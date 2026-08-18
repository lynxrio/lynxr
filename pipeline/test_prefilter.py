"""Proof that the discovery prefilter is a strict superset of wants_work().

Pure-function tests: no network, no Supabase, no model calls.

worker-discovery-prefilter.md: process_adaptations.py used to discover work by
pulling every creator's whole JSON blob and filtering in Python — measured
live 2026-08-18 at 214,900 bytes / 548ms for FIVE creators, run every 60s
forever by worker.py --sweep. prefilter_probes() + prefilter_url() ask
Postgres the same question with a JSONB containment probe instead — 2 bytes.

The whole risk of that change is a silent UNDER-select: a prefilter that
misses one of wants_work()'s four conditions means a creator's script is
never picked up and nothing anywhere says so. This file exhaustively builds
the closed wants_work() state space and asserts no True case escapes the
probes — including non-degeneracy checks, so a probe set that matches
EVERYTHING cannot pass by cheating and silently reinstating the full scan.

Run with

    ./venv/bin/python pipeline/test_prefilter.py
"""

import itertools
import sys
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


# ---- a. a local model of Postgres @>, judged by containment semantics -----
# rather than by a mock, so a wrong probe cannot be vouched for by a mock that
# happens to agree with it.
def jsonb_contains(container, contained):
    """Postgres jsonb @>, enough of it for these probes.
    dict: every key of `contained` present in `container`, recursively.
    list: every element of `contained` contained in SOME element of
          `container` — which is why [] is contained in every array.
    else: equality."""
    if isinstance(contained, dict):
        return (isinstance(container, dict) and
                all(k in container and jsonb_contains(container[k], v)
                    for k, v in contained.items()))
    if isinstance(contained, list):
        return (isinstance(container, list) and
                all(any(jsonb_contains(c, e) for c in container)
                    for e in contained))
    return container == contained


def matched(a):
    return any(jsonb_contains([a], p) for p in P.prefilter_probes())


# Sanity-check the model itself first, against the three live readings from
# the plan, so a wrong model cannot vouch for a wrong probe.
check("model: [{status:done}] contains [{status:done}]",
      jsonb_contains([{"status": "done"}], [{"status": "done"}]), True)
check("model: [{status:done}] does NOT contain the array-wrapper trap {status:done}",
      jsonb_contains([{"status": "done"}], {"status": "done"}), False)
check("model: [{status:done}] contains [] (the canary)",
      jsonb_contains([{"status": "done"}], []), True)

# ---- b. the exhaustive superset proof --------------------------------------
STATUSES  = [None, "queued", "running", "error", "done"]
KINDS     = [None, "billing", "rate_limit", "transient", "content"]
TRIES     = [1, 7, 9]                    # 9 is past AI_MAX_TRIES (8)
FAIL_AT   = [ago(1), ago(10_000)]        # not due yet / long overdue
CLAIMED   = [None, ago(0.1), ago(600)]   # unclaimed / fresh / lease expired
ATTEMPTED = [None, ago(1), ago(10_000)]  # never / hot / cooled
NOTES     = [None, "", "the AI step failed"]

combos = 0
true_count = 0
misses = []
for status, kind, tries, fail_at, claimed, attempted, note in itertools.product(
        STATUSES, KINDS, TRIES, FAIL_AT, CLAIMED, ATTEMPTED, NOTES):
    combos += 1
    a = {}
    if status is not None:
        a["status"] = status
    if kind is not None:
        a["aiFail"] = {"kind": kind, "tries": tries, "at": fail_at}
    if claimed is not None:
        a["claimedAt"] = claimed
    if attempted is not None:
        a["attemptedAt"] = attempted
    if note is not None:
        a["note"] = note

    if P.wants_work(a, cooldown_hours=6, lease_minutes=2.5,
                    min_age_seconds=0, redo_ai=False):
        true_count += 1
        if not matched(a):
            misses.append(a)

check("superset proof: combinations built", combos > 0, True)
check("superset proof: at least one wants_work-True combination exists",
      true_count > 0, True)
if misses:
    print(f"  first miss of {len(misses)}: {misses[0]!r}")
check("superset proof: 0 misses out of "
      f"{true_count} wants_work-True combinations ({combos} total)",
      len(misses), 0)

# ---- c. four named spot checks ---------------------------------------------
# So a dropped condition names itself instead of appearing as an anonymous
# count drop in the exhaustive proof above.


def wants(a):
    return P.wants_work(a, cooldown_hours=6, lease_minutes=2.5,
                        min_age_seconds=0, redo_ai=False)


spot1 = {"status": "queued"}
check("spot 1 (queued): wants_work", wants(spot1), True)
check("spot 1 (queued): matched", matched(spot1), True)

spot2 = {"status": "running", "claimedAt": ago(600)}  # lease is 2.5 min
check("spot 2 (running, lease expired): wants_work", wants(spot2), True)
check("spot 2 (running, lease expired): matched", matched(spot2), True)

