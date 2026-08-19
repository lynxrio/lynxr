#!/usr/bin/env python3
"""Repair lynxr_videos rows whose title is yt-dlp's Instagram placeholder.

WHY THIS EXISTS
    yt-dlp has no real title to report for an Instagram post, so it synthesises
    one — "Video by stephyapps" — and puts the actual caption in `description`.
    fetch_meta() used to prefer `title` unconditionally, so every
    creator-submitted Instagram video was filed under that placeholder. The
    read side is fixed; this is the write-back for rows already stored.

    Forward-only would not have been enough: these rows are in the corpus the
    agency app searches and ranks, and a row called "Video by <handle>" is
    invisible to a title search and useless in a brief.

WHAT IT TOUCHES
    ONLY the `title` column, and only on rows it can find a real caption for.
    A row whose lookup fails is left exactly as it was rather than blanked —
    the placeholder is bad, but it is better than nothing, and a private or
    deleted post will never resolve.

    It reuses fetch_meta() from process_adaptations rather than re-deriving the
    caption, so the placeholder rule lives in exactly one place and the backfill
    cannot drift from the pipeline that writes new rows.

USAGE
    set -a; source .env; set +a
    ./venv/bin/python pipeline/backfill_titles.py --dry-run
    ./venv/bin/python pipeline/backfill_titles.py
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

from process_adaptations import fetch_meta
import envcfg  # the one place a secret or config value is read; see its docstring.

SB_URL = "https://esakjfogplfszievvabi.supabase.co"
TABLE = "/rest/v1/lynxr_videos"
# PostgREST's `like` wildcard is *, not %.
PLACEHOLDER = "Video by *"

# This venv's Python has no system CA bundle — a bare default context fails
# every request with CERTIFICATE_VERIFY_FAILED. Same guard the rest of the
# pipeline uses (process_adaptations.py, upload_covers.py, cohort.py).
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("backfill-titles")


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


def targets(key, include_empty):
    """Rows needing a title. Selected on the placeholder, not on platform, so a
    placeholder that ever shows up elsewhere is caught too."""
    sel = "select=platform,video_id,url,title,data_source"
    rows = sb(key, f"{TABLE}?title=like.{urllib.parse.quote(PLACEHOLDER)}&{sel}&limit=2000")
    if include_empty:
        rows += sb(key, f"{TABLE}?title=eq.&{sel}&limit=2000")
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would change and write nothing")
    ap.add_argument("--limit", type=int, default=0, help="stop after N rows")
    ap.add_argument("--include-empty", action="store_true",
                    help="also fill rows whose title is empty (scraper/client "
                         "imports, a different defect from the placeholder)")
    args = ap.parse_args()

    key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (source the .env first)")

    rows = targets(key, args.include_empty)
    if args.limit:
        rows = rows[:args.limit]
    log.info("%d row(s) to repair%s", len(rows), "  [DRY RUN]" if args.dry_run else "")

    fixed = skipped = failed = 0
    for i, row in enumerate(rows, 1):
        url, was = row["url"], row["title"]
        title = (fetch_meta(url) or {}).get("title", "").strip()
        if not title:
            log.warning("  %2d/%d  no caption found, left as-is: %s", i, len(rows), url[:70])
            failed += 1
            continue
        if title == was:
            skipped += 1
            continue
        log.info("  %2d/%d  %r -> %r", i, len(rows), was[:34], title[:60])
        if args.dry_run:
            fixed += 1
            continue
        # platform+video_id is the table's unique key (see upsert_video's
        # on_conflict). Filtering on both makes this a single-row update.
        q = (f"{TABLE}?platform=eq.{urllib.parse.quote(row['platform'])}"
             f"&video_id=eq.{urllib.parse.quote(row['video_id'])}")
        try:
            sb(key, q, method="PATCH", body={"title": title})
            fixed += 1
        except urllib.error.HTTPError as e:
            log.error("  update failed (%s): %s", e.code, e.read().decode()[:160])
            failed += 1

    log.info("done — %d repaired, %d already correct, %d left alone", fixed, skipped, failed)


if __name__ == "__main__":
    main()
