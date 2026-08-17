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
    scale, because that script's discovery step pulls EVERY creator's whole JSON
    blob to look for queued work. Measured at three creators that is already
    101,626 bytes and 887ms; at a thousand it is megabytes, several times a
    second, forever.

    So this polls a much cheaper question first: JSONB containment against the
    adaptations array, returning ids only. Same three creators, 2 bytes and
    170ms — and it stays that size as the corpus grows, because Postgres does
    the filtering instead of shipping everything here to be filtered.

    Only when that probe finds something does the real worker run.

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
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

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
        log.warning("probe failed (%s) — will retry", str(e)[:90])
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--poll", type=float, default=2.0,
                    help="seconds between queue probes (default 2)")
    ap.add_argument("--sweep", type=float, default=180.0,
                    help="seconds between full passes, which also pick up error "
                         "retries and abandoned claims (default 180)")
    ap.add_argument("--once", action="store_true",
                    help="probe once, run a pass if there is work, then exit")
    args, passthrough = ap.parse_known_args()   # anything else goes to the worker

    load_env(ROOT / ".env")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (not in the environment or .env)")

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    log.info("watching for queued scripts — probe every %.1fs, full sweep every %.0fs",
             args.poll, args.sweep)
    if passthrough:
        log.info("passing through to process_adaptations: %s", " ".join(passthrough))

    last_sweep = 0.0
    idle_logged = False
    while not STOPPING:
        due_sweep = (time.time() - last_sweep) >= args.sweep
        ids = queued_creators(key)

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
            log.info("periodic sweep")
            run_pass(passthrough)
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
