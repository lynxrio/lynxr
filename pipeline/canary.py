#!/usr/bin/env python3
"""A canary for the creator script path: known-good public videos run through
the REAL pipeline while the Fly worker is idle, and the page goes out when OUR
pipeline breaks.

WHY THIS EXISTS
---------------
On 2026-10-04 PyAV 19 dropped an argument faster-whisper still passes. The
image built and deployed cleanly, every transcription failed with
"open() got an unexpected keyword argument 'metadata_errors'", and nothing
noticed until a creator's paste failed: a valid TikTok died in OUR
transcription and was shown to the creator as a download problem.
pipeline/smoke_media.py now catches that one case at build time, on a generated
clip. Nothing exercised the real path (real platform download -> ffprobe ->
Whisper -> frames -> model) between creator pastes, so yt-dlp / TikTok /
Instagram drift, a bad deploy, a dead API key or an empty credit balance was
still found by a creator. This is that check.

WHAT A PASS RUNS
----------------
It calls the real `fill_source()` (link check, yt-dlp metadata, download,
ffprobe, Whisper, cover, frames, clip) from process_adaptations.py, with three
guards that apply inside THIS process only: the source cache is off, the Apify
fallback is off (it is checked on its own), and cover/clip uploads are replaced
by byte counters.

  media pass   a stub model client (the shot list and tags are skipped) plus one
               16-token model "ping", which catches a dead key, an empty balance
               or a retired model id. No money beyond the ping.
  full pass    the real client, then `extract_format()` and `fill_adaptation()`
               against a synthetic brand ("lynxr"); an Instagram full pass also
               fetches the reel through `apify_fetch()`. Runs on a NEW image
               (--boot) and on a script-failure retry only: there is no scheduled
               full pass (fixer plan Q6; set CANARY_FULL_EVERY_H to add one).

WHAT IT WRITES
--------------
lynxr_ops `canary.health`, plus lynxr_costs rows with lane='canary' after a full
pass (never for a ping: 720 rows a month would swamp the Ops tab's pass count).
Nothing else: no creator row, no storage object, no source, no charge.
pipeline/watchdog.py reads `canary.health` and turns it into alarms, the same
way it reads `track.health`. THIS FILE NEVER CALLS raise_alarm / clear_alarm:
run_once() clears every latch that is not in that tick's paging list, so a
directly raised alarm would read "resolved" within two minutes.

EXIT CODES (worker.py reads rc == 3 as "retry soon")
    0  every check that ran passed
    1  the canary itself crashed (a bug here, not in the pipeline)
    3  a check failed for the first time: re-run in a few minutes to confirm
    4  a failure is confirmed (already failing on an earlier pass)
    5  skipped: paused, or not on Fly

KILL SWITCHES, fastest first: the lynxr_ops row `canary.pause` (no restart);
Fly secrets CANARY_FULL=0 (no model calls at all), CANARY_APIFY=0, CANARY=0
(the worker lane off). Setting a Fly secret restarts the machine.

FAULT INJECTION: the lynxr_ops row `canary.fault` ({"stage", "until",
optional "only_image"}) breaks ONE stage of the canary's own process so the page
can be proven end to end with no creator involved. `only_image` lets the fixer
drill simulate a bug that a new image cures. There is deliberately no fault
hook anywhere else.

Unrelated to PREFILTER_CANARY in process_adaptations.py (the discovery probe's
grammar check).

    ./venv/bin/python pipeline/canary.py --dry-run --tier media --platform tiktok --no-ping
"""

import argparse
import copy
import json
import logging
import os
import re
import shutil
import signal
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import envcfg  # noqa: E402 - config reads live in one place
import watchdog as W  # noqa: E402 - side-effect-free at import (see its header)
# NEVER `import process_adaptations` here at module top: its import runs
# logging.basicConfig and mkdir("output/"). pipeline() below imports it, so an
# import failure becomes a recorded `import` failure instead of a crash.

log = logging.getLogger("canary")

