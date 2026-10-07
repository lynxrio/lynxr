"""Checks on the pipeline canary (pipeline/canary.py).

No network, no model, no Supabase: every ops_get / ops_put / fetch_meta /
download / transcribe / sb / anthropic_client is a stub, restored in `finally`.
Real ffprobe, ffmpeg frames, cover and clip run on a generated 3-second clip, so
the media half of the pipeline is exercised for real. Run with

    ./venv/bin/python pipeline/test_canary.py

Case (b) replays the 2026-10-04 PyAV TypeError as a hard `transcribe` failure:
before the canary nothing outside a creator's paste ever ran that path.
"""

import contextlib
import copy
import inspect
import io
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import canary  # noqa: E402
import watchdog as W  # noqa: E402
import process_adaptations as P  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


NOW = datetime(2026, 10, 6, 12, 0, 0, tzinfo=timezone.utc)


def ago(seconds):
    return (NOW - timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def ahead(seconds):
    return (NOW + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


TT1 = "https://www.tiktok.com/@leenabhushan/video/6748451240264420610"
TT2 = "https://www.tiktok.com/@patroxofficial/video/6742501081818877190"
CFG = {"videos": {"tiktok": [{"url": TT1, "speech": True, "seconds": 3}, {"url": TT2, "speech": True, "seconds": 3}],
                  "instagram": [{"url": "https://www.instagram.com/reel/CDUMkliABpa/", "speech": True, "seconds": 3}]},
       "creator": {"name": "lynxr canary"},
       "brand": {"id": "canary-brand", "name": "lynxr", "description": "x", "objective": "x", "niche": "x", "tried": "yes"}}
SAID = "hello this is the lynxr canary speaking clearly"
GOOD_T = {"text": SAID, "has_speech": True, "duration": 3.0, "segments": [[0, 3, SAID]],
          "hook_spoken": "hello", "language": "en", "hook_usable": True}

TMP = Path(tempfile.mkdtemp(prefix="canary-test-"))
CLIP = TMP / "clip.mp4"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=30:duration=3",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", "-movflags", "+faststart", str(CLIP)], check=True, capture_output=True, timeout=120)

# ---- stubs, all restored in `finally` --------------------------------------
P_NAMES = ["fetch_meta", "download_video", "fetch_audio", "transcribe", "sb", "anthropic_client", "extract_frames",
           "structured", "analyze_frames", "REUSE_SOURCES", "FETCH_FALLBACK_APIFY", "upload_cover", "upload_clip",
           "cached_source", "media_duration"]
SAVED_P = {n: getattr(P, n) for n in P_NAMES}
SAVED_W = {"ops_get": W.ops_get, "ops_put": W.ops_put}
SAVED_LR_LOAD = W.LR.load_env
SAVED_ENV = {k: os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "FLY_APP_NAME", "FLY_IMAGE_REF")}
SAVED_CANARY = {n: getattr(canary, n) for n in ("NoModel", "DEADLINE_S", "FULL_EVERY_H", "DEADLINE_HIT")}
SAVED_TEMPDIR = tempfile.tempdir
SAVED_SIGTERM = signal.getsignal(signal.SIGTERM)
SAVED_SIGALRM = signal.getsignal(signal.SIGALRM)

OPS = {}
PUTS = []
SB_CALLS = []
DL_URLS = []
NO_MODELS = []


class RecNoModel(canary.NoModel):
    def __init__(self):
        super().__init__()
        NO_MODELS.append(self)


def reset():
    OPS.clear()
    PUTS.clear()
    SB_CALLS.clear()
    DL_URLS.clear()
    NO_MODELS.clear()
    P.fetch_meta = lambda url, paid=False: {"duration": 3.0, "video_id": "1", "title": "t"}

    def dl(url, dest):
        DL_URLS.append(url)
        shutil.copy(CLIP, Path(dest) / "v.mp4")
        return Path(dest) / "v.mp4", None
    P.download_video = dl
    P.fetch_audio = lambda url, dest: (None, "ERROR: audio not needed")
    P.transcribe = lambda path, model: dict(GOOD_T)
    P.sb = lambda key, path, method="GET", body=None, raw=False: SB_CALLS.append((method, path, body))
    # Restore the real implementations of anything a previous case replaced.
    for n in ("extract_frames", "structured", "analyze_frames", "anthropic_client"):
        setattr(P, n, SAVED_P[n])
    canary.FULL_EVERY_H = SAVED_CANARY["FULL_EVERY_H"]


