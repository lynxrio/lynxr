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
# reliability plan, Step 10.1: `final` only ever REMOVES a wants_work-True
# case (the automatic-loop floor added in Step 3), so widening the brute
# force with it can only shrink true_count — it cannot manufacture a miss
# that wasn't already possible, and the probes stay a strict superset.
FINALS    = [None, True]
PASSES    = [0, 1, P.FINAL_MAX_PASSES]

combos = 0
true_count = 0
misses = []
for status, kind, tries, fail_at, claimed, attempted, note, final, passes in itertools.product(
        STATUSES, KINDS, TRIES, FAIL_AT, CLAIMED, ATTEMPTED, NOTES, FINALS, PASSES):
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
    if final is not None:
        a["final"] = final
    if passes is not None:
        a["passes"] = passes

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

# reliability plan, Step 10.2: the automatic-loop floor (Step 3) turns an
# error entry with `final` into wants_work-False — but the {"status":"error"}
# probe is deliberately UNCONDITIONAL (over-selecting costs one row fetch,
# under-selecting loses a script), so it must still match even though
# wants_work is now False for this shape.
spot5 = {"status": "error", "final": True, "attemptedAt": ago(10_000)}
check("spot 5 (error, final, cooled): wants_work is False now",
      wants(spot5), False)
check("spot 5 (error, final, cooled): matched — the error probe is unconditional",
      matched(spot5), True)


def wants_redo(a):
    return P.wants_work(a, cooldown_hours=6, lease_minutes=2.5,
                        min_age_seconds=0, redo_ai=True)


check("spot 5 under --redo-ai: wants_work True (the manual escape hatch)",
      wants_redo(spot5), True)

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

# ---- g. THE TERMINATION PROOF — the point of the whole plan ----------------
# Drives the REAL process_group over four permanently-failing shapes, each
# pass backed by an always-529 (or always-refusing, or always-walled) stub,
# and asserts the automatic loop stops selecting the entry within
# AI_MAX_TRIES + 2 passes. On unmodified code the branded case runs to the
# bound and never stops — that is exactly the bug this plan closes.


def _drive_to_termination(entry, brands, fill_source_stub, structured_stub):
    """Repeatedly run process_group over ONE entry until wants_work(entry)
    goes False or the bound is exceeded. Between passes, back-dates whatever
    schedule field exists (attemptedAt / aiFail.at) far enough to be due —
    the same "six hours later" trick the other end-to-end proofs use — so a
    real backoff schedule doesn't make the test itself the bottleneck.

    Returns (passes_taken, stopped) where `stopped` is whether wants_work is
    False once the loop exits.
    """
    orig_sb, orig_fetch_meta = P.sb, P.fetch_meta
    orig_upsert_source, orig_upsert_video = P.upsert_source, P.upsert_video
    orig_fill_source, orig_structured = P.fill_source, P.structured
    bound = P.AI_MAX_TRIES + 2
    try:
        P.sb = lambda key, path, method="GET", body=None, raw=False: [{"data": {"adaptations": []}}]
        P.fetch_meta = lambda url: {}
        P.upsert_source = lambda key, a: None
        P.upsert_video = lambda key, a: None
        P.fill_source = fill_source_stub
        P.structured = structured_stub
        group = [("cid-term", {"name": "t", "brands": brands}, entry)]

        def wants():
            return P.wants_work(entry, cooldown_hours=6, lease_minutes=2.5,
                                min_age_seconds=0, redo_ai=False)

        passes = 0
        while wants() and passes < bound:
            P.process_group("fake-key", object(), group)
            passes += 1
            if entry.get("attemptedAt"):
                entry["attemptedAt"] = ago(10_000)
            if entry.get("aiFail"):
                entry["aiFail"]["at"] = ago(10_000)
        return passes, not wants()
    finally:
        P.sb, P.fetch_meta = orig_sb, orig_fetch_meta
        P.upsert_source, P.upsert_video = orig_upsert_source, orig_upsert_video
        P.fill_source, P.structured = orig_fill_source, orig_structured


def _term_fill_source_ok(a, aclient, key, notes, timings, publish=None):
    a["source"] = {"platform": "tiktok",
                   "script": {"has_speech": False, "text": ""}, "shots": []}
    return True


def _term_fill_source_wall(a, aclient, key, notes, timings, publish=None):
    raise RuntimeError("download failed: ERROR: [TikTok] 1: This post may not be "
                       "comfortable for some audiences. Log in for access.")


def _term_structured_529(client, system, schema, content, max_tokens=3000):
    raise RuntimeError("Error code: 529 - Overloaded")


def _term_structured_content_refusal(client, system, schema, content, max_tokens=3000):
    # The format extraction call always succeeds — only the per-brand adapt
    # call refuses — so the shape under test is genuinely "a refusal", not
    # "no format for this video" (a different, already-covered path).
    if schema is P.FORMAT_SCHEMA:
        return {"name": "fmt", "beats": [{"role": "hook", "seconds": 3}],
                "product_entry": "early", "why_it_works": "x", "wrapper_removed": ""}
    raise RuntimeError("the model declined: this violates content policy")


# a. a branded entry, every pass 529ing on format extraction and the adapt call
term_branded = {"id": "termbrd1", "brandId": "b1", "status": "queued",
                "sourceUrl": "https://tiktok.com/@x/video/t1"}
p_branded, stopped_branded = _drive_to_termination(
    term_branded, [{"id": "b1", "name": "Acme"}], _term_fill_source_ok, _term_structured_529)
check(f"termination (branded, 529): stopped within {P.AI_MAX_TRIES + 2} passes (took {p_branded})",
      stopped_branded, True)
check("termination (branded, 529): within the bound", p_branded <= P.AI_MAX_TRIES + 2, True)

# b. a no-brand entry, same always-529 structured() — the source-read-back path
term_nobrand = {"id": "termnob1", "status": "queued", "sourceUrl": "https://tiktok.com/@x/video/t2"}
p_nobrand, stopped_nobrand = _drive_to_termination(
    term_nobrand, [], _term_fill_source_ok, _term_structured_529)
check(f"termination (no-brand, 529): stopped within {P.AI_MAX_TRIES + 2} passes (took {p_nobrand})",
      stopped_nobrand, True)
check("termination (no-brand, 529): within the bound", p_nobrand <= P.AI_MAX_TRIES + 2, True)

# c. a branded entry whose adapt call is refused (content) — should stop fast
term_refused = {"id": "termref1", "brandId": "b1", "status": "queued",
                "sourceUrl": "https://tiktok.com/@x/video/t3"}
p_refused, stopped_refused = _drive_to_termination(
    term_refused, [{"id": "b1", "name": "Acme"}], _term_fill_source_ok,
    _term_structured_content_refusal)
check(f"termination (content refusal): stopped within {P.AI_MAX_TRIES + 2} passes (took {p_refused})",
      stopped_refused, True)
check("termination (content refusal): within the bound", p_refused <= P.AI_MAX_TRIES + 2, True)

# d. a permanent fetch wall — should stop on the very first pass
term_wall = {"id": "termwal1", "brandId": "b1", "status": "queued",
             "sourceUrl": "https://tiktok.com/@x/video/t4"}
p_wall, stopped_wall = _drive_to_termination(
    term_wall, [{"id": "b1", "name": "Acme"}], _term_fill_source_wall, _term_structured_529)
check(f"termination (fetch wall): stopped within {P.AI_MAX_TRIES + 2} passes (took {p_wall})",
      stopped_wall, True)
check("termination (fetch wall): within the bound", p_wall <= P.AI_MAX_TRIES + 2, True)

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
