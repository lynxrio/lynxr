#!/usr/bin/env python3
"""One-time migration: reinterpret an existing Instagram `views: 0` as unknown.

WHY THIS EXISTS
    process_adaptations.py used to do `int(view_count or 0)`, so a platform
    that reported nothing was stored as a measured `0` — indistinguishable
    from a real zero-view video. That coercion is fixed going forward
    (fetch_meta / source_metrics / trusted_views); this is the write-back for
    rows already stored under the old behaviour.

    NOT DESTROYING DATA. Instagram provably cannot report a view count at
    all without signing in — yt-dlp never returns a `view_count` key for it,
    by any unauthenticated route: the pinned release, the newest nightly,
    the `app_id=ios` extractor argument, the public /embed/ page and
    unauthenticated oEmbed all return nothing (measured 2026-08-19, plan
    Appendix A). So a stored Instagram `0` can only ever have come from
    `int(None or 0)`, never a measurement — this migration only ever touches
    rows on a platform that provably cannot report a genuine zero.

WHAT IT TOUCHES
    lynxr_sources — rows where platform=instagram and views=0, PATCHed to
    views=null. Expect 7 rows (verified live 2026-08-19).

    lynxr_creators — adaptations/trash entries where platform_of(sourceUrl)
    == "instagram" and source.meta.views == 0, set to None (matching the
    shape fetch_meta now writes — the key stays, so "asked, nothing" reads
    the same everywhere). Skips any entry whose status is "queued" or
    "running" — that entry is in flight and something else owns it, the same
    guard process_adaptations.py's apply_views()/renew_claim() use. Expect
    19 entries across 13 adaptations + 6 trash, all status "done" (verified
    live 2026-08-19).

    For each creator row this re-reads the row immediately before writing
    and mutates that fresh copy rather than a snapshot taken earlier in the
    run — the same renew_claim() pattern process_adaptations.py uses for any
    read-modify-write of a creator's whole JSON blob, so this can never write
    back a stale copy of an adaptation the pipeline touched in the meantime.
    (This script is a single, short-lived process with no threads of its
    own, so there is no in-process lock to share across processes — the
    fresh read immediately before the write is what actually narrows the
    window, and this is meant to be run once, as a manual migration, not
    scheduled against a busy pipeline.)

    This half changes no pixels — videoViews() already treats 0 as absent,
    so these cards are blank today and stay blank. It is about the row
    being true, and about `views is null` being a usable filter again:
    backfill_source_metrics.py's default backlog query is `&views=is.null`,
    so a views=0 row is invisible to it today and permanently excluded from
    the very repair that would fill it in.

USAGE
    set -a; source .env; set +a
    ./venv/bin/python pipeline/backfill_views_null.py --dry-run
    ./venv/bin/python pipeline/backfill_views_null.py
"""

import argparse
import json
import logging
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from process_adaptations import platform_of  # noqa: E402  (same source of truth)
import envcfg  # noqa: E402 — the one place a secret or config value is read; see its docstring.

SB_URL = "https://esakjfogplfszievvabi.supabase.co"

# This venv's Python has no system CA bundle — a bare default context fails
# every request with CERTIFICATE_VERIFY_FAILED. Same guard the rest of the
# pipeline uses (process_adaptations.py, backfill_titles.py, cohort.py).
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("backfill-views-null")


def sb(key, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(SB_URL + path, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=90, context=SSL_CTX) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw.strip() else None


def fix_sources(key, dry_run, limit):
    """lynxr_sources: platform=instagram, views=0 -> views=null."""
    rows = sb(key, "/rest/v1/lynxr_sources?select=canonical_url,platform,views"
                    "&views=eq.0&platform=eq.instagram")
    if limit:
        rows = rows[:limit]
    log.info("lynxr_sources: %d row(s) with views=0 on instagram%s",
              len(rows), "  [DRY RUN]" if dry_run else "")
    fixed = 0
    for row in rows:
        log.info("  %s", row["canonical_url"][:70])
        if dry_run:
            fixed += 1
            continue
        q = "/rest/v1/lynxr_sources?canonical_url=eq." + urllib.parse.quote(
            row["canonical_url"], safe="")
        try:
            sb(key, q, method="PATCH", body={"views": None})
            fixed += 1
        except urllib.error.HTTPError as e:
            log.error("  update failed (%s): %s", e.code, e.read().decode()[:160])
    log.info("lynxr_sources done — %d row(s) %s",
              fixed, "would be nulled" if dry_run else "nulled")
    return fixed


def _null_zero_instagram(entries):
    """Set source.meta.views to None on every entry that is Instagram and
    currently reads a measured-looking 0. Pure — no I/O. Returns the count
    changed.

    Skips any entry whose status is "queued" or "running" — the same guard
    process_adaptations.py's apply_views() uses, for the same reason: that
    entry is in flight and something else owns it."""
    changed = 0
    for entry in entries:
        if entry.get("status") in ("queued", "running"):
            continue
        source = entry.get("source")
        if not isinstance(source, dict):
            continue
        meta = source.get("meta")
        if not isinstance(meta, dict):
            continue
        if meta.get("views") != 0:
            continue
        if platform_of(entry.get("sourceUrl") or "") != "instagram":
            continue
        meta["views"] = None
        changed += 1
    return changed


def fix_creators(key, dry_run, limit):
    """lynxr_creators: adaptations + trash entries, platform=instagram,
    source.meta.views=0 -> None."""
    rows = sb(key, "/rest/v1/lynxr_creators?select=id,data")
    if limit:
        rows = rows[:limit]
    total = 0
    for row in rows:
        cid = row["id"]
        if dry_run:
            # Preview against the row already in hand — nothing is written,
            # so there is no snapshot to go stale.
            data = row["data"]
            n = _null_zero_instagram(data.get("adaptations") or [])
            n += _null_zero_instagram(data.get("trash") or [])
            if n:
                log.info("  creator %s: %d entr%s would be nulled",
                          str(cid)[:8], n, "y" if n == 1 else "ies")
            total += n
            continue
        # NEVER write a snapshot — re-read the row fresh immediately before
        # writing (renew_claim's pattern) and mutate that copy. Anything the
        # live pipeline did to this row between the listing above and now
        # must not be rolled back.
        fresh = sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}&select=data")[0]["data"]
        n = _null_zero_instagram(fresh.get("adaptations") or [])
        n += _null_zero_instagram(fresh.get("trash") or [])
        if n:
            sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}", method="PATCH",
               body={"data": fresh})
            log.info("  creator %s: %d entr%s nulled",
                      str(cid)[:8], n, "y" if n == 1 else "ies")
        total += n
    log.info("lynxr_creators done — %d entr%s %s",
              total, "y" if total == 1 else "ies",
              "would be nulled" if dry_run else "nulled")
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would change and write nothing")
    ap.add_argument("--limit", type=int, default=0,
                    help="stop after N rows per half (0 = all)")
    args = ap.parse_args()

    key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (source the .env first)")

    fix_sources(key, args.dry_run, args.limit)
    fix_creators(key, args.dry_run, args.limit)


if __name__ == "__main__":
    main()
