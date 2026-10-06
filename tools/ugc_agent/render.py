"""Render every agent-owned page from article JSON. Pure standard library; deterministic.

Writes: blog/<slug>/index.html (one per live article), faq/<topic>/index.html (one per
topic with a live article), and the marker regions in faq/index.html, blog/index.html,
sitemap.xml and llms.txt. The site chrome (head, header, footer) is copied live from the
model page named in config.json, so a cache-stamp bump or a footer edit reaches every
agent page on the next render. The model never writes HTML: every string it returns is
escaped here, and only [anchor](/path/) links and the UGC capitals class are rebuilt.

Rendering twice produces identical bytes.
"""
import html
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent.parent
SITE = "https://lynxr.io"
ORG = SITE + "/#organization"
WEBSITE = SITE + "/#website"
LYNXR = SITE + "/#lynxr"
OG_IMAGE = SITE + "/og-v3.png"
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]
RESERVED_IDS = {"do-it-with-lynxr", "more-questions", "keep-reading", "questions"}

UGC_RE = re.compile(r"\bUGC\b")
LINK_RE = re.compile(r"\[([^\]\n]{1,90})\]\((/[a-z0-9/_#.-]*)\)")
SENTENCE_RE = re.compile(r"(.+?[.?!])(?:\s|$)", re.S)

CTA = ('<p class="lp-p">Paste a public TikTok or Instagram link on <a href="/">the homepage</a> and lynxr works out '
       'the format — hook, beats, turn, close — and writes it as a script for the brand you make content for. '
       '<a href="/how-it-works/">How lynxr writes scripts</a> shows each step. Free to start: '
       '<a href="/faq/#what-it-costs">3 scripts a week, no card</a>.</p>')


# ---------------------------------------------------------------- loading

