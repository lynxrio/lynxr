#!/usr/bin/env python3
"""Live row-level-security probe for the CM portal (plan: ~/.claude/plans/lynxr-cm-portal.md).

Talks to Supabase exactly as a browser does: the PUBLIC publishable key (the same one app.js ships) plus a signed-in
account's own token. Passwords are read with getpass and never stored, printed or written anywhere. Re-run it after any
change to supabase/cm_portal.sql or any agency policy: reading the SQL is not evidence (HANDOFF.md).

    ./venv/bin/python tools/cm_probe.py --plain EMAIL                 # an ordinary creator: sees nothing agency-side
    ./venv/bin/python tools/cm_probe.py --cm EMAIL [--staff EMAIL]    # a test CM; --staff adds the cross-company and
                                                                      # sending checks and cleans up after them

The CM run writes and then deletes: one brief named "cm probe, delete me" on the CM's first company (by id), one
format written from scratch in it, one 4-byte file in its storage folder, and (with --staff) one sent-brief record with
no delivery. It never sends anything to a real creator: the one delivery it tries is one the database must refuse.
Exit status 0 = every check passed.
"""
import argparse
import getpass
import json
import sys
import urllib.error
import urllib.request
import uuid
import ssl

# This venv's Python has no system CA bundle, so a bare urlopen fails every request with
# CERTIFICATE_VERIFY_FAILED (first run, 2026-10-13). Same guard the pipeline uses.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

SB_URL = "https://esakjfogplfszievvabi.supabase.co"
SB_KEY = "sb_publishable_pTFNX2B94PE_DFLL799w4A_4VcH2xTN"   # public by design: the key app.js and creator.js ship
BUCKET = "lynxr-brief-files"
FAILS = []

AGENCY_TABLES = ["lynxr_campaigns", "lynxr_campaign_formats", "lynxr_agency_briefs", "lynxr_agency_deliveries",
                 "lynxr_brief_files", "lynxr_brief_file_beats", "lynxr_cm_clients", "lynxr_cms"]
CLOSED_TABLES = ["lynxr_videos", "lynxr_clients", "lynxr_roster", "lynxr_staff", "lynxr_ops", "lynxr_costs",
                 "lynxr_sources", "lynxr_feedback"]


def call(method, path, token=None, body=None, prefer=None, raw=None, ctype=None):
    """(status, parsed JSON or None, text). Never raises on an HTTP error status."""
    headers = {"apikey": SB_KEY, "Authorization": f"Bearer {token or SB_KEY}"}
    data = None
    if raw is not None:
        data = raw
        headers["Content-Type"] = ctype or "application/octet-stream"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(SB_URL + path, data=data, method=method, headers=headers)
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


def refused(status, text):
    """PostgREST answers an RLS refusal 401/403 (42501); Storage answers 400 with statusCode 403 in the body."""
    return status in (401, 403) or "42501" in text or "row-level security" in text or '"statusCode":"403"' in text


def listed(status, parsed):
    return parsed if status == 200 and isinstance(parsed, list) else None


def sign_in(email):
    pw = getpass.getpass(f"password for {email}: ")
    status, js, _ = call("POST", "/auth/v1/token?grant_type=password", body={"email": email, "password": pw})
    if status != 200 or not isinstance(js, dict) or "access_token" not in js:
        print(f"could not sign in as {email} (HTTP {status})")
        sys.exit(2)
    return js["access_token"], js["user"]["id"]


def reads_nothing(token, table):
    status, js, text = call("GET", f"/rest/v1/{table}?select=*&limit=3", token)
    # 404 = the table is not installed on this project, which also means there is nothing to read
    check(f"{table}: 0 rows", (status == 200 and js == []) or status == 404, f"HTTP {status} {text[:160]}")


def run_plain(email):
    token, _ = sign_in(email)
    status, roles, _ = call("POST", "/rest/v1/rpc/my_roles", token, body={})
    check("my_roles: neither staff nor CM", status == 200 and isinstance(roles, dict)
          and roles.get("staff") is False and roles.get("cm") is False, roles)
    for t in AGENCY_TABLES + CLOSED_TABLES:
        reads_nothing(token, t)
    for fn in ("cm_clients", "cm_roster"):
        status, js, _ = call("POST", f"/rest/v1/rpc/{fn}", token, body={})
        check(f"{fn}: empty", status == 200 and js == [], f"HTTP {status} {js}")
    status, _, text = call("POST", "/rest/v1/lynxr_campaigns", token,
                           body={"client_id": "probe-" + uuid.uuid4().hex[:8], "name": "probe"})
    check("cannot create a brief", refused(status, text), f"HTTP {status} {text[:160]}")
    status, js, _ = call("POST", "/rest/v1/rpc/staff_add_cm", token, body={"p_email": email})
    check("cannot tag anyone a CM", status == 200 and isinstance(js, dict) and js.get("ok") is False, js)


