#!/usr/bin/env python3
"""Re-tag videos using what was said AND what is on screen, not just the caption.

This is where the accuracy comes from. transcribe.py produced the evidence;
this feeds it to the tagger and overwrites the caption-only guesses.

Three kinds of evidence now reach the model:
  1. The spoken hook — the literal words in the first ~3 seconds. The taxonomy
     defines the hook pattern by exactly this, so it stops being inference.
  2. The full transcript — first-person address ("I", "you guys") means a
     talking head; narration over unrelated footage reads differently; a
     numbered rundown out loud is a Listicle no matter what the caption says.
  3. has_speech=false — a real answer, not a gap. No speech means the message
     is carried by on-screen text or the visual.
  4. The opening frame, when a cover has been fetched. This is the only source
     for the Visual Hook column and for on-screen text, and it rescues exactly
     the videos audio cannot reach: a silent clip of a campus with "my campus>"
     burned into the frame has a real hook that no caption or transcript holds.

Only rows with a transcript are touched; everything else keeps its current tag.
Each retagged row records tag_source=audio so you can tell measured tags from
inferred ones later.

Usage:
    python retag_with_audio.py --dry-run    # show what would change
    python retag_with_audio.py              # apply, then re-encrypt
"""

import argparse
import csv
import json
import logging
import shutil
import sys
import time
from collections import Counter
from datetime import date
from pathlib import Path

import anthropic

sys.path.insert(0, str(Path(__file__).parent))
from taxonomy import (FORMAT_TYPES, HOOK_PATTERNS, NICHE_CATEGORIES, TARGET_AUDIENCES,
                      VISUAL_HOOKS, TAG_SCHEMA, TAG_SCHEMA_VISION)
from merge_data import MASTER_FIELDS, summarize, to_int

ROOT = Path(__file__).parent.parent
MASTER = ROOT / "output" / "master_video_database.csv"
TRANSCRIPTS = ROOT / "output" / "transcripts.jsonl"
COVERS = ROOT / "data" / "covers"
MODEL = "claude-opus-5"
DIMS = ["format_type", "hook_pattern", "niche_category", "target_audience"]
VIS_DIMS = ["visual_hook", "onscreen_text"]

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout),
              logging.FileHandler(ROOT / "output" / "retag_audio.log")],
)
log = logging.getLogger("retag-audio")

SYSTEM = f"""You are tagging short-form videos for Lynxr using a LOCKED taxonomy.
Unlike caption-only tagging, you can now hear the video: you get the words spoken
in the first ~3 seconds and the full transcript. Use them as primary evidence —
they outrank the caption whenever the two disagree.

format_type: {", ".join(FORMAT_TYPES)}
hook_pattern: {", ".join(HOOK_PATTERNS)}
niche_category: {", ".join(NICHE_CATEGORIES)}
target_audience: {", ".join(TARGET_AUDIENCES)}

Reading the audio:
- SPOKEN HOOK is the hook. Classify hook_pattern from those exact words:
  withholds a payoff -> Curiosity Gap; superlative/contrarian -> Bold Claim;
  a number that stops the scroll -> Surprising Stat; names a frustration the
  viewer shares -> Relatable Pain; insider/outsider -> Us vs Them; asks the
  viewer -> Question; "stop doing X" -> Warning; "everyone's switching" ->
  Social Proof; before/after -> Transformation; an imperative aimed at the
  viewer -> Direct CTA; names/addresses a segment -> Audience Call-Out; the
  creator's own feeling -> Emotional Share.
- FORMAT from how they speak: sustained first-person address to camera ->
  Talking Head; an enumerated rundown ("number one… number two") -> Listicle;
  narrating an interface/walkthrough -> Screen Demo; recounting something that
  happened to them -> Story Time; acted dialogue or characters -> Skit;
  reacting to another clip -> Reaction / Duet; narration over footage with no
  direct address -> Voiceover B-roll; "POV:" framing -> POV.
- NO SPEECH means nothing is said aloud: the message is on-screen text or the
  visual. That is normally Meme / Trend Clip, and the hook is No Hook unless the
  caption itself carries a real device. Do not invent a spoken hook.
- ALWAYS READ THE TRANSCRIPT ON ITS MERITS. Creators routinely talk over a
  trending sound — that is normal UGC practice, not an exception. A licensed
  track playing does NOT mean there is no speech. Judge every transcript by
  what it actually says.
- AUDIO TRACK is context, never a verdict. "Licensed music" means the words
  COULD be the song's lyrics, so look harder before deciding — it does not
  license you to skip the transcript. "Original sound" means the audio is the
  creator's own upload, which usually means speech but can still be them
  lip-syncing or music they posted.
- TELLING SPEECH FROM LYRICS is a content judgement, not a metadata one. Speech
  addresses a viewer, explains, instructs, enumerates, or recounts ("here are
  four apps", "listen up", "I passed my NREMT"). Lyrics rhyme, repeat a chorus,
  scan in metre, and do not address the viewer as a person. When a transcript
  contains both — the creator talking while a song plays underneath — the
  creator's words are the speech; use them and ignore the sung fragments.
- Only when the transcript is ENTIRELY lyrics with no one addressing the viewer
  should you treat the video as having no speech.
- HOOK NOT USABLE means speech exists but its opening is too fragmentary to
  classify. Use the full transcript for format, and take the hook from the
  caption instead.

WHEN AN IMAGE IS ATTACHED it is the video's opening frame. Use it for:
- visual_hook — what is on screen in frame one: {", ".join(VISUAL_HOOKS)}.
  A face filling the frame -> Face Close-up; text burned over the video before
  anything else reads -> Text-first; the product or an app UI visible ->
  Product On-screen; an unexpected object or action -> Pattern Interrupt; a
  place being shown off -> Location Reveal; motion as the opener ->
  Motion / Movement.
- onscreen_text — transcribe any text burned into the frame, verbatim. This is
  frequently the real hook on silent videos, so read it carefully.
- Corroborating format: a face to camera supports Talking Head, an app UI
  supports Screen Demo, a person over a screenshot supports Green Screen.
If the video has no speech, the on-screen text IS the hook — classify
hook_pattern from those words rather than defaulting to No Hook.

Commit to the most plausible specific value for every dimension. "Other" is only
for genuinely unintelligible material."""


