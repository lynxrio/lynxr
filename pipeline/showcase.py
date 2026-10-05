#!/usr/bin/env python3
"""The showcase lane: for every entry staff approved for the landing page's "made with lynxr" card, read the real video,
check it is the account's own, copy its cover into our own storage, and keep measuring its public view count.

Plan: ~/.claude/plans/lynxr-showcase.md. Tables and rules: supabase/showcase.sql (a creator's consent and the staff's
approval live there; this file never decides who may be shown, it only fetches and measures).

WHAT IT DOES, IN ORDER (one pass: covers -> measure -> sweep)
    COVERS. An approved entry that has no cover yet (check_status 'pending'): read the video's public page (TikTok:
        yt-dlp plus the oEmbed endpoint, free; Instagram: one Apify result), check the video belongs to the entry's handle,
        fetch its cover image, shrink it to a 360px JPEG with ffmpeg and upload it to the PUBLIC lynxr-covers bucket under
        showcase/<pub_id>-<random>.jpg. The entry then becomes check_status 'ok' and the first measured point is stored
        in lynxr_showcase_points. A video that is gone or belongs to someone else is marked not_found / mismatch and is
        never shown; three unreadable reads in a row mark it failed.
    MEASURE. An 'ok' entry that is due: read it again and add a point (views, and the profile's followers). Agency entries
        are re-read daily for their first SHOWCASE_DAILY_DAYS days, then every SHOWCASE_RECHECK_H hours; creator entries
        every SHOWCASE_RECHECK_H hours (their own numbers come from the post tracker).
    SWEEP. Delete stored covers no approved entry references any more (withdrawn, removed, rejected, failed), once they are
        older than SWEEP_MIN_AGE_S, so a withdrawal takes the picture down within about one pass. It never deletes when it
        could not read the list of references.

FLY ONLY
    Runs inside track_posts.py's pass (worker.py's idle lane). NEVER add it to .github/workflows/adaptations.yml: the GitHub
    fallback runs process_adaptations.py directly, and a second runner would double the Apify spend and race the rows.
    showcase_pass() is handed the RUNNING track_posts module as `T`. This file does not import track_posts at module level:
    track_posts.py runs as __main__, so importing it here would create a second copy with its own APIFY_RESULTS and _ROOM
    budget counters. Only main() below, which is a separate entry point, imports it.

CREATORS FIRST
    P.queued_work(key) is asked before every item; a queued script ends the pass at once.
    Every update of an entry carries status=eq.approved, so a creator who withdraws while a cover is being fetched wins
    the race: the entry is no longer approved, the update matches nothing, and the uploaded file is deleted again.

COST
    TikTok is free. Instagram is one Apify result (about $0.0027) per read, only while T.ig_gate("max") allows it, plus one
    more for the follower count. At SHOWCASE_PER_PASS = 3 and daily reads for 30 days, an Instagram entry costs about $0.16.

PRIVACY OF THE LOG
    Counts only: never a handle, a note, an email or a link.

RUN
    ./venv/bin/python pipeline/showcase.py --dry-run           # read-only: counts what is due, fetches and writes nothing
    ./venv/bin/python pipeline/showcase.py --cover-dry URL OUT # the REAL read of one public video from this machine, with
        # no database access: prints owner, views, posted_at and the cover host, and writes the converted JPEG to OUT (an
        # absolute path OUTSIDE this repo). Instagram needs --spend (one Apify result, about $0.0027).
"""
import argparse
import json
import logging
import os
import re
import secrets
import subprocess
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

log = logging.getLogger("showcase")

