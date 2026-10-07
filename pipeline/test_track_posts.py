"""Offline checks for pipeline/track_posts.py. Same check()/FAILS style as pipeline/test_brief_clips.py.
No Supabase, no TikTok, no Apify: every I/O helper is replaced.

Run with

    ./venv/bin/python pipeline/test_track_posts.py
"""
import json
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import track_posts as T  # noqa: E402

# The real I/O helpers, kept before the tests below replace them with stubs.
REAL_SCAN_PROFILE = T.scan_profile
REAL = {n: getattr(T, n) for n in ("ig_details", "tt_profile_page", "measure", "tt_list", "ig_posts", "follower_read",
                                     "apify_ok", "tier_of", "apify_run", "ytdlp_json", "rest")}

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


NOW = datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc)


def ago(**kw):
    return (NOW - timedelta(**kw)).isoformat().replace("+00:00", "Z")


# good_handle
check("handle: a.b_c", T.good_handle("a.b_c"), True)
check("handle: space", T.good_handle("a b"), False)
check("handle: leading dash", T.good_handle("-x"), False)
check("handle: path", T.good_handle("../x"), False)
check("handle: empty", T.good_handle(""), False)
check("handle: 31 chars", T.good_handle("a" * 31), False)
check("handle: 30 chars", T.good_handle("a" * 30), True)

# bio_has_code
check("bio: found", T.bio_has_code("hi lynxr-ab12cd there", "lynxr-ab12cd"), True)
check("bio: case-insensitive", T.bio_has_code("HI LYNXR-AB12CD", "lynxr-ab12cd"), True)
check("bio: absent", T.bio_has_code("hello", "lynxr-ab12cd"), False)
check("bio: empty bio", T.bio_has_code("", "lynxr-ab12cd"), False)
check("bio: empty code", T.bio_has_code("anything", ""), False)
check("bio: None", T.bio_has_code(None, None), False)


# parse_tt_page
def page(detail):
    blob = json.dumps({"__DEFAULT_SCOPE__": {"webapp.user-detail": detail}})
    return f'<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{blob}</script></html>'


found = T.parse_tt_page(page({"statusCode": 0, "userInfo": {"user": {"id": 107955, "signature": "bio lynxr-ab12cd", "privateAccount": False}}}))
check("tt page: found", (found["found"], found["private"], found["bio"], found["uid"], found["error"]),
      (True, False, "bio lynxr-ab12cd", "107955", False))
priv = T.parse_tt_page(page({"statusCode": 0, "userInfo": {"user": {"id": "9", "signature": "", "privateAccount": True}}}))
check("tt page: private", (priv["found"], priv["private"]), (True, True))
gone = T.parse_tt_page(page({"statusCode": 10221, "userInfo": {}}))
check("tt page: 10221 is not found, and not an error", (gone["found"], gone["error"]), (False, False))
secret = T.parse_tt_page(page({"statusCode": 10222, "statusMsg": "ErrBizUserSecret", "userInfo": {"user": {"id": "744", "signature": "", "privateAccount": True}}}))
check("tt page: private (10222) is found + private", (secret["found"], secret["private"], secret["uid"], secret["error"]), (True, True, "744", False))
check("tt page: private (10222) classifies as private", T.classify_verify(secret, "lynxr-ab12cd", "t")["status"], "private")
junk = T.parse_tt_page("<html>captcha</html>")
check("tt page: garbage is an error", (junk["found"], junk["error"]), (False, True))
check("tt page: None is an error", T.parse_tt_page(None)["error"], True)
check("tt page: broken json is an error",
      T.parse_tt_page('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="x">{nope</script>')["error"], True)

# verify_due
ig = {"platform": "instagram", "verified_at": None, "verify_tries": 0, "added_at": ago(minutes=5)}
check("due: IG with no request", T.verify_due(ig, NOW), False)
check("due: IG with a request", T.verify_due({**ig, "check_requested_at": ago(minutes=1)}, NOW), True)
check("due: IG at the cap", T.verify_due({**ig, "check_requested_at": ago(minutes=1), "verify_tries": T.TRACK_IG_VERIFY_TRIES}, NOW), False)
tt = {"platform": "tiktok", "verified_at": None, "verify_tries": 0}
check("due: TT 10 minutes old, never checked", T.verify_due({**tt, "added_at": ago(minutes=10)}, NOW), True)
check("due: TT 2 hours old, checked 10 minutes ago",
      T.verify_due({**tt, "added_at": ago(hours=2), "last_checked_at": ago(minutes=10)}, NOW), False)
check("due: TT 2 hours old, checked 31 minutes ago",
      T.verify_due({**tt, "added_at": ago(hours=2), "last_checked_at": ago(minutes=31)}, NOW), True)
check("due: TT 2 days old, checked 3 hours ago",
      T.verify_due({**tt, "added_at": ago(days=2), "last_checked_at": ago(hours=3)}, NOW), False)
check("due: TT 2 days old, checked 7 hours ago",
      T.verify_due({**tt, "added_at": ago(days=2), "last_checked_at": ago(hours=7)}, NOW), True)
check("due: TT 8 days old", T.verify_due({**tt, "added_at": ago(days=8)}, NOW), False)
check("due: TT 8 days old but the creator pressed Check",
      T.verify_due({**tt, "added_at": ago(days=8), "check_requested_at": ago(minutes=1)}, NOW), True)
check("due: verified is never due", T.verify_due({**tt, "added_at": ago(minutes=10), "verified_at": ago(minutes=1)}, NOW), False)
check("due: fractional-second timestamps parse",
      T.verify_due({**tt, "added_at": "2026-10-01T11:50:00.123+00:00"}, NOW), True)
T.TRACK_TT = False
check("due: TRACK_TT off", T.verify_due({**tt, "added_at": ago(minutes=10)}, NOW), False)
T.TRACK_TT = True

# classify_verify
iso = "2026-10-01T12:00:00Z"
rd = {"found": True, "private": False, "bio": "x lynxr-ab12cd", "uid": "42"}
check("classify: None", T.classify_verify(None, "lynxr-ab12cd", iso), {"status": "unavailable"})
check("classify: error", T.classify_verify({"error": True}, "lynxr-ab12cd", iso), {"status": "unavailable"})
check("classify: not found", T.classify_verify({"found": False}, "lynxr-ab12cd", iso), {"status": "not_found"})
check("classify: verified", T.classify_verify(rd, "lynxr-ab12cd", iso),
      {"status": "verified", "verified_at": iso, "platform_uid": "42"})
check("classify: verified even if private", T.classify_verify({**rd, "private": True}, "lynxr-ab12cd", iso)["status"], "verified")
check("classify: private, no code", T.classify_verify({**rd, "bio": "", "private": True}, "lynxr-ab12cd", iso), {"status": "private"})
check("classify: code not found", T.classify_verify({**rd, "bio": "nope"}, "lynxr-ab12cd", iso), {"status": "code_not_found"})


# the handle guard: a bad handle never reaches the network
def boom(*a, **k):
    raise AssertionError("urlopen must not be called")


_real_urlopen = urllib.request.urlopen
urllib.request.urlopen = boom
try:
    check("guard: tt_profile_page('../x') is None and makes no request", T.tt_profile_page("../x"), None)
    check("guard: ig_details('a b') is None and makes no request", T.ig_details("a b"), None)
finally:
    urllib.request.urlopen = _real_urlopen

# verify_pass, against a fake REST layer
ROW_TT = {"creator_id": "c1", "platform": "tiktok", "handle": "a.b", "verify_code": "lynxr-ab12cd", "verify_tries": 0,
          "check_requested_at": None, "last_checked_at": None, "added_at": ago(minutes=10)}
ROW_IG = {**ROW_TT, "platform": "instagram", "check_requested_at": ago(minutes=1)}


class Fake:
    def __init__(self, rows, patch_codes=(204,)):
        self.rows, self.patches, self.codes = rows, [], list(patch_codes)

    def rest(self, key, path, method="GET", body=None, prefer=None):
        if method == "GET":
            return 200, self.rows
        self.patches.append((path, body))
        return (self.codes.pop(0) if self.codes else 204), None


def run_pass(rows, *, queued=False, apify=True, read=None, codes=(204,), tier="max", tiers=None, spent=0.0):
    f = Fake(rows, codes)
    T.rest = f.rest
    T.tier_of = lambda key, uid, cache: (tiers or {}).get(uid, tier)
    T._ROOM["v"] = (spent, 5.0)
    T.P.queued_work = lambda key: queued
    T.apify_ok = lambda: apify
    T.tt_profile_page = lambda h: page({"statusCode": 0, "userInfo": {"user": {"id": 7, "signature": "lynxr-ab12cd"}}})
    T.ig_details = lambda h: read
    return f, T.verify_pass("k", NOW)


