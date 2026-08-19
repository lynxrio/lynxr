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
cooldown, and "done" entries whose AI step failed for a reason that can clear
on its own — a dry credit balance, a rate limit, an overloaded API). Failures
mark the entry and keep going.

A failed AI step now stamps `aiFail` on the entry and is retried automatically
on a backoff keyed to WHY it failed. Nobody has to notice a lapsed Anthropic
balance and run --redo-ai by hand any more; that flag is now only for forcing a
"content" failure, which no timer can fix.

Usage:
    python process_adaptations.py             # everything queued, plus due retries
    python process_adaptations.py --no-ai     # transcript only, no spend
    python process_adaptations.py --redo-ai   # force EVERY failed AI step, now
"""

import argparse
import base64
import collections
import copy
import hashlib
import json
import logging
import os
import random
import re
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
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
from retag_with_audio import SYSTEM as TAG_SYSTEM
from retag_with_audio import user_content
from taxonomy import TAG_SCHEMA, TAG_SCHEMA_VISION, length_bucket
import envcfg  # the one place a secret or config value is read; see its docstring.

ROOT = Path(__file__).parent.parent
SB_URL = "https://esakjfogplfszievvabi.supabase.co"
MODEL = "claude-opus-5"
# The creator path's tagger is declared HERE, not imported from
# retag_with_audio, because that module's MODEL also drives the bulk
# re-tag of the 9,016-row lynxr_videos corpus (Batch API, latency
# irrelevant). Those two want different answers: this one is on a
# creator's critical path, that one is not.
TAG_MODEL = envcfg.get("TAG_MODEL", "claude-opus-5")
# Claude Opus 5 runs ADAPTIVE THINKING BY DEFAULT at effort "high" —
# unlike Opus 4.8/4.7, which stay off unless asked. This call is
# classification against a locked taxonomy whose decision procedure is
# spelled out line by line in TAG_SYSTEM; it is the least appropriate
# place in the pipeline for depth, and it is the only unbounded term in
# the call. "low" is not "off": disabling thinking on Opus 5 has two
# documented failure modes (a tool call written into visible text, and
# <thinking> tags leaking into the response), so cap the effort instead.
TAG_EFFORT = envcfg.get("TAG_EFFORT", "low")

# The SDK retries 408/409/429/5xx on its own with exponential backoff and
# jitter, honouring retry-after. Its default of 2 spends 1.4s before handing
# the creator a five-minute scheduled round trip; 5 spends ~14s, which covers a
# short overload episode without hammering a struggling API. Worst case on a
# hard-down API is ~14s per call — ~60s on a pass that fails everywhere, paid
# only on the failure path. Measured, not assumed: pipeline/test_ai_retry.py
# counts the requests against a local socket.
ANTHROPIC_MAX_RETRIES = int(envcfg.get("ANTHROPIC_MAX_RETRIES", "5"))


def anthropic_client(api_key, base_url=None):
    """The one place the model client is built, so its retry policy is a
    property of this pipeline rather than an SDK default — and so the test can
    point it at a local socket and count attempts instead of taking the docs'
    word for it."""
    import anthropic
    kw = {"api_key": api_key, "max_retries": ANTHROPIC_MAX_RETRIES}
    if base_url:
        kw["base_url"] = base_url
    return anthropic.Anthropic(**kw)


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


# ---------------------------------------------------------- fused (Step 13)
# Format extraction (9.4s) then adaptation (18.9s) is 28.3s of strictly
# sequential Opus 5 — the biggest remaining item once Steps 1-11 land. The
# second call genuinely depends on the first (the adapt prompt embeds
# a["format"] and re-states wrapper_removed), so they cannot simply run in
# parallel; fusing them into ONE call removes the round trip and the re-read
# of the format's own output. Estimated saving: 7-10s.
#
# It is also a real quality change — the two-step exists so the model strips
# the topic BEFORE it rewrites, and HANDOFF records that leaving the wrapper
# unsaid makes the model drift back into the original's framing. So this stays
# OFF by default; pipeline/ab_format_adapt.py is how the owner judges it
# without spending anything for real. Do not flip FUSE_FORMAT_ADAPT's default.
FUSE_FORMAT_ADAPT = envcfg.get("FUSE_FORMAT_ADAPT", "0") not in ("0", "", "false", "False")

FUSED_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"format": FORMAT_SCHEMA, "adaptation": ADAPT_SCHEMA},
    "required": ["format", "adaptation"],
}

FUSED_SYSTEM = (
    FORMAT_SYSTEM + "\n\n---\n\n" + ADAPT_SYSTEM + "\n\n---\n\n"
    "Do BOTH of the above in one pass, in order. First extract the reusable "
    "`format` — including `wrapper_removed` if the source is a portfolio "
    "piece, reaction, stitch or otherwise framed. Then, using the format you "
    "just extracted (not a re-read of it), write the `adaptation` for the "
    "brand below. If you named a wrapper_removed, the adaptation must not "
    "drift back into it — adapt the INNER format only, never the frame "
    "around it. Return both objects."
)


def delivery_mode_text(a):
    """'silent' vs 'spoken' instructions for the adapt prompt, shared by the
    normal two-step path and the fused one so they read identically to the
    model."""
    silent = not ((a.get("source") or {}).get("script") or {}).get("has_speech")
    return ("The original video has NO SPOKEN WORDS. Set delivery=\"silent\", leave every "
            "`say` empty, and carry the whole thing on `do` and `show`. Give one beat per "
            "shot or on-screen text change, and put a literal caption in `show` on every "
            "single beat — that text IS the script here."
            if silent else
            "The original is spoken to camera. Set delivery=\"spoken\".")


def fused_format_and_adapt(aclient, a, brand, creator, max_tokens=6000):
    """One Opus call producing both the format and its adaptation for `brand`.

    Behind FUSE_FORMAT_ADAPT (default off — see the comment above). Only
    called where there is exactly one adaptation for this video in the current
    pass (see main()'s grouping): fusing forgoes Step 7c's format reuse across
    siblings, so it only makes sense when there is no sibling to reuse it with.
    """
    prompt = ("Extract the format, then adapt it for the brand below, in one pass.\n\n"
              f"=== DELIVERY ===\n{delivery_mode_text(a)}\n\n"
              f"=== ORIGINAL VIDEO ===\n{source_digest(a)}\n\n"
              f"=== BRAND ===\n{brand_digest(brand, creator)}")
    out = structured(aclient, FUSED_SYSTEM, FUSED_SCHEMA, prompt, max_tokens=max_tokens)
    return out["format"], out["adaptation"]


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


def count_charges(key, since_iso):
    """Row count of lynxr_script_charges charged after `since_iso` (an ISO
    string). Uses Prefer: count=exact + Range: 0-0 so the body stays empty and
    the total comes off Content-Range — sb() discards headers, so this is a
    small dedicated helper rather than a mode on it. Mirrors
    watchdog.py:_sources_count, which uses the identical pattern against a
    different table.

    Returns 0 (never raises) on any failure, INCLUDING "the table doesn't
    exist yet" — supabase/allowance_ledger.sql is an owner action and this
    module must keep working, degraded, before it is applied. That makes the
    daily cap fail OPEN, unlike charge_scripts(): this is a circuit breaker
    bounding worst-case spend, not the per-creator control the plan forbids
    failing open on."""
    try:
        q = urllib.parse.quote(since_iso, safe="")
        req = urllib.request.Request(
            f"{SB_URL}/rest/v1/lynxr_script_charges?charged_at=gt.{q}&select=adaptation_id")
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("Prefer", "count=exact")
        req.add_header("Range", "0-0")
        with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as r:
            content_range = r.headers.get("Content-Range", "")
            r.read()
        total = content_range.split("/")[-1]
        return int(total) if total.isdigit() else 0
    except Exception as e:  # noqa: BLE001
        log.warning("lynxr_script_charges count failed: %s", str(e)[:90])
        return 0


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


@contextmanager
def stage(timings, name):
    """Record how long one stage took, in seconds, onto `timings`.

    Written onto the adaptation itself rather than only logged: the container's
    log file dies with the machine, and the 26- and 34-minute waits this plan
    exists to kill were invisible until someone queried the database by hand.
    """
    t0 = time.monotonic()
    try:
        yield
    finally:
        timings[name] = round(time.monotonic() - t0, 2)


# A token identifying THIS process, logged at start (Step 10a). Not an atomic
# claim — PostgREST cannot compare-and-swap inside a JSONB array — but paired
# with the read-after-write check in main() it turns a near-certain double
# spend under two machines into a rare one. See fly.toml / Step 10b for the
# actually-atomic fix this stands in for (a SECURITY DEFINER Postgres RPC),
# which needs the owner in the SQL editor and isn't built here.
CLAIM_ID = uuid.uuid4().hex[:12]

# True only inside a --redo-ai run. A hand-forced re-run of a finished entry
# is a deliberate owner action, not the re-run SHAPE pipeline/watchdog.py's
# `rerun:<id8>` alarm exists to catch — see run_entry's attemptedAt block.
FORCED = False

# Set to the machine count when the owner scales up (`fly scale count N`). At
# the default of 1 there is only one claimer, so the extra GET + jittered sleep
# in main()'s claim-verification step would cost ~1.5s on the SLA for nothing —
# skip it entirely below that.
WORKER_PEERS = int(envcfg.get("WORKER_PEERS", "1"))


def api_reason(e):
    s = str(e)
    m = s.split("'message': '")
    return (m[1].split("'")[0] if len(m) > 1 else s)[:90]


# ---------- WHEN THE VIDEO CANNOT BE FETCHED ----------
#
# yt-dlp's stderr is written for someone at a terminal. Stored raw on the
# entry it becomes the creator's error message, and the first one we hit in
# the wild read:
#
#   download failed: ERROR: [TikTok] 7524866777004723486: This post may not be
#   comfortable for some audiences. Log in for access. Use --cookies-from-browser
#
# A creator reads that, taps Try again, gets the identical failure, and
# concludes the product is broken. It is not — that video is age-gated and no
# number of retries will ever open it. Two things are wrong: the words, and
# offering a retry for something that cannot succeed.
#
# So classify. `retryable` False means the answer will not change on its own,
# and the card must not show a Try again button (creator.js reads it).
# Anything unrecognised stays retryable — a network blip must not be
# mistaken for a permanent wall.
FETCH_FAILURES = (
    (False, "fetch_age",
     ("may not be comfortable", "log in for access", "age-restricted",
      "sign in to confirm your age")),
    (False, "fetch_private",
     ("private video", "this video is private", "is private")),
    (False, "fetch_gone",
     ("video unavailable", "has been removed", "no longer available",
      "content isn't available", "http error 404", "not found")),
    (False, "fetch_unreadable",
     ("unsupported url", "is not a valid url", "unable to extract")),
    (False, "fetch_geo",
     # yt-dlp's real wording is "The uploader has not made this video available
     # in your country", so match the tail rather than a phrasing that never
     # appears — the first draft used "not available in your country" and
     # silently matched nothing.
     ("available in your country", "geo restricted", "geo-restricted",
      "blocked in your country", "not available from your location")),
    (False, "fetch_bot",
     ("sign in to confirm you", "confirm you're not a bot", "captcha")),
)


def fetch_failure(err):
    """(CREATOR_NOTES key, retryable) for a yt-dlp/download error.

    Unrecognised errors keep the generic wording and STAY retryable. Guessing
    "permanent" on an unknown string would hide a transient outage behind a
    card with no way forward, which is worse than one pointless retry.
    """
    low = str(err).lower()
    for retryable, key, needles in FETCH_FAILURES:
        if any(n in low for n in needles):
            return key, retryable
    return "fetch_generic", True


# ---------- WHEN THE MODEL STEPS FAIL ----------
#
# An entry whose AI steps failed used to end up status "done" with a note, and
# nothing ever looked at it again: wants_work() only reconsidered "done" under
# --redo-ai, a flag neither the Fly worker nor the GitHub job passes. So a
# lapsed Anthropic balance did not produce an error anyone could see — it
# produced scripts that simply never arrived, on rows that looked finished.
#
# The three reasons need three different waits, which is why this classifies
# rather than retrying everything on one timer. A dry credit balance clears the
# moment a human tops it up; an overloaded API clears in seconds; a model that
# will not write beats for this particular source will not write them in six
# hours either, and retrying that one just spends money to fail again.
AI_FAIL_KINDS = (
    ("billing", ("credit balance", "billing", "payment", "quota",
                 "insufficient_quota", "insufficient credit")),
    ("rate_limit", ("rate_limit", "rate limit", "too many requests", "429")),
    ("transient", ("overloaded", "529", "503", "502", "500", "timed out",
                   "timeout", "connection", "internal server", "temporarily",
                   "anthropic_api_key", "malformed model response")),
)

# Minutes before the Nth automatic retry of each kind. Billing starts short
# because the top-up is a human action that can land at any moment, and the
# retry that notices it is the difference between a creator waiting minutes and
# waiting until someone thinks to look. It backs off so a genuinely dead account
# does not re-download the same videos all night.
AI_RETRY_MINUTES = {
    "billing":    [15, 30, 60, 120, 240, 360],
    "rate_limit": [5, 10, 20, 40, 60],
    "transient":  [5, 10, 20, 40, 60],
}
# Only these retry on their own. "content" — a refusal, a schema the model will
# not satisfy for this source — is left exactly as it is today: --redo-ai can
# still force it, but a timer cannot fix it and would only burn credit.
AI_RETRY_KINDS = tuple(AI_RETRY_MINUTES)
AI_MAX_TRIES = 8          # ~5.25h of transient retrying (5+10+20+40+60x4), or
                           # ~19.75h of billing retrying (15+30+60+120+240+360x2)
                           # before it gives up and says so

# THE UNIVERSAL BACKSTOP. Every failure class below has its own bounded
# schedule, but `wants_work`'s error branch ends in a 6-hour cooled() floor
# that reopens ANY error forever — including shapes nothing here enumerates
# (an unrecognised download failure, an exception before any marker is
# stamped). Twelve passes is ~3 days of six-hourly retrying, and it can never
# fire before the AI schedule (8 tries) because `passes` and `tries` both
# count one per pass.
FINAL_MAX_PASSES = 12


def ai_failure_kind(reason):
    r = (reason or "").lower()
    for kind, needles in AI_FAIL_KINDS:
        if any(n in r for n in needles):
            return kind
    return "content"


# EVERY SENTENCE A CREATOR CAN EVER READ ON A CARD, and the only source of
# them. `kind` is the enumerated word creator.js picks its chip from — the
# renderer must never parse the prose. Format slots take NUMBERS ONLY (see
# set_note), so no caller can smuggle provider text in through one.
CREATOR_NOTES = {
    "ai_ours":      ("something on our side went wrong — we're retrying. "
                     "Nothing was used from your allowance.", "ours"),
    "ai_video":     ("we couldn't write a script from that video.", "video"),
    # The allowance clause here is TRUE ONLY UNDER OPTION (b) — see the
    # decision block. Under (a) this sentence ends at "tries." instead.
    "gave_up":      ("something on our side went wrong and we couldn't finish this "
                     "one after {tries} tries. Nothing was used from your allowance.", "ours"),
    "brand_missing": ("that company isn't on your profile any more — pick another "
                      "and send this video again.", "brand"),
    "cap":          ("This account has used its {cap} scripts. "
                     "Ask us to raise the limit.", "cap"),
    "off_platform": ("lynxr only reads TikTok, Instagram, Facebook and YouTube "
                     "links. Nothing was used from your allowance.", "platform"),
    "fetch_age":    ("This video is age-restricted, so we can't open it. "
                     "Try another link.", "fetch"),
    "fetch_private": ("This video is private, so we can't open it. "
                      "Try another link.", "fetch"),
    "fetch_gone":   ("This video has been deleted or made unavailable. "
                     "Try another link.", "fetch"),
    "fetch_unreadable": ("That link isn't a video we can read. Check it and "
                         "try again.", "fetch"),
    "fetch_geo":    ("This video isn't available in the region our servers run from.",
                     "fetch"),
    "fetch_bot":    ("The platform is asking us to prove we're not a bot on this one. "
                     "Try another link.", "fetch"),
    "fetch_generic": ("We couldn't read that video. It may be a temporary problem — "
                      "try again.", "fetch"),
    # Reached only if a key is ever mistyped. set_note must never raise: it
    # runs inside except handlers, and a KeyError there would cost the
    # creator their error card as well as their script.
    "fallback":     ("something on our side went wrong. "
                     "Nothing was used from your allowance.", "ours"),
}

# Which sentence each classified AI failure gets. billing/rate_limit/
# transient are all OURS to fix, not the creator's; only "content" is
# genuinely about their video.
AI_NOTE_KEY = {"billing": "ai_ours", "rate_limit": "ai_ours",
               "transient": "ai_ours", "content": "ai_video"}

# The strings that must NEVER reach a creator-visible field. Drawn from real
# production text: Anthropic's own 529/credit-balance sentences, yt-dlp
# stderr (two rows in live `trash` still carry
# "download failed: ERROR: [TikTok] …Use --cookies-from-browser"), and
# Python internals. DUPLICATED in pipeline/watchdog.py — that module may not
# import this one (import-time logging.basicConfig + mkdir) — so change one,
# change both; test_ai_retry.py asserts the two stay identical.
RAW_TEXT_NEEDLES = ("overloaded", "529", "credit balance", "rate_limit", "429",
                    "traceback", "anthropic", "error:", "yt-dlp", "--cookies",
                    "http error", "nonetype", "exception", "failed:", "api_key")


def note_text(key, **nums):
    """The sentence for `key`, with number-only substitutions."""
    text, _kind = CREATOR_NOTES.get(key) or CREATOR_NOTES["fallback"]
    safe = {k: v for k, v in nums.items() if isinstance(v, (int, float))}
    try:
        return text.format(**safe)[:200]
    except Exception:  # noqa: BLE001
        return CREATOR_NOTES["fallback"][0]


def set_note(a, key, **nums):
    """THE ONLY WRITER OF a["note"] IN THIS MODULE. Takes a registry KEY,
    never prose — which is what makes it impossible for a future failure
    path to leak provider text by default. Raw strings go to the log and to
    a["diag"]/a["aiFail"]["reason"], neither of which creator.js renders."""
    if key not in CREATOR_NOTES:
        log.error("set_note: unknown key %r — falling back", key)
        key = "fallback"
    a["note"] = note_text(key, **nums)
    a["noteKind"] = CREATOR_NOTES[key][1]


def clear_note(a):
    a.pop("note", None)
    a.pop("noteKind", None)


class CreatorFacing(Exception):
    """A failure whose creator-visible sentence is already decided. Carries a
    CREATOR_NOTES key, never prose, so run_entry's handler can honour it
    without classifying."""

    def __init__(self, key, *, retryable=True, detail=""):
        super().__init__(detail or key)
        self.key, self.retryable = key, retryable


def begin_attempt(a):
    """Mark the start of ONE pass over this entry.

    Every failure inside a pass — shot list, tags, format, adaptation —
    belongs to one attempt, and `tries` is what the retry schedule indexes
    on, so miscounting it is a wait the CREATOR serves. It used to be keyed
    on `attemptedAt`, which run_entry stamps AFTER the source phase: three
    steps failing in one pass drove tries 0->3, and on adaptation 644ba12d
    two passes drove it to 6, moving the next retry from 5 minutes to 60.

    Deliberately NOT attemptedAt and not a timestamp. attemptedAt marks the
    source/adapt boundary latency_report.py splits every sample on
    ("source+format" vs "adapt"); moving it to fix this would silently
    redefine that report. This field is read by nothing else.
    """
    a["attemptId"] = uuid.uuid4().hex[:12]
    a["passes"] = int(a.get("passes") or 0) + 1
    # Last pass's verdict, cleared before this pass can fail. mark_final() is
    # the only thing that writes it back.
    a.pop("final", None)
    a.pop("finalWhy", None)


def mark_ai_fail(a, reason):
    """Stamp a machine-readable failure marker on the entry.

    Deliberately its own field rather than the old `"failed" in note` test. That
    string was unreliable in both directions: the no-brand branch in process_one
    DELETES the note before returning, so an original script that lost its shot
    list was unrecoverable and invisible at once; and any future note containing
    the word would have been retried by accident.

    `tries` counts ATTEMPTS, not failed steps. Three model calls failing inside
    one pass is one attempt — keyed on `attemptId`, a token process_group stamps
    once per entry before any work in the pass begins (see begin_attempt). The
    last failure of an attempt wins for kind/reason, which is the one that
    mattered: the steps run cheapest-first, so the later the failure, the
    further the entry got."""
    prev = a.get("aiFail") or {}
    token = a.get("attemptId")
    # A missing token counts as a NEW attempt. Over-counting is the safe
    # direction — it retries sooner than ideal; under-counting would give an
    # entry unlimited tries and it would never reach ai_gave_up().
    same_attempt = bool(token) and prev.get("attempt") == token
    a["aiFail"] = {
        "kind": ai_failure_kind(reason),
        "reason": (reason or "")[:160],
        "at": now_iso(),
        "attempt": token,
        "tries": int(prev.get("tries") or 0) + (0 if same_attempt else 1),
    }


def minutes_since(stamp):
    if not stamp:
        return float("inf")
    try:
        return (datetime.now(timezone.utc)
                - datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))).total_seconds() / 60
    except ValueError:
        return float("inf")


def ai_retry_due(a):
    """Is this finished-but-failed entry due another go, on its own?"""
    f = a.get("aiFail")
    if not f or f.get("kind") not in AI_RETRY_KINDS:
        return False
    tries = max(1, int(f.get("tries") or 1))
    if tries >= AI_MAX_TRIES:
        return False                      # given up on; main() marks it error
    sched = AI_RETRY_MINUTES[f["kind"]]
    return minutes_since(f.get("at")) >= sched[min(tries - 1, len(sched) - 1)]


def has_usable_result(a):
    """Is there anything on this entry the creator can actually use?

    "Usable" depends on what was ASKED FOR, which is what the old
    `not a.get("format")` test missed. A branded entry is a request for a
    script: a format with no beats is our working note, not their answer. A
    no-brand entry IS the source read back, so a format — or even just the
    transcript or shot list — is the whole deliverable.
    """
    if a.get("brandId"):
        return bool((a.get("adaptation") or {}).get("beats") or [])
    src = a.get("source") or {}
    return bool(a.get("format") or (src.get("shots") or [])
                or ((src.get("script") or {}).get("text") or ""))


def ai_gave_up(a):
    """Out of automatic retries AND with nothing usable to show for it.

    The second half matters. A shot list that failed on a transient blip leaves
    an entry that still has its transcript, its format and its script — that is
    a working result with a gap in it, and flipping it to "error" after a day of
    quiet retries would take a card the creator is happily using and replace it
    with a red one. Only an entry that produced NO format is actually empty."""
    f = a.get("aiFail") or {}
    return (f.get("kind") in AI_RETRY_KINDS
            and int(f.get("tries") or 0) >= AI_MAX_TRIES
            and not has_usable_result(a))


def mark_final(a, why):
    """THE ONLY WRITER OF a["final"]. `why` is an enumerated word, never prose
    and never provider text — nothing renders it, but the same rule that keeps
    CREATOR_NOTES a registry applies to anything landing on a creator's row.

    `final` and `retryable` are DIFFERENT QUESTIONS. `retryable` decides
    whether creator.js paints a Try again button; `final` decides whether the
    worker will ever pick this entry up again ON ITS OWN. A gave-up entry is
    final and still retryable — the human can ask, the timer cannot.
    """
    a["final"] = True
    a["finalWhy"] = why


def final_reason(a, *, retryable=True):
    """Why the automatic loop should stop with this entry, or "" to keep going.

    Pure, so pipeline/test_prefilter.py can drive the whole state space through
    it. Order matters: a recognised permanent wall wins over any counter.
    """
    if not retryable:
        return "wall"                    # age-gated/private/deleted/brand gone
    f = a.get("aiFail") or {}
    if f and not has_usable_result(a):
        if f.get("kind") not in AI_RETRY_KINDS:
            return "no_script"           # a refusal; a timer cannot fix it
        if int(f.get("tries") or 0) >= AI_MAX_TRIES:
            return "gave_up"
    if int(a.get("passes") or 0) >= FINAL_MAX_PASSES:
        return "exhausted"
    return ""


# ---------------------------------------------------------------------------
# DISCOVERY PREFILTER
#
# Discovery used to pull every creator's whole `data` blob and filter here.
# Measured live 2026-08-18: 214,900 bytes / 548ms at FIVE creators, and
# worker.py --sweep fires it every 60 seconds forever. It is linear in the
# corpus and it degrades silently, which is the worst failure shape here.
#
# So ask Postgres instead, the way worker.py's queued_creators() already
# does — JSONB containment, ids only, 2 bytes. The difference is that probe
# asks ONLY about status:"queued" (deliberately: it is the latency probe),
# and wants_work() accepts FOUR conditions. These probes are the union of
# all four, and must stay a strict SUPERSET of it: over-selecting costs one
# wasted row fetch that the per-creator pass then re-checks precisely,
# under-selecting loses a creator's script with nothing anywhere saying so.
#
# `done` is the overwhelmingly common status, so it is probed only TOGETHER
# with a concrete aiFail.kind — a bare {"status":"done"} probe would match
# nearly every creator and buy nothing.
#
# THE ARRAY WRAPPER IS LOAD-BEARING. `data->adaptations` is a jsonb ARRAY,
# so a probe must be `[{...}]`. Measured: the same probe as a bare object
# `{...}` returns HTTP 200 and [] — no error, matching nothing. A malformed
# probe here is indistinguishable from an empty queue, which is why
# candidate_creators() below re-checks with a canary before believing an
# empty answer, and why test_prefilter.py asserts the shape.
def prefilter_probes():
    """Containment probes whose union is a strict superset of wants_work()."""
    probes = [[{"status": "queued"}],      # wants_work condition 1
              [{"status": "running"}],     # condition 2, narrowed by abandoned()
              [{"status": "error"}]]       # condition 3, narrowed by cooled()/ai_retry_due()
    # Condition 4: done + a RETRYABLE aiFail. Keyed off AI_RETRY_KINDS so
    # adding a kind to AI_RETRY_MINUTES cannot silently leave it unprobed —
    # test_prefilter.py asserts these two stay in step.
    probes += [[{"status": "done", "aiFail": {"kind": k}}]
               for k in sorted(AI_RETRY_KINDS)]
    return probes


# [] is contained in EVERY json array, so this probe matches every creator
# row that has an adaptations array (verified live: 5 of 5). Appended to the
# real probes it proves the containment grammar still MATCHES, which is the
# one thing an empty result cannot tell you on its own.
PREFILTER_CANARY = []


def prefilter_url(probes, limit=None):
    """PostgREST or=() over JSONB containment, ids only.

    Each value is wrapped in double quotes with its inner quotes
    backslash-escaped. That is not decoration: the probes for condition 4
    contain a comma, and PostgREST splits or=() on unquoted commas — an
    unquoted value would be torn into two garbage conditions.

    Only the joined conditions are percent-encoded; the surrounding parens
    stay literal, because PostgREST needs to see them as syntax.
    """
    conds = []
    for p in probes:
        j = json.dumps(p, separators=(",", ":")).replace('"', '\\"')
        conds.append(f'data->adaptations.cs."{j}"')
    q = urllib.parse.quote(",".join(conds), safe="")
    tail = f"&limit={limit}" if limit else ""
    return f"/rest/v1/lynxr_creators?select=id&or=({q}){tail}"


def candidate_creators(key):
    """Ids of creators that MIGHT have work, or None to fall back.

    None means "could not answer" and the caller must run the full scan.
    An empty list means "asked, and there is genuinely nothing" — but that
    is also what a broken filter returns, so it is only returned after the
    canary proves the grammar still matches something.
    """
    probes = prefilter_probes()
    try:
        rows = sb(key, prefilter_url(probes))
    except Exception as e:  # noqa: BLE001
        log.warning("PREFILTER FAILED (%s) — falling back to the full scan",
                    api_reason(e))
        return None
    if rows:
        return [r["id"] for r in rows]
    try:
        alive = sb(key, prefilter_url(probes + [PREFILTER_CANARY], limit=1))
    except Exception as e:  # noqa: BLE001
        log.warning("PREFILTER CANARY FAILED (%s) — falling back to the full scan",
                    api_reason(e))
        return None
    if not alive:
        # Note: on a lynxr_creators table with ZERO rows the canary also
        # returns nothing, so this logs every sweep. That is the safe
        # direction (it falls back to a scan that is itself 2 bytes on an
        # empty table) and cannot happen in production, where the table only
        # grows.
        log.error("PREFILTER CANARY MATCHED NOTHING — the containment filter is "
                  "broken, not the queue empty. Falling back to the full scan.")
        return None
    return []


def note_soft_fail(a, subsystem, reason):
    """Record a swallowed, non-fatal failure on the entry itself.

    The best-effort handlers this sits next to (upsert_source, upsert_video,
    the cover in fill_source, fetch_meta at its call site) are correct and
    stay exactly as they are — a failure there must never cost the creator
    their script, so they log a warning and move on. The problem was never
    the swallow, it was that a swallowed failure left no trace anywhere a
    human would look. This just makes it visible: pipeline/watchdog.py's
    `softfail:<subsystem>` alarm reads this field and pages when the SAME
    subsystem fails on 3 of the last 5 finished scripts, which turns a
    persistent problem loud while a single blip (1 of 5) stays quiet."""
    (a.setdefault("softFails", {}))[subsystem] = {
        "reason": str(reason)[:120], "at": now_iso()}


def clear_soft_fail(a, subsystem):
    (a.get("softFails") or {}).pop(subsystem, None)


def too_young(a, min_age_seconds):
    """Step 11c: True if `a` was added more recently than `min_age_seconds`
    ago. A top-level pure function (rather than a closure inside main(), like
    the others near ai_retry_due) so it is directly testable — the GitHub
    fallback passes --min-age-seconds 180 so it stays a genuine backstop for
    Fly instead of racing it for the claim."""
    if not min_age_seconds:
        return False
    added = a.get("addedAt") or ""
    if not added:
        return False
    try:
        age = (datetime.now(timezone.utc)
               - datetime.fromisoformat(added.replace("Z", "+00:00"))).total_seconds()
    except ValueError:
        return False
    return age < min_age_seconds


def cooled(a, cooldown_hours):
    last = a.get("attemptedAt") or ""
    if not last or not cooldown_hours:
        return True
    try:
        age = (datetime.now(timezone.utc)
               - datetime.fromisoformat(last.replace("Z", "+00:00"))).total_seconds() / 3600
    except ValueError:
        return True
    return age >= cooldown_hours


def abandoned(a, lease_minutes):
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
    return age >= lease_minutes


def wants_work(a, *, cooldown_hours, lease_minutes, min_age_seconds, redo_ai):
    if too_young(a, min_age_seconds):
        return False
    if a.get("status") == "queued":
        return True
    if a.get("status") == "running":
        return abandoned(a, lease_minutes)
    if a.get("status") == "error":
        # THE LOOP HAS A FLOOR NOW. Everything below ends in cooled(), which
        # reopens ANY error every six hours forever — a permanent wall, a model
        # refusal, an entry out of tries. Each of those costs a full download,
        # Whisper pass and model chain to fail identically again, on an entry
        # the creator has already been given the answer on. --redo-ai is
        # deliberately still able to force it: this is the automatic loop's
        # floor, not a lock.
        if a.get("final") and not redo_ai:
            return False
        # A dry balance is not the same kind of failure as a video that
        # cannot be downloaded, and it was getting the same six-hour wait.
        # A brand adaptation that fails on billing RAISES (no beats), so it
        # lands here rather than in the "done" branch below — without this
        # it would sit out the full cooldown after a top-up, which is the
        # manual waiting this whole change exists to remove. The cooled()
        # floor still applies to everything else, unchanged.
        if a.get("aiFail"):
            return ai_retry_due(a) or cooled(a, cooldown_hours)
        return cooled(a, cooldown_hours)
    if a.get("status") != "done":
        return False
    # Forced by hand. Unchanged in spirit, except it now also recognises the
    # marker — an entry whose note was cleared (every original script) was
    # previously unreachable even by --redo-ai.
    if redo_ai and ("failed" in (a.get("note") or "") or a.get("aiFail")):
        return cooled(a, cooldown_hours)
    # ...and on its own, for the failures a timer can actually fix. This is
    # the one that means nobody has to notice a lapsed balance by hand.
    return ai_retry_due(a)


# An alias under a DIFFERENT name, for main()'s args-bound shadow to close over.
# `def wants_work(...)` inside main() makes `wants_work` a LOCAL name for that
# whole scope, so a default of `_w=wants_work` is resolved against the local —
# unbound at def time — and raises UnboundLocalError on the first pass. That
# shipped on 2026-08-18 and crashed every worker pass until this line. The
# alias is not assigned in main(), so it resolves to the module global.
_wants_work_impl = wants_work


# Maps a HOSTNAME to its platform label. Used by platform_of() below, matched
# the same way supported_url() matches SUPPORTED_HOSTS: an exact host or a
# subdomain of one, after stripping a leading "www.". youtu.be, fb.watch and
# fb.com are separate keys because they are separate hosts a creator can paste
# (all three are on SUPPORTED_HOSTS) that resolve to the same platform.
PLATFORM_HOSTS = {"tiktok.com": "tiktok", "instagram.com": "instagram",
                  "facebook.com": "facebook", "fb.watch": "facebook",
                  "fb.com": "facebook", "youtube.com": "youtube",
                  "youtu.be": "youtube"}


def platform_of(url):
    """Which platform a URL belongs to, matched on the HOSTNAME — not a
    substring test, which used to file youtu.be, fb.watch and fb.com under
    "other" (verified: platform_of("https://youtu.be/aqz-KE-bpKQ") returned
    "other", and so did fb.watch/... and fb.com/...). All three are accepted
    creator links (see SUPPORTED_HOSTS), so every one of them silently missed
    every trust-list and refresh query keyed on platform. supported_url() is
    still the ACCEPT gate; this is only the LABEL, but a label that misfiles
    an accepted host is still wrong."""
    try:
        host = (urllib.parse.urlsplit(str(url or "").strip()).hostname or "").lower()
    except ValueError:
        return "other"
    host = host.removeprefix("www.")
    for d, p in PLATFORM_HOSTS.items():
        if host == d or host.endswith("." + d):
            return p
    return "other"


# THE FOUR PLATFORMS. Mirrors PLATFORMS in creator.js — change one, change the
# other. This is the copy that counts: the queue is a field inside a row the
# creator owns, so the browser check can be walked around from the console, and
# an off-platform link otherwise costs a download, a Whisper pass and four model
# calls before failing on something unrelated.
# Matched on the HOSTNAME. `platform_of` above is now also a hostname match
# (it used to be a substring test on the whole URL, which was wrong even as a
# label — see its docstring); this remains the one that must never regress to
# a substring test, because it would let `evil.com/?ref=tiktok.com` through as
# a gate, not merely mislabel a row we already accepted.
SUPPORTED_HOSTS = ("tiktok.com", "instagram.com",
                   "facebook.com", "fb.watch", "fb.com",
                   "youtube.com", "youtu.be")

# WHICH PLATFORMS ACTUALLY HAND OVER A VIEW COUNT, without signing in, via
# yt-dlp specifically (this list is about the FREE route only — see
# VIEWS_PAID_PLATFORMS below for the paid one).
# Measured 2026-08-19 against live URLs — see the plan's Appendix A.
#   tiktok     yes   191,000 on a real corpus video
#   youtube    yes   watch, youtu.be and /shorts/ all report it
#   instagram  NO, via yt-dlp — pinned 2026.07.04, nightly 2026.08.18,
#                    app_id=ios, the public /embed/ page and unauthenticated
#                    oEmbed ALL return nothing on the anonymous surface
#                    yt-dlp reads. That is NOT the end of the story: the
#                    count now comes from VIEWS_PAID_PLATFORMS / apify_views()
#                    instead, a paid API, not a session — this does NOT
#                    reopen the cookie/session route declined 2026-08-18.
#                    Do not "fix" this by adding "instagram" to the trust
#                    list below — there is still no yt-dlp number to trust.
#   facebook   NOT TRUSTED — it returns a number, and on the one live
#                    Facebook Reel measured that number was 407 while the
#                    same response's Facebook-written title said
#                    "9.8K views". Wrong on the short-form shape is worse
#                    than blank. Add "facebook" here to reverse.
VIEWS_TRUSTED_PLATFORMS = ("tiktok", "youtube")

# WHICH PLATFORMS WE PAY FOR A COUNT. Instagram DOES publish a play count —
# it is simply not on the anonymous surface yt-dlp reads. The agency scrape
# has had it all along (pipeline/scrape_instagram.py -> videoPlayCount,
# read at pipeline/process_scraped.py:70), and 985 of 986 scraped Instagram
# rows in lynxr_videos carry a real number because of it.
#
# Measured 2026-08-19 against the live Apify API: apify/instagram-scraper
# with directUrls returns videoPlayCount for ONE direct post URL, on
# /reel/, /reels/ and /p/ alike, for $0.0023 a lookup. See apify_views().
# This does NOT reopen the cookie/session route — that stays declined and
# is not needed; this is a paid public API doing what it is sold to do.
VIEWS_PAID_PLATFORMS = ("instagram",)

VIEWS_REFRESH_PLATFORMS = tuple(VIEWS_TRUSTED_PLATFORMS) + VIEWS_PAID_PLATFORMS
VIEWS_MAX_AGE_H  = float(envcfg.get("VIEWS_MAX_AGE_H", "24"))
# 7 days, not 24h. Refresh cost scales with the CUMULATIVE corpus times the
# frequency, and the account's hard Apify ceiling is $50/month shared with
# the agency scrapes. Daily refresh reaches ~$37/month within six months at
# today's paste rate; weekly is ~$5. Set VIEWS_PAID_MAX_AGE_H=24 to reverse.
VIEWS_PAID_MAX_AGE_H = float(envcfg.get("VIEWS_PAID_MAX_AGE_H", "168"))
VIEWS_PER_PASS   = int(envcfg.get("VIEWS_PER_PASS", "3"))
# A row that has NEVER got a number is a different case from a stale one, and
# the 168h clock hid it: fetch_meta stamps metrics_at at PASTE time while
# leaving views None (the paste path never pays), so a fresh Instagram paste
# was neither null nor stale and sat blank for a week — the exact shape that
# stranded 7 rows on 2026-08-19. So: retry an absent value on a SHORT clock,
# but only while the row is young. A real paste succeeds on its first retry; a
# genuinely dead post (deleted, private) costs ~12 lookups over the window
# (~$0.03) and then falls back to the weekly clock forever, rather than being
# retried every sweep at $0.0023 a time until someone notices.
VIEWS_PAID_RETRY_H        = float(envcfg.get("VIEWS_PAID_RETRY_H", "2"))
VIEWS_PAID_RETRY_WINDOW_H = float(envcfg.get("VIEWS_PAID_RETRY_WINDOW_H", "24"))

APIFY_VIEWS_ACTOR    = "apify~instagram-scraper"   # actor id shu8hvrXbJbY3Eb9W
APIFY_RUN_TIMEOUT_S  = int(envcfg.get("APIFY_RUN_TIMEOUT_S", "60"))
APIFY_MAX_CHARGE_USD = float(envcfg.get("APIFY_MAX_CHARGE_USD", "0.05"))
APIFY_MAX_MONTHLY_USD = float(envcfg.get("APIFY_MAX_MONTHLY_USD", "45"))
APIFY_BUDGET_TTL_S   = int(envcfg.get("APIFY_BUDGET_TTL_S", "600"))
APIFY_PRICE_PER_LOOKUP_USD = 0.0023  # BRONZE tier, measured 2026-08-19 — for
# the refresh_views() summary log line ONLY; not authoritative for spend
# decisions, apify_budget_ok() reads Apify's own ledger for that.

# Shown to the creator in the app, so it reads as an answer rather than a fault.
OFF_PLATFORM_NOTE = note_text("off_platform")


def supported_url(url):
    """True if this is a link we accept. Subdomains count (vm.tiktok.com,
    m.facebook.com); a domain that merely ends in one of these words does not.

    Checks the SCHEME too, not just the hostname — belt and braces: nothing
    reachable today exploits its absence (a leading `-` already makes
    `hostname` None, which this already refused), but "cannot be exploited by
    the argument we happen to pass" and "cannot be exploited" are different
    claims, and this is the one gate here that decides what a subprocess
    (yt-dlp) is handed."""
    try:
        parts = urllib.parse.urlsplit(str(url or "").strip())
        host = parts.hostname or ""
    except ValueError:
        return False
    if parts.scheme not in ("http", "https"):
        return False
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return any(host == d or host.endswith("." + d) for d in SUPPORTED_HOSTS)


# Tokens spent THIS SCRIPT, per model — one dict per thread. Cost per script is
# the number that decides whether opening the doors to 100 creators is sane,
# and it cannot be guessed from the outside: four calls, three of them Opus,
# one carrying six images.
#
# threading.local rather than a plain module dict: Step 7 runs several scripts
# concurrently, one per worker thread, and a shared dict would blend and then
# wipe each other's costs mid-run — cost-per-script is the number the pricing
# model rests on, so that silent blending would be a real regression, not a
# cosmetic one.
_USAGE_LOCAL = threading.local()


def usage():
    """This thread's usage dict."""
    if not hasattr(_USAGE_LOCAL, "d"):
        _USAGE_LOCAL.d = {}
    return _USAGE_LOCAL.d


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


def warm_prefixes(aclient):
    """Write the three cached prefixes before anyone is waiting on them.

    Sibling of worker.py's warm_whisper(), same reason: the creator who
    happens to paste first after a deploy should not pay for the machine
    being new.

    NOT the documented max_tokens=0 pre-warm. That form is an
    invalid_request_error when the request carries output_config.format —
    and all three of these calls do, and the json_schema LANDS IN THE
    CACHED PREFIX (it is what pushes FORMAT_SYSTEM's 491 tokens over the
    512 minimum). Dropping the schema to satisfy max_tokens=0 would warm a
    prefix the real calls never send, i.e. warm nothing. So: the real
    shape, max_tokens=16, answer discarded.

    Honest limit: the default cache TTL is 5 minutes. This helps the paste
    that follows a deploy; it does nothing for the first paste of a quiet
    day, and a keep-warm on an interval would cost more per day than the
    scripts do.
    """
    t0 = time.time()

    def warm(label, model, system, schema, effort=None):
        try:
            out_cfg = {"format": {"type": "json_schema", "schema": schema}}
            if effort and not model.startswith("claude-haiku"):
                out_cfg["effort"] = effort
            msg = aclient.messages.create(
                model=model, max_tokens=16,
                system=sys_block(system),
                output_config=out_cfg,
                messages=[{"role": "user", "content": "warm"}])
            u = getattr(msg, "usage", None)
            log.info("  warmed %s: cache_creation_input_tokens=%d", label,
                     getattr(u, "cache_creation_input_tokens", 0) or 0)
        except Exception as e:  # noqa: BLE001 — a failed warm-up must never stop the worker
            log.warning("  prefix warm (%s) skipped: %s", label, str(e)[:90])

    warm("tags", TAG_MODEL, TAG_SYSTEM, TAG_SCHEMA_VISION, TAG_EFFORT)
    warm("format", MODEL, FORMAT_SYSTEM, FORMAT_SCHEMA)
    warm("adapt", MODEL, ADAPT_SYSTEM, ADAPT_SCHEMA)
    log.info("prefix warm-up done in %.1fs", time.time() - t0)


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
    d = usage().setdefault(model, {"in": 0, "out": 0, "calls": 0, "write": 0, "read": 0})
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


def log_usage(label, u):
    """Tokens AND dollars per script.

    Cost per script is the number that decides whether opening the doors is
    sane, and it cannot be worked out from the outside: four calls, three of
    them Opus, one carrying six images. Printing the dollar figure on every run
    means the answer is in the log the first time a real script is written,
    instead of being reconstructed from token counts afterwards.

    Takes the usage dict explicitly (the current thread's `usage()`, in every
    real call site) rather than reading a module global — Step 7 runs several
    scripts concurrently and each must log its own tally, not whatever the
    global happened to hold at the moment this ran.
    """
    if not u:
        return
    total = 0.0
    priced = True
    for model, d in u.items():
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
    if len(u) > 1 or not priced:
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
    try:
        return undouble(json.loads(first_text(msg)))
    except Exception as e:  # noqa: BLE001
        # A SHAPE FLUKE IS NOT A REFUSAL. Opus 5 returns a ThinkingBlock
        # adaptively and a body can arrive truncated; both used to classify as
        # "content", which final_reason() now treats as terminal. Say so in a
        # phrase ai_failure_kind() can see, so these keep the 5/10/20/40/60
        # schedule and give up like any other transient failure.
        raise RuntimeError(f"malformed model response: {api_reason(e)}") from e


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


# Default ON, per Step 8 — an off switch for when a re-read is actually wanted.
REUSE_SOURCES = envcfg.get("REUSE_SOURCES", "1") not in ("0", "false", "False")


def cached_source(key, url):
    """What a previous run already learned about this exact video.

    HANDOFF's THE POINT: one video pasted by three creators in a week is the
    saturation signal. The same fact makes it a cache — the source half of a
    script is a property of the VIDEO, not of the creator or the brand.
    Returns None unless every field the adaptation step reads is present.

    Be honest about the hit rate today: it is zero. All 21 rows in
    lynxr_sources have tag_count = 1 — no video has yet been pasted by two
    creators. And it does nothing at all until Step 0b is done, because the
    library upsert that fills the cache is currently returning PGRST204.
    """
    q = urllib.parse.quote(canon_url(url), safe="")
    rows = sb(key, f"/rest/v1/lynxr_sources?canonical_url=eq.{q}"
                   "&select=platform,script,shots,tags,format&limit=1")
    r = (rows or [None])[0]
    if not r or not r.get("format") or not r.get("script"):
        return None
    return r


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
    # METRICS. fetch_meta() already ran for this video — its result is sitting in
    # src["meta"], fetched for lynxr_videos — so this costs nothing extra: no
    # second yt-dlp call, no API. Without it the sources table had no reach
    # signal at all and could only ever be ranked by tag_count and recency.
    #
    # Only written when the fetch actually SUCCEEDED. fetch_meta returns {} on
    # any failure, and writing zeros from that would be a lie the app cannot
    # tell apart from a video that genuinely has no views — the column is
    # nullable precisely so "unknown" stays distinguishable from "none". That
    # promise used to be false: fetch_meta itself coerced an absent count to
    # 0 before it ever got here. It is true now — source_metrics() writes
    # `views: None` straight through as SQL NULL when the platform reported
    # nothing (see trusted_views).
    meta = src.get("meta") or {}
    if meta:
        body.update(source_metrics(meta, src.get("duration")))
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
        clear_soft_fail(a, "source_upsert")
    except Exception as e:  # noqa: BLE001
        log.warning("  source library upsert skipped: %s", str(e)[:90])
        note_soft_fail(a, "source_upsert", e)


_APIFY_TOKEN = None   # None = not looked yet; "" = looked, none there


def apify_token():
    """The Apify token, read through envcfg like every other secret here.

    Same source order as main()'s SUPABASE_SERVICE_ROLE_KEY read: .env
    first (a hand-run pass), then os.environ (Fly secrets, and worker.py's
    load_env, which subprocesses inherit). envcfg.secret() refuses a value
    with whitespace left inside it and names the VARIABLE, never the
    value — that refusal is caught here and turned into "no token", because
    a bad secret must cost a view count and never a script.

    NEVER log, print or include this value in an exception message.
    """
    global _APIFY_TOKEN
    if _APIFY_TOKEN is None:
        env = load_env(ROOT / ".env")
        try:
            _APIFY_TOKEN = envcfg.secret(
                "APIFY_API_TOKEN",
                env.get("APIFY_API_TOKEN"),
                os.environ.get("APIFY_API_TOKEN"))
        except Exception:  # noqa: BLE001
            log.warning("APIFY_API_TOKEN unusable — paid view lookups disabled")
            _APIFY_TOKEN = ""
    return _APIFY_TOKEN


_APIFY_BUDGET = {"at": 0.0, "ok": None}


def apify_budget_ok(token):
    """False when this Apify account is at or past its spend ceiling.

    Reads Apify's OWN ledger (current.monthlyUsageUsd against
    limits.maxMonthlyUsageUsd) rather than counting our calls, because the
    agency scrapes spend from the same account and a count we keep here
    would not see them. Cached APIFY_BUDGET_TTL_S so a long-lived worker
    asks about once every 10 minutes, not once per lookup.

    FAILS CLOSED. If the limits call itself fails we refuse to spend: the
    cost of being wrong that way is a stale view count, and the cost of
    being wrong the other way is exhausting the account ceiling, which
    stops the agency scrapes too.
    """
    now = time.time()
    if _APIFY_BUDGET["ok"] is not None and now - _APIFY_BUDGET["at"] < APIFY_BUDGET_TTL_S:
        return _APIFY_BUDGET["ok"]
    try:
        req = urllib.request.Request("https://api.apify.com/v2/users/me/limits")
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as r:
            d = json.loads(r.read()).get("data") or {}
        current = float((d.get("current") or {}).get("monthlyUsageUsd") or 0)
        account_limit = (d.get("limits") or {}).get("maxMonthlyUsageUsd")
        ceiling = min(APIFY_MAX_MONTHLY_USD, float(account_limit)) \
            if account_limit is not None else APIFY_MAX_MONTHLY_USD
        ok = current < ceiling
        if not ok:
            log.warning("apify_budget_ok: $%.2f spent of $%.2f ceiling (account "
                        "cap $%s) — paid view lookups paused, scripts unaffected",
                        current, ceiling, account_limit)
    except Exception as e:  # noqa: BLE001
        log.warning("apify_budget_ok: limits check failed (%s) — failing closed, "
                    "scripts unaffected", str(e)[:90])
        ok = False
    _APIFY_BUDGET["at"] = now
    _APIFY_BUDGET["ok"] = ok
    return ok


def apify_item_views(items):
    """The play count out of an apify/instagram-scraper dataset, or None.

    Field precedence mirrors pipeline/process_scraped.py:70, which is how
    the agency side has read this actor's siblings all along:
    videoPlayCount first, videoViewCount as the fallback.

    ONE DELIBERATE DIVERGENCE: process_scraped uses `a or b`, which turns a
    genuine 0 into the fallback and then into 0 anyway. Here 0 is a real
    measurement and absent is None, so the precedence is written as an
    explicit `is None` test. Same rule as trusted_views.

    A negative count is treated as ABSENT, not as a number — Instagram
    returns -1 for a count the creator has hidden (process_scraped.py:71
    already handles exactly that for likesCount).

    An item carrying an `error` key is a refusal, not a measurement:
    measured 2026-08-19, a post that does not exist comes back as
    {"error": "not_found", "errorDescription": "Post does not exist"} with
    no count field at all. It still costs $0.0023 — failures are billed.
    """
    for item in (items or []):
        if not isinstance(item, dict) or item.get("error"):
            continue
        raw = item.get("videoPlayCount")
        if raw is None:
            raw = item.get("videoViewCount")
        if raw is None:
            continue
        try:
            v = int(raw)
        except (TypeError, ValueError):
            continue
        if v < 0:
            continue
        return v
    return None


_APIFY_CALLS = 0   # paid lookups attempted this process; read by refresh_views


def apify_views(url):
    """The Instagram play count for ONE post URL, via the Apify actor the
    agency scrape already uses. Returns an int, or None. NEVER raises, and
    never returns 0 to mean failure — absent is None everywhere in this
    file (see trusted_views / source_metrics).

    Measured live 2026-08-19 (plan Appendix A): apify/instagram-scraper,
    directUrls with a single post URL, returns videoPlayCount for /reel/,
    /reels/ and /p/ shapes alike, at $0.0023 a lookup and 7-23s. Scope is
    public post metadata and nothing else.

    Called over plain urllib rather than the apify_client SDK ON PURPOSE:
    apify-client is NOT in requirements-ci.txt, so it is in neither the Fly
    image nor GitHub CI, and adding an import that can fail at module load
    to the file every test and backfill imports is a worse trade than one
    HTTP request. run-sync-get-dataset-items does the whole thing in a
    single POST — no run id, no polling, no dataset read.

    The token goes in an Authorization header, NEVER in the query string,
    so it cannot reach a log line or an exception message.
    """
    global _APIFY_CALLS
    token = apify_token()
    if not token:
        return None
    if not apify_budget_ok(token):
        return None
    q = urllib.parse.urlencode({"timeout": APIFY_RUN_TIMEOUT_S,
                                "maxItems": 1,
                                "maxTotalChargeUsd": APIFY_MAX_CHARGE_USD,
                                "format": "json"})
    ep = (f"https://api.apify.com/v2/acts/{APIFY_VIEWS_ACTOR}"
          f"/run-sync-get-dataset-items?{q}")
    body = {"directUrls": [url], "resultsType": "posts",
            "resultsLimit": 1, "addParentData": False}
    _APIFY_CALLS += 1
    try:
        req = urllib.request.Request(ep, method="POST")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
        with urllib.request.urlopen(
                req, timeout=APIFY_RUN_TIMEOUT_S + 15, context=SSL_CTX) as r:
            items = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        log.info("  apify_views failed: %s — %s", str(url)[:60], str(e)[:90])
        return None
    return apify_item_views(items)


def trusted_views(url, raw):
    """int(raw) when `raw` is a real number AND platform_of(url) is one this
    project trusts to hand back a view count at all — None otherwise. The
    single place the Facebook decision lives, so no caller downstream of
    fetch_meta can accidentally trust a number this plan does not.

    Facebook DOES return a view_count for ordinary videos (744,188 and
    19,571,910 measured on two live URLs) — but on the one live Facebook
    Reel measured, yt-dlp reported `view_count: 407` while that same
    response's own title, written by Facebook, read "9.8K views · 343
    reactions | ...". Stable across two runs and across both the /reel/ and
    m.facebook.com/watch forms. Short-form is the shape creators paste, so
    the shape that is wrong is the shape that would land on a card — 24x off
    is worse than blank. See VIEWS_TRUSTED_PLATFORMS."""
    if raw is None or platform_of(url) not in VIEWS_TRUSTED_PLATFORMS:
        return None
    return int(raw)


def video_views(url, raw, paid=False):
    """THE single place a view count is decided, whatever its source.

    Free first: trusted_views() reads what yt-dlp already handed back, for
    tiktok and youtube. Only when that is absent AND the caller has opted
    in to spending does a paid platform fall through to Apify. The card
    does not care which source answered — both return an int or None, and
    None means absent, never zero.

    `paid` defaults to FALSE so a caller can only spend money on purpose.
    backfill_titles.py and backfill_source_metrics.py both import
    fetch_meta and run over the whole corpus; neither wants a view count
    and neither should ever be able to run up a bill by omission. Fail
    closed on spend.
    """
    v = trusted_views(url, raw)
    if v is not None:
        return v
    if paid and platform_of(url) in VIEWS_PAID_PLATFORMS:
        return apify_views(url)
    return None


def fetch_meta(url, paid=False):
    """Public counts and the platform's own id, straight from yt-dlp. Free — no
    API, no scrape — and it is what lets a creator-submitted video sit in
    lynxr_videos as a real row rather than one with zeroed metrics.

    `paid=True` lets the Instagram slot fall through to a paid Apify lookup
    (see video_views) when yt-dlp itself hands back nothing — the caller
    opts in on purpose; the default stays free. Only refresh_views() passes
    paid=True; the paste path never does (see Assumption 1 in the plan)."""
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
    # This return-{}-on-failure happens BEFORE the dict below is ever built,
    # so a video yt-dlp itself cannot see (deleted, private, wrong URL)
    # costs no Apify money at all — video_views(paid=True) never runs.
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
    # ABSENT IS NOT ZERO. `int(x or 0)` turned "this platform told us nothing"
    # into "this video has no views" — indistinguishable in the row, and the
    # reason the views field looked populated on every record while being
    # empty on ~86% of them. Measured 2026-08-19: yt-dlp returns no
    # view_count at all for Instagram (see VIEWS_TRUSTED_PLATFORMS), which
    # is 19 of the 22 distinct videos creators have pasted. That Instagram
    # blank is now filled from VIEWS_PAID_PLATFORMS / apify_views() when the
    # caller passes paid=True (video_views handles the fallthrough below),
    # and stays blank otherwise.
    raw_views = d.get("view_count")
    return {
        "video_id": str(d.get("id") or ""),
        "creator": str(d.get("uploader_id") or d.get("uploader") or d.get("channel") or "").lstrip("@"),
        "title": title[:300],
        "views": video_views(url, raw_views, paid=paid),
        "likes": int(d.get("like_count") or 0),
        "comments": int(d.get("comment_count") or 0),
        "duration": float(d.get("duration") or 0),
        "metricsAt": now_iso(),
    }


def source_metrics(meta, fallback_duration=None):
    """The lynxr_sources metric columns for a SUCCESSFUL fetch_meta result.

    `views` may be None, and None is written through as SQL NULL on
    purpose — supabase/sources_staff_read.sql's own comment on that column
    says NULL means never-measured and is NOT the same as 0. Callers must
    not call this with a falsy `meta`: {} means "could not ask", and
    blanking a good number over a transport hiccup is the mistake this
    whole plan exists to stop.
    """
    return {
        "views":      meta.get("views"),
        "likes":      meta.get("likes"),
        "comments":   meta.get("comments"),
        "duration":   meta.get("duration") or fallback_duration,
        "creator":    meta.get("creator") or "",
        "title":      meta.get("title") or "",
        "metrics_at": now_iso(),
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
        clear_soft_fail(a, "video_upsert")
    except Exception as e:  # noqa: BLE001
        log.warning("  database upsert skipped: %s", str(e)[:120])
        note_soft_fail(a, "video_upsert", e)


# ============================================================================
# process_one() (pre-Step-7) is now split in two, so main() can do the source
# half ONCE PER VIDEO (Step 7c) and share it across every sibling adaptation
# pasted for the same source, instead of once per adaptation:
#
#   fill_source()      download/transcribe/cover/frames/shots/tags — the part
#                       that is a property of the VIDEO, not the brand.
#   extract_format()    the topic-stripped format — also video-not-brand, but
#                       kept separate so FUSE_FORMAT_ADAPT (Step 13) can skip
#                       it for a solo branded entry and fold it into the
#                       adaptation call instead.
#   fill_adaptation()   the per-brand rewrite (or the no-brand "here is your
#                       script" finish) — the only part that is NOT shared.
# ============================================================================


def fill_source(a, aclient, key, notes, timings, publish=None):
    """The video-dependent half of a script: download, transcribe, cover,
    frames, shots, tags. Populates a["source"]. Independent of brand, so
    main() runs this ONCE per distinct video and deep-copies the result onto
    every sibling entry asking for the same source (Step 7c).

    `notes` and `timings` are the CALLING entry's lists/dicts — appended to in
    place, same as the old process_one, so a partial failure here still lets
    the entry land with whatever it managed.

    `publish`, when given, is called with a phase name as each one starts —
    see publish_phase(). Optional and trailing so ab_format_adapt.py's
    positional calls stay untouched and its arm timings stay comparable.

    Returns True if there is a usable source to proceed with; False only for
    the "no ANTHROPIC_API_KEY" case, where the transcript is all there ever
    will be. Raises on a hard failure (nothing downloaded at all) — the same
    as process_one always did; main() marks the whole group as errored.
    """
    url = a.get("sourceUrl")
    if not url:
        raise RuntimeError("no source URL on this adaptation")

    if REUSE_SOURCES:
        with stage(timings, "source_cache"):
            cached = cached_source(key, url)
        if cached:
            # A cache hit skips both "reading" and "watching" outright — there
            # is nothing left mid-run for a phase to describe, and publishing
            # one here would cost a graft to say something already over.
            timings["source_cache"] = "hit"
            a["source"] = {
                "platform": cached.get("platform") or platform_of(url),
                "script": cached.get("script"),
                "shots": cached.get("shots"),
                # Not in Step 8's populate list, but cached_source SELECTs it
                # and upsert_source() below writes src.get("tags") back onto
                # this same row — omitting it here would null out the
                # library's tags on the very next write.
                "tags": cached.get("tags"),
                "duration": (cached.get("script") or {}).get("duration"),
                "cover": (f"{SB_URL}/storage/v1/object/public/{COVER_BUCKET}/"
                         + hashlib.sha1(canon_url(url).encode()).hexdigest()[:20] + ".jpg"),
            }
            a["format"] = cached.get("format")
            return True

    if publish:
        publish("reading")

    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        with stage(timings, "download"):
            media, err = download_video(str(url).strip(), td)
            if not media:
                media, err2 = fetch_audio(url, td)   # video refused; audio still scripts it
                if not media:
                    raise RuntimeError(f"download failed: {err or err2}")

        with stage(timings, "transcribe"):
            t = transcribe(str(media), WHISPER_MODEL)
        src = a.setdefault("source", {})
        # Before anything billable: the cover is free, and a source that fails
        # at the model steps is exactly the one a creator needs to recognise.
        try:
            with stage(timings, "cover"):
                blob = make_cover(media, td)
                if blob:
                    src["cover"] = upload_cover(
                        key, hashlib.sha1(canon_url(url).encode()).hexdigest()[:20], blob)
        except Exception as e:  # noqa: BLE001
            log.warning("  -> no cover: %s", api_reason(e))
            note_soft_fail(a, "cover", e)
        else:
            clear_soft_fail(a, "cover")
        src.update({
            "platform": platform_of(url),
            "duration": t["duration"],
            "script": {"hook": t["hook_spoken"], "duration": t["duration"],
                       "language": t["language"], "has_speech": t["has_speech"],
                       "text": t["text"], "segments": t["segments"]},
        })

        if not aclient:
            notes.append("transcript only — format + script need ANTHROPIC_API_KEY")
            return False

        if publish:
            publish("watching")
        with stage(timings, "frames"):
            frames = extract_frames(media, frame_times(t, t["duration"]), td)

        def do_shots():
            if not frames:
                notes.append("no frames (audio-only source)")
                return
            try:
                with stage(timings, "shots"):
                    src["shots"] = analyze_frames(MeteredClient(aclient), frames)["shots"]
                log.info("  shot list: %d frame(s)", len(frames))
            except Exception as e:  # noqa: BLE001
                notes.append(f"shot list failed: {api_reason(e)}")
                mark_ai_fail(a, api_reason(e))

        # WHY TAGGING IS NOT DEFERRED PAST THE SCRIPT (asked 2026-08-17, measured,
        # declined). Two real pastes minutes apart: tags 57.28s then 7.05s, no code
        # change. At 7s it is not the bottleneck — and it is not even ON the
        # critical path, because it runs CONCURRENTLY with the shot list in the pool
        # below, and on the second script shots took 16.64s. Deferring tags would
        # have saved that script exactly ZERO seconds.
        #
        # The cost of deferring is not zero: source_digest() puts the tags in front
        # of BOTH the format extraction and the adaptation, so moving them out
        # changes what the model sees when it writes the script — the deliverable.
        # It would also need a second graft, a re-entrant upsert_source/upsert_video,
        # and group-level sequencing after run_entry's per-entry pool.
        #
        # The remaining levers are the ~25s of strictly sequential Opus
        # (format 8.1s + adapt 16.7s — that is what FUSE_FORMAT_ADAPT targets) and
        # the shot list's own variance. Not this.
        def do_tags():
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
                # `effort` lives INSIDE output_config, beside `format` — not
                # as a top-level parameter. Haiku 4.5 REJECTS it (400), so a
                # TAG_MODEL of claude-haiku-4-5 must not carry one; Opus 5
                # takes low/medium/high/xhigh/max and defaults to high.
                out_cfg = {"format": {"type": "json_schema", "schema": schema}}
                if TAG_EFFORT and not TAG_MODEL.startswith("claude-haiku"):
                    out_cfg["effort"] = TAG_EFFORT
                with stage(timings, "tags"):
                    msg = aclient.messages.create(
                        model=TAG_MODEL, max_tokens=2000,
                        system=sys_block(TAG_SYSTEM),
                        output_config=out_cfg,
                        messages=[{"role": "user", "content": content}])
                note_usage(TAG_MODEL, msg)
                u = getattr(msg, "usage", None)
                log.info("  tag call: %d frame(s), %d out, cache %dw/%dr, thinking=%s",
                         len(frames),
                         getattr(u, "output_tokens", 0) or 0,
                         getattr(u, "cache_creation_input_tokens", 0) or 0,
                         getattr(u, "cache_read_input_tokens", 0) or 0,
                         any(getattr(b, "type", None) == "thinking" for b in msg.content))
                # Deliberately NOT routed through structured()'s malformed-
                # response handling (Step 5). A tags failure is soft — the
                # pass still delivers the script, and run_entry drops this
                # marker once the entry has something usable — so a shape
                # fluke here cannot strand anything the way one in
                # structured() could. Asymmetric on purpose, not an oversight.
                src["tags"] = undouble(json.loads(first_text(msg)))
            except Exception as e:  # noqa: BLE001
                notes.append(f"tags failed: {api_reason(e)}")
                mark_ai_fail(a, api_reason(e))

        # Independent of each other: analyze_frames reads `frames`; the tag
        # call reads user_content(row, t) plus frames[0]. Neither reads the
        # other's output — only source_digest(), which runs after both, needs
        # them together. Saves ~5.5s outright, no model or prompt change.
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda f: f(), (do_shots, do_tags)))

    return True


