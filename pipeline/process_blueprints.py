#!/usr/bin/env python3
"""Give client blueprint videos the FULL database treatment.

WHY THIS EXISTS
---------------
The site is static — it can't run Whisper or call the tagger. The client page
(Video blueprints section) queues an uploaded file (lynxr-blueprints bucket)
or a pasted link on the client's row. This script, run on the owner's machine
like the rest of the pipeline, closes the loop with exactly what database
videos get:

    queued entry -> media (storage object, or yt-dlp for links)
      -> Whisper verbatim script with segment timestamps   (local, free)
      -> frames at the real beat starts -> shot list        (analyze_visuals)
      -> locked-taxonomy tags from audio + opening frame    (retag_with_audio)
    -> written back into the client record -> the site renders the same
       recreation blueprint it renders for database rows (realScript)
    -> and upserted into lynxr_videos, so a video staff found for one client
       becomes searchable Lynx-wide (see upsert_video for what is and is not
       written, and why it carries the same data_source as creator finds).

Reuses the SAME functions as the database passes — same Whisper model and
hallucination gate, same frame timing, same visual schema, same tag SYSTEM
prompt — so a blueprint here means exactly what it means everywhere else.
Shots + tags need ANTHROPIC_API_KEY (pennies per video); without it the
script still lands and the entry notes what was skipped.

Safe to re-run: only status == "queued" entries are touched. Failures mark the
entry status=error with a note and KEEP the storage object so a later run can
retry after the cause is fixed.

Usage:
    python process_blueprints.py            # everything queued, full treatment
    python process_blueprints.py --no-ai    # local script only, spend nothing
    python process_blueprints.py --keep     # don't delete storage objects
"""

import argparse
import base64
import hashlib
import json
import logging
import os
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# macOS framework Python ships without a CA bundle wired into urllib — use
# certifi's (already in the venv via yt-dlp) so Supabase HTTPS verifies.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

from transcribe import MODEL, fetch_audio, transcribe
from analyze_visuals import analyze as analyze_frames
from analyze_visuals import download_video, extract_frames, frame_times, yt_dlp_bin
from retag_with_audio import MODEL as TAG_MODEL
from retag_with_audio import SYSTEM as TAG_SYSTEM
from retag_with_audio import user_content
from taxonomy import TAG_SCHEMA, TAG_SCHEMA_VISION, length_bucket

ROOT = Path(__file__).parent.parent
SB_URL = "https://esakjfogplfszievvabi.supabase.co"
BUCKET = "lynxr-blueprints"
RESERVED_IDS = {"ingest-queue", "deleted-clients"}

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("blueprints")


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
    if raw:
        return data
    return json.loads(data) if data else None


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def platform_of(url):
    for p in ("tiktok", "instagram", "youtube"):
        if p in (url or ""):
            return p
    return "upload"


def api_reason(e):
    """The useful part of an Anthropic error — its message, not the wrapper."""
    s = str(e)
    m = s.split("'message': '")
    return (m[1].split("'")[0] if len(m) > 1 else s)[:90]


def canon_url(u):
    """Same canonicalisation the apps use, so one video is one row. Copied from
    process_adaptations rather than imported — importing that module would run
    its logging setup as a side effect, and platform_of is already duplicated
    here for the same reason."""
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


def fetch_meta(url):
    """Public counts and the platform's own id, straight from yt-dlp. Free — no
    API, no scrape — and it is what lets a blueprint sit in lynxr_videos as a
    real row rather than one with zeroed metrics."""
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


