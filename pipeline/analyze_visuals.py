#!/usr/bin/env python3
"""Read what's ON SCREEN: per-video shot list + verbatim on-screen text.

For every target video: download it (yt-dlp), pull frames at the real beat
boundaries (Whisper segment starts when we have them, else evenly spaced),
and have a vision model describe each frame — one short shot description plus
ALL on-screen text transcribed verbatim.

Why: ~40% of the database has no speech; their script IS the on-screen text.
For speech videos the shot list becomes the visual cue attached to each beat.

Usage:
    python analyze_visuals.py --no-speech-only          # the silent videos first
    python analyze_visuals.py --limit 5                 # smoke test
    python analyze_visuals.py                           # everything

Resumable: appends to output/visuals.jsonl; already-analyzed ids are skipped.
Model: claude-haiku-4-5 live requests — ~$0.005/video at 5 frames, 512px.
"""

import argparse
import base64
import csv
import json
import logging
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic

ROOT = Path(__file__).parent.parent
MASTER = ROOT / "output" / "master_video_database.csv"
TRANSCRIPTS = ROOT / "output" / "transcripts.jsonl"
OUT = ROOT / "output" / "visuals.jsonl"
MODEL = "claude-haiku-4-5-20251001"
MAX_FRAMES = 6
FRAME_EDGE = 512

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout),
              logging.FileHandler(ROOT / "output" / "visuals.log")],
)
log = logging.getLogger("visuals")

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "shots": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "t": {"type": "number", "description": "timestamp seconds of this frame"},
                    "visual": {"type": "string", "description": "one short clause: subject, framing, action"},
                    "onscreen_text": {"type": "string", "description": "ALL text visible in the frame, verbatim; empty string if none"},
                },
                "required": ["t", "visual", "onscreen_text"],
            },
        },
    },
    "required": ["shots"],
}

PROMPT = ("These are frames from one short-form vertical video, in order, taken at the "
          "timestamps given with each image. For EACH frame return: `t` (its timestamp), "
          "`visual` (one short clause — subject, framing, what's happening), and "
          "`onscreen_text` (every piece of text visible in the frame, transcribed verbatim — "
          "captions, overlays, app UI; empty string if none). Keep frame order.")


def latest_transcripts():
    """video_id -> latest transcript entry (later lines win)."""
    trs = {}
    if TRANSCRIPTS.exists():
        for line in TRANSCRIPTS.read_text().splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue
            trs[str(d.get("video_id"))] = d
    return trs


def already_done():
    done = set()
    if OUT.exists():
        for line in OUT.read_text().splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue
            if not d.get("error"):
                done.add(str(d["video_id"]))
    return done


def frame_times(entry, duration):
    """Frame timestamps: Whisper segment starts when known, else spread evenly."""
    segs = (entry or {}).get("segments") or []
    if segs:
        times = [s[0] for s in segs[:MAX_FRAMES]]
        if len(times) < 3 and duration:
            times += [duration * p for p in (0.5, 0.85)]
        return sorted(set(round(t, 1) for t in times))[:MAX_FRAMES]
    d = duration or 20
    return [round(d * p, 1) for p in (0.03, 0.25, 0.5, 0.75, 0.92)]


def download_video(url, dest):
    r = subprocess.run(
        [str(ROOT / "venv" / "bin" / "yt-dlp"), "-q", "--no-warnings", "-f", "b[height<=720]/b",
         "--no-playlist", "-o", str(dest / "v.%(ext)s"), url],
        capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return None, (r.stderr or "download failed").strip().splitlines()[-1][:160]
    vids = list(dest.glob("v.*"))
    return (vids[0], None) if vids else (None, "no file")


def extract_frames(video, times, dest):
    frames = []
    for i, t in enumerate(times):
        out = dest / f"f{i}.jpg"
        r = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(t), "-i", str(video),
             "-frames:v", "1", "-vf", f"scale='min({FRAME_EDGE},iw)':-2", "-q:v", "5", str(out)],
            capture_output=True, timeout=60)
        if r.returncode == 0 and out.exists() and out.stat().st_size > 1000:
            frames.append((t, out))
    return frames


def analyze(client, frames):
    content = []
    for t, path in frames:
        content.append({"type": "text", "text": f"Frame at t={t}s:"})
        content.append({"type": "image", "source": {
            "type": "base64", "media_type": "image/jpeg",
            "data": base64.b64encode(path.read_bytes()).decode()}})
    content.append({"type": "text", "text": PROMPT})
    msg = client.messages.create(
        model=MODEL, max_tokens=1500,
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": content}])
    return json.loads(next(b.text for b in msg.content if b.type == "text"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=3,
                    help="parallel download+analyze workers (downloads dominate wall time)")
    ap.add_argument("--no-speech-only", action="store_true",
                    help="only videos whose transcript says no speech — their script IS the screen text")
    args = ap.parse_args()

    trs = latest_transcripts()
    done = already_done()
    rows = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))
    todo = []
    for r in rows:
        vid = str(r["video_id"])
        if not r.get("url") or vid in done:
            continue
        entry = trs.get(vid)
        if args.no_speech_only and (entry is None or entry.get("has_speech") or entry.get("error")):
            continue
        todo.append(r)
    todo.sort(key=lambda r: -int(float(r.get("views") or 0)))
    if args.limit:
        todo = todo[: args.limit]

    log.info("%d analyzed already; %d queued (%d workers)", len(done), len(todo), args.workers)
    client = anthropic.Anthropic()
    lock = threading.Lock()
    state = {"i": 0, "ok": 0, "failed": 0}
    t0 = time.time()

    def work(r, sink):
        vid = str(r["video_id"])
        rec = {"video_id": vid, "platform": r["platform"], "url": r["url"]}
        try:
            with tempfile.TemporaryDirectory() as td:
                td = Path(td)
                video, err = download_video(r["url"], td)
                if not video:
                    raise RuntimeError(err)
                entry = trs.get(vid)
                times = frame_times(entry, (entry or {}).get("duration") or 0)
                frames = extract_frames(video, times, td)
                if not frames:
                    raise RuntimeError("no frames extracted")
                rec["shots"] = analyze(client, frames)["shots"]
        except Exception as e:
            rec["error"] = str(e)[:200]
        with lock:
            state["i"] += 1
            state["ok" if "shots" in rec else "failed"] += 1
            sink.write(json.dumps(rec, ensure_ascii=False) + "\n")
            sink.flush()
            if state["i"] % 25 == 0 or state["i"] == len(todo):
                rate = (time.time() - t0) / state["i"]
                log.info("[%d/%d] ok=%d failed=%d, %.1fs/video, ~%d min left",
                         state["i"], len(todo), state["ok"], state["failed"],
                         rate, int(rate * (len(todo) - state["i"]) / 60))

    with open(OUT, "a", encoding="utf-8") as sink:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for r in todo:
                pool.submit(work, r, sink)
    log.info("DONE: %d ok, %d failed -> %s", state["ok"], state["failed"], OUT)


if __name__ == "__main__":
    main()
