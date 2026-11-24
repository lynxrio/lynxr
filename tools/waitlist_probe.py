#!/usr/bin/env python3
"""Live probe for the waitlist queue (plan: ~/.claude/plans/waitlist-referral-queue.md and its deltas
~/.claude/plans/waitlist-beli-referrals.md and ~/.claude/plans/waitlist-no-confirm.md, supabase/waitlist_queue.sql,
supabase/functions/waitlist). Reading the SQL is
not evidence (HANDOFF.md): this talks to the live project exactly as a browser does, with the PUBLIC publishable key, and
says what a stranger can and cannot do.

    ./venv/bin/python tools/waitlist_probe.py                 # anonymous; WRITES NOTHING you would keep (see below)
    ./venv/bin/python tools/waitlist_probe.py --join          # sends up to 2 Resend TEST mails (the welcome email)
    ./venv/bin/python tools/waitlist_probe.py --staff EMAIL   # a staff account (password asked with getpass): the
                                                              # stats RPC and a DRY release, which writes and sends nothing
    ./venv/bin/python tools/waitlist_probe.py --gate          # only when sign-up is closed: a stranger is refused
    ./venv/bin/python tools/waitlist_probe.py --gifts EMAIL   # any signed-in account (password asked with getpass): its
                                                              # own invite counts, and that RLS shows only its own
                                                              # lynxr_members row. Makes the account's invite link if it
                                                              # has none, as opening Invite friends in the app does;
                                                              # nothing is sent

Default mode, what it does and does not touch:
  * every RPC is called with input that cannot write even if the call were wrongly allowed (a malformed email, an unknown
    token, a dry run), so a failed lock shows up as a FAIL instead of a junk row;
  * the one direct INSERT into lynxr_waitlist is attempted ONLY once supabase/waitlist_queue.sql is installed (before
    that the old policy still lets anon insert, and a probe must not write to the live list);
  * the function's `spot` call with a random token bumps one hashed-IP counter that expires in two days.
Before supabase/waitlist_queue.sql is run (plan step 2) and the function deployed (step 5) the checks that need them print
SKIP, and the run exits 2: "nothing was wrong, and nothing was proven". Exit 0 = every check ran and passed; 1 = a FAIL.

Passwords are read with getpass and never stored, printed or written. Nothing is written to disk.
"""
import argparse
import getpass
import json
import re
import secrets
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

# This venv's Python has no system CA bundle, so a bare urlopen fails every request with CERTIFICATE_VERIFY_FAILED.
# Same guard tools/cm_probe.py and the pipeline use.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

SB_URL = "https://esakjfogplfszievvabi.supabase.co"
SB_KEY = "sb_publishable_pTFNX2B94PE_DFLL799w4A_4VcH2xTN"   # public by design: the key home.js and creator.js ship
FN_URL = f"{SB_URL}/functions/v1/waitlist"
SITE = "https://lynxr.io"
PROBE_DOMAIN = "example.invalid"   # never a real inbox, and no lynxr account can ever have it
GIFT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # the invite-code alphabet (no I, O, 0, 1); gift codes use it too
GIFT_CODE_RE = re.compile(r"^[A-HJ-NP-Z2-9]{8}$")
FAILS = []
SKIPS = []


