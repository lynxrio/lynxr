"""Checks on the automatic retry of failed AI steps.

Pure-function tests: no network, no model calls, no Supabase. Run with

    ./venv/bin/python pipeline/test_ai_retry.py

They exist because the thing being asserted is a POLICY — which failures come
back on their own and how soon — and policy that is only in a comment drifts.
The specific regression: a lapsed Anthropic balance used to land as status
"done" with a note, which nothing ever reopened without someone passing
--redo-ai by hand.
"""

import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_adaptations as P  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


def ago(minutes):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


# ---- classification -------------------------------------------------------
# The real strings the Anthropic SDK surfaces, as api_reason() trims them.
check("credit balance -> billing",
      P.ai_failure_kind("Your credit balance is too low to access the Anthropic API"), "billing")
check("quota -> billing", P.ai_failure_kind("insufficient_quota"), "billing")
check("429 -> rate_limit", P.ai_failure_kind("Error code: 429 - rate_limit_error"), "rate_limit")
check("overloaded -> transient", P.ai_failure_kind("Overloaded"), "transient")
check("529 -> transient", P.ai_failure_kind("Error code: 529"), "transient")
check("timeout -> transient", P.ai_failure_kind("Request timed out"), "transient")
check("no beats -> content",
      P.ai_failure_kind("the model returned a script with no beats"), "content")
check("refusal -> content", P.ai_failure_kind("stop_reason: refusal"), "content")

# ---- tries count ATTEMPTS, not failed steps -------------------------------
a = {"attemptedAt": "2026-08-18T01:00:00Z"}
P.mark_ai_fail(a, "credit balance is too low")   # shot list
P.mark_ai_fail(a, "credit balance is too low")   # tags
P.mark_ai_fail(a, "credit balance is too low")   # format extraction
check("three failed steps in one pass = 1 try", a["aiFail"]["tries"], 1)
check("kind recorded", a["aiFail"]["kind"], "billing")

a["attemptedAt"] = "2026-08-18T01:30:00Z"        # the next pass
P.mark_ai_fail(a, "credit balance is too low")
check("second pass = 2 tries", a["aiFail"]["tries"], 2)

# ---- the backoff ----------------------------------------------------------
billing = lambda tries, mins: {"aiFail": {"kind": "billing", "tries": tries, "at": ago(mins)}}
check("billing try 1, 5m ago -> not yet", P.ai_retry_due(billing(1, 5)), False)
check("billing try 1, 16m ago -> due", P.ai_retry_due(billing(1, 16)), True)
check("billing try 2, 16m ago -> not yet (30m)", P.ai_retry_due(billing(2, 16)), False)
check("billing try 2, 31m ago -> due", P.ai_retry_due(billing(2, 31)), True)
check("billing try 6, 5h ago -> not yet (6h)", P.ai_retry_due(billing(6, 300)), False)
check("billing try 6, 7h ago -> due", P.ai_retry_due(billing(6, 420)), True)
check("out of tries -> never again", P.ai_retry_due(billing(P.AI_MAX_TRIES, 10_000)), False)

check("rate limit try 1, 6m ago -> due",
      P.ai_retry_due({"aiFail": {"kind": "rate_limit", "tries": 1, "at": ago(6)}}), True)

# The whole point of classifying: a model that will not write beats for THIS
# source will not write them in fifteen minutes either, so no timer touches it.
check("content failure never auto-retries",
      P.ai_retry_due({"aiFail": {"kind": "content", "tries": 1, "at": ago(10_000)}}), False)
check("no marker at all -> nothing to retry", P.ai_retry_due({}), False)

# ---- giving up ------------------------------------------------------------
# Only when there is nothing usable. An entry that got its format and lost only
# its shot list is a working card with a gap, not an error.
check("exhausted with no format -> give up",
      P.ai_gave_up({"aiFail": {"kind": "billing", "tries": P.AI_MAX_TRIES}}), True)
check("exhausted BUT has a format -> leave it alone",
      P.ai_gave_up({"aiFail": {"kind": "billing", "tries": P.AI_MAX_TRIES},
                    "format": {"name": "x"}}), False)
check("still has tries -> not given up",
      P.ai_gave_up({"aiFail": {"kind": "billing", "tries": 2}}), False)
check("content failure is never 'given up on' by the timer",
      P.ai_gave_up({"aiFail": {"kind": "content", "tries": 99}}), False)

# ---- the marker survives the note being cleared ---------------------------
# process_one pops `note` on every original-script entry, which is exactly why
# the old `"failed" in note` test could never see one.
orig = {"attemptedAt": "2026-08-18T02:00:00Z", "note": "shot list failed: Overloaded"}
P.mark_ai_fail(orig, "Overloaded")
orig.pop("note", None)
check("marker outlives the popped note", bool(orig.get("aiFail")), True)
check("...and is still due after its wait",
      P.ai_retry_due({"aiFail": {**orig["aiFail"], "at": ago(30)}}), True)

# ---- stage() records a duration --------------------------------------------
# creator-latency-60s.md Step 1: the container's log dies with the machine, so
# per-stage timings have to live on the row, not just in fly logs.
_timings = {}
with P.stage(_timings, "download"):
    time.sleep(0.01)
