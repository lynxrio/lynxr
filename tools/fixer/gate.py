#!/usr/bin/env python3
"""The fixer's deterministic gate: decides whether a model-written patch may become a pull request.

Stdlib only, Python 3.12, and NO imports from this repo. The workflow's propose job copies this file out of the
BASE checkout before any patch is applied and runs the copy, so a patch can never change the rules that judge it.

    gate.py check        verdict + the files the PR is made from (title, commit message, body)
    gate.py collect      (brain job) the patch and a validated out.json, into --outdir
    gate.py drill-patch  (drill:pr only) a one-line patch, no model

The gate never trusts the model: paths, sizes, sensitive lines and test results decide, not what the diagnosis says.
"""

import argparse
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

ALLOW_RE = re.compile(r"^(pipeline/[a-z0-9_]+\.py|requirements-ci\.txt|Dockerfile)$")
DRILL_ALLOW = {"pipeline/fixer_drill.txt"}
DENY = {"pipeline/fixer.py", "pipeline/fixer_dispatch.py", "pipeline/test_fixer.py", "pipeline/watchdog.py",
        "pipeline/test_watchdog.py", "pipeline/canary.py", "pipeline/test_canary.py", "pipeline/envcfg.py",
        "pipeline/test_envcfg.py"}
SENSITIVE_RE = re.compile(
    r"charge_scripts|refund|allowance|lynxr_billing|billing|stripe|service_role|SUPABASE_SERVICE_ROLE_KEY|"
    r"ANTHROPIC_API_KEY|NTFY_TOPIC|FLY_API_TOKEN|is_staff|auth\.uid|/rpc/|method=\"DELETE\"|\.delete\(|delete from|"
    r"drop table|truncate |os\.environ\[|\.env\b", re.I)
MAX_FILES, MAX_LINES = 8, 400
BRANCH_RE = re.compile(r"^fixer/[a-z0-9-]{1,60}$")
INCIDENT_RE = re.compile(r"^[a-z0-9][a-z0-9:_.-]{0,47}$")
MODES = ("fix", "diagnose", "drill-pr")
OUT_MAX_BYTES = 20_000
_URL_RE = re.compile(r"https?://\S+")


def parse_patch(text):
    """A git patch -> [{"path", "old_path", "status" (A/M/D/R), "binary", "added_lines", "removed_lines"}]."""
    files = []
    for chunk in re.split(r"(?m)^(?=diff --git a/)", text or ""):
        if not chunk.startswith("diff --git a/"):
            continue
        head = chunk.split("\n", 1)[0]
        m = re.match(r"diff --git a/(.*) b/(.*)$", head)
        d = {"path": m.group(2) if m else "", "old_path": m.group(1) if m else "", "status": "M", "binary": False,
             "added_lines": [], "removed_lines": []}
        plus = minus = None
        in_hunk = False
        for line in chunk.split("\n")[1:]:
            if line.startswith("@@"):
                in_hunk = True
                continue
            if not in_hunk:
                if line.startswith("new file mode"):
                    d["status"] = "A"
                elif line.startswith("deleted file mode"):
                    d["status"] = "D"
                elif line.startswith("rename from "):
                    d["old_path"] = line[len("rename from "):]
                elif line.startswith("rename to "):
                    d["status"] = "R"
                    d["path"] = line[len("rename to "):]
                elif line.startswith("Binary files") or line.startswith("GIT binary patch"):
                    d["binary"] = True
                elif line.startswith("+++ "):
                    plus = line[4:]
                elif line.startswith("--- "):
                    minus = line[4:]
                continue
            if line.startswith("+") and not line.startswith("+++"):
                d["added_lines"].append(line[1:])
            elif line.startswith("-") and not line.startswith("---"):
                d["removed_lines"].append(line[1:])
            elif line.startswith("+++ ") or line.startswith("--- "):
                # inside a hunk a line starting with +++/--- is content, not a header
                (d["added_lines"] if line[0] == "+" else d["removed_lines"]).append(line[1:])
        if plus and plus.startswith("b/"):
            d["path"] = plus[2:]
        elif plus == "/dev/null" and minus and minus.startswith("a/"):
            d["path"] = minus[2:]
        files.append(d)
    return files


def verdict(files, mode, tests_rc):
    """(verdict, reasons). Every reason that applies is collected; the verdict is "pr" only when there are none."""
    reasons = []
    if mode == "diagnose":
        if files:
            reasons.append("changes discarded: diagnose mode")
        return "diagnose", reasons
    if not files:
        return "nothing", reasons
    if mode == "drill-pr":
        bad = [f["path"] for f in files if f["path"] not in DRILL_ALLOW]
        if bad:
            return "diagnose", [f"touches {p}: outside what the drill may change" for p in bad]
        return "pr", []
    for f in files:
        p = f["path"]
        if f["binary"]:
            reasons.append(f"binary file {p}")
        if f["status"] == "D":
            reasons.append(f"deletes {p}")
        for q in {p, f.get("old_path") or p}:
            if q in DENY:
                reasons.append("touches its own guardrails")
            elif not ALLOW_RE.match(q):
                reasons.append(f"touches {q}: outside what the fixer may change")
        if re.match(r"^pipeline/test_[a-z0-9_]+\.py$", p) and f["removed_lines"]:
            reasons.append(f"removes lines from {p}: a test may be weakened")
        if any(SENSITIVE_RE.search(x) for x in f["added_lines"] + f["removed_lines"]):
            reasons.append(f"touches billing/auth/secrets/deletes in {p}: tier 3")
    if len(files) > MAX_FILES:
        reasons.append(f"{len(files)} files changed (max {MAX_FILES})")
    n = sum(len(f["added_lines"]) + len(f["removed_lines"]) for f in files)
    if n > MAX_LINES:
        reasons.append(f"{n} lines changed (max {MAX_LINES})")
    if str(tests_rc).strip() != "0":
        reasons.append("tests fail with the change in a clean job")
    reasons = list(dict.fromkeys(reasons))
    return ("diagnose" if reasons else "pr"), reasons


