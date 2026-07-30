#!/usr/bin/env python3
"""Export the master video database to web/data.json for the MVP dashboard."""

import csv
import json
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC = ROOT / "output" / "master_video_database.csv"
DEST = ROOT / "web" / "data.json"

KEEP = [
    "video_id", "creator", "platform", "title", "views", "likes", "comments",
    "engagement_rate", "format_type", "hook_pattern", "niche_category",
    "target_audience", "data_source",
]


def main():
    if not SRC.exists():
        raise SystemExit(f"{SRC} not found — run merge_data.py first.")

    with open(SRC, newline="", encoding="utf-8") as f:
        rows = [{k: r.get(k, "") for k in KEEP} for r in csv.DictReader(f)]

    for r in rows:
        for n in ("views", "likes", "comments"):
            try:
                r[n] = int(float(r[n] or 0))
            except ValueError:
                r[n] = 0

    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(json.dumps(rows, separators=(",", ":")))
    print(f"Wrote {DEST} ({len(rows):,} rows, {DEST.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
