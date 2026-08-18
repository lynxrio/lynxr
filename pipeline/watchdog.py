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
tells the owner when one of a fixed set of failure SHAPES shows up:

    inflight:<id8>    a script stuck queued/running past 10 minutes
    inflight:many     more than 3 stuck at once (collapsed into one page)
    empty-script:<id8> finished "done" with a brand and zero beats
    rerun:<id8>       an entry that finished and was then worked AGAIN
    sources-stalled   scripts finishing but lynxr_sources not growing
    softfail:<sub>    a soft failure (source_upsert/video_upsert/cover/meta)
                      hit on 3+ of the last 5 finished scripts
    worker-down       the Fly worker's heartbeat has gone quiet
    spend-24h         process_adaptations.py's --daily-cap circuit breaker has
                      tripped — the worker is refusing ALL new work, so a
                      quiet queue means "capped", not "healthy"

p95 latency is DELIBERATELY not here — it lives in the daily digest instead.
The watchdog's first-ever run failed on `p95 1548s > 60s`, and at n=7 samples
p95 IS the worst sample, so one historical incident would pin a p95-based
pager red for 24h on an otherwise healthy system. A pager that is always red
gets muted, which is worse than no pager.

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
SOURCES_STALL_MIN = 3         # this many finished-with-source in the window...
SOURCES_STALL_WINDOW_H = 6    # ...and zero new lynxr_sources rows = stalled
SOFTFAIL_LAST_N = 5
SOFTFAIL_THRESHOLD = 3
WORKER_DOWN_MINUTES = 5       # heartbeat every 60s (worker.py) tolerates 5 misses —
                               # more than kill_timeout="300s" plus a cold boot.
LATCH_REMIND_HOURS = 24       # how long an open alarm stays quiet before a reminder
DIGEST_HOUR_UTC = int(os.environ.get("DIGEST_HOUR_UTC", "15"))
# Same default and same env var process_adaptations.py's --daily-cap reads —
# so the breaker that refuses work and the alarm that pages about it can
# never disagree on where the line is.
DAILY_SCRIPT_CAP = int(os.environ.get("DAILY_SCRIPT_CAP", 250))

SOFTFAIL_SUBSYSTEMS = ("source_upsert", "video_upsert", "cover", "meta")


# =============================================================================
# 3a. notify()
# =============================================================================

_warned = False