def load_json(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def load_config(root):
    return load_json(pathlib.Path(root) / "tools/ugc_agent/config.json")


def load_articles(root):
    out = {}
    d = pathlib.Path(root) / "tools/ugc_agent/articles"
    if d.is_dir():
        for p in sorted(d.glob("*.json")):
            a = load_json(p)
            out[a["slug"]] = a
    return out


def topic_map(cfg):
    return {t["slug"]: t for t in cfg["topics"]}


# ---------------------------------------------------------------- text helpers

def esc(s):
    return html.escape(s, quote=False)


def acr(s):
    return UGC_RE.sub('<span class="acr">UGC</span>', s)


def to_html(s):
    """Model string -> escaped HTML with [anchor](/path/) links and UGC capitals."""
    out, pos = [], 0
    for m in LINK_RE.finditer(s):
        out.append(acr(esc(s[pos:m.start()])))
        out.append('<a href="%s">%s</a>' % (m.group(2), acr(esc(m.group(1)))))
        pos = m.end()
    out.append(acr(esc(s[pos:])))
    return "".join(out)


def plain(s):
    """Link markup removed: what meta tags and JSON-LD carry."""
    return LINK_RE.sub(r"\1", s)


def attr(s):
    return esc(plain(s)).replace('"', "&quot;")


def first_sentence(s):
    m = SENTENCE_RE.match(s.strip())
    return m.group(1) if m else s.strip()


def kebab(heading):
    words = heading.split()[:6]
    return "-".join(re.findall(r"[a-z0-9]+", " ".join(words).lower()))


def date_long(iso):
    y, m, d = (int(x) for x in iso.split("-"))
    return "%d %s %d" % (d, MONTHS[m - 1], y)


def ld(obj):
    return ('<script type="application/ld+json">\n'
            + json.dumps(obj, ensure_ascii=False, indent=2) + "\n</script>")


def strip_tags(s):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", s)).split())


def first_h1(text):
    """Inner HTML of the page's first real <h1>, or None. Comments go first: /how-it-works/ has a comment that
    mentions "<h1>" ahead of its real one, and matching that leaked the comment text as the page title."""
    m = re.search(r"<h1[^>]*>(.*?)</h1>", re.sub(r"<!--.*?-->", "", text, flags=re.S), re.S)
    return m.group(1) if m else None


# ---------------------------------------------------------------- chrome

def chrome(root, cfg):
    """Head/header/footer fragments copied from the model page. Raises if a marker is missing."""
    t = (pathlib.Path(root) / cfg["model_page"]).read_text(encoding="utf-8")

    def need(s):
        i = t.find(s)
        if i < 0:
            raise ValueError("chrome marker missing in %s: %r" % (cfg["model_page"], s))
        return i

    viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">'
    end_ld = "<!-- END SHARED ENTITY JSON-LD -->"
    head_top = t[need('<meta charset="utf-8">'):need(viewport) + len(viewport)]
    chrome_head = t[need('<link rel="icon"'):need(end_ld) + len(end_ld)]
    h = need("</head>") + len("</head>")
    rest = t[h:].lstrip("\n")
    if not rest.startswith("<!--"):
        raise ValueError("chrome marker missing: no comment right after </head>")
    start = t.index(rest[:40], h)
    body_open = t[start:need("</header>") + len("</header>")]
    foot = t[need('<footer id="site-footer">'):t.rindex("</html>") + len("</html>")]
    return {"HEAD_TOP": head_top, "CHROME_HEAD": chrome_head, "BODY_OPEN": body_open, "FOOTER": foot}


def pillar_label(root, path):
    t = (pathlib.Path(root) / path.strip("/") / "index.html").read_text(encoding="utf-8")
    h1 = first_h1(t)
    if h1 is None:
        raise ValueError("pillar page has no h1: " + path)
    return to_html(strip_tags(h1))


# ---------------------------------------------------------------- page assembly

def head_metas(title, desc, url, og_type):
    return "\n".join([
        "<title>%s</title>" % esc(title),
        '<meta name="description" content="%s">' % attr(desc),
        '<meta property="og:title" content="%s">' % attr(title),
        '<meta property="og:description" content="%s">' % attr(desc),
        '<meta property="og:type" content="%s">' % og_type,
        '<meta property="og:site_name" content="lynxr">',
        '<meta property="og:url" content="%s">' % url,
        '<meta property="og:image" content="%s">' % OG_IMAGE,
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta name="twitter:card" content="summary_large_image">',
        '<meta name="twitter:title" content="%s">' % attr(title),
        '<meta name="twitter:description" content="%s">' % attr(desc),
        '<meta name="twitter:image" content="%s">' % OG_IMAGE,
        '<link rel="canonical" href="%s">' % url,
    ])


def breadcrumb(items):
    return {"@context": "https://schema.org", "@type": "BreadcrumbList",
            "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": n, "item": u}
                                for i, (n, u) in enumerate(items)]}


def live_in_topic(arts, topic):
    return sorted((a for a in arts.values() if a["status"] == "live" and a["theme"] == topic),
                  key=lambda a: (a["published"], a["slug"]))


def section_ids(sections):
    seen, out = set(), []
    for s in sections:
        base = kebab(s["heading"]) or "section"
        cand, n = base, 1
        while cand in seen or cand in RESERVED_IDS:
            n += 1
            cand = "%s-%d" % (base, n)
        seen.add(cand)
        out.append(cand)
    return out


def render_block(b):
    k = b["kind"]
    if k == "paragraph":
        return '      <p class="lp-p">%s</p>' % to_html(b["text"])
    if k == "list":
        lis = "".join("\n        <li>%s</li>" % to_html(i) for i in b["items"])
        return '      <ul class="lp-list">%s\n      </ul>' % lis
    if k == "table":
        th = "".join('<th scope="col">%s</th>' % to_html(h) for h in b["table_head"])
        rows = "".join("\n            <tr>%s</tr>" % "".join("<td>%s</td>" % to_html(c) for c in r)
                       for r in b["table_rows"])
        return ('      <div class="post-table">\n        <table>\n          <thead><tr>%s</tr></thead>\n'
                '          <tbody>%s\n          </tbody>\n        </table>\n      </div>' % (th, rows))
    if k == "script":
        lis = "".join(
            '\n          <li><span class="ps-part">%s</span><span class="ps-say">say: &ldquo;%s&rdquo;</span>'
            '<span class="ps-do">do: %s</span></li>' % (esc(x["part"]), to_html(x["say"]), to_html(x["do"]))
            for x in b["script_beats"])
        return ('      <figure class="post-script">\n        <figcaption>%s</figcaption>\n'
                '        <ol class="ps-beats">%s\n        </ol>\n      </figure>' % (to_html(b["script_caption"]), lis))
    raise ValueError("unknown block kind: %r" % k)


