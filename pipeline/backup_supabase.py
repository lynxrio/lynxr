#!/usr/bin/env python3
"""Pull every irreplaceable table out of Supabase and write it to disk.

WHY THIS EXISTS
----------------
There is no other copy. `lynxr_creators` holds one JSONB row per creator —
name, niches, brands, every adaptation, library and trash — and it cannot be
reconstructed from anything: not from `output/master_video_database.csv`, not
from git, not from the model that wrote the scripts. Whether Supabase's own
plan takes even a daily snapshot is unverified. Every other failure this
project has hit was a bad day; losing this table is permanent.

The whole irreplaceable set is small enough that "back up only the important
part" would be a false economy — it is one HTTP round trip per table.

READ ONLY, BY CONSTRUCTION. This module issues GET and nothing else. It must
never gain a POST, PATCH or DELETE; restoring is `restore_supabase.py`'s job
and it deliberately lives in a different file with a different deny-list.

WHAT IS CAPTURED, AND WHY IN TIERS
-----------------------------------
Tier 1 — irreplaceable. A failure here is a HARD failure: non-zero exit, the
table named, and no pretence of partial success. A backup run that quietly
skipped `lynxr_creators` and exited 0 would be worse than no backup at all,
because it would be trusted.

Tier 2 — painful to lose, effectively free to include. `lynxr_signup_gate`
holds `seats` / `require_invite` / `internal` and every signup passes through
it; `lynxr_sources` carries Apify view counts that cost real money to
re-fetch. A failure here is a warning and the run continues.

Tier 3 — best effort. `lynxr_costs` may not exist yet (`supabase/costs_table.sql`
is unapplied as of 2026-08-20), so PostgREST answers `PGRST205`. That is
"skipped", not "failed": the table is not irreplaceable — its own header says
a missing table degrades to "no cost data", `record_cost()` is best-effort,
and there is deliberately no backfill before 2026-08-16. But once it exists it
is the only record of what the pipeline has spent, it holds no creator data at
all (`id8` only, by design), and it is a few kilobytes. Free to carry, so
carry it — never at the cost of a Tier 1 table. This decision is written down
here because it is exactly the sort that gets re-litigated.

The auth roster is captured separately through the admin API. IT CANNOT
INCLUDE PASSWORD HASHES — the admin endpoint does not return them, so this is
a roster of who exists, not a set of credentials you could restore people
with. That sentence is repeated into the written file's `_note` key so
whoever finds it in six months is not misled by it.

`lynxr_videos` IS DELIBERATELY NOT CAPTURED. 9,028 rows, regenerable by
`pipeline/export_supabase.py` from `output/master_video_database.csv` (19.8 MB,
already on disk), and out of scope by standing instruction. It is named in the
manifest's `not_captured` key rather than silently omitted, so a future reader
can tell "decided against" from "forgotten".

WHERE IT REFUSES TO WRITE
--------------------------
CLAUDE.md's rule that a waitlist CSV never goes inside the repo is a habit
today. `unsafe_git_ancestor()` makes it structural: the destination is
rejected if it, or any ancestor up to $HOME, contains a `.git` directory. One
`git add -A` must not be able to publish creator data, and this is the
difference between that being enforced and being remembered.

Nothing here logs a key, an email address, or a line of a creator's script.
Counts and byte sizes only.

    ./venv/bin/python pipeline/backup_supabase.py --dry-run
    ./venv/bin/python pipeline/backup_supabase.py
    ./venv/bin/python pipeline/backup_supabase.py --dest /Volumes/x --keep 60
"""

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import envcfg  # noqa: E402 — the one place a secret is read; see its docstring.
import latency_report as LR  # noqa: E402 — reused for load_env/SB_URL, same as watchdog.py.

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    # This venv's Python has no system CA bundle — a bare default context
    # fails every request with CERTIFICATE_VERIFY_FAILED. Same guard every
    # other pipeline script uses.
    SSL_CTX = ssl.create_default_context()

ROOT = Path(__file__).resolve().parent.parent
SB_URL = LR.SB_URL
PROJECT_REF = SB_URL.split("//", 1)[-1].split(".", 1)[0]

