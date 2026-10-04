#!/usr/bin/env python3
"""Smoke test for the worker's media stack: fail the BUILD, not the creator.

WHY THIS EXISTS. On 2026-10-04 every video failed for hours with
"open() got an unexpected keyword argument 'metadata_errors'". PyAV 19 had
dropped an argument that faster-whisper still passes, nothing pinned `av`, and
the routine rebuild pulled the new release. The image built fine and deployed
fine; the break only showed when a real video reached Whisper. Staff saw "the
video couldn't be downloaded" and one creator's paste failed.

This script runs the same media steps on a generated two-second clip:
  1. ffmpeg encodes H.264 + AAC (the clip and cover steps shell out to it);
  2. ffprobe reads its duration (video_limits.media_duration, the 5-minute gate);
  3. faster-whisper's decode_audio reads it through PyAV (the 2026-10-04 break);
  4. the baked Whisper model transcribes it (ctranslate2), unless SMOKE_MODEL=0;
  5. anthropic and yt_dlp import.
Any failure exits non-zero.

WHERE IT RUNS.
  - Dockerfile: after the model is baked. A failure fails the image build, so
    fly-deploy.yml / fly-refresh.yml go red and the running machine keeps the
    last good image.
  - .github/workflows/adaptations.yml: right after `pip install`, with
    SMOKE_MODEL=0 (the weights are restored from cache later in that job).

    python pipeline/smoke_media.py              # everything
    SMOKE_MODEL=0 python pipeline/smoke_media.py   # skip the model load
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


def step(name, fn):
    try:
        out = fn()
    except Exception as e:  # noqa: BLE001 -- the whole point is to report anything
        print(f"SMOKE FAIL  {name}: {type(e).__name__}: {e}", flush=True)
        sys.exit(1)
    print(f"smoke ok    {name}{(': ' + str(out)) if out not in (None, '') else ''}", flush=True)
    return out


def main():
    with tempfile.TemporaryDirectory() as td:
        clip = Path(td) / "smoke.mp4"

        def encode():
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-f", "lavfi", "-i", "testsrc=size=320x568:rate=30:duration=2",
                 "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                 "-movflags", "+faststart", str(clip)],
                check=True, capture_output=True, timeout=120)
            size = clip.stat().st_size
            if size < 1000:
                raise RuntimeError(f"encoded file is only {size} bytes")
            return f"{size} bytes"

        def duration():
            import video_limits
            d = video_limits.media_duration(clip)
            if not d or not 1.5 <= d <= 3.0:
                raise RuntimeError(f"ffprobe duration {d!r}, expected about 2s")
            return f"{d:.2f}s"

        def decode():
            import av
            from faster_whisper.audio import decode_audio
            samples = decode_audio(str(clip))
            if len(samples) < 16000:
                raise RuntimeError(f"decoded only {len(samples)} samples")
            return f"{len(samples)} samples, av {av.__version__}"

        def transcribe():
            from faster_whisper import WhisperModel
            size = os.environ.get("WHISPER_MODEL", "small")
            model = WhisperModel(size, device="cpu", compute_type="int8")
            segments, info = model.transcribe(str(clip), vad_filter=True)
            list(segments)  # the generator is lazy; this is what actually runs the model
            return f"model {size}, {info.duration:.2f}s of audio"

        def imports():
            import anthropic
            import faster_whisper
            import yt_dlp.version
            return (f"anthropic {anthropic.__version__}, faster-whisper {faster_whisper.__version__}, "
                    f"yt-dlp {yt_dlp.version.__version__}")

        step("ffmpeg encode", encode)
        step("ffprobe duration", duration)
        step("PyAV decode via faster-whisper", decode)
        if os.environ.get("SMOKE_MODEL", "1") != "0":
            step("whisper transcribe", transcribe)
        step("imports", imports)
    print("SMOKE PASS", flush=True)


if __name__ == "__main__":
    main()
