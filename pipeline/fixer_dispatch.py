"""Hand a newly opened paging alarm to the fixer agent: one workflow_dispatch of
.github/workflows/fixer.yml per alarm episode.

Called from watchdog.run_once() through watchdog._fixer_hook(). It is INERT
unless FIXER_DISPATCH_TOKEN and FIXER_ENABLED=1 are both in the environment,
which only the two GitHub callers set (adaptations.yml's fallback loop and
latency-watch.yml, each with its own GITHUB_TOKEN): on Fly it returns
"disabled" with no network call and no database read.

The state lives in the lynxr_ops row `fixer.dispatched`:
  sent    {alarm_key: opened_at} for the episodes already handed over, so one
          episode is dispatched once (a new episode of the same key has a new
          opened_at). Closed episodes drop out.
  ledger  ISO times of recent dispatches; at most MAX_PER_HOUR in any hour.
The kill switch is the lynxr_ops row `fixer.pause` ({"off": true} or
{"until": <iso>}); fixer.py imports `paused` from here so there is one copy.

Side-effect-free at import, and it must never import watchdog or fixer: watchdog
imports THIS lazily inside _fixer_hook, and fixer imports both.
"""

import copy
import json
import os
import re
import urllib.request
from datetime import datetime, timezone

DISPATCH_KEY = "fixer.dispatched"
PAUSE_KEY = "fixer.pause"
SKIP = {"selftest", "ci-unverified", "watchdog-blind"}
MAX_PER_HOUR = 6
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
API = "https://api.github.com/repos/{repo}/actions/workflows/fixer.yml/dispatches"


def _parse(v):
    """An aware datetime from an ISO string, or None for anything else (the
    same rules as watchdog._parse_iso, re-implemented: no circular import)."""
    if not isinstance(v, str) or not v:
        return None
    try:
        d = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def paused(v, now):
    """True when `v` (the value of the fixer.pause row, or None) is a dict with
    a truthy "off" or an "until" later than `now`. False for anything else,
    malformed input included."""
    if not isinstance(v, dict):
        return False
    if v.get("off"):
        return True
    until = _parse(v.get("until"))
    return until is not None and until > now


def due(paging_keys, latches, state, now):
    """(keys, new_state): the alarm keys to hand over this tick.

    `latches` is {alarm_key: opened_at_iso}; `state` is the fixer.dispatched
    value or {}. One dispatch handles every open incident, so when it goes out
    ALL due keys are marked sent."""
    st = copy.deepcopy(state) if isinstance(state, dict) else {}
    prev_sent = st.get("sent") if isinstance(st.get("sent"), dict) else {}
    sent = {k: v for k, v in prev_sent.items() if k in paging_keys}   # closed episodes drop out
    ledger = []
    for t in (st.get("ledger") if isinstance(st.get("ledger"), list) else []):
        d = _parse(t)
        if d is not None and 0 <= (now - d).total_seconds() < 3600:
            ledger.append(t)
    keys = [k for k in sorted(paging_keys)
            if k not in SKIP and (latches or {}).get(k) and sent.get(k) != latches[k]]
    if keys and len(ledger) < MAX_PER_HOUR:
        for k in keys:
            sent[k] = latches[k]
        ledger.append(_iso(now))
        return keys, {"sent": sent, "ledger": ledger}
    return [], {"sent": sent, "ledger": ledger}


def maybe_dispatch(key, paging_keys, ops_get, ops_put, now, env=None, urlopen=None, ssl_ctx=None):
    """Dispatch fixer.yml once per newly opened paging alarm episode. Returns
    "disabled" | "paused" | "none" | "sent:<key>" | "error:<80 chars>". Never raises."""
    try:
        env = os.environ if env is None else env
        urlopen = urlopen or urllib.request.urlopen
        token = env.get("FIXER_DISPATCH_TOKEN")
        if not token or env.get("FIXER_ENABLED") != "1":
            return "disabled"
        if paused((ops_get(key, PAUSE_KEY) or {}).get("value"), now):
            return "paused"
        latches = {k: ((ops_get(key, f"alarm.{k}") or {}).get("value") or {}).get("opened_at")
                   for k in paging_keys if k not in SKIP}
        state = (ops_get(key, DISPATCH_KEY) or {}).get("value") or {}
        keys, new = due(paging_keys, latches, state, now)
        if not keys:
            if new != state:
                ops_put(key, DISPATCH_KEY, new)
            return "none"
        repo = env.get("GITHUB_REPOSITORY") or "lynxrio/lynxr"
        if not REPO_RE.match(repo):
            return "error:bad repo"
        body = {"ref": "main", "inputs": {"incident": keys[0], "source": env.get("FIXER_SOURCE") or "watchdog"}}
        req = urllib.request.Request(API.format(repo=repo), method="POST", data=json.dumps(body).encode())
        for h, v in (("Authorization", f"Bearer {token}"), ("Accept", "application/vnd.github+json"),
                     ("X-GitHub-Api-Version", "2022-11-28"), ("Content-Type", "application/json")):
            req.add_header(h, v)
        try:
            resp = urlopen(req, timeout=10, context=ssl_ctx)
            status = getattr(resp, "status", None) or (resp.getcode() if hasattr(resp, "getcode") else 204)
            if not 200 <= int(status) < 300:
                raise RuntimeError(f"HTTP {status}")
        except Exception as e:  # noqa: BLE001
            # Retry on a later tick: forget that these keys were sent, but KEEP the
            # ledger entry (that is the rate limit).
            for k in keys:
                new["sent"].pop(k, None)
            ops_put(key, DISPATCH_KEY, new)
            return "error:" + (type(e).__name__ + " " + str(e))[:80]
        ops_put(key, DISPATCH_KEY, new)
        return f"sent:{keys[0]}"
    except Exception as e:  # noqa: BLE001
        return "error:" + str(e)[:80]
