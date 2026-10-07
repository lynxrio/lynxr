#!/usr/bin/env python3
"""The insights lane: for every video a creator posted on a profile they CONNECTED (Settings -> connected accounts), read how long the
average viewer watched from the platform's own API, and keep it as a snapshot next to the public counts.

Plan: ~/.claude/plans/lynxr-social-insights.md. Tables, rules and the disconnect function: supabase/platform_insights.sql. The token
lifecycle (exchange, refresh, revoke, encryption) is supabase/functions/insights-connect/index.ts; this file never holds the key and
never decrypts anything, it asks that function's /token route for a usable token.

WHAT IT DOES, IN ORDER (one pass: due -> token -> read -> check -> write)
    DUE. Posts on a profile that has an active token and is in one of three states: `pending` (not read yet, younger than
        INSIGHTS_FRESH_DAYS), `ok` (a view checkpoint has passed since the last read, so a snapshot lands on the same `day` as its
        lynxr_post_views row), or `failed` (under the cap and past its wait). Never unsupported, too_old or no_token.
    TOKEN. POST {INSIGHTS_FN}/token with the service key. needs_reconnect means the function has ALREADY deleted the token and the
        figures: every post of that profile goes to no_token and nothing is written. A transient answer or a rotated key changes nothing.
    READ. Instagram: list the profile's newest media once per pass, match the post on its SHORTCODE (Apify says /p/<code>/ where the API
        says /reel/<code>/ for the same reel, so a canonical-URL join silently finds nothing), then ask for ig_reels_avg_watch_time,
        reels_skip_rate and reach. TikTok: one business-video call per profile, matched on the numeric id in the post's link.
    CHECK. Two guards, because a plausible-but-wrong number is worse than no number: a watch time is converted to milliseconds ONLY when
        INSIGHTS_*_WATCH_UNIT says what unit the platform used (empty means store nothing), and an average longer than three times the
        video's own length is discarded and the post marked failed. The video's length is the one number not in either API; it is read
        once per post with a free yt-dlp metadata call.
    WRITE. One lynxr_post_insights row per (post, day), then the post's state. Just before it, the token row is read again: a creator who
        pressed Disconnect while this pass was mid-flight must not get a figure written back after the delete.

LIFETIME AGGREGATES. Both platforms report these as lifetime totals, not per-window. The snapshot at the largest `day` is the number the
brain uses; earlier ones exist so a post that goes quiet still has a number at all. NEVER SUBTRACT TWO avg_watch_ms VALUES: an average
over a growing population is not differenceable, and the difference is meaningless. (total_watch_ms deltas over views deltas WOULD be a
valid per-window average, which is why total_watch_ms is stored. Nothing reads it yet.)

UNITS, MEASURED AND NOT. Neither platform documents its watch-time unit in a way this file may rely on. Every default is empty, which means
STORE NOTHING, until someone measures it against a video of known length (plan step 11: `insights.py --print UUID` prints the raw value
beside the video's real length; a 14 second reel with a raw value near 4200 is ms, near 4.2 is seconds) and sets the Fly secret.
    INSIGHTS_IG_WATCH_UNIT   measured: NOT YET.      INSIGHTS_IG_SKIP_SCALE  ("1" = already 0-1, "100" = a percentage)  measured: NOT YET.
    INSIGHTS_TT_WATCH_UNIT   measured: NOT YET.      INSIGHTS_TT_RATE_SCALE  same, for the share who finished          measured: NOT YET.
Write the measured value and the date here when it is known, so nobody has to measure it twice.
Instagram insight data can lag up to 48 hours behind the video, and Meta keeps it for two years: an empty answer for a young reel is
"no figure yet", not a failure.

FLY ONLY
    Runs inside track_posts.py's pass (worker.py's idle lane). NEVER add it to .github/workflows/adaptations.yml: the GitHub fallback runs
    process_adaptations.py directly, and a second runner would race the same rows. insights_pass() is handed the RUNNING track_posts module
    as `T`. This file does not import track_posts at module level: track_posts.py runs as __main__, so importing it here would create a
    second copy with its own APIFY_RESULTS and _ROOM budget counters. Only main() below, a separate entry point, imports it.

CREATORS FIRST
    P.queued_work(key) is asked before every post; a queued script ends the pass at once. Posts are taken max -> pro -> free.

COST
    $0. The platform's own API is free for the account holder. No Apify, ever. The one yt-dlp metadata read per post is free.

PRIVACY OF THE LOG
    Counts only: never a handle, a caption, a token, a URL or a full uuid. (A URL here can carry an access token in its query string.)

CREATOR-SIDE ONLY
    Nothing in this file may be imported by pipeline/process_campaigns.py or reach AGENCY_SCRIPT_SYSTEM. pipeline/test_insights.py checks it.

RUN
    ./venv/bin/python pipeline/insights.py --dry-run          # reads the database, counts what is due; polls nothing, writes nothing
    ./venv/bin/python pipeline/insights.py --print UUID       # polls ONE creator's connected posts and prints the table, RAW VALUES
        # included (that is the unit measurement). Writes no figure and no post state; the token route may refresh the token, which is
        # its job. The output holds the creator's numbers: keep it off any public surface.
"""
import argparse
import json
import logging
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_adaptations as P  # noqa: E402
import envcfg  # noqa: E402

