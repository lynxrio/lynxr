#!/usr/bin/env python3
"""Clips for agency briefs sent to creators, so every format plays in lynxr's own player.

Plan: ~/.claude/plans/agency-brief-regular-ui.md. Owner, 2026-09-24: "make the videos the way it is
on the actual user side, like native to lynxr".

WHAT IT DOES
    A creator's brief page (creator.js lynxRefPanelHtml) plays a format through refPlayHtml -- the
    same native <video> a creator's own script uses -- from `clip` (+ `cover`) on that format inside
    the SENT snapshot, lynxr_agency_briefs.doc, the only thing a creator can read (my_agency_brief()).
    Campaign formats carry both from the agency lane's read (app.js agencySendDoc copies them). This
    fills them in for every sent format that has none: legacy picked-video briefs (the scraped corpus
    has no media), campaign briefs sent before 2026-09-24, and any format whose clip is missing.

    The bytes are the SAME objects a creator's own paste makes -- lynxr-clips/<sha1(canon_url)[:20]>.mp4
    and lynxr-covers/<same>.jpg, public buckets (supabase/clips_bucket.sql explains that posture) -- so
    a HEAD finds a clip that already exists and nothing is downloaded. On 2026-09-24 all four formats
    of the two live briefs resolved that way.

ONLY SENT BRIEFS, NEVER THE CORPUS
    Reads lynxr_agency_briefs and nothing else. A format is fetched only because a brief holding it
    was delivered to a creator and not unsent. lynxr_videos is never read or written (standing owner
    rule: no work on the scraped corpus beyond what a creator will actually see).

COST
    yt-dlp + ffmpeg on the Fly box: no Apify, no model call, no money per clip. Storage ~1.7 MB a clip
    (median of the 75 objects in lynxr-clips on 2026-09-24; the largest was 12.7 MB).

WHEN IT CANNOT
    A host the worker does not fetch (anything but TikTok and Instagram -- YouTube is bot-checked from
    Fly; SUPPORTED_HOSTS), a download yt-dlp says can never work (private, deleted, age-gated,
    geo-blocked, bot-checked: the non-retryable FETCH_FAILURES), or MAX_TRIES failed attempts: the
    format gets clip_state "failed" and the creator page shows the regular no-clip panel ("This one can
    only be watched on TikTok" and the link out). Never an embed.

CONCURRENCY
    Each result is grafted into the brief's CURRENT doc, re-read just before writing, and the PATCH
    carries `updated_at=eq.<what was read>` (the column's own trigger moves it on every write), so a
    staff Update landing in between is never overwritten: the PATCH matches nothing and the next pass
    starts from the new doc. A staff send or Update carries these fields over (app.js agStampDoc), and
    agDocSig ignores them, so a clip arriving never reads as an edit.

RUN
    The Fly worker's idle lane (pipeline/worker.py, BRIEF_CLIPS). Fly-only: the GitHub fallback runs
    process_adaptations.py directly and never reaches it. By hand:
        ./venv/bin/python pipeline/brief_clips.py --dry-run    # read-only: GET + HEAD, writes nothing
        ./venv/bin/python pipeline/brief_clips.py              # one pass
"""
import argparse
import hashlib
import json
import logging
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_adaptations as P  # noqa: E402
import envcfg  # noqa: E402
from analyze_visuals import download_video  # noqa: E402
from video_limits import media_duration, too_long  # noqa: E402

log = logging.getLogger("brief_clips")

PER_PASS = int(envcfg.get("BRIEF_CLIPS_PER_PASS", "4"))      # formats worked per pass
MAX_TRIES = int(envcfg.get("BRIEF_CLIPS_MAX_TRIES", "3"))    # retryable failures before giving up
WINDOW_H = float(envcfg.get("BRIEF_CLIPS_WINDOW_H", "168"))  # only briefs written in the last week

# The only clip a creator page trusts (creator.js lynxClipOf mirrors this): our own public object.
CLIP_RE = re.compile(r"^" + re.escape(P.SB_URL) + r"/storage/v1/object/public/lynxr-clips/[0-9a-f]{20}\.mp4$")


def object_name(url):
    return hashlib.sha1(P.canon_url(url).encode()).hexdigest()[:20]


def public_url(bucket, name, ext):
    return f"{P.SB_URL}/storage/v1/object/public/{bucket}/{name}.{ext}"


