"""Deterministic quality gate for agent articles and for the whole rendered site. Standard library only.

Two levels, each returning a list of human-readable problems (empty list = pass):
  article_problems(root, art, ...)  one article's JSON and its rendered page
  site_problems(root)               every agent-owned page, the four shared files, the stamp
"""
import html
import json
import pathlib
import re
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

import render as R

SKIP_DIRS = {"venv", "output", "data", "node_modules", ".git", "tools", "agencyonly", "creatorsonly", "waitlist"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
PARTS = {"hook", "setup", "beat 1", "beat 2", "beat 3", "beat 4", "turn", "close"}
GUIDES = {"/what-is-a-video-format/", "/turn-a-video-into-a-script/", "/short-form-script-structure/",
          "/how-to-write-a-hook/", "/ugc-script-template/", "/remake-a-viral-video/"}
SCRIPT_TOPICS = {"ugc-scripts", "ugc-hooks", "ugc-formats"}

BANNED_CHARS = ["%", "$", "€", "£", "!", "<", ">"]
# Multi-word phrases and phrases with punctuation match as exact substrings (case-insensitive).
BANNED_PHRASES = [
    "per cent", "${", "lynx media", "studies show", "data shows", "according to", "on average", "most brands",
    "most creators", "industry standard", "going rate", "in today's", "let's dive", "in conclusion", "game-changer",
]
# Single words match on word boundaries, so "studying" is not "study". A few take their plain inflections.
BANNED_WORDS = [
    ("percent", r"percent"), ("lynxr", r"lynxr"), ("youtube", r"youtube"), ("facebook", r"facebook"),
    ("snapchat", r"snapchat"), ("pinterest", r"pinterest"), ("linkedin", r"linkedin"), ("twitter", r"twitter"),
    ("study", r"study"), ("research", r"research"), ("survey", r"surveys?"), ("statistic", r"statistics?"),
    ("typically", r"typically"), ("algorithm", r"algorithms?"), ("unlock", r"unlock(?:s|ed|ing)?"),
    ("elevate", r"elevate[sd]?"),
]
BANNED_WORD_RES = [(label, re.compile(r"\b(?:%s)\b" % pat, re.I)) for label, pat in BANNED_WORDS]
# Fill-in-the-blank placeholders in templates: [DATE], [PRODUCT], [NUMBER]. Square brackets, capitals only.
PLACEHOLDER = re.compile(r"\[[A-Z][A-Z _-]{1,30}\]")
SCRIPT_BANNED = re.compile(r"\b(cure|cures|cured|heal|heals|clears|cleared|guarantee|guaranteed)\b|"
                           r"fixes acne|lose weight|burns fat|results in days", re.I)
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿]")
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
ALLOW = set("I I'm I've I'd I'll TikTok Instagram Reels UGC CTA POV GRWM DM DMs FAQ B-roll SPF OK".split()) \
    | set(WEEKDAYS) | set(R.MONTHS)
WORD = re.compile(r"[A-Z][A-Za-z'’-]+")
SENT_START = re.compile(r"[.?!:][”\"')\]]*\s+$")
BROAD_LINK = re.compile(r"\[([^\]\n]*)\]\(([^)\n]*)\)")
SAY_RE = re.compile(r'<span class="ps-say">say: &ldquo;(.*?)&rdquo;</span>', re.S)


# ---------------------------------------------------------------- field walking

def fields(art):
    """Yield (label, text, kind) for every model-written string. kind: 'plain' or 'script' (say/do)."""
    yield "description", art["description"], "plain"
    yield "short_answer", art["short_answer"], "plain"
    for si, s in enumerate(art["sections"]):
        yield "heading %d" % (si + 1), s["heading"], "plain"
        for bi, b in enumerate(s["blocks"]):
            w = "section %d block %d" % (si + 1, bi + 1)
            if b.get("text"):
                yield w + " text", b["text"], "plain"
            for i, it in enumerate(b.get("items") or []):
                yield w + " item %d" % (i + 1), it, "plain"
            for i, h in enumerate(b.get("table_head") or []):
                yield w + " table head %d" % (i + 1), h, "plain"
            for ri, r in enumerate(b.get("table_rows") or []):
                for ci, c in enumerate(r):
                    yield w + " table cell %d,%d" % (ri + 1, ci + 1), c, "plain"
            if b.get("script_caption"):
                yield w + " caption", b["script_caption"], "plain"
            for i, x in enumerate(b.get("script_beats") or []):
                yield w + " beat %d say" % (i + 1), x["say"], "script"
                yield w + " beat %d do" % (i + 1), x["do"], "script"


