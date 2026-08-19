#!/usr/bin/env python3
"""Evaluate a fixed set of invariants against the live database and push a
notification to the owner's phone (ntfy.sh) when one breaks.

WHY THIS EXISTS
----------------
Every serious failure in this project so far has been silent: the Fly deploy
failing five runs straight, `upsert_source()` 400ing for weeks, AI steps
writing back `status="done"` with no script, a 25-minute claim lease
stranding a paste, and — on 2026-08-18 — `renew_claim()` racing the
completion graft, erasing a finished script and re-billing the same paste.
Every one was found by a human querying by hand, usually long after it
started costing something.

This module reads the database (never writes anything a creator can see) and
tells the owner when one of a fixed set of failure SHAPES shows up. THE RULE,
in the owner's own words: page only for something that would need his
attention — a creator affected, or about to be. Do not page for a redundancy
failure that a creator never felt (a double-bill that still delivered a
script, an analytics sensor going quiet). Every alarm below therefore carries
a `page` bit; `page: False` alarms still fire and still get carried — just
into the once-daily digest, never onto the phone.

PAGES THE PHONE (page: True):

    inflight:<id8>    a script stuck queued/running past 10 minutes
    inflight:many     more than 3 stuck at once (collapsed into one page)
    empty-script:<id8> finished "done" with a brand and zero beats
    gave-up:<id8>     the automatic retry loop stopped and the creator has no
                      script (finalWhy gave_up/no_script/exhausted) — a
                      permanent platform wall does NOT page here, see below
    fetch-wall:burst  3+ DISTINCT source videos refused to download inside 6h
                      — suspect a yt-dlp extractor break, not one bad link
    spend-24h         process_adaptations.py's --daily-cap circuit breaker has
                      tripped — the worker is refusing ALL new work, so a
                      quiet queue means "capped", not "healthy"
    worker-down       tri-state, keyed on whether the github fallback loop is
                      covering (see below) — priority 3 ("fly down, github
                      covering" — degraded, not down, but no redundancy left),
                      priority 5 ("nothing is writing scripts" — both down),
                      or priority 4 ("heartbeat missing, fallback status
                      unknown" — cannot tell, today's original wording)
    ci-unverified     a GitHub job that keeps lynxr running failed AND
                      lynxr_ops itself was not readable, so this module
                      cannot tell whether Fly is covering either (see
                      ci_failure_verdict())

DIGEST ONLY (page: False) — still reported, once a day, in digest()'s
"quiet:" line, never on the phone:

    rerun:<id8>       an entry that finished with beats and was then claimed
                      AGAIN (explicit marker) — a double-bill, but the
                      creator still got their script either way. What goes
                      unnoticed longer: nothing creator-facing — spend-24h
                      (which still pages) and the per-creator allowance
                      ledger both still bound total cost.
    sources-stalled   scripts finishing but lynxr_sources not growing — costs
                      the agency's sourcing signal (lynxr_sources, HANDOFF's
                      "moat"), never a creator's script.
    softfail:<sub>    a soft failure (source_upsert/video_upsert/cover/meta)
                      hit on 3+ of the last 5 finished scripts — worst visible
                      outcome is a library card with a generic title or no
                      thumbnail, on a script that was still delivered.

p95 latency is DELIBERATELY not here — it lives in the daily digest instead.
The watchdog's first-ever run failed on `p95 1548s > 60s`, and at n=7 samples
p95 IS the worst sample, so one historical incident would pin a p95-based
pager red for 24h on an otherwise healthy system. A pager that is always red
gets muted, which is worse than no pager.

TWO EXTERNAL CALLERS, not one — worker-down is NOT structurally exclusive to
the GitHub fallback loop any more. `.github/workflows/adaptations.yml`'s
polling loop (`--as-fallback`) is the primary one, and it also writes
`fallback.heartbeat`, which is what lets worker-down tell "fly down, github
covering" apart from "nothing is writing scripts". `.github/workflows/
latency-watch.yml` is a SECOND external caller (plain `--once`, no
`--as-fallback` — an observer, not a worker, so it never claims to cover
anything). The Fly-side caller (`role="fly"`, from worker.py) can never raise
worker-down at all, by construction — see check_all()'s comment on that.

NOTHING HERE MAY RAISE INTO A SCRIPT'S CRITICAL PATH. `notify()`, `ops_get`/
`ops_put`/`ops_del`, and `run_once()` all catch Exception and keep going. A
creator waiting is a UI problem; a creator losing their script is not, and
this module is not allowed to be the thing that costs them one.

DEGRADES SAFELY. With no NTFY_TOPIC set, `notify()` logs once and returns
False — everything else still runs. With no `lynxr_ops` table (step 1 of the
plan this module implements is an owner action in the Supabase SQL editor),
every `ops_*` call falls back to an in-process dict latch. Worse (no memory
across a restart, so a page can repeat once) but never a crash and never
total silence.

THE TOPIC IS A BEARER SECRET on a public ntfy.sh server — anyone who learns
it can read the alarms and publish fakes into them. Alarm bodies therefore
carry no creator PII: ids are truncated to 8 characters, and there are no
emails, source URLs or brand names anywhere in this file.

Usage:
    python watchdog.py --once            # the default — one check, no output changes
    python watchdog.py --dry-run         # print what would fire, touch nothing
    python watchdog.py --digest          # force the daily digest now
    python watchdog.py --json            # machine-readable
    python watchdog.py --self-test       # prove the channel + latch both work
    python watchdog.py --once --as-fallback  # THIS process IS the github fallback
                                              # loop — writes fallback.heartbeat
    python watchdog.py --ci-failed       # a github job that keeps lynxr running
                                          # just failed; page only if a creator
                                          # is actually affected (always exits 0)

Never exits non-zero on a breach — see main(). A workflow that goes red on a
single noisy sample gets muted; that is exactly the mistake latency-watch.yml
made with p95 before this module existed.
"""