def cross_company(token, stoken, uid, ids, pid, company, crew):
    status, allc, _ = call("GET", "/rest/v1/lynxr_campaigns?select=id,client_id,name", stoken)
    other = next((c for c in listed(status, allc) or [] if c["client_id"] not in ids), None)
    if not other:
        print("note: no brief exists on a company this CM is not on, so the cross-company checks could not run")
    else:
        status, js, _ = call("GET", f"/rest/v1/lynxr_campaigns?id=eq.{other['id']}&select=id", token)
        check("cannot read another company's brief", status == 200 and js == [], js)
        status, js, _ = call("GET", f"/rest/v1/lynxr_campaign_formats?campaign_id=eq.{other['id']}&select=id", token)
        check("cannot read another company's formats", status == 200 and js == [], js)
        # a no-op write: if the policy were open it would only rewrite the same name
        status, js, text = call("PATCH", f"/rest/v1/lynxr_campaigns?id=eq.{other['id']}&select=id", token,
                                prefer="return=representation", body={"name": other["name"]})
        check("cannot edit another company's brief", (status == 200 and js == []) or refused(status, text),
              f"HTTP {status} {text[:160]}")
        opath = f"campaign/{other['id']}/probe-{uuid.uuid4().hex[:8]}/probe.png"
        status, _, text = call("POST", f"/storage/v1/object/{BUCKET}/{opath}", token, raw=b"\x89PNG", ctype="image/png")
        check("cannot upload into another company's brief", status != 200, f"HTTP {status} {text[:160]}")
        if status == 200:
            call("DELETE", f"/storage/v1/object/{BUCKET}/{opath}", stoken)   # undo the hole this just proved
    status, roster, _ = call("GET", "/rest/v1/lynxr_roster?select=creator_id,status&status=eq.accepted", stoken)
    mine = {r["creator_id"] for r in crew if company in (r.get("client_ids") or [])}
    outsider = next((r for r in listed(status, roster) or []
                     if r.get("creator_id") and r["creator_id"] not in mine), None)
    status, js, text = call("POST", "/rest/v1/lynxr_agency_briefs?select=id", token, prefer="return=representation",
                            body={"client_name": "probe", "title": "cm probe, delete me", "source_kind": "campaign",
                                  "source_id": pid, "sent_by": uid, "doc": {"v": 1, "title": "probe", "formats": []}})
    bid = js[0]["id"] if status == 201 and isinstance(js, list) and js else None
    check("can record a send for my own brief", bid is not None, f"HTTP {status} {text[:160]}")
    if not bid:
        return
    try:
        if outsider:
            status, _, text = call("POST", "/rest/v1/lynxr_agency_deliveries", token,
                                   body={"brief_id": bid, "creator_id": outsider["creator_id"]})
            check("cannot send to a creator who is not on this company", refused(status, text),
                  f"HTTP {status} {text[:160]}")
        else:
            print("note: every accepted roster creator is on this company, so the refused-send check could not run")
    finally:
        call("DELETE", f"/rest/v1/lynxr_agency_briefs?id=eq.{bid}", stoken)   # staff clean-up; deliveries cascade