def extract_format(aclient, a, notes, timings, publish=None):
    """The topic-stripped format extraction call, on its own.

    Used whenever FUSE_FORMAT_ADAPT does not (or cannot) fold this into the
    adaptation call: an original-script entry always needs it standalone,
    since there is no adaptation to fuse it into, and a multi-sibling group
    always extracts it once here rather than per-brand (Step 7c).
    """
    if publish:
        publish("structure")
    try:
        with stage(timings, "format"):
            a["format"] = structured(
                aclient, FORMAT_SYSTEM, FORMAT_SCHEMA,
                "Extract the reusable format from this video.\n\n" + source_digest(a))
        return True
    except Exception as e:  # noqa: BLE001
        notes.append(f"format extraction failed: {api_reason(e)}")
        # The consequential one. Without a format the entry has nothing in it a
        # creator can use, brand or no brand — and because this does not raise,
        # it lands as "done" rather than crashing the whole entry. wants_work()
        # still reopens it on the aiFail schedule below.
        mark_ai_fail(a, api_reason(e))
        return False


def thin_script(ad, fmt):
    """Is this answer too short to BE the format it was told to reuse?

    Empty is the extreme case and was the only one caught before. Measured on
    the 25 branded scripts written to date: 24 have >= 1.0x their format's beat
    count and one has 0.17x (1 beat against a 6-beat format) — so half the
    format's beats sits far below every healthy sample and above the only
    defect. Guarded on a format of at least 3 beats, because "half" of a
    2-beat format is not a signal.
    """
    n = len((ad or {}).get("beats") or [])
    if n == 0:
        return True
    nf = len((fmt or {}).get("beats") or [])
    return nf >= 3 and n * 2 < nf


