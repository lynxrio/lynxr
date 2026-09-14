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

print()
if FAILS:
    print(f"{len(FAILS)} FAILED:")
    for f in FAILS:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