f, s = run_pass([ROW_TT])
check("pass: TikTok verified", (s, len(f.patches), f.patches[0][1]["status"], f.patches[0][1]["verify_tries"],
                                f.patches[0][1]["check_requested_at"], f.patches[0][1]["platform_uid"]),
      ({"checked": 1, "verified": 1, "skipped_budget": 0}, 1, "verified", 1, None, "7"))
check("pass: the PATCH targets exactly one row", "creator_id=eq.c1&platform=eq.tiktok&handle=eq.a.b" in f.patches[0][0], True)

f, s = run_pass([ROW_IG], apify=False)
check("budget: apify_ok False -> no PATCH, skipped_budget 1", (len(f.patches), s["skipped_budget"], s["checked"]), (0, 1, 0))

f, s = run_pass([ROW_IG], read={"found": True, "private": False, "bio": "hi lynxr-ab12cd", "uid": "99"})
check("pass: Instagram verified through details", (s["verified"], f.patches[0][1]["platform_uid"]), (1, "99"))

f, s = run_pass([ROW_TT, ROW_IG], queued=True)
check("yield: queued_work True -> no PATCH", (len(f.patches), s["checked"]), (0, 0))

f, s = run_pass([ROW_TT], codes=(409, 204))
check("409 -> taken, second PATCH", (len(f.patches), f.patches[1][1]["status"], f.patches[1][1]["verified_at"],
                                      f.patches[1][1]["platform_uid"], s["verified"]), (2, "taken", None, None, 0))

f, s = run_pass([{**ROW_TT, "added_at": ago(days=9)}])
check("pass: nothing due -> nothing done", (len(f.patches), s["checked"]), (0, 0))

T.TRACK_VERIFY_PER_PASS = 2
f, s = run_pass([ROW_TT, {**ROW_TT, "handle": "b"}, {**ROW_TT, "handle": "c"}])
check("pass: at most TRACK_VERIFY_PER_PASS per pass", s["checked"], 2)

# verify_dry: the real logic, fetchers replaced, no database in sight
T.tt_profile_page = lambda h: page({"statusCode": 0, "userInfo": {"user": {"id": 5, "signature": "hi lynxr-ab12cd", "privateAccount": False}}})
d = T.verify_dry("tiktok", "@Some.Name", "lynxr-ab12cd")
check("dry tiktok: verified", (d["verdict"]["status"], d["read"]["uid"], d["read"]["bio"]), ("verified", "5", "hi lynxr-ab12cd"))
check("dry tiktok: wrong code", T.verify_dry("tiktok", "x", "lynxr-zzzzzz")["verdict"]["status"], "code_not_found")
T.tt_profile_page = lambda h: None
check("dry tiktok: no answer", T.verify_dry("tiktok", "x", "c")["verdict"]["status"], "unavailable")
check("dry: bad handle", "error" in T.verify_dry("tiktok", "../x", "c"), True)
check("dry: bad platform", "error" in T.verify_dry("youtube", "x", "c"), True)
calls = []
T.ig_details = lambda h: calls.append(h) or {"found": True, "private": False, "bio": "lynxr-ab12cd", "uid": "9"}
check("dry instagram: refuses without --spend", ("error" in T.verify_dry("instagram", "x", "c"), calls), (True, []))
T.apify_ok = lambda: True
check("dry instagram: --spend runs it", (T.verify_dry("instagram", "x", "lynxr-ab12cd", spend=True)["verdict"]["status"], calls), ("verified", ["x"]))


# ═══════════════════════════════════════════════════════════════════════════════════════════════
# PHASE B: scan, measure and followers (every tier since 2026-10-03)
# ═══════════════════════════════════════════════════════════════════════════════════════════════

# count_or_none: absent is None, never zero; a hidden count (-1) is absent too
check("count: first present", T.count_or_none(None, "96000317"), 96000317)
check("count: zero is a real zero", T.count_or_none(0), 0)
check("count: -1 (hidden) is absent", T.count_or_none(-1), None)
check("count: junk is absent", T.count_or_none("x", None), None)
check("count: bool is not a count", T.count_or_none(True), None)

# TikTok followers: statsV2 is exact, stats is the rounded fallback
fp = T.parse_tt_page(page({"statusCode": 0, "userInfo": {"user": {"id": 7, "signature": "x"},
                                                            "stats": {"followerCount": 96000000},
                                                            "statsV2": {"followerCount": "96000317"}}}))
check("tt page: followers prefer exact statsV2", fp["followers"], 96000317)
fp2 = T.parse_tt_page(page({"statusCode": 0, "userInfo": {"user": {"id": 7}, "stats": {"followerCount": 5400}}}))
check("tt page: followers fall back to stats", fp2["followers"], 5400)
fp3 = T.parse_tt_page(page({"statusCode": 0, "userInfo": {"user": {"id": 7}}}))
check("tt page: no stats -> followers None", fp3["followers"], None)
check("tt page: garbage -> followers None", T.parse_tt_page("nope")["followers"], None)

# Instagram followers ride on the details result
T.ig_details = REAL["ig_details"]
T.apify_run = lambda body: [{"id": 25025320, "biography": "b", "private": False, "followersCount": 12345}]
check("ig details: followers", T.ig_details("x")["followers"], 12345)
T.apify_run = lambda body: [{"id": 1, "biography": "b", "followersCount": -1}]
check("ig details: hidden followers -> None", T.ig_details("x")["followers"], None)
T.apify_run = lambda body: [{"error": "not_found"}]
check("ig details: error item -> not found, no followers", (T.ig_details("x")["found"], T.ig_details("x")["followers"]), (False, None))

# checkpoints / age_days / next_measure_at
check("checkpoints: junk, dupes and negatives dropped", T.checkpoints("7,1,x,1,-3"), [1, 7])
check("checkpoints: default", T.checkpoints(), [1, 3, 7, 30])
check("age_days: 2.5 days", T.age_days(ago(days=2, hours=12), NOW), 2)
check("age_days: just posted", T.age_days(ago(minutes=5), NOW), 0)
check("age_days: future date is 0", T.age_days("2026-10-02T00:00:00Z", NOW), 0)
check("age_days: unknown is 0", T.age_days(None, NOW), 0)
check("age_days: exactly 7 days", T.age_days(ago(days=7), NOW), 7)
check("next: posted 2h ago -> +1 day", T.next_measure_at(ago(hours=2), NOW), NOW - timedelta(hours=2) + timedelta(days=1))
check("next: posted 2 days ago -> +3 days", T.next_measure_at(ago(days=2), NOW), NOW - timedelta(days=2) + timedelta(days=3))
check("next: posted 40 days ago -> None", T.next_measure_at(ago(days=40), NOW), None)
check("next: unknown date -> +1h", T.next_measure_at(None, NOW), NOW + timedelta(hours=1))
check("next: exactly at a checkpoint moves to the next", T.next_measure_at(ago(days=3), NOW), NOW - timedelta(days=3) + timedelta(days=7))

# scan_due / since_for / follower_due
vt = {"platform": "tiktok", "verified_at": ago(days=1), "status": "verified", "last_scan_at": None}
check("scan_due: never scanned", T.scan_due(vt, NOW), True)
check("scan_due: scanned 2h ago", T.scan_due({**vt, "last_scan_at": ago(hours=2)}, NOW), False)
check("scan_due: scanned 25h ago", T.scan_due({**vt, "last_scan_at": ago(hours=25)}, NOW), True)
check("scan_due: unverified", T.scan_due({**vt, "verified_at": None}, NOW), False)
check("scan_due: changed", T.scan_due({**vt, "status": "changed"}, NOW), False)
check("scan_due: Instagram due", T.scan_due({**vt, "platform": "instagram"}, NOW), True)
check("scan_due: unknown platform", T.scan_due({**vt, "platform": "youtube"}, NOW), False)
T.TRACK_TT = False
check("scan_due: TRACK_TT off", T.scan_due(vt, NOW), False)
T.TRACK_TT = True
check("since: watermark wins", T.since_for({"watermark_at": ago(days=2)}, NOW), NOW - timedelta(days=2))
check("since: no watermark -> backfill", T.since_for({}, NOW), NOW - timedelta(days=T.TRACK_BACKFILL_DAYS))

