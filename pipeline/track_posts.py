#!/usr/bin/env python3
"""The profile lane: bio-code verification of the TikTok / Instagram profiles creators add, and, for EVERY verified profile
(free, pro and max alike), discovery and measurement of the videos posted on it, plus a daily follower count.

Plans: ~/.claude/plans/lynxr-onboarding-and-post-tracking.md and ~/.claude/plans/lynxr-tracking-for-all.md. Owner, 2026-09-21 /
2026-10-01: one setup for every tier that collects the profiles tracking needs, each confirmed by a short code in the bio.
Owner, 2026-10-03: tracking is for every tier; what the tiers sell is the coaching (not built yet), so this lane no longer
asks whether an account holds post_tracking. The database function has_post_tracking() is left in place, unused.

WHAT IT DOES, IN ORDER (one pass: verify -> scan -> measure -> followers -> showcase -> match -> insights -> brain -> health)
    VERIFY (every tier). For each profile in lynxr_profiles that is not verified yet and is due a check, read the
        profile's public bio and look for its verify_code (set by supabase/profiles.sql's set_my_profile). Found ->
        verified, with the platform's own account number recorded so a username that later passes to someone else
        can be told apart. Nothing in VERIFY reads a profile's posts.
    SCAN (every tier). For each verified profile not scanned within TRACK_TT_SCAN_H / TRACK_IG_SCAN_H, list its
        newest videos (TikTok: yt-dlp, free; Instagram: one Apify `posts` run) and store the ones newer than the profile's
        watermark in lynxr_posts, each with a day-0 snapshot in lynxr_post_views. A first scan backfills
        TRACK_BACKFILL_DAYS. If the videos belong to a different platform account number than the one recorded at
        verification the profile is marked `changed` and nothing is stored.
    MEASURE (every tier). Re-read each stored video at day 1, 3, 7 and 30 after posting (TRACK_CHECKPOINTS) and
        add a snapshot of its views, likes and comments. TikTok is free (yt-dlp); Instagram is one Apify result.
    FOLLOWERS (every tier). One follower-count snapshot per verified profile per UTC day in
        lynxr_profile_followers. TikTok reads userInfo.statsV2.followerCount off the public profile page it is
        already able to fetch (free); Instagram is one Apify `details` result per profile per day.
    The three goals read these: views per video and likes per video from the day-7 snapshots of the latest 5 videos,
    followers from the daily snapshots.
    MATCH (every tier, after the other lanes so it can never delay them; BRAIN runs after it). Plan: ~/.claude/plans/lynxr-adaptation-id.md. A stored
        post that has no script link yet is matched to the lynxr script that produced it: the creator's recent finished,
        branded scripts are the candidates (none -> nothing is downloaded), the post's audio is fetched with yt-dlp and
        transcribed by the worker's own Whisper, and pipeline/post_match.py scores the words against each candidate. Only a
        sure match writes lynxr_posts.adaptation_id (match_state 'auto'); everything else is logged for staff in
        lynxr_match_log (numbers and script ids, never a word of the transcript or caption). Precision over recall: a wrong
        link teaches the brain a lie nothing can detect. Needs supabase/post_match.sql; without it the lane logs one line and
        does nothing. TRACK_MATCH=0 stops it; TRACK_MATCH_WRITE=0 scores and logs but links nothing (shadow mode).
    INSIGHTS (only creators who connected an account in Settings, after MATCH and before BRAIN so the brain sees the freshest watch
        numbers in the same pass). Plan: ~/.claude/plans/lynxr-social-insights.md. For each video on a connected profile, the platform's
        own API says how long the average viewer watched (Instagram: ig_reels_avg_watch_time and reels_skip_rate, reels only; TikTok's
        endpoint is unverified), kept as a snapshot in lynxr_post_insights (pipeline/insights.py). It costs nothing: the platform's API is
        free for the account holder, and the one yt-dlp metadata read per post is free. It asks the insights-connect Edge Function for a
        usable token and never holds the encryption key. INSIGHTS=0 stops it; a watch time is stored only once its unit has been measured
        (INSIGHTS_*_WATCH_UNIT). Needs supabase/platform_insights.sql; without it the lane logs one line and does nothing.
    BRAIN (every tier, after MATCH and INSIGHTS so it sees the freshest links and watch numbers). Plan: ~/.claude/plans/lynxr-brain-doc.md. Each creator's own tracked
        posts and onboarding answers are folded into one derived document in lynxr_creator_brain (pipeline/brain.py): how they write
        (their own captions), where they post, and, once five posts on one platform have a day-7 count, how their videos do against their
        own median. DERIVED: safe to drop, rebuilt at most every BRAIN_EVERY_H hours, nothing here reads it yet. It costs nothing but one
        weekly Haiku call per creator for the voice line. BRAIN=0 stops the lane; BRAIN_VOICE=0 (the default) drops only that call, and
        nothing is sent to Anthropic while it is off. Needs supabase/creator_brain.sql; without it the lane logs one line and does nothing.

FLY ONLY
    Runs as worker.py's idle lane (TRACK_POSTS). NEVER add it to .github/workflows/adaptations.yml: the
    GitHub fallback runs process_adaptations.py directly, and a second runner would double the Apify
    spend and race the same rows.

CREATORS FIRST
    P.queued_work(key) is asked before every item; a queued script ends the pass at once.

COST (Apify, measured 2026-10-01; the full table is in the plan). Result price $0.0027.
    TikTok verification, scan, measurement and follower counts are FREE (public page + yt-dlp).
    Instagram verification: one `details` result, only on a press, capped at TRACK_IG_VERIFY_TRIES per profile.
    Instagram tracking, per post: 1 discovery + 4 checkpoint lookups = 5 results = about $0.0135, so about $0.18 a month
    for a profile posting 3 a week, $0.41 daily. Likes and comments come back in the same result as views: no extra cost.
    Instagram followers: one `details` result per profile per day = about $0.081 a month per profile (30 results).
    MATCH: $0 — one yt-dlp audio download and one local Whisper pass per attempted post; no Apify, ever.
    All Apify calls stop while the account's spend (plus this process's own results) is at or over
    (1 - TRACK_APIFY_RESERVE) x the cap, so a creator's paid view lookups keep headroom.

TIER PRIORITY UNDER THE APIFY BUDGET (2026-10-03). Tracking for everyone means free accounts can use up the Apify month and
    stop Instagram tracking for paying ones. So each creator's tier is looked up once per pass (the service-role
    entitlement_for(uid): plan_code, no row or an error = free), and
      * Instagram work (verify, scan, measure, followers) is taken max -> pro -> free within each pass;
      * once this month's Apify spend reaches TRACK_IG_FREE_STOP x the ceiling (default 0.5) Instagram work for FREE accounts
        stops, and past TRACK_IG_PRO_STOP x the ceiling (default 0.65) it stops for PRO too; the 80% guard above still stops
        everything. TikTok work costs nothing and is never skipped for budget.
    Instagram costs about $0.26-0.49 a month per tracked profile (5 results per post plus 30 follower results a month), so
    the Apify plan has to be a paid one before many creators link Instagram.

PRIVACY OF THE LOG
    It never logs handles, emails, captions or full uuids: counts only.

RUN
    By hand:
        ./venv/bin/python pipeline/track_posts.py --dry-run    # read-only: lists what is due, no fetch, no write
        ./venv/bin/python pipeline/track_posts.py              # one pass
        ./venv/bin/python pipeline/track_posts.py --verify-dry tiktok <handle> <code>
            # the REAL check for one profile from this Mac: reads the bio, prints it, says whether <code> is in it.
            # No database access, nothing written. Free. Instagram needs --spend (one Apify result, about $0.0027).
        ./venv/bin/python pipeline/track_posts.py --match-dry POST_ID
            # the whole match path for one stored post: prints the candidate table and the decision. Reads the database,
            # never writes it. Costs one free audio download and one local Whisper pass.
"""
import argparse
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_adaptations as P  # noqa: E402
import post_match as M  # noqa: E402
import envcfg  # noqa: E402

log = logging.getLogger("track_posts")

