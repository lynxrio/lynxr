#!/usr/bin/env python3
"""Tag five taxonomy dimensions that the caption-only pass never produced:
length_bucket, audio_trend (both mechanical), and cta_type / visual_hook /
hook_delivery (one multimodal API request per video).

Honest accuracy, by dimension:
  length_bucket  — exact where a duration exists (raw TikTok scrape or a
                   transcript). Blank when we have neither.
  audio_trend    — the platform's own sound label for scraped TikToks
                   (trending-sound name, or Original Audio); "Voiceover" when a
                   transcript shows the creator talking over their own sound.
                   Blank for rows with no music metadata and no transcript.
  cta_type       — from caption + transcript. Text evidence, ~all rows.
  visual_hook    — from the opening cover frame. Only rows with a cover (~66%).
  hook_delivery  — deliberately conservative. Delivery energy needs the actual
                   audio/video; from text + one still we can only catch a
                   visible shocked face or a clearly narrative transcript.
                   Everything else is "Other" (== not determinable), on purpose.

Usage:
    python tag_extra_dims.py --mechanical-only   # length_bucket + audio_trend, no API
    python tag_extra_dims.py --limit 3           # small live batch to prove credits
    python tag_extra_dims.py                      # full multimodal batch, then merge
Then: python export_supabase.py   (push the new columns to lynxr_videos)
"""

import argparse
import base64
import csv
import glob
import json
import logging
import os
import shutil
import sys
import time
from collections import Counter
from datetime import date
from pathlib import Path

import anthropic


def _load_env():
    """Make ANTHROPIC_API_KEY available when run standalone (not via
    run_pipeline.sh, which sources .env)."""
    env = Path(__file__).parent.parent / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


_load_env()

sys.path.insert(0, str(Path(__file__).parent))
from taxonomy import (TAG_SCHEMA_EXTRA, TAG_SCHEMA_EXTRA_VISION, SYSTEM_EXTRA,
                      length_bucket)
from merge_data import MASTER_FIELDS

ROOT = Path(__file__).parent.parent
MASTER = ROOT / "output" / "master_video_database.csv"
TRANSCRIPTS = ROOT / "output" / "transcripts.jsonl"
COVERS = ROOT / "data" / "covers"
MODEL = "claude-opus-5"
MAX_EDGE = 768   # cap the cover's long edge; keeps on-screen text legible, halves image spend

# New columns this script fills. Order kept stable for the CSV.
NEW_COLS = ["length_bucket", "audio_trend", "cta_type", "visual_hook",
            "onscreen_text", "hook_delivery"]

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout),
              logging.FileHandler(ROOT / "output" / "tag_extra.log")],
)
log = logging.getLogger("tag-extra")


def load_durations():
    """video_id -> duration seconds, from raw TikTok scrapes then transcripts."""
    dur = {}
    for f in glob.glob(str(ROOT / "data" / "*_parts*" / "*.json")):
        try:
            items = json.loads(Path(f).read_text())
        except Exception:
            continue
        for it in (items if isinstance(items, list) else [items]):
            vid = str(it.get("id") or "")
            d = (it.get("videoMeta") or {}).get("duration")
            if vid and d:
                dur[vid] = d
    for line in _transcript_lines():
        if line.get("duration") and line["video_id"] not in dur:
            dur[line["video_id"]] = line["duration"]
    return dur


def load_music():
    """video_id -> {original: bool, name: str} from the raw TikTok scrapes."""
    idx = {}
    for f in glob.glob(str(ROOT / "data" / "*_parts*" / "*.json")):
        try:
            items = json.loads(Path(f).read_text())
        except Exception:
            continue
        for it in (items if isinstance(items, list) else [items]):
            mm = it.get("musicMeta") or {}
            vid = str(it.get("id") or "")
            if vid and mm:
                idx[vid] = {"original": bool(mm.get("musicOriginal")),
                            "name": (mm.get("musicName") or "").strip()}
    return idx


def _transcript_lines():
    if not TRANSCRIPTS.exists():
        return
    for line in TRANSCRIPTS.read_text().splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("error") or not d.get("video_id"):
            continue
        yield d


def load_transcripts():
    return {d["video_id"]: d for d in _transcript_lines()}


def audio_trend(row, music, tr):
    """Sound label per the taxonomy: a named trending sound, Original Audio, or
    Voiceover. Blank when we have no signal at all."""
    m = music.get(row["video_id"])
    speaking = bool(tr.get(row["video_id"], {}).get("has_speech"))
    if m:
        if not m["original"] and m["name"]:
            return m["name"]                 # a licensed/named (often trending) sound
        return "Voiceover" if speaking else "Original Audio"
    # No music metadata (e.g. Medceptor). Only "Voiceover" is safely inferable.
    return "Voiceover" if speaking else ""


def enrich_mechanical(rows):
    dur = load_durations()
    music = load_music()
    tr = load_transcripts()
    lb = at = 0
    for r in rows:
        b = length_bucket(dur.get(r["video_id"]))
        r["length_bucket"] = b
        if b:
            lb += 1
        a = audio_trend(r, music, tr)
        r["audio_trend"] = a
        if a:
            at += 1
    log.info("mechanical: length_bucket on %d/%d, audio_trend on %d/%d",
             lb, len(rows), at, len(rows))
    return dur, music, tr