def nwords(s):
    return len(R.plain(s).split())


def total_words(art):
    n = nwords(art["short_answer"])
    for s in art["sections"]:
        n += nwords(s["heading"])
        for b in s["blocks"]:
            n += nwords(b.get("text") or "")
            n += sum(nwords(i) for i in b.get("items") or [])
            n += sum(nwords(h) for h in b.get("table_head") or [])
            n += sum(nwords(c) for r in b.get("table_rows") or [] for c in r)
            n += nwords(b.get("script_caption") or "")
            for x in b.get("script_beats") or []:
                n += nwords(x["say"]) + nwords(x["do"])
    return n


def banned_hits(text):
    """Rule 3 hits for one string (list of the offending patterns)."""
    low = text.lower().replace("’", "'")
    hits = []
    if re.search(r"\d", text):
        hits.append("a digit")
    for c in BANNED_CHARS:
        if c in text:
            hits.append(repr(c))
    if EMOJI.search(text):
        hits.append("an emoji")
    for p in BANNED_PHRASES:
        if p in low:
            hits.append(repr(p))
    for label, rx in BANNED_WORD_RES:
        if rx.search(low):
            hits.append(repr(label))
    return hits


def proper_noun_hits(text):
    t = PLACEHOLDER.sub("x", R.plain(text))
    bad = []
    for m in WORD.finditer(t):
        w = m.group(0)
        base = re.sub(r"['’]s$", "", w)
        if w in ALLOW or base in ALLOW or (base.endswith("s") and base[:-1] in ALLOW):
            continue
        pre = t[:m.start()]
        if pre.strip() == "" or pre.endswith(("“", '"')) or SENT_START.search(pre):
            continue
        bad.append(w)
    return bad


# ---------------------------------------------------------------- html parsing

class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.errors = [], []
        self.ids, self.h1 = [], 0
        self.ld, self._inld, self._buf = [], False, ""
        self.meta, self.links = {}, []
        self.title, self._intitle = "", False
        self.styles = 0
        self.text = []
        self._main, self._skip = 0, 0
        self.details = []   # [question, answer]
        self._cap = None
        self.assets = []

    def handle_starttag(self, t, a):
        a = dict(a)
        c = (a.get("class") or "").split()
        if "style" in a:
            self.styles += 1
        if "id" in a:
            self.ids.append(a["id"])
        if t == "h1":
            self.h1 += 1
        if t == "title":
            self._intitle = True
        if t == "meta" and (a.get("name") or a.get("property")):
            self.meta[a.get("name") or a.get("property")] = a.get("content", "")
        if t == "link" and a.get("rel") == "canonical":
            self.meta["canonical"] = a.get("href")
        if t == "a" and a.get("href"):
            self.links.append(a["href"])
        if t == "script" and a.get("type") == "application/ld+json":
            self._inld, self._buf = True, ""
        if t == "main":
            self._main += 1
        if self._main and t == "section" and ("post-end" in c or self._skip):
            self._skip += 1
        if t == "summary":
            self._cap = ["q", ""]
            self.details.append(["", ""])
        if t == "p" and "lp-a" in c and a.get("id") and self.details and not self.details[-1][1]:
            self._cap = ["a", ""]
        if t not in VOID:
            self.stack.append(t)

    def handle_endtag(self, t):
        if t in VOID:
            return
        if not self.stack or self.stack[-1] != t:
            self.errors.append("unexpected </%s>" % t)
            for i in range(len(self.stack) - 1, -1, -1):
                if self.stack[i] == t:
                    del self.stack[i:]
                    break
            return
        self.stack.pop()
        if t == "script" and self._inld:
            self._inld = False
            self.ld.append(self._buf)
        if t == "title":
            self._intitle = False
        if t == "main":
            self._main -= 1
        if t == "section" and self._skip:
            self._skip -= 1
        if self._cap and ((t == "summary" and self._cap[0] == "q") or (t == "p" and self._cap[0] == "a")):
            self.details[-1][0 if self._cap[0] == "q" else 1] = " ".join(self._cap[1].split())
            self._cap = None

    def handle_data(self, d):
        if self._inld:
            self._buf += d
        elif self._intitle:
            self.title += d
        else:
            if self._cap:
                self._cap[1] += d
            if self._main and not self._skip:
                self.text.append(d)


