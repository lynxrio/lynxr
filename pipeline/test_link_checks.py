"""Checks on the links lynxr refuses, how a failed read is classified, and how
long a failed read keeps being retried.

Pure-function tests: no network, no model calls, no Supabase. Run with

    ./venv/bin/python pipeline/test_link_checks.py

Why this exists: on 2026-10-04 a creator pasted a cut-off Instagram link
(.../reels/OB5/). Nothing checked the shortcode, yt-dlp said "There is no video
in this post", no rule matched, it became a generic retryable error, and the
entry was re-run with no schedule until it was "given up" and paged the owner.
The fixture pipeline/link_shapes.json is shared with tools/test_link_shape.mjs
(the browser's rules) so the paste box and the worker cannot disagree.

  A  link_shape()/supported_url()/fetch_url() against the shared fixture
  B  refuse_bad_links(): refused at claim time, before any charge
  C  fetch_class(): input / unclear / ours, from real strings only
  D  apify_fetch(): the Instagram fallback, stubbed
  E  process_group(): the retry window end to end
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_adaptations as P  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


def ago(minutes):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


# ---- Part A: the shared fixture -------------------------------------------
FIXTURE = json.loads((Path(__file__).resolve().parent / "link_shapes.json").read_text())
check("fixture: has cases", len(FIXTURE) > 30, True)
for _c in FIXTURE:
    _u, _want = _c["url"], _c["expect"]
    if _want == "off_platform":
        check(f"A off_platform: {_u}", P.supported_url(_u), False)
        check(f"A off_platform verdict: {_u}", P.link_verdict(_u), "off_platform")
    else:
        check(f"A supported: {_u}", P.supported_url(_u), True)
        check(f"A shape {_want}: {_u}", P.link_shape(_u), _want)
        check(f"A verdict: {_u}", P.link_verdict(_u), P.LINK_NOTE.get(_want))

check("A fetch_url: m.tiktok.com -> www.",
      P.fetch_url("https://m.tiktok.com/@leenabhushan/video/6748451240264420610?x=1"),
      "https://www.tiktok.com/@leenabhushan/video/6748451240264420610?x=1")
check("A fetch_url: instagram unchanged",
      P.fetch_url("https://www.instagram.com/reel/CDUMkliABpa/"),
      "https://www.instagram.com/reel/CDUMkliABpa/")
check("A fetch_url: vm.tiktok.com unchanged",
      P.fetch_url("https://vm.tiktok.com/ZTR45GpSF/"), "https://vm.tiktok.com/ZTR45GpSF/")

# Every new sentence fits note_text()'s 200-character cut and carries no
# provider needle (test_ai_retry.py sweeps the whole registry too).
for _k in ("link_cut_off", "link_profile", "link_photo", "link_page", "fetch_no_video",
           "fetch_unreachable", "fetch_retrying", "read_ours"):
    _t, _kind = P.CREATOR_NOTES[_k]
    check(f"A note fits 200 chars: {_k}", len(_t) <= 200, True)


# ---- Part B: refuse_bad_links -----------------------------------------------
def _wants(a):
    return P.wants_work(a, cooldown_hours=6, lease_minutes=30, min_age_seconds=0, redo_ai=False)


_cut = {"id": "b0000001", "status": "queued", "sourceUrl": "https://www.instagram.com/reels/OB5/"}
_ok = {"id": "b0000002", "status": "queued", "sourceUrl": "https://www.instagram.com/reel/CDUMkliABpa/"}
_yt = {"id": "b0000003", "status": "queued", "sourceUrl": "https://www.youtube.com/shorts/aqz-KE-bpKQ"}
_done = {"id": "b0000004", "status": "done", "sourceUrl": "https://www.instagram.com/reels/OB5/"}
_list = [_cut, _ok, _yt, _done]
_got = P.refuse_bad_links(_list, _wants)
check("B refused ids", [a["id"] for a in _got], ["b0000001", "b0000003"])
check("B cut-off: status", _cut["status"], "error")
check("B cut-off: note", _cut["note"], P.note_text("link_cut_off"))
check("B cut-off: noteKind", _cut["noteKind"], "link")
check("B cut-off: final", _cut.get("final"), True)
check("B cut-off: finalWhy", _cut.get("finalWhy"), "wall")
check("B cut-off: retryable False", _cut["retryable"], False)
check("B cut-off: fetchClass input", _cut["fetchClass"], "input")
check("B cut-off: wants_work False afterwards", _wants(_cut), False)
check("B valid reel untouched", _ok, {"id": "b0000002", "status": "queued",
                                      "sourceUrl": "https://www.instagram.com/reel/CDUMkliABpa/"})
check("B youtube: note off_platform", _yt["note"], P.note_text("off_platform"))
check("B youtube: final wall", (_yt.get("final"), _yt.get("finalWhy")), (True, "wall"))
check("B done entry untouched", _done, {"id": "b0000004", "status": "done",
                                        "sourceUrl": "https://www.instagram.com/reels/OB5/"})
check("B second call returns []", P.refuse_bad_links(_list, _wants), [])
# --redo-ai makes a final entry wanted again; it must not be rewritten.
_redo = lambda a: P.wants_work(a, cooldown_hours=6, lease_minutes=30, min_age_seconds=0, redo_ai=True)  # noqa: E731
check("B redo-ai: already-refused not rewritten", P.refuse_bad_links(_list, _redo), [])
# A stale fetch marker and "still trying" flag are cleared by a refusal.
_stale = {"id": "b0000005", "status": "queued", "retrying": True, "fetchFail": {"tries": 2},
          "sourceUrl": "https://www.tiktok.com/@leenabhushan"}
P.refuse_bad_links([_stale], _wants)
check("B refusal clears fetchFail and retrying",
      ("fetchFail" in _stale, "retrying" in _stale), (False, False))
check("B profile note", _stale["note"], P.note_text("link_profile"))


# ---- Part C: fetch_class — REAL strings only --------------------------------
_REAL = [
    # input
    ("ERROR: [Instagram] OB5: There is no video in this post", ("fetch_no_video", "input")),
    ("ERROR: [Instagram] BsOGulcndj-: There is no video in this post", ("fetch_no_video", "input")),
    ("ERROR: [TikTok] 7524866777004723486: This post may not be comfortable for some audiences. "
     "Log in for access. Use --cookies-from-browser", ("fetch_age", "input")),
    ("ERROR: [instagram:story] You need to log in to access this content. Use --cookies-from-browser "
     "or --cookies for the authentication.", ("fetch_private", "input")),
    ("ERROR: Unsupported URL: https://www.tiktok.com/?_r=1", ("fetch_unreadable", "input")),
    ("apify not_found: Post does not exist", ("fetch_gone", "input")),
    # unclear
    ("ERROR: [TikTok] 671833539: Your IP address is blocked from accessing this post",
     ("fetch_unreachable", "unclear")),
    ("ERROR: [Instagram] DVCUrksDzm: Instagram sent an empty media response. Check if this post is "
     "accessible in your browser without being logged-in. If it is not, then u",
     ("fetch_unreachable", "unclear")),
    ("ERROR: [generic] 7670598391079963935: Unable to download webpage: HTTP Error 404: Not Found "
     "(caused by <HTTPError 404: Not Found>)", ("fetch_unreachable", "unclear")),
    ("apify no_items: Empty or private data for provided input", ("fetch_unreachable", "unclear")),
    # ours
    ("ERROR: [TikTok] 1: Unexpected response from webpage request", ("fetch_ours", "ours")),
    ("download timed out", ("fetch_ours", "ours")),
    ("HTTPSConnectionPool(host='x'): Read timed out.", ("fetch_ours", "ours")),
    ("ERROR: something nobody has seen before", ("fetch_ours", "ours")),
]
for _s, _want in _REAL:
    check(f"C fetch_class: {_s[:60]}", P.fetch_class(_s), _want)
check("C wrapper: no-video -> fetch_unreadable, permanent",
      P.fetch_failure("ERROR: [Instagram] OB5: There is no video in this post"), ("fetch_unreadable", False))
check("C wrapper: ip-blocked -> fetch_generic, retryable",
      P.fetch_failure("ERROR: [TikTok] 671833539: Your IP address is blocked from accessing this post"),
      ("fetch_generic", True))
check("C wrapper: ours -> fetch_generic, retryable",
      P.fetch_failure("ERROR: [TikTok] 1: Unexpected response from webpage request"), ("fetch_generic", True))
# The wrapper only ever returns keys the agency app (CB_ERROR_TEXT) already knows.
_old_keys = {"fetch_age", "fetch_private", "fetch_gone", "fetch_unreadable", "fetch_geo",
             "fetch_bot", "fetch_generic"}
check("C wrapper only returns old keys",
      all(P.fetch_failure(s)[0] in _old_keys for s, _ in _REAL), True)


# ---- Part D: apify_fetch (no network: stubs, restored in finally) -----------
import io
import tempfile

_ORIG_ITEMS, _ORIG_URLOPEN = P.apify_post_items, P.urllib.request.urlopen


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


try:
    with tempfile.TemporaryDirectory() as _td:
        _td = Path(_td)
        P.apify_post_items = lambda url: [{"error": "not_found", "errorDescription": "Post does not exist"}]
        _p, _v = P.apify_fetch("https://www.instagram.com/p/BsOGulcndj-/", _td)
        check("D error item: no file", _p, None)
        check("D error item: verdict classifies as fetch_gone", P.fetch_class(_v), ("fetch_gone", "input"))

        P.apify_post_items = lambda url: [{"type": "Video"}]
        _p, _v = P.apify_fetch("https://www.instagram.com/p/BsOGulcndj-/", _td)
        check("D no videoUrl: no file", _p, None)
        check("D no videoUrl: verdict classifies as fetch_no_video", P.fetch_class(_v), ("fetch_no_video", "input"))

        _asked = []

        def _fake_urlopen(req, timeout=None, context=None):
            _asked.append((req.full_url, req.get_header("User-agent"), timeout))
            return _Resp(b"\x00" * 2500)

        P.apify_post_items = lambda url: [{"type": "Video", "videoUrl": "https://cdn.test/v.mp4"}]
        P.urllib.request.urlopen = _fake_urlopen
        _p, _v = P.apify_fetch("https://www.instagram.com/reel/CDUMkliABpa/", _td)
        check("D videoUrl: verdict None", _v, None)
        check("D videoUrl: file written", (_p is not None and Path(_p).read_bytes() == b"\x00" * 2500), True)
        check("D videoUrl: asked the video url with a UA and the timeout",
              _asked, [("https://cdn.test/v.mp4", "Mozilla/5.0", P.APIFY_VIDEO_TIMEOUT_S)])

        # Over the size ceiling: aborted, partial file removed.
        _ORIG_MAX = P.APIFY_VIDEO_MAX_BYTES
        P.APIFY_VIDEO_MAX_BYTES = 1000
        try:
            _p, _v = P.apify_fetch("https://www.instagram.com/reel/CDUMkliABpa/", _td)
        finally:
            P.APIFY_VIDEO_MAX_BYTES = _ORIG_MAX
        check("D oversize: (None, None)", (_p, _v), (None, None))
        check("D oversize: no partial file left", (_td / "v.mp4").exists(), False)

        # A non-http videoUrl is never opened.
        _asked.clear()
        P.apify_post_items = lambda url: [{"type": "Video", "videoUrl": "file:///etc/hosts"}]
        _p, _v = P.apify_fetch("https://www.instagram.com/reel/CDUMkliABpa/", _td)
        check("D file:// videoUrl refused, never opened", (_p, _v, _asked), (None, None, []))

        P.apify_post_items = lambda url: None
        check("D None items -> (None, None)", P.apify_fetch("https://www.instagram.com/reel/CDUMkliABpa/", _td), (None, None))
        P.apify_post_items = lambda url: []
        check("D empty items -> (None, None)", P.apify_fetch("https://www.instagram.com/reel/CDUMkliABpa/", _td), (None, None))
finally:
    P.apify_post_items, P.urllib.request.urlopen = _ORIG_ITEMS, _ORIG_URLOPEN

check("D stubs restored", (P.apify_post_items is _ORIG_ITEMS, P.urllib.request.urlopen is _ORIG_URLOPEN), (True, True))
# apify_views still reads the count through the shared lookup.
_ORIG_ITEMS = P.apify_post_items
try:
    P.apify_post_items = lambda url: [{"videoPlayCount": 1234}]
    check("D apify_views reads the count via apify_post_items", P.apify_views("https://x"), 1234)
    P.apify_post_items = lambda url: None
    check("D apify_views None when it could not ask", P.apify_views("https://x"), None)
finally:
    P.apify_post_items = _ORIG_ITEMS


# ---- Part E: the retry window, end to end through process_group --------------
_E_ORIG = {n: getattr(P, n) for n in ("sb", "fetch_meta", "upsert_source", "upsert_video", "refund",
                                       "fill_source", "record_cost", "extract_format", "run_entry")}
_E_NOTES = {k: v[0] for k, v in P.CREATOR_NOTES.items()}
_refunds = []
_FINAL_SEEN = []   # every entry this part leaves final, for the invariant at the end


def _drive(entry, make_exc, max_passes=20, heal_after=None):
    """Run `entry` through process_group until wants_work() says stop. Returns
    the per-pass snapshots (status/retrying/final/note) taken after each pass."""
    state = {"calls": 0}

    def _fill(a, aclient, key, notes, timings, publish=None, usage_sink=None, **_kw):
        state["calls"] += 1
        if heal_after is not None and state["calls"] > heal_after:
            a["source"] = {"platform": "tiktok", "script": {"has_speech": False}, "shots": []}
            return True
        raise make_exc()

    P.fill_source = _fill
    snaps = []
    while len(snaps) < max_passes:
        if snaps and entry.get("fetchFail"):
            entry["fetchFail"]["at"] = ago(10000)        # the wait has elapsed
        if not _wants(entry):
            break
        P.process_group("fake-key", object(), [("cid-e", {"name": "c", "brands": []}, entry)])
        snaps.append({"status": entry.get("status"), "retrying": entry.get("retrying"),
                      "final": entry.get("final"), "finalWhy": entry.get("finalWhy"),
                      "note": entry.get("note"), "noteKind": entry.get("noteKind"),
                      "retryable": entry.get("retryable")})
    if entry.get("final"):
        _FINAL_SEEN.append(entry)
    return snaps


try:
    P.sb = lambda key, path, method="GET", body=None, raw=False: [{"data": {"adaptations": []}}]
    P.fetch_meta = lambda url: {}
    P.upsert_source = lambda key, a: None
    P.upsert_video = lambda key, a: None
    P.record_cost = lambda key, id8, ok, u: None
    P.refund = lambda key, a, why: _refunds.append(a.get("id"))
    P.extract_format = lambda *a, **k: None
    P.run_entry = lambda *a, **k: None

    _UNCLEAR = "download failed: ERROR: [TikTok] 671833539: Your IP address is blocked from accessing this post"
    _OURS = "download failed: ERROR: [TikTok] 1: Unexpected response from webpage request"
    _INPUT = "download failed: ERROR: [Instagram] OB5: There is no video in this post"

    # unclear: 6 passes, "still trying" until the last, then "unreachable"
    _u = {"id": "e0000001", "status": "queued", "sourceUrl": "https://www.tiktok.com/@x/video/6748451240264420610"}
    _sn = _drive(_u, lambda: P.FetchFailed(_UNCLEAR))
    check("E unclear: exactly 6 passes", len(_sn), 6)
    check("E unclear: middle passes say retrying", [s["retrying"] for s in _sn[:-1]], [True] * 5)
    check("E unclear: middle passes carry the fetch_retrying sentence",
          {s["note"] for s in _sn[:-1]}, {_E_NOTES["fetch_retrying"]})
    check("E unclear: middle passes are not final", [s["final"] for s in _sn[:-1]], [None] * 5)
    check("E unclear: finalWhy unreachable", _u.get("finalWhy"), "unreachable")
    check("E unclear: final sentence", _u.get("note"), _E_NOTES["fetch_unreachable"])
    check("E unclear: retryable (Try again offered)", _u.get("retryable"), True)
    check("E unclear: no retrying flag at the end", "retrying" in _u, False)
    check("E unclear: fetchClass unclear", _u.get("fetchClass"), "unclear")
    check("E unclear: tries recorded", _u["fetchFail"]["tries"], 6)

    # ours: 6 passes then gave_up with the count in the sentence
    _o = {"id": "e0000002", "status": "queued", "sourceUrl": "https://www.tiktok.com/@x/video/6748451240264420610"}
    _sn = _drive(_o, lambda: P.FetchFailed(_OURS))
    check("E ours: exactly 6 passes", len(_sn), 6)
    check("E ours: finalWhy gave_up", _o.get("finalWhy"), "gave_up")
    check("E ours: gave_up sentence carries 6", _o.get("note"), P.note_text("gave_up", tries=6))
    check("E ours: sentence mentions 6", "6" in (_o.get("note") or ""), True)
    check("E ours: fetchClass ours (what the burst alarm counts)", _o.get("fetchClass"), "ours")
    check("E ours: no retrying flag at the end", "retrying" in _o, False)

    # processing failure past the download: ours, never a fetch_* key
    _p = {"id": "e0000003", "status": "queued", "sourceUrl": "https://www.tiktok.com/@x/video/6748451240264420610"}
    _sn = _drive(_p, lambda: TypeError("open() got an unexpected keyword argument 'metadata_errors'"))
    check("E processing: noteKind ours while retrying", {s["noteKind"] for s in _sn[:-1]}, {"ours"})
    check("E processing: the read_ours sentence while retrying",
          {s["note"] for s in _sn[:-1]}, {_E_NOTES["read_ours"]})
    check("E processing: never a fetch_* sentence",
          any(s["note"] in {v for k, v in _E_NOTES.items() if k.startswith("fetch_")} for s in _sn), False)
    check("E processing: fetchFail.key is read_ours", _p["fetchFail"]["key"], "read_ours")
    check("E processing: ends gave_up", _p.get("finalWhy"), "gave_up")

    # input: one pass, a wall
    _i = {"id": "e0000004", "status": "queued", "sourceUrl": "https://www.instagram.com/reel/CDUMkliABpa/"}
    _sn = _drive(_i, lambda: P.FetchFailed(_INPUT))
    check("E input: exactly 1 pass", len(_sn), 1)
    check("E input: finalWhy wall", _i.get("finalWhy"), "wall")
    check("E input: fetch_no_video sentence", _i.get("note"), _E_NOTES["fetch_no_video"])
    check("E input: retryable False", _i.get("retryable"), False)
    check("E input: no fetchFail", "fetchFail" in _i, False)
    check("E input: fetchClass input", _i.get("fetchClass"), "input")
    check("E input: not retrying", "retrying" in _i, False)

    # heal: fail twice (unclear), then the read works
    _h = {"id": "e0000005", "status": "queued", "sourceUrl": "https://www.tiktok.com/@x/video/6748451240264420610"}
    _sn = _drive(_h, lambda: P.FetchFailed(_UNCLEAR), max_passes=3, heal_after=2)
    check("E heal: three passes", len(_sn), 3)
    check("E heal: fetchFail gone", "fetchFail" in _h, False)
    check("E heal: fetchHealed.tries == 2", (_h.get("fetchHealed") or {}).get("tries"), 2)
    check("E heal: fetchHealed.cls", (_h.get("fetchHealed") or {}).get("cls"), "unclear")
    check("E heal: no note", ("note" in _h, "noteKind" in _h), (False, False))
    check("E heal: no retrying, no fetchClass", ("retrying" in _h, "fetchClass" in _h), (False, False))

    # every failed pass refunded its charge
    check("E refunds: one per failed pass (6 + 6 + 6 + 1 + 2)", len(_refunds), 21)
finally:
    for _n, _f in _E_ORIG.items():
        setattr(P, _n, _f)

# the schedule itself
_sched = {"status": "error", "retryable": True, "fetchFail": {"tries": 1, "at": ago(0.5), "cls": "ours"}}
check("E schedule: 30s after try 1 -> not due", _wants(_sched), False)
_sched["fetchFail"]["at"] = ago(61 / 60)
check("E schedule: 61s after try 1 -> due", _wants(_sched), True)
check("E schedule: try 5 waits 15 min (14 min -> not due)",
      _wants({"status": "error", "fetchFail": {"tries": 5, "at": ago(14)}}), False)
check("E schedule: try 5 waits 15 min (16 min -> due)",
      _wants({"status": "error", "fetchFail": {"tries": 5, "at": ago(16)}}), True)
check("E schedule: window length is 1+2+4+8+15 = 30 minutes",
      sum(P.FETCH_RETRY_MINUTES), 30)
check("E schedule: six tries", P.FETCH_MAX_TRIES, 6)

# mark_retrying: the only writer of the flag
check("E retrying: error + fetchFail", (lambda a: (P.mark_retrying(a), a.get("retrying"))[1])(
    {"status": "error", "fetchFail": {"tries": 1}}), True)
check("E retrying: final drops it", (lambda a: (P.mark_retrying(a), a.get("retrying"))[1])(
    {"status": "error", "fetchFail": {"tries": 6}, "final": True, "retrying": True}), None)
check("E retrying: retryable False drops it", (lambda a: (P.mark_retrying(a), a.get("retrying"))[1])(
    {"status": "error", "fetchFail": {"tries": 1}, "retryable": False, "retrying": True}), None)
check("E retrying: ai transient on an error entry (Q9)", (lambda a: (P.mark_retrying(a), a.get("retrying"))[1])(
    {"status": "error", "aiFail": {"kind": "transient"}}), True)
check("E retrying: ai content refusal does not", (lambda a: (P.mark_retrying(a), a.get("retrying"))[1])(
    {"status": "error", "aiFail": {"kind": "content"}}), None)
check("E retrying: a done entry never has it", (lambda a: (P.mark_retrying(a), a.get("retrying"))[1])(
    {"status": "done", "aiFail": {"kind": "transient"}, "retrying": True}), None)

# INVARIANT: nothing final may still promise the platform will be retried.
_promises = {_E_NOTES["fetch_retrying"], _E_NOTES["read_ours"], _E_NOTES["fetch_ours"], _E_NOTES["ai_ours"]}
for _fe in _FINAL_SEEN:
    check(f"E invariant: final entry {_fe['id']} carries no retry promise", _fe.get("note") in _promises, False)


print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
