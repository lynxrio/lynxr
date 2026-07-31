#!/usr/bin/env python3
"""Download each video's audio and transcribe it locally.

WHY THIS EXISTS
---------------
Every tag we have was inferred from caption text. A caption cannot tell you
whether someone is talking to camera or narrating over b-roll, and it usually
isn't the hook at all — the taxonomy defines the hook as "the exact words said
in the first ~2 seconds". That sentence is in the audio, nowhere else. So the
single biggest accuracy unlock is hearing the video.

HOW
---
yt-dlp pulls audio only (no video, so it's fast and small), and mlx-whisper
transcribes on the Apple-Silicon GPU. Both are local: no API key, no per-video
cost, no rate limit. The only budget is time.

The output records the first-3-seconds text separately, because that segment IS
the spoken hook and is what the retagger keys on.

Usage:
    python transcribe.py --limit 25            # try it on 25 videos
    python transcribe.py                       # everything untranscribed
    python transcribe.py --platform tiktok     # one platform

Resumable: every finished video is appended to output/transcripts.jsonl and
skipped on the next run. Ctrl-C any time; nothing is lost.
"""

import argparse
import csv
import json
import logging
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent
MASTER = ROOT / "output" / "master_video_database.csv"
OUT = ROOT / "output" / "transcripts.jsonl"

# Whisper size/quality trade-off. "small" is the sweet spot for short-form:
# near-large accuracy on clear speech, several times faster. Bump to
# "mlx-community/whisper-large-v3-mlx" if you want maximum fidelity.
MODEL = "mlx-community/whisper-small-mlx"
HOOK_SECONDS = 3.0

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout),
              logging.FileHandler(ROOT / "output" / "transcribe.log")],
)
log = logging.getLogger("transcribe")


def already_done():
    if not OUT.exists():
        return set()
    done = set()
    for line in OUT.read_text().splitlines():
        try:
            d = json.loads(line)
        except Exception:
            continue
        # Only successes count as done — failures are usually transient
        # (rate limits, missing impersonation) and should be retried on a
        # later run rather than written off forever.
        if not d.get("error"):
            done.add(d["video_id"])
    return done


def fetch_audio(url, dest_dir):
    """Audio-only download. Returns the file path, or None if unavailable."""
    out_tmpl = str(dest_dir / "%(id)s.%(ext)s")
    cmd = [
        str(ROOT / "venv" / "bin" / "yt-dlp"),
        # TikTok lists every format as carrying aac, but the h265 ("bytevc1")
        # variants it actually delivers frequently contain a video stream only —
        # ffprobe then reports "unable to obtain file audio codec" and the whole
        # download is wasted. The h264 variants are reliably muxed, so prefer
        # them explicitly. Verified: the same video fails on bytevc1_1080p and
        # succeeds on h264_540p.
        "-f", "bestaudio/best[vcodec^=avc]/best[vcodec^=h264]/best",
        # TikTok increasingly requires browser impersonation (curl-cffi).
        "--impersonate", "chrome",
        "-x", "--audio-format", "mp3", "--audio-quality", "5",
        "--no-playlist", "--no-warnings", "--quiet",
        "--socket-timeout", "20", "--retries", "2",
        "-o", out_tmpl, url,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=180)
    except subprocess.CalledProcessError as e:
        return None, (e.stderr or b"").decode()[:160]
    except subprocess.TimeoutExpired:
        return None, "download timed out"
    files = list(dest_dir.glob("*.mp3"))
    return (files[0], None) if files else (None, "no audio produced")


# Whisper hallucinates on music-only audio — it loops a phrase ("I'm sorry"
# twenty times) or emits a fragment. Short-form is full of music-only clips, so
# detecting "no speech" is not an edge case: it is a real, useful answer. A
# video with no speech has no spoken hook, which itself tells the tagger
# something (the hook is visual or on-screen text, not said aloud).
NO_SPEECH_PROB = 0.6     # Whisper's own per-segment confidence
MIN_COMPRESSION = 2.4    # gzip ratio above this = looping text
MIN_WORDS = 3


