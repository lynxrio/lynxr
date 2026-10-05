"""Offline checks for the agency campaign lane — campaign_queue.py and
process_campaigns.py. Same check()/FAILS style as pipeline/test_costs.py.

PURE-FUNCTION and monkeypatched-network checks only. No real Supabase or
Anthropic call is ever made by this file.

Run with

    ./venv/bin/python pipeline/test_campaigns.py
"""
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import process_adaptations as P  # noqa: E402
import campaign_queue as Q  # noqa: E402
import process_campaigns as C  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


def check_true(name, cond):
    check(name, bool(cond), True)


NOW = datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc)

# ---- (a) campaign_queue -----------------------------------------------------
logic = Q.claimable_logic(NOW)
check_true("claimable_logic: balanced parens", logic.count("(") == logic.count(")"))
check_true("claimable_logic: contains status.eq.queued", "status.eq.queued" in logic)
check_true("claimable_logic: contains claimed_at.lt at now-3min",
           'claimed_at.lt."2026-09-14T11:57:00Z"' in logic)
check_true("claimable_logic: contains retry_at.lte at now",
           'retry_at.lte."2026-09-14T12:00:00Z"' in logic)

query = Q.claimable_query(NOW)
check_true("claimable_query: no raw double-quote", '"' not in query)

check_true("probe_path: ends &limit=1", Q.probe_path(NOW).endswith("&limit=1"))
check_true("claim_patch_path: starts with the formats table + id filter",
           Q.claim_patch_path("abc123", NOW).startswith("/rest/v1/lynxr_campaign_formats?id=eq."))

# ---- (b) schema well-formedness ---------------------------------------------
FORBIDDEN = ("minimum", "maximum", "minLength", "maxLength")


def walk_schema(node, path="$"):
    problems = []
    if not isinstance(node, dict):
        return problems
    for bad in FORBIDDEN:
        if bad in node:
            problems.append(f"{path}: forbidden key {bad!r}")
    if node.get("type") == "object":
        if node.get("additionalProperties") is not False:
            problems.append(f"{path}: object without additionalProperties:false")
        props = node.get("properties") or {}
        required = set(node.get("required") or [])
        for k in props:
            if k not in required:
                problems.append(f"{path}.{k}: in properties but not required")
        for k, v in props.items():
            problems.extend(walk_schema(v, f"{path}.{k}"))
    if "items" in node:
        problems.extend(walk_schema(node["items"], f"{path}[]"))
    return problems


for schema_name, schema in (("AGENCY_READ_SCHEMA", C.AGENCY_READ_SCHEMA),
                             ("AGENCY_SCRIPT_SCHEMA", C.AGENCY_SCRIPT_SCHEMA)):
    problems = walk_schema(schema)
    check(f"{schema_name}: additionalProperties:false + fully required, no bounds",
          problems, [])

# ---- (c) brand_block ---------------------------------------------------------
check("brand_block({}): one line, 'What it is: (not given)'",
      C.brand_block({}), "What it is: (not given)")

FULL_BC = {
    "name": "Cloey", "company": "Cloey Inc", "niche": "Skincare",
    "description": "a skincare app", "product": "the Cloey app",
    "audience": "young women", "audienceNotes": "20s-30s",
    "painPoints": "dry skin", "features": ["a", "b"],
    "valueProps": "clears skin fast", "tone": "warm, direct",
    "cta": "download the app", "site": "https://cloey.example",
    "notes": "past campaign notes", "habits": "scrolls TikTok at night",
    "goals": "clear skin",
}
full_lines = C.brand_block(FULL_BC).split("\n")
full_labels = [line.split(":", 1)[0] for line in full_lines]
check("brand_block(full dict): lines in the documented order",
      full_labels,
      ["Brand", "What it is", "Product / app", "Niche", "Who it is for",
       "Their main pain points", "Key features", "Value propositions",
       "Brand tone and language", "Call to action to use",
       "Website / app link", "Brand-specific instructions and past campaign notes",
       "Audience daily habits", "Audience goals"])

