#!/usr/bin/env python3
"""The daily UGC answer agent: pick questions, write, gate, judge, render, and hand a manifest to commit.sh.

    agent.py daily [--dry-run] [--attempts-cache FILE]
    agent.py withdraw --slugs a,b
    agent.py render | gate | publish-check | smoke

Common options: --root DIR (default: the repo), --manifest FILE, --summary FILE.
Never run from an interactive Claude session against the real repo with --dry-run omitted:
the real daily run belongs to .github/workflows/ugc-agent.yml.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import random
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zoneinfo

import gate as G
import render as R
from llm import LLM, BudgetExceeded, LLMError

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
Q_START = re.compile(r"^(How|What|Why|When|Should|Can|Do|Does|Is|Are)\b")
Q_BANNED = re.compile(r"\d|\$|%|tax|legal|lawyer|\blaw\b|copyright|trademark|ftc|disclos|visa|llc|insurance|medical|"
                      r"doctor|cure|acne|weight|salary|income|how much|earn|make money", re.I)
ALLOW_PATH = re.compile(r"^(blog/[a-z0-9-]+/index\.html|blog/index\.html|faq/index\.html|faq/ugc-[a-z-]+/index\.html|"
                        r"sitemap\.xml|llms\.txt|tools/ugc_agent/(articles/[a-z0-9-]+\.json|attempts\.json|questions-auto\.json))$")
UA = "lynxr-ugc-agent/1.0 (+https://lynxr.io/)"


# ---------------------------------------------------------------- small helpers

def today_str():
    forced = os.environ.get("UGC_AGENT_TODAY")
    if forced:
        return forced
    return datetime.datetime.now(zoneinfo.ZoneInfo("America/New_York")).date().isoformat()


def clamp(n, lo, hi):
    return max(lo, min(hi, n))


def env_int(name, default):
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


def wjson(path, obj):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def strip_all(x):
    if isinstance(x, str):
        return x.strip()
    if isinstance(x, list):
        return [strip_all(i) for i in x]
    if isinstance(x, dict):
        return {k: strip_all(v) for k, v in x.items()}
    return x


def load_questions(root):
    d = pathlib.Path(root) / "tools/ugc_agent"
    out = R.load_json(d / "questions.json")
    auto = d / "questions-auto.json"
    if auto.is_file():
        out += R.load_json(auto)
    return out


def merge_attempts(base, cache):
    out = {k: dict(v) for k, v in base.items()}
    for k, v in (cache or {}).items():
        cur = out.get(k)
        if not cur:
            out[k] = dict(v)
            continue
        if v.get("fails", 0) > cur.get("fails", 0):
            cur["fails"] = v["fails"]
        if (v.get("last_fail") or "") > (cur.get("last_fail") or ""):
            cur["last_fail"] = v["last_fail"]
            cur["last_error"] = v.get("last_error", "")
    return out


def live_counts(arts):
    c = {}
    for a in arts.values():
        if a["status"] == "live":
            c[a["theme"]] = c.get(a["theme"], 0) + 1
    return c


def build_queue(cfg, questions, arts, attempts):
    """Questions with no live/pending/withdrawn article, fewer than 4 failures, topic below its cap."""
    have_q = {a["question_id"] for a in arts.values() if a["status"] in ("live", "pending", "withdrawn")}
    have_s = {a["slug"] for a in arts.values() if a["status"] in ("live", "pending", "withdrawn")}
    counts = live_counts(arts)
    cap = cfg["topic_cap"]
    return [q for q in questions
            if q["id"] not in have_q and q["slug"] not in have_s
            and attempts.get(q["id"], {}).get("fails", 0) < 4 and counts.get(q["theme"], 0) < cap]


def pick(cands, n, attempts, today, yesterday):
    """Priority order, deprioritising yesterday's and today's failures, round-robin across topics."""
    def key(q):
        lf = attempts.get(q["id"], {}).get("last_fail")
        return (1 if lf in (today, yesterday) else 0, q["priority"], q["id"])
    by_topic = {}
    for q in sorted(cands, key=key):
        by_topic.setdefault(q["theme"], []).append(q)
    picks = []
    while len(picks) < n and any(by_topic.values()):
        heads = sorted((t for t in by_topic if by_topic[t]), key=lambda t: key(by_topic[t][0]))
        for t in heads:
            if len(picks) >= n:
                break
            picks.append(by_topic[t].pop(0))
    return picks


def jaccard_words(a, b):
    A = set(re.findall(r"[a-z0-9]+", a.lower()))
    B = set(re.findall(r"[a-z0-9]+", b.lower()))
    return len(A & B) / len(A | B) if A | B else 0.0


def accept_replenished(cands, cfg, questions, arts, root):
    """Step 21a: keep a model-proposed question only when every rule holds. Returns (accepted, rejected_count)."""
    topics = {t["slug"] for t in cfg["topics"]}
    counts = live_counts(arts)
    slugs = {q["slug"] for q in questions} | set(arts) | (
        {p.name for p in (pathlib.Path(root) / "blog").iterdir() if p.is_dir()} if (pathlib.Path(root) / "blog").is_dir() else set())
    existing = [q["question"] for q in questions]
    nums = [int(q["id"][1:]) for q in questions if re.fullmatch(r"a\d+", q["id"])]
    nxt = max(nums) + 1 if nums else 1
    out = []
    for c in cands:
        q = c.get("question", "").strip()
        s = c.get("slug", "").strip()
        if c.get("topic") not in topics or counts.get(c.get("topic"), 0) >= cfg["topic_cap"]:
            continue
        if s in slugs or not SLUG_RE.match(s):
            continue
        if len(q) > 70 or not Q_START.match(q):
            continue
        if any(jaccard_words(q, e) >= 0.6 for e in existing):
            continue
        if Q_BANNED.search(q) or Q_BANNED.search(c.get("target_query", "")):
            continue
        out.append({"id": "a%03d" % nxt, "theme": c["topic"], "priority": 3, "question": q, "slug": s,
                    "target_query": c.get("target_query", "").strip().lower(), "angle": c.get("angle", "").strip()})
        nxt += 1
        slugs.add(s)
        existing.append(q)
        if len(out) >= 15:
            break
    return out, len(cands) - len(out)


# ---------------------------------------------------------------- payload and text

def h2s(text):
    return [(m.group(1), re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(2))).strip())
            for m in re.finditer(r'<h2[^>]*\bid="([^"]+)"[^>]*>(.*?)</h2>', text, re.S)]


def page_title(root, rel):
    t = (pathlib.Path(root) / rel / "index.html").read_text(encoding="utf-8")
    m = re.search(r"<h1[^>]*>(.*?)</h1>", t, re.S)
    return R.strip_tags(m.group(1)) if m else rel


def link_inventory(root, cfg, arts, q):
    root = pathlib.Path(root)
    inv = []
    agent_slugs = set(arts)
    pages = ["what-is-a-video-format", "turn-a-video-into-a-script", "short-form-script-structure",
             "how-to-write-a-hook", "ugc-script-template", "remake-a-viral-video"]
    if (root / "blog").is_dir():
        pages += ["blog/" + p.name for p in sorted((root / "blog").iterdir())
                  if p.is_dir() and p.name not in agent_slugs and (p / "index.html").is_file()]
    for rel in pages:
        f = root / rel / "index.html"
        if not f.is_file():
            continue
        inv.append({"url": "/%s/" % rel, "title": page_title(root, rel)})
        for i, t in h2s(f.read_text(encoding="utf-8")):
            if i not in R.RESERVED_IDS and i != "start-here":
                inv.append({"url": "/%s/#%s" % (rel, i), "title": t})
    g = root / "glossary" / "index.html"
    if g.is_file():
        for i, t in h2s(g.read_text(encoding="utf-8")):
            if i not in R.RESERVED_IDS:
                inv.append({"url": "/glossary/#%s" % i, "title": t})
    for t in cfg["topics"]:
        if (root / "faq" / t["slug"] / "index.html").is_file():
            inv.append({"url": "/faq/%s/" % t["slug"], "title": t["title"]})
    live = sorted((a for a in arts.values() if a["status"] == "live"), key=lambda a: (a["published"], a["slug"]), reverse=True)
    same = [a for a in live if a["theme"] == q["theme"]]
    for a in same:
        inv.append({"url": "/blog/%s/" % a["slug"], "title": a["title"]})
    for a in [a for a in live if a["theme"] != q["theme"]][:15]:
        inv.append({"url": "/blog/%s/" % a["slug"], "title": a["title"]})
    return inv


def build_payload(root, cfg, arts, q):
    topics = R.topic_map(cfg)
    live = [a for a in arts.values() if a["status"] == "live" and a["theme"] == q["theme"]]
    return {"question": q["question"], "slug": q["slug"], "topic_title": topics[q["theme"]]["title"],
            "target_query": q["target_query"], "angle": q["angle"],
            "existing_hooks": G.existing_hooks(root, arts),
            "same_topic_answers": [{"url": "/blog/%s/" % a["slug"], "title": a["title"]} for a in live],
            "link_inventory": link_inventory(root, cfg, arts, q), "revision": None}


def title_for_target(root, target, arts):
    """(page title, section title or None) for an internal link target, read from the tree or from this run's articles."""
    path, _, frag = target.partition("#")
    am = re.fullmatch(r"/blog/([a-z0-9-]+)/", path)
    if am and am.group(1) in arts:
        a = arts[am.group(1)]
        sec = None
        if frag:
            for s, sid in zip(a["sections"], R.section_ids(a["sections"])):
                if sid == frag:
                    sec = R.plain(s["heading"])
        return a["title"], sec
    f = pathlib.Path(root) / path.lstrip("/") / "index.html"
    if not f.is_file():
        return target, None
    text = f.read_text(encoding="utf-8")
    m = re.search(r"<h1[^>]*>(.*?)</h1>", text, re.S)
    page = R.strip_tags(m.group(1)) if m else path
    sec = None
    if frag:
        m = re.search(r'\bid="%s"[^>]*>(.*?)</' % re.escape(frag), text, re.S)
        if m:
            sec = R.strip_tags(m.group(1))
    return page, sec


