"""Offline checks for pipeline/coach.py, the pure coach: how a video's views moved, the moments in its audio, the one thing that separates a
creator's stronger videos from their quieter ones, and the score it keeps. No network, no Supabase, no model call. Same check()/FAILS style as
pipeline/test_post_shape.py.

Every handle, uuid, post id and number below is invented for this test. No real creator, caption or id goes in this file: it is checked into
a public repo.

Run with

    ./venv/bin/python pipeline/test_coach.py
"""
import ast
import copy
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import coach as C  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


NOW = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)
POSTED = datetime(2026, 9, 20, 10, 0, 0, tzinfo=timezone.utc)


def at(hours, base=POSTED):
    return C.iso(base + timedelta(hours=hours))


def snaps(*pts, base=POSTED):
    """(day, views, hours after posting) -> lynxr_post_views rows."""
    return [{"day": d, "views": v, "at": at(h, base)} for d, v, h in pts]


# ── 1. curve ─────────────────────────────────────────────────────────────────────────────────────
cv = C.curve(snaps((0, 300, 2), (1, 320, 26)), POSTED)
check("curve: two readings with almost no growth between them -> stopped_early, with the two hours",
      (cv["kind"], cv["from_h"], cv["by_h"], cv["days"], cv["views"]), ("stopped_early", 2, 26, 1, 320))
cv = C.curve(snaps((0, 300, 2), (1, 900, 26), (3, 950, 74)), POSTED)
check("curve: it grew, then stalled after the early window -> levelled_off", (cv["kind"], cv["from_h"], cv["by_h"]), ("levelled_off", 26, 74))
cv = C.curve(snaps((0, 300, 2), (1, 900, 26), (3, 2000, 74), (7, 4200, 170)), POSTED)
check("curve: still growing at the last reading, young -> climbing", (cv["kind"], cv["days"], "by_h" in cv), ("climbing", 7, False))
cv = C.curve(snaps((0, 300, 2), (1, 900, 26), (7, 4200, 170), (20, 9000, 480)), POSTED)
check("curve: still growing but older than COACH_CURVE_DAYS -> grew", cv["kind"], "grew")
cv = C.curve(snaps((0, 300, 2), (1, 305, 26), (3, 900, 74), (7, 4200, 170)), POSTED)
check("curve: a stall that later RESUMED is not 'stopped': the last interval decides", cv["kind"], "climbing")
cv = C.curve(snaps((0, 300, 2), (1, 310, 26), (3, 312, 74), (7, 313, 170)), POSTED)
check("curve: a stall that persisted to the end is reported from where it began", (cv["kind"], cv["from_h"], cv["by_h"]), ("stopped_early", 2, 26))
check("curve: all-zero readings -> no_views", C.curve(snaps((0, 0, 2), (1, 0, 26), (3, 0, 74)), POSTED)["kind"], "no_views")
check("curve: one reading -> None", C.curve(snaps((0, 300, 2)), POSTED), None)
check("curve: no readings -> None", (C.curve([], POSTED), C.curve(None, POSTED)), (None, None))
check("curve: a post discovered late (earliest reading day 23) has no early reading -> None", C.curve(snaps((23, 500, 560), (30, 600, 720)), POSTED), None)
check("curve: a reading with no view count is ignored", C.curve([{"day": 0, "views": None, "at": at(2)}, *snaps((1, 5, 26))], POSTED), None)
check("curve: no posted_at -> None", C.curve(snaps((0, 1, 2), (1, 2, 26)), None), None)
check("curve: a reading with no `at` is placed at its day", C.curve([{"day": 0, "views": 100}, {"day": 1, "views": 100}], POSTED)["by_h"], 24)

# ── 2. the sentences, one per kind ───────────────────────────────────────────────────────────────
check("line: stopped_early says between which two hours", C.line_for({"kind": "stopped_early", "from_h": 2, "by_h": 26, "days": 1}),
      "it had almost stopped growing between hour 2 and hour 26")
check("line: climbing", C.line_for({"kind": "climbing", "days": 7}), "it was still climbing at its last reading, on day 7")
check("line: grew", C.line_for({"kind": "grew", "days": 20}), "it kept growing through day 20")
check("line: no_views", C.line_for({"kind": "no_views", "days": 3}), "it has no views in the readings lynxr took")
check("line: against the creator's own usual, only when there is one",
      C.line_for({"kind": "climbing", "days": 7}, 4200, 1.4), "it was still climbing at its last reading, on day 7; 4,200 views a week in, 1.4× your own usual")
check("line: no curve -> empty", C.line_for(None, 5, 1.0), "")
check("verdict: thresholds", (C.verdict(1.3), C.verdict(1.29), C.verdict(0.7), C.verdict(0.71), C.verdict(None)), ("stronger", "usual", "weaker", "usual", None))

