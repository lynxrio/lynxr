# The script worker, packaged to run anywhere that isn't a laptop.
#
# The Mac LaunchAgent (pipeline/io.lynxr.worker.plist) writes scripts in
# seconds, but only while the Mac is awake. This is the same worker.py with no
# such condition attached.
#
# BUILD   docker build -t lynxr-worker .
# RUN     docker run -d --restart=always --name lynxr-worker \
#             -e SUPABASE_SERVICE_ROLE_KEY=... \
#             -e ANTHROPIC_API_KEY=... \
#             lynxr-worker
#
# SECRETS ARE INJECTED, NEVER BAKED. .env is excluded by .dockerignore and the
# image is built from a public repo — worker.py falls back to os.environ when
# there is no .env, which is exactly this case.

FROM python:3.12-slim

# ffmpeg for frame extraction and audio; the pipeline shells out to it by name,
# so it has to be on PATH rather than vendored.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Deps first, so a code change does not re-install torch-sized wheels.
COPY requirements-ci.txt .
RUN pip install --no-cache-dir -r requirements-ci.txt

# Bake the Whisper weights into the image (~500MB). Without this the first
# script after every deploy pays a cold model download, and a Hugging Face
# outage becomes a lynxr outage. HF_HOME is set before the download so the
# cache lands somewhere the runtime user can read.
ENV HF_HOME=/app/.cache/huggingface
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small')"

# transcribe.py picks whichever backend imports. On this image that is
# faster-whisper, which wants a plain size name — the Mac's default
# ("mlx-community/whisper-small-mlx") is Apple-Silicon only and would fail here.
ENV WHISPER_MODEL=small

# Don't phone home for a model that is already in the image. This removes a
# network round-trip and a failure mode, not a minute — see below for what the
# minute actually was.
#
# Trade: if the weights are ever missing this FAILS instead of downloading,
# which is the better failure — loud at deploy rather than silent at run time.
# Change WHISPER_MODEL and you must bake in that size above too.
ENV HF_HUB_OFFLINE=1

# ── The one-minute first script, and why it is not a bug to fix here ──────────
# Loading the model was measured at 59.6s once and ~1.7s every time after, in
# separate processes. That is the COLD PAGE CACHE: the first read of 464MB off
# the machine's disk after a start. Once those pages are resident every
# subsequent load is ~1.7s, and each pass being its own subprocess costs nothing.
#
# So the penalty is per MACHINE START, not per script. It only looked per-script
# because Fly's trial tier stopped the machine every 5 minutes, making every
# script the first one. On a machine that stays up it disappears on its own.
#
# If it ever needs to go away entirely: compute_type="int8" loads in ~1.0s and
# uses less memory, at some cost to transcription quality. Not worth it yet.

ENV PYTHONUNBUFFERED=1

# Only the pipeline. The site, the scraped corpus and the venv are all excluded
# by .dockerignore; copying the repo wholesale would drag in output/ (1.7GB of
# cover frames) and slow every build for nothing.
COPY pipeline/ ./pipeline/

# Don't run as root. The worker downloads and executes nothing but its own
# code, but it does fetch arbitrary creator-supplied URLs with yt-dlp, and that
# is the sort of surface where "it was only a video" ages badly.
RUN useradd --create-home --uid 10001 worker \
 && chown -R worker:worker /app
USER worker

CMD ["python", "pipeline/worker.py"]
