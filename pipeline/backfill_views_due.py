#!/usr/bin/env python3
"""One-time migration: queue the 36 Instagram scripts stuck with no view
count for a paid lookup, WITHOUT ever calling Apify from this process.

WHY THIS EXISTS
    36 Instagram lynxr_sources rows have no view count at all — 13 were
    orphaned before Fly ever had an APIFY_API_TOKEN, 7 have no source.meta at
    all, and the rest simply never got measured. The paid lookups that fix
    this must run inside the Fly worker's own serial sweep (refresh_views),
    never from this script or from this Mac: the Mac holds the token too, and
    running a lookup here would race the worker's read-modify-write on
    lynxr_creators (see the plan's "Do not" section) and spend money outside
    the worker's own budget gate.

    So this script does exactly one thing: it sets `metrics_at = NULL` on the
    rows that are due, which is what makes refresh_views() (ordered
    metrics_at.asc.nullsfirst) pick them up FIRST on the worker's next idle
    passes — 3 Instagram rows per pass, paid and budget-gated there, not here.

WHAT IT TOUCHES
    lynxr_sources.metrics_at only, set to NULL, only on rows matching
    platform = instagram AND views IS NULL AND metrics_at IS NOT NULL.
    (A row with metrics_at already NULL is already at the front of the
    queue — touching it again would be a no-op PATCH.) Nothing else, on no
    other table.

USAGE
    ./venv/bin/python pipeline/backfill_views_due.py                # dry run
    ./venv/bin/python pipeline/backfill_views_due.py --apply         # queue them
    ./venv/bin/python pipeline/backfill_views_due.py --apply --max 100
"""

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import envcfg  # noqa: E402
from process_adaptations import sb, load_env, ROOT  # noqa: E402

PRICE_PER_LOOKUP_USD = 0.0027


def due_rows(key):
    return sb(key, "/rest/v1/lynxr_sources?select=canonical_url,url,metrics_at,first_seen_at"
                    "&platform=eq.instagram&views=is.null&metrics_at=not.is.null"
                    "&order=first_seen_at.desc") or []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="actually queue the rows (default: dry run, writes nothing)")
    ap.add_argument("--max", type=int, default=60,
                    help="refuse --apply if more than this many rows would be queued "
                         "(default 60, a $0.16 sanity bound at $0.0027/lookup)")
    args = ap.parse_args()

    env = load_env(ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY",
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"),
                            env.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (source the .env first)")

    rows = due_rows(key)
    n = len(rows)
    print(f"{n} row(s) would be queued for a paid view lookup")
    print(f"est. ≤ ${n * PRICE_PER_LOOKUP_USD:.4f} at ${PRICE_PER_LOOKUP_USD} each "
          "(orphans cost $0 — refresh_views skips them)")
    for row in rows:
        print(f"  {(row.get('url') or '')[:70]}")

    if not args.apply:
        return

    if n > args.max:
        sys.exit(f"refusing --apply: {n} row(s) exceeds --max {args.max} "
                 f"(${args.max * PRICE_PER_LOOKUP_USD:.2f} sanity bound) — "
                 "pass a higher --max if this is genuinely expected")

    sb(key, "/rest/v1/lynxr_sources?platform=eq.instagram&views=is.null&metrics_at=not.is.null",
       method="PATCH", body={"metrics_at": None})

    now_null = sb(key, "/rest/v1/lynxr_sources?select=canonical_url"
                       "&platform=eq.instagram&views=is.null&metrics_at=is.null") or []
    print(f"now queued: {len(now_null)}")


if __name__ == "__main__":
    main()
