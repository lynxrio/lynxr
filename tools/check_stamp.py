#!/usr/bin/env python3
"""Enforce the `?v=YYYYMMDDx` cache-bust stamp across every page in the repo.

WHY THIS EXISTS
---
`app.css` is loaded by twelve pages and `?v=` is the only cache-busting
mechanism there is (no build step, no content-hashed filenames — see
`~/.claude/plans/hardening-e-maintainability.md`, E3). It has moved by hand
every time, and on 2026-08-20 it did not move at all: commit `4dc7f99`
changed `app.css` (52 insertions) and left the stamp at `20260823j` on every
page. Nothing caught it; the next commit an hour later happened to bump the
stamp anyway and covered the miss by accident. This script is the thing that
should have caught it, and `--range 4dc7f99^..4dc7f99` (below) is the
regression test that proves it now does.

WHAT IT CHECKS
---
Pages are discovered, never hardcoded — `rglob("index.html")` from the repo
root, skipping `venv/`, `output/`, `data/`, `node_modules/`, `.git/`.
`output/` matters on its own: it holds `.html` spec documents that must not
be scanned as if they were served pages.

  Check A (always): every stamped local .css/.js reference, across every
  discovered page, resolves to exactly one distinct stamp value.

  Check B (always): no local .css/.js reference is missing a `?v=` at all.

  Check C (conditional on comparing two revisions — `--staged` or `--range`):
  if any of app.css, app.js, creator.js, site.js, home.js, dotgrid.js, or any
  fonts/*.woff2 differs between the two revisions, the stamp value must also
  differ. A plain no-argument run compares the working tree against `HEAD`
  for the same reason.

References are pulled ONLY out of `.html` files, with
`(?:href|src)="...\\.(?:css|js)(\\?v=...)?"`. That anchoring is not cosmetic:
`creator.js:381-382` and `app.js:914-915` both contain the literal string
`"?v="` (YouTube URL canonicalisation — `youtu.be/ID` -> `watch?v=ID`), and
`app.js:4602` mentions the stamp in a comment. A repo-wide `grep '?v='`
counts all four; this script never greps `.js` source for the token at all.

USAGE
---
    ./venv/bin/python tools/check_stamp.py                  # working tree vs HEAD
    ./venv/bin/python tools/check_stamp.py --staged          # index vs HEAD (pre-commit)
    ./venv/bin/python tools/check_stamp.py --range B..H      # CI, two commits
    ./venv/bin/python tools/check_stamp.py --selftest        # synthetic, no git

This script never rewrites anything. On failure it prints the changed
asset(s), the stamp in force, a suggested next value, and a copy-pasteable
command that performs the bump -- it does not run that command itself. A
hook that silently rewrites a commit is worse than no hook.

`[skip stamp]` in a commit message is honoured only by `--range` (i.e. in
CI, reading real commit messages after the fact). A `pre-commit` hook runs
BEFORE git has captured any commit message at all -- confirmed empirically,
not assumed: `.git/COMMIT_EDITMSG` does not exist yet at pre-commit time even
under `git commit -m "..."`. So `--staged` cannot see the token and does not
try to; bypass a false positive there with `git commit --no-verify` and put
`[skip stamp]` in the message so CI lets it through.
"""

import argparse
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent

SKIP_DIRS = {"venv", "output", "data", "node_modules", ".git"}

# Only ever run against .html text. Requires the extension so it cannot
# match a bare "?v=" inside JS source (the YouTube-URL false positive).
REF_RE = re.compile(
    r'(?:href|src)="(/?[A-Za-z0-9_./-]+\.(?:css|js))(\?v=([0-9a-z]+))?"'
)

STAMP_RE = re.compile(r'^(\d+)([a-z])$')

# Pathspecs (relative to repo root) whose change must be accompanied by a
# stamp bump. Git pathspec glob syntax, not shell glob -- passed straight to
# `git diff -- <spec>`, never through a shell.
WATCHED_ASSET_SPECS = [
    "app.css", "app.js", "creator.js", "site.js", "home.js", "dotgrid.js",
    "footer.js", "theme.js", "fonts/*.woff2",
]

SKIP_TOKEN = "[skip stamp]"


# ---------------------------------------------------------------- git glue

def git(*args, check=True):
    res = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True
    )
    if check and res.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {res.stderr.strip()}")
    return res