log = logging.getLogger("insights")

INSIGHTS = envcfg.get("INSIGHTS", "1") not in ("0", "", "false", "False")               # "0" stops the lane entirely
INSIGHTS_PER_PASS = int(envcfg.get("INSIGHTS_PER_PASS", "6"))                           # posts polled per pass
INSIGHTS_BUDGET_S = float(envcfg.get("INSIGHTS_BUDGET_S", "120"))                       # no new post starts past this many seconds in the lane
INSIGHTS_LIST_LIMIT = int(envcfg.get("INSIGHTS_LIST_LIMIT", "25"))                      # media listed per profile per list call
INSIGHTS_FRESH_DAYS = float(envcfg.get("INSIGHTS_FRESH_DAYS", "7"))                     # a post with no snapshot yet is polled only if younger than this
INSIGHTS_RETRY_H = float(envcfg.get("INSIGHTS_RETRY_H", "6"))                           # a deferred or failed post waits this long
INSIGHTS_MAX_FAILS = int(envcfg.get("INSIGHTS_MAX_FAILS", "3"))                         # then insights_state = 'failed' for good
INSIGHTS_REFRESH_BEFORE_DAYS = int(envcfg.get("INSIGHTS_REFRESH_BEFORE_DAYS", "10"))    # passed to the function's /token route
INSIGHTS_IG_WATCH_UNIT = envcfg.get("INSIGHTS_IG_WATCH_UNIT", "").lower()               # "ms" | "s"; EMPTY = refuse to store (unmeasured)
INSIGHTS_TT_WATCH_UNIT = envcfg.get("INSIGHTS_TT_WATCH_UNIT", "").lower()               # same
INSIGHTS_IG_SKIP_SCALE = envcfg.get("INSIGHTS_IG_SKIP_SCALE", "")                       # "1" | "100"; EMPTY = refuse to store (unmeasured)
INSIGHTS_TT_RATE_SCALE = envcfg.get("INSIGHTS_TT_RATE_SCALE", "")                       # same, for the share who finished
INSIGHTS_DURATION = envcfg.get("INSIGHTS_DURATION", "1") not in ("0", "", "false", "False")   # the one free yt-dlp metadata read per post
INSIGHTS_FN = envcfg.get("INSIGHTS_FN", f"{P.SB_URL}/functions/v1/insights-connect")
# TikTok's Business API could not be verified from any public source (plan, assumption 3): every string below is a guess recorded by the
# owner from the developer portal as a Fly secret, and the defaults are the plan's best guesses, not facts.
INSIGHTS_TT_URL = envcfg.get("INSIGHTS_TT_URL", "https://business-api.tiktok.com/open_api/v1.3/business/video/list/")    # UNVERIFIED
INSIGHTS_TT_HEADER = envcfg.get("INSIGHTS_TT_HEADER", "Access-Token")                                                       # UNVERIFIED
INSIGHTS_TT_FIELDS = envcfg.get("INSIGHTS_TT_FIELDS", "item_id,create_time,video_duration,average_time_watched,"
                                "full_video_watched_rate,total_time_watched,reach,impression_sources")                       # UNVERIFIED

