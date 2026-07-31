#!/usr/bin/env python3
"""Scrape Instagram Reels via Apify (apify/instagram-reel-scraper).

Verified working 2026-07-31 against a live natgeo pull: returns Reels only, with
the exact fields normalize_instagram() reads (caption, likesCount, commentsCount,
videoViewCount/videoPlayCount, ownerUsername, url, id/shortCode, timestamp), so
Instagram Reels flow into the shared 12-column CSV and get tagged identically to
TikTok — same taxonomy, same accuracy.

WHY THIS ACTOR (over the flagship / the old hashtag scraper):
- Reels-only — no photo/carousel noise to filter, and it actually returns videos
  (the old apify/instagram-hashtag-scraper returned 0 videos for these tags).
- Reliable — it takes CREATOR HANDLES / profile URLs, which is Instagram's
  dependable surface. Hashtag pages are heavily restricted and unreliable, so
  Instagram is creator-driven here rather than hashtag-driven like TikTok.
- Bonus paid add-ons available: audio transcript (INCLUDE_TRANSCRIPT) and share
  counts (INCLUDE_SHARES). Off by default to control cost; the local Whisper
  pass already covers transcripts, and Instagram exposes no shares for free.

HOW TO USE: put the Instagram accounts you want to study in HANDLES (bare
usernames, no @). Your own creators are the obvious seed — e.g. the accounts you
track in Sideshift. Then run the normal pipeline (scrape -> process -> tag ->
merge -> export). Public accounts only.

Requires APIFY_API_TOKEN (the same token as every other Apify actor).
"""

import json
import logging
import os
import sys
from datetime import timedelta
from pathlib import Path

from apify_client import ApifyClient

# Instagram accounts to pull Reels from — bare usernames, no "@". Replace these
# with the creators you actually want in the database (e.g. your Sideshift
# roster). Empty = nothing to scrape.
HANDLES = [
    # Cloey campaign creators (from Sideshift) — replace/extend with your roster.
    "ezerafits",
    "jiwonsootds",
    "styledbylexy",
]

RESULTS_PER_HANDLE = 25       # reels per profile
INCLUDE_TRANSCRIPT = False    # paid add-on; local Whisper already transcribes
INCLUDE_SHARES = False        # paid add-on; Instagram has no free share count
ACTOR = "apify/instagram-reel-scraper"

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


def scrape_handle(client, handle):
    part_path = PARTS_DIR / f"{handle}.json"
    if part_path.exists():
        items = json.loads(part_path.read_text())
        log.info("@%s already scraped (%d reels), skipping", handle, len(items))
        return items

    log.info("Scraping @%s (target %d reels)...", handle, RESULTS_PER_HANDLE)
    run_input = {
        "username": [handle],
        "resultsLimit": RESULTS_PER_HANDLE,
        "skipPinnedPosts": True,
        "includeTranscript": INCLUDE_TRANSCRIPT,
        "includeSharesCount": INCLUDE_SHARES,
        "includeDownloadedVideo": False,
    }
    try:
        run = client.actor(ACTOR).call(
            run_input=run_input,
            run_timeout=timedelta(hours=1),
            max_items=RESULTS_PER_HANDLE,
        )
        if run is None or not run.default_dataset_id:
            raise RuntimeError(f"actor run returned no dataset (status: {run and run.status})")
        items = list(client.dataset(run.default_dataset_id).iterate_items())
    except Exception as e:
        log.error("@%s failed: %s", handle, e)
        return []

    # Record which creator each reel came from (reuses the source_hashtag column).
    for item in items:
        item["_source_hashtag"] = f"@{handle}"
    part_path.write_text(json.dumps(items))
    log.info("@%s: got %d reels", handle, len(items))
    return items


def main():
    token = os.environ.get("APIFY_API_TOKEN")
    if not token:
        raise SystemExit("Set APIFY_API_TOKEN first.")
    if not HANDLES:
        raise SystemExit("HANDLES is empty — add Instagram usernames to scrape "
                         "(this actor is creator-based, not hashtag-based).")
    PARTS_DIR.mkdir(parents=True, exist_ok=True)

    client = ApifyClient(token)
    all_items = []
    for handle in HANDLES:
        all_items.extend(scrape_handle(client, handle))

    OUTPUT.write_text(json.dumps(all_items))
    log.info("DONE: %d total Instagram reels -> %s", len(all_items), OUTPUT)


if __name__ == "__main__":
    main()
