"""Checks on the automatic retry of failed AI steps, AND on what the creator
reads when a step fails.

Pure-function tests: no network, no model calls, no Supabase. Run with

    ./venv/bin/python pipeline/test_ai_retry.py

They exist because the thing being asserted is a POLICY — which failures come
back on their own and how soon, and which sentence a creator reads for each —
and policy that is only in a comment drifts. The specific regressions:
a lapsed Anthropic balance used to land as status "done" with a note, which
nothing ever reopened without someone passing --redo-ai by hand; and on
2026-08-18 a tester read raw provider text, a duplicated internal step name,
and a wrong status chip, while `tries` counted failed STEPS instead of
attempts and turned a 5-minute retry into a 62-minute one.
"""

import re
import sys
import threading
import time
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


def illegal(a):
    """The state this whole plan makes unwritable: a BRANDED entry that
    finished "done" with no adaptation at all. Before Step 4 this is what a
    branded no-format failure produced — the "source only" chip with raw
    internal notes underneath it, seen live on 2026-08-18."""
    return (a.get("status") == "done" and bool(a.get("brandId"))
            and not ((a.get("adaptation") or {}).get("beats") or []))


def _structured_529(client, system, schema, content, max_tokens=3000):
    raise RuntimeError("Error code: 529 - Overloaded")


# Entries the reliability-plan cases below leave `final` — checked once, at
# the end of the file, by the invariant (Step 9.2): nothing may be final
# while its sentence still promises a retry.
_ALL_FINAL = []


# ---- classification -------------------------------------------------------
# The real strings the Anthropic SDK surfaces, as api_reason() trims them.
check("credit balance -> billing",
      P.ai_failure_kind("Your credit balance is too low to access the Anthropic API"), "billing")
check("quota -> billing", P.ai_failure_kind("insufficient_quota"), "billing")
check("429 -> rate_limit", P.ai_failure_kind("Error code: 429 - rate_limit_error"), "rate_limit")
check("overloaded -> transient", P.ai_failure_kind("Overloaded"), "transient")
check("529 -> transient", P.ai_failure_kind("Error code: 529"), "transient")
check("timeout -> transient", P.ai_failure_kind("Request timed out"), "transient")
check("no beats -> content",
      P.ai_failure_kind("the model returned a script with no beats"), "content")
check("refusal -> content", P.ai_failure_kind("stop_reason: refusal"), "content")

# ---- CREATOR_NOTES: the registry sweep, not a case list --------------------
# Every sentence a creator can ever be shown, checked the same way, so a new
# key added later is covered automatically rather than only if someone
# remembers to add a case for it.
for _key in P.CREATOR_NOTES:
    _text = P.note_text(_key, tries=8, cap=25)
    check(f"CREATOR_NOTES[{_key!r}] is non-empty", bool(_text), True)
    check(f"CREATOR_NOTES[{_key!r}] has no unresolved slot", "{" in _text, False)
    check(f"CREATOR_NOTES[{_key!r}] is needle-free",
          any(n in _text.lower() for n in P.RAW_TEXT_NEEDLES), False)

# ---- every FETCH_FAILURES key (and the default) exists in CREATOR_NOTES ----
# A typo here would KeyError inside an except handler in production — set_note
# falls back safely, but fetch_failure()'s caller expects a real sentence.
for _retryable, _key, _needles in P.FETCH_FAILURES:
    check(f"FETCH_FAILURES key {_key!r} is a real CREATOR_NOTES entry",
          _key in P.CREATOR_NOTES, True)
_default_key, _default_retryable = P.fetch_failure("something nobody has seen before")
check("fetch_failure()'s default key is a real CREATOR_NOTES entry",
      _default_key in P.CREATOR_NOTES, True)

# ---- set_note cannot be handed prose ---------------------------------------
_a = {}
P.set_note(_a, "gave_up", tries="Overloaded 529")   # non-numeric slot dropped
check("set_note: a non-numeric format value is dropped, not interpolated",
      any(n in _a["note"].lower() for n in P.RAW_TEXT_NEEDLES), False)

_a2 = {}
P.set_note(_a2, "no-such-key")
check("set_note: an unknown key does not raise and falls back",
      _a2.get("note"), P.CREATOR_NOTES["fallback"][0])
check("set_note: the fallback's kind is 'ours'", _a2.get("noteKind"), "ours")

# ---- structural: exactly ONE writer of a["note"] ---------------------------
_src = Path(P.__file__).read_text()
_writers = re.findall(r'\[\s*["\']note["\']\s*\]\s*=', _src)
check("exactly one writer of a['note'] in process_adaptations.py — see set_note()",
      len(_writers), 1)
check("no .setdefault(\"note\" escape hatch around set_note()",
      '.setdefault("note"' in _src, False)

