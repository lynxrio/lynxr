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
import urllib.parse
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
        "wrapper_removed": {"type": "string", "description": "the framing you discarded before extracting the format, e.g. 'portfolio intro presenting the ad as sample work'. EMPTY STRING if the video was not wrapped."},
    },
    "required": ["name", "beats", "product_entry", "why_it_works", "wrapper_removed"],
}

FORMAT_SYSTEM = """You extract the REUSABLE STRUCTURE of a short-form video.

You are not summarising the video. You are identifying the skeleton another
creator could fill with completely different subject matter and still get the
same effect.

Strip the topic entirely. "3 signs you're dehydrated" is not a format about
hydration — it is a contrarian hook, a three-item list, a visual reset between
items, the most surprising item held for last, then a soft CTA. That skeleton
is the format.

Be specific about what each beat DOES structurally, never about what it says.

SOME VIDEOS HAVE ANOTHER VIDEO INSIDE THEM. A creator's portfolio piece — "I
make UGC for brands, here's one I shot for a client, take a look" — is a FRAME
around an ad. So is a reaction, a stitch, a duet, a screen-recorded clip with
commentary over it, or "watch this ad I made".

In all of those the reusable format is the INNER video. Extract the ad and
discard the presenting. Get this wrong and the creator who reuses the format
opens their own video by announcing that they make videos for brands — which
is a portfolio piece about them, not an ad for the product they were paid to
sell. The frame is that creator's business model, not a format.

Name what you discarded in `wrapper_removed`, or leave it empty when the video
was not wrapped. If the frame is ALL there is — someone talking about their
work with no inner piece to pull out — then keep it and say so there."""


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
            "minItems": 1,          # belt and braces: an empty beat list is not a script
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


COVER_BUCKET = "lynxr-covers"


def make_cover(media, dest):
    """One small JPEG from the source video, for telling scripts apart.

    A creator with twenty entries cannot remember which link was which, and the
    rows fall back to a raw URL whenever the title fails to hydrate. A frame
    from the video itself is the one label that always works.

    Taken at 1s rather than 0s: the very first frame of a short-form video is
    routinely black, a platform splash, or a half-drawn caption.
    """
    out = dest / "cover.jpg"
    r = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", "1", "-i", str(media),
         "-frames:v", "1", "-vf", "scale='min(360,iw)':-2", "-q:v", "6", str(out)],
        capture_output=True, timeout=60)
    if r.returncode != 0 or not out.exists() or out.stat().st_size < 500:
        return None
    return out.read_bytes()


def upload_cover(key, name, blob):
    """Put the cover in a PUBLIC bucket and return its URL.

    Public because these are frames of already-public videos, and because a
    signed URL would expire and leave the row blank later. Storing the bytes on
    the creator's row instead was the alternative and it is worse: that row is
    re-fetched on tab focus and every 90 seconds, so fifty covers would be a
    few hundred KB of repeated mobile traffic. A URL is cached by the browser.
    """
    path = f"{COVER_BUCKET}/{name}.jpg"
    req = urllib.request.Request(f"{SB_URL}/storage/v1/object/{path}", method="POST")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "image/jpeg")
    req.add_header("x-upsert", "true")     # a re-run should replace, not 409
    req.data = blob
    with urllib.request.urlopen(req, timeout=120, context=SSL_CTX) as r:
        r.read()
    return f"{SB_URL}/storage/v1/object/public/{path}"


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def api_reason(e):
    s = str(e)
    m = s.split("'message': '")
    return (m[1].split("'")[0] if len(m) > 1 else s)[:90]


def platform_of(url):
    for p in ("tiktok", "instagram", "facebook", "youtube"):
        if p in (url or ""):
            return p
    return "other"


# THE FOUR PLATFORMS. Mirrors PLATFORMS in creator.js — change one, change the
# other. This is the copy that counts: the queue is a field inside a row the
# creator owns, so the browser check can be walked around from the console, and
# an off-platform link otherwise costs a download, a Whisper pass and four model
# calls before failing on something unrelated.
# Matched on the HOSTNAME. `platform_of` above is a substring test on the whole
# URL and is fine for LABELLING a row we already accepted, but it would let
# `evil.com/?ref=tiktok.com` through as a gate.
SUPPORTED_HOSTS = ("tiktok.com", "instagram.com",
                   "facebook.com", "fb.watch", "fb.com",
                   "youtube.com", "youtu.be")