def ref_exists(ref):
    # NOT `git rev-parse --verify --quiet <ref>` alone -- for a well-formed
    # 40-hex string (exactly the shape of a dropped force-push commit, or
    # the all-zeros `before` on a brand-new branch) that command reports
    # success WITHOUT checking the object actually exists in the database.
    # Confirmed empirically: `git rev-parse --verify --quiet
    # 0000...0000` exits 0 on this repo. Appending `^{commit}` forces git to
    # actually dereference the object, which is the real existence check.
    return git(
        "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False
    ).returncode == 0


# ------------------------------------------------------------ pure helpers
# Kept side-effect-free and dict/string based on purpose, same house pattern
# as pipeline/watchdog.py's ops_snapshot_value -- so --selftest can exercise
# the actual logic without a git repo, an index, or a filesystem.

def is_skipped_dir(relparts):
    return any(part in SKIP_DIRS for part in relparts)


def discover_page_relpaths(all_relpaths):
    """all_relpaths: iterable of posix-style path strings (files, any kind).
    Returns the sorted subset that are index.html pages we should scan,
    skipping the directories that must never be treated as served pages."""
    out = []
    for p in all_relpaths:
        pp = PurePosixPath(p)
        if pp.name != "index.html":
            continue
        if is_skipped_dir(pp.parts[:-1]):
            continue
        out.append(pp.as_posix())
    return sorted(out)


def resolve_ref_relpath(page_relpath, ref):
    """Resolve an href/src value found on `page_relpath` to a repo-relative
    posix path. `ref` may be root-relative ("/app.css?stripped-by-caller")
    or relative to the page's own directory ("app.css")."""
    page_dir = PurePosixPath(page_relpath).parent
    if ref.startswith("/"):
        cand_parts = PurePosixPath(ref.lstrip("/")).parts
    else:
        cand_parts = (page_dir / ref).parts
    parts = []
    for part in cand_parts:
        if part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return PurePosixPath(*parts).as_posix() if parts else ""


def find_refs(html_text):
    """Yield (ref, stamp_or_None) for every href/src="...\\.(css|js)" match."""
    for m in REF_RE.finditer(html_text):
        ref, _, stamp = m.groups()
        yield ref, stamp


def check_a_and_b(pages, exists):
    """pages: dict[relpath -> html text]. exists: callable(relpath) -> bool,
    resolved against whatever revision `pages` was taken from.

    Returns (errors: list[str], stamp_refs: dict[stamp -> [(page, ref), ...]])
    """
    missing = []
    stamp_refs = defaultdict(list)
    for page in sorted(pages):
        for ref, stamp in find_refs(pages[page]):
            target = resolve_ref_relpath(page, ref)
            if not target or not exists(target):
                continue  # not ours to enforce -- a future CDN/absolute URL
            if stamp is None:
                missing.append((page, ref))
            else:
                stamp_refs[stamp].append((page, ref))

    errors = []
    if missing:
        lines = "\n".join(f"  {p}: {r}" for p, r in missing)
        errors.append(
            f"Check B FAILED -- {len(missing)} reference(s) with no ?v= stamp:\n{lines}"
        )
    if len(stamp_refs) > 1:
        lines = "\n".join(
            f"  {s}: {len(refs)} reference(s), e.g. {refs[0][0]}"
            for s, refs in sorted(stamp_refs.items())
        )
        errors.append(
            f"Check A FAILED -- stamp values disagree across the repo:\n{lines}"
        )
    return errors, stamp_refs


def dominant_stamp(stamp_refs):
    """The one stamp value in force, or None if zero or more than one."""
    if len(stamp_refs) == 1:
        return next(iter(stamp_refs))
    return None


def check_c(changed_assets, stamp_before, stamp_after):
    """Pure. changed_assets: list of watched-asset specs that differ between
    the two revisions. Returns an error string, or None."""
    if not changed_assets:
        return None
    if stamp_before is not None and stamp_after is not None and stamp_before == stamp_after:
        return (
            "Check C FAILED -- asset(s) changed but the stamp did not move: "
            + ", ".join(changed_assets)
            + f" (stamp stayed {stamp_before!r})"
        )
    return None


def suggest_next_stamp(old):
    """20260823l -> 20260823m. None if the shape isn't recognised (owner
    picks a value by hand in that case -- e.g. a 'z' rollover)."""
    m = STAMP_RE.match(old)
    if not m:
        return None
    date, letter = m.groups()
    if letter == "z":
        return None
    return f"{date}{chr(ord(letter) + 1)}"


