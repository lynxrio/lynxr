#!/usr/bin/env python3
"""The script worker — runs continuously, picks up work within seconds.

WHY THIS EXISTS
    Scripts were written by GitHub Actions. The cron said every 15 minutes;
    measured, it fired roughly every THREE HOURS, and one run held a
    concurrency group so exactly one script in the world was processed at a
    time. A creator pasted a link and waited hours.

    None of that was compute. A script takes ~50 seconds end to end (measured:
    8s download, 3s transcribe, ~40s of model calls). The hours were queue.

HOW IT PICKS WORK UP FAST
    The obvious loop — "call process_adaptations every few seconds" — does not
    scale, because that script's discovery step used to pull EVERY creator's
    whole JSON blob to look for queued work. Measured at three creators that
    was already 101,626 bytes and 887ms; at a thousand it would be megabytes,
    several times a second, forever.

    So this polls a much cheaper question first: JSONB containment against the
    adaptations array, returning ids only. Same three creators, 2 bytes and
    170ms — and it stays that size as the corpus grows, because Postgres does
    the filtering instead of shipping everything here to be filtered.

    Only when that probe finds something does the real worker run — and as of
    the 2026-08-18 discovery-prefilter change, process_adaptations.py's own
    periodic sweep runs the same CLASS of containment probe, generalised over
    all four wants_work() conditions (queued, abandoned running, cooled/retry-
    due error, and retryable done+aiFail), not just queued. Measured live:
    214,900 bytes / 548ms -> 2 bytes / ~200ms at five creators. So the sweep
    below is cheap too now, not just the probe here — queued_creators() stays
    queued-only ON PURPOSE, because it is the fast LATENCY probe (this file's
    job is picking up work in seconds), not the discovery scan (that one lives
    in process_adaptations.py and can afford the full four-condition check
    every 60s instead of every 2s).

RUNNING IT
    set -a; source .env; set +a
    ./venv/bin/python pipeline/worker.py

    Ctrl-C (or SIGTERM) finishes the script in flight, then exits — it does not
    abandon a half-written one.

LEAVE THE GITHUB WORKFLOW ON
    .github/workflows/adaptations.yml runs the same worker on GitHub's runners,
    and the two coexist safely — keep it as the fallback for whenever this Mac
    is asleep, which is the one way this process is WORSE than GitHub's runners.

    They do not double-spend, because process_adaptations claims before it
    spends: it writes status="running" + claimedAt and grafts that back before
    any model call, and wants_work() treats a `running` entry as available only
    once its lease has expired (25 min). So whichever worker claims first, the
    other skips. The race window is the few hundred milliseconds between one
    worker's read and its claim — and in practice this one empties the queue
    within seconds of a paste, so GitHub's run usually finds nothing at all.
"""

import argparse
import json
import logging
import os
import signal
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Safe to import at module top: watchdog.py only pulls in latency_report.py,
# which is side-effect-free (functions, SSL_CTX, ROOT, SB_URL, main() guarded
# behind __name__). It must NEVER pull in process_adaptations — that module
# runs logging.basicConfig and mkdir("output/") as import-time side effects,
# which is exactly why run_pass() below runs it as a subprocess instead.
import watchdog
import envcfg

ROOT = Path(__file__).resolve().parent.parent
SB_URL = "https://esakjfogplfszievvabi.supabase.co"

# This venv's Python has no system CA bundle — a bare default context fails
# every request with CERTIFICATE_VERIFY_FAILED. Same guard the rest of the
# pipeline uses (process_adaptations.py, upload_covers.py, cohort.py).
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("worker")

STOPPING = False