SHOWCASE = envcfg.get("SHOWCASE", "1") not in ("0", "", "false", "False")       # "0" turns the lane off
SHOWCASE_PER_PASS = int(envcfg.get("SHOWCASE_PER_PASS", "3"))                   # covers, and measurements, per pass
SHOWCASE_DAILY_DAYS = float(envcfg.get("SHOWCASE_DAILY_DAYS", "30"))            # an agency entry is read daily this long
SHOWCASE_RECHECK_H = float(envcfg.get("SHOWCASE_RECHECK_H", "168"))             # ... then this often
SHOWCASE_MAX_FAILS = int(envcfg.get("SHOWCASE_MAX_FAILS", "3"))                 # unreadable reads in a row before 'failed'
SWEEP_MIN_AGE_S = 600                  # a stored cover this young is never swept (its update may not have landed yet)
COVER_MAX_BYTES = 5_000_000
COVER_HOSTS = (".tiktokcdn.com", ".tiktokcdn-us.com", ".tiktokcdn-eu.com", ".cdninstagram.com", ".fbcdn.net")
COVER_BUCKET = "lynxr-covers"
COVER_CACHE_CONTROL = "max-age=600"    # the CDN may serve a withdrawn cover for at most this long (the privacy page promises a day)

ENTRIES = "/rest/v1/lynxr_showcase_entries"
COVER_NAME_RE = re.compile(r"^showcase/[a-f0-9]{12}-[a-f0-9]{16}\.jpg$")        # mirrors the cover_path check in showcase.sql
TT_HANDLE_RE = re.compile(r"^https://www\.tiktok\.com/@([a-z0-9._]{1,30})/video/", re.I)
HANDLE_RE = re.compile(r"[a-z0-9._]{1,30}")


# ── pure ──────────────────────────────────────────────────────────────────────────────────────────

def iso(dt):
    """A UTC timestamp PostgREST and Python both read."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(s):
    """A timezone-aware datetime from an ISO string, or None."""
    if not s or not isinstance(s, str):
        return None
    try:
        dt = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def count(v):
    """A non-negative whole number, or None. Absent is None, never zero."""
    if v is None or isinstance(v, bool):
        return None
    try:
        n = int(float(v)) if isinstance(v, str) and "." in v else int(v)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def cover_host_ok(url):
    """True only for an https URL whose hostname is, or ends in a dot plus, one of COVER_HOSTS. The check is on the parsed
    hostname, so 'tiktokcdn.com.evil.example' and a plain http link are refused."""
    try:
        u = urllib.parse.urlparse(str(url))
        host = (u.hostname or "").lower()
    except ValueError:
        return False
    return u.scheme == "https" and any(host.endswith(h) for h in COVER_HOSTS)


def canon(url):
    """The link without its query, fragment and trailing slash."""
    return re.sub(r"/$", "", re.sub(r"[?#].*$", "", str(url or "").strip()))


def day_of(posted_at_iso, now):
    """Whole days from posting to `now`, at least 0, or None when the posting time is unknown."""
    dt = parse_ts(posted_at_iso)
    if dt is None:
        return None
    return max(0, int((now - dt).total_seconds() // 86400))


def next_due(kind, added_at_iso, now):
    """When to read an 'ok' entry next (a datetime). Agency: daily while it is younger than SHOWCASE_DAILY_DAYS, then every
    SHOWCASE_RECHECK_H. Creator: always SHOWCASE_RECHECK_H (its numbers come from the post tracker). Unknown age = slow."""
    slow = now + timedelta(hours=SHOWCASE_RECHECK_H)
    if kind != "agency":
        return slow
    added = parse_ts(added_at_iso)
    if added is not None and now - added < timedelta(days=SHOWCASE_DAILY_DAYS):
        return now + timedelta(hours=24)
    return slow


def owner_ok(platform, handle, read):
    """Is the video the entry's own? Compares the owner name the read returned with the entry's handle, lowercased. With no
    owner in the read, a TikTok link that carries /@handle/ counts as the owner (read['url_handle']). Otherwise False."""
    if not isinstance(read, dict) or not handle:
        return False
    owner = str(read.get("owner") or "").strip().lower().lstrip("@")
    if owner:
        return owner == str(handle).lower()
    if platform == "tiktok":
        return str(read.get("url_handle") or "").lower() == str(handle).lower()
    return False


def cover_name(pub_id):
    """showcase/<pub_id>-<16 random hex>.jpg: the random part makes a cover's address unguessable and new on every re-fetch."""
    return f"showcase/{pub_id}-{secrets.token_hex(8)}.jpg"


# ── I/O (none of it raises) ───────────────────────────────────────────────────────────────────────

