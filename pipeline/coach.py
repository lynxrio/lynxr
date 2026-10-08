#!/usr/bin/env python3
"""The coach, pure: from one creator's own posted videos, say how each one did against that creator's own usual, name the moments in the
video it can point at, and pick the ONE thing that differs between their stronger videos and their quieter ones.

Plan: ~/.claude/plans/lynxr-coach-v1.md (steps 7 and 8) and the owner's amendments of 2026-10-07: "show where in the video the posts went
well, went wrong, and show them the analytics so they can start to learn how to do better".

PURE. No network, no clock but the `now` it is handed, no model call, no filesystem write. It imports nothing from this repo but envcfg, so
brain.py (which calls it) and the tests can import it without a cycle. The model-written prose is pipeline/coach_prose.py, which lives
beside this file and may only REWRITE what this file measured (its output is checked in code, `prose_ok` below, before it is kept).

WHAT IT KNOWS, AND WHAT IT DOES NOT. It knows how a video's VIEW COUNT moved between the readings lynxr took (day 0 when found, then about
days 1, 3, 7 and 30: three to five points, never a daily curve), how that compares with this creator's own median, and the numbers
pipeline/post_shape.py measured from the creator's own audio: when anyone started speaking, how many words came in the first three seconds,
the longest stretch with nobody speaking, the length, the second each beat of the linked script was said, and where a line was said again.
It does NOT know where any viewer stopped watching, who watched, why, or what a platform did: no platform gives lynxr that. So no string in
this file says retention, drop-off, watch time, swipe, an audience, an algorithm, or a percentage. test_coach.py scans every string literal
here for those words and fails loudly if someone writes friendlier copy.

THE FOUR RULES THAT MAKE IT SAFE TO SAY LITTLE.
    1. A creator is compared with THEMSELVES, never with another creator, a niche, or the scraped corpus.
    2. Below COACH_MIN_SHAPED measured videos the coach says it is still learning, and says how many it has. That is a pass, not a failure.
    3. ONE thing to work on, held for COACH_HOLD_DAYS unless it has been scored and something else now separates the videos better.
    4. Advice is a prediction and the coach keeps score: after COACH_SCORE_MIN videos posted since it was set, it says whether the number moved.

EXTENSION POINT. COACH_SIGNALS is an ordered tuple; order is the tie-break, so the most trustworthy measurement comes first. When a platform
review lands and lynxr_post_insights has real watch figures, signals are APPENDED there (avg_watch_fraction, finished_rate), gated on the
post having such a row and never on a tier, and nothing else here is restructured. Cut detection, the first cut and cuts per ten seconds, is
the other open slot: it needs a measured threshold nobody has measured yet.

RUN
    ./venv/bin/python pipeline/coach.py --print UUID           # reads that creator from the live database (through brain.py) and prints
        # the per-video table, the stronger/quieter split with both medians per signal, the chosen thing, and the rendered note. Writes NOTHING,
        # makes no model call. This is what the owner reads before COACH=1 is ever set.
    ./venv/bin/python pipeline/coach.py --file FILE.json       # the same, offline, from {"posts", "snaps", "shapes", "now", "prev_note"}
        # FILE.json = what brain.read_creator returns, as JSON (keep it outside the repo: it holds a creator's own numbers).
"""
import argparse
import hashlib
import json
import math
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import envcfg  # noqa: E402

COACH = envcfg.get("COACH", "0") not in ("0", "", "false", "False")        # OFF: a bad diagnosis must not reach the writer or the creator before the owner has read a real one
COACH_MIN_SHAPED = int(envcfg.get("COACH_MIN_SHAPED", "4"))                # videos with a week of numbers AND a measured shape before the coach compares any of them
COACH_SCORE_MIN = int(envcfg.get("COACH_SCORE_MIN", "2"))                  # videos posted since the advice was set before the coach says whether it worked
COACH_HOLD_DAYS = float(envcfg.get("COACH_HOLD_DAYS", "21"))               # the one thing to work on is held at least this long
COACH_EARLY_H = float(envcfg.get("COACH_EARLY_H", "36"))                   # a video whose views had almost stopped growing by this hour "stopped early"
COACH_GROWTH_MIN = float(envcfg.get("COACH_GROWTH_MIN", "1.1"))            # between two readings, views must grow by at least this factor to count as still growing
COACH_CURVE_DAYS = int(envcfg.get("COACH_CURVE_DAYS", "10"))               # a video older than this is not "still climbing", it "kept growing"
COACH_POSTS_MAX = 12                                                       # videos described in one note, newest first
COACH_WINDOW_DAYS = 180.0                                                  # mirrors brain.BRAIN_WINDOW_DAYS (test_brain.py asserts they agree)
STRONG = 1.3                                                               # times the creator's own median at or above which a video is "stronger"  (mirrors brain.STANDOUT_BEST)
WEAK = 0.7                                                                 # ... and at or below which it is "weaker"                                (mirrors brain.STANDOUT_QUIET)
MOMENT_QUIET_START_S = 1.5                                                 # nobody spoke for at least this long at the start: a moment worth naming
MOMENT_GAP_S = 1.0                                                         # a stretch with nobody speaking at least this long: a moment worth naming
MOMENT_LATE_BEAT_S = 2.0                                                   # a script beat said at least this many seconds later than the script has it
MOMENTS_MAX = 3
HISTORY_MAX = 3                                                            # entries of working_on kept, newest first (the writer reads the first only)