# TikTok verification reads the public profile page. TRACK_TT=0 switches it off (set it if TikTok refuses
# Fly's IP: profiles then show "TikTok can't be checked right now" and stay unverified).
TRACK_TT = envcfg.get("TRACK_TT", "1") not in ("0", "", "false", "False")
TRACK_VERIFY_PER_PASS = int(envcfg.get("TRACK_VERIFY_PER_PASS", "3"))          # profiles checked per pass
TRACK_TT_VERIFY_TRIES = int(envcfg.get("TRACK_TT_VERIFY_TRIES", "200"))        # mirrors supabase/profiles.sql
TRACK_IG_VERIFY_TRIES = int(envcfg.get("TRACK_IG_VERIFY_TRIES", "10"))         # mirrors supabase/profiles.sql
TRACK_TT_AUTOCHECK_DAYS = float(envcfg.get("TRACK_TT_AUTOCHECK_DAYS", "7"))    # TikTok is checked by itself this long
TRACK_APIFY_RESERVE = float(envcfg.get("TRACK_APIFY_RESERVE", "0.2"))          # share of the cap never spent here
TRACK_IG_FREE_STOP = float(envcfg.get("TRACK_IG_FREE_STOP", "0.5"))            # share of the Apify ceiling past which FREE accounts' Instagram work stops
TRACK_IG_PRO_STOP = float(envcfg.get("TRACK_IG_PRO_STOP", "0.65"))             # ... and PRO accounts' (max is only ever stopped by the reserve)
TRACK_APIFY_MAX_CHARGE_USD = float(envcfg.get("TRACK_APIFY_MAX_CHARGE_USD", "0.10"))  # per Apify run
# Scan, measure and followers: every verified profile, whatever the tier.
TRACK_SCAN_PER_PASS = int(envcfg.get("TRACK_SCAN_PER_PASS", "3"))              # profiles scanned per pass
TRACK_MEASURE_PER_PASS = int(envcfg.get("TRACK_MEASURE_PER_PASS", "5"))        # posts measured per pass
TRACK_FOLLOW_PER_PASS = int(envcfg.get("TRACK_FOLLOW_PER_PASS", "6"))          # follower counts read per pass
TRACK_TT_SCAN_H = float(envcfg.get("TRACK_TT_SCAN_H", "24"))                   # a TikTok profile is scanned this often
TRACK_IG_SCAN_H = float(envcfg.get("TRACK_IG_SCAN_H", "24"))                   # an Instagram profile is scanned this often (a paid run)
TRACK_TT_LIST_LIMIT = int(envcfg.get("TRACK_TT_LIST_LIMIT", "30"))             # newest TikTok videos listed per scan
TRACK_IG_LIST_LIMIT = int(envcfg.get("TRACK_IG_LIST_LIMIT", "20"))             # newest Instagram posts requested per scan
TRACK_BACKFILL_DAYS = float(envcfg.get("TRACK_BACKFILL_DAYS", "30"))           # how far back a first scan reaches
TRACK_CHECKPOINTS = envcfg.get("TRACK_CHECKPOINTS", "1,3,7,30")                # days after posting at which counts are re-read
TRACK_MEASURE_RETRY_H = float(envcfg.get("TRACK_MEASURE_RETRY_H", "6"))        # a failed measurement is retried after this
TRACK_MEASURE_MAX_FAILS = int(envcfg.get("TRACK_MEASURE_MAX_FAILS", "3"))      # then it moves on to its next checkpoint
# One follower-count snapshot per verified profile per UTC day. TRACK_IG_FOLLOWERS=0 stops only the paid Instagram half
# (about $0.081 a month per profile); a failed read waits TRACK_FOLLOW_RETRY_H before the next try, so a broken profile
# cannot spend every pass.
TRACK_FOLLOWERS = envcfg.get("TRACK_FOLLOWERS", "1") not in ("0", "", "false", "False")
TRACK_IG_FOLLOWERS = envcfg.get("TRACK_IG_FOLLOWERS", "1") not in ("0", "", "false", "False")
TRACK_FOLLOW_RETRY_H = float(envcfg.get("TRACK_FOLLOW_RETRY_H", "6"))
# MATCH (the script-attribution lane, pipeline/post_match.py). TRACK_MATCH=0 stops it; TRACK_MATCH_WRITE=0 is shadow mode (score and
# log, link nothing). The thresholds are the ones reviewed on 2026-09-21 and move only on reviewed data from lynxr_match_log.
TRACK_MATCH = envcfg.get("TRACK_MATCH", "1") not in ("0", "", "false", "False")
TRACK_MATCH_WRITE = envcfg.get("TRACK_MATCH_WRITE", "1") not in ("0", "", "false", "False")
TRACK_MATCH_PER_PASS = int(envcfg.get("TRACK_MATCH_PER_PASS", "2"))            # posts attempted per pass
TRACK_MATCH_BUDGET_S = float(envcfg.get("TRACK_MATCH_BUDGET_S", "240"))        # no new attempt starts past this many seconds in the lane
TRACK_MATCH_MAX_SEC = float(envcfg.get("TRACK_MATCH_MAX_SEC", "300"))          # a downloaded file longer than this is skipped, not transcribed
TRACK_MATCH_RETRY_H = float(envcfg.get("TRACK_MATCH_RETRY_H", "12"))           # a failed post waits this long before another try
TRACK_MATCH_MAX_FAILS = int(envcfg.get("TRACK_MATCH_MAX_FAILS", "3"))          # then it stays failed for good
MATCH_WINDOW_DAYS = float(envcfg.get("MATCH_WINDOW_DAYS", "45"))               # a script is a candidate if added this long before the post
MATCH_PER_SCRIPT = int(envcfg.get("MATCH_PER_SCRIPT", "4"))                    # most posts one script may ever be linked to
MATCH_CFG = M.Cfg(auto_min=float(envcfg.get("MATCH_AUTO_MIN", "0.70")), margin=float(envcfg.get("MATCH_MARGIN", "0.25")),
                  contain_min=float(envcfg.get("MATCH_CONTAIN_MIN", "0.45")),
                  contain_strong=float(envcfg.get("MATCH_CONTAIN_STRONG", "0.60")),
                  auto_days=float(envcfg.get("MATCH_AUTO_DAYS", "30")), log_min=float(envcfg.get("MATCH_LOG_MIN", "0.25")),
                  per_script=MATCH_PER_SCRIPT, window_days=MATCH_WINDOW_DAYS,
                  # The sparse path (see post_match.decide). Tunable by env so the cutoff can be moved on the
                  # worker without a deploy while it is still being calibrated against real posts.
                  sparse_script_words=int(envcfg.get("MATCH_SPARSE_SCRIPT_WORDS", "20")),
                  sparse_post_words=int(envcfg.get("MATCH_SPARSE_POST_WORDS", "10")),
                  sparse_days=float(envcfg.get("MATCH_SPARSE_DAYS", "14")))