# ── 3. signal_values and moments ─────────────────────────────────────────────────────────────────
SH = {"has_speech": True, "segments": 5, "duration_s": 21.0, "speech_start_s": 2.9, "words_first_3s": 4, "longest_silence_s": 1.2, "longest_silence_at_s": 7.4,
      "beats": [{"i": 1, "of": 4, "kind": "beat", "start_s": 2.9, "end_s": 8.1, "planned_s": 0.0},
                {"i": 2, "of": 4, "kind": "beat", "start_s": 9.0, "end_s": 12.0, "planned_s": 3.0},
                {"i": 3, "of": 4, "kind": "beat", "found": False},
                {"of": 4, "kind": "cta", "start_s": 15.0, "end_s": 18.0}],
      "repeats": [{"at_s": 6.1, "of_s": 2.9}]}
v = C.signal_values(SH)
check("signal_values: all six, hook_end from beat 1's end, repeat_count from the repeats", v,
      {"speech_start_s": 2.9, "longest_silence_s": 1.2, "words_first_3s": 4.0, "duration_s": 21.0, "hook_end_s": 8.1, "repeat_count": 1.0})
check("signal_values: a music-only video has no speech signals and no repeat_count of zero",
      C.signal_values({"has_speech": False, "segments": 0, "duration_s": 14.0}), {"duration_s": 14.0})
check("signal_values: a speech video with no repeats has a REAL zero", C.signal_values({"has_speech": True, "speech_start_s": 0.4})["repeat_count"], 0.0)
check("signal_values: an unfound opening beat gives no hook_end_s", "hook_end_s" in C.signal_values({**SH, "beats": [{"i": 1, "kind": "beat", "found": False}]}), False)
check("signal_values: nothing in, nothing out", (C.signal_values(None), C.signal_values({})), ({}, {}))

m = C.moments(SH)
check("moments: capped at three, chosen repeat > late beat > gap > quiet start > missed beat, shown in time order",
      [(x["kind"], x["at_s"]) for x in m], [("repeat", 6.1), ("gap", 7.4), ("late_beat", 9.0)])
check("moments: the repeat names both seconds", [x["text"] for x in m if x["kind"] == "repeat"], ["at second 6.1 you say again what you said at second 2.9"])
check("moments: a late beat names the script's own second", [x["text"] for x in m if x["kind"] == "late_beat"],
      ["beat 2 of your script starts at second 9; the script has it at second 3"])
check("moments: a stretch with nobody speaking", [x["text"] for x in m if x["kind"] == "gap"], ["nobody spoke for 1.2 seconds, from second 7.4"])
only = C.moments({"speech_start_s": 2.9, "beats": [{"i": 3, "kind": "beat", "found": False}]})
check("moments: a quiet start and an unheard beat", [(x["kind"], x["at_s"]) for x in only], [("quiet_start", 0.0), ("missed_beat", None)])
check("moments: the unheard beat is worded as what lynxr heard, not what the creator did", [x["text"] for x in only if x["kind"] == "missed_beat"],
      ["lynxr did not hear beat 3 of your script"])
check("moments: nothing notable -> []", C.moments({"speech_start_s": 0.4, "longest_silence_s": 0.3, "longest_silence_at_s": 2.0,
                                                    "beats": [{"i": 1, "kind": "beat", "start_s": 0.4, "end_s": 3.0, "planned_s": 0.0}]}), [])
check("moments: a beat only a second late is not a moment",
      C.moments({"beats": [{"i": 2, "kind": "beat", "start_s": 4.0, "end_s": 6.0, "planned_s": 3.0}]}), [])
check("moments: none and junk", (C.moments(None), C.moments({})), ([], []))
check("moments: every moment carries a second or an explicit none, and plain numbers", all("text" in x for x in m), True)


def row(views, **vals):
    return {"views": views, "values": {k: float(x) for k, x in vals.items()}}


# ── 3b. the line with the most specifics and the payoff beat ─────────────────────────────────────
SP = {"has_speech": True, "speech_start_s": 0.4, "best_line_at_s": 22.0,
      "beats": [{"i": 1, "of": 4, "kind": "beat", "start_s": 0.4, "end_s": 3.0, "planned_s": 0.0},
                {"i": 3, "of": 4, "kind": "beat", "payoff": True, "start_s": 6.0, "end_s": 9.0, "planned_s": 12.0}]}
v = C.signal_values(SP)
check("signal_values: best_line_s is the second, payoff_off_s the distance from where the script puts the payoff (either side)",
      (v["best_line_s"], v["payoff_off_s"]), (22.0, 6.0))