# ── the only copy this file writes ────────────────────────────────────────────────────────────────
# Every sentence a creator can read from here is one of the strings below, filled with a measured number. They are module-level so that
# test_coach.py can scan them, and so that nothing is ever worded in the middle of a function.

NOT_YET_NONE = "lynxr has not measured one of your videos yet. it checks your linked accounts once a day."
NOT_YET_FEW = ("lynxr needs {need} of your videos that have been up a week and that it has listened to, before it can tell you what is "
               "different about one of them. it has {have}.")
NOT_YET_NODIFF = ("lynxr has not found a difference it can stand behind between your stronger videos and your quieter ones.")

LINES = {      # how a video's views moved between the readings lynxr took. `from_h` and `by_h` are hours after posting.
    "no_views": "it has no views in the readings lynxr took",
    "climbing": "it was still climbing at its last reading, {days} days in",
    "grew": "it kept growing through day {days}",
    "stopped_early": "it had almost stopped growing between hour {from_h} and hour {by_h}",
    "levelled_off": "it had almost stopped growing between hour {from_h} and hour {by_h}",
}
LINE_VS_USUAL = "{views} views a week in, {times} times your own usual"

MOMENT_TEXT = {      # moments in the audio, each with the second it happened
    "quiet_start": "nobody spoke until second {x}",
    "gap": "nobody spoke for {x} seconds, from second {at}",
    "repeat": "at second {at} you say again what you said at second {of}",
    "late_beat": "beat {i} of your script starts at second {s}; the script has it at second {p}",
    "missed_beat": "lynxr did not hear beat {i} of your script",
}
MOMENT_ORDER = ("repeat", "late_beat", "gap", "quiet_start", "missed_beat")      # which moments are named first when there are more than MOMENTS_MAX

VERDICTS = {"stronger": "stronger than your usual", "weaker": "weaker than your usual", "usual": "about your usual"}

BECAUSE = "your {n_good} stronger videos typically {good}; your {n_poor} quieter ones typically {poor}"

# COACH_SIGNALS. key: the measured number. direction: "below" means a LOWER number goes with the stronger videos. spread: the smallest gap
# between the two groups' medians worth acting on. good / poor: the clause for the stronger / quieter group, filled with that group's median.
# said: the one thing to work on, filled with n (rounded, from the stronger group's median).
COACH_SIGNALS = (
    {"key": "speech_start_s", "direction": "below", "spread": 0.8,
     "good": "had someone talking by {x}s", "poor": "waited {x}s before anyone spoke",
     "said": "start talking inside the first second", "said_n": "start talking inside the first {n} seconds", "n_min": 1},
    {"key": "hook_end_s", "direction": "below", "spread": 1.0,
     "good": "got through the opening line by second {x}", "poor": "took until second {x} to get through the opening line",
     "said": "get through your opening line by second {n}", "said_n": "get through your opening line by second {n}", "n_min": 1},
    {"key": "longest_silence_s", "direction": "below", "spread": 0.6,
     "good": "went no longer than {x}s without anyone speaking", "poor": "went {x}s without anyone speaking",
     "said": "keep every gap between lines to about {x} seconds or less", "said_n": "keep every gap between lines to about {x} seconds or less",
     "n_min": 0},
    {"key": "repeat_count", "direction": "below", "spread": 1.0,
     "good": "said a line again {x} times", "poor": "said a line again {x} times",
     "said": "say each line once", "said_n": "say each line once", "n_min": 0},
    {"key": "words_first_3s", "direction": "above", "spread": 3.0,
     "good": "got {x} words out in the first three seconds", "poor": "got only {x} words out in the first three seconds",
     "said": "get {n} words out before second three", "said_n": "get {n} words out before second three", "n_min": 1},
    {"key": "duration_s", "direction": "below", "spread": 3.0,
     "good": "ran {x}s", "poor": "ran {x}s",
     "said": "keep it to about {n} seconds", "said_n": "keep it to about {n} seconds", "n_min": 1},
)
SIGNAL_KEYS = tuple(s["key"] for s in COACH_SIGNALS)