# (table, tier). Order is the order they are fetched, so a Tier 1 failure
# aborts before spending time on the cheap stuff.
TABLES = (
    ("lynxr_creators", 1),
    ("lynxr_script_charges", 1),
    ("lynxr_allowance", 1),
    ("lynxr_clients", 1),
    ("lynxr_staff", 1),
    ("lynxr_signup_gate", 2),
    ("lynxr_invites", 2),
    ("lynxr_waitlist", 2),
    ("lynxr_feedback", 2),
    ("lynxr_sources", 2),
    ("lynxr_costs", 3),
)

NOT_CAPTURED = {
    "lynxr_videos": (
        "9,028 rows. Regenerable by pipeline/export_supabase.py from "
        "output/master_video_database.csv (19.8 MB, on disk). Out of scope by "
        "standing instruction. Decided against, not forgotten."
    ),
}

AUTH_FIELDS = ("id", "email", "created_at", "email_confirmed_at",
               "last_sign_in_at", "user_metadata")

AUTH_NOTE = (
    "This is a ROSTER, not a set of credentials. The Supabase admin API does "
    "not return password hashes, so nobody can be restored to a working login "
    "from this file — they would have to reset their password. Do not read "
    "this file as 'the accounts are backed up'."
)

PAGE = 1000          # PostgREST's own default cap; ask explicitly rather than
                     # inherit it, so a server-side default change cannot
                     # silently truncate a table.
AUTH_PAGE = 200      # the admin API's documented per_page maximum.


class Tier1Failure(RuntimeError):
    """A table we cannot claim to have backed up without lying."""


def unsafe_git_ancestor(dest, home=None):
    """The first directory at or above `dest` that holds a .git, or None.

    Walks upward and stops after $HOME (inclusive) — beyond that is somebody
    else's business. Ancestors that do not exist yet cannot hold a .git, so
    they are skipped rather than treated as safe-by-omission.
    """
    dest = Path(dest).expanduser().resolve()
    home = Path(home if home is not None else Path.home()).expanduser().resolve()
    for p in (dest, *dest.parents):
        if (p / ".git").exists():
            return p
        if p == home:
            break
    return None


def _get(url, key, timeout=60):
    req = urllib.request.Request(url)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return json.load(r)


def is_missing_table(err_body):
    """PostgREST's 'relation does not exist' code, which is a SKIP not a FAIL.

    Matched on the code rather than the message: the message carries the
    schema name and wording that has changed between PostgREST releases.
    """
    return "PGRST205" in (err_body or "")


def classify_failure(tier, status, body):
    """What a failed table read MEANS, as a rule rather than as inline
    branching — so the policy can be tested without a network.

    Returns one of "fail" / "skip" / "warn" with a reason. The only path to
    "skip" is a tier-3 table that PostgREST says does not exist; a tier-1
    table never reaches anything but "fail", whatever the status code, and
    that asymmetry is the whole point of the tiers.
    """
    if tier == 3 and is_missing_table(body):
        return "skip", "PGRST205 — table does not exist yet (tier 3)"
    if tier == 1:
        return "fail", (f"irreplaceable and could not be read (HTTP {status}). "
                        f"Nothing about this run can be trusted.")
    return "warn", f"HTTP {status}"


def fetch_table(key, table, page=PAGE, getter=None):
    """Every row, paginated. Raises urllib.error.HTTPError untouched so the
    caller can tell a missing table from a permission failure."""
    getter = getter or (lambda url: _get(url, key))
    rows, offset = [], 0
    while True:
        batch = getter(f"{SB_URL}/rest/v1/{table}?select=*"
                       f"&limit={page}&offset={offset}")
        rows.extend(batch)
        if len(batch) < page:
            return rows
        offset += page


def fetch_auth_users(key, per_page=AUTH_PAGE, getter=None):
    """The auth roster, trimmed to AUTH_FIELDS.

    Stops on a short page. A full FINAL page is the loop-forever case — it
    looks identical to 'there is more' until the next request comes back
    empty — so an empty page ends it too.
    """
    getter = getter or (lambda url: _get(url, key))
    out, page = [], 1
    while True:
        body = getter(f"{SB_URL}/auth/v1/admin/users"
                      f"?page={page}&per_page={per_page}")
        users = body.get("users", body) if isinstance(body, dict) else body
        if not users:
            return out
        out.extend({k: u.get(k) for k in AUTH_FIELDS} for u in users)
        if len(users) < per_page:
            return out
        page += 1


