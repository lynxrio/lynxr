"""Checks on the watchdog's failure-shape detectors.

Pure-function tests: no network, no Supabase, no real ntfy send. Run with

    ./venv/bin/python pipeline/test_watchdog.py

They exist because the thing being asserted is a POLICY — which shapes page
and at what threshold — and this whole plan exists because a documented alarm
(an `SLA BREACH` line HANDOFF.md and .github/workflows/latency-watch.yml both
described as real-time) turned out never to have been built. A detector that
cannot fail a test is decoration; every check below either proves an alarm
fires when it should, or proves it stays silent when it shouldn't — never only
one side of that.

The `rerun:<id8>` cases were DELIBERATELY INVALIDATED and rewritten as their
own opposite: `done + attempts >= 2 + no aiFail` used to be inferred as a
double-bill, but it is exactly the shape a SUCCESSFUL transient retry ends in
(proven live by adaptation 644ba12d on 2026-08-18 — attempts=3, no aiFail, 11
beats, recovered fine — which paged for real under the old rule). The alarm
now keys on the explicit `rerun` marker only.
"""

import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import watchdog as W  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


def keys_of(alarms):
    return {a["key"] for a in alarms}


def ago(now, seconds):
    return (now - timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def row(creator_id, adaptations):
    return {"id": creator_id, "data": {"adaptations": adaptations}}


NOW = datetime.now(timezone.utc)

# ---- the most important assertion: a healthy set makes zero noise ---------
healthy_rows = [
    row("c1", [
        {"id": "a0000001", "status": "done", "processedAt": ago(NOW, 120),
         "sourceUrl": "https://tiktok.com/@x/video/1", "attempts": 1},
        {"id": "a0000002", "status": "done", "brandId": "b1",
         "adaptation": {"beats": [{"t": "0-3s"}]},
         "processedAt": ago(NOW, 60), "attempts": 1},
    ]),
]
healthy = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("a healthy set produces zero alarms", healthy, [])

# ---- inflight: threshold at 600s -------------------------------------------
stuck_700 = [row("c2", [{"id": "b1111111", "status": "running",
                         "addedAt": ago(NOW, 700)}])]
alarms = W.check_all(stuck_700, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("one entry running 700s -> exactly one inflight: alarm",
      keys_of(alarms), {"inflight:b1111111"})

stuck_500 = [row("c2", [{"id": "b2222222", "status": "running",
                         "addedAt": ago(NOW, 500)}])]
alarms = W.check_all(stuck_500, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("the same shape at 500s -> none", keys_of(alarms), set())

# ---- inflight:many collapses a burst ---------------------------------------
five_stuck = [row("c3", [
    {"id": f"c333333{i}", "status": "running", "addedAt": ago(NOW, 700)}
    for i in range(5)
])]
alarms = W.check_all(five_stuck, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("five in-flight breaches -> one inflight:many, no per-entry keys",
      keys_of(alarms), {"inflight:many"})

# ---- empty-script: done + brandId + no beats -------------------------------
empty_script = [row("c4", [
    {"id": "d4444444", "status": "done", "brandId": "b1",
     "adaptation": {"beats": []}, "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(empty_script, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("done + brandId + beats:[] -> one empty-script:",
      keys_of(alarms), {"empty-script:d4444444"})

# ---- gave-up: the automatic loop stopped and the creator has nothing -------
gave_up_rows = [row("c9", [
    {"id": "h9999991", "status": "error", "final": True, "finalWhy": "gave_up",
     "attemptedAt": ago(NOW, 60), "aiFail": {"kind": "transient", "tries": 8}},
])]
alarms = W.check_all(gave_up_rows, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("error + final + finalWhy gave_up, inside 24h -> exactly one gave-up:",
      keys_of(alarms), {"gave-up:h9999991"})
gave_up_alarm = next(a for a in alarms if a["key"] == "gave-up:h9999991")
gbody = gave_up_alarm["body"]
check("gave-up: body carries no @ (no email)", "@" in gbody, False)
check("gave-up: body carries no http (no URL)", "http" in gbody, False)
check("gave-up: body carries no uuid-shaped id",
      bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", gbody)), False)

gave_up_stale = [row("c9", [
    {"id": "h9999992", "status": "error", "final": True, "finalWhy": "gave_up",
     "attemptedAt": ago(NOW, 25 * 3600), "aiFail": {"kind": "transient", "tries": 8}},
])]
alarms = W.check_all(gave_up_stale, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("the same shape 25h old -> none", "gave-up:h9999992" in keys_of(alarms), False)

gave_up_wall = [row("c9", [
    {"id": "h9999993", "status": "error", "final": True, "finalWhy": "wall",
     "attemptedAt": ago(NOW, 60), "retryable": False},
])]
alarms = W.check_all(gave_up_wall, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("finalWhy wall -> none (a platform wall must not page)",
      "gave-up:h9999993" in keys_of(alarms), False)

# ---- fetch-wall:burst: the download layer itself has broken ----------------
def fetch_wall_rows(source_urls):
    entries = [
        {"id": f"j999999{i}", "status": "error", "noteKind": "fetch",
         "claimedAt": ago(NOW, 60), "sourceUrl": url}
        for i, url in enumerate(source_urls)
    ]
    return [row("c10", entries)]

three_distinct = fetch_wall_rows([
    "https://tiktok.com/@x/video/1", "https://tiktok.com/@x/video/2",
    "https://tiktok.com/@x/video/3"])
alarms = W.check_all(three_distinct, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("3 distinct sourceUrls, error+fetch inside 6h -> one fetch-wall:burst",
      "fetch-wall:burst" in keys_of(alarms), True)
fetch_wall_alarm = next(a for a in alarms if a["key"] == "fetch-wall:burst")
fbody = fetch_wall_alarm["body"]
check("fetch-wall:burst: body carries no @ (no email)", "@" in fbody, False)
check("fetch-wall:burst: body carries no http (no URL)", "http" in fbody, False)
check("fetch-wall:burst: body carries no uuid-shaped id",
      bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", fbody)), False)

three_same_url = fetch_wall_rows(
    ["https://tiktok.com/@x/video/9"] * 3)   # the brand fan-out shape that actually happened
alarms = W.check_all(three_same_url, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("3 entries sharing ONE sourceUrl -> none (one bad video, not a systemic break)",
      "fetch-wall:burst" in keys_of(alarms), False)

two_distinct = fetch_wall_rows(
    ["https://tiktok.com/@x/video/1", "https://tiktok.com/@x/video/2"])
alarms = W.check_all(two_distinct, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("2 distinct sourceUrls -> none (under the threshold)",
      "fetch-wall:burst" in keys_of(alarms), False)

# ---- rerun: THE EXPLICIT MARKER ONLY, not attempts >= 2 --------------------
# DELIBERATELY INVALIDATED, and made its own opposite: `done + attempts:2 +
# no aiFail` is exactly the shape a SUCCESSFUL transient retry ends in — proven
# live by 644ba12d (attempts=3, no aiFail, 11 beats, recovered fine) — and the
# old inference paged on it for real. The explicit `rerun` marker is the only
# thing that may fire this alarm now.
no_marker_healed = [row("c5", [
    {"id": "e5555555", "status": "done", "attempts": 2,
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(no_marker_healed, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("done + attempts:2 + no aiFail + no rerun marker -> none (self-healed retry)",
      keys_of(alarms), set())

healed_shape = [row("c5", [
    {"id": "e5555559", "status": "done", "attempts": 3,
     "healed": {"kind": "transient", "tries": 2, "at": ago(NOW, 30)},
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(healed_shape, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("done + attempts:3 + healed + no aiFail -> none (the healed shape, explicitly)",
      keys_of(alarms), set())

rerun_marker = [row("c5", [
    {"id": "e5555557", "status": "done", "attempts": 2,
     "rerun": {"at": ago(NOW, 0), "prevProcessedAt": ago(NOW, 120), "beats": 10},
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(rerun_marker, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("done + attempts:2 + explicit rerun marker -> exactly one rerun:",
      keys_of(alarms), {"rerun:e5555557"})
rerun_alarm = next(a for a in alarms if a["key"] == "rerun:e5555557")
rbody = rerun_alarm["body"]
check("rerun: body carries no @ (no email)", "@" in rbody, False)
check("rerun: body carries no http (no URL — the command is a local script)",
      "http" in rbody, False)
check("rerun: body carries no uuid-shaped id",
      bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", rbody)), False)

rerun_25h = [row("c5", [
    {"id": "e5555558", "status": "done", "attempts": 2,
     "rerun": {"at": ago(NOW, 25 * 3600), "prevProcessedAt": ago(NOW, 26 * 3600), "beats": 10},
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(rerun_25h, sources_recent=1, worker_seen_at=NOW, now=NOW)
# RERUN_WINDOW_S is 48h now, not 24h (Step 7) — a rerun is a DIGEST line, the
# digest fires once a day, and a 24h window let a rerun 25h before the digest
# go unreported by anything at all. So 25h old still fires (as a digest-only,
# non-paging alarm; see the page:False check below).
check("rerun marker 25h old -> STILL present (window widened to 48h so the "
      "digest can never miss it)", "rerun:e5555558" in keys_of(alarms), True)

rerun_stale = [row("c5", [
    {"id": "e5555561", "status": "done", "attempts": 2,
     "rerun": {"at": ago(NOW, 49 * 3600), "prevProcessedAt": ago(NOW, 50 * 3600), "beats": 10},
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(rerun_stale, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("rerun marker 49h old -> none (past the 48h window)",
      keys_of(alarms), set())

rerun_no_at = [row("c5", [
    {"id": "e5555560", "status": "done", "attempts": 2,
     "rerun": {"prevProcessedAt": ago(NOW, 120), "beats": 10},
     "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(rerun_no_at, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("rerun marker with no `at` -> one alarm (fails loud)",
      keys_of(alarms), {"rerun:e5555560"})

# Kept: proves the aiFail path is not what the alarm keys on any more.
rerun_but_ai_retry = [row("c5", [
    {"id": "e5555556", "status": "done", "attempts": 2,
     "aiFail": {"kind": "billing"}, "processedAt": ago(NOW, 60)},
])]
alarms = W.check_all(rerun_but_ai_retry, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("the same shape WITH an aiFail -> none", keys_of(alarms), set())

# ---- sources-stalled --------------------------------------------------------
four_with_source = [row("c6", [
    {"id": f"f666666{i}", "status": "done", "processedAt": ago(NOW, 1000),
     "sourceUrl": f"https://tiktok.com/@x/video/{i}"}
    for i in range(4)
])]
alarms = W.check_all(four_with_source, sources_recent=0, worker_seen_at=NOW, now=NOW)
check("4 finished in 6h with sources_recent=0 -> sources-stalled",
      "sources-stalled" in keys_of(alarms), True)

alarms = W.check_all(four_with_source, sources_recent=1, worker_seen_at=NOW, now=NOW)
check("the same 4 with sources_recent=1 -> none",
      "sources-stalled" in keys_of(alarms), False)

# ---- softfail:<subsystem> ---------------------------------------------------
def softfail_rows(hits):
    entries = []
    for i in range(5):
        e = {"id": f"a{i}sfsfsf", "status": "done", "processedAt": ago(NOW, 3600 * (5 - i))}
        if i < hits:
            e["softFails"] = {"source_upsert": {"reason": "PGRST204", "at": ago(NOW, 100)}}
        entries.append(e)
    return [row("c7", entries)]

alarms = W.check_all(softfail_rows(3), sources_recent=1, worker_seen_at=NOW, now=NOW)
check("3 of the last 5 finished carrying softFails.source_upsert -> softfail:source_upsert",
      "softfail:source_upsert" in keys_of(alarms), True)

alarms = W.check_all(softfail_rows(1), sources_recent=1, worker_seen_at=NOW, now=NOW)
check("1 of 5 -> none", "softfail:source_upsert" in keys_of(alarms), False)

# ---- spend-24h ---------------------------------------------------------------
alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW, now=NOW,
                      charges_24h=W.DAILY_SCRIPT_CAP - 1)
check("charges_24h one under the cap -> none", "spend-24h" in keys_of(alarms), False)

alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW, now=NOW,
                      charges_24h=W.DAILY_SCRIPT_CAP)
check("charges_24h AT the cap -> spend-24h", "spend-24h" in keys_of(alarms), True)

spend_alarm = next(a for a in alarms if a["key"] == "spend-24h")
body = spend_alarm["body"]
check("spend-24h body carries no @ (no email)", "@" in body, False)
check("spend-24h body carries no http (no URL)", "http" in body, False)
check("spend-24h body carries no uuid-shaped id (no creator id)",
      bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-", body)), False)
# ---- spend-24h wording: creator terms, not a billing note (Step 7) --------
check("spend-24h title reframed in creator terms",
      spend_alarm["title"], "no new scripts — 24h cap reached")
check("spend-24h body still carries both numbers (charged count)",
      str(W.DAILY_SCRIPT_CAP) in body, True)
check("spend-24h body says new pastes are refused until it clears",
      "refusing every new paste" in body, True)

# ---- worker-down -------------------------------------------------------------
alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW - timedelta(minutes=6), now=NOW)
check("worker_seen_at 6 min old -> worker-down", "worker-down" in keys_of(alarms), True)

alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW - timedelta(minutes=2), now=NOW)
check("worker_seen_at 2 min old -> none", "worker-down" in keys_of(alarms), False)

alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=None, now=NOW)
check("worker_seen_at never seen -> worker-down", "worker-down" in keys_of(alarms), True)

# ---- "page" is on every alarm — a structural guard -------------------------
# An alarm added later without it defaults to paging (check_all's own dict
# construction never sets a default; run_once() reads a.get("page", True),
# which pages on a missing key) — so this fixture trips several alarms at
# once and asserts NONE of the dicts omit "page".
kitchen_sink_rows = [
    row("kx", [
        {"id": "kx000001", "status": "running", "addedAt": ago(NOW, 700)},
        {"id": "kx000002", "status": "done", "brandId": "b1",
         "adaptation": {"beats": []}, "processedAt": ago(NOW, 60)},
        {"id": "kx000003", "status": "error", "final": True, "finalWhy": "gave_up",
         "attemptedAt": ago(NOW, 60), "aiFail": {"kind": "transient", "tries": 8}},
        {"id": "kx000004", "status": "done", "attempts": 2,
         "rerun": {"at": ago(NOW, 0), "prevProcessedAt": ago(NOW, 120), "beats": 10},
         "processedAt": ago(NOW, 60)},
    ] + [
        {"id": f"kx0001{i:02d}", "status": "error", "noteKind": "fetch",
         "claimedAt": ago(NOW, 60), "sourceUrl": f"https://tiktok.com/@x/video/{i}"}
        for i in range(3)
    ]),
]
kitchen_sink_alarms = W.check_all(
    kitchen_sink_rows, sources_recent=1, worker_seen_at=None, now=NOW,
    charges_24h=W.DAILY_SCRIPT_CAP)
check("kitchen-sink fixture actually trips several alarms (guard against a "
      "degenerate empty-list pass)", len(kitchen_sink_alarms) >= 4, True)
check("every alarm dict carries a 'page' key",
      all("page" in a for a in kitchen_sink_alarms), True)

# ---- demotions, both sides: still reported, but page:False ----------------
rerun_page = next(a for a in W.check_all(rerun_marker, sources_recent=1, worker_seen_at=NOW, now=NOW)
                  if a["key"] == "rerun:e5555557")
check("rerun:<id8> still present (reaches the digest)", rerun_page is not None, True)
check("rerun:<id8> is page:False", rerun_page["page"], False)

sources_stalled_page = next(
    a for a in W.check_all(four_with_source, sources_recent=0, worker_seen_at=NOW, now=NOW)
    if a["key"] == "sources-stalled")
check("sources-stalled still present (reaches the digest)", sources_stalled_page is not None, True)
check("sources-stalled is page:False", sources_stalled_page["page"], False)

softfail_page = next(
    a for a in W.check_all(softfail_rows(3), sources_recent=1, worker_seen_at=NOW, now=NOW)
    if a["key"] == "softfail:source_upsert")
check("softfail:<sub> still present (reaches the digest)", softfail_page is not None, True)
check("softfail:<sub> is page:False", softfail_page["page"], False)

# ---- kept pages: page:True on every one of these -----------------------------
kept_page_cases = [
    (stuck_700, "inflight:b1111111"),
    (five_stuck, "inflight:many"),
    (empty_script, "empty-script:d4444444"),
    (gave_up_rows, "gave-up:h9999991"),
    (three_distinct, "fetch-wall:burst"),
]
for fixture_rows, wanted_key in kept_page_cases:
    got = W.check_all(fixture_rows, sources_recent=1, worker_seen_at=NOW, now=NOW)
    a = next((x for x in got if x["key"] == wanted_key), None)
    check(f"{wanted_key} is page:True", a is not None and a.get("page"), True)

spend_kept = next(
    a for a in W.check_all(healthy_rows, sources_recent=1, worker_seen_at=NOW, now=NOW,
                           charges_24h=W.DAILY_SCRIPT_CAP)
    if a["key"] == "spend-24h")
check("spend-24h is page:True", spend_kept["page"], True)

# ---- role="fly" cannot raise worker-down (the self-certifying-watchdog guard,
# the single most important new check here) ----------------------------------
fly_alarms = W.check_all(healthy_rows, sources_recent=1, worker_seen_at=None, now=NOW,
                         role="fly")
check("role='fly' + worker_seen_at=None -> no worker-down key at all",
      "worker-down" in keys_of(fly_alarms), False)

# ---- the three worker-down variants, keyed on priority ----------------------
wd_true = next(
    a for a in W.check_all(healthy_rows, sources_recent=1, worker_seen_at=None, now=NOW,
                           role="external", fallback_alive=True)
    if a["key"] == "worker-down")
check("fallback_alive=True -> worker-down present, priority 3", wd_true["priority"], 3)

wd_false = next(
    a for a in W.check_all(healthy_rows, sources_recent=1, worker_seen_at=None, now=NOW,
                           role="external", fallback_alive=False)
    if a["key"] == "worker-down")
check("fallback_alive=False -> worker-down present, priority 5 (both-down)",
      wd_false["priority"], 5)
check("...and the title says nothing is writing scripts",
      "NOTHING is writing scripts" in wd_false["title"], True)

wd_none = next(
    a for a in W.check_all(healthy_rows, sources_recent=1, worker_seen_at=None, now=NOW,
                           role="external", fallback_alive=None)
    if a["key"] == "worker-down")
check("fallback_alive=None -> worker-down present, priority 4 (today's default)",
      wd_none["priority"], 4)

# ---- _fallback_alive() directly ---------------------------------------------
check("_fallback_alive(role='fallback') -> True regardless of seen_at",
      W._fallback_alive(None, NOW, "fallback"), True)
check("_fallback_alive(fresh) -> True",
      W._fallback_alive(NOW - timedelta(seconds=5), NOW, "external"), True)
check("_fallback_alive(FALLBACK_COVER_MINUTES + 1 old) -> False",
      W._fallback_alive(NOW - timedelta(minutes=W.FALLBACK_COVER_MINUTES + 1), NOW, "external"),
      False)
check("_fallback_alive(None) -> None",
      W._fallback_alive(None, NOW, "external"), None)

# ---- ci_failure_verdict(): all four rows of the Step 11 table --------------
v = W.ci_failure_verdict(NOW - timedelta(minutes=1), True, NOW)
check("readable, heartbeat fresh -> no page (fly-covering)", v["page"], False)
check("...why == fly-covering", v["why"], "fly-covering")

v = W.ci_failure_verdict(NOW - timedelta(minutes=W.FALLBACK_COVER_MINUTES + 1), True, NOW)
check("readable, heartbeat stale -> page, priority 5, both-down", v["page"], True)
check("...priority 5", v["priority"], 5)
check("...alarm_key worker-down", v["alarm_key"], "worker-down")
check("...why both-down", v["why"], "both-down")

v = W.ci_failure_verdict(None, True, NOW)
check("readable, no heartbeat row at all -> page, priority 5, both-down", v["page"], True)
check("...priority 5", v["priority"], 5)
check("...alarm_key worker-down", v["alarm_key"], "worker-down")
check("...why both-down", v["why"], "both-down")

v = W.ci_failure_verdict(None, False, NOW)
check("not readable -> page, priority 4, ci-unverified", v["page"], True)
check("...priority 4", v["priority"], 4)
check("...alarm_key ci-unverified", v["alarm_key"], "ci-unverified")
check("...why unknown", v["why"], "unknown")

# ---- digest(): demoted-only conditions, fallback timestamp ------------------
digest_alarms = [
    {"key": "sources-stalled", "page": False, "priority": 2,
     "tags": "chart_with_downwards_trend", "title": "x", "body": "x"},
    {"key": "softfail:meta", "page": False, "priority": 2,
     "tags": "warning", "title": "x", "body": "x"},
]
digest_body = W.digest(healthy_rows, 1, NOW, NOW, open_alarms=digest_alarms)
check("digest() with only demoted conditions -> 'open alarms: none'",
      "open alarms: none" in digest_body, True)
check("...and carries a 'quiet:' line naming them",
      "quiet: softfail:meta, sources-stalled" in digest_body, True)

digest_body_fb = W.digest(healthy_rows, 1, NOW, NOW, fallback_seen_at=NOW - timedelta(seconds=30))
check("digest() sources line carries the fallback timestamp",
      re.search(r"fallback \d+s ago", digest_body_fb) is not None, True)

digest_body_no_fb = W.digest(healthy_rows, 1, NOW, NOW, fallback_seen_at=None)
check("digest() with fallback_seen_at=None -> 'fallback never seen'",
      "fallback never seen" in digest_body_no_fb, True)

# ---- raw_notes() / digest()'s "notes: clean" line ---------------------------
# The sentence is HARD-CODED here, not imported from process_adaptations —
# this module must not import that one (see the module docstring). Verified
# live 2026-08-18: 0 of 21 adaptations carry a note at all, so this is the
# regression guard, not a case list.
raw_note_rows = [row("c8", [
    {"id": "g8888888", "status": "error",
     "note": "tags failed: Overloaded; format extraction failed: Overloaded"},
])]
check("raw_notes(): a raw provider/internal-text note is caught",
      W.raw_notes(raw_note_rows), ["g8888888"])

clean_note_rows = [row("c8", [
    {"id": "g8888889", "status": "error",
     "note": "something on our side went wrong — we're retrying. "
             "Nothing was used from your allowance."},
])]
check("raw_notes(): a real CREATOR_NOTES-shaped sentence is NOT flagged",
      W.raw_notes(clean_note_rows), [])

check("digest(): the healthy fixture reads 'notes: clean'",
      "notes: clean" in W.digest(healthy_rows, 1, NOW, NOW), True)
check("digest(): a raw-note row reads the count and id8",
      "notes: 1 with raw text (g8888888)" in W.digest(raw_note_rows, 1, NOW, NOW), True)

# ---- ops_snapshot_value(): the Ops tab's whole feed, written once per tick -
check("empty alarms -> ['alarms'] == []", W.ops_snapshot_value([], 0, 0, "fly", NOW)["alarms"], [])
check("role is carried through verbatim", W.ops_snapshot_value([], 0, 0, "fly", NOW)["role"], "fly")

# A mixed tick — one paging alarm (inflight:), one digest-only (sources-stalled)
# — must carry BOTH. This is the regression that would silently undo the only
# reason ops.snapshot exists: a digest-only alarm never latches, so this row
# is the only place it is visible between one tick and the 15:00 UTC digest.
mixed_rows = [row("c-mix", [
    {"id": "m1111111", "status": "running", "addedAt": ago(NOW, 700)},
] + [
    {"id": f"m222222{i}", "status": "done", "processedAt": ago(NOW, 1000),
     "sourceUrl": f"https://tiktok.com/@x/video/{i}"}
    for i in range(4)
])]
mixed_alarms = W.check_all(mixed_rows, sources_recent=0, worker_seen_at=NOW, now=NOW)
mixed_snap = W.ops_snapshot_value(mixed_alarms, 0, 0, "fly", NOW)
mixed_keys = {a["key"] for a in mixed_snap["alarms"]}
check("mixed tick: the paging alarm (inflight:) is in the snapshot",
      "inflight:m1111111" in mixed_keys, True)
check("mixed tick: the digest-only alarm (sources-stalled) is ALSO in the snapshot",
      "sources-stalled" in mixed_keys, True)
mixed_by_key = {a["key"]: a for a in mixed_snap["alarms"]}
check("...and each keeps its own page flag (inflight: pages)",
      mixed_by_key["inflight:m1111111"]["page"], True)
check("...sources-stalled stays page:False", mixed_by_key["sources-stalled"]["page"], False)

# ---- the panel labels its thresholds off these — a drift here relabels the UI
snap = W.ops_snapshot_value([], 0, 0, "fly", NOW)
check("inflight_sla_s == W.INFLIGHT_SLA", snap["inflight_sla_s"], W.INFLIGHT_SLA)
check("daily_script_cap == W.DAILY_SCRIPT_CAP", snap["daily_script_cap"], W.DAILY_SCRIPT_CAP)

# ---- truncation: one long exception string must not bloat the row ----------
long_body_snap = W.ops_snapshot_value(
    [{"key": "k", "title": "t" * 400, "body": "b" * 900, "priority": 1, "page": True}],
    0, 0, "fly", NOW)
long_alarm = long_body_snap["alarms"][0]
check("a 900-character body is truncated to 300", len(long_alarm["body"]), 300)
check("a 400-character title is truncated to 200", len(long_alarm["title"]), 200)

# ---- None inputs come out as 0, never as None -------------------------------
none_snap = W.ops_snapshot_value([], None, None, "fly", NOW)
check("charges_24h=None -> 0, not None", none_snap["charges_24h"], 0)
check("sources_recent=None -> 0, not None", none_snap["sources_recent"], 0)

# ---- pure: same inputs -> equal output, and the input list is not mutated --
pure_alarms = [{"key": "k1", "title": "t", "body": "b", "priority": 2, "page": True}]
pure_alarms_copy = [dict(a) for a in pure_alarms]
first_call = W.ops_snapshot_value(pure_alarms, 5, 2, "fly", NOW)
second_call = W.ops_snapshot_value(pure_alarms, 5, 2, "fly", NOW)
check("ops_snapshot_value is pure: calling it twice with the same inputs agrees",
      first_call, second_call)
check("ops_snapshot_value does not mutate the input alarms list",
      pure_alarms, pure_alarms_copy)

# ---- notify() never raises, and never sends without a topic ----------------
import os  # noqa: E402

_orig_load_env = W.LR.load_env
_saved_topic = os.environ.pop("NTFY_TOPIC", None)
_saved_server = os.environ.pop("NTFY_SERVER", None)
try:
    W.LR.load_env = lambda path: {}   # no .env fallback either, for a deterministic test
    check("notify() with NTFY_TOPIC unset returns False",
          W.notify("test", "body"), False)
    check("notify() with a non-ASCII title and no topic returns False, does not raise",
          W.notify("tëst émoji 🎉 café", "body"), False)
finally:
    W.LR.load_env = _orig_load_env
    if _saved_topic is not None:
        os.environ["NTFY_TOPIC"] = _saved_topic
    if _saved_server is not None:
        os.environ["NTFY_SERVER"] = _saved_server

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
