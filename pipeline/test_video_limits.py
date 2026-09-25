"""Checks on the 5-minute source limit (pipeline/video_limits.py) across every
lane that processes a video: the creator paste (process_adaptations), the
agency campaign read (process_campaigns) and brief clips (brief_clips).
Plan: ~/.claude/plans/max-video-length.md.

Offline: no Supabase, no model call, no download. Every network and model
boundary is stubbed; ffprobe runs for real on a 2.5-second file this script
makes with ffmpeg in a temp dir. Same check()/FAILS style as test_ai_retry.py.

Run with

    ./venv/bin/python pipeline/test_video_limits.py
"""
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import video_limits as V  # noqa: E402
import process_adaptations as P  # noqa: E402
import process_campaigns as C  # noqa: E402
import brief_clips as B  # noqa: E402
import watchdog as W  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


class Reached(Exception):
    """Raised by a stub to prove the gate let the video through to that step."""


def boom(label):
    def _f(*a, **kw):
        raise Reached(label)
    return _f


# ---- (a) the rule itself -----------------------------------------------------
check("the limit is 300 seconds", V.MAX_SOURCE_SECONDS, 300)
check("the limit is whole minutes (the sentences say 'N minutes')", V.MAX_SOURCE_SECONDS % 60, 0)
for secs, want in ((299, False), (300, False), (300.4, False), (300.5, True), (301, True), (3600, True)):
    check(f"too_long({secs})", V.too_long(secs), want)
for unknown in (None, 0, 0.0, -5, "", "abc", "N/A", float("nan"), float("inf")):
    check(f"too_long({unknown!r}) is unknown, so allowed", V.too_long(unknown), False)
check("a numeric string counts", V.too_long("301"), True)
check("whole_seconds rounds half up", (V.whole_seconds(431.6), V.whole_seconds(300.5), V.whole_seconds(300.49)), (432, 301, 300))

# ---- (b) ffprobe, for real ---------------------------------------------------
check("ffmpeg and ffprobe are on PATH", bool(shutil.which("ffmpeg") and shutil.which("ffprobe")), True)
with tempfile.TemporaryDirectory() as td_s:
    td = Path(td_s)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.5",
                    "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2.5", "-shortest",
                    "-c:v", "libx264", "-c:a", "aac", str(td / "v.mp4")], check=True)
    got = V.media_duration(td / "v.mp4")
    check("media_duration: a real 2.5s mp4", got is not None and abs(got - 2.5) < 0.1, True)
    (td / "bad.mp4").write_text("not a video")
    check("media_duration: garbage -> None", V.media_duration(td / "bad.mp4"), None)
    check("media_duration: missing file -> None", V.media_duration(td / "missing.mp4"), None)

# ---- (c) the creator's sentence ---------------------------------------------
_note = P.note_text("too_long", m=7, s=12, lm=5)
check("too_long sentence", _note,
      "This video is 7:12 — lynxr works from videos up to 5 minutes. Nothing was used from your allowance.")