import argparse
import json
import logging
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import latency_report as LR  # noqa: E402 — reused for fetch_rows/load_env/build_report/parse_iso.
import envcfg  # noqa: E402 — the one place a secret or config value is read; see its docstring.
# NEVER `import process_adaptations` here. That module runs logging.basicConfig
# and mkdir("output/") as import-time side effects — the trap already recorded
# for process_blueprints.py, and the reason canon_url is duplicated rather than
# imported. watchdog.py must stay as side-effect-free at import as latency_report
# itself, because worker.py imports this at module top.

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    # This venv's Python has no system CA bundle — a bare default context fails
    # every request with CERTIFICATE_VERIFY_FAILED. Same guard every other
    # pipeline script uses.
    SSL_CTX = ssl.create_default_context()

log = logging.getLogger("watchdog")

# ---------------------------------------------------------------- thresholds
# Each one is measured, not guessed — see the module docstring and the plan
# this implements (~/.claude/plans/alarms-when-lynxr-breaks.md) for the data
# behind every number below.
INFLIGHT_SLA = 600            # 10min = 2.6x measured p90 (229s); every real
                               # failure measured (1504s, 1548s, 101171s) clears it easily.
INFLIGHT_MANY = 3             # more than this in one tick collapses into inflight:many
EMPTY_SCRIPT_WINDOW_S = 24 * 3600
GAVE_UP_WINDOW_S = 24 * 3600
RERUN_WINDOW_S = 48 * 3600     # widened from 24h — this is now a DIGEST line
                               # (Step 7), and the digest fires once a day, so a
                               # 24h window let a rerun that happened 25h before
                               # the digest go unreported by anything at all.
FETCH_WALL_MIN = 3            # this many DISTINCT source videos refusing...
FETCH_WALL_WINDOW_H = 6       # ...inside this window = a systemic fetch break
SOURCES_STALL_MIN = 3         # this many finished-with-source in the window...
SOURCES_STALL_WINDOW_H = 6    # ...and zero new lynxr_sources rows = stalled
SOFTFAIL_LAST_N = 5
SOFTFAIL_THRESHOLD = 3
WORKER_DOWN_MINUTES = 5       # heartbeat every 60s (worker.py) tolerates 5 misses —
                               # more than kill_timeout="300s" plus a cold boot.
FALLBACK_COVER_MINUTES = 15   # a fly deploy (strategy="immediate", kill_timeout
                               # 300s) plus a cold boot is ~3min; 15 is well
                               # clear of that and far short of an outage worth
                               # being woken for.
LATCH_REMIND_HOURS = 24       # how long an open alarm stays quiet before a reminder
DIGEST_HOUR_UTC = int(envcfg.get("DIGEST_HOUR_UTC", "15"))
# Same default and same env var process_adaptations.py's --daily-cap reads —
# so the breaker that refuses work and the alarm that pages about it can
# never disagree on where the line is.
DAILY_SCRIPT_CAP = int(envcfg.get("DAILY_SCRIPT_CAP", "250"))

SOFTFAIL_SUBSYSTEMS = ("source_upsert", "video_upsert", "cover", "meta")

# DUPLICATED from process_adaptations.RAW_TEXT_NEEDLES — this module may not
# import that one (its import runs logging.basicConfig and mkdir("output/")).
# Change one, change both; pipeline/test_ai_retry.py asserts they match.
RAW_NOTE_NEEDLES = ("overloaded", "529", "credit balance", "rate_limit", "429",
                    "traceback", "anthropic", "error:", "yt-dlp", "--cookies",
                    "http error", "nonetype", "exception", "failed:", "api_key")


def raw_notes(rows):
    """id8s of live adaptations whose creator-visible note carries provider
    or internal text. Verified live 2026-08-18: 0 of 21 adaptations carry a
    note at all, so anything above zero is a regression in
    process_adaptations.set_note(). Scans `adaptations` only — two rows in
    `trash` still carry pre-FETCH_FAILURES yt-dlp stderr, and counting them
    would pin this line permanently non-zero, which teaches the owner to
    ignore it."""
    hits = []
    for row in rows:
        for a in (row.get("data") or {}).get("adaptations") or []:
            note = str(a.get("note") or "").lower()
            if note and any(n in note for n in RAW_NOTE_NEEDLES):
                hits.append(str(a.get("id") or "")[:8] or "????????")
    return hits


# =============================================================================
# 3a. notify()
# =============================================================================

_warned = False


def notify(title, body, priority=4, tags="rotating_light"):
    """POST one message to ntfy.sh. May not raise, ever — catches Exception
    and returns False on any failure, including "no topic configured"."""
    global _warned
    env = LR.load_env(LR.ROOT / ".env")
    topic = envcfg.first(os.environ.get("NTFY_TOPIC"), env.get("NTFY_TOPIC"))
    server = envcfg.first(os.environ.get("NTFY_SERVER"), env.get("NTFY_SERVER"),
                          default="https://ntfy.sh")
    if not topic:
        if not _warned:
            log.warning("NTFY_TOPIC not set — alarms will not reach the phone")
            _warned = True
        return False
    try:
        # HTTP header values must be ASCII — a title carrying a creator's emoji
        # or an accented name raises UnicodeEncodeError inside add_header.
        full_title = f"lynxr: {title}"[:200]
        ascii_title = full_title.encode("ascii", "ignore").decode()
        data = str(body)[:900].encode("utf-8")
        req = urllib.request.Request(f"{server}/{topic}", method="POST", data=data)
        req.add_header("X-Title", ascii_title)
        req.add_header("X-Priority", str(priority))
        req.add_header("X-Tags", tags)
        urllib.request.urlopen(req, timeout=8, context=SSL_CTX).read()
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("notify() failed: %s", str(e)[:120])
        return False


# =============================================================================
# 3b. The latch — lynxr_ops helpers, plus raise_alarm / clear_alarm
# =============================================================================

# Falls back to this when Supabase (or the table itself) is unreachable, so an
# outage still produces exactly ONE page rather than none (silence) or one
# every tick (noise). Only touched from inside the except branches below — the
# whole point is that it only kicks in when the real thing failed.
_LOCAL_LATCH = {}


