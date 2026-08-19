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
check("apply_views: an entry with no source.meta is NOT touched",
      by_id["no_meta"]["source"], {})
check("apply_views: an entry whose value already matches is NOT reported changed "
      "(no-op write)",
      by_id["already_31"]["source"]["meta"].get("metricsAt"), None)
check("apply_views: an entry for a DIFFERENT video is untouched",
      by_id["other_video"]["source"]["meta"]["views"], 5)
check("apply_views: two entries for the same video with different query "
      "strings are BOTH matched via canon_url",
      by_id["diff_qs"]["source"]["meta"]["views"], 31)
check("apply_views: returns the count of entries ACTUALLY changed "
      "(done + diff_qs, not already_31)",
      changed, 2)


print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
