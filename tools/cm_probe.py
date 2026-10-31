#!/usr/bin/env python3
"""Live row-level-security probe for the CM portal (plan: ~/.claude/plans/lynxr-cm-portal.md).

Talks to Supabase exactly as a browser does: the PUBLIC publishable key (the same one app.js ships) plus a signed-in
account's own token. Passwords are read with getpass and never stored, printed or written anywhere. Re-run it after any
change to supabase/cm_portal.sql or any agency policy: reading the SQL is not evidence (HANDOFF.md).

    ./venv/bin/python tools/cm_probe.py --plain EMAIL                 # an ordinary creator: sees nothing agency-side
    ./venv/bin/python tools/cm_probe.py --cm EMAIL [--staff EMAIL]    # a test CM; --staff adds the cross-company and
                                                                      # sending checks and cleans up after them
    ./venv/bin/python tools/cm_probe.py --cm EMAIL --staff EMAIL --cap   # also proves the 20-a-day invite cap; that test
                                                                      # CM then cannot invite for 24 hours

Adding creators (supabase/cm_creators.sql): the CM run also invites, appends to and removes roster rows for addresses at
example.invalid (never a real inbox or account) and deletes every one of them at the end.

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
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
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
                 "lynxr_sources", "lynxr_feedback", "lynxr_cm_roster_log"]
PROBE_DOMAIN = "example.invalid"   # never a real inbox, and no lynxr account can ever have it
CM_DAILY_CAP = 20                  # v_cap in supabase/cm_creators.sql


def q(s):
    return urllib.parse.quote(str(s), safe="")


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
    status, js, text = call("POST", "/rest/v1/rpc/cm_creators", token, body={})
    check("cm_creators: empty (run supabase/cm_creators.sql first)", status == 200 and js == [],
          f"HTTP {status} {text[:160]}")
    status, _, text = call("POST", "/rest/v1/rpc/cm_creators", None, body={})
    check("cm_creators: anonymous callers refused", refused(status, text), f"HTTP {status} {text[:160]}")
    fake = "probe-unassigned-" + uuid.uuid4().hex[:8]
    probe_addr = f"cm-probe-plain-{uuid.uuid4().hex[:8]}@{PROBE_DOMAIN}"
    for fn, body in (("cm_invite_creator", {"p_client": fake, "p_email": probe_addr, "p_name": ""}),
                     ("cm_remove_creator", {"p_client": fake, "p_email": probe_addr})):
        status, js, text = call("POST", f"/rest/v1/rpc/{fn}", token, body=body)
        check(f"{fn}: refused (not a CM)", status == 200 and isinstance(js, dict) and js.get("reason") == "not_cm",
              f"HTTP {status} {text[:160]}")
        status, _, text = call("POST", f"/rest/v1/rpc/{fn}", None, body=body)
        check(f"{fn}: anonymous callers refused", refused(status, text), f"HTTP {status} {text[:160]}")
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


def other_company(stoken, ids):
    """A lynxr_clients id this CM is not on (staff read), or a made-up one when there is none."""
    status, rows, _ = call("GET", "/rest/v1/lynxr_clients?select=id", stoken)
    skip = {"ingest-queue", "deleted-clients", "source-edits"}
    for r in listed(status, rows) or []:
        if r.get("id") and r["id"] not in ids and r["id"] not in skip:
            return r["id"]
    return "probe-unassigned-" + uuid.uuid4().hex[:8]


def crew_checks(token, stoken, uid, ids, company, cap):
    """CMs adding creators (supabase/cm_creators.sql). Writes only roster rows for @example.invalid addresses and removes
    every one of them at the end: staff delete them, or (without --staff) the CM cancels them itself."""
    made = []

    def addr(tag):
        e = f"cm-probe-{tag}-{uuid.uuid4().hex[:8]}@{PROBE_DOMAIN}"
        made.append(e)
        return e

    def rpc(fn, body):
        status, js, text = call("POST", f"/rest/v1/rpc/{fn}", token, body=body)
        return js if status == 200 and isinstance(js, dict) else {"http": status, "text": text[:160]}

    def invite(cid, e, name=""):
        return rpc("cm_invite_creator", {"p_client": cid, "p_email": e, "p_name": name})

    def remove(cid, e):
        return rpc("cm_remove_creator", {"p_client": cid, "p_email": e})

    def row(e):   # staff ground truth; None = no such row
        status, js, _ = call("GET", f"/rest/v1/lynxr_roster?email=eq.{q(e)}&select=email,campaign,status,display_name",
                             stoken)
        return js[0] if status == 200 and isinstance(js, list) and js else None

    def crew():
        status, js, _ = call("POST", "/rest/v1/rpc/cm_creators", token, body={})
        return listed(status, js)

    try:
        rows = crew()
        check("cm_creators: answers (run supabase/cm_creators.sql first)", rows is not None, rows)
        if rows is None:
            return
        check("cm_creators: only my companies' creators",
              all(r.get("client_ids") and set(r["client_ids"]) <= ids for r in rows), rows)
        check("cm_creators: invited or accepted only", all(r.get("status") in ("invited", "accepted") for r in rows), rows)
        check("cm_creators: no account id on a pending invite",
              all(r.get("creator_id") is None for r in rows if r.get("status") == "invited"), rows)

        mine = addr("mine")
        js = invite(company, mine, "Probe Person")
        check("can invite a creator to my company", js.get("ok") is True and js.get("result") == "invited", js)
        check("the invite is listed in cm_creators, on my company",
              any(r.get("email") == mine and company in (r.get("client_ids") or []) for r in crew() or []), mine)
        js = invite(company, mine)
        check("inviting the same email again adds nothing", js.get("ok") is True and js.get("result") == "already", js)
        js = invite(company, "not an email")
        check("a malformed email is refused", js.get("reason") == "bad_email", js)
        elsewhere = other_company(stoken, ids) if stoken else "probe-unassigned-" + uuid.uuid4().hex[:8]
        outside = addr("outside")
        js = invite(elsewhere, outside)
        check("cannot invite to a company I'm not on", js.get("ok") is False and js.get("reason") == "not_cm", js)

        if stoken:
            got = row(mine)
            check("the new row is an invite, labelled by the database, with the name given",
                  got is not None and got["status"] == "invited" and got["campaign"] != ""
                  and got["display_name"] == "Probe Person", got)
            check("and nothing was made for the other company", row(outside) is None, row(outside))

            theirs = addr("theirs")
            status, _, text = call("POST", "/rest/v1/lynxr_roster", stoken,
                                   body={"email": theirs, "campaign": "Probe Other Brand"})
            check("(staff) made a creator on another brand", status in (200, 201), f"HTTP {status} {text[:160]}")
            js = remove(company, theirs)
            check("cannot take another brand's creator off", js.get("ok") is False and js.get("reason") == "not_yours", js)
            status, js2, text = call("PATCH", f"/rest/v1/lynxr_roster?email=eq.{q(theirs)}&select=email", token,
                                     prefer="return=representation", body={"campaign": "hijacked"})
            check("cannot relabel a roster row directly", (status == 200 and js2 == []) or refused(status, text),
                  f"HTTP {status} {text[:160]}")
            status, js2, text = call("DELETE", f"/rest/v1/lynxr_roster?email=eq.{q(theirs)}&select=email", token,
                                     prefer="return=representation")
            check("cannot delete a roster row directly", (status == 200 and js2 == []) or refused(status, text),
                  f"HTTP {status} {text[:160]}")
            status, _, text = call("POST", "/rest/v1/lynxr_roster", token, body={"email": addr("direct"), "campaign": "x"})
            check("cannot insert a roster row directly", refused(status, text), f"HTTP {status} {text[:160]}")
            got = row(theirs)
            check("the other brand's creator is untouched", got is not None and got["campaign"] == "Probe Other Brand", got)
            check("and is not in my cm_creators", not any(r.get("email") == theirs for r in crew() or []), theirs)

            js = invite(company, theirs)
            check("adding my company to a creator on another brand appends it", js.get("result") == "added", js)
            got = row(theirs)
            check("their label names both brands", got is not None and got["campaign"].startswith("Probe Other Brand, "), got)
            js = remove(company, theirs)
            check("removing takes only my company off", js.get("ok") is True and js.get("result") == "removed", js)
            got = row(theirs)
            check("their row stays, with the other brand only", got is not None and got["campaign"] == "Probe Other Brand", got)

        js = remove(company, mine)
        check("can cancel my own pending invite", js.get("ok") is True and js.get("result") == "cancelled", js)
        if stoken:
            check("the cancelled invite is gone", row(mine) is None, row(mine))

        if cap and not stoken:
            print("note: --cap needs --staff (it reads the log to count)")
        elif cap:
            print(f"cap: inviting probe addresses until refused; this test CM cannot invite again for 24 hours")
            last = {}
            for _ in range(CM_DAILY_CAP + 2):
                last = invite(company, addr("cap"))
                if last.get("ok") is not True:
                    break
            since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
            status, logged, _ = call("GET", f"/rest/v1/lynxr_cm_roster_log?cm_id=eq.{q(uid)}"
                                            f"&kind=in.(invite,add_brand)&made_at=gt.{q(since)}&select=id", stoken)
            n = len(logged) if status == 200 and isinstance(logged, list) else None
            check(f"the cap refuses past {CM_DAILY_CAP} in 24 hours",
                  last.get("reason") == "cap" and last.get("cap") == CM_DAILY_CAP and n == CM_DAILY_CAP,
                  {"answer": last, "logged": n})
    finally:
        for e in made:
            if stoken:
                call("DELETE", f"/rest/v1/lynxr_roster?email=eq.{q(e)}", stoken)
            else:
                remove(company, e)


def run_cm(email, staff_email, cap=False):
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
    crew_checks(token, stoken, uid, ids, company, cap)
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
    ap.add_argument("--cap", action="store_true",
                    help="with --cm and --staff: also prove the 20-a-day invite cap (that test CM cannot invite for 24 hours)")
    a = ap.parse_args()
    if a.plain:
        run_plain(a.plain)
    else:
        run_cm(a.cm, a.staff, a.cap)
    print(f"\n{len(FAILS)} FAILED: {', '.join(FAILS)}" if FAILS else "\nALL PASS")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
