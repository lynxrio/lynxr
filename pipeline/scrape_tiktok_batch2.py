#!/usr/bin/env python3
"""Batch 2: ~10K more TikTok videos across 17 niche-aligned hashtags.

A probe measured the actor's real yield at ~584 videos per hashtag (the
hashtag-page depth limit), so 17 hashtags ≈ 10K. Same per-hashtag caching as
scrape_tiktok.py, in data/tiktok_parts2/ -> data/tiktok_raw2.json.
"""

import json
import logging
import os
import sys
from datetime import timedelta
from pathlib import Path

from apify_client import ApifyClient
import envcfg  # the one place a secret or config value is read; see its docstring.

# studytok already cached from the probe run; the rest deepen the same niches
# the database already covers (health, study, fitness, finance, apps, music).
HASHTAGS = [
    "studytok",           # cached
    "nursingschool", "medschool", "studytips", "studyhacks", "learnontiktok",
    "productivityapps", "aiapps", "techtok", "moneytok", "investing",
    "gymtok", "workoutmotivation", "languagelearning", "datingadvice",
    "marketingtips", "musicproduction",
]
VIDEOS_PER_HASHTAG = 600
ACTOR = "clockworks/tiktok-scraper"

ROOT = Path(__file__).parent.parent
PARTS_DIR = ROOT / "data" / "tiktok_parts2"
OUTPUT = ROOT / "data" / "tiktok_raw2.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(ROOT / "output" / "scrape_tiktok2.log"),
    ],
)
log = logging.getLogger("tiktok2")


def scrape_hashtag(client, hashtag):
    part_path = PARTS_DIR / f"{hashtag}.json"
    if part_path.exists():
        items = json.loads(part_path.read_text())
        log.info("#%s already scraped (%d items), skipping", hashtag, len(items))
        return items

    log.info("Scraping #%s (target %d videos)...", hashtag, VIDEOS_PER_HASHTAG)
    run_input = {
        "hashtags": [hashtag],
        "resultsPerPage": 1000,
        "shouldDownloadVideos": False,
        "shouldDownloadCovers": False,
        "shouldDownloadSubtitles": False,
        "shouldDownloadSlideshowImages": False,
    }
    try:
        run = client.actor(ACTOR).call(
            run_input=run_input,
            run_timeout=timedelta(minutes=25),
            max_items=VIDEOS_PER_HASHTAG,
            logger=None,
        )
        if run is None or not run.default_dataset_id:
            raise RuntimeError(f"no dataset (status: {run and run.status})")
        items = list(client.dataset(run.default_dataset_id).iterate_items())
        usd = run.model_dump().get("usage_total_usd")
    except Exception as e:
        log.error("#%s failed: %s", hashtag, e)
        return []

    for item in items:
        item["_source_hashtag"] = hashtag
    part_path.write_text(json.dumps(items))
    log.info("#%s: got %d items ($%.2f)", hashtag, len(items), usd or 0)
    return items


def main():
    token = envcfg.secret("APIFY_API_TOKEN", os.environ.get("APIFY_API_TOKEN"))
    if not token:
        raise SystemExit("Set APIFY_API_TOKEN first.")
    PARTS_DIR.mkdir(parents=True, exist_ok=True)

    client = ApifyClient(token)
    all_items = []
    for hashtag in HASHTAGS:
        all_items.extend(scrape_hashtag(client, hashtag))
        log.info("running total: %d videos", len(all_items))

    OUTPUT.write_text(json.dumps(all_items))
    log.info("DONE: %d total batch-2 TikTok videos -> %s", len(all_items), OUTPUT)


if __name__ == "__main__":
    main()