# ---- driven end-to-end over the real paths, not the three known ones ------
# A two-brand group on one video, run through the real process_group ->
# fill_adaptation -> run_entry chain, with only the network/model boundary
# stubbed. Proves Defect 3 (the duplicate per-entry format call) is gone at
# its SOURCE, and that neither entry lands in the illegal state.
_ORIG_SB = P.sb
_ORIG_FETCH_META = P.fetch_meta
_ORIG_UPSERT_SOURCE = P.upsert_source
_ORIG_UPSERT_VIDEO = P.upsert_video
_ORIG_FILL_SOURCE = P.fill_source
_ORIG_STRUCTURED = P.structured
try:
    P.sb = lambda key, path, method="GET", body=None, raw=False: [{"data": {"adaptations": []}}]
    P.fetch_meta = lambda url: {}
    P.upsert_source = lambda key, a: None
    P.upsert_video = lambda key, a: None

    def _stub_fill_source(a, aclient, key, notes, timings, publish=None):
        a["source"] = {"platform": "tiktok", "script": {"has_speech": False}, "shots": []}
        return True

    _structured_calls = []

    def _stub_structured(client, system, schema, content, max_tokens=3000):
        _structured_calls.append(1)
        raise RuntimeError("Error code: 529 - Overloaded")

    P.fill_source = _stub_fill_source
    P.structured = _stub_structured

    _brand1 = {"id": "b1", "name": "Acme"}
    _brand2 = {"id": "b2", "name": "Widgets"}
    _e1 = {"id": "e2e00001", "brandId": "b1", "sourceUrl": "https://tiktok.com/@x/video/9"}
    _e2 = {"id": "e2e00002", "brandId": "b2", "sourceUrl": "https://tiktok.com/@x/video/9"}
    _group = [("cid-e2e-1", {"name": "c1", "brands": [_brand1]}, _e1),
              ("cid-e2e-2", {"name": "c2", "brands": [_brand2]}, _e2)]

    P.process_group("fake-key", object(), _group)

    check("Defect 3: structured() called exactly once for the whole group",
          len(_structured_calls), 1)
    for _label, _e in (("rep", _e1), ("sibling", _e2)):
        check(f"e2e {_label}: status error", _e.get("status"), "error")
        check(f"e2e {_label}: note is the ai_ours sentence",
              _e.get("note"), P.CREATOR_NOTES["ai_ours"][0])
        check(f"e2e {_label}: noteKind ours", _e.get("noteKind"), "ours")
        check(f"e2e {_label}: retryable", _e.get("retryable"), True)
        check(f"e2e {_label}: aiFail kind transient (fast schedule)",
              (_e.get("aiFail") or {}).get("kind"), "transient")
        check(f"e2e {_label}: not the illegal state", illegal(_e), False)
        check(f"e2e {_label}: note carries no raw text",
              any(n in (_e.get("note") or "").lower() for n in P.RAW_TEXT_NEEDLES), False)
        _diag = (_e.get("diag") or "") + str((_e.get("aiFail") or {}).get("reason") or "")
        check(f"e2e {_label}: the raw text was KEPT, just not shown (diag/aiFail.reason)",
              "overloaded" in _diag.lower(), True)

    # wants_work() reopens both on the FAST schedule, not only the 6h cooldown —
    # backdate the marker past the 5-minute transient slot to prove it.
    _e1["aiFail"]["at"] = ago(6)
    check("e2e rep: wants_work reopens on the transient schedule, not the 6h floor",
          P.wants_work(_e1, cooldown_hours=6, lease_minutes=25, min_age_seconds=0,
                       redo_ai=False), True)
finally:
    P.sb = _ORIG_SB
    P.fetch_meta = _ORIG_FETCH_META
    P.upsert_source = _ORIG_UPSERT_SOURCE
    P.upsert_video = _ORIG_UPSERT_VIDEO
    P.fill_source = _ORIG_FILL_SOURCE
    P.structured = _ORIG_STRUCTURED

# ---- tries count ATTEMPTS, not failed steps -------------------------------
# WHY THIS CASE STAMPS attemptId, NOT attemptedAt (as the original version of
# this test did): hand-building `a = {"attemptedAt": ...}` and THEN calling
# mark_ai_fail three times makes every mark "after the stamp" — the one
# sub-case that was always correct, and the reason this test passed while
# production miscounted. In production the shot-list, tag and group-format
# marks are all made inside process_group, BEFORE run_entry ever stamps
# anything, so each one used to compare against None or the previous pass's
# value. See the process_group-driven case below for that real ordering
# (it fails on unmodified code: got 3, want 1).
a = {"attemptId": "attempt-0001"}
P.mark_ai_fail(a, "credit balance is too low")   # shot list
P.mark_ai_fail(a, "credit balance is too low")   # tags
P.mark_ai_fail(a, "credit balance is too low")   # format extraction
check("three failed steps in one pass = 1 try", a["aiFail"]["tries"], 1)
check("kind recorded", a["aiFail"]["kind"], "billing")

a["attemptId"] = "attempt-0002"                  # the next pass
P.mark_ai_fail(a, "credit balance is too low")
check("second pass = 2 tries", a["aiFail"]["tries"], 2)

# ---- the backoff ----------------------------------------------------------
billing = lambda tries, mins: {"aiFail": {"kind": "billing", "tries": tries, "at": ago(mins)}}
check("billing try 1, 5m ago -> not yet", P.ai_retry_due(billing(1, 5)), False)
check("billing try 1, 16m ago -> due", P.ai_retry_due(billing(1, 16)), True)
check("billing try 2, 16m ago -> not yet (30m)", P.ai_retry_due(billing(2, 16)), False)
check("billing try 2, 31m ago -> due", P.ai_retry_due(billing(2, 31)), True)
check("billing try 6, 5h ago -> not yet (6h)", P.ai_retry_due(billing(6, 300)), False)
check("billing try 6, 7h ago -> due", P.ai_retry_due(billing(6, 420)), True)
check("out of tries -> never again", P.ai_retry_due(billing(P.AI_MAX_TRIES, 10_000)), False)

check("rate limit try 1, 6m ago -> due",
      P.ai_retry_due({"aiFail": {"kind": "rate_limit", "tries": 1, "at": ago(6)}}), True)

# The whole point of classifying: a model that will not write beats for THIS
# source will not write them in fifteen minutes either, so no timer touches it.
check("content failure never auto-retries",
      P.ai_retry_due({"aiFail": {"kind": "content", "tries": 1, "at": ago(10_000)}}), False)
check("no marker at all -> nothing to retry", P.ai_retry_due({}), False)