check("signal_values: a payoff said LATE is as far off as one said early", C.signal_values({"has_speech": True, "beats": [{"i": 3, "kind": "beat", "payoff": True, "start_s": 18.0, "planned_s": 12.0}]})["payoff_off_s"], 6.0)
check("signal_values: an unheard payoff gives no payoff_off_s", "payoff_off_s" in C.signal_values({"has_speech": True, "beats": [{"i": 3, "kind": "beat", "payoff": True, "found": False}]}), False)
check("signal_values: no payoff flag, no payoff_off_s", "payoff_off_s" in C.signal_values({"has_speech": True, "beats": [{"i": 2, "kind": "beat", "start_s": 6.0, "planned_s": 12.0}]}), False)
m = {x["kind"]: x["text"] for x in C.moments(SP)}
check("moments: the line with the most numbers and names, as a second, only once it is past the opening", m["late_line"], "the line with the most numbers and names in it starts at second 22")
check("moments: a payoff said before the script puts it", m["payoff_early"], "the payoff beat of your script (beat 3) starts at second 6, 6 seconds before the script puts it")
check("moments: a payoff said after", [x["text"] for x in C.moments({"beats": [{"i": 3, "kind": "beat", "payoff": True, "start_s": 18.0, "planned_s": 12.0}]})],
      ["the payoff beat of your script (beat 3) starts at second 18, 6 seconds after the script puts it"])
check("moments: a payoff within two seconds of the script is no moment",
      C.moments({"beats": [{"i": 3, "kind": "beat", "payoff": True, "start_s": 13.0, "planned_s": 12.0}]}), [])
check("moments: an unheard payoff beat is its own moment, and the generic 'missed beat' is not added for it",
      [(x["kind"], x["text"]) for x in C.moments({"beats": [{"i": 3, "kind": "beat", "payoff": True, "found": False}]})],
      [("payoff_missing", "lynxr did not hear the payoff beat of your script (beat 3)")])
check("moments: a payoff beat is never also reported as a late beat", [x["kind"] for x in C.moments({"beats": [{"i": 3, "kind": "beat", "payoff": True, "start_s": 18.0, "planned_s": 12.0}]})], ["payoff_late"])
check("moments: a best line inside the first ten seconds is no moment", C.moments({"best_line_at_s": 4.0}), [])
check("moments: the payoff and the late best line outrank a repeat, a gap and a quiet start when only three fit (shown in time order)",
      [x["kind"] for x in C.moments({**SP, "repeats": [{"at_s": 7.0, "of_s": 1.0}], "longest_silence_s": 1.5, "longest_silence_at_s": 4.0, "speech_start_s": 2.0})],
      ["payoff_early", "repeat", "late_line"])
bl = [row(1000, best_line_s=4), row(900, best_line_s=5), row(200, best_line_s=22), row(100, best_line_s=24)]
sb = C.separation(bl)
check("separation: best_line_s clears when the stronger videos reach it earlier", (sb["signal"], sb["m_good"], sb["m_poor"]), ("best_line_s", 4.5, 23.0))
check("advise: the best line, rounded UP to a reachable second", C.advise(sb, NOW)["said"], "get to your line with the most numbers and names by second 5")
check("advise: the evidence names both medians in the creator's own seconds", C.advise(sb, NOW)["because"],
      "your 2 stronger videos typically reached their line with the most numbers and names by second 4.5; your 2 quieter ones typically did not reach their line with the most numbers and names until second 23")
po = [row(1000, payoff_off_s=0.5), row(900, payoff_off_s=1.0), row(200, payoff_off_s=7.0), row(100, payoff_off_s=9.0)]
sp = C.separation(po)
check("separation: payoff_off_s clears when the stronger videos landed the payoff nearer the script's own second", (sp["signal"], sp["m_good"], sp["m_poor"]), ("payoff_off_s", 0.75, 8.0))
check("advise: the payoff, within a reachable number of seconds", C.advise(sp, NOW)["said"], "land the payoff within 1s of where your script puts it")
check("shape numbers carry the best line for the max depth", C.shape_numbers(SP)["best_line_at_s"], 22.0)
check("COACH_SIGNALS order: the script-aligned measurements come before the plain ones, the plainest last",
      list(C.SIGNAL_KEYS), ["speech_start_s", "hook_end_s", "payoff_off_s", "longest_silence_s", "repeat_count", "best_line_s", "words_first_3s", "duration_s"])

