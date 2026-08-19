#!/usr/bin/env python3
"""Measure the discovery prefilter against the live database, on the wire.

WHY THIS EXISTS
----------------
worker-discovery-prefilter.md replaced process_adaptations.py's discovery
scan — pull every creator's whole `data` blob, filter in Python — with a
JSONB containment probe. Live 2026-08-18, three runs each, at five creators:

    query                                              bytes    ms
    select=id,data (today's discovery scan)            214,900  415/548/606
    the containment prefilter                           2       171/200/271
    prefilter + [] canary, limit=1                      47       249/293/675

Those numbers are already stale the moment the corpus changes size, and the
plan's own latency projections past five creators are estimates, not
measurements (see the plan's "What was measured" section). This script makes
re-checking a live number one command instead of a rediscovery.

READ-ONLY. It issues GETs against process_adaptations.py's own
prefilter_probes()/prefilter_url() (so it measures the exact query the
worker runs, not a hand-copied approximation) and must never write.

Usage:
    ./venv/bin/python pipeline/prefilter_bench.py
    ./venv/bin/python pipeline/prefilter_bench.py --runs 5
"""

import argparse
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    # This venv's Python has no system CA bundle — a bare default context
    # fails every request with CERTIFICATE_VERIFY_FAILED. Same guard every
    # other pipeline script uses.
    SSL_CTX = ssl.create_default_context()

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import process_adaptations as P  # noqa: E402 — reuses the worker's own probe/URL code
import envcfg  # noqa: E402 — the one place a secret or config value is read; see its docstring.

SB_URL = "https://esakjfogplfszievvabi.supabase.co"


def load_env(path):
    env = {}
    try:
        for line in Path(path).read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return env


def timed_get(key, path):
    """One GET. Returns (status, byte_count, ms). Never writes — GET only."""
    req = urllib.request.Request(SB_URL + path, method="GET")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
            body = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        body = e.read()
        status = e.code
    ms = (time.monotonic() - t0) * 1000
    return status, len(body), ms


def run_n(label, key, path, runs):
    print(f"\n{label}")
    print(f"  {path[:100]}{'...' if len(path) > 100 else ''}")
    results = []
    for i in range(runs):
        status, nbytes, ms = timed_get(key, path)
        results.append((status, nbytes, ms))
        print(f"  run {i + 1}: HTTP {status}, {nbytes:,} bytes, {ms:.0f}ms")
    return results


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", type=int, default=3,
                    help="requests per query (default 3)")
    args = ap.parse_args()

    env = load_env(ROOT / ".env")
    key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY",
                        env.get("SUPABASE_SERVICE_ROLE_KEY"),
                        os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (.env or environment)")

    probes = P.prefilter_probes()

    scan_results = run_n(
        "today's full discovery scan (select=id,data)",
        key, "/rest/v1/lynxr_creators?select=id,data", args.runs)

    prefilter_results = run_n(
        "the discovery prefilter (containment, ids only)",
        key, P.prefilter_url(probes), args.runs)

    canary_results = run_n(
        "prefilter + [] canary, limit=1",
        key, P.prefilter_url(probes + [P.PREFILTER_CANARY], limit=1), args.runs)

    # One extra cheap GET (ids only) purely to count creators for the
    # per-creator/projection math below — not one of the three measured
    # queries above.
    try:
        import json as _json
        req = urllib.request.Request(
            SB_URL + "/rest/v1/lynxr_creators?select=id", method="GET")
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {key}")
        with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
            creators = len(_json.load(r))
    except Exception:  # noqa: BLE001
        creators = None

    print("\n--- summary ---")
    scan_bytes = [n for _, n, _ in scan_results]
    prefilter_bytes = [n for _, n, _ in prefilter_results]
    canary_bytes = [n for _, n, _ in canary_results]
    print(f"full scan:  bytes {min(scan_bytes):,}-{max(scan_bytes):,}, "
          f"ms {min(m for _, _, m in scan_results):.0f}-{max(m for _, _, m in scan_results):.0f}")
    print(f"prefilter:  bytes {min(prefilter_bytes):,}-{max(prefilter_bytes):,}, "
          f"ms {min(m for _, _, m in prefilter_results):.0f}-{max(m for _, _, m in prefilter_results):.0f}")
    print(f"canary:     bytes {min(canary_bytes):,}-{max(canary_bytes):,}, "
          f"ms {min(m for _, _, m in canary_results):.0f}-{max(m for _, _, m in canary_results):.0f}")

    if creators:
        bytes_per_creator = max(scan_bytes) / creators
        print(f"\ncreators: {creators}")
        print(f"bytes/creator (full scan): ~{bytes_per_creator:,.0f}")
        for n in (30, 300):
            print(f"projected full-scan bytes at {n} creators: "
                  f"~{bytes_per_creator * n:,.0f} "
                  f"({bytes_per_creator * n / 1024:,.1f} KB)")
    else:
        print("\ncould not determine creator count — skipping projection")

    any_http_error = any(s >= 400 for s, _, _ in scan_results + prefilter_results + canary_results)
    sys.exit(1 if any_http_error else 0)


if __name__ == "__main__":
    main()
