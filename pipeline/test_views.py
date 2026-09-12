"""Proof that absent stays absent and a genuine zero survives — the whole
point of the views change.

Pure-function tests plus one narrow stub: `fetch_meta` shells out to yt-dlp
via `subprocess.run`, so it is driven off recorded fixture JSON by replacing
`P.subprocess` (the name inside process_adaptations's own namespace) with a
fake, never the real `subprocess` module. No network.

Fixtures are the REAL shapes measured live 2026-08-19 (plan Appendix A):
Instagram never carries a `view_count` key at all, TikTok and YouTube do,
and the one live Facebook Reel returned a `view_count` 24x below what
Facebook's own title on the same response said. `view_count: 0` on a
trusted platform is the check the whole change turns on — the HANDOFF lesson
from `ownWordsTitle` applies: a fixture set that skips the uncomfortable
case proves nothing about it.

Run with

    ./venv/bin/python pipeline/test_views.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_adaptations as P  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


# =============================================================================
# fetch_meta, stubbed off recorded fixture shapes — the absent-vs-zero split
# =============================================================================

class _FakeCompleted:
    def __init__(self, returncode, stdout):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""


class _FakeSubprocess:
    """Stands in for the `subprocess` module inside P's namespace. `run` reads
    the URL off the end of the yt-dlp argv (fetch_meta's own command shape)
    and returns the canned result for it."""

    def __init__(self, by_url):
        self.by_url = by_url

    def run(self, cmd, **kwargs):
        url = cmd[-1]
        return self.by_url[url]


_ORIG_SUBPROCESS = P.subprocess

INSTAGRAM_URL = "https://instagram.com/reel/DVbnHPhju5V/"
INSTAGRAM_JSON = json.dumps({
    "id": "DVbnHPhju5V",
    "uploader_id": "stephyapps",
    "title": "Video by stephyapps",
    "description": "this is so goated omg…",
    # No "view_count" key at all — measured, not a stray None.
    "like_count": 70234,
    "comment_count": 241,
    "duration": None,
})

TIKTOK_URL = "https://tiktok.com/@lynxr.io/video/7674825452522933534"
TIKTOK_JSON = json.dumps({
    "id": "7674825452522933534",
    "uploader_id": "lynxr.io",
    "title": "a real tiktok title",
    "view_count": 191000,
    "like_count": 4200,
    "comment_count": 30,
    "duration": 21.0,
})

TIKTOK_ZERO_URL = "https://tiktok.com/@nobody/video/1"
TIKTOK_ZERO_JSON = json.dumps({
    "id": "1",
    "uploader_id": "nobody",
    "title": "a video nobody has watched yet",
    "view_count": 0,
    "like_count": 0,
    "comment_count": 0,
    "duration": 5.0,
})

FACEBOOK_URL = "https://facebook.com/reel/1195289147628387"
FACEBOOK_JSON = json.dumps({
    "id": "1195289147628387",
    "uploader_id": "someone",
    # Facebook's own title on this response said "9.8K views · 343
    # reactions" while view_count read 407 — measured 2026-08-19, stable
    # across two runs and both the /reel/ and m.facebook.com/watch forms.
    "title": "9.8K views · 343 reactions | When your trying to help "
             "your partner out…",
    "view_count": 407,
    "like_count": 343,
    "comment_count": 12,
    "duration": 30.0,
})

FAIL_URL = "https://tiktok.com/@gone/video/deleted"

P.subprocess = _FakeSubprocess({
    INSTAGRAM_URL: _FakeCompleted(0, INSTAGRAM_JSON),
    TIKTOK_URL: _FakeCompleted(0, TIKTOK_JSON),
    TIKTOK_ZERO_URL: _FakeCompleted(0, TIKTOK_ZERO_JSON),
    FACEBOOK_URL: _FakeCompleted(0, FACEBOOK_JSON),
    FAIL_URL: _FakeCompleted(1, ""),
})

try:
    ig = P.fetch_meta(INSTAGRAM_URL)
    check("instagram: views is None (absent, not coerced to 0)",
          ig["views"], None)
    check("instagram: 'views' key is present — absent, not missing",
          "views" in ig, True)
    check("instagram: likes are real (not suppressed)", ig["likes"], 70234)

    tt = P.fetch_meta(TIKTOK_URL)
    check("tiktok: views == 191000 (a trusted platform's real count)",
          tt["views"], 191000)

    ttz = P.fetch_meta(TIKTOK_ZERO_URL)
    check("tiktok: view_count 0 on a trusted platform survives as 0, not None — "
          "the check the whole change turns on",
          ttz["views"], 0)
    check("tiktok: 0 is not None (sanity — 0 == None must never accidentally hold)",
          ttz["views"] is None, False)

    fb = P.fetch_meta(FACEBOOK_URL)
    check("facebook: views is None — NOT TRUSTED (Assumption 2, 407 vs '9.8K views')",
          fb["views"], None)

    empty = P.fetch_meta(FAIL_URL)
    check("yt-dlp failure: fetch_meta returns {} (could not ask)", empty, {})
    check("{} and {'views': None, ...} stay distinguishable",
          empty == ig, False)
finally:
    P.subprocess = _ORIG_SUBPROCESS


# =============================================================================
# platform_of — hostname-matched, not a substring test
# =============================================================================

check("platform_of youtu.be", P.platform_of("https://youtu.be/x"), "youtube")
check("platform_of fb.watch", P.platform_of("https://fb.watch/x/"), "facebook")
check("platform_of fb.com", P.platform_of("https://fb.com/x"), "facebook")
check("platform_of vm.tiktok.com (subdomain)",
      P.platform_of("https://vm.tiktok.com/x"), "tiktok")
check("platform_of m.facebook.com/reel/1 (subdomain + path)",
      P.platform_of("https://m.facebook.com/reel/1"), "facebook")
check("platform_of a non-match with a spoofed query string is NOT tiktok "
      "(hostname match, not substring)",
      P.platform_of("https://evil.com/?ref=tiktok.com"), "other")


# =============================================================================
# source_metrics
# =============================================================================

check("source_metrics(...)['views'] is None when meta carries None",
      P.source_metrics({"views": None, "likes": 1, "comments": 2,
                         "duration": 3, "creator": "c", "title": "t"})["views"],
      None)
check("source_metrics(...)['views'] survives a real 0",
      P.source_metrics({"views": 0, "likes": 1, "comments": 2,
                         "duration": 3, "creator": "c", "title": "t"})["views"],
      0)
check("source_metrics falls back to src duration when meta has none",
      P.source_metrics({"views": 5}, fallback_duration=12.0)["duration"],
      12.0)


# =============================================================================
# upsert_metrics — the paste path must never blank a stored count
# =============================================================================

_um_no_count = P.upsert_metrics({"views": None, "likes": 1, "comments": 0,
                                  "duration": 5.0, "creator": "", "title": "t"})
check("upsert_metrics: no count -> 'views' key is left OUT of the body",
      "views" in _um_no_count, False)
check("upsert_metrics: no count -> metrics_at is None (due for the next sweep)",
      _um_no_count["metrics_at"], None)

_um_zero = P.upsert_metrics({"views": 0, "likes": 1, "comments": 0,
                              "duration": 5.0, "creator": "", "title": "t"})
check("upsert_metrics: a real 0 survives", _um_zero["views"], 0)
check("upsert_metrics: a real 0 still stamps metrics_at",
      isinstance(_um_zero["metrics_at"], str), True)

_um_5 = P.upsert_metrics({"views": 5, "likes": 1, "comments": 0,
                           "duration": 5.0, "creator": "", "title": "t"})
check("upsert_metrics: a real count survives", _um_5["views"], 5)


# =============================================================================
# apply_views — pure, hand-built entry lists
# =============================================================================

def entry(id_, status, url, views, has_meta=True):
    e = {"id": id_, "status": status, "sourceUrl": url}
    if has_meta:
        e["source"] = {"meta": {"views": views}}
    else:
        e["source"] = {}
    return e


VIDEO_A = "https://tiktok.com/@x/video/1"
VIDEO_A_ALT_QS = "https://tiktok.com/@x/video/1?is_from_webapp=1&sender_device=pc"
VIDEO_B = "https://tiktok.com/@other/video/2"
CANON_A = P.canon_url(VIDEO_A)
AT = "2026-08-19T00:00:00Z"

es = [
    entry("done", "done", VIDEO_A, 27),
    entry("queued", "queued", VIDEO_A, 27),
    entry("running", "running", VIDEO_A, 27),
    entry("no_meta", "done", VIDEO_A, None, has_meta=False),
    entry("already_31", "done", VIDEO_A, 31),
    entry("other_video", "done", VIDEO_B, 5),
    entry("diff_qs", "done", VIDEO_A_ALT_QS, 27),
]
changed = P.apply_views(es, CANON_A, 31, AT)
by_id = {e["id"]: e for e in es}

check("apply_views: a done entry is updated",
      by_id["done"]["source"]["meta"]["views"], 31)
check("apply_views: ...and stamped with metricsAt",
      by_id["done"]["source"]["meta"]["metricsAt"], AT)
check("apply_views: a queued entry is NOT updated",
      by_id["queued"]["source"]["meta"]["views"], 27)
check("apply_views: a running entry is NOT updated",
      by_id["running"]["source"]["meta"]["views"], 27)
check("apply_views: a source dict with no meta GETS one",
      by_id["no_meta"]["source"], {"meta": {"views": 31, "metricsAt": AT}})
check("apply_views: an unchanged count is re-stamped",
      by_id["already_31"]["source"]["meta"].get("metricsAt"), AT)
check("apply_views: an entry for a DIFFERENT video is untouched",
      by_id["other_video"]["source"]["meta"]["views"], 5)
check("apply_views: two entries for the same video with different query "
      "strings are BOTH matched via canon_url",
      by_id["diff_qs"]["source"]["meta"]["views"], 31)
check("apply_views: returns the count of entries ACTUALLY changed "
      "(done + no_meta + already_31 + diff_qs)",
      changed, 4)

es2 = [entry("d2", "done", VIDEO_A, 27)]
check("apply_views: views=None returns 0 (a refresh with no count is a no-op)",
      P.apply_views(es2, CANON_A, None, AT), 0)
check("apply_views: ...and touches nothing", es2[0]["source"]["meta"]["views"], 27)

es3 = [{"id": "nosrc", "status": "done", "sourceUrl": VIDEO_A}]
check("apply_views: an entry with no source key at all returns 0",
      P.apply_views(es3, CANON_A, 31, AT), 0)
check("apply_views: ...and gains no source key",
      "source" in es3[0], False)


# =============================================================================
# apify_item_views — the response contract, off the real recorded shapes
# measured 2026-08-19 (plan Appendix A)
# =============================================================================

check("apify_item_views: videoPlayCount off a real item",
      P.apify_item_views([{"shortCode": "DVbnHPhju5V", "videoPlayCount": 1757994,
                            "likesCount": 70233, "type": "Video"}]),
      1757994)
check("apify_item_views: an 'error' item is a refusal, not a measurement — "
      "the measured not-found shape, still billed",
      P.apify_item_views([{"error": "not_found",
                            "errorDescription": "Post does not exist",
                            "url": "..."}]),
      None)
check("apify_item_views: videoPlayCount None falls back to videoViewCount",
      P.apify_item_views([{"videoPlayCount": None, "videoViewCount": 1234}]),
      1234)
check("apify_item_views: a genuine 0 does NOT fall through to the fallback — "
      "the deliberate divergence from process_scraped.py:70's `or`",
      P.apify_item_views([{"videoPlayCount": 0, "videoViewCount": 999}]),
      0)
check("apify_item_views: -1 (hidden count) is ABSENT, mirroring likesCount == -1",
      P.apify_item_views([{"videoPlayCount": -1}]), None)
check("apify_item_views: a photo post carries no count field -> None",
      P.apify_item_views([{"type": "Image", "likesCount": 5}]), None)
check("apify_item_views: [] -> None", P.apify_item_views([]), None)
check("apify_item_views: None -> None", P.apify_item_views(None), None)


# =============================================================================
# video_views — the spend gate
# =============================================================================

class _FakeApify:
    """Stands in for P.apify_views. Records whether it was called, because
    half these checks are about money NOT being spent."""

    def __init__(self, value):
        self.value = value
        self.called = False

    def __call__(self, url):
        self.called = True
        return self.value


IG_URL = "https://instagram.com/reel/DVbnHPhju5V/"
TT_URL2 = "https://tiktok.com/@x/video/1"
FB_URL2 = "https://facebook.com/reel/1"

_ORIG_APIFY_VIEWS = P.apify_views
try:
    stub = _FakeApify(184221)
    P.apify_views = stub
    check("video_views: instagram + raw=None + paid=True -> the stub's value",
          P.video_views(IG_URL, None, paid=True), 184221)
    check("video_views: ...stub WAS called", stub.called, True)

    stub = _FakeApify(184221)
    P.apify_views = stub
    check("video_views: instagram + raw=None + paid=False -> None (default is free)",
          P.video_views(IG_URL, None, paid=False), None)
    check("video_views: ...stub was NOT called", stub.called, False)

    stub = _FakeApify(None)
    P.apify_views = stub
    check("video_views: instagram + paid=True, stub returns None -> None, not 0",
          P.video_views(IG_URL, None, paid=True), None)

    stub = _FakeApify(0)
    P.apify_views = stub
    check("video_views: instagram + paid=True, stub returns 0 -> 0 survives",
          P.video_views(IG_URL, None, paid=True), 0)

    stub = _FakeApify(999)
    P.apify_views = stub
    check("video_views: tiktok + raw=5 + paid=True -> 5, stub NOT called "
          "(free platform, no Apify)",
          P.video_views(TT_URL2, 5, paid=True), 5)
    check("video_views: ...stub was NOT called", stub.called, False)

    stub = _FakeApify(999)
    P.apify_views = stub
    check("video_views: tiktok + raw=None + paid=True -> None, stub NOT called",
          P.video_views(TT_URL2, None, paid=True), None)
    check("video_views: ...stub was NOT called", stub.called, False)

    stub = _FakeApify(999)
    P.apify_views = stub
    check("video_views: facebook + raw=407 + paid=True -> None, stub NOT called "
          "(Facebook suppression still holds through the new path)",
          P.video_views(FB_URL2, 407, paid=True), None)
    check("video_views: ...stub was NOT called", stub.called, False)
finally:
    P.apify_views = _ORIG_APIFY_VIEWS


# =============================================================================
# fetch_meta — through the existing Instagram fixture, with the paid kwarg
# =============================================================================

P.subprocess = _FakeSubprocess({INSTAGRAM_URL: _FakeCompleted(0, INSTAGRAM_JSON)})
try:
    no_kwarg = P.fetch_meta(INSTAGRAM_URL)
    check("fetch_meta(INSTAGRAM_URL) with no kwarg: views is None",
          no_kwarg["views"], None)

    stub = _FakeApify(184221)
    P.apify_views = stub
    try:
        P.fetch_meta(INSTAGRAM_URL)
        check("fetch_meta(INSTAGRAM_URL) with no kwarg: stub NOT called",
              stub.called, False)
    finally:
        P.apify_views = _ORIG_APIFY_VIEWS

    stub = _FakeApify(184221)
    P.apify_views = stub
    try:
        paid = P.fetch_meta(INSTAGRAM_URL, paid=True)
        check("fetch_meta(INSTAGRAM_URL, paid=True): views == stub's value",
              paid["views"], 184221)
        check("fetch_meta(INSTAGRAM_URL, paid=True): likes still real — the "
              "enrichment adds a field and changes nothing else",
              paid["likes"], 70234)
        check("fetch_meta(INSTAGRAM_URL, paid=True): 'views' key still present",
              "views" in paid, True)
    finally:
        P.apify_views = _ORIG_APIFY_VIEWS
finally:
    P.subprocess = _ORIG_SUBPROCESS


# =============================================================================
# apify_budget_ok — fail-closed, no real network call
# =============================================================================

class _FakeHTTPResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


_ORIG_URLOPEN = P.urllib.request.urlopen
try:
    def _raise(*a, **kw):
        raise OSError("simulated network failure")

    P.urllib.request.urlopen = _raise
    P._APIFY_BUDGET = {"at": 0.0, "ok": None}
    check("apify_budget_ok: limits call fails -> False (fails closed)",
          P.apify_budget_ok("fake-token"), False)

    def _ok(*a, **kw):
        return _FakeHTTPResponse({"data": {"current": {"monthlyUsageUsd": 1},
                                            "limits": {"maxMonthlyUsageUsd": 50}}})

    P.urllib.request.urlopen = _ok
    P._APIFY_BUDGET = {"at": 0.0, "ok": None}
    check("apify_budget_ok: under ceiling -> True",
          P.apify_budget_ok("fake-token"), True)
finally:
    P.urllib.request.urlopen = _ORIG_URLOPEN
    P._APIFY_BUDGET = {"at": 0.0, "ok": None}


print()
def _urllib_unquote(s):
    import urllib.parse
    return urllib.parse.unquote(s)


# ---------------------------------------------------------------------------
# views_or_clause: the selection rule that hid fresh pastes for a week.
#
# fetch_meta stamps metrics_at at PASTE time while leaving views None (the
# paste path never pays for Apify), so a brand-new Instagram row was neither
# null nor older than 168h and the sweep could not see it until 2026-08-26.
# These lock in the bounded retry that fixes it.
# ---------------------------------------------------------------------------
import re as _re
from datetime import datetime as _dt, timezone as _tz

_NOW = _dt(2026, 8, 19, 12, 0, 0, tzinfo=_tz.utc)
_free = P.views_or_clause(_NOW, 24)
_paid = P.views_or_clause(_NOW, 168, 2, 24)

check("free pool: no retry branch (yt-dlp costs nothing to re-ask)",
      "and(" in _free, False)
check("free pool: still selects never-fetched rows",
      "metrics_at.is.null" in _free, True)
check("paid pool: retry branch present", "and(" in _paid, True)
check("paid pool: retry branch keys on views IS NULL",
      "views.is.null" in _paid, True)
check("paid pool: retry branch bounded by row age",
      "first_seen_at.gt." in _paid, True)
check("paid pool: three distinct windows (stale, age-bound, retry)",
      len(set(_re.findall(r"(?:lt|gt)\.([^,)]+)", _paid))), 3)
check("paid pool: ordinary staleness clause survives",
      "metrics_at.is.null" in _paid, True)

# The retry window must be the LONGER of the two short windows — a row is
# eligible while it is younger than the window and its last attempt is older
# than the retry clock. Getting these backwards would retry nothing.
_stamps = _re.findall(r"(?:lt|gt)\.([^,)]+)", _paid)
_dec = sorted(_urllib_unquote(s) for s in _stamps)
check("paid pool: staleness stamp is the oldest of the three",
      _dec[0].startswith("2026-08-12"), True)

# Zero/absent retry config must degrade to the plain two-clause form, so a
# platform can be moved between pools without a silent behaviour change.
check("retry config of 0 degrades to the free form",
      P.views_or_clause(_NOW, 168, 0, 0), P.views_or_clause(_NOW, 168))

# ---------------------------------------------------------------------------
# views_or_clause taper (2026-09-12): the max_age_h clock only applies while
# first_seen_at is younger than taper_after_h; older rows fall back to
# taper_max_age_h. Both 0 = no taper, output identical to before.
# ---------------------------------------------------------------------------
import urllib.parse

_taper = P.views_or_clause(_NOW, 168, 2, 24, 720, 720)
check("taper: retry branch's and(...) is joined by the taper's own and(...)",
      "and(first_seen_at.gt." in _taper, True)
check("taper: three metrics_at.lt. windows (taper, retry, taper-max-age)",
      _taper.count("metrics_at.lt."), 3)
check("taper: 720h-before-now stamp is present (taper_after_h/taper_max_age_h)",
      urllib.parse.quote("2026-07-20T12:00:00Z", safe="") in _taper, True)
check("taper: 0/0 degrades to the untapered form",
      P.views_or_clause(_NOW, 168, 2, 24, 0, 0) == P.views_or_clause(_NOW, 168, 2, 24), True)


# =============================================================================
# refresh_views (2026-09-12 rework) — yield to a paste, skip orphans, never
# blank a stored count, taper. Stubs P.sb, P.fetch_meta, P.queued_work and
# P.refresh_entry_views; restores all four in `finally`.
# =============================================================================

_ORIG_SB = P.sb
_ORIG_FETCH_META = P.fetch_meta
_ORIG_QUEUED_WORK = P.queued_work
_ORIG_REFRESH_ENTRY_VIEWS = P.refresh_entry_views

_RV_INSTAGRAM_ROW = {"canonical_url": "instagram.com/reel/x", "url": INSTAGRAM_URL,
                     "platform": "instagram", "views": 3715, "metrics_at": None}


def _make_rv_sb(holders, patches):
    def _sb(key, path, method="GET", body=None, raw=False):
        if method == "PATCH":
            patches.append((path, body))
            return None
        if "lynxr_sources?select=" in path and "platform=in.(instagram)" in path:
            return [_RV_INSTAGRAM_ROW]
        if "lynxr_sources?select=" in path:
            return []
        if path.startswith("/rest/v1/lynxr_creators?select=id&or="):
            return holders
        raise AssertionError(f"unexpected sb call: {method} {path}")
    return _sb


try:
    # --- (a) yield: a paste is waiting, so nothing is fetched or paid for ---
    patches = []
    P.sb = _make_rv_sb([], patches)
    P.queued_work = lambda k: True

    def _fm_must_not_run(*a, **kw):
        raise AssertionError("fetch_meta must not run while yielding")
    P.fetch_meta = _fm_must_not_run
    P.refresh_views("k", 3)
    check("refresh_views (a) yield: no PATCH issued", patches, [])

    # --- (b) orphan: nobody holds the video — clock moves, nothing is fetched ---
    patches = []
    P.sb = _make_rv_sb([], patches)
    P.queued_work = lambda k: False

    def _fm_must_not_run2(*a, **kw):
        raise AssertionError("fetch_meta must not run on an orphan row")
    P.fetch_meta = _fm_must_not_run2
    P.refresh_views("k", 3)
    check("refresh_views (b) orphan: exactly one PATCH", len(patches), 1)
    check("refresh_views (b) orphan: PATCH body is metrics_at only",
          sorted(patches[0][1].keys()) if patches else None, ["metrics_at"])

    # --- (c) no count comes back: the stored count is kept, nothing propagates ---
    patches = []
    P.sb = _make_rv_sb([{"id": "c1"}], patches)
    P.queued_work = lambda k: False
    P.fetch_meta = lambda url, paid=False: {
        "video_id": "x", "creator": "", "title": "t", "views": None,
        "likes": 1, "comments": 0, "duration": 5.0,
        "metricsAt": "2026-09-12T00:00:00Z"}
    _rev_calls = []
    P.refresh_entry_views = lambda *a: _rev_calls.append(a) or 0
    P.refresh_views("k", 3)
    check("refresh_views (c) no count: exactly one PATCH", len(patches), 1)
    check("refresh_views (c) no count: PATCH body has no 'views' key",
          "views" in (patches[0][1] if patches else {}), False)
    check("refresh_views (c) no count: PATCH body has metrics_at",
          "metrics_at" in (patches[0][1] if patches else {}), True)
    check("refresh_views (c) no count: refresh_entry_views NOT called",
          _rev_calls, [])

    # --- (d) a count propagates ---
    patches = []
    P.sb = _make_rv_sb([{"id": "c1"}], patches)
    P.queued_work = lambda k: False
    P.fetch_meta = lambda url, paid=False: {
        "video_id": "x", "creator": "", "title": "t", "views": 1234,
        "likes": 1, "comments": 0, "duration": 5.0,
        "metricsAt": "2026-09-12T00:00:00Z"}
    _rev_calls = []
    P.refresh_entry_views = lambda *a: _rev_calls.append(a) or 1
    P.refresh_views("k", 3)
    check("refresh_views (d) count propagates: PATCH body views == 1234",
          (patches[0][1] if patches else {}).get("views"), 1234)
    check("refresh_views (d) count propagates: refresh_entry_views called once",
          len(_rev_calls), 1)
    check("refresh_views (d) count propagates: refresh_entry_views args",
          _rev_calls[0] if _rev_calls else None,
          ("k", "c1", P.canon_url(INSTAGRAM_URL), 1234, "2026-09-12T00:00:00Z"))

    # --- (e) fetch failure: {} means "could not ask" — clock moves, no count ---
    patches = []
    P.sb = _make_rv_sb([{"id": "c1"}], patches)
    P.queued_work = lambda k: False
    P.fetch_meta = lambda url, paid=False: {}
    _rev_calls = []
    P.refresh_entry_views = lambda *a: _rev_calls.append(a) or 0
    P.refresh_views("k", 3)
    check("refresh_views (e) fetch failure: exactly one PATCH", len(patches), 1)
    check("refresh_views (e) fetch failure: PATCH body is metrics_at only",
          sorted(patches[0][1].keys()) if patches else None, ["metrics_at"])
    check("refresh_views (e) fetch failure: refresh_entry_views NOT called",
          _rev_calls, [])

    # --- queued_work itself (the real function, not the stub above) ---
    P.queued_work = _ORIG_QUEUED_WORK

    def _sb_raises(key, path, method="GET", body=None, raw=False):
        raise OSError("simulated transport failure")
    P.sb = _sb_raises
    check("queued_work: a probe error yields (fails toward yielding)",
          P.queued_work("k"), True)

    _qw_path = {}

    def _sb_empty(key, path, method="GET", body=None, raw=False):
        _qw_path["path"] = path
        return []
    P.sb = _sb_empty
    check("queued_work: an empty probe means nothing queued", P.queued_work("k"), False)
    check("queued_work: the probe it issues is capped at one row",
          "limit=1" in _qw_path.get("path", ""), True)

    def _sb_one(key, path, method="GET", body=None, raw=False):
        return [{"id": "x"}]
    P.sb = _sb_one
    check("queued_work: a queued creator means yield", P.queued_work("k"), True)
finally:
    P.sb = _ORIG_SB
    P.fetch_meta = _ORIG_FETCH_META
    P.queued_work = _ORIG_QUEUED_WORK
    P.refresh_entry_views = _ORIG_REFRESH_ENTRY_VIEWS


if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