check("too_long kind is 'length' (never 'fetch' — that pages fetch-wall:burst)", P.CREATOR_NOTES["too_long"][1], "length")
_dirty = [w for w in range(301, 3601)
          if any(n in P.note_text("too_long", m=w // 60, s=w % 60, lm=5).lower() for n in P.RAW_TEXT_NEEDLES)]
check("too_long sentence is needle-free for every length 5:01..60:00", _dirty, [])
try:
    P.refuse_if_long(431.6, "ffprobe")
    check("refuse_if_long(431.6) raises", False, True)
except P.CreatorFacing as e:
    check("refuse_if_long: key/retryable/nums",
          (e.key, e.retryable, e.nums),
          ("too_long", False, {"m": 7, "s": 12, "lm": 5, "secs": 432, "limit": 300}))
    check("refuse_if_long: detail names the measurement, not the creator", str(e), "too long: 432s by ffprobe, limit 300s")
check("refuse_if_long(300) returns", P.refuse_if_long(300, "ffprobe"), None)
check("refuse_if_long(None) returns (unknown is allowed)", P.refuse_if_long(None, "metadata"), None)

# ---- (d) fill_source: where the gate sits -----------------------------------
_saved = {n: getattr(P, n) for n in ("download_video", "fetch_audio", "media_duration", "transcribe",
                                     "cached_source", "REUSE_SOURCES")}
_downloads = []


def _dl_ok(url, dest):
    _downloads.append(url)
    return dest / "v.mp4", None


def run_fill(probed=None, hint=None, dl=_dl_ok, audio=None):
    """Drive the REAL fill_source with the boundaries stubbed. Returns 'refused m:ss',
    'reached transcribe', or the exception class name."""
    P.REUSE_SOURCES = False
    P.download_video = dl
    P.fetch_audio = audio or (lambda url, dest: (None, "no audio produced"))
    P.media_duration = lambda path: probed
    P.transcribe = boom("transcribe")
    a = {"id": "tl000001", "sourceUrl": "https://www.tiktok.com/@x/video/7600000000000000001"}
    try:
        P.fill_source(a, None, "k", [], {},
                      length_hint=(None if hint is None else hint if callable(hint) else (lambda wait: hint)))
    except P.CreatorFacing as e:
        return f"refused {e.nums['m']}:{e.nums['s']:02d}"
    except Reached as r:
        return f"reached {r}"
    except Exception as e:  # noqa: BLE001
        return type(e).__name__
    return "returned"


try:
    check("ffprobe 299 -> allowed", run_fill(probed=299.0), "reached transcribe")
    check("ffprobe 300 -> allowed", run_fill(probed=300.0), "reached transcribe")
    check("ffprobe 300.4 -> allowed (rounds to 300)", run_fill(probed=300.4), "reached transcribe")
    check("ffprobe 301 -> refused before Whisper", run_fill(probed=301.0), "refused 5:01")
    check("ffprobe 300.5 -> refused, and the card says the judged number", run_fill(probed=300.5), "refused 5:01")
    check("ffprobe unknown, metadata unknown -> allowed", run_fill(probed=None, hint=None), "reached transcribe")
    check("ffprobe unknown, metadata 0 (yt-dlp's 'unknown') -> allowed", run_fill(probed=None, hint=0.0), "reached transcribe")
    check("ffprobe unknown, metadata 301 -> refused", run_fill(probed=None, hint=301.0), "refused 5:01")
    check("metadata already over the limit refuses before the download", run_fill(probed=120.0, hint=900.0), "refused 15:00")
    # Metadata that is still in flight at the download (wait=0 -> None) is not waited on;
    # the file's own length then decides, and the late number is never consulted.
    check("late metadata is not waited on; the file (120s) decides",
          run_fill(probed=120.0, hint=lambda wait: None if wait == 0 else 900.0), "reached transcribe")
    _downloads.clear()
    check("metadata already says 432 -> refused BEFORE the download", run_fill(probed=None, hint=432.0), "refused 7:12")
    check("...and download_video was never called", _downloads, [])

    def _dl_fail(url, dest):
        return None, "ERROR: [TikTok] 1: Read timed out"

    def _dl_timeout(url, dest):
        raise subprocess.TimeoutExpired(cmd="yt-dlp", timeout=180)

    check("download failed + metadata 1800 -> too long, not a fetch error",
          run_fill(hint=1800.0, dl=_dl_fail), "refused 30:00")
    check("download timed out + metadata 1800 -> too long", run_fill(hint=1800.0, dl=_dl_timeout), "refused 30:00")
    check("download failed + metadata unknown -> the fetch error is unchanged",
          run_fill(hint=None, dl=_dl_fail), "RuntimeError")
    check("download timed out + metadata 120 -> the timeout is unchanged",
          run_fill(hint=120.0, dl=_dl_timeout), "TimeoutExpired")
    check("video refused, audio-only fallback 400s -> refused",
          run_fill(probed=400.0, dl=_dl_fail, audio=lambda url, dest: (dest / "a.mp3", None)), "refused 6:40")

    # the library cache path: no download at all
    P.REUSE_SOURCES = True
    P.cached_source = lambda key, url: {"platform": "tiktok", "duration": 301, "script": {"duration": 12},
                                         "format": {"name": "f"}, "shots": [], "tags": {}, "clip": None}
    _a = {"id": "tl000002", "sourceUrl": "https://www.tiktok.com/@x/video/7600000000000000002"}
    try:
        P.fill_source(_a, None, "k", [], {})
        check("library hit at 301s -> refused", "returned", "refused")
    except P.CreatorFacing as e:
        check("library hit at 301s -> refused", e.key, "too_long")
    P.cached_source = lambda key, url: {"platform": "tiktok", "duration": None, "script": {"duration": 58.2},
                                         "format": {"name": "f"}, "shots": [], "tags": {}, "clip": None}
    check("library hit at 58s -> reused as before", P.fill_source(_a, None, "k", [], {}), True)
finally:
    for n, v in _saved.items():
        setattr(P, n, v)

# ---- (e) the creator lane end to end: refused, final, refunded, silent -------
_saved = {n: getattr(P, n) for n in ("sb", "fetch_meta", "download_video", "media_duration", "transcribe",
                                     "structured", "upsert_source", "upsert_video", "REUSE_SOURCES")}
_calls = []


def _rec_sb(key, path, method="GET", body=None, raw=False):
    _calls.append((method, path, body))
    return [{"data": {"adaptations": []}}]


try:
    P.sb = _rec_sb
    P.REUSE_SOURCES = False
    P.fetch_meta = lambda url: {"duration": 431.6}
    P.download_video = _dl_ok
    P.media_duration = lambda path: 431.6
    P.transcribe = boom("transcribe")
    P.structured = boom("structured")
    P.upsert_source = boom("upsert_source")
    P.upsert_video = boom("upsert_video")
    _url = "https://www.tiktok.com/@x/video/7600000000000000003"
    _e1 = {"id": "tlong001", "brandId": "b1", "sourceUrl": _url, "status": "running"}
    _e2 = {"id": "tlong002", "brandId": "b2", "sourceUrl": _url, "status": "running"}
    P.process_group("fake-key", object(), [("cid-1", {"name": "c1", "brands": [{"id": "b1", "name": "Acme"}]}, _e1),
                                          ("cid-2", {"name": "c2", "brands": [{"id": "b2", "name": "Widgets"}]}, _e2)])
    for _label, _e in (("brand 1", _e1), ("brand 2", _e2)):
        check(f"e2e {_label}: status error", _e.get("status"), "error")
        check(f"e2e {_label}: the too_long sentence", _e.get("note"), _note)
        check(f"e2e {_label}: noteKind length", _e.get("noteKind"), "length")
        check(f"e2e {_label}: not retryable (no Try again)", _e.get("retryable"), False)
        check(f"e2e {_label}: final wall (never picked up again, never pages gave-up)",
              (_e.get("final"), _e.get("finalWhy")), (True, "wall"))
        check(f"e2e {_label}: wants_work is False",
              P.wants_work(_e, cooldown_hours=6, lease_minutes=2.5, min_age_seconds=0, redo_ai=False), False)
    _refunds = [b.get("p_id") for m, p, b in _calls if p == "/rest/v1/rpc/refund_script"]
    check("no charge: one refund per entry, by id", sorted(_refunds), ["tlong001", "tlong002"])
    check("no spend: no lynxr_costs row written", [p for m, p, b in _calls if "lynxr_costs" in p], [])
finally:
    for n, v in _saved.items():
        setattr(P, n, v)

# ---- (f) refund survives one dropped request ---------------------------------
_saved_sb = P.sb
try:
    _n = []

    def _flaky(key, path, method="GET", body=None, raw=False):
        _n.append(path)
        if len(_n) == 1:
            raise OSError("connection reset")
        return None

    P.sb = _flaky
    P.refund("k", {"id": "tlong003"}, "test")
    check("refund: retried once after a dropped request", _n, ["/rest/v1/rpc/refund_script"] * 2)
    _n.clear()

    def _down(key, path, method="GET", body=None, raw=False):
        _n.append(path)
        raise OSError("down")

    P.sb = _down
    P.refund("k", {"id": "tlong004"}, "test")   # must not raise
    check("refund: gives up after two tries, never raises", len(_n), 2)
finally:
    P.sb = _saved_sb

# ---- (g) watchdog: a refusal is expected behaviour, never a page -------------
_now = datetime.now(timezone.utc)
_stamp = _now.isoformat().replace("+00:00", "Z")
_rows = [{"id": "c-tl", "data": {"adaptations": [
    {"id": f"tlw0000{i}", "status": "error", "note": _note, "noteKind": "length", "retryable": False,
     "final": True, "finalWhy": "wall", "claimedAt": _stamp, "attemptedAt": _stamp, "addedAt": _stamp,
     "sourceUrl": f"https://www.tiktok.com/@x/video/76000000000000001{i}"} for i in range(3)]}}]
_alarms = W.check_all(_rows, sources_recent=1, worker_seen_at=_now, now=_now)
check("watchdog: three refused long videos in 6h raise no alarm at all", sorted(a["key"] for a in _alarms), [])
check("watchdog: the sentence is not flagged as raw text", W.raw_notes(_rows), [])

# ---- (h) the agency lane: failed, final, same reason, no model spend --------
_saved = {n: getattr(P, n) for n in ("fetch_meta", "download_video", "media_duration", "transcribe", "structured",
                                     "REUSE_SOURCES")}
_saved_sbx = C.sbx
_patches = []
try:
    P.REUSE_SOURCES = False
    P.fetch_meta = lambda url: {}
    P.download_video = _dl_ok
    P.media_duration = lambda path: 431.6
    P.transcribe = boom("transcribe")
    P.structured = boom("structured")

    def _rec_sbx(key, path, method="GET", body=None, prefer=None):
        _patches.append((method, path, body))
        return [{"id": "fmt-tl"}]

    C.sbx = _rec_sbx
    _row = {"id": "fmt-tl-000000000000", "job": "read", "attempts": 0,
            "source_url": "https://www.tiktok.com/@x/video/7600000000000000004"}
    C.run_format("k", object(), _row, {"instructions": "", "brand_context": {}})
    _fin = [b for m, p, b in _patches if m == "PATCH" and b and b.get("status") == "error"]
    check("agency: exactly one error finalize", len(_fin), 1)
    if _fin:
        check("agency: error_kind too_long, not retryable",
              (_fin[0]["error_kind"], _fin[0]["retryable"]), ("too_long", False))
        check("agency: the card's numbers ride on source", _fin[0].get("source"), {"duration": 432, "maxDuration": 300})
        check("agency: staff detail names the measurement", _fin[0]["error_detail"], "too long: 432s by ffprobe, limit 300s")
    check("agency: no cost row (no model call was made)", [p for m, p, b in _patches if "lynxr_costs" in p], [])
    check("agency: finalize_patch leaves other errors without a source key",
          "source" in C.finalize_patch("error", _row, _now, error_kind="fetch_private", retryable=False), False)
finally:
    for n, v in _saved.items():
        setattr(P, n, v)
    C.sbx = _saved_sbx

# ---- (i) brief clips: never encoded past the limit ---------------------------
_saved_b = {n: getattr(B, n) for n in ("exists", "download_video", "media_duration")}
_saved_clip = B.P.make_clip
try:
    B.exists = lambda url: False
    B.download_video = lambda url, dest: (dest / "v.mp4", None)
    B.P.make_clip = boom("make_clip")
    B.media_duration = lambda path: 301.0
    check("brief clip at 301s -> failed, not retryable",
          B.make_one("k", "https://www.tiktok.com/@x/video/7600000000000000005"), {"fail": "too_long", "retryable": False})
    check("...and apply() gives up at once",
          B.apply({"id": "f", "source_url": "u"}, {"fail": "too_long", "retryable": False}).get("clip_state"), "failed")
    B.media_duration = lambda path: 300.0
    try:
        B.make_one("k", "https://www.tiktok.com/@x/video/7600000000000000006")
        check("brief clip at 300s -> encoded", "returned", "reached make_clip")
    except Reached as r:
        check("brief clip at 300s -> encoded", f"reached {r}", "reached make_clip")
finally:
    for n, v in _saved_b.items():
        setattr(B, n, v)
    B.P.make_clip = _saved_clip

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