def render_article_page(root, cfg, ch, art, arts):
    """arts must contain art as a live article (the caller sets status/published for a candidate)."""
    topics = topic_map(cfg)
    t = topics[art["theme"]]
    slug, title, desc, date = art["slug"], art["title"], art["description"], art["published"]
    url = "%s/blog/%s/" % (SITE, slug)
    topic_url = "%s/faq/%s/" % (SITE, t["slug"])
    blog_ld = {"@context": "https://schema.org", "@type": "BlogPosting", "@id": url + "#article",
               "headline": title, "description": plain(desc), "image": OG_IMAGE, "inLanguage": "en",
               "datePublished": date, "dateModified": date,
               "author": {"@id": ORG}, "publisher": {"@id": ORG}, "isPartOf": {"@id": WEBSITE},
               "mentions": {"@id": LYNXR}, "mainEntityOfPage": url}
    crumbs = breadcrumb([("lynxr", SITE + "/"), ("questions and answers", SITE + "/faq/"),
                         (t["title"], topic_url), (title, url)])
    ids = section_ids(art["sections"])
    secs = []
    for sec, sid in zip(art["sections"], ids):
        parts = ['      <h2 class="lp-h2" id="%s">%s</h2>' % (sid, to_html(sec["heading"]))]
        parts += [render_block(b) for b in sec["blocks"]]
        secs.append("\n".join(parts))
    # related answers in the same topic
    L = live_in_topic(arts, t["slug"])
    idx = [i for i, a in enumerate(L) if a["slug"] == slug]
    rel = []
    if idx:
        i = idx[0]
        prev = L[i - 1] if i > 0 else None
        nxt = L[i + 1] if i < len(L) - 1 else None
        rel = [x for x in (prev, nxt) if x]
        taken = {slug} | {x["slug"] for x in rel}
        rel += [x for x in reversed(L) if x["slug"] not in taken][:2]
        rel = rel[:4]
    rel_li = "".join(
        '\n        <li><b><a href="/blog/%s/">%s</a></b> — %s</li>'
        % (x["slug"], to_html(x["title"]), to_html(first_sentence(x["short_answer"]))) for x in rel)
    pillars = "".join(
        '\n        <li><b><a href="%s">%s</a></b></li>' % (p, pillar_label(root, p)) for p in t["pillars"])
    body = """
<main>

  <section class="lp-hero">
    <div class="lp-in">
      <nav class="post-crumbs" aria-label="Breadcrumb"><a href="/">lynxr</a> / <a href="/faq/">questions</a> / <a href="/faq/%(topic)s/">%(short)s</a></nav>
      <h1 class="lp-h1">%(title)s</h1>
      <p class="lp-lede">%(lede)s</p>
      <p class="post-meta">Published <time datetime="%(date)s">%(date_long)s</time></p>
    </div>
  </section>

  <section class="lp-sec">
    <div class="lp-in">
%(sections)s
    </div>
  </section>

  <section class="lp-band post-end">
    <div class="lp-in">
      <h2 class="lp-h2" id="do-it-with-lynxr">Write your next <span class="acr">UGC</span> script with lynxr</h2>
      %(cta)s
      <h2 class="lp-h2" id="more-questions">More questions about %(topic_title)s</h2>
      <ul class="lp-list">%(rel)s
        <li><b><a href="/faq/%(topic)s/">All questions about %(topic_title)s</a></b> — %(blurb)s.</li>
      </ul>
      <h2 class="lp-h2" id="keep-reading">Keep reading</h2>
      <ul class="lp-list">%(pillars)s
        <li><b><a href="/faq/">Questions and answers</a></b> — about lynxr, and every topic <span class="acr">UGC</span> creators ask about.</li>
      </ul>
    </div>
  </section>

</main>
""" % {"topic": t["slug"], "short": to_html(t["short"]), "title": to_html(title), "lede": to_html(art["short_answer"]),
       "date": date, "date_long": date_long(date), "sections": "\n\n".join(secs), "cta": CTA,
       "topic_title": to_html(t["title"]), "rel": rel_li, "blurb": to_html(t["blurb"]), "pillars": pillars}
    return "\n".join([
        "<!doctype html>", '<html lang="en">', "<head>", ch["HEAD_TOP"],
        head_metas(title, desc, url, "article"), ch["CHROME_HEAD"],
        ld(blog_ld), ld(crumbs), "</head>", ch["BODY_OPEN"], body, ch["FOOTER"], ""])