def ascii_clean(s, n):
    t = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    t = _URL_RE.sub("", t)
    return " ".join(t.split())[:n]


def neutral(s, n):
    return _URL_RE.sub("<url>", str(s or "").replace("```", "'''"))[:n]


def slug(incident):
    return re.sub(r"[^a-z0-9]+", "-", str(incident or "").lower()).strip("-")[:40]


def branch(incident, run_id):
    b = f"fixer/{slug(incident)}-{re.sub(r'[^0-9]', '', str(run_id or ''))[:15]}"
    if not BRANCH_RE.match(b):
        print(f"refusing branch name {b!r}", file=sys.stderr)
        sys.exit(2)
    return b


def _read_obj(path):
    try:
        p = Path(path)
        if p.stat().st_size > OUT_MAX_BYTES:
            return {}
        d = json.loads(p.read_text())
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _read_text(path):
    try:
        return Path(path).read_text(errors="replace")
    except OSError:
        return ""


def cmd_check(a):
    if a.mode not in MODES or not INCIDENT_RE.match(a.incident or ""):
        print("bad --mode or --incident", file=sys.stderr)
        return 2
    br = branch(a.incident, a.run_id)
    files = parse_patch(_read_text(a.patch))
    v, reasons = verdict(files, a.mode, a.tests_rc)
    out = _read_obj(a.out_json)
    summary, diagnosis = out.get("summary") or "", out.get("diagnosis") or ""
    if a.mode == "drill-pr":
        title = "[fixer drill] close without merging"
    else:
        title = "fixer: " + (ascii_clean(summary, 90) or ascii_clean(f"fix for {a.incident}", 90))
    outdir = Path(a.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "gate.json").write_text(json.dumps({"verdict": v, "reasons": reasons, "branch": br, "title": title}))
    (outdir / "title.txt").write_text(title)
    (outdir / "commit.txt").write_text(f"{title}\n\nIncident: {a.incident}\nRun: {a.run_url}\n")
    log_tail = "\n".join(_read_text(a.tests_log).splitlines()[-40:])
    passed = "paths allowed, guardrail files untouched, no billing/auth/secret/delete lines, no removed test lines, size within limits, tests green"
    (outdir / "body.md").write_text(
        f"Incident `{a.incident}`. Run: {a.run_url}\n\n"
        f"**Gate:** {passed if v == 'pr' else 'refused: ' + '; '.join(reasons)}.\n\n"
        "### Diagnosis (model output, unverified)\n```text\n" + neutral(diagnosis, 2000) + "\n```\n\n"
        "### Tests (clean job, no secrets)\n```text\n" + neutral(log_tail, 4000) + "\n```\n\n"
        "### Before you merge\n"
        "- A push touching pipeline/**, Dockerfile or requirements-ci.txt redeploys the Fly worker: check the queue is "
        "idle first (HANDOFF, the read-only idle check).\n"
        "- Written by the fixer agent. It never merges; closing this is safe.\n")
    if a.github_output:
        with open(a.github_output, "a") as f:
            f.write(f"verdict={v}\nbranch={br}\n")
    print(f"verdict={v} branch={br}")
    for r in reasons:
        print("reason:", r)
    return 0


def cmd_collect(a):
    outdir = Path(a.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    patch = ""
    if a.mode in ("fix", "drill-pr"):
        subprocess.run(["git", "add", "-A", "--", ".", ":!.fixer"], check=False)
        patch = subprocess.run(["git", "diff", "--cached", "--binary"], capture_output=True, text=True, check=False).stdout
    (outdir / "patch.diff").write_text(patch)
    out = _read_obj(".fixer/out.json")
    if not out:
        out = {"summary": "", "diagnosis": "the model wrote no valid .fixer/out.json", "changed": False}
    (outdir / "out.json").write_text(json.dumps(out))
    (outdir / "mode.txt").write_text(a.mode)
    return 0


def cmd_drill_patch(a):
    from datetime import datetime, timezone
    Path("pipeline").mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    Path("pipeline/fixer_drill.txt").write_text(f"fixer drill {stamp}: close the PR without merging.\n")
    Path(".fixer").mkdir(exist_ok=True)
    Path(".fixer/out.json").write_text(json.dumps({
        "summary": "fire drill: PR plumbing",
        "diagnosis": ("This pull request exists only to prove the fixer can push a fixer/* branch and open a PR. "
                      "Close it without merging."),
        "tier": 2, "changed": True, "confidence": "high", "tests_run": []}))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    for name in ("patch", "out-json", "tests-log", "tests-rc", "mode", "incident", "run-id", "run-url", "outdir"):
        c.add_argument("--" + name, required=True)
    c.add_argument("--github-output", default="")
    k = sub.add_parser("collect")
    k.add_argument("--mode", required=True, choices=MODES)
    k.add_argument("--outdir", required=True)
    sub.add_parser("drill-patch")
    a = ap.parse_args(argv)
    return {"check": cmd_check, "collect": cmd_collect, "drill-patch": cmd_drill_patch}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