def fill_adaptation(a, creator, aclient, notes, timings, fuse=False, publish=None):
    """The per-brand rewrite (or the no-brand "here is your script" finish).

    Assumes fill_source() already ran (a["source"] is populated, possibly
    copied from a sibling's run). a["format"] may already be set too — by
    extract_format() run once for the group, or, on a solo branded entry
    under FUSE_FORMAT_ADAPT, not yet — see `fuse`.

    NO BRAND IS A VALID, FINISHED RESULT (owner, 2026-08-13). A creator with a
    brand-new account has nothing to adapt FOR, and making them set a company
    up before they can see anything is the wall that lost us a live account
    once already. So a link with no brandId is a first-class request: read the
    video, hand back its actual script and structure, and stop there. The app
    then offers to rewrite it for a company, which is the point at which
    asking for one is a favour rather than a toll gate.
    """
    if not a.get("brandId"):
        # Original-script entry: still needs its format even under fusion —
        # there is no adaptation call to fuse it into. Skipped when the
        # group's own extraction already failed (the marker is copied onto
        # siblings in process_group), so the same overloaded API is not
        # asked twice inside one pass. Kept as a fallback for callers that
        # do not extract first — ab_format_adapt.py does.
        if not a.get("format") and not (a.get("aiFail") or {}).get("kind"):
            extract_format(aclient, a, notes, timings)
        # NOT creator-visible. `notes` is raw internal text ("tags failed:
        # Overloaded"); the original-script card renders no note at all, and
        # this keeps the detail on the row where the owner can read it after
        # the container's log is gone.
        clear_note(a)
        if notes:
            a["diag"] = "; ".join(notes)[:300]
        return

    brand = next((b for b in (creator.get("brands") or [])
                  if b.get("id") == a.get("brandId")), None)
    if not brand:
        notes.append("brand not found on this creator profile")
        a["diag"] = "; ".join(notes)[:300]
        raise CreatorFacing("brand_missing", retryable=False)

    if not a.get("format") and not fuse:
        # ONE extraction per VIDEO, not one per brand. process_group runs
        # extract_format() for the group's representative and deep-copies
        # the result (or, when it failed, the failure marker) onto every
        # sibling — so reaching here means that call already ran and failed,
        # and re-running it asked an API that had just said "overloaded" the
        # same question seconds later, printed the same sentence twice on
        # the card, and paid for it. The 5/10/20/40/60-minute aiFail
        # schedule is the retry.
        #
        # AND IT RAISES. The old early return left a BRANDED entry as
        # "done" with no adaptation, which is the state that renders as a
        # "source only" chip with raw internal notes under it (seen live,
        # 2026-08-18). run_entry's handler owns every creator-facing failure
        # sentence; this is how the failure gets there. Status "error" does
        # NOT slow the retry down — wants_work()'s error branch is
        # `ai_retry_due(a) or cooled(...)`, i.e. the faster of the two.
        why = (a.get("aiFail") or {}).get("reason") or (
            "no ANTHROPIC_API_KEY, so the model was never called" if not aclient
            else "the format step did not run")
        raise RuntimeError(f"no format for this video: {why}")

    if publish and a.get("brandId"):
        publish("writing")
    try:
        if fuse and not a.get("format"):
            # FUSE_FORMAT_ADAPT is untouched by Step 7's guard: this path has
            # no second ask on a thin result (it is a single fused call, and
            # this is default-OFF), only the thin *marker* below still records
            # a thin outcome here so it is not silent. Do not assume the
            # re-ask guard covers this branch.
            with stage(timings, "format_adapt_fused"):
                fmt, ad = fused_format_and_adapt(aclient, a, brand, creator)
            a["format"] = fmt
        else:
            # If the format step stripped a wrapper, say so again here. The
            # source digest below still contains the WHOLE original —
            # including the portfolio intro — and left unsaid the model
            # drifts back to it and writes the frame it was supposed to
            # discard.
            wrapper = (a.get("format") or {}).get("wrapper_removed") or ""
            frame = (f"\n=== IGNORE THE FRAMING ===\nThe original is wrapped in: {wrapper}\n"
                     "That framing is NOT part of the format. It appears in the transcript and "
                     "shots below — skip past it and adapt only the piece inside. Never open with "
                     "the creator introducing themselves or their work.\n" if wrapper else "")
            prompt = ("Adapt this format for the brand below.\n\n"
                      f"=== DELIVERY ===\n{delivery_mode_text(a)}\n{frame}\n"
                      f"=== FORMAT TO REUSE ===\n{json.dumps(a['format'], indent=1)}\n\n"
                      f"=== ORIGINAL VIDEO (for reference — do NOT reuse its topic) ===\n{source_digest(a)}\n\n"
                      f"=== BRAND ===\n{brand_digest(brand, creator)}")
            # A script with no beats is not a script, and the schema cannot
            # catch it: the model can return a perfectly valid SHELL — a real
            # fit, a real fit_reason, a hook — and then `beats: []`, `cta: ""`,
            # caption "placeholder". Nothing downstream looked, so the entry
            # went "done" and the creator opened a card headed "Your script"
            # with nothing underneath it. Seen live on 2026-08-12 against a
            # good source: 722 characters of transcript, 15 segments, 6
            # shots, fit 0.88.
            #
            # Ask once more before giving up. It is one Opus call against a
            # retry that usually works, versus handing someone an empty
            # script or making them wait out the six-hour cooldown.
            with stage(timings, "adapt"):
                ad = structured(aclient, ADAPT_SYSTEM, ADAPT_SCHEMA, prompt, max_tokens=4000)
                if thin_script(ad, a.get("format")):
                    log.warning("  -> adaptation came back thin (%d beats against a %d-beat "
                                "format); asking again", len(ad.get("beats") or []),
                                len((a.get("format") or {}).get("beats") or []))
                    ad = structured(
                        aclient, ADAPT_SYSTEM, ADAPT_SCHEMA,
                        prompt + "\n\n=== IMPORTANT ===\nYour last answer had "
                        f"{len(ad.get('beats') or [])} beat(s) against a "
                        f"{len((a.get('format') or {}).get('beats') or [])}-beat format, "
                        "which is not a usable script. Write the full beat list: one beat "
                        "per beat of the format above, each with `say`, `do` and `show` "
                        "filled in as the delivery requires.",
                        max_tokens=4000)
        if not (ad.get("beats") or []):
            raise RuntimeError("the model returned a script with no beats")
        a["adaptation"] = ad
        if thin_script(ad, a.get("format")):
            a["thin"] = {"beats": len(ad.get("beats") or []),
                         "formatBeats": len((a.get("format") or {}).get("beats") or []),
                         "at": now_iso()}
            log.warning("  -> still thin after a second ask: %d beats against %d",
                        a["thin"]["beats"], a["thin"]["formatBeats"])
        else:
            a.pop("thin", None)
    except Exception as e:  # noqa: BLE001
        notes.append(f"adaptation failed: {api_reason(e)}")
        mark_ai_fail(a, api_reason(e))

    if notes:
        a["diag"] = "; ".join(notes)[:300]
    clear_note(a)

    # An entry with no script is a FAILURE, not a finished job. Left as "done"
    # it renders as a "source only" card with no Try again button. Raising
    # hands it to run_entry(), which marks it error — so the creator gets a
    # Try again button and the cooldown retries it on its own.
    # (`aiFail` was stamped at the failure site above, so wants_work() now also
    # reopens this on the billing/rate-limit/overload schedule rather than only
    # on the six-hour error cooldown. Raising is still right: it is what makes
    # the failure VISIBLE to the creator rather than a quiet "done".)
    if not ((a.get("adaptation") or {}).get("beats") or []):
        raise RuntimeError(a.get("note") or "no script was produced")