# ---- the real ordering, through process_group ------------------------------
# FAILS ON TODAY'S CODE: got 3, want 1. The hand-built case above always
# passed because it stamps the token and THEN calls mark_ai_fail — the one
# sub-case that was always correct. In production, fill_source's shot-list
# and tag failures happen INSIDE process_group, before run_entry ever stamps
# anything — so this stub mimics that contract: two marks from the source
# phase, then a real extract_format() failure for the third.
_ORIG_SB = P.sb
_ORIG_FETCH_META = P.fetch_meta
_ORIG_UPSERT_SOURCE = P.upsert_source
_ORIG_UPSERT_VIDEO = P.upsert_video
_ORIG_FILL_SOURCE = P.fill_source
_ORIG_STRUCTURED = P.structured
try:
    P.sb = lambda key, path, method="GET", body=None, raw=False: [{"data": {"adaptations": []}}]
    P.fetch_meta = lambda url: {}
    P.upsert_source = lambda key, a: None
    P.upsert_video = lambda key, a: None

    def _stub_fill_source_two_marks(a, aclient, key, notes, timings, publish=None):
        a["source"] = {"platform": "tiktok", "script": {"has_speech": False}, "shots": []}
        notes.append("shot list failed: Error code: 529 - Overloaded")
        P.mark_ai_fail(a, "Error code: 529 - Overloaded")   # shot list
        notes.append("tags failed: Error code: 529 - Overloaded")
        P.mark_ai_fail(a, "Error code: 529 - Overloaded")   # tags
        return True

    def _stub_structured_529(client, system, schema, content, max_tokens=3000):
        raise RuntimeError("Error code: 529 - Overloaded")

    P.fill_source = _stub_fill_source_two_marks
    P.structured = _stub_structured_529   # real extract_format() runs into this

    _rbrand = {"id": "b1", "name": "Acme"}
    _sbrand = {"id": "b2", "name": "Widgets"}
    _rep = {"id": "cad000r1", "brandId": "b1", "sourceUrl": "https://tiktok.com/@x/video/7"}
    _sib = {"id": "cad000s1", "brandId": "b2", "sourceUrl": "https://tiktok.com/@x/video/7"}
    _cgroup = [("cid-cad-r", {"name": "cr", "brands": [_rbrand]}, _rep),
               ("cid-cad-s", {"name": "cs", "brands": [_sbrand]}, _sib)]

    P.process_group("fake-key", object(), _cgroup)

    check("three failed steps across one process_group pass = 1 try",
          _rep.get("aiFail", {}).get("tries"), 1)
    check("sibling's inherited marker counts once, not once per step",
          _sib.get("aiFail", {}).get("tries"), 1)

    # The schedule that follows: a fresh (tries=1) transient marker is on the
    # 5-minute slot.
    check("5-minute slot: due at 6 minutes",
          P.ai_retry_due({"aiFail": {"kind": "transient", "tries": 1, "at": ago(6)}}), True)
    check("5-minute slot: not yet at 4 minutes",
          P.ai_retry_due({"aiFail": {"kind": "transient", "tries": 1, "at": ago(4)}}), False)
    # The counterfactual this removes — the miscounted shape from 644ba12d's
    # own row (tries drove to 3, then 6, moving the wait from 5min to 60min).
    check("counterfactual: tries=3, 6m ago -> NOT due (20m slot)",
          P.ai_retry_due({"aiFail": {"kind": "transient", "tries": 3, "at": ago(6)}}), False)
    check("counterfactual: tries=6, 30m ago -> NOT due (60m slot, 644ba12d's actual wait)",
          P.ai_retry_due({"aiFail": {"kind": "transient", "tries": 6, "at": ago(30)}}), False)

    # A SECOND pass mints a NEW token, so it counts once more — not six.
    P.process_group("fake-key", object(), _cgroup)
    check("a second pass counts to 2, not 6", _rep.get("aiFail", {}).get("tries"), 2)
    check("a second pass, sibling too", _sib.get("aiFail", {}).get("tries"), 2)

    # ---- the healing rule (Step 11), both directions -----------------------
    # A marker whose `attempt` equals the CURRENT pass's token: an entry that
    # ends the pass WITH beats has aiFail popped and a `healed` breadcrumb left
    # behind; an original-script entry that ends the pass with NO format KEEPS
    # its marker — the regression Step 3 would otherwise have introduced.
    _healed_beats = {"id": "heal0001", "attemptId": "tok-heal-1",
                      "aiFail": {"kind": "transient", "tries": 2, "attempt": "tok-heal-1",
                                 "at": ago(3), "reason": "Error code: 529 - Overloaded"},
                      "format": {"name": "x"},
                      "adaptation": {"beats": [{"t": "0-3s", "say": "hi", "do": "", "show": ""}]}}
    if (_healed_beats.get("format") or ((_healed_beats.get("adaptation") or {}).get("beats") or [])):
        _prev = _healed_beats.pop("aiFail", None)
        if _prev:
            _healed_beats["healed"] = {"kind": _prev.get("kind"),
                                       "tries": int(_prev.get("tries") or 0),
                                       "at": P.now_iso()}
    check("healing: aiFail popped once the pass produced something usable",
          _healed_beats.get("aiFail"), None)
    check("healing: breadcrumb kind", (_healed_beats.get("healed") or {}).get("kind"), "transient")
    check("healing: breadcrumb tries", (_healed_beats.get("healed") or {}).get("tries"), 2)
    check("healing: breadcrumb has a timestamp",
          bool((_healed_beats.get("healed") or {}).get("at")), True)

    _no_format_orig = {"id": "heal0002", "attemptId": "tok-heal-2",
                        "aiFail": {"kind": "transient", "tries": 1, "attempt": "tok-heal-2",
                                   "at": ago(6), "reason": "Error code: 529 - Overloaded"},
                        "format": None, "adaptation": None}
    if (_no_format_orig.get("format")
            or ((_no_format_orig.get("adaptation") or {}).get("beats") or [])):
        _no_format_orig.pop("aiFail", None)   # would NOT run — nothing usable this pass
    check("healing: an original-script entry with NO format KEEPS its marker",
          bool(_no_format_orig.get("aiFail")), True)
    check("healing: ...and is still ai_retry_due-eligible",
          P.ai_retry_due(_no_format_orig), True)
finally:
    P.sb = _ORIG_SB
    P.fetch_meta = _ORIG_FETCH_META
    P.upsert_source = _ORIG_UPSERT_SOURCE
    P.upsert_video = _ORIG_UPSERT_VIDEO
    P.fill_source = _ORIG_FILL_SOURCE
    P.structured = _ORIG_STRUCTURED

# ---- giving up ------------------------------------------------------------
# Only when there is nothing usable. An entry that got its format and lost only
# its shot list is a working card with a gap, not an error.
check("exhausted with no format -> give up",
      P.ai_gave_up({"aiFail": {"kind": "billing", "tries": P.AI_MAX_TRIES}}), True)
check("exhausted BUT has a format -> leave it alone",
      P.ai_gave_up({"aiFail": {"kind": "billing", "tries": P.AI_MAX_TRIES},
                    "format": {"name": "x"}}), False)
check("still has tries -> not given up",
      P.ai_gave_up({"aiFail": {"kind": "billing", "tries": 2}}), False)
