#!/usr/bin/env python3
"""The brain lane: one derived JSONB document per creator, worked out from their own tracked posts and their own onboarding
answers, rebuilt on a schedule. Pro will SEE it, so every field name and string reads as a person would say it.

Plan: ~/.claude/plans/lynxr-brain-doc.md (step 2 of ~/.claude/plans/lynxr-one-brain-v1.md). The contract it builds to is
~/.claude/plans/lynxr-brain-shape.md. The table and its row-level security are supabase/creator_brain.sql (owner SQL).

DERIVED ONLY. This module writes exactly one table, `lynxr_creator_brain`, and reads everything else. It never writes
`lynxr_posts`, `lynxr_post_views`, `lynxr_profiles`, `lynxr_profile_followers` or `lynxr_creators`.

CREATOR-SIDE ONLY. Nothing here may be imported by `pipeline/process_campaigns.py` or reach `AGENCY_SCRIPT_SYSTEM`. (The agency
app is an internal tool; the owner's rule, 2026-10-07. pipeline/test_brain.py checks it.)

CONSERVATIVE BY DESIGN. There is no correction UI and there will not be one: a creator should not have to correct lynxr. So a
field that cannot be derived truthfully from what is actually stored is omitted, and the omission is recorded in the document's
own `not_known`. A wrong line is a bug in this derivation, not something to push onto the creator.

FOUR DEVIATIONS FROM ~/.claude/plans/lynxr-brain-shape.md (the real schema could not support the draft):
    1. `what_you_post` is NOT BUILT. lynxr_posts holds no format, no tag and no duration (track_posts.py reads duration and keeps
       only `video = duration > 0`), and the only format text in the system describes the SOURCE video, not the posted one. A
       numbers-only `where_you_post` (platform, counts, cadence) replaces it, and the omission is stated in `not_known`.
    2. `about_you.creators_you_named` is DEAD. The owner, 2026-10-07: "no need for this". Onboarding never asked for it and will not
       start; it is gone from the shape.
    3. `ready` means 5+ comparable posts on ONE platform, not 5 across both. A median that mixes a 20k-view TikTok account with a
       500-view Instagram account describes neither.
    4. `what_works_for_you` carries the creator's best and quietest individual posts, not only grouped patterns. With no tags, no
       duration and no transcript, honest patterns are rare; honest facts about one video are always available.

A FIFTH NOTE, added with plan ~/.claude/plans/lynxr-social-insights.md: WATCH TIME IS NOW READ WHERE A TOKEN EXISTS. A creator who connected an
Instagram or TikTok account in Settings has per-video average watch time in `lynxr_post_insights` (pipeline/insights.py), and
`how_people_watch` below folds it in: two points on the curve (how long the average viewer stayed, and one completion-ish share), never the
curve, because neither platform exposes one. `what_you_post` is STILL not built (deviation 1: no format, no tag, unchanged), and a creator
with no connected account gets no `how_people_watch` and a `not_known` line saying how to get one. Disconnecting deletes the figures AND
removes this key the same second (supabase/platform_insights.sql revoke_insights()), so nothing here outlives a connection.

A SIXTH NOTE, added with plan ~/.claude/plans/lynxr-coach-v1.md: `working_on` IS NOW WRITTEN BY THE COACH (pipeline/coach.py) when COACH is on, and is
[] exactly as before when it is off (the default). Only the one-line `said` is mirrored here, because this document is readable by its owner and
the coach's evidence is paid depth: the full note (the tip's evidence, every video's read, the moments in its audio) goes to
lynxr_coach_notes, which only my_coach() reads, trimmed by tier (supabase/coach.sql). The coach adds one read of lynxr_post_shape and one of
the previous note, and only when COACH is on; with it off this lane reads and writes exactly what it did before.

THE VOICE LINE is the only thing here that costs money and the only thing that sends a creator's words anywhere: once a week, one
Haiku call over up to 8 of their own captions describes how they write. It is OFF unless BRAIN_VOICE is set, and nothing calls the
model while it is off: brain_pass() does not build a client, and voice_line() itself refuses. The privacy wording for it is still
the owner's to settle (see privacy/index.html).

RUN
    ./venv/bin/python pipeline/brain.py --dry-run               # counts what is due; reads no creator's data, no model call, writes nothing
    ./venv/bin/python pipeline/brain.py --print UUID [--why]    # builds one creator's body from the live database and prints it. Writes
        # NOTHING (no upsert, no cost row) and makes no model call. The output holds the creator's own captions: keep it off any public
        # surface. --why first prints the table that explains every omission (one row per tracked post), then a one-line summary.
    BRAIN_VOICE=1 ./venv/bin/python pipeline/brain.py --print UUID --voice
        # the same, plus the real Haiku call (it sends up to 8 of that creator's captions to Anthropic), printing the measured spend.
        # Without BRAIN_VOICE=1 in the environment --voice does nothing: one switch governs every model call here.
"""
import argparse
import hashlib
import json
import logging
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_adaptations as P  # noqa: E402
import envcfg  # noqa: E402
import coach as C  # noqa: E402 -- pure; the one writer of body["working_on"] (plan lynxr-coach-v1.md)
import coach_prose as CP  # noqa: E402 -- the Haiku rewrite of the coach's measured facts; checked in code before anything is kept

log = logging.getLogger("brain")

