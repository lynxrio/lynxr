#!/usr/bin/env python3
"""Attach each video's real spoken words to the master database.

Fills two columns from output/transcripts.jsonl:
  hook_spoken — the verbatim first ~3 seconds (only when quality-usable)
  transcript  — the spoken script, capped at TRANSCRIPT_CAP chars

Why: client-facing "tailored scripts" must be the video's own script lightly
adapted, not a format template. The site can only tailor what it can read, so
the words go into master -> Supabase alongside the tags.

Run any time; idempotent. Re-run after more transcription to grow coverage.
"""

import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from merge_data import MASTER_FIELDS

ROOT = Path(__file__).parent.parent
MASTER = ROOT / "output" / "master_video_database.csv"
TRANSCRIPTS = ROOT / "output" / "transcripts.jsonl"
VISUALS = ROOT / "output" / "visuals.jsonl"
TRANSCRIPT_CAP = 900
SEGMENTS_CAP = 40      # segments per video kept for beat timing
SHOTS_CAP = 6


def main():
    trs = {}
    for line in open(TRANSCRIPTS, encoding="utf-8"):
        d = json.loads(line)
        if not d.get("has_speech") or d.get("quality") not in (None, "ok"):
            continue
        text = (d.get("text") or "").strip()
        if not text:
            continue
        # Later lines win: re-transcribed entries (with segments) replace old ones.
        trs[str(d["video_id"])] = {
            "transcript": text[:TRANSCRIPT_CAP],
            "hook_spoken": (d.get("hook_spoken") or "").strip() if d.get("hook_usable") else "",
            "transcript_segments": json.dumps(d["segments"][:SEGMENTS_CAP], ensure_ascii=False)
                                   if d.get("segments") else "",
        }

    vis = {}
    if VISUALS.exists():
        for line in open(VISUALS, encoding="utf-8"):
            d = json.loads(line)
            if d.get("shots"):
                vis[str(d["video_id"])] = json.dumps(d["shots"][:SHOTS_CAP], ensure_ascii=False)

    rows = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))
    n_t = n_h = n_s = n_v = 0
    for r in rows:
        t = trs.get(str(r["video_id"]))
        if t:
            r["transcript"] = t["transcript"]
            r["hook_spoken"] = t["hook_spoken"]
            r["transcript_segments"] = t["transcript_segments"]
            n_t += 1
            n_h += bool(t["hook_spoken"])
            n_s += bool(t["transcript_segments"])
        v = vis.get(str(r["video_id"]))
        if v:
            r["visual_cues"] = v
            n_v += 1

    fields = MASTER_FIELDS + [c for c in ("hook_spoken", "transcript", "transcript_segments", "visual_cues")
                              if c not in MASTER_FIELDS]
    for r in rows:
        for c in fields:
            r.setdefault(c, "")
    with open(MASTER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} rows: transcript {n_t}, spoken hook {n_h}, "
          f"timed segments {n_s}, visual shot lists {n_v}")


if __name__ == "__main__":
    main()

