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
import llm as L  # noqa: E402
import render as R  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("ok    " if cond else "FAIL  ") + name + ((" -- " + str(detail)[:300]) if (detail and not cond) else ""))
    if not cond:
        FAILS.append(name)


def make_fixture(tmp):
    """Copy the real pages and the agent into tmp; return the fixture root."""
    root = pathlib.Path(tmp) / "site"
    root.mkdir()
    for d in ("blog", "glossary", "faq", "about", "how-it-works", "pricing", "what-is-a-video-format",
              "turn-a-video-into-a-script", "short-form-script-structure", "how-to-write-a-hook",
              "ugc-script-template", "remake-a-viral-video", "privacy", "terms", "refunds", "accessibility"):
        shutil.copytree(REPO / d, root / d, ignore=shutil.ignore_patterns("UNUSED"))
    for f in ("index.html", "404.html", "sitemap.xml", "llms.txt"):
        shutil.copy2(REPO / f, root / f)
    shutil.copytree(REPO / "tools/ugc_agent", root / "tools/ugc_agent", ignore=shutil.ignore_patterns("__pycache__"))
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

    # ---- cost
    pr = cfg["price_per_mtok"]
    check("cost: 1M input tokens = 4.00", abs(L.cost_usd({"input_tokens": 1_000_000}, pr) - 4.00) < 1e-9)
    check("cost: 1M output tokens = 20.00", abs(L.cost_usd({"output_tokens": 1_000_000}, pr) - 20.00) < 1e-9)
    check("cost: cache write is 1.25x and read 0.1x input",
          abs(L.cost_usd({"cache_creation_input_tokens": 1_000_000}, pr) - 5.00) < 1e-9
          and abs(L.cost_usd({"cache_read_input_tokens": 1_000_000}, pr) - 0.40) < 1e-9)

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

    # ---- end to end with a fake model: the gate runs before the judge, and the judge sees link targets
    class FakeLLM:
        def __init__(self, cfg, root=None):
            self.total, self.notes = 0.0, []
            self.calls, self.judge_ctx, self.revise_problems = [], [], []
            FakeLLM.last = self

        def info(self):
            return {"model": "fake", "stop_reason": "end_turn", "usage": {}, "cost": 0.01}

        def good(self):
            return {k: copy.deepcopy(base[k]) for k in ("description", "short_answer", "sections")}

        def generate(self, payload):
            self.calls.append("generate")
            d = self.good()
            blk = d["sections"][1]["blocks"][1]
            blk["text"] += " Also read [a page that is not there](/no-such-page/)."
            return d, self.info()

        def revise(self, payload, previous, problems):
            self.calls.append("revise")
            self.revise_problems += problems
            return self.good(), self.info()

        def judge(self, context):
            self.calls.append("judge")
            self.judge_ctx.append(context)
            return {"verdict": "pass", "scores": {"answers_first": 5, "useful_specific": 5, "ugc_focus": 5, "originality": 4, "voice": 5},
                    "blocking_issues": [], "revision_notes": []}, self.info()

        def replenish(self, context):
            raise AssertionError("the queue is long enough; no replenish call expected")
    tmp2 = tempfile.TemporaryDirectory()
    root2 = make_fixture(tmp2.name)
    (root2 / "tools/ugc_agent/articles/ugc-script-for-skincare.json").unlink()
    old_llm, old_env = A.LLM, {k: os.environ.get(k) for k in ("UGC_AGENT_PER_DAY", "UGC_AGENT_MIN_PASS")}
    A.LLM = FakeLLM
    os.environ["UGC_AGENT_PER_DAY"], os.environ["UGC_AGENT_MIN_PASS"] = "1", "1"
    ns2 = argparse.Namespace(root=str(root2), manifest=str(pathlib.Path(tmp2.name) / "out/manifest.txt"),
                             summary=str(pathlib.Path(tmp2.name) / "out/summary.md"), dry_run=True, attempts_cache=None, slugs=None)
    try:
        rc2 = A.cmd_daily(ns2)
    finally:
        A.LLM = old_llm
        for k, v in old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    fk = FakeLLM.last
    check("end to end: the daily run exits 0", rc2 == 0, (pathlib.Path(tmp2.name) / "out/summary.md").read_text() if (pathlib.Path(tmp2.name) / "out/summary.md").exists() else "")
    check("end to end: a dead link is caught by code, so the first draft never reaches the judge",
          fk.calls == ["generate", "revise", "judge"], fk.calls)
    check("end to end: the revision was told about the broken link", has(fk.revise_problems, "broken internal link /no-such-page/"), fk.revise_problems)
    check("end to end: the judge got link targets with titles and the site page list",
          len(fk.judge_ctx) == 1 and fk.judge_ctx[0]["links_used"] and "site_pages" in fk.judge_ctx[0]
          and "page_title" in fk.judge_ctx[0]["links_used"][0])
    cdir = pathlib.Path(tmp2.name) / "out/candidates"
    cands = list(cdir.glob("*.json")) if cdir.is_dir() else []
    cj = json.loads(cands[0].read_text()) if cands else {}
    check("end to end: the dry run saves every attempt and its judge verdict",
          len(cands) == 1 and cj.get("result") == "pass" and [a["stage"] for a in cj["attempts"]] == ["generate", "revise"]
          and cj["attempts"][0]["gate_problems"] and cj["attempts"][1]["judge"]["verdict"] == "pass", cj.get("result"))
    mf2 = (pathlib.Path(tmp2.name) / "out/manifest.txt").read_text().split()
    check("end to end: the manifest holds only allowlisted paths and the new article",
          mf2 and all(A.ALLOW_PATH.match(p) for p in mf2) and "blog/how-do-ugc-creators-get-paid/index.html" in mf2, mf2)
    check("end to end: the site gate is clean after the run", G.site_problems(root2) == [], G.site_problems(root2))
    tmp2.cleanup()

    tmp.cleanup()
    print()
    if FAILS:
        print("%d CHECK(S) FAILED: %s" % (len(FAILS), "; ".join(FAILS)))
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