def ops_get(key, opskey):
    """{"value": {...}, "updated_at": iso} for one lynxr_ops row, or None."""
    try:
        q = urllib.parse.quote(opskey, safe="")
        req = urllib.request.Request(
            f"{LR.SB_URL}/rest/v1/lynxr_ops?key=eq.{q}&select=value,updated_at&limit=1")
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {key}")
        with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as r:
            rows = json.load(r)
        if rows:
            return {"value": rows[0].get("value") or {}, "updated_at": rows[0].get("updated_at")}
        return None
    except Exception as e:  # noqa: BLE001
        log.warning("ops_get(%s) failed, falling back to the local latch: %s",
                    opskey, str(e)[:90])
        return _LOCAL_LATCH.get(opskey)


def ops_put(key, opskey, value):
    """Upsert one lynxr_ops row. Writes `updated_at` explicitly in the body —
    `default now()` does NOT re-apply on a merge-duplicates upsert, the same
    trap that leaves lynxr_videos.updated_at stale on re-upserts."""
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    body = {"key": opskey, "value": value, "updated_at": now}
    try:
        req = urllib.request.Request(
            f"{LR.SB_URL}/rest/v1/lynxr_ops?on_conflict=key", method="POST",
            data=json.dumps(body).encode())
        for h, v in (("apikey", key), ("Authorization", f"Bearer {key}"),
                     ("Content-Type", "application/json"),
                     ("Prefer", "resolution=merge-duplicates")):
            req.add_header(h, v)
        urllib.request.urlopen(req, timeout=10, context=SSL_CTX).read()
    except Exception as e:  # noqa: BLE001
        log.warning("ops_put(%s) failed, falling back to the local latch: %s",
                    opskey, str(e)[:90])
        _LOCAL_LATCH[opskey] = {"value": value, "updated_at": now}


def ops_del(key, opskey):
    try:
        q = urllib.parse.quote(opskey, safe="")
        req = urllib.request.Request(
            f"{LR.SB_URL}/rest/v1/lynxr_ops?key=eq.{q}", method="DELETE")
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {key}")
        urllib.request.urlopen(req, timeout=10, context=SSL_CTX).read()
    except Exception as e:  # noqa: BLE001
        log.warning("ops_del(%s) failed, clearing the local latch instead: %s",
                    opskey, str(e)[:90])
        _LOCAL_LATCH.pop(opskey, None)


def _list_open_alarms(key):
    """Alarm keys (without the "alarm." prefix) currently latched open."""
    try:
        req = urllib.request.Request(
            f"{LR.SB_URL}/rest/v1/lynxr_ops?key=like.alarm.*&select=key,value")
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {key}")
        with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as r:
            rows = json.load(r)
        return [row["key"][len("alarm."):] for row in rows
                if (row.get("value") or {}).get("open")]
    except Exception as e:  # noqa: BLE001
        log.warning("could not list open alarms: %s", str(e)[:90])
        return [ak[len("alarm."):] for ak, v in _LOCAL_LATCH.items()
                if ak.startswith("alarm.") and (v.get("value") or {}).get("open")]


def raise_alarm(key, alarm_key, title, body, priority=4, tags="rotating_light"):
    """Notify once per open episode; a reminder after LATCH_REMIND_HOURS if it
    is still open; an immediate re-page if it got WORSE (priority increased)
    even inside that quiet window; silent otherwise.

    The escalation branch exists because of Step 8's tri-state worker-down:
    an open episode can silently go from priority 3 ("fly down, github
    covering") to priority 5 ("nothing is writing scripts") while sharing one
    latch key, and without this the phone would stay quiet for up to
    LATCH_REMIND_HOURS while the true state got much worse.

    Existing latches carry no "priority" key, so `int(None or 0)` is 0 and the
    first tick after this deploys re-pages any alarm that is currently open —
    a one-time, harmless cost: `--dry-run --json` prints [] today, so zero
    alarms are open to re-page."""
    opskey = f"alarm.{alarm_key}"
    now = datetime.now(timezone.utc)
    latch = ops_get(key, opskey)
    value = (latch or {}).get("value") or {}
    now_s = now.isoformat().replace("+00:00", "Z")

    if not value.get("open"):
        notify(title, body, priority=priority, tags=tags)
        ops_put(key, opskey, {"open": True, "opened_at": now_s,
                              "notified_at": now_s, "reminders": 0,
                              "priority": priority})
        return

    if priority > int(value.get("priority") or 0):
        notify(f"worse — {title}", body, priority=priority, tags=tags)
        value["notified_at"] = now_s
        value["priority"] = priority
        ops_put(key, opskey, value)
        return

    notified_at = LR.parse_iso(value.get("notified_at"))
    if notified_at is None or (now - notified_at).total_seconds() > LATCH_REMIND_HOURS * 3600:
        notify(f"still broken — {title}", body, priority=3, tags=tags)
        value["notified_at"] = now_s
        value["reminders"] = int(value.get("reminders") or 0) + 1
        ops_put(key, opskey, value)


def clear_alarm(key, alarm_key, note):
    """If a latch is open, send a quiet resolve and delete it. If none is
    open — the common path — do nothing, cheaply and silently."""
    opskey = f"alarm.{alarm_key}"
    latch = ops_get(key, opskey)
    value = (latch or {}).get("value") or {}
    if not value.get("open"):
        return
    opened_at = LR.parse_iso(value.get("opened_at"))
    now = datetime.now(timezone.utc)
    dur = f"{(now - opened_at).total_seconds() / 60:.0f}m" if opened_at else "?"
    notify(note, f"open for {dur}", priority=2, tags="white_check_mark")
    ops_del(key, opskey)


# =============================================================================
# 3c. check_all() — pure, no network, no Supabase
# =============================================================================