def bump_oneliner(old, new):
    return (
        f"grep -rl '?v={old}' --include='index.html' . | "
        f"xargs sed -i '' 's/?v={old}/?v={new}/g'"
    )


def has_skip_token(messages):
    return any(SKIP_TOKEN in msg for msg in messages)


# --------------------------------------------------------------- snapshots
# Three ways to get "the set of discovered pages and their text", used by
# the three real (non-selftest) modes.

def snapshot_worktree():
    pages = {}
    for p in sorted(ROOT.rglob("index.html")):
        rel = p.relative_to(ROOT)
        if is_skipped_dir(rel.parts[:-1]):
            continue
        pages[rel.as_posix()] = p.read_text(encoding="utf-8", errors="replace")
    return pages


def exists_worktree(relpath):
    return (ROOT / relpath).exists()


def snapshot_index():
    """The staged tree -- what `git commit` would actually record."""
    all_paths = git("ls-files").stdout.splitlines()
    pages = {}
    for rel in discover_page_relpaths(all_paths):
        pages[rel] = git("show", f":{rel}").stdout
    return pages


def exists_index(relpath):
    return git("cat-file", "-e", f":{relpath}", check=False).returncode == 0


def snapshot_ref(ref):
    all_paths = git("ls-tree", "-r", "--name-only", ref).stdout.splitlines()
    pages = {}
    for rel in discover_page_relpaths(all_paths):
        pages[rel] = git("show", f"{ref}:{rel}").stdout
    return pages


def make_exists_ref(ref):
    def _exists(relpath):
        return git("cat-file", "-e", f"{ref}:{relpath}", check=False).returncode == 0
    return _exists


def changed_watched_assets(diff_args):
    """diff_args: list of args to insert between `git diff` and `-- <spec>`,
    e.g. ["--cached"] or ["<base>", "<head>"]."""
    changed = []
    for spec in WATCHED_ASSET_SPECS:
        rc = git("diff", "--quiet", *diff_args, "--", spec, check=False).returncode
        if rc == 1:
            changed.append(spec)
        elif rc not in (0, 1):
            raise RuntimeError(f"git diff --quiet {' '.join(diff_args)} -- {spec} errored")
    return changed


# -------------------------------------------------------------- reporting

def report_failure(errors, changed_assets, stamp_after):
    print("\n".join(errors))
    if changed_assets and stamp_after:
        nxt = suggest_next_stamp(stamp_after)
        print()
        print(f"Current stamp: {stamp_after}")
        if nxt:
            print(f"Suggested next stamp: {nxt}")
            print("Run this yourself -- this tool never rewrites a commit:")
            print(f"  {bump_oneliner(stamp_after, nxt)}")
        else:
            print(
                "Could not derive a suggested next stamp automatically "
                f"(shape of {stamp_after!r} not recognised, or it ends in "
                "'z') -- pick a new YYYYMMDDx value by hand and bump it on "
                "every discovered page."
            )


# -------------------------------------------------------------------- runs

def run_worktree():
    pages = snapshot_worktree()
    errors, stamp_refs = check_a_and_b(pages, exists_worktree)
    stamp_after = dominant_stamp(stamp_refs)

    changed = []
    if ref_exists("HEAD"):
        changed = changed_watched_assets(["HEAD"])
        head_pages = snapshot_ref("HEAD")
        _, head_stamp_refs = check_a_and_b(head_pages, make_exists_ref("HEAD"))
        stamp_before = dominant_stamp(head_stamp_refs)
        c_err = check_c(changed, stamp_before, stamp_after)
        if c_err:
            errors.append(c_err)

    if errors:
        report_failure(errors, changed, stamp_after)
        return 1
    print(f"ok -- {len(pages)} page(s), stamp {stamp_after!r} consistent, no missing stamps.")
    return 0