BRAIN = envcfg.get("BRAIN", "1") not in ("0", "", "false", "False")                       # "0" turns the lane off entirely
BRAIN_VOICE = envcfg.get("BRAIN_VOICE", "0") not in ("0", "", "false", "False")           # OFF by default: the only thing here that costs money (and sends captions to Anthropic)
BRAIN_PER_PASS = int(envcfg.get("BRAIN_PER_PASS", "3"))                                   # creators rebuilt per pass
BRAIN_EVERY_H = float(envcfg.get("BRAIN_EVERY_H", "20"))                                  # a creator is rebuilt at most this often
BRAIN_SCAN_LIMIT = int(envcfg.get("BRAIN_SCAN_LIMIT", "500"))                             # creators considered per pass; revisit past this many accounts
BRAIN_WINDOW_DAYS = float(envcfg.get("BRAIN_WINDOW_DAYS", "180"))                         # a post older than this sets no baseline
BRAIN_DAY = int(envcfg.get("BRAIN_DAY", "7"))                                             # the age, in days, at which posts are compared (mirrors creator.js GOAL_WEEK_DAY)
BRAIN_DAY_TOL = int(envcfg.get("BRAIN_DAY_TOL", "3"))                                     # a snapshot counts when its `day` is BRAIN_DAY..BRAIN_DAY+TOL
BRAIN_MIN_POSTS = int(envcfg.get("BRAIN_MIN_POSTS", "5"))                                 # comparable posts on ONE platform before what_works_for_you exists
BRAIN_SAMPLES = int(envcfg.get("BRAIN_SAMPLES", "8"))                                     # captions kept as voice samples
BRAIN_SAMPLE_CHARS = int(envcfg.get("BRAIN_SAMPLE_CHARS", "200"))                         # each sample trimmed to this
BRAIN_GROUP_MIN = int(envcfg.get("BRAIN_GROUP_MIN", "4"))                                 # a grouped line needs this many posts in the group AND this many outside it
BRAIN_GROUP_HIGH = float(envcfg.get("BRAIN_GROUP_HIGH", "1.5"))                           # at or above this ratio a group is "beats your median"
BRAIN_GROUP_LOW = float(envcfg.get("BRAIN_GROUP_LOW", "0.6"))                             # at or below it, "falls short"
BRAIN_VOICE_DAYS = float(envcfg.get("BRAIN_VOICE_DAYS", "7"))                             # read_as is recomputed at most this often
BRAIN_VOICE_MODEL = envcfg.get("BRAIN_VOICE_MODEL", "claude-haiku-4-5")
BRAIN_WATCH_MIN = int(envcfg.get("BRAIN_WATCH_MIN", "3"))                                 # posts with a watch time (and, separately, with a length) before how_people_watch says anything

VOICE_MIN_SAMPLES = 5            # fewer captions than this and there is no voice line (a style needs something to show it)
STANDOUT_BEST = 1.3              # a post is one of "your best" at this many times the median or more ...
STANDOUT_QUIET = 0.7             # ... and one of "your quietest" at this many or fewer
GOAL_LAST_N = 5                  # perform goal: the latest 5 posts that have a day-7 count (creator.js GOAL_LAST_N)
VOICE_MAX_RAW = 200              # an answer longer than this is not a one-line description; it is discarded
VOICE_MAX_CHARS = 90             # ... and a kept one is cut to this

BRAINS = "/rest/v1/lynxr_creator_brain"
COACH_NOTES = "/rest/v1/lynxr_coach_notes"
SHAPES = "/rest/v1/lynxr_post_shape"
SHAPE_FIELDS = "post_id,duration_s,speech_start_s,words_first_3s,longest_silence_s,longest_silence_at_s,has_speech,beats,repeats"

NOT_KNOWN_VIDEOS = ("what is actually in your videos — lynxr keeps your captions and your public counts, "
                    "not what you said or showed")
NOT_KNOWN_WORKS = "what works for you — lynxr needs five measured videos on one of your accounts"
NOT_KNOWN_WATCH = "how long people actually watch — connect your tiktok or instagram account in settings and lynxr can read that"

# The goal, in the words a creator would use (creator.js goalLabel says the same things). Keys are the stored priority codes.
GOAL_WORDS = {"deals": "brand deals a month", "rate": "dollars a video", "perform": "views on each video",
              "grow": "followers"}
LEGACY_GOAL = {"views": "perform", "followers": "grow"}      # what an older build stored (creator.js LEGACY_PRIORITY); engagement has no UGC meaning


# ── pure ──────────────────────────────────────────────────────────────────────────────────────────

def parse_ts(s):
    """An aware datetime from an ISO string (a trailing Z and fractional seconds are fine), or None. Copied from post_match.py."""
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
    """A UTC timestamp PostgREST and Python both read."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _tracked(posts):
    """The rows that are the creator's own tracked posts. A row with no `origin` is NOT assumed tracked."""
    return [p for p in (posts or []) if isinstance(p, dict) and p.get("origin") == "tracked"]


def _num(v):
    """A non-negative whole number or None. Absent is None, never zero."""
    if v is None or isinstance(v, bool):
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def views_at(snaps, day=BRAIN_DAY, tol=BRAIN_DAY_TOL):
    """The views of a post's EARLIEST snapshot whose `day` is in [day, day + tol] and whose `views` is not null, else None.
    `snaps` is that post's lynxr_post_views rows.

    WHY THERE IS AN UPPER BOUND. lynxr_post_views.day is age_days(posted_at, now): the post's REAL age when the snapshot was taken,
    not the nominal checkpoint (track_posts.py:measure_pass). A post first discovered at age 23 (a first scan backfills
    TRACK_BACKFILL_DAYS) has a day-23 snapshot and no day-7 one; without the upper bound its 23-day number would be compared against
    another post's 7-day number. Those posts are excluded, deliberately.

    This is stricter than creator.js:metricAtDay, which takes the earliest snapshot with day >= 7 and no upper bound. That function
    feeds a progress read; this one feeds a baseline."""
    best = None
    for s in snaps or []:
        d, v = _num((s or {}).get("day")), _num((s or {}).get("views"))
        if d is None or v is None or not (day <= d <= day + tol):
            continue
        if best is None or d < best[0]:
            best = (d, v)
    return best[1] if best else None


def comparable(posts, snaps_by_post, now):
    """[{post_id, platform, caption, posted_at (an aware datetime), views}] for the posts that are tracked, have a `posted_at`, are
    no older than BRAIN_WINDOW_DAYS, and have a views_at(...) that is not None. Newest first."""
    horizon = now - timedelta(days=BRAIN_WINDOW_DAYS)
    out = []
    for p in _tracked(posts):
        when = parse_ts(p.get("posted_at"))
        if when is None or when < horizon or not p.get("platform"):
            continue
        v = views_at((snaps_by_post or {}).get(p.get("id")))
        if v is None:
            continue
        out.append({"post_id": p.get("id"), "platform": p.get("platform"), "caption": p.get("caption") or "",
                    "posted_at": when, "views": v})
    out.sort(key=lambda r: r["posted_at"], reverse=True)
    return out


def lead_platform(rows):
    """The platform with the most comparable posts; ties go to the larger total views, then to the name, so it is deterministic.
    None for an empty list."""
    tally = {}
    for r in rows or []:
        t = tally.setdefault(r["platform"], [0, 0])
        t[0] += 1
        t[1] += r["views"]
    if not tally:
        return None
    return sorted(tally.items(), key=lambda kv: (-kv[1][0], -kv[1][1], kv[0]))[0][0]