def render_topic_page(root, cfg, ch, topic, arts):
    L = live_in_topic(arts, topic["slug"])
    url = "%s/faq/%s/" % (SITE, topic["slug"])
    title = "%s — questions and answers" % topic["title"]
    newest = max(a["published"] for a in L)
    faq_ld = {"@context": "https://schema.org", "@type": "FAQPage", "@id": url + "#faqpage", "url": url,
              "inLanguage": "en", "dateModified": newest, "isPartOf": {"@id": WEBSITE}, "publisher": {"@id": ORG},
              "mainEntity": [{"@type": "Question", "name": a["title"],
                              "acceptedAnswer": {"@type": "Answer", "url": "%s/blog/%s/" % (SITE, a["slug"]),
                                                 "text": plain(a["short_answer"])}} for a in L]}
    crumbs = breadcrumb([("lynxr", SITE + "/"), ("questions and answers", SITE + "/faq/"), (topic["title"], url)])
    dets = []
    for n, a in enumerate(L):
        # The summary is a flex row in app.css: the title goes inside ONE span, or an inline <span class="acr">
        # in it becomes its own flex item and is drawn with gaps around it.
        dets.append('        <details class="lp-q"%s>\n          <summary><span>%s</span></summary>\n'
                    '          <p class="lp-a" id="%s">%s</p>\n'
                    '          <p class="lp-a"><a href="/blog/%s/">Read the full answer</a></p>\n        </details>'
                    % (" open" if n == 0 else "", to_html(a["title"]), a["slug"], to_html(a["short_answer"]), a["slug"]))
    pillars = "".join('\n        <li><b><a href="%s">%s</a></b></li>' % (p, pillar_label(root, p))
                      for p in topic["pillars"])
    n = len(L)
    body = """
<main>

  <section class="lp-hero">
    <div class="lp-in">
      <nav class="post-crumbs" aria-label="Breadcrumb"><a href="/">lynxr</a> / <a href="/faq/">questions</a></nav>
      <h1 class="lp-h1">%(title)s</h1>
      <p class="lp-lede">%(lede)s %(count)s</p>
    </div>
  </section>

  <section class="lp-band">
    <div class="lp-in">
      <div class="lp-faq">
%(dets)s
      </div>
    </div>
  </section>

  <section class="lp-sec">
    <div class="lp-in">
      <h2 class="lp-h2" id="more">More for <span class="acr">UGC</span> creators</h2>
      <ul class="lp-list">%(pillars)s
        <li><b><a href="/faq/">All questions and answers</a></b> — about lynxr, and every topic <span class="acr">UGC</span> creators ask about.</li>
        <li><b><a href="/blog/">The lynxr blog</a></b> — longer guides to <span class="acr">UGC</span> scripts, hooks and formats.</li>
      </ul>
      <h2 class="lp-h2" id="do-it-with-lynxr">Write your next <span class="acr">UGC</span> script with lynxr</h2>
      %(cta)s
    </div>
  </section>

</main>
""" % {"title": to_html(topic["title"]), "lede": to_html(topic["lede"]),
       "count": "%d answer%s so far." % (n, "" if n == 1 else "s"),
       "dets": "\n".join(dets), "pillars": pillars, "cta": CTA}
    return "\n".join([
        "<!doctype html>", '<html lang="en">', "<head>", ch["HEAD_TOP"],
        head_metas(title, topic["desc"], url, "website"), ch["CHROME_HEAD"],
        ld(faq_ld), ld(crumbs), "</head>", ch["BODY_OPEN"], body, ch["FOOTER"], ""])