# Shown to the creator in the app, so it reads as an answer rather than a fault.
OFF_PLATFORM_NOTE = ("lynxr only reads TikTok, Instagram, Facebook and YouTube "
                     "links. Nothing was used from your allowance.")


def supported_url(url):
    """True if this is a link we accept. Subdomains count (vm.tiktok.com,
    m.facebook.com); a domain that merely ends in one of these words does not."""
    try:
        host = urllib.parse.urlsplit(str(url or "").strip()).hostname or ""
    except ValueError:
        return False
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return any(host == d or host.endswith("." + d) for d in SUPPORTED_HOSTS)


# Tokens spent this run, per model. Cost per script is the number that decides
# whether opening the doors to 100 creators is sane, and it cannot be guessed
# from the outside: four calls, three of them Opus, one carrying six images.
USAGE = {}


# Anthropic's minimum cacheable prefix on Opus 5. Below it a cache_control block
# is SILENTLY IGNORED — no error, no cache entry, cache_creation_input_tokens
# just comes back 0 — so this threshold is worth knowing before assuming a
# prompt caches.
#
# THE PREFIX IS NOT JUST THE SYSTEM TEXT. It is tools -> system -> messages, and
# the json_schema passed through output_config lands in it too, worth ~190
# tokens on these calls. That gap decides one of the three:
#
#                    system text   actual cached prefix
#     TAG_SYSTEM        1848              2038
#     ADAPT_SYSTEM       640               830
#     FORMAT_SYSTEM      491               681   <- system alone is UNDER 512
#
# So FORMAT_SYSTEM caches even though its prompt is 21 tokens short of the
# minimum on its own. Measured live, cold-then-warm, on 2026-08-16: all three
# wrote on the first call and read back the identical token count on the second.
# Do not "optimise" by dropping the marker from the short one — check the whole
# prefix, not the prompt.
CACHE_MIN_TOKENS = 512


def sys_block(text):
    """The system prompt, marked cacheable.

    These calls all send the same system prompt every time and differ only in
    the user turn, which is the exact shape prompt caching is for: the prefix is
    identical, so after the first call it is read back at about a tenth of the
    input price instead of being re-processed in full.

    Worth it here because the worker drains a BATCH — several queued scripts run
    back to back, seconds apart, well inside the 5-minute window. The default
    TTL is deliberate: the 1-hour variant costs 2x to write instead of 1.25x and
    only pays if scripts keep arriving 5-60 minutes apart, which is a bet on a
    traffic pattern this app does not have yet.

    Measured: the three prefixes total ~3,550 tokens per script. Warm they cost
    a tenth of that, saving about $0.016 a script at Opus 5 input rates; cold
    they cost 1.25x, about $0.004 more. So it pays from the second script in any
    5-minute window and the downside on a lone script is fractions of a cent.
    """
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


class _Metered:
    """A client whose calls get costed even when another module makes them.

    analyze_frames() lives in analyze_visuals.py, takes a client, and returns
    only its parsed JSON — so the shot-analysis call, which carries six images
    and is the most expensive input in the run, never reached note_usage and the
    per-script figure read low. Wrapping the client is the least invasive fix:
    analyze_visuals.py is shared with the scraping pipelines and has no business
    knowing about this one's accounting.
    """

    def __init__(self, inner):
        self._inner = inner

    def create(self, **kw):
        msg = self._inner.create(**kw)
        note_usage(kw.get("model") or MODEL, msg)
        return msg


class MeteredClient:
    def __init__(self, inner):
        self.messages = _Metered(inner.messages)