@contextmanager
def claim_heartbeat(key, cid, aid):
    """Keep one entry's claim alive for as long as it is actually being
    worked on (Step 3b) — a daemon thread renews claimedAt every 45s so the
    lease only has to outlive one heartbeat interval, not the worst legitimate
    script."""
    stop = threading.Event()
    t = threading.Thread(target=heartbeat, args=(key, cid, aid, stop), daemon=True)
    t.start()
    try:
        yield
    finally:
        stop.set()


def run_entry(key, cid, data, a, aclient, notes, fuse):
    """Everything after the source (and, for a solo branded entry, its
    format) is ready for THIS one entry: the per-brand rewrite, status,
    delivery, and the library writes.

    Called once per adaptation — by process_group's inner pool for every
    member of a shared-source group, so several of these can be running at
    once, both within one group (Step 7c) and across groups (Step 7a).
    """
    log.info("[%s] %s -> %s", data.get("name", cid[:8]),
             (a.get("sourceUrl") or "")[:52], a.get("brandName", "?"))
    prev_attempt = a.get("attemptedAt")
    a["attemptedAt"] = now_iso()
    a["attempts"] = int(a.get("attempts") or 0) + 1
    hist = a.setdefault("attemptHistory", [])
    if prev_attempt:
        hist.append(prev_attempt)
    del hist[:-5]                       # keep the last five, no more
    # ABOUT TO PAY TWICE. Beats + a processedAt means a finished script already
    # exists on this entry; re-running it re-bills the whole chain. This is the
    # 2026-08-18 renew_claim race, seen from the other side. RECORD ONLY —
    # changing control flow here is a fix, not an alarm, and is out of scope
    # (see "Noticed, not planned" in the plan this implements). Honest gap: on
    # 2026-08-18 the racing graft had ERASED the beats before the re-run, so
    # this specific marker would not have caught that instance —
    # pipeline/watchdog.py's `inflight:` alarm at 10 minutes would have, since
    # the entry sat `running` for 1548s. This marker catches the class where
    # the evidence survives; the stall alarm catches the class where it does
    # not.
    if (not FORCED and a.get("processedAt") and not a.get("aiFail")
            and ((a.get("adaptation") or {}).get("beats") or [])):
        a["rerun"] = {"at": a["attemptedAt"], "prevProcessedAt": a.get("processedAt"),
                      "prevBy": a.get("claimedBy"),
                      "beats": len((a.get("adaptation") or {}).get("beats") or [])}
        log.error("  -> RE-RUN: this entry already finished at %s with %d beats",
                  a.get("processedAt"), a["rerun"]["beats"])
    was = a.get("aiFail") or {}
    if was:
        log.info("  retrying a failed AI step (%s, try %s of %d): %s",
                 was.get("kind"), int(was.get("tries") or 0) + 1,
                 AI_MAX_TRIES, was.get("reason", "")[:70])
    timings = a.setdefault("timings", {})
    with claim_heartbeat(key, cid, a.get("id")):
        try:
            fill_adaptation(a, data, aclient, notes, timings, fuse=fuse,
                             publish=lambda phase: publish_phase(key, [(cid, a)], phase))
            # DID THIS PASS PRODUCE SOMETHING USABLE? — not "did anything
            # fail", which is what the old `attemptedAt` comparison answered
            # by accident (every source-phase marker carried a stale stamp,
            # so it always looked like an earlier attempt's). An entry that
            # lost its shot list to a 529 but still delivered a full script
            # is a working result with a gap in it — the same rule
            # ai_gave_up() applies — and reopening it would re-run and
            # re-bill a script the creator already has. An entry with NO
            # format has nothing, so it keeps its marker and the schedule
            # brings it back. THAT is the case Step 3 would otherwise have
            # broken: the duplicate format call it removes is the only
            # reason an original-script entry's marker survives today.
            #
            # KEEP A BREADCRUMB when the marker does go. Popping it outright
            # made a self-healed retry byte-identical to the 2026-08-18
            # double-bill shape (done + attempts>=2 + no aiFail), which is
            # what made watchdog.py's rerun: alarm page on a script that
            # worked. kind and tries are enumerated/numeric — no provider
            # text, and nothing renders this.
            if a.get("format") or ((a.get("adaptation") or {}).get("beats") or []):
                prev = a.pop("aiFail", None)
                if prev:
                    a["healed"] = {"kind": prev.get("kind"),
                                   "tries": int(prev.get("tries") or 0),
                                   "at": now_iso()}
            if ai_gave_up(a):
                # Out of automatic goes with nothing usable to show. Say so
                # as an error: that is the one status the creator's card
                # renders a Try again button for, so a dead end becomes a
                # thing they can see and act on instead of a silent "done".
                a["status"] = "error"
                # aiFail.reason stays on the record (watchdog and --redo-ai
                # read it) — it just stops being what the creator sees. For a
                # billing failure that reason is Anthropic's own sentence
                # about OUR credit balance, which is not this creator's
                # problem to read on their card.
                set_note(a, "gave_up", tries=AI_MAX_TRIES)
                mark_final(a, "gave_up")
                log.error("  -> GAVE UP after %d tries: %s", AI_MAX_TRIES,
                          (a.get("aiFail") or {}).get("reason", ""))
                # OPTION (b) ONLY — see Step 12. This is the branch a no-brand
                # entry reaches, since a branded one now raises into Step 7's
                # handler instead.
                refund(key, a, "gave up")
            else:
                a["status"] = "done"
            a["processedAt"] = now_iso()
            with stage(timings, "graft"):
                graft_adaptations(key, cid, [a])   # the creator has it NOW
            # The value here was fetched by process_group's prefetch — a
            # thread started alongside the source pass and joined onto `rep`
            # before this group's siblings were deep-copied, so it is already
            # sitting on a["source"]["meta"] by the time this runs. Marked
            # here rather than at fetch_meta's own call site, since that call
            # no longer lives on this creator's critical path.
            if not (a.get("source") or {}).get("meta") and a.get("sourceUrl"):
                note_soft_fail(a, "meta", "yt-dlp returned nothing")
            else:
                clear_soft_fail(a, "meta")
            upsert_source(key, a)                  # library second — it is not their wait
            upsert_video(key, a)                   # and into the main video database
            if a.get("softFails"):
                # A second graft, only when something actually failed. The
                # creator already has their script (grafted above), so this is
                # off the SLA path and costs nothing in the happy path. Without
                # it a softFails marker from either upsert above would never
                # reach the database — the completion graft already ran before
                # they were even attempted.
                try:
                    graft_adaptations(key, cid, [a])
                except Exception as e:  # noqa: BLE001
                    log.warning("  soft-fail marker not persisted: %s", str(e)[:90])
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
            log_usage("this script", usage())
            usage().clear()
        except Exception as e:  # noqa: BLE001
            a["status"] = "error"
            # THE ONE PLACE A FAILED ENTRY GETS ITS SENTENCE. Classified, never
            # the raw exception text — str(e) here could be Anthropic's own
            # sentence about OUR credit balance or an internal stack trace. The
            # raw string still goes to log.error below, unchanged.
            if isinstance(e, CreatorFacing):
                set_note(a, e.key)
                a["retryable"] = e.retryable
            elif ai_gave_up(a):
                # Out of automatic goes with nothing usable to show. Reached
                # here as well as on the success path below, because the
                # branded no-format failure now raises (Step 4) — without this
                # an exhausted entry would keep promising a retry forever.
                set_note(a, "gave_up", tries=AI_MAX_TRIES)
                a["retryable"] = True
                log.error("  -> GAVE UP after %d tries: %s", AI_MAX_TRIES,
                          (a.get("aiFail") or {}).get("reason", ""))
            else:
                # THE MARKER, NOT THE EXCEPTION TEXT. fill_adaptation clears the
                # note and re-raises a generic "no script was produced", which
                # classifies as `content` — so a 529 of ours reached the creator
                # as "we couldn't write a script from that video". aiFail.kind is
                # what ai_retry_due() indexes on; the sentence must match it.
                # Falls back to the exception for failures that never marked one
                # (a graft or upsert raising).
                kind = (a.get("aiFail") or {}).get("kind") or ai_failure_kind(api_reason(e))
                set_note(a, AI_NOTE_KEY.get(kind, "ai_video"))
                # Everything reaching here got past the download, so it is a
                # model or write failure — those do clear on their own, and
                # ai_retry_due() already schedules them. Explicit so a card that
                # failed here never inherits a stale False from an earlier attempt.
                a["retryable"] = True
            # NEVER PROMISE A RETRY WE WILL NOT MAKE. The "ours" sentence ends
            # "— we're retrying", which becomes a lie the moment this entry
            # stops being picked up. If the loop is finished, the sentence has
            # to be the one that says so.
            why = final_reason(a, retryable=a.get("retryable", True))
            if why:
                if a.get("noteKind") == "ours":
                    set_note(a, "gave_up",
                             tries=int((a.get("aiFail") or {}).get("tries") or AI_MAX_TRIES))
                mark_final(a, why)
            log.error("  -> FAILED: %s", e)
            graft_adaptations(key, cid, [a])
            # OPTION (b) ONLY — see Step 12. After the graft, so a slow or
            # failing RPC can never delay the creator's error card.
            refund(key, a, "no script was produced")