def oembed_get(T, url):
    """(status, dict|None) of TikTok's public oEmbed for a video; (0, None) when it could not be asked."""
    try:
        req = urllib.request.Request("https://www.tiktok.com/oembed?url=" + urllib.parse.quote(url, safe=""))
        req.add_header("User-Agent", T.UA)
        with urllib.request.urlopen(req, timeout=15, context=P.SSL_CTX) as r:
            data = json.loads(r.read())
        return 200, data if isinstance(data, dict) else None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:  # noqa: BLE001
        return 0, None


def read_video(T, platform, url):
    """{"found": bool, "owner": str, "views": int|None, "posted_at": iso|None, "thumb": url|None, "url_handle": str},
    or None when the video could not be read at all (offline, blocked). found False means the platform says it is gone.
    The caller asks T.ig_gate('max') before an Instagram read; this function does not."""
    try:
        if platform == "tiktok":
            d = T.ytdlp_json(["--skip-download", "--no-playlist", "--dump-single-json", url], 90)
            m = TT_HANDLE_RE.match(url or "")
            out = {"found": True, "owner": "", "views": None, "posted_at": None, "thumb": None,
                   "url_handle": m.group(1).lower() if m else ""}
            if d:
                ts = d.get("timestamp")
                out.update(owner=str(d.get("uploader") or "").lower(), views=count(d.get("view_count")),
                           thumb=d.get("thumbnail"),
                           posted_at=iso(datetime.fromtimestamp(ts, tz=timezone.utc))
                           if isinstance(ts, (int, float)) and ts > 0 else None)
            status, oe = oembed_get(T, url)
            if oe:
                out["thumb"] = oe.get("thumbnail_url") or out["thumb"]      # oEmbed's is a JPEG
                out["owner"] = str(oe.get("author_unique_id") or out["owner"]).lower()
            if not d and not oe:
                return {**out, "found": False} if status in (400, 404) else None
            return out
        if platform == "instagram":
            items = T.apify_run({"directUrls": [url], "resultsType": "posts", "resultsLimit": 1, "addParentData": False})
            if not items:
                return None
            item = next((i for i in items if isinstance(i, dict) and not i.get("error")), None)
            if item is None:
                return ({"found": False, "owner": "", "views": None, "posted_at": None, "thumb": None, "url_handle": ""}
                        if any(isinstance(i, dict) and i.get("error") for i in items) else None)
            return {"found": True, "owner": str(item.get("ownerUsername") or "").lower(),
                    "views": T.P.apify_item_views([item]), "posted_at": str(item.get("timestamp") or "") or None,
                    "thumb": item.get("displayUrl"), "url_handle": ""}
    except Exception as e:  # noqa: BLE001
        log.info("showcase: read failed (%s)", type(e).__name__)
    return None


def fetch_cover(url, ua=None):
    """A 360px-wide JPEG (bytes) of the cover image at `url`, or None. Only the CDN hosts in COVER_HOSTS are fetched, at most
    COVER_MAX_BYTES, and ffmpeg (flags as process_adaptations.make_cover) turns whatever came back into a plain JPEG."""
    if not cover_host_ok(url):
        return None
    try:
        req = urllib.request.Request(url)
        req.add_header("User-Agent", ua or "Mozilla/5.0")
        with urllib.request.urlopen(req, timeout=20, context=P.SSL_CTX) as r:
            raw = r.read(COVER_MAX_BYTES + 1)
        if not raw or len(raw) > COVER_MAX_BYTES:
            return None
        with tempfile.TemporaryDirectory() as td:
            src, dst = Path(td) / "in", Path(td) / "out.jpg"
            src.write_bytes(raw)
            r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-frames:v", "1",
                                "-vf", "scale='min(360,iw)':-2", "-q:v", "5", str(dst)], capture_output=True, timeout=60)
            if r.returncode != 0 or not dst.exists() or dst.stat().st_size < 500:
                return None
            return dst.read_bytes()
    except Exception:  # noqa: BLE001
        return None