# ---- (d) script_prompt --------------------------------------------------------
FIXTURE_ANALYSIS = {
    "format": {"name": "f", "beats": [{"role": "hook", "seconds": 2}],
               "product_entry": "early", "why_it_works": "x", "wrapper_removed": ""},
    "production": {"hook_mechanism": "x"},
}
no_instr = C.script_prompt({}, FIXTURE_ANALYSIS, {"instructions": ""})
check_true("script_prompt: empty instructions render as (none)", "(none)" in no_instr)
check_true("script_prompt: no regen block with no note/hook",
           "WHAT THE AGENCY WANTS" not in no_instr)
with_note = C.script_prompt({}, FIXTURE_ANALYSIS, {"instructions": ""}, regen_note="more Gen Z")
check_true("script_prompt: regen block present with a regen note",
           "WHAT THE AGENCY WANTS" in with_note and "more Gen Z" in with_note)
with_hook = C.script_prompt({}, FIXTURE_ANALYSIS, {"instructions": ""}, prev_hook="old hook")
check_true("script_prompt: regen block present with only a previous hook",
           "WHAT THE AGENCY WANTS" in with_hook and "old hook" in with_hook)

# ---- (e) finalize_patch -------------------------------------------------------
ROW_BASE = {"id": "fmt1", "job": "read", "attempts": 0, "source_url": "https://www.tiktok.com/@x/video/1"}

rs = C.finalize_patch("requeue_script", ROW_BASE, NOW, source={"a": 1}, analysis={"b": 2})
check("finalize_patch requeue_script: job=script", rs["job"], "script")
check("finalize_patch requeue_script: status=queued", rs["status"], "queued")
check("finalize_patch requeue_script: attempts=0", rs["attempts"], 0)

row_with_script = {**ROW_BASE, "script": {"hook": "old"}, "edited": {"cta": "x"}}
done_with_prev = C.finalize_patch("done", row_with_script, NOW, script={"hook": "new"})
check_true("finalize_patch done (had a previous script): sets script_prev",
           done_with_prev.get("script_prev") == {"script": {"hook": "old"}, "edited": {"cta": "x"}})
check("finalize_patch done (had a previous script): edited reset to None",
      done_with_prev.get("edited"), None)

done_fresh = C.finalize_patch("done", ROW_BASE, NOW, script={"hook": "new"})
check_true("finalize_patch done (no previous script): omits script_prev",
           "script_prev" not in done_fresh)

err = C.finalize_patch("error", ROW_BASE, NOW, error_kind="off_platform", retryable=False)
check("finalize_patch error off_platform: retryable=False", err["retryable"], False)

ai = C.finalize_patch("ai_requeue", ROW_BASE, NOW, fail_kind="transient")
check("finalize_patch ai_requeue transient at attempts=0: retry_at is now+5min",
      ai["retry_at"], Q.stamp(datetime(2026, 9, 14, 12, 5, tzinfo=timezone.utc)))

# ---- (f) shared-rule inheritance ----------------------------------------------
check_true("AGENCY_SCRIPT_SYSTEM starts with P.ADAPT_SYSTEM",
           C.AGENCY_SCRIPT_SYSTEM.startswith(P.ADAPT_SYSTEM))
check_true("AGENCY_READ_SYSTEM starts with P.FORMAT_SYSTEM",
           C.AGENCY_READ_SYSTEM.startswith(P.FORMAT_SYSTEM))

# ---- (g) pool_ready ------------------------------------------------------------
COMPLETE_SOURCE = {"platform": "tiktok", "script": {"hook": "h", "text": "t"},
                   "shots": [{"t": 0, "visual": "x"}], "tags": {"format_type": "Talking Head"},
                   "clip": "https://cdn.example/clip.mp4", "meta": {}}
COMPLETE_FMT = {"name": "f", "beats": [{"role": "hook", "seconds": 2}],
                "product_entry": "early", "why_it_works": "x", "wrapper_removed": ""}
complete_subject = {"id": "fmt1", "sourceUrl": "https://www.tiktok.com/@x/video/1",
                    "source": COMPLETE_SOURCE, "format": COMPLETE_FMT}