def parse(text):
    p = Page()
    p.feed(text)
    p.src = text
    return p


def words_of(text_list):
    return re.findall(r"[a-z0-9']+", " ".join(text_list).lower())


def shingles(words, n=12):
    return {" ".join(words[i:i + n]) for i in range(len(words) - n + 1)}


def public_pages(root):
    """All public index.html pages (relative posix paths), the V2 convention."""
    root = pathlib.Path(root)
    out = []
    for p in [root / "index.html", *root.glob("*/index.html"), *root.glob("*/*/index.html")]:
        if not p.exists():
            continue
        rel = p.relative_to(root).as_posix()
        if rel.split("/")[0] in SKIP_DIRS:
            continue
        out.append(rel)
    return sorted(out)


def resolve_href(root, href):
    """None when the internal link resolves (file and #anchor), else a problem string."""
    if not href.startswith("/") or href.startswith("//"):
        return None
    path, _, frag = href.partition("#")
    path = path.split("?")[0]
    f = pathlib.Path(root) / path.lstrip("/")
    f = f / "index.html" if (path.endswith("/") or f.is_dir()) else f
    if not f.is_file():
        return "broken internal link %s" % href
    if frag and 'id="%s"' % frag not in f.read_text(encoding="utf-8"):
        return "missing anchor %s" % href
    return None


def norm(s):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", s)).replace("‑", "-").split())


# ---------------------------------------------------------------- page structure (site gate + article gate)

def structure_problems(text, rel, check_links=True, root=None, stub=False):
    """The structure rules of the routine's V2, on one rendered agent page."""
    p = parse(text)
    out = []
    for e in p.errors:
        out.append("%s: %s" % (rel, e))
    if p.stack:
        out.append("%s: unclosed tags %s" % (rel, p.stack))
    if p.h1 != 1:
        out.append("%s: h1 count %d" % (rel, p.h1))
    dup = sorted({i for i in p.ids if p.ids.count(i) > 1})
    if dup:
        out.append("%s: duplicate ids %s" % (rel, dup))
    if p.styles:
        out.append("%s: %d inline style= attribute(s)" % (rel, p.styles))
    if "${" in text:
        out.append("%s: contains ${" % rel)
    url = "https://lynxr.io/" + rel[:-len("index.html")]
    if not stub:
        if p.meta.get("canonical") != url:
            out.append("%s: canonical is %s, expected %s" % (rel, p.meta.get("canonical"), url))
        if p.meta.get("og:url") != url:
            out.append("%s: og:url is %s" % (rel, p.meta.get("og:url")))
    for k in ("description", "og:title", "og:description", "og:image", "twitter:card", "twitter:title",
              "twitter:description", "twitter:image"):
        if not stub and not p.meta.get(k):
            out.append("%s: missing meta %s" % (rel, k))
    for blk in p.ld:
        if re.search(r"&[a-zA-Z]+;|&#\d+;", blk):
            out.append("%s: HTML entity inside a JSON-LD block" % rel)
        try:
            j = json.loads(blk)
        except Exception as e:
            out.append("%s: JSON-LD does not parse: %s" % (rel, e))
            continue
        if j.get("@type") == "BreadcrumbList" and not stub and j["itemListElement"][-1]["item"] != url:
            out.append("%s: breadcrumb last item != canonical" % rel)
        if j.get("@type") == "FAQPage":
            vis = {norm(q): norm(a) for q, a in p.details}
            if len(j["mainEntity"]) != len(p.details):
                out.append("%s: FAQPage has %d questions, the page shows %d" % (rel, len(j["mainEntity"]), len(p.details)))
            for q in j["mainEntity"]:
                n, a = norm(q["name"]), norm(q["acceptedAnswer"]["text"])
                if n not in vis:
                    out.append("%s: FAQPage question not visible word for word: %r" % (rel, n))
                elif vis[n] != a:
                    out.append("%s: FAQPage answer differs from the visible answer for %r" % (rel, n))
    if check_links and root is not None:
        for h in p.links:
            m = resolve_href(root, h)
            if m:
                out.append("%s: %s" % (rel, m))
    return out