def article_text(art, link_title=None):
    """The answer as plain text. With link_title(target) -> (page, section), each link is shown with its target and title."""
    def txt(s):
        if link_title is None:
            return R.plain(s)

        def one(m):
            page, sec = link_title(m.group(2))
            return '%s [link to: "%s"%s (%s)]' % (m.group(1), page, (' > "%s"' % sec) if sec else "", m.group(2))
        return R.LINK_RE.sub(one, s)
    out = [art["title"], "", R.plain(art["short_answer"]), ""]
    for s in art["sections"]:
        out.append("## " + R.plain(s["heading"]))
        for b in s["blocks"]:
            if b["kind"] == "paragraph":
                out.append(txt(b["text"]))
            elif b["kind"] == "list":
                out += ["- " + txt(i) for i in b["items"]]
            elif b["kind"] == "table":
                out.append(" | ".join(b["table_head"]))
                out += [" | ".join(txt(c) for c in r) for r in b["table_rows"]]
            elif b["kind"] == "script":
                out.append(txt(b["script_caption"]))
                out += ["%s: say \"%s\" / do: %s" % (x["part"], txt(x["say"]), txt(x["do"])) for x in b["script_beats"]]
        out.append("")
    return "\n".join(out)


def site_pages(root, cfg, arts):
    """Every existing page the judge may see a link to, grouped. Titles come from the tree."""
    root = pathlib.Path(root)

    def page(rel):
        f = root / rel / "index.html"
        return {"url": "/%s/" % rel if rel else "/", "title": page_title(root, rel)} if f.is_file() else None
    guides = ["what-is-a-video-format", "turn-a-video-into-a-script", "short-form-script-structure",
              "how-to-write-a-hook", "ugc-script-template", "remake-a-viral-video"]
    older = sorted(p.name for p in (root / "blog").iterdir()
                   if p.is_dir() and p.name not in arts and (p / "index.html").is_file()) if (root / "blog").is_dir() else []
    product = ["", "how-it-works", "how-it-works/coach", "pricing", "faq", "about", "blog", "glossary"]
    out = {
        "product_pages": [x for x in (page(r) for r in product) if x],
        "guides": [x for x in (page(r) for r in guides) if x],
        "older_blog_posts": [x for x in (page("blog/" + s) for s in older) if x],
        "faq_topics": [x for x in (page("faq/" + t["slug"]) for t in cfg["topics"]) if x],
        "glossary_terms": [],
        "answers_in_this_site_or_this_run": [{"url": "/blog/%s/" % a["slug"], "title": a["title"]}
                                            for a in arts.values() if a["status"] in ("live", "pending")],
    }
    g = root / "glossary" / "index.html"
    if g.is_file():
        out["glossary_terms"] = [{"url": "/glossary/#%s" % i, "title": tt} for i, tt in h2s(g.read_text(encoding="utf-8"))
                                 if i not in R.RESERVED_IDS]
    return out


