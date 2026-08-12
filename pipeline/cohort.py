#!/usr/bin/env python3
"""Who signed up, who actually used it, and what they said.

The point of a 5-10 creator test is learning where people stall, and that is
invisible from inside the app: a creator who signs up and never sends a link
looks identical to one who never signed up. This joins auth.users against
lynxr_creators and lynxr_feedback so the drop-off is on one screen.

Read-only. Run:  ./venv/bin/python pipeline/cohort.py
"""
import json
import os
import pathlib
import ssl
import urllib.request
from datetime import datetime, timezone

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

ROOT = pathlib.Path(__file__).parent.parent
SB = "https://esakjfogplfszievvabi.supabase.co"


def env(name):
    v = os.environ.get(name)
    if v:
        return v
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, val = line.split("=", 1)
            if k.strip() == name:
                return val.strip().strip('"').strip("'")
    raise SystemExit(f"{name} not set")


KEY = env("SUPABASE_SERVICE_ROLE_KEY")


def get(path):
    r = urllib.request.Request(SB + path)
    r.add_header("apikey", KEY)
    r.add_header("Authorization", f"Bearer {KEY}")
    with urllib.request.urlopen(r, timeout=60, context=CTX) as resp:
        return json.loads(resp.read() or "[]")


def ago(iso):
    if not iso:
        return "never"
    t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    h = (datetime.now(timezone.utc) - t).total_seconds() / 3600
    return f"{h:.0f}h ago" if h < 48 else f"{h/24:.0f}d ago"


users = get("/auth/v1/admin/users?per_page=200").get("users", [])
rows = {r["id"]: (r.get("data") or {}) for r in get("/rest/v1/lynxr_creators?select=id,data")}
feedback = get("/rest/v1/lynxr_feedback?select=creator_id,kind,message,created_at&order=created_at.desc")
staff = {s["id"] for s in get("/rest/v1/lynxr_staff?select=id")}

print(f"\n{'ACCOUNT':34} {'SIGNED UP':>10} {'LAST IN':>9}  BRANDS  SENT  SCRIPTS  STATE")
print("-" * 96)

stalled = []
for u in sorted(users, key=lambda x: x.get("created_at") or ""):
    if u["id"] in staff:
        continue                       # staff are not part of the cohort
    d = rows.get(u["id"], {})
    brands = len(d.get("brands") or [])
    sent = len(d.get("library") or [])
    scripts = len(d.get("adaptations") or [])
    done = sum(1 for a in d.get("adaptations") or [] if a.get("status") == "done")

    # Name the wall they hit, not just the counts.
    if not d:
        state = "never opened the app"
    elif not brands:
        state = "no brand yet"
    elif not sent:
        state = "brand, but never sent a link"
    elif not done:
        state = "waiting on first script"
    else:
        state = f"{done}/{scripts} scripts ready"
    if state != f"{done}/{scripts} scripts ready":
        stalled.append((u.get("email"), state))

    print(f"{(u.get('email') or '?'):34} {ago(u.get('created_at')):>10} "
          f"{ago(u.get('last_sign_in_at')):>9}  {brands:^6} {sent:^5} {scripts:^7}  {state}")

print(f"\n  cohort: {len([u for u in users if u['id'] not in staff])} accounts, {len(stalled)} stalled")
for email, why in stalled:
    print(f"    - {email}: {why}")

if feedback:
    print(f"\nFEEDBACK ({len(feedback)})")
    print("-" * 96)
    for f in feedback:
        print(f"  {f['created_at'][:16]}  [{f.get('kind')}]  {(f.get('message') or '')[:70]}")
else:
    print("\n  no feedback submitted yet")
print()
