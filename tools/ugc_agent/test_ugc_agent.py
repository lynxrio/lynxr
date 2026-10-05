#!/usr/bin/env python3
"""Offline tests for the UGC answer agent. No network, no API key, nothing written inside the repo.

    ./venv/bin/python tools/ugc_agent/test_ugc_agent.py     # last line: ALL CHECKS PASSED

Fixtures are built in a temp directory by copying the real pages the agent depends on.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import copy
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
REPO = HERE.parent.parent

import agent as A  # noqa: E402
import gate as G  # noqa: E402
import render as R  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("ok    " if cond else "FAIL  ") + name + ((" -- " + str(detail)[:300]) if (detail and not cond) else ""))
    if not cond:
        FAILS.append(name)


def make_fixture(tmp):
    """Copy the real pages and the toolbox into tmp, then reset to a clean 'no agent articles yet' state:
    the hand-written sample pending, every agent page gone, the generated regions empty."""
    root = pathlib.Path(tmp) / "site"
    root.mkdir()
    for d in ("blog", "glossary", "faq", "about", "how-it-works", "pricing", "what-is-a-video-format",
              "turn-a-video-into-a-script", "short-form-script-structure", "how-to-write-a-hook",
              "ugc-script-template", "remake-a-viral-video", "privacy", "terms", "refunds", "accessibility"):
        shutil.copytree(REPO / d, root / d, ignore=shutil.ignore_patterns("UNUSED"))
    for f in ("index.html", "404.html", "sitemap.xml", "llms.txt"):
        shutil.copy2(REPO / f, root / f)
    shutil.copytree(REPO / "tools/ugc_agent", root / "tools/ugc_agent", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy2(REPO / "tools/check_stamp.py", root / "tools/check_stamp.py")
    arts = root / "tools/ugc_agent/articles"
    sample = json.loads((arts / "ugc-script-for-skincare.json").read_text(encoding="utf-8"))
    for f in arts.glob("*.json"):
        slug = json.loads(f.read_text(encoding="utf-8"))["slug"]
        shutil.rmtree(root / "blog" / slug, ignore_errors=True)
        f.unlink()
    for d in (root / "faq").glob("ugc-*"):
        shutil.rmtree(d)
    sample.update({"status": "pending", "published": None})
    (arts / "ugc-script-for-skincare.json").write_text(json.dumps(sample, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (root / "tools/ugc_agent/attempts.json").write_text("{}\n", encoding="utf-8")
    (root / "tools/ugc_agent/questions-auto.json").write_text("[]\n", encoding="utf-8")
    R.render_all(root)
    return root


def load_sample(root):
    return json.loads((root / "tools/ugc_agent/articles/ugc-script-for-skincare.json").read_text(encoding="utf-8"))


def put_article(root, art):
    p = root / "tools/ugc_agent/articles" / (art["slug"] + ".json")
    p.write_text(json.dumps(art, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def problems_for(root, art, **kw):
    arts = R.load_articles(root)
    return G.article_problems(root, art, arts, **kw)


def has(probs, needle):
    return any(needle in p for p in probs)


def first_block(art, kind, section=None):
    secs = art["sections"] if section is None else [art["sections"][section]]
    for s in secs:
        for b in s["blocks"]:
            if b["kind"] == kind:
                return b
    raise KeyError(kind)


PY = sys.executable
SCORES5 = {"answers_first": 5, "useful_specific": 5, "ugc_focus": 5, "originality": 4, "voice": 5}


def sh(args, cwd, env=None):
    e = dict(os.environ, UGC_AGENT_TODAY="2026-10-06", PYTHONDONTWRITEBYTECODE="1", GIT_TERMINAL_PROMPT="0")
    e.pop("ANTHROPIC_API_KEY", None)
    if env:
        e.update(env)
    return subprocess.run(args, cwd=str(cwd), env=e, capture_output=True, text=True)


def git(args, cwd):
    return sh(["git", "-c", "user.name=t", "-c", "user.email=t@example.com"] + args, cwd)


def routine_site(tmp, protect_main=False, questions=None):
    """A throwaway git repo (the fixture site) with a bare origin, the way the cloud routine's clone looks."""
    work = make_fixture(tmp)
    # the stub writer's text is the sample's; take the sample out of the fixture so it is not its own duplicate
    sample_json = work / "tools/ugc_agent/articles/ugc-script-for-skincare.json"
    shutil.move(str(sample_json), str(pathlib.Path(tmp) / "sample-content.json"))
    if questions is not None:
        qp = work / "tools/ugc_agent/questions.json"
        qp.write_text(json.dumps(json.loads(qp.read_text(encoding="utf-8"))[:questions], indent=2) + "\n", encoding="utf-8")
    origin = pathlib.Path(tmp) / "origin.git"
    git(["init", "-q", "--bare", "-b", "main", str(origin)], tmp)
    git(["init", "-q", "-b", "main"], work)
    git(["add", "-A"], work)
    git(["commit", "-q", "-m", "initial"], work)
    git(["remote", "add", "origin", str(origin)], work)
    git(["push", "-q", "origin", "main"], work)
    if protect_main:
        hook = origin / "hooks" / "pre-receive"
        hook.write_text('#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then\n'
                        '    echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2\n    exit 1\n  fi\ndone\n')
        hook.chmod(0o755)
    return work, origin


def stub_candidate(work, out, slug, mutate=None):
    """The stub writer: the hand-written sample's content under this question's slug."""
    s = json.loads((pathlib.Path(work).parent / "sample-content.json").read_text(encoding="utf-8"))
    cand = {k: copy.deepcopy(s[k]) for k in ("description", "short_answer", "sections")}
    if mutate:
        mutate(cand)
    p = pathlib.Path(out) / "candidates" / (slug + ".json")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cand, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def stub_review(out, slug, verdict="pass", issues=()):
    """The stub reviewer: writes a verdict file in the reviewer schema."""
    p = pathlib.Path(out) / "verdicts" / (slug + ".json")
    p.parent.mkdir(parents=True, exist_ok=True)
    v = {"verdict": verdict, "scores": dict(SCORES5), "blocking_issues": list(issues), "revision_notes": []}
    p.write_text(json.dumps(v), encoding="utf-8")
    return p