def judge_context(root, cfg, arts, q, topic_title, art):
    """What the judge sees: the answer with link targets and titles, the links used, and every page on the site."""
    cache = {}

    def lt(target):
        if target not in cache:
            cache[target] = title_for_target(root, target, arts)
        return cache[target]
    links, seen = [], set()
    for label, text, kind in G.fields(art):
        for m in R.LINK_RE.finditer(text):
            if (m.group(1), m.group(2)) in seen:
                continue
            seen.add((m.group(1), m.group(2)))
            page, sec = lt(m.group(2))
            links.append({"anchor": m.group(1), "target": m.group(2), "page_title": page, "section_title": sec})
    return {"question": q["question"], "topic": topic_title, "target_query": q["target_query"],
            "link_check": "Already verified in code: every link in the answer resolves to an existing page or to another answer in this run. Do not report links as missing.",
            "links_used": links, "site_pages": site_pages(root, cfg, arts),
            "other_published_titles": other_titles(arts, q["slug"]),
            "answer": article_text(art, lt)}


def make_art(q, data):
    d = strip_all(data)
    return {"question_id": q["id"], "slug": q["slug"], "theme": q["theme"], "title": q["question"],
            "description": d["description"], "short_answer": d["short_answer"], "sections": d["sections"],
            "status": "pending", "published": None, "withdrawn": None, "origin": "agent",
            "hooks": [], "model": "", "cost_usd": 0.0, "judge": {}}