def render_stub(cfg, ch, art):
    t = topic_map(cfg)[art["theme"]]
    topic_url = "%s/faq/%s/" % (SITE, t["slug"])
    body = ('\n<main><section class="lp-hero"><div class="lp-in"><h1 class="lp-h1">This answer has moved</h1>'
            '<p class="lp-lede">See <a href="/faq/%s/">%s</a>.</p></div></section></main>\n'
            % (t["slug"], to_html(t["title"])))
    return "\n".join([
        "<!doctype html>", '<html lang="en">', "<head>", ch["HEAD_TOP"],
        "<title>%s</title>" % esc(art["title"]),
        '<meta name="robots" content="noindex">',
        '<meta http-equiv="refresh" content="0; url=/faq/%s/">' % t["slug"],
        '<link rel="canonical" href="%s">' % topic_url,
        ch["CHROME_HEAD"], "</head>", ch["BODY_OPEN"], body, ch["FOOTER"], ""])


# ---------------------------------------------------------------- marker regions

def replace_region(text, begin_prefix, end_prefix, body):
    """Replace ONLY the lines between a BEGIN and its END marker. body is "" or ends with a newline."""
    lines = text.split("\n")
    bi = [i for i, l in enumerate(lines) if l.lstrip().startswith(begin_prefix)]
    ei = [i for i, l in enumerate(lines) if l.lstrip().startswith(end_prefix)]
    if len(bi) != 1 or len(ei) != 1:
        raise ValueError("marker pair %r / %r must occur exactly once (found %d / %d)"
                         % (begin_prefix, end_prefix, len(bi), len(ei)))
    if ei[0] <= bi[0]:
        raise ValueError("marker %r comes after %r" % (end_prefix, begin_prefix))
    mid = body[:-1].split("\n") if body else []
    return "\n".join(lines[:bi[0] + 1] + mid + lines[ei[0]:])


def region_faq(cfg, arts):
    lis = []
    for t in cfg["topics"]:
        L = live_in_topic(arts, t["slug"])
        if not L:
            continue
        nw = L[-1]
        lis.append('        <li><b><a href="/faq/%s/">%s</a></b> — %d answer%s. newest: <a href="/blog/%s/">%s</a></li>'
                   % (t["slug"], to_html(t["title"]), len(L), "" if len(L) == 1 else "s", nw["slug"], to_html(nw["title"])))
    if not lis:
        return ""
    return ('  <section class="lp-sec">\n    <div class="lp-in">\n'
            '      <h2 class="lp-h2" id="ugc-questions">questions <span class="acr">UGC</span> creators ask</h2>\n'
            '      <p class="lp-p">short answers to the questions people ask about <span class="acr">UGC</span> work, '
            'grouped by topic. each one links to a full answer.</p>\n      <ul class="lp-list">\n'
            + "\n".join(lis) + "\n      </ul>\n    </div>\n  </section>\n")