IG_API = "https://graph.instagram.com/v25.0"           # the version the plan verified against the live docs, 2026-10-07
IG_METRICS = "ig_reels_avg_watch_time,reels_skip_rate,reach"
IG_METRIC_MIN = "ig_reels_avg_watch_time"              # the retry when the full list is refused (one invalid metric errors the whole request)
META_TRANSIENT = (4, 17, 32, 613)                      # Meta's rate-limit codes: try again later, change nothing
SANE_MULTIPLE = 3                                      # an average above this many times the video's length is not a watch time
POSTS = "/rest/v1/lynxr_posts"
TOKENS = "/rest/v1/lynxr_platform_tokens"
INSIGHT_ROWS = "/rest/v1/lynxr_post_insights"
POST_FIELDS = ("id,creator_id,platform,handle,url,canonical_url,posted_at,platform_media_id,duration_s,"
               "insights_state,insights_at,insights_fails")

SHORTCODE_RE = re.compile(r"/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)")
TT_ID_RE = re.compile(r"/video/(\d+)")


# ── pure ──────────────────────────────────────────────────────────────────────────────────────────

def _num(v):
    """A non-negative finite number (int or float) or None. Absent is None, never zero. Same rule as brain.py:_num, but a watch time is
    not a whole number, so the fraction is kept."""
    if v is None or isinstance(v, bool):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(n) or math.isinf(n) or n < 0:
        return None
    return int(n) if n.is_integer() else n


def shortcode(url):
    """The Instagram shortcode in a link (the part after /p/, /reel/, /reels/ or /tv/), or None."""
    m = SHORTCODE_RE.search(str(url or ""))
    return m.group(1) if m else None


def tt_video_id(url):
    """The numeric TikTok video id at the end of a post link, or None."""
    m = TT_ID_RE.search(str(url or ""))
    return m.group(1) if m else None


def match_ig(media, url):
    """The id of the media item whose permalink has the same SHORTCODE as `url`, or None. Matching on the shortcode and not the canonical
    URL is the point: the same reel is /p/<code>/ in Apify's data and /reel/<code>/ in the API."""
    want = shortcode(url)
    if not want:
        return None
    for m in media if isinstance(media, list) else []:
        if isinstance(m, dict) and m.get("id") and shortcode(m.get("permalink")) == want:
            return str(m["id"])
    return None


def parse_ig_insights(body):
    """{"avg": n|None, "skip": n|None, "reach": n|None} from Instagram's {"data":[{"name","values":[{"value":N}]}]}. A metric that is absent,
    empty or not a number is None, never 0."""
    by = {}
    for item in (body or {}).get("data") or [] if isinstance(body, dict) else []:
        vals = item.get("values") if isinstance(item, dict) else None
        if isinstance(vals, list) and vals and isinstance(vals[0], dict):
            by[item.get("name")] = _num(vals[0].get("value"))
    return {"avg": by.get("ig_reels_avg_watch_time"), "skip": by.get("reels_skip_rate"), "reach": by.get("reach")}


def to_ms(value, unit):
    """Milliseconds from a raw watch time, or None when the value is missing OR the unit is not set to exactly "ms" or "s"."""
    n = _num(value)
    if n is None or unit not in ("ms", "s"):
        return None
    return int(round(n * (1000 if unit == "s" else 1)))


def to_fraction(value, scale):
    """A 0-1 share from a raw one, or None when it is missing, the scale is not "1" or "100", or the result is outside 0..1."""
    n = _num(value)
    if n is None or scale not in ("1", "100"):
        return None
    f = n / (100.0 if scale == "100" else 1.0)
    return f if 0 <= f <= 1 else None


def finalize(platform, raw, duration_s):
    """(fields, verdict, notes): the lynxr_post_insights columns this read supports, whether it passed the sanity guard, and short reasons
    for anything dropped (logged as counts). `raw` is an adapter's output with the platform's own numbers untouched.

    verdict is "ok", or "implausible" when the converted average exceeds SANE_MULTIPLE x the video's length (the average is then None and
    the caller stores nothing). A unit that is not set yields avg_watch_ms None and a note, not a guess."""
    ig = platform == "instagram"
    unit = INSIGHTS_IG_WATCH_UNIT if ig else INSIGHTS_TT_WATCH_UNIT
    notes = []
    avg = to_ms(raw.get("avg"), unit)
    total = None if ig else to_ms(raw.get("total"), unit)
    if raw.get("avg") is not None and avg is None:
        notes.append("unit_unset")
    if duration_s and avg is not None and avg > SANE_MULTIPLE * duration_s * 1000:
        return ({"avg_watch_ms": None, "total_watch_ms": None, "finished_rate": None, "skipped_3s_rate": None, "reach": None,
                 "sources": None}, "implausible", ["implausible"])
    skipped = to_fraction(raw.get("skipped"), INSIGHTS_IG_SKIP_SCALE) if ig else None
    finished = None if ig else to_fraction(raw.get("finished"), INSIGHTS_TT_RATE_SCALE)
    if ig and raw.get("skipped") is not None and skipped is None:
        notes.append("skip_scale_unset")
    if not ig and raw.get("finished") is not None and finished is None:
        notes.append("rate_scale_unset")
    reach = _num(raw.get("reach"))
    fields = {"avg_watch_ms": avg, "total_watch_ms": total, "finished_rate": finished, "skipped_3s_rate": skipped,
              "reach": int(reach) if reach is not None else None,
              "sources": raw.get("sources") if isinstance(raw.get("sources"), (dict, list)) else None}
    return fields, "ok", notes