def check_all(rows, sources_recent, worker_seen_at, now=None, charges_24h=0,
              role="external", fallback_alive=None):
    """The list of currently-breached invariants, each a dict with keys
    "key", "title", "body", "priority", "tags", "page". A pure function of
    its arguments — same reason LR.build_report is pure: it has to be
    testable without a network call, and this plan exists precisely because a
    documented alarm (`SLA BREACH` in fly logs) turned out never to have been
    built, so the detector itself has to be provably real.

    `charges_24h` defaults to 0 (never fires) so every existing caller that
    does not pass it keeps working unchanged.

    `role` and `fallback_alive` default to today's behaviour too (every
    existing test call and latency-watch.yml's plain `--once` unaffected):
    `role="external"` runs the worker-down check as before, and
    `fallback_alive=None` produces the "fallback status unknown" wording."""
    now = now or datetime.now(timezone.utc)
    alarms = []

    # ---- spend-24h ----------------------------------------------------------
    # Pages the moment process_adaptations.py's --daily-cap breaker trips, so
    # a quiet worker (queue empty because it is REFUSING work, not because
    # there is none) does not read as healthy. No creator id, email or URL —
    # just the two numbers, same invariant every other body here holds to.
    if DAILY_SCRIPT_CAP and charges_24h >= DAILY_SCRIPT_CAP:
        alarms.append({
            "key": "spend-24h",
            "title": "no new scripts — 24h cap reached",
            "body": (f"{charges_24h} scripts charged in 24h (cap {DAILY_SCRIPT_CAP}). "
                     "the worker is refusing every new paste until this clears."),
            "priority": 4, "tags": "rotating_light", "page": True,
        })

    # ---- inflight:<id8> / inflight:many --------------------------------
    # Reuses LR.build_report so the addedAt/status parsing lives in one place.
    # "52w" (not "24h") because build_report skips anything older than --since,
    # INCLUDING in-flight entries — a paste stuck for days must still show up.
    report = LR.build_report(rows, "52w", INFLIGHT_SLA, now=now)
    breaches = report["inflight_breaches"]
    if len(breaches) > INFLIGHT_MANY:
        alarms.append({
            "key": "inflight:many",
            "title": f"{len(breaches)} scripts stuck over {INFLIGHT_SLA}s",
            "body": (f"{len(breaches)} entries queued/running past {INFLIGHT_SLA}s. "
                     "./venv/bin/python pipeline/latency_report.py --since 24h --sla 60"),
            "priority": 4, "tags": "rotating_light", "page": True,
        })
    else:
        for b in breaches:
            id8 = str(b.get("id") or "")[:8] or "????????"
            alarms.append({
                "key": f"inflight:{id8}",
                "title": f"script stuck {b['age']:.0f}s",
                "body": f"status={b['status']} age={b['age']:.0f}s (budget {INFLIGHT_SLA}s). fly logs",
                "priority": 4, "tags": "rotating_light", "page": True,
            })

    # ---- everything else needs the raw entries, not just build_report's
    # finished-sample summary (brandId, beats, softFails, attempts, aiFail
    # never leave this function or a script).
    finished = []   # (processedAt, entry) — every "done" entry with a processedAt
    fetch_walls = set()   # distinct sourceUrls with a fresh fetch failure (see (b) below)
    for row in rows:
        for a in (row.get("data") or {}).get("adaptations") or []:
            status = a.get("status")
            processed = LR.parse_iso(a.get("processedAt"))
            if status == "done" and processed:
                finished.append((processed, a))

            aid8 = str(a.get("id") or "")[:8] or "????????"

            # ---- empty-script:<id8> ---------------------------------------
            if (status == "done" and a.get("brandId")
                    and not ((a.get("adaptation") or {}).get("beats") or [])
                    and processed
                    and (now - processed).total_seconds() <= EMPTY_SCRIPT_WINDOW_S):
                alarms.append({
                    "key": f"empty-script:{aid8}",
                    "title": "done with zero beats",
                    "body": f"adaptation {aid8} finished with a brand and no beats. fly logs",
                    "priority": 4, "tags": "rotating_light", "page": True,
                })

            # ---- gave-up:<id8> ---------------------------------------------
            # A terminal state OF OURS — the automatic loop has stopped and the
            # creator has no script. Scoped by finalWhy so a permanent platform
            # wall (age-gated, deleted, off-platform) does NOT page: that class
            # is the creator's link, is answered accurately on the card, and
            # cannot be fixed by anyone being woken up. Live count on the
            # corpus: 0.
            settled = LR.parse_iso(a.get("attemptedAt") or a.get("claimedAt"))
            if (status == "error" and a.get("final")
                    and a.get("finalWhy") in ("gave_up", "no_script", "exhausted")
                    and (settled is None
                         or (now - settled).total_seconds() <= GAVE_UP_WINDOW_S)):
                alarms.append({
                    "key": f"gave-up:{aid8}",
                    "title": "a script was given up on",
                    "body": (f"adaptation {aid8} final={a.get('finalWhy')} "
                             f"kind={(a.get('aiFail') or {}).get('kind')} "
                             f"tries={(a.get('aiFail') or {}).get('tries')} "
                             f"passes={a.get('passes')}. fly logs"),
                    "priority": 4, "tags": "rotating_light", "page": True,
                })

            # ---- fetch-wall:burst (accumulate; alarm raised after the loop) -
            if status == "error" and a.get("noteKind") == "fetch":
                claimed = LR.parse_iso(a.get("claimedAt") or a.get("addedAt"))
                if claimed is not None and (now - claimed).total_seconds() <= FETCH_WALL_WINDOW_H * 3600:
                    fetch_walls.add(a.get("sourceUrl"))

            # ---- rerun:<id8> ------------------------------------------------
            # THE EXPLICIT MARKER ONLY. This used to infer the shape from
            # `done + attempts >= 2 + no aiFail`, which a SUCCESSFUL transient
            # retry imitates exactly — run_entry drops the aiFail marker when
            # an attempt succeeds, so a healed entry ends done/attempts=3/no
            # aiFail. That fired for real on 2026-08-18 (adaptation 644ba12d,
            # 11 beats, recovered fine) and paged at priority 4.
            #
            # process_adaptations.run_entry stamps a["rerun"] at claim time,
            # BEFORE any spend, when an entry that already finished with beats
            # is worked again — and never under --redo-ai. What that cannot
            # see is the original incident's own shape, where the racing graft
            # had erased the beats first; `inflight:` owns that class and
            # catches it ~10 minutes in (the real one sat running 1548s against
            # a 600s budget) instead of after the second bill.
            rerun = a.get("rerun") or {}
            rerun_at = LR.parse_iso(rerun.get("at"))
            # DIGEST ONLY (Step 7): a double-bill, but the creator still got
            # their script either way — not the "would need my attention"
            # shape. Still bounded by spend-24h (which still pages) and the
            # per-creator allowance ledger; still visible daily in the
            # digest's "quiet:" line.
            if rerun and (rerun_at is None
                          or (now - rerun_at).total_seconds() <= RERUN_WINDOW_S):
                alarms.append({
                    "key": f"rerun:{aid8}",
                    "title": "entry worked twice",
                    "body": (f"adaptation {aid8} attempts={a.get('attempts')} "
                             f"prevProcessedAt={rerun.get('prevProcessedAt')} "
                             f"beats={rerun.get('beats')}. "
                             "./venv/bin/python pipeline/latency_report.py --since 24h --sla 60"),
                    "priority": 2, "tags": "heavy_dollar_sign", "page": False,
                })

    # ---- fetch-wall:burst --------------------------------------------------
    # yt-dlp breaks on a schedule as platforms change their pages — which is
    # why .github/workflows/fly-refresh.yml force-rebuilds the image weekly —
    # and 17 of the 22 videos ever pasted here are Instagram, the extractor
    # that breaks most. When it goes, EVERY paste fails FAST with an accurate
    # wall, so nothing else here fires: sources-stalled needs 3+ FINISHED
    # scripts and inflight: needs a stall. This is that gap.
    #
    # DISTINCT URLS, not entries: the only fetch failure in the corpus was one
    # link pasted for two brands — 2 records, 1 bad video. Three distinct
    # videos refusing inside six hours has never happened and is what a
    # systemic break looks like.
    if len(fetch_walls) >= FETCH_WALL_MIN:
        alarms.append({
            "key": "fetch-wall:burst",
            "title": f"{len(fetch_walls)} videos refused in {FETCH_WALL_WINDOW_H}h",
            "body": (f"{len(fetch_walls)} distinct source videos failed to download "
                     f"in {FETCH_WALL_WINDOW_H}h — suspect a yt-dlp extractor break. "
                     "fly logs"),
            "priority": 4, "tags": "rotating_light", "page": True,
        })

    # ---- sources-stalled --------------------------------------------------
    # DIGEST ONLY (Step 7): the analytics sensor going quiet costs the agency's
    # sourcing signal (lynxr_sources, HANDOFF's "moat"), not any creator — no
    # script is affected. Still visible daily via the digest's "quiet:" line
    # and the "sources N total" count flatlining across consecutive digests.
    cutoff = now - timedelta(hours=SOURCES_STALL_WINDOW_H)
    finished_with_source = sum(
        1 for processed, a in finished if processed >= cutoff and a.get("sourceUrl"))
    if finished_with_source >= SOURCES_STALL_MIN and (sources_recent or 0) == 0:
        alarms.append({
            "key": "sources-stalled",
            "title": "lynxr_sources not growing",
            "body": (f"{finished_with_source} adaptations finished in "
                     f"{SOURCES_STALL_WINDOW_H}h with a source, 0 new lynxr_sources rows. "
                     "flyctl logs"),
            "priority": 2, "tags": "chart_with_downwards_trend", "page": False,
        })

    # ---- softfail:<subsystem> ---------------------------------------------
    # DIGEST ONLY (Step 7): the script was still delivered — worst case is a
    # library card with a generic title or no thumbnail. Still visible daily
    # via the digest's "quiet:" line.
    finished.sort(key=lambda t: t[0])
    last_n = [a for _, a in finished[-SOFTFAIL_LAST_N:]]
    if last_n:
        for subsystem in SOFTFAIL_SUBSYSTEMS:
            hits = sum(1 for a in last_n if (a.get("softFails") or {}).get(subsystem))
            if hits >= SOFTFAIL_THRESHOLD:
                alarms.append({
                    "key": f"softfail:{subsystem}",
                    "title": f"{subsystem} failing repeatedly",
                    "body": (f"{hits}/{len(last_n)} of the last finished scripts carry "
                             f"softFails.{subsystem}. fly logs"),
                    "priority": 2, "tags": "warning", "page": False,
                })

    # ---- worker-down --------------------------------------------------------
    # Evaluated only when role != "fly". The Fly-side caller writes
    # worker.heartbeat immediately before checking (run_once(beat=True)), so
    # it can never observe its own heartbeat as stale — that property is the
    # whole dead-man's switch, and this now enforces it with `role` instead of
    # relying on the ordering to make it accidental.
    #
    # ONE KEY for all three variants below, deliberately: the latch is one
    # episode and self-resolves the moment Fly comes back, rather than three
    # keys that could each be independently open. raise_alarm's escalation
    # branch (Step 9) is what keeps a worsening state audible even though the
    # key never changes.
    if role != "fly":
        stale = worker_seen_at is None or (now - worker_seen_at).total_seconds() > WORKER_DOWN_MINUTES * 60
        if stale:
            age = "never seen" if worker_seen_at is None else \
                f"{(now - worker_seen_at).total_seconds():.0f}s ago"
            if fallback_alive is True:
                # Degraded, not down: scripts are still written, just slower
                # (cold Whisper, ~3h best-effort scheduling, a 180s hand-off) —
                # and there is no second worker left, so the next failure is a
                # total outage. That is "would need my attention", but a
                # priority-3 page still makes a sound rather than the full
                # rotating_light treatment.
                alarms.append({
                    "key": "worker-down",
                    "title": "fly worker down — github fallback covering",
                    "body": (f"worker.heartbeat last seen {age} (budget {WORKER_DOWN_MINUTES}min). "
                             "scripts still get written, but slower — cold whisper, "
                             "best-effort scheduling measured at ~3h gaps, and a 180s "
                             "hand-off. no second worker left. flyctl status"),
                    "priority": 3, "tags": "warning", "page": True,
                })
            elif fallback_alive is False:
                alarms.append({
                    "key": "worker-down",
                    "title": "NOTHING is writing scripts",
                    "body": (f"worker.heartbeat last seen {age} (budget {WORKER_DOWN_MINUTES}min), "
                             "and the github fallback has not checked in either. every "
                             "pasted link is stuck. flyctl status + github actions"),
                    "priority": 5, "tags": "rotating_light", "page": True,
                })
            else:
                # fallback_alive is None — cannot tell. Today's wording,
                # extended to say so, rather than guessing either direction.
                alarms.append({
                    "key": "worker-down",
                    "title": "worker heartbeat missing",
                    "body": (f"worker.heartbeat last seen {age} (budget {WORKER_DOWN_MINUTES}min). "
                             "fallback status unknown. flyctl status"),
                    "priority": 4, "tags": "rotating_light", "page": True,
                })

    return alarms