def notify(title, body, priority=4, tags="rotating_light"):
    """POST one message to ntfy.sh. May not raise, ever — catches Exception
    and returns False on any failure, including "no topic configured"."""
    global _warned
    env = LR.load_env(LR.ROOT / ".env")
    topic = os.environ.get("NTFY_TOPIC") or env.get("NTFY_TOPIC")
    server = os.environ.get("NTFY_SERVER") or env.get("NTFY_SERVER") or "https://ntfy.sh"
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
    is still open; silent otherwise."""
    opskey = f"alarm.{alarm_key}"
    now = datetime.now(timezone.utc)
    latch = ops_get(key, opskey)
    value = (latch or {}).get("value") or {}
    now_s = now.isoformat().replace("+00:00", "Z")

    if not value.get("open"):
        notify(title, body, priority=priority, tags=tags)
        ops_put(key, opskey, {"open": True, "opened_at": now_s,
                              "notified_at": now_s, "reminders": 0})
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

def check_all(rows, sources_recent, worker_seen_at, now=None, charges_24h=0):
    """The list of currently-breached invariants, each a dict with keys
    "key", "title", "body", "priority", "tags". A pure function of its
    arguments — same reason LR.build_report is pure: it has to be testable
    without a network call, and this plan exists precisely because a
    documented alarm (`SLA BREACH` in fly logs) turned out never to have been
    built, so the detector itself has to be provably real.

    `charges_24h` defaults to 0 (never fires) so every existing caller that
    does not pass it keeps working unchanged."""
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
            "title": f"{charges_24h} scripts charged in 24h",
            "body": (f"{charges_24h} scripts charged in 24h (cap {DAILY_SCRIPT_CAP}) "
                     "— worker is refusing new work"),
            "priority": 4, "tags": "rotating_light",
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
            "priority": 4, "tags": "rotating_light",
        })
    else:
        for b in breaches:
            id8 = str(b.get("id") or "")[:8] or "????????"
            alarms.append({
                "key": f"inflight:{id8}",
                "title": f"script stuck {b['age']:.0f}s",
                "body": f"status={b['status']} age={b['age']:.0f}s (budget {INFLIGHT_SLA}s). fly logs",
                "priority": 4, "tags": "rotating_light",
            })

    # ---- everything else needs the raw entries, not just build_report's
    # finished-sample summary (brandId, beats, softFails, attempts, aiFail
    # never leave this function or a script).
    finished = []   # (processedAt, entry) — every "done" entry with a processedAt
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
                    "priority": 4, "tags": "rotating_light",
                })

            # ---- rerun:<id8> ------------------------------------------------
            if (status == "done" and int(a.get("attempts") or 1) >= 2
                    and not a.get("aiFail")):
                rerun = a.get("rerun") or {}
                extra = (f" explicit rerun marker: prevProcessedAt={rerun.get('prevProcessedAt')} "
                         f"beats={rerun.get('beats')}.") if rerun else ""
                alarms.append({
                    "key": f"rerun:{aid8}",
                    "title": "entry worked twice",
                    "body": (f"adaptation {aid8} attempts={a.get('attempts')}.{extra} "
                             "./venv/bin/python pipeline/latency_report.py --since 24h --sla 60"),
                    "priority": 4, "tags": "rotating_light",
                })

    # ---- sources-stalled --------------------------------------------------
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
            "priority": 4, "tags": "rotating_light",
        })

    # ---- softfail:<subsystem> ---------------------------------------------
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
                    "priority": 4, "tags": "rotating_light",
                })

    # ---- worker-down --------------------------------------------------------
    # STRUCTURALLY, only the GitHub-side caller can ever fire this one: the
    # Fly-side caller writes worker.heartbeat immediately before checking
    # (run_once(beat=True)), so it can never observe its own heartbeat as
    # stale. That is the single most important property of the whole design —
    # the dead-man's switch has to live somewhere Fly dying cannot silence it.
    stale = worker_seen_at is None or (now - worker_seen_at).total_seconds() > WORKER_DOWN_MINUTES * 60
    if stale:
        age = "never seen" if worker_seen_at is None else \
            f"{(now - worker_seen_at).total_seconds():.0f}s ago"
        alarms.append({
            "key": "worker-down",
            "title": "worker heartbeat missing",
            "body": f"worker.heartbeat last seen {age} (budget {WORKER_DOWN_MINUTES}min). flyctl status",
            "priority": 4, "tags": "rotating_light",
        })

    return alarms


# =============================================================================
# 3d. digest()
# =============================================================================

def _fmt_s(val):
    return f"{val:.0f}s" if val is not None else "—"


def digest(rows, sources_total, worker_seen_at, now, open_alarms=None):
    """One daily message, priority 2 (arrives without a sound). THE DIGEST IS
    WHAT MAKES SILENCE MEAN SOMETHING — without a daily "all good" the owner
    cannot tell a healthy system from a dead alarm.

    `open_alarms`, when given, is the list check_all() returned this tick —
    it is what lets the digest say "open alarms: none" instead of just
    latency numbers, so a quiet system reads as verifiably quiet rather than
    merely unmeasured.
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
    line3 = f"sources {sources_total} total · worker seen {worker_txt}"
    if open_alarms:
        line4 = "open alarms: " + ", ".join(sorted(a.get("key", "?") for a in open_alarms))
    else:
        line4 = "open alarms: none"
    return "\n".join(x for x in (line1, line2, line3, line4) if x)


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
    sources_total = _sources_count(key)
    body = digest(rows, sources_total, worker_seen_at, now, open_alarms=open_alarms)
    notify("daily digest", body, priority=2, tags="chart_with_upwards_trend")
    ops_put(key, "digest.last", {"date": now.date().isoformat()})
    return True


def run_once(key, dry_run=False, beat=False, force_digest=False):
    """Fetch, check, latch, notify, and send the daily digest when due.
    Wraps the whole body in try/except — run_once may not raise, ever, no
    matter what the database or the network are doing."""
    try:
        if beat:
            _write_heartbeat(key)

        now = datetime.now(timezone.utc)
        rows = LR.fetch_rows(key)
        sources_recent = _sources_count(key, since=now - timedelta(hours=SOURCES_STALL_WINDOW_H))
        worker_seen_at = _worker_seen_at(key)
        charges_24h = _charges_count(key, since=now - timedelta(hours=24))
        alarms = check_all(rows, sources_recent, worker_seen_at, now, charges_24h=charges_24h)

        if dry_run:
            return alarms

        alarm_keys = {a["key"] for a in alarms}
        for a in alarms:
            raise_alarm(key, a["key"], a["title"], a["body"],
                        a.get("priority", 4), a.get("tags", "rotating_light"))

        # Anything latched open that ISN'T in this tick's list has cleared.
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
        return []


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
# 3f. CLI
# =============================================================================

def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="run one check (the default)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be sent; touch no latch, send nothing")
    ap.add_argument("--digest", action="store_true", help="force the daily digest now")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--self-test", action="store_true",
                    help="raise then clear one alarm under the reserved key 'selftest'")
    args = ap.parse_args()

    env = LR.load_env(LR.ROOT / ".env")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (.env or environment)")

    if args.self_test:
        _self_test(key)
        print("self-test: alarm raised, then cleared — check the phone for two messages")
        return

    alarms = run_once(key, dry_run=args.dry_run, force_digest=args.digest)

    if args.json:
        print(json.dumps(alarms, indent=2))
    else:
        if not alarms:
            print("no breaches")
        for a in alarms:
            print(f"{a['key']}: {a['title']}")
            print(f"  {a['body']}")

    # Never exit non-zero on a breach — that is what pinned latency-watch.yml
    # permanently red off one 1548s sample. This module's whole point is a
    # notification the owner sees on their phone, not a red X nobody watches.


if __name__ == "__main__":
    main()
