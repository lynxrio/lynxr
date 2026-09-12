#!/usr/bin/env python3
"""Read-only view-count coverage report: how many scripts have a real view
count, on which platform, and how fresh it is.

WHY THIS EXISTS
    The owner asked why some cards show a view count and others don't. Before
    touching any code this answers "how bad is it, exactly" — and after a fix
    lands, this is the same measurement re-run to prove it worked. GET
    requests only; it must never issue PATCH, POST or DELETE.

WHAT IT PRINTS
    Table 1 — from lynxr_creators.data.adaptations (status == "done" only,
    never trash): per platform, how many scripts have a stored view count,
    how many of those were measured within the last 8 days, and how many
    distinct videos (by canon_url) that platform accounts for.

    Table 2 — from lynxr_sources: per platform, row count, how many carry a
    views value, how many have never been measured (metrics_at IS NULL).

    An Apify spend line, read from Apify's own account ledger, only when
    APIFY_API_TOKEN resolves. The token itself is never printed.

USAGE
    ./venv/bin/python tools/views_coverage.py
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import envcfg  # noqa: E402
from process_adaptations import platform_of, canon_url, load_env, SB_URL, SSL_CTX  # noqa: E402

PLATFORMS = ("tiktok", "instagram", "youtube", "facebook")


def get(key, path, timeout=60):
    req = urllib.request.Request(SB_URL + path, method="GET")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        data = r.read()
    return json.loads(data) if data else None


def _parses_within(iso, hours):
    if not iso:
        return False
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return False
    return (datetime.now(timezone.utc) - dt).total_seconds() <= hours * 3600


def table1(key):
    rows = get(key, "/rest/v1/lynxr_creators?select=id,data") or []
    scripts = {p: 0 for p in PLATFORMS}
    scripts["other"] = 0
    with_count = {p: 0 for p in PLATFORMS}
    with_count["other"] = 0
    fresh = {p: 0 for p in PLATFORMS}
    fresh["other"] = 0
    distinct = {p: set() for p in PLATFORMS}
    distinct["other"] = set()

    for row in rows:
        data = row.get("data") or {}
        for a in data.get("adaptations") or []:
            if a.get("status") != "done":
                continue
            url = a.get("sourceUrl") or ""
            plat = platform_of(url)
            if plat not in scripts:
                plat = "other"
            scripts[plat] += 1
            distinct[plat].add(canon_url(url))
            meta = ((a.get("source") or {}).get("meta") or {})
            if meta.get("views") is not None:
                with_count[plat] += 1
            if _parses_within(meta.get("metricsAt"), 8 * 24):
                fresh[plat] += 1

    print("| platform | scripts | with a view count | measured ≤8d | older or undated |")
    print("|---|---|---|---|---|")
    for p in PLATFORMS:
        n = scripts[p]
        if n == 0:
            print(f"| {p} | 0 | — | — | — |")
        else:
            older = n - fresh[p]
            print(f"| {p} | {n} | {with_count[p]} | {fresh[p]} | {older} |")
    if scripts["other"]:
        n = scripts["other"]
        older = n - fresh["other"]
        print(f"| other | {n} | {with_count['other']} | {fresh['other']} | {older} |")

    print()
    for p in list(PLATFORMS) + (["other"] if scripts["other"] else []):
        print(f"distinct videos ({p}): {len(distinct[p])}")


def table2(key):
    rows = get(key, "/rest/v1/lynxr_sources?select=platform,views,metrics_at") or []
    counts = {}
    for row in rows:
        p = row.get("platform") or "(none)"
        c = counts.setdefault(p, {"rows": 0, "with_views": 0, "metrics_null": 0})
        c["rows"] += 1
        if row.get("views") is not None:
            c["with_views"] += 1
        if row.get("metrics_at") is None:
            c["metrics_null"] += 1

    print()
    print("| platform | rows | with views | metrics_at null |")
    print("|---|---|---|---|")
    for p in sorted(counts):
        c = counts[p]
        print(f"| {p} | {c['rows']} | {c['with_views']} | {c['metrics_null']} |")


def apify_line(key):
    env = load_env(ROOT / ".env")
    try:
        token = envcfg.secret("APIFY_API_TOKEN", os.environ.get("APIFY_API_TOKEN"),
                              env.get("APIFY_API_TOKEN"))
    except ValueError as e:
        print(f"\napify: unavailable ({str(e)[:60]})")
        return
    if not token:
        return
    try:
        req = urllib.request.Request("https://api.apify.com/v2/users/me/limits")
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as r:
            d = json.loads(r.read()).get("data") or {}
        current = float((d.get("current") or {}).get("monthlyUsageUsd") or 0)
        limits = d.get("limits") or {}
        cap = limits.get("maxMonthlyUsageUsd")
        cycle = d.get("monthlyUsageCycle") or {}
        start = str(cycle.get("startAt") or "")[:10]
        end = str(cycle.get("endAt") or "")[:10]
        print(f"\napify: ${current:.4f} of ${cap} this cycle ({start} → {end})")
    except Exception as e:  # noqa: BLE001
        print(f"\napify: unavailable ({str(e)[:60]})")


def main():
    env = load_env(ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY",
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"),
                            env.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (source the .env first)")

    table1(key)
    table2(key)
    apify_line(key)


if __name__ == "__main__":
    main()
