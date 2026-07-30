#!/usr/bin/env python3
"""Scrape Instagram posts by hashtag via Apify (apify/instagram-hashtag-scraper).

Same structure as scrape_tiktok.py: one actor call per hashtag, cached parts in
data/instagram_parts/, combined into data/instagram_raw.json.

Note: the hashtag scraper returns mixed post types; process_scraped.py filters
to videos/reels, so the final video count per hashtag may land below 2,500.

Requires APIFY_API_TOKEN env var.
"""

import json
import logging
import os
import sys
from datetime import timedelta
from pathlib import Path

from apify_client import ApifyClient

HASHTAGS = [
    "apptok", "apptutorial", "studytok", "musicapp", "appmarketing",
    "fitnessapp", "healthapp", "edtech", "fintech", "datingapp",
]
RESULTS_PER_HASHTAG = 10  # scaled down per user: ~100 videos total per platform
ACTOR = "apify/instagram-hashtag-scraper"

DATA_DIR = Path(__file__).parent.parent / "data"
PARTS_DIR = DATA_DIR / "instagram_parts"
OUTPUT = DATA_DIR / "instagram_raw.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(Path(__file__).parent.parent / "output" / "scrape_instagram.log"),
    ],
)
log = logging.getLogger("instagram")


def scrape_hashtag(client, hashtag):
    part_path = PARTS_DIR / f"{hashtag}.json"
    if part_path.exists():
        items = json.loads(part_path.read_text())
        log.info("#%s already scraped (%d items), skipping", hashtag, len(items))
        return items

    log.info("Scraping #%s (target %d posts)...", hashtag, RESULTS_PER_HASHTAG)
    run_input = {
        "hashtags": [hashtag],
        "resultsLimit": RESULTS_PER_HASHTAG,
    }
    try:
        run = client.actor(ACTOR).call(
            run_input=run_input,
            run_timeout=timedelta(hours=2),
            max_items=RESULTS_PER_HASHTAG,
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
    log.info("DONE: %d total Instagram posts -> %s", len(all_items), OUTPUT)


if __name__ == "__main__":
    main()