check("content failure is never 'given up on' by the timer",
      P.ai_gave_up({"aiFail": {"kind": "content", "tries": 99}}), False)

# ---- needle-list drift: process_adaptations and watchdog must agree --------
# watchdog.py may not import this module (its import runs logging.basicConfig
# and mkdir("output/")), so the needle list is duplicated by hand there.
import watchdog as W  # noqa: E402
check("RAW_TEXT_NEEDLES matches watchdog.RAW_NOTE_NEEDLES",
      tuple(P.RAW_TEXT_NEEDLES), tuple(W.RAW_NOTE_NEEDLES))

# ---- gave-up: the sentence, on BOTH the success path and the raising path,
# and the refund (option (b)) ------------------------------------------------
_ORIG_SB = P.sb
_ORIG_FETCH_META = P.fetch_meta
_ORIG_UPSERT_SOURCE = P.upsert_source
_ORIG_UPSERT_VIDEO = P.upsert_video
try:
    _sb_calls = []

    def _rec_sb(key, path, method="GET", body=None, raw=False):
        _sb_calls.append((method, path))
        return [{"data": {"adaptations": []}}]

    def _refund_count():
        return sum(1 for m, p in _sb_calls if p == "/rest/v1/rpc/refund_script")

    P.sb = _rec_sb
    P.fetch_meta = lambda url: {}
    P.upsert_source = lambda key, a: None
    P.upsert_video = lambda key, a: None

    # -- gives up, SUCCESS path (no-brand entry; fill_adaptation never raises) --
    _giveup_noband = {"id": "give0001",
                       "aiFail": {"kind": "transient", "tries": P.AI_MAX_TRIES,
                                  "attempt": "tok-x", "at": ago(10),
                                  "reason": "Error code: 529 - Overloaded"}}
    _sb_calls.clear()
    P.run_entry("fake-key", "cid-give-1", {"brands": []}, _giveup_noband, None, [], False)
    check("gave-up (success path): status error", _giveup_noband.get("status"), "error")
    check("gave-up (success path): sentence contains the try count",
          "8" in (_giveup_noband.get("note") or ""), True)
    check("gave-up (success path): note is needle-free",
          any(n in (_giveup_noband.get("note") or "").lower() for n in P.RAW_TEXT_NEEDLES), False)
    check("gave-up (success path): refund posted exactly once", _refund_count(), 1)

    # -- gives up, RAISING path (branded, no format — Step 4's raise) --------
    _giveup_brand = {"id": "give0002", "brandId": "b1",
                      "aiFail": {"kind": "transient", "tries": P.AI_MAX_TRIES,
                                 "attempt": "tok-y", "at": ago(10),
                                 "reason": "Error code: 529 - Overloaded"}}
    _sb_calls.clear()
    P.run_entry("fake-key", "cid-give-2", {"brands": [{"id": "b1", "name": "Acme"}]},
                _giveup_brand, None, [], False)
    check("gave-up (raising path): status error", _giveup_brand.get("status"), "error")
    check("gave-up (raising path): sentence contains the try count",
          "8" in (_giveup_brand.get("note") or ""), True)
    check("gave-up (raising path): note is needle-free",
          any(n in (_giveup_brand.get("note") or "").lower() for n in P.RAW_TEXT_NEEDLES), False)
    check("gave-up (raising path): refund posted exactly once", _refund_count(), 1)

    # -- delivers a script: no refund at all ---------------------------------
    _delivered = {"id": "give0003", "format": {"name": "predetermined"}}
    _sb_calls.clear()
    P.run_entry("fake-key", "cid-give-3", {"brands": []}, _delivered, None, [], False)
    check("delivered script: status done", _delivered.get("status"), "done")
    check("delivered script: no refund posted", _refund_count(), 0)

    # -- still retrying below AI_MAX_TRIES: no refund ------------------------
    _retrying = {"id": "give0004",
                 "aiFail": {"kind": "transient", "tries": 2, "attempt": "tok-z",
                            "at": ago(1), "reason": "Error code: 529 - Overloaded"}}
    _sb_calls.clear()
    P.run_entry("fake-key", "cid-give-4", {"brands": []}, _retrying, None, [], False)
    check("still retrying: status done", _retrying.get("status"), "done")
    check("still retrying: no refund posted", _refund_count(), 0)
finally:
    P.sb = _ORIG_SB
    P.fetch_meta = _ORIG_FETCH_META
    P.upsert_source = _ORIG_UPSERT_SOURCE
    P.upsert_video = _ORIG_UPSERT_VIDEO

# ---- the marker survives the note being cleared ---------------------------
# process_one pops `note` on every original-script entry, which is exactly why
# the old `"failed" in note` test could never see one.
orig = {"attemptedAt": "2026-08-18T02:00:00Z", "note": "shot list failed: Overloaded"}
P.mark_ai_fail(orig, "Overloaded")
orig.pop("note", None)
check("marker outlives the popped note", bool(orig.get("aiFail")), True)
check("...and is still due after its wait",
      P.ai_retry_due({"aiFail": {**orig["aiFail"], "at": ago(30)}}), True)

# ---- stage() records a duration --------------------------------------------
# creator-latency-60s.md Step 1: the container's log dies with the machine, so
# per-stage timings have to live on the row, not just in fly logs.
_timings = {}
with P.stage(_timings, "download"):
    time.sleep(0.01)
check("stage() records a key", "download" in _timings, True)
check("stage() records a positive duration", _timings.get("download", 0) > 0, True)

# ---- wants_work() / too_young() respects --min-age-seconds ----------------
# Step 11c: the GitHub fallback passes --min-age-seconds 180 so it stays a
# genuine backstop for Fly rather than racing it for the claim.
check("too_young: 0 threshold never withholds anything",
      P.too_young({"addedAt": P.now_iso()}, 0), False)
check("too_young: just-added entry, 180s threshold -> too young",
      P.too_young({"addedAt": ago(0)}, 180), True)
check("too_young: 5-minutes-old entry, 180s threshold -> old enough",
      P.too_young({"addedAt": ago(5)}, 180), False)
check("too_young: no addedAt at all -> never withheld",
      P.too_young({}, 180), False)