def media_plan(platform="tiktok", ping=False):
    return {"platforms": [platform], "full": False, "full_platform": None, "ping": ping, "apify": False, "boot": False}


def full_plan(platform="tiktok"):
    return {"platforms": [platform], "full": True, "full_platform": platform, "ping": False, "apify": False, "boot": False}


def fake_client(text="{}"):
    def create(**kw):
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], stop_reason="end_turn",
                               usage=SimpleNamespace(input_tokens=100, output_tokens=10,
                                                     cache_creation_input_tokens=0, cache_read_input_tokens=0))
    return SimpleNamespace(messages=SimpleNamespace(create=create))


try:
    os.environ["ANTHROPIC_API_KEY"] = "test-key"
    os.environ.pop("FLY_IMAGE_REF", None)
    W.LR.load_env = lambda p: {}
    W.ops_get = lambda key, k: OPS.get(k)
    W.ops_put = lambda key, k, v: (PUTS.append((k, copy.deepcopy(v))), OPS.__setitem__(k, {"value": copy.deepcopy(v)}))
    canary.NoModel = RecNoModel
    reset()

    # ---- (a) a healthy media pass ----------------------------------------------
    r = canary.run_pass(media_plan(), CFG, "k", True, now=NOW)
    check("(a) pipeline and tiktok pass", (r["checks"]["pipeline"]["ok"], r["checks"]["tiktok"]["ok"]), (True, True))
    st = r["stages"]["tiktok"]
    check("(a) frames extracted", st["frames"] > 0, True)
    check("(a) cover bytes recorded", st["cover_bytes"] > 500, True)
    check("(a) clip bytes recorded", st["clip_bytes"] > 10000, True)
    check("(a) ffprobe ran through the wrapper", (st["probed"] or 0) > 0, True)
    check("(a) the stub model was asked (shots/tags attempted)", sum(n.calls for n in NO_MODELS) >= 1, True)
    check("(a) nothing billed", r["usd"], 0)
    check("(a) P.sb never called", SB_CALLS, [])
    check("(a) the guards are undone after the pass",
          (P.REUSE_SOURCES, P.upload_cover is SAVED_P["upload_cover"], P.media_duration is SAVED_P["media_duration"]),
          (SAVED_P["REUSE_SOURCES"], True, True))

    # ---- (b) the 2026-10-04 regression ----------------------------------------
    reset()

    def pyav(path, model):
        raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")
    P.transcribe = pyav
    r = canary.run_pass(media_plan(), CFG, "k", True, now=NOW)
    c = r["checks"]["tiktok"]
    check("(b) PyAV TypeError is a hard transcribe failure", (c["ok"], c["stage"]), (False, "transcribe"))
    check("(b) the reason names the argument", "metadata_errors" in c["reason"], True)

    # ---- (c) ours download: the backup is NOT tried ----------------------------
    reset()
    P.download_video = lambda url, dest: (DL_URLS.append(url), (None, "ERROR: [TikTok] 1: Unexpected response from webpage request"))[1]
    P.fetch_audio = lambda url, dest: (None, "ERROR: [TikTok] 1: Unexpected response from webpage request")
    r = canary.run_pass(media_plan(), CFG, "k", True, now=NOW)
    c = r["checks"]["tiktok"]
    check("(c) a download break is a hard failure at download", (c["ok"], c["stage"]), (False, "download"))
    check("(c) the backup was not tried", DL_URLS, [TT1])

    # ---- (d) primary gone, backup ok -------------------------------------------
    reset()

    def dl_gone(url, dest):
        DL_URLS.append(url)
        if url == TT1:
            return None, "ERROR: [TikTok] 674: Video unavailable"
        shutil.copy(CLIP, Path(dest) / "v.mp4")
        return Path(dest) / "v.mp4", None
    P.download_video = dl_gone
    P.fetch_audio = lambda url, dest: (None, "ERROR: [TikTok] 674: Video unavailable")
    r = canary.run_pass(media_plan(), CFG, "k", True, now=NOW)
    check("(d) the backup carried the check", r["checks"]["tiktok"]["ok"], True)
    check("(d) video_gone names the primary", r["video_gone"], {"tiktok": [0]})
    check("(d) the stage record shows the backup was read", r["stages"]["tiktok"]["video"], 1)

    # ---- (e) silence from a video that has speech ------------------------------
    reset()
    P.transcribe = lambda path, model: dict(GOOD_T, text="", has_speech=False, segments=[])
    c = canary.run_pass(media_plan(), CFG, "k", True, now=NOW)["checks"]["tiktok"]
    check("(e) a silent result is a hard transcribe failure", (c["ok"], c["stage"]), (False, "transcribe"))

    # ---- (f) zero frames --------------------------------------------------------
    reset()
    P.extract_frames = lambda media, times, td: []
    c = canary.run_pass(media_plan(), CFG, "k", True, now=NOW)["checks"]["tiktok"]
    check("(f) zero frames is a hard frames failure", (c["ok"], c["stage"]), (False, "frames"))

    # ---- (g) a healthy full pass ------------------------------------------------
    def full_stubs():
        P.analyze_frames = lambda client, frames, max_tokens=1500: {"shots": [{"t": 0, "visual": "x"}]}
        FMT = {"name": "f", "beats": [{"t": "0-3s"}], "product_entry": "", "why_it_works": "", "wrapper_removed": ""}
        AD = {"beats": [{"t": "0-3s", "say": "x", "do": "y", "show": "z"}]}

        def structured(client, system, schema, content, max_tokens=16000):
            if schema is P.FORMAT_SCHEMA:
                return dict(FMT)
            if schema is P.ADAPT_SCHEMA:
                if ADAPT_RAISES:
                    raise RuntimeError("malformed model response")
                return copy.deepcopy(AD)
            raise AssertionError("unexpected schema")
        P.structured = structured
        P.anthropic_client = lambda api_key, base_url=None: fake_client()
    ADAPT_RAISES = False
    reset()
    full_stubs()
    r = canary.run_pass(full_plan(), CFG, "k", False, now=NOW)
    check("(g) the script check passes", r["checks"].get("script", {}).get("ok"), True)
    check("(g) the tag call was costed", r["usd"] > 0, True)
    check("(g) exactly one write: the cost rows", [(m, p) for m, p, b in SB_CALLS], [("POST", "/rest/v1/lynxr_costs")])
    rows = SB_CALLS[0][2] if SB_CALLS else []
    check("(g) every cost row is lane canary / id8 canary", all(x.get("lane") == "canary" and x.get("id8") == "canary" for x in rows) and bool(rows), True)

    # ---- (h) adapt fails --------------------------------------------------------
    ADAPT_RAISES = True
    reset()
    full_stubs()
    r = canary.run_pass(full_plan(), CFG, "k", True, now=NOW)
    c = r["checks"].get("script", {})
    check("(h) a failed adaptation is a hard adapt failure", (c.get("ok"), c.get("stage")), (False, "adapt"))
    ADAPT_RAISES = False

    # ---- (i) plan_pass ----------------------------------------------------------
    p = canary.plan_pass({}, NOW, False, "img", model_on=True)
    check("(i) a fresh state: tiktok, no full pass, ping", (p["platforms"], p["full"], p["ping"]), (["tiktok"], False, True))
    canary.FULL_EVERY_H = 24
    try:
        p = canary.plan_pass({}, NOW, False, "img", model_on=True)
        check("(i) with a daily cadence set a fresh state is due a full pass", (p["full"], p["ping"]), (True, False))
    finally:
        canary.FULL_EVERY_H = SAVED_CANARY["FULL_EVERY_H"]
    s = {"last_full_at": ago(3600), "last_platform": "tiktok"}
    p = canary.plan_pass(s, NOW, False, "img", model_on=True)
    check("(i) alternates to instagram, media pass, ping", (p["platforms"], p["full"], p["ping"]), (["instagram"], False, True))
    s = {"last_full_image": "img", "last_full_at": ago(3600)}
    p = canary.plan_pass(s, NOW, True, "img", model_on=True)
    check("(i) boot on the same image: both platforms, no full", (p["platforms"], p["full"]), (["tiktok", "instagram"], False))
    check("(i) boot on a new image: full", canary.plan_pass(s, NOW, True, "other", model_on=True)["full"], True)
    check("(i) boot with no image ref: full", canary.plan_pass(s, NOW, True, "", model_on=True)["full"], True)
    s = {"full_today": {"date": NOW.date().isoformat(), "n": 4}}
    check("(i) 4 full passes today: none even on a new image", canary.plan_pass(s, NOW, True, "new", model_on=True)["full"], False)
    s = {"next": {"retry": True, "platform": "instagram", "tier": "full"}}
    p = canary.plan_pass(s, NOW, False, "img", model_on=True)
    check("(i) a full retry goes to instagram, full", (p["platforms"], p["full"]), (["instagram"], True))
    p = canary.plan_pass({}, NOW, True, "img", model_on=False)
    check("(i) model off: no ping, no full", (p["ping"], p["full"]), (False, False))
    s = {"streak": {"script": 1}, "last_full_at": ago(4 * 3600)}
    check("(i) a script failure re-runs the full pass after 3h", canary.plan_pass(s, NOW, False, "img", model_on=True)["full"], True)
    s = {"streak": {"script": 1}, "last_full_at": ago(1 * 3600)}
    check("(i) but not within 3h", canary.plan_pass(s, NOW, False, "img", model_on=True)["full"], False)

    # ---- (j) apply_result -------------------------------------------------------
    def res(ok, tier="media", image="imgA", at=None, platforms=("tiktok",)):
        return {"at": at or NOW.isoformat().replace("+00:00", "Z"), "boot": False, "image": image, "versions": {"yt_dlp": "x"},
                "tier": tier, "platforms": list(platforms), "full_platform": None, "usd": 0, "soft": [], "video_gone": {},
                "stages": {}, "checks": {"pipeline": {"ok": True}, "tiktok": {"ok": ok, "stage": None if ok else "transcribe", "platform": "tiktok", "reason": "" if ok else "TypeError"}}}
    st0 = {}
    snapshot = copy.deepcopy(st0)
    r1 = res(False)
    s1 = canary.apply_result(st0, r1, NOW)
    r2 = res(False, image="imgA")
    s2 = canary.apply_result(s1, r2, NOW)
    r3 = res(True, image="imgB")
    s3 = canary.apply_result(s2, r3, NOW)
    check("(j) streaks go 1, 2, 0", (s1["streak"]["tiktok"], s2["streak"]["tiktok"], s3["streak"]["tiktok"]), (1, 2, 0))
    check("(j) retry is set only after the first failure", (bool(s1["next"].get("retry")), bool(s2["next"].get("retry")), bool(s3["next"].get("retry"))), (True, False, False))
    check("(j) exit codes go 3, 4, 0", (canary.exit_code(s1, r1), canary.exit_code(s2, r2), canary.exit_code(s3, r3)), (3, 4, 0))
    check("(j) last_good_image is set only by the passing step", ("last_good_image" in s1, "last_good_image" in s2, s3.get("last_good_image")), (False, False, "imgB"))
    check("(j) the failure record carries stage and image", (s2["fails"]["tiktok"]["stage"], s2["fails"]["tiktok"]["image"]), ("transcribe", "imgA"))
    check("(j) a pass clears fails and stamps last_ok", ("tiktok" in s3["fails"], bool(s3["last_ok"].get("tiktok"))), (False, True))
    hist = {}
    for i in range(60):
        hist = canary.apply_result(hist, res(True), NOW)
    check("(j) history is capped at 48", len(hist["history"]), 48)
    check("(j) the input state is unchanged", st0, snapshot)

    # ---- (k) fault injection ----------------------------------------------------
    reset()
    OPS[canary.FAULT_KEY] = {"value": {"stage": "transcribe", "until": ahead(600)}}
    fault = canary.active_fault(OPS[canary.FAULT_KEY]["value"], NOW)
    check("(k) an unexpired fault is active", fault, "transcribe")
    r = canary.run_pass(media_plan(), CFG, "k", True, fault=fault, now=NOW)
    c = r["checks"]["tiktok"]
    check("(k) the fault is a hard transcribe failure that says so", (c["ok"], c["stage"], "injected" in c["reason"]), (False, "transcribe", True))
    check("(k) the fault patch is undone after the pass", P.transcribe is not SAVED_P["transcribe"] and callable(P.transcribe), True)
    reset()
    old = {"stage": "transcribe", "until": ago(60)}
    check("(k) an expired fault is inactive", canary.active_fault(old, NOW), None)
    check("(k) with the fault expired the pass is healthy", canary.run_pass(media_plan(), CFG, "k", True, fault=canary.active_fault(old, NOW), now=NOW)["checks"]["tiktok"]["ok"], True)
    check("(k) an unknown stage is inactive", canary.active_fault({"stage": "cover", "until": ahead(60)}, NOW), None)
    # O3: image-bound fault
    other_img = {"stage": "download", "until": ahead(600), "only_image": "registry.fly.io/lynxr-worker:deployment-OTHER"}
    check("(k) only_image naming another image: inactive", canary.active_fault(other_img, NOW), None)
    reset()
    check("(k) ...so the pass is healthy", canary.run_pass(media_plan(), CFG, "k", True, fault=canary.active_fault(other_img, NOW), now=NOW)["checks"]["tiktok"]["ok"], True)
    os.environ["FLY_IMAGE_REF"] = "registry.fly.io/lynxr-worker:deployment-THIS"
    try:
        mine = dict(other_img, only_image="registry.fly.io/lynxr-worker:deployment-THIS")
        fault = canary.active_fault(mine, NOW)
        check("(k) only_image equal to FLY_IMAGE_REF: active", fault, "download")
        reset()
        c = canary.run_pass(media_plan(), CFG, "k", True, fault=fault, now=NOW)["checks"]["tiktok"]
        check("(k) ...and a hard download failure", (c["ok"], c["stage"], "injected" in c["reason"]), (False, "download", True))
    finally:
        os.environ.pop("FLY_IMAGE_REF", None)
    reset()
    full_stubs()
    c = canary.run_pass(full_plan(), CFG, "k", True, fault="format", now=NOW)["checks"].get("script", {})
    check("(k) a format fault is a hard format failure", (c.get("ok"), c.get("stage")), (False, "format"))
    reset()
    c = canary.run_pass(dict(media_plan(), ping=True), CFG, "k", True, fault="ping", now=NOW)["checks"].get("ping", {})
    check("(k) a ping fault is a hard ping failure", (c.get("ok"), c.get("stage")), (False, "ping"))

    # ---- (l) pause --------------------------------------------------------------
    reset()
    os.environ["FLY_APP_NAME"] = "lynxr-test"
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "k"
    OPS[canary.HEALTH_KEY] = {"value": {"at": ago(600), "ok": True}}
    OPS[canary.PAUSE_KEY] = {"value": {"off": True}}
    rc = canary.main([])
    written = [v for k, v in PUTS if k == canary.HEALTH_KEY]
    check("(l) paused: exit 5", rc, 5)
    check("(l) paused: the written state is paused with `at` unchanged",
          (bool(written) and written[-1].get("paused"), bool(written) and written[-1].get("at")), (True, ago(600)))
    os.environ.pop("FLY_APP_NAME", None)
    tempfile.tempdir = SAVED_TEMPDIR

    # ---- (m) stage coverage guard ----------------------------------------------
    names = set(re.findall(r'stage\(timings, "([a-z_]+)"\)', inspect.getsource(P.fill_source)))
    unknown = sorted(n for n in names if n not in canary.STAGES and n not in canary.SKIPPED_FILL_SOURCE_STAGES)
    check("(m) every fill_source stage is known to the canary", unknown, [])

    # ---- (n) no URL reaches health ---------------------------------------------
    check("(n) clean_reason strips URLs", "http" in canary.clean_reason("Unsupported URL: https://www.tiktok.com/x?y=1"), False)

    # ---- (o) worker.run_preemptible --------------------------------------------
    import worker as WK
    t0 = time.time()
    flips = {"n": 0}

    def stop_after_one_poll():
        flips["n"] += 1
        return time.time() - t0 >= 1
    out = WK.run_preemptible([sys.executable, "-c", "import time; time.sleep(30)"], stop_after_one_poll, poll_s=0.5, grace_s=3)
    check("(o) a sleeper is preempted", out, ("preempted", None))
    check("(o) ...in under 10s", time.time() - t0 < 10, True)
    check("(o) a non-zero exit is a failure", WK.run_preemptible([sys.executable, "-c", "import sys; sys.exit(3)"], lambda: False, poll_s=0.5), ("failed", 3))
    check("(o) a clean exit is ok", WK.run_preemptible([sys.executable, "-c", "pass"], lambda: False, poll_s=0.5), ("ok", 0))
    check("(o) the timeout is honoured", WK.run_preemptible([sys.executable, "-c", "import time; time.sleep(30)"], lambda: False, poll_s=0.5, grace_s=3, timeout_s=1), ("timeout", None))

    def boom():
        raise OSError("probe failed")
    check("(o) a should_stop that raises counts as False", WK.run_preemptible([sys.executable, "-c", "import time; time.sleep(1.2)"], boom, poll_s=0.5), ("ok", 0))
    check("(o) a command that cannot start is an error, not a raise", WK.run_preemptible(["/no/such/binary-xyz", "a"], lambda: False)[0], "error")

    # ---- (p) the deadline -------------------------------------------------------
    reset()
    canary.DEADLINE_S = 1

    def slow(path, model):
        time.sleep(3)
        return dict(GOOD_T)
    P.transcribe = slow
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "k"
    OPS.clear()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = canary.main(["--dry-run", "--tier", "media", "--platform", "tiktok", "--no-ping"])
    out = buf.getvalue()
    j = json.loads(out[out.index("{"):]) if "{" in out else {}
    c = (j.get("result") or {}).get("checks", {}).get("tiktok", {})
    check("(p) a hung transcribe is a hard transcribe failure naming the deadline", (c.get("ok"), c.get("stage"), "deadline" in (c.get("reason") or "")), (False, "transcribe", True))
    check("(p) and exits 3 (retry)", rc, 3)
    canary.DEADLINE_S = SAVED_CANARY["DEADLINE_S"]
    canary.DEADLINE_HIT = False

    # ---- (q) pure bits the other layers rely on ---------------------------------
    check("(q) is_paused: off", canary.is_paused({"off": True}, NOW), True)
    check("(q) is_paused: until in the future", canary.is_paused({"until": ahead(60)}, NOW), True)
    check("(q) is_paused: until in the past, junk, None", (canary.is_paused({"until": ago(60)}, NOW), canary.is_paused("x", NOW), canary.is_paused(None, NOW)), (False, False, False))
finally:
    for n, v in SAVED_P.items():
        setattr(P, n, v)
    canary.NoModel = SAVED_CANARY["NoModel"]
    canary.DEADLINE_S = SAVED_CANARY["DEADLINE_S"]
    canary.FULL_EVERY_H = SAVED_CANARY["FULL_EVERY_H"]
    canary.DEADLINE_HIT = False
    canary.restore_patches()
    W.ops_get, W.ops_put = SAVED_W["ops_get"], SAVED_W["ops_put"]
    W.LR.load_env = SAVED_LR_LOAD
    for k, v in SAVED_ENV.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    tempfile.tempdir = SAVED_TEMPDIR
    signal.alarm(0)
    signal.signal(signal.SIGTERM, SAVED_SIGTERM)
    signal.signal(signal.SIGALRM, SAVED_SIGALRM)
    shutil.rmtree(TMP, ignore_errors=True)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