# ── 4. separation ────────────────────────────────────────────────────────────────────────────────
FOUR = [row(1000, speech_start_s=0.5), row(900, speech_start_s=0.7), row(200, speech_start_s=2.4), row(100, speech_start_s=2.6)]
check("separation: three shaped videos -> None", C.separation(FOUR[:3]), None)
sep = C.separation(FOUR)
check("separation: four, with a 1.9 s gap in speech_start_s -> that signal", (sep["signal"], sep["m_good"], sep["m_poor"], sep["n_good"], sep["n_poor"]),
      ("speech_start_s", 0.6, 2.5, 2, 2))
flat = [row(1000, speech_start_s=0.5, words_first_3s=9, duration_s=10), row(900, speech_start_s=0.6, words_first_3s=9, duration_s=10),
        row(200, speech_start_s=0.7, words_first_3s=8, duration_s=11), row(100, speech_start_s=0.8, words_first_3s=8, duration_s=11)]
check("separation: a gap below the minimum on every signal -> None", C.separation(flat), None)
two = [row(1000, speech_start_s=0.5, words_first_3s=20), row(900, speech_start_s=0.5, words_first_3s=20),
       row(200, speech_start_s=2.5, words_first_3s=4), row(100, speech_start_s=2.5, words_first_3s=4)]
check("separation: two signals clear, the higher score (gap over minimum) wins", C.separation(two)["signal"], "words_first_3s")
tie = [row(1000, words_first_3s=9, duration_s=10), row(900, words_first_3s=9, duration_s=10),
       row(200, words_first_3s=6, duration_s=13), row(100, words_first_3s=6, duration_s=13)]
check("separation: on an exact tie the EARLIER signal in COACH_SIGNALS wins", C.separation(tie)["signal"], "words_first_3s")
wrong = [row(1000, speech_start_s=2.5), row(900, speech_start_s=2.5), row(200, speech_start_s=0.5), row(100, speech_start_s=0.5)]
check("separation: the gap in the WRONG direction (the stronger videos waited longer) never wins", C.separation(wrong), None)
few = [row(1000, speech_start_s=0.5), row(900, speech_start_s=0.5), row(200), row(100, speech_start_s=2.9)]
check("separation: fewer than two measured values on a side -> that signal is skipped", C.separation(few), None)
ex = []
C.separation(FOUR, ex)
check("separation: --print's explanation has one entry per signal, and marks the chosen one",
      ([e["key"] for e in ex], [e["key"] for e in ex if e.get("chosen")]), (list(C.SIGNAL_KEYS), ["speech_start_s"]))
check("separation: the split is the set's OWN median (an outside number never decides it)", C.separation([row(5, speech_start_s=0.5), row(5, speech_start_s=0.5),
      row(5, speech_start_s=2.9), row(5, speech_start_s=2.9)]), None)

# ── 5. advise ────────────────────────────────────────────────────────────────────────────────────
a = C.advise(C.separation(FOUR), NOW)
check("advise: the one thing, in words the writer can be told", a["said"], "start talking inside the first second")
check("advise: the evidence names both medians and both group sizes",
      a["because"], "your 2 stronger videos typically had someone talking by 0.6s; your 2 quieter ones typically waited 2.5s before anyone spoke")
check("advise: it records what it is measured against", (a["signal"], a["direction"], a["was"], a["target"], a["set_at"]),
      ("speech_start_s", "below", 2.5, 0.6, "2026-10-07T12:00:00Z"))
a2 = C.advise({"signal": "speech_start_s", "direction": "below", "m_good": 1.2, "m_poor": 3.0, "n_good": 3, "n_poor": 3}, NOW)
check("advise: a target above one second is rounded UP and says so", a2["said"], "start talking inside the first 2 seconds")
check("advise: words in the first three seconds", C.advise({"signal": "words_first_3s", "direction": "above", "m_good": 11.0, "m_poor": 4.0, "n_good": 2, "n_poor": 2}, NOW)["said"],
      "get 11 words out before second three")
check("advise: a gap, never a target below half a second", C.advise({"signal": "longest_silence_s", "direction": "below", "m_good": 0.1, "m_poor": 1.4, "n_good": 2, "n_poor": 2}, NOW)["said"],
      "keep every gap between lines to about 0.5 seconds or less")