# ---- cached_source() returns None when the row has no format --------------
# Step 8: the source half of a script is a property of the VIDEO, and a row
# missing a format (or a script) is not a usable cache hit.
_ORIG_SB = P.sb
try:
    P.sb = lambda key, path, method="GET", body=None, raw=False: [
        {"platform": "tiktok", "script": {"text": "hi"}, "shots": [], "tags": {}, "format": None}]
    check("cached_source: None when format is missing",
          P.cached_source("fake-key", "https://tiktok.com/@x/video/1"), None)

    P.sb = lambda key, path, method="GET", body=None, raw=False: []
    check("cached_source: None when there is no row at all",
          P.cached_source("fake-key", "https://tiktok.com/@x/video/1"), None)

    P.sb = lambda key, path, method="GET", body=None, raw=False: [
        {"platform": "tiktok", "script": {"text": "hi", "duration": 12},
         "shots": [{"t": 0}], "tags": {"a": 1}, "format": {"name": "x"}}]
    hit = P.cached_source("fake-key", "https://tiktok.com/@x/video/1")
    check("cached_source: a hit when format AND script are both present",
          bool(hit) and hit.get("format", {}).get("name"), "x")
finally:
    P.sb = _ORIG_SB

# ---- fetch_failure(): human wording, and what must NOT offer a retry -------
# The wall cases must come back retryable=False so creator.js hides Try again.
# The DEFAULT matters more than any of them: an unrecognised error has to stay
# retryable, or a transient outage becomes a card with no way forward.
check("age-gated is permanent",
      P.fetch_failure("ERROR: [TikTok] 752: This post may not be comfortable "
                      "for some audiences. Log in for access.")[1], False)
check("private is permanent",
      P.fetch_failure("ERROR: [youtube] x: Private video. Sign in if you have access")[1], False)
check("deleted is permanent",
      P.fetch_failure("ERROR: Video unavailable")[1], False)
check("404 is permanent",
      P.fetch_failure("ERROR: unable to download: HTTP Error 404: Not Found")[1], False)
check("unsupported link is permanent",
      P.fetch_failure("ERROR: Unsupported URL: https://example.com/nope")[1], False)
check("geo block is permanent",
      P.fetch_failure("ERROR: The uploader has not made this video available "
                      "in your country")[1], False)
check("a timeout is NOT permanent",
      P.fetch_failure("HTTPSConnectionPool(host='x'): Read timed out.")[1], True)
check("an unknown error is NOT permanent",
      P.fetch_failure("ERROR: something nobody has seen before")[1], True)
check("the age-gated message carries no yt-dlp jargon",
      any(j in P.fetch_failure("This post may not be comfortable for some "
                               "audiences. Log in for access.")[0].lower()
          for j in ("cookies", "yt-dlp", "--", "error:")), False)

# ---- graft_adaptations' per-cid lock ---------------------------------------
# Step 7b: two threads grafting the SAME creator must not run their
# read-modify-write concurrently (one write would be lost); two threads on
# DIFFERENT creators must not block each other at all.
#
# The overlap has to be measured on the CRITICAL SECTION (the GET while
# holding the lock), not on the whole graft_adaptations() call — the calling
# thread starts its clock before it even tries to acquire the lock, so a
# thread blocked waiting for it would still look "overlapping" by that
# measure regardless of whether the lock did anything.
try:
    def make_fake_sb_graft(events, events_lock):
        def fake_sb_graft(key, path, method="GET", body=None, raw=False):
            if method == "GET":
                cid = path.split("id=eq.")[1].split("&")[0]
                t0 = time.monotonic()
                time.sleep(0.05)          # a window wide enough to catch an overlap
                with events_lock:
                    events.append((cid, t0, time.monotonic()))
                return [{"data": {"adaptations": []}}]
            return None
        return fake_sb_graft

    def run_graft(cid):
        P.graft_adaptations("fake-key", cid, [{"id": "a1"}])

    events, events_lock = [], threading.Lock()
    P.sb = make_fake_sb_graft(events, events_lock)
    threads = [threading.Thread(target=run_graft, args=("cid-same-a",)) for _ in range(2)]
    for t in threads: t.start()
    for t in threads: t.join()
    (_, s1, e1), (_, s2, e2) = events
    check("graft lock serialises two threads on ONE creator",
          s1 < e2 and s2 < e1, False)

    events.clear()
    threads = [threading.Thread(target=run_graft, args=("cid-diff-a",)),
               threading.Thread(target=run_graft, args=("cid-diff-b",))]
    for t in threads: t.start()
    for t in threads: t.join()
    (_, s3, e3), (_, s4, e4) = events
    check("graft lock does NOT serialise two DIFFERENT creators",
          s3 < e4 and s4 < e3, True)
    # ---- renew_claim must hold the SAME lock as graft_adaptations ----------
    # REGRESSION, 2026-08-18. renew_claim() does a read-modify-write of the whole
    # creator row and did NOT take _GRAFT_LOCKS. The heartbeat thread read the row
    # mid-script, the worker thread grafted "done" + 10 beats, and the heartbeat
    # then PATCHed its pre-completion snapshot back — the finished script was
    # erased, the row stayed `running`, the 2.5-minute lease lapsed and the next
    # sweep re-ran and re-billed the same paste. Same creator => must serialise.
    events.clear()
    def run_renew(cid):
        P.renew_claim("fake-key", cid, "a1")
    P.sb = make_fake_sb_graft(events, events_lock)
    threads = [threading.Thread(target=run_graft, args=("cid-mixed",)),
               threading.Thread(target=run_renew, args=("cid-mixed",))]
    for t in threads: t.start()
    for t in threads: t.join()
    (_, s1, e1), (_, s2, e2) = events
    check("renew_claim and graft_adaptations serialise on ONE creator",
          s1 < e2 and s2 < e1, False)

finally:
    P.sb = _ORIG_SB