check_true("pool_ready: complete subject is ready", C.pool_ready(complete_subject))
for missing_key, patch in (
    ("format", {"format": None}),
    ("script", {"source": {**COMPLETE_SOURCE, "script": None}}),
    ("shots (empty list)", {"source": {**COMPLETE_SOURCE, "shots": []}}),
    ("tags", {"source": {**COMPLETE_SOURCE, "tags": None}}),
    ("clip", {"source": {**COMPLETE_SOURCE, "clip": None}}),
):
    broken = {**complete_subject, **patch}
    check_true(f"pool_ready: False when {missing_key} is missing", not C.pool_ready(broken))

# ---- (h) agency_seen_path -------------------------------------------------------
check("agency_seen_path: canonicalises and quotes the URL",
      C.agency_seen_path("https://www.instagram.com/reel/ABC123/?igsh=x"),
      "/rest/v1/lynxr_sources?canonical_url=eq.instagram.com%2Freel%2FABC123")

# ---- (i) nothing agency-internal is pooled --------------------------------------
_orig_urlopen = urllib.request.urlopen
_calls = []


class _FakeResp:
    def __init__(self, data=b""):
        self._data = data

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _fake_urlopen(req, *a, **kw):
    body = json.loads(req.data) if req.data else None
    _calls.append((req.full_url, req.get_method(), body))
    return _FakeResp(b"")


urllib.request.urlopen = _fake_urlopen
try:
    sentinel_row = {
        "id": "fmt-sentinel", "source_url": "https://www.tiktok.com/@x/video/999",
        "name": "SENTINEL_CAMPAIGN", "instructions": "SENTINEL_RULES",
        "internal_note": "SENTINEL_NOTE", "created_by": "sentinel@staff.example",
    }
    sentinel_campaign = {"brand_context": {"name": "SENTINEL_BRAND"}}  # noqa: F841 (kept in scope, never passed to pool_source)
    subject = C.pool_subject(sentinel_row, COMPLETE_SOURCE, COMPLETE_FMT)
    result = C.pool_source("k", subject)
    check("pool_source: a complete subject pools", result, "pooled")
    check("pool_source: exactly three requests", len(_calls), 3)
    if len(_calls) == 3:
        (u0, m0, b0), (u1, m1, b1), (u2, m2, b2) = _calls
        check_true("request 1: POST lynxr_sources?on_conflict=canonical_url",
                   m0 == "POST" and "/rest/v1/lynxr_sources?on_conflict=canonical_url" in u0)
        check_true("request 2: POST lynxr_videos?on_conflict=platform,video_id",
                   m1 == "POST" and "/rest/v1/lynxr_videos?on_conflict=platform,video_id" in u1)
        check_true("request 3: PATCH lynxr_sources?canonical_url=eq....",
                   m2 == "PATCH" and u2.startswith(P.SB_URL + "/rest/v1/lynxr_sources?canonical_url=eq."))
        allowed_keys = {"canonical_url", "url", "platform", "last_seen_at", "consent",
                        "script", "shots", "tags", "format", "clip",
                        "views", "likes", "comments", "duration", "creator", "title", "metrics_at"}
        check_true("lynxr_sources body keys are a subset of the allowed list",
                   set(b0.keys()) <= allowed_keys)
        check_true("lynxr_sources body never sets tag_count", "tag_count" not in b0)
        check("PATCH body is exactly {'agency_seen_at': ...}", set(b2.keys()), {"agency_seen_at"})
        blob = json.dumps(_calls)
        check_true("no request body contains a SENTINEL marker",
                   "SENTINEL" not in blob and "sentinel@" not in blob)
finally:
    urllib.request.urlopen = _orig_urlopen

# ---- (j) agency_frame_times -----------------------------------------------------
_ft = C.agency_frame_times({"segments": []}, 16.2)
check_true("agency_frame_times (silent 16s): sorted, <= 14, has the opening plan",
           _ft == sorted(_ft) and len(_ft) <= 14 and all(x in _ft for x in (0.3, 1.0, 1.8, 2.6, 3.4)))