def process_group(key, aclient, group):
    """One canon_url's worth of jobs — Step 7c. `group` is a list of
    (cid, data, a) tuples, all sharing one source video.

    Does the source half ONCE, on the group's first entry, deep-copies the
    result onto every sibling, then runs each entry's per-brand adaptation (or
    no-brand finish) concurrently — so N brands pasted for the same video pay
    for one download/transcribe/shot-list/tag/format pass, not N.
    """
    cid0, data0, rep = group[0]
    rep_timings = rep.setdefault("timings", {})
    source_notes = []
    # ONE PASS, ONE TOKEN, stamped before fill_source can fail. Every mark
    # below compares against it, so `tries` counts attempts rather than
    # failed steps. process_group owns this because it owns the pass: it is
    # the only place that runs before every failure site in one.
    for _cid, _data, entry in group:
        begin_attempt(entry)
    # Fuse only a SOLO branded entry (Step 13): fusing skips the separate
    # format call, so a multi-sibling group would lose Step 7c's format reuse
    # for every extra brand — a worse trade than the round trip it saves. Both
    # steps are default-off/on respectively, so in practice this only matters
    # once the owner turns FUSE_FORMAT_ADAPT on.
    fuse = FUSE_FORMAT_ADAPT and len(group) == 1 and bool(rep.get("brandId"))
    # The whole group shares one source pass, so every sibling must get the
    # phase, not just the representative — otherwise a two-brand send shows
    # one card moving and one frozen.
    pub = lambda phase: publish_phase(key, [(c, e) for c, _d, e in group], phase)  # noqa: E731
    # THE TITLE, FETCHED CONCURRENTLY WITH THE SCRIPT. This used to run in
    # run_entry() AFTER the completion graft (1.4s of yt-dlp that the
    # creator should not wait for), which meant source.meta was fetched,
    # used for the two library upserts, and then dropped on the floor —
    # verified live 2026-08-18: every record processed before a66fe51
    # carries source.meta and every record after it carries none, and those
    # are exactly the cards reading "Instagram reel". A daemon thread
    # started here overlaps it with an 11s+ source pass instead, so the
    # caption rides the completion graft at no cost to the wait.
    # ONE call per GROUP, not per entry: the title is a property of the
    # video, so N brands pasted for one video now cost one lookup, not N.
    meta_box = {}
    meta_thread = threading.Thread(
        target=lambda: meta_box.update(m=fetch_meta(rep.get("sourceUrl") or "")),
        daemon=True)
    meta_thread.start()
    try:
        with claim_heartbeat(key, cid0, rep.get("id")):
            ok = fill_source(rep, aclient, key, source_notes, rep_timings, publish=pub)
            if ok and not fuse and not rep.get("format"):
                extract_format(aclient, rep, source_notes, rep_timings, publish=pub)
    except Exception as e:  # noqa: BLE001
        # No sibling in this group has a source either — all fail alike.
        note_key, retryable = fetch_failure(e)
        for cid, data, a in group:
            a["status"] = "error"
            set_note(a, note_key)
            # False means Try again is pointless and creator.js hides it. Only
            # ever written here, and only False for a recognised permanent
            # wall — see FETCH_FAILURES.
            a["retryable"] = retryable
            why = final_reason(a, retryable=retryable)
            if why:
                mark_final(a, why)
            # Reached only when fill_source raised, i.e. before extract_format
            # and before any Anthropic call — nothing was spent on this entry,
            # so a charge taken for it (main() charges before the claim, this
            # exception fires after) is refunded. Best-effort: a failed
            # refund must not cost the creator their error card, and the
            # over-refund it would leave is bounded and visible in
            # lynxr_script_charges, not silent.
            refund(key, a, "source failed before any model call")
            graft_adaptations(key, cid, [a])
        # The raw stderr stays in the log, where whoever is debugging can see
        # it, and out of the row, where a creator would.
        log.error("  -> FAILED (source): %s%s", e, "" if retryable else "  [permanent]")
        return

    # Joined here, not in the `try` above: on the failure path the group is
    # already errored and nobody should wait on a lookup nothing will read.
    # Daemon, so a hung yt-dlp can never hold the process open; the 20s is
    # slack for the rare cached-source hit, where fill_source returns in
    # under a second and this has not finished yet.
    with stage(rep_timings, "meta"):
        meta_thread.join(timeout=20)
    (rep.setdefault("source", {}))["meta"] = meta_box.get("m") or {}

    for cid, data, a in group[1:]:
        a["source"] = copy.deepcopy(rep.get("source"))
        if rep.get("format") is not None:
            a["format"] = copy.deepcopy(rep.get("format"))
        elif (rep.get("aiFail") or {}).get("reason"):
            # The shared format extraction failed, so it failed for every brand
            # in this group. Without this a sibling reaches fill_adaptation with
            # no format AND no marker, and (before Step 4) made its own
            # duplicate call to find that out. mark_ai_fail rather than a copy,
            # so each sibling keeps its OWN tries bookkeeping.
            mark_ai_fail(a, rep["aiFail"]["reason"])

    def run_one(job):
        cid, data, a = job
        notes = list(source_notes) if a is not rep else source_notes
        run_entry(key, cid, data, a, aclient, notes, fuse=(fuse and a is rep))

    # Bounded independent of args.concurrency: a group is a handful of brands
    # for one video (2, occasionally 4), never worth spending a large pool on.
    with ThreadPoolExecutor(max_workers=min(len(group), 4)) as pool:
        list(pool.map(run_one, group))