def other_titles(arts, slug):
    """Titles of every other published (or pending, or passed-this-run) answer, for the judge's originality check."""
    return [a["title"] for a in arts.values() if a["slug"] != slug and a["status"] in ("live", "pending")]


def judge_passes(j):
    return j["verdict"] == "pass" and all(v >= 4 for v in j["scores"].values()) and not j["blocking_issues"]


# ---------------------------------------------------------------- snapshots / manifest

def snapshot(root):
    root = pathlib.Path(root)
    out = {}
    files = []
    for d in ("blog", "faq", "tools/ugc_agent"):
        if (root / d).is_dir():
            files += [p for p in (root / d).rglob("*") if p.is_file() and "__pycache__" not in p.parts]
    files += [root / "sitemap.xml", root / "llms.txt"]
    for p in files:
        if p.is_file():
            out[p.relative_to(root).as_posix()] = hashlib.sha1(p.read_bytes()).hexdigest()
    return out


def changed_paths(root, before, dry_run):
    root = pathlib.Path(root)
    if not dry_run and (root / ".git").exists():
        r = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=root,
                           capture_output=True, text=True, check=True)
        paths = []
        for line in r.stdout.splitlines():
            if len(line) > 3:
                paths.append(line[3:].strip().strip('"'))
        return sorted(set(paths))
    after = snapshot(root)
    return sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))


def write_outputs(manifest, summary_path, paths, subject, summary_lines, dry_run, root):
    manifest = pathlib.Path(manifest)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text("".join(p + "\n" for p in paths), encoding="utf-8")
    (manifest.parent / "commit-subject.txt").write_text((subject or "") + "\n", encoding="utf-8")
    if summary_path:
        pathlib.Path(summary_path).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(summary_path).write_text("\n".join(summary_lines) + "\n", encoding="utf-8")
    if dry_run:
        out = manifest.parent / "dry-run-out"
        if out.exists():
            shutil.rmtree(out)
        for p in paths:
            src = pathlib.Path(root) / p
            if src.is_file():
                dst = out / p
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)