def load_music_index():
    """video_id -> {original: bool, name: str, author: str} from the raw scrapes.

    TikTok reports whether a video's audio is the creator's own recording
    ("original sound") or a licensed track. That distinction is the strongest
    lyrics-vs-speech evidence we have, and unlike a text heuristic it comes
    from the platform rather than a guess about the words.
    """
    import glob
    idx = {}
    for f in glob.glob(str(ROOT / "data" / "*_parts*" / "*.json")):
        try:
            items = json.loads(Path(f).read_text())
        except Exception:
            continue
        for it in items:
            mm = it.get("musicMeta") or {}
            vid = str(it.get("id") or "")
            if vid and mm:
                idx[vid] = {"original": bool(mm.get("musicOriginal")),
                            "name": (mm.get("musicName") or "")[:80],
                            "author": (mm.get("musicAuthor") or "")[:60]}
    return idx


def load_transcripts():
    t = {}
    if not TRANSCRIPTS.exists():
        raise SystemExit(f"{TRANSCRIPTS} not found — run transcribe.py first.")
    for line in TRANSCRIPTS.read_text().splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("error"):
            continue
        t[d["video_id"]] = d
    return t


# Vision cost scales with pixel area (~w*h/750 tokens). Covers arrive anywhere
# from 480x360 to 1170x2080; capping the long edge keeps on-screen text
# readable while roughly halving the image spend across the set.
MAX_EDGE = 768


def cover_bytes(video_id):
    """Downscaled JPEG bytes for the opening frame, or None."""
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
        return p.read_bytes()   # fall back to the original rather than skipping


