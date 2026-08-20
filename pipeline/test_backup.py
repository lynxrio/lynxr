"""Checks on backup_supabase.py's rules.

Pure-function tests: no credentials, no network, no Supabase. Run with

    ./venv/bin/python pipeline/test_backup.py

The thing under test is POLICY, not plumbing — where the backup refuses to
write, which failures are fatal and which are survivable, and whether the
manifest can leak a creator's email. Every check below either proves a
refusal happens when it should, or proves it does NOT happen when it
shouldn't; a guard only ever asserted in the direction it fires is a guard
nobody has tested.

The dest-safety cases matter most. CLAUDE.md's rule that creator data never
lands inside the repo is otherwise a habit, and habits do not survive a
`--dest .` typed at 2 a.m.
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backup_supabase as B  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


# ---- where it refuses to write --------------------------------------------
REPO = Path(__file__).resolve().parent.parent

check("repo root is refused",
      B.unsafe_git_ancestor(REPO) == REPO, True)
check("a subdirectory of the repo is refused",
      B.unsafe_git_ancestor(REPO / "output" / "backups") == REPO, True)
check("the pipeline dir itself is refused",
      B.unsafe_git_ancestor(REPO / "pipeline") == REPO, True)

with tempfile.TemporaryDirectory() as td:
    home = Path(td).resolve()
    (home / "Lynxr-backups").mkdir()
    check("a plain directory under a clean home is accepted",
          B.unsafe_git_ancestor(home / "Lynxr-backups", home=home), None)

    # a repo nested under that home, with the dest inside it
    (home / "proj" / ".git").mkdir(parents=True)
    (home / "proj" / "backups").mkdir()
    check("a dest inside a nested checkout is refused",
          B.unsafe_git_ancestor(home / "proj" / "backups", home=home),
          home / "proj")
    check("a dest that does not exist yet is still judged by its ancestors",
          B.unsafe_git_ancestor(home / "proj" / "nope" / "deeper", home=home),
          home / "proj")

    # the walk stops at $HOME — a .git ABOVE home is not this tool's business
    check("the walk stops at $HOME",
          B.unsafe_git_ancestor(home / "Lynxr-backups", home=home), None)


# ---- which failures are fatal ---------------------------------------------
PGRST205 = '{"code":"PGRST205","message":"Could not find the table"}'

check("tier 3 + PGRST205 is a skip",
      B.classify_failure(3, 404, PGRST205)[0], "skip")
check("tier 3 + a permission failure is NOT a skip",
      B.classify_failure(3, 401, '{"code":"42501"}')[0], "warn")
check("tier 2 failure is survivable",
      B.classify_failure(2, 500, "")[0], "warn")
check("tier 1 failure is fatal",
      B.classify_failure(1, 500, "")[0], "fail")
check("tier 1 is fatal even when the table is genuinely missing",
      B.classify_failure(1, 404, PGRST205)[0], "fail")
check("is_missing_table matches the code, not the wording",
      (B.is_missing_table(PGRST205), B.is_missing_table('{"message":"no table"}')),
      (True, False))


# ---- the pager stops ------------------------------------------------------
def pager(pages):
    """A fake admin API returning `pages` in order, then empty forever."""
    calls = {"n": 0}

    def get(url):
        i = calls["n"]
        calls["n"] += 1
        return {"users": pages[i] if i < len(pages) else []}
    return get, calls


def users(n, start=0):
    return [{"id": f"id{start + i}", "email": f"u{start + i}@example.com"}
            for i in range(n)]


get, calls = pager([users(3)])
check("a single short page ends the pager",
      (len(B.fetch_auth_users("k", per_page=200, getter=get)), calls["n"]), (3, 1))

get, calls = pager([users(2), users(2, 2), users(1, 4)])
check("pages until a short one, keeping every user",
      (len(B.fetch_auth_users("k", per_page=2, getter=get)), calls["n"]), (5, 3))

get, calls = pager([users(2), users(2, 2)])
check("a FULL final page does not loop forever",
      (len(B.fetch_auth_users("k", per_page=2, getter=get)), calls["n"]), (4, 3))

check("the roster keeps only the declared fields",
      sorted(B.fetch_auth_users("k", per_page=200,
                                getter=pager([[{"id": "a", "email": "e@x.io",
                                                "encrypted_password": "SECRET",
                                                "phone": "+1"}]])[0])[0]),
      sorted(B.AUTH_FIELDS))


# ---- the table pager ------------------------------------------------------
def tpager(pages):
    calls = {"n": 0}

    def get(url):
        i = calls["n"]
        calls["n"] += 1
        return pages[i] if i < len(pages) else []
    return get, calls

get, calls = tpager([[{"a": 1}] * 3])
check("a short table page ends the fetch",
      (len(B.fetch_table("k", "t", page=1000, getter=get)), calls["n"]), (3, 1))

get, calls = tpager([[{"a": 1}] * 2, [{"a": 1}] * 2])
check("a full final table page does not loop forever",
      (len(B.fetch_table("k", "t", page=2, getter=get)), calls["n"]), (4, 3))


# ---- the manifest carries tiers and counts, and no personal data ----------
man = B.build_manifest(
    [("lynxr_creators", 1, 5, 274_000), ("lynxr_sources", 2, 28, 9_100)],
    "20260820T200000Z",
    skipped={"lynxr_costs": "PGRST205 — table does not exist yet (tier 3)"},
    auth={"count": 8, "bytes": 2048, "file": "auth_users.json",
          "note": B.AUTH_NOTE})

check("manifest carries the tier", man["tables"]["lynxr_creators"]["tier"], 1)
check("manifest carries the row count", man["tables"]["lynxr_creators"]["rows"], 5)
check("manifest carries the byte size", man["tables"]["lynxr_sources"]["bytes"], 9_100)
check("manifest records a skipped table with its reason",
      "PGRST205" in man["skipped"]["lynxr_costs"], True)
check("manifest names lynxr_videos as decided-against, not forgotten",
      "lynxr_videos" in man["not_captured"], True)
check("manifest states the roster has no password hashes",
      "password hashes" in man["auth_users"]["note"], True)

blob = json.dumps(man)
check("no '@' anywhere in the manifest", "@" not in blob, True)
check("no service-role key shape in the manifest",
      ("service_role" not in blob and "sb_secret" not in blob), True)


# ---- prune only ever removes its own timestamped directories --------------
with tempfile.TemporaryDirectory() as td:
    dest = Path(td)
    for stamp in ("20260101T000000Z", "20260102T000000Z", "20260103T000000Z"):
        (dest / stamp).mkdir()
        (dest / stamp / "MANIFEST.json").write_text("{}")
    (dest / "notes.txt").write_text("keep me")
    (dest / "some-other-dir").mkdir()

    dropped = B.prune(dest, keep=2)
    check("prune drops the oldest beyond --keep", dropped, ["20260101T000000Z"])
    check("prune leaves the newest alone",
          (dest / "20260103T000000Z").is_dir(), True)
    check("prune never touches an unexpected sibling directory",
          (dest / "some-other-dir").is_dir(), True)
    check("prune never touches a loose file", (dest / "notes.txt").is_file(), True)
    check("prune with keep >= count drops nothing", B.prune(dest, keep=10), [])


print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