def default_paths(args):
    base = pathlib.Path(tempfile.gettempdir()) / ("ugc-agent-%d" % os.getpid())
    base.mkdir(parents=True, exist_ok=True)
    return (args.manifest or str(base / "manifest.txt")), (args.summary or str(base / "summary.md"))


def dump_candidate(args, manifest, q, log, result, problems, cost):
    """Dry runs keep every generated article and every judge verdict, passed or failed, beside the manifest."""
    if not args.dry_run:
        return
    d = pathlib.Path(manifest).parent / "candidates"
    wjson(d / (q["slug"] + ".json"), {"question": q, "result": result, "problems": problems,
                                      "cost_usd": round(cost, 4), "attempts": log})


# ---------------------------------------------------------------- daily

def cmd_daily(args):
    root = pathlib.Path(args.root).resolve()
    manifest, summary_path = default_paths(args)
    today = today_str()
    yday = (datetime.date.fromisoformat(today) - datetime.timedelta(days=1)).isoformat()
    S = ["# UGC answer agent: %s%s" % (today, " (dry run)" if args.dry_run else ""), ""]
    if not args.dry_run and (root / ".git").exists():
        try:
            subjects = subprocess.run(["git", "log", "-n", "40", "--format=%s"], cwd=root, capture_output=True,
                                      text=True, check=True).stdout
        except Exception:
            subjects = ""
        if "ugc-agent: articles %s" % today in subjects:
            write_outputs(manifest, summary_path, [], "", S + ["already ran today"], False, root)
            print("already ran today")
            return 0
    cfg = R.load_config(root)
    arts = R.load_articles(root)
    questions = load_questions(root)
    attempts = merge_attempts(R.load_json(root / "tools/ugc_agent/attempts.json"),
                              R.load_json(args.attempts_cache) if args.attempts_cache and pathlib.Path(args.attempts_cache).is_file() else {})
    before = snapshot(root)

    probs = G.site_problems(root)
    if probs:
        S += ["The untouched tree fails the site gate; nothing was built on it:", ""] + ["- " + p for p in probs]
        write_outputs(manifest, summary_path, [], "", S, False, root)
        print("site gate failed on the untouched tree:\n" + "\n".join(probs))
        return 1

    llm = LLM(cfg, root)
    queue = build_queue(cfg, questions, arts, attempts)
    if len(queue) < cfg["replenish_below"]:
        try:
            counts = live_counts(arts)
            ctx = {"topics_with_room": [{"slug": t["slug"], "title": t["title"], "answers_so_far": counts.get(t["slug"], 0),
                                         "room": cfg["topic_cap"] - counts.get(t["slug"], 0)} for t in cfg["topics"]
                                        if counts.get(t["slug"], 0) < cfg["topic_cap"]],
                   "existing_questions": [q["question"] for q in questions]}
            data, info = llm.replenish(ctx)
            acc, rej = accept_replenished(data["questions"], cfg, questions, arts, root)
            if acc:
                auto = root / "tools/ugc_agent/questions-auto.json"
                wjson(auto, R.load_json(auto) + acc)
                questions = load_questions(root)
                queue = build_queue(cfg, questions, arts, attempts)
            S.append("Replenisher: %d accepted, %d rejected, $%.3f." % (len(acc), rej, info["cost"]))
        except (LLMError, BudgetExceeded, KeyError) as e:
            S.append("Replenisher failed (not fatal): %s" % e)
    if not queue:
        S.append("queue empty: add questions or a topic")
        write_outputs(manifest, summary_path, [], "", S, False, root)
        print("queue empty — add questions or a topic")
        return 1

    per_day = clamp(env_int("UGC_AGENT_PER_DAY", cfg["per_day_default"]), 1, 3)
    min_pass = clamp(env_int("UGC_AGENT_MIN_PASS", cfg["min_pass_default"]), 1, per_day)
    picks = pick(queue, per_day, attempts, today, yday)
    S.append("Picked %d of %d queued: %s. Need %d to pass." % (len(picks), len(queue), ", ".join(q["slug"] for q in picks), min_pass))

    gctx = G.Context(root)
    ch = R.chrome(root, cfg)
    passed, failures = [], []
    run_arts = dict(arts)
    stopped = False
    for q in picks:
        if stopped:
            break
        cost = 0.0
        res = {"q": q, "problems": [], "art": None}
        log = []
        try:
            payload = build_payload(root, cfg, run_arts, q)
            topic_title = payload["topic_title"]
            data, info = llm.generate(payload)
            cost += info["cost"]
            model = info["model"]
            art = make_art(q, data)
            problems = G.article_problems(root, art, run_arts, gctx, cfg, ch)
            entry = {"stage": "generate", "article": data, "gate_problems": problems, "judge": None, "cost": info["cost"]}
            log.append(entry)
            issues, verdict = [], None
            if not problems:
                j, ji = llm.judge(judge_context(root, cfg, run_arts, q, topic_title, art))
                cost += ji["cost"]
                entry["judge"], entry["cost"] = j, entry["cost"] + ji["cost"]
                if judge_passes(j):
                    verdict = j
                else:
                    issues = ["judge: " + x for x in j["blocking_issues"] + j["revision_notes"]]
                    if not issues:
                        issues = ["judge: scores below 4: %s" % json.dumps(j["scores"])]
            if not problems and verdict is None or problems:
                data2, info2 = llm.revise(payload, data, problems + issues)
                cost += info2["cost"]
                model = info2["model"]
                art = make_art(q, data2)
                problems = G.article_problems(root, art, run_arts, gctx, cfg, ch)
                entry = {"stage": "revise", "article": data2, "gate_problems": problems, "judge": None, "cost": info2["cost"]}
                log.append(entry)
                if not problems:
                    j, ji = llm.judge(judge_context(root, cfg, run_arts, q, topic_title, art))
                    cost += ji["cost"]
                    entry["judge"], entry["cost"] = j, entry["cost"] + ji["cost"]
                    if judge_passes(j):
                        verdict = j
                    else:
                        problems = ["judge: " + x for x in (j["blocking_issues"] + j["revision_notes"])] or \
                                   ["judge: scores below 4: %s" % json.dumps(j["scores"])]
            if problems or verdict is None:
                res["problems"] = problems or ["no verdict"]
            else:
                art["model"] = model
                art["cost_usd"] = round(cost, 4)
                art["judge"] = {"verdict": verdict["verdict"], "scores": verdict["scores"]}
                art["hooks"] = [R.plain(h) for h in G.hook_lines(art)]
                res["art"] = art
        except BudgetExceeded as e:
            S.append("Budget cap reached: %s" % e)
            stopped = True
            dump_candidate(args, manifest, q, log, "budget cap", [str(e)], cost)
            continue
        except LLMError as e:
            res["problems"] = ["model call failed: %s" % e]
        dump_candidate(args, manifest, q, log, "pass" if res["art"] else "fail", res["problems"], cost)
        res["cost"] = cost
        if res["art"]:
            passed.append(res)
            run_arts[q["slug"]] = res["art"]
            tmp = dict(res["art"], status="live", published=today)
            tmp_all = dict(run_arts)
            tmp_all[q["slug"]] = tmp
            gctx.extra["blog/%s/index.html" % q["slug"]] = G.shingles(G.words_of(
                G.parse(R.render_article_page(root, cfg, ch, tmp, tmp_all)).text))
        else:
            failures.append(res)
            a = attempts.setdefault(q["id"], {"fails": 0})
            a["fails"] = a.get("fails", 0) + 1
            a["last_fail"] = today
            a["last_error"] = res["problems"][0][:200]

    if args.attempts_cache:
        wjson(args.attempts_cache, attempts)
    for res in passed:
        S.append("- PASS %s ($%.3f) scores %s" % (res["q"]["slug"], res["cost"], json.dumps(res["art"]["judge"]["scores"])))
    for res in failures:
        S.append("- FAIL %s ($%.3f): %s" % (res["q"]["slug"], res.get("cost", 0), "; ".join(res["problems"][:6])))
    S.append("Run total: $%.3f%s" % (llm.total, (" (" + ", ".join(llm.notes) + ")") if llm.notes else ""))
    if len(passed) < min_pass:
        S += ["", "Only %d of %d needed passed: nothing was rendered or committed." % (len(passed), min_pass)]
        write_outputs(manifest, summary_path, [], "", S, False, root)
        print("only %d passed (need %d); see the summary" % (len(passed), min_pass))
        return 1

    # publish: generated passes, then any pending article that passes the gate
    published = []
    for res in passed:
        a = res["art"]
        a["status"], a["published"] = "live", today
        wjson(root / "tools/ugc_agent/articles" / (a["slug"] + ".json"), a)
        published.append(a)
    arts_now = R.load_articles(root)
    for slug, a in sorted(arts_now.items()):
        if a["status"] != "pending":
            continue
        others = {k: v for k, v in arts_now.items() if k != slug}
        problems = G.article_problems(root, a, others, gctx, cfg, ch)
        if problems:
            S.append("- PENDING %s stays pending: %s" % (slug, "; ".join(problems[:6])))
            continue
        a["status"], a["published"] = "live", today
        wjson(root / "tools/ugc_agent/articles" / (slug + ".json"), a)
        published.append(a)
        S.append("- PENDING %s is now live" % slug)
    wjson(root / "tools/ugc_agent/attempts.json", attempts)
    try:
        R.render_all(root)
    except ValueError as e:
        S.append("render failed: %s" % e)
        write_outputs(manifest, summary_path, [], "", S, False, root)
        print("render failed: %s" % e)
        return 1
    probs = G.site_problems(root)
    if probs:
        S += ["", "Site gate failed after rendering:"] + ["- " + p for p in probs]
        write_outputs(manifest, summary_path, [], "", S, False, root)
        print("site gate failed after rendering:\n" + "\n".join(probs))
        return 1
    paths = changed_paths(root, before, args.dry_run)
    bad = [p for p in paths if not ALLOW_PATH.match(p)]
    if bad:
        S += ["", "Changed paths outside the allowlist: " + ", ".join(bad)]
        write_outputs(manifest, summary_path, [], "", S, False, root)
        print("changed paths outside the allowlist: %s" % bad)
        return 1
    subject = "ugc-agent: articles %s (%d): %s" % (today, len(published), ", ".join(a["slug"] for a in published))
    S += ["", "## Published", ""]
    for a in published:
        S.append("- %s: https://lynxr.io/blog/%s/ (topic %s, scores %s, $%s)"
                 % (a["title"], a["slug"], a["theme"], json.dumps(a.get("judge", {}).get("scores", {})), a.get("cost_usd", 0)))
    S += ["", "Commit subject: " + subject]
    write_outputs(manifest, summary_path, paths, subject, S, args.dry_run, root)
    print("ok: %d article(s); manifest %s; run total $%.3f" % (len(published), manifest, llm.total))
    return 0