def call(method, path, token=None, body=None, prefer=None, headers=None, raw=None, url=None):
    """(status, parsed JSON or None, text). Never raises on an HTTP error status."""
    h = {"apikey": SB_KEY, "Authorization": f"Bearer {token or SB_KEY}"}
    data = None
    if raw is not None:
        data = raw.encode()
    elif body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    if prefer:
        h["Prefer"] = prefer
    if headers:
        h.update(headers)
    req = urllib.request.Request(url or (SB_URL + path), data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as res:
            status, text = res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode("utf-8", "replace")
    try:
        parsed = json.loads(text) if text else None
    except ValueError:
        parsed = None
    return status, parsed, text


def fn_call(body, origin=SITE, auth=None):
    """POST to the waitlist function as the landing page does: text/plain, no apikey, an Origin. No Origin if None."""
    h = {"Content-Type": "text/plain;charset=UTF-8"}
    if origin:
        h["Origin"] = origin
    if auth:
        h["Authorization"] = f"Bearer {auth}"
    # Not through call(): that adds apikey and a Supabase Authorization header, which the page never sends here.
    req = urllib.request.Request(FN_URL, data=json.dumps(body).encode(), method="POST", headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as res:
            status, text = res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode("utf-8", "replace")
    try:
        parsed = json.loads(text) if text else None
    except ValueError:
        parsed = None
    return status, parsed, text


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"\n        got: {str(detail)[:300]}"))
    if not ok:
        FAILS.append(name)


def skip(name, why):
    print(f"SKIP  {name}: {why}")
    SKIPS.append(name)


def refused(status, text):
    """PostgREST answers a privilege refusal 401/403 (42501)."""
    return status in (401, 403) or "42501" in text or "permission denied" in text or "row-level security" in text


def missing(status, text):
    """PostgREST: a function or table that is not in the schema cache (PGRST202 / PGRST205), or the function URL itself 404."""
    return status == 404 or "PGRST202" in text or "PGRST205" in text


def fn_deployed(status, text):
    """The Supabase gateway answers 404 NOT_FOUND for an Edge Function that was never deployed."""
    return not (status == 404 and ("NOT_FOUND" in text or "not found" in text.lower()))


# ── anonymous: what a stranger with the publishable key can reach ─────────────────────────────────────────────────
def rpc_closed(label, fn, body):
    """An RPC an anonymous caller must not reach. Refused, or answering null, is a PASS; installed-and-answering is a FAIL."""
    status, js, text = call("POST", f"/rest/v1/rpc/{fn}", body=body)
    if missing(status, text):
        skip(f"anon {label}", "not installed yet (expected before supabase/waitlist_queue.sql)")
        return False
    check(f"anon {label}: refused (or null)", refused(status, text) or (status == 200 and js is None), f"HTTP {status} {text[:160]}")
    return True