fv = {"creator_id": "c1", "platform": "tiktok", "handle": "a", "verified_at": ago(days=1), "status": "verified", "followers_try_at": None}
check("follower_due: none today", T.follower_due(fv, set(), NOW), True)
check("follower_due: already has today's snapshot", T.follower_due(fv, {("c1", "tiktok", "a")}, NOW), False)
check("follower_due: tried 1h ago and failed", T.follower_due({**fv, "followers_try_at": ago(hours=1)}, set(), NOW), False)
check("follower_due: tried 7h ago", T.follower_due({**fv, "followers_try_at": ago(hours=7)}, set(), NOW), True)
check("follower_due: changed", T.follower_due({**fv, "status": "changed"}, set(), NOW), False)
check("follower_due: unverified", T.follower_due({**fv, "verified_at": None}, set(), NOW), False)
T.TRACK_IG_FOLLOWERS = False
check("follower_due: Instagram follower counts switched off", T.follower_due({**fv, "platform": "instagram"}, set(), NOW), False)
check("follower_due: TikTok unaffected by the Instagram switch", T.follower_due(fv, set(), NOW), True)
T.TRACK_IG_FOLLOWERS = True
T.TRACK_FOLLOWERS = False
check("follower_due: master switch off", T.follower_due(fv, set(), NOW), False)
T.TRACK_FOLLOWERS = True

# the mappers
tte = {"url": "https://www.tiktok.com/@a/video/1", "timestamp": 1790805450, "view_count": 103800, "like_count": 1925,
       "comment_count": 483, "duration": 88, "uploader_id": "107955", "description": "x" * 2000}
m = T.tt_entry_to_post(tte)
check("tt entry: counts, owner, video", (m["views"], m["likes"], m["comments"], m["owner_uid"], m["video"]), (103800, 1925, 483, "107955", True))
check("tt entry: posted_at is UTC ISO", m["posted_at"], "2026-09-30T21:57:30Z")
check("tt entry: caption cut to 1000", len(m["caption"]), 1000)
check("tt entry: canonical url", m["canonical_url"], "tiktok.com/@a/video/1")
check("tt entry: no counts -> None not 0", (lambda x: (x["views"], x["likes"], x["comments"]))(T.tt_entry_to_post({"url": "https://www.tiktok.com/@a/video/2", "duration": 5})), (None, None, None))
check("tt entry: photo post (no duration) is not a video", T.tt_entry_to_post({"url": "https://www.tiktok.com/@a/photo/3"})["video"], False)
check("tt entry: no url -> None", T.tt_entry_to_post({"id": "1"}), None)
check("tt entry: not a dict -> None", T.tt_entry_to_post("x"), None)

igi = {"type": "Video", "productType": "clips", "url": "https://www.instagram.com/reel/AAA/", "timestamp": "2026-09-30T19:04:54.000Z",
       "videoPlayCount": 4000, "videoViewCount": 1000, "likesCount": 55, "commentsCount": 7, "caption": "hi",
       "ownerId": "25025320", "ownerUsername": "Some.One"}
g = T.ig_item_to_post(igi)
check("ig item: views are the PLAY count, likes, comments", (g["views"], g["likes"], g["comments"]), (4000, 55, 7))
check("ig item: owner", (g["owner_uid"], g["owner_name"], g["video"]), ("25025320", "some.one", True))
check("ig item: hidden likes -> None", T.ig_item_to_post({**igi, "likesCount": -1})["likes"], None)
check("ig item: falls back to videoViewCount", T.ig_item_to_post({**{k: v for k, v in igi.items() if k != "videoPlayCount"}})["views"], 1000)
check("ig item: placeholder (no timestamp) -> None", T.ig_item_to_post({"inputUrl": "https://www.instagram.com/x/"}), None)
check("ig item: error -> None", T.ig_item_to_post({"error": "not_found", "url": "u", "timestamp": "t"}), None)
check("ig item: a photo is not a video", T.ig_item_to_post({**igi, "type": "Image", "productType": "feed"})["video"], False)

# owner_mismatch
mp = lambda uid, name="": {"owner_uid": uid, "owner_name": name}
check("owner: matching uid", T.owner_mismatch([mp("1")], "1", "h"), False)
check("owner: all different uid, different name", T.owner_mismatch([mp("2", "z"), mp("2", "z")], "1", "h"), True)
check("owner: one collab post among own", T.owner_mismatch([mp("2", "z"), mp("1")], "1", "h"), False)
check("owner: different uid but same handle", T.owner_mismatch([mp("2", "h")], "1", "h"), False)
check("owner: no recorded uid -> nothing to compare", T.owner_mismatch([mp("2")], "", "h"), False)
check("owner: no posts", T.owner_mismatch([], "1", "h"), False)

check("post_url_ok: tiktok", T.post_url_ok("https://www.tiktok.com/@a/video/1", "tiktok"), True)
check("post_url_ok: wrong host for platform", T.post_url_ok("https://evil.example/x", "tiktok"), False)
check("post_url_ok: file scheme", T.post_url_ok("file:///etc/passwd", "instagram"), False)
check("post_url_ok: unknown platform", T.post_url_ok("https://www.tiktok.com/", "youtube"), False)
check("merge_counts: only present counts", T.merge_counts({"views": 5, "likes": None, "comments": 0}), {"views": 5, "comments": 0})

# the spend guard counts this process's own results
T.apify_ok = REAL["apify_ok"]
T.P.apify_token = lambda: "tok"
T._ROOM["v"] = (3.50, 5.0)                    # 3.50 of 5.00 spent; the ceiling for this lane is 80% = 4.00
T.APIFY_RESULTS = 0
check("apify_ok: under the guard", T.apify_ok(), True)
T.APIFY_RESULTS = 200                         # 200 x 0.0027 = 0.54 more -> 4.04 >= 4.00
check("apify_ok: this process's own results count", T.apify_ok(), False)
T.APIFY_RESULTS = 0
T._ROOM["v"] = None
check("apify_ok: ledger unknown -> closed", T.apify_ok(), False)
T._ROOM["v"] = (0.0, 5.0)

# tt_list: a profile with nothing posted is EMPTY, not unreadable.
# yt-dlp exits non-zero and says so on stderr; before 2026-10-07 that was indistinguishable from a blocked read, and a
# verified creator who simply had not posted yet was recorded as a scan failure.
_REAL_RUN = T.ytdlp_run
T.ytdlp_run = lambda args, timeout: (None, "ERROR: [tiktok:user] newbie: This account does not have any videos posted")
check("tt_list: nothing posted -> [] not None", T.tt_list("newbie"), [])
T.ytdlp_run = lambda args, timeout: (None, "ERROR: [tiktok:user] x: Unable to download webpage: HTTP Error 403")
check("tt_list: a blocked read is still None", T.tt_list("blocked"), None)
T.ytdlp_run = lambda args, timeout: (None, "")
check("tt_list: no stderr at all is still None", T.tt_list("quiet"), None)
T.ytdlp_run = lambda args, timeout: ({"entries": [{"id": "1"}]}, "")
check("tt_list: entries pass through", T.tt_list("ok"), [{"id": "1"}])
T.ytdlp_run = _REAL_RUN

# the handle guard on the new fetchers: no subprocess, no request
import subprocess as _sp
_real_run = _sp.run
_sp.run = lambda *a, **k: (_ for _ in ()).throw(AssertionError("subprocess must not run"))
T.tt_list, T.ig_posts, T.measure = REAL["tt_list"], REAL["ig_posts"], REAL["measure"]
try:
    check("guard: tt_list('../x') is None and runs nothing", T.tt_list("../x"), None)
    check("guard: ig_posts('a b') is None", T.ig_posts("a b", NOW), None)
    check("guard: measure with a foreign url runs nothing", T.measure({"platform": "tiktok", "url": "https://evil.example/x"}), None)
finally:
    _sp.run = _real_run


# ── the passes, against a routed fake REST layer ──
class Rest:
    """Records every call; GETs and rpc answer from `routes`, matched by substring of the path, first match wins."""
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, key, path, method="GET", body=None, prefer=None):
        self.calls.append((method, path, body, prefer))
        for frag, ans in self.routes:
            if frag in path:
                return ans(path, body) if callable(ans) else ans
        return 204, None

    def writes(self):
        return [c for c in self.calls if c[0] != "GET" and "/rpc/" not in c[1]]

    def to(self, frag, method=None):
        return [c for c in self.calls if frag in c[1] and (method is None or c[0] == method)]


def setup_world(routes, *, tier="max", tiers=None, queued=False, apify=True, spent=0.0):
    T.rest = Rest(routes)
    T.P.queued_work = lambda key: queued
    T.apify_ok = lambda: apify
    T.tier_of = lambda key, uid, cache: (tiers or {}).get(uid, tier)
    T._ROOM["v"] = (spent, 5.0)                    # this month's Apify spend and the ceiling (the soft stops are shares of it)
    for t in T.BUDGET_SKIPS:
        T.BUDGET_SKIPS[t] = 0
    return T.rest


PROF_TT = {"creator_id": "c1", "platform": "tiktok", "handle": "a.b", "platform_uid": "107955", "status": "verified",
           "verified_at": ago(days=3), "last_scan_at": None, "watermark_at": None}
