#!/usr/bin/env python3
"""Creator side: turn a pasted source link into a brand-adapted script.

WHY THIS EXISTS
---------------
The creator app (creator.html) is static — it can't run Whisper or call the
model. A creator pastes a link, picks one of their brands, and the app queues
an ADAPTATION on their own `lynxr_creators` row. This worker, run on the
owner's machine like every other pipeline stage, does the work:

    queued adaptation
      -> download the source (yt-dlp)
      -> Whisper verbatim script + segments        (local, free)
      -> frames at beat starts -> shot list        (analyze_visuals)
      -> locked-taxonomy tags                      (retag_with_audio)
      -> EXTRACT THE FORMAT: the reusable structure, not the topic
      -> ADAPT: rewrite that structure for the creator's brand
    -> written back -> the creator sees hook, beats, shot list, on-screen
       text and CTA in the app.

Spec: output/LYNXR_SPEC_v2.md §4 (format extraction), §4.1 (family/format),
§6 (adaptation), §6.1 (fit score — refuse a bad pairing rather than force it).

Format extraction and adaptation need ANTHROPIC_API_KEY. Without it the
transcript and shot list still land and the entry says what was skipped.

Safe to re-run: only status == "queued" is touched (plus "error" after the
cooldown). Failures mark the entry and keep going.

Usage:
    python process_adaptations.py             # everything queued
    python process_adaptations.py --no-ai     # transcript only, no spend
    python process_adaptations.py --redo-ai   # retry entries whose AI step failed
"""

import argparse
import base64
import hashlib
import json
import logging
import os
import re
import ssl
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

import urllib.error
import urllib.request

from transcribe import MODEL as WHISPER_MODEL
from transcribe import fetch_audio, transcribe
from analyze_visuals import analyze as analyze_frames
from analyze_visuals import download_video, extract_frames, frame_times, yt_dlp_bin
from retag_with_audio import MODEL as TAG_MODEL
from retag_with_audio import SYSTEM as TAG_SYSTEM
from retag_with_audio import user_content
from taxonomy import TAG_SCHEMA, TAG_SCHEMA_VISION, length_bucket

ROOT = Path(__file__).parent.parent
SB_URL = "https://esakjfogplfszievvabi.supabase.co"
MODEL = "claude-opus-5"

(ROOT / "output").mkdir(exist_ok=True)   # gitignored: absent in a fresh CI checkout

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout),
                              logging.FileHandler(ROOT / "output" / "adaptations.log")])
log = logging.getLogger("adaptations")


# ---------------------------------------------------------------- format
# Spec §4.1: FAMILY is the locked taxonomy pair (format_type × hook_pattern),
# which the tagging pass already produces. FORMAT is the finer structure that
# lives inside it — the reusable skeleton, deliberately stripped of topic so it
# can carry to a different product.
FORMAT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "name": {"type": "string", "description": "short human name for this format, topic-free, e.g. 'Contrarian three-item list with surprise last'"},
        "beats": {
            "type": "array",
            "description": "the structural skeleton in order, topic removed",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "role": {"type": "string", "description": "what this beat DOES structurally, e.g. 'contrarian hook', 'item 1 of 3', 'surprise payoff', 'soft CTA'"},
                    "seconds": {"type": "number", "description": "approximate duration of this beat"},
                },
                "required": ["role", "seconds"],
            },
        },
        "product_entry": {"type": "string", "enum": ["early", "mid", "late", "none"],
                          "description": "where the product is introduced"},
        "why_it_works": {"type": "string", "description": "one sentence on the mechanism — what keeps attention"},
    },
    "required": ["name", "beats", "product_entry", "why_it_works"],
}

FORMAT_SYSTEM = """You extract the REUSABLE STRUCTURE of a short-form video.

You are not summarising the video. You are identifying the skeleton another
creator could fill with completely different subject matter and still get the
same effect.

Strip the topic entirely. "3 signs you're dehydrated" is not a format about
hydration — it is a contrarian hook, a three-item list, a visual reset between
items, the most surprising item held for last, then a soft CTA. That skeleton
is the format.

Be specific about what each beat DOES structurally, never about what it says."""