def run_anon():
    status, js, text = call("POST", "/rest/v1/rpc/signup_state", body={})
    print(f"INFO  signup_state(): {text.strip()[:120] if status == 200 else f'HTTP {status}'}")
    gate_closed = status == 200 and isinstance(js, dict) and js.get("invite_required") is True
    print(f"INFO  public sign-up is {'CLOSED (invite required)' if gate_closed else 'OPEN'}")

    status, js, text = call("GET", "/rest/v1/lynxr_waitlist?select=email&limit=1")
    check("anon GET lynxr_waitlist: not a 200 with rows", not (status == 200 and isinstance(js, list) and js), f"HTTP {status} {text[:160]}")

    status, js, text = call("GET", "/rest/v1/lynxr_waitlist_settings?select=*&limit=1")
    installed = not missing(status, text)
    if installed:
        check("anon GET lynxr_waitlist_settings: no rows", (status == 200 and js == []) or refused(status, text), f"HTTP {status} {text[:160]}")
        status, js, text = call("GET", "/rest/v1/lynxr_waitlist_meter?select=*&limit=1")
        check("anon GET lynxr_waitlist_meter: no rows", (status == 200 and js == []) or refused(status, text), f"HTTP {status} {text[:160]}")
    else:
        skip("anon lynxr_waitlist_settings / lynxr_waitlist_meter", "not installed yet (expected before supabase/waitlist_queue.sql)")

    if installed:
        addr = f"wl-probe-{uuid.uuid4().hex[:8]}@{PROBE_DOMAIN}"
        status, _, text = call("POST", "/rest/v1/lynxr_waitlist", body={"email": addr, "source": "probe"}, prefer="return=minimal")
        check("anon POST lynxr_waitlist: refused", refused(status, text) and status not in (200, 201, 204), f"HTTP {status} {text[:160]}")
        if status in (200, 201, 204):
            print(f"      a probe row was written. Clean up:  delete from public.lynxr_waitlist where email like 'wl-probe-%@{PROBE_DOMAIN}';")
    else:
        skip("anon POST lynxr_waitlist", "not tried: until waitlist_queue.sql runs the old policy lets anon insert, and this probe must not write the live list")

    # Inputs that cannot write even if the call were wrongly allowed: a malformed email, an unknown token, a dry run.
    rpc_closed("waitlist_join", "waitlist_join", {"p_email": "probe", "p_ref": "", "p_source": "probe", "p_consent": ""})
    rpc_closed("waitlist_spot", "waitlist_spot", {"p_token": uuid.uuid4().hex, "p_confirm": None})
    rpc_closed("waitlist_release (dry)", "waitlist_release", {"p_n": 3, "p_dry": True})
    rpc_closed("lynxr_signup_verdict", "lynxr_signup_verdict", {"p_email": f"wl-probe@{PROBE_DOMAIN}", "p_provider": "email", "p_code": ""})
    rpc_closed("staff_waitlist_stats", "staff_waitlist_stats", {})
    # The gift / crew layer (waitlist_beli_referrals). Same rule: input that cannot write even if the call were wrongly
    # allowed (a code no one holds, a malformed address, a random uuid that is not an account).
    rpc_closed("waitlist_gift_claim", "waitlist_gift_claim", {"p_code": "ZZZZZZZZ", "p_email": "probe"})
    rpc_closed("waitlist_gift_peek", "waitlist_gift_peek", {"p_code": "ZZZZZZZZ"})
    rpc_closed("waitlist_gift_mark", "waitlist_gift_mark", {"p_email": "probe"})
    rpc_closed("lynxr_link_account", "lynxr_link_account", {"p_uid": str(uuid.uuid4()), "p_email": f"wl-probe@{PROBE_DOMAIN}"})
    rpc_closed("my_gifts", "my_gifts", {})
    # The no-confirmation layer (waitlist_no_confirm, 2026-11-21): six more server-only functions, each with input that cannot
    # write even if the call were wrongly allowed (an address nobody has, a random token, a code no one holds).
    rpc_closed("lynxr_wl_credit_friend", "lynxr_wl_credit_friend", {"p_email": f"wl-probe@{PROBE_DOMAIN}"})
    rpc_closed("lynxr_wl_uncredit", "lynxr_wl_uncredit", {"p_email": f"wl-probe@{PROBE_DOMAIN}"})
    rpc_closed("waitlist_strip", "waitlist_strip", {"p_referrer": f"wl-probe@{PROBE_DOMAIN}", "p_scope": "unseen", "p_drop": False})
    rpc_closed("waitlist_set_name", "waitlist_set_name", {"p_token": uuid.uuid4().hex, "p_name": "Probe"})
    rpc_closed("waitlist_ref_name", "waitlist_ref_name", {"p_code": "ZZZZZZZZ"})
    rpc_closed("lynxr_wl_from_confirm", "lynxr_wl_from_confirm", {})
    for table in ("lynxr_members", "lynxr_gift_claims", "lynxr_crew"):
        status, js, text = call("GET", f"/rest/v1/{table}?select=*&limit=1")
        if missing(status, text):
            skip(f"anon GET {table}", "not installed yet (expected before supabase/waitlist_queue.sql)")
        else:
            check(f"anon GET {table}: no rows", (status == 200 and js == []) or refused(status, text), f"HTTP {status} {text[:160]}")

    # The function, as the landing page calls it.
    status, js, text = fn_call({"action": "spot", "token": uuid.uuid4().hex})
    if not fn_deployed(status, text):
        skip("function spot with a random token", "the waitlist function is not deployed yet (plan step 5)")
        skip("function foreign Origin", "the waitlist function is not deployed yet (plan step 5)")
    else:
        check("function: spot with a random token -> {state:'none'}", status == 200 and isinstance(js, dict) and js.get("state") == "none", f"HTTP {status} {text[:160]}")
        status, _, text = fn_call({"action": "join", "email": "probe"}, origin="https://evil.example")
        check("function: a foreign Origin -> 403", status == 403, f"HTTP {status} {text[:160]}")
        # The gift actions. An older deployed function answers 400 unknown_action: not a failure, but nothing is proven.
        code = "".join(secrets.choice(GIFT_ALPHABET) for _ in range(8))
        status, js, text = fn_call({"action": "gift_peek", "code": code})
        if status == 400 and "unknown_action" in text:
            skip("function gift_peek / gift", "the deployed function predates the gift actions (redeploy supabase/functions/waitlist)")
        else:
            check("function: gift_peek with a random code -> {state:'none'} (or 'open' while sign-up is open), nothing else",
                  status == 200 and isinstance(js, dict) and set(js) == {"state"} and js.get("state") in ("none", "open"), f"HTTP {status} {text[:160]}")
            status, js, text = fn_call({"action": "gift", "code": code, "email": "probe"})
            check("function: gift with a malformed email -> {status:'bad_email'} and nothing is written",
                  status == 200 and isinstance(js, dict) and js == {"status": "bad_email"}, f"HTTP {status} {text[:160]}")
        # The invite-name actions. An older deployed function answers 400 unknown_action: not a failure, nothing proven.
        status, js, text = fn_call({"action": "ref_peek", "code": code})
        if status == 400 and "unknown_action" in text:
            skip("function ref_peek / name", "the deployed function predates the invite-name actions (redeploy supabase/functions/waitlist)")
        else:
            check("function: ref_peek with a code no one holds -> exactly {} (no name, nothing else)",
                  status == 200 and js == {}, f"HTTP {status} {text[:160]}")
            status, js, text = fn_call({"action": "name", "token": uuid.uuid4().hex, "name": "Probe"})
            check("function: name with a random token -> {ok:false} and nothing is written",
                  status == 200 and js == {"ok": False}, f"HTTP {status} {text[:160]}")


