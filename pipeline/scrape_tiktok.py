#!/usr/bin/env python3
"""Scrape TikTok videos by hashtag via Apify (clockworks/tiktok-scraper).

Runs one actor call per hashtag so a single failure doesn't lose the whole run;
per-hashtag results are cached in data/tiktok_parts/ and combined into
data/tiktok_raw.json. Re-running skips hashtags already scraped.

Requires APIFY_API_TOKEN env var.
"""

import json
import logging
import os
import sys
from datetime import timedelta
from pathlib import Path

from apify_client import ApifyClient

# UGC-focused discovery: these surface authentic creator content (the format
# style Lynx's clients actually make), not brand/news posts. Blend of explicit
# UGC tags, product-review UGC, and a couple of app-niche tags for relevance.
# Edit freely — this list is just the seed for what enters the database.
HASHTAGS = [
    "ugc", "ugccreator", "ugcexample", "ugccommunity",
    "tiktokmademebuyit", "productreview", "honestreview", "founditontiktok",
    "appreview", "studytok",
]
VIDEOS_PER_HASHTAG = 10  # scaled down per user: ~100 videos total per platform
ACTOR = "clockworks/tiktok-scraper"

DATA_DIR = Path(__file__).parent.parent / "data"
PARTS_DIR = DATA_DIR / "tiktok_parts"
OUTPUT = DATA_DIR / "tiktok_raw.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(Path(__file__).parent.parent / "output" / "scrape_tiktok.log"),
    ],
)
log = logging.getLogger("tiktok")


def scrape_hashtag(client, hashtag):
    part_path = PARTS_DIR / f"{hashtag}.json"
    if part_path.exists():
        items = json.loads(part_path.read_text())
        log.info("#%s already scraped (%d items), skipping", hashtag, len(items))
        return items

    log.info("Scraping #%s (target %d videos)...", hashtag, VIDEOS_PER_HASHTAG)
    run_input = {
        "hashtags": [hashtag],
        "resultsPerPage": VIDEOS_PER_HASHTAG,
        "shouldDownloadVideos": False,
        "shouldDownloadCovers": False,
        "shouldDownloadSubtitles": False,
        "shouldDownloadSlideshowImages": False,
    }
    try:
        run = client.actor(ACTOR).call(
            run_input=run_input,
            run_timeout=timedelta(hours=2),
            max_items=VIDEOS_PER_HASHTAG,
        )
        if run is None or not run.default_dataset_id:
            raise RuntimeError(f"actor run returned no dataset (status: {run and run.status})")
        items = list(client.dataset(run.default_dataset_id).iterate_items())
    except Exception as e:
        log.error("#%s failed: %s", hashtag, e)
        return []

    for item in items:
        item["_source_hashtag"] = hashtag
    part_path.write_text(json.dumps(items))
    log.info("#%s: got %d items", hashtag, len(items))
    return items


def main():
    token = os.environ.get("APIFY_API_TOKEN")
    if not token:
        raise SystemExit("Set APIFY_API_TOKEN first.")
    PARTS_DIR.mkdir(parents=True, exist_ok=True)

    client = ApifyClient(token)
    all_items = []
    for hashtag in HASHTAGS:
        all_items.extend(scrape_hashtag(client, hashtag))

    OUTPUT.write_text(json.dumps(all_items))
    log.info("DONE: %d total TikTok videos -> %s", len(all_items), OUTPUT)


if __name__ == "__main__":
    main()