# ------------------------------------------------------------ adaptation
ADAPT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "fit": {"type": "number", "description": "0-1, how well this format suits this product. Below 0.45 means do not force it."},
        "fit_reason": {"type": "string", "description": "one sentence explaining the fit score"},
        "hook": {"type": "string", "description": "the first line, under ~12 words. The spoken opener when delivery is 'spoken'; the opening on-screen text card when it is 'silent'."},
        "beats": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "t": {"type": "string", "description": "timing, e.g. '0-3s'"},
                    "say": {"type": "string", "description": "exact words to say. EMPTY STRING for a silent video — never invent a voiceover the format did not have."},
                    "do": {"type": "string", "description": "direction: framing, expression, gesture, prop, movement. Imperative."},
                    "show": {"type": "string", "description": "on-screen text for this beat, verbatim — the caption the viewer reads. Required on every beat of a silent video, since it is what carries the meaning. Empty string only when the beat genuinely has none."},
                },
                "required": ["t", "say", "do", "show"],
            },
        },
        "delivery": {"type": "string", "enum": ["spoken", "silent"],
                     "description": "'spoken' if the creator talks to camera; 'silent' if the video carries itself on action, on-screen text and audio, with no voiceover. Match the source."},
        "cta": {"type": "string", "description": "the closing call to action. Spoken when delivery is 'spoken'; the final on-screen card when it is 'silent'. Do NOT invent a discount or referral code."},
        "caption": {"type": "string", "description": "suggested post caption"},
    },
    "required": ["fit", "fit_reason", "hook", "beats", "delivery", "cta", "caption"],
}

ADAPT_SYSTEM = """You adapt a proven short-form video FORMAT to a specific product.

Rules:

1. Keep the STRUCTURE. Same beat roles, same order, same pacing, same place
   the product enters. That structure is the thing being reused.
2. Replace the TOPIC completely. Never mention the original video's subject.
3. Write words the creator actually says out loud. Spoken register, contractions,
   no marketing voice, no "in today's video", no "let's dive in".
4. `do` is direction, not description: "hold the phone up to camera, fills the
   frame", "react with mock outrage, hands up", "walk out of frame left".
   Never "A person is..." or "The video shows...".
5. `show` is literal on-screen text, kept short enough to read in passing.
6. IF THE SOURCE HAS NO SPEECH, the adaptation has no speech. Set
   delivery="silent", leave every `say` empty, and carry the whole thing on
   `do` and `show`. This is the case where people cheat by bolting on a
   voiceover; do not. A silent format works BECAUSE it is silent — it is read,
   not heard, and it survives being watched muted.
   A silent beat must be more specific, not less:
     - `do` is the exact action, framing and movement for that moment, precise
       enough to film without seeing the original.
     - `show` is the literal on-screen caption for that moment, verbatim, short
       enough to read before the cut.
   Give a silent video MORE beats than a spoken one — roughly one per shot or
   text change — because the cuts are the script.
7. Score `fit` honestly. If the format's mechanism depends on something this
   product does not have — a visible before/after, a physical object, a
   dramatic reveal — score it BELOW 0.45 and say why in fit_reason. A forced
   adaptation produces a bad video and poisons the format's performance record.
   Refusing is the correct answer more often than people expect."""


def load_env(path):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return env