# ── --join: two real calls to the function (Resend test sink) ─────────────────────────────────────────────────────
def run_join():
    print("--join sends the welcome email to a Resend TEST address (delivered+...@resend.dev) and then joins the same")
    print("address again. That is at most 2 emails, counted against today's Resend quota, and one waitlist row you delete after.")
    if input("type yes to send: ").strip().lower() != "yes":
        print("not sent")
        return
    label = uuid.uuid4().hex[:8]
    addr = f"delivered+wlprobe-{label}@resend.dev"
    status, js, text = fn_call({"action": "join", "email": addr, "source": "probe", "consent": "waitlist-queue-v3"})
    if not fn_deployed(status, text):
        check("function: join", False, "the waitlist function is not deployed (plan step 5)")
        return
    allowed = {"status", "position", "ref_code", "mailed", "batch_size", "places", "token"}
    check("join -> new, with a position", status == 200 and isinstance(js, dict) and js.get("status") == "new" and isinstance(js.get("position"), int), f"HTTP {status} {text[:200]}")
    check("join answers only the allowed keys", isinstance(js, dict) and set(js) == allowed, text[:200])
    # The one token that may leave: the new entry's own, to the browser whose request created it. Nothing else of that shape.
    tokens = re.findall(r"[0-9a-f]{32}", text)
    check("join answer holds exactly one 32-hex value (the entry's own token), no address and no invite code",
          isinstance(js, dict) and len(tokens) == 1 and js.get("token") == tokens[0] and "@" not in text and "resend.dev" not in text, text[:200])
    status, js, text = fn_call({"action": "join", "email": addr, "source": "probe", "consent": "waitlist-queue-v3"})
    check("join again -> exists, only status + mailed",
          status == 200 and isinstance(js, dict) and set(js) == {"status", "mailed"} and js.get("status") == "exists", f"HTTP {status} {text[:200]}")
    check("the exists answer holds no token at all (typing someone's address must not hand over their page)", not re.search(r"[0-9a-f]{32}", text), text[:200])
    print("      Clean up the probe row in the SQL editor:")
    print("        delete from public.lynxr_waitlist where email like 'delivered+wlprobe-%@resend.dev';")