def wait_over(post, now, T):
    """True when the post was never tried, or was last tried at least INSIGHTS_RETRY_H ago."""
    at = T.parse_ts(post.get("insights_at"))
    return at is None or now - at >= timedelta(hours=INSIGHTS_RETRY_H)


def is_due(post, now, T):
    """Is this post due a read? pending: younger than INSIGHTS_FRESH_DAYS and past its wait. ok: a view checkpoint passed since the last read.
    failed: under the cap and past its wait. Anything else (unsupported, too_old, no_token) never."""
    state = post.get("insights_state")
    posted = T.parse_ts(post.get("posted_at"))
    if state == "pending":
        return (posted is not None and now - posted <= timedelta(days=INSIGHTS_FRESH_DAYS)) and wait_over(post, now, T)
    if state == "ok":
        at = T.parse_ts(post.get("insights_at"))
        if at is None:
            return True
        nxt = T.next_measure_at(posted, at) if posted is not None else None
        return nxt is not None and nxt <= now
    if state == "failed":
        return int(post.get("insights_fails") or 0) < INSIGHTS_MAX_FAILS and wait_over(post, now, T)
    return False


# ── I/O (none of it raises) ───────────────────────────────────────────────────────────────────────

def http_json(url, method="GET", headers=None, body=None, timeout=30):
    """(status, dict|None). HTTPError -> (code, its JSON body if any); anything else -> (0, None). NEVER logs the URL: it can carry an
    access token in its query string."""
    req = urllib.request.Request(url, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=P.SSL_CTX) as r:
            raw = r.read()
            status = r.status
        data = json.loads(raw) if raw else None
        return status, data if isinstance(data, dict) else None
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read())
        except Exception:  # noqa: BLE001
            data = None
        return e.code, data if isinstance(data, dict) else None
    except Exception:  # noqa: BLE001
        return 0, None


class Ctx:
    """What one pass remembers: the key, the borrowed track_posts module, and per-pass caches (a token and a media list per profile)."""

    def __init__(self, T, key, now, write=True):
        self.T, self.key, self.now, self.write = T, key, now, write
        self.tokens, self.media, self.tt = {}, {}, {}
        self.noted = set()                                  # one log line per reason per pass, not one per post
        self.reset = set()                                  # profiles already set to no_token this pass
        self.stats = {"insights_due": 0, "insights_polled": 0, "insights_ok": 0, "insights_failed": 0, "insights_unsupported": 0,
                      "insights_deferred": 0, "insights_reconnect": 0}


def token_for(ctx, creator_id, platform, handle):
    """("ok", {"access_token", "platform_user_id", ...}) | ("needs_reconnect", None) | ("retry", None), cached for the pass.
    needs_reconnect: the function has ALREADY deleted the token and the figures. retry: transient, a rotated key, or no row: change nothing."""
    k = (creator_id, platform, handle)
    if k in ctx.tokens:
        return ctx.tokens[k]
    st, data = http_json(f"{INSIGHTS_FN}/token", method="POST", headers={"Authorization": f"Bearer {ctx.key}"},
                         body={"creator_id": creator_id, "platform": platform, "handle": handle,
                               "refresh_before_days": INSIGHTS_REFRESH_BEFORE_DAYS})
    err = (data or {}).get("error")
    if st == 200 and isinstance(data, dict) and data.get("access_token"):
        out = ("ok", data)
    elif st == 409 and err == "needs_reconnect":
        out = ("needs_reconnect", None)
    else:
        out = ("retry", None)
        log.info("insights: token route answered HTTP %s (%s)", st, err or "no error code")
    ctx.tokens[k] = out
    return out