def sb(key, path, method="GET", body=None, raw=False):
    req = urllib.request.Request(SB_URL + path, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    with urllib.request.urlopen(req, timeout=120, context=SSL_CTX) as r:
        data = r.read()
    return data if raw else (json.loads(data) if data else None)


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def api_reason(e):
    s = str(e)
    m = s.split("'message': '")
    return (m[1].split("'")[0] if len(m) > 1 else s)[:90]


def platform_of(url):
    for p in ("tiktok", "instagram", "youtube"):
        if p in (url or ""):
            return p
    return "other"


# Tokens spent this run, per model. Cost per script is the number that decides
# whether opening the doors to 100 creators is sane, and it cannot be guessed
# from the outside: four calls, three of them Opus, one carrying six images.
USAGE = {}


def note_usage(model, msg):
    u = getattr(msg, "usage", None)
    if not u:
        return
    d = USAGE.setdefault(model, {"in": 0, "out": 0, "calls": 0})
    d["in"] += getattr(u, "input_tokens", 0) or 0
    d["out"] += getattr(u, "output_tokens", 0) or 0
    d["calls"] += 1


# USD per MILLION tokens, input/output. Anthropic list prices, 2026-08-12.
# Update when prices change — a stale number here is worse than none, because it
# reads as measured when it isn't.
PRICES = {
    "claude-opus-5":  (5.00, 25.00),
    "claude-haiku-4-5": (1.00, 5.00),
}


def price_of(model):
    """Rates for a model id, tolerating a dated suffix (…-20251001)."""
    for name, rates in PRICES.items():
        if model.startswith(name):
            return rates
    return None


def log_usage(label):
    """Tokens AND dollars per script.

    Cost per script is the number that decides whether opening the doors is
    sane, and it cannot be worked out from the outside: four calls, three of
    them Opus, one carrying six images. Printing the dollar figure on every run
    means the answer is in the log the first time a real script is written,
    instead of being reconstructed from token counts afterwards.
    """
    if not USAGE:
        return
    total = 0.0
    priced = True
    for model, d in USAGE.items():
        rates = price_of(model)
        if rates:
            cost = d["in"] / 1e6 * rates[0] + d["out"] / 1e6 * rates[1]
            total += cost
            money = f"  ${cost:.4f}"
        else:
            priced = False
            money = "  (no price on file)"
        log.info("  tokens %s: %d in / %d out over %d call%s%s  [%s]",
                 model, d["in"], d["out"], d["calls"],
                 "" if d["calls"] == 1 else "s", money, label)
    if len(USAGE) > 1 or not priced:
        log.info("  TOTAL %s: $%.4f%s", label, total,
                 "" if priced else " (+ unpriced models above)")


def first_text(msg):
    """The first text block of a response, whatever precedes it.

    Opus 5 can return a ThinkingBlock before the answer, and it does so
    adaptively — the same call site works one minute and raises
    'ThinkingBlock' object has no attribute 'text' the next. Reading
    content[0] blindly is therefore a bug that hides until a live run:
    format extraction died this way on the very first one (2026-08-11).
    analyze_visuals.py already filtered by type, which is why the shot list
    survived the same response shape."""
    for b in msg.content:
        if getattr(b, "type", None) == "text":
            return b.text
    raise RuntimeError("no text block in the model response")


_LITERAL_ESCAPE = re.compile(r"\\u([0-9a-fA-F]{4})")


def undouble(obj):
    r"""Repair a \uXXXX that survived JSON decoding as six literal characters.

    The model sometimes DOUBLE-escapes a non-ASCII character: it writes
    "\\u2192" where it means "→", and json.loads faithfully returns the literal
    text → rather than an arrow. Nothing downstream decodes it again, so it
    reaches the creator verbatim — creator.js renders format.name as a chip, and
    the first real script shipped "Reframe hook → personal anecdote spiral
    → …". One of the first two live scripts was affected.

    Repaired here, at the point every model call funnels through, rather than at
    the render site: the stored row is then correct for everything that reads it
    later (the shared source library, the agency app, any export).
    """
    if isinstance(obj, str):
        return _LITERAL_ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), obj)
    if isinstance(obj, list):
        return [undouble(v) for v in obj]
    if isinstance(obj, dict):
        return {k: undouble(v) for k, v in obj.items()}
    return obj