PROF_IG = {**PROF_TT, "platform": "instagram", "platform_uid": "25025320"}


def tt_entries(*ages_h):
    return [{"url": f"https://www.tiktok.com/@a.b/video/{900 + i}", "timestamp": int((NOW - timedelta(hours=h)).timestamp()),
             "view_count": 1000 * (i + 1), "like_count": 50 * (i + 1), "comment_count": 5, "duration": 30, "uploader_id": "107955"}
            for i, h in enumerate(ages_h)]


def ig_items(*ages_h, owner="25025320", name="a.b"):
    return [{"type": "Video", "productType": "clips", "url": f"https://www.instagram.com/reel/R{i}/",
             "timestamp": (NOW - timedelta(hours=h)).isoformat().replace("+00:00", "Z"), "videoPlayCount": 2000 * (i + 1),
             "likesCount": 90 * (i + 1), "commentsCount": 3, "ownerId": owner, "ownerUsername": name} for i, h in enumerate(ages_h)]


def inserted(path, body):
    """A fake POST /lynxr_posts?... answer: every body row comes back with an id, like return=representation."""
    return 201, [{**r, "id": 100 + i} for i, r in enumerate(body)]


# scan: no tier gate any more -- a FREE account's TikTok profile is scanned
r = setup_world([("lynxr_profiles", (200, [PROF_TT])), ("on_conflict=creator_id,canonical_url", inserted), ("lynxr_posts?creator_id", (200, []))], tier="free")
T.tt_list = lambda h: tt_entries(2)
s1 = T.scan_pass("k", NOW)
check("scan: a free account is scanned too", s1["scanned_tt"], 1)

# scan: a TikTok profile, first scan (backfill), likes and comments stored with the day-0 snapshot
r = setup_world([("lynxr_profiles", (200, [PROF_TT])), ("on_conflict=creator_id,canonical_url", inserted), ("lynxr_posts?creator_id", (200, []))])
T.tt_list = lambda h: tt_entries(2, 30, 24 * 40)          # 2h old, 30h old, and one 40 days old (before the 30-day backfill)
s1 = T.scan_pass("k", NOW)
ins = r.to("on_conflict=creator_id,canonical_url", "POST")
check("scan tt: two posts stored, the 40-day-old one is not", (s1["new_posts"], len(ins[0][2])), (2, 2))
row0 = ins[0][2][0]
check("scan tt: post row carries views, likes, comments", (row0["views"], row0["likes"], row0["comments"], row0["origin"]), (1000, 50, 5, "tracked"))
check("scan tt: ignore-duplicates + representation", ins[0][3], "resolution=ignore-duplicates,return=representation")
snaps = r.to("lynxr_post_views", "POST")[0][2]
check("scan tt: day-0 snapshot per new post, with likes and comments", ([(x["day"], x["views"], x["likes"], x["comments"]) for x in snaps]), [(0, 1000, 50, 5), (1, 2000, 100, 5)])
check("scan tt: next checkpoint set (2h old -> +1 day)", row0["next_measure_at"], T.iso(NOW - timedelta(hours=2) + timedelta(days=1)))
pp = r.to("handle=eq.a.b", "PATCH")[-1][2]
check("scan tt: profile PATCH moves the watermark to the newest post", (pp["status"], pp["watermark_at"], pp["last_scan_ok_at"]),
      ("verified", T.iso(NOW - timedelta(hours=2)), T.iso(NOW)))

# scan: second scan is incremental; the watermark post is not stored again
wm = {**PROF_TT, "watermark_at": T.iso(NOW - timedelta(hours=2)), "last_scan_at": ago(hours=25)}
r = setup_world([("lynxr_profiles", (200, [wm])), ("on_conflict=creator_id,canonical_url", inserted), ("lynxr_posts?creator_id", (200, []))])
T.tt_list = lambda h: tt_entries(2, 30)                    # the newest IS the watermark: nothing is newer
s1 = T.scan_pass("k", NOW)
check("scan tt: nothing newer than the watermark -> no insert", (s1["new_posts"], len(r.to("on_conflict=creator_id,canonical_url"))), (0, 0))
check("scan tt: ok still stamped", r.to("handle=eq.a.b", "PATCH")[-1][2]["last_scan_ok_at"], T.iso(NOW))

# scan: TikTok daily refresh only ever raises a stored count
stored = [{"id": 7, "canonical_url": "tiktok.com/@a.b/video/900", "views": 400, "likes": 99999, "comments": None},
          {"id": 8, "canonical_url": "tiktok.com/@a.b/video/901", "views": 5000, "likes": 1, "comments": 5}]
r = setup_world([("lynxr_profiles", (200, [wm])), ("lynxr_posts?creator_id", (200, stored))])
s1 = T.scan_pass("k", NOW)
patches = {c[1].split("id=eq.")[1]: c[2] for c in r.to("lynxr_posts?id=eq", "PATCH")}
check("scan tt refresh: raises views and fills the missing comments, never lowers likes", patches.get("7"), {"views": 1000, "comments": 5})
check("scan tt refresh: a stored count above the listing is left alone, a lower one is raised", patches.get("8"), {"likes": 100})

# scan: ownership change -> `changed`, nothing stored
r = setup_world([("lynxr_profiles", (200, [PROF_TT])), ("on_conflict=creator_id,canonical_url", inserted)])
T.tt_list = lambda h: [{**e, "uploader_id": "42"} for e in tt_entries(2)]
s1 = T.scan_pass("k", NOW)
check("scan mismatch: changed, verified_at cleared, nothing inserted",
      (s1["scan_changed"], r.to("handle=eq.a.b", "PATCH")[0][2]["status"], r.to("handle=eq.a.b", "PATCH")[0][2]["verified_at"],
       len(r.to("lynxr_posts"))), (1, "changed", None, 0))

# scan: the list failed -> unavailable, retried after the interval (last_scan_at moves)
r = setup_world([("lynxr_profiles", (200, [PROF_TT]))])
T.tt_list = lambda h: None
s1 = T.scan_pass("k", NOW)
# A failed scan moves last_scan_at and NOTHING ELSE. It must not write `status`: this lane only runs on profiles whose
# verified_at is set, so a scan outcome there overwrites the verification state and the app tells a verified creator
# their profile failed.
check("scan failure: last_scan_at only, status untouched",
      (s1["scan_failed"], "status" in r.writes()[0][2], "last_scan_at" in r.writes()[0][2], "verified_at" in r.writes()[0][2]),
      (1, False, True, False))

# scan: an insert that did not land must not move the watermark
r = setup_world([("lynxr_profiles", (200, [PROF_TT])), ("on_conflict=creator_id,canonical_url", (500, None))])
T.tt_list = lambda h: tt_entries(2)
s1 = T.scan_pass("k", NOW)
check("scan insert failure: watermark not moved", ("watermark_at" in r.to("handle=eq.a.b", "PATCH")[-1][2], s1["scan_failed"]), (False, 1))

# scan: yield to a creator
r = setup_world([("lynxr_profiles", (200, [PROF_TT]))], queued=True)
T.tt_list = lambda h: (_ for _ in ()).throw(AssertionError("must not list"))
s1 = T.scan_pass("k", NOW)
check("scan yield: queued_work -> no list, no write", (len(r.writes()), s1["scanned_tt"]), (0, 0))

# scan: Instagram without budget makes no Apify call
r = setup_world([("lynxr_profiles", (200, [PROF_IG]))], apify=False)
T.ig_posts = lambda h, since: (_ for _ in ()).throw(AssertionError("must not call Apify"))
s1 = T.scan_pass("k", NOW)
check("scan ig budget: no call, no write, counted", (len(r.writes()), s1["scan_skipped_budget"]), (0, 1))

# scan: Instagram, the inclusive boundary post and the empty-scan placeholder
bound = {**PROF_IG, "watermark_at": T.iso(NOW - timedelta(hours=5)), "last_scan_at": ago(hours=25)}
r = setup_world([("lynxr_profiles", (200, [bound])), ("on_conflict=creator_id,canonical_url", inserted)])
seen = {}
T.ig_posts = lambda h, since: seen.setdefault("since", since) and ig_items(5, 2) + [{"inputUrl": "x"}]   # boundary (5h) + a new one (2h) + placeholder
s1 = T.scan_pass("k", NOW)
check("scan ig: asked for posts newer than the watermark", seen["since"], NOW - timedelta(hours=5))
check("scan ig: boundary post and placeholder dropped, only the strictly newer stored", (s1["new_posts"], len(r.to("on_conflict=creator_id,canonical_url")[0][2])), (1, 1))
check("scan ig: likes and comments stored", (lambda b: (b["views"], b["likes"], b["comments"]))(r.to("on_conflict=creator_id,canonical_url")[0][2][0]), (4000, 180, 3))
T.apify_run = lambda body: [{"error": "not_found"}]
check("ig_posts: only error items -> None", REAL["ig_posts"]("a.b", NOW), None)
T.apify_run = lambda body: [{"inputUrl": "x"}]
check("ig_posts: the empty-scan placeholder is a successful empty scan", REAL["ig_posts"]("a.b", NOW), [{"inputUrl": "x"}])
sent = {}
T.apify_run = lambda body: sent.update(body) or []
REAL["ig_posts"]("a.b", NOW)
check("ig_posts: the run asks for posts, newer than the datetime, limited", (sent["resultsType"], sent["onlyPostsNewerThan"], sent["resultsLimit"], sent["addParentData"]),
      ("posts", "2026-10-01T12:00:00Z", T.TRACK_IG_LIST_LIMIT, False))

