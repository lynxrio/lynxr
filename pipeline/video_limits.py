"""The longest source video lynxr will work from, and how a length is measured.

Owner, 2026-09-25: "when someone adds a video that is longer than 5 minutes,
dont run it". Plan: ~/.claude/plans/max-video-length.md.

THE RULE. A video whose length, rounded to the nearest whole second (half up),
is over MAX_SOURCE_SECONDS is refused before Whisper and before any model call.
Exactly 300 is allowed; 300.4 is allowed (rounds to 300); 300.5 is refused
(rounds to 301). Rounding before comparing means the number on the card is the
number that was judged, and it matches creator.js lengthLabel(), which rounds
the same way.

UNKNOWN IS ALLOWED. None, 0, negative, NaN, infinite or unparseable is "we do
not know", never "too long". ffprobe reads the container header of a file we
already downloaded, so a failure means an odd file, not a long one; refusing
it would hand a creator a final "too long" card for a video that may be 20
seconds, with no number to show. The cost of a wrong allow is bounded: the
download itself times out at 180s (analyze_visuals.download_video).

Stdlib only, no import-time side effects -- process_adaptations.py,
brief_clips.py and the tests all import it. THE CONSTANT LIVES HERE AND
NOWHERE ELSE; every sentence that names the limit derives it from this value.
"""
import math
import subprocess

MAX_SOURCE_SECONDS = 300


def as_seconds(value):
    """A usable length in seconds as a float, or None when unknown."""
    try:
        s = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(s) or s <= 0:
        return None
    return s


def whole_seconds(value):
    """Nearest whole second, half up (431.6 -> 432, 300.5 -> 301). None when unknown."""
    s = as_seconds(value)
    return None if s is None else int(math.floor(s + 0.5))


def too_long(value):
    """True only for a KNOWN length over the limit."""
    w = whole_seconds(value)
    return w is not None and w > MAX_SOURCE_SECONDS


def media_duration(path):
    """Seconds of a local media file from ffprobe's container duration, or None.

    ffprobe ships with the ffmpeg package on Fly (Dockerfile), the GitHub
    fallback (adaptations.yml installs ffmpeg) and the Mac (Homebrew).
    Never raises."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=20)
    except Exception:  # noqa: BLE001 -- missing binary, timeout: unknown, not an error
        return None
    if r.returncode != 0:
        return None
    lines = (r.stdout or "").strip().splitlines()
    return as_seconds(lines[0]) if lines else None
