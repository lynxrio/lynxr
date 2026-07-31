#!/usr/bin/env python3
"""Scrape YouTube Shorts by channel via Apify (streamers/youtube-shorts-scraper).

Completes cross-platform coverage (TikTok + Instagram + YouTube) in the video
database. Same structure and output as scrape_instagram.py: one actor call per
channel, cached parts in data/youtube_parts/, combined into data/youtube_raw.json,
then `process_scraped.py youtube` normalizes to the shared 12-column CSV and the
rows tag identically to the other platforms.

Channel-based, like the Instagram reel scraper (YouTube has no reliable hashtag
surface). Put the channels you want in CHANNELS — bare usernames/handles or full
channel URLs. Your creators' YouTube channels are the obvious seed.

Output fields map cleanly onto normalize_youtube(): id, title, url, viewCount,
likes, commentsCount, channelName/channelUsername, date.

Requires APIFY_API_TOKEN (the same token as every other Apify actor).
"""

import json
import logging
import os
import sys
from datetime import timedelta
from pathlib import Path

from apify_client import ApifyClient

# YouTube channels to pull Shorts from — bare usernames/handles (no leading @)
# or full channel URLs. Replace with the channels you actually want tracked.
CHANNELS = [
    "ezerafits",
    "jiwonsootds",
    "styledbylexy",
]

RESULTS_PER_CHANNEL = 25
ACTOR = "streamers/youtube-shorts-scraper"

DATA_DIR = Path(__file__).parent.parent / "data"
PARTS_DIR = DATA_DIR / "youtube_parts"
OUTPUT = DATA_DIR / "youtube_raw.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(Path(__file__).parent.parent / "output" / "scrape_youtube.log"),
    ],
)
log = logging.getLogger("youtube")


def _safe(name):
    """Filesystem-safe cache filename from a channel name or URL."""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:80]


def scrape_channel(client, channel):
    part_path = PARTS_DIR / f"{_safe(channel)}.json"
    if part_path.exists():
        items = json.loads(part_path.read_text())
        log.info("%s already scraped (%d shorts), skipping", channel, len(items))
        return items

    log.info("Scraping %s (target %d shorts)...", channel, RESULTS_PER_CHANNEL)
    run_input = {
        "channels": [channel],
        "maxResultsShorts": RESULTS_PER_CHANNEL,
        "sortChannelShortsBy": "NEWEST",
    }
    try:
        run = client.actor(ACTOR).call(
            run_input=run_input,
            run_timeout=timedelta(hours=1),
            max_items=RESULTS_PER_CHANNEL,
        )
        if run is None or not run.default_dataset_id:
            raise RuntimeError(f"actor run returned no dataset (status: {run and run.status})")
        items = list(client.dataset(run.default_dataset_id).iterate_items())
    except Exception as e:
        log.error("%s failed: %s", channel, e)
        return []

    for item in items:
        item["_source_hashtag"] = channel
    part_path.write_text(json.dumps(items))
    log.info("%s: got %d shorts", channel, len(items))
    return items


def main():
    token = os.environ.get("APIFY_API_TOKEN")
    if not token:
        raise SystemExit("Set APIFY_API_TOKEN first.")
    if not CHANNELS:
        raise SystemExit("CHANNELS is empty — add YouTube channels to scrape.")
    PARTS_DIR.mkdir(parents=True, exist_ok=True)

    client = ApifyClient(token)
    all_items = []
    for channel in CHANNELS:
        all_items.extend(scrape_channel(client, channel))

    OUTPUT.write_text(json.dumps(all_items))
    log.info("DONE: %d total YouTube shorts -> %s", len(all_items), OUTPUT)


if __name__ == "__main__":
    main()
