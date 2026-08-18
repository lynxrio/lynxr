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

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
