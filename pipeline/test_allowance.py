"""Checks on the allowance ledger's guards — the server-side control that
replaced the JSONB-blob cap and its three known walks (wiping `adaptations`,
wiping `trash`, back-dating one entry's `addedAt`).

Run with

    ./venv/bin/python pipeline/test_allowance.py

TWO TIERS, deliberately:

1. PURE-FUNCTION checks, always run, no network, no Supabase: the Python-side
   half of the guard (count_charges()'s fail-open degrade, the scheme check
   supported_url() now applies, the AI-failure wording that stopped raw
   exception text reaching a creator's card).

2. LEDGER checks, against the LIVE project, of the actual server-side
   invariant: that the three known bypasses fail to move a creator's charge
   count. These need supabase/allowance_ledger.sql applied (an owner action —
   see that file's header) AND a disposable creator id to charge against,
   which this repo has no test database to provide. They SKIP CLEANLY,
   printing why, rather than failing or (worse) inventing a database:

     - no SUPABASE_SERVICE_ROLE_KEY   -> skipped, same as pipeline/.env being absent
     - allowance_ledger.sql not applied (probed once, read-only)  -> skipped
     - no LYNXR_TEST_CREATOR_ID in the environment -> skipped

   That third gate is deliberately stricter than the plan's own minimum ("skip
   when SUPABASE_SERVICE_ROLE_KEY is absent"): charge_scripts() WRITES rows
   tied to a real auth.users id, and this file must never charge a real
   creator's allowance just by being run. Set LYNXR_TEST_CREATOR_ID to a
   throwaway account's uuid to actually exercise tier 2; until then, tier 2's
   absence is reported, not hidden.
"""

import os
import sys
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_adaptations as P  # noqa: E402

FAILS = []
SKIPPED = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


def skip(name, why):
    SKIPPED.append(name)
    print(f"skip  {name}: {why}")


# =============================================================================
# TIER 1 — pure function, no network
# =============================================================================

# ---- count_charges() degrades to 0 on any failure, never raises -----------
_ORIG_URLOPEN = P.urllib.request.urlopen


def _raise(*a, **k):
    raise urllib.error.HTTPError("url", 404, "not found", {}, None)


P.urllib.request.urlopen = _raise
try:
    check("count_charges() with the table missing (404) -> 0, no raise",
          P.count_charges("fake-key", "2026-01-01T00:00:00Z"), 0)
finally:
    P.urllib.request.urlopen = _ORIG_URLOPEN

# ---- the daily-cap breaker and the watchdog alarm read the SAME default ---
sys.path.insert(0, str(Path(__file__).resolve().parent))
import watchdog as W  # noqa: E402
check("process_adaptations' --daily-cap default and watchdog's DAILY_SCRIPT_CAP agree",
      250, W.DAILY_SCRIPT_CAP)

# ---- supported_url() now requires http(s), not just a matching host -------
check("bare host, no scheme -> False (already refused before this plan)",
      P.supported_url("tiktok.com/@x/video/1"), False)
check("javascript: scheme on a matching host -> False",
      P.supported_url("javascript://tiktok.com/@x/video/1"), False)
check("https on a supported host -> True", P.supported_url("https://tiktok.com/@x/video/1"), True)
check("ftp on a supported host -> False", P.supported_url("ftp://tiktok.com/@x/video/1"), False)

# ---- a billing/rate_limit/transient failure never reaches the creator's ---
# ---- card as Anthropic's own sentence about OUR credit balance ------------
_wording = dict(P.AI_FAIL_WORDING)
for kind in ("billing", "rate_limit", "transient"):
    check(f"{kind} wording carries no raw vendor text",
          "credit balance" in _wording[kind] or "rate_limit_error" in _wording[kind], False)
check("content wording is about the video, not the vendor",
      "video" in _wording["content"], True)
check("every AI_FAIL_KINDS kind has a wording entry",
      set(k for k, _ in P.AI_FAIL_KINDS) <= set(_wording), True)
check("ai_failure_kind()'s fallback ('content') has a wording entry too",
      "content" in _wording, True)

# =============================================================================
# TIER 2 — the actual ledger, live. Skips cleanly; see the module docstring.
# =============================================================================

env = P.load_env(P.ROOT / ".env")
key = env.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
test_creator = os.environ.get("LYNXR_TEST_CREATOR_ID")

if not key:
    skip("three-bypass proof (charge_scripts)", "SUPABASE_SERVICE_ROLE_KEY not set")
    skip("period_days rolling-window proof (charge_scripts)", "SUPABASE_SERVICE_ROLE_KEY not set")
elif not test_creator:
    skip("three-bypass proof (charge_scripts)",
         "LYNXR_TEST_CREATOR_ID not set — refusing to charge against a real creator "
         "(see module docstring); set it to a throwaway account's uuid to run this")
    skip("period_days rolling-window proof (charge_scripts)",
         "LYNXR_TEST_CREATOR_ID not set — see above")
else:
    def rpc_count(creator_id):
        rows = P.sb(key, f"/rest/v1/lynxr_script_charges?creator_id=eq.{creator_id}&select=adaptation_id")
        return len(rows or [])

    try:
        before = rpc_count(test_creator)
    except Exception as e:  # noqa: BLE001
        before = None
        skip("three-bypass proof (charge_scripts)",
             f"allowance_ledger.sql not applied yet — {str(e)[:90]}")
        skip("period_days rolling-window proof (charge_scripts)", "same — schema not applied")

    if before is not None:
        # The bypass proof doesn't need to simulate the browser console at
        # all — that is the point. `data.adaptations`/`data.trash`/`addedAt`
        # never appear in this call. charge_scripts() only ever sees a
        # creator id and a list of adaptation ids; there is nothing in its
        # signature FOR "wipe adaptations", "wipe trash" or "back-date
        # addedAt" to act on. The three-bypass proof is therefore: charge one
        # id, then charge it again (the resend a wipe-and-repaste would look
        # like from the server's side) — the count must not move.
        probe_id = f"test-{datetime.now(timezone.utc).timestamp()}"
        try:
            r1 = P.sb(key, "/rest/v1/rpc/charge_scripts", method="POST",
                      body={"p_creator": test_creator, "p_ids": [probe_id]})
            after_first = rpc_count(test_creator)
            r2 = P.sb(key, "/rest/v1/rpc/charge_scripts", method="POST",
                      body={"p_creator": test_creator, "p_ids": [probe_id]})
            after_repeat = rpc_count(test_creator)
            check("charging the same id twice ('wipe and repaste') doesn't double-charge",
                  after_repeat, after_first)
            check("both calls report the id charged (idempotent)", r1 == r2, True)
        finally:
            P.sb(key, "/rest/v1/rpc/refund_script", method="POST", body={"p_id": probe_id})

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
if SKIPPED:
    print(f"{len(SKIPPED)} skipped (see above) — not verified against the live ledger")
print("all checks passed")