# What the prose pass is checked against. These are NOT coach copy: they are the words the checker refuses to see in a model's output, so
# test_coach.py does not scan them.
PROSE_BANNED = ("retention", "drop-off", "dropoff", "drop off", "watch time", "watched", "finish", "completion", "swipe", "scroll", "left at",
                "clicked off", "%", "algorithm", "suppress", "shadowban", "viewer", "audience", "platform", "tiktok", "instagram",
                "fyp", "viral", "trend", "curve", "watchers", "followers", "subscribers")
PROSE_CAUSAL = ("because", "caused", "cause", "due to", "led to", "leads to", "therefore", "thanks to", "as a result", "which is why",
                "that is why", "the reason", "result of", "so that")
PROSE_NUMBER_WORDS = ("one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "twice", "double",
                      "triple", "half", "dozen", "hundred", "thousand", "million", "tenth", "third", "quarter", "once", "thrice")
PROSE_MAX_CHARS = 420


# ── small helpers ─────────────────────────────────────────────────────────────────────────────────

def parse_ts(s):
    """An aware datetime from an ISO string (a trailing Z and fractional seconds are fine), or None."""
    if not s:
        return None
    try:
        t = str(s).strip().replace("Z", "+00:00")
        m = re.match(r"^(.*T\d\d:\d\d:\d\d)\.(\d+)(.*)$", t)
        if m:
            t = f"{m.group(1)}.{m.group(2)[:6].ljust(6, '0')}{m.group(3)}"
        d = datetime.fromisoformat(t)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _f(v):
    """A non-negative finite float, or None. Absent is None, never zero."""
    if v is None or isinstance(v, bool):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) and n >= 0 else None


def _median(values):
    v = sorted(values)
    n = len(v)
    if not n:
        raise ValueError("median of nothing")
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


def _n(x):
    """A measured number as a person writes it: one decimal at most, no trailing .0."""
    s = f"{float(x):.1f}"
    return s[:-2] if s.endswith(".0") else s


def _int(x):
    return f"{int(round(x)):,}"