def median_of(values):
    """The median as a whole number. Odd count: the middle one. Even: the mean of the two middle ones, rounded half up."""
    v = sorted(int(x) for x in values)
    n = len(v)
    if not n:
        raise ValueError("median of nothing")
    if n % 2:
        return v[n // 2]
    return (v[n // 2 - 1] + v[n // 2] + 1) // 2


def _rate(v):
    """A 0-1 share as a float, or None."""
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if 0 <= f <= 1 else None


def watch_at(snaps):
    """The newest snapshot of a post's watch figures: the one with the LARGEST `day` whose avg_watch_ms is not null, as
    {"ms", "finished_rate", "skipped_3s_rate", "day"}, else None. `snaps` is that post's lynxr_post_insights rows.

    LARGEST, NOT EARLIEST, the opposite of views_at(). Watch time is a LIFETIME aggregate (the platform reports the average over every
    view so far), so the newest snapshot is the most complete one; a views baseline, by contrast, needs one fixed age to be comparable
    between posts. And never subtract two of these: an average over a growing population is not differenceable."""
    best = None
    for s in snaps or []:
        d, ms = _num((s or {}).get("day")), _num((s or {}).get("avg_watch_ms"))
        if d is None or ms is None:
            continue
        if best is None or d > best["day"]:
            best = {"ms": ms, "finished_rate": _rate(s.get("finished_rate")), "skipped_3s_rate": _rate(s.get("skipped_3s_rate")), "day": d}
    return best


def how_people_watch(posts, watch_by_post, lead, now):
    """The `how_people_watch` section, or None. Only tracked posts on `lead` (the platform what_works_for_you uses), posted within
    BRAIN_WINDOW_DAYS, with a watch_at(...). Fewer than BRAIN_WATCH_MIN of them and there is no median worth the word: None. A key whose
    input is missing is OMITTED, never nulled (this file's standing rule). Captions are the creator's own, cut to 160, like your_best.

    Seconds are to one decimal. The shares (watched fraction, finished, skipped) are 0-1 numbers and are kept to TWO decimals: one decimal
    of a share is a 10-point step, which would turn "about 31%" into "about 30%" in the writer's prompt."""
    if not lead:
        return None
    horizon = now - timedelta(days=BRAIN_WINDOW_DAYS)
    rows = []
    for p in _tracked(posts):
        when = parse_ts(p.get("posted_at"))
        if p.get("platform") != lead or when is None or when < horizon:
            continue
        w = watch_at((watch_by_post or {}).get(p.get("id")))
        if w is None:
            continue
        dur = _num(p.get("duration_s"))
        rows.append({**w, "caption": p.get("caption") or "", "posted_at": when, "duration_s": int(dur) if dur else None,
                     "fraction": (w["ms"] / 1000.0) / dur if dur else None})
    if len(rows) < BRAIN_WATCH_MIN:
        return None
    out = {"platform": lead, "measured": f"how long the average viewer watched, from {lead}'s own numbers", "posts_counted": len(rows),
           "your_median_seconds": round(median_of([int(r["ms"]) for r in rows]) / 1000.0, 1)}
    timed = [r for r in rows if r["fraction"] is not None]
    if len(timed) >= BRAIN_WATCH_MIN:
        out["your_median_watched_fraction"] = round(median_of([int(round(r["fraction"] * 1000)) for r in timed]) / 1000.0, 2)
    for key, field in (("your_median_finished_rate", "finished_rate"), ("your_median_skipped_3s_rate", "skipped_3s_rate")):
        have = [r[field] for r in rows if r[field] is not None]
        if len(have) >= BRAIN_WATCH_MIN:
            out[key] = round(median_of([int(round(x * 1000)) for x in have]) / 1000.0, 2)

    def item(r):
        return {"caption": (r["caption"] or "").strip()[:160], "seconds": round(r["ms"] / 1000.0, 1), "of_seconds": r["duration_s"]}

    if len(timed) >= BRAIN_WATCH_MIN:
        newest_first = sorted(timed, key=lambda r: r["posted_at"], reverse=True)         # ties go to the newer post
        longest = sorted(newest_first, key=lambda r: -r["fraction"])[:2]
        soonest = [r for r in sorted(newest_first, key=lambda r: r["fraction"]) if r not in longest][:1]
        out["they_stayed_longest"] = [item(r) for r in longest]
        if soonest:
            out["they_left_soonest"] = [item(r) for r in soonest]
    return out


# Why this is only four groups: the posts table holds no tags, no duration and no transcript, so a caption attribute and a clock are
# the only true things to group on. Each label says precisely what was measured and must never claim to describe the video.
GROUPS = (
    ("captions with a number in them", lambda r: bool(re.search(r"\d", r["caption"] or ""))),
    ("captions that ask a question", lambda r: "?" in (r["caption"] or "")),
    ("captions under 60 characters", lambda r: len((r["caption"] or "").strip()) < 60),
    ("videos you posted at the weekend", lambda r: r["posted_at"].astimezone(timezone.utc).weekday() in (5, 6)),
)


def grouped(rows, median):
    """(beats, falls_short): for each group in GROUPS with at least BRAIN_GROUP_MIN posts inside it AND outside it, the group's median
    views over the creator's own median. At or above BRAIN_GROUP_HIGH it goes in `beats`, at or below BRAIN_GROUP_LOW in
    `falls_short`, and in between nowhere. beats is sorted by times_median descending, falls_short ascending."""
    beats, short = [], []
    if not median or median <= 0:
        return beats, short
    for label, pred in GROUPS:
        inside = [r for r in rows if pred(r)]
        outside = [r for r in rows if not pred(r)]
        if len(inside) < BRAIN_GROUP_MIN or len(outside) < BRAIN_GROUP_MIN:
            continue
        ratio = median_of([r["views"] for r in inside]) / median
        item = {"what": label, "posts": len(inside), "times_median": round(ratio, 1)}
        if ratio >= BRAIN_GROUP_HIGH:
            beats.append(item)
        elif ratio <= BRAIN_GROUP_LOW:
            short.append(item)
    beats.sort(key=lambda i: -i["times_median"])
    short.sort(key=lambda i: i["times_median"])
    return beats, short


def standouts(rows, median):
    """(your_best, your_quietest): up to 2 posts at STANDOUT_BEST x the median or more (highest first), and up to 1 at STANDOUT_QUIET x
    or less (lowest first). Ties go to the newer post."""
    if not median or median <= 0:
        return [], []

    def item(r):
        return {"caption": (r["caption"] or "").strip()[:160], "views": r["views"],
                "times_median": round(r["views"] / median, 1), "posted": r["posted_at"].strftime("%Y-%m-%d")}

    newest = sorted(rows, key=lambda r: r["posted_at"], reverse=True)
    best = sorted([r for r in newest if r["views"] / median >= STANDOUT_BEST], key=lambda r: -r["views"])[:2]
    quiet = sorted([r for r in newest if r["views"] / median <= STANDOUT_QUIET], key=lambda r: r["views"])[:1]
    return [item(r) for r in best], [item(r) for r in quiet]


def samples_of(posts):
    """Up to BRAIN_SAMPLES captions, newest first, stripped, empties skipped, de-duplicated on the text as it will be kept, each cut to
    BRAIN_SAMPLE_CHARS. Across BOTH platforms: voice is voice."""
    old = datetime.min.replace(tzinfo=timezone.utc)
    ordered = sorted(_tracked(posts), key=lambda p: parse_ts(p.get("posted_at")) or old, reverse=True)
    out, seen = [], set()
    for p in ordered:
        text = str(p.get("caption") or "").strip()[:BRAIN_SAMPLE_CHARS].strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
        if len(out) >= BRAIN_SAMPLES:
            break
    return out


def voice_key(samples):
    """A fingerprint of the captions the voice line was read from."""
    return hashlib.sha1("\n".join(samples).encode()).hexdigest()[:16]


def where_you_post(posts, now):
    """One item per platform with at least one tracked post in the window: {platform, posts, first_at, last_at, per_week}, most posts
    first. per_week is posts / (span in weeks), only when the span is 14+ days and there are 4+ posts, else None."""
    horizon = now - timedelta(days=BRAIN_WINDOW_DAYS)
    by = {}
    for p in _tracked(posts):
        when = parse_ts(p.get("posted_at"))
        if when is None or when < horizon or not p.get("platform"):
            continue
        by.setdefault(p["platform"], []).append(when)
    out = []
    for platform, times in by.items():
        first, last = min(times), max(times)
        span = (last - first).total_seconds() / 86400
        per_week = round(len(times) / (span / 7), 1) if span >= 14 and len(times) >= 4 else None
        out.append({"platform": platform, "posts": len(times), "first_at": first.strftime("%Y-%m-%d"),
                    "last_at": last.strftime("%Y-%m-%d"), "per_week": per_week})
    out.sort(key=lambda i: (-i["posts"], i["platform"]))
    return out


def goal_metric(me):
    """The stored code of what the creator's goal is about: the priority picked, else the goal's own metric (same precedence as
    creator.js:goalMetric), else None. An older build's names are mapped (views -> perform, followers -> grow)."""
    me = me if isinstance(me, dict) else {}
    pri = LEGACY_GOAL.get(me.get("priority"), me.get("priority"))
    if pri in GOAL_WORDS:
        return pri
    g = me.get("goal")
    m = LEGACY_GOAL.get((g or {}).get("metric"), (g or {}).get("metric")) if isinstance(g, dict) else None
    return m if m in GOAL_WORDS else None


def goal_now(metric, posts, snaps_by_post, followers, me, now):
    """Where the creator's goal stands right now, a number, or None when it cannot be said truthfully.

    perform  the MEAN of the day-7 views over the latest GOAL_LAST_N posts that have one. This mirrors creator.js:goalProgress exactly:
             the earliest snapshot with day >= 7 and NO upper bound, newest posts first. It deliberately differs from views_at(): the
             Posts page already shows this number, and the two surfaces must not disagree about the creator's progress. (When no post
             has a day-7 count the Posts page falls back to "so far"; the brain says nothing instead.)
    grow     the sum, over profiles, of each profile's most recent follower count.
    deals    the deals logged in the current UTC calendar month (0 is a real answer).
    rate     the creator's own self-reported rate in dollars."""
    me = me if isinstance(me, dict) else {}
    if metric == "perform":
        old = datetime.min.replace(tzinfo=timezone.utc)
        ordered = sorted(_tracked(posts), key=lambda p: parse_ts(p.get("posted_at")) or old, reverse=True)
        week = []
        for p in ordered:
            best = None
            for s in (snaps_by_post or {}).get(p.get("id")) or []:
                d, v = _num((s or {}).get("day")), _num((s or {}).get("views"))
                if d is not None and v is not None and d >= BRAIN_DAY and (best is None or d < best[0]):
                    best = (d, v)
            if best is not None:
                week.append(best[1])
            if len(week) >= GOAL_LAST_N:
                break
        return (2 * sum(week) + len(week)) // (2 * len(week)) if week else None       # round half up, as Math.round does
    if metric == "grow":
        latest = {}
        for r in followers or []:
            r = r if isinstance(r, dict) else {}
            n, day = _num(r.get("followers")), str(r.get("day") or "")
            k = (r.get("platform"), r.get("handle"))
            if n is not None and day and (k not in latest or day > latest[k][0]):
                latest[k] = (day, n)
        return sum(n for _, n in latest.values()) if latest else None
    if metric == "deals":
        deals = me.get("deals")
        if not isinstance(deals, list):
            return None
        cur = now.astimezone(timezone.utc)
        n = 0
        for d in deals:
            t = parse_ts((d or {}).get("at")) if isinstance(d, dict) else None
            if t is not None:
                t = t.astimezone(timezone.utc)
                n += t.year == cur.year and t.month == cur.month
        return n
    if metric == "rate":
        usd = me["rate"].get("usd") if isinstance(me.get("rate"), dict) else None
        if isinstance(usd, bool) or not isinstance(usd, (int, float)) or usd <= 0:
            return None
        return int(usd) if float(usd).is_integer() else usd
    return None


def about_you(me, goal_now_value):
    """What the creator told onboarding, or None when every field would be empty. A field with nothing in it is left out, not null."""
    me = me if isinstance(me, dict) else {}
    out = {}
    niches = [str(n).strip() for n in (me.get("niches") or []) if isinstance(n, str) and n.strip()] \
        if isinstance(me.get("niches"), list) else []
    if niches:
        out["niche"] = ", ".join(niches[:3])
    metric = goal_metric(me)
    if metric:
        goal = {"metric": GOAL_WORDS[metric]}
        g = me.get("goal")
        if isinstance(g, dict) and LEGACY_GOAL.get(g.get("metric"), g.get("metric")) == metric:
            try:
                if g.get("target") is not None and float(g["target"]) > 0:
                    goal["target"] = g["target"] if isinstance(g["target"], (int, float)) else float(g["target"])
            except (TypeError, ValueError):
                pass
        if goal_now_value is not None:
            goal["now"] = goal_now_value
        out["goal"] = goal
    brands, seen = [], set()
    for b in me.get("brands") if isinstance(me.get("brands"), list) else []:
        name = str((b or {}).get("name") or "").strip() if isinstance(b, dict) else ""
        if name and name not in seen:
            seen.add(name)
            brands.append(name)
    if brands:
        out["brands_you_write_for"] = brands[:8]
    for key, field in (("your_own_words", "about"), ("never_say", "never")):
        text = me.get(field).strip()[:400] if isinstance(me.get(field), str) else ""
        if text:
            out[key] = text
    return out or None


def _voice_plan(samples, previous, now):
    """(carried, need): the previous voice line fields to keep in the body (a dict, maybe empty) and the samples a model call is wanted
    for (a list, or None). The cache rule:
      fewer than VOICE_MIN_SAMPLES captions -> nothing carried, no call (a creator who lost captions loses the line);
      no previous line                      -> call;
      same fingerprint                      -> carry, no call (nothing changed, so the line cannot have);
      changed, line younger than BRAIN_VOICE_DAYS -> carry, no call;
      changed, line at least that old       -> call, and the old line stays until the call succeeds.
    So at most one call per creator per week, and none for a creator who has not posted."""
    if len(samples) < VOICE_MIN_SAMPLES:
        return {}, None
    prev = (previous or {}).get("how_you_sound") if isinstance(previous, dict) else None
    prev = prev if isinstance(prev, dict) else {}
    if not (isinstance(prev.get("read_as"), str) and prev["read_as"].strip()):
        return {}, list(samples)
    carried = {k: prev[k] for k in ("read_as", "read_as_at", "read_as_key") if k in prev}
    if prev.get("read_as_key") == voice_key(samples):
        return carried, None
    at = parse_ts(prev.get("read_as_at"))
    if at is not None and now - at < timedelta(days=BRAIN_VOICE_DAYS):
        return carried, None
    return carried, list(samples)


def coach_inputs(posts, snaps_by_post, now):
    """(rows, lead, median) as the coach needs them: the comparable posts, the lead platform, and the creator's own median views a week in
    (None unless there are BRAIN_MIN_POSTS comparable posts on the lead platform, the same gate what_works_for_you uses, so the Posts page and
    the coach can never disagree about the creator's median)."""
    rows = comparable(_tracked(posts), snaps_by_post, now)
    lead = lead_platform(rows)
    lead_rows = [r for r in rows if r["platform"] == lead]
    ready = lead is not None and len(lead_rows) >= BRAIN_MIN_POSTS
    return rows, lead, (median_of([r["views"] for r in lead_rows]) if ready else None)


def build(me, posts, snaps_by_post, profiles, followers, now, previous=None, watch_by_post=None, shape_by_post=None, prev_note=None,
          coach_on=None):
    """(body, voice_need, note): the whole document, the samples a voice call is wanted for (None = no call), and the coach's note (None when
    the coach is off). No network. `previous` is the last stored body, or None; the voice line is carried over from it unchanged, and the caller
    owns the model call. `watch_by_post` is {post_id: [lynxr_post_insights rows]} or None (a creator with no connected account, or a read that
    blipped: both mean no section). `shape_by_post` is {post_id: lynxr_post_shape row} and `prev_note` the last stored coach note; both are
    read only when the coach is on. `coach_on` overrides the COACH flag (--print shows what the coach would say without turning it on)."""
    me = me if isinstance(me, dict) else {}
    tracked = _tracked(posts)
    rows = comparable(tracked, snaps_by_post, now)
    lead = lead_platform(rows)
    lead_rows = [r for r in rows if r["platform"] == lead]
    ready = lead is not None and len(lead_rows) >= BRAIN_MIN_POSTS

    # Follower counts count only for verified profiles, and only when EVERY verified profile has one: a sum over some of them would
    # understate the goal, and a wrong line is a bug.
    verified = {(p.get("platform"), p.get("handle")) for p in (profiles or []) if isinstance(p, dict)}
    mine = [r for r in (followers or []) if isinstance(r, dict) and (r.get("platform"), r.get("handle")) in verified]
    have = {(r.get("platform"), r.get("handle")) for r in mine}
    metric = goal_metric(me)
    now_value = goal_now(metric, tracked, snaps_by_post, mine if verified and have >= verified else [], me, now)
    about = about_you(me, now_value)

    state = "ready" if ready else "empty" if not tracked and about is None else "learning"
    samples = samples_of(tracked)
    carried, need = _voice_plan(samples, previous, now)

    body = {"v": 1, "state": state, "built_at": iso(now)}
    if about is not None:
        body["about_you"] = about
    if samples:
        body["how_you_sound"] = {"from": "your captions", "samples": samples, **carried}
    where = where_you_post(tracked, now)
    if where:
        body["where_you_post"] = where
    if ready:
        median = median_of([r["views"] for r in lead_rows])
        beats, short = grouped(lead_rows, median)
        best, quiet = standouts(lead_rows, median)
        body["what_works_for_you"] = {
            "platform": lead, "measured": f"views {BRAIN_DAY} days after posting", "your_median_views": median,
            "posts_counted": len(lead_rows), "beats_your_median": beats, "falls_short": short,
            "your_best": best, "your_quietest": quiet}
    hpw = how_people_watch(tracked, watch_by_post, lead, now)
    if hpw:
        body["how_people_watch"] = hpw
    body["not_known"] = [NOT_KNOWN_VIDEOS] + ([] if ready else [NOT_KNOWN_WORKS]) + ([] if hpw else [NOT_KNOWN_WATCH])
    # The coach, when it is on, writes the one thing to work on; off (the default), this is [] exactly as it was before the coach existed.
    note, mirror = None, []
    if C.COACH if coach_on is None else coach_on:
        note, mirror = C.coach(tracked, snaps_by_post, shape_by_post, rows, lead, median if ready else None, prev_note, now)
    body["working_on"] = mirror
    return body, need, note


# ── the voice line ────────────────────────────────────────────────────────────────────────────────

# ~250 tokens: well under P.CACHE_MIN_TOKENS (512), so a cache_control marker would be silently ignored. It is therefore NOT wrapped
# in P.sys_block() — that would read as caching without caching.
VOICE_SYSTEM = """You read a creator's own video captions and say, in ONE short line, how they write.

Describe only what the captions show: sentence length, punctuation habits, emoji and hashtag
use, slang, swearing, whether they ask questions, whether they shout in capitals, how direct
they are. Nothing else.

Rules:
- One line. Fewer than 90 characters. No full stop at the end.
- Describe the WRITING, never the person, their job, their niche or their audience.
- No praise, no advice, no suggestions, no comparison to any other creator.
- Invent nothing. If the captions are too few, too short or too alike to show a style,
  answer exactly: not enough to tell
- Write it as the continuation of "they write ...", but do not include those words.

The shape wanted, as examples only — these are not this creator:
short, blunt, no emoji, often opens on a number
long and chatty, lots of emoji, ends on a question"""


def clean_voice(text):
    """The model's answer as the stored line, or None. Strip, collapse whitespace, remove matching surrounding quotes, drop one trailing
    full stop. None when it is empty, when the raw answer is longer than VOICE_MAX_RAW (that is not one line), or when it says "not
    enough to tell". Otherwise cut to VOICE_MAX_CHARS at the last space. NOT lowercased: house style is text-transform in app.css."""
    raw = str(text or "")
    if len(raw) > VOICE_MAX_RAW:
        return None
    s = re.sub(r"\s+", " ", raw).strip()
    if len(s) >= 2 and (s[0], s[-1]) in (('"', '"'), ("'", "'"), ("“", "”"), ("‘", "’")):
        s = s[1:-1].strip()
    if s.endswith("."):
        s = s[:-1].rstrip()
    if not s or s.lower().rstrip(" .!?") == "not enough to tell":
        return None
    if len(s) > VOICE_MAX_CHARS:
        cut = s[:VOICE_MAX_CHARS]
        if s[VOICE_MAX_CHARS] != " " and " " in cut:
            cut = cut[:cut.rfind(" ")]
        s = cut.rstrip(" ,;:-")
    return s or None


def voice_content(samples):
    """The user message: the captions, one numbered line each (a caption's own line breaks become spaces)."""
    flat = [re.sub(r"[\r\n]+", " ", c) for c in samples]
    lines = [f'{i}. "{c}"' for i, c in enumerate(flat, 1)]
    return "Here are up to 8 of one creator's own captions, newest first.\n\n" + "\n".join(lines)


def voice_line(aclient, samples, key=None, usage_out=None):
    """One Haiku call over `samples`, returned as the cleaned line, or None. NEVER RAISES, and never calls the model while BRAIN_VOICE is
    off (this function is the last gate: it is what sends a creator's captions to Anthropic).

    No output_config.effort: Haiku 4.5 rejects it with a 400 (process_adaptations.py's tag call guards the same way). No `thinking`
    parameter: Haiku 4.5 is not an adaptive-thinking model and this is a one-line classification. Not P.structured(): that helper
    hardcodes MODEL (Opus 5) and a JSON schema, and this wants one line of text.

    Spend: when `key` is given the cost is written with P.record_cost (id8 "brain"); `usage_out`, when given, is filled with the same
    tally either way. P.note_usage is NOT used: it writes a thread-local the worker's other lanes share."""
    if not BRAIN_VOICE:
        log.info("brain: voice line unavailable (%s)", "BRAIN_VOICE is off")
        return None
    try:
        msg = aclient.messages.create(
            model=BRAIN_VOICE_MODEL, max_tokens=100,
            system=VOICE_SYSTEM,
            messages=[{"role": "user", "content": voice_content(samples)}])
        u = getattr(msg, "usage", None)
        tally = {BRAIN_VOICE_MODEL: {"in": int(getattr(u, "input_tokens", 0) or 0), "out": int(getattr(u, "output_tokens", 0) or 0),
                                      "write": int(getattr(u, "cache_creation_input_tokens", 0) or 0),
                                      "read": int(getattr(u, "cache_read_input_tokens", 0) or 0), "calls": 1}}
        if usage_out is not None:
            usage_out.update(tally)
        if key:
            P.record_cost(key, "brain", True, tally)
        return clean_voice(P.first_text(msg))
    except Exception as e:  # noqa: BLE001
        log.info("brain: voice line unavailable (%s)", type(e).__name__)
        return None


def apply_voice(body, samples, get_client, key=None, usage_out=None, now=None):
    """Ask for the voice line and put it in `body` (read_as, read_as_at, read_as_key). True on success. On ANY failure — no key, a model
    error, an answer that cleans to nothing — the body is left exactly as it was, so the previous line (if any) stays. The voice line
    never blocks the document."""
    if not BRAIN_VOICE or not samples or "how_you_sound" not in body:
        return False
    client = get_client()
    if client is None:
        log.info("brain: voice line unavailable (%s)", "no client")
        return False
    line = voice_line(client, samples, key=key, usage_out=usage_out)
    if line is None:
        return False
    hs = body["how_you_sound"]
    hs["read_as"], hs["read_as_at"], hs["read_as_key"] = line, iso(now or datetime.now(timezone.utc)), voice_key(samples)
    return True


def _client_getter():
    """A function that builds the Anthropic client lazily and once, or returns None when there is no usable key. Called only when a voice
    call is actually wanted, so a pass with BRAIN_VOICE off or nothing to say never builds one (or even reads .env)."""
    box = {}

    def get():
        if "c" not in box:
            box["c"] = None
            try:
                env = P.load_env(P.ROOT / ".env")
                api_key = envcfg.secret("ANTHROPIC_API_KEY", env.get("ANTHROPIC_API_KEY"), os.environ.get("ANTHROPIC_API_KEY"))
                box["c"] = P.anthropic_client(api_key) if api_key else None
            except Exception as e:  # noqa: BLE001
                log.info("brain: voice line unavailable (%s)", type(e).__name__)
        return box["c"]
    return get


# ── reading a creator (I/O, none of it raises) ────────────────────────────────────────────────────

def read_creator(T, key, cid):
    """The reads that make a body (the watch-time ones optional), plus the previous body. Returns a dict, or None when a read that must not be partial failed
    (the creator's data, their posts, or their previous body): a half-read creator must not overwrite a good brain with a thinner one.
    The profile, follower and snapshot reads degrade only their own field."""
    c = T.q(cid)
    st, rows = T.rest(key, f"/rest/v1/lynxr_creators?id=eq.{c}&select=data")
    if st != 200 or not isinstance(rows, list):
        return None
    me = (rows[0].get("data") if rows and isinstance(rows[0], dict) else None) or {}
    st, posts = T.rest(key, f"/rest/v1/lynxr_posts?creator_id=eq.{c}&origin=eq.tracked&select=id,origin,platform,caption,posted_at,views"
                            "&order=posted_at.desc.nullslast&limit=300")
    if st != 200 or not isinstance(posts, list):
        return None
    # PostgREST caps a response at the project's max-rows (1000 by default) whatever limit is asked for; ordering newest post first means
    # a cap would drop the oldest posts' snapshots, which only lowers how many posts are comparable.
    st, views = T.rest(key, f"/rest/v1/lynxr_post_views?creator_id=eq.{c}&select=post_id,day,views&order=post_id.desc,day.asc&limit=2000")
    snaps = {}
    for s in views if st == 200 and isinstance(views, list) else []:
        snaps.setdefault(s.get("post_id"), []).append(s)
    # Watch time (supabase/platform_insights.sql). Degrades only its own field: a creator whose insight read blipped, or a database where
    # that file is not applied yet, still gets the rest of their brain, and `watch` stays empty.
    st, ins = T.rest(key, f"/rest/v1/lynxr_post_insights?creator_id=eq.{c}&select=post_id,day,avg_watch_ms,finished_rate,skipped_3s_rate"
                          "&order=post_id.desc,day.asc&limit=2000")
    watch = {}
    for s in ins if st == 200 and isinstance(ins, list) else []:
        watch.setdefault(s.get("post_id"), []).append(s)
    if watch:
        # The video's length is a separate read, NOT another column on the posts read above: that read must never fail (a 400 for a
        # column the SQL has not added yet would skip every creator), and this one is only worth making when there is a watch time.
        st, durs = T.rest(key, f"/rest/v1/lynxr_posts?creator_id=eq.{c}&origin=eq.tracked&duration_s=not.is.null&select=id,duration_s&limit=300")
        by_id = {d.get("id"): d.get("duration_s") for d in durs} if st == 200 and isinstance(durs, list) else {}
        for p in posts:
            if p.get("id") in by_id:
                p["duration_s"] = by_id[p["id"]]
    st, profiles = T.rest(key, f"/rest/v1/lynxr_profiles?creator_id=eq.{c}&verified_at=not.is.null&select=platform,handle")
    profiles = profiles if st == 200 and isinstance(profiles, list) else []
    st, followers = T.rest(key, f"/rest/v1/lynxr_profile_followers?creator_id=eq.{c}&select=platform,handle,day,followers"
                                "&order=day.desc&limit=200")
    followers = followers if st == 200 and isinstance(followers, list) else []
    st, prev = T.rest(key, f"{BRAINS}?creator_id=eq.{c}&select=body")
    if st in (400, 404):
        prev = []                    # the table is not there (yet): there is no previous body, and --print can still read the rest
    elif st != 200 or not isinstance(prev, list):
        return None                  # an unreadable previous body would reset the voice cache and cost a call; skip the creator
    previous = prev[0].get("body") if prev and isinstance(prev[0], dict) else None
    return {"me": me, "posts": posts, "snaps": snaps, "profiles": profiles, "followers": followers, "watch": watch,
            "previous": previous if isinstance(previous, dict) else None}


def _done(stats):
    log.info("brain: due %d · built %d · voiced %d · voice failed %d · failed %d",
             stats["brain_due"], stats["built"], stats["voiced"], stats["voice_failed"], stats["brain_failed"])
    return stats


def brain_pass(key, now, dry=False, T=None):
    """One pass of the lane. `T` is the RUNNING track_posts module (it runs as __main__, so this file must not import it; see showcase.py).
    Returns the counts, or {} when the lane is off, has no module to borrow, or supabase/creator_brain.sql is not applied."""
    if not BRAIN or T is None:
        return {}
    stats = {"brain_due": 0, "built": 0, "voiced": 0, "voice_failed": 0, "brain_failed": 0}
    status, creators = T.rest(key, f"/rest/v1/lynxr_creators?select=id&limit={BRAIN_SCAN_LIMIT}")     # past BRAIN_SCAN_LIMIT accounts this needs paging
    if status != 200 or not isinstance(creators, list):
        if status:
            log.info("brain: lynxr_creators not readable (HTTP %s)", status)
        return stats
    status, brains = T.rest(key, f"{BRAINS}?select=creator_id,built_at&limit={BRAIN_SCAN_LIMIT}")
    if status in (400, 404):
        log.info("brain: lynxr_creator_brain not readable — is supabase/creator_brain.sql applied?")
        return {}
    if status != 200 or not isinstance(brains, list):
        return stats
    built = {b.get("creator_id"): parse_ts(b.get("built_at")) for b in brains if isinstance(b, dict)}
    horizon = now - timedelta(hours=BRAIN_EVERY_H)
    old = datetime.min.replace(tzinfo=timezone.utc)
    due = [{"creator_id": c["id"], "built_at": built.get(c["id"])} for c in creators if isinstance(c, dict) and c.get("id")
           and (built.get(c["id"]) is None or built[c["id"]] < horizon)]
    due.sort(key=lambda r: r["built_at"] or old)                    # missing rows first, then the oldest
    stats["brain_due"] = len(due)
    if dry:
        return _done(stats)                                          # before any read of a creator's data and before any model call
    cache = {}
    get_client = _client_getter()
    for r in T.by_tier(due, key, cache)[:BRAIN_PER_PASS]:
        if T.P.queued_work(key):
            break                                                    # creators first
        try:
            got = read_creator(T, key, r["creator_id"])
            if got is None:
                stats["brain_failed"] += 1
                continue
            body, need = build(got["me"], got["posts"], got["snaps"], got["profiles"], got["followers"], now, got["previous"], got["watch"])
            if need and BRAIN_VOICE:
                if apply_voice(body, need, get_client, key=key, now=now):
                    stats["voiced"] += 1
                else:
                    stats["voice_failed"] += 1
            status, _ = T.rest(key, f"{BRAINS}?on_conflict=creator_id", method="POST",
                               body={"creator_id": r["creator_id"], "body": body, "built_at": iso(now)},
                               prefer="resolution=merge-duplicates,return=minimal")
            if 200 <= status < 300:
                stats["built"] += 1
            else:
                stats["brain_failed"] += 1
        except Exception as e:  # noqa: BLE001 — a broken brain must never stop the pass
            log.info("brain: build failed (%s)", type(e).__name__)
            stats["brain_failed"] += 1
    return _done(stats)


# ── by hand ───────────────────────────────────────────────────────────────────────────────────────

def why_table(posts, snaps_by_post, now):
    """The lines that explain every omission: one row per tracked post, and whether it counts toward a baseline and, if not, why. Then a
    one-line summary of the comparable posts per platform, the lead platform and the state."""
    counted = {r["post_id"]: r for r in comparable(posts, snaps_by_post, now)}
    tracked = sorted(_tracked(posts), key=lambda p: parse_ts(p.get("posted_at")) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    lo, hi = BRAIN_DAY, BRAIN_DAY + BRAIN_DAY_TOL
    lines = [f"{'post':<9} {'platform':<10} {'posted':<12} {'snapshot days':<18} {'day7 views':<11} counts?"]
    for p in tracked:
        snaps = sorted((s for s in (snaps_by_post or {}).get(p.get("id")) or [] if _num(s.get("day")) is not None),
                       key=lambda s: s["day"])
        days = ",".join(str(s["day"]) for s in snaps) or "—"
        when = parse_ts(p.get("posted_at"))
        got = counted.get(p.get("id"))
        if got is not None:
            verdict, v = "yes", f"{got['views']:,}"
        else:
            v = "—"
            measured = [s for s in snaps if _num(s.get("views")) is not None]
            if when is None:
                verdict = "no: no posting date"
            elif when < now - timedelta(days=BRAIN_WINDOW_DAYS):
                verdict = f"no: older than {BRAIN_WINDOW_DAYS:g} days"
            elif not measured:
                verdict = "no: no snapshot with a view count yet"
            elif any(lo <= s["day"] <= hi for s in measured):
                verdict = "no: not counted (no platform recorded)"
            elif measured[0]["day"] > hi:
                verdict = f"no: first snapshot at day {measured[0]['day']} (backfilled)"
            elif any(s["day"] > hi for s in measured):
                verdict = f"no: no snapshot at day {lo}-{hi} (next at day {next(s['day'] for s in measured if s['day'] > hi)})"
            else:
                verdict = f"no: no snapshot at day {lo}-{hi} yet"
        lines.append(f"{str(p.get('id')):<9} {str(p.get('platform')):<10} {(when.strftime('%Y-%m-%d') if when else '—'):<12} "
                     f"{days:<18} {v:<11} {verdict}")
    per = {}
    for r in counted.values():
        per[r["platform"]] = per.get(r["platform"], 0) + 1
    lead = lead_platform(list(counted.values()))
    state = "ready" if lead and per[lead] >= BRAIN_MIN_POSTS else "learning"
    lines.append("comparable: " + (", ".join(f"{n} on {p}" for p, n in sorted(per.items(), key=lambda kv: -kv[1])) or "none")
                 + f" → lead {lead or 'none'}, state {state}")
    return lines


def print_creator(T, key, cid, why=False, voice=False):
    """Build one creator's body from the live database and print it. Writes nothing: no upsert, no cost row. Returns the exit code."""
    got = read_creator(T, key, cid)
    if got is None:
        print("could not read that creator (HTTP error, or supabase/creator_brain.sql is not applied)")
        return 1
    now = datetime.now(timezone.utc)
    print("# warning: the output below holds the creator's own captions. Keep it off any public surface.")
    if why:
        print("\n".join(why_table(got["posts"], got["snaps"], now)))
        print()
    body, need = build(got["me"], got["posts"], got["snaps"], got["profiles"], got["followers"], now, got["previous"], got["watch"])
    if voice:
        if not BRAIN_VOICE:
            print("# --voice did nothing: BRAIN_VOICE is off. Set BRAIN_VOICE=1 in the environment to make the call "
                  "(it sends up to 8 of this creator's captions to Anthropic).")
        elif not need:
            print("# --voice: no call wanted (fewer than 5 captions, or the stored line is current).")
        else:
            spent = {}
            ok = apply_voice(body, need, _client_getter(), key=None, usage_out=spent, now=now)
            for model, d in spent.items():
                cost = P.cost_of(model, d)
                print(f"# voice call: {model}, {d['in']} in / {d['out']} out, "
                      + (f"${cost:.5f}" if cost is not None else "no price on file") + (" (line kept)" if ok else " (no line kept)"))
            if not spent:
                print("# voice call: made no usable call (no key, or it failed); see the log line above.")
    print(json.dumps(body, indent=2, ensure_ascii=False))
    return 0


def main():
    envcfg.sanitize_environ()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="count what is due; reads no creator's data, makes no model call, writes nothing")
    ap.add_argument("--print", dest="print_uuid", metavar="CREATOR_UUID",
                    help="build that creator's body from the live database and print it; writes nothing")
    ap.add_argument("--why", action="store_true", help="with --print: first print the table that explains the omissions")
    ap.add_argument("--voice", action="store_true",
                    help="with --print: also make the real Haiku call (needs BRAIN_VOICE=1 in the environment; sends captions to Anthropic)")
    args = ap.parse_args()
    if not args.dry_run and not args.print_uuid:
        ap.error("give --dry-run or --print CREATOR_UUID")
    import track_posts as T                      # here and only here: see the docstring
    env = P.load_env(P.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"),
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
    if args.print_uuid:
        sys.exit(print_creator(T, key, args.print_uuid, why=args.why, voice=args.voice))
    stats = brain_pass(key, datetime.now(timezone.utc), dry=True, T=T)
    if not stats:
        print("the lane is off, or lynxr_creator_brain is not readable (is supabase/creator_brain.sql applied?)")
        sys.exit(1)
    print(f"brain_due {stats['brain_due']}, built {stats['built']}")


if __name__ == "__main__":
    main()
