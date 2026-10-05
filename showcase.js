/* THE SHOWCASE (plan ~/.claude/plans/lynxr-showcase.md): real videos made with lynxr scripts, with the numbers lynxr measured,
   shown in the landing page's right-hand card instead of the coach row and paste box.

   WHEN IT SHOWS. Only when the public read (the one anonymous door, rpc/showcase_public in supabase/showcase.sql) returns at
   least SHOWCASE_MIN approved, consented, checked entries AND a real "typical" figure, in time (SWAP_DEADLINE_MS), and while
   nobody is using the paste box. In every other case this file does nothing and the card stays exactly as index.html wrote it.
   There is no empty state, no placeholder and no sample number anywhere in the production path: the sample in devSample() is
   reachable only on localhost with ?obtest=1&showcase=sample.

   NEVER innerHTML WITH DATA. Everything below is built with createElement/textContent/setAttribute, and positions are set
   through CSSOM (el.style.x): the landing page's CSP drops inline style attributes and the data came from a public endpoint.

   ONE WRAPPER, NO TOP-LEVEL NAMES. home.js, creator.js and this file share one document as classic scripts, so a top-level
   const here would collide with theirs (see the note at the top of home.js). The factory below keeps every name private; in
   node (tools/test_showcase.mjs) it is exported, in the browser it boots itself.

   KILL SWITCHES, fastest first: revoke execute on showcase_public() from anon (SQL); SHOWCASE_LIVE = false (here). */