def region_problems(root, rel, begin_prefix, end_prefix):
    """Shared page: the marker pair occurs once, the region is balanced, its links resolve."""
    t = (pathlib.Path(root) / rel).read_text(encoding="utf-8")
    lines = t.split("\n")
    bi = [i for i, l in enumerate(lines) if l.lstrip().startswith(begin_prefix)]
    ei = [i for i, l in enumerate(lines) if l.lstrip().startswith(end_prefix)]
    if len(bi) != 1 or len(ei) != 1 or ei[0] <= bi[0]:
        return ["%s: marker pair %r must occur exactly once (found %d / %d)" % (rel, begin_prefix, len(bi), len(ei))]
    region = "\n".join(lines[bi[0] + 1:ei[0]])
    out = []
    stack = []

    class B(HTMLParser):
        def handle_starttag(s, tag, a):
            if tag not in VOID:
                stack.append(tag)
            for k, v in a:
                if k == "href" and v:
                    m = resolve_href(root, v)
                    if m:
                        out.append("%s region: %s" % (rel, m))

        def handle_endtag(s, tag):
            if tag in VOID:
                return
            if not stack or stack[-1] != tag:
                out.append("%s region: unbalanced </%s>" % (rel, tag))
            else:
                stack.pop()
    B().feed(region)
    if stack:
        out.append("%s region: unclosed %s" % (rel, stack))
    return out


def stamp_problems(root):
    root = pathlib.Path(root)
    ref = re.compile(r'(?:href|src)="(/?[A-Za-z0-9_./-]+\.(?:css|js))(\?v=([0-9a-z]+))?"')
    stamps, out = set(), []
    pages = []
    for p in list(root.rglob("index.html")) + [root / "404.html"]:
        if not p.exists():
            continue
        rel = p.relative_to(root)
        if rel.parts[0] in {"venv", "output", "data", "node_modules", ".git"}:
            continue
        pages.append(p)
    for p in pages:
        for m in ref.finditer(p.read_text(encoding="utf-8")):
            if m.group(3):
                stamps.add(m.group(3))
            else:
                out.append("%s: %s has no ?v= stamp" % (p.relative_to(root).as_posix(), m.group(1)))
    if len(stamps) != 1:
        out.append("stamps in use: %s (need exactly one)" % sorted(stamps))
    return out


def site_problems(root):
    root = pathlib.Path(root)
    cfg = R.load_config(root)
    arts = R.load_articles(root)
    out = []
    # agent-owned pages
    for a in arts.values():
        rel = "blog/%s/index.html" % a["slug"]
        f = root / rel
        if a["status"] == "live":
            if not f.is_file():
                out.append("%s: live article has no page" % rel)
                continue
            out += structure_problems(f.read_text(encoding="utf-8"), rel, True, root)
        elif a["status"] == "withdrawn" and f.is_file():
            t = f.read_text(encoding="utf-8")
            if 'content="noindex"' not in t or 'http-equiv="refresh"' not in t:
                out.append("%s: withdrawn stub lacks noindex/refresh" % rel)
    for t in cfg["topics"]:
        L = R.live_in_topic(arts, t["slug"])
        rel = "faq/%s/index.html" % t["slug"]
        if L:
            f = root / rel
            if not f.is_file():
                out.append("%s: topic page missing" % rel)
            else:
                out += structure_problems(f.read_text(encoding="utf-8"), rel, True, root)
    # shared pages: markers only
    out += region_problems(root, "faq/index.html", "<!-- BEGIN UGC AGENT: topics", "<!-- END UGC AGENT: topics")
    out += region_problems(root, "blog/index.html", "<!-- BEGIN UGC AGENT: newest answers", "<!-- END UGC AGENT: newest answers")
    for rel in ("sitemap.xml", "llms.txt"):
        t = (root / rel).read_text(encoding="utf-8")
        if t.count("<!-- BEGIN UGC AGENT -->") != 1 or t.count("<!-- END UGC AGENT -->") != 1:
            out.append("%s: UGC AGENT marker pair must occur exactly once" % rel)
    out += stamp_problems(root)
    try:
        ET.fromstring((root / "sitemap.xml").read_bytes())
    except Exception as e:
        out.append("sitemap.xml does not parse: %s" % e)
    sm = (root / "sitemap.xml").read_text(encoding="utf-8")
    ll = (root / "llms.txt").read_text(encoding="utf-8")
    for a in arts.values():
        if a["status"] != "live":
            continue
        u = "https://lynxr.io/blog/%s/" % a["slug"]
        if sm.count("<loc>%s</loc>" % u) != 1:
            out.append("sitemap.xml lists %s %d times (need 1)" % (u, sm.count("<loc>%s</loc>" % u)))
        if ll.count("](%s)" % u) != 1:
            out.append("llms.txt lists %s %d times (need 1)" % (u, ll.count("](%s)" % u)))
        tp = root / "faq" / a["theme"] / "index.html"
        if not tp.is_file() or tp.read_text(encoding="utf-8").count('id="%s"' % a["slug"]) != 1:
            out.append("topic page does not list %s exactly once" % a["slug"])
    return out


