#!/bin/bash
# Lynxr end-to-end pipeline. Requires ANTHROPIC_API_KEY and APIFY_API_TOKEN.
# Every step is resumable — re-running skips completed work.
set -e
cd "$(dirname "$0")"
PY=../venv/bin/python

# Load API keys from ~/lynxr/.env if present
if [ -f ../.env ]; then
  set -a; source ../.env; set +a
fi

echo "=== Step 1: Tag Medceptor data ==="
$PY tag_videos.py --input ../data/medceptor_raw.csv --output ../output/medceptor_tagged.csv

echo "=== Step 2: Scrape TikTok ==="
$PY scrape_tiktok.py

echo "=== Step 3: Scrape Instagram ==="
$PY scrape_instagram.py

echo "=== Step 4a: Normalize scraped data ==="
$PY process_scraped.py tiktok
$PY process_scraped.py instagram

echo "=== Step 4b: Tag scraped data ==="
$PY tag_videos.py --input ../data/tiktok_normalized.csv --output ../output/tiktok_tagged.csv
$PY tag_videos.py --input ../data/instagram_normalized.csv --output ../output/instagram_tagged.csv

echo "=== Step 5-6: Merge + summary ==="
$PY merge_data.py

echo "=== Step 7: Export data for web MVP ==="
$PY export_web.py

echo "=== PIPELINE COMPLETE ==="