def exists(url):
    """True if the public object is there. Storage answers a missing one with HTTP 400."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=20,
                                    context=P.SSL_CTX) as r:
            return r.status == 200
    except urllib.error.HTTPError:
        return False


def live(row):
    return any(d.get("revoked_at") is None for d in (row.get("lynxr_agency_deliveries") or []))


def needs_clip(f):
    return bool(isinstance(f, dict) and f.get("id") and f.get("source_url")
                and not CLIP_RE.match(str(f.get("clip") or ""))
                and f.get("clip_state") != "failed")


def pending(rows):
    """[(brief_id, format_id, source_url)] for live briefs, in the order given (newest first)."""
    return [(row["id"], f["id"], f["source_url"])
            for row in rows if live(row)
            for f in ((row.get("doc") or {}).get("formats") or []) if needs_clip(f)]


def apply(f, result):
    """One format with a result applied. Pure, so test_brief_clips.py can pin it down."""
    g = dict(f)
    if result.get("clip"):
        g["clip"] = result["clip"]
        if result.get("cover") and not g.get("cover"):
            g["cover"] = result["cover"]
        g.pop("clip_state", None)
        g.pop("clip_tries", None)
        return g
    g["clip_tries"] = int(g.get("clip_tries") or 0) + 1
    if not result.get("retryable", True) or g["clip_tries"] >= MAX_TRIES:
        g["clip_state"] = "failed"
    return g


def make_one(key, url):
    """{"clip", "cover"} on success, else {"fail": <note key>, "retryable": bool}."""
    if not P.supported_url(url):
        return {"fail": "off_platform", "retryable": False}
    name = object_name(url)
    clip_url = public_url(P.CLIP_BUCKET, name, "mp4")
    cover_url = public_url(P.COVER_BUCKET, name, "jpg")
    if exists(clip_url):
        return {"clip": clip_url, "cover": cover_url if exists(cover_url) else ""}
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        media, err = download_video(str(url).strip(), td)
        if not media:
            kind, retryable = P.fetch_failure(err or "download failed")
            return {"fail": kind, "retryable": retryable}
        # The length gate (video_limits.py), before the CPU-heavy encode. Only
        # legacy picked-video briefs can reach it: a campaign format over the
        # limit is refused by the agency lane before it can be sent.
        if too_long(media_duration(media)):
            return {"fail": "too_long", "retryable": False}
        blob = P.make_clip(media, td)
        if not blob:
            return {"fail": "clip", "retryable": True}
        out = {"clip": P.upload_clip(key, name, blob), "cover": ""}
        try:
            cov = P.make_cover(media, td)
            if cov:
                out["cover"] = P.upload_cover(key, name, cov)
        except Exception as e:  # noqa: BLE001 -- a clip with no cover still plays
            log.warning("  no cover: %s", P.api_reason(e))
        return out


def patch(key, path, body):
    req = urllib.request.Request(P.SB_URL + path, method="PATCH")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation")
    req.data = json.dumps(body).encode()
    with urllib.request.urlopen(req, timeout=60, context=P.SSL_CTX) as r:
        return json.loads(r.read() or b"[]")


def graft(key, brief_id, format_id, source_url, result):
    """Write one result into the brief's current doc. False when the doc moved on: the format was
    removed, its link replaced, it was filled meanwhile, or a staff write landed first."""
    bid = urllib.parse.quote(str(brief_id), safe="")
    rows = P.sb(key, f"/rest/v1/lynxr_agency_briefs?id=eq.{bid}&select=id,updated_at,doc")
    if not rows:
        return False
    row = rows[0]
    doc = row.get("doc") or {}
    hit, formats = False, []
    for f in doc.get("formats") or []:
        if not hit and needs_clip(f) and f.get("id") == format_id and f.get("source_url") == source_url:
            formats.append(apply(f, result))
            hit = True
        else:
            formats.append(f)
    if not hit:
        return False
    stamp = urllib.parse.quote(row["updated_at"], safe="")
    done = patch(key, f"/rest/v1/lynxr_agency_briefs?id=eq.{bid}&updated_at=eq.{stamp}&select=id",
                 {"doc": {**doc, "formats": formats}})
    return bool(done)


def fetch_rows(key, now=None):
    since = ((now or datetime.now(timezone.utc)) - timedelta(hours=WINDOW_H)).isoformat()
    return P.sb(key, "/rest/v1/lynxr_agency_briefs?select=id,doc,lynxr_agency_deliveries(revoked_at)"
                     f"&updated_at=gte.{urllib.parse.quote(since, safe='')}&order=created_at.desc") or []


def run(key, dry=False):
    todo = pending(fetch_rows(key))
    if not todo:
        return 0
    log.info("brief clips: %d format(s) waiting", len(todo))
    if dry:
        for brief_id, fid, url in todo:
            name = object_name(url)
            how = ("unsupported" if not P.supported_url(url)
                   else "reuse" if exists(public_url(P.CLIP_BUCKET, name, "mp4")) else "download")
            print(f"{brief_id[:8]}  {str(fid)[:12]:<12}  {how:<11}  {url[:80]}")
        return len(todo)
    for brief_id, fid, url in todo[:PER_PASS]:
        try:
            result = make_one(key, url)
        except Exception as e:  # noqa: BLE001 -- one bad link must not stop the pass
            log.warning("  clip error for %s: %s", url[:60], P.api_reason(e))
            result = {"fail": "error", "retryable": True}
        wrote = graft(key, brief_id, fid, url, result)
        log.info("  %s  %s -> %s%s", brief_id[:8], url[:60],
                 "clip" if result.get("clip") else result.get("fail"),
                 "" if wrote else "  (not written: the brief changed; next pass)")
    return len(todo)


def main():
    envcfg.sanitize_environ()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="read-only: list what is waiting and whether it would reuse or download")
    args = ap.parse_args()
    env = P.load_env(P.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"),
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
    n = run(key, dry=args.dry_run)
    if args.dry_run:
        print(f"{n} format(s) waiting")


if __name__ == "__main__":
    main()