# ---- run_entry stamps a `rerun` marker on a genuine re-run --------------
# alarms-when-lynxr-breaks.md Step 5b: an entry that already finished (has
# beats and a processedAt) but gets worked AGAIN is the double-bill shape
# from 2026-08-18 (renew_claim raced the completion graft, erased the beats,
# the lease lapsed, the same paste was re-billed). RECORD ONLY — this does
# not change control flow, it stamps `rerun` + bumps `attempts` so
# pipeline/watchdog.py's `rerun:<id8>` alarm can see it. --redo-ai (FORCED)
# is a deliberate owner action and must not be flagged as this shape.
_ORIG_SB = P.sb
_ORIG_FETCH_META = P.fetch_meta
_ORIG_UPSERT_SOURCE = P.upsert_source
_ORIG_UPSERT_VIDEO = P.upsert_video
_ORIG_FORCED = P.FORCED
try:
    # Fed to graft_adaptations()'s re-pull inside run_entry; an empty
    # adaptations list is fine, graft_adaptations just appends `a` back on.
    P.sb = lambda key, path, method="GET", body=None, raw=False: [{"data": {"adaptations": []}}]
    # fetch_meta/upsert_source/upsert_video sit past the graft on run_entry's
    # happy path and hit the network directly (not through P.sb) — stub them
    # so this test makes zero real requests.
    P.fetch_meta = lambda url: {}
    P.upsert_source = lambda key, a: None
    P.upsert_video = lambda key, a: None

    def already_finished_entry():
        return {
            "id": "rerun0001",
            # No matching brand on the creator below, so fill_adaptation
            # RAISES on its "brand not found" branch immediately (Step 3) —
            # no aclient, no model call, and a["adaptation"] is left exactly
            # as set here. run_entry's except handler catches it and marks
            # the entry "error" with the brand_missing sentence.
            "brandId": "brand-does-not-exist",
            "attempts": 1,
            "attemptedAt": "2026-08-18T00:30:00Z",
            "processedAt": "2026-08-18T01:00:00Z",
            "adaptation": {"beats": [{"t": "0-3s", "say": "hi", "do": "", "show": ""}]},
            "claimedBy": "worker-abc",
        }

    P.FORCED = False
    a = already_finished_entry()
    P.run_entry("fake-key", "cid-rerun-1", {"brands": []}, a, None, [], False)
    check("rerun: beats + processedAt + no aiFail -> gets a rerun marker",
          bool(a.get("rerun")), True)
    check("rerun: attempts counted to 2", a.get("attempts"), 2)
    # ---- brand-not-found (Step 3 raises CreatorFacing) ---------------------
    check("brand-not-found: status error", a.get("status"), "error")
    check("brand-not-found: noteKind brand", a.get("noteKind"), "brand")
    check("brand-not-found: not retryable", a.get("retryable"), False)
    check("brand-not-found: note is needle-free",
          any(n in (a.get("note") or "").lower() for n in P.RAW_TEXT_NEEDLES), False)
    check("brand-not-found: not the illegal state",
          illegal(a), False)

    P.FORCED = True
    a2 = already_finished_entry()
    P.run_entry("fake-key", "cid-rerun-2", {"brands": []}, a2, None, [], False)
    check("rerun: FORCED=True (--redo-ai) -> no rerun marker", a2.get("rerun"), None)
finally:
    P.sb = _ORIG_SB
    P.fetch_meta = _ORIG_FETCH_META
    P.upsert_source = _ORIG_UPSERT_SOURCE
    P.upsert_video = _ORIG_UPSERT_VIDEO
    P.FORCED = _ORIG_FORCED

# =============================================================================
# creator-video-to-script-reliability.md — the terminal rules, the invariant,
# the retry count, the thin guard
# =============================================================================

# ---- 1. the stranding case, end to end -------------------------------------
# A branded entry with a format, no beats, already at AI_MAX_TRIES, driven
# through the REAL run_entry with an always-529 structured(). Before Steps
# 1-4 this is the state the whole plan exists to make unreachable: status
# error, final None None, note the generic "video" sentence, wants_work True
# forever (measured, see the plan's Context section).
_ORIG_SB = P.sb
_ORIG_FETCH_META = P.fetch_meta
_ORIG_UPSERT_SOURCE = P.upsert_source
_ORIG_UPSERT_VIDEO = P.upsert_video
_ORIG_STRUCTURED = P.structured
try:
    _strand_calls = []

    def _rec_sb_strand(key, path, method="GET", body=None, raw=False):
        _strand_calls.append((method, path))
        return [{"data": {"adaptations": []}}]

    def _strand_refund_count():
        return sum(1 for m, p in _strand_calls if p == "/rest/v1/rpc/refund_script")

    P.sb = _rec_sb_strand
    P.fetch_meta = lambda url: {}
    P.upsert_source = lambda key, a: None
    P.upsert_video = lambda key, a: None
    P.structured = _structured_529

    _stranded = {"id": "strand01", "brandId": "b1", "format": {"name": "f", "beats": []},
                 "attemptId": "t",
                 "aiFail": {"kind": "transient", "tries": P.AI_MAX_TRIES, "attempt": "t",
                            "at": ago(10), "reason": "Error code: 529 - Overloaded"}}
    _strand_calls.clear()
    P.run_entry("fake-key", "cid-strand", {"brands": [{"id": "b1", "name": "Acme"}]},
                _stranded, None, [], False)
    check("stranding: status error", _stranded.get("status"), "error")
    check("stranding: final True", _stranded.get("final"), True)
    check("stranding: finalWhy gave_up", _stranded.get("finalWhy"), "gave_up")
    check("stranding: refunded exactly once", _strand_refund_count(), 1)
    _stranded["attemptedAt"] = ago(10_000)          # six hours later, and then some
    check("stranding: wants_work False even backdated past the cooldown",
          P.wants_work(_stranded, cooldown_hours=6, lease_minutes=2.5,
                       min_age_seconds=0, redo_ai=False), False)
    _ALL_FINAL.append(_stranded)

    # ---- 6. manual Try again still buys exactly one pass -------------------
    # Take the entry above and apply exactly what .ad-retry does in
    # creator.js: status back to "queued", note/noteKind/attemptedAt cleared.
    # `.ad-retry` deliberately does NOT touch aiFail (Assumptions) — a press
    # still always buys exactly one more pass.
    _stranded["status"] = "queued"
    _stranded.pop("note", None)
    _stranded.pop("noteKind", None)
    _stranded.pop("attemptedAt", None)
    check("manual retry: wants_work True right after Try again clears the note",
          P.wants_work(_stranded, cooldown_hours=6, lease_minutes=2.5,
                       min_age_seconds=0, redo_ai=False), True)
    _passes_before = int(_stranded.get("passes") or 0)
    P.begin_attempt(_stranded)                      # one pass, exactly as process_group does
    P.run_entry("fake-key", "cid-strand", {"brands": [{"id": "b1", "name": "Acme"}]},
                _stranded, None, [], False)
    check("manual retry: final again after the one pass it bought",
          _stranded.get("final"), True)
    check("manual retry: passes increased by exactly 1",
          int(_stranded.get("passes") or 0) - _passes_before, 1)
    _ALL_FINAL.append(_stranded)