def routine_tests():
    # ---- the API path is gone
    check("no API: llm.py and requirements.txt are deleted", not (HERE / "llm.py").exists() and not (HERE / "requirements.txt").exists())
    src = "\n".join((HERE / f).read_text(encoding="utf-8") for f in ("agent.py", "gate.py", "render.py", "schema.py"))
    check("no API: no anthropic import, key or messages call in the toolbox",
          not re.search(r"import anthropic|from anthropic|messages\.create|ANTHROPIC_API_KEY|api\.anthropic", src))
    wf = (REPO / ".github/workflows/ugc-agent.yml").read_text(encoding="utf-8")
    check("no API: the workflow has no schedule, secret, API key or UGC_AGENT_ENABLED",
          not re.search(r"ANTHROPIC|UGC_AGENT_ENABLED|schedule:|cron:|secrets\.", wf) and "withdraw" in wf and "publish-check" in wf)
    rt = (HERE / "ROUTINE.md").read_text(encoding="utf-8")
    check("routine: ROUTINE.md covers next, check, judge-context, publish, fail, render, gate, check_stamp, commit.sh, PR and issue",
          all(s in rt for s in ("agent.py next", "agent.py check", "judge-context", "agent.py publish", "agent.py fail", "agent.py render",
                                "agent.py gate", "check_stamp.py", "commit.sh", "gh pr create", "gh issue create", "claude/ugc-", "SEPARATE subagent")))

    # ---- A: stub writer + stub reviewer, one article passes, one fails, then render/gate/stamp/finish/commit.sh
    tmp = tempfile.TemporaryDirectory()
    work, origin = routine_site(tmp.name)
    agent = [PY, str(work / "tools/ugc_agent/agent.py")]
    out = pathlib.Path(tmp.name) / "out"
    initial = git(["rev-parse", "HEAD"], work).stdout.strip()
    r = sh(agent + ["next", "--out", str(out), "--n", "2"], work)
    summ = json.loads(r.stdout) if r.returncode == 0 else {"briefs": []}
    check("routine: next exits 0 and writes two briefs", r.returncode == 0 and len(summ["briefs"]) == 2 and all(pathlib.Path(b["brief"]).is_file() for b in summ["briefs"]), r.stdout + r.stderr)
    good, bad = summ["briefs"][0]["slug"], summ["briefs"][1]["slug"]
    brief = json.loads(pathlib.Path(summ["briefs"][0]["brief"]).read_text(encoding="utf-8"))
    check("routine: a brief holds the question, schema, link inventory, hooks, related pages and the paths",
          all(k in brief for k in ("question", "slug", "topic", "schema", "link_inventory", "existing_hooks", "same_topic_answers",
                                   "topic_pillars", "candidate_path", "verdict_path", "reference_answer")) and brief["link_inventory"], list(brief))
    cp = stub_candidate(work, out, good)
    r = sh(agent + ["check", str(cp)], work)
    check("routine: check passes the stub writer's article", r.returncode == 0 and "PASS" in r.stdout, r.stdout)
    r = sh(agent + ["judge-context", str(cp)], work)
    jc = json.loads(r.stdout) if r.returncode == 0 else {}
    check("routine: judge-context prints the article with link targets and the site page list",
          r.returncode == 0 and "[link to:" in jc.get("answer", "") and jc.get("links_used") and jc.get("site_pages", {}).get("guides")
          and "Already verified" in jc.get("link_check", ""), r.stdout[:200] + r.stderr)
    vp = stub_review(out, good, "revise", ["a blocking issue"])
    r = sh(agent + ["publish", str(cp), "--verdict", str(vp)], work)
    check("routine: publish refuses a revise verdict and writes nothing",
          r.returncode == 1 and "REFUSED" in r.stdout and not (work / "tools/ugc_agent/articles" / (good + ".json")).exists(), r.stdout)
    low = stub_review(out, good, "pass")
    v = json.loads(low.read_text()); v["scores"]["voice"] = 3; low.write_text(json.dumps(v))
    r = sh(agent + ["publish", str(cp), "--verdict", str(low)], work)
    check("routine: publish refuses a pass verdict with a score under 4", r.returncode == 1 and "REFUSED" in r.stdout, r.stdout)
    vp = stub_review(out, good, "pass")
    r = sh(agent + ["publish", str(cp), "--verdict", str(vp)], work)
    art_path = work / "tools/ugc_agent/articles" / (good + ".json")
    art = json.loads(art_path.read_text(encoding="utf-8")) if art_path.exists() else {}
    check("routine: publish writes the article live with the verdict scores",
          r.returncode == 0 and art.get("status") == "live" and art.get("published") == "2026-10-06" and art.get("judge", {}).get("scores") == SCORES5, r.stdout)
    att = json.loads((work / "tools/ugc_agent/attempts.json").read_text())
    check("routine: publish records the attempt", any(v.get("published") == "2026-10-06" for v in att.values()), att)
    cb = stub_candidate(work, out, bad)
    r = sh(agent + ["check", str(cb)], work)
    check("routine: a second article that repeats the first fails check (in-run overlap and hook)",
          r.returncode == 1 and "originality" in r.stdout, r.stdout)
    r2 = sh(agent + ["check", str(cb)], work)
    check("routine: the same candidate still fails on re-check", r2.returncode == 1)
    vbad = stub_review(out, bad, "pass")
    r = sh(agent + ["publish", str(cb), "--verdict", str(vbad)], work)
    check("routine: publish refuses a candidate that fails the gate, even with a pass verdict",
          r.returncode == 1 and "code gate" in r.stdout and not (work / "tools/ugc_agent/articles" / (bad + ".json")).exists(), r.stdout)
    r = sh(agent + ["fail", bad, "--reason", "originality: hook repeats an existing line"], work)
    att = json.loads((work / "tools/ugc_agent/attempts.json").read_text())
    check("routine: fail records the attempt", r.returncode == 0 and any(v.get("fails") == 1 for v in att.values()), r.stdout)
    r = sh(agent + ["check", str(out / "candidates/not-a-question.json")], work)
    check("routine: check on a missing candidate is a usage error (exit 2)", r.returncode == 2, r.stdout)
    bad_shape = pathlib.Path(tmp.name) / "shape" / (good + ".json")
    bad_shape.parent.mkdir()
    bad_shape.write_text(json.dumps({"description": "x", "short_answer": "y", "sections": [{"heading": "h"}]}))
    r = sh(agent + ["check", str(bad_shape)], work)
    check("routine: a candidate in the wrong shape fails with schema problems", r.returncode in (1, 2) and ("schema" in r.stdout or "already" in r.stdout), r.stdout)
    r = sh(agent + ["render"], work)
    check("routine: render writes the article page, topic page and regions", r.returncode == 0 and ("blog/%s/index.html" % good) in r.stdout and "sitemap.xml" in r.stdout, r.stdout)
    r = sh(agent + ["gate"], work)
    check("routine: the site gate is clean", r.returncode == 0 and "site gate ok" in r.stdout, r.stdout)
    r = sh([PY, "tools/check_stamp.py"], work)
    check("routine: check_stamp.py is ok", r.returncode == 0 and r.stdout.startswith("ok"), r.stdout + r.stderr)
    r = sh(agent + ["finish", "--out", str(out)], work, {"UGC_AGENT_MIN_PUBLISH": "2"})
    check("routine: finish exits 3 when fewer than the minimum were published, with an empty manifest",
          r.returncode == 3 and (out / "manifest.txt").read_text() == "", r.stdout)
    r = sh(agent + ["finish", "--out", str(out)], work)
    mf = (out / "manifest.txt").read_text().split()
    subj = (out / "commit-subject.txt").read_text().strip()
    check("routine: finish writes an allowlisted manifest and the commit subject",
          r.returncode == 0 and mf and all(A.ALLOW_PATH.match(p) for p in mf) and ("blog/%s/index.html" % good) in mf
          and "tools/ugc_agent/attempts.json" in mf and subj == "ugc-agent: articles 2026-10-06 (1): %s" % good, (mf, subj))
    r = sh(["bash", str(work / "tools/ugc_agent/commit.sh"), str(out / "manifest.txt"), str(out / "commit-subject.txt")], work,
           {"UGC_FALLBACK_BRANCH": "claude/ugc-test"})
    files = git(["show", "--name-only", "--format=", "HEAD"], work).stdout.split()
    head = git(["rev-parse", "HEAD"], work).stdout.strip()
    omain = sh(["git", "--git-dir", str(origin), "rev-parse", "main"], work).stdout.strip()
    check("routine: commit.sh pushes one commit to main touching only allowlisted files",
          r.returncode == 0 and head != initial and omain == head and files and all(A.ALLOW_PATH.match(f) for f in files)
          and git(["log", "-1", "--format=%s"], work).stdout.strip() == subj and not (out / "pushed-branch.txt").exists(), (r.stdout, r.stderr, files))
    check("routine: nothing else is left changed after the commit", git(["status", "--porcelain"], work).stdout.strip() == "")
    # the queue now skips the published question and remembers the failure
    r = sh(agent + ["next", "--out", str(out), "--n", "3"], work)
    again = [b["slug"] for b in json.loads(r.stdout)["briefs"]]
    check("routine: next does not pick the published question again", good not in again, again)
    r = sh(agent + ["next", "--out", str(out), "--n", "3"], work)
    check("routine: next stops when a commit for today already exists", json.loads(r.stdout).get("status") == "already ran today", r.stdout)
    tmp.cleanup()

    # ---- B: nothing passes -> nothing is committed; four failures retire a question; add-questions; low and empty queues
    tmp = tempfile.TemporaryDirectory()
    work, origin = routine_site(tmp.name)
    agent = [PY, str(work / "tools/ugc_agent/agent.py")]
    out = pathlib.Path(tmp.name) / "out"
    initial = git(["rev-parse", "HEAD"], work).stdout.strip()
    r = sh(agent + ["next", "--out", str(out), "--n", "1"], work)
    slug = json.loads(r.stdout)["briefs"][0]["slug"]
    cp = stub_candidate(work, out, slug, lambda c: c["sections"][0]["blocks"][0].__setitem__("text", c["sections"][0]["blocks"][0]["text"] + " It takes 3 days."))
    r = sh(agent + ["check", str(cp)], work)
    check("routine B: a candidate with a figure fails check", r.returncode == 1 and "a digit" in r.stdout, r.stdout)
    r = sh(agent + ["publish", str(cp), "--verdict", str(stub_review(out, slug))], work)
    check("routine B: publish refuses it", r.returncode == 1 and not (work / "tools/ugc_agent/articles" / (slug + ".json")).exists())
    sh(agent + ["fail", slug, "--reason", "a digit"], work)
    r = sh(agent + ["render"], work)
    r2 = sh(agent + ["gate"], work)
    r3 = sh(agent + ["finish", "--out", str(out)], work)
    check("routine B: render and gate are clean; finish exits 3 with a manifest of only the attempts state",
          "no changes" in r.stdout and r2.returncode == 0 and r3.returncode == 3
          and (out / "manifest.txt").read_text().split() == ["tools/ugc_agent/attempts.json"], (r.stdout, r3.stdout))
    r = sh(["bash", str(work / "tools/ugc_agent/commit.sh"), str(out / "manifest.txt"), str(out / "commit-subject.txt")], work)
    changed = git(["show", "--name-only", "--format=", "HEAD"], work).stdout.split()
    check("routine B: commit.sh commits only attempts.json, so the next run moves past the failed question",
          r.returncode == 0 and git(["rev-parse", "HEAD"], work).stdout.strip() != initial and changed == ["tools/ugc_agent/attempts.json"]
          and git(["status", "--porcelain"], work).stdout.strip() == "", (r.stdout + r.stderr, changed))
    check("routine B: the attempts-only commit reached origin main",
          git(["rev-parse", "HEAD"], work).stdout.strip() == git(["rev-parse", "main"], origin).stdout.strip())
    for _ in range(3):
        sh(agent + ["fail", slug, "--reason", "again"], work)
    r = sh(agent + ["next", "--out", str(out), "--n", "3", "--force"], work)
    check("routine B: four failures retire a question", slug not in [b["slug"] for b in json.loads(r.stdout)["briefs"]], r.stdout)
    qfile = pathlib.Path(tmp.name) / "new-questions.json"
    qfile.write_text(json.dumps({"questions": [
        {"topic": "ugc-filming", "question": "How do you plan a UGC shoot day?", "slug": "plan-a-ugc-shoot-day", "target_query": "plan a ugc shoot", "angle": "what to do"},
        {"topic": "ugc-filming", "question": "How do you plan a UGC shoot day?", "slug": "plan-a-ugc-shoot-day-again", "target_query": "x", "angle": "dupe"},
        {"topic": "ugc-filming", "question": "How much do you earn from UGC?", "slug": "earn-from-ugc", "target_query": "x", "angle": "off limits"}]}))
    r = sh(agent + ["add-questions", str(qfile)], work)
    auto = json.loads((work / "tools/ugc_agent/questions-auto.json").read_text())
    check("routine B: add-questions validates, dedupes and appends", r.returncode == 0 and "1 accepted, 2 rejected" in r.stdout and len(auto) == 1 and auto[0]["id"] == "a001", r.stdout)
    qfile.write_text(json.dumps({"questions": [{"topic": "x"}]}))
    r = sh(agent + ["add-questions", str(qfile)], work)
    check("routine B: add-questions rejects a file in the wrong shape (exit 2)", r.returncode == 2, r.stdout)
    tmp.cleanup()

    tmp = tempfile.TemporaryDirectory()
    work, origin = routine_site(tmp.name, questions=5)
    agent = [PY, str(work / "tools/ugc_agent/agent.py")]
    r = sh(agent + ["next", "--out", str(pathlib.Path(tmp.name) / "out"), "--n", "1"], work)
    s = json.loads(r.stdout)
    rb = pathlib.Path(s["replenish_brief"]) if s.get("replenish_brief") else None
    check("routine C: a short queue is flagged and a replenish brief is written",
          s.get("queue_low") is True and rb and rb.is_file() and json.loads(rb.read_text())["topics_with_room"], r.stdout)
    tmp.cleanup()
    tmp = tempfile.TemporaryDirectory()
    work, origin = routine_site(tmp.name, questions=0)
    agent = [PY, str(work / "tools/ugc_agent/agent.py")]
    r = sh(agent + ["next", "--out", str(pathlib.Path(tmp.name) / "out")], work)
    check("routine C: an empty queue exits 4 and still writes the replenish brief", r.returncode == 4 and (pathlib.Path(tmp.name) / "out/replenish-brief.json").is_file(), r.stdout)
    tmp.cleanup()

    # ---- D: main is protected -> the same commit goes to claude/ugc-<date>, ready for a pull request
    tmp = tempfile.TemporaryDirectory()
    work, origin = routine_site(tmp.name, protect_main=True)
    agent = [PY, str(work / "tools/ugc_agent/agent.py")]
    out = pathlib.Path(tmp.name) / "out"
    initial = git(["rev-parse", "HEAD"], work).stdout.strip()
    r = sh(agent + ["next", "--out", str(out), "--n", "1"], work)
    slug = json.loads(r.stdout)["briefs"][0]["slug"]
    cp = stub_candidate(work, out, slug)
    ok = (sh(agent + ["check", str(cp)], work).returncode == 0
          and sh(agent + ["publish", str(cp), "--verdict", str(stub_review(out, slug))], work).returncode == 0
          and sh(agent + ["render"], work).returncode == 0 and sh(agent + ["gate"], work).returncode == 0
          and sh(agent + ["finish", "--out", str(out)], work).returncode == 0)
    r = sh(["bash", str(work / "tools/ugc_agent/commit.sh"), str(out / "manifest.txt"), str(out / "commit-subject.txt")], work,
           {"UGC_FALLBACK_BRANCH": "claude/ugc-2026-10-06"})
    head = git(["rev-parse", "HEAD"], work).stdout.strip()
    omain = sh(["git", "--git-dir", str(origin), "rev-parse", "main"], work).stdout.strip()
    obranch = sh(["git", "--git-dir", str(origin), "rev-parse", "claude/ugc-2026-10-06"], work).stdout.strip()
    check("routine D: a protected main refuses the push, so the same commit lands on claude/ugc-<date>",
          ok and r.returncode == 0 and omain == initial and obranch == head
          and (out / "pushed-branch.txt").read_text().strip() == "claude/ugc-2026-10-06", (r.stdout, r.stderr))
    r = sh(["bash", str(work / "tools/ugc_agent/commit.sh"), str(out / "manifest.txt"), str(out / "commit-subject.txt")], work)
    check("routine D: without a fallback branch a refused push exits 1", r.returncode == 1 or "nothing" in r.stdout, r.stdout)
    tmp.cleanup()