def _classify(status, body):
    """What an Instagram error means: "ok" (200), "transient" (network, 5xx, a rate limit), "auth" (the token, not the post), or "refused"."""
    if status == 200:
        return "ok"
    err = (body or {}).get("error") if isinstance(body, dict) else None
    code = err.get("code") if isinstance(err, dict) else None
    code = code if isinstance(code, int) else None
    if status == 0 or status >= 500 or code in META_TRANSIENT:
        return "transient"
    if status == 401 or code == 190 or code == 10 or (code is not None and 200 <= code <= 299):
        return "auth"
    return "refused"


def ig_list(ctx, token, cid, handle):
    """The profile's newest media, cached per profile per pass, or None when it could not be read."""
    k = (cid, handle)
    if k not in ctx.media:
        st, body = http_json(f"{IG_API}/me/media?" + urllib.parse.urlencode(
            {"fields": "id,permalink,timestamp,media_type,caption", "limit": INSIGHTS_LIST_LIMIT, "access_token": token}))
        ctx.media[k] = body.get("data") if st == 200 and isinstance(body, dict) and isinstance(body.get("data"), list) else None
    return ctx.media[k]


def ig_poll(ctx, token, post):
    """(kind, raw): kind is "ok", "nomatch", "nodata", "unsupported", "auth" or "transient". `raw` carries the platform's own numbers
    untouched. One invalid metric errors the WHOLE request (Meta's docs), so a refused request is retried once with the average alone, and
    only if that is refused too is the post `unsupported` (a feed video is not a reel and never will be)."""
    media_id = post.get("platform_media_id")
    if not media_id:
        media = ig_list(ctx, token, post["creator_id"], post["handle"])
        if media is None:
            return "transient", None
        media_id = match_ig(media, post.get("canonical_url") or post.get("url")) or match_ig(media, post.get("url"))
        if not media_id:
            return "nomatch", None
    for metrics in (IG_METRICS, IG_METRIC_MIN):
        st, body = http_json(f"{IG_API}/{urllib.parse.quote(str(media_id), safe='')}/insights?" +
                             urllib.parse.urlencode({"metric": metrics, "access_token": token}))
        kind = _classify(st, body)
        if kind == "ok":
            got = parse_ig_insights(body)
            raw = {"media_id": media_id, "avg": got["avg"], "skipped": got["skip"], "reach": got["reach"],
                   "total": None, "finished": None, "sources": None, "duration_s": None}
            return ("ok" if any(raw[k] is not None for k in ("avg", "skipped", "reach")) else "nodata"), raw
        if kind in ("transient", "auth"):
            return kind, None
    return "unsupported", None


def tt_poll(ctx, token, post, platform_user_id):
    """UNVERIFIED (plan, assumption 3). One business-video call per profile per pass, matched on the numeric id in the post's link. Anything
    that does not look as expected is "transient" or "nomatch": a wrong guess is a logged refusal, never a wrong row."""
    k = (post["creator_id"], post["handle"])
    if k not in ctx.tt:
        fields = json.dumps([f.strip() for f in INSIGHTS_TT_FIELDS.split(",") if f.strip()])
        st, body = http_json(f"{INSIGHTS_TT_URL}?" + urllib.parse.urlencode({"business_id": platform_user_id, "fields": fields}),
                             headers={INSIGHTS_TT_HEADER: token})
        data = (body or {}).get("data") if isinstance(body, dict) else None
        items = None
        if st == 200 and isinstance(body, dict) and body.get("code") == 0 and isinstance(data, dict):
            items = next((data[n] for n in ("videos", "list", "items") if isinstance(data.get(n), list)), None)
        ctx.tt[k] = items
    items = ctx.tt[k]
    if items is None:
        return "transient", None
    want = tt_video_id(post.get("url"))
    hit = next((i for i in items if isinstance(i, dict) and want and str(i.get("item_id")) == want), None)
    if hit is None:
        return "nomatch", None
    dur = _num(hit.get("video_duration"))
    raw = {"media_id": want, "avg": _num(hit.get("average_time_watched")), "total": _num(hit.get("total_time_watched")),
           "finished": _num(hit.get("full_video_watched_rate")), "skipped": None, "reach": _num(hit.get("reach")),
           "sources": hit.get("impression_sources"), "duration_s": int(round(dur)) if dur else None}
    return ("ok" if any(raw[k2] is not None for k2 in ("avg", "finished", "reach")) else "nodata"), raw