def load_env(path):
    """Read .env into the environment, without overwriting what is already set.

    The worker reads this itself rather than relying on the caller having
    sourced it, because under launchd there IS no caller — a LaunchAgent starts
    with a near-empty environment. The alternative is putting the service-role
    key in the plist, and the plist lives in a PUBLIC repo. Secrets stay in
    .env, which is gitignored, and nowhere else.

    Subprocesses inherit these, so process_adaptations gets its keys too.
    """
    try:
        text = Path(path).read_text()
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def stop(signum, _frame):
    """Finish the current script, then exit.

    Killing mid-script would leave the adaptation claimed and the creator
    watching "writing your script" until the lease expires — so the flag is
    checked between passes rather than inside one.
    """
    global STOPPING
    if STOPPING:                       # second signal: the caller means it
        log.warning("second signal — exiting now")
        sys.exit(130)
    STOPPING = True
    log.info("signal %s — finishing the current script, then stopping", signum)


# The text of the last probe failure, so the watchdog alarm raised after 30
# consecutive misses can say WHY instead of just "it's been failing".
_LAST_PROBE_ERROR = ""


def queued_creators(key):
    """Ids of creators with at least one QUEUED adaptation. Cheap on purpose.

    `cs` is JSONB containment: `[{...,"status":"queued",...}] @> [{"status":
    "queued"}]` is true, so Postgres answers "is there any queued entry" without
    returning the entries. Only `queued` is probed here — `error` retries and
    abandoned `running` leases are not latency-sensitive and are swept up by the
    periodic full pass instead.

    Returns None on a transport error so the caller can tell "no work" from
    "could not ask", and not treat a network blip as an empty queue.
    """
    want = urllib.parse.quote(json.dumps([{"status": "queued"}]))
    url = f"{SB_URL}/rest/v1/lynxr_creators?select=id&data->adaptations=cs.{want}"
    req = urllib.request.Request(url)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=20, context=SSL_CTX) as r:
            return [row["id"] for row in json.load(r)]
    except Exception as e:  # noqa: BLE001
        global _LAST_PROBE_ERROR
        _LAST_PROBE_ERROR = str(e)[:90]
        log.warning("probe failed (%s) — will retry", _LAST_PROBE_ERROR)
        return None


def run_pass(extra_args):
    """One run of the real worker, as its own process.

    Deliberately a subprocess rather than an import. process_adaptations is
    long-running, holds temp dirs and a Whisper model, and can raise from a
    dozen places; a crash there must not take this loop down with it. The
    GitHub workflow ran it exactly this way and that property is the reason.
    """
    cmd = [sys.executable, str(ROOT / "pipeline" / "process_adaptations.py")] + extra_args
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=str(ROOT / "pipeline"), timeout=3600)
        ok = r.returncode == 0
    except subprocess.TimeoutExpired:
        log.error("pass exceeded one hour — killed")
        return False
    except Exception as e:  # noqa: BLE001
        log.error("pass failed to start: %s", str(e)[:120])
        return False
    log.info("pass finished in %.0fs%s", time.time() - t0, "" if ok else " (non-zero exit)")
    return ok


def warm_whisper():
    """Page the model weights in before anyone is waiting on them.

    Not a model download — the Dockerfile bakes the weights in and sets
    HF_HUB_OFFLINE=1. This is the OS page cache: 464MB read cold is ~60s, warm
    is ~1.7s, and without this the creator who happens to paste first after a
    deploy pays the difference.
    """
    t0 = time.time()
    try:
        sys.path.insert(0, str(ROOT / "pipeline"))
        from transcribe import MODEL, load_faster       # added in Step 6
        load_faster(MODEL)
        log.info("whisper warm in %.0fs", time.time() - t0)
    except Exception as e:  # noqa: BLE001 — a cold model is slow, not fatal
        log.warning("whisper warm-up skipped: %s", str(e)[:100])