check_true("agency_frame_times (silent 16s): every frame inside the video", all(x < 16.05 for x in _ft))
check_true("agency_frame_times (silent 16s): neighbours >= 0.5s apart",
           min(b - a for a, b in zip(_ft, _ft[1:])) >= 0.5 - 1e-9)
_ft2 = C.agency_frame_times({"segments": []}, 2.0)
check_true("agency_frame_times (2s video): at least 5 frames, all inside", len(_ft2) >= 5 and all(x < 1.85 for x in _ft2))
_ft3 = C.agency_frame_times({"segments": [[s, s + 1, "w"] for s in (0, 2.1, 4.5, 7.0, 9.8, 12.3)]}, 68.8)
# 2.1 is within 0.5s of the opening frame at 1.8, so the plan drops it; the later beat starts survive.
check_true("agency_frame_times (spoken 69s): capped at 14, keeps beat starts 4.5 and 7.0",
           len(_ft3) <= 14 and 4.5 in _ft3 and 7.0 in _ft3)

# ---- (k)-(m) verbatim_beats -------------------------------------------------------
SILENT_SOURCE = {"duration": 16.3, "caption": "an invented caption", "script": {"has_speech": False, "text": ""},
                 "shots": [
                     {"t": 0.3, "visual": "Stand centred holding an empty jar", "onscreen_text": "Out of snacks again?"},
                     {"t": 1.0, "visual": "Tip the jar upside down", "onscreen_text": "Out of snacks again?"},
                     {"t": 1.8, "visual": "Shake it", "onscreen_text": "Out of snacks\nagain?"},
                     {"t": 2.6, "visual": "Toss the jar", "onscreen_text": "try this!"},
                     {"t": 4.2, "visual": "Point at the shelf", "onscreen_text": "stock up"}]}
_vb = C.verbatim_beats(SILENT_SOURCE)
check("verbatim_beats silent: three runs of on-screen text", len(_vb), 3)
check("verbatim_beats silent: beat 0 window", _vb[0]["t"], "0-2.6s")
check("verbatim_beats silent: beat 0 say is empty", _vb[0]["say"], "")
check("verbatim_beats silent: beat 0 do joins the shots",
      _vb[0]["do"], "Stand centred holding an empty jar → Tip the jar upside down → Shake it")
check("verbatim_beats silent: beat 0 show", _vb[0]["show"], "Out of snacks again?")
check("verbatim_beats silent: beat 1 window", _vb[1]["t"], "2.6-4.2s")
check("verbatim_beats silent: beat 2 runs to the end", _vb[2]["t"], "4.2-16.3s")
check("verbatim_beats silent: orig is the beat's own window", [b["orig"] for b in _vb], [b["t"] for b in _vb])

SPOKEN_SOURCE = {"script": {"has_speech": True, "segments": [
    [0, 2, "Stop scrolling."], [2, 4.5, "This app plans my week."],
    [4.5, 9, "Every single Sunday."], [9, 12, "Link in bio."]]},
    "shots": [{"t": 0.5, "visual": "Face to camera", "onscreen_text": ""},
              {"t": 5.0, "visual": "Screen recording of the app", "onscreen_text": "my week"}]}
_vs = C.verbatim_beats(SPOKEN_SOURCE)
check("verbatim_beats spoken: four beats", len(_vs), 4)
check("verbatim_beats spoken: beat 0",
      _vs[0], {"t": "0-2s", "orig": "0-2s", "say": "Stop scrolling.", "do": "Face to camera", "show": ""})
check("verbatim_beats spoken: beat 1 takes the nearest shot", _vs[1]["do"], "Screen recording of the app")
check("verbatim_beats spoken: beat 3 takes the shot exactly 4s away", _vs[3]["do"], "Screen recording of the app")

check("verbatim_beats: nothing to keep gives no beats", C.verbatim_beats({}), [])
_vt = C.verbatim_beats({"script": {"text": "just some words"}})
check_true("verbatim_beats: text only is one beat carrying the text", len(_vt) == 1 and _vt[0]["say"] == "just some words")