def main():
    tmp = tempfile.TemporaryDirectory()
    root = make_fixture(tmp.name)
    base = load_sample(root)

    # ---- the hand-written sample passes the gate, and the untouched fixture passes the site gate
    check("baseline: the sample passes the article gate", problems_for(root, base) == [], problems_for(root, base))
    check("baseline: untouched site gate is clean", G.site_problems(root) == [], G.site_problems(root))
    check("baseline: render of an empty queue changes nothing", R.render_all(root) == set())

    # ---- escaping and link conversion
    h = R.to_html("a <script>x</script> & [the hook](/glossary/#hook) for UGC")
    check("escape: <script> is escaped", "<script>" not in h and "&lt;script&gt;" in h, h)
    check("escape: link and UGC capitals are rebuilt", '<a href="/glossary/#hook">the hook</a>' in h and '<span class="acr">UGC</span>' in h, h)
    check("escape: href is never wrapped in the UGC span", "UGC" not in re.findall(r'href="([^"]*)"', R.to_html("[UGC](/glossary/#ugc)"))[0])
    check("plain: link markup is stripped for meta and JSON-LD", R.plain("see [the hook](/glossary/#hook) now") == "see the hook now")
    a = copy.deepcopy(base)
    first_block(a, "paragraph")["text"] = "Use <script>alert(1)</script> here."
    check("gate: a < in model text is rejected", has(problems_for(root, a), "banned"))

    # ---- links: external, missing page, bad anchor
    for label, target, needle in (("external", "https://example.com/x", "not an internal"),
                                  ("missing page", "/no-such-page/", "broken internal link"),
                                  ("bad anchor", "/glossary/#no-such-term", "missing anchor")):
        a = copy.deepcopy(base)
        first_block(a, "paragraph", 1)["text"] += " See [more](%s)." % target
        check("links: %s link is rejected" % label, has(problems_for(root, a), needle), problems_for(root, a))
    a = copy.deepcopy(base)
    first_block(a, "paragraph", 1)["text"] += " See [itself](/blog/ugc-script-for-skincare/)."
    check("links: a link to the article itself is rejected", has(problems_for(root, a), "links to itself"))
    a = copy.deepcopy(base)
    for s in a["sections"]:
        for b in s["blocks"]:
            for k in ("text",):
                if b.get(k):
                    b[k] = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", b[k])
    check("links: fewer than three links is rejected", has(problems_for(root, a), "need 3-10"))

    # ---- banned patterns (Step 19.3 to 19.5)
    def banned_case(name, mutate, needle):
        a = copy.deepcopy(base)
        mutate(a)
        pr = problems_for(root, a)
        check("banned: %s" % name, has(pr, needle), pr)

    para = lambda a: first_block(a, "paragraph", 1)
    banned_case("a digit", lambda a: para(a).__setitem__("text", para(a)["text"] + " It takes 3 days."), "a digit")
    banned_case("percent sign", lambda a: para(a).__setitem__("text", para(a)["text"] + " Up 50% more."), "'%'")
    banned_case("dollar sign", lambda a: para(a).__setitem__("text", para(a)["text"] + " It costs $ a lot."), "'$'")
    banned_case("studies show", lambda a: para(a).__setitem__("text", para(a)["text"] + " Studies show it works."), "'studies show'")
    banned_case("YouTube", lambda a: para(a).__setitem__("text", para(a)["text"] + " Post it on YouTube."), "'youtube'")
    banned_case("lynxr", lambda a: para(a).__setitem__("text", para(a)["text"] + " Ask lynxr about it."), "'lynxr'")
    banned_case("exclamation", lambda a: para(a).__setitem__("text", para(a)["text"] + " Great!"), "'!'")
    banned_case("emoji", lambda a: para(a).__setitem__("text", para(a)["text"] + " Nice \U0001F600"), "an emoji")
    banned_case("mid-sentence Acme", lambda a: para(a).__setitem__("text", para(a)["text"] + " Ask for Acme products."), "Acme")
    banned_case("script claim: cures", lambda a: first_block(a, "script")["script_beats"][1].__setitem__("say", "This cures dry skin."), "claim")
    check("proper nouns: sentence-start Because and TikTok pass",
          G.proper_noun_hits("Because it works. Film it for TikTok and Instagram, then post on Reels.") == [])
    check("proper nouns: after a quotation mark passes", G.proper_noun_hits("Say “What happened next” aloud.") == [])
    check("proper nouns: a mid-sentence name fails", G.proper_noun_hits("Ask Acme for a sample.") == ["Acme"])
    check("banned: a clean sentence has no hits", G.banned_hits("Film the texture close to the lens.") == [])

    # ---- shape and artifacts
    a = copy.deepcopy(base)
    a["sections"][0]["heading"] = "Why is this hard"
    check("shape: a heading without ? is rejected", has(problems_for(root, a), "does not end with ?"))
    a = copy.deepcopy(base)
    a["short_answer"] = "Short."
    check("shape: a short answer under 35 words is rejected", has(problems_for(root, a), "short_answer is"))
    a = copy.deepcopy(base)
    a["description"] = "Too short."
    check("shape: a short description is rejected", has(problems_for(root, a), "description is"))
    a = copy.deepcopy(base)
    first_block(a, "script")["script_beats"][0]["part"] = "setup"
    check("script: first beat must be hook", has(problems_for(root, a), "first beat"))
    a = copy.deepcopy(base)
    first_block(a, "table")["table_rows"][0].append("extra")
    check("table: a ragged row is rejected", has(problems_for(root, a), "row's length"))

    # ---- originality: hook duplicate and near duplicate, 12-word overlap
    other = copy.deepcopy(base)
    other.update({"slug": "other-live-answer", "title": "What is a different thing?", "status": "live", "published": "2026-10-01",
                  "question_id": "q999"})
    put_article(root, other)
    hook = first_block(base, "script")["script_beats"][0]["say"]
    cand = copy.deepcopy(base)
    cand.update({"slug": "a-new-answer", "title": "What is yet another thing?", "question_id": "q998"})
    check("originality: the identical hook is rejected", has(problems_for(root, cand), "hook repeats"), problems_for(root, cand))
    cand["sections"][4]["blocks"][1]["script_beats"][0]["say"] = hook.rstrip(".") + " today, honestly."
    check("originality: a near-duplicate hook is rejected", has(problems_for(root, cand), "too close"), problems_for(root, cand))
    cand["sections"][4]["blocks"][1]["script_beats"][0]["say"] = "My cheeks look dull by noon, and I have no idea which step to blame."
    check("originality: a fresh hook passes that check", not has(problems_for(root, cand), "hook"), problems_for(root, cand))
    page = G.parse((root / "ugc-script-template/index.html").read_text(encoding="utf-8"))
    run = " ".join(G.words_of(page.text)[40:55])
    cand2 = copy.deepcopy(cand)
    first_block(cand2, "paragraph", 1)["text"] += " " + run + "."
    check("originality: a 12-word run copied from another page is rejected",
          has(problems_for(root, cand2), "12-word run"), problems_for(root, cand2))
    (root / "tools/ugc_agent/articles/other-live-answer.json").unlink()

    # ---- render: idempotence, FAQ twin, markers, withdraw
    live = copy.deepcopy(base)
    live.update({"status": "live", "published": "2026-10-05"})
    put_article(root, live)
    second = copy.deepcopy(base)
    second.update({"slug": "second-answer", "title": "What goes in a UGC script for an app?", "status": "live",
                   "published": "2026-10-06", "question_id": "q032",
                   "description": "A second description that is unique to this fixture and long enough to be a plausible meta description for a page."})
    put_article(root, second)
    originals = {f: (root / f).read_text(encoding="utf-8") for f in ("faq/index.html", "blog/index.html", "sitemap.xml", "llms.txt")}
    ch1 = R.render_all(root)
    ch2 = R.render_all(root)
    check("render: two renders produce identical bytes", ch2 == set() and "faq/ugc-scripts/index.html" in ch1, (ch1, ch2))
    check("render: site gate is clean with live articles", G.site_problems(root) == [], G.site_problems(root))
    for f, text in originals.items():
        new = (root / f).read_text(encoding="utf-8")
        strip = lambda t, f=f: re.sub(r"(<!-- BEGIN UGC AGENT[^\n]*\n)(?:.*?\n)?([ ]*<!-- END UGC AGENT)", r"\1\2", t, flags=re.S)
        check("markers: bytes outside the markers are identical in %s" % f, strip(new) == strip(text) and new != text)
    try:
        R.replace_region("no markers here\n", "<!-- BEGIN UGC AGENT -->", "<!-- END UGC AGENT -->", "x\n")
        check("markers: a missing marker raises", False)
    except ValueError:
        check("markers: a missing marker raises", True)
    try:
        t2 = "<!-- BEGIN UGC AGENT -->\n<!-- END UGC AGENT -->\n" * 2
        R.replace_region(t2, "<!-- BEGIN UGC AGENT -->", "<!-- END UGC AGENT -->", "x\n")
        check("markers: a duplicated marker raises", False)
    except ValueError:
        check("markers: a duplicated marker raises", True)
    topic = (root / "faq/ugc-scripts/index.html").read_text(encoding="utf-8")
    pg = G.parse(topic)
    faq = [json.loads(b) for b in pg.ld if '"FAQPage"' in b][0]
    check("faq: FAQPage text equals the visible answer for every question",
          all(G.norm(q["acceptedAnswer"]["text"]) == dict((G.norm(a), G.norm(b)) for a, b in pg.details)[G.norm(q["name"])]
              for q in faq["mainEntity"]) and len(faq["mainEntity"]) == 2)
    check("faq: the first answer is open", topic.count("<details class=\"lp-q\" open>") == 1)
    broken = topic.replace(R.plain(live["short_answer"])[:40], "TAMPERED " + R.plain(live["short_answer"])[:40], 1)
    (root / "faq/ugc-scripts/index.html").write_text(broken, encoding="utf-8")
    check("faq: a tampered visible answer fails the site gate", has(G.site_problems(root), "FAQPage"), G.site_problems(root))
    (root / "faq/ugc-scripts/index.html").write_text(topic, encoding="utf-8")

    ns = argparse.Namespace(root=str(root), manifest=str(pathlib.Path(tmp.name) / "m.txt"), summary=str(pathlib.Path(tmp.name) / "s.md"),
                            slugs="second-answer", dry_run=False, attempts_cache=None)
    rc = A.cmd_withdraw(ns)
    stub = (root / "blog/second-answer/index.html").read_text(encoding="utf-8")
    topic2 = (root / "faq/ugc-scripts/index.html").read_text(encoding="utf-8")
    check("withdraw: exits 0 and the site gate is clean", rc == 0 and G.site_problems(root) == [], G.site_problems(root))
    check("withdraw: the stub has noindex, canonical to the topic page and a refresh",
          'content="noindex"' in stub and '<link rel="canonical" href="https://lynxr.io/faq/ugc-scripts/">' in stub
          and 'http-equiv="refresh"' in stub)
    check("withdraw: removed from the topic page, sitemap and llms.txt",
          "second-answer" not in topic2 and "second-answer" not in (root / "sitemap.xml").read_text(encoding="utf-8")
          and "second-answer" not in (root / "llms.txt").read_text(encoding="utf-8"))
    mf = (pathlib.Path(tmp.name) / "m.txt").read_text(encoding="utf-8").split()
    check("withdraw: the manifest is allowlisted paths only", mf and all(A.ALLOW_PATH.match(p) for p in mf), mf)
    ns.slugs = "../etc"
    check("withdraw: a bad slug is refused", A.cmd_withdraw(ns) == 1)

    # ---- commit.sh allowlist (the regex and the article-JSON rule, run for real)
    sh = (HERE / "commit.sh").read_text(encoding="utf-8")
    allow = re.search(r"^allow='(.*)'$", sh, re.M).group(1)
    ok_paths = ["blog/ugc-script-for-skincare/index.html", "blog/index.html", "faq/index.html", "faq/ugc-scripts/index.html",
                "sitemap.xml", "llms.txt", "tools/ugc_agent/articles/x.json", "tools/ugc_agent/attempts.json",
                "tools/ugc_agent/questions-auto.json"]
    bad_paths = ["app.css", "creator.js", "index.html", "tools/ugc_agent/questions.json", "tools/ugc_agent/render.py",
                 "blog/../app.css", "robots.txt", ".github/workflows/ugc-agent.yml", "faq/pricing/index.html"]
    check("commit.sh: allowlisted paths match", all(re.match(allow, p) for p in ok_paths))
    check("commit.sh: other paths are refused", not any(re.match(allow, p) for p in bad_paths), [p for p in bad_paths if re.match(allow, p)])
    gitdir = pathlib.Path(tmp.name) / "g"
    gitdir.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=gitdir, check=True)
    subj = gitdir / "subject.txt"
    subj.write_text("ugc-agent: test\n")

    def run_commit(lines):
        m = gitdir / "manifest.txt"
        m.write_text("".join(l + "\n" for l in lines))
        return subprocess.run(["bash", str(HERE / "commit.sh"), str(m), str(subj)], cwd=gitdir, capture_output=True, text=True)
    r = run_commit([])
    check("commit.sh: an empty manifest is a no-op", r.returncode == 0 and "nothing to commit" in r.stdout, r.stdout + r.stderr)
    r = run_commit(["app.css"])
    check("commit.sh: app.css is refused", r.returncode != 0 and "::error::" in r.stdout, r.stdout + r.stderr)
    r = run_commit(["blog/question-hooks/index.html"])
    check("commit.sh: a blog page with no article JSON is refused", r.returncode != 0 and "no tools/ugc_agent/articles/question-hooks.json" in r.stdout, r.stdout)

    # ---- picker
    qs = [{"id": "q%03d" % i, "theme": t, "priority": p, "question": "q%d" % i, "slug": "s%d" % i, "target_query": "", "angle": ""}
          for i, (t, p) in enumerate([("ugc-a", 1), ("ugc-a", 1), ("ugc-a", 2), ("ugc-b", 2), ("ugc-c", 3), ("ugc-b", 1)], 1)]
    picks = A.pick(qs, 3, {}, "2026-10-05", "2026-10-04")
    check("picker: priority order, then round-robin across topics",
          [q["id"] for q in picks] == ["q001", "q006", "q005"], [q["id"] for q in picks])
    check("picker: never two from one topic while another has a candidate", len({q["theme"] for q in picks}) == 3, [q["theme"] for q in picks])
    picks = A.pick(qs, 3, {"q001": {"fails": 1, "last_fail": "2026-10-04"}}, "2026-10-05", "2026-10-04")
    check("picker: yesterday's failure is deprioritised", [q["id"] for q in picks] == ["q002", "q006", "q005"], [q["id"] for q in picks])
    cfg = R.load_config(root)
    arts = {"x": {"slug": "x", "question_id": "q001", "theme": "ugc-a", "status": "live", "published": "2026-10-01"}}
    cfg2 = dict(cfg, topic_cap=1)
    queue = A.build_queue(cfg2, qs, arts, {"q002": {"fails": 4}})
    ids = [q["id"] for q in queue]
    check("picker: a question with an article is skipped", "q001" not in ids, ids)
    check("picker: fails >= 4 is skipped", "q002" not in ids, ids)
    check("picker: a topic at its cap is skipped", "q003" not in ids, ids)
    check("picker: the rest stays queued", ids == ["q004", "q005", "q006"], ids)

    # ---- replenisher acceptance
    qs2 = [{"id": "q001", "theme": "ugc-scripts", "priority": 1, "question": "How do you write a UGC script for an app?", "slug": "ugc-script-for-an-app",
            "target_query": "", "angle": ""}]

    def cand(**kw):
        d = {"topic": "ugc-scripts", "question": "How do you plan a UGC shoot day?", "slug": "plan-a-ugc-shoot-day",
             "target_query": "plan a ugc shoot", "angle": "what to do"}
        d.update(kw)
        return d
    acc = lambda c: A.accept_replenished([c], cfg, qs2, {}, root)[0]
    check("replenish: a good candidate is accepted with id a001 and priority 3",
          len(acc(cand())) == 1 and acc(cand())[0]["id"] == "a001" and acc(cand())[0]["priority"] == 3)
    check("replenish: an unknown topic is rejected", acc(cand(topic="ugc-nope")) == [])
    check("replenish: an existing slug is rejected", acc(cand(slug="ugc-script-for-an-app")) == [])
    check("replenish: a bad slug is rejected", acc(cand(slug="Bad Slug")) == [])
    check("replenish: a question over 70 characters is rejected", acc(cand(question="How do you plan " + "a very long " * 8 + "shoot day?")) == [])
    check("replenish: a question that does not start with a question word is rejected", acc(cand(question="Planning a UGC shoot day")) == [])
    check("replenish: a near-duplicate question is rejected", acc(cand(question="How do you write a UGC script for an app?", slug="x-y")) == [])
    for word in ("How much should you charge for UGC?", "Do you pay tax on UGC?", "Is UGC a legal grey area?", "How do you make money from UGC?",
                 "What are 5 UGC hooks?", "Can UGC cure acne?"):
        check("replenish: %r is rejected by the topic filter" % word, acc(cand(question=word, slug="zz-" + str(abs(hash(word)) % 999).replace("-", ""))) == [])

    # ---- fix 3: banned single words match on word boundaries; phrases stay exact
    check("banned words: 'studying' is not 'study'", G.banned_hits("I am studying how hooks work.") == [])
    check("banned words: 'study' still fails", G.banned_hits("Here is a study of hooks.") == ["'study'"])
    check("banned words: 'researching' is not 'research'", G.banned_hits("Keep researching products you like.") == [])
    check("banned words: 'research' and 'statistics' still fail",
          G.banned_hits("Do research.") == ["'research'"] and G.banned_hits("Quote statistics.") == ["'statistic'"])
    check("banned words: 'unlocked' still fails", G.banned_hits("It unlocked a door.") == ["'unlock'"])
    check("banned words: 'surveyed' and 'algorithmic' are not the banned words",
          G.banned_hits("She surveyed the shelf.") == [] and G.banned_hits("An algorithmic feel.") == [])
    check("banned phrases: multi-word phrases match exactly as before",
          G.banned_hits("According to someone.") == ["'according to'"] and G.banned_hits("Studies show it.") == ["'studies show'"]
          and G.banned_hits("In conclusion, stop.") == ["'in conclusion'"])
    check("banned phrases: 'lynx media' and 'per cent' still fail",
          G.banned_hits("Ask lynx media.") == ["'lynx media'"] and G.banned_hits("One per cent.") == ["'per cent'"])

    # ---- fix 2: square-bracketed placeholders are accepted; unbracketed all-caps words are not
    check("placeholders: [DATE] and [PRODUCT] are not proper nouns", G.proper_noun_hits("Send it on [DATE] with the [PRODUCT] and [NUMBER] of takes.") == [])
    check("placeholders: an unbracketed all-caps word is still flagged", G.proper_noun_hits("Send it on DATE with the PRODUCT.") == ["DATE", "PRODUCT"])
    check("placeholders: they are not figures or banned text", G.banned_hits("Invoice [NUMBER] for [PRODUCT], due [DATE].") == [])
    a = copy.deepcopy(base)
    first_block(a, "paragraph", 1)["text"] += " Invoice [NUMBER] for [PRODUCT], due [DATE]."
    pr = problems_for(root, a)
    check("placeholders: an article using them passes the gate (originality aside: the fixture holds clones of this sample)",
          [x for x in pr if not x.startswith("originality")] == [], pr)
    a = copy.deepcopy(base)
    first_block(a, "paragraph", 1)["text"] += " Invoice for PRODUCT, due DATE."
    check("placeholders: unbracketed all-caps words fail the gate", has(problems_for(root, a), "proper noun"))
    a = copy.deepcopy(base)
    first_block(a, "paragraph", 1)["text"] += " Invoice [product] now."
    check("placeholders: lowercase brackets are malformed link markup", has(problems_for(root, a), "malformed link markup"))
    a = copy.deepcopy(base)
    a["short_answer"] = a["short_answer"] + " Fill in [DATE]."
    check("placeholders: not allowed in short_answer", has(problems_for(root, a), "short_answer contains ["))

    # ---- fix 1a: links are verified in code, including links to articles of the same run
    arts_run = R.load_articles(root)
    runart = copy.deepcopy(base)
    runart.update({"slug": "run-article", "title": "What is a run article?", "status": "pending", "question_id": "q998"})
    arts_run["run-article"] = runart
    cand = copy.deepcopy(base)
    cand.update({"slug": "link-test", "title": "What is a link test?", "question_id": "q997"})
    first_block(cand, "paragraph", 1)["text"] += " See [the run answer](/blog/run-article/) and [its section](/blog/run-article/#why-is-a-skincare-ugc-script)."
    lp, tg, ps = G.link_problems(root, cand, arts_run)
    check("links in code: a link to an article of the same run resolves", lp == [], lp)
    first_block(cand, "paragraph", 1)["text"] += " And [a ghost](/blog/ghost-article/)."
    lp, tg, ps = G.link_problems(root, cand, arts_run)
    check("links in code: a link to nothing is a problem", has(lp, "broken internal link /blog/ghost-article/"), lp)
    cand2 = copy.deepcopy(cand)
    first_block(cand2, "paragraph", 1)["text"] = first_block(cand2, "paragraph", 1)["text"].replace("/blog/ghost-article/", "/blog/run-article/#nope")
    lp, tg, ps = G.link_problems(root, cand2, arts_run)
    check("links in code: a bad anchor on a same-run article is a problem", has(lp, "missing anchor /blog/run-article/#nope"), lp)
    arts_run["run-article"] = dict(runart, status="withdrawn")
    lp, tg, ps = G.link_problems(root, cand, arts_run)
    check("links in code: a link to a withdrawn answer is a problem", has(lp, "withdrawn"), lp)

    # ---- fix 1b: what the judge sees
    q0 = {"id": "q001", "question": "How do you test links?", "target_query": "test links", "theme": "ugc-scripts", "slug": "link-test"}
    arts_run["run-article"] = runart
    ctx_j = A.judge_context(root, cfg, arts_run, q0, "Writing UGC scripts", cand2 if False else base)
    check("judge context: the link check note says validity is already verified", "Already verified in code" in ctx_j["link_check"])
    tg = {l["target"]: l for l in ctx_j["links_used"]}
    check("judge context: links carry target and page title",
          "/blog/brief-to-script/" in tg and tg["/blog/brief-to-script/"]["page_title"] and "brief" in tg["/blog/brief-to-script/"]["page_title"].lower(), ctx_j["links_used"])
    check("judge context: a glossary link carries its term as the section title",
          tg.get("/glossary/#hook", {}).get("section_title"), ctx_j["links_used"])
    check("judge context: the answer text shows each link target and title, not stripped text",
          '[link to: "' in ctx_j["answer"] and "(/blog/brief-to-script/)" in ctx_j["answer"], ctx_j["answer"][:300])
    sp = ctx_j["site_pages"]
    check("judge context: the full site page list covers guides, older posts, glossary, faq topics, product pages, answers",
          all(sp.get(k) for k in ("guides", "older_blog_posts", "glossary_terms", "faq_topics", "product_pages")) and
          any(x["url"] == "/blog/run-article/" for x in sp["answers_in_this_site_or_this_run"]), {k: len(v) for k, v in sp.items()})
    check("judge context: guides include the six guide pages", len(sp["guides"]) == 6, sp["guides"])
    jp = (HERE / "prompts/judge.txt").read_text(encoding="utf-8")
    check("judge prompt: says links are already checked and stays strict on claims",
          "LINKS ARE ALREADY CHECKED" in jp and "Be strict" in jp and "generalisation" in jp)
    sysp = (HERE / "prompts/system.txt").read_text(encoding="utf-8")
    check("writer prompt: steers to reasoned advice and one placeholder style",
          "advice with its reason" in sysp and "[NAME], [PRODUCT], [DATE], [NUMBER]" in sysp)

    routine_tests()

    tmp.cleanup()
    print()
    if FAILS:
        print("%d CHECK(S) FAILED: %s" % (len(FAILS), "; ".join(FAILS)))
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
