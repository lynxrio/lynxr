"""Checks on the fixer's PR gate (tools/fixer/gate.py). Stdlib only, no network.

    python3 tools/fixer/test_gate.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate as G  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


def diff(path, added=(), removed=(), new=False, deleted=False):
    out = [f"diff --git a/{path} b/{path}"]
    if new:
        out += ["new file mode 100644", "--- /dev/null", f"+++ b/{path}"]
    elif deleted:
        out += ["deleted file mode 100644", f"--- a/{path}", "+++ /dev/null"]
    else:
        out += [f"--- a/{path}", f"+++ b/{path}"]
    out.append("@@ -1,1 +1,1 @@")
    out += [f"-{x}" for x in removed] + [f"+{x}" for x in added]
    return "\n".join(out) + "\n"


def v(patch, mode="fix", rc="0"):
    return G.verdict(G.parse_patch(patch), mode, rc)


# ---- parse_patch ---------------------------------------------------------------
patch = (diff("pipeline/a.py", added=["x = 1"], removed=["x = 0"])
         + diff("pipeline/new.py", added=["y = 2"], new=True)
         + diff("pipeline/old.py", removed=["z = 3"], deleted=True)
         + "diff --git a/pipeline/r1.py b/pipeline/r2.py\nsimilarity index 100%\nrename from pipeline/r1.py\nrename to pipeline/r2.py\n")
fs = G.parse_patch(patch)
check("parse: four files", [(f["path"], f["status"]) for f in fs],
      [("pipeline/a.py", "M"), ("pipeline/new.py", "A"), ("pipeline/old.py", "D"), ("pipeline/r2.py", "R")])
check("parse: added and removed lines", (fs[0]["added_lines"], fs[0]["removed_lines"]), (["x = 1"], ["x = 0"]))
check("parse: a removed '-- comment' line inside a hunk is content, not a header",
      G.parse_patch("diff --git a/pipeline/q.py b/pipeline/q.py\n--- a/pipeline/q.py\n+++ b/pipeline/q.py\n@@ -1 +1 @@\n--- note\n+x\n")[0]["removed_lines"], ["-- note"])
check("parse: binary", G.parse_patch("diff --git a/pipeline/b.py b/pipeline/b.py\nBinary files a/pipeline/b.py and b/pipeline/b.py differ\n")[0]["binary"], True)

# ---- allowlist / denylist -------------------------------------------------------
check("allow: a pipeline module", v(diff("pipeline/transcribe.py", added=["a"], removed=["b"]))[0], "pr")
check("allow: requirements-ci.txt", v(diff("requirements-ci.txt", added=["av>=11,<19"]))[0], "pr")
check("deny: a page", v(diff("index.html", added=["a"]))[0], "diagnose")
check("deny: a workflow", v(diff(".github/workflows/fixer.yml", added=["a"]))[0], "diagnose")
check("deny: supabase sql", v(diff("supabase/x.sql", added=["a"]))[0], "diagnose")
for p in ("pipeline/fixer.py", "pipeline/fixer_dispatch.py", "pipeline/watchdog.py", "pipeline/canary.py", "pipeline/envcfg.py", "pipeline/test_fixer.py"):
    check(f"deny: its own guardrail {p}", v(diff(p, added=["a"]))[0], "diagnose")
check("deny: a rename out of a guardrail",
      v("diff --git a/pipeline/canary.py b/pipeline/c2.py\nsimilarity index 100%\nrename from pipeline/canary.py\nrename to pipeline/c2.py\n")[0], "diagnose")
check("deny: a deletion", v(diff("pipeline/old.py", removed=["z"], deleted=True))[0], "diagnose")

# ---- tests are never weakened ----------------------------------------------------
check("a removed line in a test file: diagnose", v(diff("pipeline/test_x.py", added=["a"], removed=["assert b"]))[0], "diagnose")
check("an added-only test change: pr", v(diff("pipeline/test_x.py", added=["assert b"]))[0], "pr")

# ---- sensitive lines ---------------------------------------------------------------
check("a SENSITIVE added line (refund()): diagnose", v(diff("pipeline/p.py", added=["refund(key, a)"]))[0], "diagnose")
check("a SENSITIVE removed line: diagnose", v(diff("pipeline/p.py", removed=["charge_scripts(x)"], added=["y"]))[0], "diagnose")
check("a .env read: diagnose", v(diff("pipeline/p.py", added=["open('.env').read()"]))[0], "diagnose")

# ---- size ----------------------------------------------------------------------------
many = "".join(diff(f"pipeline/m{i}.py", added=["a"]) for i in range(9))
check("9 files: diagnose", v(many)[0], "diagnose")
check("8 files: pr", v("".join(diff(f"pipeline/m{i}.py", added=["a"]) for i in range(8)))[0], "pr")
check("401 changed lines: diagnose", v(diff("pipeline/p.py", added=[f"l{i}" for i in range(401)]))[0], "diagnose")
check("400 changed lines: pr", v(diff("pipeline/p.py", added=[f"l{i}" for i in range(400)]))[0], "pr")

# ---- tests, mode, empty --------------------------------------------------------------
check("tests_rc 1: diagnose", v(diff("pipeline/p.py", added=["a"]), rc="1")[0], "diagnose")
r = v(diff("pipeline/p.py", added=["a"]), mode="diagnose")
check("diagnose mode with files: diagnose, with the discard reason", (r[0], "changes discarded: diagnose mode" in r[1]), ("diagnose", True))
check("an empty patch: nothing", v("")[0], "nothing")
check("diagnose mode with no files: diagnose", v("", mode="diagnose")[0], "diagnose")
check("drill-pr with the drill file: pr", v(diff("pipeline/fixer_drill.txt", added=["x"], new=True), mode="drill-pr")[0], "pr")
check("drill-pr touching worker.py: diagnose", v(diff("pipeline/worker.py", added=["x"]), mode="drill-pr")[0], "diagnose")
check("a clean one-file change: pr", v(diff("pipeline/transcribe.py", added=["x = 1"], removed=["x = 2"]), rc="0")[0], "pr")

# ---- text helpers --------------------------------------------------------------------
t = G.ascii_clean("Fix café https://evil.example/x   now " + "z" * 200, 90)
check("ascii_clean: no URL, ASCII, cut at 90", ("http" in t, t.isascii(), len(t)), (False, True, 90))
check("neutral: triple backticks are removed", "```" in G.neutral("a ``` b", 50), False)
check("neutral: a URL becomes <url>", G.neutral("see https://x.example/y", 50), "see <url>")
check("branch: a normal incident", G.branch("deploy-failed:123", "456"), "fixer/deploy-failed-123-456")
check("branch: a hostile incident still matches BRANCH_RE", bool(G.BRANCH_RE.match(G.branch("../x", "1"))), True)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