finally:
    P.sb = _ORIG_SB
    P.fetch_meta = _ORIG_FETCH_META
    P.upsert_source = _ORIG_UPSERT_SOURCE
    P.upsert_video = _ORIG_UPSERT_VIDEO
    P.structured = _ORIG_STRUCTURED

# ---- 3. the sentence matches the marker (Step 4c) --------------------------
# A branded entry with aiFail.kind == "transient" and tries == 2 failing the
# adapt call gets the ai_ours sentence, not ai_video — today it gets ai_video,
# which blames the creator's video for our 529.
_ORIG_SB = P.sb
_ORIG_FETCH_META = P.fetch_meta
_ORIG_UPSERT_SOURCE = P.upsert_source
_ORIG_UPSERT_VIDEO = P.upsert_video
_ORIG_STRUCTURED = P.structured
try:
    P.sb = lambda key, path, method="GET", body=None, raw=False: [{"data": {"adaptations": []}}]
    P.fetch_meta = lambda url: {}
    P.upsert_source = lambda key, a: None
    P.upsert_video = lambda key, a: None
    P.structured = _structured_529

    _sentence = {"id": "sent0001", "brandId": "b1",
                 "format": {"name": "f", "beats": [{"role": "r", "seconds": 1}]},
                 "attemptId": "tok-sent",
                 "aiFail": {"kind": "transient", "tries": 2, "attempt": "tok-sent",
                            "at": ago(1), "reason": "Error code: 529 - Overloaded"}}
    P.run_entry("fake-key", "cid-sent", {"brands": [{"id": "b1", "name": "Acme"}]},
                _sentence, None, [], False)
    check("step 4c: a 529 of ours gets the ai_ours sentence, not ai_video",
          _sentence.get("note"), P.CREATOR_NOTES["ai_ours"][0])
    check("step 4c: noteKind ours", _sentence.get("noteKind"), "ours")
finally:
    P.sb = _ORIG_SB
    P.fetch_meta = _ORIG_FETCH_META
    P.upsert_source = _ORIG_UPSERT_SOURCE
    P.upsert_video = _ORIG_UPSERT_VIDEO
    P.structured = _ORIG_STRUCTURED

# ---- 4. no_script -----------------------------------------------------------
# A branded entry whose adapt call raises a REFUSAL (content kind, not one of
# AI_FAIL_KINDS' needles) ends final with finalWhy "no_script" and the
# ai_video sentence — a timer cannot fix a refusal, but --redo-ai still can.
_ORIG_SB = P.sb
_ORIG_FETCH_META = P.fetch_meta
_ORIG_UPSERT_SOURCE = P.upsert_source
_ORIG_UPSERT_VIDEO = P.upsert_video
_ORIG_STRUCTURED = P.structured
try:
    P.sb = lambda key, path, method="GET", body=None, raw=False: [{"data": {"adaptations": []}}]
    P.fetch_meta = lambda url: {}
    P.upsert_source = lambda key, a: None
    P.upsert_video = lambda key, a: None

    def _structured_refusal(client, system, schema, content, max_tokens=3000):
        raise RuntimeError("the model declined: this violates content policy")

    P.structured = _structured_refusal

    _refused = {"id": "refuse01", "brandId": "b1",
                "format": {"name": "f", "beats": [{"role": "r", "seconds": 1}]}}
    P.run_entry("fake-key", "cid-refuse", {"brands": [{"id": "b1", "name": "Acme"}]},
                _refused, None, [], False)
    check("no_script: status error", _refused.get("status"), "error")
    check("no_script: final True", _refused.get("final"), True)
    check("no_script: finalWhy no_script", _refused.get("finalWhy"), "no_script")
    check("no_script: the ai_video sentence (it IS about the source)",
          _refused.get("note"), P.CREATOR_NOTES["ai_video"][0])
    check("no_script: wants_work False under the automatic loop",
          P.wants_work(_refused, cooldown_hours=6, lease_minutes=2.5,
                       min_age_seconds=0, redo_ai=False), False)
    _refused["attemptedAt"] = ago(10_000)
    check("no_script: wants_work True under --redo-ai (the manual escape hatch)",
          P.wants_work(_refused, cooldown_hours=6, lease_minutes=2.5,
                       min_age_seconds=0, redo_ai=True), True)
    _ALL_FINAL.append(_refused)
finally:
    P.sb = _ORIG_SB
    P.fetch_meta = _ORIG_FETCH_META
    P.upsert_source = _ORIG_UPSERT_SOURCE
    P.upsert_video = _ORIG_UPSERT_VIDEO
    P.structured = _ORIG_STRUCTURED