check("stage() records a key", "download" in _timings, True)
check("stage() records a positive duration", _timings.get("download", 0) > 0, True)

# ---- wants_work() / too_young() respects --min-age-seconds ----------------
# Step 11c: the GitHub fallback passes --min-age-seconds 180 so it stays a
# genuine backstop for Fly rather than racing it for the claim.
check("too_young: 0 threshold never withholds anything",
      P.too_young({"addedAt": P.now_iso()}, 0), False)
check("too_young: just-added entry, 180s threshold -> too young",
      P.too_young({"addedAt": ago(0)}, 180), True)
check("too_young: 5-minutes-old entry, 180s threshold -> old enough",
      P.too_young({"addedAt": ago(5)}, 180), False)
check("too_young: no addedAt at all -> never withheld",
      P.too_young({}, 180), False)

# ---- cached_source() returns None when the row has no format --------------
# Step 8: the source half of a script is a property of the VIDEO, and a row
# missing a format (or a script) is not a usable cache hit.
_ORIG_SB = P.sb
try:
    P.sb = lambda key, path, method="GET", body=None, raw=False: [
        {"platform": "tiktok", "script": {"text": "hi"}, "shots": [], "tags": {}, "format": None}]
    check("cached_source: None when format is missing",
          P.cached_source("fake-key", "https://tiktok.com/@x/video/1"), None)

    P.sb = lambda key, path, method="GET", body=None, raw=False: []
    check("cached_source: None when there is no row at all",
          P.cached_source("fake-key", "https://tiktok.com/@x/video/1"), None)

    P.sb = lambda key, path, method="GET", body=None, raw=False: [
        {"platform": "tiktok", "script": {"text": "hi", "duration": 12},
         "shots": [{"t": 0}], "tags": {"a": 1}, "format": {"name": "x"}}]
    hit = P.cached_source("fake-key", "https://tiktok.com/@x/video/1")
    check("cached_source: a hit when format AND script are both present",
          bool(hit) and hit.get("format", {}).get("name"), "x")
finally:
    P.sb = _ORIG_SB

# ---- graft_adaptations' per-cid lock ---------------------------------------
# Step 7b: two threads grafting the SAME creator must not run their
# read-modify-write concurrently (one write would be lost); two threads on
# DIFFERENT creators must not block each other at all.
#
# The overlap has to be measured on the CRITICAL SECTION (the GET while
# holding the lock), not on the whole graft_adaptations() call — the calling
# thread starts its clock before it even tries to acquire the lock, so a
# thread blocked waiting for it would still look "overlapping" by that
# measure regardless of whether the lock did anything.
try:
    def make_fake_sb_graft(events, events_lock):
        def fake_sb_graft(key, path, method="GET", body=None, raw=False):
            if method == "GET":
                cid = path.split("id=eq.")[1].split("&")[0]
                t0 = time.monotonic()
                time.sleep(0.05)          # a window wide enough to catch an overlap
                with events_lock:
                    events.append((cid, t0, time.monotonic()))
                return [{"data": {"adaptations": []}}]
            return None
        return fake_sb_graft

    def run_graft(cid):
        P.graft_adaptations("fake-key", cid, [{"id": "a1"}])

    events, events_lock = [], threading.Lock()
    P.sb = make_fake_sb_graft(events, events_lock)
    threads = [threading.Thread(target=run_graft, args=("cid-same-a",)) for _ in range(2)]
    for t in threads: t.start()
    for t in threads: t.join()
    (_, s1, e1), (_, s2, e2) = events
    check("graft lock serialises two threads on ONE creator",
          s1 < e2 and s2 < e1, False)

    events.clear()
    threads = [threading.Thread(target=run_graft, args=("cid-diff-a",)),
               threading.Thread(target=run_graft, args=("cid-diff-b",))]
    for t in threads: t.start()
    for t in threads: t.join()
    (_, s3, e3), (_, s4, e4) = events
    check("graft lock does NOT serialise two DIFFERENT creators",
          s3 < e4 and s4 < e3, True)
    # ---- renew_claim must hold the SAME lock as graft_adaptations ----------
    # REGRESSION, 2026-08-18. renew_claim() does a read-modify-write of the whole
    # creator row and did NOT take _GRAFT_LOCKS. The heartbeat thread read the row
    # mid-script, the worker thread grafted "done" + 10 beats, and the heartbeat
    # then PATCHed its pre-completion snapshot back — the finished script was
    # erased, the row stayed `running`, the 2.5-minute lease lapsed and the next
    # sweep re-ran and re-billed the same paste. Same creator => must serialise.
    events.clear()
    def run_renew(cid):
        P.renew_claim("fake-key", cid, "a1")
    P.sb = make_fake_sb_graft(events, events_lock)
    threads = [threading.Thread(target=run_graft, args=("cid-mixed",)),
               threading.Thread(target=run_renew, args=("cid-mixed",))]
    for t in threads: t.start()
    for t in threads: t.join()
    (_, s1, e1), (_, s2, e2) = events
    check("renew_claim and graft_adaptations serialise on ONE creator",
          s1 < e2 and s2 < e1, False)

finally:
    P.sb = _ORIG_SB

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
