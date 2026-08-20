"""Checks on the cost formula and the lynxr_costs row builder — the
persistence half of `~/.claude/plans/agency-ops-dashboard.md`.

Run with

    ./venv/bin/python pipeline/test_costs.py

PURE-FUNCTION checks only, no network, no Supabase: `cost_of()` and
`cost_rows()` are both deliberately pure (see their docstrings in
process_adaptations.py) so this file needs neither a key nor a live table.
`record_cost()` itself — the HTTP write — is exercised live only by actually
running the worker; there is no test database here to point it at, so it is
not covered by this file (see supabase/costs_table.sql's header for the owner
action that makes it reachable at all).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_adaptations as P  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


def d(in_=0, out=0, write=0, read=0, calls=1):
    return {"in": in_, "out": out, "write": write, "read": read, "calls": calls}


# ---- 1/2: plain input and output rates -------------------------------------
check("cost_of: 1M input tokens on claude-opus-5 -> $5.00 (list input rate)",
      P.cost_of("claude-opus-5", d(in_=1_000_000)), 5.00)
check("cost_of: 1M output tokens on claude-opus-5 -> $25.00 (list output rate)",
      P.cost_of("claude-opus-5", d(out=1_000_000)), 25.00)

# ---- 3: cache write at 1.25x input, cache read at 0.10x --------------------
check("cost_of: 1M cache-write tokens on claude-opus-5 -> $6.25 (1.25x input)",
      P.cost_of("claude-opus-5", d(write=1_000_000)), 6.25)
check("cost_of: 1M cache-read tokens on claude-opus-5 -> $0.50 (0.10x input)",
      P.cost_of("claude-opus-5", d(read=1_000_000)), 0.50)

# ---- 4: a dated model suffix prices the same as the bare name --------------
# This is the id analyze_visuals.MODEL actually sends (claude-haiku-4-5-20251001)
# — a regression here silently unprices every shot-list call.
mixed = d(in_=200_000, out=50_000, write=30_000, read=400_000)
check("cost_of: dated haiku suffix prices identically to the bare model name",
      P.cost_of("claude-haiku-4-5-20251001", mixed), P.cost_of("claude-haiku-4-5", mixed))

# ---- 5: an unknown model has no price on file ------------------------------
check("cost_of: a model with no PRICES entry -> None, not a wrong number",
      P.cost_of("gpt-nope", d(in_=1000)), None)

# ---- 6: one row per model, not one blended row ------------------------------
two_model_usage = {
    "claude-opus-5": d(in_=100_000, out=10_000, write=5_000, read=20_000, calls=2),
    "claude-haiku-4-5-20251001": d(in_=50_000, out=5_000, calls=1),
}
rows = P.cost_rows(two_model_usage, "abcdef0123456789", True)
check("cost_rows: one row per model for a two-model usage dict", len(rows), 2)
check("cost_rows: the row set names exactly the two models present",
      {r["model"] for r in rows}, {"claude-opus-5", "claude-haiku-4-5-20251001"})
by_model = {r["model"]: r for r in rows}
check("cost_rows: the opus row's usd matches cost_of on the same tally",
      by_model["claude-opus-5"]["usd"],
      round(P.cost_of("claude-opus-5", two_model_usage["claude-opus-5"]), 6))
check("cost_rows: the haiku row's usd matches cost_of on the same tally",
      by_model["claude-haiku-4-5-20251001"]["usd"],
      round(P.cost_of("claude-haiku-4-5-20251001", two_model_usage["claude-haiku-4-5-20251001"]), 6))

# ---- 7: id8 truncation, and no creator-identifying key ---------------------
check("cost_rows: id8 is truncated to 8 characters",
      rows[0]["id8"], "abcdef01")
check("cost_rows: a row's key set carries no creator id, url, sourceUrl or title",
      set(rows[0].keys()),
      {"id8", "ok", "model", "calls", "tokens_in", "tokens_out",
       "tokens_cache_write", "tokens_cache_read", "usd", "price_rev"})

# ---- 8: the unpriced/priced pair that stops the panel rendering $0 --------
unpriced_usage = {"gpt-nope": d(in_=1000, out=1000)}
unpriced_rows = P.cost_rows(unpriced_usage, "x", True)
check("cost_rows: an unpriced model's row carries usd == 0", unpriced_rows[0]["usd"], 0)
check("cost_rows: an unpriced model's row carries an EMPTY price_rev (not measured, not free)",
      unpriced_rows[0]["price_rev"], "")
priced_rows = P.cost_rows({"claude-opus-5": d(in_=1000)}, "x", True)
check("cost_rows: a priced model's row carries price_rev == P.PRICES_REV",
      priced_rows[0]["price_rev"], P.PRICES_REV)

# ---- 9: an empty usage dict writes nothing ---------------------------------
check("cost_rows: an empty usage dict -> [] (record_cost short-circuits before any HTTP call)",
      P.cost_rows({}, "x", True), [])

# ---- 10: log_usage and cost_rows agree — one formula, never two -----------
# log_usage() only adds a model's cost into its printed total when that model
# is priced (cost_of returns non-None); an unpriced model prints "(no price on
# file)" and is excluded from the total. Reproduce exactly that selection here
# rather than hard-coding a literal, so the assertion is the identity, not a
# copy of today's numbers.
agree_usage = {
    "claude-opus-5": d(in_=300_000, out=20_000, write=10_000, read=50_000, calls=3),
    "claude-haiku-4-5": d(in_=80_000, out=8_000, calls=1),
}
log_usage_total = sum(
    c for c in (P.cost_of(model, dd) for model, dd in agree_usage.items()) if c is not None)
cost_rows_total = sum(r["usd"] for r in P.cost_rows(agree_usage, "x", True))
check("log_usage's printed total and cost_rows' summed usd agree (one formula, not two)",
      round(cost_rows_total, 6), round(log_usage_total, 6))

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
