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
  const CLIP_RE = /^showcase\/[a-f0-9]{12}-[a-f0-9]{16}\.mp4$/;   // a short muted loop beside the cover (optional)
  /* UNTIL REAL LYNXR VIDEOS QUALIFY, OUR COFOUNDER'S OWN (owner, 2026-10-06: "make them all gawins"): a static file in this
     repo — assets/showcase/founder.json, its covers and clips beside it — shown when showcase_public() has too few. Labelled
     for what they are: his handle, "lynxr cofounder", when posted and the date the numbers were read. Never "made with
     lynxr" and never "this week": they are neither. */
  const FOUNDER_URL = "/assets/showcase/founder.json";
  const FOUNDER_MEDIA_RE = { jpg: /^\/assets\/showcase\/[A-Za-z0-9_-]{5,40}\.jpg$/, mp4: /^\/assets\/showcase\/[A-Za-z0-9_-]{5,40}\.mp4$/ };
  const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
  const URL_RE = {
    tiktok: /^https:\/\/www\.tiktok\.com\/@[a-z0-9._]{1,30}\/video\/\d{5,25}\/?$/,
    instagram: /^https:\/\/www\.instagram\.com\/(reel|reels|p)\/[A-Za-z0-9_-]{5,40}\/?$/,
    youtube: /^https:\/\/www\.youtube\.com\/shorts\/[A-Za-z0-9_-]{11}\/?$/,   // the cofounder's file only (cleanEntry keeps to TikTok/Instagram)
  };
  const PLAT_NAME = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" };
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
      followers: cleanFollowers(e.followers), ...(typeof e.clip === "string" && CLIP_RE.test(e.clip) ? { clip: e.clip } : {}) };
  }

  /** Views a video gained in the 7 days up to its latest measurement, from the MEASURED points only, or null when that cannot
      be known: the measurement is older than a week (not "this week"), or no point reaches back to the start of the week of
      a video older than that. A video posted within the week gained everything it has. Never estimated past the points. */
  function weekGain(e, today = new Date().toISOString().slice(0, 10)) {
    const pts = Array.isArray(e && e.points) ? e.points : [];
    if (!pts.length || !isYmd(e.views_on) || !isYmd(today)) return null;
    const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${e.views_on}T00:00:00Z`)) / 864e5;
    if (!(age >= 0 && age <= 7)) return null;
    const last = pts[pts.length - 1], from = last[0] - 7;
    if (from <= 0) return last[1];
    let prev = null;
    for (const p of pts) {
      if (p[0] <= from) { prev = p; continue; }
      if (!prev) return null;
      const t = (from - prev[0]) / (p[0] - prev[0]);
      return Math.max(0, Math.round(last[1] - (prev[1] + t * (p[1] - prev[1]))));
    }
    return Math.max(0, last[1] - prev[1]);
  }

  /** THE TOP OF THE WEEK (owner, 2026-10-06: "have it say top 5 videos this week with a gold background"): the approved
      videos with a known gain this week, most views gained first, at most `k`. The label claims "top N this week", so
      only videos whose this-week gain was measured can be in it. */
  function topOfWeek(entries, k = 5, today) {
    return (entries || []).map((e, i) => ({ e, i, g: weekGain(e, today) }))
      .filter((x) => x.g !== null && x.g > 0)
      .sort((a, b) => b.g - a.g || a.i - b.i)
      .slice(0, k).map((x) => x.e);
  }

  /** founder.json -> { entries, typical: null, founder: true }: every entry checked as strictly as an RPC one, its media
      only from /assets/showcase/. Anything that does not look exactly right is dropped. Most viewed first, at most 5.
      The file's platform and handle are the default; an entry may name its own (owner, 2026-10-07: his YouTube Short and
      his second Instagram account), and its link must be that platform's. Its own as_of overrides the file's too. */
  function cleanFounder(json) {
    const out = { entries: [], typical: null, founder: true };
    if (!json || typeof json !== "object" || !isYmd(json.as_of)) return out;
    for (const e of Array.isArray(json.entries) ? json.entries : []) {
      if (!e || typeof e !== "object" || typeof e.id !== "string" || !/^[A-Za-z0-9_-]{5,40}$/.test(e.id)) continue;
      const platform = e.platform === undefined ? json.platform : e.platform;
      const handle = e.handle === undefined ? json.handle : e.handle;
      const asOf = e.as_of === undefined ? json.as_of : e.as_of;
      if (platform !== "instagram" && platform !== "youtube") continue;
      if (typeof handle !== "string" || !HANDLE_RE.test(handle) || !isYmd(asOf)) continue;
      if (typeof e.url !== "string" || !URL_RE[platform].test(e.url) || !isCount(e.views, 1) || !isYmd(e.posted)) continue;
      if (typeof e.cover !== "string" || !FOUNDER_MEDIA_RE.jpg.test(e.cover)) continue;
      const clip = typeof e.clip === "string" && FOUNDER_MEDIA_RE.mp4.test(e.clip) ? e.clip : null;
      out.entries.push({ id: e.id, platform, handle, url: e.url, posted: e.posted, tag: "founder",
        views: e.views, views_on: asOf, points: [], followers: null, kind: "founder", coverSrc: e.cover, ...(clip ? { clipSrc: clip } : {}) });
    }
    out.entries.sort((a, b) => b.views - a.views);
    out.entries = out.entries.slice(0, 5);
    return out;
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

  const profileUrl = (platform, handle) => (platform === "instagram" ? `https://www.instagram.com/${handle}/`
    : platform === "youtube" ? `https://www.youtube.com/@${handle}` : `https://www.tiktok.com/@${handle}`);

  /** [boldPart, rest] of the connection label, or null. The company name keeps its own case (the caller wraps it in .entity). */
  function tagText(tag) {
    if (tag === "agency") return ["Lynx Media Group", " creator"];
    if (tag === "comp") return ["", "free lynxr plan"];
    if (tag === "founder") return ["", "lynxr cofounder"];
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

  /* The dev sample's local covers, by entry id — looked up only when rendering the dev preview, so parsePayload's checks
     stay exactly as strict for it as for the live answer. */
  const DEV_COVERS = { e1: "/output/showcase-sample/DLloiBesrzN.jpg" };
  const DEV_CLIPS = { e1: "/output/showcase-sample/DLloiBesrzN.mp4" };   // made with ffmpeg: 540x960, muted, 11s

  function devSample(mode) {
    const mk = (id, platform, handle, views, points, extra = {}) => ({
      id, platform, handle,
      url: platform === "instagram" ? `https://www.instagram.com/reel/SampleAAA${id}/` : `https://www.tiktok.com/@${handle}/video/1000000000${id.slice(1)}`,
      cover: `showcase/${id.padEnd(12, "0")}-0000000000000000.jpg`, posted: "2026-09-20", tag: null,
      views, views_on: "2026-10-04", points, followers: null, ...extra });
    const day = new Date().toISOString().slice(0, 10);
    /* ONE REAL VIDEO, for the look only (owner, 2026-10-06: "use this as a sample"): @collegewithgawin's reel, read once on
       2026-10-06 through pipeline/showcase.py --cover-dry (Apify: 2,178,334 views, posted 2025-07-02). It is a staff
       account and predates lynxr, so it can NEVER be a real entry; it lives in this localhost-only sample. Its cover is
       NOT in the repo: output/showcase-sample/ is gitignored, and when the file is missing the slide falls back to the
       gradient. One measured point, so no growth line is drawn (the card never invents one). */
    const posted = Date.UTC(2025, 6, 2), dayN = Math.floor((Date.UTC(2026, 9, 6) - posted) / 864e5);
    const real = { ...mk("e1", "instagram", "collegewithgawin", 2178334, [[dayN, 2178334]], { views_on: "2026-10-06", posted: "2025-07-02" }),
      url: "https://www.instagram.com/reel/DLloiBesrzN/" };
    const four = [
      mk("a1", "tiktok", "sample.one", 120000, [[0, 1000], [1, 30000], [3, 80000], [7, 100000], [14, 120000]],
        { followers: { from: 10000, from_on: "2026-09-10", to: 12500, to_on: "2026-10-03" } }),
      mk("a2", "instagram", "sample.two", 50000, [[0, 500], [2, 20000], [6, 50000]], { tag: "agency" }),
      mk("a3", "tiktok", "sample.three", 8000, [[5, 8000]]),
      mk("a4", "tiktok", "sample.handle.that.is.long.xx", 300000, [[0, 2000], [4, 150000], [9, 300000]], { tag: "comp", views_on: day }),
    ];
    if (mode === "few") return { v: 1, typical: { views: 1234, n: 40, day: 7 }, entries: four.slice(0, 2) };
    if (mode === "notypical") return { v: 1, typical: null, entries: four };
    return { v: 1, typical: { views: 1234, n: 40, day: 7 }, entries: [real, ...four] };
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

  /** "in 14 days · ", "on its first day · " or "": how fast the number came, from the last measured day after posting. */
  function speedText(last) {
    if (last === null || last === undefined) return "";
    return last > 0 ? `in ${last} day${last === 1 ? "" : "s"} · ` : "on its first day · ";
  }

  /* ONE SLIDE, FULL-BLEED (owner, 2026-10-06: "have the entire box be filled with the video so the edge of the box is
     the edge of the video and then important things people would need to see in order to be convinced this works").
     The cover IS the slide — and the link to the post — and over it: "made with lynxr" and the platform at the top;
     at the bottom, on a dark fade, who made it (their handle, linked, and any connection to us), the number, how fast
     it came and that lynxr measured it, the growth line, and followers gained. */
  function buildSlide(e, i, n, dev) {
    const plat = PLAT_NAME[e.platform];
    const slide = el("article", "sc-slide");
    slide.setAttribute("aria-roledescription", "slide");
    slide.setAttribute("aria-label", `${i + 1} of ${n}`);

    const tile = openLink(el("a", "sc-tile"), e.url);
    tile.setAttribute("aria-label", `watch @${e.handle}'s video on ${plat} (opens in a new tab)`);
    const fake = () => el("span", "sc-cover sc-cover-fake", "SAMPLE");
    if (e.coverSrc) {                              // the cofounder's: from this site's own /assets/showcase/
      const img = el("img", "sc-cover");
      img.alt = ""; img.src = e.coverSrc; img.width = 540; img.height = 960; img.decoding = "async";
      tile.appendChild(img);
    } else if (dev && DEV_COVERS[e.id]) {                 // the dev sample's one real video: a local, gitignored cover
      const img = el("img", "sc-cover");
      img.alt = ""; img.src = DEV_COVERS[e.id]; img.width = 360; img.height = 640;
      img.addEventListener("error", () => img.replaceWith(fake()), { once: true });
      tile.appendChild(img);
    } else if (dev) {
      tile.appendChild(fake());
    } else {
      const img = el("img", "sc-cover");
      img.alt = ""; img.src = `${SB_URL}/storage/v1/object/public/lynxr-covers/${e.cover}`;
      img.width = 360; img.height = 640; img.decoding = "async";
      tile.appendChild(img);
    }
    /* IT PLAYS (owner, 2026-10-06: "while its showing the videos on the side have it actually play the video"): a short
       muted loop from our own storage, laid over the cover (which stays as the fallback and the first frame). Only the
       slide on show plays (render). Not under reduced motion or Save-Data: there the cover stands alone. */
    const clip = e.clipSrc || (dev ? DEV_CLIPS[e.id] : (e.clip ? `${SB_URL}/storage/v1/object/public/lynxr-covers/${e.clip}` : null));
    const calm = (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      || !!(navigator.connection && navigator.connection.saveData);
    if (clip && !calm) {
      const v = el("video", "sc-video");
      v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true; v.preload = "none";
      v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.setAttribute("aria-hidden", "true");
      v.disablePictureInPicture = true;
      v.addEventListener("error", () => v.remove(), { once: true });
      v.src = clip;
      tile.appendChild(v);
    }
    slide.appendChild(tile);


    const data = el("div", "sc-data");
    const who = el("p", "sc-who");
    who.appendChild(openLink(el("a", "sc-handle", `@${e.handle}`), profileUrl(e.platform, e.handle)));
    const tag = tagText(e.tag);
    if (tag) {
      const t = el("span", "sc-tag");
      if (tag[0]) t.appendChild(el("span", "entity", tag[0]));
      t.appendChild(document.createTextNode(tag[1]));
      who.appendChild(t);
    }
    data.appendChild(who);
    const big = el("p", "sc-big");
    big.appendChild(el("b", null, viewsShort(e.views)));
    big.appendChild(document.createTextNode(" views"));
    data.appendChild(big);
    const last = e.points.length ? e.points[e.points.length - 1][0] : null;
    data.appendChild(el("p", "sc-when", e.kind === "founder"
      ? `posted ${dateShort(e.posted)} · views as of ${dateShort(e.views_on)}`
      : `${speedText(last)}tracked by lynxr, as of ${dateShort(e.views_on)}`));

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
    slide.appendChild(data);
    return slide;
  }

  function starIcon() {
    const svg = svgEl("svg", { viewBox: "0 0 12 12", width: "12", height: "12", "aria-hidden": "true", focusable: "false", class: "sc-star" });
    svg.appendChild(svgEl("path", { d: "M6 .8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L6 9l-3.2 1.7.6-3.6L.8 4.6l3.6-.5z", fill: "currentColor" }));
    return svg;
  }

  function chevron(dir) {
    const svg = svgEl("svg", { viewBox: "0 0 12 12", width: "14", height: "14", "aria-hidden": "true", focusable: "false" });
    svg.appendChild(svgEl("path", { d: dir < 0 ? "M7.5 2.5 4 6l3.5 3.5" : "M4.5 2.5 8 6 4.5 9.5", fill: "none", stroke: "currentColor",
      "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" }));
    return svg;
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

    /* "top N videos this week" only when it is true: at least SHOWCASE_MIN approved videos with a measured gain this week,
       the five biggest first. Otherwise the approved videos as ranked, under "made with lynxr". The dev sample keeps its
       own order (placeholders, plus one real video with a single measurement) so the preview opens on the real one. */
    const founder = !!parsed.founder;
    const week = founder ? [] : dev === "sample" ? parsed.entries.slice(0, 5) : topOfWeek(parsed.entries);
    const isTop = week.length >= SHOWCASE_MIN;
    const entries = founder ? parsed.entries : isTop ? week : parsed.entries;
    const n = entries.length;
    const root = el("div", "sc");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "made with lynxr: real videos and their measured numbers");

    // the videos, full-bleed, one at a time (buildSlide)
    const stage = el("div", "sc-stage");
    stage.setAttribute("aria-live", "off");
    const slides = entries.map((e, i) => buildSlide(e, i, n, dev));
    slides.forEach((s) => stage.appendChild(s));
    root.appendChild(stage);

    /* THE TOP: story bars — one per video, the current one filling over ROTATE_MS, each a button to jump there —
       and pause. MANUAL NAVIGATION (owner, 2026-10-06: "it cycles automatically and allows the user to scroll
       through them manually too"): the bars, ‹ › on the card's edges, a sideways swipe or drag on the video, a
       sideways trackpad scroll, and ← → while focus is in the card. Any manual move starts the new video's bar
       from empty, so the next automatic step is a full ROTATE_MS away. */
    const top = el("div", "sc-top");
    const bars = el("div", "sc-bars");
    const segs = entries.map((e, i) => {
      const b = el("button", "sc-seg");
      b.type = "button";
      b.setAttribute("aria-label", `video ${i + 1} of ${n}`);
      b.appendChild(el("i", "sc-fill"));
      bars.appendChild(b);
      return b;
    });
    const fills = segs.map((b) => b.firstChild);
    top.appendChild(bars);
    const pause = el("button", "sc-pause");
    pause.type = "button";
    top.appendChild(pause);
    root.appendChild(top);
    const arrow = (dir) => {
      const b = el("button", `sc-arrow ${dir < 0 ? "sc-prev" : "sc-next"}`);
      b.type = "button";
      b.setAttribute("aria-label", dir < 0 ? "previous video" : "next video");
      b.appendChild(chevron(dir));
      return b;
    };
    const prev = arrow(-1), next = arrow(1);
    if (n > 1) { root.appendChild(prev); root.appendChild(next); }
    // the cofounder's: "top N videos" (his most viewed of the posts read), gold, never "this week" (owner kept the gold badge)
    const gold = isTop || founder;
    const badge = el("p", gold ? "sc-badge sc-badge-top" : "sc-badge");
    if (gold) badge.appendChild(starIcon());
    badge.appendChild(document.createTextNode(founder ? `top ${n} videos` : isTop ? `top ${n} videos this week` : "made with lynxr"));
    root.appendChild(badge);

    /* NO TYPICAL-RESULT LINE ON THE CARD (owner, 2026-10-06, asked twice: "get rid of this"). It was the FTC disclosure for
       standout results (16 CFR 255.2(b)); the lawyer read must settle where that disclosure lives BEFORE this card goes
       live (plan lynxr-showcase.md). The gate (SHOWCASE_NEED_TYPICAL) still requires the typical figure to exist. */

    /* rotation: the current bar fills while nothing says to hold still (paused, hovered, focus inside, under half on
       screen, a hidden tab, reduced motion); full, the next video comes in from the side it is coming from (CSS keys
       on the stage's data-dir). Reduced motion: no automatic steps, no slide, no fade. */
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    let idx = 0, paused = false, hover = false, inside = false, seen = true, elapsed = 0, lastTick = 0;
    const still = () => !!(reduce && reduce.matches);
    const held = () => still() || paused || hover || inside || !seen || document.hidden;
    const videos = slides.map((s) => s.querySelector("video"));
    // a playing video's slide lasts its clip (4-15s); a still one ROTATE_MS
    const slideMs = () => {
      const v = videos[idx];
      return v && isFinite(v.duration) && v.duration > 0 ? Math.min(15000, Math.max(4000, v.duration * 1000)) : ROTATE_MS;
    };
    // only the slide on show plays, and only while the card is on screen, the tab visible and nobody pressed pause
    const syncVideo = () => {
      videos.forEach((v, k) => {
        if (!v) return;
        const want = k === idx && !paused && seen && !document.hidden;
        if (want && v.paused) v.play().catch(() => {});
        else if (!want && !v.paused) v.pause();
      });
    };
    const paintBars = () => {
      const p = still() ? 1 : Math.min(1, elapsed / slideMs());
      fills.forEach((f, k) => { f.style.transform = `scaleX(${k < idx ? 1 : k > idx ? 0 : p.toFixed(3)})`; });
    };
    const show = (i, dir = "next") => {
      idx = ((i % n) + n) % n;
      elapsed = 0;
      stage.setAttribute("data-dir", dir);
      slides.forEach((s, k) => { s.hidden = k !== idx; });
      videos.forEach((v, k) => { if (v && k !== idx) { v.pause(); try { v.currentTime = 0; } catch { /* not loaded */ } } });
      syncVideo();
      segs.forEach((b, k) => { if (k === idx) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); });
      root.classList.add("sc-jump");                       // the bars snap to their new state, then fill smoothly again
      paintBars();
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("sc-jump")));
    };
    const goTo = (i, dir) => { if (n > 1) show(i, dir); };
    const paintPause = () => {
      pause.setAttribute("aria-label", paused ? "play" : "pause");
      pause.replaceChildren(pauseIcon(paused));
    };
    segs.forEach((b, k) => b.addEventListener("click", () => goTo(k, k < idx ? "prev" : "next")));
    prev.addEventListener("click", () => goTo(idx - 1, "prev"));
    next.addEventListener("click", () => goTo(idx + 1, "next"));
    root.addEventListener("keydown", (e) => {
      if (n < 2 || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowRight") { e.preventDefault(); goTo(idx + 1, "next"); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goTo(idx - 1, "prev"); }
    });
    /* SWIPE / DRAG: a mostly-sideways move on the video (finger, pen or mouse) of 40px or more goes one video
       that way; the slide follows the finger a little while it moves. Vertical moves stay the page's scroll
       (app.css: touch-action: pan-y). A drag that ends on the cover is not a click on it. */
    let drag = null, swipedAt = 0;
    stage.addEventListener("dragstart", (e) => e.preventDefault());   // no ghost image of the cover
    stage.addEventListener("pointerdown", (e) => {
      if (n < 2 || (e.pointerType === "mouse" && e.button !== 0)) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId, dx: 0, side: false };
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.dx = e.clientX - drag.x;
      if (!drag.side && Math.abs(drag.dx) > 8 && Math.abs(drag.dx) > Math.abs(e.clientY - drag.y) * 1.2) {
        drag.side = true;
        stage.classList.add("sc-dragging");
        try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      if (drag.side && !still()) slides[idx].style.transform = `translateX(${(drag.dx * 0.35).toFixed(1)}px)`;
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      stage.classList.remove("sc-dragging");
      slides[idx].style.transform = "";
      if (d.side && Math.abs(d.dx) >= 40) { swipedAt = performance.now(); goTo(idx + (d.dx < 0 ? 1 : -1), d.dx < 0 ? "next" : "prev"); }
      else if (d.side) swipedAt = performance.now();
    };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    stage.addEventListener("click", (e) => { if (performance.now() - swipedAt < 400) { e.preventDefault(); e.stopPropagation(); } }, true);
    // A SIDEWAYS TRACKPAD SCROLL (or shift-wheel) on the card: one video per gesture. Vertical scrolling is untouched.
    let wheelSum = 0, wheelAt = 0, wheelLock = 0;
    root.addEventListener("wheel", (e) => {
      if (n < 2 || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();                                   // and no browser back/forward swipe
      const now = performance.now();
      if (now < wheelLock) return;
      if (now - wheelAt > 250) wheelSum = 0;
      wheelAt = now;
      wheelSum += e.deltaX;
      if (Math.abs(wheelSum) > 60) {
        goTo(idx + (wheelSum > 0 ? 1 : -1), wheelSum > 0 ? "next" : "prev");
        wheelSum = 0;
        wheelLock = now + 650;                              // one move per flick, however long the momentum runs
      }
    }, { passive: false });
    pause.addEventListener("click", () => { paused = !paused; paintPause(); syncVideo(); });
    root.addEventListener("mouseenter", () => { hover = true; });
    root.addEventListener("mouseleave", () => { hover = false; });
    root.addEventListener("focusin", () => { inside = true; });
    root.addEventListener("focusout", () => { inside = false; });
    show(0);
    paintPause();

    panel.appendChild(root);
    panel.classList.add("sc-on");
    root.style.setProperty("--sc-foot-h", "8px");   // nothing under the numbers now but the card's own edge
    syncVideo();
    document.addEventListener("visibilitychange", syncVideo);
    if (n > 1) {
      if ("IntersectionObserver" in window) {
        new IntersectionObserver((list) => { seen = list[list.length - 1].intersectionRatio >= 0.5; }, { threshold: [0, 0.5, 1] }).observe(panel);
      }
      lastTick = performance.now();
      setInterval(() => {
        const now = performance.now(), dt = now - lastTick;
        lastTick = now;
        if (!held()) {
          elapsed += dt;
          if (elapsed >= slideMs()) { show(idx + 1, "next"); return; }
        }
        syncVideo();
        paintBars();
      }, 100);
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

  function fetchFounder() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SWAP_DEADLINE_MS);
    return fetch(FOUNDER_URL, { signal: ctl.signal, cache: "no-cache" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(cleanFounder, () => ({ entries: [] })).finally(() => clearTimeout(timer));
  }

  async function boot() {
    const keep = (why) => console.info("[showcase] kept the card:", why);
    if (!SHOWCASE_LIVE) return;
    if (!document.body || !document.body.classList.contains("home")) return;
    const panel = document.querySelector("body.home .hx-half.hx-r > .hx-panel");
    if (!panel) return;
    if (!panel.getClientRects().length) return keep("the card is not shown here (a phone)");   // nothing fetched, no video loaded
    try { if (localStorage.getItem("lynxr_creator_session")) return; } catch { /* ignore */ }   // signed in: straight to the app
    const dev = devMode(location.hostname, location.search);
    const founder = dev ? null : fetchFounder();                          // in parallel: the fallback is ready when needed
    const tryFounder = async (why) => {
      const f = founder && await founder;
      if (f && f.entries.length >= 2) return render(panel, f, null);
      return keep(why);
    };
    try {
      let parsed = parsePayload(await fetchPublic(dev));
      if (!decide(parsed).show) return tryFounder(decide(parsed).why);
      if (!dev) {
        parsed = { ...parsed, entries: await preload(parsed.entries) };      // drop what cannot be drawn, then decide again
        if (!decide(parsed).show) return tryFounder(decide(parsed).why);
      }
      render(panel, parsed, dev);
    } catch (err) {
      tryFounder(err && err.name === "AbortError" ? "timeout" : "no answer");
    }
  }

  return { parsePayload, cleanFounder, decide, devMode, sparkPoints, profileUrl, tagText, followersLine, viewsShort, dateShort, weekGain, topOfWeek, boot };
});
