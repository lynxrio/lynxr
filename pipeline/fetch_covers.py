#!/usr/bin/env python3
"""Collect each video's opening frame so the visual hook can be tagged.

WHY
---
The taxonomy's Visual Hook column — Face Close-up, Text-first, Product
On-screen, Pattern Interrupt — describes what is on screen in frame one. No
caption and no transcript contains that. Plenty of short-form videos also carry
their entire hook as on-screen text over silent b-roll, which is invisible to
both of the passes we already run.

WHERE THE FRAME COMES FROM
--------------------------
The scrapes already carry videoMeta.coverUrl for every TikTok, so no video
download is needed — the frames are one cheap HTTP fetch each. Instagram and
YouTube rows fall back to their own thumbnail conventions where available.

Covers are cached to data/covers/<video_id>.jpg and skipped if present, so this
is resumable and safe to re-run.

Usage:
    python fetch_covers.py --limit 50
    python fetch_covers.py
"""

import argparse
import csv
import glob
import json
import logging
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).parent.parent
MASTER = ROOT / "output" / "master_video_database.csv"
COVERS = ROOT / "data" / "covers"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("covers")


def cover_index():
    """video_id -> cover URL, taken from the raw scrape payloads."""
    idx = {}
    for f in glob.glob(str(ROOT / "data" / "*_parts*" / "*.json")):
        try:
            items = json.loads(Path(f).read_text())
        except Exception:
            continue
        for it in items:
            vid = str(it.get("id") or it.get("shortCode") or "")
            vm = it.get("videoMeta") or {}
            url = vm.get("coverUrl") or vm.get("originalCoverUrl") or it.get("displayUrl")
            if vid and url:
                idx[vid] = url
    return idx


def youtube_thumb(url):
    import re
    m = re.search(r"(?:shorts/|watch\?v=|youtu\.be/)([A-Za-z0-9_-]{6,})", url or "")
    return f"https://i.ytimg.com/vi/{m.group(1)}/hqdefault.jpg" if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    COVERS.mkdir(parents=True, exist_ok=True)
    idx = cover_index()
    rows = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))

    todo = []
    for r in rows:
        vid = r["video_id"]
        if (COVERS / f"{vid}.jpg").exists():
            continue
        url = idx.get(vid) or (youtube_thumb(r.get("url")) if r["platform"] == "youtube" else None)
        if url:
            todo.append((vid, url, int(float(r.get("views") or 0))))
    todo.sort(key=lambda t: -t[2])          # highest-view first, as elsewhere
    if args.limit:
        todo = todo[: args.limit]

    have = len(list(COVERS.glob("*.jpg")))
    log.info("%d covers cached; %d to fetch", have, len(todo))
    ok = failed = 0
    with httpx.Client(timeout=20, follow_redirects=True) as client:
        for i, (vid, url, _) in enumerate(todo, 1):
            try:
                resp = client.get(url)
                if resp.status_code != 200 or not resp.content:
                    raise RuntimeError(f"HTTP {resp.status_code}")
                (COVERS / f"{vid}.jpg").write_bytes(resp.content)
                ok += 1
            except Exception as e:
                failed += 1
                log.warning("[%d/%d] %s failed: %s", i, len(todo), vid, type(e).__name__)
            if i % 100 == 0:
                log.info("--- %d ok, %d failed ---", ok, failed)
    log.info("DONE: %d fetched, %d failed. %d covers cached in %s",
             ok, failed, len(list(COVERS.glob("*.jpg"))), COVERS)


if __name__ == "__main__":
    main()