def note_usage(model, msg):
    u = getattr(msg, "usage", None)
    if not u:
        return
    d = USAGE.setdefault(model, {"in": 0, "out": 0, "calls": 0, "write": 0, "read": 0})
    d["in"] += getattr(u, "input_tokens", 0) or 0
    d["out"] += getattr(u, "output_tokens", 0) or 0
    # Cached tokens are reported SEPARATELY from input_tokens, not inside it —
    # so a run that caches well shows a small `in` and the rest here. Summing
    # only `in` would read as a huge saving that is really just a moved number.
    d["write"] += getattr(u, "cache_creation_input_tokens", 0) or 0
    d["read"] += getattr(u, "cache_read_input_tokens", 0) or 0
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
            # Cache writes bill at 1.25x input, reads at 0.1x. Charging both at
            # the plain input rate would under-report a cold run and wildly
            # over-report a warm one — the two states differ by ~12x on the
            # cached span, which is the whole point of measuring this.
            cost = (d["in"] / 1e6 * rates[0]
                    + d["write"] / 1e6 * rates[0] * 1.25
                    + d["read"] / 1e6 * rates[0] * 0.10
                    + d["out"] / 1e6 * rates[1])
            total += cost
            money = f"  ${cost:.4f}"
        else:
            priced = False
            money = "  (no price on file)"
        cached = (f", cache {d['write']}w/{d['read']}r" if (d["write"] or d["read"]) else "")
        log.info("  tokens %s: %d in / %d out%s over %d call%s%s  [%s]",
                 model, d["in"], d["out"], cached, d["calls"],
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
        system=sys_block(system),
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
    # yt-dlp has no real title to report for an Instagram post, so it
    # SYNTHESISES one — "Video by stephyapps" — and puts the actual caption in
    # `description`. Preferring `title` blindly filed every creator-submitted
    # Instagram video into lynxr_videos under that placeholder. Verified on a
    # live reel: title "Video by stephyapps", description "this is so goated
    # omg… (not me swallowing the longan pit by accident)". YouTube and TikTok
    # do report real titles, so the placeholder test leaves them alone.
    title = str(d.get("title") or "").strip()
    if not title or re.fullmatch(r"video by \S+", title, re.I):
        title = str(d.get("description") or "").strip()
    return {
        "video_id": str(d.get("id") or ""),
        "creator": str(d.get("uploader_id") or d.get("uploader") or d.get("channel") or "").lstrip("@"),
        "title": title[:300],
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


def process_one(a, creator, aclient, key):
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
        # Before anything billable: the cover is free, and a source that fails
        # at the model steps is exactly the one a creator needs to recognise.
        try:
            blob = make_cover(media, td)
            if blob:
                src["cover"] = upload_cover(
                    key, hashlib.sha1(canon_url(url).encode()).hexdigest()[:20], blob)
        except Exception as e:  # noqa: BLE001
            log.warning("  -> no cover: %s", api_reason(e))
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
                src["shots"] = analyze_frames(MeteredClient(aclient), frames)["shots"]
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
                system=sys_block(TAG_SYSTEM),
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
    #
    # NO BRAND IS A VALID, FINISHED RESULT (owner, 2026-08-13). A creator with a
    # brand-new account has nothing to adapt FOR, and making them set a company
    # up before they can see anything is the wall that lost us a live account
    # once already. So a link with no brandId is a first-class request: read the
    # video, hand back its actual script and structure, and stop there. The app
    # then offers to rewrite it for a company, which is the point at which
    # asking for one is a favour rather than a toll gate.
    #
    # Everything above this line has already run, so the entry carries the
    # verbatim transcript, the shot list, the tags and the extracted format —
    # which is the whole "here is what this video actually is" answer. Only the
    # rewrite needs a brand, and the rewrite is what gets skipped.
    if not a.get("brandId"):
        a.pop("note", None)
        return

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
        # If the format step stripped a wrapper, say so again here. The source
        # digest below still contains the WHOLE original — including the
        # portfolio intro — and left unsaid the model drifts back to it and
        # writes the frame it was supposed to discard.
        wrapper = (a.get("format") or {}).get("wrapper_removed") or ""
        frame = (f"\n=== IGNORE THE FRAMING ===\nThe original is wrapped in: {wrapper}\n"
                 "That framing is NOT part of the format. It appears in the transcript and "
                 "shots below — skip past it and adapt only the piece inside. Never open with "
                 "the creator introducing themselves or their work.\n" if wrapper else "")
        prompt = ("Adapt this format for the brand below.\n\n"
                  f"=== DELIVERY ===\n{mode}\n{frame}\n"
                  f"=== FORMAT TO REUSE ===\n{json.dumps(a['format'], indent=1)}\n\n"
                  f"=== ORIGINAL VIDEO (for reference — do NOT reuse its topic) ===\n{source_digest(a)}\n\n"
                  f"=== BRAND ===\n{brand_digest(brand, creator)}")
        # A script with no beats is not a script, and the schema cannot catch
        # it: the model can return a perfectly valid SHELL — a real fit, a real
        # fit_reason, a hook — and then `beats: []`, `cta: ""`, caption
        # "placeholder". Nothing downstream looked, so the entry went "done"
        # and the creator opened a card headed "Your script" with nothing
        # underneath it. Seen live on 2026-08-12 against a good source: 722
        # characters of transcript, 15 segments, 6 shots, fit 0.88.
        #
        # Ask once more before giving up. It is one Opus call against a retry
        # that usually works, versus handing someone an empty script or making
        # them wait out the six-hour cooldown for the same answer.
        ad = structured(aclient, ADAPT_SYSTEM, ADAPT_SCHEMA, prompt, max_tokens=4000)
        if not (ad.get("beats") or []):
            log.warning("  -> adaptation came back with no beats; asking again")
            ad = structured(aclient, ADAPT_SYSTEM, ADAPT_SCHEMA,
                            prompt + "\n\n=== IMPORTANT ===\nYour last answer had an EMPTY "
                                     "`beats` array, which is unusable. Write the full beat "
                                     "list: one beat per moment of the format above, each with "
                                     "`say`, `do` and `show` filled in as the delivery requires.",
                            max_tokens=4000)
        if not (ad.get("beats") or []):
            raise RuntimeError("the model returned a script with no beats")
        a["adaptation"] = ad
    except Exception as e:  # noqa: BLE001
        notes.append(f"adaptation failed: {api_reason(e)}")

    if notes:
        a["note"] = "; ".join(notes)[:200]
    else:
        a.pop("note", None)

    # An entry with no script is a FAILURE, not a finished job. Left as "done"
    # it renders as a "source only" card with no Try again button, and nothing
    # ever picks it up again: wants_work() only reconsiders "error" entries
    # (or "done" ones under --redo-ai, which the launchd agent does not pass).
    # Raising hands it to main(), which marks it error — so the creator gets a
    # Try again button and the cooldown retries it on its own.
    # ...but only when a rewrite was actually asked for. An ORIGINAL-script
    # entry is
    # finished the moment the source is read (see above), and has no beats by
    # design — raising here would mark every one of them an error.
    if a.get("brandId") and not ((a.get("adaptation") or {}).get("beats") or []):
        raise RuntimeError(a.get("note") or "no script was produced")


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
    ap.add_argument("--backfill-covers", action="store_true",
                    help="give existing scripts a cover frame and exit. No model calls.")
    ap.add_argument("--cap", type=int, default=int(os.environ.get("SCRIPT_CAP", 50)),
                    help="most scripts one creator may ever have written (0 = unlimited). "
                         "Keep in step with SCRIPT_CAP in creator.js")
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

    if args.backfill_covers:
        # Scripts written before covers existed still show a bare URL, which is
        # the whole problem covers solve. Re-fetching just the video and pulling
        # one frame costs nothing but bandwidth — no model call, no cap spend,
        # and the script itself is left exactly as it is.
        done = failed = 0
        for row in sb(key, "/rest/v1/lynxr_creators?select=id,data"):
            data, touched = row["data"], []
            for a in (data.get("adaptations") or []) + (data.get("trash") or []):
                src = a.get("source") or {}
                if src.get("cover") or not a.get("sourceUrl"):
                    continue
                try:
                    with tempfile.TemporaryDirectory() as td_s:
                        td = Path(td_s)
                        media, err = download_video(a["sourceUrl"], td)
                        if not media:
                            raise RuntimeError(err or "download failed")
                        blob = make_cover(media, td)
                        if not blob:
                            raise RuntimeError("no frame")
                        a.setdefault("source", {})["cover"] = upload_cover(
                            key, hashlib.sha1(canon_url(a["sourceUrl"]).encode()).hexdigest()[:20], blob)
                    touched.append(a)
                    done += 1
                    log.info("  cover: %s", a["sourceUrl"][:60])
                except Exception as e:  # noqa: BLE001
                    failed += 1
                    log.warning("  no cover for %s — %s", a["sourceUrl"][:50], api_reason(e))
            if touched:
                # Trash entries are grafted by id the same way; graft_adaptations
                # matches on id and leaves everything it does not recognise.
                graft_adaptations(key, row["id"], touched)
        log.info("backfill done: %d covered, %d failed", done, failed)
        return

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
        # THE CAP, enforced where the money is spent. creator.js checks it too,
        # but that check is a courtesy: the queue is a field inside a row the
        # creator owns, so anyone with the browser console can append a
        # hundred more. Four model calls each, three on Opus, ~$0.12 a script —
        # an uncapped queue is the one thing here that can run up a real bill
        # unattended. Allowance is the OLDEST `cap` adaptations by addedAt, so
        # it cannot be reset by deleting finished ones.
        allowed = set()
        if args.cap:
            # Trashed scripts COUNT. Each was four model calls that were paid
            # for, so deleting one must not buy another — otherwise the cap
            # limits how many you keep, not how many you spend. The app moves
            # deletions to `trash` rather than dropping them for this reason.
            in_order = sorted((data.get("adaptations") or []) + (data.get("trash") or []),
                              key=lambda a: a.get("addedAt") or "")
            allowed = {id(a) for a in in_order[:args.cap]}
            over = [a for a in in_order[args.cap:] if wants_work(a)]
            if over:
                for a in over:
                    a["status"] = "error"
                    a["note"] = (f"This account has used its {args.cap} scripts. "
                                 "Ask us to raise the limit.")
                log.info("[%s] refusing %d over the %d-script cap",
                         data.get("name") or cid[:8], len(over), args.cap)
                graft_adaptations(key, cid, over)

        # OFF-PLATFORM LINKS, refused before anything is spent — the same
        # allowlist creator.js applies at the paste box, enforced here because
        # that one lives in a row the creator owns and the console can walk
        # around it. A Netflix or news URL otherwise costs a download, a Whisper
        # pass and four model calls before failing on something unrelated.
        # Only WRITTEN when the note is not already there: an "error" entry
        # becomes eligible again once it cools, and re-marking it every pass
        # would be an endless write loop for no change.
        off = [a for a in (data.get("adaptations") or [])
               if wants_work(a) and not supported_url(a.get("sourceUrl"))]
        fresh_off = [a for a in off if a.get("note") != OFF_PLATFORM_NOTE]
        if fresh_off:
            for a in fresh_off:
                a["status"] = "error"
                a["note"] = OFF_PLATFORM_NOTE
            log.info("[%s] refusing %d off-platform link(s)",
                     data.get("name") or cid[:8], len(fresh_off))
            graft_adaptations(key, cid, fresh_off)

        ready = sorted((a for a in (data.get("adaptations") or [])
                        if wants_work(a) and supported_url(a.get("sourceUrl"))
                        and (not args.cap or id(a) in allowed)),
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
                process_one(a, data, aclient, key)
                a["status"] = "done"
                a["processedAt"] = now_iso()
                changed = True
                touched.append(a)
                brand = next((b for b in (data.get("brands") or [])
                              if b.get("id") == a.get("brandId")), {})
                upsert_source(key, a)
                upsert_video(key, a)          # and into the main video database
                ad = a.get("adaptation") or {}
                # An original-script entry has no fit and no beats BY DESIGN — it is
                # the source read back, not a rewrite. Logging it as "fit=—, 0
                # beats" alongside real failures made a working feature look
                # like a broken one.
                if not a.get("brandId"):
                    src = a.get("source") or {}
                    log.info("  -> source only (no brand): %d shots, %s transcript",
                             len(src.get("shots") or []),
                             "spoken" if (src.get("script") or {}).get("has_speech") else "silent")
                else:
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
