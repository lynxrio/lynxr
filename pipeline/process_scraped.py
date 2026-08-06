#!/usr/bin/env python3
"""Normalize raw Apify JSON (TikTok / Instagram) into flat CSVs ready for tagging.

Usage:
    python process_scraped.py tiktok      # data/tiktok_raw.json  -> data/tiktok_normalized.csv
    python process_scraped.py instagram   # data/instagram_raw.json -> data/instagram_normalized.csv

Output columns: video_id, creator, platform, title, views, likes, comments,
shares, engagement_rate, url, uploaded_at, source_hashtag
"""

import csv
import json
import sys
from datetime import date
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"

FIELDS = [
    "video_id", "creator", "platform", "title", "views", "likes", "comments",
    "shares", "engagement_rate", "url", "uploaded_at", "source_hashtag",
]


def to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def engagement(views, likes, comments, shares):
    if views <= 0:
        return ""
    return round((likes + comments + shares) / views * 100, 2)


def normalize_tiktok(item):
    author = item.get("authorMeta") or {}
    views = to_int(item.get("playCount"))
    likes = to_int(item.get("diggCount"))
    comments = to_int(item.get("commentCount"))
    shares = to_int(item.get("shareCount"))
    return {
        "video_id": str(item.get("id") or ""),
        "creator": author.get("name") or author.get("nickName") or "",
        "platform": "tiktok",
        "title": (item.get("text") or "").replace("\n", " ").strip(),
        "views": views,
        "likes": likes,
        "comments": comments,
        "shares": shares,
        "engagement_rate": engagement(views, likes, comments, shares),
        "url": item.get("webVideoUrl") or "",
        "uploaded_at": item.get("createTimeISO") or "",
        "source_hashtag": item.get("_source_hashtag") or "",
    }


def is_instagram_video(item):
    t = (item.get("type") or "").lower()
    pt = (item.get("productType") or "").lower()
    return (t == "video" or pt in ("clips", "igtv")
            or item.get("videoViewCount") is not None
            or item.get("videoPlayCount") is not None)


def normalize_instagram(item):
    views = to_int(item.get("videoPlayCount") or item.get("videoViewCount"))
    # Instagram returns likesCount == -1 when the creator hides like counts;
    # treat that (and any negative) as 0 so engagement_rate stays sane.
    likes = max(0, to_int(item.get("likesCount")))
    comments = max(0, to_int(item.get("commentsCount")))
    return {
        "video_id": str(item.get("id") or item.get("shortCode") or ""),
        "creator": item.get("ownerUsername") or "",
        "platform": "instagram",
        "title": (item.get("caption") or "").replace("\n", " ").strip(),
        "views": views,
        "likes": likes,
        "comments": comments,
        "shares": 0,
        "engagement_rate": engagement(views, likes, comments, 0),
        "url": item.get("url") or "",
        "uploaded_at": item.get("timestamp") or "",
        "source_hashtag": item.get("_source_hashtag") or "",
    }


def normalize_youtube(item):
    # From streamers/youtube-shorts-scraper. Shorts are always video, so no
    # video filter is needed. YouTube exposes no share count -> 0.
    views = to_int(item.get("viewCount"))
    likes = max(0, to_int(item.get("likes")))
    comments = max(0, to_int(item.get("commentsCount")))
    return {
        "video_id": str(item.get("id") or ""),
        "creator": item.get("channelUsername") or item.get("channelName") or "",
        "platform": "youtube",
        "title": (item.get("title") or "").replace("\n", " ").strip(),
        "views": views,
        "likes": likes,
        "comments": comments,
        "shares": 0,
        "engagement_rate": engagement(views, likes, comments, 0),
        "url": item.get("url") or "",
        "uploaded_at": item.get("date") or "",
        "source_hashtag": item.get("_source_hashtag") or "",
    }


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("tiktok", "instagram", "youtube"):
        raise SystemExit("Usage: process_scraped.py {tiktok|instagram|youtube}")
    platform = sys.argv[1]
    normalizers = {"tiktok": normalize_tiktok, "instagram": normalize_instagram,
                   "youtube": normalize_youtube}

    raw_path = DATA_DIR / f"{platform}_raw.json"
    out_path = DATA_DIR / f"{platform}_normalized.csv"
    items = json.loads(raw_path.read_text())

    rows, seen = [], set()
    skipped_non_video = 0
    for item in items:
        if platform == "instagram" and not is_instagram_video(item):
            skipped_non_video += 1
            continue
        row = normalizers[platform](item)
        key = row["video_id"] or row["url"]
        if not key or key in seen:
            continue
        seen.add(key)
        rows.append(row)

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    print(f"{platform}: {len(items)} raw items -> {len(rows)} unique videos "
          f"({skipped_non_video} non-video posts skipped) -> {out_path}")


if __name__ == "__main__":
    main()