def watchdog_loop(key):
    """Runs the alarm checks independently of the queue probe above, on its
    own 60s tick — daemon so it never blocks process exit, same as
    warm_whisper's thread. Writes the heartbeat every tick and runs the full
    watchdog.run_once() every SECOND tick (120s): the Fly worker is fast
    (the probe above finds work in ~2s), so a 120s alarm cadence is plenty,
    and it is what makes worker-down structurally impossible to raise from
    THIS side (see watchdog.check_all's comment on that) — now ENFORCED by
    passing role="fly" below, not merely implied by the ordering of the
    heartbeat write. role="fly" also means this caller never reads
    fallback.heartbeat for an alarm — only watchdog.digest() ever puts it on
    the phone, in the daily digest's sources line.

    COST NOTE: run_once() still re-pulls every creator's whole row (measured
    101,626 bytes / 887ms at three creators, worse now — see
    worker-discovery-prefilter.md's "Noticed, not planned") — unlike
    process_adaptations.py's own sweep, which the 2026-08-18 discovery-
    prefilter change moved onto a cheap JSONB containment probe (see --sweep's
    comment below). watchdog.py needs timings, processedAt, softFails and
    attempts across every creator to run its alarm checks, which a
    containment probe cannot answer, so it cannot reuse that prefilter as-is —
    a real fix means narrowing what it selects. Fine at today's scale; this is
    what remains to fix once the creator count grows past the dozens.

    A watchdog failure may never stop the worker — every tick is wrapped in
    its own try/except.
    """
    tick = 0
    while not STOPPING:
        try:
            watchdog.beat(key)
            if tick % 2 == 1:
                watchdog.run_once(key, beat=True, role="fly")
        except Exception as e:  # noqa: BLE001
            log.warning("watchdog tick failed: %s", str(e)[:120])
        tick += 1
        slept = 0.0
        while slept < 60.0 and not STOPPING:
            time.sleep(min(0.25, 60.0 - slept))
            slept += 0.25


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--poll", type=float, default=2.0,
                    help="seconds between queue probes (default 2)")
    # A stale claim is invisible to the fast probe above (queued_creators() asks
    # only status:queued, deliberately) so only the full sweep recovers it.
    # Shortened from 180s alongside the lease going from 25 minutes to 2.5 in
    # process_adaptations.py: together, a death mid-script now costs the lease
    # (150s) plus at most one sweep (60s) — about 3.5 minutes, not 25.
    #
    # Each pass now asks a cheap JSONB containment prefilter first (2026-08-18)
    # instead of always doing a full discovery pull — measured live at five
    # creators: 2 bytes on the prefilter, falling back to the old full scan
    # (~215 KB) only when the prefilter cannot answer or its canary says the
    # containment grammar is broken. See process_adaptations.py's
    # "DISCOVERY PREFILTER" block for the four conditions it covers.
    ap.add_argument("--sweep", type=float, default=60.0,
                    help="seconds between full passes, which also pick up error "
                         "retries and abandoned claims (default 60)")
    ap.add_argument("--once", action="store_true",
                    help="probe once, run a pass if there is work, then exit")
    args, passthrough = ap.parse_known_args()   # anything else goes to the worker

    load_env(ROOT / ".env")
    envcfg.sanitize_environ()
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY",
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (not in the environment or .env)")

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    # Non-blocking: a link pasted during the warm-up must still be picked up in
    # 2 seconds and just pays the cold cost once, rather than waiting for the
    # warm-up to finish. Daemon so it never blocks process exit either.
    threading.Thread(target=warm_whisper, daemon=True).start()
    # A subprocess, not an import, for the reason run_pass()'s own docstring
    # gives — and because importing process_adaptations into another module
    # runs its logging setup as a side effect, the trap already recorded for
    # process_blueprints.
    threading.Thread(target=lambda: run_pass(["--warm-prefixes"]), daemon=True).start()
    # Not for --once: a one-shot invocation (used by the launchd/manual paths)
    # exits in seconds, and a 60s-ticking daemon thread has no business
    # existing for a process that short-lived.
    if not args.once:
        threading.Thread(target=watchdog_loop, args=(key,), daemon=True).start()

    log.info("watching for queued scripts — probe every %.1fs, full sweep every %.0fs",
             args.poll, args.sweep)
    if passthrough:
        log.info("passing through to process_adaptations: %s", " ".join(passthrough))

    last_sweep = 0.0
    idle_logged = False
    probe_fails = 0
    # 30 consecutive failures at the default 2.0s poll is ~60s of unbroken
    # trouble — long enough that a single blip (already handled silently,
    # every other tick just retries) cannot trip it, and short enough to
    # still catch the case actually measured: a rotated/expired service-role
    # key, which fails "HTTP Error 401: Unauthorized" on every single try.
    PROBE_FAIL_ALARM = 30
    while not STOPPING:
        due_sweep = (time.time() - last_sweep) >= args.sweep
        ids = queued_creators(key)

        if ids is None:
            probe_fails += 1
            if probe_fails >= PROBE_FAIL_ALARM:
                try:
                    watchdog.raise_alarm(
                        key, "supabase-unreachable", "worker can't reach Supabase",
                        f"{probe_fails} consecutive probe failures. {_LAST_PROBE_ERROR}",
                        priority=4, tags="rotating_light")
                except Exception as e:  # noqa: BLE001
                    log.warning("watchdog raise_alarm failed: %s", str(e)[:120])
        elif probe_fails:
            # Recovering from a streak that was long enough to matter — clear
            # whatever raise_alarm may have opened above. clear_alarm() is a
            # cheap no-op when nothing is open, but this only calls it on the
            # recovery edge rather than on every healthy tick, so a Fly worker
            # polling every 2s is not also hitting lynxr_ops every 2s forever.
            try:
                watchdog.clear_alarm(key, "supabase-unreachable", "supabase reachable again")
            except Exception as e:  # noqa: BLE001
                log.warning("watchdog clear_alarm failed: %s", str(e)[:120])
            probe_fails = 0

        if ids:
            log.info("queued work from %d creator(s) — starting", len(ids))
            idle_logged = False
            # One pass, then straight back to the probe. A pass takes at most
            # --max-per-creator entries, so a burst of pasted links drains over
            # consecutive iterations rather than in a single run — which is what
            # keeps one creator's backlog from starving everyone else's.
            run_pass(passthrough)
            last_sweep = time.time()
        elif due_sweep:
            # Either nothing is queued or the probe could not answer. Both are
            # reasons to run the full pass on schedule anyway: it does its own
            # discovery, and it is what picks up error retries and claims
            # abandoned by a killed run.
            #
            # This sweep is now ALSO the metrics tick: --refresh-views only
            # fires when process_adaptations.py's own pass finds nothing
            # queued (its idle branch), so passing it here costs a busy
            # system nothing and only ever runs on the branch that was
            # already idle. The queued-work branch above stays plain
            # `passthrough` on purpose — a pass triggered by a real paste
            # must never refresh (Assumption 3): the GitHub fallback loop
            # runs the same script every ~60s in parallel, and letting both
            # refresh would double the requests and put two processes into
            # the same read-modify-write on lynxr_creators. Only the Fly
            # worker's sweep asks for it.
            log.info("periodic sweep")
            run_pass(passthrough + ["--refresh-views"])
            last_sweep = time.time()
            idle_logged = False
        elif ids is None:
            # Probe failed; queued_creators already warned. Say nothing more —
            # claiming "idle" here would report an outage as an empty queue.
            pass
        elif not idle_logged:
            log.info("idle — nothing queued")
            idle_logged = True          # say it once, not every two seconds

        if args.once:
            break
        # Sleep in slices so a signal is noticed promptly rather than after a
        # full interval.
        slept = 0.0
        while slept < args.poll and not STOPPING:
            time.sleep(min(0.25, args.poll - slept))
            slept += 0.25

    log.info("stopped")


if __name__ == "__main__":
    main()