# ---- (n) verbatim_script ----------------------------------------------------------
KM_ANALYSIS = {**FIXTURE_ANALYSIS, "production": {"hook_mechanism": "x", "camera": "cam", "setting": "a room"},
               "key_moments": ["Open on the jar", "Toss it"]}
_vsc = C.verbatim_script(SILENT_SOURCE, KM_ANALYSIS)
check_true("verbatim_script: carries every required script field",
           set(C.AGENCY_SCRIPT_SCHEMA["required"]) <= set(_vsc))
check_true("verbatim_script: marked verbatim, no fit", _vsc["verbatim"] is True and _vsc["fit"] is None)
check("verbatim_script: needs are the key moments", _vsc["needs"], KM_ANALYSIS["key_moments"])
check("verbatim_script: framing is the read's camera", _vsc["framing"], "cam")
check("verbatim_script: silent video delivers silent", _vsc["delivery"], "silent")
check("verbatim_script: caption is the original post's", _vsc["caption"], "an invented caption")

# ---- (o) script_prompt blocks -----------------------------------------------------
_km_prompt = C.script_prompt({}, {**FIXTURE_ANALYSIS, "key_moments": ["Open on the jar"]}, {"instructions": ""})
check_true("script_prompt: must-have moments block lists each moment",
           "MUST-HAVE MOMENTS" in _km_prompt and "Open on the jar" in _km_prompt)
_own_prompt = C.script_prompt({}, FIXTURE_ANALYSIS, {"instructions": ""}, staff_needs=["Mine"])
check_true("script_prompt: the agency's own needs block", "THE AGENCY'S OWN NEEDS" in _own_prompt and "- Mine" in _own_prompt)
check_true("script_prompt: neither block with no moments and no own needs",
           "MUST-HAVE MOMENTS" not in no_instr and "THE AGENCY'S OWN NEEDS" not in no_instr)

# ---- (p) finalize_patch carries the read ------------------------------------------
_dn = C.finalize_patch("done", ROW_BASE, NOW, script={"hook": "h"}, source={"s": 1}, analysis={"a": 1})
check_true("finalize_patch done with source+analysis: sets both and job=script",
           _dn.get("source") == {"s": 1} and _dn.get("analysis") == {"a": 1} and _dn.get("job") == "script")
_dn2 = C.finalize_patch("done", ROW_BASE, NOW, script={"hook": "h"})
check_true("finalize_patch done without them: sets neither and no job",
           "source" not in _dn2 and "analysis" not in _dn2 and "job" not in _dn2)
check("finalize_patch error with job: sets job", C.finalize_patch("error", ROW_BASE, NOW, error_kind="x", job="read").get("job"), "read")

# ---- (q) prompts -------------------------------------------------------------------
check_true("AGENCY_SCRIPT_SYSTEM: rule 15 says no slots", "NO SLOTS" in C.AGENCY_SCRIPT_SYSTEM)
check_true("ADAPT_SYSTEM (creator lane) still leaves slots", "LEAVE A SLOT" in P.ADAPT_SYSTEM)
check_true("AGENCY_READ_SCHEMA requires key_moments", "key_moments" in C.AGENCY_READ_SCHEMA["required"])

# ---- (r) write_script --------------------------------------------------------------
_orig_structured = P.structured


def _script(say):
    return {"beats": [{"t": "0-2s", "say": say, "do": "d", "show": ""}, {"t": "2-4s", "say": "ok", "do": "d", "show": ""}]}


def _stub(answers):
    calls = []

    def fake(client, system, schema, content, max_tokens=None):
        calls.append(content)
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a
    return fake, calls