# ── --staff ───────────────────────────────────────────────────────────────────────────────────────────────────────
def sign_in(email):
    """(access token, user id) for a password the operator types. Exits 2 when it does not work. Never stored or printed."""
    pw = getpass.getpass(f"password for {email}: ")
    status, js, _ = call("POST", "/auth/v1/token?grant_type=password", body={"email": email, "password": pw})
    if status != 200 or not isinstance(js, dict) or "access_token" not in js:
        print(f"could not sign in as {email} (HTTP {status})")
        sys.exit(2)
    return js["access_token"], (js.get("user") or {}).get("id")


def run_staff(email):
    token, _ = sign_in(email)
    status, js, text = call("POST", "/rest/v1/rpc/staff_waitlist_stats", token, body={})
    if missing(status, text):
        check("staff: staff_waitlist_stats", False, "not installed (plan step 2)")
    else:
        want = {"waiting", "referred", "unseen", "released", "joined", "left", "unmailed", "pending_mail", "last_batch", "last_batch_at", "batch_size", "places",
                "gifted", "gift_joined"}
        if status == 200 and isinstance(js, dict) and "unconfirmed" in js and "referred" not in js:
            skip("staff: staff_waitlist_stats referred / unseen", "supabase/waitlist_queue.sql has not been re-run since the no-confirmation revision (it still answers unconfirmed)")
        else:
            check("staff: staff_waitlist_stats returns the numbers", status == 200 and isinstance(js, dict) and want <= set(js), f"HTTP {status} {text[:200]}")
        if isinstance(js, dict):
            print(f"INFO  waiting {js.get('waiting')}, from friends {js.get('referred')}, never opened {js.get('unseen')}, let in {js.get('released')}, "
                  f"made an account {js.get('joined')}, left {js.get('left')}, batch {js.get('batch_size')}, places {js.get('places')}, "
                  f"gifts claimed {js.get('gifted')}, joined from a gift {js.get('gift_joined')}")
    status, js, text = fn_call({"action": "release", "n": 3, "dry": True}, auth=token)
    if not fn_deployed(status, text):
        check("staff: function release (dry)", False, "the waitlist function is not deployed (plan step 5)")
    else:
        check("staff: a dry release answers {batch, count} and sends nothing", status == 200 and isinstance(js, dict) and set(js) == {"batch", "count"}, f"HTTP {status} {text[:200]}")
    status, _, text = fn_call({"action": "release", "n": 3, "dry": True})
    if fn_deployed(status, text):
        check("function: release with no Authorization -> 401", status == 401, f"HTTP {status} {text[:160]}")


