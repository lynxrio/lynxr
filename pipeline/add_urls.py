#!/usr/bin/env python3
"""Add specific videos to the database by URL — the hand-picked path.

Owner drops exact TikTok/Instagram links (reference videos, competitor posts,
exemplars for a client vertical); this fetches their real metadata through the
same Apify actors as the bulk scrapers, normalizes into the master schema, and
appends with dedupe. Raw items are cached in data/manual_parts/ so
enrich_signals.py picks up followers/saves for them like any scraped row.

Usage:
    ./venv/bin/python pipeline/add_urls.py --niche "Fashion & Beauty" URL [URL ...]
    ./venv/bin/python pipeline/add_urls.py --file urls.txt

Tags: --niche sets niche_category directly (owner-curated ground truth).
Format/hook/audience stay blank until the retag pass fills them from the
transcript + cover; transcribe.py picks the rows up on its next run.
"""

import argparse
import csv
import json
import logging
import os
import re
import sys
import time
from datetime import timedelta
from pathlib import Path

from apify_client import ApifyClient

sys.path.insert(0, str(Path(__file__).parent))
from process_scraped import normalize_tiktok, normalize_instagram
from merge_data import MASTER_FIELDS
import envcfg  # the one place a secret or config value is read; see its docstring.

ROOT = Path(__file__).parent.parent
MASTER = ROOT / "output" / "master_video_database.csv"
PARTS_DIR = ROOT / "data" / "manual_parts"

TIKTOK_ACTOR = "clockworks/tiktok-scraper"
IG_ACTOR = "apify/instagram-scraper"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout),
                              logging.FileHandler(ROOT / "output" / "add_urls.log")])
log = logging.getLogger("add-urls")


def split_urls(urls):
    tt, ig, yt, bad = [], [], [], []
    for u in urls:
        u = u.strip().rstrip("/")
        if not u:
            continue
        if "tiktok.com" in u and "/video/" in u:
            tt.append(u)
        elif "instagram.com" in u and re.search(r"/(reels?|p)/[A-Za-z0-9_-]+", u):
            # the scraper wants /reel/<code> (singular), not /reels/
            code = re.search(r"/(?:reels?|p)/([A-Za-z0-9_-]+)", u).group(1)
            ig.append(f"https://www.instagram.com/reel/{code}/")
        elif "youtube.com" in u and "/shorts/" in u:
            yt.append(u)
        else:
            bad.append(u)
    return tt, ig, yt, bad


def fetch_youtube(urls):
    """Per-URL metadata via yt-dlp — free, no actor needed for known links."""
    import subprocess
    rows = []
    for u in urls:
        try:
            out = subprocess.run(
                [str(ROOT / "venv" / "bin" / "yt-dlp"), "--dump-json", "--no-download",
                 "--no-warnings", u],
                capture_output=True, text=True, timeout=60)
            d = json.loads(out.stdout)
        except Exception as e:
            log.error("youtube failed %s: %s", u, str(e)[:120])
            continue
        views = d.get("view_count") or 0
        likes = d.get("like_count") or 0
        comments = d.get("comment_count") or 0
        er = round(100 * (likes + comments) / views, 2) if views else ""
        rows.append({
            "video_id": d.get("id", ""),
            "creator": d.get("uploader_id", d.get("channel", "")).lstrip("@"),
            "platform": "youtube",
            "title": d.get("title", ""),
            "views": views, "likes": likes, "comments": comments, "shares": "",
            "engagement_rate": er,
            "url": u,
            "uploaded_at": d.get("upload_date", ""),
            "source_hashtag": "",
        })
        log.info("youtube ok: %s (%s views)", d.get("id"), views)
    return rows


def fetch_tiktok(client, urls):
    if not urls:
        return []
    log.info("TikTok: fetching %d urls...", len(urls))
    run = client.actor(TIKTOK_ACTOR).call(
        run_input={"postURLs": urls, "shouldDownloadVideos": False,
                   "shouldDownloadCovers": False, "shouldDownloadSubtitles": False,
                   "shouldDownloadSlideshowImages": False},
        run_timeout=timedelta(minutes=10), max_items=len(urls), logger=None)
    if run is None or not run.default_dataset_id:
        raise RuntimeError(f"tiktok run failed (status: {run and run.status})")
    return list(client.dataset(run.default_dataset_id).iterate_items())


def fetch_instagram(client, urls):
    if not urls:
        return []
    log.info("Instagram: fetching %d urls...", len(urls))
    run = client.actor(IG_ACTOR).call(
        run_input={"directUrls": urls, "resultsType": "posts",
                   "resultsLimit": len(urls), "addParentData": False},
        run_timeout=timedelta(minutes=10), max_items=len(urls) * 2, logger=None)
    if run is None or not run.default_dataset_id:
        raise RuntimeError(f"instagram run failed (status: {run and run.status})")
    return list(client.dataset(run.default_dataset_id).iterate_items())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="*")
    ap.add_argument("--file", help="text file with one URL per line")
    ap.add_argument("--niche", default="",
                    help="set niche_category directly (owner-curated ground truth)")
    ap.add_argument("--source", default="",
                    help='data_source override, e.g. "Cloey" for campaign posts — '
                         "keeps them in their own benchmark group, never compared "
                         "against viral scrapes")
    args = ap.parse_args()

    urls = list(args.urls)
    if args.file:
        urls += Path(args.file).read_text().splitlines()
    tt, ig, yt, bad = split_urls(urls)
    for u in bad:
        log.warning("unrecognized url skipped: %s", u)
    if not tt and not ig and not yt:
        raise SystemExit("No usable TikTok/Instagram/YouTube URLs.")

    token = envcfg.secret("APIFY_API_TOKEN", os.environ.get("APIFY_API_TOKEN"))
    if not token:
        raise SystemExit("Set APIFY_API_TOKEN first.")
    client = ApifyClient(token)
    PARTS_DIR.mkdir(parents=True, exist_ok=True)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    raw_tt = fetch_tiktok(client, tt)
    raw_ig = fetch_instagram(client, ig)
    if raw_tt:
        (PARTS_DIR / f"tiktok-{stamp}.json").write_text(json.dumps(raw_tt))
    if raw_ig:
        (PARTS_DIR / f"instagram-{stamp}.json").write_text(json.dumps(raw_ig))

    rows = []
    for it in raw_tt:
        r = normalize_tiktok(it)
        if r:
            rows.append(r)
    for it in raw_ig:
        r = normalize_instagram(it)
        if r:
            rows.append(r)
    rows += fetch_youtube(yt)
    log.info("normalized %d of %d requested", len(rows), len(tt) + len(ig) + len(yt))

    master = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))
    seen = {(m["platform"], m["video_id"]) for m in master} | \
           {("url", m["url"]) for m in master if m["url"]}
    added = 0
    for r in rows:
        keys = [(r["platform"], r["video_id"])] + ([("url", r["url"])] if r["url"] else [])
        if any(k in seen for k in keys):
            log.info("already in database: %s", r["url"])
            continue
        seen.update(keys)
        row = {c: "" for c in MASTER_FIELDS}
        row.update({k: r.get(k, "") for k in r})
        row["data_source"] = args.source or "Scraped"
        row["source_type"] = "ugc_program" if args.source else "hand_picked"
        row["tag_source"] = "caption"
        if args.niche:
            row["niche_category"] = args.niche
        master.append(row)
        added += 1

    with open(MASTER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=MASTER_FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(master)
    log.info("DONE: +%d rows -> %d total. Next: transcribe.py, then the "
             "credit-gated passes fill tags/shots.", added, len(master))


if __name__ == "__main__":
    main()