def cover_bytes(video_id):
    p = COVERS / f"{video_id}.jpg"
    if not p.exists():
        return None
    try:
        from PIL import Image
        import io
        im = Image.open(p).convert("RGB")
        w, h = im.size
        scale = min(MAX_EDGE / max(w, h), 1.0)
        if scale < 1.0:
            im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=82)
        return buf.getvalue()
    except Exception:
        return p.read_bytes()


def user_text(row, tr):
    caption = (row.get("title") or "").strip().replace("\n", " ")[:600]
    parts = [f"Platform: {row['platform']}",
             "Source: Medceptor campaign" if row["data_source"] == "Medceptor" else "Source: organic scrape",
             f"Caption: {caption or '(none)'}"]
    t = tr.get(row["video_id"])
    if t and t.get("has_speech"):
        if t.get("hook_spoken"):
            parts.append(f'SPOKEN HOOK: "{t["hook_spoken"]}"')
        parts.append(f"FULL TRANSCRIPT: {t.get('text', '')[:2000]}")
    elif t:
        parts.append("AUDIO: no speech detected (music/on-screen text only).")
    return "Tag this video.\n\n" + "\n".join(parts)


def build_requests(rows, tr, limit, niche=""):
    reqs = []
    with_vision = 0
    for i, r in enumerate(rows):
        if limit and len(reqs) >= limit:
            break
        # Only rows the LLM pass hasn't tagged yet — re-running never re-bills.
        if r.get("cta_type"):
            continue
        if niche and r.get("niche_category") != niche:
            continue
        text = user_text(r, tr)
        cover = cover_bytes(r["video_id"])
        if cover:
            with_vision += 1
            content = [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                             "data": base64.b64encode(cover).decode()}},
                {"type": "text", "text": text + "\n\nThe image above is this video's opening frame."},
            ]
            schema = TAG_SCHEMA_EXTRA_VISION
        else:
            content = text
            schema = TAG_SCHEMA_EXTRA
        reqs.append({
            # id-keyed so results survive master reorders (see retag_with_audio)
            "custom_id": f"x-{r['video_id']}"[:64],
            "params": {
                "model": MODEL, "max_tokens": 1200,
                "system": [{"type": "text", "text": SYSTEM_EXTRA, "cache_control": {"type": "ephemeral"}}],
                "output_config": {"format": {"type": "json_schema", "schema": schema}},
                "messages": [{"role": "user", "content": content}],
            },
        })
    return reqs, with_vision


def apply_results(client, batch_id, rows):
    changed = Counter()
    applied = 0
    by_vid = {str(r["video_id"]): i for i, r in enumerate(rows)}
    for result in client.messages.batches.results(batch_id):
        kind, _, key = result.custom_id.partition("-")
        idx = by_vid.get(key, -1) if kind == "x" and not key.isdigit() else (
            int(key) if key.isdigit() else -1)
        if result.result.type != "succeeded" or not (0 <= idx < len(rows)):
            continue
        msg = result.result.message
        if msg.stop_reason == "refusal":
            continue
        try:
            data = json.loads(next(b.text for b in msg.content if b.type == "text"))
        except (StopIteration, json.JSONDecodeError):
            continue
        for k in ("cta_type", "visual_hook", "onscreen_text", "hook_delivery"):
            if k in data:
                rows[idx][k] = data[k]
                changed[k] += 1
        applied += 1
    return applied, changed


def write_master(rows):
    fields = MASTER_FIELDS + [c for c in NEW_COLS if c not in MASTER_FIELDS]
    for r in rows:
        for c in NEW_COLS:
            r.setdefault(c, "")
    with open(MASTER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mechanical-only", action="store_true")
    ap.add_argument("--niche", default="",
                    help='only rows in this niche_category (e.g. "Fashion & Beauty")')
    ap.add_argument("--limit", type=int, default=0, help="cap LLM rows (for a credit test)")
    args = ap.parse_args()

    rows = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))
    log.info("%d rows", len(rows))

    snap = MASTER.with_name(f"master_before_extra_{date.today().isoformat()}.csv")
    if not snap.exists():
        shutil.copy(MASTER, snap)
        log.info("snapshot -> %s", snap.name)

    dur, music, tr = enrich_mechanical(rows)

    if args.mechanical_only:
        write_master(rows)
        log.info("wrote master with length_bucket + audio_trend. Push: export_supabase.py")
        return

    reqs, with_vision = build_requests(rows, tr, args.limit, args.niche)
    log.info("%d LLM requests, %d include the opening frame", len(reqs), with_vision)

    client = anthropic.Anthropic()
    b = client.messages.batches.create(requests=reqs)
    state = ROOT / "output" / "tag_extra.batch_state.json"
    state.write_text(json.dumps({"batch_id": b.id, "n": len(reqs)}))
    log.info("submitted batch %s (%d requests)", b.id, len(reqs))

    while True:
        b = client.messages.batches.retrieve(b.id)
        c = b.request_counts
        log.info("batch %s: processing=%d succeeded=%d errored=%d",
                 b.processing_status, c.processing, c.succeeded, c.errored)
        if b.processing_status == "ended":
            break
        time.sleep(30)

    applied, changed = apply_results(client, b.id, rows)
    write_master(rows)
    log.info("applied %d rows. new tags: %s", applied, dict(changed))
    log.info("Push to Supabase: ./venv/bin/python pipeline/export_supabase.py")


if __name__ == "__main__":
    main()