# =============================================================================
# 3d. digest()
# =============================================================================

def _fmt_s(val):
    return f"{val:.0f}s" if val is not None else "—"


def digest(rows, sources_total, worker_seen_at, now, open_alarms=None, fallback_seen_at=None):
    """One daily message, priority 2 (arrives without a sound). THE DIGEST IS
    WHAT MAKES SILENCE MEAN SOMETHING — without a daily "all good" the owner
    cannot tell a healthy system from a dead alarm.

    `open_alarms`, when given, is the FULL list check_all() returned this
    tick — paging AND digest-only. Line 4 narrows to paging alarms (what the
    owner already knows about, since those already paged); the new line 5 is
    the ONLY place a digest-only alarm (rerun:*, sources-stalled, softfail:*)
    is ever reported, so it must not be dropped.

    `fallback_seen_at`, when given, extends the sources line with the
    GitHub-fallback heartbeat alongside the Fly one.
    """
    report = LR.build_report(rows, "24h", 60, now=now)
    if report["n"]:
        line1 = (f"24h: {report['n']} scripts · p50 {_fmt_s(report['p50'])} "
                 f"p90 {_fmt_s(report['p90'])} p95 {_fmt_s(report['p95'])} · "
                 f"{report['under_sla']}/{report['n']} under 60s")
        line2 = (f"queue {_fmt_s(report.get('queue_median'))} / "
                 f"source+format {_fmt_s(report.get('source_median'))} / "
                 f"adapt {_fmt_s(report.get('adapt_median'))}")
    else:
        line1, line2 = "24h: 0 scripts", ""
    worker_txt = "never seen" if worker_seen_at is None else \
        f"{(now - worker_seen_at).total_seconds():.0f}s ago"
    fallback_txt = "fallback never seen" if fallback_seen_at is None else \
        f"fallback {(now - fallback_seen_at).total_seconds():.0f}s ago"
    line3 = f"sources {sources_total} total · worker seen {worker_txt} · {fallback_txt}"
    # ---- quality: thin scripts and give-ups, quiet — a signal, not an outage.
    # Same "fails loud" rule the alarms above use: a missing timestamp counts
    # as inside the window rather than being silently excluded.
    thin_hits = sum(
        1 for row in rows
        for a in (row.get("data") or {}).get("adaptations") or []
        if (a.get("thin") or {}).get("at")
        and (now - (LR.parse_iso(a["thin"]["at"]) or now)).total_seconds() <= 24 * 3600)
    given_up_hits = sum(
        1 for row in rows
        for a in (row.get("data") or {}).get("adaptations") or []
        if a.get("finalWhy") == "gave_up"
        and (now - (LR.parse_iso(a.get("attemptedAt") or a.get("claimedAt")) or now))
            .total_seconds() <= 24 * 3600)
    line_quality = f"quality: {thin_hits} thin · {given_up_hits} given up (24h)"
    hits = raw_notes(rows)
    line3_notes = "notes: clean" if not hits else \
        f"notes: {len(hits)} with raw text ({', '.join(hits[:5])})"
    if open_alarms:
        paging = sorted(a["key"] for a in open_alarms if a.get("page", True))
        line4 = "open alarms: " + ", ".join(paging) if paging else "open alarms: none"
        quiet = sorted(a["key"] for a in open_alarms if not a.get("page", True))
        line5 = "quiet: " + ", ".join(quiet) if quiet else ""
    else:
        line4 = "open alarms: none"
        line5 = ""
    return "\n".join(x for x in (line1, line2, line3, line_quality, line3_notes, line4, line5) if x)


