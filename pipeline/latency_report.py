#!/usr/bin/env python3
"""Paste-to-script latency, measured from the live database — not a claim.

WHY THIS EXISTS
----------------
The 26- and 34-minute waits creator-latency-60s.md exists to kill were
invisible until someone queried lynxr_creators by hand and split addedAt from
processedAt. This is that query, kept in the repo instead of a scratch file,
so the next regression is a command instead of a rediscovery.

It splits every finished adaptation into three stages instead of one number:

    addedAt -> claimedAt      queue        (waiting for a worker to pick it up)
    claimedAt -> attemptedAt  source       (download, transcribe, cover, frames,
                                            shots, tags AND format extraction)
    attemptedAt -> processedAt adapt       (the per-brand rewrite, and only that)

    CAUTION, this bucket was mislabelled until 2026-08-17. The middle stage was
    called "claim lag (claimed, not yet actually started)", which reads as dead
    queueing time. It is not. `attemptedAt` is stamped immediately before
    fill_adaptation(), so everything fill_source() does — plus format
    extraction, which is shared across a video's brands — lands inside it. On a
    measured 56s script that bucket was 37s of productive work and the queue
    was 1.7s; the old label made the pipeline look like a queueing problem and
    made `work` look like 17s when the real work was 54s.

plus the end-to-end total, addedAt -> processedAt. That split is what turned
"p90 is 2050s" into "the tail is entirely queue" on 2026-08-17, and it must
not have to be rediscovered by hand again.

It also reads the per-stage `timings` object (Step 1 of the same plan) when
present, so a regression is attributable to `download` or `adapt` specifically
rather than to "the worker got slower".

IN-FLIGHT BREACHES: any entry still `queued` or `running` whose addedAt is
older than --sla and has no processedAt. Those never become a finished sample,
so a purely retrospective report would never see them — and they are exactly
the ones nobody notices, because nothing ever "finishes" to draw attention.

EXIT CODE: non-zero when p95 over the window exceeds --sla, or when any
in-flight entry is over budget. Meant to be run from CI (see
.github/workflows/latency-watch.yml) where a non-zero exit is a red X.

Usage:
    python latency_report.py --since 24h --sla 60
    python latency_report.py --since 30d --sla 60 --json
"""

import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
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


def parse_since(s):
    """'24h' / '7d' / '30d' / '90m' -> a timedelta."""
    m = re.fullmatch(r"(\d+)\s*([hdmw])", s.strip().lower())
    if not m:
        sys.exit(f"--since must look like 24h, 7d or 30d — got {s!r}")
    n, unit = int(m.group(1)), m.group(2)
    return {"h": timedelta(hours=n), "d": timedelta(days=n),
            "m": timedelta(minutes=n), "w": timedelta(weeks=n)}[unit]


def parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def pct(sorted_vals, p):
    """Nearest-rank percentile — deliberately the same method the throwaway
    measurement script used, not a "more correct" interpolated one. This
    report's own acceptance test is that it reproduces THOSE numbers exactly
    on unchanged data (p50 121s, p90 2050s, 1/14 under 60s); a different
    formula that happens to be close is still the report being wrong."""
    if not sorted_vals:
        return None
    return sorted_vals[min(len(sorted_vals) - 1, int(round((p / 100) * (len(sorted_vals) - 1))))]


def median(sorted_vals):
    if not sorted_vals:
        return None
    n = len(sorted_vals)
    mid = n // 2
    return sorted_vals[mid] if n % 2 else (sorted_vals[mid - 1] + sorted_vals[mid]) / 2


def fetch_rows(key):
    req = urllib.request.Request(f"{SB_URL}/rest/v1/lynxr_creators?select=id,data")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
        return json.load(r)


