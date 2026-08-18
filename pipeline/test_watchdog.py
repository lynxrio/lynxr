"""Checks on the watchdog's failure-shape detectors.

Pure-function tests: no network, no Supabase, no real ntfy send. Run with

    ./venv/bin/python pipeline/test_watchdog.py

They exist because the thing being asserted is a POLICY — which shapes page
and at what threshold — and this whole plan exists because a documented alarm
(an `SLA BREACH` line HANDOFF.md and .github/workflows/latency-watch.yml both
described as real-time) turned out never to have been built. A detector that
cannot fail a test is decoration; every check below either proves an alarm
fires when it should, or proves it stays silent when it shouldn't — never only
one side of that.

The `rerun:<id8>` cases were DELIBERATELY INVALIDATED and rewritten as their
own opposite: `done + attempts >= 2 + no aiFail` used to be inferred as a
double-bill, but it is exactly the shape a SUCCESSFUL transient retry ends in
(proven live by adaptation 644ba12d on 2026-08-18 — attempts=3, no aiFail, 11
beats, recovered fine — which paged for real under the old rule). The alarm
now keys on the explicit `rerun` marker only.
"""

import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import watchdog as W  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


def keys_of(alarms):
    return {a["key"] for a in alarms}


def ago(now, seconds):
    return (now - timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def row(creator_id, adaptations):
    return {"id": creator_id, "data": {"adaptations": adaptations}}


NOW = datetime.now(timezone.utc)

# ---- the most important assertion: a healthy set makes zero noise ---------
healthy_rows = [
    row("c1", [
        {"id": "a0000001", "status": "done", "processedAt": ago(NOW, 120),
         "sourceUrl": "https://tiktok.com/@x/video/1", "attempts": 1},
        {"id": "a0000002", "status": "done", "brandId": "b1",
         "adaptation": {"beats": [{"t": "0-3s"}]},
         "processedAt": ago(NOW, 60), "attempts": 1},
    ]),
]
healthy = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("a healthy set produces zero alarms", healthy, [])

# ---- inflight: threshold at 600s -------------------------------------------
stuck_700 = [row("c2", [{"id": "b1111111", "status": "running",
                         "addedAt": ago(NOW, 700)}])]
alarms = W.check_all(stuck_700, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("one entry running 700s -> exactly one inflight: alarm",
      keys_of(alarms), {"inflight:b1111111"})

stuck_500 = [row("c2", [{"id": "b2222222", "status": "running",
                         "addedAt": ago(NOW, 500)}])]
alarms = W.check_all(stuck_500, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("the same shape at 500s -> none", keys_of(alarms), set())

# ---- inflight:many collapses a burst ---------------------------------------
five_stuck = [row("c3", [
    {"id": f"c333333{i}", "status": "running", "addedAt": ago(NOW, 700)}
    for i in range(5)
])]
alarms = W.check_all(five_stuck, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("five in-flight breaches -> one inflight:many, no per-entry keys",
      keys_of(alarms), {"inflight:many"})

# ---- empty-script: done + brandId + no beats -------------------------------
empty_script = [row("c4", [
    {"id": "d4444444", "status": "done", "brandId": "b1",
     "adaptation": {"beats": []}, "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(empty_script, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("done + brandId + beats:[] -> one empty-script:",
      keys_of(alarms), {"empty-script:d4444444"})

# ---- gave-up: the automatic loop stopped and the creator has nothing -------
gave_up_rows = [row("c9", [
    {"id": "h9999991", "status": "error", "final": True, "finalWhy": "gave_up",
     "attemptedAt": ago(NOW, 60), "aiFail": {"kind": "transient", "tries": 8}},
])]
alarms = W.check_all(gave_up_rows, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("error + final + finalWhy gave_up, inside 24h -> exactly one gave-up:",
      keys_of(alarms), {"gave-up:h9999991"})
gave_up_alarm = next(a for a in alarms if a["key"] == "gave-up:h9999991")
gbody = gave_up_alarm["body"]
check("gave-up: body carries no @ (no email)", "@" in gbody, False)
check("gave-up: body carries no http (no URL)", "http" in gbody, False)
check("gave-up: body carries no uuid-shaped id",
      bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", gbody)), False)

gave_up_stale = [row("c9", [
    {"id": "h9999992", "status": "error", "final": True, "finalWhy": "gave_up",
     "attemptedAt": ago(NOW, 25 * 3600), "aiFail": {"kind": "transient", "tries": 8}},
])]
alarms = W.check_all(gave_up_stale, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("the same shape 25h old -> none", "gave-up:h9999992" in keys_of(alarms), False)

gave_up_wall = [row("c9", [
    {"id": "h9999993", "status": "error", "final": True, "finalWhy": "wall",
     "attemptedAt": ago(NOW, 60), "retryable": False},
])]
alarms = W.check_all(gave_up_wall, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("finalWhy wall -> none (a platform wall must not page)",
      "gave-up:h9999993" in keys_of(alarms), False)

# ---- fetch-wall:burst: the download layer itself has broken ----------------
def fetch_wall_rows(source_urls):
    entries = [
        {"id": f"j999999{i}", "status": "error", "noteKind": "fetch",
         "claimedAt": ago(NOW, 60), "sourceUrl": url}
        for i, url in enumerate(source_urls)
    ]
    return [row("c10", entries)]

three_distinct = fetch_wall_rows([
    "https://tiktok.com/@x/video/1", "https://tiktok.com/@x/video/2",
    "https://tiktok.com/@x/video/3"])
alarms = W.check_all(three_distinct, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("3 distinct sourceUrls, error+fetch inside 6h -> one fetch-wall:burst",
      "fetch-wall:burst" in keys_of(alarms), True)
fetch_wall_alarm = next(a for a in alarms if a["key"] == "fetch-wall:burst")
fbody = fetch_wall_alarm["body"]
check("fetch-wall:burst: body carries no @ (no email)", "@" in fbody, False)
check("fetch-wall:burst: body carries no http (no URL)", "http" in fbody, False)
check("fetch-wall:burst: body carries no uuid-shaped id",
      bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", fbody)), False)

three_same_url = fetch_wall_rows(
    ["https://tiktok.com/@x/video/9"] * 3)   # the brand fan-out shape that actually happened
alarms = W.check_all(three_same_url, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("3 entries sharing ONE sourceUrl -> none (one bad video, not a systemic break)",
      "fetch-wall:burst" in keys_of(alarms), False)

two_distinct = fetch_wall_rows(
    ["https://tiktok.com/@x/video/1", "https://tiktok.com/@x/video/2"])
alarms = W.check_all(two_distinct, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("2 distinct sourceUrls -> none (under the threshold)",
      "fetch-wall:burst" in keys_of(alarms), False)

# ---- rerun: THE EXPLICIT MARKER ONLY, not attempts >= 2 --------------------
# DELIBERATELY INVALIDATED, and made its own opposite: `done + attempts:2 +
# no aiFail` is exactly the shape a SUCCESSFUL transient retry ends in — proven
# live by 644ba12d (attempts=3, no aiFail, 11 beats, recovered fine) — and the
# old inference paged on it for real. The explicit `rerun` marker is the only
# thing that may fire this alarm now.
no_marker_healed = [row("c5", [
    {"id": "e5555555", "status": "done", "attempts": 2,
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(no_marker_healed, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("done + attempts:2 + no aiFail + no rerun marker -> none (self-healed retry)",
      keys_of(alarms), set())

healed_shape = [row("c5", [
    {"id": "e5555559", "status": "done", "attempts": 3,
     "healed": {"kind": "transient", "tries": 2, "at": ago(NOW, 30)},
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(healed_shape, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("done + attempts:3 + healed + no aiFail -> none (the healed shape, explicitly)",
      keys_of(alarms), set())

rerun_marker = [row("c5", [
    {"id": "e5555557", "status": "done", "attempts": 2,
     "rerun": {"at": ago(NOW, 0), "prevProcessedAt": ago(NOW, 120), "beats": 10},
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(rerun_marker, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("done + attempts:2 + explicit rerun marker -> exactly one rerun:",
      keys_of(alarms), {"rerun:e5555557"})
rerun_alarm = next(a for a in alarms if a["key"] == "rerun:e5555557")
rbody = rerun_alarm["body"]
check("rerun: body carries no @ (no email)", "@" in rbody, False)
check("rerun: body carries no http (no URL — the command is a local script)",
      "http" in rbody, False)
check("rerun: body carries no uuid-shaped id",
      bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", rbody)), False)

rerun_stale = [row("c5", [
    {"id": "e5555558", "status": "done", "attempts": 2,
     "rerun": {"at": ago(NOW, 25 * 3600), "prevProcessedAt": ago(NOW, 26 * 3600), "beats": 10},
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(rerun_stale, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("rerun marker 25h old -> none (window makes a page self-resolve)",
      keys_of(alarms), set())

rerun_no_at = [row("c5", [
    {"id": "e5555560", "status": "done", "attempts": 2,
     "rerun": {"prevProcessedAt": ago(NOW, 120), "beats": 10},
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(rerun_no_at, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("rerun marker with no `at` -> one alarm (fails loud)",
      keys_of(alarms), {"rerun:e5555560"})

# Kept: proves the aiFail path is not what the alarm keys on any more.
rerun_but_ai_retry = [row("c5", [
    {"id": "e5555556", "status": "done", "attempts": 2,
     "aiFail": {"kind": "billing"}, "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(rerun_but_ai_retry, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("the same shape WITH an aiFail -> none", keys_of(alarms), set())

# ---- sources-stalled --------------------------------------------------------
four_with_source = [row("c6", [
    {"id": f"f666666{i}", "status": "done", "processedAt": ago(NOW, 1000),
     "sourceUrl": f"https://tiktok.com/@x/video/{i}"}
    for i in range(4)
])]
alarms = W.check_all(four_with_source, sources_recent=0, worker_seen_at=NOW, now=NOW)
check("4 finished in 6h with sources_recent=0 -> sources-stalled",
      "sources-stalled" in keys_of(alarms), True)

alarms = W.check_all(four_with_source, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("the same 4 with sources_recent=1 -> none",
      "sources-stalled" in keys_of(alarms), False)

# ---- softfail:<subsystem> ---------------------------------------------------
def softfail_rows(hits):
    entries = []
    for i in range(5):
        e = {"id": f"a{i}sfsfsf", "status": "done", "processedAt": ago(NOW, 3600 * (5 - i))}
        if i < hits:
            e["softFails"] = {"source_upsert": {"reason": "PGRST204", "at": ago(NOW, 100)}}
        entries.append(e)
    return [row("c7", entries)]

alarms = W.check_all(softfail_rows(3), sources_recent=1, worker_seen_at=NOW, now=NOW)
check("3 of the last 5 finished carrying softFails.source_upsert -> softfail:source_upsert",
      "softfail:source_upsert" in keys_of(alarms), True)

alarms = W.check_all(softfail_rows(1), sources_recent=1, worker_seen_at=NOW, now=NOW)
check("1 of 5 -> none", "softfail:source_upsert" in keys_of(alarms), False)

# ---- spend-24h ---------------------------------------------------------------
alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW, now=NOW,
                      charges_24h=W.DAILY_SCRIPT_CAP - 1)
check("charges_24h one under the cap -> none", "spend-24h" in keys_of(alarms), False)

alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW, now=NOW,
                      charges_24h=W.DAILY_SCRIPT_CAP)
check("charges_24h AT the cap -> spend-24h", "spend-24h" in keys_of(alarms), True)

spend_alarm = next(a for a in alarms if a["key"] == "spend-24h")
body = spend_alarm["body"]
check("spend-24h body carries no @ (no email)", "@" in body, False)
check("spend-24h body carries no http (no URL)", "http" in body, False)
check("spend-24h body carries no uuid-shaped id (no creator id)",
      bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", body)), False)

# ---- worker-down -------------------------------------------------------------
alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW - timedelta(minutes=6), now=NOW)
check("worker_seen_at 6 min old -> worker-down", "worker-down" in keys_of(alarms), True)

alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW - timedelta(minutes=2), now=NOW)
check("worker_seen_at 2 min old -> none", "worker-down" in keys_of(alarms), False)

alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=None, now=NOW)
check("worker_seen_at never seen -> worker-down", "worker-down" in keys_of(alarms), True)

# ---- raw_notes() / digest()'s "notes: clean" line ---------------------------
# The sentence is HARD-CODED here, not imported from process_adaptations —
# this module must not import that one (see the module docstring). Verified
# live 2026-08-18: 0 of 21 adaptations carry a note at all, so this is the
# regression guard, not a case list.
raw_note_rows = [row("c8", [
    {"id": "g8888888", "status": "error",
     "note": "tags failed: Overloaded; format extraction failed: Overloaded"},
])]
check("raw_notes(): a raw provider/internal-text note is caught",
      W.raw_notes(raw_note_rows), ["g8888888"])

clean_note_rows = [row("c8", [
    {"id": "g8888889", "status": "error",
     "note": "something on our side went wrong — we're retrying. "
             "Nothing was used from your allowance."},
])]
check("raw_notes(): a real CREATOR_NOTES-shaped sentence is NOT flagged",
      W.raw_notes(clean_note_rows), [])

check("digest(): the healthy fixture reads 'notes: clean'",
      "notes: clean" in W.digest(healthy_rows, 1, NOW, NOW), True)
check("digest(): a raw-note row reads the count and id8",
      "notes: 1 with raw text (g8888888)" in W.digest(raw_note_rows, 1, NOW, NOW), True)

# ---- notify() never raises, and never sends without a topic ----------------
import os  # noqa: E402

_orig_load_env = W.LR.load_env
_saved_topic = os.environ.pop("NTFY_TOPIC", None)
_saved_server = os.environ.pop("NTFY_SERVER", None)
try:
    W.LR.load_env = lambda path: {}   # no .env fallback either, for a deterministic test
    check("notify() with NTFY_TOPIC unset returns False",
          W.notify("test", "body"), False)
    check("notify() with a non-ASCII title and no topic returns False, does not raise",
          W.notify("tëst émoji 🎉 café", "body"), False)
finally:
    W.LR.load_env = _orig_load_env
    if _saved_topic is not None:
        os.environ["NTFY_TOPIC"] = _saved_topic
    if _saved_server is not None:
        os.environ["NTFY_SERVER"] = _saved_server

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