# ---------------------------------------------------------------- other commands

def cmd_withdraw(args):
    root = pathlib.Path(args.root).resolve()
    manifest, summary_path = default_paths(args)
    today = today_str()
    slugs = [s.strip() for s in (args.slugs or "").split(",") if s.strip()]
    S = ["# UGC answer agent: withdraw %s" % today, ""]
    if not slugs:
        print("no slugs given")
        return 1
    arts = R.load_articles(root)
    for s in slugs:
        if not SLUG_RE.match(s) or s not in arts or arts[s]["status"] != "live":
            S.append("not a live article slug: %r" % s)
            write_outputs(manifest, summary_path, [], "", S, False, root)
            print("not a live article slug: %r" % s)
            return 1
    before = snapshot(root)
    for s in slugs:
        a = arts[s]
        a["status"], a["withdrawn"] = "withdrawn", today
        wjson(root / "tools/ugc_agent/articles" / (s + ".json"), a)
    R.render_all(root)
    probs = G.site_problems(root)
    if probs:
        S += ["Site gate failed after withdrawing:"] + ["- " + p for p in probs]
        write_outputs(manifest, summary_path, [], "", S, False, root)
        print("site gate failed:\n" + "\n".join(probs))
        return 1
    paths = changed_paths(root, before, False)
    bad = [p for p in paths if not ALLOW_PATH.match(p)]
    if bad:
        print("changed paths outside the allowlist: %s" % bad)
        return 1
    subject = "ugc-agent: withdraw %s" % ", ".join(slugs)
    write_outputs(manifest, summary_path, paths, subject, S + ["Withdrew: " + ", ".join(slugs)], False, root)
    print("withdrew %s" % ", ".join(slugs))
    return 0