def build_manifest(results, run_utc, skipped=None, auth=None):
    """Counts, sizes and tiers — never a value out of any row."""
    return {
        "_note": (
            "Written by pipeline/backup_supabase.py. Read its docstring before "
            "trusting any of this. Restoring is restore_supabase.py's job."
        ),
        "run_utc": run_utc,
        "project_ref": PROJECT_REF,
        "tables": {
            name: {"tier": tier, "rows": rows, "bytes": size,
                   "file": f"{name}.json"}
            for name, tier, rows, size in results
        },
        "skipped": dict(skipped or {}),
        "not_captured": dict(NOT_CAPTURED),
        "auth_users": auth or {},
    }


def prune(dest, keep):
    """Drop the oldest run directories beyond `keep`. Only ever removes a
    directory whose name is a timestamp this module itself would produce —
    an unexpected sibling is left alone rather than deleted."""
    runs = sorted(p for p in Path(dest).glob("[0-9]" * 8 + "T" + "[0-9]" * 6 + "Z")
                  if p.is_dir())
    dropped = []
    for old in runs[:max(0, len(runs) - keep)]:
        for f in sorted(old.iterdir()):
            f.unlink()
        old.rmdir()
        dropped.append(old.name)
    return dropped


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dest", default=str(Path.home() / "Lynxr-backups"),
                    help="where run directories are written (default ~/Lynxr-backups)")
    ap.add_argument("--keep", type=int, default=30,
                    help="how many run directories to retain (default 30)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be fetched and written; contacts nothing")
    args = ap.parse_args(argv)

    dest = Path(args.dest).expanduser()
    offender = unsafe_git_ancestor(dest)
    if offender:
        sys.exit(
            f"refusing to write backups under a git working tree: {offender} "
            f"contains .git\nCreator data inside a repo is one `git add -A` "
            f"away from being public. Pick a --dest outside every checkout."
        )

    run_utc = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = dest / run_utc

    if args.dry_run:
        print(f"would write to {run_dir}")
        for name, tier in TABLES:
            print(f"  tier {tier}  {name}.json")
        print(f"  auth      auth_users.json  (roster only, no password hashes)")
        print(f"  manifest  MANIFEST.json")
        print(f"not captured: {', '.join(NOT_CAPTURED)}")
        print(f"would keep the newest {args.keep} run directories")
        return 0

    key = envcfg.first(envcfg.get("SUPABASE_SERVICE_ROLE_KEY"),
                       LR.load_env(ROOT / ".env").get("SUPABASE_SERVICE_ROLE_KEY"))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY is not set (env or .env)")

    run_dir.mkdir(parents=True, exist_ok=True)
    results, skipped = [], {}

    for name, tier in TABLES:
        try:
            rows = fetch_table(key, name)
        except urllib.error.HTTPError as e:
            verdict, reason = classify_failure(
                tier, e.code, e.read().decode("utf-8", "replace"))
            if verdict == "fail":
                raise Tier1Failure(f"{name} is {reason}") from None
            skipped[name] = reason
            print(f"{verdict:<4}  {name}: {reason}")
            continue

        blob = json.dumps(rows, indent=1, sort_keys=True, default=str).encode()
        (run_dir / f"{name}.json").write_bytes(blob)
        results.append((name, tier, len(rows), len(blob)))
        print(f"ok    {name}: {len(rows)} rows, {len(blob)} bytes")

    try:
        users = fetch_auth_users(key)
        blob = json.dumps({"_note": AUTH_NOTE, "users": users},
                          indent=1, sort_keys=True, default=str).encode()
        (run_dir / "auth_users.json").write_bytes(blob)
        auth = {"count": len(users), "bytes": len(blob),
                "file": "auth_users.json", "note": AUTH_NOTE}
        print(f"ok    auth roster: {len(users)} users, {len(blob)} bytes")
    except urllib.error.HTTPError as e:
        auth = {"error": f"HTTP {e.code}"}
        print(f"warn  auth roster: HTTP {e.code} (continuing)")

    manifest = build_manifest(results, run_utc, skipped, auth)
    (run_dir / "MANIFEST.json").write_bytes(
        json.dumps(manifest, indent=1, sort_keys=True).encode())

    total = sum(r[3] for r in results) + auth.get("bytes", 0)
    dropped = prune(dest, args.keep)
    print(f"\nwrote {len(results)} tables + roster, {total} bytes -> {run_dir}")
    if dropped:
        print(f"pruned {len(dropped)} old run(s), kept newest {args.keep}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Tier1Failure as e:
        sys.exit(f"BACKUP FAILED: {e}")
