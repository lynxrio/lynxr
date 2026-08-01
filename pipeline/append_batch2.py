#!/usr/bin/env python3
"""Fold batch-2 scrape into the master database.

Steps: normalize data/tiktok_raw2.json -> tag via tag_videos.py (run separately,
Batches API) -> this script appends output/tiktok2_tagged.csv to
output/master_video_database.csv with dedupe, regenerates data_summary.txt.

Usage:
    python append_batch2.py normalize   # raw2 json -> data/tiktok2_normalized.csv
    python append_batch2.py merge       # tagged csv -> master + summary
"""

import csv
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from process_scraped import normalize_tiktok, FIELDS as NORM_FIELDS
from merge_data import MASTER_FIELDS, TAG_COLS, summarize, to_int

ROOT = Path(__file__).parent.parent
RAW = ROOT / "data" / "tiktok_raw2.json"
NORMALIZED = ROOT / "data" / "tiktok2_normalized.csv"
TAGGED = ROOT / "output" / "tiktok2_tagged.csv"
MASTER = ROOT / "output" / "master_video_database.csv"
TODAY = date.today().isoformat()


def normalize():
    items = json.loads(RAW.read_text())
    rows, seen = [], set()
    for item in items:
        row = normalize_tiktok(item)
        key = row["video_id"] or row["url"]
        if not key or key in seen:
            continue
        seen.add(key)
        rows.append(row)
    with open(NORMALIZED, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=NORM_FIELDS)
        w.writeheader()
        w.writerows(rows)
    print(f"{len(items)} raw -> {len(rows)} unique videos -> {NORMALIZED}")


def merge():
    master = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))
    seen = {(r["platform"], r["video_id"]) for r in master if r["video_id"]}
    seen |= {("url", r.get("url", "")) for r in master if r.get("url")}

    added = dupes = 0
    for r in csv.DictReader(open(TAGGED, newline="", encoding="utf-8")):
        keys = [("tiktok", r["video_id"]), ("url", r.get("url", ""))]
        if any(k in seen for k in keys if k[1]):
            dupes += 1
            continue
        seen.update(k for k in keys if k[1])
        master.append({
            "video_id": r["video_id"], "creator": r["creator"], "platform": "tiktok",
            "title": r["title"], "views": to_int(r["views"]), "likes": to_int(r["likes"]),
            "comments": to_int(r["comments"]), "engagement_rate": r["engagement_rate"],
            **{c: r.get(c, "") for c in TAG_COLS},
            "data_source": "Scraped", "source_type": "organic_scrape",
            "scraped_at": TODAY, "url": r.get("url", ""),
        })
        added += 1

    with open(MASTER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=MASTER_FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(master)

    # merge_data.summarize expects int views + _url key
    for r in master:
        r["views"] = to_int(r["views"])
        r.setdefault("_url", r.get("url", ""))
    summary = summarize(master, dupes)
    (ROOT / "output" / "data_summary.txt").write_text(summary + "\n")
    print(f"added {added:,}, skipped {dupes:,} dupes -> master now {len(master):,} rows")
    print(summary)


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("normalize", "merge"):
        raise SystemExit("Usage: append_batch2.py {normalize|merge}")
    (normalize if sys.argv[1] == "normalize" else merge)()
