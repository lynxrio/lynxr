"""Offline checks for pipeline/showcase.py. Same check()/FAILS style as pipeline/test_track_posts.py.
No Supabase, no TikTok, no Apify, no ffmpeg: the running track_posts module is replaced by a stub namespace and the
cover fetch, upload and oEmbed calls are monkeypatched.

Run with

    ./venv/bin/python pipeline/test_showcase.py
"""
import re
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import showcase as S  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


NOW = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)


def ago(**kw):
    return (NOW - timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── pure ──────────────────────────────────────────────────────────────────────────────────────────

check("host: tiktokcdn-us ok", S.cover_host_ok("https://p16-sign.tiktokcdn-us.com/x.jpeg"), True)
check("host: instagram cdn ok", S.cover_host_ok("https://scontent-iad3-1.cdninstagram.com/v/x.jpg"), True)
check("host: suffix attack refused", S.cover_host_ok("https://tiktokcdn.com.evil.example/x"), False)
check("host: http refused", S.cover_host_ok("http://p16.tiktokcdn.com/x"), False)
check("host: lookalike refused", S.cover_host_ok("https://instagram.com.evil/x"), False)
check("host: bare domain without dot refused", S.cover_host_ok("https://eviltiktokcdn.com/x"), False)
check("host: empty", S.cover_host_ok(""), False)
check("host: None", S.cover_host_ok(None), False)

check("canon: query and slash", S.canon("https://www.tiktok.com/@a/video/12345?lang=en#x"), "https://www.tiktok.com/@a/video/12345")
check("canon: trailing slash", S.canon("https://www.instagram.com/reel/AbC123/"), "https://www.instagram.com/reel/AbC123")

check("day_of: 3 days", S.day_of(ago(days=3), NOW), 3)
check("day_of: the future is 0", S.day_of((NOW + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ"), NOW), 0)
check("day_of: missing", S.day_of(None, NOW), None)
check("day_of: junk", S.day_of("not a date", NOW), None)

check("next_due: agency day 3 is +24h", S.next_due("agency", ago(days=3), NOW), NOW + timedelta(hours=24))
check("next_due: agency day 40 is +168h", S.next_due("agency", ago(days=40), NOW), NOW + timedelta(hours=168))
check("next_due: creator is +168h", S.next_due("creator", ago(days=3), NOW), NOW + timedelta(hours=168))
check("next_due: unknown age is slow", S.next_due("agency", None, NOW), NOW + timedelta(hours=168))

check("owner: match", S.owner_ok("tiktok", "maya", {"owner": "maya"}), True)
check("owner: case-insensitive", S.owner_ok("tiktok", "maya", {"owner": "MAYA"}), True)
check("owner: mismatch", S.owner_ok("tiktok", "maya", {"owner": "someone"}), False)
check("owner: tiktok url fallback", S.owner_ok("tiktok", "maya", {"owner": "", "url_handle": "maya"}), True)
check("owner: tiktok url fallback wrong handle", S.owner_ok("tiktok", "maya", {"owner": "", "url_handle": "x"}), False)
check("owner: instagram has no fallback", S.owner_ok("instagram", "maya", {"owner": "", "url_handle": "maya"}), False)
check("owner: no read", S.owner_ok("tiktok", "maya", None), False)

NAME_RE = re.compile(r"^showcase/[a-f0-9]{12}-[a-f0-9]{16}\.jpg$")        # the regex supabase/showcase.sql checks
check("cover_name: matches the SQL regex", bool(NAME_RE.match(S.cover_name("0123456789ab"))), True)
check("cover_name: random part differs", S.cover_name("0123456789ab") != S.cover_name("0123456789ab"), True)

# ── the pass, against stubs ───────────────────────────────────────────────────────────────────────

REAL_FETCH, REAL_UPLOAD, REAL_OEMBED = S.fetch_cover, S.upload_cover, S.oembed_get
PUB = "0123456789ab"
OLD_COVER = f"showcase/{PUB}-{'a' * 16}.jpg"
OLD_UNREF = f"showcase/{'b' * 12}-{'c' * 16}.jpg"
YOUNG_UNREF = f"showcase/{'d' * 12}-{'e' * 16}.jpg"


class Rest:
    """Records every call; answers by path."""

    def __init__(self, cover_rows=None, due_rows=None, referenced=None, stored=None, first=200, patch=(200, [{"id": 1}])):
        self.calls = []
        self.cover_rows, self.due_rows = cover_rows or [], due_rows or []
        self.referenced, self.stored, self.first, self.patch = referenced or [], stored or [], first, patch

    def __call__(self, key, path, method="GET", body=None, prefer=None):
        self.calls.append((method, path, body))
        if method == "GET" and "cover_path=is.null" in path:
            return self.first, (self.cover_rows if self.first == 200 else None)
        if method == "GET" and "check_status=eq.ok" in path:
            return 200, self.due_rows
        if method == "GET" and "cover_path=not.is.null" in path:
            return 200, [{"cover_path": p} for p in self.referenced]
        if method == "POST" and "/storage/v1/object/list/" in path:
            return 200, self.stored
        if method == "PATCH" and "id=eq." in path:
            return self.patch
        if method == "DELETE":
            return 200, {"message": "ok"}
        return 201, None

    def of(self, method, needle):
        return [c for c in self.calls if c[0] == method and needle in c[1]]


def entry(**kw):
    e = {"id": 7, "pub_id": PUB, "kind": "agency", "platform": "tiktok", "handle": "maya",
         "url": "https://www.tiktok.com/@maya/video/7000000000001", "added_at": ago(days=2), "posted_at": None, "check_fails": 0}
    e.update(kw)
    return e


TT_GOOD = {"uploader": "maya", "view_count": 1000, "timestamp": int((NOW - timedelta(days=3)).timestamp()),
           "thumbnail": "https://p16-sign.tiktokcdn-us.com/x.webp"}


def make_T(rest, queued=False, ig=True, tt=TT_GOOD, items=None):
    calls = {"ytdlp": 0, "apify": 0}

    def ytdlp(args, timeout):
        calls["ytdlp"] += 1
        return tt

    def apify(body):
        calls["apify"] += 1
        return items

    T = types.SimpleNamespace(
        UA="ua", rest=rest, ytdlp_json=ytdlp, apify_run=apify, ig_gate=lambda tier: ig,
        follower_read=lambda platform, handle: {"uid": "1", "followers": 4321},
        P=types.SimpleNamespace(queued_work=lambda key: queued, apify_item_views=S.P.apify_item_views))
    return T, calls


S.oembed_get = lambda T, url: (200, {"thumbnail_url": "https://p16-sign.tiktokcdn-us.com/x.jpeg", "author_unique_id": "maya"})
S.fetch_cover = lambda url, ua=None: b"j" * 800
S.upload_cover = lambda key, path, blob: True

# a cover pass on an approved entry
r = Rest(cover_rows=[entry()])
T, _ = make_T(r)
stats = S.showcase_pass("k", NOW, T=T)
patches = r.of("PATCH", "id=eq.7")
check("cover: covers counted", stats["covers"], 1)
check("cover: PATCH is guarded by status=eq.approved", "status=eq.approved" in patches[0][1], True)
check("cover: body check_status ok", patches[0][2]["check_status"], "ok")
check("cover: body cover_path is valid", bool(NAME_RE.match(patches[0][2]["cover_path"])), True)
check("cover: posted_at filled from the read", bool(patches[0][2].get("posted_at")), True)
check("cover: next_measure_at is +24h for a young agency entry", patches[0][2]["next_measure_at"], "2026-10-06T12:00:00Z")
pts = r.of("POST", "lynxr_showcase_points")
check("cover: one point inserted", len(pts), 1)
check("cover: the point has day computed", pts[0][2]["day"], 3)
check("cover: the point has views and followers", (pts[0][2]["views"], pts[0][2]["followers"]), (1000, 4321))
check("cover: a checked_ok log row, no detail", [c[2]["action"] for c in r.of("POST", "lynxr_showcase_log")], ["checked_ok"])
check("cover: the log row is the pipeline's", r.of("POST", "lynxr_showcase_log")[0][2]["actor_role"], "pipeline")

# withdrawn while the cover was being fetched: the guarded PATCH matches nothing, and the file comes straight back down
r = Rest(cover_rows=[entry()], patch=(200, []))
stats = S.showcase_pass("k", NOW, T=make_T(r)[0])
check("race: no cover counted", stats["covers"], 0)
check("race: the uploaded file is deleted again", len(r.of("DELETE", "/storage/v1/object/lynxr-covers/showcase/")), 1)
check("race: no point stored", len(r.of("POST", "lynxr_showcase_points")), 0)

# unreadable three times in a row
S.oembed_get = lambda T, url: (0, None)
for fails, want_failed in ((0, False), (1, False), (2, True)):
    r = Rest(cover_rows=[entry(check_fails=fails)])
    stats = S.showcase_pass("k", NOW, T=make_T(r, tt=None)[0])
    body = r.of("PATCH", "id=eq.7")[0][2]
    check(f"unreadable: fail #{fails + 1} -> failed={want_failed}", body.get("check_status") == "failed", want_failed)
    check(f"unreadable: fail #{fails + 1} counts", body["check_fails"], fails + 1)
    check(f"unreadable: fail #{fails + 1} stat", stats["failed"], 1 if want_failed else 0)

# gone: yt-dlp failed and oEmbed answers 404 -> not_found at once
S.oembed_get = lambda T, url: (404, None)
r = Rest(cover_rows=[entry()])
stats = S.showcase_pass("k", NOW, T=make_T(r, tt=None)[0])
check("gone: not_found at once", r.of("PATCH", "id=eq.7")[0][2]["check_status"], "not_found")
check("gone: stat", stats["not_found"], 1)

# someone else's video
S.oembed_get = lambda T, url: (0, None)
r = Rest(cover_rows=[entry()])
stats = S.showcase_pass("k", NOW, T=make_T(r, tt={**TT_GOOD, "uploader": "someone"})[0])
check("mismatch: marked", r.of("PATCH", "id=eq.7")[0][2]["check_status"], "mismatch")
check("mismatch: stat", stats["mismatch"], 1)
check("mismatch: nothing uploaded or measured", len(r.of("POST", "lynxr_showcase_points")), 0)

# an Instagram entry the budget gate refuses
r = Rest(cover_rows=[entry(platform="instagram", url="https://www.instagram.com/reel/AbC1234/")])
T, calls = make_T(r, ig=False)
stats = S.showcase_pass("k", NOW, T=T)
check("instagram: budget skip counted", stats["budget_skips"], 1)
check("instagram: apify_run not called", calls["apify"], 0)
check("instagram: entry left untouched", len(r.of("PATCH", "id=eq.7")), 0)

# an Instagram entry that is read
IG_ITEM = {"ownerUsername": "Maya", "videoPlayCount": 5000, "timestamp": ago(days=2), "displayUrl": "https://scontent.cdninstagram.com/a.jpg"}
r = Rest(cover_rows=[entry(platform="instagram", url="https://www.instagram.com/reel/AbC1234/")])
T, calls = make_T(r, items=[IG_ITEM])
stats = S.showcase_pass("k", NOW, T=T)
check("instagram: read and covered", (stats["covers"], calls["apify"]), (1, 1))
check("instagram: views from the play count", r.of("POST", "lynxr_showcase_points")[0][2]["views"], 5000)

# an Instagram refusal means the post is gone
r = Rest(cover_rows=[entry(platform="instagram", url="https://www.instagram.com/reel/AbC1234/")])
stats = S.showcase_pass("k", NOW, T=make_T(r, items=[{"error": "not_found"}])[0])
check("instagram: an error item is not_found", stats["not_found"], 1)

# measure: an 'ok' entry that is due
S.oembed_get = lambda T, url: (200, {"thumbnail_url": "https://p16-sign.tiktokcdn-us.com/x.jpeg", "author_unique_id": "maya"})
r = Rest(due_rows=[entry(posted_at=ago(days=3))])
stats = S.showcase_pass("k", NOW, T=make_T(r)[0])
check("measure: counted", stats["measured"], 1)
check("measure: a point is stored with its day", r.of("POST", "lynxr_showcase_points")[0][2]["day"], 3)
body = r.of("PATCH", "id=eq.7")[0][2]
check("measure: next due is set and failures reset", (body["next_measure_at"], body["check_fails"]), ("2026-10-06T12:00:00Z", 0))
check("measure: PATCH is guarded", "status=eq.approved" in r.of("PATCH", "id=eq.7")[0][1], True)

# measure: the video is gone -> hidden at once, cover reference dropped
S.oembed_get = lambda T, url: (404, None)
r = Rest(due_rows=[entry(posted_at=ago(days=3))])
stats = S.showcase_pass("k", NOW, T=make_T(r, tt=None)[0])
body = r.of("PATCH", "id=eq.7")[0][2]
check("measure gone: not_found and no cover reference", (body["check_status"], body["cover_path"]), ("not_found", None))

# the sweep: only unreferenced objects older than 600s
S.oembed_get = lambda T, url: (200, None)
stored = [{"name": OLD_COVER.split("/")[1], "created_at": ago(hours=5)},
          {"name": OLD_UNREF.split("/")[1], "created_at": ago(hours=5)},
          {"name": YOUNG_UNREF.split("/")[1], "created_at": ago(seconds=30)}]
r = Rest(referenced=[OLD_COVER], stored=stored)
stats = S.showcase_pass("k", NOW, T=make_T(r)[0])
deleted = [c[1] for c in r.of("DELETE", "/storage/")]
check("sweep: deletes only the old unreferenced object", deleted, [f"/storage/v1/object/lynxr-covers/{OLD_UNREF}"])
check("sweep: swept count", stats["swept"], 1)
check("sweep: dangling cover_path of non-approved entries is cleared",
      len(r.of("PATCH", "status=neq.approved")), 1)

# the sweep never deletes when it could not read the references
class NoRefs(Rest):
    def __call__(self, key, path, method="GET", body=None, prefer=None):
        if method == "GET" and "cover_path=not.is.null" in path:
            self.calls.append((method, path, body))
            return 500, None
        return super().__call__(key, path, method, body, prefer)


r = NoRefs(stored=stored)
S.showcase_pass("k", NOW, T=make_T(r)[0])
check("sweep: no deletes on doubt", len(r.of("DELETE", "/storage/")), 0)

# dry: nothing written, no storage call at all
r = Rest(cover_rows=[entry()], due_rows=[entry(id=8)], referenced=[OLD_COVER], stored=stored)
T, calls = make_T(r)
stats = S.showcase_pass("k", NOW, dry=True, T=T)
check("dry: counts what is due", (stats["covers"], stats["measured"]), (1, 1))
check("dry: zero non-GET calls", [c for c in r.calls if c[0] != "GET"], [])
check("dry: zero storage calls", [c for c in r.calls if "/storage/" in c[1]], [])
check("dry: nothing fetched", calls["ytdlp"], 0)

# a queued creator script ends the pass before the first item
r = Rest(cover_rows=[entry()], due_rows=[entry(id=8)], stored=stored)
T, calls = make_T(r, queued=True)
stats = S.showcase_pass("k", NOW, T=T)
check("queued: nothing read", calls["ytdlp"], 0)
check("queued: nothing written", [c for c in r.calls if c[0] != "GET"], [])
check("queued: nothing counted", stats["covers"] + stats["measured"] + stats["swept"], 0)

# the SQL is not applied yet
r = Rest(first=404)
check("404: the pass returns {}", S.showcase_pass("k", NOW, T=make_T(r)[0]), {})
check("404: nothing else was asked", len(r.calls), 1)

# switched off, or no module to borrow
S.SHOWCASE = False
check("off: returns {}", S.showcase_pass("k", NOW, T=make_T(Rest())[0]), {})
S.SHOWCASE = True
check("no T: returns {}", S.showcase_pass("k", NOW, T=None), {})

# fetch_cover refuses a non-CDN host without any network
S.fetch_cover, S.upload_cover, S.oembed_get = REAL_FETCH, REAL_UPLOAD, REAL_OEMBED
check("fetch_cover: refuses a foreign host", S.fetch_cover("https://example.com/a.jpg"), None)
check("fetch_cover: refuses http", S.fetch_cover("http://p16.tiktokcdn.com/a.jpg"), None)

print("\nALL OK" if not FAILS else f"\n{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