HANDLE_RE = re.compile(r"[a-z0-9._]{1,30}")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36")
TT_SCRIPT_RE = re.compile(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', re.S)

APIFY_RESULTS = 0          # Apify result items received this process (for the log line's cost estimate)
_ROOM = {"v": False}       # False = not looked; None = looked, unknown; (current, ceiling) = known


# ── pure ──────────────────────────────────────────────────────────────────────────────────────────

def count_or_none(*values):
    """The first value that reads as a non-negative whole number, else None. Absent is None, never zero; Instagram
    returns -1 for a count the creator has hidden, and that is absent too."""
    for v in values:
        if v is None or isinstance(v, bool):
            continue
        try:
            n = int(float(v)) if isinstance(v, str) and "." in v else int(v)
        except (TypeError, ValueError):
            continue
        if n >= 0:
            return n
    return None


def good_handle(h):
    return isinstance(h, str) and bool(HANDLE_RE.fullmatch(h))


def bio_has_code(bio, code):
    """Case-insensitive. False on empty input."""
    if not bio or not code:
        return False
    return str(code).lower() in str(bio).lower()


TT_PRIVATE_STATUS = 10222   # "ErrBizUserSecret": the account exists and is private


def parse_tt_page(html):
    """{found, private, bio, uid, followers, error} from a TikTok profile page. Never raises.

    `found` is true only for statusCode 0 with a user id. `error` is true when the page carried no
    readable profile data at all (a block page, a captcha, garbage): that is "TikTok did not answer",
    not "no such user", and classify_verify treats the two differently.

    `followers` is the follower count, or None. statsV2.followerCount is a decimal string holding the exact count
    (96000317 for the account measured 2026-10-01); stats.followerCount is the same number rounded (96000000), so it
    is only the fallback."""
    out = {"found": False, "private": False, "bio": "", "uid": None, "followers": None, "error": True}
    try:
        m = TT_SCRIPT_RE.search(html or "")
        if not m:
            return out
        detail = json.loads(m.group(1))["__DEFAULT_SCOPE__"]["webapp.user-detail"]
        out["error"] = False
        user = ((detail.get("userInfo") or {}).get("user")) or {}
        if detail.get("statusCode") == 0 and user.get("id"):
            info = detail.get("userInfo") or {}
            out.update(found=True, private=bool(user.get("privateAccount")),
                       bio=str(user.get("signature") or ""), uid=str(user["id"]),
                       followers=count_or_none((info.get("statsV2") or {}).get("followerCount"),
                                               (info.get("stats") or {}).get("followerCount")))
        elif detail.get("statusCode") == TT_PRIVATE_STATUS and user.get("id"):
            # A private account: TikTok returns the user but hides the bio (signature is ""), so the code
            # can never be read. Measured 2026-10-01 on a real private profile.
            out.update(found=True, private=True, bio="", uid=str(user["id"]))
        return out
    except Exception:  # noqa: BLE001 -- garbage in, "did not answer" out
        return {"found": False, "private": False, "bio": "", "uid": None, "followers": None, "error": True}


def parse_ts(s):
    """An aware datetime from a PostgREST / Python ISO timestamp, or None."""
    if not s:
        return None
    try:
        t = str(s).strip().replace("Z", "+00:00")
        m = re.match(r"^(.*T\d\d:\d\d:\d\d)\.(\d+)(.*)$", t)
        if m:
            t = f"{m.group(1)}.{m.group(2)[:6].ljust(6, '0')}{m.group(3)}"
        d = datetime.fromisoformat(t)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def verify_due(p, now):
    """True when this profile row should be checked now.

    Not verified yet, under the platform's try cap, and either the creator asked (check_requested_at) or
    it is a TikTok profile still inside its automatic window. Instagram NEVER auto-checks: it costs
    money, so it runs on a press only. With TRACK_TT off a TikTok profile is never due."""
    if p.get("verified_at"):
        return False
    ig = p.get("platform") == "instagram"
    cap = TRACK_IG_VERIFY_TRIES if ig else TRACK_TT_VERIFY_TRIES
    if int(p.get("verify_tries") or 0) >= cap:
        return False
    if not ig and not TRACK_TT:
        return False
    if p.get("check_requested_at"):
        return True
    if ig:
        return False
    added = parse_ts(p.get("added_at"))
    if added is None or now - added >= timedelta(days=TRACK_TT_AUTOCHECK_DAYS):
        return False
    last = parse_ts(p.get("last_checked_at"))
    if last is None:
        return True
    gap = timedelta(minutes=30) if now - added < timedelta(hours=24) else timedelta(hours=6)
    return now - last >= gap


def classify_verify(read, code, now_iso):
    """The PATCH fields for one profile read ({found, private, bio, uid, error} or None). Pure."""
    if not read or read.get("error"):
        return {"status": "unavailable"}
    if not read.get("found"):
        return {"status": "not_found"}
    if bio_has_code(read.get("bio"), code):
        # Verified even when the account is private: the code is in the bio and the bio is readable.
        return {"status": "verified", "verified_at": now_iso, "platform_uid": str(read.get("uid") or "")[:64] or None}
    if read.get("private"):
        return {"status": "private"}
    return {"status": "code_not_found"}


def iso(dt):
    """A UTC timestamp PostgREST and Python both read."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def checkpoints(spec=None):
    """The days after posting at which a video's counts are re-read, ascending, from "1,3,7,30". Anything that is not a
    positive whole number is dropped."""
    out = set()
    for part in str(TRACK_CHECKPOINTS if spec is None else spec).split(","):
        try:
            d = int(part.strip())
        except ValueError:
            continue
        if d > 0:
            out.add(d)
    return sorted(out)


def age_days(posted_at, now):
    """Whole days between posting and `now`; 0 for an unknown or future date. This is a snapshot's `day`."""
    p = posted_at if isinstance(posted_at, datetime) else parse_ts(posted_at)
    if p is None:
        return 0
    return max(0, int((now - p).total_seconds() // 86400))


def next_measure_at(posted_at, now, cps=None):
    """When a video is next due a measurement: the first checkpoint after `now`, or None once the last has passed. An
    unknown posting date is checked again in an hour."""
    cps = checkpoints() if cps is None else cps
    p = posted_at if isinstance(posted_at, datetime) else parse_ts(posted_at)
    if p is None:
        return now + timedelta(hours=1)
    for d in cps:
        t = p + timedelta(days=d)
        if t > now:
            return t
    return None


def scan_due(p, now):
    """True when a profile row should be scanned now: verified, not `changed`, its platform is switched on, and it was
    last scanned longer ago than that platform's interval."""
    if not p.get("verified_at") or p.get("status") == "changed":
        return False
    plat = p.get("platform")
    if plat == "tiktok":
        if not TRACK_TT:
            return False
        hours = TRACK_TT_SCAN_H
    elif plat == "instagram":
        hours = TRACK_IG_SCAN_H
    else:
        return False
    last = parse_ts(p.get("last_scan_at"))
    return last is None or now - last >= timedelta(hours=hours)


def since_for(p, now):
    """Only videos posted after this are new: the profile's watermark, else the backfill horizon."""
    w = parse_ts(p.get("watermark_at"))
    return w if w is not None else now - timedelta(days=TRACK_BACKFILL_DAYS)


def follower_due(p, done_today, now):
    """True when a verified profile should have its follower count read now: tracked platform on, not `changed`, no
    snapshot yet for today's UTC date (`done_today` holds (creator_id, platform, handle) keys), and any earlier try
    today was long enough ago."""
    if not TRACK_FOLLOWERS or not p.get("verified_at") or p.get("status") == "changed":
        return False
    plat = p.get("platform")
    if plat == "tiktok":
        if not TRACK_TT:
            return False
    elif plat == "instagram":
        if not TRACK_IG_FOLLOWERS:
            return False
    else:
        return False
    if (p.get("creator_id"), plat, p.get("handle")) in done_today:
        return False
    last = parse_ts(p.get("followers_try_at"))
    return last is None or now - last >= timedelta(hours=TRACK_FOLLOW_RETRY_H)


def tt_entry_to_post(e):
    """One yt-dlp flat-playlist entry of a TikTok profile -> a post dict, or None. Counts are absent (None), never 0, when
    the entry has none; the listing's counts are rounded to the hundred (measured 2026-10-01)."""
    if not isinstance(e, dict) or not e.get("url"):
        return None
    url = str(e["url"])
    ts = e.get("timestamp")
    posted = None
    if isinstance(ts, (int, float)) and ts > 0:
        posted = iso(datetime.fromtimestamp(ts, tz=timezone.utc))
    try:
        video = float(e.get("duration") or 0) > 0
    except (TypeError, ValueError):
        video = False
    return {"url": url, "canonical_url": P.canon_url(url), "posted_at": posted,
            "views": count_or_none(e.get("view_count")), "likes": count_or_none(e.get("like_count")),
            "comments": count_or_none(e.get("comment_count")), "caption": str(e.get("description") or "")[:1000],
            "owner_uid": str(e.get("uploader_id") or ""), "owner_name": "", "video": video}


def ig_item_to_post(item):
    """One Apify instagram-scraper `posts` item -> a post dict, or None for a refusal (an `error` key) or an item with no
    link or no timestamp (an empty scan comes back as one such placeholder item, measured 2026-10-01).

    views = videoPlayCount (videoViewCount is about 4x lower and is only the fallback, P.apify_item_views);
    likes / comments are likesCount / commentsCount, absent when hidden (-1)."""
    if not isinstance(item, dict) or item.get("error") or not item.get("url") or not item.get("timestamp"):
        return None
    url = str(item["url"])
    return {"url": url, "canonical_url": P.canon_url(url), "posted_at": str(item["timestamp"]),
            "views": P.apify_item_views([item]), "likes": count_or_none(item.get("likesCount")),
            "comments": count_or_none(item.get("commentsCount")), "caption": str(item.get("caption") or "")[:1000],
            "owner_uid": str(item.get("ownerId") or ""), "owner_name": str(item.get("ownerUsername") or "").lower(),
            "video": item.get("type") == "Video" or item.get("productType") == "clips"}


def owner_mismatch(posts, uid, handle):
    """True when the listed videos belong to a different account than the one verified: none of them carries the
    recorded platform account number, and none carries the handle. A collaboration post owned by someone else, listed
    among the creator's own, does not trip it. False when nothing is known to compare."""
    uid = str(uid or "")
    owners = {x["owner_uid"] for x in posts if x.get("owner_uid")}
    if not uid or not owners:
        return False
    if uid in owners:
        return False
    names = {x["owner_name"] for x in posts if x.get("owner_name")}
    return str(handle or "").lower() not in names


def post_url_ok(url, platform):
    """A stored post link is only ever fetched when it is a plain https link on its own platform's host."""
    prefix = {"tiktok": "https://www.tiktok.com/", "instagram": "https://www.instagram.com/"}.get(platform)
    return bool(prefix) and str(url or "").startswith(prefix)


def merge_counts(*sources):
    """Only the counts that are present (not None), as a PATCH body fragment."""
    out = {}
    for src in sources:
        for k in ("views", "likes", "comments"):
            if src and src.get(k) is not None:
                out[k] = src[k]
    return out


# ── I/O (never raise) ────────────────────────────────────────────────────────────────────────────

def rest(key, path, method="GET", body=None, prefer=None):
    """(status, data) from a Supabase REST call. HTTPError -> (code, None); anything else -> (0, None)."""
    req = urllib.request.Request(P.SB_URL + path, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    if prefer:
        req.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(req, timeout=60, context=P.SSL_CTX) as r:
            raw = r.read()
            status = r.status
        return status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:  # noqa: BLE001
        return 0, None


def tt_profile_page(handle):
    """The public profile page HTML, or None (bad handle, network error, any non-200)."""
    if not good_handle(handle):
        return None
    try:
        req = urllib.request.Request(f"https://www.tiktok.com/@{handle}",
                                     headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
        with urllib.request.urlopen(req, timeout=20, context=P.SSL_CTX) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return None


def apify_room():
    """(spent this month, ceiling) off Apify's own ledger, cached for the process, or None if unknown."""
    if _ROOM["v"] is not False:
        return _ROOM["v"]
    room = None
    token = P.apify_token()
    if token:
        try:
            req = urllib.request.Request("https://api.apify.com/v2/users/me/limits")
            req.add_header("Authorization", f"Bearer {token}")
            with urllib.request.urlopen(req, timeout=15, context=P.SSL_CTX) as r:
                d = json.loads(r.read()).get("data") or {}
            current = float((d.get("current") or {}).get("monthlyUsageUsd") or 0)
            cap = (d.get("limits") or {}).get("maxMonthlyUsageUsd")
            ceiling = min(P.APIFY_MAX_MONTHLY_USD, float(cap)) if cap is not None else P.APIFY_MAX_MONTHLY_USD
            room = (current, ceiling)
        except Exception as e:  # noqa: BLE001
            log.info("apify limits check failed (%s)", str(e)[:80])
    _ROOM["v"] = room
    return room


def apify_ok():
    """True only when there is a token, the ledger is known, and spend is under (1 - reserve) x ceiling. Used by
    every paid call in this file: verification, Instagram scans, measurements and follower counts."""
    if not P.apify_token():
        return False
    room = apify_room()
    if room is None:
        return False
    current, ceiling = room
    # `current` was read once, at the first question of this process. Add what this process has spent since, so a
    # pass of many lookups cannot run past the guard on a stale number.
    current += APIFY_RESULTS * P.APIFY_PRICE_PER_LOOKUP_USD
    return current < (1 - TRACK_APIFY_RESERVE) * ceiling


def apify_run(body):
    """The dataset items of one synchronous run, or None. The token rides in a header, never the URL."""
    global APIFY_RESULTS
    token = P.apify_token()
    if not token:
        return None
    q = urllib.parse.urlencode({"timeout": 60, "maxTotalChargeUsd": TRACK_APIFY_MAX_CHARGE_USD, "format": "json"})
    try:
        req = urllib.request.Request(
            f"https://api.apify.com/v2/acts/{P.APIFY_VIEWS_ACTOR}/run-sync-get-dataset-items?{q}", method="POST")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
        with urllib.request.urlopen(req, timeout=75, context=P.SSL_CTX) as r:
            items = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        log.info("apify run failed: %s", str(e)[:80])
        return None
    if not isinstance(items, list):
        return None
    APIFY_RESULTS += len(items)
    return items


def ig_details(handle):
    """{found, private, bio, uid, followers} for an Instagram profile, or None when Apify did not answer.
    The same single `details` result serves verification (bio, uid) and the daily follower count."""
    if not good_handle(handle):
        return None
    items = apify_run({"directUrls": [f"https://www.instagram.com/{handle}/"], "resultsType": "details",
                       "resultsLimit": 1, "addParentData": False})
    if not items:
        return None
    item = items[0] if isinstance(items[0], dict) else {}
    if item.get("error"):
        return {"found": False, "private": False, "bio": "", "uid": None, "followers": None}
    if not item.get("id"):
        return None
    return {"found": True, "private": bool(item.get("private")), "bio": str(item.get("biography") or ""),
            "uid": str(item["id"]), "followers": count_or_none(item.get("followersCount"))}


TIER_RANK = {"max": 0, "pro": 1, "free": 2}
BUDGET_SKIPS = {"max": 0, "pro": 0, "free": 0}     # Instagram jobs skipped for budget this pass, by tier


def tier_of(key, uid, cache):
    """'max' | 'pro' | 'free' for a creator, cached for the pass. The service-only entitlement_for(uid); no row, an unknown
    plan code or any error is 'free' (the lowest priority, never an error that stops the lane)."""
    if uid in cache:
        return cache[uid]
    tier = "free"
    status, data = rest(key, "/rest/v1/rpc/entitlement_for", method="POST", body={"p_creator": uid})
    if status == 200:
        row = data[0] if isinstance(data, list) and data else data if isinstance(data, dict) else {}
        code = str((row or {}).get("plan_code") or "").lower()
        if code in TIER_RANK:
            tier = code
    cache[uid] = tier
    return tier


def by_tier(items, key, cache, creator=lambda r: r.get("creator_id")):
    """items sorted max -> pro -> free (stable: the order they came in is kept inside a tier)."""
    return sorted(items, key=lambda r: TIER_RANK[tier_of(key, creator(r), cache)])


def tier_allowed(tier, spent, ceiling):
    """Pure: may paid Instagram work run for this tier at this month's spend? max has no soft stop; pro stops at
    TRACK_IG_PRO_STOP x ceiling; free at TRACK_IG_FREE_STOP x ceiling."""
    stop = {"free": TRACK_IG_FREE_STOP, "pro": TRACK_IG_PRO_STOP}.get(tier)
    return stop is None or spent < stop * ceiling


def ig_gate(tier):
    """True when a paid Instagram call for a creator of this tier may run now: the 80% guard is open AND the tier's soft stop
    has not been reached. A refusal is counted in BUDGET_SKIPS."""
    ok = apify_ok()
    if ok:
        room = apify_room()
        if room is not None:
            current, ceiling = room
            ok = tier_allowed(tier, current + APIFY_RESULTS * P.APIFY_PRICE_PER_LOOKUP_USD, ceiling)
    if not ok:
        BUDGET_SKIPS[tier] = BUDGET_SKIPS.get(tier, 0) + 1
    return ok


def ytdlp_run(args, timeout):
    """(parsed json or None, stderr text). Quiet, no cache, no shell. The stderr is kept because yt-dlp says WHY it
    failed there, and one of its failures — a profile with nothing posted — is not a failure at all."""
    try:
        r = subprocess.run([P.yt_dlp_bin(), "-q", "--no-warnings", "--no-cache-dir", "--socket-timeout", "20", *args],
                           capture_output=True, text=True, timeout=timeout)
        err = (r.stderr or "")[:400]
        if r.returncode != 0 or not r.stdout.strip():
            return None, err
        d = json.loads(r.stdout)
        return (d if isinstance(d, dict) else None), err
    except Exception:  # noqa: BLE001
        return None, ""


def ytdlp_json(args, timeout):
    """yt-dlp's --dump-single-json for `args`, or None. Quiet, no cache, no shell."""
    return ytdlp_run(args, timeout)[0]


# yt-dlp ERRORS on a profile that exists but has posted nothing, so a brand-new creator who has done everything right
# looked exactly like an unreadable account. Measured 2026-10-07 on a real creator: verified on both platforms, code in
# her bio, 0 followers and 0 videos — recorded as a scan failure for a day. The phrase is yt-dlp's own.
TT_EMPTY_PROFILE = "does not have any videos posted"


def tt_list(handle):
    """The newest TikTok entries of a profile (a list, possibly empty), or None when yt-dlp could not read it."""
    if not good_handle(handle):
        return None
    d, err = ytdlp_run(["--flat-playlist", "--playlist-end", str(TRACK_TT_LIST_LIMIT), "--dump-single-json",
                        f"https://www.tiktok.com/@{handle}"], 90)
    if d is None:
        # A readable profile with nothing on it is an EMPTY list, not a failure: there is nothing wrong with the
        # creator or with us, and the next post will be picked up normally.
        return [] if TT_EMPTY_PROFILE in (err or "") else None
    entries = d.get("entries")
    return entries if isinstance(entries, list) else []


def ig_posts(handle, since):
    """The Instagram posts newer than `since` (a datetime), as Apify items, or None when the run failed or every item was
    a refusal (a private or missing profile). The boundary post itself comes back too, onlyPostsNewerThan being
    inclusive (measured 2026-10-01): the caller keeps only posts strictly newer."""
    if not good_handle(handle):
        return None
    items = apify_run({"directUrls": [f"https://www.instagram.com/{handle}/"], "resultsType": "posts",
                       "resultsLimit": TRACK_IG_LIST_LIMIT, "onlyPostsNewerThan": iso(since), "addParentData": False})
    if items is None:
        return None
    if items and all(isinstance(i, dict) and i.get("error") for i in items):
        return None
    return items


def measure(post):
    """{views, likes, comments} (each None when absent) for one stored post, or None when it could not be read (no count
    at all). TikTok is a free yt-dlp read of the one video (exact counts); Instagram is one Apify result."""
    plat, url = post.get("platform"), post.get("url")
    if not post_url_ok(url, plat):
        return None
    if plat == "tiktok":
        d = ytdlp_json(["--skip-download", "--no-playlist", "--dump-single-json", url], 90)
        if d is None:
            return None
        m = {"views": count_or_none(d.get("view_count")), "likes": count_or_none(d.get("like_count")),
             "comments": count_or_none(d.get("comment_count"))}
    elif plat == "instagram":
        items = apify_run({"directUrls": [url], "resultsType": "posts", "resultsLimit": 1, "addParentData": False})
        item = next((i for i in (items or []) if isinstance(i, dict) and not i.get("error")), None)
        if item is None:
            return None
        m = {"views": P.apify_item_views([item]), "likes": count_or_none(item.get("likesCount")),
             "comments": count_or_none(item.get("commentsCount"))}
    else:
        return None
    return m if any(m[k] is not None for k in ("views", "likes", "comments")) else None


def follower_read(platform, handle):
    """{uid, followers} for a verified profile, or None. TikTok: its public page (free). Instagram: one `details` result."""
    if platform == "tiktok":
        html = tt_profile_page(handle)
        r = parse_tt_page(html) if html else None
    elif platform == "instagram":
        r = ig_details(handle)
    else:
        return None
    if not r or r.get("error") or not r.get("found") or r.get("followers") is None:
        return None
    return {"uid": r.get("uid"), "followers": r["followers"]}


# ── the pass ──────────────────────────────────────────────────────────────────────────────────────

def verify_pass(key, now, dry=False, cache=None):
    """Check the profiles that are due, max accounts first. Returns {"checked", "verified", "skipped_budget"}."""
    stats = {"checked": 0, "verified": 0, "skipped_budget": 0}
    cache = {} if cache is None else cache
    status, rows = rest(
        key, "/rest/v1/lynxr_profiles?verified_at=is.null"
             "&select=creator_id,platform,handle,verify_code,verify_tries,check_requested_at,last_checked_at,added_at"
             "&order=check_requested_at.desc.nullslast,last_checked_at.asc.nullsfirst&limit=50")
    if status != 200 or not isinstance(rows, list):
        if status:
            log.info("track_posts: lynxr_profiles not readable (HTTP %s) — is supabase/profiles.sql applied?", status)
        return stats
    due = by_tier([r for r in rows if verify_due(r, now)], key, cache)[:TRACK_VERIFY_PER_PASS]
    for r in due:
        plat = r.get("platform")
        if dry:
            print(f"would check a {plat} profile (try {int(r.get('verify_tries') or 0) + 1})")
            continue
        if P.queued_work(key):
            break
        if plat == "tiktok":
            if not TRACK_TT:
                continue
            html = tt_profile_page(r.get("handle"))
            read = parse_tt_page(html) if html else None
        elif plat == "instagram":
            if not ig_gate(tier_of(key, r.get("creator_id"), cache)):
                stats["skipped_budget"] += 1
                continue
            read = ig_details(r.get("handle"))
        else:
            continue
        now_iso = now.isoformat().replace("+00:00", "Z")
        patch = {"verify_tries": int(r.get("verify_tries") or 0) + 1, "last_checked_at": now_iso,
                 "check_requested_at": None, **classify_verify(read, r.get("verify_code"), now_iso)}
        where = (f"/rest/v1/lynxr_profiles?creator_id=eq.{urllib.parse.quote(str(r.get('creator_id')), safe='')}"
                 f"&platform=eq.{urllib.parse.quote(str(plat), safe='')}"
                 f"&handle=eq.{urllib.parse.quote(str(r.get('handle')), safe='')}")
        code, _ = rest(key, where, method="PATCH", body=patch, prefer="return=minimal")
        if code == 409:
            # The partial unique index: another account verified this (platform, handle) first.
            patch.update({"status": "taken", "verified_at": None, "platform_uid": None})
            code, _ = rest(key, where, method="PATCH", body=patch, prefer="return=minimal")
        stats["checked"] += 1
        if patch.get("status") == "verified" and patch.get("verified_at"):
            stats["verified"] += 1
    return stats


# How many verified profiles a pass reads before choosing the ones to scan or count. At the current handful of profiles this
# is everything; past a couple of hundred verified profiles it would need a service-side query (and a tier lookup per creator
# is one entitlement_for call each, cached for the pass).
PROFILE_READ_LIMIT = 200


def q(v):
    return urllib.parse.quote(str(v), safe="")


def profile_where(r):
    return (f"/rest/v1/lynxr_profiles?creator_id=eq.{q(r.get('creator_id'))}"
            f"&platform=eq.{q(r.get('platform'))}&handle=eq.{q(r.get('handle'))}")


def scan_profile(key, r, now, stats):
    """Scan one verified profile of a tracked creator: list its newest videos, store the new ones with a day-0 snapshot,
    check the videos still belong to the verified account, refresh a TikTok profile's stored counts, move the watermark."""
    plat, handle, cid = r.get("platform"), r.get("handle"), r.get("creator_id")
    where = profile_where(r)
    now_iso = iso(now)
    since = since_for(r, now)
    if plat == "tiktok":
        entries = tt_list(handle)
        raw = None if entries is None else [tt_entry_to_post(e) for e in entries]
        stats["scanned_tt"] += 1
    else:
        items = ig_posts(handle, since)
        raw = None if items is None else [ig_item_to_post(i) for i in items]
        stats["scanned_ig"] += 1
    if raw is None:
        # DO NOT TOUCH `status` HERE. This lane only ever runs on a profile whose verified_at is set (see due_scan and
        # due_followers), so writing a scan outcome into `status` overwrites the VERIFICATION state with scan health —
        # and the app then tells a correctly verified creator that the platform "didn't answer". Scan health already
        # has its own columns: last_scan_at moves every attempt, last_scan_ok_at only on success, so a stale pair is
        # the signal. (The owner-mismatch branch below is different: that genuinely un-verifies the profile.)
        rest(key, where, method="PATCH", body={"last_scan_at": now_iso}, prefer="return=minimal")
        stats["scan_failed"] += 1
        return
    posts = [x for x in raw if x and x["video"]]
    if owner_mismatch(posts, r.get("platform_uid"), handle):
        # The username now belongs to someone else: store nothing, and ask for the code again.
        rest(key, where, method="PATCH", body={"status": "changed", "verified_at": None, "last_scan_at": now_iso},
             prefer="return=minimal")
        stats["scan_changed"] += 1
        return
    patch = {"last_scan_at": now_iso, "last_scan_ok_at": now_iso, "status": "verified"}
    if not r.get("platform_uid"):
        uid = next((x["owner_uid"] for x in posts if x["owner_uid"]), "")
        if uid:
            patch["platform_uid"] = uid[:64]
    new = []
    for x in posts:
        pt = parse_ts(x["posted_at"])
        if pt is not None and pt > since:        # strictly: Instagram's onlyPostsNewerThan includes the boundary post
            new.append(x)
    if new:
        body = []
        for x in new:
            nm = next_measure_at(x["posted_at"], now)
            body.append({"creator_id": cid, "platform": plat, "handle": handle, "origin": "tracked", "url": x["url"],
                         "canonical_url": x["canonical_url"], "caption": x["caption"] or None, "posted_at": x["posted_at"],
                         "views": x["views"], "likes": x["likes"], "comments": x["comments"], "metrics_at": now_iso,
                         "next_measure_at": iso(nm) if nm else None})
        code, ins = rest(key, "/rest/v1/lynxr_posts?on_conflict=creator_id,canonical_url", method="POST", body=body,
                         prefer="resolution=ignore-duplicates,return=representation")
        if code not in (200, 201) or not isinstance(ins, list):
            # Nothing stored: do not move the watermark past videos we failed to keep.
            rest(key, where, method="PATCH", body={"last_scan_at": now_iso}, prefer="return=minimal")
            stats["scan_failed"] += 1
            return
        by_url = {x["canonical_url"]: x for x in new}
        snaps = []
        for row in ins:
            x = by_url.get(row.get("canonical_url"))
            if x and row.get("id") is not None:
                snaps.append({"post_id": row["id"], "creator_id": cid, "day": age_days(x["posted_at"], now), "at": now_iso,
                              "views": x["views"], "likes": x["likes"], "comments": x["comments"]})
        if snaps:
            rest(key, "/rest/v1/lynxr_post_views?on_conflict=post_id,day", method="POST", body=snaps,
                 prefer="resolution=merge-duplicates,return=minimal")
        stats["new_posts"] += len(ins)
    if plat == "tiktok" and posts:
        # The free daily refresh: the listing's counts onto the stored posts. They only ever go up (the listing is rounded
        # to the hundred, and a snapshot's exact count must not be pulled down by it).
        st, stored = rest(key, f"/rest/v1/lynxr_posts?creator_id=eq.{q(cid)}&platform=eq.tiktok&handle=eq.{q(handle)}"
                               "&select=id,canonical_url,views,likes,comments&order=posted_at.desc.nullslast&limit=200")
        if st == 200 and isinstance(stored, list):
            listed = {x["canonical_url"]: x for x in posts}
            for sp in stored:
                x = listed.get(sp.get("canonical_url"))
                if not x:
                    continue
                grow = {k: x[k] for k in ("views", "likes", "comments") if x[k] is not None and (sp.get(k) is None or x[k] > sp[k])}
                if grow:
                    rest(key, f"/rest/v1/lynxr_posts?id=eq.{q(sp.get('id'))}", method="PATCH", body=grow, prefer="return=minimal")
    newest = max((parse_ts(x["posted_at"]) for x in posts if parse_ts(x["posted_at"])), default=None)
    old = parse_ts(r.get("watermark_at"))
    if newest is not None and (old is None or newest > old):
        patch["watermark_at"] = iso(newest)
    rest(key, where, method="PATCH", body=patch, prefer="return=minimal")


def scan_pass(key, now, dry=False, cache=None):
    """Scan the verified profiles that are due (every tier, max accounts first). Returns the counts."""
    stats = {"verified_profiles": 0, "scanned_tt": 0, "scanned_ig": 0, "scan_failed": 0, "scan_changed": 0,
             "new_posts": 0, "scan_skipped_budget": 0}
    cache = {} if cache is None else cache
    status, rows = rest(
        key, "/rest/v1/lynxr_profiles?verified_at=not.is.null"
             "&select=creator_id,platform,handle,platform_uid,status,verified_at,last_scan_at,watermark_at"
             f"&order=last_scan_at.asc.nullsfirst&limit={PROFILE_READ_LIMIT}")
    if status != 200 or not isinstance(rows, list):
        if status:
            log.info("track_posts: lynxr_profiles not readable for scanning (HTTP %s)", status)
        return stats
    stats["verified_profiles"] = len(rows)
    due = by_tier([r for r in rows if scan_due(r, now)], key, cache)[:TRACK_SCAN_PER_PASS]
    for r in due:
        if dry:
            print(f"would scan a {r.get('platform')} profile")
            continue
        if P.queued_work(key):
            break
        if r.get("platform") == "instagram" and not ig_gate(tier_of(key, r.get("creator_id"), cache)):
            stats["scan_skipped_budget"] += 1
            continue
        scan_profile(key, r, now, stats)
    return stats


def measure_pass(key, now, dry=False, cache=None):
    """Re-read the posts that have reached a checkpoint (every tier, max accounts first) and add a snapshot of their counts.
    Returns the counts."""
    stats = {"measured": 0, "measure_failed": 0, "measure_skipped_budget": 0}
    cache = {} if cache is None else cache
    status, rows = rest(
        key, f"/rest/v1/lynxr_posts?next_measure_at=lte.{q(iso(now))}"
             "&select=id,creator_id,platform,url,posted_at,measure_fails&order=next_measure_at.asc&limit=20")
    if status != 200 or not isinstance(rows, list):
        if status:
            log.info("track_posts: lynxr_posts not readable (HTTP %s) — is supabase/post_tracking.sql applied?", status)
        return stats
    live = by_tier(rows, key, cache)
    for r in live[:TRACK_MEASURE_PER_PASS]:
        if dry:
            print(f"would measure a {r.get('platform')} post")
            continue
        if P.queued_work(key):
            break
        if r.get("platform") == "instagram" and not ig_gate(tier_of(key, r.get("creator_id"), cache)):
            stats["measure_skipped_budget"] += 1
            continue
        got = measure(r)
        where = f"/rest/v1/lynxr_posts?id=eq.{q(r.get('id'))}"
        if got is None:
            fails = int(r.get("measure_fails") or 0) + 1
            if fails >= TRACK_MEASURE_MAX_FAILS:
                nm, fails = next_measure_at(r.get("posted_at"), now), 0     # give up on this checkpoint
            else:
                nm = now + timedelta(hours=TRACK_MEASURE_RETRY_H)
            rest(key, where, method="PATCH", body={"measure_fails": fails, "next_measure_at": iso(nm) if nm else None},
                 prefer="return=minimal")
            stats["measure_failed"] += 1
            continue
        posted = r.get("posted_at")
        nm = next_measure_at(posted, now)
        patch = {**merge_counts(got), "metrics_at": iso(now), "measure_fails": 0, "next_measure_at": iso(nm) if nm else None}
        rest(key, where, method="PATCH", body=patch, prefer="return=minimal")
        rest(key, "/rest/v1/lynxr_post_views?on_conflict=post_id,day", method="POST",
             body=[{"post_id": r["id"], "creator_id": r.get("creator_id"), "day": age_days(posted, now),
                    "at": iso(now), "views": got["views"], "likes": got["likes"], "comments": got["comments"]}],
             prefer="resolution=merge-duplicates,return=minimal")
        stats["measured"] += 1
    return stats


def followers_pass(key, now, dry=False, cache=None):
    """One follower-count snapshot per verified profile per UTC day (every tier, max accounts first). TikTok reads the
    public profile page (free); Instagram is one paid `details` result, behind the same budget guard as every Apify call.
    Reading the page or details also confirms the profile still belongs to the verified account. Returns the counts."""
    stats = {"followers": 0, "followers_failed": 0, "followers_changed": 0, "followers_skipped_budget": 0}
    if not TRACK_FOLLOWERS:
        return stats
    cache = {} if cache is None else cache
    status, rows = rest(
        key, "/rest/v1/lynxr_profiles?verified_at=not.is.null"
             "&select=creator_id,platform,handle,platform_uid,status,verified_at,followers_try_at"
             f"&limit={PROFILE_READ_LIMIT}")
    if status != 200 or not isinstance(rows, list):
        if status:
            log.info("track_posts: lynxr_profiles not readable for follower counts (HTTP %s) — are supabase/profiles.sql and supabase/post_tracking.sql applied?", status)
        return stats
    today = now.date().isoformat()
    st2, done = rest(key, f"/rest/v1/lynxr_profile_followers?day=eq.{today}&select=creator_id,platform,handle&limit=1000")
    done_today = {(d.get("creator_id"), d.get("platform"), d.get("handle")) for d in done} if st2 == 200 and isinstance(done, list) else set()
    due = by_tier([r for r in rows if follower_due(r, done_today, now)], key, cache)[:TRACK_FOLLOW_PER_PASS]
    now_iso = iso(now)
    for r in due:
        plat, handle, cid = r.get("platform"), r.get("handle"), r.get("creator_id")
        if dry:
            print(f"would read followers of a {plat} profile")
            continue
        if P.queued_work(key):
            break
        if plat == "instagram" and not ig_gate(tier_of(key, cid, cache)):
            stats["followers_skipped_budget"] += 1
            continue
        where = profile_where(r)
        read = follower_read(plat, handle)
        if read is None:
            rest(key, where, method="PATCH", body={"followers_try_at": now_iso}, prefer="return=minimal")
            stats["followers_failed"] += 1
            continue
        uid = str(read.get("uid") or "")
        if r.get("platform_uid") and uid and uid != str(r["platform_uid"]):
            rest(key, where, method="PATCH", body={"status": "changed", "verified_at": None, "followers_try_at": now_iso},
                 prefer="return=minimal")
            stats["followers_changed"] += 1
            continue
        code, _ = rest(key, "/rest/v1/lynxr_profile_followers?on_conflict=creator_id,platform,handle,day", method="POST",
                       body=[{"creator_id": cid, "platform": plat, "handle": handle, "day": today, "at": now_iso,
                              "followers": read["followers"]}],
                       prefer="resolution=merge-duplicates,return=minimal")
        rest(key, where, method="PATCH", body={"followers_try_at": now_iso}, prefer="return=minimal")
        if code in (200, 201, 204):
            stats["followers"] += 1
        else:
            stats["followers_failed"] += 1
    return stats


# ── MATCH: which lynxr script did this post come from ────────────────────────────────────────────────

POSTS = "/rest/v1/lynxr_posts"
MATCH_FIELDS = "id,creator_id,platform,handle,url,caption,posted_at,match_tries"


def match_due(key, now):
    """The tracked posts still to be matched, newest first: `pending` ones, then `failed` ones that are past their retry wait and
    under the try cap. Two separate reads, merged here (one PostgREST or= clause is easy to get wrong on the hot path). A 404 or a
    400 (PostgREST answers 400 for an unknown column) means supabase/post_match.sql is not applied: one INFO line and []."""
    horizon = q(iso(now - timedelta(days=MATCH_WINDOW_DAYS)))
    tail = (f"&adaptation_id=is.null&origin=eq.tracked&posted_at=gt.{horizon}&select={MATCH_FIELDS}"
            f"&order=posted_at.desc.nullslast&limit={TRACK_MATCH_PER_PASS * 4}")
    reads = (f"{POSTS}?match_state=eq.pending{tail}",
             f"{POSTS}?match_state=eq.failed&match_tries=lt.{TRACK_MATCH_MAX_FAILS}"
             f"&match_at=lt.{q(iso(now - timedelta(hours=TRACK_MATCH_RETRY_H)))}{tail}")
    out, seen = [], set()
    for path in reads:
        status, rows = rest(key, path)
        if status in (400, 404):
            log.info("match: lynxr_posts.match_state missing — is supabase/post_match.sql applied?")
            return []
        if status != 200 or not isinstance(rows, list):
            return out
        for r in rows:
            if isinstance(r, dict) and r.get("id") is not None and r["id"] not in seen:
                seen.add(r["id"])
                out.append(r)
    return out


def match_creator(key, cid, blobs):
    """What a creator's scripts look like to the matcher, cached for the pass: {"ads", "brands", "counts"}, or None when the
    database could not be read (a transient error: nothing is concluded from it)."""
    if cid in blobs:
        return blobs[cid]
    st, rows = rest(key, f"/rest/v1/lynxr_creators?id=eq.{q(cid)}&select=data")
    st2, linked = rest(key, f"{POSTS}?creator_id=eq.{q(cid)}&adaptation_id=not.is.null&select=adaptation_id&limit=1000")
    if st != 200 or not isinstance(rows, list) or st2 != 200 or not isinstance(linked, list):
        return None
    data = (rows[0].get("data") if rows and isinstance(rows[0], dict) else None) or {}
    blobs[cid] = {"ads": [a for a in (data.get("adaptations") or []) if isinstance(a, dict)],
                  "brands": [b for b in (data.get("brands") or []) if isinstance(b, dict)],
                  "counts": Counter(r.get("adaptation_id") for r in linked if isinstance(r, dict) and r.get("adaptation_id"))}
    return blobs[cid]


def match_evaluate(key, post, blobs):
    """The read / download / transcribe / score path for one post. Writes nothing. Returns a dict whose `kind` is one of
    unreadable (the database failed: record nothing), no_candidates, skipped, fetch_failed, too_long or scored; `scored` kind
    also carries `scored` ([(id, score, features)] best first), `decision` and `best`. The transcript lives in this function's
    locals and is gone when it returns."""
    cid = post.get("creator_id")
    blob = match_creator(key, cid, blobs)
    if blob is None:
        return {"kind": "unreadable"}
    posted = parse_ts(post.get("posted_at"))
    if posted is None or not M.candidates(blob["ads"], blob["counts"], posted, MATCH_WINDOW_DAYS, MATCH_PER_SCRIPT):
        # Candidates come first because they are free: no script in the window means nothing is downloaded.
        return {"kind": "no_candidates"}
    if not post_url_ok(post.get("url"), post.get("platform")):
        return {"kind": "skipped"}
    with tempfile.TemporaryDirectory() as td:
        media, _err = P.fetch_audio(post["url"], Path(td))      # no Apify fallback, by rule: a post yt-dlp cannot get is failed
        if not media:
            return {"kind": "fetch_failed"}
        dur = P.media_duration(media)
        if dur and dur > TRACK_MATCH_MAX_SEC:
            return {"kind": "too_long"}
        t = P.transcribe(str(media), P.WHISPER_MODEL)
        words, speech = (t.get("text") or ""), bool(t.get("has_speech"))
        scored, decision, best = M.rank(blob["ads"], blob["brands"], words, post.get("caption"), speech, posted, MATCH_CFG,
                                        blob["counts"])
        del t, words
    return {"kind": "scored", "scored": scored, "decision": decision, "best": best}


def match_log_row(post, decision, scored):
    """The lynxr_match_log row: numbers and script ids only. No transcript, no caption, not one word of either."""
    best = scored[0] if scored else None
    return {"post_id": post["id"], "creator_id": post["creator_id"], "decision": decision,
            "best_adaptation_id": best[0] if best else None, "best_score": best[1] if best else None,
            "second_score": scored[1][1] if len(scored) > 1 else (0.0 if best else None),
            "features": best[2] if best else {}, "candidates": [{"id": s[0], "score": s[1]} for s in scored[:5]]}


def match_one(key, post, now, stats, blobs):
    """Match one stored post and record the outcome. Never raises."""
    where = f"{POSTS}?id=eq.{q(post.get('id'))}"
    now_iso = iso(now)

    def state(s):
        return {"match_state": s, "match_at": now_iso, "match_tries": int(post.get("match_tries") or 0) + 1}

    try:
        r = match_evaluate(key, post, blobs)
        kind = r["kind"]
        if kind == "unreadable":
            return
        if kind == "fetch_failed":
            rest(key, where, method="PATCH", body=state("failed"), prefer="return=minimal")
            stats["match_failed"] += 1
            return
        if kind in ("skipped", "too_long"):
            rest(key, where, method="PATCH", body=state("skipped"), prefer="return=minimal")
            stats["match_skipped"] += 1
            return
        scored = r.get("scored") or []
        decision = r["decision"] if kind == "scored" else "none"
        if decision == "auto" and TRACK_MATCH_WRITE:
            # adaptation_id=is.null is load-bearing: a creator who linked this post by hand while the audio downloaded wins.
            st, got = rest(key, f"{where}&adaptation_id=is.null", method="PATCH",
                           body={"adaptation_id": r["best"], "script_linked_at": now_iso, **state("auto")},
                           prefer="return=representation")
            if st not in (200, 201, 204):
                stats["match_failed"] += 1
                return
            if isinstance(got, list) and not got:
                return                                  # the creator linked it first: nothing of ours to record
            blobs[post["creator_id"]]["counts"][r["best"]] += 1
            stats["matched"] += 1
        else:
            # Shadow mode scores and logs a would-be link but writes none: the post is parked as borderline, never as `auto`
            # without an adaptation_id (the log row keeps the real decision).
            st, _ = rest(key, where, method="PATCH", body=state("borderline" if decision == "auto" else decision),
                         prefer="return=minimal")
            if st not in (200, 201, 204):
                stats["match_failed"] += 1
                return
            stats["borderline" if decision in ("auto", "borderline") else "match_none"] += 1
        rest(key, "/rest/v1/lynxr_match_log", method="POST", body=match_log_row(post, decision, scored), prefer="return=minimal")
    except Exception as e:  # noqa: BLE001 -- a broken matcher must never stop the rest of the pass
        log.warning("match: one post failed (%s)", type(e).__name__)
        stats["match_failed"] += 1
        try:
            rest(key, where, method="PATCH", body=state("failed"), prefer="return=minimal")
        except Exception:  # noqa: BLE001
            pass


def match_pass(key, now, dry=False, cache=None):
    """Match the stored posts that are due, max accounts first. Returns the counts, or {} when the lane is off."""
    if not TRACK_MATCH:
        return {}
    stats = {"match_due": 0, "matched": 0, "borderline": 0, "match_none": 0, "match_failed": 0, "match_skipped": 0}
    cache = {} if cache is None else cache
    due = match_due(key, now)
    stats["match_due"] = len(due)
    if dry:
        return stats
    blobs, started = {}, time.monotonic()
    for post in by_tier(due, key, cache)[:TRACK_MATCH_PER_PASS]:
        if P.queued_work(key) or time.monotonic() - started >= TRACK_MATCH_BUDGET_S:
            break
        match_one(key, post, now, stats, blobs)
    log.info("match: due %d · auto %d · borderline %d · none %d · failed %d · skipped %d", stats["match_due"], stats["matched"],
             stats["borderline"], stats["match_none"], stats["match_failed"], stats["match_skipped"])
    return stats


def match_dry(key, post_id):
    """The whole match path for ONE stored post, printed. Reads the database, never writes it: no PATCH, no log row. Costs one
    free audio download and one local Whisper pass. Returns the exit code."""
    st, rows = rest(key, f"{POSTS}?id=eq.{q(post_id)}&select={MATCH_FIELDS}")
    if st != 200 or not isinstance(rows, list) or not rows:
        print(f"no such post (HTTP {st}), or lynxr_posts is not readable")
        return 2
    post = rows[0]
    r = match_evaluate(key, post, {})
    kind = r["kind"]
    if kind != "scored":
        print({"unreadable": "the creator's scripts could not be read",
               "no_candidates": "no candidate script: none is finished, branded, in the window and under its link cap (nothing would be downloaded)",
               "skipped": "the post link is not a plain https link on its own platform",
               "fetch_failed": "the audio could not be fetched",
               "too_long": f"longer than {TRACK_MATCH_MAX_SEC:.0f}s: skipped, not transcribed"}[kind])
        return 0 if kind in ("no_candidates", "too_long") else 1
    print("rank  id8       score  contain  recall  hook  brand  caption  days")
    for i, (aid, s, f) in enumerate(r["scored"], 1):
        print(f"{i:<5} {str(aid)[:8]:<9} {s:<6.3f} {f['containment']:<8.3f} {f['recall']:<7.3f} {f['hook']:<5} {f['brand']:<6} "
              f"{f['caption']:<8.3f} {f['days']:.0f}")
    print(f"decision: {r['decision']}" + (f"  {str(r['best'])[:8]}" if r["best"] else "") + "   (nothing was written)")
    return 0


def write_health(key, stats):
    """Best-effort: lynxr_ops 'track.health' = this pass's counts plus `at`, and `apify_closed_since` (the first pass that
    found the Apify spend guard closed, kept while it stays closed, cleared once it is open: the watchdog's
    tracking-budget alarm reads it)."""
    now_iso = P.now_iso()
    closed = None
    if stats.get("apify_ok") is False:
        closed = now_iso
        st, rows = rest(key, "/rest/v1/lynxr_ops?key=eq.track.health&select=value&limit=1")
        if st == 200 and isinstance(rows, list) and rows and isinstance(rows[0].get("value"), dict):
            closed = rows[0]["value"].get("apify_closed_since") or now_iso
    rest(key, "/rest/v1/lynxr_ops?on_conflict=key", method="POST",
         body={"key": "track.health", "value": {**stats, "at": now_iso, "apify_closed_since": closed}, "updated_at": now_iso},
         prefer="resolution=merge-duplicates")


def verify_dry(platform, handle, code, spend=False):
    """The REAL read and verdict for one profile, with no database access at all (nothing is read from or written to
    Supabase). TikTok is free. Instagram is one Apify `details` result (about $0.0027) and needs spend=True.
    Returns {"error": str} or {"read": {found, private, bio, uid, error} or None, "verdict": {...}}."""
    handle = str(handle or "").strip().lower().lstrip("@")
    if platform not in ("tiktok", "instagram"):
        return {"error": "platform must be tiktok or instagram"}
    if not good_handle(handle):
        return {"error": "that is not a valid username"}
    if platform == "tiktok":
        html = tt_profile_page(handle)
        read = parse_tt_page(html) if html else None
    else:
        if not spend:
            return {"error": "instagram costs one Apify result (about $0.0027): add --spend to run it"}
        if not apify_ok():
            return {"error": "no Apify token, or the account is past its spend guard"}
        read = ig_details(handle)
    return {"read": read, "verdict": classify_verify(read, code, P.now_iso())}


def print_verify_dry(platform, handle, code, spend=False):
    """verify_dry for a terminal: what was read, and whether the code is in the bio. Returns the exit code."""
    out = verify_dry(platform, handle, code, spend)
    if out.get("error"):
        print(out["error"])
        return 2
    read, verdict = out["read"], out["verdict"]
    if not read or read.get("error"):
        print(f"{platform} did not answer (blocked, offline or an unreadable page). Nothing to verify.")
        return 1
    print(f"found: {'yes' if read.get('found') else 'no'}")
    print(f"private: {'yes' if read.get('private') else 'no'}")
    print(f"platform user id: {read.get('uid')}")
    print(f"bio: {read.get('bio')!r}")
    print(f"code {code!r} in bio: {'yes' if bio_has_code(read.get('bio'), code) else 'no'}")
    print(f"verdict: {verdict['status']}")
    return 0 if verdict["status"] == "verified" else 1


def run(key, dry=False):
    cache = {}                                       # each creator's tier (entitlement_for), for this pass
    for t in BUDGET_SKIPS:
        BUDGET_SKIPS[t] = 0
    v = verify_pass(key, datetime.now(timezone.utc), dry=dry, cache=cache)
    sc = scan_pass(key, datetime.now(timezone.utc), dry=dry, cache=cache)
    m = measure_pass(key, datetime.now(timezone.utc), dry=dry, cache=cache)
    f = followers_pass(key, datetime.now(timezone.utc), dry=dry, cache=cache)
    shw = {}
    try:
        import showcase as SHOWCASE_LANE              # local import: pass THIS module in, see showcase.py's docstring
        shw = SHOWCASE_LANE.showcase_pass(key, datetime.now(timezone.utc), dry=dry, T=sys.modules[__name__])
    except Exception as e:  # noqa: BLE001
        log.warning("showcase pass failed: %s", str(e)[:120])
    mt = {}
    try:
        mt = match_pass(key, datetime.now(timezone.utc), dry=dry, cache=cache)       # LAST: the slow lane never delays the rest
    except Exception as e:  # noqa: BLE001
        log.warning("match pass failed: %s", str(e)[:120])
    ins = {}
    try:
        import insights as INSIGHTS_LANE             # local import: pass THIS module in, see insights.py's docstring
        ins = INSIGHTS_LANE.insights_pass(key, datetime.now(timezone.utc), dry=dry, T=sys.modules[__name__])
    except Exception as e:  # noqa: BLE001
        log.warning("insights pass failed: %s", str(e)[:120])
    br = {}
    try:
        import brain as BRAIN_LANE                   # local import: pass THIS module in, see brain.py's docstring
        br = BRAIN_LANE.brain_pass(key, datetime.now(timezone.utc), dry=dry, T=sys.modules[__name__])
    except Exception as e:  # noqa: BLE001
        log.warning("brain pass failed: %s", str(e)[:120])
    stats = {**v, **sc, **m, **f, "budget_skips": dict(BUDGET_SKIPS), "showcase": shw, "match": mt, "insights": ins, "brain": br}
    n = APIFY_RESULTS
    log.info("track_posts: verify %d (verified %d, budget-skipped %d) · scan tt %d ig %d (new %d, failed %d, changed %d) · "
             "measure %d (failed %d) · followers %d (failed %d) · budget skips max %d pro %d free %d · apify ~%d results (~$%.4f)",
             v["checked"], v["verified"], v["skipped_budget"], sc["scanned_tt"], sc["scanned_ig"], sc["new_posts"],
             sc["scan_failed"], sc["scan_changed"] + f["followers_changed"], m["measured"], m["measure_failed"],
             f["followers"], f["followers_failed"], BUDGET_SKIPS["max"], BUDGET_SKIPS["pro"], BUDGET_SKIPS["free"],
             n, n * P.APIFY_PRICE_PER_LOOKUP_USD)
    if not dry:
        stats["apify_ok"] = apify_ok()
        write_health(key, stats)
    return stats


def main():
    envcfg.sanitize_environ()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="read-only: list what is due; fetches nothing and writes nothing")
    ap.add_argument("--verify-dry", nargs=3, metavar=("PLATFORM", "HANDLE", "CODE"),
                    help="run the REAL bio check for one profile from this machine, with no database access: "
                         "prints what was read and whether CODE is in the bio")
    ap.add_argument("--spend", action="store_true",
                    help="with --verify-dry instagram: allow the one Apify result it costs (about $0.0027)")
    ap.add_argument("--match-dry", type=int, metavar="POST_ID",
                    help="the whole script-match path for one stored post (lynxr_posts.id): prints the candidate table and the "
                         "decision. Reads the database but NEVER writes it (no link, no log row). Costs one free audio "
                         "download and one local Whisper pass")
    args = ap.parse_args()
    if args.verify_dry:
        sys.exit(print_verify_dry(*args.verify_dry, spend=args.spend))
    env = P.load_env(P.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"),
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
    if args.match_dry is not None:
        sys.exit(match_dry(key, args.match_dry))
    stats = run(key, dry=args.dry_run)
    if args.dry_run:
        print(f"verify {stats['checked']} · scan tt {stats['scanned_tt']} ig {stats['scanned_ig']} · "
              f"measure {stats['measured']} · followers {stats['followers']}")


if __name__ == "__main__":
    main()