def run_staged():
    if not ref_exists("HEAD"):
        # First commit ever in the repo -- nothing to diff against yet.
        pages = snapshot_index()
        errors, stamp_refs = check_a_and_b(pages, exists_index)
        stamp_after = dominant_stamp(stamp_refs)
        if errors:
            report_failure(errors, [], stamp_after)
            return 1
        print("ok -- initial commit, checks A and B only (no HEAD to diff against).")
        return 0

    pages = snapshot_index()
    errors, stamp_refs = check_a_and_b(pages, exists_index)
    stamp_after = dominant_stamp(stamp_refs)

    changed = changed_watched_assets(["--cached"])
    head_pages = snapshot_ref("HEAD")
    _, head_stamp_refs = check_a_and_b(head_pages, make_exists_ref("HEAD"))
    stamp_before = dominant_stamp(head_stamp_refs)
    c_err = check_c(changed, stamp_before, stamp_after)
    if c_err:
        errors.append(c_err)

    if errors:
        report_failure(errors, changed, stamp_after)
        print(
            "\nNote: [skip stamp] is not honoured here -- a pre-commit hook "
            "runs before git has captured a commit message. Use "
            "'git commit --no-verify' and put [skip stamp] in the message "
            "so CI lets it through instead."
        )
        return 1
    print(f"ok -- {len(pages)} staged page(s), stamp {stamp_after!r} consistent.")
    return 0


def resolve_range(range_arg):
    """Returns (base_or_None, head, can_check_c). Handles the degenerate
    ranges a GitHub Actions checkout can hand us: a brand-new branch's
    `before` is all zeros, and a force-push's points at a dropped commit."""
    base, sep, head = range_arg.partition("..")
    head = head or "HEAD"
    if sep and base and ref_exists(base):
        return base, head, True
    fallback = f"{head}^"
    if ref_exists(fallback):
        return fallback, head, True
    return None, head, False


def run_range(range_arg):
    base, head, can_check_c = resolve_range(range_arg)

    if base is not None:
        messages = git("log", "--format=%B", f"{base}..{head}").stdout
        if has_skip_token([messages]):
            print(f"skipped -- {SKIP_TOKEN} found in a commit message between {base}..{head}.")
            return 0

    head_pages = snapshot_ref(head)
    errors, head_stamp_refs = check_a_and_b(head_pages, make_exists_ref(head))
    stamp_after = dominant_stamp(head_stamp_refs)

    changed = []
    if can_check_c:
        changed = changed_watched_assets([base, head])
        base_pages = snapshot_ref(base)
        _, base_stamp_refs = check_a_and_b(base_pages, make_exists_ref(base))
        stamp_before = dominant_stamp(base_stamp_refs)
        c_err = check_c(changed, stamp_before, stamp_after)
        if c_err:
            errors.append(c_err)
    else:
        print(
            "note: could not resolve a base commit to diff against "
            f"(range was {range_arg!r}) -- running Checks A and B only, "
            "skipping Check C."
        )

    if errors:
        report_failure(errors, changed, stamp_after)
        return 1
    print(f"ok -- {len(head_pages)} page(s) at {head}, stamp {stamp_after!r} consistent.")
    return 0


# ----------------------------------------------------------------- selftest