CONFIG_PATH = Path(__file__).resolve().parent / "canary.json"
HEALTH_KEY, PAUSE_KEY, FAULT_KEY = "canary.health", "canary.pause", "canary.fault"
PLATFORMS = ("tiktok", "instagram")
CHECKS = ("pipeline", "tiktok", "instagram", "ping", "script")
_on = lambda v: v not in ("0", "", "false", "False")  # noqa: E731
CANARY_FULL = _on(envcfg.get("CANARY_FULL", "1"))        # 0 = no model calls at all (no ping, no full pass)
CANARY_APIFY = _on(envcfg.get("CANARY_APIFY", "1"))
CANARY_ANYWHERE = envcfg.get("CANARY_ANYWHERE", "0") in ("1", "true", "True")
FULL_EVERY_H = float(envcfg.get("CANARY_FULL_EVERY_H", "0"))  # 0 = no scheduled model pass (fixer plan Q6): full passes run on a new image (--boot) and on a script-failure retry only
FULL_RETRY_H = float(envcfg.get("CANARY_FULL_RETRY_H", "3"))   # while a script failure is open
FULL_MAX_PER_DAY = int(envcfg.get("CANARY_FULL_MAX_PER_DAY", "4"))
DEADLINE_S = int(envcfg.get("CANARY_DEADLINE_S", "780"))   # inside the worker's 900s kill, so a hang pages
DEADLINE_HIT = False
HISTORY_MAX = 48
EXIT_OK, EXIT_CANARY_BUG, EXIT_RETRY, EXIT_CONFIRMED, EXIT_SKIPPED = 0, 1, 3, 4, 5
STAGES = ("import", "link", "meta", "download", "length", "transcribe", "cover", "frames", "clip",
          "shots", "tags", "ping", "format", "adapt", "apify")
HARD_STAGES = {"import", "link", "download", "length", "transcribe", "frames", "ping", "format", "adapt"}
SKIPPED_FILL_SOURCE_STAGES = {"source_cache": "canary sets REUSE_SOURCES False",
                              "apify_fetch": "the fallback is checked on its own as the apify stage"}
FAULT_STAGES = ("download", "transcribe", "format", "ping")


# ------------------------------------------------------------------ pure helpers

def other(p):
    """The other platform."""
    return "instagram" if p == "tiktok" else "tiktok"


def clean_reason(text):
    """A one-line, URL-free reason: this lands in lynxr_ops and on the phone."""
    return re.sub(r"\s+", " ", re.sub(r"https?://\S+", "<url>", str(text or ""))).strip()[:160]


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def hours_since(stamp, now):
    """Hours between an ISO stamp and `now`; inf when missing or unparseable."""
    d = W._parse_iso(stamp)
    if d is None:
        return float("inf")
    return (now - d).total_seconds() / 3600


def full_today(state, now):
    ft = state.get("full_today")
    if isinstance(ft, dict) and ft.get("date") == now.date().isoformat():
        try:
            return int(ft.get("n") or 0)
        except (TypeError, ValueError):
            return 0
    return 0


def streak(state, check):
    """The int streak for a check; 0 when absent or malformed."""
    s = state.get("streak")
    v = s.get(check) if isinstance(s, dict) else None
    return v if isinstance(v, int) and not isinstance(v, bool) else 0


def plan_pass(state, now, boot, image, model_on=CANARY_FULL, apify_on=CANARY_APIFY):
    """What this pass runs. PURE: a function of the stored state, the clock and
    the image, so the cadence is testable without a network."""
    nxt = state.get("next") if isinstance(state.get("next"), dict) else {}
    retry = bool(nxt.get("retry")) and nxt.get("platform") in PLATFORMS
    room = model_on and full_today(state, now) < FULL_MAX_PER_DAY
    if not room:
        full = False
    elif boot:
        full = image == "" or image != state.get("last_full_image")
    elif retry:
        full = nxt.get("tier") == "full"
    else:
        full = ((FULL_EVERY_H > 0 and hours_since(state.get("last_full_at"), now) >= FULL_EVERY_H)
                or (streak(state, "script") >= 1 and hours_since(state.get("last_full_at"), now) >= FULL_RETRY_H))
    if full:
        full_platform = nxt["platform"] if retry else other(state.get("last_full_platform") or "instagram")
    else:
        full_platform = None
    if boot:
        platforms = list(PLATFORMS)
    elif retry:
        platforms = [nxt["platform"]]
    elif full:
        platforms = [full_platform]
    else:
        platforms = [other(state.get("last_platform") or "instagram")]
    return {"platforms": platforms, "full": full, "full_platform": full_platform,
            "ping": bool(model_on and not full),
            "apify": bool(full and full_platform == "instagram" and apify_on), "boot": bool(boot)}