def upload_cover(key, path, blob):
    """Put the JPEG in the public covers bucket at `path` (showcase/...). Like process_adaptations.upload_cover, plus a short
    Cache-Control so a withdrawn cover leaves the CDN quickly. True on success."""
    try:
        req = urllib.request.Request(f"{P.SB_URL}/storage/v1/object/{COVER_BUCKET}/{path}", method="POST")
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("Content-Type", "image/jpeg")
        req.add_header("Cache-Control", COVER_CACHE_CONTROL)
        req.add_header("x-upsert", "true")
        req.data = blob
        with urllib.request.urlopen(req, timeout=120, context=P.SSL_CTX) as r:
            r.read()
        return True
    except Exception:  # noqa: BLE001
        return False


def delete_cover(key, T, path):
    return T.rest(key, f"/storage/v1/object/{COVER_BUCKET}/{path}", method="DELETE")


def list_covers(key, T):
    """[(showcase/<name>, created_at)] of the stored showcase covers, or None when the list could not be read."""
    status, data = T.rest(key, f"/storage/v1/object/list/{COVER_BUCKET}", method="POST",
                          body={"prefix": "showcase", "limit": 1000, "offset": 0})
    if status != 200 or not isinstance(data, list):
        return None
    return [(f"showcase/{o['name']}", o.get("created_at")) for o in data if isinstance(o, dict) and o.get("name")]


# ── the pass ──────────────────────────────────────────────────────────────────────────────────────

def _followers(T, platform, handle):
    """The profile's follower count, or None. Instagram's is one more Apify result, so it asks the budget gate first."""
    try:
        if platform == "instagram" and not T.ig_gate("max"):
            return None
        r = T.follower_read(platform, handle)
        return count(r.get("followers")) if r else None
    except Exception:  # noqa: BLE001
        return None


def _patch(T, key, eid, body, rep=False):
    """Update one entry, but only while it is still approved (a withdrawal mid-fetch wins the race)."""
    return T.rest(key, f"{ENTRIES}?id=eq.{int(eid)}&status=eq.approved", method="PATCH", body=body,
                  prefer="return=representation" if rep else None)


def _log(T, key, eid, action):
    T.rest(key, "/rest/v1/lynxr_showcase_log", method="POST",
           body={"entry_id": int(eid), "actor_role": "pipeline", "action": action, "detail": {}})


def _point(T, key, e, read, posted_iso, now):
    """Store one measured point (views, day, followers); nothing when the read had no number at all."""
    followers = _followers(T, e.get("platform"), e.get("handle"))
    views = count(read.get("views"))
    if views is None and followers is None:
        return
    T.rest(key, "/rest/v1/lynxr_showcase_points", method="POST",
           body={"entry_id": int(e["id"]), "day": day_of(posted_iso, now), "views": views, "followers": followers})


def _read(T, e, stats):
    """('ok', read) | ('budget', None) | ('unreadable', None) | ('gone', None) for one entry."""
    if e.get("platform") == "instagram" and not T.ig_gate("max"):
        stats["budget_skips"] += 1
        return "budget", None
    read = read_video(T, e.get("platform"), e.get("url"))
    if read is None:
        return "unreadable", None
    if not read.get("found"):
        return "gone", None
    return "ok", read


def _fail(T, key, e, stats, hide_cover=False):
    """An unreadable read: count it, and after SHOWCASE_MAX_FAILS in a row the entry is 'failed' (never shown)."""
    fails = int(e.get("check_fails") or 0) + 1
    body = {"check_fails": fails}
    if fails >= SHOWCASE_MAX_FAILS:
        body["check_status"] = "failed"
        if hide_cover:
            body["cover_path"] = None
        _patch(T, key, e["id"], body)
        _log(T, key, e["id"], "check_failed")
        stats["failed"] += 1
    else:
        _patch(T, key, e["id"], body)


def _verdict(T, key, e, status, stats, stat_key, hide_cover=False):
    """not_found / mismatch: the entry stops being shown at once."""
    body = {"check_status": status, "checked_at": iso(datetime.now(timezone.utc))}
    if hide_cover:
        body["cover_path"] = None
    _patch(T, key, e["id"], body)
    _log(T, key, e["id"], "check_failed")
    stats[stat_key] += 1