# =============================================================================
# 3e. run_once()
# =============================================================================

def _write_heartbeat(key):
    ops_put(key, "worker.heartbeat", {"note": "alive"})


def beat(key):
    """Write worker.heartbeat directly. Called by worker.py's Fly-side loop
    every tick (60s). run_once(beat=True) does the same thing every SECOND
    tick (120s), immediately before it checks anything — that ordering is
    what guarantees the Fly-side caller can never observe its own heartbeat
    as stale (see check_all's worker-down comment)."""
    _write_heartbeat(key)


def _worker_seen_at(key):
    latch = ops_get(key, "worker.heartbeat")
    if not latch:
        return None
    return LR.parse_iso(latch.get("updated_at"))


def _fallback_seen_at(key):
    """Mirrors _worker_seen_at, against the second lynxr_ops key the
    fallback loop (--as-fallback) writes every ~60s."""
    latch = ops_get(key, "fallback.heartbeat")
    return LR.parse_iso(latch.get("updated_at")) if latch else None


def _fallback_alive(seen_at, now, role):
    """Tri-state, and the third state matters. True: covering. False:
    measured quiet. None: cannot tell — no row, or lynxr_ops unreadable.
    None must never escalate to the both-down page, because "I have not
    looked" and "it is dead" are opposite claims."""
    if role == "fallback":
        return True     # THIS process is the fallback loop's own check.
                        # Directly observable, not self-certifying: it
                        # asserts its own presence and Fly's absence, never
                        # its own health.
    if seen_at is None:
        return None
    return (now - seen_at).total_seconds() <= FALLBACK_COVER_MINUTES * 60