def build_report(rows, since_arg, sla, now=None):
    """Pure function of the rows and args — split out from main() so it can be
    unit-tested without a network call, if that is ever worth doing."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - parse_since(since_arg)

    samples = []
    inflight = []

    for row in rows:
        for a in (row.get("data") or {}).get("adaptations") or []:
            added = parse_iso(a.get("addedAt"))
            if not added or added < cutoff:
                continue
            claimed = parse_iso(a.get("claimedAt"))
            attempted = parse_iso(a.get("attemptedAt"))
            processed = parse_iso(a.get("processedAt"))
            status = a.get("status")

            if processed:
                samples.append({
                    "addedAt": a.get("addedAt"),
                    "status": status,
                    "total": (processed - added).total_seconds(),
                    "queue": (claimed - added).total_seconds() if claimed else None,
                    "source": (attempted - claimed).total_seconds()
                              if (attempted and claimed) else None,
                    "adapt": (processed - attempted).total_seconds() if attempted else None,
                    "timings": a.get("timings") or {},
                })
            elif status in ("queued", "running"):
                age = (now - added).total_seconds()
                if age > sla:
                    inflight.append({"addedAt": a.get("addedAt"), "status": status,
                                     "age": round(age, 0)})

    totals = sorted(s["total"] for s in samples)
    result = {"since": since_arg, "sla": sla, "n": len(samples),
              "inflight_breaches": inflight}

    if totals:
        under = sum(1 for t in totals if t <= sla)
        result.update({
            "min": totals[0], "max": totals[-1],
            "p50": pct(totals, 50), "p90": pct(totals, 90), "p95": pct(totals, 95),
            "under_sla": under, "under_sla_pct": round(100 * under / len(totals), 1),
        })
        for stage in ("queue", "source", "adapt"):
            vals = sorted(v[stage] for v in samples if v[stage] is not None)
            result[f"{stage}_median"] = median(vals)

        # Per-stage medians from the `timings` object Step 1 writes onto each
        # adaptation — absent on anything processed before that step deployed,
        # which is why this only counts entries that actually carry one.
        stage_names = set()
        for s in samples:
            stage_names.update(k for k in s["timings"] if k not in ("total", "source_cache"))
        stage_medians = {}
        for name in sorted(stage_names):
            vals = sorted(v for v in (s["timings"].get(name) for s in samples)
                          if isinstance(v, (int, float)))
            if vals:
                stage_medians[name] = median(vals)
        result["stage_medians"] = stage_medians
    else:
        result.update({"min": None, "max": None, "p50": None, "p90": None, "p95": None,
                       "under_sla": 0, "under_sla_pct": None, "stage_medians": {},
                       "queue_median": None, "source_median": None, "adapt_median": None})

    result["breach"] = bool(inflight) or (result["p95"] is not None and result["p95"] > sla)
    return result


def print_report(r):
    print(f"window: last {r['since']} ({r['n']} finished samples), SLA {r['sla']:.0f}s")
    if r["n"]:
        print(f"  min {r['min']:.0f}s   p50 {r['p50']:.0f}s   p90 {r['p90']:.0f}s   "
              f"p95 {r['p95']:.0f}s   max {r['max']:.0f}s")
        print(f"  under {r['sla']:.0f}s: {r['under_sla']}/{r['n']} = {r['under_sla_pct']:.0f}%")

        def fmt(val):
            return f"{val:.0f}s" if val is not None else "—"

        print(f"  stage split (median): queue {fmt(r.get('queue_median'))}, "
              f"source+format {fmt(r.get('source_median'))}, "
              f"adapt {fmt(r.get('adapt_median'))}")
        if r["stage_medians"]:
            print("  per-stage medians (from `timings`):")
            for name, val in r["stage_medians"].items():
                print(f"    {name:16s} {val:6.2f}s")
    else:
        print("  no finished samples in this window")

    if r["inflight_breaches"]:
        print(f"\n{len(r['inflight_breaches'])} IN-FLIGHT BREACH(ES) — over budget and never "
              "finished, so they would not show up as a sample:")
        for b in r["inflight_breaches"]:
            print(f"  {b['addedAt']}  status={b['status']}  age={b['age']:.0f}s")

    print()
    if r["breach"]:
        why = []
        if r["p95"] is not None and r["p95"] > r["sla"]:
            why.append(f"p95 {r['p95']:.0f}s > sla {r['sla']:.0f}s")
        if r["inflight_breaches"]:
            why.append(f"{len(r['inflight_breaches'])} in-flight breach(es)")
        print("FAIL: " + "; ".join(why))
    else:
        print("OK")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", default="24h",
                    help="window to measure — 24h, 7d, 30d, ... (default 24h)")
    ap.add_argument("--sla", type=float, default=60,
                    help="seconds — the promise this is measured against (default 60)")
    ap.add_argument("--json", action="store_true",
                    help="machine-readable output instead of the printed report")
    args = ap.parse_args()

    env = load_env(ROOT / ".env")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (.env or environment)")

    try:
        rows = fetch_rows(key)
    except urllib.error.URLError as e:
        sys.exit(f"could not reach Supabase: {e}")

    report = build_report(rows, args.since, args.sla)

    if args.json:
        print(json.dumps({k: v for k, v in report.items() if k != "breach"}, indent=2))
    else:
        print_report(report)

    sys.exit(1 if report["breach"] else 0)


if __name__ == "__main__":
    main()