def renew_claim(key, cid, aid):
    """Re-stamp claimedAt on one adaptation, by id, without touching the
    in-memory copy the worker thread is still mutating.

    The lease exists so a killed run does not park an entry forever. Without a
    heartbeat the lease has to be longer than the worst legitimate script, so
    it was 25 minutes — and a mid-pass death cost the creator all 25 of them
    (measured: an entry claimed 4s after the paste, delivered 1504s after).
    With a heartbeat the lease only has to outlive one heartbeat interval.
    """
    # UNDER THE SAME LOCK graft_adaptations() uses, and for the same reason: this
    # is a read-modify-write of the WHOLE row. Unlocked, it raced the completion
    # graft and lost a finished script — measured 2026-08-18, worker log said
    # "fit=0.62, 10 beats / done" at 04:47:11 while the row stayed status=running
    # with beats=0, so the 2.5-minute lease lapsed and the next sweep re-ran and
    # re-billed the same paste ($0.0539 + $0.0482 for one script, and the creator
    # got the second, shorter version). The heartbeat renews a claim; it must
    # never be able to write back a snapshot taken before the script landed.
    with _GRAFT_LOCKS[cid]:
        fresh = sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}&select=data")[0]["data"]
        for entry in fresh.get("adaptations") or []:
            if entry.get("id") == aid:
                # Already finished (or failed) between the last heartbeat and
                # this one — renewing now would re-stamp a claim on a terminal
                # entry for no reason. Nothing to hold.
                if entry.get("status") in ("done", "error"):
                    return
                entry["claimedAt"] = now_iso()
                break
        else:
            return
        sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}", method="PATCH", body={"data": fresh})


