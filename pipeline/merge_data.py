#!/usr/bin/env python3
"""Merge tagged Medceptor + TikTok + Instagram data into the master database.

Reads:  output/medceptor_tagged.csv, output/tiktok_tagged.csv, output/instagram_tagged.csv
Writes: output/master_video_database.csv, output/data_summary.txt

Missing input files are skipped with a warning, so this can run on partial data.
"""

import csv
import re
from collections import Counter
from datetime import date
from pathlib import Path

OUT_DIR = Path(__file__).parent.parent / "output"

MASTER_FIELDS = [
    "video_id", "creator", "platform", "title", "views", "likes", "comments",
    "engagement_rate", "format_type", "hook_pattern", "niche_category",
    "target_audience", "data_source", "source_type", "scraped_at", "url",
    # Extended tag dimensions + provenance. These MUST live here: every writer
    # that rewrites the master (merge, append_batch2, retag_with_audio,
    # tag_extra_dims) trims to MASTER_FIELDS, and columns missing from this
    # list are silently dropped on the next rewrite.
    "length_bucket", "audio_trend", "cta_type", "visual_hook",
    "onscreen_text", "hook_delivery", "tag_source",
    # The video's own words + timing + shot list (attach_transcripts.py /
    # analyze_visuals.py) — the recreation blueprint behind tailored scripts.
    "hook_spoken", "transcript", "transcript_segments", "visual_cues",
]

TAG_COLS = ["format_type", "hook_pattern", "niche_category", "target_audience"]
TODAY = date.today().isoformat()


def to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def medceptor_video_id(url):
    # last non-empty path segment of the post URL, e.g. .../reel/DbYyICWCMOA/ -> DbYyICWCMOA
    parts = [p for p in re.split(r"[/?#]", url or "") if p]
    return parts[-1] if parts else ""


def load_medceptor(path):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if (r.get("Platform") or "").lower() == "facebook":
                continue  # Facebook dropped from the database entirely
            views = to_int(r.get("Views"))
            likes = to_int(r.get("Likes"))
            comments = to_int(r.get("Comments"))
            rows.append({
                "video_id": medceptor_video_id(r.get("URL")),
                "creator": r.get("Creator", ""),
                "platform": (r.get("Platform") or "").lower(),
                "title": r.get("Title", ""),
                "views": views,
                "likes": likes,
                "comments": comments,
                "engagement_rate": r.get("Engagement %", ""),
                **{c: r.get(c, "") for c in TAG_COLS},
                "data_source": "Medceptor",
                "source_type": "ugc_program",
                "scraped_at": TODAY,
                "url": r.get("URL", ""),
            })
    return rows


def load_scraped(path, source_name):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows.append({
                "video_id": r.get("video_id", ""),
                "creator": r.get("creator", ""),
                "platform": (r.get("platform") or "").lower(),
                "title": r.get("title", ""),
                "views": to_int(r.get("views")),
                "likes": to_int(r.get("likes")),
                "comments": to_int(r.get("comments")),
                "engagement_rate": r.get("engagement_rate", ""),
                **{c: r.get(c, "") for c in TAG_COLS},
                "data_source": source_name,
                "source_type": "organic_scrape",
                "scraped_at": TODAY,
                "url": r.get("url", ""),
            })
    return rows


def dedupe(rows):
    seen, out, dropped = set(), [], 0
    for r in rows:
        keys = []
        if r["video_id"]:
            keys.append((r["platform"], r["video_id"]))
        if r["url"]:
            keys.append(("url", r["url"]))
        if any(k in seen for k in keys):
            dropped += 1
            continue
        seen.update(keys)
        out.append(r)
    return out, dropped


def summarize(rows, dropped):
    lines = []
    lines.append("LYNXR MASTER VIDEO DATABASE — SUMMARY")
    lines.append(f"Generated: {TODAY}")
    lines.append("=" * 50)
    lines.append(f"Total videos: {len(rows):,}")
    lines.append(f"Duplicates removed: {dropped:,}")
    lines.append("")

    def section(title, counter, top=None):
        lines.append(title)
        items = counter.most_common(top)
        for k, v in items:
            lines.append(f"  {k or '(untagged)'}: {v:,}")
        lines.append("")

    section("Videos by source:", Counter(r["data_source"] for r in rows))
    section("Videos by platform:", Counter(r["platform"] for r in rows))
    section("Videos by niche:", Counter(r["niche_category"] for r in rows))
    section("Videos by format type:", Counter(r["format_type"] for r in rows))
    section("Videos by hook pattern:", Counter(r["hook_pattern"] for r in rows))
    section("Videos by target audience:", Counter(r["target_audience"] for r in rows))

    total_views = sum(r["views"] for r in rows)
    lines.append(f"Total views across all videos: {total_views:,}")

    ers = [e for e in (to_float(r["engagement_rate"]) for r in rows) if e is not None]
    if ers:
        lines.append(f"Average engagement rate: {sum(ers) / len(ers):.2f}% "
                     f"(across {len(ers):,} videos with data)")
    return "\n".join(lines)


def main():
    sources = [
        ("medceptor_tagged.csv", load_medceptor, None),
        ("tiktok_tagged.csv", load_scraped, "Scraped"),
        ("instagram_tagged.csv", load_scraped, "Scraped"),
        ("youtube_tagged.csv", load_scraped, "Scraped"),
    ]
    all_rows = []
    for fname, loader, source_name in sources:
        path = OUT_DIR / fname
        if not path.exists():
            print(f"WARNING: {path} missing, skipping")
            continue
        rows = loader(path) if source_name is None else loader(path, source_name)
        print(f"{fname}: {len(rows):,} rows")
        all_rows.extend(rows)

    rows, dropped = dedupe(all_rows)

    master_path = OUT_DIR / "master_video_database.csv"
    with open(master_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=MASTER_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    summary = summarize(rows, dropped)
    (OUT_DIR / "data_summary.txt").write_text(summary + "\n")
    print(f"\nWrote {master_path} ({len(rows):,} rows)")
    print("\n" + summary)


if __name__ == "__main__":
    main()