def apply_result(state, result, now):
    """The new canary.health value. PURE: never mutates `state`.

    `result` is built by run_pass(): {"at", "boot", "image", "versions", "tier",
    "platforms" (those that actually ran), "full_platform", "usd", "checks",
    "soft", "video_gone", "stages"}. `checks` holds only the checks that ran."""
    s = copy.deepcopy(state) if isinstance(state, dict) else {}
    at = result.get("at") or iso(now)
    image = result.get("image") or ""
    streaks = s["streak"] = dict(s["streak"]) if isinstance(s.get("streak"), dict) else {}
    fails = s["fails"] = dict(s["fails"]) if isinstance(s.get("fails"), dict) else {}
    last_ok = s["last_ok"] = dict(s["last_ok"]) if isinstance(s.get("last_ok"), dict) else {}
    failing, fresh = [], []
    for c, r in (result.get("checks") or {}).items():
        if r.get("ok"):
            streaks[c] = 0
            fails.pop(c, None)
            last_ok[c] = at
            continue
        streaks[c] = streak(s, c) + 1
        fails[c] = {"stage": r.get("stage"), "platform": r.get("platform"), "tier": result.get("tier"),
                    "reason": clean_reason(r.get("reason")), "at": at, "image": image}
        failing.append(c)
        if streaks[c] == 1:
            fresh.append(c)
    ran = list(result.get("platforms") or [])
    if fresh:
        p = (result.get("checks") or {}).get(fresh[0], {}).get("platform")
        if p not in PLATFORMS:
            p = result.get("full_platform") or (ran[0] if ran else "tiktok")
        s["next"] = {"retry": True, "platform": p, "tier": result.get("tier")}
    else:
        # A failure already confirmed goes back to the normal cadence, which
        # keeps a model outage from re-buying full passes every 3 minutes.
        s["next"] = {}
    if result.get("tier") == "full":
        s["full_today"] = {"date": now.date().isoformat(), "n": full_today(state if isinstance(state, dict) else {}, now) + 1}
        s["last_full_at"] = at
        s["last_full_platform"] = result.get("full_platform")
        s["last_full_image"] = image
        s["last_full_usd"] = result.get("usd")
    if ran:
        s["last_platform"] = ran[-1]
    seen = dict(s["soft_seen"]) if isinstance(s.get("soft_seen"), dict) else {}
    for name in result.get("soft") or []:
        seen[name] = at
    s["soft_seen"] = {k: v for k, v in seen.items() if hours_since(v, now) < 48}
    gone = dict(s["video_gone"]) if isinstance(s.get("video_gone"), dict) else {}
    for p in ran:
        idx = (result.get("video_gone") or {}).get(p)
        if idx:
            gone[p] = idx
        else:
            gone.pop(p, None)
    s["video_gone"] = gone
    if all(streak(s, c) == 0 for c in CHECKS):
        s["last_good_image"] = image
        s["last_good_versions"] = result.get("versions")
        s["last_good_at"] = at
    hist = s["history"] if isinstance(s.get("history"), list) else []
    hist.append({"at": at, "tier": result.get("tier"), "platforms": ran, "ok": not failing})
    s["history"] = hist[-HISTORY_MAX:]
    for k in ("boot", "tier", "versions", "usd"):
        s[k] = result.get(k)
    s["at"], s["ok"], s["image"], s["platforms"] = at, not failing, image, ran
    s["paused"] = False
    s.pop("paused_at", None)
    return s


def exit_code(new_state, result):
    if all(c.get("ok") for c in (result.get("checks") or {}).values()):
        return EXIT_OK
    if (new_state.get("next") or {}).get("retry"):
        return EXIT_RETRY
    return EXIT_CONFIRMED


def active_fault(v, now, image=None):
    """The fault stage to inject, or None. Active only while `until` is in the
    future, the stage is allowed, and `only_image` (when present) names the
    image this process runs on."""
    if not isinstance(v, dict):
        return None
    until = W._parse_iso(v.get("until"))
    if until is None or until <= now or v.get("stage") not in FAULT_STAGES:
        return None
    only = v.get("only_image")
    if only and only != (os.environ.get("FLY_IMAGE_REF", "") if image is None else image):
        return None
    return v["stage"]