# ---------------------------------------------------------------- article gate

def hook_lines(art):
    hooks = []
    for s in art["sections"]:
        for b in s["blocks"]:
            if b["kind"] == "script" and b["script_beats"]:
                hooks.append(b["script_beats"][0]["say"])
    return hooks


def hnorm(s):
    return re.sub(r"[^a-z0-9 ]+", "", s.lower().replace("’", "'").replace("'", "")).split()


def trigrams(t):
    return {tuple(t[i:i + 3]) for i in range(len(t) - 2)}


def existing_hooks(root, arts, exclude_slug=None):
    """Every ps-say line on a page on disk, plus every hook in any other article JSON."""
    root = pathlib.Path(root)
    out = []
    for rel in public_pages(root):
        if exclude_slug and rel == "blog/%s/index.html" % exclude_slug:
            continue
        for m in SAY_RE.finditer((root / rel).read_text(encoding="utf-8")):
            out.append(norm(m.group(1)))
    for slug, a in arts.items():
        if slug == exclude_slug:
            continue
        out += [R.plain(h) for h in hook_lines(a)]
        out += list(a.get("hooks") or [])
    return out


class Context:
    """Per-run cache so every candidate is compared with the same page set."""

    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.pages = {}      # rel -> {title, desc, shingles}
        self.extra = {}      # rel -> shingles of an article passed earlier in this run

    def page(self, rel):
        if rel not in self.pages:
            p = parse((self.root / rel).read_text(encoding="utf-8"))
            self.pages[rel] = {"title": p.title.strip(), "desc": p.meta.get("description", ""),
                               "sh": shingles(words_of(p.text))}
        return self.pages[rel]


def resolve_link(root, target, arts, self_slug):
    """None when the link resolves: a file and #anchor in the tree, or an article / topic page of the same run
    (an article that is not on disk yet). Otherwise a problem string."""
    m = resolve_href(root, target)
    if m is None:
        return None
    path, _, frag = target.partition("#")
    am = re.fullmatch(r"/blog/([a-z0-9-]+)/", path)
    if am and am.group(1) in arts and am.group(1) != self_slug:
        ok_ids = R.section_ids(arts[am.group(1)]["sections"]) + ["do-it-with-lynxr", "more-questions", "keep-reading"]
        return None if (not frag or frag in ok_ids) else "missing anchor %s" % target
    tm = re.fullmatch(r"/faq/(ugc-[a-z-]+)/", path)
    if tm and not frag and any(a["theme"] == tm.group(1) and a["slug"] != self_slug for a in arts.values()):
        return None
    return m