def read_duration(T, post):
    """The video's length in whole seconds (1..3600) from one free yt-dlp metadata read, or None. Only ever a plain link on its own platform."""
    if not T.post_url_ok(post.get("url"), post.get("platform")):
        return None
    d = T.ytdlp_json(["--skip-download", "--no-playlist", "--dump-single-json", post["url"]], 90)
    dur = _num((d or {}).get("duration"))
    return int(round(dur)) if dur and 0 < dur <= 3600 else None


def poll_one(ctx, post):
    """Read one post. Returns a dict {"kind", "fields", "raw", "duration_s", "media_id", "notes"} and writes NOTHING. kind is one of
    "ok" "no_token" "retry" "nomatch" "nodata" "unsupported" "implausible" "transient" "auth"."""
    T = ctx.T
    platform = post["platform"]
    tk, tok = token_for(ctx, post["creator_id"], platform, post["handle"])
    if tk == "needs_reconnect":
        return {"kind": "no_token"}
    if tk != "ok":
        return {"kind": "retry"}
    token = tok["access_token"]
    kind, raw = (ig_poll(ctx, token, post) if platform == "instagram"
                 else tt_poll(ctx, token, post, tok.get("platform_user_id")))
    if kind != "ok":
        return {"kind": kind}
    duration = post.get("duration_s") or raw.get("duration_s")
    if not duration and INSIGHTS_DURATION:
        duration = read_duration(T, post)
    fields, verdict, notes = finalize(platform, raw, duration)
    if verdict != "ok":
        return {"kind": verdict, "raw": raw, "duration_s": duration, "notes": notes, "media_id": raw.get("media_id")}
    return {"kind": "ok", "fields": fields, "raw": raw, "duration_s": duration, "notes": notes, "media_id": raw.get("media_id")}


def profile_q(T, r):
    return f"creator_id=eq.{T.q(r['creator_id'])}&platform=eq.{T.q(r['platform'])}&handle=eq.{T.q(r['handle'])}"


def token_active(ctx, post):
    """True when the profile's token row still exists and is active, read right now. False on any doubt."""
    st, rows = ctx.T.rest(ctx.key, f"{TOKENS}?{profile_q(ctx.T, post)}&status=eq.active&select=handle")
    return st == 200 and isinstance(rows, list) and len(rows) > 0


def apply(ctx, post, res):
    """Write what poll_one found: the figure (when there is one), then the post's state. Counts the outcome in ctx.stats."""
    T, key, now, stats = ctx.T, ctx.key, ctx.now, ctx.stats
    stamp = T.iso(now)
    where = f"{POSTS}?id=eq.{int(post['id'])}"
    fails = int(post.get("insights_fails") or 0) + 1
    kind = res["kind"]
    for note in res.get("notes") or []:
        if note not in ctx.noted:
            ctx.noted.add(note)
            if note == "implausible":
                log.info("insights: dropped an average of %s (raw) on a %ss video — more than %dx its length", (res.get("raw") or {}).get("avg"),
                         res.get("duration_s"), SANE_MULTIPLE)
            else:
                log.info("insights: a figure was not stored (%s) — set the matching INSIGHTS_* secret after measuring it", note)

    def patch(body):
        T.rest(key, where, method="PATCH", body=body, prefer="return=minimal")

    if kind == "no_token":
        k = (post["creator_id"], post["platform"], post["handle"])
        if k not in ctx.reset:                              # one update per profile, not one per post
            ctx.reset.add(k)
            T.rest(key, f"{POSTS}?{profile_q(T, post)}", method="PATCH", body={"insights_state": "no_token"}, prefer="return=minimal")
        stats["insights_reconnect"] += 1
        return
    if kind in ("retry", "auth", "transient", "nodata"):
        patch({"insights_at": stamp})                      # wait INSIGHTS_RETRY_H before another look; not the post's fault, so no fail counted
        stats["insights_deferred"] += 1
        return
    if kind == "unsupported":
        patch({"insights_state": "unsupported", "insights_at": stamp})
        stats["insights_unsupported"] += 1
        return
    if kind in ("nomatch", "implausible"):
        patch({"insights_at": stamp, "insights_fails": fails,
               **({"insights_state": "failed"} if kind == "implausible" or fails >= INSIGHTS_MAX_FAILS else {})})
        stats["insights_failed"] += 1
        return
    # kind == "ok"
    fields = res["fields"]
    state_patch = {"insights_state": "ok", "insights_at": stamp, "insights_fails": 0}
    if res.get("media_id") and post["platform"] == "instagram":
        state_patch["platform_media_id"] = str(res["media_id"])[:64]
    if res.get("duration_s") and not post.get("duration_s"):
        state_patch["duration_s"] = int(res["duration_s"])
    if any(v is not None for v in fields.values()):
        if not token_active(ctx, post):                     # a Disconnect pressed mid-pass wins: write nothing back
            stats["insights_deferred"] += 1
            return
        day = min(T.age_days(post.get("posted_at"), now), 3650)
        status, _ = T.rest(key, f"{INSIGHT_ROWS}?on_conflict=post_id,day", method="POST",
                           body={"post_id": int(post["id"]), "creator_id": post["creator_id"], "platform": post["platform"],
                                 "day": day, "at": stamp, **fields},
                           prefer="resolution=merge-duplicates,return=minimal")
        if not 200 <= status < 300:
            patch({"insights_at": stamp, "insights_fails": fails,
                   **({"insights_state": "failed"} if fails >= INSIGHTS_MAX_FAILS else {})})
            stats["insights_failed"] += 1
            return
    patch(state_patch)
    stats["insights_ok"] += 1