(function (factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;   // node tests
  else api.boot();                                                          // the browser
})(function () {
  // Same public project and publishable key as home.js (that file's IIFE keeps its own copy private).
  const SB_URL = "https://esakjfogplfszievvabi.supabase.co";
  const SB_KEY = "sb_publishable_pTFNX2B94PE_DFLL799w4A_4VcH2xTN";

  const SHOWCASE_LIVE = true;          // kill switch for the landing half
  const SHOWCASE_MIN = 3;              // mirrors showcase_public()
  const SHOWCASE_NEED_TYPICAL = true;  // Q2: no real typical figure, no showcase
  const SWAP_DEADLINE_MS = 2500;
  const ROTATE_MS = 6000;
  const PASTE_KEY = "lynxr_pending_paste";
  const COVER_RE = /^showcase\/[a-f0-9]{12}-[a-f0-9]{16}\.jpg$/;
  const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
  const URL_RE = {
    tiktok: /^https:\/\/www\.tiktok\.com\/@[a-z0-9._]{1,30}\/video\/\d{5,25}\/?$/,
    instagram: /^https:\/\/www\.instagram\.com\/(reel|reels|p)\/[A-Za-z0-9_-]{5,40}\/?$/,
  };
  const PLAT_NAME = { tiktok: "TikTok", instagram: "Instagram" };
  const DEV_MODES = ["sample", "few", "notypical", "error", "slow"];

  // ── pure (tested in node) ─────────────────────────────────────────────────────────────────────

  const isCount = (v, min) => Number.isInteger(v) && v >= min;
  function isYmd(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  const dayMs = (ymd) => Date.parse(`${ymd}T00:00:00Z`);

  function cleanFollowers(f) {
    if (!f || typeof f !== "object") return null;
    if (!isCount(f.from, 0) || !isCount(f.to, 0) || !isYmd(f.from_on) || !isYmd(f.to_on)) return null;
    if (dayMs(f.to_on) - dayMs(f.from_on) < 7 * 864e5) return null;
    return { from: f.from, from_on: f.from_on, to: f.to, to_on: f.to_on };
  }

  function cleanEntry(e) {
    if (!e || typeof e !== "object") return null;
    if (e.platform !== "tiktok" && e.platform !== "instagram") return null;
    if (typeof e.handle !== "string" || !HANDLE_RE.test(e.handle)) return null;
    if (typeof e.url !== "string" || !URL_RE[e.platform].test(e.url)) return null;
    if (typeof e.cover !== "string" || !COVER_RE.test(e.cover)) return null;
    if (!isCount(e.views, 1) || !isYmd(e.views_on)) return null;
    if (e.tag !== null && e.tag !== "agency" && e.tag !== "comp") return null;
    if (typeof e.id !== "string" || !/^[a-z0-9]{1,32}$/.test(e.id)) return null;
    if (!Array.isArray(e.points)) return null;
    const points = e.points
      .filter((p) => Array.isArray(p) && p.length === 2 && isCount(p[0], 0) && isCount(p[1], 0))
      .map((p) => [p[0], p[1]])
      .sort((a, b) => a[0] - b[0]);
    return { id: e.id, platform: e.platform, handle: e.handle, url: e.url, cover: e.cover,
      posted: isYmd(e.posted) ? e.posted : null, tag: e.tag, views: e.views, views_on: e.views_on, points,
      followers: cleanFollowers(e.followers) };
  }

  /** The RPC answer -> { entries, typical }. Anything that does not look exactly right is dropped, silently; nothing is ever
      filled in. */
  function parsePayload(json) {
    const out = { entries: [], typical: null };
    if (!json || typeof json !== "object") return out;
    if (Array.isArray(json.entries)) out.entries = json.entries.map(cleanEntry).filter(Boolean);
    const t = json.typical;
    if (t && typeof t === "object" && isCount(t.views, 0) && isCount(t.n, 30)) out.typical = { views: t.views, n: t.n };
    return out;
  }

  /** Show or keep today's card? -> { show, why } with why one of "few", "no_typical", "ok". */
  function decide(parsed) {
    if (!parsed || parsed.entries.length < SHOWCASE_MIN) return { show: false, why: "few" };
    if (SHOWCASE_NEED_TYPICAL && !parsed.typical) return { show: false, why: "no_typical" };
    return { show: true, why: "ok" };
  }

  /** The dev preview mode, or null. Non-null ONLY on localhost / 127.0.0.1 with ?obtest=1 and a known ?showcase= value. */
  function devMode(hostname, search) {
    if (hostname !== "localhost" && hostname !== "127.0.0.1") return null;
    let q;
    try { q = new URLSearchParams(search || ""); } catch { return null; }
    if (q.get("obtest") !== "1") return null;
    const m = q.get("showcase");
    return DEV_MODES.includes(m) ? m : null;
  }

  /** A polyline "x,y x,y" for [[day, views], ...] in a w x h box with the baseline at ZERO views, or null for under 2 points. */
  function sparkPoints(points, w = 100, h = 32) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const d0 = points[0][0], dN = points[points.length - 1][0];
    const max = Math.max(...points.map((p) => p[1]));
    if (!(dN > d0) || !(max > 0)) return null;
    const r = (n) => +n.toFixed(1);
    return points.map((p) => `${r(((p[0] - d0) / (dN - d0)) * w)},${r(h - (p[1] / max) * (h - 4))}`).join(" ");
  }

  const profileUrl = (platform, handle) => (platform === "instagram"
    ? `https://www.instagram.com/${handle}/` : `https://www.tiktok.com/@${handle}`);

  /** [boldPart, rest] of the connection label, or null. The company name keeps its own case (the caller wraps it in .entity). */
  function tagText(tag) {
    if (tag === "agency") return ["Lynx Media Group", " creator"];
    if (tag === "comp") return ["", "free lynxr plan"];
    return null;
  }

  /** "+500 followers since Sep 4", or null when the count did not grow. Never a negative, never a flat line as growth. */
  function followersLine(f, fmt, dateFmt) {
    if (!f) return null;
    const grew = f.to - f.from;
    return grew > 0 ? `+${fmt(grew)} followers since ${dateFmt(f.from_on)}` : null;
  }

  /** "12k", "1.2m": the same short form as the creator app's viewsLabel. */
  function viewsShort(n) {
    const v = Number(n) || 0;
    if (v <= 0) return "";
    if (v < 1000) return String(v);
    if (v < 999500) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`.replace(".0k", "k");
    return `${(v / 1e6).toFixed(1)}m`.replace(".0m", "m");
  }

  /** A UTC measurement date ("2026-10-05") as "today" / "Oct 5" / "Oct 5, 2025". Dates are UTC days, so they are read as such. */
  function dateShort(ymd, now = new Date()) {
    if (!isYmd(ymd)) return "";
    if (ymd === now.toISOString().slice(0, 10)) return "today";
    const opts = { month: "short", day: "numeric", timeZone: "UTC" };
    if (ymd.slice(0, 4) !== String(now.getUTCFullYear())) opts.year = "numeric";
    return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", opts);
  }

  // ── the dev sample: reachable only through devMode(), never fetched, never in a database ──────

  function devSample(mode) {
    const mk = (id, platform, handle, views, points, extra = {}) => ({
      id, platform, handle,
      url: platform === "instagram" ? `https://www.instagram.com/reel/SampleAAA${id}/` : `https://www.tiktok.com/@${handle}/video/1000000000${id.slice(1)}`,
      cover: `showcase/${id.padEnd(12, "0")}-0000000000000000.jpg`, posted: "2026-09-20", tag: null,
      views, views_on: "2026-10-04", points, followers: null, ...extra });
    const day = new Date().toISOString().slice(0, 10);
    const four = [
      mk("a1", "tiktok", "sample.one", 120000, [[0, 1000], [1, 30000], [3, 80000], [7, 100000], [14, 120000]],
        { followers: { from: 10000, from_on: "2026-09-10", to: 12500, to_on: "2026-10-03" } }),
      mk("a2", "instagram", "sample.two", 50000, [[0, 500], [2, 20000], [6, 50000]], { tag: "agency" }),
      mk("a3", "tiktok", "sample.three", 8000, [[5, 8000]]),
      mk("a4", "tiktok", "sample.handle.that.is.long.xx", 300000, [[0, 2000], [4, 150000], [9, 300000]], { tag: "comp", views_on: day }),
    ];
    if (mode === "few") return { v: 1, typical: { views: 1234, n: 40, day: 7 }, entries: four.slice(0, 2) };
    if (mode === "notypical") return { v: 1, typical: null, entries: four };
    return { v: 1, typical: { views: 1234, n: 40, day: 7 }, entries: four };
  }

  // ── DOM (browser only) ────────────────────────────────────────────────────────────────────────

  const NS = "http://www.w3.org/2000/svg";
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    return e;
  }
  function openLink(a, href) {
    a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
    return a;
  }

  function buildSlide(e, i, n, dev) {
    const plat = PLAT_NAME[e.platform];
    const slide = el("article", "sc-slide");
    slide.setAttribute("aria-roledescription", "slide");
    slide.setAttribute("aria-label", `${i + 1} of ${n}`);

    const tile = openLink(el("a", "sc-tile"), e.url);
    tile.setAttribute("aria-label", `watch @${e.handle}'s video on ${plat} (opens in a new tab)`);
    if (dev) {
      tile.appendChild(el("span", "sc-cover sc-cover-fake", "SAMPLE"));
    } else {
      const img = el("img", "sc-cover");
      img.alt = ""; img.src = `${SB_URL}/storage/v1/object/public/lynxr-covers/${e.cover}`;
      img.width = 360; img.height = 640; img.decoding = "async";
      tile.appendChild(img);
    }
    tile.appendChild(el("span", "sc-plat", plat));
    slide.appendChild(tile);

    const data = el("div", "sc-data");
    data.appendChild(openLink(el("a", "sc-handle", `@${e.handle}`), profileUrl(e.platform, e.handle)));
    const big = el("p", "sc-big");
    big.appendChild(el("b", null, viewsShort(e.views)));
    big.appendChild(document.createTextNode(" views"));
    data.appendChild(big);
    const last = e.points.length ? e.points[e.points.length - 1][0] : null;
    data.appendChild(el("p", "sc-when", `${last !== null ? `day ${last} · ` : ""}as of ${dateShort(e.views_on)}`));

    const sp = sparkPoints(e.points);
    if (sp) {
      const box = el("div", "sc-chart");
      const svg = svgEl("svg", { viewBox: "0 0 100 32", preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false", class: "sc-spark" });
      svg.appendChild(svgEl("polyline", { points: sp }));
      box.appendChild(svg);
      const [lx, ly] = sp.split(" ").pop().split(",").map(Number);
      const dot = el("span", "sc-dot");
      dot.style.left = `${lx}%`;
      dot.style.top = `${(ly / 32) * 100}%`;
      box.appendChild(dot);
      data.appendChild(box);
    }
    const fol = followersLine(e.followers, viewsShort, dateShort);
    if (fol) data.appendChild(el("p", "sc-fol", fol));
    const tag = tagText(e.tag);
    if (tag) {
      const p = el("p", "sc-tag");
      if (tag[0]) p.appendChild(el("span", "entity", tag[0]));
      p.appendChild(document.createTextNode(tag[1]));
      data.appendChild(p);
    }
    slide.appendChild(data);
    return slide;
  }

  function pauseIcon(paused) {
    const svg = svgEl("svg", { viewBox: "0 0 12 12", width: "12", height: "12", "aria-hidden": "true", focusable: "false" });
    if (paused) svg.appendChild(svgEl("path", { d: "M3 1.5v9l7.5-4.5z", fill: "currentColor" }));
    else {
      svg.appendChild(svgEl("rect", { x: "2.5", y: "1.5", width: "2.6", height: "9", fill: "currentColor" }));
      svg.appendChild(svgEl("rect", { x: "6.9", y: "1.5", width: "2.6", height: "9", fill: "currentColor" }));
    }
    return svg;
  }

  /** Swap the card's content for the showcase, if every guard still holds. Returns true when it swapped. */
  function render(panel, parsed, dev) {
    const keep = (why) => { console.info("[showcase] kept the card:", why); return false; };
    if (typeof performance !== "undefined" && performance.now() > SWAP_DEADLINE_MS) return keep("too late");
    if (!document.body.classList.contains("home") || document.body.classList.contains("gate-on")) return keep("not the plain landing page");
    const box = document.getElementById("lp-composer-url");
    if (box && (document.activeElement === box || box.value)) return keep("the paste box is in use");
    try { if (sessionStorage.getItem(PASTE_KEY)) return keep("a link is waiting to be written"); } catch { /* ignore */ }
    if (document.hidden) return keep("tab hidden");

    const entries = parsed.entries;
    const n = entries.length;
    const root = el("div", "sc");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "made with lynxr: real videos and their measured numbers");
    if (dev) root.appendChild(el("p", "sc-dev", "dev preview: fake sample data"));
    root.appendChild(el("p", "sc-k", "made with lynxr"));

    const stage = el("div", "sc-stage");
    stage.setAttribute("aria-live", "off");
    const slides = entries.map((e, i) => buildSlide(e, i, n, dev));
    slides.forEach((s) => stage.appendChild(s));
    root.appendChild(stage);

    const nav = el("div", "sc-nav");
    const dots = entries.map((e, i) => {
      const b = el("button", "sc-dot-btn");
      b.type = "button";
      b.setAttribute("aria-label", `video ${i + 1} of ${n}`);
      nav.appendChild(b);
      return b;
    });
    const pause = el("button", "sc-pause");
    pause.type = "button";
    nav.appendChild(pause);
    root.appendChild(nav);

    const foot = el("div", "sc-foot");
    const typ = el("p", "sc-typ");
    if (parsed.typical) {
      typ.appendChild(document.createTextNode("typical lynxr creator video: "));
      typ.appendChild(el("b", null, viewsShort(parsed.typical.views) || "0"));
      typ.appendChild(document.createTextNode(" views after a week"));
    } else typ.textContent = "standout results. most videos get fewer views.";
    foot.appendChild(typ);
    const go = el("a", "btn sc-go", "your turn →");
    go.href = "/?signup=1";
    go.setAttribute("data-gate", "up");
    go.setAttribute("data-lx-spot", "");
    foot.appendChild(go);
    root.appendChild(foot);

    // rotation: crossfade (CSS) every ROTATE_MS, except when anything below says to hold still
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    let idx = 0, paused = false, hover = false, inside = false, seen = true;
    const show = (i) => {
      idx = i;
      slides.forEach((s, k) => { s.hidden = k !== i; });
      dots.forEach((b, k) => { if (k === i) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); });
    };
    const paintPause = () => {
      pause.setAttribute("aria-label", paused ? "play" : "pause");
      pause.replaceChildren(pauseIcon(paused));
    };
    dots.forEach((b, k) => b.addEventListener("click", () => show(k)));
    pause.addEventListener("click", () => { paused = !paused; paintPause(); });
    root.addEventListener("mouseenter", () => { hover = true; });
    root.addEventListener("mouseleave", () => { hover = false; });
    root.addEventListener("focusin", () => { inside = true; });
    root.addEventListener("focusout", () => { inside = false; });
    show(0);
    paintPause();

    panel.appendChild(root);
    panel.classList.add("sc-on");
    if (n > 1) {
      if ("IntersectionObserver" in window) {
        new IntersectionObserver((list) => { seen = list[list.length - 1].intersectionRatio >= 0.5; }, { threshold: [0, 0.5, 1] }).observe(panel);
      }
      setInterval(() => {
        if (!(reduce && reduce.matches) && !paused && !hover && !inside && seen && !document.hidden) show((idx + 1) % n);
      }, ROTATE_MS);
    }
    document.dispatchEvent(new CustomEvent("lx:spots"));    // home.js re-picks the x's target now the card has changed
    return true;
  }

  function preload(entries) {
    return Promise.allSettled(entries.map((e) => new Promise((resolve, reject) => {
      const img = new Image();
      img.src = `${SB_URL}/storage/v1/object/public/lynxr-covers/${e.cover}`;
      img.decode().then(resolve, reject);
    }))).then((rs) => entries.filter((e, i) => rs[i].status === "fulfilled"));
  }

  function fetchPublic(dev) {
    if (dev === "error") return Promise.reject(new Error("dev: error"));
    if (dev === "slow") return new Promise((resolve) => setTimeout(() => resolve(devSample("sample")), 4000));
    if (dev) return Promise.resolve(devSample(dev));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SWAP_DEADLINE_MS);
    return fetch(`${SB_URL}/rest/v1/rpc/showcase_public`, {
      method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" }, body: "{}", signal: ctl.signal,
    }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).finally(() => clearTimeout(timer));
  }

  async function boot() {
    const keep = (why) => console.info("[showcase] kept the card:", why);
    if (!SHOWCASE_LIVE) return;
    if (!document.body || !document.body.classList.contains("home")) return;
    const panel = document.querySelector("body.home .hx-half.hx-r > .hx-panel");
    if (!panel) return;
    try { if (localStorage.getItem("lynxr_creator_session")) return; } catch { /* ignore */ }   // signed in: straight to the app
    const dev = devMode(location.hostname, location.search);
    try {
      let parsed = parsePayload(await fetchPublic(dev));
      if (!decide(parsed).show) return keep(decide(parsed).why);
      if (!dev) {
        parsed = { ...parsed, entries: await preload(parsed.entries) };      // drop what cannot be drawn, then decide again
        if (!decide(parsed).show) return keep(decide(parsed).why);
      }
      render(panel, parsed, !!dev);
    } catch (err) {
      keep(err && err.name === "AbortError" ? "timeout" : "no answer");
    }
  }

  return { parsePayload, decide, devMode, sparkPoints, profileUrl, tagText, followersLine, viewsShort, dateShort, boot };
});