def link_problems(root, art, arts):
    """Every internal link in the article must be well formed and resolve. Returns (problems, targets, per_section)."""
    out, targets, per_section = [], [], []
    slug = art["slug"]
    for si, s in enumerate(art["sections"]):
        sec_t = []
        for label, text, kind in fields({"description": "", "short_answer": "", "sections": [s]}):
            if label.startswith(("description", "short_answer", "heading")):
                continue
            stripped = PLACEHOLDER.sub("", R.LINK_RE.sub("", text))
            if "[" in stripped or "]" in stripped:
                out.append("links: malformed link markup in section %d: %r" % (si + 1, text[:60]))
            for m in BROAD_LINK.finditer(text):
                sec_t.append(m.group(2))
        per_section.append(sec_t)
        targets += sec_t
    if not 3 <= len(targets) <= 10:
        out.append("links: %d links (need 3-10)" % len(targets))
    for t in targets:
        if not R.LINK_RE.fullmatch("[x](%s)" % t):
            out.append("links: not an internal /path/ link: %s" % t)
            continue
        m = resolve_link(root, t, arts, slug)
        if m:
            out.append("links: %s" % m)
        wm = re.fullmatch(r"/blog/([a-z0-9-]+)/(?:#.*)?", t)
        if wm and arts.get(wm.group(1), {}).get("status") == "withdrawn":
            out.append("links: links to a withdrawn answer: %s" % t)
        if t.split("#")[0] == "/blog/%s/" % slug:
            out.append("links: links to itself: %s" % t)
    return out, targets, per_section