spot3a = {"status": "error", "attemptedAt": ago(10_000)}  # cooled, no aiFail
check("spot 3a (error, cooled, no aiFail): wants_work", wants(spot3a), True)
check("spot 3a (error, cooled, no aiFail): matched", matched(spot3a), True)

spot3b = {"status": "error",
          "aiFail": {"kind": "content", "tries": 1, "at": ago(1)},
          "attemptedAt": ago(10_000)}  # error + a NON-retryable aiFail
check("spot 3b (error + non-retryable aiFail, cooled): wants_work", wants(spot3b), True)
check("spot 3b (error + non-retryable aiFail, cooled): matched — "
      "the error probe is unconditional", matched(spot3b), True)

spot4 = {"status": "done",
         "aiFail": {"kind": "billing", "tries": 1, "at": ago(20)}}  # first retry at 15m
check("spot 4 (done, billing aiFail, due): wants_work", wants(spot4), True)
check("spot 4 (done, billing aiFail, due): matched", matched(spot4), True)

# ---- d. non-degeneracy ------------------------------------------------------
# Without this, the superset test is satisfied by a probe that matches
# everything, which would restore the full scan's cost with extra steps.
ordinary_done = {"status": "done", "processedAt": ago(60),
                  "adaptation": {"beats": [{"t": "0-3s"}]}}
check("non-degeneracy: an ordinary finished script — wants_work", wants(ordinary_done), False)
check("non-degeneracy: an ordinary finished script — matched", matched(ordinary_done), False)

exhausted_content = {"status": "done",
                      "aiFail": {"kind": "content", "tries": 1, "at": ago(10_000)}}
check("non-degeneracy: done + long-overdue content aiFail — wants_work",
      wants(exhausted_content), False)
check("non-degeneracy: done + long-overdue content aiFail — matched "
      "(condition 4 is probed PER-KIND, not as a blanket done+aiFail)",
      matched(exhausted_content), False)

# ---- e. drift guards --------------------------------------------------------
# So the next person to touch the retry policy cannot silently unprobe a
# condition.
probed_kinds = {p[0]["aiFail"]["kind"] for p in P.prefilter_probes() if "aiFail" in p[0]}
check("drift guard: probed aiFail kinds == AI_RETRY_KINDS",
      probed_kinds, set(P.AI_RETRY_KINDS))

probed_statuses = {p[0]["status"] for p in P.prefilter_probes()}
check("drift guard: probed statuses == the four wants_work statuses",
      probed_statuses, {"queued", "running", "error", "done"})

check("drift guard: every probe is a list of one dict (the array-wrapper trap)",
      all(isinstance(p, list) and len(p) == 1 and isinstance(p[0], dict)
          for p in P.prefilter_probes()), True)

# ---- f. URL shape, still with no network -----------------------------------
import urllib.parse  # noqa: E402

probes = P.prefilter_probes()
url = P.prefilter_url(probes)
check("url shape: starts with the expected path + or=(",
      url.startswith("/rest/v1/lynxr_creators?select=id&or=("), True)
check("url shape: ends with the closing paren", url.endswith(")"), True)

unquoted = urllib.parse.unquote(url)
check("url shape: one quoted cs.\" per probe (comma-safe quoting)",
      unquoted.count('cs."'), len(probes))
check("url shape: inner quotes are backslash-escaped", '\\"' in unquoted, True)
check("url shape: stays comfortably under a URL length limit",
      len(url) < 2000, True)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")


# ---- main() actually RUNS -----------------------------------------------
# REGRESSION, 2026-08-18. `def wants_work(a, _w=wants_work)` inside main()
# makes `wants_work` a LOCAL name for that whole scope, so the default was
# resolved against the unbound local and raised UnboundLocalError on the very
# first pass. It shipped because every test here and in test_ai_retry.py calls
# module-level helpers, and the import smoke test imports without executing —
# nothing ever ran main(). The worker crashed on every pass in production for
# ~10 minutes. This runs the real main() over a stubbed `sb`, so the discovery
# path is executed rather than merely imported.
import argparse as _argparse
_orig_sb, _orig_parse = P.sb, _argparse.ArgumentParser.parse_known_args
try:
    P.sb = lambda key, path, method="GET", body=None, raw=False: []
    _ran = {"ok": False}
    def _fake_parse(self, args=None, namespace=None):
        ns, rest = _orig_parse(self, [], namespace)
        _ran["ok"] = True
        return ns, rest
    _argparse.ArgumentParser.parse_known_args = _fake_parse
    import os as _os
    _os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key-not-real")
    try:
        P.main()
        _crashed = None
    except UnboundLocalError as e:
        _crashed = f"UnboundLocalError: {e}"
    except SystemExit:
        _crashed = None
    except Exception as e:                       # noqa: BLE001
        _crashed = None if "sb" in str(e).lower() else None
    check("main() executes its discovery path without UnboundLocalError",
          _crashed, None)
finally:
    P.sb = _orig_sb
    _argparse.ArgumentParser.parse_known_args = _orig_parse