def _hours(a, b):
    return max(0, int((b - a).total_seconds() // 3600))


# ── 7a. one video's views over the readings lynxr took ────────────────────────────────────────────

def curve(snaps, posted_at):
    """How a video's views moved, or None (the coach says nothing about this video's curve).

    `snaps` is that post's lynxr_post_views rows (day, at, views); `posted_at` an aware datetime. None when fewer than two readings have a
    view count, or the earliest reading is later than day 2: a video discovered at age 23 has no early reading, and its first count says
    nothing about how it started (brain.views_at excludes it for the same reason).

    Readings are about days 0, 1, 3, 7 and 30, so this is three to five points, NEVER a daily curve, and every statement here is only about
    the interval between two readings. `by_h` is the hour of the reading by which views had almost stopped growing for good (each reading
    from there on grew by less than COACH_GROWTH_MIN), and `from_h` the hour of the reading before it: all that is known is that growth in
    between was small. kind: no_views, climbing (still growing at the last reading, young), grew (still growing, older),
    stopped_early (almost stopped by COACH_EARLY_H), levelled_off (almost stopped later)."""
    if posted_at is None:
        return None
    rows = []
    for s in snaps or []:
        d, v = _f((s or {}).get("day")), _f((s or {}).get("views"))
        if d is None or v is None:
            continue
        at = parse_ts((s or {}).get("at")) or posted_at + timedelta(days=d)
        rows.append({"day": int(d), "views": int(v), "at": at})
    rows.sort(key=lambda r: (r["day"], r["at"]))
    if len(rows) < 2 or rows[0]["day"] > 2:
        return None
    last = rows[-1]
    out = {"days": last["day"], "views": last["views"]}
    if last["views"] == 0:
        return {**out, "kind": "no_views"}
    grew = [rows[k]["views"] >= COACH_GROWTH_MIN * rows[k - 1]["views"] for k in range(1, len(rows))]
    if grew[-1]:
        return {**out, "kind": "climbing" if last["day"] <= COACH_CURVE_DAYS else "grew"}
    k = len(rows) - 1
    while k > 1 and not grew[k - 2]:         # walk back to the first reading from which every later one stalled
        k -= 1
    out["from_h"], out["by_h"] = _hours(posted_at, rows[k - 1]["at"]), _hours(posted_at, rows[k]["at"])
    return {**out, "kind": "stopped_early" if out["by_h"] <= COACH_EARLY_H else "levelled_off"}


# ── per-video: numbers, verdict, moments ──────────────────────────────────────────────────────────

def signal_values(shape):
    """{signal key: number} for the signals this video's measured shape can answer. A signal whose input is missing is absent, never zero.
    hook_end_s is when the script's opening beat was last heard; repeat_count is how many times a line was said again (only for a video
    with speech, where none is a real answer)."""
    shape = shape if isinstance(shape, dict) else {}
    v = {}
    for k in ("speech_start_s", "longest_silence_s", "words_first_3s", "duration_s"):
        x = _f(shape.get(k))
        if x is not None:
            v[k] = x
    for b in shape.get("beats") or []:
        if isinstance(b, dict) and b.get("kind") == "beat" and b.get("i") == 1 and b.get("found") is not False:
            e = _f(b.get("end_s"))
            if e is not None:
                v["hook_end_s"] = e
    if shape.get("has_speech") and "speech_start_s" in v:
        v["repeat_count"] = float(len(shape.get("repeats") or []))
    return v


def moments(shape):
    """The moments in the audio worth naming, as [{"kind", "at_s", "text", ...numbers}], at most MOMENTS_MAX, in the order they happen.
    Each is a measurement with a second attached; none claims a cause. Chosen in MOMENT_ORDER when there are more than fit."""
    shape = shape if isinstance(shape, dict) else {}
    found = []
    for r in shape.get("repeats") or []:
        at, of = _f((r or {}).get("at_s")), _f((r or {}).get("of_s"))
        if at is not None and of is not None:
            found.append({"kind": "repeat", "at_s": at, "of_s": of, "text": MOMENT_TEXT["repeat"].format(at=_n(at), of=_n(of))})
    for b in shape.get("beats") or []:
        if not isinstance(b, dict) or b.get("kind") != "beat" or not isinstance(b.get("i"), int):
            continue
        if b.get("found") is False:
            found.append({"kind": "missed_beat", "at_s": None, "beat": b["i"], "text": MOMENT_TEXT["missed_beat"].format(i=b["i"])})
            continue
        s, p = _f(b.get("start_s")), _f(b.get("planned_s"))
        if s is not None and p is not None and s - p >= MOMENT_LATE_BEAT_S:
            found.append({"kind": "late_beat", "at_s": s, "beat": b["i"], "planned_s": p,
                          "text": MOMENT_TEXT["late_beat"].format(i=b["i"], s=_n(s), p=_n(p))})
    gap, at = _f(shape.get("longest_silence_s")), _f(shape.get("longest_silence_at_s"))
    if gap is not None and at is not None and gap >= MOMENT_GAP_S:
        found.append({"kind": "gap", "at_s": at, "value": gap, "text": MOMENT_TEXT["gap"].format(x=_n(gap), at=_n(at))})
    start = _f(shape.get("speech_start_s"))
    if start is not None and start >= MOMENT_QUIET_START_S:
        found.append({"kind": "quiet_start", "at_s": 0.0, "value": start, "text": MOMENT_TEXT["quiet_start"].format(x=_n(start))})
    found.sort(key=lambda m: (MOMENT_ORDER.index(m["kind"]), m["at_s"] if m["at_s"] is not None else 1e9))
    return sorted(found[:MOMENTS_MAX], key=lambda m: (m["at_s"] is None, m["at_s"] or 0.0))


def verdict(times_median):
    """stronger / weaker / usual against the creator's own median, or None when there is no median to compare with."""
    if times_median is None:
        return None
    return "stronger" if times_median >= STRONG else "weaker" if times_median <= WEAK else "usual"


def line_for(cv, views7=None, times_median=None):
    """The one-sentence read of a video's views, or "" when there is no curve."""
    if not cv:
        return ""
    base = LINES[cv["kind"]].format(days=cv.get("days"), from_h=cv.get("from_h"), by_h=cv.get("by_h"))
    if times_median is not None and views7 is not None:
        base += "; " + LINE_VS_USUAL.format(views=_int(views7), times=_n(times_median))
    return base


def shape_numbers(shape):
    """The measured numbers of one video, for the note's max depth: what post_shape.py wrote, minus the ids. Keys with no value are absent."""
    shape = shape if isinstance(shape, dict) else {}
    out = {}
    for k in ("speech_start_s", "words_first_3s", "longest_silence_s", "longest_silence_at_s", "duration_s"):
        x = _f(shape.get(k))
        if x is not None:
            out[k] = x
    for k in ("beats", "repeats"):
        if isinstance(shape.get(k), list) and shape[k]:
            out[k] = shape[k]
    return out


def post_entry(post, snaps, shape, views7, median, lead, now):
    """One video's entry in the note, or None when there is neither a curve nor a measured shape to say anything from."""
    posted = parse_ts(post.get("posted_at"))
    cv = curve(snaps, posted)
    mom = moments(shape) if shape else []
    if cv is None and not mom and not shape_numbers(shape):
        return None
    times = round(views7 / median, 1) if (median and median > 0 and views7 is not None and post.get("platform") == lead) else None
    e = {"post_id": post.get("id")}
    if cv:
        e.update({"curve": cv["kind"], "days": cv["days"], "views": cv["views"]})
        if "by_h" in cv:
            e["from_h"], e["by_h"] = cv["from_h"], cv["by_h"]
    if views7 is not None:
        e["views7"] = views7
    if times is not None:
        e["times_median"], e["verdict"] = times, verdict(times)
    e["line"] = line_for(cv, views7, times)
    if mom:
        e["moments"] = mom
    nums = shape_numbers(shape)
    if nums:
        e["shape"] = nums
    e["_facts"] = facts_for(e, snaps)
    return e


# ── what the prose pass may say, and the check that holds it to that ──────────────────────────────

def facts_for(e, snaps):
    """The measured facts about one video, as the lines the prose pass is given and checked against. Numbers and plain statements only."""
    out = []
    if e.get("views") is not None:
        out.append(f"views at the last reading: {_int(e['views'])}")
    pts = sorted({(int(s["day"]), int(s["views"])) for s in snaps or [] if _f((s or {}).get("day")) is not None and _f((s or {}).get("views")) is not None})
    if len(pts) >= 2:
        out.append("views at each reading: " + ", ".join(f"day {d}: {_int(v)}" for d, v in pts[:6]))
    if e.get("line"):
        out.append(e["line"])
    if e.get("verdict"):
        out.append(f"against this creator's own usual a week in: {VERDICTS[e['verdict']]}")
    for m in e.get("moments") or []:
        out.append("in the audio: " + m["text"])
    return "\n".join(out)


def facts_key(facts):
    return hashlib.sha1(facts.encode()).hexdigest()[:16]


_NUM_RE = re.compile(r"\d+(?:,\d{3})*(?:\.\d+)?")


def numbers_in(text):
    """The set of numbers written in `text`, as floats ('1,204' -> 1204.0, '0.6' -> 0.6)."""
    return {float(m.replace(",", "")) for m in _NUM_RE.findall(str(text or ""))}


def prose_ok(text, facts):
    """(True, cleaned) when a model's rewrite may be kept, else (False, reason). The rewrite is trusted with NOTHING: the model is given only
    `facts` and may only rephrase them, so every number it writes must be a number in `facts`, and it may not bring in a word that claims
    something the facts do not (an audience, a platform, an algorithm, a cause, a curve, a number spelled out). A rewrite that fails any test
    is dropped and the templated sentence stands."""
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(s) >= 2 and (s[0], s[-1]) in (('"', '"'), ("'", "'")):
        s = s[1:-1].strip()
    if not s:
        return False, "empty"
    if len(s) > PROSE_MAX_CHARS:
        return False, "too long"
    low, base = s.lower(), str(facts or "").lower()
    if any(ch in s for ch in "*#`|") or re.search(r"(^|\s)[-•]\s", s):
        return False, "markup"
    extra = sorted(numbers_in(s) - numbers_in(facts))
    if extra:
        return False, f"a number that is not in the facts: {extra[0]:g}"
    for w in PROSE_BANNED:
        if w in low and w not in base:
            return False, f"banned word: {w}"
    for w in PROSE_CAUSAL:
        if re.search(rf"\b{re.escape(w)}\b", low) and not re.search(rf"\b{re.escape(w)}\b", base):
            return False, f"a cause the facts do not give: {w}"
    for w in PROSE_NUMBER_WORDS:
        if re.search(rf"\b{re.escape(w)}\b", low) and not re.search(rf"\b{re.escape(w)}\b", base):
            return False, f"a number in words: {w}"
    return True, s


# ── 7c. what separates the stronger videos from the quieter ones ──────────────────────────────────

def separation(rows, explain=None):
    """The one signal that best separates this creator's stronger videos from their quieter ones, or None.

    `rows` = [{"views": views a week in, "values": {signal: number}}] for the creator's videos on their lead platform that have a week of
    numbers AND a measured shape. Fewer than COACH_MIN_SHAPED: None. The split is this set's own median (stronger = at or above it), so it
    is always defined and roughly even, and no outside number ever decides it. For each signal in COACH_SIGNALS order: at least two values on
    each side, the medians at least `spread` apart, and the gap in the direction the signal names. Score = gap / spread; the highest wins and
    ties go to the earlier signal, so the answer is deterministic. `explain`, when a list, is filled with one dict per signal for --print."""
    if len(rows) < COACH_MIN_SHAPED:
        return None
    cut = _median([r["views"] for r in rows])
    good = [r for r in rows if r["views"] >= cut]
    poor = [r for r in rows if r["views"] < cut]
    best = None
    for rank, sig in enumerate(COACH_SIGNALS):
        g = [r["values"][sig["key"]] for r in good if sig["key"] in r["values"]]
        p = [r["values"][sig["key"]] for r in poor if sig["key"] in r["values"]]
        info = {"key": sig["key"], "n_good": len(g), "n_poor": len(p), "verdict": "too few"}
        if len(g) >= 2 and len(p) >= 2:
            mg, mp = _median(g), _median(p)
            gap = mp - mg if sig["direction"] == "below" else mg - mp
            info.update({"m_good": mg, "m_poor": mp, "score": round(abs(mp - mg) / sig["spread"], 2)})
            if abs(mp - mg) < sig["spread"]:
                info["verdict"] = "gap under the minimum"
            elif gap < 0:
                info["verdict"] = "wrong direction"
            else:
                info["verdict"] = "clears"
                score = abs(mp - mg) / sig["spread"]
                if best is None or score > best[0]:
                    best = (score, rank, sig, mg, mp, len(g), len(p))
        if explain is not None:
            explain.append(info)
    if best is None:
        return None
    _, _, sig, mg, mp, ng, np_ = best
    if explain is not None:
        for info in explain:
            info["chosen"] = info["key"] == sig["key"]
    return {"signal": sig["key"], "direction": sig["direction"], "m_good": mg, "m_poor": mp, "n_good": ng, "n_poor": np_}


def advise(sep, now):
    """The `working_on` entry for a separation: the one thing, the evidence in the creator's own numbers, and what it is measured against."""
    sig = next(s for s in COACH_SIGNALS if s["key"] == sep["signal"])
    mg, mp = sep["m_good"], sep["m_poor"]
    # A time is rounded UP (a target must be reachable by the videos that already did it); a count or a length is rounded to nearest.
    n = max(sig["n_min"], int(math.ceil(mg)) if sig["key"] in ("speech_start_s", "hook_end_s") else int(round(mg)))
    said = (sig["said_n"] if sig["key"] == "speech_start_s" and n > 1 else sig["said"]).format(n=n, x=_n(max(mg, 0.5)))
    because = BECAUSE.format(n_good=sep["n_good"], n_poor=sep["n_poor"], good=sig["good"].format(x=_n(mg)), poor=sig["poor"].format(x=_n(mp)))
    return {"said": said, "because": because, "signal": sig["key"], "direction": sig["direction"], "was": round(mp, 1), "target": round(mg, 1),
            "set_at": iso(now)}


# ── 7e. the coach keeps score ─────────────────────────────────────────────────────────────────────

def score(prev, shaped, now):
    """The `since` block for a carried-forward entry. `shaped` = [{"posted": aware datetime, "values": {...}, "curve": kind or None}] for the
    creator's measured videos on their lead platform. Videos posted strictly after `prev["set_at"]` are the test: fewer than COACH_SCORE_MIN
    of them (or none with this signal measured) and nothing is claimed beyond how many there are."""
    set_at = parse_ts(prev.get("set_at")) or now
    after = [r for r in shaped if r["posted"] > set_at]
    since = {"posts": len(after)}
    vals = [r["values"][prev["signal"]] for r in after if prev["signal"] in r["values"]]
    if len(after) < COACH_SCORE_MIN or len(vals) < COACH_SCORE_MIN:
        return since
    m = _median(vals)
    was = _f(prev.get("was"))
    if was is None:
        return since
    since["median"] = round(m, 1)
    since["moved"] = (m < was) if prev.get("direction") == "below" else (m > was)
    before = [r for r in shaped if r["posted"] <= set_at and r["curve"]]
    later = [r for r in after if r["curve"]]
    if before and later:
        good = ("climbing", "grew")
        since["curve_better"] = (sum(r["curve"] in good for r in later) / len(later)) > (sum(r["curve"] in good for r in before) / len(before))
    return since


def _history(prev_note):
    wo = (prev_note or {}).get("working_on") if isinstance(prev_note, dict) else None
    return [w for w in (wo if isinstance(wo, list) else []) if isinstance(w, dict) and w.get("signal") in SIGNAL_KEYS and w.get("said")]


def choose(prev_hist, sep, shaped, now):
    """The new working_on list, newest first, at most HISTORY_MAX. The "one thing" rule: a previous entry is carried forward (with a fresh
    `since`) unless it has been scored and a DIFFERENT signal now separates the videos, or it has been held COACH_HOLD_DAYS. Without it the
    hinge would change every rebuild and the writer would get a new instruction every night."""
    new = advise(sep, now) if sep else None
    if not prev_hist:
        return [new] if new else []
    prev = prev_hist[0]
    since = score(prev, shaped, now)
    set_at = parse_ts(prev.get("set_at")) or now
    expired = now - set_at >= timedelta(days=COACH_HOLD_DAYS)
    scored = since["posts"] >= COACH_SCORE_MIN
    replace = expired or (scored and new is not None and new["signal"] != prev["signal"])
    kept = {**{k: v for k, v in prev.items() if k != "since"}, "since": since}
    if not replace:
        return [kept] + prev_hist[1:HISTORY_MAX]
    if new is None:
        return []                               # held its time and nothing separates the videos now: say nothing rather than repeat old advice
    return [new, kept] + prev_hist[1:HISTORY_MAX - 1]


# ── 7f. the note ──────────────────────────────────────────────────────────────────────────────────

def coach(posts, snaps_by_post, shape_by_post, comparable_rows, lead, median, prev_note, now, explain=None):
    """(note, mirror). `posts` = the creator's tracked posts; `snaps_by_post` = {post_id: lynxr_post_views rows}; `shape_by_post` =
    {post_id: lynxr_post_shape row}; `comparable_rows` = brain.comparable()'s rows (post_id, platform, posted_at, views a week in);
    `lead` and `median` = the lead platform and the creator's own median (None when the brain is not `ready`); `prev_note` = the last stored
    note or None, for carrying the one thing forward and for the prose cache.

    note: {"v", "state": ready|learning|nothing, "not_yet"?, "platform"?, "median_views"?, "posts": [...], "working_on": [...]}. Each post
    entry carries a private `_facts` for the prose pass; strip_private() removes it before anything is stored. mirror: [{"said"}] or [], the
    ONE line the brain document keeps. No transcript, no script text, no number outside the creator's own data."""
    horizon = now - timedelta(days=COACH_WINDOW_DAYS)
    week = {r["post_id"]: r["views"] for r in comparable_rows or []}
    ordered = sorted([p for p in posts or [] if isinstance(p, dict) and p.get("origin", "tracked") == "tracked" and parse_ts(p.get("posted_at"))
                      and parse_ts(p["posted_at"]) >= horizon], key=lambda p: parse_ts(p["posted_at"]), reverse=True)
    entries, rows, shaped = [], [], []
    for p in ordered:
        sh = (shape_by_post or {}).get(p.get("id"))
        snaps = (snaps_by_post or {}).get(p.get("id"))
        e = post_entry(p, snaps, sh, week.get(p.get("id")), median, lead, now)
        if e is not None and len(entries) < COACH_POSTS_MAX:
            entries.append(e)
        vals = signal_values(sh) if sh else {}
        if vals and p.get("platform") == lead:
            cv = curve(snaps, parse_ts(p["posted_at"]))
            shaped.append({"posted": parse_ts(p["posted_at"]), "values": vals, "curve": cv["kind"] if cv else None})
            if p.get("id") in week:
                rows.append({"views": week[p["id"]], "values": vals})
    note = {"v": 1, "platform": lead} if lead else {"v": 1}
    if median:
        note["median_views"] = median
    prev_hist = _history(prev_note)
    working = []
    if not entries:
        note.update({"state": "nothing", "not_yet": NOT_YET_NONE})
    elif len(rows) < COACH_MIN_SHAPED:
        note.update({"state": "learning", "not_yet": NOT_YET_FEW.format(need=COACH_MIN_SHAPED, have=len(rows))})
    else:
        sep = separation(rows, explain)
        working = choose(prev_hist, sep, shaped, now)
        if working:
            note["state"] = "ready"
        else:
            note.update({"state": "learning", "not_yet": NOT_YET_NODIFF})
    note["posts"] = _carry_prose(entries, prev_note)
    note["working_on"] = working
    return note, ([{"said": working[0]["said"]}] if working else [])


def _carry_prose(entries, prev_note):
    """The prose cache. A video whose facts are unchanged since the last note keeps its prose (and the fact that a rewrite was already tried),
    so a repeat build costs nothing. A video whose facts changed has no prose until the prose pass makes some."""
    old_posts = prev_note.get("posts") if isinstance(prev_note, dict) else None
    prev = {e["post_id"]: e for e in (old_posts if isinstance(old_posts, list) else []) if isinstance(e, dict) and e.get("post_id") is not None}
    for e in entries:
        key = facts_key(e["_facts"]) if e.get("_facts") else None
        old = prev.get(e["post_id"])
        if key and old and old.get("prose_key") == key:
            e["prose_key"] = key
            if old.get("prose"):
                e["prose"] = old["prose"]
    return entries


def strip_private(note):
    """The note with every private key (a leading underscore) removed from its posts: what is stored, and what --print shows last."""
    if not isinstance(note, dict):
        return note
    return {**note, "posts": [{k: v for k, v in e.items() if not k.startswith("_")} for e in note.get("posts") or []]}


# ── by hand ───────────────────────────────────────────────────────────────────────────────────────

def report(got, now, comparable_rows, lead, median):
    """The text --print shows: one row per video, the split with both medians per signal, the chosen thing, the rendered note."""
    posts, snaps, shapes = got["posts"], got["snaps"], got.get("shapes") or {}
    lines = [f"{'post':<7} {'platform':<10} {'posted':<11} {'readings (day)':<20} {'curve':<14} {'wk views':<9} {'start':<6} {'w3s':<4} {'gap':<5} {'len':<6} {'rep':<4} hook_end"]
    week = {r["post_id"]: r["views"] for r in comparable_rows}
    for p in sorted([p for p in posts if isinstance(p, dict)], key=lambda p: parse_ts(p.get("posted_at")) or now, reverse=True):
        sh = shapes.get(p.get("id")) or {}
        cv = curve(snaps.get(p.get("id")), parse_ts(p.get("posted_at")))
        days = ",".join(str(s.get("day")) for s in sorted(snaps.get(p.get("id")) or [], key=lambda s: s.get("day", 0)) if s.get("views") is not None) or "-"
        v = signal_values(sh)
        t = parse_ts(p.get("posted_at"))
        lines.append(f"{str(p.get('id')):<7} {str(p.get('platform')):<10} {(t.strftime('%Y-%m-%d') if t else '-'):<11} {days:<20} "
                     f"{(cv['kind'] if cv else '-'):<14} {str(week.get(p.get('id'), '-')):<9} {str(v.get('speech_start_s', '-')):<6} "
                     f"{str(int(v['words_first_3s']) if 'words_first_3s' in v else '-'):<4} {str(v.get('longest_silence_s', '-')):<5} "
                     f"{str(v.get('duration_s', '-')):<6} {str(int(v['repeat_count']) if 'repeat_count' in v else '-'):<4} {v.get('hook_end_s', '-')}")
    explain = []
    note, mirror = coach(posts, snaps, shapes, comparable_rows, lead, median, got.get("prev_note"), now, explain)
    lines.append("")
    if explain:
        lines.append("stronger/quieter split (each signal: values on each side, medians, score, verdict)")
        for i in explain:
            lines.append(f"  {i['key']:<18} good n={i['n_good']} poor n={i['n_poor']}  "
                         + (f"medians {i['m_good']:g} / {i['m_poor']:g}  score {i['score']:g}  " if "m_good" in i else "")
                         + i["verdict"] + ("   <- CHOSEN" if i.get("chosen") else ""))
    else:
        lines.append(f"no split: {sum(1 for r in comparable_rows if r['platform'] == lead)} comparable videos on the lead platform; "
                     f"the coach compares from {COACH_MIN_SHAPED} that also have a measured shape")
    lines += ["", "note (what would be stored):", json.dumps(strip_private(note), indent=2, ensure_ascii=False),
              "", f"mirrored into the brain: {json.dumps(mirror)}"]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", dest="print_uuid", metavar="CREATOR_UUID",
                    help="read that creator from the live database (through brain.py) and print the table, the split and the note; writes nothing")
    ap.add_argument("--file", metavar="FILE.json", help="the same, offline, from a JSON file (see the docstring)")
    args = ap.parse_args()
    if not (args.print_uuid or args.file):
        ap.error("give --print CREATOR_UUID or --file FILE.json")
    if args.file:
        import brain as B                                  # pure helpers only
        got = json.load(open(args.file))
        got["snaps"] = {int(k): v for k, v in (got.get("snaps") or {}).items()}
        got["shapes"] = {int(k): v for k, v in (got.get("shapes") or {}).items()}
        now = parse_ts(got.get("now")) or datetime.now(timezone.utc)
    else:
        import os
        import brain as B                                  # here and only here: the network reads live in brain.py
        import track_posts as T
        env = B.P.load_env(B.P.ROOT / ".env")
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
        if not key:
            sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
        got = B.read_creator(T, key, args.print_uuid)
        if got is None:
            sys.exit("could not read that creator")
        now = datetime.now(timezone.utc)
        print("# warning: this holds the creator's own numbers. Keep it off any public surface.")
    rows, lead, median = B.coach_inputs(got["posts"], got["snaps"], now)
    print(report(got, now, rows, lead, median))


if __name__ == "__main__":
    main()