def is_paused(v, now):
    if not isinstance(v, dict):
        return False
    if v.get("off"):
        return True
    until = W._parse_iso(v.get("until"))
    return until is not None and until > now


# ------------------------------------------------------------------ the runner

_P = None
_PATCHES = []   # (module, name, original): undone at the end of run_pass()


def pipeline():
    """process_adaptations, imported on first use. The caller wraps this in
    try/except: an import failure is a recorded `import` failure, not a crash."""
    global _P
    if _P is None:
        import process_adaptations as P
        _P = P
    return _P


def _patch(P, name, value):
    _PATCHES.append((P, name, getattr(P, name)))
    setattr(P, name, value)


def restore_patches():
    while _PATCHES:
        mod, name, orig = _PATCHES.pop()
        setattr(mod, name, orig)


def install_guards(P, rec):
    """Run once per video attempt, with a fresh `rec`. Every assignment changes
    only THIS process, and run_pass() undoes them all."""
    _patch(P, "REUSE_SOURCES", False)
    _patch(P, "FETCH_FALLBACK_APIFY", False)
    _patch(P, "upload_cover", lambda key, name, blob: rec.__setitem__("cover_bytes", len(blob or b"")))
    _patch(P, "upload_clip", lambda key, name, blob: rec.__setitem__("clip_bytes", len(blob or b"")))

    def _no_cache(key, url):
        raise AssertionError("canary must not read the source cache")
    _patch(P, "cached_source", _no_cache)
    orig = getattr(P.media_duration, "_canary_orig", P.media_duration)

    def probe(path):
        v = orig(path)
        rec["probed"] = v
        return v
    probe._canary_orig = orig
    _patch(P, "media_duration", probe)


class NoModel:
    """A client whose every call raises. In a media pass fill_source swallows
    this inside do_shots / do_tags, so shots and tags are not checked and
    nothing is billed."""

    def __init__(self):
        self.calls = 0
        self.messages = self

    def create(self, **kw):
        self.calls += 1
        raise RuntimeError("canary media pass: model call skipped")


def apply_fault(P, stage):
    """Break one stage of the canary's own process (see the docstring)."""
    log.warning("canary: FAULT INJECTED %s", stage)
    msg = "injected fault (canary.fault)"
    if stage == "download":
        _patch(P, "download_video", lambda url, dest: (None, "ERROR: " + msg))
        _patch(P, "fetch_audio", lambda url, dest: (None, "ERROR: " + msg))
    elif stage == "transcribe":
        def boom(path, model):
            raise RuntimeError(msg)
        _patch(P, "transcribe", boom)
    elif stage == "format":
        real = P.structured

        def structured(client, system, schema, content, *a, **k):
            if schema is P.FORMAT_SCHEMA:
                raise RuntimeError(msg)
            return real(client, system, schema, content, *a, **k)
        _patch(P, "structured", structured)
    # "ping" is applied inside run_ping.


def _check(ok, stage=None, platform=None, reason=""):
    return {"ok": ok, "stage": stage, "platform": platform, "reason": clean_reason(reason)}