# scan: Instagram ownership
r = setup_world([("lynxr_profiles", (200, [PROF_IG]))])
T.ig_posts = lambda h, since: ig_items(2, owner="999", name="someone.else")
s1 = T.scan_pass("k", NOW)
check("scan ig mismatch: changed", (s1["scan_changed"], r.writes()[0][2]["status"]), (1, "changed"))

# scan: at most TRACK_SCAN_PER_PASS profiles
T.TRACK_SCAN_PER_PASS = 2
r = setup_world([("lynxr_profiles", (200, [{**PROF_TT, "handle": "a"}, {**PROF_TT, "handle": "b"}, {**PROF_TT, "handle": "c"}])),
                 ("lynxr_posts", (200, []))])
T.tt_list = lambda h: []
s1 = T.scan_pass("k", NOW)
check("scan: at most TRACK_SCAN_PER_PASS per pass", s1["scanned_tt"], 2)
T.TRACK_SCAN_PER_PASS = 3

# dry run: nothing written, nothing fetched
r = setup_world([("lynxr_profiles", (200, [PROF_TT]))])
T.tt_list = lambda h: (_ for _ in ()).throw(AssertionError("must not list"))
s1 = T.scan_pass("k", NOW, dry=True)
check("scan dry: no fetch, no write", (len(r.writes()), s1["scanned_tt"]), (0, 0))

# ── measure ──
DUE = {"id": 5, "creator_id": "c1", "platform": "tiktok", "url": "https://www.tiktok.com/@a.b/video/900",
       "posted_at": ago(days=3, hours=1), "measure_fails": 0}
DUE_IG = {**DUE, "id": 6, "platform": "instagram", "url": "https://www.instagram.com/reel/R0/"}
T.measure = lambda post: {"views": 9000, "likes": 700, "comments": 12}
r = setup_world([("lynxr_posts?next_measure_at", (200, [DUE]))])
sm = T.measure_pass("k", NOW)
body = r.to("lynxr_posts?id=eq.5", "PATCH")[0][2]
check("measure: counts, metrics_at and the next checkpoint (day 3 -> day 7)", (body["views"], body["likes"], body["comments"], body["metrics_at"], body["next_measure_at"], body["measure_fails"]),
      (9000, 700, 12, T.iso(NOW), T.iso(NOW - timedelta(days=3, hours=1) + timedelta(days=7)), 0))
snap = r.to("lynxr_post_views", "POST")[0][2][0]
check("measure: snapshot day = whole days since posting, with likes and comments", (snap["post_id"], snap["day"], snap["views"], snap["likes"], snap["comments"]), (5, 3, 9000, 700, 12))
check("measure: counted", sm["measured"], 1)

T.measure = lambda post: {"views": None, "likes": 700, "comments": None}
r = setup_world([("lynxr_posts?next_measure_at", (200, [DUE]))])
T.measure_pass("k", NOW)
check("measure: an absent count is left out of the PATCH, not written as 0", sorted(k for k in r.to("lynxr_posts?id=eq.5", "PATCH")[0][2] if k in ("views", "likes", "comments")), ["likes"])

T.measure = lambda post: {"views": 9, "likes": 1, "comments": 0}
r = setup_world([("lynxr_posts?next_measure_at", (200, [DUE]))], tier="free")
sm = T.measure_pass("k", NOW)
check("measure: a free account's post is measured, never frozen", (sm["measured"], "frozen" in sm, r.to("lynxr_posts?id=eq.5", "PATCH")[0][2].get("next_measure_at") is not None), (1, False, True))

r = setup_world([("lynxr_posts?next_measure_at", (200, [DUE]))], queued=True)
sm = T.measure_pass("k", NOW)
check("measure yield: queued_work -> no write", len(r.writes()), 0)

r = setup_world([("lynxr_posts?next_measure_at", (200, [DUE_IG]))], apify=False)
sm = T.measure_pass("k", NOW)
check("measure ig budget: no measurement, counted", (len(r.writes()), sm["measure_skipped_budget"]), (0, 1))

T.measure = lambda post: None
r = setup_world([("lynxr_posts?next_measure_at", (200, [DUE]))])
T.measure_pass("k", NOW)
b = r.to("lynxr_posts?id=eq.5", "PATCH")[0][2]
check("measure failure: retried after TRACK_MEASURE_RETRY_H, fails counted", (b["measure_fails"], b["next_measure_at"]), (1, T.iso(NOW + timedelta(hours=T.TRACK_MEASURE_RETRY_H))))
r = setup_world([("lynxr_posts?next_measure_at", (200, [{**DUE, "measure_fails": T.TRACK_MEASURE_MAX_FAILS - 1}]))])
T.measure_pass("k", NOW)
b = r.to("lynxr_posts?id=eq.5", "PATCH")[0][2]
check("measure failure at the cap: moves to the next checkpoint, fails reset", (b["measure_fails"], b["next_measure_at"]), (0, T.iso(NOW - timedelta(days=3, hours=1) + timedelta(days=7))))
check("measure failure: no snapshot written", len(r.to("lynxr_post_views")), 0)
r = setup_world([("lynxr_posts?next_measure_at", (200, [{**DUE, "posted_at": ago(days=40), "measure_fails": 2}]))])
T.measure_pass("k", NOW)
check("measure failure on the last checkpoint: next is None", r.to("lynxr_posts?id=eq.5", "PATCH")[0][2]["next_measure_at"], None)

T.TRACK_MEASURE_PER_PASS = 1
T.measure = lambda post: {"views": 1, "likes": 1, "comments": 1}
r = setup_world([("lynxr_posts?next_measure_at", (200, [DUE, {**DUE, "id": 9}]))])
sm = T.measure_pass("k", NOW)
check("measure: at most TRACK_MEASURE_PER_PASS per pass", sm["measured"], 1)
T.TRACK_MEASURE_PER_PASS = 5

# measure(): the real mapper, with the fetchers stubbed
T.measure = REAL["measure"]
T.apify_run = lambda body: [{"error": "not_found"}]
check("measure ig: a refusal -> None", T.measure(DUE_IG), None)
T.apify_run = lambda body: [{"type": "Video", "videoPlayCount": 800, "videoViewCount": 200, "likesCount": 40, "commentsCount": -1}]
check("measure ig: play count, likes, hidden comments absent", T.measure(DUE_IG),
      {"views": 800, "likes": 40, "comments": None})
T.apify_run = lambda body: [{"type": "Video"}]
check("measure ig: an item with no counts at all -> None", T.measure(DUE_IG), None)
T.ytdlp_json = lambda args, timeout: {"view_count": 103812, "like_count": 1925, "comment_count": None}
check("measure tt: exact counts, absent stays None", T.measure(DUE),
      {"views": 103812, "likes": 1925, "comments": None})
T.ytdlp_json = lambda args, timeout: {"view_count": 103812, "like_count": 1925, "comment_count": None}
T.ytdlp_json = lambda args, timeout: None
check("measure tt: yt-dlp failed -> None", T.measure(DUE), None)

# ── followers ──
FOL = {"creator_id": "c1", "platform": "tiktok", "handle": "a.b", "platform_uid": "107955", "status": "verified",
       "verified_at": ago(days=3), "followers_try_at": None}
FOL_IG = {**FOL, "platform": "instagram", "platform_uid": "25025320"}
T.follower_read = lambda plat, handle: {"uid": "107955" if plat == "tiktok" else "25025320", "followers": 96000317}
r = setup_world([("lynxr_profiles", (200, [FOL])), ("lynxr_profile_followers?day", (200, []))])
sf = T.followers_pass("k", NOW)
snap = r.to("lynxr_profile_followers?on_conflict", "POST")[0]
check("followers tt: one snapshot for today", (sf["followers"], snap[2][0]["day"], snap[2][0]["followers"], snap[3]), (1, "2026-10-01", 96000317, "resolution=merge-duplicates,return=minimal"))
check("followers tt: the attempt is stamped on the profile", r.to("handle=eq.a.b", "PATCH")[0][2], {"followers_try_at": T.iso(NOW)})