try:
    P.structured, _c = _stub([_script("I had [how many] tabs open"), _script("I had five tabs open")])
    _o, _left = C.write_script(object(), "prompt", FIXTURE_ANALYSIS)
    check_true("write_script: a slot is repaired once", _left == 0 and len(_c) == 2 and "five tabs" in _o["beats"][0]["say"])
    P.structured, _c = _stub([_script("I had five tabs open")])
    _o, _left = C.write_script(object(), "prompt", FIXTURE_ANALYSIS)
    check_true("write_script: no slot, one call", _left == 0 and len(_c) == 1)
    P.structured, _c = _stub([_script("I had [how many] tabs open"), RuntimeError("boom")])
    _o, _left = C.write_script(object(), "prompt", FIXTURE_ANALYSIS)
    check_true("write_script: a failed repair keeps the first answer", _left == 1 and "[how many]" in _o["beats"][0]["say"])
finally:
    P.structured = _orig_structured

# ---- (s) run_format routing ---------------------------------------------------------
_saved = (C.sbx, P.fill_source, P.fetch_meta, P.structured, C.pool_source, C.record_agency_cost)
_patches, _structured_calls, _plans = [], [], []
_FILL_RAISES = []


def _fake_sbx(key, path, method="GET", body=None, prefer=None):
    _patches.append((method, body))
    return [{"id": "x"}] if prefer else None


def _fake_fill(a, aclient, key, notes, timings, publish=None, on_frames=None, usage_sink=None,
               length_hint=None, frame_plan=None):
    _plans.append(frame_plan)
    if _FILL_RAISES:
        raise _FILL_RAISES[0]
    a["source"] = {**SILENT_SOURCE}
    if on_frames:
        on_frames([(0.3, b"x")])
    return True


def _fake_structured(client, system, schema, content, max_tokens=None):
    _structured_calls.append((schema, content))
    if schema is C.AGENCY_READ_SCHEMA:
        return {"format": FIXTURE_ANALYSIS["format"], "production": {"hook_mechanism": "x", "camera": "cam"},
                "key_moments": ["Open on the jar"]}
    return {"title": "t", "fit": 0.5, "fit_reason": "r", "delivery": "silent", "hook": "h", "needs": ["n"],
            "setting": "", "lighting": "", "framing": "", "audio": "",
            "beats": [{"t": "0-2s", "say": "", "do": "d", "show": "s", "orig": "8.14-12s"},
                      {"t": "2-4s", "say": "", "do": "d", "show": "s", "orig": "99-100s"}],
            "cta": "", "caption": "", "creator_note": "", "strategy_note": ""}


def _run(row):
    _patches.clear(); _structured_calls.clear(); _plans.clear()
    base = {"id": "fmtroute", "source_url": "https://www.tiktok.com/@x/video/1", "attempts": 0,
            "campaign_id": "c1", "regen_note": "", "script": None, "edited": None}
    C.run_format("k", object(), {**base, **row}, {"instructions": "", "brand_context": {}})
    final = [b for m, b in _patches if isinstance(b, dict) and "status" in b]
    return final[-1] if final else None