def _cover_one(T, key, e, now, stats):
    state, read = _read(T, e, stats)
    if state == "budget":
        return
    if state == "unreadable":
        return _fail(T, key, e, stats)
    if state == "gone":
        return _verdict(T, key, e, "not_found", stats, "not_found")
    if not owner_ok(e.get("platform"), e.get("handle"), read):
        return _verdict(T, key, e, "mismatch", stats, "mismatch")
    blob = fetch_cover(read.get("thumb"), getattr(T, "UA", None))
    path = cover_name(e.get("pub_id"))
    if blob is None or not upload_cover(key, path, blob):
        return _fail(T, key, e, stats)
    posted = e.get("posted_at") or read.get("posted_at")
    body = {"cover_path": path, "check_status": "ok", "check_fails": 0, "checked_at": iso(now),
            "next_measure_at": iso(next_due(e.get("kind"), e.get("added_at"), now))}
    if posted and not e.get("posted_at"):
        body["posted_at"] = posted
    status, data = _patch(T, key, e["id"], body, rep=True)
    if status == 200 and data == []:            # withdrawn while the cover was being fetched: take the file straight back down
        delete_cover(key, T, path)
        return
    _point(T, key, e, read, posted, now)
    _log(T, key, e["id"], "checked_ok")
    stats["covers"] += 1


def _measure_one(T, key, e, now, stats):
    state, read = _read(T, e, stats)
    if state == "budget":
        return
    if state == "unreadable":
        return _fail(T, key, e, stats, hide_cover=True)
    if state == "gone":
        return _verdict(T, key, e, "not_found", stats, "not_found", hide_cover=True)
    if not owner_ok(e.get("platform"), e.get("handle"), read):
        return _verdict(T, key, e, "mismatch", stats, "mismatch", hide_cover=True)
    posted = e.get("posted_at") or read.get("posted_at")
    body = {"check_fails": 0, "checked_at": iso(now),
            "next_measure_at": iso(next_due(e.get("kind"), e.get("added_at"), now))}
    if posted and not e.get("posted_at"):
        body["posted_at"] = posted
    _point(T, key, e, read, posted, now)
    _patch(T, key, e["id"], body)
    stats["measured"] += 1


def _sweep(T, key, now, stats):
    """Delete stored covers no approved entry references, once they are older than SWEEP_MIN_AGE_S. Never on doubt."""
    status, rows = T.rest(key, f"{ENTRIES}?status=eq.approved&cover_path=not.is.null&select=cover_path&limit=1000")
    if status != 200 or not isinstance(rows, list):
        return
    referenced = {r.get("cover_path") for r in rows if isinstance(r, dict)}
    stored = list_covers(key, T)
    if stored is None:
        return
    for path, created in stored:
        made = parse_ts(created)
        if path in referenced or made is None or (now - made).total_seconds() < SWEEP_MIN_AGE_S:
            continue
        if not COVER_NAME_RE.match(path):
            continue
        s, _ = delete_cover(key, T, path)
        if s in (200, 204):
            stats["swept"] += 1
    T.rest(key, f"{ENTRIES}?status=neq.approved&cover_path=not.is.null", method="PATCH", body={"cover_path": None})