# ── 6. the note: the minimums table, by count ────────────────────────────────────────────────────
def world(n, shaped=None, gap=True, median_on=True, platform="tiktok", start=1):
    """n lead-platform posts, newest first by id, each with readings, a week of views, and (the first `shaped` of them) a measured shape."""
    posts, sn, shapes, comp = [], {}, {}, []
    shaped = n if shaped is None else shaped
    for k in range(n):
        pid = start + k
        base = NOW - timedelta(days=12 + 2 * k)
        views = 1000 - 100 * k
        posts.append({"id": pid, "origin": "tracked", "platform": platform, "posted_at": C.iso(base), "views": views})
        sn[pid] = snaps((0, views // 4, 3), (1, views // 2, 27), (3, views * 3 // 4, 75), (7, views, 171), base=base)
        comp.append({"post_id": pid, "platform": platform, "posted_at": base, "views": views})
        if k < shaped:
            strong = k < (n + 1) // 2
            shapes[pid] = {"post_id": pid, "has_speech": True, "segments": 4, "duration_s": 20.0,
                           "speech_start_s": (0.5 if strong else 2.5) if gap else 1.0, "words_first_3s": 8, "longest_silence_s": 0.4,
                           "longest_silence_at_s": 6.0}
    med = C.__dict__["_median"]([r["views"] for r in comp]) if comp else None
    return posts, sn, shapes, comp, (platform if comp else None), (int(med) if (med is not None and median_on) else None)


def run(n, **kw):
    prev = kw.pop("prev", None)
    now = kw.pop("now", NOW)
    posts, sn, shapes, comp, lead, med = world(n, **kw)
    return C.coach(posts, sn, shapes, comp, lead, med, prev, now)


note, mirror = C.coach([], {}, {}, [], None, None, None, NOW)
check("note, 0 videos: nothing, with the exact sentence and no posts and no working_on",
      (note["state"], note["not_yet"], note["posts"], note["working_on"], mirror),
      ("nothing", "lynxr has not measured one of your videos yet. it checks your linked accounts once a day.", [], [], []))
check("note, 0 videos: no platform and no median keys", ("platform" in note, "median_views" in note), (False, False))
for n in (1, 2, 3):
    note, mirror = run(n)
    check(f"note, {n} measured video(s): learning, the exact sentence, working_on stays []",
          (note["state"], note["not_yet"], note["working_on"], mirror),
          ("learning", f"lynxr needs 4 of your videos that have been up a week and that it has listened to, before it can tell you what is different about one of them. it has {n}.",
           [], []))
note, _ = run(3)
check("note, 3 videos: the per-video lines are still there (the evidence does not wait for the comparison)", len(note["posts"]), 3)
note, mirror = run(4)
check("note, 4 videos with a real gap: ready, one working_on entry, mirrored as one line",
      (note["state"], len(note["working_on"]), note["working_on"][0]["said"], mirror), ("ready", 1, "start talking inside the first second",
                                                                                       [{"said": "start talking inside the first second"}]))
check("note, ready: no not_yet key", "not_yet" in note, False)
check("note, ready: the one entry has its evidence and its yardstick (no score yet: nothing has been posted since)", sorted(note["working_on"][0]),
      ["because", "direction", "said", "set_at", "signal", "target", "was"])
note, mirror = run(4, gap=False)
check("note, 4+ videos but no signal clears: learning, the exact 'no difference' sentence, working_on []",
      (note["state"], note["not_yet"], note["working_on"], mirror),
      ("learning", "lynxr has not found a difference it can stand behind between your stronger videos and your quieter ones.", [], []))
note, _ = run(9)
check("note, 9 videos: ready, still ONE thing (never a list of three)", (note["state"], len(note["working_on"])), ("ready", 1))
note, _ = run(10)
check("note, 10 videos: ready, identical shape", (note["state"], len(note["working_on"])), ("ready", 1))
note, _ = run(5, shaped=3)
check("note: videos with a week of numbers but no measured shape do not count toward the four", (note["state"], note["not_yet"].endswith("it has 3.")), ("learning", True))
note, _ = run(6, shaped=0)
check("note: curves with no shape at all -> learning, and the curve lines are still shown", (note["state"], len(note["posts"]), all(p["line"] for p in note["posts"])),
      ("learning", 6, True))

# per-video entries
note, _ = run(6)
e = note["posts"][0]
check("post entry: newest first, with its curve, readings count, views and the creator's own usual",
      (e["post_id"], e["curve"], e["days"], e["views"], e["views7"], e["times_median"], e["verdict"]), (1, "climbing", 7, 1000, 1000, 1.3, "stronger"))
check("post entry: a quieter video is 'weaker' only when it is at most 0.7 of the creator's own median",
      [(p["post_id"], p["verdict"]) for p in note["posts"]], [(1, "stronger"), (2, "usual"), (3, "usual"), (4, "usual"), (5, "usual"), (6, "weaker")])
check("post entry: the shape numbers ride along (max sees them)", sorted(e["shape"]), ["duration_s", "longest_silence_at_s", "longest_silence_s", "speech_start_s", "words_first_3s"])
check("post entry: the private facts are present for the prose pass", bool(e["_facts"]), True)
check("strip_private removes every underscore key and nothing else", ("_facts" in json.dumps(C.strip_private(note)), len(C.strip_private(note)["posts"])), (False, 6))
check("post entry: median_views is the creator's own", note["median_views"], 750)
posts, sn, shapes, comp, lead, med = world(4)
n4, _ = C.coach(posts, sn, shapes, comp, lead, None, None, NOW)                 # brain not ready: no median passed
check("times_median: absent (and no verdict, no median_views) when the brain has no median yet",
      ("times_median" in n4["posts"][0], "verdict" in n4["posts"][0], "median_views" in n4), (False, False, False))
n5, _ = run(5)
check("times_median: present at five comparable posts", "times_median" in n5["posts"][0], True)
ig, snig, shig, compig, _, _ = world(3, platform="instagram", start=50)
mixed = world(5)
n, _ = C.coach(mixed[0] + ig, {**mixed[1], **snig}, {**mixed[2], **shig}, mixed[3] + compig, "tiktok", mixed[5], None, NOW)
check("times_median: never computed for a post on another platform than the creator's median",
      [("times_median" in p) for p in n["posts"] if p["post_id"] >= 50], [False, False, False])
posts, sn, shapes, comp, lead, med = world(2)
sn[1] = snaps((23, 500, 560), (30, 600, 720))
n, _ = C.coach(posts, sn, shapes, comp, lead, med, None, NOW)
e1 = [p for p in n["posts"] if p["post_id"] == 1][0]
check("post entry: a backfilled video has no curve but keeps its audio facts", ("curve" in e1, e1["line"], "shape" in e1), (False, "", True))

# ── 7. score and the one-thing rule ──────────────────────────────────────────────────────────────
SET = NOW - timedelta(days=10)
PREV = {"said": "start talking inside the first second", "because": "x", "signal": "speech_start_s", "direction": "below", "was": 2.5, "target": 0.6,
        "set_at": C.iso(SET)}


def sh(days_ago, start, kind="climbing"):
    return {"posted": NOW - timedelta(days=days_ago), "values": {"speech_start_s": start}, "curve": kind}


check("score: nothing posted since -> posts 0, nothing claimed", C.score(PREV, [sh(20, 2.5)], NOW), {"posts": 0})
check("score: ONE video since the advice claims nothing but the count", C.score(PREV, [sh(20, 2.5), sh(5, 0.4)], NOW), {"posts": 1})
s2 = C.score(PREV, [sh(20, 2.5, "stopped_early"), sh(5, 0.4, "climbing"), sh(3, 0.6, "grew")], NOW)
check("score: two videos that improved -> moved True, with their median", (s2["posts"], s2["median"], s2["moved"]), (2, 0.5, True))
check("score: ... and the curve is better when a larger share of them kept growing", s2["curve_better"], True)
s3 = C.score(PREV, [sh(5, 2.9), sh(3, 3.1)], NOW)
check("score: two videos that did not improve -> moved False", (s3["moved"], "curve_better" in s3), (False, False))
check("score: a signal the new videos could not measure claims nothing", C.score(PREV, [{"posted": NOW - timedelta(days=2), "values": {}, "curve": None}] * 3, NOW), {"posts": 3})

two_sep = {"signal": "speech_start_s", "direction": "below", "m_good": 0.6, "m_poor": 2.5, "n_good": 2, "n_poor": 2}
other_sep = {"signal": "words_first_3s", "direction": "above", "m_good": 11.0, "m_poor": 4.0, "n_good": 2, "n_poor": 2}
out = C.choose([PREV], two_sep, [sh(5, 0.4), sh(3, 0.5)], NOW)
check("choose: the signal is unchanged -> carried forward with the SAME set_at and a fresh since", (len(out), out[0]["set_at"], out[0]["since"]["posts"], out[0]["since"]["moved"]),
      (1, PREV["set_at"], 2, True))
out = C.choose([PREV], other_sep, [sh(5, 0.4), sh(3, 0.5)], NOW)
check("choose: a DIFFERENT signal after the advice was scored replaces it, and the old one goes to history with its result",
      (out[0]["signal"], out[1]["signal"], out[1]["since"]["moved"], out[0]["set_at"]), ("words_first_3s", "speech_start_s", True, "2026-10-07T12:00:00Z"))
out = C.choose([PREV], other_sep, [sh(5, 0.4)], NOW)
check("choose: a different signal BEFORE the advice has been scored changes nothing (the hinge must not move every rebuild)",
      (len(out), out[0]["signal"], out[0]["set_at"]), (1, "speech_start_s", PREV["set_at"]))
old = {**PREV, "set_at": C.iso(NOW - timedelta(days=22))}
out = C.choose([old], two_sep, [], NOW)
check("choose: held COACH_HOLD_DAYS -> replaced regardless, even with no videos since", (out[0]["set_at"], out[1]["set_at"]), ("2026-10-07T12:00:00Z", old["set_at"]))
check("choose: held its time and nothing separates the videos now -> no advice at all", C.choose([old], None, [], NOW), [])
check("choose: not yet expired and nothing separates now -> the held advice stands", C.choose([PREV], None, [], NOW)[0]["said"], PREV["said"])
check("choose: no previous and no signal -> []", C.choose([], None, [], NOW), [])
hist = [PREV, {**PREV, "said": "b"}, {**PREV, "said": "c"}]
check("choose: at most three entries are kept", len(C.choose(hist, other_sep, [sh(5, 0.4), sh(3, 0.5)], NOW)), 3)
check("choose: junk in the stored history is ignored", C._history({"working_on": [{"signal": "nope", "said": "x"}, "x", None]}), [])

# the coach through the note: carried forward across two builds
n1, _ = run(4)
set_at_1 = n1["working_on"][0]["set_at"]
n2, _ = run(4, prev=n1, now=NOW + timedelta(hours=20))
check("note: a second build 20 hours later keeps the same thing with the same set_at (it does not change every rebuild)",
      (n2["working_on"][0]["said"], n2["working_on"][0]["set_at"]), (n1["working_on"][0]["said"], set_at_1))

# ── 8. the prose cache and the check ─────────────────────────────────────────────────────────────
n1, _ = run(4)
e = n1["posts"][0]
key = C.facts_key(e["_facts"])
fake_prev = {"posts": [{"post_id": e["post_id"], "prose_key": key, "prose": "a sentence kept from before"}]}
n2, _ = run(4, prev=fake_prev)
check("prose cache: unchanged facts carry the earlier prose and its key (a repeat render costs nothing)",
      (n2["posts"][0].get("prose"), n2["posts"][0].get("prose_key")), ("a sentence kept from before", key))
fake_prev = {"posts": [{"post_id": e["post_id"], "prose_key": "0123456789abcdef", "prose": "stale"}]}
n3, _ = run(4, prev=fake_prev)
check("prose cache: CHANGED facts carry nothing (the prose must be remade)", ("prose" in n3["posts"][0], "prose_key" in n3["posts"][0]), (False, False))
fake_prev = {"posts": [{"post_id": e["post_id"], "prose_key": key}]}
n4_, _ = run(4, prev=fake_prev)
check("prose cache: a refused rewrite is remembered (key carried, no prose): the same facts are not asked again",
      ("prose" in n4_["posts"][0], n4_["posts"][0].get("prose_key")), (False, key))

FACTS = ("views at the last reading: 1,204\nviews at each reading: day 0: 300, day 1: 640, day 7: 1,204\n"
         "it was still climbing at its last reading, on day 7; 1,204 views a week in, 1.2× your own usual\n"
         "against this creator's own usual a week in: about your usual\nin the audio: nobody spoke until second 2.9")
ok, out = C.prose_ok("It was still climbing 7 days in, with 1,204 views. Nobody spoke until second 2.9.", FACTS)
check("prose_ok: a rewrite that uses only the facts' numbers is kept", (ok, out), (True, "It was still climbing 7 days in, with 1,204 views. Nobody spoke until second 2.9."))
check("prose_ok: a number that is NOT in the facts is refused", C.prose_ok("It had 1,500 views by day 7.", FACTS)[0], False)
check("prose_ok: a rounded number is refused", C.prose_ok("It had about 1,200 views.", FACTS)[0], False)
check("prose_ok: an abbreviated number is refused even when its digits appear in the facts", C.prose_ok("It had about 1.2k views.", FACTS)[0], False)
check("prose_ok: an invented second is refused", C.prose_ok("Nobody spoke until second 3.", FACTS)[0], False)
check("prose_ok: a number spelled out is refused", C.prose_ok("Nobody spoke for three seconds.", FACTS)[0], False)
check("prose_ok: ... unless the facts themselves use that word", C.prose_ok("It was once climbing.", FACTS + " once")[0], True)
for word in ("viewers", "your audience", "the algorithm", "this platform", "retention", "a drop-off", "the curve", "watch time", "tiktok", "swipe", "an 8% rise"):
    check(f"prose_ok: '{word}' is refused", C.prose_ok(f"Your video had 1,204 views and {word}.", FACTS)[0], False)
for word in ("because", "which is why", "due to", "led to", "therefore"):
    check(f"prose_ok: an unbacked cause ('{word}') is refused", C.prose_ok(f"It was climbing {word} the opening.", FACTS)[0], False)
check("prose_ok: empty, too long, a list and a heading are refused",
      [C.prose_ok(t, FACTS)[0] for t in ("", "x " * 300, "- one\n- two", "# 7 days")], [False] * 4)
check("prose_ok: surrounding quote marks are stripped", C.prose_ok('"It was climbing 7 days in."', FACTS), (True, "It was climbing 7 days in."))
check("prose_ok: the refusal says why, never what", C.prose_ok("It had 1,500 views.", FACTS)[1].startswith("a number that is not in the facts"), True)
check("numbers_in: commas and decimals", sorted(C.numbers_in("1,204 views, 0.6s, day 7")), [0.6, 7.0, 1204.0])

# ── 9. the words the coach may never write ───────────────────────────────────────────────────────
FORBIDDEN = ("retention", "drop-off", "dropoff", "drop off", "watch time", "watched", "finish", "completion", "swipe", "scroll", "left at", "clicked off",
             "%", "algorithm", "suppress", "shadowban")
COPY_FORBIDDEN = FORBIDDEN + ("audience", "viewer", "platform")        # dict keys such as "platform" are legitimate in code, so these three are scanned in the copy only
tree = ast.parse((HERE / "coach.py").read_text())
skip_names = {"PROSE_BANNED", "PROSE_CAUSAL", "PROSE_NUMBER_WORDS"}
doc_ids = set()
for node in ast.walk(tree):
    if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)):
        body = node.body
        if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) and isinstance(body[0].value.value, str):
            doc_ids.add(id(body[0].value))
