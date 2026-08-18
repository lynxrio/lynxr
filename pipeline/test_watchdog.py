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

# ---- rerun: done + attempts>=2 + no aiFail ---------------------------------
rerun_entry = [row("c5", [
    {"id": "e5555555", "status": "done", "attempts": 2,
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(rerun_entry, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("done + attempts:2 + no aiFail -> one rerun:",
      keys_of(alarms), {"rerun:e5555555"})

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