r = setup_world([("lynxr_profiles", (200, [FOL])), ("lynxr_profile_followers?day", (200, [{"creator_id": "c1", "platform": "tiktok", "handle": "a.b"}]))])
sf = T.followers_pass("k", NOW)
check("followers: already read today -> no read, no write", (sf["followers"], len(r.writes())), (0, 0))

T.follower_read = lambda plat, handle: {"uid": "107955", "followers": 10}
r = setup_world([("lynxr_profiles", (200, [FOL])), ("lynxr_profile_followers?day", (200, []))], tier="free")
sf = T.followers_pass("k", NOW)
check("followers: a free account's TikTok count is read too", sf["followers"], 1)

r = setup_world([("lynxr_profiles", (200, [FOL])), ("lynxr_profile_followers?day", (200, []))], queued=True)
sf = T.followers_pass("k", NOW)
check("followers yield: queued_work -> nothing", len(r.writes()), 0)

T.follower_read = lambda plat, handle: (_ for _ in ()).throw(AssertionError("must not call Apify"))
r = setup_world([("lynxr_profiles", (200, [FOL_IG])), ("lynxr_profile_followers?day", (200, []))], apify=False)
sf = T.followers_pass("k", NOW)
check("followers ig budget: past the guard -> no details call, counted", (len(r.writes()), sf["followers_skipped_budget"]), (0, 1))

T.follower_read = lambda plat, handle: None
r = setup_world([("lynxr_profiles", (200, [FOL_IG])), ("lynxr_profile_followers?day", (200, []))])
sf = T.followers_pass("k", NOW)
check("followers failure: no snapshot, the try is stamped so it waits", (sf["followers_failed"], len(r.to("lynxr_profile_followers?on_conflict")), r.writes()[0][2]), (1, 0, {"followers_try_at": T.iso(NOW)}))

T.follower_read = lambda plat, handle: {"uid": "999", "followers": 5}
r = setup_world([("lynxr_profiles", (200, [FOL])), ("lynxr_profile_followers?day", (200, []))])
sf = T.followers_pass("k", NOW)
check("followers: a different account number -> changed, no snapshot", (sf["followers_changed"], r.writes()[0][2]["status"], len(r.to("lynxr_profile_followers?on_conflict"))), (1, "changed", 0))

T.TRACK_FOLLOW_PER_PASS = 2
T.follower_read = lambda plat, handle: {"uid": "107955", "followers": 1}
r = setup_world([("lynxr_profiles", (200, [{**FOL, "handle": h} for h in "abcd"])), ("lynxr_profile_followers?day", (200, []))])
sf = T.followers_pass("k", NOW)
check("followers: at most TRACK_FOLLOW_PER_PASS per pass", sf["followers"], 2)
T.TRACK_FOLLOW_PER_PASS = 6

# follower_read(): the real function, fetchers stubbed
T.follower_read = REAL["follower_read"]
T.tt_profile_page = lambda h: page({"statusCode": 0, "userInfo": {"user": {"id": 7}, "statsV2": {"followerCount": "1234"}}})
check("follower_read tt: uid and exact followers", T.follower_read("tiktok", "x"), {"uid": "7", "followers": 1234})
T.tt_profile_page = lambda h: page({"statusCode": 0, "userInfo": {"user": {"id": 7}}})
check("follower_read tt: no stats -> None", T.follower_read("tiktok", "x"), None)
T.tt_profile_page = lambda h: None
check("follower_read tt: no page -> None", T.follower_read("tiktok", "x"), None)
T.ig_details = lambda h: {"found": True, "private": False, "bio": "", "uid": "9", "followers": 55}
check("follower_read ig: uid and followers", T.follower_read("instagram", "x"), {"uid": "9", "followers": 55})
T.ig_details = lambda h: {"found": False, "followers": None}
check("follower_read ig: not found -> None", T.follower_read("instagram", "x"), None)
check("follower_read: unknown platform -> None", T.follower_read("youtube", "x"), None)

# tier_of: entitlement_for through the service rpc, cached; no row / unknown code / error is free
def _ent(path, body):
    pass


T.rest = lambda key, path, method="GET", body=None, prefer=None: (
    (200, [{"granted": 150, "period_days": 7, "daily_max": 20, "plan_code": "pro"}]) if body == {"p_creator": "p"} else
    (200, [{"granted": 600, "period_days": 7, "daily_max": 50, "plan_code": "max"}]) if body == {"p_creator": "m"} else
    (200, [{"granted": 3, "period_days": 7, "daily_max": 0, "plan_code": "free"}]) if body == {"p_creator": "f"} else
    (200, []) if body == {"p_creator": "none"} else
    (200, [{"plan_code": "enterprise"}]) if body == {"p_creator": "odd"} else (500, None))
c = {}
check("tier_of: pro", REAL["tier_of"]("k", "p", c), "pro")
check("tier_of: max", REAL["tier_of"]("k", "m", c), "max")
check("tier_of: free", REAL["tier_of"]("k", "f", c), "free")
check("tier_of: no row is free", REAL["tier_of"]("k", "none", c), "free")
check("tier_of: an unknown plan code is free", REAL["tier_of"]("k", "odd", c), "free")
check("tier_of: an error is free", REAL["tier_of"]("k", "boom", c), "free")
calls = []
T.rest = lambda key, path, method="GET", body=None, prefer=None: calls.append(body) or (200, [{"plan_code": "max"}])
REAL["tier_of"]("k", "z", {})
REAL["tier_of"]("k", "z", {"z": "max"})
check("tier_of: cached per pass (one call for one fresh uid, none for a cached one)", len(calls), 1)
check("tier_of: the rpc is entitlement_for's p_creator", calls[0], {"p_creator": "z"})

# the soft stops: pure thresholds (ceiling 5.0, free stops at 50% = 2.50, pro at 65% = 3.25, max has none)
check("tier_allowed: free below 50%", T.tier_allowed("free", 2.49, 5.0), True)
check("tier_allowed: free at 50%", T.tier_allowed("free", 2.50, 5.0), False)
check("tier_allowed: pro below 65%", T.tier_allowed("pro", 3.24, 5.0), True)
check("tier_allowed: pro at 65%", T.tier_allowed("pro", 3.25, 5.0), False)
check("tier_allowed: max has no soft stop", T.tier_allowed("max", 4.9, 5.0), True)
check("tier_allowed: unknown tier behaves like max", T.tier_allowed("x", 4.9, 5.0), True)

# ig_gate: the guard AND the tier's stop, with this process's own results counted, and skips counted by tier
T.apify_ok = lambda: True
T._ROOM["v"] = (2.40, 5.0)
T.APIFY_RESULTS = 0
for t in T.BUDGET_SKIPS:
    T.BUDGET_SKIPS[t] = 0
check("ig_gate: free allowed at 2.40", T.ig_gate("free"), True)
T.APIFY_RESULTS = 100                           # 100 x 0.0027 = 0.27 more -> 2.67: past free's stop, under pro's
check("ig_gate: free refused once this process's results pass 50%", T.ig_gate("free"), False)
check("ig_gate: pro still allowed at 2.67", T.ig_gate("pro"), True)
T._ROOM["v"] = (3.30, 5.0)
T.APIFY_RESULTS = 0
check("ig_gate: pro refused past 65%", T.ig_gate("pro"), False)
check("ig_gate: max allowed past 65%", T.ig_gate("max"), True)
check("ig_gate: refusals are counted by tier", dict(T.BUDGET_SKIPS), {"max": 0, "pro": 1, "free": 1})
T.apify_ok = lambda: False
check("ig_gate: the 80% guard closed refuses max too", T.ig_gate("max"), False)
T.apify_ok = lambda: True
T._ROOM["v"] = (0.0, 5.0)

# ordering: max -> pro -> free, stable inside a tier, and it applies BEFORE the per-pass cap
TIERS = {"cm": "max", "cp": "pro", "cf": "free"}
T.tier_of = lambda key, uid, cache: TIERS[uid]
check("by_tier: max, pro, free; stable", [r["n"] for r in T.by_tier(
    [{"creator_id": "cf", "n": 1}, {"creator_id": "cp", "n": 2}, {"creator_id": "cf", "n": 3}, {"creator_id": "cm", "n": 4}, {"creator_id": "cp", "n": 5}], "k", {})],
      [4, 2, 5, 1, 3])