# ── due set ───────────────────────────────────────────────────────────────────────────────────────

def connected_profiles(T, key, creator=None):
    """{(creator_id, platform, handle)} of every ACTIVE token, or None when the table is not readable (the SQL is not applied)."""
    extra = f"&creator_id=eq.{T.q(creator)}" if creator else ""
    st, rows = T.rest(key, f"{TOKENS}?status=eq.active{extra}&select=creator_id,platform,handle&limit=1000")
    if st in (400, 404):
        return None
    if st != 200 or not isinstance(rows, list):
        return set()
    return {(r["creator_id"], r["platform"], r["handle"]) for r in rows if isinstance(r, dict) and r.get("creator_id")}


def due(T, key, now, cache):
    """The posts to read now, max -> pro -> free, or None when supabase/platform_insights.sql is not applied. Three reads merged in Python
    (the match_due() device: one PostgREST or= clause is easy to get wrong on the hot path)."""
    profiles = connected_profiles(T, key)
    if profiles is None:
        log.info("insights: lynxr_platform_tokens missing — is supabase/platform_insights.sql applied?")
        return None
    if not profiles:
        return []
    ids = ",".join(sorted({T.q(c) for c, _, _ in profiles}))
    base = f"{POSTS}?origin=eq.tracked&creator_id=in.({ids})&select={POST_FIELDS}&order=posted_at.desc.nullslast&limit=300"
    out, seen = [], set()
    for state in ("pending", "ok", "failed"):
        st, rows = T.rest(key, f"{base}&insights_state=eq.{state}")
        if st in (400, 404):
            log.info("insights: lynxr_posts.insights_state missing — is supabase/platform_insights.sql applied?")
            return None
        if st != 200 or not isinstance(rows, list):
            continue
        for r in rows:
            if (isinstance(r, dict) and r.get("id") is not None and r["id"] not in seen
                    and (r.get("creator_id"), r.get("platform"), r.get("handle")) in profiles and is_due(r, now, T)):
                seen.add(r["id"])
                out.append(r)
    return T.by_tier(out, key, cache)


def _done(stats):
    log.info("insights: due %d · ok %d · failed %d · unsupported %d · deferred %d · reconnect %d",
             stats["insights_due"], stats["insights_ok"], stats["insights_failed"], stats["insights_unsupported"],
             stats["insights_deferred"], stats["insights_reconnect"])
    return stats