# ── --gifts ───────────────────────────────────────────────────────────────────────────────────────────────────────
def run_gifts(email):
    print("--gifts makes this account's invite link if it has none, exactly as opening Invite friends in the app would.")
    print("Nothing is sent, and no friend's address is read or written. Only counts are printed.")
    token, uid = sign_in(email)
    status, js, text = call("POST", "/rest/v1/rpc/my_gifts", token, body={})
    if missing(status, text):
        check("gifts: my_gifts", False, "not installed (run supabase/waitlist_queue.sql)")
        return
    check("gifts: my_gifts answers an object to a signed-in account", status == 200 and isinstance(js, dict) and "on" in js, f"HTTP {status} {text[:200]}")
    if not isinstance(js, dict) or "on" not in js:
        return
    if js.get("on") is not True:
        print("INFO  invites are off (settings.gifts = 0): my_gifts answered {on: false}")
        return
    total, left = js.get("total"), js.get("left")
    check("gifts: the personal code is 8 characters of the invite alphabet", isinstance(js.get("code"), str) and bool(GIFT_CODE_RE.match(js["code"])), "(code not printed)")
    check("gifts: 0 <= left <= total", isinstance(total, int) and isinstance(left, int) and 0 <= left <= total, f"total {total}, left {left}")
    check("gifts: the answer holds counts only (no friend's address, no token)",
          set(js) <= {"on", "gate_open", "code", "total", "left", "waiting", "joined", "crew", "title"} and "@" not in text, f"keys {sorted(js)}")
    print(f"INFO  on {js.get('on')}, gate_open {js.get('gate_open')}, total {total}, left {left}, waiting {js.get('waiting')}, "
          f"joined {js.get('joined')}, crew {js.get('crew')}, title {js.get('title')}")
    # RLS: a member reads their own lynxr_members row. Staff have a second policy that lets them read all of them, so for a
    # staff account "only my own row" cannot be shown here; for anyone else it must be exactly one row.
    status, rows, text = call("GET", "/rest/v1/lynxr_members?select=id", token)
    stat_status, stat_js, _ = call("POST", "/rest/v1/rpc/staff_waitlist_stats", token, body={})
    is_staff = stat_status == 200 and isinstance(stat_js, dict)
    mine = isinstance(rows, list) and any(isinstance(r, dict) and r.get("id") == uid for r in rows)
    if is_staff:
        check("gifts: the account's own lynxr_members row is readable (staff may read others by design; count not asserted)", status == 200 and mine, f"HTTP {status} {text[:120]}")
        print(f"INFO  staff account: {len(rows) if isinstance(rows, list) else '?'} lynxr_members row(s) visible")
    else:
        check("gifts: exactly one lynxr_members row is visible (own row only)", status == 200 and isinstance(rows, list) and len(rows) == 1 and mine, f"HTTP {status} {text[:120]}")


# ── --gate ────────────────────────────────────────────────────────────────────────────────────────────────────────
def run_gate():
    status, js, _ = call("POST", "/rest/v1/rpc/signup_state", body={})
    if not (status == 200 and isinstance(js, dict) and js.get("invite_required") is True):
        print("gate is open, skipped (sign-up is not closed; this probe never creates an account while it is open)")
        return
    addr = f"wl-probe-{uuid.uuid4().hex[:8]}@{PROBE_DOMAIN}"
    # A throwaway value for an address that cannot exist; the request must be refused before any account is made.
    status, js, text = call("POST", "/auth/v1/signup", body={"email": addr, "password": uuid.uuid4().hex + "Aa1!"})
    check("gate: a stranger's sign-up is refused with 'no invite for this address'",
          status >= 400 and "no invite for this address" in text, f"HTTP {status} {text[:200]}")
    if status < 400:
        print(f"      an account may have been created for {addr}; delete it in Authentication -> Users.")


def main():
    ap = argparse.ArgumentParser(description="Live probe for the waitlist queue. Prints PASS/FAIL/SKIP.")
    ap.add_argument("--join", action="store_true", help="join a Resend test address twice (sends <= 2 test mails)")
    ap.add_argument("--staff", metavar="EMAIL", help="a staff account: stats RPC and a dry release")
    ap.add_argument("--gate", action="store_true", help="only when sign-up is closed: a stranger is refused")
    ap.add_argument("--gifts", metavar="EMAIL", help="a signed-in account: its own invite counts and own-row RLS on lynxr_members")
    a = ap.parse_args()
    run_anon()
    if a.join:
        run_join()
    if a.staff:
        run_staff(a.staff)
    if a.gate:
        run_gate()
    if a.gifts:
        run_gifts(a.gifts)
    if FAILS:
        print(f"\n{len(FAILS)} FAILED: {', '.join(FAILS)}")
        sys.exit(1)
    if SKIPS:
        print(f"\nNO FAILURES, but {len(SKIPS)} check(s) could not run (not installed / not deployed yet): nothing was proven for those.")
        sys.exit(2)
    print("\nALL PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