def read_video(P, cfg, platform, aclient, sink, full):
    """The real fill_source() on the platform's test video(s).
    -> (check, soft, gone, stages, a). `a` carries a["source"] for run_script()."""
    gone = []
    vids = cfg["videos"][platform]
    for idx, v in enumerate(vids):
        rec = {}
        install_guards(P, rec)
        a = {"id": "canary", "sourceUrl": v["url"]}
        timings, notes, soft = {}, [], []

        def done(check):
            stages = dict(timings)
            stages.update({"frames": rec.get("frames", 0), "cover_bytes": rec.get("cover_bytes", 0),
                           "clip_bytes": rec.get("clip_bytes", 0), "probed": rec.get("probed"),
                           "video": idx})
            return check, soft, gone, stages, a

        if P.link_verdict(v["url"]) is not None:
            # The validator disagrees with a known-good link: the validator is
            # wrong, so the backup would only repeat it.
            return done(_check(False, "link", platform, "link check refused a known-good video"))
        try:
            meta = P.fetch_meta(v["url"]) or {}
        except Exception:  # noqa: BLE001
            meta = {}
        if not meta:
            soft.append("meta")
        try:
            P.fill_source(a, aclient, None, notes, timings, usage_sink=sink,
                          length_hint=lambda w, m=meta: m.get("duration"),
                          on_frames=lambda fr: rec.__setitem__("frames", len(fr)))
        except P.FetchFailed as e:
            _, cls = P.fetch_class(e)
            if cls == "input" and idx < len(vids) - 1:
                gone.append(idx)
                continue
            return done(_check(False, "download", platform, clean_reason(e)))
        except P.CreatorFacing as e:
            # A known-short video was refused: the length gate is broken.
            return done(_check(False, "length", platform, f"refused as {e.key}"))
        except Exception as e:  # noqa: BLE001
            last = list(timings)[-1] if timings else "download"
            stage = last if last in ("download", "length", "transcribe", "frames") else "after " + last
            return done(_check(False, stage, platform, f"{type(e).__name__}: {e}"))
        src = a.get("source") or {}
        s = src.get("script") or {}
        if v.get("speech") and (not s.get("has_speech") or len((s.get("text") or "").strip()) < 20):
            return done(_check(False, "transcribe", platform, "no speech from a video that has speech"))
        if not rec.get("frames"):
            return done(_check(False, "frames", platform, "0 frames extracted"))
        if not rec.get("cover_bytes"):
            soft.append("cover")
        if not rec.get("clip_bytes"):
            soft.append("clip")
        if full:
            if not src.get("shots"):
                soft.append("shots")
            if not src.get("tags"):
                soft.append("tags")
        return done(_check(True, platform=platform))
    # Unreachable: the last video's input failure falls to a hard failure above.
    return _check(False, "download", platform, "no test video"), [], gone, {}, {}


def run_script(P, cfg, a, aclient, sink, platform=None):
    """The creator path's order after fill_source (process_group then run_entry):
    the format, then the branded adaptation. -> (check "script", soft)."""
    P._USAGE_LOCAL.d = sink
    notes, timings = [], {}
    if not P.extract_format(aclient, a, notes, timings) or not (a.get("format") or {}).get("beats"):
        why = (a.get("aiFail") or {}).get("reason") or "format has no beats"
        return _check(False, "format", platform, why), []
    a["brandId"] = cfg["brand"]["id"]
    creator = {"name": cfg["creator"]["name"], "brands": [cfg["brand"]]}
    try:
        P.fill_adaptation(a, creator, aclient, notes, timings, fuse=False)
    except Exception as e:  # noqa: BLE001
        why = (a.get("aiFail") or {}).get("reason") or f"{type(e).__name__}: {e}"
        return _check(False, "adapt", platform, why), []
    return _check(True, platform=platform), (["thin"] if a.get("thin") else [])


def run_ping(P, aclient, sink, fault=None):
    """One 16-token call: the key, the balance and the model id all answered.
    The same shape warm_prefixes() already sends in production. A stop_reason of
    max_tokens is still a pass."""
    P._USAGE_LOCAL.d = sink
    try:
        if fault == "ping":
            raise RuntimeError("injected fault (canary.fault)")
        msg = aclient.messages.create(model=P.MODEL, max_tokens=16, output_config={"effort": "low"},
                                      messages=[{"role": "user", "content": "Reply with the word ok."}])
        P.note_usage(P.MODEL, msg)
    except Exception as e:  # noqa: BLE001
        return _check(False, "ping", None, P.api_reason(e))
    return _check(True)


def run_apify(P, cfg, td):
    """"ok" | "skipped:<why>" | "fail:<reason>". Soft, never hard. Primary Instagram video."""
    url = cfg["videos"]["instagram"][0]["url"]
    tok = P.apify_token()
    if not tok:
        return "skipped:no token"
    if not P.apify_budget_ok(tok):
        return "skipped:budget closed"
    path, verdict = P.apify_fetch(url, Path(td))
    if path and (P.media_duration(path) or 0) > 0:
        return "ok"
    return "fail:" + clean_reason(verdict or "no file")


def versions():
    out = {}
    for name, mod in (("yt_dlp", "yt_dlp.version"), ("av", "av"), ("faster_whisper", "faster_whisper"),
                      ("anthropic", "anthropic")):
        try:
            m = __import__(mod, fromlist=["x"])
            out[name] = getattr(m, "__version__", None) or getattr(m, "VERSION", None)
        except Exception:  # noqa: BLE001
            pass
    return {k: str(v) for k, v in out.items() if v}