def user_content(row, tr, music=None):
    caption = (row.get("title") or "").strip().replace("\n", " ")[:600]
    parts = [f"Platform: {row['platform']}",
             "Source: Medceptor campaign" if row["data_source"] == "Medceptor" else "Source: organic scrape",
             f"Caption: {caption or '(none)'}"]
    if music:
        parts.append("Audio track: creator's own recording (original sound)" if music["original"]
                     else f"Audio track: licensed music — \"{music['name']}\" by {music['author']}. "
                          "The creator may still be speaking over it — read the transcript and decide.")
    if tr.get("has_speech"):
        if tr.get("hook_usable", True) and tr.get("hook_spoken"):
            parts.append(f'SPOKEN HOOK (first 3s, verbatim): "{tr["hook_spoken"]}"')
        else:
            parts.append("SPOKEN HOOK: not usable — opening too fragmentary. "
                         "Take the hook from the caption; use the transcript for format.")
        parts.append(f"FULL TRANSCRIPT: {tr['text'][:2000]}")
    else:
        parts.append("AUDIO: no speech — music or ambient only. "
                     "The message is on-screen text or visual.")
    return "Tag this video.\n\n" + "\n".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--all", action="store_true",
                    help="also re-tag rows already marked tag_source=audio")
    args = ap.parse_args()

    trs = load_transcripts()
    music = load_music_index()
    rows = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))
    targets = [(i, r) for i, r in enumerate(rows) if r["video_id"] in trs]
    if not args.all:
        already = sum(1 for _, r in targets if r.get("tag_source", "").startswith("audio"))
        if already:
            log.info("skipping %d rows already retagged from audio (--all to redo)", already)
        targets = [(i, r) for i, r in targets
                   if not r.get("tag_source", "").startswith("audio")]
    if args.limit:
        targets = targets[: args.limit]
    if not targets:
        raise SystemExit("No transcribed videos found in the master database.")

    speech = sum(1 for _, r in targets if trs[r["video_id"]].get("has_speech"))
    with_music = sum(1 for _, r in targets if r["video_id"] in music)
    licensed = sum(1 for _, r in targets
                   if music.get(r["video_id"]) and not music[r["video_id"]]["original"])
    log.info("%d transcribed rows to retag (%d with speech, %d without)",
             len(targets), speech, len(targets) - speech)
    log.info("music metadata on %d of them; %d use a licensed track (lyrics likely)",
             with_music, licensed)

    client = anthropic.Anthropic()
    import base64
    requests = []
    with_vision = 0
    for i, r in targets:
        text = user_content(r, trs[r["video_id"]], music.get(r["video_id"]))
        cover = cover_bytes(r["video_id"])
        if cover:
            with_vision += 1
            content = [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                             "data": base64.b64encode(cover).decode()}},
                {"type": "text", "text": text + "\n\nThe image above is this video's opening frame."},
            ]
            schema = TAG_SCHEMA_VISION
        else:
            content = text
            schema = TAG_SCHEMA
        requests.append({
            "custom_id": f"a-{i}",
            "params": {
                "model": MODEL, "max_tokens": 2000,
                "system": [{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
                "output_config": {"format": {"type": "json_schema", "schema": schema}},
                "messages": [{"role": "user", "content": content}],
            },
        })
    log.info("%d of %d requests include the opening frame", with_vision, len(requests))

    if args.dry_run:
        i, r = targets[0]
        log.info("DRY RUN — %d requests would be sent. Example prompt:\n%s",
                 len(requests), requests[0]["params"]["messages"][0]["content"][:700])
        return

    state = ROOT / "output" / "retag_audio.batch_state.json"
    if state.exists():
        batch_id = json.loads(state.read_text())["batch_id"]
        log.info("Resuming batch %s", batch_id)
    else:
        b = client.messages.batches.create(requests=requests)
        state.write_text(json.dumps({"batch_id": b.id, "n": len(requests)}))
        batch_id = b.id
        log.info("Submitted batch %s (%d requests)", batch_id, len(requests))

    while True:
        b = client.messages.batches.retrieve(batch_id)
        c = b.request_counts
        log.info("batch %s: processing=%d succeeded=%d errored=%d",
                 b.processing_status, c.processing, c.succeeded, c.errored)
        if b.processing_status == "ended":
            break
        time.sleep(30)

    snap = MASTER.with_name(f"master_before_audio_{date.today().isoformat()}.csv")
    if not snap.exists():
        shutil.copy(MASTER, snap)
        log.info("snapshot -> %s", snap.name)

    changed = Counter()
    applied = 0
    for result in client.messages.batches.results(batch_id):
        idx = int(result.custom_id.split("-", 1)[1])
        if result.result.type != "succeeded" or not (0 <= idx < len(rows)):
            continue
        msg = result.result.message
        if msg.stop_reason == "refusal":
            continue
        try:
            data = json.loads(next(b_.text for b_ in msg.content if b_.type == "text"))
        except (StopIteration, json.JSONDecodeError):
            continue
        for d in DIMS:
            if rows[idx][d] != data[d]:
                changed[d] += 1
            rows[idx][d] = data[d]
        for d in VIS_DIMS:
            if d in data:
                rows[idx][d] = data[d]
        rows[idx]["tag_source"] = "audio+visual" if "visual_hook" in data else "audio"
        applied += 1

    extra = [c for c in ["visual_hook", "onscreen_text", "tag_source"] if c not in MASTER_FIELDS]
    fields = MASTER_FIELDS + extra
    for r in rows:
        r.setdefault("tag_source", "caption")
        r.setdefault("visual_hook", "")
        r.setdefault("onscreen_text", "")
    with open(MASTER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    log.info("Retagged %d rows from audio. Changes: %s", applied, dict(changed))
    log.info("  (a change means the caption-only tag was wrong and audio corrected it)")

    for r in rows:
        r["views"] = to_int(r["views"])
        r.setdefault("_url", r.get("url", ""))
    (ROOT / "output" / "data_summary.txt").write_text(summarize(rows, 0) + "\n")
    log.info("Summary regenerated. Push new tags to Supabase with: "
             "./venv/bin/python pipeline/export_supabase.py")


if __name__ == "__main__":
    main()
