#!/usr/bin/env python3
"""Fill in views/likes/comments/creator/title on lynxr_sources rows that have none.

WHY. lynxr_sources gained metric columns after 19 rows already existed, so those
rows read NULL for everything. process_adaptations.py writes the numbers going
forward — this is only for the backlog.

It costs nothing but time: yt-dlp reads the platform's own public counts, no API
and no key, which is the same call lynxr_videos rows have always been built from.
`fetch_meta` is IMPORTED rather than re-implemented so the two can never drift —
the same reason backfill_titles.py imports it.

    ./venv/bin/python pipeline/backfill_source_metrics.py            # all NULL rows
    ./venv/bin/python pipeline/backfill_source_metrics.py --limit 5  # try a few first
    ./venv/bin/python pipeline/backfill_source_metrics.py --refresh  # re-read ALL rows

RUN sources_staff_read.sql FIRST. Without the metric columns every write here
comes back 400 (PGRST204, "column not found"), which is the error you will see.
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
from datetime import datetime, timezone
from pathlib import Path

import certifi

sys.path.insert(0, str(Path(__file__).resolve().parent))
from process_adaptations import fetch_meta  # noqa: E402  (same source of truth)

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("backfill-metrics")

# The venv's Python has no system CA bundle — a bare create_default_context()
# fails every Supabase request with CERTIFICATE_VERIFY_FAILED.
SSL_CTX = ssl.create_default_context(cafile=certifi.where())


# Hardcoded, same as every other script in pipeline/ — .env carries the KEY and
# nothing else. Do not "improve" this into an env var without changing the other
# six, or half the pipeline reads one project and half reads another.
SB_URL = "https://esakjfogplfszievvabi.supabase.co"


def load_key():
    """Read .env the same way worker.py does, falling back to the environment so
    this works inside the container as well as on a laptop."""
    env = {}
    p = Path(__file__).resolve().parent.parent / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return (env.get("SUPABASE_SERVICE_ROLE_KEY")
            or os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "")


def sb(url, key, path, method="GET", body=None, extra=None):
    req = urllib.request.Request(url + path, method=method)
    for h, v in (("apikey", key), ("Authorization", f"Bearer {key}"),
                 ("Content-Type", "application/json")):
        req.add_header(h, v)
    for h, v in (extra or {}).items():
        req.add_header(h, v)
    if body is not None:
        req.data = json.dumps(body).encode()
    with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="stop after N rows (0 = all)")
    ap.add_argument("--refresh", action="store_true",
                    help="re-read rows that already have metrics, not just NULL ones")
    args = ap.parse_args()

    url, key = SB_URL, load_key()
    if not key:
        log.error("SUPABASE_SERVICE_ROLE_KEY missing from .env")
        return 1

    # `views=is.null` is the backlog. With --refresh, take everything instead —
    # counts on a video that was pasted last week have moved since.
    q = "/rest/v1/lynxr_sources?select=canonical_url,url,views,metrics_at&order=last_seen_at.desc"
    if not args.refresh:
        q += "&views=is.null"
    try:
        rows = sb(url, key, q)
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:200]
        if "column" in detail and "does not exist" in detail or "PGRST204" in detail:
            log.error("The metric columns are missing — run supabase/sources_staff_read.sql "
                      "in the SQL editor first.\n  %s", detail)
        else:
            log.error("read failed: %s — %s", e, detail)
        return 1

    if args.limit:
        rows = rows[:args.limit]
    if not rows:
        log.info("nothing to do — every row already has metrics")
        return 0

    log.info("%d row(s) to read", len(rows))
    done = failed = 0
    for r in rows:
        src = r.get("url") or ""
        meta = fetch_meta(src)
        if not meta:
            # A deleted or private post is the common case and is not an error
            # worth failing the run over — it simply stays NULL, which is the
            # honest value. Rerunning later costs nothing.
            failed += 1
            log.warning("  no metadata: %s", src[:64])
            continue
        patch = {
            "views": meta.get("views"),
            "likes": meta.get("likes"),
            "comments": meta.get("comments"),
            "duration": meta.get("duration"),
            "creator": meta.get("creator") or "",
            "title": meta.get("title") or "",
            "metrics_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        # Keyed on the primary key, so this can only ever touch the one row.
        target = "/rest/v1/lynxr_sources?canonical_url=eq." + urllib.parse.quote(
            r["canonical_url"], safe="")
        try:
            sb(url, key, target, method="PATCH", body=patch,
               extra={"Prefer": "return=minimal"})
            done += 1
            log.info("  %8s views  %s", f"{meta.get('views', 0):,}", src[:58])
        except urllib.error.HTTPError as e:
            failed += 1
            log.warning("  write failed: %s — %s", src[:48], e.read().decode()[:120])

    log.info("done: %d filled, %d skipped", done, failed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