def _api_key():
    try:
        return envcfg.secret("ANTHROPIC_API_KEY", W.LR.load_env(W.LR.ROOT / ".env").get("ANTHROPIC_API_KEY"),
                             os.environ.get("ANTHROPIC_API_KEY"))
    except ValueError:
        return ""


def _log_check(platform_label, tier, check, secs, stages, usd):
    if check["ok"]:
        tim = " ".join(f"{k} {v}" for k, v in (stages or {}).items()
                       if k in ("download", "transcribe", "frames") and isinstance(v, (int, float)))
        log.info("canary: PASS %s %s %.0fs (%s) $%.4f", tier, platform_label, secs, tim, usd)
    else:
        log.error("canary: FAIL %s (%s, %s): %s", check["stage"], check.get("platform") or platform_label,
                  tier, check["reason"])


def run_pass(plan, cfg, key, dry_run, fault=None, now=None):
    """One pass -> `result` (the shape apply_result takes)."""
    now = now or datetime.now(timezone.utc)
    tier = "full" if plan["full"] else "media"
    result = {"at": iso(now), "boot": plan.get("boot", False), "image": os.environ.get("FLY_IMAGE_REF", ""),
              "versions": versions(), "tier": tier, "platforms": [], "full_platform": plan.get("full_platform"),
              "usd": 0, "checks": {}, "soft": [], "video_gone": {}, "stages": {}}
    checks = result["checks"]
    try:
        P = pipeline()
        checks["pipeline"] = _check(True)
    except Exception as e:  # noqa: BLE001
        checks["pipeline"] = _check(False, "import", None, f"{type(e).__name__}: {e}")
        _log_check("pipeline", tier, checks["pipeline"], 0, {}, 0)
        return result
    try:
        if fault:
            apply_fault(P, fault)
        real = None
        if plan["full"] or plan["ping"]:
            api_key = _api_key()
            if api_key:
                real = P.anthropic_client(api_key)
        sink = {}
        extra_usd = 0.0
        for platform in plan["platforms"]:
            if DEADLINE_HIT:
                break
            is_full = plan["full"] and platform == plan["full_platform"]
            t0 = time.monotonic()
            check, soft, gone, stages, a = read_video(P, cfg, platform, real if (is_full and real) else NoModel(),
                                                      sink, is_full and real is not None)
            checks[platform] = check
            result["platforms"].append(platform)
            result["soft"] += soft
            result["stages"][platform] = stages
            if gone:
                result["video_gone"][platform] = gone
            _log_check(platform, tier, check, time.monotonic() - t0, stages, 0)
            if is_full:
                if real is None:
                    checks["script"] = _check(False, "ping", platform, "no ANTHROPIC_API_KEY")
                elif check["ok"] and not DEADLINE_HIT:
                    checks["script"], soft2 = run_script(P, cfg, a, real, sink, platform)
                    result["soft"] += soft2
                    _log_check("script", tier, checks["script"], 0, {}, 0)
        if plan["apify"] and not DEADLINE_HIT:
            with tempfile.TemporaryDirectory() as td:
                res = run_apify(P, cfg, td)
            log.info("canary: apify %s", res)
            if not res.startswith("skipped"):
                extra_usd += P.APIFY_PRICE_PER_LOOKUP_USD
            if res.startswith("fail:"):
                result["soft"].append("apify")
        if plan["ping"] and not DEADLINE_HIT:
            if real is None:
                checks["ping"] = _check(False, "ping", None, "no ANTHROPIC_API_KEY")
            else:
                checks["ping"] = run_ping(P, real, sink, fault)
            _log_check("ping", tier, checks["ping"], 0, {}, 0)
        result["usd"] = round(sum(P.cost_of(m, d) or 0 for m, d in sink.items()) + extra_usd, 6)
        if plan["full"] and not dry_run and key:
            rows = P.cost_rows(sink, "canary", all(c.get("ok") for c in checks.values()))
            for r in rows:
                r["lane"] = "canary"
            if rows:
                try:
                    P.sb(key, "/rest/v1/lynxr_costs", method="POST", body=rows)
                except Exception as e:  # noqa: BLE001
                    log.warning("canary cost not recorded: %s", str(e)[:90])
    finally:
        restore_patches()
    return result