def selftest():
    fails = []
    total = [0]

    def check(name, got, want):
        total[0] += 1
        ok = got == want
        if not ok:
            fails.append(name)
        print(f"{'ok  ' if ok else 'FAIL'}  {name}")
        if not ok:
            print(f"      got:  {got!r}")
            print(f"      want: {want!r}")

    # -- page discovery skips the right directories, including output/*.html
    all_paths = [
        "index.html",
        "creatorsonly/index.html",
        "output/spec_a/index.html",
        "output/spec_b/index.html",
        "venv/lib/index.html",
        "data/index.html",
        "node_modules/pkg/index.html",
        ".git/hooks/index.html",
        "faq/index.html",
        "notes.txt",
    ]
    check(
        "discover_page_relpaths skips venv/output/data/node_modules/.git",
        discover_page_relpaths(all_paths),
        ["creatorsonly/index.html", "faq/index.html", "index.html"],
    )

    # -- resolve_ref_relpath: root-relative and page-relative both land right
    check(
        "root-relative ref resolves against repo root",
        resolve_ref_relpath("creatorsonly/index.html", "/app.css"),
        "app.css",
    )
    check(
        "page-relative ref resolves against the page's own directory",
        resolve_ref_relpath("index.html", "app.css"),
        "app.css",
    )
    check(
        "page-relative ref from a subdirectory page",
        resolve_ref_relpath("waitlist/index.html", "site.js"),
        "waitlist/site.js",
    )

    # -- Check A: consistent stamp across pages passes; disagreement fails
    consistent_pages = {
        "index.html": '<link rel="stylesheet" href="app.css?v=20260823l">',
        "faq/index.html": '<link rel="stylesheet" href="/app.css?v=20260823l">',
    }
    exists_all = lambda _r: True
    errors, stamps = check_a_and_b(consistent_pages, exists_all)
    check("Check A passes when every page agrees on one stamp", errors, [])
    check("dominant_stamp reads the single agreed value", dominant_stamp(stamps), "20260823l")

    disagreeing_pages = {
        "index.html": '<link rel="stylesheet" href="app.css?v=20260823l">',
        "faq/index.html": '<link rel="stylesheet" href="/app.css?v=20260823k">',
    }
    errors, stamps = check_a_and_b(disagreeing_pages, exists_all)
    check("Check A fires when two pages disagree on the stamp", len(errors), 1)
    check(
        "the failing Check A message names both stamp values",
        errors and "Check A FAILED" in errors[0],
        True,
    )

    # -- Check B: a reference with no ?v= at all is caught
    missing_stamp_pages = {
        "index.html": '<link rel="stylesheet" href="app.css">',
    }
    errors, _ = check_a_and_b(missing_stamp_pages, exists_all)
    check("Check B fires on a css/js reference with no ?v=", len(errors), 1)
    check(
        "the failing Check B message names it",
        errors and "Check B FAILED" in errors[0],
        True,
    )

    # -- references to files that don't exist on disk are ignored, not failed
    absent_ref_pages = {
        "index.html": '<link rel="stylesheet" href="nonexistent.css">',
    }
    errors, stamps = check_a_and_b(absent_ref_pages, lambda _r: False)
    check("a reference to a file absent on disk is silently ignored", errors, [])
    check("...and contributes no stamp either", dict(stamps), {})

    # -- the "?v=" YouTube false positive: our regex only fires on
    # href/src="...\.(css|js)(\?v=...)?" , so a raw "?v=" string sitting in
    # an inline <script> block (the shape creator.js:381-382 / app.js:914-915
    # actually have, if it ever ended up inside an .html page) must not be
    # mistaken for an asset reference.
    inline_js_page = {
        "index.html": (
            '<script>const u = "https://youtu.be/ID"; '
            'const canon = u.replace("youtu.be/", "watch?v=");</script>'
            '<link rel="stylesheet" href="app.css?v=20260823l">'
        ),
    }
    errors, stamps = check_a_and_b(inline_js_page, exists_all)
    check("inline JS containing a bare '?v=' does not register as a css/js ref", errors, [])
    check(
        "...only the real href=...css?v=... reference is counted",
        {s: len(r) for s, r in stamps.items()},
        {"20260823l": 1},
    )

    # -- Check C: pure core, no git involved
    check(
        "Check C fires when a watched asset changed but the stamp did not move",
        check_c(["app.css"], "20260823j", "20260823j") is not None,
        True,
    )
    check(
        "Check C is silent when the stamp moved alongside the asset",
        check_c(["app.css"], "20260823j", "20260823k"),
        None,
    )
    check(
        "Check C is silent when nothing watched changed",
        check_c([], "20260823j", "20260823j"),
        None,
    )

    # -- suggested next stamp
    check("suggest_next_stamp bumps the trailing letter", suggest_next_stamp("20260823l"), "20260823m")
    check("suggest_next_stamp gives up past 'z'", suggest_next_stamp("20260823z"), None)
    check("suggest_next_stamp gives up on an unrecognised shape", suggest_next_stamp("v2"), None)

    # -- [skip stamp]
    check("has_skip_token finds the literal token", has_skip_token(["fix: typo [skip stamp]"]), True)
    check("has_skip_token is false without it", has_skip_token(["fix: typo"]), False)

    print()
    passed = total[0] - len(fails)
    print(f"{passed} passed, {len(fails)} failed")
    return 0 if not fails else 1


# ------------------------------------------------------------------------- CLI

def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--selftest", action="store_true", help="run the synthetic self-test, no git")
    mode.add_argument("--staged", action="store_true", help="staged content vs HEAD (pre-commit)")
    mode.add_argument("--range", metavar="BASE..HEAD", help="two commits, e.g. for CI")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if args.staged:
        return run_staged()
    if args.range:
        return run_range(args.range)
    return run_worktree()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
