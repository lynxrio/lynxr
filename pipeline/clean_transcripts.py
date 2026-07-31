#!/usr/bin/env python3
"""Second-pass quality filter over transcripts.jsonl.

transcribe.py rejects the obvious hallucinations (looping text, high
no_speech_prob). Three kinds still slip through, and all three would corrupt
the retag if fed to the tagger as if they were spoken hooks:

  1. PHANTOM PHRASES — Whisper emits stock captions on near-silent audio.
     "Thanks for watching!", "Subscribe", "Bye" and friends appear constantly
     and are indistinguishable from real speech by confidence alone.
  2. LOOPED SPEECH — Whisper repeats a genuine sentence many times. The
     content is real, so the run is collapsed rather than discarded.
  3. FRAGMENTS — a hook of "I" or "!" carries no classifiable signal even when
     the rest of the transcript is real. Marked hook_usable=false, but the
     transcript is kept for format evidence.

This pass is non-destructive: it rewrites has_speech / hook_usable and records
why, so a decision can always be traced. It re-reads the retained text, so it
can run after the fact without re-downloading anything.

Usage:
    python clean_transcripts.py --dry-run    # report only
    python clean_transcripts.py              # rewrite in place (keeps a .bak)
"""

import argparse
import json
import re
import shutil
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC = ROOT / "output" / "transcripts.jsonl"

# Stock strings Whisper invents when there is nothing to hear. Matched against
# the whole transcript, so a video that ONLY contains one of these is silence.
PHANTOMS = [
    "thanks for watching", "thank you for watching", "thanks for listening",
    "please subscribe", "subscribe to my channel", "like and subscribe",
    "see you next time", "see you in the next video", "don't forget to subscribe",
    "for more information visit", "transcription by", "subtitles by",
    "amara.org", "captions by", "music playing", "outro music",
]

MIN_HOOK_WORDS = 4

# NOTE ON LYRICS: an earlier version tried to detect singing with word-density
# and repeated-n-gram heuristics. Measured against real transcripts it failed
# both ways — it rejected a maths problem read aloud and an app list (both real
# speech, both useful), while keeping actual song lyrics. Nothing in the text
# reliably separates singing from speech. The tagger sees the full transcript
# and judges that far better, so lyric handling is left to the prompt.


def norm(t):
    return re.sub(r"[^a-z0-9' ]", " ", (t or "").lower())


def is_phantom(text):
    n = " ".join(norm(text).split())
    if not n:
        return True
    for p in PHANTOMS:
        if n == p or (p in n and len(n) < len(p) + 25):
            return True
    return False


def collapse_loops(text):
    """Whisper sometimes repeats a real sentence many times. The content is
    genuine — only the repetition is an artifact — so collapse runs instead of
    discarding the video."""
    parts = re.split(r"(?<=[.!?])\s+", (text or "").strip())
    out = []
    for p in parts:
        if not out or norm(p).strip() != norm(out[-1]).strip():
            out.append(p)
    return " ".join(out).strip()


def classify(rec):
    """Returns (has_speech, hook_usable, reason)."""
    if rec.get("error"):
        return False, False, "download failed"
    if not rec.get("has_speech"):
        return False, False, rec.get("reason", "no speech detected")
    text = collapse_loops(rec.get("text") or "")
    rec["text"] = text
    if is_phantom(text):
        return False, False, "whisper phantom phrase"
    hook = collapse_loops(rec.get("hook_spoken") or "").strip()
    rec["hook_spoken"] = hook
    if len(hook.split()) < MIN_HOOK_WORDS:
        # real speech, but the opening is too thin to classify a hook from
        return True, False, "hook too short to classify"
    return True, True, "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SRC.exists():
        raise SystemExit(f"{SRC} not found — run transcribe.py first.")
    recs = []
    for line in SRC.read_text().splitlines():
        try:
            recs.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    reasons = Counter()
    flipped = 0
    for r in recs:
        was = bool(r.get("has_speech"))
        speech, hook_ok, why = classify(r)
        reasons[why] += 1
        if was and not speech:
            flipped += 1
        r["has_speech"] = speech
        r["hook_usable"] = hook_ok
        r["quality"] = why
        if not speech:
            r["hook_spoken"] = ""

    usable_hooks = sum(1 for r in recs if r.get("hook_usable"))
    speech = sum(1 for r in recs if r.get("has_speech"))
    print(f"{len(recs)} records")
    print(f"  usable spoken hooks: {usable_hooks}")
    print(f"  has speech:          {speech}")
    print(f"  reclassified as non-speech this pass: {flipped}")
    print("\nbreakdown:")
    for why, n in reasons.most_common():
        print(f"  {n:5d}  {why}")

    if args.dry_run:
        print("\n(dry run — nothing written)")
        return
    shutil.copy(SRC, SRC.with_suffix(".jsonl.bak"))
    with open(SRC, "w", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"\nrewrote {SRC} (backup at {SRC.name}.bak)")


if __name__ == "__main__":
    main()
