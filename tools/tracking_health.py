#!/usr/bin/env python3
"""Read-only post-tracking health: can lynxr read the videos on each verified profile, and is the worker's tracking lane healthy.

WHY THIS EXISTS
    Plan ~/.claude/plans/tracking-always-works.md (2026-10-31). Before that change a quiet Instagram profile, a private account and a
    renamed TikTok username all looked like "the scrape broke", and nothing said so. This is the one place to see the whole picture
    from a terminal, before and after the fix. GET requests only; it must never issue PATCH, POST or DELETE.

WHAT IT PRINTS
    1. Whether lynxr_profiles.scan_state exists yet (supabase/profile_scan_state.sql); if not, a line saying to run it.
    2. One line per platform over the VERIFIED profiles:
           tiktok: 22 verified · 21 ok · 0 private · 1 gone · 0 failing · 0 no state yet · last ok over 48h: 1
       The scan_state counts appear only when the column exists. "last ok over 48h" counts profiles whose last_scan_ok_at is
       missing or older than 48 hours.
    3. With --handles a,b,c: for each username, every verified row with it: platform, handle, scan_state, scan_state_at,
       last_scan_at, last_scan_ok_at, watermark_at. With no row it says so.
    4. lynxr_ops 'track.health': when it was written, apify_ok / apify_why, and one line per lane with its failure streak and the
       number of DISTINCT profiles behind it.

PRIVACY
    Usernames are printed ONLY for the ones passed in --handles. It never prints a key, an email, a creator id or any other uuid.

USAGE
    ./venv/bin/python tools/tracking_health.py
    ./venv/bin/python tools/tracking_health.py --handles name1,name2
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import envcfg  # noqa: E402
from process_adaptations import load_env, SB_URL, SSL_CTX  # noqa: E402

PLATFORMS = ("tiktok", "instagram")
STATES = ("ok", "private", "gone", "failing")


def get(key, path, timeout=60):
    """(status, parsed json or None). GET only. An HTTP error is (code, None); a network error is (0, None)."""
    req = urllib.request.Request(SB_URL + path, method="GET")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
            data = r.read()
            return r.status, (json.loads(data) if data else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:  # noqa: BLE001
        return 0, None


def parse_ts(s):
    """An aware datetime from an ISO timestamp, or None."""
    if not s:
        return None
    try:
        d = datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def ago_txt(s, now):
    d = parse_ts(s)
    if d is None:
        return "never" if not s else str(s)
    h = (now - d).total_seconds() / 3600
    return f"{h:.0f}h ago" if h < 48 else f"{h / 24:.0f}d ago"


def main():
    ap = argparse.ArgumentParser(description="read-only post-tracking health")
    ap.add_argument("--handles", default="", help="comma-separated usernames to list in full (lower-cased, @ stripped)")
    args = ap.parse_args()

    env = load_env(ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", os.environ.get("SUPABASE_SERVICE_ROLE_KEY"),
                            env.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set (source the .env first)")

    now = datetime.now(timezone.utc)
    st, _ = get(key, "/rest/v1/lynxr_profiles?select=scan_state&limit=1")
    has_state = st == 200
    if not has_state:
        print("scan_state: column not there yet (run supabase/profile_scan_state.sql)")

    cols = "platform,handle,status,last_scan_at,last_scan_ok_at,watermark_at" + (",scan_state,scan_state_at" if has_state else "")
    st, rows = get(key, f"/rest/v1/lynxr_profiles?verified_at=not.is.null&select={cols}&limit=1000")
    if st != 200 or not isinstance(rows, list):
        print(f"profiles: not readable (HTTP {st})")
        rows = []

    for plat in PLATFORMS:
        mine = [r for r in rows if r.get("platform") == plat]
        if not mine:
            continue
        stale = sum(1 for r in mine
                    if parse_ts(r.get("last_scan_ok_at")) is None
                    or now - parse_ts(r.get("last_scan_ok_at")) > timedelta(hours=48))
        bits = [f"{len(mine)} verified"]
        if has_state:
            for s in STATES:
                bits.append(f"{sum(1 for r in mine if r.get('scan_state') == s)} {s}")
            bits.append(f"{sum(1 for r in mine if r.get('scan_state') not in STATES)} no state yet")
        bits.append(f"last ok over 48h: {stale}")
        print(f"{plat}: " + " · ".join(bits))

    for h in [x.strip().lower().lstrip("@") for x in args.handles.split(",") if x.strip()]:
        hit = [r for r in rows if str(r.get("handle") or "").lower() == h]
        if not hit:
            print(f"{h}: no verified profile with that username")
            continue
        for r in hit:
            print(" ".join(str(x) for x in (
                r.get("platform"), r.get("handle"), r.get("scan_state") if has_state else "(no scan_state column)",
                r.get("scan_state_at") or "-", r.get("last_scan_at") or "-", r.get("last_scan_ok_at") or "-",
                r.get("watermark_at") or "-")))

    st, ops = get(key, "/rest/v1/lynxr_ops?key=eq.track.health&select=value,updated_at")
    if st != 200 or not isinstance(ops, list) or not ops or not isinstance(ops[0].get("value"), dict):
        print("track.health: not written yet")
        return
    v = ops[0]["value"]
    print(f"track.health at {v.get('at') or ops[0].get('updated_at')} ({ago_txt(v.get('at'), now)})")
    print(f"apify_ok {v.get('apify_ok')} · apify_why {v.get('apify_why')}")
    lanes = v.get("lanes") if isinstance(v.get("lanes"), dict) else {}
    if not lanes:
        print("lanes: none recorded yet")
    for name in sorted(k for k in lanes if isinstance(k, str)):
        ln = lanes[name]
        if not isinstance(ln, dict):
            continue
        keys = ln.get("fail_keys") if isinstance(ln.get("fail_keys"), list) else []
        print(f"{name} streak {ln.get('fail_streak')} across {len({k for k in keys if isinstance(k, str)})} profiles, "
              f"last ok {ago_txt(ln.get('ok_at'), now) if ln.get('ok_at') else 'never'}")


if __name__ == "__main__":
    main()