T.TRACK_SCAN_PER_PASS = 1
scanned = []
T.scan_profile = lambda key, r, now, stats: scanned.append(r["creator_id"])
setup_world([("lynxr_profiles", (200, [{**PROF_TT, "creator_id": "cf"}, {**PROF_TT, "creator_id": "cp"}, {**PROF_TT, "creator_id": "cm"}]))], tiers=TIERS)
T.scan_pass("k", NOW)
check("scan: the one slot goes to the max account, not the free one that came first", scanned, ["cm"])
T.TRACK_SCAN_PER_PASS = 3
scanned.clear()
setup_world([("lynxr_profiles", (200, [{**PROF_TT, "creator_id": "cf"}, {**PROF_TT, "creator_id": "cp"}, {**PROF_TT, "creator_id": "cm"}]))], tiers=TIERS)
T.scan_pass("k", NOW)
check("scan: order is max, pro, free", scanned, ["cm", "cp", "cf"])
T.scan_profile = REAL_SCAN_PROFILE
T.TRACK_SCAN_PER_PASS = 5

# Instagram scan under budget pressure: free is refused at 2.6 of 5.0, pro and max are not
T.tt_list = lambda h: []
T.ig_posts = lambda h, since: []
igp = [{**PROF_IG, "creator_id": "cf"}, {**PROF_IG, "creator_id": "cp"}, {**PROF_IG, "creator_id": "cm"}]
r = setup_world([("lynxr_profiles", (200, igp))], tiers=TIERS, spent=2.6)
s1 = T.scan_pass("k", NOW)
check("scan ig: free refused (counted), pro and max scanned", (s1["scan_skipped_budget"], s1["scanned_ig"], dict(T.BUDGET_SKIPS)), (1, 2, {"max": 0, "pro": 0, "free": 1}))
r = setup_world([("lynxr_profiles", (200, igp))], tiers=TIERS, spent=3.3)
s1 = T.scan_pass("k", NOW)
check("scan ig: past 65% only max is scanned", (s1["scan_skipped_budget"], s1["scanned_ig"], dict(T.BUDGET_SKIPS)), (2, 1, {"max": 0, "pro": 1, "free": 1}))
# ... and TikTok is never skipped for budget, even with the guard closed
r = setup_world([("lynxr_profiles", (200, [{**PROF_TT, "creator_id": "cf"}]))], tiers=TIERS, spent=4.9, apify=False)
s1 = T.scan_pass("k", NOW)
check("scan tt: free TikTok scanned with the Apify budget gone", (s1["scanned_tt"], s1["scan_skipped_budget"]), (1, 0))

# verify: the one slot goes to the max account's Instagram check; a free one is refused under pressure
T.TRACK_VERIFY_PER_PASS = 1
f, s = run_pass([{**ROW_IG, "creator_id": "cf"}, {**ROW_IG, "creator_id": "cm"}], tiers=TIERS, read={"found": True, "private": False, "bio": "lynxr-ab12cd", "uid": "9"})
check("verify: the one slot goes to the max account", (s["checked"], "creator_id=eq.cm" in f.patches[0][0]), (1, True))
T.TRACK_VERIFY_PER_PASS = 3
f, s = run_pass([{**ROW_IG, "creator_id": "cf"}], tiers=TIERS, spent=2.6, read={"found": True, "private": False, "bio": "lynxr-ab12cd", "uid": "9"})
check("verify ig: a free account is refused at 52% of the ceiling", (len(f.patches), s["skipped_budget"]), (0, 1))

# run(): one pass, verify -> scan -> measure -> followers -> health
T.rest = lambda key, path, method="GET", body=None, prefer=None: (200, [])
T.P.queued_work = lambda key: False
T.apify_ok = lambda: True
T.tier_of = lambda key, uid, cache: "max"
out = T.run("k", dry=True)
check("run dry: every phase reports, nothing counted", (out["checked"], out["scanned_tt"], out["scanned_ig"], out["measured"], out["followers"]), (0, 0, 0, 0, 0))
health = []
T.rest = lambda key, path, method="GET", body=None, prefer=None: (health.append(body), (200, []))[1] if "track.health" in str(body) or "lynxr_ops" in path else (200, [])
out = T.run("k")
hb = [b for b in health if isinstance(b, dict) and b.get("key") == "track.health"]
check("run: health written with the new counts", (len(hb), sorted(k for k in ("verified_profiles", "scanned_tt", "new_posts", "measured", "followers", "apify_ok", "budget_skips") if k in hb[0]["value"])),
      (1, sorted(["verified_profiles", "scanned_tt", "new_posts", "measured", "followers", "apify_ok", "budget_skips"])))
check("run: health carries the budget skips by tier", hb[0]["value"]["budget_skips"], {"max": 0, "pro": 0, "free": 0})


# measure() refuses a link that is not on its own platform's host.
T.measure = REAL["measure"]
check("measure: a foreign host is never fetched", T.measure({"platform": "tiktok", "url": "https://evil.example/@a/video/1"}), None)
check("measure: a look-alike host is never fetched", T.measure({"platform": "instagram", "url": "https://www.instagram.com.evil.example/reel/x/"}), None)

# ── MATCH: the script-attribution lane. No network, no Supabase, no ffmpeg: fetch_audio / transcribe / media_duration are stubs ──
import contextlib
import io
import logging

REAL_P = {n: getattr(T.P, n) for n in ("fetch_audio", "transcribe", "media_duration", "queued_work")}
HOOK_M = "your water bottle is lying about how cold it stays"
BEATS_M = ["i filled the quenchwell bottle with ice and left it in my hot car all afternoon",
           "six hours later the ice was still there and the water was freezing cold",
           "the lid seals tight so nothing leaks inside my gym bag either",
           "it fits my cup holder and it cleans in the dishwasher with no effort"]
CTA_M = "grab a quenchwell bottle before summer ends"
SAID_M = " ".join([HOOK_M] + BEATS_M + [CTA_M])
CAPTION_M = "a private caption nobody should ever store"


def m_script(aid="s-1", brand="b1", **kw):
    return {"id": aid, "status": "done", "brandId": brand, "addedAt": ago(days=2),
            "adaptation": {"delivery": "spoken", "hook": HOOK_M, "cta": CTA_M, "caption": "",
                           "beats": [{"t": "0-3s", "say": s, "do": "", "show": ""} for s in BEATS_M]}, **kw}


M_DATA = {"brands": [{"id": "b1", "name": "Quenchwell"}], "adaptations": [m_script()]}
M_POST = {"id": 7, "creator_id": "c1", "platform": "tiktok", "handle": "a.b", "url": "https://www.tiktok.com/@a.b/video/7",
          "caption": CAPTION_M, "posted_at": ago(hours=5), "match_tries": 1}
M_CALLS = {"fetch": 0, "transcribe": 0}


def match_stubs(said=SAID_M, speech=True, dur=30, fetch_ok=True, boom=False):
    M_CALLS.update(fetch=0, transcribe=0)

    def fetch(url, dest):
        M_CALLS["fetch"] += 1
        if not fetch_ok:
            return None, "download failed"
        f = dest / "a.mp3"
        f.write_bytes(b"x")
        return f, None

    def transcribe(path, model):
        M_CALLS["transcribe"] += 1
        if boom:
            raise RuntimeError("whisper fell over")
        return {"text": said if speech else "", "has_speech": speech}

    T.P.fetch_audio, T.P.transcribe, T.P.media_duration = fetch, transcribe, lambda p: dur


def match_world(post=M_POST, data=M_DATA, linked=(), **kw):
    return setup_world([("match_state=eq.pending", (200, [post] if post else [])), ("match_state=eq.failed", (200, [])),
                        ("lynxr_creators", (200, [{"data": data}])),
                        ("adaptation_id=not.is.null", (200, [{"adaptation_id": a} for a in linked]))], **kw)


def patches(r):
    return r.to("lynxr_posts?id=eq.", "PATCH")


class Grab(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, rec):
        self.lines.append(rec.getMessage())


GRAB = Grab()
logging.getLogger("track_posts").addHandler(GRAB)

# match_due: an unapplied post_match.sql (404, then 400) is one INFO line, [] and nothing further asked
for code in (404, 400):
    GRAB.lines.clear()
    r = setup_world([("lynxr_posts", (code, None))])
    check(f"match_due {code}: [] and exactly one read", (T.match_due("k", NOW), len(r.calls)), ([], 1))
    check(f"match_due {code}: one INFO line naming the SQL file", len([l for l in GRAB.lines if "post_match.sql" in l]), 1)
    check(f"match_pass {code}: harmless, counts zero", T.match_pass("k", NOW)["match_due"], 0)

# match_due: the two reads, pending then failed (try cap and retry wait), merged without duplicates
r = match_world()
due = T.match_due("k", NOW)
fr = r.to("match_state=eq.failed")[0][1]
check("match_due: pending read asks adaptation_id is null, tracked, inside the window",
      all(x in r.to("match_state=eq.pending")[0][1] for x in ("adaptation_id=is.null", "origin=eq.tracked", "posted_at=gt.")), True)
