#!/usr/bin/env python3
"""Publish the cached cover frames so the apps can actually show them.

WHY
---
fetch_covers.py already caches an opening frame per video in data/covers/ —
8,260 of them matching the live database — but that folder is gitignored and
1.7 GB, so no browser has ever been able to reach it. The agency app therefore
fell back to per-platform tricks: YouTube covers derive from the URL and TikTok
covers come from a per-card oEmbed round-trip, while **Instagram had nothing at
all** and rendered a placeholder. Publishing the frames we already have fixes
Instagram and removes the third-party hop for the other two.

THE KEY
-------
Deliberately the SAME scheme process_adaptations.py already uses for creator
covers, so the two pipelines share one bucket and never collide:

    lynxr-covers/<sha1(canon_url(url))[:20]>.jpg     (public bucket)

canon_url is byte-identical to canonUrl() in app.js/creator.js, so the browser
can derive the key from a row's URL without storing anything extra.

SIZE
----
Sources are ~1080x1920 at ~111 KB. Cards render ~366 px wide, so they are
resampled to 360 px and re-encoded: ~22 KB each, 181 MB for the full set
against Supabase's 1 GB. Uploading the originals would have been 1.3 GB.

Resumable: an object that already exists is skipped (the bucket already holds
creator covers written by process_adaptations.py — those are left alone).

Usage:
    python upload_covers.py --dry-run
    python upload_covers.py --limit 50
    python upload_covers.py
"""

import argparse
import csv
import hashlib
import io
import logging
import os
import ssl
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

import envcfg  # the one place a secret or config value is read; see its docstring.

ROOT = Path(__file__).resolve().parent.parent
COVERS = ROOT / "data" / "covers"
MASTER = ROOT / "output" / "master_video_database.csv"
BUCKET = "lynxr-covers"
SB_URL = "https://esakjfogplfszievvabi.supabase.co"
MAX_W = 360
QUALITY = 72
# This venv's Python has no system CA bundle — a bare default context fails
# every request with CERTIFICATE_VERIFY_FAILED. Same guard the rest of the
# pipeline uses (process_adaptations.py, cohort.py).
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("upload-covers")


def canon_url(u):
    """Byte-identical to canonUrl() in app.js — the key must match in both."""
    from urllib.parse import urlparse, parse_qs
    try:
        p = urlparse(u if "://" in u else "https://" + u)
        host = p.hostname.lower().removeprefix("www.").removeprefix("m.")
        path = p.path.rstrip("/")
        key = ""
        if host == "youtu.be":
            key, host, path = "?v=" + path.lstrip("/"), "youtube.com", "/watch"
        elif host == "youtube.com" and parse_qs(p.query).get("v"):
            key = "?v=" + parse_qs(p.query)["v"][0]
        return host + path + key
    except Exception:  # noqa: BLE001
        return (u or "").rstrip("/")


def cover_name(url):
    return hashlib.sha1(canon_url(url).encode()).hexdigest()[:20]


def shrink(path):
    """360 px wide progressive JPEG. Returns bytes, or None if unreadable."""
    try:
        im = Image.open(path)
        im = im.convert("RGB")
        im.thumbnail((MAX_W, MAX_W * 4), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=QUALITY, optimize=True, progressive=True)
        return buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        log.warning("unreadable %s: %s", path.name, exc)
        return None


def put(key, name, blob):
    """Upload one cover. Returns 'ok', 'exists', or 'fail'."""
    req = urllib.request.Request(
        f"{SB_URL}/storage/v1/object/{BUCKET}/{name}.jpg", data=blob, method="POST")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "image/jpeg")
    req.add_header("Cache-Control", "public, max-age=31536000, immutable")
    try:
        with urllib.request.urlopen(req, timeout=60, context=SSL_CTX):
            return "ok"
    except urllib.error.HTTPError as e:
        # 409 = already there. That is the resume path, not an error.
        return "exists" if e.code == 409 else "fail"
    except Exception:  # noqa: BLE001
        return "fail"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="stop after N uploads")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    if not key and not args.dry_run:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (source the .env first)")

    rows = list(csv.DictReader(open(MASTER, encoding="utf-8")))
    todo = []
    missing = 0
    for r in rows:
        src = COVERS / f"{r['video_id']}.jpg"
        if not src.exists():
            missing += 1
            continue
        if not r.get("url"):
            continue
        todo.append((src, cover_name(r["url"]), r["platform"]))

    # One video can appear under two rows; upload each key once.
    seen, unique = set(), []
    for item in todo:
        if item[1] in seen:
            continue
        seen.add(item[1])
        unique.append(item)

    from collections import Counter
    log.info("%d rows, %d with a cached cover, %d unique keys (%d rows have no cover)",
             len(rows), len(todo), len(unique), missing)
    log.info("by platform: %s", dict(Counter(p for _, _, p in unique)))
    if args.limit:
        unique = unique[:args.limit]
    if args.dry_run:
        for src, name, plat in unique[:5]:
            blob = shrink(src)
            log.info("would PUT %s.jpg  (%s, %s -> %s KB)", name, plat,
                     f"{src.stat().st_size // 1024}", len(blob) // 1024 if blob else "?")
        return

    tally = Counter()
    lock = threading.Lock()

    def work(item):
        src, name, _ = item
        blob = shrink(src)
        if blob is None:
            res = "fail"
        else:
            res = put(key, name, blob)
        with lock:
            tally[res] += 1
            done = sum(tally.values())
            if done % 250 == 0:
                log.info("%d/%d  %s", done, len(unique), dict(tally))

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(work, unique))

    log.info("DONE %s", dict(tally))


if __name__ == "__main__":
    main()