def cmd_render(args):
    root = pathlib.Path(args.root).resolve()
    changed = R.render_all(root)
    probs = G.site_problems(root)
    print("\n".join(sorted(changed)) if changed else "no changes")
    if probs:
        print("site gate FAILED:\n" + "\n".join(probs))
        return 1
    return 0


def cmd_gate(args):
    probs = G.site_problems(pathlib.Path(args.root).resolve())
    if probs:
        print("site gate FAILED:\n" + "\n".join(probs))
        return 1
    print("site gate ok")
    return 0


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as e:  # network blips and 404s both mean "not live yet"
        return 0, str(e)


def cmd_publish_check(args, sleep=time.sleep, fetch=http_get, run=subprocess.run):
    root = pathlib.Path(args.root).resolve()
    manifest, summary_path = default_paths(args)
    mp = pathlib.Path(manifest)
    paths = [l.strip() for l in mp.read_text(encoding="utf-8").splitlines() if l.strip()] if mp.is_file() else []
    if not paths:
        print("nothing to check")
        return 0
    arts = R.load_articles(root)
    blog = [p for p in paths if re.fullmatch(r"blog/[a-z0-9-]+/index\.html", p) and p != "blog/index.html"]
    target = blog[0] if blog else paths[0]
    slug = target.split("/")[1] if blog else None
    withdrawn = bool(slug and arts.get(slug, {}).get("status") == "withdrawn")
    url_path = "/" + target[:-len("index.html")]
    want = 'content="noindex"' if withdrawn else (
        '<link rel="canonical" href="https://lynxr.io/blog/%s/">' % slug if slug else None)
    interval = float(os.environ.get("UGC_AGENT_POLL_SECONDS", "15"))

    def live():
        cb = "ugc%d%d" % (int(time.time()), random.randint(1000, 9999))
        code, body = fetch("https://lynxr.io%s?cb=%s" % (url_path, cb))
        return code == 200 and (want is None or want in body)
    ok = False
    for _ in range(20):
        if live():
            ok = True
            break
        sleep(interval)
    if not ok:
        repo = os.environ.get("GITHUB_REPOSITORY")
        if repo:
            run(["gh", "api", "-X", "POST", "repos/%s/pages/builds" % repo], capture_output=True, text=True)
        for _ in range(40):
            if live():
                ok = True
                break
            sleep(interval)
    if not ok:
        print("%s was not live after all polls" % url_path)
        return 1
    urls = []
    for p in paths:
        if re.fullmatch(r"blog/[a-z0-9-]+/index\.html", p) and p != "blog/index.html":
            urls.append("/" + p[:-len("index.html")])
        elif re.fullmatch(r"faq/ugc-[a-z-]+/index\.html", p):
            urls.append("/" + p[:-len("index.html")])
    urls += ["/faq/", "/blog/"]
    urls = list(dict.fromkeys(urls))
    r = run([sys.executable, str(REPO / "tools" / "indexnow.py")] + urls, cwd=str(root), capture_output=True, text=True)
    print((r.stdout or "").strip())
    if r.returncode != 0:
        print((r.stderr or "").strip())
        return 1
    return 0


def cmd_smoke(args):
    cfg = R.load_config(pathlib.Path(args.root).resolve())
    llm = LLM(cfg, args.root)
    data, info = llm.smoke()
    print("model", info["model"])
    print("stop_reason", info["stop_reason"])
    print("usage", json.dumps(info["usage"]))
    print("cost $%.4f" % info["cost"])
    print("ok", data.get("ok"))
    if llm.notes:
        print(", ".join(llm.notes))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["daily", "withdraw", "render", "gate", "publish-check", "smoke"])
    ap.add_argument("--root", default=str(REPO))
    ap.add_argument("--manifest")
    ap.add_argument("--summary")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--attempts-cache")
    ap.add_argument("--slugs")
    args = ap.parse_args(argv)
    try:
        return {"daily": cmd_daily, "withdraw": cmd_withdraw, "render": cmd_render, "gate": cmd_gate,
                "publish-check": cmd_publish_check, "smoke": cmd_smoke}[args.mode](args)
    except LLMError as e:
        print("model call failed: %s" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