def apply_views(entries, canon, views, at):
    """Set source.meta.views/metricsAt on every entry for one video.
    Returns the number of entries actually changed. Pure — no I/O.

    - Matches on canon_url(entry.sourceUrl) == canon, not raw string
      equality — two creators paste the same video with different query
      strings.
    - Skips any entry whose status is "queued" or "running" — that entry is
      in flight and something else owns it; the same guard renew_claim uses
      when it refuses to re-stamp a terminal entry, for the same reason
      (HANDOFF, 2026-08-18: an unlocked read-modify-write raced the
      completion graft and erased a finished script).
    - Skips any entry with no existing source.meta dict — never invent a
      source object on an entry the pipeline never fetched; has_usable_result()
      and the title resolvers both read that shape.
    - Skips when the value is already what it would be set to, so an
      unchanged refresh writes nothing.
    """
    changed = 0
    for entry in entries:
        if canon_url(entry.get("sourceUrl") or "") != canon:
            continue
        if entry.get("status") in ("queued", "running"):
            continue
        source = entry.get("source")
        if not isinstance(source, dict):
            continue
        meta = source.get("meta")
        if not isinstance(meta, dict):
            continue
        if meta.get("views") == views:
            continue
        meta["views"] = views
        meta["metricsAt"] = at
        changed += 1
    return changed


def refresh_entry_views(key, cid, canon, views, at):
    """Re-read this creator's row and update only source.meta.views on the
    entries for one video. Modelled on renew_claim(): under the SAME
    _GRAFT_LOCKS[cid] lock and mutating the FRESHLY read row, never a
    snapshot — see renew_claim's docstring for the script that was lost the
    one time this was done without both. Deliberately does NOT touch
    updatedAt, claimedAt, status, phase or anything else. Returns the number
    of entries apply_views actually changed."""
    with _GRAFT_LOCKS[cid]:
        fresh = sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}&select=data")[0]["data"]
        changed = apply_views(fresh.get("adaptations") or [], canon, views, at)
        if changed:
            sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}", method="PATCH", body={"data": fresh})
        return changed


def views_or_clause(now, max_age_h, retry_h=0, retry_window_h=0):
    """The PostgREST `or=(...)` body selecting rows due a view refresh.

    Pure and separate from refresh_views() for the same reason too_young() is:
    the selection rule is the thing that was wrong, so it has to be testable
    without a database. Returns the clause body WITHOUT the wrapping parens.

    Three ways a row qualifies:
      * metrics_at IS NULL          — never fetched at all
      * metrics_at older than max_age_h  — the ordinary staleness clock
      * (paid pools only) views IS NULL AND the row is younger than
        retry_window_h AND metrics_at older than retry_h — the never-succeeded
        case, retried fast but only for a bounded window.
    """
    def stamp(hours):
        return urllib.parse.quote(
            (now - timedelta(hours=hours)).isoformat().replace("+00:00", "Z"), safe="")
    clauses = ["metrics_at.is.null", f"metrics_at.lt.{stamp(max_age_h)}"]
    if retry_h and retry_window_h:
        clauses.append("and(views.is.null,"
                       f"first_seen_at.gt.{stamp(retry_window_h)},"
                       f"metrics_at.lt.{stamp(retry_h)})")
    return ",".join(clauses)


def refresh_views(key, limit):
    """Refresh stale lynxr_sources view counts and propagate the new number
    to every creator entry holding that video. Never raises — a failure
    here must never fail the pass it rides on.

    Two pools, each on its own staleness clock: VIEWS_TRUSTED_PLATFORMS
    (tiktok/youtube, free via yt-dlp) at VIEWS_MAX_AGE_H, and
    VIEWS_PAID_PLATFORMS (instagram, paid via Apify) at the much longer
    VIEWS_PAID_MAX_AGE_H — see the plan's Assumption 2 for why weekly, not
    daily. `limit` is per pool, so a pass does at most `limit` free fetches
    and at most `limit` PAID ones — default 3, i.e. $0.0069 a pass, worst
    case.

    Steady-state rate: a row is re-selected only once its metrics_at is
    older than its pool's staleness window, so this is one fetch per
    views-capable video per that window, not one per pass. In paid terms:
    one Apify lookup per Instagram video per VIEWS_PAID_MAX_AGE_H (7 days
    by default), which at today's 24 Instagram rows in lynxr_sources is
    ~3.4 lookups a day, ~$0.24 a month.
    """
    considered = fetched = entries_updated = 0
    calls_before = _APIFY_CALLS
    try:
        # (platforms, staleness clock, short retry clock, retry window).
        # Only the PAID pool gets the retry pair — a free yt-dlp platform that
        # returns nothing is answered on the ordinary clock and costs nothing
        # to ask again, so it needs no bounded window.
        pools = ((VIEWS_TRUSTED_PLATFORMS, VIEWS_MAX_AGE_H, 0, 0),
                 (VIEWS_PAID_PLATFORMS,    VIEWS_PAID_MAX_AGE_H,
                  VIEWS_PAID_RETRY_H, VIEWS_PAID_RETRY_WINDOW_H))
        rows = []
        now = datetime.now(timezone.utc)
        for pool_platforms, pool_max_age_h, retry_h, retry_window_h in pools:
            if not pool_platforms:
                continue
            platforms = ",".join(pool_platforms)
            q = ("/rest/v1/lynxr_sources?select=canonical_url,url,platform,views,metrics_at"
                 f"&platform=in.({platforms})"
                 f"&or=({views_or_clause(now, pool_max_age_h, retry_h, retry_window_h)})"
                 f"&order=metrics_at.asc.nullsfirst&limit={limit}")
            rows.extend(sb(key, q) or [])
    except Exception as e:  # noqa: BLE001
        log.warning("refresh_views: selection failed: %s", str(e)[:120])
        return
    considered = len(rows)
    for row in rows:
        url = row.get("url") or ""
        try:
            # {} means "could not ask" — deleted, private, rate-limited, a
            # transport failure. Write nothing at all; blanking a good
            # number on a hiccup is the mistake source_metrics()'s docstring
            # names. paid=True: this is the sweep, the one caller allowed to
            # spend — video_views() still refuses to spend on anything
            # outside VIEWS_PAID_PLATFORMS, so a tiktok/youtube row here
            # never reaches Apify. No per-row platform branch is needed.
            meta = fetch_meta(url, paid=True)
            if not meta:
                log.info("  refresh: no metadata — %s", url[:60])
                continue
            fetched += 1
            # metrics_at moves whether or not a count came back, which is
            # what stops a views-less row being re-selected every pass.
            target = "/rest/v1/lynxr_sources?canonical_url=eq." + urllib.parse.quote(
                row.get("canonical_url") or canon_url(url), safe="")
            sb(key, target, method="PATCH", body=source_metrics(meta))

            canon = canon_url(url)
            try:
                probe_rows = sb(key, prefilter_url([[{"sourceUrl": url}]])) or []
            except Exception as e:  # noqa: BLE001
                log.warning("  refresh: creator probe failed for %s: %s", url[:50], str(e)[:90])
                continue
            # An empty probe means "nobody holds it", and must NOT trigger
            # candidate_creators()'s canary/full-scan fallback. That
            # machinery exists because an empty queue and a broken filter
            # were indistinguishable and the consequence was "no scripts get
            # written". Here the consequence is "a number stays a day old" —
            # not worth importing a 215 KB full scan to protect a decoration.
            if not probe_rows:
                log.info("  refresh: no creator holds %s", url[:60])
                continue
            at = now_iso()
            for r in probe_rows:
                try:
                    entries_updated += refresh_entry_views(
                        key, r["id"], canon, meta.get("views"), at)
                except Exception as e:  # noqa: BLE001
                    log.warning("  refresh: creator %s not updated: %s",
                                str(r.get("id"))[:8], str(e)[:90])
        except Exception as e:  # noqa: BLE001
            log.warning("  refresh: row failed (%s): %s", url[:50], str(e)[:90])

    paid_calls = _APIFY_CALLS - calls_before
    log.info("refresh_views: %d row(s) considered, %d fetched, %d creator entr%s updated, "
              "%d paid lookup(s) (~$%.4f)",
              considered, fetched, entries_updated, "y" if entries_updated == 1 else "ies",
              paid_calls, paid_calls * APIFY_PRICE_PER_LOOKUP_USD)


def heartbeat(key, cid, aid, stop_event, interval=45):
    """Run renew_claim every `interval` seconds until `stop_event` is set.

    Meant to run in a daemon thread for the life of one entry's processing.
    Swallows its own exceptions — a failed heartbeat must never fail a script;
    worst case the lease lapses and the sweep in worker.py recovers it, which
    is exactly the safety net this whole step is layered on top of.
    """
    while not stop_event.wait(interval):
        try:
            renew_claim(key, cid, aid)
        except Exception as e:  # noqa: BLE001
            log.warning("  heartbeat for %s skipped: %s", str(aid)[:8], str(e)[:90])


# One lock per creator, created on first use. Two threads grafting the SAME
# creator concurrently (Step 7's per-job worker pool) would lose one of the two
# writes in the read-modify-write below; grafts for DIFFERENT creators still
# run fully in parallel, since they touch different rows and different locks.
_GRAFT_LOCKS = collections.defaultdict(threading.Lock)


def refund(key, a, why):
    """Give the allowance charge back for an entry that produced nothing.

    Best-effort, exactly like the download-failure refund this replaces: a
    failed refund must never cost the creator their error card, and the
    over-refund it would leave is bounded and visible in
    lynxr_script_charges. Idempotent server-side — refund_script is a
    DELETE by primary key — so calling it twice for one entry is a no-op,
    and charge_scripts re-charges the id from scratch if the entry is ever
    picked up again.

    WHY IT IS NOT ONLY FOR DOWNLOAD FAILURES ANY MORE: three of the four
    sentences on a failed card end "Nothing was used from your allowance."
    The charge is taken in main() before the claim, so that was false on
    every model-side failure and flatly untrue after a give-up. The model
    spend is OURS; the allowance is theirs, and they got nothing.
    """
    try:
        sb(key, "/rest/v1/rpc/refund_script", method="POST", body={"p_id": a["id"]})
        log.info("  refunded the allowance charge (%s)", why)
    except Exception as e:  # noqa: BLE001
        log.warning("  refund not recorded for %s: %s",
                    str(a.get("id"))[:8], str(e)[:90])


def graft_adaptations(key, cid, touched):
    """Write only the adaptations this pass touched onto the creator's CURRENT row.

    Writing `data` wholesale would roll back everything the creator did while
    this ran — a transcript plus two model calls can take minutes, and saving
    library entries during it is exactly what the app is for. So re-pull now and
    graft only what changed. Anything the creator deleted mid-run stays deleted.
    """
    if not touched:
        return
    with _GRAFT_LOCKS[cid]:
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