def region_blog(cfg, arts):
    live = sorted((a for a in arts.values() if a["status"] == "live"), key=lambda a: (a["published"], a["slug"]), reverse=True)
    if not live:
        return ""
    topics = topic_map(cfg)
    lis = ['        <li><b><a href="/blog/%s/">%s</a></b> — %s, %s.</li>'
           % (a["slug"], to_html(a["title"]), to_html(topics[a["theme"]]["short"]), date_long(a["published"]))
           for a in live[:10]]
    tl = [t for t in cfg["topics"] if live_in_topic(arts, t["slug"])]
    links = " · ".join('<a href="/faq/%s/">%s</a>' % (t["slug"], to_html(t["title"])) for t in tl)
    return ('  <section class="lp-sec">\n    <div class="lp-in">\n'
            '      <h2 class="lp-h2" id="newest-answers">Newest answers for <span class="acr">UGC</span> creators</h2>\n'
            '      <ul class="lp-list">\n' + "\n".join(lis) + "\n      </ul>\n"
            '      <p class="lp-p">Every answer, by topic: ' + links + "</p>\n    </div>\n  </section>\n")


def region_sitemap(cfg, arts):
    entries = []
    for t in cfg["topics"]:
        L = live_in_topic(arts, t["slug"])
        if L:
            entries.append(("%s/faq/%s/" % (SITE, t["slug"]), max(a["published"] for a in L)))
    for a in arts.values():
        if a["status"] == "live":
            entries.append(("%s/blog/%s/" % (SITE, a["slug"]), a["published"]))
    entries.sort()
    return "".join("  <url>\n    <loc>%s</loc>\n    <lastmod>%s</lastmod>\n    <priority>0.6</priority>\n  </url>\n" % e
                   for e in entries)


def region_llms(cfg, arts):
    out = []
    for t in cfg["topics"]:
        L = live_in_topic(arts, t["slug"])
        if not L:
            continue
        out.append("- [%s](%s/faq/%s/): %s" % (t["title"], SITE, t["slug"], plain(t["desc"])))
        for a in L:
            out.append("  - [%s](%s/blog/%s/): %s" % (a["title"], SITE, a["slug"], plain(a["description"])))
    if not out:
        return ""
    return "## Questions UGC creators ask\n\n" + "\n".join(out) + "\n\n"


# ---------------------------------------------------------------- render_all

def render_all(root=None):
    """Write every agent-owned file under root. Returns the set of relative paths whose bytes changed."""
    root = pathlib.Path(root or DEFAULT_ROOT)
    cfg = load_config(root)
    arts = load_articles(root)
    topics = topic_map(cfg)
    for a in arts.values():
        if a["theme"] not in topics:
            raise ValueError("article %s has unknown topic %s" % (a["slug"], a["theme"]))
    ch = chrome(root, cfg)
    outputs = {}
    for a in arts.values():
        if a["status"] == "live":
            outputs["blog/%s/index.html" % a["slug"]] = render_article_page(root, cfg, ch, a, arts)
        elif a["status"] == "withdrawn":
            outputs["blog/%s/index.html" % a["slug"]] = render_stub(cfg, ch, a)
    for t in cfg["topics"]:
        if live_in_topic(arts, t["slug"]):
            outputs["faq/%s/index.html" % t["slug"]] = render_topic_page(root, cfg, ch, t, arts)
    shared = [
        ("faq/index.html", "<!-- BEGIN UGC AGENT: topics", "<!-- END UGC AGENT: topics", region_faq(cfg, arts)),
        ("blog/index.html", "<!-- BEGIN UGC AGENT: newest answers", "<!-- END UGC AGENT: newest answers", region_blog(cfg, arts)),
        ("sitemap.xml", "<!-- BEGIN UGC AGENT -->", "<!-- END UGC AGENT -->", region_sitemap(cfg, arts)),
        ("llms.txt", "<!-- BEGIN UGC AGENT -->", "<!-- END UGC AGENT -->", region_llms(cfg, arts)),
    ]
    for rel, b, e, body in shared:
        outputs[rel] = replace_region((root / rel).read_text(encoding="utf-8"), b, e, body)
    changed = set()
    for rel, text in outputs.items():
        p = root / rel
        data = text.encode("utf-8")
        if p.exists() and p.read_bytes() == data:
            continue
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        changed.add(rel)
    return changed


if __name__ == "__main__":
    import sys
    r = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_ROOT
    ch_ = render_all(r)
    print("\n".join(sorted(ch_)) if ch_ else "no changes")