def article_problems(root, art, arts=None, ctx=None, cfg=None, ch=None):
    """Gate one article (a dict in the article-JSON shape). The caller need not set status/published."""
    root = pathlib.Path(root)
    cfg = cfg or R.load_config(root)
    arts = dict(arts if arts is not None else R.load_articles(root))
    ctx = ctx or Context(root)
    topics = R.topic_map(cfg)
    out = []
    slug = art["slug"]
    if art["theme"] not in topics:
        return ["unknown topic %r" % art["theme"]]
    secs = art["sections"]

    # 1. shape
    if not 4 <= len(secs) <= 6:
        out.append("shape: %d sections (need 4-6)" % len(secs))
    for i, s in enumerate(secs):
        h = s["heading"]
        if "[" in h or "]" in h:
            out.append("shape: heading %d contains link markup" % (i + 1))
        if not h.strip().endswith("?"):
            out.append("shape: heading %d does not end with ?: %r" % (i + 1, h))
        if not 4 <= nwords(h) <= 14:
            out.append("shape: heading %d is %d words (need 4-14): %r" % (i + 1, nwords(h), h))
        first = next((b for b in s["blocks"] if b["kind"] == "paragraph" and b["text"].strip()), None)
        if first is None:
            out.append("shape: section %d has no opening paragraph" % (i + 1))
        elif nwords(R.first_sentence(first["text"])) > 30:
            out.append("shape: first sentence of section %d is %d words (max 30)" % (i + 1, nwords(R.first_sentence(first["text"]))))
    sa = art["short_answer"]
    if "[" in sa:
        out.append("shape: short_answer contains [")
    if not 35 <= nwords(sa) <= 70:
        out.append("shape: short_answer is %d words (need 35-70)" % nwords(sa))
    if nwords(R.first_sentence(sa)) > 30:
        out.append("shape: first sentence of short_answer is %d words (max 30)" % nwords(R.first_sentence(sa)))
    tw = total_words(art)
    if not 700 <= tw <= 1300:
        out.append("shape: %d words in total (need 700-1300)" % tw)
    d = art["description"]
    if not 120 <= len(d) <= 160 or '"' in d:
        out.append("shape: description is %d characters or contains a double quote (need 120-160, no quotes)" % len(d))

    # 2. artifacts
    blocks = [b for s in secs for b in s["blocks"]]
    kinds = [b["kind"] for b in blocks]
    for b in blocks:
        if b["kind"] not in ("paragraph", "list", "table", "script"):
            out.append("artifact: unknown block kind %r" % b["kind"])
    if not ({"table", "script"} & set(kinds)):
        out.append("artifact: needs at least one table or script block")
    if art["theme"] in SCRIPT_TOPICS and "script" not in kinds:
        out.append("artifact: topic %s requires an example script" % art["theme"])
    for b in blocks:
        if b["kind"] == "script":
            bt = b["script_beats"]
            if not 4 <= len(bt) <= 7:
                out.append("script: %d beats (need 4-7)" % len(bt))
            if bt and bt[0]["part"] != "hook":
                out.append("script: first beat is %r, not hook" % bt[0]["part"])
            for x in bt:
                if x["part"] not in PARTS:
                    out.append("script: unknown part %r" % x["part"])
                if not x["say"].strip() or not x["do"].strip():
                    out.append("script: empty say or do in %r" % x["part"])
        if b["kind"] == "table":
            h, rows = b["table_head"], b["table_rows"]
            if not 2 <= len(h) <= 4:
                out.append("table: %d columns (need 2-4)" % len(h))
            if not 3 <= len(rows) <= 6:
                out.append("table: %d rows (need 3-6)" % len(rows))
            if any(len(r) != len(h) for r in rows):
                out.append("table: a row's length differs from the header")
        if b["kind"] == "list" and not b["items"]:
            out.append("list: empty")
        if b["kind"] == "paragraph" and not b["text"].strip():
            out.append("paragraph: empty")

    # 3-5. banned patterns, script claims, proper nouns
    for label, text, kind in fields(art):
        hits = banned_hits(text)
        if hits:
            out.append("banned: %s has %s" % (label, ", ".join(hits)))
        if kind == "script":
            m = SCRIPT_BANNED.search(text)
            if m:
                out.append("claim: %s has %r" % (label, m.group(0)))
        pn = proper_noun_hits(text)
        if pn:
            out.append("proper noun: %s has %s" % (label, ", ".join(sorted(set(pn)))))

    # 6. links: code is the authority, and this runs before any judge call
    link_out, targets, per_section = link_problems(root, art, arts)
    out += link_out
    gloss = {t for t in targets if t.startswith("/glossary/#")}
    if len(gloss) < 2:
        out.append("links: %d distinct /glossary/#term links (need 2)" % len(gloss))
    agent_slugs = set(arts) | {slug}
    blog_dir = root / "blog"
    old_posts = {"/blog/%s/" % p.name for p in blog_dir.iterdir()
                 if p.is_dir() and (p / "index.html").is_file() and p.name not in agent_slugs} if blog_dir.is_dir() else set()
    early = {t.split("#")[0] for sec in per_section[:2] for t in sec}
    if not (early & (GUIDES | old_posts)):
        out.append("links: no link to a guide or an earlier blog post in the first two sections")
    same = {"/blog/%s/" % a["slug"] for a in arts.values() if a["status"] == "live" and a["theme"] == art["theme"] and a["slug"] != slug}
    if same and not ({t.split("#")[0] for t in targets} & same):
        out.append("links: no link to another live answer in this topic")

    # 7. originality
    mine = hook_lines(art)
    others = existing_hooks(root, arts, exclude_slug=slug)
    for h in mine:
        hn = hnorm(R.plain(h))
        for o in others:
            on = hnorm(o)
            if hn == on:
                out.append("originality: hook repeats an existing line: %r" % R.plain(h)[:60])
                break
            a_, b_ = trigrams(hn), trigrams(on)
            if a_ and b_ and len(a_ & b_) / len(a_ | b_) >= 0.5:
                out.append("originality: hook is too close to an existing line: %r ~ %r" % (R.plain(h)[:50], o[:50]))
                break

    # render the candidate (as live) for the page-level checks
    cand = dict(art)
    cand["status"] = "live"
    cand["published"] = art.get("published") or "2000-01-01"
    arts[slug] = cand
    ch = ch or R.chrome(root, cfg)
    page_html = R.render_article_page(root, cfg, ch, cand, arts)
    rel = "blog/%s/index.html" % slug
    out += structure_problems(page_html, rel, check_links=False)
    pg = parse(page_html)
    mine_sh = shingles(words_of(pg.text))
    topic_rel = "faq/%s/index.html" % art["theme"]
    for r in public_pages(root):
        if r == rel or r == topic_rel:
            continue
        shared = mine_sh & ctx.page(r)["sh"]
        if shared:
            out.append("originality: %d shared 12-word run(s) with %s, e.g. %r" % (len(shared), r, sorted(shared)[0]))
    for r, sh in ctx.extra.items():
        if r != rel and mine_sh & sh:
            out.append("originality: shared 12-word run with %s from this run" % r)

    # 8. uniqueness
    title = art["title"]
    desc = html.unescape(R.plain(art["description"])).strip()
    for r in public_pages(root):
        if r == rel:
            continue
        pg2 = ctx.page(r)
        if html.unescape(pg2["title"]) == title:
            out.append("unique: <title> is the same as %s" % r)
        if html.unescape(pg2["desc"]).strip() == desc:
            out.append("unique: description is the same as %s" % r)
    if (blog_dir / slug).exists() and slug not in R.load_articles(root):
        out.append("unique: blog/%s already exists and is not an agent article" % slug)
    return out