# THE FOUR THINGS A CREATOR CAN SEE HAPPENING. Deliberately coarser than
# `timings`: that has eleven keys because it exists to attribute a
# regression, this has four because it exists to tell someone staring at
# a phone that their script is moving. Each one costs a graft — a read of
# this creator's row and a write back — so the count is the cost, and
# four is the most that earns its round trip.
#
#   reading   download + Whisper + cover     ~11s
#   watching  frames + shot list + tags      ~18s
#   structure format extraction              ~8s
#   writing   the adaptation                 ~17s
#
# Best-effort in the strongest sense: a creator waiting is a UI problem,
# a creator losing their script is not. Nothing here may raise.
def publish_phase(key, jobs, phase):
    """Stamp `phase` on each (cid, adaptation) and graft it back now."""
    stamp = now_iso()
    by_cid = collections.defaultdict(list)
    for cid, a in jobs:
        a["phase"] = phase
        a["phaseAt"] = stamp
        by_cid[cid].append(a)
    for cid, entries in by_cid.items():
        try:
            graft_adaptations(key, cid, entries)
        except Exception as e:  # noqa: BLE001
            log.warning("  phase %s not published: %s", phase, str(e)[:90])


def main():
    envcfg.sanitize_environ()
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-ai", action="store_true",
                    help="transcript only — no format extraction or adaptation (no API spend)")
    ap.add_argument("--redo-ai", action="store_true",
                    help="force EVERY failed AI step now, including 'content' ones no "
                         "timer retries. Billing/rate-limit/overload failures no longer "
                         "need this — they retry on their own.")
    ap.add_argument("--cooldown-hours", type=float, default=6,
                    help="min hours between retries of the same entry")
    ap.add_argument("--max-per-creator", type=int, default=2,
                    help="most adaptations to take from any one creator per run (0 = no cap)")
    ap.add_argument("--lease-minutes", type=float, default=2.5,
                    help="how long a claimed adaptation stays claimed before it is retryable "
                         "(default 2.5 — short because Step 3b heartbeats the claim every 45s "
                         "while an entry is genuinely being worked on; a dead worker's claim now "
                         "only has to be recovered, not survived for 25 minutes)")
    ap.add_argument("--backfill-covers", action="store_true",
                    help="give existing scripts a cover frame and exit. No model calls.")
    ap.add_argument("--warm-prefixes", action="store_true",
                    help="write the three cached prefixes and exit. Fired by worker.py in a "
                         "daemon thread at boot, before any discovery or database read.")
    ap.add_argument("--cap", type=int, default=int(envcfg.get("SCRIPT_CAP", "25")),
                    help="NOT the enforcement point any more — charge_scripts() "
                         "(supabase/allowance_ledger.sql, lynxr_allowance.granted) "
                         "is. This is now only (a) the number named in the refusal "
                         "sentence when a creator is over allowance, and (b) an "
                         "escape hatch for a local/--no-ai run against a database "
                         "where that table doesn't exist yet: 0 skips the "
                         "charge_scripts call entirely and treats every candidate "
                         "as allowed.")
    ap.add_argument("--daily-cap", type=int,
                    default=int(envcfg.get("DAILY_SCRIPT_CAP", "250")),
                    help="global circuit breaker: refuse ALL new work this pass once "
                         "this many scripts have been charged (lynxr_script_charges) "
                         "in the trailing 24h. 0 = unlimited. Per-account exposure is "
                         "bounded by the allowance; this is what bounds an unattended "
                         "night's worst case whichever gate turns out to leak. "
                         "pipeline/watchdog.py's spend-24h alarm reads the same count "
                         "against the same DAILY_SCRIPT_CAP so the two can never "
                         "disagree.")
    ap.add_argument("--concurrency", type=int,
                    default=int(envcfg.get("WORKER_CONCURRENCY", "3")),
                    help="distinct videos to process at once (Step 7) — default 3, "
                         "comfortable on Fly's 2 shared vCPUs since almost all of a "
                         "script's time is waiting on yt-dlp or the model API, not compute")
    ap.add_argument("--min-age-seconds", type=float, default=0,
                    help="ignore entries whose addedAt is younger than this. Used by the "
                         "GitHub fallback (--min-age-seconds 180) so it stays a genuine "
                         "backstop for Fly rather than racing it (Step 11c)")
    ap.add_argument("--reuse-sources", dest="reuse_sources", action="store_true", default=None,
                    help="use lynxr_sources as a cross-paste cache for the source half "
                         "(Step 8). Default: on (REUSE_SOURCES env, else on)")
    ap.add_argument("--no-reuse-sources", dest="reuse_sources", action="store_false")
    ap.add_argument("--refresh-views", action="store_true",
                    help="refresh stale view counts when this pass finds nothing queued. "
                         "Only worker.py's periodic-sweep branch passes this — see Assumption 3 "
                         "in the plan for why the queued-work branch and the GitHub fallback "
                         "loop must not.")
    ap.add_argument("--refresh-views-now", action="store_true",
                    help="refresh now and exit, whatever is queued. For manual runs and "
                         "verification — bypasses the idle-only gate on --refresh-views.")
    ap.add_argument("--views-per-pass", type=int, default=VIEWS_PER_PASS,
                    help="most lynxr_sources rows to refresh per pass (default VIEWS_PER_PASS "
                         "env, else 3)")
    args = ap.parse_args()

    global REUSE_SOURCES
    if args.reuse_sources is not None:
        REUSE_SOURCES = args.reuse_sources

    global FORCED
    FORCED = args.redo_ai

    log.info("worker claim id: %s (WORKER_PEERS=%d)", CLAIM_ID, WORKER_PEERS)

    env = load_env(ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY",
                            env.get("SUPABASE_SERVICE_ROLE_KEY"),
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
        api_key = envcfg.secret("ANTHROPIC_API_KEY",
                                env.get("ANTHROPIC_API_KEY"),
                                os.environ.get("ANTHROPIC_API_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
    aclient = None
    if api_key and not args.no_ai:
        aclient = anthropic_client(api_key)
    else:
        log.info("AI steps OFF (%s)", "--no-ai" if args.no_ai else "no ANTHROPIC_API_KEY")

    if args.warm_prefixes:
        # Returns BEFORE any discovery or database read — this is a boot-time
        # side task, not a pass over queued work.
        if aclient:
            warm_prefixes(aclient)
        else:
            log.info("skipping prefix warm — no ANTHROPIC_API_KEY")
        return

    if args.refresh_views_now:
        # Returns BEFORE any discovery or database read, same as
        # --warm-prefixes above and for the same reason: this is a side
        # task, not a pass over queued work.
        refresh_views(key, args.views_per_pass)
        return

    # Shadows the module-level wants_work with one bound to this run's args, so
    # the four call sites below keep reading wants_work(a) unchanged. `_w=`
    # binds the module-level function as a default argument AT DEFINITION
    # TIME, before the local name below exists to shadow it — without that,
    # the body's own reference to `wants_work` would resolve to itself and
    # recurse forever instead of calling the real one.
    def wants_work(a, _w=_wants_work_impl):
        return _w(a, cooldown_hours=args.cooldown_hours,
                  lease_minutes=args.lease_minutes,
                  min_age_seconds=args.min_age_seconds,
                  redo_ai=args.redo_ai)

    if args.backfill_covers:
        # Scripts written before covers existed still show a bare URL, which is
        # the whole problem covers solve. Re-fetching just the video and pulling
        # one frame costs nothing but bandwidth — no model call, no cap spend,
        # and the script itself is left exactly as it is.
        # Deliberately still a full scan over every creator, including trash —
        # a manual one-off across the whole corpus by design, unrelated to the
        # discovery prefilter above. Do not "fix" it onto candidate_creators().
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
                        media, err = download_video(str(a["sourceUrl"]).strip(), td)
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

    # Ask Postgres which creators MIGHT have work (2 bytes) instead of
    # pulling every blob and filtering here (214,900 bytes at five
    # creators, every 60 seconds). candidate_creators() returns None when
    # it could not answer OR when its own canary says the filter is broken;
    # either way fall back to the full scan and say so loudly, because a
    # permanently-failing prefilter that quietly reported an empty queue is
    # exactly the shape this project keeps getting bitten by.
    #
    # --redo-ai always takes the full scan: it widens the `done` branch to
    # `"failed" in note`, which no containment probe can express without
    # matching nearly every row. It is a rare manual flag; the cost is fine.
    prefetched = {}
    todo = None if args.redo_ai else candidate_creators(key)
    if todo is None:
        rows = sb(key, "/rest/v1/lynxr_creators?select=id,data")
        # Keep the blobs. On this path they have already been paid for, so
        # re-fetching them per creator below would be the SECOND full read
        # of the same row — the double fetch this change removes.
        prefetched = {r["id"]: r["data"] for r in rows}
        todo = [r["id"] for r in rows
                if any(wants_work(a) for a in (r["data"].get("adaptations") or []))]
    if not todo:
        log.info("nothing queued")
        if args.refresh_views:
            try:
                refresh_views(key, args.views_per_pass)
            except Exception as e:  # noqa: BLE001
                log.warning("refresh_views failed: %s", str(e)[:120])
        return
    log.info("creators to consider: %d", len(todo))

    # THE CIRCUIT BREAKER. Per-account exposure is bounded by the allowance
    # (charge_scripts, above), but the number of accounts is not — this is
    # the one control that bounds an unattended night's worst-case loss
    # whichever gate turns out to leak. Checked here, before any claim, so a
    # tripped breaker costs nothing and claims nothing.
    if args.daily_cap:
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat().replace("+00:00", "Z")
        spent_24h = count_charges(key, since)
        if spent_24h >= args.daily_cap:
            log.error("SPEND CAP REACHED: %d scripts charged in the last 24h "
                      "(cap %d) — refusing all new work this pass",
                      spent_24h, args.daily_cap)
            return

    # Claiming (below) still happens per creator, serially, exactly as before —
    # it is cheap and the fairness/cap/off-platform logic needs each creator's
    # own row. Only the actual processing becomes concurrent, over this flat
    # list built up across every creator (Step 7a).
    jobs = []
    for cid in todo:
        # The ONLY full-blob read, and only for creators that might have
        # work. On the prefilter path nothing has been read yet; on the
        # fallback path the scan already has it. Safe to reuse a blob read a
        # moment ago: every write below goes through graft_adaptations(),
        # which re-pulls the row fresh and merges by adaptation id rather
        # than writing `data` wholesale.
        data = prefetched.get(cid)
        if data is None:
            data = sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}&select=id,data")[0]["data"]

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
        # THE ALLOWANCE, enforced server-side (supabase/allowance_ledger.sql,
        # not yet applied — see HANDOFF) in a table this process can write and
        # the creator cannot. There used to be a comment here calling the
        # allowance "the OLDEST `cap` adaptations by addedAt" — that design
        # had three walks around it (wipe `adaptations`, wipe `trash`, or
        # back-date one entry's addedAt to sort it inside the window), all
        # because the ledger and the data it metered lived in the same blob
        # the creator PATCHes whole on every save. `addedAt` now decides only
        # the FIFO order candidates are offered to charge_scripts() in, never
        # how many are allowed.
        candidates = sorted(
            (a for a in (data.get("adaptations") or [])
             if wants_work(a) and supported_url(a.get("sourceUrl"))),
            key=lambda a: a.get("addedAt") or "")
        ready, over = candidates, []
        if args.cap:
            try:
                charged = sb(key, "/rest/v1/rpc/charge_scripts", method="POST",
                             body={"p_creator": cid,
                                   "p_ids": [a["id"] for a in candidates]})
                if charged is None:
                    raise RuntimeError("charge_scripts returned nothing")
            except Exception as e:  # noqa: BLE001
                # FAIL CLOSED. Every other check here fails open so a broken
                # check cannot lock out a real creator — right for the signup
                # gate, wrong here. A charge call that errors means "I do not
                # know what this costs"; the answer is to wait a pass, not to
                # spend, so this creator is skipped entirely this time round.
                log.warning("[%s] charge_scripts failed, skipping this pass: %s",
                            data.get("name") or cid[:8], str(e)[:120])
                continue
            allowed = set(charged)
            ready = [a for a in candidates if a["id"] in allowed]
            over = [a for a in candidates if a["id"] not in allowed]
            cap_note = note_text("cap", cap=args.cap)
            fresh_over = [a for a in over if a.get("note") != cap_note]
            if fresh_over:
                # Written only when not already there: an "error" entry with
                # no attemptedAt clears cooled() on every pass, so without
                # this guard an over-allowance entry would be re-marked every
                # pass forever instead of once.
                for a in fresh_over:
                    a["status"] = "error"
                    set_note(a, "cap", cap=args.cap)
                log.info("[%s] refusing %d over the allowance",
                         data.get("name") or cid[:8], len(fresh_over))
                graft_adaptations(key, cid, fresh_over)

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
                set_note(a, "off_platform")
                a["retryable"] = False        # a Netflix link never becomes a video
                mark_final(a, "wall")
            log.info("[%s] refusing %d off-platform link(s)",
                     data.get("name") or cid[:8], len(fresh_off))
            graft_adaptations(key, cid, fresh_off)

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
            a["claimedBy"] = CLAIM_ID
        graft_adaptations(key, cid, batch)

        # Step 10a. Not atomic — PostgREST cannot compare-and-swap inside a
        # JSONB array — but paired with the token above it turns a near-certain
        # double spend under two machines into a rare one. Only worth the extra
        # GET + jittered sleep once there IS a second machine (WORKER_PEERS>1);
        # at the default of 1 there is only one claimer and this whole block is
        # a no-op cost. See renew_claim()'s docstring for the actually-atomic
        # fix this stands in for.
        if WORKER_PEERS > 1 and batch:
            time.sleep(random.uniform(1.0, 2.0))
            fresh = sb(key, f"/rest/v1/lynxr_creators?id=eq.{cid}&select=data")[0]["data"]
            by_id = {e.get("id"): e for e in fresh.get("adaptations") or []}
            kept = []
            for a in batch:
                owner = (by_id.get(a.get("id")) or {}).get("claimedBy")
                if owner != CLAIM_ID:
                    log.info("  claim lost to %s — skipping", owner)
                else:
                    kept.append(a)
            batch = kept
            if not batch:
                continue

        for a in batch:
            jobs.append((cid, data, a))

    if not jobs:
        log.info("done")
        return

    # Step 7c: group by canon_url so N brands pasted for the SAME video (even
    # across different creators) share one download/transcribe/shot-list/tag/
    # format pass instead of paying for it N times.
    groups = collections.defaultdict(list)
    for job in jobs:
        groups[canon_url(job[2].get("sourceUrl") or "")].append(job)
    group_list = list(groups.values())
    log.info("processing %d job(s) across %d distinct video(s), concurrency %d",
             len(jobs), len(group_list), args.concurrency)

    # Step 7a: one video's worth of work per pool slot. A group's own inner
    # pool (process_group) fans out its per-brand adaptation calls, so this is
    # "how many VIDEOS at once", which is what the vCPU/network budget is
    # actually sized against.
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        list(pool.map(lambda g: process_group(key, aclient, g), group_list))
    log.info("done")


if __name__ == "__main__":
    main()