check("match_due: failed read has the try cap and the retry wait", ("match_tries=lt.3" in fr, "match_at=lt." in fr), (True, True))
check("match_due: returns the post", [p["id"] for p in due], [7])

# the lane off: no REST call at all
T.TRACK_MATCH = False
r = match_world()
check("match off: {} and no call", (T.match_pass("k", NOW), len(r.calls)), ({}, 0))
T.TRACK_MATCH = True

# dry: counts what is due, fetches and writes nothing
match_stubs()
r = match_world()
sm = T.match_pass("k", NOW, dry=True)
check("match dry: counts, no download, no write", (sm["match_due"], M_CALLS["fetch"], len(r.writes())), (1, 0, 0))

# no candidate script: nothing is downloaded; state none; one log row with no candidates
match_stubs()
r = match_world(data={"brands": M_DATA["brands"], "adaptations": [{**m_script(), "brandId": None}]})   # a no-brand entry is not a candidate
sm = T.match_pass("k", NOW)
check("match none: no download at all", M_CALLS["fetch"], 0)
check("match none: state none, tries + 1", (patches(r)[0][2]["match_state"], patches(r)[0][2]["match_tries"]), ("none", 2))
lg = r.to("lynxr_match_log", "POST")
check("match none: one log row, decision none, no candidates", (len(lg), lg[0][2]["decision"], lg[0][2]["candidates"]), (1, "none", []))
check("match none: counted", sm["match_none"], 1)

# a script already linked to 4 posts is not a candidate either
match_stubs()
r = match_world(linked=["s-1"] * 4)
T.match_pass("k", NOW)
check("match: a script at its link cap is out, so no download", (M_CALLS["fetch"], patches(r)[0][2]["match_state"]), (0, "none"))

# auto: exactly one PATCH on the post, guarded by adaptation_id=is.null
match_stubs()
r = match_world()
sm = T.match_pass("k", NOW)
pp = patches(r)
check("match auto: exactly one PATCH", len(pp), 1)
check("match auto: its path carries adaptation_id=is.null (the creator wins a race)", "adaptation_id=is.null" in pp[0][1], True)
check("match auto: it writes the script id and state auto", (pp[0][2]["adaptation_id"], pp[0][2]["match_state"], pp[0][2]["match_tries"]), ("s-1", "auto", 2))
check("match auto: it stamps script_linked_at and match_at", (pp[0][2]["script_linked_at"], pp[0][2]["match_at"]), (T.iso(NOW), T.iso(NOW)))
lg = r.to("lynxr_match_log", "POST")
check("match auto: one log row, decision auto, the script id and a score", (len(lg), lg[0][2]["decision"], lg[0][2]["best_adaptation_id"], lg[0][2]["best_score"] >= 0.7),
      (1, "auto", "s-1", True))
blob = json.dumps([c[2] for c in r.writes()])
check("match auto: no transcript word and no caption anywhere in what was written",
      any(x in blob for x in ("dishwasher", "freezing", "private caption", "gym bag")), False)
check("match auto: counted as matched; one download and one transcription", (sm["matched"], M_CALLS["fetch"], M_CALLS["transcribe"]), (1, 1, 1))

# shadow mode: scored and logged, no adaptation_id written
T.TRACK_MATCH_WRITE = False
match_stubs()
r = match_world()
sm = T.match_pass("k", NOW)
check("match shadow: the PATCH carries no adaptation_id and never says auto", ("adaptation_id" in patches(r)[0][2], patches(r)[0][2]["match_state"]), (False, "borderline"))
check("match shadow: the log still records the real decision", r.to("lynxr_match_log", "POST")[0][2]["decision"], "auto")
check("match shadow: nothing counted as matched", sm["matched"], 0)
T.TRACK_MATCH_WRITE = True

# the creator linked the post by hand while the audio downloaded: the guarded PATCH matches no row, so nothing of ours is recorded
match_stubs()
r = match_world()
r.routes.insert(0, ("lynxr_posts?id=eq.", (200, [])))
sm = T.match_pass("k", NOW)
check("match race: no log row and not counted when the creator got there first", (len(r.to("lynxr_match_log", "POST")), sm["matched"]), (0, 0))

# fetch failure: failed, tries + 1, NO log row
match_stubs(fetch_ok=False)
r = match_world()
sm = T.match_pass("k", NOW)
check("match fetch failed: state failed, tries incremented", (patches(r)[0][2]["match_state"], patches(r)[0][2]["match_tries"]), ("failed", 2))
check("match fetch failed: no log row, counted", (len(r.to("lynxr_match_log", "POST")), sm["match_failed"]), (0, 1))

# a transcribe crash is contained: failed, and the pass goes on
match_stubs(boom=True)
r = match_world()
sm = T.match_pass("k", NOW)
check("match transcribe crash: contained, state failed", (patches(r)[0][2]["match_state"], sm["match_failed"]), ("failed", 1))

# too long: skipped, and Whisper never runs
match_stubs(dur=T.TRACK_MATCH_MAX_SEC + 1)
r = match_world()
sm = T.match_pass("k", NOW)
check("match too long: skipped, transcribe never called", (patches(r)[0][2]["match_state"], M_CALLS["transcribe"], sm["match_skipped"]), ("skipped", 0, 1))

# a link that is not on the post's own platform host is never fetched
match_stubs()
r = match_world(post={**M_POST, "url": "https://evil.example/v/7"})
T.match_pass("k", NOW)
check("match: a foreign host is never downloaded", (M_CALLS["fetch"], patches(r)[0][2]["match_state"]), (0, "skipped"))

# creators first: a queued script stops the loop before the first item
match_stubs()
r = match_world(queued=True)
sm = T.match_pass("k", NOW)
check("match yield: queued_work -> due counted, nothing attempted", (sm["match_due"], M_CALLS["fetch"], len(r.writes())), (1, 0, 0))

# the wall clock: no new attempt starts past the budget
match_stubs()
r = match_world()
T.TRACK_MATCH_BUDGET_S = -1
sm = T.match_pass("k", NOW)
T.TRACK_MATCH_BUDGET_S = 240
check("match budget: nothing starts past the budget", (M_CALLS["fetch"], len(r.writes())), (0, 0))

# at most TRACK_MATCH_PER_PASS posts per pass, max accounts first
match_stubs()
posts3 = [{**M_POST, "id": 10 + i, "creator_id": c} for i, c in enumerate(("cf", "cp", "cm"))]
r = setup_world([("match_state=eq.pending", (200, posts3)), ("match_state=eq.failed", (200, [])), ("lynxr_creators", (200, [{"data": M_DATA}])),
                 ("adaptation_id=not.is.null", (200, []))], tiers=TIERS)
T.match_pass("k", NOW)
check("match per pass: two attempts, max then pro (the free one waits)", [p[1].split("id=eq.")[1].split("&")[0] for p in patches(r)], ["12", "11"])

# an unreadable creator row records nothing (a transient error is not a verdict)
match_stubs()
r = setup_world([("match_state=eq.pending", (200, [M_POST])), ("match_state=eq.failed", (200, [])), ("lynxr_creators", (500, None))])
T.match_pass("k", NOW)
check("match: an unreadable creator row writes nothing and downloads nothing", (len(r.writes()), M_CALLS["fetch"]), (0, 0))

# run(): the lane is wired in last and its counts reach the health row
match_stubs()
r = match_world()
T.apify_ok = lambda: True
out = T.run("k", dry=True)
check("run dry: the match lane reports what is due", out["match"]["match_due"], 1)
check("run: the match key is present in the stats", "match" in out, True)

# --match-dry: the whole path, printed, and nothing written
match_stubs()
r = setup_world([("lynxr_posts?id=eq.7&select", (200, [M_POST])), ("lynxr_creators", (200, [{"data": M_DATA}])),
                 ("adaptation_id=not.is.null", (200, []))])
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = T.match_dry("k", 7)
check("match-dry: writes nothing at all (no PATCH, no log row)", (rc, len(r.writes())), (0, 0))
check("match-dry: prints the decision and the candidate id, not a transcript word",
      ("decision: auto" in buf.getvalue(), "s-1" in buf.getvalue(), "dishwasher" in buf.getvalue(), "private caption" in buf.getvalue()),
      (True, True, False, False))
r = setup_world([("lynxr_posts?id=eq.7&select", (200, []))])
with contextlib.redirect_stdout(io.StringIO()):
    check("match-dry: an unknown post is exit 2", T.match_dry("k", 7), 2)

for n, f in REAL_P.items():
    setattr(T.P, n, f)
logging.getLogger("track_posts").removeHandler(GRAB)

print()
print("ALL OK" if not FAILS else f"{len(FAILS)} FAILED")
sys.exit(1 if FAILS else 0)