def _deadline(signum, frame):
    global DEADLINE_HIT
    DEADLINE_HIT = True
    raise TimeoutError(f"canary pass over its {DEADLINE_S}s deadline")


def main(argv=None):
    """Returns the exit code (the __main__ guard passes it to sys.exit)."""
    global DEADLINE_HIT
    envcfg.sanitize_environ()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--boot", action="store_true", help="the first pass after a machine start: both platforms")
    ap.add_argument("--dry-run", action="store_true", help="print the result; write nothing")
    ap.add_argument("--tier", choices=("media", "full"))
    ap.add_argument("--platform", choices=PLATFORMS)
    ap.add_argument("--no-ping", action="store_true")
    ap.add_argument("--apify", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")

    if not os.environ.get("FLY_APP_NAME") and not CANARY_ANYWHERE and not args.dry_run:
        log.info("canary: not on Fly - skipped")
        return EXIT_SKIPPED
    signal.signal(signal.SIGTERM, lambda s, f: sys.exit(143))   # so `with` blocks clean up when the worker preempts

    base = Path(tempfile.gettempdir())
    if base.name != "lynxr-canary":
        base = base / "lynxr-canary"
    shutil.rmtree(base, ignore_errors=True)   # wipes anything a SIGKILLed run left behind
    base.mkdir(parents=True)
    tempfile.tempdir = str(base)

    env = W.LR.load_env(W.LR.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"),
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        log.error("canary: %s", e)
        key = ""
    if not key and not args.dry_run:
        log.error("canary: SUPABASE_SERVICE_ROLE_KEY not set")
        return EXIT_CANARY_BUG
    now = datetime.now(timezone.utc)
    state = (W.ops_get(key, HEALTH_KEY) or {}).get("value") if key else {}
    state = state if isinstance(state, dict) else {}
    image = os.environ.get("FLY_IMAGE_REF", "")

    # 7a. Pause: checked before planning. Nothing else runs.
    if key and is_paused((W.ops_get(key, PAUSE_KEY) or {}).get("value"), now):
        paused = dict(state, paused=True, paused_at=iso(now))   # `at` left unchanged so staleness still shows
        if not args.dry_run:
            W.ops_put(key, HEALTH_KEY, paused)
        log.info("canary: paused (lynxr_ops canary.pause)")
        return EXIT_SKIPPED
    # 7b. Fault: read here, handed to run_pass.
    fault = active_fault((W.ops_get(key, FAULT_KEY) or {}).get("value"), now) if key else None

    try:
        plan = plan_pass(state, now, args.boot, image)
        if args.platform:
            plan["platforms"] = [args.platform]
        if args.tier == "full":
            plan.update(full=True, full_platform=plan["platforms"][0], ping=False)
        elif args.tier == "media":
            # Load-bearing: a fresh or empty state makes plan_pass say the full
            # pass is due, and without this a "media" dry run would silently
            # buy a model pass.
            plan.update(full=False, full_platform=None, apify=False, ping=CANARY_FULL)
        if args.no_ping:
            plan["ping"] = False
        if args.apify:
            plan["apify"] = True
        cfg = json.loads(CONFIG_PATH.read_text())
        DEADLINE_HIT = False
        signal.signal(signal.SIGALRM, _deadline)
        signal.alarm(DEADLINE_S)
        try:
            result = run_pass(plan, cfg, key, args.dry_run, fault, now)
        finally:
            signal.alarm(0)
        new = apply_result(state, result, now)
        if args.dry_run:
            print(json.dumps({"plan": plan, "result": result, "state": new}, indent=1, default=str))
        else:
            W.ops_put(key, HEALTH_KEY, new)
        return exit_code(new, result)
    except Exception:  # noqa: BLE001
        log.error("canary crashed:\n%s", traceback.format_exc())
        if not args.dry_run and key:
            broken = dict(state)
            soft = dict(broken["soft_seen"]) if isinstance(broken.get("soft_seen"), dict) else {}
            soft["canary_error"] = iso(now)
            broken["soft_seen"] = soft   # `at` left unchanged so staleness still shows
            W.ops_put(key, HEALTH_KEY, broken)
        return EXIT_CANARY_BUG


if __name__ == "__main__":
    sys.exit(main())