def insights_pass(key, now, dry=False, T=None):
    """One pass of the lane. `T` is the RUNNING track_posts module (see the docstring). Returns the counts, or {} when the lane is off, has
    no module to borrow, or supabase/platform_insights.sql is not applied."""
    if not INSIGHTS or T is None:
        return {}
    ctx = Ctx(T, key, now)
    cache = {}
    work = due(T, key, now, cache)
    if work is None:
        return {}
    ctx.stats["insights_due"] = len(work)
    if dry:
        return _done(ctx.stats)                            # before any platform call and before any write
    started = time.monotonic()
    for post in work[:INSIGHTS_PER_PASS]:
        if T.P.queued_work(key) or time.monotonic() - started >= INSIGHTS_BUDGET_S:
            break
        ctx.stats["insights_polled"] += 1
        try:
            apply(ctx, post, poll_one(ctx, post))
        except Exception as e:  # noqa: BLE001 — one broken post must never stop the lane
            log.info("insights: post failed (%s)", type(e).__name__)
            ctx.stats["insights_failed"] += 1
    for (cid, platform, handle) in ctx.tokens:             # when each connected profile was last polled
        if ctx.tokens[(cid, platform, handle)][0] == "ok":
            T.rest(key, f"{TOKENS}?creator_id=eq.{T.q(cid)}&platform=eq.{T.q(platform)}&handle=eq.{T.q(handle)}",
                   method="PATCH", body={"last_poll_at": T.iso(now)}, prefer="return=minimal")
    return _done(ctx.stats)


# ── by hand ───────────────────────────────────────────────────────────────────────────────────────

def print_creator(T, key, cid):
    """Poll one creator's connected posts and print the table, raw values included. Writes no figure and no post state. Returns the exit code."""
    profiles = connected_profiles(T, key, creator=cid)
    if profiles is None:
        print("lynxr_platform_tokens is not readable: is supabase/platform_insights.sql applied?")
        return 1
    if not profiles:
        print("that creator has no active connected account")
        return 1
    now = datetime.now(timezone.utc)
    ctx = Ctx(T, key, now, write=False)
    st, posts = T.rest(key, f"{POSTS}?creator_id=eq.{T.q(cid)}&origin=eq.tracked&select={POST_FIELDS}"
                            "&order=posted_at.desc.nullslast&limit=40")
    if st != 200 or not isinstance(posts, list):
        print(f"could not read that creator's posts (HTTP {st})")
        return 1
    print("# warning: this holds the creator's own numbers. Keep it off any public surface.")
    print(f"# units set: instagram watch={INSIGHTS_IG_WATCH_UNIT or 'NOT SET'} skip-scale={INSIGHTS_IG_SKIP_SCALE or 'NOT SET'}; "
          f"tiktok watch={INSIGHTS_TT_WATCH_UNIT or 'NOT SET'} rate-scale={INSIGHTS_TT_RATE_SCALE or 'NOT SET'}")
    print(f"{'post':<8} {'platform':<10} {'posted':<11} {'result':<12} {'raw avg':<10} {'raw skip':<9} {'raw reach':<10} "
          f"{'video s':<8} {'avg ms (stored)':<16} notes")
    for p in posts:
        if (p.get("creator_id"), p.get("platform"), p.get("handle")) not in profiles:
            continue
        res = poll_one(ctx, p)
        raw = res.get("raw") or {}
        fields = res.get("fields") or {}
        when = T.parse_ts(p.get("posted_at"))
        print(f"{str(p['id']):<8} {p['platform']:<10} {(when.strftime('%Y-%m-%d') if when else '—'):<11} {res['kind']:<12} "
              f"{str(raw.get('avg')):<10} {str(raw.get('skipped')):<9} {str(raw.get('reach')):<10} "
              f"{str(res.get('duration_s') or '—'):<8} {str(fields.get('avg_watch_ms')):<16} {','.join(res.get('notes') or [])}")
    return 0


def main():
    envcfg.sanitize_environ()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="read-only: count what is due; polls nothing and writes nothing")
    ap.add_argument("--print", dest="print_uuid", metavar="CREATOR_UUID",
                    help="poll that creator's connected posts and print the table with the RAW values; writes no figure and no state")
    args = ap.parse_args()
    if not args.dry_run and not args.print_uuid:
        ap.error("give --dry-run or --print CREATOR_UUID")
    import track_posts as T                      # here and only here: see the docstring
    env = P.load_env(P.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"),
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
    if args.print_uuid:
        sys.exit(print_creator(T, key, args.print_uuid))
    stats = insights_pass(key, datetime.now(timezone.utc), dry=True, T=T)
    if not stats:
        print("the lane is off, or supabase/platform_insights.sql is not applied")
        sys.exit(1)
    print(f"insights_due {stats['insights_due']}")


if __name__ == "__main__":
    main()