def run_cm(email, staff_email):
    token, uid = sign_in(email)
    stoken = sign_in(staff_email)[0] if staff_email else None

    status, roles, _ = call("POST", "/rest/v1/rpc/my_roles", token, body={})
    check("my_roles: a CM, not staff", status == 200 and isinstance(roles, dict)
          and roles.get("cm") is True and roles.get("staff") is False, roles)
    status, mine, _ = call("POST", "/rest/v1/rpc/cm_clients", token, body={})
    mine = listed(status, mine) or []
    ids = {c.get("id") for c in mine}
    check("cm_clients: at least one company (assign one first)", bool(ids), f"HTTP {status}")
    if not ids:
        return
    check("cm_clients: only id, company, niche, ctx",
          all(set(c) == {"id", "company", "niche", "ctx"} for c in mine), [sorted(c) for c in mine])
    for t in CLOSED_TABLES:
        reads_nothing(token, t)

    status, camps, _ = call("GET", "/rest/v1/lynxr_campaigns?select=id,client_id", token)
    camps = listed(status, camps)
    check("briefs: readable", camps is not None, f"HTTP {status}")
    camps = camps or []
    check("briefs: only my companies'", all(c["client_id"] in ids for c in camps),
          sorted({c["client_id"] for c in camps} - ids))
    cids = {c["id"] for c in camps}
    status, rows, _ = call("GET", "/rest/v1/lynxr_campaign_formats?select=campaign_id", token)
    check("formats: only my companies' briefs", all(r["campaign_id"] in cids for r in (listed(status, rows) or [])),
          f"HTTP {status}")
    status, sent, _ = call("GET", "/rest/v1/lynxr_agency_briefs?select=id,source_kind,source_id", token)
    sent = listed(status, sent) or []
    check("sent briefs: only my companies'",
          all(b["source_kind"] == "campaign" and b["source_id"] in cids for b in sent), f"HTTP {status}")
    sids = {b["id"] for b in sent}
    status, rows, _ = call("GET", "/rest/v1/lynxr_agency_deliveries?select=brief_id", token)
    check("deliveries: only of my companies' briefs", all(r["brief_id"] in sids for r in (listed(status, rows) or [])),
          f"HTTP {status}")
    status, rows, _ = call("GET", "/rest/v1/lynxr_brief_files?select=source_kind,source_id", token)
    check("files: only my companies' briefs",
          all(r["source_kind"] == "campaign" and r["source_id"] in cids for r in (listed(status, rows) or [])),
          f"HTTP {status}")
    status, rows, _ = call("GET", "/rest/v1/lynxr_cm_clients?select=cm_id,client_id", token)
    rows = listed(status, rows) or []
    check("assignments: only my own", all(r["cm_id"] == uid for r in rows), rows)
    status, crew, _ = call("POST", "/rest/v1/rpc/cm_roster", token, body={})
    crew = listed(status, crew)
    check("cm_roster: answers", crew is not None, f"HTTP {status}")
    check("cm_roster: every creator is on one of my companies",
          all(r.get("client_ids") and set(r["client_ids"]) <= ids for r in (crew or [])), crew)

    fake = "probe-unassigned-" + uuid.uuid4().hex[:8]
    status, _, text = call("POST", "/rest/v1/lynxr_campaigns", token, body={"client_id": fake, "name": "probe"})
    check("cannot create a brief for a company I'm not on", refused(status, text), f"HTTP {status} {text[:160]}")
    status, _, text = call("POST", "/rest/v1/lynxr_cm_clients", token, body={"cm_id": uid, "client_id": fake})
    check("cannot put myself on a company", refused(status, text), f"HTTP {status} {text[:160]}")
    status, _, text = call("POST", "/rest/v1/lynxr_staff", token, body={"id": uid, "email": ""})
    check("cannot make myself staff", refused(status, text), f"HTTP {status} {text[:160]}")
    status, js, _ = call("POST", "/rest/v1/rpc/staff_add_cm", token, body={"p_email": email})
    check("cannot tag anyone a CM", status == 200 and isinstance(js, dict) and js.get("ok") is False, js)

    company = sorted(ids)[0]
    status, made, text = call("POST", "/rest/v1/lynxr_campaigns?select=id,created_uid", token,
                              prefer="return=representation",
                              body={"client_id": company, "name": "cm probe, delete me", "created_by": "cm probe"})
    probe = made[0] if status == 201 and isinstance(made, list) and made else None
    check("can create a brief for my company", probe is not None, f"HTTP {status} {text[:160]}")
    if not probe:
        return
    pid = probe["id"]
    try:
        check("the brief is recorded as mine (created_uid)", probe.get("created_uid") == uid, probe)
        status, js, text = call("POST", "/rest/v1/lynxr_campaign_formats?select=id", token,
                                prefer="return=representation",
                                body={"campaign_id": pid, "position": 0, "source_url": "", "job": "script",
                                      "status": "done", "script": {"title": "probe", "beats": [
                                          {"t": "", "say": "probe", "do": "", "show": ""}]}})
        check("can add a format written from scratch", status == 201 and bool(js), f"HTTP {status} {text[:160]}")
        path = f"campaign/{pid}/probe-{uuid.uuid4().hex[:8]}/probe.png"
        status, _, text = call("POST", f"/storage/v1/object/{BUCKET}/{path}", token, raw=b"\x89PNG", ctype="image/png")
        check("can upload a file into my brief", status == 200, f"HTTP {status} {text[:160]}")
        status, _, text = call("GET", f"/storage/v1/object/authenticated/{BUCKET}/{path}", token)
        check("can download it", status == 200, f"HTTP {status} {text[:160]}")
        status, _, text = call("DELETE", f"/storage/v1/object/{BUCKET}/{path}", token)
        check("can delete it", status == 200, f"HTTP {status} {text[:160]}")
        if stoken:
            cross_company(token, stoken, uid, ids, pid, company, crew or [])
        else:
            print("note: run with --staff EMAIL for the cross-company and sending checks")
    finally:
        status, js, text = call("DELETE", f"/rest/v1/lynxr_campaigns?id=eq.{pid}&select=id", token,
                                prefer="return=representation")
        check("can delete my own brief (cleans up)", status == 200 and isinstance(js, list) and len(js) == 1,
              f"HTTP {status} {text[:160]}")


def main():
    ap = argparse.ArgumentParser(description="Live RLS probe for the CM portal. Asks for passwords; prints PASS/FAIL.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--plain", metavar="EMAIL", help="an ordinary creator account (not staff, not a CM)")
    g.add_argument("--cm", metavar="EMAIL", help="a test CM account that is on at least one company")
    ap.add_argument("--staff", metavar="EMAIL", help="with --cm: a staff account, for ground truth and clean-up")
    a = ap.parse_args()
    if a.plain:
        run_plain(a.plain)
    else:
        run_cm(a.cm, a.staff)
    print(f"\n{len(FAILS)} FAILED: {', '.join(FAILS)}" if FAILS else "\nALL PASS")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