def _sources_count(key, since=None):
    """Row count of lynxr_sources, optionally filtered to last_seen_at >=
    `since`. Uses Prefer: count=exact + Range: 0-0 so the response body is
    empty and the total comes off Content-Range (verified working: returns
    "0-0/25")."""
    try:
        path = "/rest/v1/lynxr_sources?select=canonical_url"
        if since is not None:
            iso = since.isoformat().replace("+00:00", "Z")
            path += f"&last_seen_at=gte.{urllib.parse.quote(iso, safe='')}"
        req = urllib.request.Request(f"{LR.SB_URL}{path}")
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("Prefer", "count=exact")
        req.add_header("Range", "0-0")
        with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as r:
            content_range = r.headers.get("Content-Range", "")
            r.read()
        total = content_range.split("/")[-1]
        return int(total) if total.isdigit() else 0
    except Exception as e:  # noqa: BLE001
        log.warning("lynxr_sources count failed: %s", str(e)[:90])
        return 0


def _charges_count(key, since):
    """Row count of lynxr_script_charges charged_at >= `since`. Same
    Prefer: count=exact + Range: 0-0 pattern as _sources_count above, against
    supabase/allowance_ledger.sql's ledger table instead of lynxr_sources.
    Returns 0 (never raises) if that table doesn't exist yet — an owner action
    this module must keep degrading gracefully in front of, same as every
    other table here that isn't applied yet."""
    try:
        iso = since.isoformat().replace("+00:00", "Z")
        path = "/rest/v1/lynxr_script_charges?select=adaptation_id"
        path += f"&charged_at=gte.{urllib.parse.quote(iso, safe='')}"
        req = urllib.request.Request(f"{LR.SB_URL}{path}")
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("Prefer", "count=exact")
        req.add_header("Range", "0-0")
        with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as r:
            content_range = r.headers.get("Content-Range", "")
            r.read()
        total = content_range.split("/")[-1]
        return int(total) if total.isdigit() else 0
    except Exception as e:  # noqa: BLE001
        log.warning("lynxr_script_charges count failed: %s", str(e)[:90])
        return 0


def _maybe_digest(key, rows, now, open_alarms=None, force=False):
    if not force:
        if now.hour < DIGEST_HOUR_UTC:
            return False
        latch = ops_get(key, "digest.last")
        if latch and (latch.get("value") or {}).get("date") == now.date().isoformat():
            return False
    worker_seen_at = _worker_seen_at(key)
    fallback_seen_at = _fallback_seen_at(key)
    sources_total = _sources_count(key)
    body = digest(rows, sources_total, worker_seen_at, now, open_alarms=open_alarms,
                  fallback_seen_at=fallback_seen_at)
    notify("daily digest", body, priority=2, tags="chart_with_upwards_trend")
    ops_put(key, "digest.last", {"date": now.date().isoformat()})
    return True


def run_once(key, dry_run=False, beat=False, force_digest=False, role="external"):
    """Fetch, check, latch, notify, and send the daily digest when due.
    Wraps the whole body in try/except — run_once may not raise, ever, no
    matter what the database or the network are doing.

    `role`: "fly" (the Fly-side worker's own loop, via worker.py), "fallback"
    (the GitHub `adaptations.yml` polling loop, via --as-fallback), or the
    default "external" (any other caller, e.g. latency-watch.yml's plain
    --once — an observer, not a worker, so it never claims to be covering
    anything)."""
    try:
        if beat:
            _write_heartbeat(key)
        if role == "fallback":
            # Written before anything else — same ordering `beat=True` uses
            # for Fly's own heartbeat, and for the same reason: this loop
            # must never observe its own presence as stale.
            ops_put(key, "fallback.heartbeat", {"note": "alive"})

        now = datetime.now(timezone.utc)
        rows = LR.fetch_rows(key)
        sources_recent = _sources_count(key, since=now - timedelta(hours=SOURCES_STALL_WINDOW_H))
        worker_seen_at = _worker_seen_at(key)
        charges_24h = _charges_count(key, since=now - timedelta(hours=24))
        fallback_seen_at = _fallback_seen_at(key)
        fallback_alive = _fallback_alive(fallback_seen_at, now, role)
        alarms = check_all(rows, sources_recent, worker_seen_at, now, charges_24h=charges_24h,
                            role=role, fallback_alive=fallback_alive)

        if dry_run:
            return alarms

        # Only paging alarms latch/notify/clear here — a digest-only alarm
        # (rerun:*, sources-stalled, softfail:*) is reported exclusively by
        # _maybe_digest's "quiet:" line below, never by raise_alarm/notify.
        paging = [a for a in alarms if a.get("page", True)]
        alarm_keys = {a["key"] for a in paging}
        for a in paging:
            raise_alarm(key, a["key"], a["title"], a["body"],
                        a.get("priority", 4), a.get("tags", "rotating_light"))

        # Anything latched open that ISN'T in this tick's PAGING list has
        # cleared — including a key that was latched open under the old rules
        # and is now demoted: it gets one quiet "resolved" here, correctly.
        # "selftest" is excluded — it is only ever opened/closed by --self-test
        # itself, never by check_all, so a --self-test interrupted mid-way
        # must stay open until deliberately cleared (see verification step 5).
        for ak in _list_open_alarms(key):
            if ak != "selftest" and ak not in alarm_keys:
                clear_alarm(key, ak, f"{ak} resolved")

        _maybe_digest(key, rows, now, open_alarms=alarms, force=force_digest)
        return alarms
    except Exception as e:  # noqa: BLE001
        log.warning("run_once() failed: %s", str(e)[:160])
        # NOT `return []` — that read as "checked, nothing wrong" to main(),
        # which is exactly the false all-clear that let this module go quiet
        # on run #168's header ValueError while it had not read a single row.
        # A blind run and a healthy run must never look the same.
        return [{"key": "watchdog-blind", "page": False, "priority": 2,
                "tags": "warning",
                "title": "watchdog could not read the database",
                "body": str(e)[:160]}]


def _self_test(key):
    """Raise then clear one alarm under the reserved key "selftest", so the
    ntfy channel and the lynxr_ops latch can both be proven working WITHOUT
    hand-editing production data. Two notifications: a priority-4 alarm, then
    a priority-2 resolve. Running this twice in a row must produce two
    alarms, not one — that is the proof the latch is actually being cleared
    rather than merely never opening."""
    raise_alarm(key, "selftest", "self-test alarm",
                "pipeline/watchdog.py --self-test — ignore if you did not run this",
                priority=4, tags="rotating_light")
    time.sleep(3)
    clear_alarm(key, "selftest", "self-test resolved")


