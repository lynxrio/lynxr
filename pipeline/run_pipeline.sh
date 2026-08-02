#!/bin/bash
# Lynxr end-to-end pipeline. Requires ANTHROPIC_API_KEY and APIFY_API_TOKEN.
# Every step is resumable — re-running skips completed work.
set -e
cd "$(dirname "$0")"
PY=../venv/bin/python

# Load API keys from the repo-root .env if present
if [ -f ../.env ]; then
  set -a; source ../.env; set +a
fi

echo "=== Step 1: Tag Medceptor data ==="
$PY tag_videos.py --input ../data/medceptor_raw.csv --output ../output/medceptor_tagged.csv

echo "=== Step 2: Scrape TikTok ==="
$PY scrape_tiktok.py

echo "=== Step 3: Scrape Instagram (Reels) + YouTube (Shorts) ==="
$PY scrape_instagram.py
$PY scrape_youtube.py

echo "=== Step 4a: Normalize scraped data ==="
$PY process_scraped.py tiktok
$PY process_scraped.py instagram
$PY process_scraped.py youtube

echo "=== Step 4b: Tag scraped data ==="
$PY tag_videos.py --input ../data/tiktok_normalized.csv --output ../output/tiktok_tagged.csv
$PY tag_videos.py --input ../data/instagram_normalized.csv --output ../output/instagram_tagged.csv
$PY tag_videos.py --input ../data/youtube_normalized.csv --output ../output/youtube_tagged.csv

echo "=== Step 5-6: Merge + summary ==="
$PY merge_data.py

echo "=== Step 7: Upsert into Supabase (lynxr_videos) ==="
$PY export_supabase.py   # needs SUPABASE_SERVICE_ROLE_KEY in .env

echo "=== PIPELINE COMPLETE ==="
echo "  Master database: output/master_video_database.csv"
echo "  Summary:         output/data_summary.txt"
echo "  Dashboard data:  Supabase table lynxr_videos (RLS: signed-in read only)"

# Content policy: English-only organic UGC — drops non-English, influencer
# (>200K/verified), and AI-generated rows, then removes them from Supabase.
$PY filter_database.py