skip_ids = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in skip_names for t in node.targets):
        skip_ids.update(id(n) for n in ast.walk(node))
literals = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in doc_ids and id(n) not in skip_ids]
check("the scan sees the coach's copy (more than forty string literals)", len(literals) > 40, True)
import re as _re
hits = sorted({(w, s[:50]) for s in literals for w in FORBIDDEN if w in _re.sub(r"%[YmdHMSz]", "", s).lower()})
check("FORBIDDEN WORDS: no string literal in coach.py says retention, drop-off, watch time, swipe, an audience, an algorithm or a percentage", hits, [])
copy_strings = [C.NOT_YET_NONE, C.NOT_YET_FEW, C.NOT_YET_NODIFF, *C.LINES.values(), C.LINE_VS_USUAL, *C.MOMENT_TEXT.values(), *C.VERDICTS.values(),
                C.BECAUSE, *[s[k] for s in C.COACH_SIGNALS for k in ("good", "poor", "said", "said_n")]]
check("FORBIDDEN WORDS: every constant the coach can say, scanned directly",
      sorted({(w, s[:40]) for s in copy_strings for w in COPY_FORBIDDEN if w in s.lower()}), [])
check("the scan can actually fail (a planted string is caught)", [w for w in FORBIDDEN if w in "your retention curve left at 3%".lower()] != [], True)
def values_of(o):
    """Every string VALUE in a nested structure (keys such as "platform" are identifiers, not copy)."""
    if isinstance(o, dict):
        return [x for v in o.values() for x in values_of(v)]
    if isinstance(o, list):
        return [x for v in o for x in values_of(v)]
    return [o] if isinstance(o, str) else []