def showcase_pass(key, now, dry=False, T=None):
    """One pass of the lane. `T` is the RUNNING track_posts module (see the docstring). Returns the stats dict, or {} when the
    lane is off, has no module to borrow, or the SQL is not applied."""
    if not SHOWCASE or T is None:
        return {}
    stats = {"covers": 0, "measured": 0, "not_found": 0, "mismatch": 0, "failed": 0, "swept": 0, "budget_skips": 0}
    fields = "id,pub_id,kind,platform,handle,url,added_at,posted_at,check_fails"
    status, cover_rows = T.rest(
        key, f"{ENTRIES}?status=eq.approved&cover_path=is.null&check_status=eq.pending&select={fields}"
             f"&order=decided_at.asc&limit={SHOWCASE_PER_PASS}")
    if status == 404:
        log.info("showcase: lynxr_showcase_entries not readable (HTTP 404) — is supabase/showcase.sql applied?")
        return {}
    if status != 200 or not isinstance(cover_rows, list):
        if status:
            log.info("showcase: lynxr_showcase_entries not readable (HTTP %s)", status)
        return stats
    status, due_rows = T.rest(
        key, f"{ENTRIES}?status=eq.approved&check_status=eq.ok&next_measure_at=lte.{iso(now)}&select={fields}"
             f"&order=next_measure_at.asc&limit={SHOWCASE_PER_PASS}")
    due_rows = due_rows if status == 200 and isinstance(due_rows, list) else []

    if dry:
        stats["covers"], stats["measured"] = len(cover_rows), len(due_rows)
    else:
        for work, step in ((cover_rows, _cover_one), (due_rows, _measure_one)):
            for e in work:
                if T.P.queued_work(key):
                    return _done(stats)
                step(T, key, e, now, stats)
        if T.P.queued_work(key):
            return _done(stats)
        _sweep(T, key, now, stats)
    return _done(stats)


def _done(stats):
    log.info("showcase: covers %d · measured %d · not found %d · mismatch %d · failed %d · swept %d · budget skips %d",
             stats["covers"], stats["measured"], stats["not_found"], stats["mismatch"], stats["failed"], stats["swept"],
             stats["budget_skips"])
    return stats


# ── by hand ───────────────────────────────────────────────────────────────────────────────────────

def cover_dry(T, url, out, spend=False):
    """The REAL read of one public video from this machine, no database. Prints the owner, views, posted_at and the cover's
    host (never the full link), and writes the converted JPEG to `out`. Returns the exit code."""
    out = Path(out)
    if not out.is_absolute() or out.resolve() == P.ROOT or P.ROOT in out.resolve().parents:
        print("OUT must be an absolute path outside the repo")
        return 2
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    platform = "tiktok" if host.endswith("tiktok.com") else "instagram" if host.endswith("instagram.com") else None
    if platform is None:
        print("not a TikTok or Instagram link")
        return 2
    if platform == "instagram":
        if not spend:
            print("instagram costs one Apify result (about $0.0027): add --spend to run it")
            return 2
        if not T.ig_gate("max"):
            print("no Apify token, or the account is past its spend guard")
            return 2
    read = read_video(T, platform, url)
    if read is None:
        print(f"{platform} did not answer (blocked, offline or an unreadable page).")
        return 1
    thumb_host = (urllib.parse.urlparse(str(read.get("thumb") or "")).hostname or "")
    print(f"found: {'yes' if read.get('found') else 'no'}")
    print(f"owner: {read.get('owner') or read.get('url_handle') or '(none)'}")
    print(f"views: {read.get('views')}")
    print(f"posted_at: {read.get('posted_at')}")
    print(f"thumb host: {thumb_host or '(none)'}  allowed: {'yes' if cover_host_ok(read.get('thumb')) else 'no'}")
    blob = fetch_cover(read.get("thumb"), getattr(T, "UA", None))
    if blob is None:
        print("cover: not fetched")
        return 1
    out.write_bytes(blob)
    print(f"cover: {len(blob)} bytes written to {out}")
    return 0


def main():
    envcfg.sanitize_environ()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="read-only: count what is due; fetches and writes nothing")
    ap.add_argument("--cover-dry", nargs=2, metavar=("URL", "OUT"),
                    help="the REAL read of one public video from this machine, no database; writes the JPEG to OUT "
                         "(an absolute path outside the repo)")
    ap.add_argument("--spend", action="store_true",
                    help="with --cover-dry on Instagram: allow the one Apify result it costs (about $0.0027)")
    args = ap.parse_args()
    import track_posts as T                      # here and only here: see the docstring
    if args.cover_dry:
        sys.exit(cover_dry(T, args.cover_dry[0], args.cover_dry[1], spend=args.spend))
    env = P.load_env(P.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"),
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
    showcase_pass(key, datetime.now(timezone.utc), dry=args.dry_run, T=T)


if __name__ == "__main__":
    main()