try:
    C.sbx, P.fill_source, P.fetch_meta, P.structured = _fake_sbx, _fake_fill, (lambda u: {"title": "cap"}), _fake_structured
    C.pool_source, C.record_agency_cost = (lambda key, subject: "pooled"), (lambda *a, **k: None)
    KM = {**FIXTURE_ANALYSIS, "key_moments": ["Open on the jar"]}
    # 1. read job, keep it exactly
    f = _run({"job": "read", "script_mode": "verbatim"})
    check_true("route 1: verbatim read job reads once, never writes",
               [c[0] is C.AGENCY_READ_SCHEMA for c in _structured_calls] == [True])
    check_true("route 1: ends done with a verbatim script, source, analysis, job=script",
               f and f["status"] == "done" and f["script"]["verbatim"] is True
               and f["script"]["needs"] == ["Open on the jar"] and "source" in f and "analysis" in f and f["job"] == "script")
    check_true("route 1: the agency frame plan reaches fill_source", _plans == [C.agency_frame_times])
    # 2. script job, verbatim, read already has key moments
    f = _run({"job": "script", "script_mode": "verbatim", "analysis": KM, "source": SILENT_SOURCE})
    check_true("route 2: no model call, done", not _structured_calls and f and f["status"] == "done")
    # 3. script job, verbatim, analysis predates key_moments
    f = _run({"job": "script", "script_mode": "verbatim", "analysis": FIXTURE_ANALYSIS, "source": SILENT_SOURCE})
    check_true("route 3: re-reads once, then done",
               [c[0] is C.AGENCY_READ_SCHEMA for c in _structured_calls] == [True] and f and f["status"] == "done")
    # 4. read job, column absent
    f = _run({"job": "read"})
    check_true("route 4: no script_mode key means adapt: queued for the script job",
               f and f["status"] == "queued" and f["job"] == "script")
    # 5. script job, adapt, staff needs
    f = _run({"job": "script", "script_mode": "adapt", "staff_needs": ["Mine"], "analysis": KM, "source": SILENT_SOURCE})
    _sc = [c for c in _structured_calls if c[0] is C.AGENCY_SCRIPT_SCHEMA]
    check_true("route 5: script call carries the agency's needs and the moments",
               len(_sc) == 1 and "THE AGENCY'S OWN NEEDS" in _sc[0][1] and "MUST-HAVE MOMENTS" in _sc[0][1]
               and f and f["status"] == "done")
    check("route 5: orig normalised against the source's 16.3s", [b["orig"] for b in f["script"]["beats"]], ["8.1-12s", ""])
    # 6. verbatim with nothing to keep
    f = _run({"job": "script", "script_mode": "verbatim", "analysis": KM, "source": {}})
    check_true("route 6: nothing to keep is a retryable verbatim_empty error back to the read job",
               f and f["status"] == "error" and f["error_kind"] == "verbatim_empty" and f["job"] == "read")
    # 7. upgrade re-read cannot download: keep the old read
    _FILL_RAISES.append(RuntimeError("download failed: ERROR: Video unavailable"))
    f = _run({"job": "script", "attempts": 1, "script_mode": "adapt", "analysis": FIXTURE_ANALYSIS, "source": SILENT_SOURCE})
    _FILL_RAISES.clear()
    check_true("route 7: a failed upgrade re-read falls back to the old read, no failed card",
               f and f["status"] == "queued" and f["job"] == "script" and f["analysis"]["key_moments"] == []
               and f["source"] == SILENT_SOURCE)
finally:
    C.sbx, P.fill_source, P.fetch_meta, P.structured, C.pool_source, C.record_agency_cost = _saved

# ---- (t) orig -----------------------------------------------------------------------
check_true("AGENCY beat requires orig", "orig" in C.AGENCY_SCRIPT_SCHEMA["properties"]["beats"]["items"]["required"])
check_true("creator lane's ADAPT_SCHEMA beat has no orig",
           "orig" not in P.ADAPT_SCHEMA["properties"]["beats"]["items"]["properties"])
check_true("AGENCY_SCRIPT_SYSTEM carries rule 17", "17. `orig`" in C.AGENCY_SCRIPT_SYSTEM)
for _in, _d, _want in [("8-12s", 16.3, "8-12s"), ("8.14 - 12.06 s", 0, "8.1-12.1s"), ("0:08-0:12", 0, "8-12s"),
                       ("3.5–7.5s", 0, "3.5-7.5s"), ("15", 16.3, "15-16.3s"), ("12-8s", 0, "12-14s"),
                       ("17-20s", 16.3, ""), ("", 16.3, ""), ("abc", 0, ""), (None, 0, "")]:
    check(f"norm_orig({_in!r}, {_d})", C.norm_orig(_in, _d), _want)
_wo = C.with_orig({"hook": "h", "beats": [{"t": "0-2s", "say": "a", "do": "", "show": ""},
                                          {"t": "2-4s", "say": "b", "do": "", "show": "", "orig": "4 - 6"}]}, 10)
check("with_orig: missing -> '', present -> canonical", [b["orig"] for b in _wo["beats"]], ["", "4-6s"])
check("with_orig: other fields untouched", (_wo["hook"], _wo["beats"][1]["say"]), ("h", "b"))

print()
if FAILS:
    print(f"{len(FAILS)} FAILED:")
    for f in FAILS:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