def upsert_video(key, b):
    """Put a finished blueprint into the MAIN database alongside the scraped
    rows, so a video staff found for one client becomes searchable Lynx-wide —
    the same round trip process_adaptations does for creator submissions.

    Marked `data_source = 'Creator'`, identical to creator submissions, on the
    owner's instruction: submitted sources are one pool regardless of which app
    the link was pasted into. The consequence to know about is that nothing
    downstream can then tell a staff blueprint from a creator find — if that
    distinction is ever wanted, this string is the only place to change.

    No client or brand identity is written. The row records a PUBLIC video; who
    it was queued for stays in the client record. That separation is what makes
    pooling safe, and it is the same rule the creator path follows.

    Best-effort: a failure here must never cost the blueprint its script.
    """
    url = b.get("url") or ""
    meta = fetch_meta(url)
    tags = b.get("tags") or {}
    script = b.get("script") or {}
    shots = b.get("shots") or []
    vid = meta.get("video_id") or hashlib.sha1(canon_url(url).encode()).hexdigest()[:20]
    views = meta.get("views") or 0
    eng = ((meta.get("likes", 0) + meta.get("comments", 0)) / views * 100) if views else None

    row = {
        "platform": platform_of(url),
        "video_id": vid,
        "creator": meta.get("creator") or "",
        "title": meta.get("title") or b.get("name") or "",
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
        "length_bucket": length_bucket(meta.get("duration") or script.get("duration") or 0),
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
        log.warning("  database upsert skipped: %s", str(e)[:90])


def process_one(b, key, aclient):
    """Fill entry b in place: script (always), shots + tags (with aclient)."""
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        if b.get("url"):
            media, err = download_video(b["url"], td)
            if not media:
                # Some links refuse the video variant — audio still scripts it.
                media, err2 = fetch_audio(b["url"], td)
                if not media:
                    raise RuntimeError(f"download failed: {err or err2}")
        else:
            obj = sb(key, f"/storage/v1/object/{BUCKET}/{b['path']}", raw=True)
            media = td / ("v" + (os.path.splitext(b["path"])[1] or ".mp4"))
            media.write_bytes(obj)

        t = transcribe(str(media), MODEL)
        b["script"] = {"hook": t["hook_spoken"], "duration": t["duration"],
                       "language": t["language"], "has_speech": t["has_speech"],
                       "text": t["text"], "segments": t["segments"]}

        notes = []
        frames = []
        if aclient:
            frames = extract_frames(media, frame_times(t, t["duration"]), td)
            if frames:
                try:
                    b["shots"] = analyze_frames(aclient, frames)["shots"]
                except Exception as e:  # noqa: BLE001
                    notes.append(f"shots failed: {api_reason(e)}")
            else:
                notes.append("no frames (audio-only source)")
            try:
                row = {"platform": platform_of(b.get("url")),
                       "data_source": "Client blueprint", "title": b.get("name", "")}
                text = user_content(row, t)
                if frames:
                    img = base64.b64encode(frames[0][1].read_bytes()).decode()
                    content = [
                        {"type": "image", "source": {"type": "base64",
                                                     "media_type": "image/jpeg", "data": img}},
                        {"type": "text",
                         "text": text + "\n\nThe image above is this video's opening frame."},
                    ]
                    schema = TAG_SCHEMA_VISION
                else:
                    content, schema = text, TAG_SCHEMA
                msg = aclient.messages.create(
                    model=TAG_MODEL, max_tokens=2000,
                    system=[{"type": "text", "text": TAG_SYSTEM}],
                    output_config={"format": {"type": "json_schema", "schema": schema}},
                    messages=[{"role": "user", "content": content}])
                b["tags"] = json.loads(msg.content[0].text)
            except Exception as e:  # noqa: BLE001
                notes.append(f"tags failed: {api_reason(e)}")
        else:
            notes.append("script only — shots+tags need ANTHROPIC_API_KEY")
        if notes:
            b["note"] = "; ".join(notes)[:160]
        else:
            b.pop("note", None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true",
                    help="don't delete storage objects after transcription")
    ap.add_argument("--no-ai", action="store_true",
                    help="local script only — skip shot analysis and tagging (no API spend)")
    ap.add_argument("--redo-ai", action="store_true",
                    help="also reprocess done entries whose shots/tags failed (e.g. after a top-up)")
    ap.add_argument("--cooldown-hours", type=float, default=6,
                    help="min hours between --redo-ai retries of the same entry "
                         "(keeps the launchd daemon from re-transcribing a stuck "
                         "entry every 3 minutes; 0 = retry immediately)")
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
        log.info("shots+tags OFF (%s)", "--no-ai" if args.no_ai else "no ANTHROPIC_API_KEY")

    # Retry policy, all cooldown-gated so the every-3-minutes daemon can't
    # hammer a stuck entry:
    #   queued        -> always processed (first attempt)
    #   status=error  -> retried automatically (transient downloads self-heal)
    #   done + failed -> retried only under --redo-ai (partial AI, e.g. an
    #                    empty credit balance; heals itself after a top-up)
    def cooled(b):
        last = b.get("attemptedAt") or ""
        if not last or not args.cooldown_hours:
            return True
        try:
            age_h = (datetime.now(timezone.utc)
                     - datetime.fromisoformat(last.replace("Z", "+00:00"))).total_seconds() / 3600
        except ValueError:
            return True
        return age_h >= args.cooldown_hours

    def wants_work(b):
        if b.get("status") == "queued":
            return True
        if b.get("status") == "error":
            return cooled(b)
        return (args.redo_ai and b.get("status") == "done"
                and "failed" in (b.get("note") or "") and cooled(b))

    rows = sb(key, "/rest/v1/lynxr_clients?select=id,data")
    todo = [(r["id"], r["data"]) for r in rows
            if r["id"] not in RESERVED_IDS
            and any(wants_work(b) for b in (r["data"].get("blueprints") or []))]
    if not todo:
        log.info("nothing queued")
        return
    log.info("clients with queued blueprints: %d", len(todo))

    for cid, _ in todo:
        # Re-pull the single row immediately before writing so a same-moment
        # site edit has the smallest possible window to be clobbered.
        row = sb(key, f"/rest/v1/lynxr_clients?id=eq.{cid}&select=id,data")[0]
        data = row["data"]
        changed = False
        for b in data.get("blueprints") or []:
            if not wants_work(b):
                continue
            log.info("[%s] %s", data.get("company", cid), b.get("name", b["id"]))
            b["attemptedAt"] = now_iso()
            try:
                process_one(b, key, aclient)
                b["status"] = "done"
                b["processedAt"] = now_iso()
                changed = True
                log.info("  -> %d beats, %d shots, tags=%s%s",
                         len(b["script"]["segments"]), len(b.get("shots") or []),
                         (b.get("tags") or {}).get("format_type", "—"),
                         "" if b["script"]["has_speech"] else " (no speech)")
                # Into the main database, same as a creator submission. Gated on
                # BOTH a public url and real tags: an upload has no public video
                # to point at, and an untagged row (--no-ai, or a tag pass that
                # failed) would move the medians shelf ranking depends on while
                # contributing no format or hook signal. Say which, rather than
                # skipping silently.
                if not b.get("url"):
                    log.info("  -> not added to the database: upload, no public url")
                elif not b.get("tags"):
                    log.info("  -> not added to the database: no tags yet%s",
                             " (--no-ai)" if args.no_ai else " — rerun with --redo-ai once tagging works")
                else:
                    upsert_video(key, b)
                # Keep the uploaded object while any AI part failed — it is
                # the only copy, and --redo-ai needs it after a top-up.
                if not args.keep and b.get("path") and "failed" not in (b.get("note") or ""):
                    try:
                        sb(key, f"/storage/v1/object/{BUCKET}/{b['path']}", method="DELETE")
                    except urllib.error.HTTPError as e:
                        log.warning("  object delete failed (%s) — harmless, retry by hand", e.code)
            except Exception as e:  # noqa: BLE001 — any failure marks the entry, run continues
                b["status"] = "error"
                b["note"] = str(e)[:120]
                changed = True
                log.error("  -> FAILED: %s", e)
        if changed:
            # Stamp updatedAt so the site's last-write-wins sync adopts this
            # version instead of resurrecting the queued state from a cache.
            data["updatedAt"] = now_iso()
            sb(key, f"/rest/v1/lynxr_clients?id=eq.{cid}", method="PATCH",
               body={"data": data})
    log.info("done")


if __name__ == "__main__":
    main()