# ---- 5. the wall ------------------------------------------------------------
# fill_source raises a permanent, recognised wall (age-gate wording) — every
# entry in the group ends retryable False, final True, finalWhy "wall", the
# fetch_age sentence, no RAW_TEXT_NEEDLES anywhere, wants_work False.
_ORIG_SB = P.sb
_ORIG_FETCH_META = P.fetch_meta
_ORIG_UPSERT_SOURCE = P.upsert_source
_ORIG_UPSERT_VIDEO = P.upsert_video
_ORIG_FILL_SOURCE = P.fill_source
try:
    P.sb = lambda key, path, method="GET", body=None, raw=False: [{"data": {"adaptations": []}}]
    P.fetch_meta = lambda url: {}
    P.upsert_source = lambda key, a: None
    P.upsert_video = lambda key, a: None

    def _wall_fill_source(a, aclient, key, notes, timings, publish=None):
        raise RuntimeError("download failed: ERROR: [TikTok] 1: This post may not be "
                            "comfortable for some audiences. Log in for access.")

    P.fill_source = _wall_fill_source

    _wbrand1 = {"id": "b1", "name": "Acme"}
    _wbrand2 = {"id": "b2", "name": "Widgets"}
    _we1 = {"id": "wall0001", "brandId": "b1", "sourceUrl": "https://tiktok.com/@x/video/99"}
    _we2 = {"id": "wall0002", "brandId": "b2", "sourceUrl": "https://tiktok.com/@x/video/99"}
    _wgroup = [("cid-wall-1", {"name": "w1", "brands": [_wbrand1]}, _we1),
               ("cid-wall-2", {"name": "w2", "brands": [_wbrand2]}, _we2)]

    P.process_group("fake-key", object(), _wgroup)

    for _label, _e in (("rep", _we1), ("sibling", _we2)):
        check(f"wall {_label}: retryable False", _e.get("retryable"), False)
        check(f"wall {_label}: final True", _e.get("final"), True)
        check(f"wall {_label}: finalWhy wall", _e.get("finalWhy"), "wall")
        check(f"wall {_label}: the fetch_age sentence",
              _e.get("note"), P.CREATOR_NOTES["fetch_age"][0])
        check(f"wall {_label}: note carries no raw text",
              any(n in (_e.get("note") or "").lower() for n in P.RAW_TEXT_NEEDLES), False)
        check(f"wall {_label}: wants_work False",
              P.wants_work(_e, cooldown_hours=6, lease_minutes=2.5,
                           min_age_seconds=0, redo_ai=False), False)
        _ALL_FINAL.append(_e)
finally:
    P.sb = _ORIG_SB
    P.fetch_meta = _ORIG_FETCH_META
    P.upsert_source = _ORIG_UPSERT_SOURCE
    P.upsert_video = _ORIG_UPSERT_VIDEO
    P.fill_source = _ORIG_FILL_SOURCE

# ---- 2. the invariant --------------------------------------------------------
# For every entry the cases above leave `final`, its note must never be the
# sentence that promises a retry — checked once, over everything collected,
# rather than only at the three sites that happen to set it today.
for _fe in _ALL_FINAL:
    if _fe.get("final"):
        check(f"invariant: final entry {_fe.get('id')} does not promise a retry",
              _fe.get("note") != P.CREATOR_NOTES["ai_ours"][0], True)

# ---- 7. FINAL_MAX_PASSES backstop -------------------------------------------
# An error entry with no aiFail (the unrecognised-download-failure shape) and
# passes == FINAL_MAX_PASSES is final; one pass earlier it is not.
check("FINAL_MAX_PASSES backstop: at the cap -> exhausted",
      P.final_reason({"status": "error", "passes": P.FINAL_MAX_PASSES}), "exhausted")
check("FINAL_MAX_PASSES backstop: one under the cap -> not yet",
      P.final_reason({"status": "error", "passes": P.FINAL_MAX_PASSES - 1}), "")

# ---- 8. the retry count, exactly as Step 6's local-server proof ------------
import json as _json                                   # noqa: E402
import threading as _threading                          # noqa: E402
from http.server import BaseHTTPRequestHandler, HTTPServer  # noqa: E402

check("ANTHROPIC_MAX_RETRIES is 5 (an env override cannot make this test lie)",
      P.ANTHROPIC_MAX_RETRIES, 5)

_HITS = []


class _OverloadHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        _HITS.append(1)
        b = _json.dumps({"type": "error", "error": {"type": "overloaded_error",
                                                     "message": "Overloaded"}}).encode()
        self.send_response(529)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


_srv = HTTPServer(("127.0.0.1", 0), _OverloadHandler)
_srv_thread = _threading.Thread(target=_srv.serve_forever, daemon=True)
_srv_thread.start()
try:
    _c = P.anthropic_client("not-a-real-key", f"http://127.0.0.1:{_srv.server_address[1]}")
    try:
        _c.messages.create(model="claude-opus-5", max_tokens=16,
                           messages=[{"role": "user", "content": "hi"}])
    except Exception:  # noqa: BLE001 — OverloadedError, expected
        pass
    check("retry count: 6 requests against a local always-529 server",
          len(_HITS), 6)
finally:
    _srv.shutdown()

# ---- 9. thin_script -----------------------------------------------------
check("thin_script: 1 of 6 -> thin", P.thin_script({"beats": [1]}, {"beats": [1, 2, 3, 4, 5, 6]}), True)
check("thin_script: 6 of 6 -> not thin", P.thin_script({"beats": [1] * 6}, {"beats": [1] * 6}), False)
check("thin_script: 4 of 6 -> not thin", P.thin_script({"beats": [1] * 4}, {"beats": [1] * 6}), False)
check("thin_script: 1 of 2 -> not thin (guard, format under 3 beats)",
      P.thin_script({"beats": [1]}, {"beats": [1, 2]}), False)
check("thin_script: empty beats -> thin", P.thin_script({"beats": []}, {}), True)

_ORIG_STRUCTURED = P.structured
try:
    _asked = []

    def _thin_stub(client, system, schema, content, max_tokens=3000):
        _asked.append(content)
        n = 6 if len(_asked) > 1 else 1
        return {"beats": [{"t": "0-3s", "say": "a", "do": "b", "show": "c"}] * n,
                "fit": 0.8, "fit_reason": "r", "hook": "h", "delivery": "spoken",
                "cta": "c", "caption": "c"}

    P.structured = _thin_stub
    _thin_a = {"id": "thin0001", "brandId": "b1",
               "format": {"name": "f", "beats": [{"role": "r", "seconds": 1}] * 6},
               "source": {"script": {"text": "hello", "segments": []}, "shots": []}}
    P.fill_adaptation(_thin_a, {"brands": [{"id": "b1", "name": "Acme"}]}, object(), [], {})
    check("thin_script two-ask: asked twice", len(_asked), 2)
    check("thin_script two-ask: 6 beats on the second answer",
          len(_thin_a["adaptation"]["beats"]), 6)
    check("thin_script two-ask: not thin any more", _thin_a.get("thin"), None)
finally:
    P.structured = _ORIG_STRUCTURED

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