def looks_hallucinated(text, segs):
    words = text.split()
    if len(words) < MIN_WORDS:
        return True
    # a handful of unique words stretched over many = a loop
    if len(set(w.lower() for w in words)) / len(words) < 0.35 and len(words) > 8:
        return True
    if segs:
        avg_ns = sum(s.get("no_speech_prob", 0) for s in segs) / len(segs)
        if avg_ns > NO_SPEECH_PROB:
            return True
        if max((s.get("compression_ratio", 0) for s in segs), default=0) > MIN_COMPRESSION:
            return True
    return False


def transcribe(path, model):
    import mlx_whisper
    r = mlx_whisper.transcribe(str(path), path_or_hf_repo=model, verbose=False)
    segs = r.get("segments") or []
    text = (r.get("text") or "").strip()
    hook = " ".join(s["text"].strip() for s in segs
                    if s.get("start", 0) < HOOK_SECONDS).strip()
    speech = not looks_hallucinated(text, segs)
    avg_ns = round(sum(s.get("no_speech_prob", 0) for s in segs) / len(segs), 3) if segs else 1.0
    return {
        "text": text if speech else "",
        "hook_spoken": hook if speech else "",
        "has_speech": speech,
        "no_speech_prob": avg_ns,
        "language": r.get("language", ""),
        "duration": round(segs[-1]["end"], 1) if segs else 0,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--platform", default="")
    ap.add_argument("--model", default=MODEL)
    args = ap.parse_args()

    rows = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))
    done = already_done()
    todo = [r for r in rows
            if r.get("url") and r["video_id"] not in done
            and (not args.platform or r["platform"] == args.platform)]
    # Highest-view videos first: they carry the most weight in every scoreboard,
    # so a partial run still improves the numbers that matter most.
    todo.sort(key=lambda r: -int(float(r.get("views") or 0)))
    if args.limit:
        todo = todo[: args.limit]

    log.info("%d already transcribed; %d queued (model: %s)", len(done), len(todo), args.model)
    ok = failed = 0
    t0 = time.time()

    with open(OUT, "a", encoding="utf-8") as sink:
        for i, r in enumerate(todo, 1):
            with tempfile.TemporaryDirectory() as td:
                audio, err = fetch_audio(r["url"], Path(td))
                if not audio:
                    failed += 1
                    log.warning("[%d/%d] %s — no audio (%s)", i, len(todo), r["video_id"], err)
                    sink.write(json.dumps({"video_id": r["video_id"], "error": err or "unavailable"}) + "\n")
                    sink.flush()
                    continue
                try:
                    t = transcribe(audio, args.model)
                except Exception as e:
                    failed += 1
                    log.warning("[%d/%d] %s — transcribe failed: %s", i, len(todo), r["video_id"], e)
                    continue
            rec = {"video_id": r["video_id"], "platform": r["platform"], "url": r["url"], **t}
            sink.write(json.dumps(rec, ensure_ascii=False) + "\n")
            sink.flush()
            ok += 1
            rate = (time.time() - t0) / max(ok + failed, 1)
            log.info("[%d/%d] %s (%.0fs) %s", i, len(todo), r["video_id"], t["duration"],
                     ("hook: " + t["hook_spoken"][:70]) if t["has_speech"] else "no speech (music/visual only)")
            if i % 25 == 0:
                log.info("--- %d ok, %d failed, %.1fs/video, ~%.0f min left ---",
                         ok, failed, rate, rate * (len(todo) - i) / 60)

    speech = sum(1 for l in OUT.read_text().splitlines()
                 if json.loads(l).get("has_speech")) if OUT.exists() else 0
    log.info("DONE: %d processed, %d failed. %d have speech -> %s", ok, failed, speech, OUT)


if __name__ == "__main__":
    main()