def structured(client, system, schema, content, max_tokens=3000):
    msg = client.messages.create(
        model=MODEL, max_tokens=max_tokens,
        system=[{"type": "text", "text": system}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
        messages=[{"role": "user", "content": content}])
    note_usage(MODEL, msg)
    return undouble(json.loads(first_text(msg)))


def source_digest(a):
    """What the model sees of the original: its words, its shots, its tags."""
    s = a.get("source") or {}
    parts = [f"Platform: {s.get('platform', 'unknown')}",
             f"Caption: {(s.get('caption') or '(none)')[:400]}",
             f"Length: {s.get('duration', '?')}s"]
    tags = s.get("tags") or {}
    if tags:
        parts.append("Tags: " + ", ".join(f"{k}={v}" for k, v in tags.items() if v))
    script = s.get("script") or {}
    if script.get("has_speech") and script.get("segments"):
        parts.append("SPOKEN SCRIPT (verbatim, with timings):")
        for st, en, txt in script["segments"][:40]:
            parts.append(f"  [{st}-{en}s] {txt}")
    else:
        parts.append("No speech — the video carries meaning visually.")
    shots = s.get("shots") or []
    if shots:
        parts.append("WHAT IS ON SCREEN:")
        for sh in shots:
            txt = (sh.get("onscreen_text") or "").strip()
            parts.append(f"  [{sh.get('t')}s] {sh.get('visual')}"
                         + (f" | text: \"{txt}\"" if txt else ""))
    return "\n".join(parts)


def brand_digest(brand, creator, code=""):
    parts = [f"Brand: {brand.get('name', '?')}",
             f"What it is: {brand.get('description') or '(not given)'}",
             f"Campaign objective: {brand.get('objective') or '(not given)'}",
             f"Niche: {brand.get('niche') or '(not given)'}"]
    if brand.get("site"):
        parts.append(f"Site: {brand['site']}")
    if creator.get("name"):
        parts.append(f"Creator delivering it: {creator['name']}")
    if creator.get("niches"):
        parts.append(f"Creator's usual niches: {', '.join(creator['niches'])}")
    # Tracking codes are PARKED, not deleted (owner, 2026-08-12). The model is
    # no longer told about one, so scripts stop ending in "use code ABCD1234"
    # while the product is still about proving the scripts are any good.
    #
    # The code is still ISSUED and stored on every adaptation, because
    # attribution cannot be applied retroactively (spec R3) — a code invented
    # later cannot be matched to a video that already went out. Re-enabling is
    # one line here plus the two render sites in creator.js.
    return "\n".join(parts)


def canon_url(u):
    """Same canonicalisation the apps use, so one video is one row."""
    from urllib.parse import urlparse, parse_qs
    try:
        p = urlparse(u if "://" in u else "https://" + u)
        host = p.hostname.lower().removeprefix("www.").removeprefix("m.")
        path = p.path.rstrip("/")
        key = ""
        if host == "youtu.be":
            key, host, path = "?v=" + path.lstrip("/"), "youtube.com", "/watch"
        elif host == "youtube.com" and parse_qs(p.query).get("v"):
            key = "?v=" + parse_qs(p.query)["v"][0]
        return host + path + key
    except Exception:  # noqa: BLE001
        return (u or "").rstrip("/")


def upsert_source(key, a):
    """Step 1's second half: the creator gets their script AND the source joins
    the Lynx library. One row per video; a second creator tagging the same
    video bumps tag_count rather than duplicating it.

    Every source goes in — the per-brand "is this a Lynx client?" opt-out was
    removed 2026-08-11 (owner's call): the whole point is one pooled database of
    what creators think is worth remaking. `consent` stays in the table so the
    column does not need dropping, pinned to 'full'. Nothing brand-identifying
    is written here, which is what makes pooling safe.

    Best-effort — a failure here must never cost the creator their script."""
    src = a.get("source") or {}
    body = {
        "canonical_url": canon_url(a.get("sourceUrl") or ""),
        "url": a.get("sourceUrl") or "",
        "platform": src.get("platform") or "",
        "last_seen_at": now_iso(),
        "consent": "full",   # every source joins the shared library — see note
        "script": src.get("script"),
        "shots": src.get("shots"),
        "tags": src.get("tags"),
        "format": a.get("format"),
    }
    try:
        # merge-duplicates so a re-tag refreshes the extraction rather than 409ing
        req = urllib.request.Request(
            SB_URL + "/rest/v1/lynxr_sources?on_conflict=canonical_url", method="POST")
        for h, v in (("apikey", key), ("Authorization", f"Bearer {key}"),
                     ("Content-Type", "application/json"),
                     ("Prefer", "resolution=merge-duplicates")):
            req.add_header(h, v)
        req.data = json.dumps(body).encode()
        urllib.request.urlopen(req, timeout=60, context=SSL_CTX).read()
    except Exception as e:  # noqa: BLE001
        log.warning("  source library upsert skipped: %s", str(e)[:90])


def fetch_meta(url):
    """Public counts and the platform's own id, straight from yt-dlp. Free — no
    API, no scrape — and it is what lets a creator-submitted video sit in
    lynxr_videos as a real row rather than one with zeroed metrics."""
    try:
        r = subprocess.run(
            [yt_dlp_bin(), "-q", "--no-warnings", "--skip-download",
             "--no-playlist", "--dump-single-json", url],
            capture_output=True, text=True, timeout=90)
        if r.returncode != 0 or not r.stdout.strip():
            return {}
        d = json.loads(r.stdout)
    except Exception as e:  # noqa: BLE001
        log.info("  metadata lookup skipped: %s", str(e)[:80])
        return {}
    return {
        "video_id": str(d.get("id") or ""),
        "creator": str(d.get("uploader_id") or d.get("uploader") or d.get("channel") or "").lstrip("@"),
        "title": str(d.get("title") or d.get("description") or "")[:300],
        "views": int(d.get("view_count") or 0),
        "likes": int(d.get("like_count") or 0),
        "comments": int(d.get("comment_count") or 0),
        "duration": float(d.get("duration") or 0),
    }


def upsert_video(key, a):
    """Put a creator-submitted source into the MAIN database alongside the
    scraped rows, so one creator's find becomes searchable Lynx-wide.

    Two deliberate choices:

    * `data_source = 'Creator'`. The column already carries provenance
      ('Scraped', or a client name), and every analysis that must not mix
      submissions with the scraped corpus can filter on it. Without a marker
      these rows would silently move the medians that shelf ranking depends on.
    * NO brand or creator identity is written. The source is a public video the
      creator merely found; which brand they were shopping it for stays in their
      own row. That separation is what makes pooling every source safe: the row
      records a public video, never who was shopping it or for whom.

    Best-effort: a failure must never cost the creator their script.
    """
    src = a.get("source") or {}
    meta = src.get("meta") or {}
    tags = src.get("tags") or {}
    url = a.get("sourceUrl") or ""
    vid = meta.get("video_id") or hashlib.sha1(canon_url(url).encode()).hexdigest()[:20]
    views = meta.get("views") or 0
    eng = ((meta.get("likes", 0) + meta.get("comments", 0)) / views * 100) if views else None
    script = src.get("script") or {}
    # process_one stores the LIST here (analyze_frames(...)["shots"]), not the
    # wrapper object — unwrapping it again raised AttributeError, and because
    # this runs inside main()'s try it flipped finished scripts to "error".
    shots = src.get("shots") or []

    row = {
        "platform": platform_of(url),
        "video_id": vid,
        "creator": meta.get("creator") or "",
        "title": meta.get("title") or "",
        "views": views,
        "likes": meta.get("likes") or 0,
        "comments": meta.get("comments") or 0,
        "engagement_rate": f"{eng:.2f}" if eng is not None else "",
        "format_type": tags.get("format_type") or "",
        "hook_pattern": tags.get("hook_pattern") or "",
        "niche_category": tags.get("niche_category") or "",
        "target_audience": tags.get("target_audience") or "",
        "data_source": "Creator",
        "url": url,
        "length_bucket": length_bucket(meta.get("duration") or src.get("duration") or 0),
        "visual_hook": tags.get("visual_hook") or "",
        "onscreen_text": tags.get("onscreen_text") or "",
        "hook_spoken": script.get("hook") or "",
        "transcript": (script.get("text") or "")[:900],
        "transcript_segments": json.dumps(script.get("segments") or []),
        "visual_cues": json.dumps([{"t": s.get("t"), "visual": s.get("visual"),
                                    "onscreen_text": s.get("onscreen_text", "")}
                                   for s in shots]),
    }
    try:
        req = urllib.request.Request(
            SB_URL + "/rest/v1/lynxr_videos?on_conflict=platform,video_id", method="POST")
        for h, v in (("apikey", key), ("Authorization", f"Bearer {key}"),
                     ("Content-Type", "application/json"),
                     ("Prefer", "resolution=merge-duplicates")):
            req.add_header(h, v)
        req.data = json.dumps(row).encode()
        urllib.request.urlopen(req, timeout=60, context=SSL_CTX).read()
        log.info("  -> added to the database as %s/%s (%s views)",
                 row["platform"], vid, f"{views:,}" if views else "no count")
    except Exception as e:  # noqa: BLE001
        log.warning("  database upsert skipped: %s", str(e)[:120])


def process_one(a, creator, aclient):
    """Fill adaptation `a` in place. Transcript always; AI steps need aclient."""
    url = a.get("sourceUrl")
    if not url:
        raise RuntimeError("no source URL on this adaptation")

    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        media, err = download_video(url, td)
        if not media:
            media, err2 = fetch_audio(url, td)   # video refused; audio still scripts it
            if not media:
                raise RuntimeError(f"download failed: {err or err2}")

        t = transcribe(str(media), WHISPER_MODEL)
        src = a.setdefault("source", {})
        src.update({
            "platform": platform_of(url),
            "meta": fetch_meta(url),          # public counts + the platform's id
            "duration": t["duration"],
            "script": {"hook": t["hook_spoken"], "duration": t["duration"],
                       "language": t["language"], "has_speech": t["has_speech"],
                       "text": t["text"], "segments": t["segments"]},
        })

        notes = []
        if not aclient:
            notes.append("transcript only — format + script need ANTHROPIC_API_KEY")
            a["note"] = "; ".join(notes)
            return

        frames = extract_frames(media, frame_times(t, t["duration"]), td)
        if frames:
            try:
                src["shots"] = analyze_frames(aclient, frames)["shots"]
            except Exception as e:  # noqa: BLE001
                notes.append(f"shot list failed: {api_reason(e)}")
        else:
            notes.append("no frames (audio-only source)")

        # Locked-taxonomy tags — the FAMILY half of spec §4.1.
        try:
            row = {"platform": src["platform"], "data_source": "Creator source",
                   "title": a.get("source", {}).get("caption", "")}
            text = user_content(row, t)
            if frames:
                img = base64.b64encode(frames[0][1].read_bytes()).decode()
                content = [
                    {"type": "image", "source": {"type": "base64",
                                                 "media_type": "image/jpeg", "data": img}},
                    {"type": "text", "text": text + "\n\nThe image above is the opening frame."},
                ]
                schema = TAG_SCHEMA_VISION
            else:
                content, schema = text, TAG_SCHEMA
            msg = aclient.messages.create(
                model=TAG_MODEL, max_tokens=2000,
                system=[{"type": "text", "text": TAG_SYSTEM}],
                output_config={"format": {"type": "json_schema", "schema": schema}},
                messages=[{"role": "user", "content": content}])
            note_usage(TAG_MODEL, msg)
            src["tags"] = undouble(json.loads(first_text(msg)))
        except Exception as e:  # noqa: BLE001
            notes.append(f"tags failed: {api_reason(e)}")

    # ---- format extraction (topic stripped) ----
    try:
        a["format"] = structured(
            aclient, FORMAT_SYSTEM, FORMAT_SCHEMA,
            "Extract the reusable format from this video.\n\n" + source_digest(a))
    except Exception as e:  # noqa: BLE001
        notes.append(f"format extraction failed: {api_reason(e)}")
        a["note"] = "; ".join(notes)
        return

    # ---- adaptation for the chosen brand ----
    brand = next((b for b in (creator.get("brands") or [])
                  if b.get("id") == a.get("brandId")), None)
    if not brand:
        notes.append("brand not found on this creator profile")
        a["note"] = "; ".join(notes)
        return
    try:
        # State the delivery outright rather than leaving it to be inferred from
        # an absent transcript — a missing section reads as "nothing to see",
        # and the model happily wrote a voiceover onto a silent format.
        silent = not ((a.get("source") or {}).get("script") or {}).get("has_speech")
        mode = ("The original video has NO SPOKEN WORDS. Set delivery=\"silent\", leave every "
                "`say` empty, and carry the whole thing on `do` and `show`. Give one beat per "
                "shot or on-screen text change, and put a literal caption in `show` on every "
                "single beat — that text IS the script here."
                if silent else
                "The original is spoken to camera. Set delivery=\"spoken\".")
        prompt = ("Adapt this format for the brand below.\n\n"
                  f"=== DELIVERY ===\n{mode}\n\n"
                  f"=== FORMAT TO REUSE ===\n{json.dumps(a['format'], indent=1)}\n\n"
                  f"=== ORIGINAL VIDEO (for reference — do NOT reuse its topic) ===\n{source_digest(a)}\n\n"
                  f"=== BRAND ===\n{brand_digest(brand, creator)}")
        a["adaptation"] = structured(aclient, ADAPT_SYSTEM, ADAPT_SCHEMA, prompt, max_tokens=4000)
    except Exception as e:  # noqa: BLE001
        notes.append(f"adaptation failed: {api_reason(e)}")

    if notes:
        a["note"] = "; ".join(notes)[:200]
    else:
        a.pop("note", None)


def graft_adaptations(key, cid, touched):
    """Write only the adaptations this pass touched onto the creator's CURRENT row.

    Writing `data` wholesale would roll back everything the creator did while
    this ran — a transcript plus two model calls can take minutes, and saving
    library entries during it is exactly what the app is for. So re-pull now and
    graft only what changed. Anything the creator deleted mid-run stays deleted.
    """
    if not touched:
        return
    fresh = sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}&select=data")[0]["data"]
    pending = {a.get("id"): a for a in touched}
    merged = []
    for a in fresh.get("adaptations") or []:
        merged.append(pending.pop(a.get("id"), a))
    for gone in pending:
        log.info("  (adaptation %s vanished during the run — dropped)", str(gone)[:8])
    fresh["adaptations"] = merged
    fresh["updatedAt"] = now_iso()
    sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}", method="PATCH", body={"data": fresh})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-ai", action="store_true",
                    help="transcript only — no format extraction or adaptation (no API spend)")
    ap.add_argument("--redo-ai", action="store_true",
                    help="also retry entries whose AI step failed (e.g. after a credit top-up)")
    ap.add_argument("--cooldown-hours", type=float, default=6,
                    help="min hours between retries of the same entry")
    ap.add_argument("--max-per-creator", type=int, default=2,
                    help="most adaptations to take from any one creator per run (0 = no cap)")
    ap.add_argument("--lease-minutes", type=float, default=25,
                    help="how long a claimed adaptation stays claimed before it is retryable")
    args = ap.parse_args()

    env = load_env(ROOT / ".env")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
    api_key = env.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    aclient = None
    if api_key and not args.no_ai:
        import anthropic
        aclient = anthropic.Anthropic(api_key=api_key)
    else:
        log.info("AI steps OFF (%s)", "--no-ai" if args.no_ai else "no ANTHROPIC_API_KEY")

    def cooled(a):
        last = a.get("attemptedAt") or ""
        if not last or not args.cooldown_hours:
            return True
        try:
            age = (datetime.now(timezone.utc)
                   - datetime.fromisoformat(last.replace("Z", "+00:00"))).total_seconds() / 3600
        except ValueError:
            return True
        return age >= args.cooldown_hours

    def abandoned(a):
        """A run killed mid-script (job timeout, crash, laptop sleep) leaves an
        adaptation claimed forever. Treat a claim older than the lease as dead
        so the next run picks it up instead of it silently never finishing."""
        held = a.get("claimedAt") or ""
        if not held:
            return True
        try:
            age = (datetime.now(timezone.utc)
                   - datetime.fromisoformat(held.replace("Z", "+00:00"))).total_seconds() / 60
        except ValueError:
            return True
        return age >= args.lease_minutes

    def wants_work(a):
        if a.get("status") == "queued":
            return True
        if a.get("status") == "running":
            return abandoned(a)
        if a.get("status") == "error":
            return cooled(a)
        return (args.redo_ai and a.get("status") == "done"
                and "failed" in (a.get("note") or "") and cooled(a))

    rows = sb(key, "/rest/v1/lynxr_creators?select=id,data")
    todo = [r["id"] for r in rows
            if any(wants_work(a) for a in (r["data"].get("adaptations") or []))]
    if not todo:
        log.info("nothing queued")
        return
    log.info("creators with queued adaptations: %d", len(todo))

    for cid in todo:
        row = sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}&select=id,data")[0]
        data = row["data"]

        # FAIRNESS. The worker is serial, so draining one creator's whole queue
        # before touching the next puts everyone else behind it — 30 pasted
        # links is ~40 minutes, past the job's 30-minute timeout, and the other
        # creators just watch "writing your script". Taking a couple per creator
        # per run serves the whole cohort on every pass instead.
        # OLDEST FIRST. The app unshifts new adaptations onto the front of the
        # array, so plain array order is newest-first — and slicing that under
        # the cap below would write the most recently pasted link first and
        # starve the earliest one for as many runs as it takes to reach it.
        # Sorting by addedAt makes the queue FIFO, which is both what a creator
        # expects and what makes the app's "ready in about N minutes" estimate
        # correct. Entries with no addedAt sort first — they predate the field.
        ready = sorted((a for a in (data.get("adaptations") or []) if wants_work(a)),
                       key=lambda a: a.get("addedAt") or "")
        batch = ready[:args.max_per_creator] if args.max_per_creator else ready
        if not batch:
            continue
        if len(ready) > len(batch):
            log.info("[%s] taking %d of %d queued — the rest next run",
                     data.get("name") or cid[:8], len(batch), len(ready))

        # CLAIM before spending anything. Nothing previously marked work as
        # in-flight: status stayed "queued" for the whole 1-2 minutes of
        # processing, so two triggers firing together (GitHub's cron and the
        # launchd fallback) would both do the same adaptation and bill twice.
        # This is a lease, not a transaction — PostgREST can't compare-and-swap
        # inside a jsonb blob — but it narrows the overlap from the entire run
        # to the few hundred ms between reading and claiming.
        for a in batch:
            a["status"] = "running"
            a["claimedAt"] = now_iso()
        graft_adaptations(key, cid, batch)

        changed = False
        touched = []
        for a in batch:
            log.info("[%s] %s -> %s", data.get("name", cid[:8]),
                     (a.get("sourceUrl") or "")[:52], a.get("brandName", "?"))
            a["attemptedAt"] = now_iso()
            try:
                process_one(a, data, aclient)
                a["status"] = "done"
                a["processedAt"] = now_iso()
                changed = True
                touched.append(a)
                brand = next((b for b in (data.get("brands") or [])
                              if b.get("id") == a.get("brandId")), {})
                upsert_source(key, a)
                upsert_video(key, a)          # and into the main video database
                ad = a.get("adaptation") or {}
                log.info("  -> fit=%s, %d beats%s", ad.get("fit", "—"),
                         len(ad.get("beats") or []),
                         f", note: {a['note']}" if a.get("note") else "")
                log_usage("this script")
                USAGE.clear()
            except Exception as e:  # noqa: BLE001
                a["status"] = "error"
                a["note"] = str(e)[:200]
                changed = True
                touched.append(a)
                log.error("  -> FAILED: %s", e)
        if changed:
            graft_adaptations(key, cid, touched)
    log.info("done")


if __name__ == "__main__":
    main()