# =============================================================================
# 3f. ci_failure_verdict() — the workflow's page decision, moved into Python
# =============================================================================
#
# A shell-level `if: failure()` curl cannot make this judgement: deciding
# whether a creator is affected requires reading worker.heartbeat out of
# lynxr_ops, and distinguishing "the table answered and there is no
# heartbeat" from "I could not read the table at all" — which ops_get()
# cannot express, since it returns None for both and they mean opposite
# things. Hence _ops_probe() below, instead of ops_get().

def _ops_probe(key):
    """(readable, worker_seen_at). One direct GET of
    lynxr_ops?key=eq.worker.heartbeat&select=updated_at&limit=1, so a
    successful read with no rows is distinguishable from a failed read.
    Returns (False, None) on any exception, and logs it."""
    try:
        req = urllib.request.Request(
            f"{LR.SB_URL}/rest/v1/lynxr_ops?key=eq.worker.heartbeat&select=updated_at&limit=1")
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {key}")
        with urllib.request.urlopen(req, timeout=10, context=SSL_CTX) as r:
            rows = json.load(r)
        seen_at = LR.parse_iso(rows[0].get("updated_at")) if rows else None
        return True, seen_at
    except Exception as e:  # noqa: BLE001
        log.warning("_ops_probe failed: %s", str(e)[:120])
        return False, None


def ci_failure_verdict(worker_seen_at, ops_readable, now):
    """Pure. What to do when a GitHub job that keeps lynxr running has just
    failed. Returns {"page", "priority", "alarm_key", "title", "body", "why"}.

    Both-down reuses the "worker-down" latch key deliberately, so a later
    --once from latency-watch.yml that still sees Fly stale keeps the SAME
    episode open rather than sending a "resolved" into a live outage, and
    clears it the moment Fly returns. "ci-unverified" is its own key and
    clears on the first healthy run_once."""
    if not ops_readable:
        return {"page": True, "priority": 4, "alarm_key": "ci-unverified",
                "title": "could not verify whether a creator is affected",
                "body": "lynxr_ops was not readable — cannot tell whether Fly is covering.",
                "why": "unknown"}

    stale = worker_seen_at is None or (now - worker_seen_at).total_seconds() > FALLBACK_COVER_MINUTES * 60
    if not stale:
        return {"page": False, "priority": 0, "alarm_key": None,
                "title": None, "body": None, "why": "fly-covering"}

    age = "never seen" if worker_seen_at is None else \
        f"{(now - worker_seen_at).total_seconds():.0f}s ago"
    return {"page": True, "priority": 5, "alarm_key": "worker-down",
            "title": "NOTHING is writing scripts",
            "body": f"worker.heartbeat last seen {age} — and this fallback job just failed too.",
            "why": "both-down"}


# =============================================================================
# 3g. CLI
# =============================================================================

def main():
    envcfg.sanitize_environ()
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="run one check (the default)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be sent; touch no latch, send nothing")
    ap.add_argument("--digest", action="store_true", help="force the daily digest now")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--self-test", action="store_true",
                    help="raise then clear one alarm under the reserved key 'selftest'")
    ap.add_argument("--as-fallback", action="store_true",
                    help="this IS the GitHub fallback loop (adaptations.yml's polling "
                         "step) — writes fallback.heartbeat every call, which is the "
                         "signal every other caller reads to decide whether the "
                         "fallback is covering for Fly")
    ap.add_argument("--ci-failed", action="store_true",
                    help="a GitHub job that keeps lynxr running just went red. Decide "
                         "whether a creator is actually affected (reading "
                         "worker.heartbeat out of lynxr_ops) before paging — always "
                         "exits 0, since the job is already red")
    args = ap.parse_args()

    env = LR.load_env(LR.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY",
                            env.get("SUPABASE_SERVICE_ROLE_KEY"),
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (.env or environment)")

    if args.self_test:
        _self_test(key)
        print("self-test: alarm raised, then cleared — check the phone for two messages")
        return

    if args.ci_failed:
        ops_readable, worker_seen_at = _ops_probe(key)
        now = datetime.now(timezone.utc)
        v = ci_failure_verdict(worker_seen_at, ops_readable, now)
        print(f"why: {v['why']}")
        if v["page"]:
            repo = os.environ.get("GITHUB_REPOSITORY", "")
            run_id = os.environ.get("GITHUB_RUN_ID", "")
            run_no = os.environ.get("GITHUB_RUN_NUMBER", "")
            ref = f"{repo}#{run_no} ({run_id})" if repo else f"run {run_id}"
            body = f"{v['body']} {ref}"
            raise_alarm(key, v["alarm_key"], v["title"], body, v["priority"], "rotating_light")
            print(f"paged: {v['alarm_key']} (priority {v['priority']})")
        else:
            print("no page — fly is covering")
        # ALWAYS exit 0: the job is already red, and a second failure mode
        # here would only obscure it.
        return

    role = "fallback" if args.as_fallback else "external"
    alarms = run_once(key, dry_run=args.dry_run, force_digest=args.digest, role=role)

    blind = any(a["key"] == "watchdog-blind" for a in alarms)

    if args.json:
        print(json.dumps(alarms, indent=2))
    else:
        if not alarms:
            print("no breaches")
        for a in alarms:
            print(f"{a['key']}: {a['title']}")
            print(f"  {a['body']}")
        if blind:
            print("CHECK FAILED — could not read the database, so this is NOT an all-clear")

    # Never exit non-zero ON A BREACH — that is what pinned latency-watch.yml
    # permanently red off one 1548s sample. This module's whole point is a
    # notification the owner sees on their phone, not a red X nobody watches.
    #
    # Exit 2 is different: it means "I could not check", not "something is
    # broken". A green run must never be allowed to mean "I looked and it was
    # fine" when it actually means "I never looked" — that is the false
    # all-clear that let run #168 onward look healthy while dying on the
    # first Supabase call of every pass.
    if blind:
        sys.exit(2)


if __name__ == "__main__":
    main()
