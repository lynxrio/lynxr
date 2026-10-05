#!/usr/bin/env python3
"""The UGC answer agent's toolbox. No model is called from here: a Claude Code routine does the writing and the
reviewing (see ROUTINE.md), and these commands do everything that must be exact.

Routine commands
    next [--n 3] [--out DIR]        pick queued questions and write one brief per question
    check CANDIDATE.json            the code gate for one candidate (links resolved in code); exit 1 on problems
    judge-context CANDIDATE.json    exactly what a reviewer receives (article with link targets + site page list)
    publish CANDIDATE.json --verdict VERDICT.json    gate + verdict thresholds, then write the article, live
    fail SLUG --reason TEXT         record a failed attempt (retry policy: 4 failures retire a question)
    add-questions FILE.json         validate, dedupe and append proposed questions to questions-auto.json
    render                          render every agent-owned page and marker region from the article JSON
    gate                            the site gate on the whole tree
    finish [--out DIR]              manifest + commit subject for commit.sh; exit 3 when nothing was published
Workflow commands
    withdraw --slugs a,b            take live articles down (noindex stub), render, gate, manifest
    publish-check --manifest FILE   poll the live site, then ping IndexNow (GitHub's runner only)
Common option: --root DIR (default: the repo).
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

import gate as G
import render as R
import schema as SCH

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
Q_START = re.compile(r"^(How|What|Why|When|Should|Can|Do|Does|Is|Are)\b")
Q_BANNED = re.compile(r"\d|\$|%|tax|legal|lawyer|\blaw\b|copyright|trademark|ftc|disclos|visa|llc|insurance|medical|"
                      r"doctor|cure|acne|weight|salary|income|how much|earn|make money", re.I)
ALLOW_PATH = re.compile(r"^(blog/[a-z0-9-]+/index\.html|blog/index\.html|faq/index\.html|faq/ugc-[a-z-]+/index\.html|"
                        r"sitemap\.xml|llms\.txt|tools/ugc_agent/(articles/[a-z0-9-]+\.json|attempts\.json|questions-auto\.json))$")
STATE_PATHS = ("tools/ugc_agent/attempts.json", "tools/ugc_agent/questions-auto.json")
UA = "lynxr-ugc-agent/1.0 (+https://lynxr.io/)"
EX_USAGE, EX_NOTHING, EX_EMPTY = 2, 3, 4


class UsageError(Exception):
    pass


# ---------------------------------------------------------------- small helpers

def today_str():
    forced = os.environ.get("UGC_AGENT_TODAY")
    if forced:
        return forced
    try:
        import zoneinfo
        return datetime.datetime.now(zoneinfo.ZoneInfo("America/New_York")).date().isoformat()
    except Exception:  # a minimal image can lack the tz database: US Eastern standard time is close enough
        return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=5)).date().isoformat()


def default_out():
    return pathlib.Path(tempfile.gettempdir()) / "ugc-agent-run"


def accept_replenished(cands, cfg, questions, arts, root):
    """Keep a proposed question only when every rule holds. Returns (accepted entries, [(slug, reason)] rejected)."""
    topics = {t["slug"] for t in cfg["topics"]}
    counts = live_counts(arts)
    slugs = {q["slug"] for q in questions} | set(arts) | (
        {p.name for p in (pathlib.Path(root) / "blog").iterdir() if p.is_dir()} if (pathlib.Path(root) / "blog").is_dir() else set())
    existing = [q["question"] for q in questions]
    nums = [int(q["id"][1:]) for q in questions if re.fullmatch(r"a\d+", q["id"])]
    nxt = max(nums) + 1 if nums else 1
    out, rejected = [], []
    for c in cands:
        q = c.get("question", "").strip()
        s = c.get("slug", "").strip()
        why = None
        if c.get("topic") not in topics:
            why = "unknown topic"
        elif counts.get(c.get("topic"), 0) >= cfg["topic_cap"]:
            why = "topic is at its cap"
        elif s in slugs or not SLUG_RE.match(s):
            why = "slug exists or is malformed"
        elif len(q) > 70 or not Q_START.match(q):
            why = "question is over 70 characters or does not start with a question word"
        elif any(jaccard_words(q, e) >= 0.6 for e in existing):
            why = "too close to an existing question"
        elif Q_BANNED.search(q) or Q_BANNED.search(c.get("target_query", "")):
            why = "off-limits topic (figures, law, tax, income, medical)"
        elif len(out) >= 15:
            why = "more than 15 in one batch"
        if why:
            rejected.append((s or q[:30], why))
            continue
        out.append({"id": "a%03d" % nxt, "theme": c["topic"], "priority": 3, "question": q, "slug": s,
                    "target_query": c.get("target_query", "").strip().lower(), "angle": c.get("angle", "").strip()})
        nxt += 1
        slugs.add(s)
        existing.append(q)
    return out, rejected


def write_outputs(manifest, summary_path, paths, subject, summary_lines, dry_run, root):
    manifest = pathlib.Path(manifest)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text("".join(p + "\n" for p in paths), encoding="utf-8")
    (manifest.parent / "commit-subject.txt").write_text((subject or "") + "\n", encoding="utf-8")
    if summary_path:
        pathlib.Path(summary_path).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(summary_path).write_text("\n".join(summary_lines) + "\n", encoding="utf-8")


def default_paths(args):
    base = pathlib.Path(tempfile.gettempdir()) / ("ugc-agent-%d" % os.getpid())
    base.mkdir(parents=True, exist_ok=True)
    return (args.manifest or str(base / "manifest.txt")), (args.summary or str(base / "summary.md"))


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


# ---------------------------------------------------------------- routine commands

def load_state(root):
    root = pathlib.Path(root).resolve()
    cfg = R.load_config(root)
    arts = R.load_articles(root)
    questions = load_questions(root)
    attempts_path = root / "tools/ugc_agent/attempts.json"
    attempts = R.load_json(attempts_path) if attempts_path.is_file() else {}
    return root, cfg, arts, questions, attempts


def load_candidate(path, questions):
    """(question, article content) from a candidate file: {description, short_answer, sections[, slug]}."""
    p = pathlib.Path(path)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise UsageError("cannot read candidate %s: %s" % (path, e))
    if not isinstance(data, dict):
        raise UsageError("candidate %s must be a JSON object" % path)
    slug = data.pop("slug", None) or p.stem
    q = next((x for x in questions if x["slug"] == slug), None)
    if q is None:
        raise UsageError("no queued question has the slug %r (the candidate's slug, or its file name)" % slug)
    return q, data


def candidate_problems(root, cfg, arts, q, data, ctx=None, ch=None):
    """Schema first, then the code gate (which resolves every internal link). Returns (problems, article dict or None)."""
    shape = SCH.validate(SCH.ARTICLE, data)
    if shape:
        return ["schema: " + s for s in shape[:12]], None
    art = make_art(q, data)
    existing = arts.get(q["slug"])
    if existing and existing["status"] in ("live", "withdrawn"):
        return ["this question already has a %s article" % existing["status"]], art
    if any(a["question_id"] == q["id"] and a["status"] in ("live", "withdrawn") for a in arts.values()):
        return ["this question already has an article under another slug"], art
    ch = ch or R.chrome(root, cfg)
    ctx = ctx or G.Context(root)
    # articles published earlier in this run have JSON but no rendered page yet: compare against them in memory
    for slug, a in arts.items():
        rel = "blog/%s/index.html" % slug
        if a["status"] == "live" and not (pathlib.Path(root) / rel).is_file():
            ctx.extra[rel] = G.shingles(G.words_of(G.parse(R.render_article_page(root, cfg, ch, a, arts)).text))
    return G.article_problems(root, art, arts, ctx, cfg, ch), art


def print_problems(problems):
    print("%d problem(s):" % len(problems))
    for p in problems:
        print("  - " + p)


def read_verdict(path):
    try:
        v = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise UsageError("cannot read verdict %s: %s" % (path, e))
    shape = SCH.validate(SCH.JUDGE, v)
    if shape:
        raise UsageError("verdict is not in the reviewer schema: " + "; ".join(shape[:6]))
    return v


def replenish_brief(cfg, arts, questions, out):
    counts = live_counts(arts)
    return {"instructions": "Follow tools/ugc_agent/prompts/replenish.txt. Write {\"questions\": [...]} to new_questions_path, "
                            "then run: python3 tools/ugc_agent/agent.py add-questions <that file>.",
            "topics_with_room": [{"slug": t["slug"], "title": t["title"], "answers_so_far": counts.get(t["slug"], 0),
                                  "room": cfg["topic_cap"] - counts.get(t["slug"], 0)} for t in cfg["topics"]
                                 if counts.get(t["slug"], 0) < cfg["topic_cap"]],
            "existing_questions": [q["question"] for q in questions],
            "schema": SCH.REPLENISH, "new_questions_path": str(out / "new-questions.json")}


def build_brief(root, cfg, arts, q, out):
    payload = build_payload(root, cfg, arts, q)
    payload.pop("revision", None)
    topic = R.topic_map(cfg)[q["theme"]]
    ref = pathlib.Path(root) / "tools/ugc_agent/articles/ugc-script-for-skincare.json"
    sample = None
    if ref.is_file():
        a = R.load_json(ref)
        sample = {k: a[k] for k in ("description", "short_answer", "sections")}
    payload.update({
        "topic": q["theme"],
        "instructions": "Write the article per tools/ugc_agent/prompts/system.txt. Write ONE JSON file at candidate_path "
                        "(an object with description, short_answer, sections: nothing else) that matches schema.",
        "schema": SCH.ARTICLE,
        "candidate_path": str(out / "candidates" / (q["slug"] + ".json")),
        "verdict_path": str(out / "verdicts" / (q["slug"] + ".json")),
        "topic_pillars": [{"url": p, "title": page_title(root, p.strip("/"))} for p in topic["pillars"]],
        "reference_answer": sample,
        "reference_answer_note": "REFERENCE ANSWER (voice and depth only; reuse none of its sentences, hooks or examples)",
    })
    return payload


def git_subjects(root, n=40):
    if not (pathlib.Path(root) / ".git").exists():
        return ""
    try:
        return subprocess.run(["git", "log", "-n", str(n), "--format=%s"], cwd=root, capture_output=True,
                              text=True, check=True).stdout
    except Exception:
        return ""


def cmd_next(args):
    root, cfg, arts, questions, attempts = load_state(args.root)
    today = today_str()
    yday = (datetime.date.fromisoformat(today) - datetime.timedelta(days=1)).isoformat()
    out = pathlib.Path(args.out) if args.out else default_out()
    if not args.force and ("ugc-agent: articles %s" % today) in git_subjects(root):
        print(json.dumps({"status": "already ran today", "briefs": []}))
        return 0
    probs = G.site_problems(root)
    if probs:
        print("the untouched tree fails the site gate; nothing is built on it:")
        print_problems(probs)
        return 1
    queue = build_queue(cfg, questions, arts, attempts)
    out.mkdir(parents=True, exist_ok=True)
    for d in ("briefs", "candidates", "verdicts"):
        (out / d).mkdir(exist_ok=True)
    for old in (out / "briefs").glob("*.json"):
        old.unlink()
    low = len(queue) < cfg["replenish_below"]
    if low:
        wjson(out / "replenish-brief.json", replenish_brief(cfg, arts, questions, out))
    n = clamp(args.n or env_int("UGC_AGENT_PER_RUN", cfg["per_day_default"]), 1, 3)
    summary = {"today": today, "out": str(out), "queue_size": len(queue), "queue_low": low,
               "replenish_brief": str(out / "replenish-brief.json") if low else None,
               "min_publish": clamp(env_int("UGC_AGENT_MIN_PUBLISH", cfg["min_publish_default"]), 1, 3), "briefs": []}
    if not queue:
        print(json.dumps(dict(summary, status="queue empty: replenish, then run next again"), indent=2))
        return EX_EMPTY
    for q in pick(queue, n, attempts, today, yday):
        path = out / "briefs" / (q["slug"] + ".json")
        wjson(path, build_brief(root, cfg, arts, q, out))
        summary["briefs"].append({"slug": q["slug"], "question": q["question"], "topic": q["theme"], "brief": str(path),
                                  "candidate_path": str(out / "candidates" / (q["slug"] + ".json")),
                                  "verdict_path": str(out / "verdicts" / (q["slug"] + ".json"))})
    wjson(out / "snapshot.json", snapshot(root))
    print(json.dumps(summary, indent=2))
    return 0


def cmd_check(args):
    root, cfg, arts, questions, attempts = load_state(args.root)
    q, data = load_candidate(args.candidate, questions)
    problems, art = candidate_problems(root, cfg, arts, q, data)
    if problems:
        print("FAIL %s" % q["slug"])
        print_problems(problems)
        return 1
    print("PASS %s (gate ok, every internal link resolves)" % q["slug"])
    return 0


def cmd_judge_context(args):
    root, cfg, arts, questions, attempts = load_state(args.root)
    q, data = load_candidate(args.candidate, questions)
    problems, art = candidate_problems(root, cfg, arts, q, data)
    if problems:
        print("the candidate does not pass the code gate, so it cannot be reviewed yet:", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
        return 1
    run_arts = dict(arts)
    run_arts[q["slug"]] = art
    ctx = judge_context(root, cfg, run_arts, q, R.topic_map(cfg)[q["theme"]]["title"], art)
    print(json.dumps(ctx, ensure_ascii=False, indent=2))
    return 0


def cmd_publish(args):
    root, cfg, arts, questions, attempts = load_state(args.root)
    q, data = load_candidate(args.candidate, questions)
    verdict = read_verdict(args.verdict)
    problems, art = candidate_problems(root, cfg, arts, q, data)
    if problems:
        print("REFUSED %s: the code gate fails" % q["slug"])
        print_problems(problems)
        return 1
    if not judge_passes(verdict):
        print("REFUSED %s: the verdict is not a pass (verdict=%s, scores=%s, %d blocking issue(s))"
              % (q["slug"], verdict["verdict"], json.dumps(verdict["scores"]), len(verdict["blocking_issues"])))
        return 1
    today = today_str()
    art.update({"status": "live", "published": today, "origin": "agent",
                "model": os.environ.get("UGC_AGENT_MODEL", "claude-code-routine"), "cost_usd": 0.0,
                "judge": {"verdict": verdict["verdict"], "scores": verdict["scores"]},
                "hooks": [R.plain(h) for h in G.hook_lines(art)]})
    wjson(root / "tools/ugc_agent/articles" / (q["slug"] + ".json"), art)
    attempts[q["id"]] = dict(attempts.get(q["id"], {"fails": 0}), published=today)
    wjson(root / "tools/ugc_agent/attempts.json", attempts)
    print("published %s (live, %s)" % (q["slug"], today))
    return 0


def cmd_fail(args):
    root, cfg, arts, questions, attempts = load_state(args.root)
    q = next((x for x in questions if x["slug"] == args.slug), None)
    if q is None:
        raise UsageError("no question has the slug %r" % args.slug)
    a = attempts.setdefault(q["id"], {"fails": 0})
    a["fails"] = a.get("fails", 0) + 1
    a["last_fail"] = today_str()
    a["last_error"] = (args.reason or "").strip()[:200]
    wjson(root / "tools/ugc_agent/attempts.json", attempts)
    print("recorded failure %d for %s%s" % (a["fails"], q["slug"], " (retired after 4)" if a["fails"] >= 4 else ""))
    return 0


def cmd_add_questions(args):
    root, cfg, arts, questions, attempts = load_state(args.root)
    try:
        data = json.loads(pathlib.Path(args.file).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise UsageError("cannot read %s: %s" % (args.file, e))
    if isinstance(data, list):
        data = {"questions": data}
    shape = SCH.validate(SCH.REPLENISH, data)
    if shape:
        raise UsageError("not in the replenish schema: " + "; ".join(shape[:6]))
    accepted, rejected = accept_replenished(data["questions"], cfg, questions, arts, root)
    if accepted:
        auto = root / "tools/ugc_agent/questions-auto.json"
        wjson(auto, R.load_json(auto) + accepted)
    print("%d accepted, %d rejected" % (len(accepted), len(rejected)))
    for a in accepted:
        print("  + %s %s" % (a["id"], a["slug"]))
    for s, why in rejected:
        print("  - %s: %s" % (s, why))
    return 0


def cmd_finish(args):
    root, cfg, arts, questions, attempts = load_state(args.root)
    today = today_str()
    out = pathlib.Path(args.out) if args.out else default_out()
    manifest = pathlib.Path(args.manifest) if args.manifest else out / "manifest.txt"
    before = {}
    if not (root / ".git").exists() and (out / "snapshot.json").is_file():
        before = R.load_json(out / "snapshot.json")
    paths = changed_paths(root, before, False)
    bad = [p for p in paths if not ALLOW_PATH.match(p)]
    if bad:
        write_outputs(manifest, None, [], "", [], False, root)
        print("REFUSED: changed paths outside the allowlist: %s" % ", ".join(bad))
        return 1
    published = []
    for p in paths:
        m = re.fullmatch(r"tools/ugc_agent/articles/([a-z0-9-]+)\.json", p)
        if m and (root / p).is_file():
            a = R.load_json(root / p)
            if a.get("status") == "live" and a.get("published") == today:
                published.append(a["slug"])
    need = clamp(env_int("UGC_AGENT_MIN_PUBLISH", cfg["min_publish_default"]), 1, 3)
    if len(published) < need:
        # Nothing published: still commit the attempts/queue state on its own, so the next run moves past the
        # questions that just failed instead of retrying them forever. Any other changed path means commit nothing.
        state = [p for p in paths if p in STATE_PATHS]
        if published or not state or len(state) != len(paths):
            write_outputs(manifest, None, [], "", [], False, root)
            print("%d article(s) published, %d needed: nothing to commit" % (len(published), need))
            return EX_NOTHING
        write_outputs(manifest, None, state, "ugc-agent: no article passed %s (attempts recorded)" % today, [], False, root)
        print("0 articles published, %d needed: manifest %s holds only the attempts state (%d paths)" % (need, manifest, len(state)))
        return EX_NOTHING
    subject = "ugc-agent: articles %s (%d): %s" % (today, len(published), ", ".join(sorted(published)))
    write_outputs(manifest, None, paths, subject, [], False, root)
    print("manifest %s (%d paths)\nsubject: %s" % (manifest, len(paths), subject))
    return 0


def main(argv=None):
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", default=str(REPO))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)
    p = sub.add_parser("next", parents=[common]); p.add_argument("--n", type=int); p.add_argument("--out"); p.add_argument("--force", action="store_true")
    p = sub.add_parser("check", parents=[common]); p.add_argument("candidate")
    p = sub.add_parser("judge-context", parents=[common]); p.add_argument("candidate")
    p = sub.add_parser("publish", parents=[common]); p.add_argument("candidate"); p.add_argument("--verdict", required=True)
    p = sub.add_parser("fail", parents=[common]); p.add_argument("slug"); p.add_argument("--reason", required=True)
    p = sub.add_parser("add-questions", parents=[common]); p.add_argument("file")
    p = sub.add_parser("finish", parents=[common]); p.add_argument("--out"); p.add_argument("--manifest")
    sub.add_parser("render", parents=[common])
    sub.add_parser("gate", parents=[common])
    p = sub.add_parser("withdraw", parents=[common]); p.add_argument("--slugs"); p.add_argument("--manifest"); p.add_argument("--summary")
    p = sub.add_parser("publish-check", parents=[common]); p.add_argument("--manifest"); p.add_argument("--summary")
    args = ap.parse_args(argv)
    fn = {"next": cmd_next, "check": cmd_check, "judge-context": cmd_judge_context, "publish": cmd_publish,
          "fail": cmd_fail, "add-questions": cmd_add_questions, "finish": cmd_finish, "render": cmd_render,
          "gate": cmd_gate, "withdraw": cmd_withdraw, "publish-check": cmd_publish_check}[args.mode]
    try:
        return fn(args)
    except UsageError as e:
        print("error: %s" % e)
        return EX_USAGE


if __name__ == "__main__":
    sys.exit(main())