check("no rendered note, on any path above, says a forbidden word",
      sorted({w for n in (C.coach([], {}, {}, [], None, None, None, NOW)[0], run(2)[0], run(4)[0], run(4, gap=False)[0], run(9)[0])
              for t in values_of(C.strip_private(n)) for w in COPY_FORBIDDEN if w in t.lower()}), [])

# ── 10. boundaries ───────────────────────────────────────────────────────────────────────────────
src = (HERE / "coach.py").read_text()
agency = (HERE / "process_campaigns.py").read_text()
check("coach.py is pure: no network, subprocess, file write or model client",
      [w for w in ("urllib", "requests", "http.client", "subprocess", "anthropic", "open(") if w in src.split('"""', 2)[2].replace("open(args.file)", "")], [])
check("agency isolation: process_campaigns.py neither imports the coach nor names its tables",
      [w for w in ("import coach", "coach_prose", "lynxr_coach_notes", "lynxr_post_shape", "working_on") if w in agency], [])
check("BRAIN_IN_PROMPT is not read anywhere in the coach", "BRAIN_IN_PROMPT" in src, False)
check("COACH is OFF by default", C.COACH, False)
check("the coach's thresholds mirror the brain's", (C.COACH_WINDOW_DAYS, C.STRONG, C.WEAK), (180.0, 1.3, 0.7))

if FAILS:
    print(f"\n{len(FAILS)} FAILED: " + ", ".join(FAILS))
    sys.exit(1)
print("all checks passed")
