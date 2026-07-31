// Frame guard: GitHub Pages cannot send an X-Frame-Options/CSP header, and
// frame-ancestors is spec-ignored in meta CSP — so block clickjacking in JS.
// If framed, blank the page and bust out to the real site.
if (window.top !== window.self) {
  document.documentElement.innerHTML = "";
  try { window.top.location = window.location; } catch { window.location.replace("about:blank"); }
}

// The database ships as data.enc — AES-256-GCM ciphertext keyed off the access
// code via PBKDF2-SHA256 (params embedded in the bundle). The page contains no
// password and no plaintext data; a wrong code simply fails GCM authentication.
//
// The derived key is NON-EXTRACTABLE and lives only in memory for the life of
// the page — no key material is written to any storage, so a reload re-prompts.
// Honest limits: anyone GIVEN the code can share it, and the ciphertext is
// public, so a weak code could be brute-forced offline. Keep the code strong.

const gate = document.getElementById("gate");
const app = document.getElementById("app");

// Belt-and-suspenders: clear any key bytes a prior build may have persisted.
try { sessionStorage.removeItem("lynxr_k"); sessionStorage.removeItem("lynxr_access"); } catch {}

// Forgiving input: phones auto-capitalize the first letter, and pasted codes
// carry stray whitespace. Must mirror normalize_code() in export_web.py.
function normalize(s) { return (s || "").replace(/\s+/g, "").toLowerCase(); }

const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let bundlePromise = null;
function fetchBundle() {
  bundlePromise ??= fetch("data.enc", { cache: "no-store" }).then((res) => {
    if (!res.ok) throw new Error("bundle " + res.status);
    return res.json();
  });
  return bundlePromise;
}

async function deriveKey(code, bundle) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(normalize(code)), "PBKDF2", false, ["deriveKey"]);
  // extractable=false: the key can decrypt but its raw bytes can never be read
  // back out (no exportKey), so nothing can exfiltrate it even under XSS.
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64decode(bundle.salt), iterations: bundle.iter, hash: "SHA-256" },
    material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

async function decryptRows(key, bundle) {
  // Throws OperationError on a wrong key — that IS the password check.
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(bundle.iv) }, key, b64decode(bundle.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

let unlocked = false;
function unlock(rows) {
  if (unlocked) return;   // guard: double-unlock would double-bind listeners
  unlocked = true;
  document.getElementById("err").textContent = "";
  gate.classList.add("leaving");
  setTimeout(() => {
    gate.style.display = "none";
    app.style.display = "block";
    app.classList.add("shown");
  }, 160);
  renderApp(rows);
}

document.getElementById("gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = document.getElementById("pw");
  const err = document.getElementById("err");
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (!normalize(pw.value)) { err.textContent = "Enter the access code."; return; }

  submitBtn.disabled = true;
  err.textContent = "Unlocking…";
  try {
    const bundle = await fetchBundle();
    const key = await deriveKey(pw.value, bundle);   // ~0.5s: 600k PBKDF2 rounds
    const rows = await decryptRows(key, bundle);     // wrong code throws here
    pw.value = "";                                   // don't leave the code in the DOM
    unlock(rows);
  } catch (ex) {
    err.textContent = (ex && ex.message || "").startsWith("bundle")
      ? "Data bundle missing — run the pipeline and redeploy."
      : "Incorrect access code.";
    pw.select();
  } finally {
    submitBtn.disabled = false;
  }
});

const toggleBtn = document.getElementById("toggle-pw");
toggleBtn.addEventListener("click", () => {
  const pw = document.getElementById("pw");
  const showing = pw.type === "text";
  pw.type = showing ? "password" : "text";
  toggleBtn.setAttribute("aria-pressed", String(!showing));
  const label = showing ? "Show access code" : "Hide access code";
  toggleBtn.setAttribute("aria-label", label);
  toggleBtn.setAttribute("title", label);
  pw.focus();
});

document.getElementById("signout").addEventListener("click", () => {
  // Key lives only in page memory; reloading discards it and shows the gate.
  location.reload();
});

// ---------- Helpers ----------
const fmt = (n) => Number(n).toLocaleString();
function compact(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Only http(s) links are allowed through — scraped rows are attacker-influenced,
// so a javascript: or data: URL must never reach an href.
function safeUrl(u) {
  try {
    const p = new URL(String(u), location.origin);
    return (p.protocol === "http:" || p.protocol === "https:") ? p.href : "";
  } catch { return ""; }
}
const views = (r) => Number(r.views) || 0;
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function countBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const v = (r[key] || "").trim() || "(untagged)";
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function renderBars(hostId, pairs, limit = 8, drillSelectId = null) {
  const host = document.getElementById(hostId);
  const shown = pairs.slice(0, limit);
  const max = shown.length ? shown[0][1] : 1;
  const total = pairs.reduce((a, [, n]) => a + n, 0) || 1;
  host.innerHTML = shown.map(([label, count]) => `
    <div class="bar-row${drillSelectId && label !== "(untagged)" ? " drill" : ""}" data-val="${escapeHtml(label)}"
         ${drillSelectId ? `role="button" tabindex="0" title="Show these videos in the database"` : ""}>
      <div class="bar-track">
        <div class="bar-fill"></div>
        <div class="bar-label">${escapeHtml(label)}</div>
      </div>
      <div class="bar-count">${fmt(count)} <span class="bar-pct">${(count / total * 100).toFixed(count / total >= 0.1 ? 0 : 1)}%</span></div>
    </div>`).join("");
  // Widths via CSSOM, not style="" attributes — the strict CSP (style-src 'self',
  // no 'unsafe-inline') silently discards inline style attributes, which shipped
  // as invisible bars. el.style assignment is allowed under CSP.
  // Force the width:0 state to be styled, then set targets a tick later so the
  // transition animates the draw-in. setTimeout (not rAF): rAF never fires in
  // hidden tabs, which would leave the bars empty until something else painted.
  void host.offsetWidth;
  setTimeout(() => {
    [...host.querySelectorAll(".bar-fill")].forEach((el, i) => {
      el.style.transitionDelay = (i * 45) + "ms";
      el.style.width = Math.max((shown[i][1] / max) * 100, 1).toFixed(2) + "%";
    });
  }, 30);
  // Overview shows the split; clicking a bar drills into those exact videos.
  if (drillSelectId) {
    host.querySelectorAll(".bar-row.drill").forEach((rowEl) => {
      const go = () => {
        document.getElementById("reset").click();
        document.getElementById(drillSelectId).value = rowEl.dataset.val;
        applyFilters();
        document.getElementById("table-anchor").scrollIntoView({ behavior: "smooth", block: "start" });
      };
      rowEl.addEventListener("click", go);
      rowEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }
}

function renderStats(rows) {
  const totalViews = rows.reduce((a, r) => a + views(r), 0);
  const ers = rows.map((r) => parseFloat(r.engagement_rate)).filter((n) => !isNaN(n));
  const avgEr = ers.length ? ers.reduce((a, b) => a + b, 0) / ers.length : null;
  const creators = new Set(rows.map((r) => r.creator).filter(Boolean)).size;
  const cards = [
    ["Videos", fmt(rows.length), ""],
    ["Total views", compact(totalViews), fmt(totalViews)],
    ["Avg engagement", avgEr === null ? "—" : avgEr.toFixed(2) + "%", `${fmt(ers.length)} with data`],
    ["Creators", fmt(creators), ""],
  ];
  document.getElementById("stats").innerHTML = cards.map(([label, value, sub]) => `
    <div class="stat"><div class="label">${label}</div><div class="value">${value}</div>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}</div>`).join("");
}

// ---------- Tabs ----------
const TABS = [
  ["tab-database", "panel-database"],
  ["tab-brief", "panel-brief"],
  ["tab-briefs", "panel-briefs"],
];
function activateTab(tabId) {
  for (const [t, p] of TABS) {
    const on = t === tabId;
    document.getElementById(t).setAttribute("aria-selected", String(on));
    document.getElementById(p).hidden = !on;
  }
  window.scrollTo({ top: 0 });
}
function initTabs() {
  for (const [tabId] of TABS) {
    document.getElementById(tabId).addEventListener("click", () => activateTab(tabId));
  }
}

// ---------- Full browsable database ----------
const PAGE_SIZE = 50;
const COLS = [
  { key: "creator", label: "Creator" },
  { key: "platform", label: "Platform" },
  { key: "title", label: "Title", cls: "title" },
  { key: "views", label: "Views", num: true },
  { key: "likes", label: "Likes", num: true },
  { key: "comments", label: "Comments", num: true },
  { key: "engagement_rate", label: "ER", num: true, pct: true },
  { key: "format_type", label: "Format" },
  { key: "hook_pattern", label: "Hook" },
  { key: "niche_category", label: "Niche" },
  { key: "target_audience", label: "Audience" },
  { key: "data_source", label: "Source" },
];
const FILTERS = [
  { id: "f-source", key: "data_source", label: "All sources" },
  { id: "f-platform", key: "platform", label: "All platforms" },
  { id: "f-format", key: "format_type", label: "All formats" },
  { id: "f-hook", key: "hook_pattern", label: "All hooks" },
  { id: "f-niche", key: "niche_category", label: "All niches" },
];

let ALL = [];
let view = [];
let page = 0;
let sortKey = "views";
let sortDir = -1;

function numOf(r, k) { const v = parseFloat(r[k]); return isNaN(v) ? -1 : v; }

function applyFilters() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const active = FILTERS.map((f) => [f.key, document.getElementById(f.id).value]);
  view = ALL.filter((r) => {
    for (const [key, val] of active) if (val && (r[key] || "") !== val) return false;
    if (!q) return true;
    return (r.creator + " " + r.title + " " + r.format_type + " " + r.hook_pattern +
            " " + r.niche_category + " " + r.target_audience).toLowerCase().includes(q);
  });
  const isNum = COLS.find((c) => c.key === sortKey)?.num;
  view.sort((a, b) => isNum
    ? (numOf(a, sortKey) - numOf(b, sortKey)) * sortDir
    : String(a[sortKey] || "").localeCompare(String(b[sortKey] || "")) * sortDir);
  page = 0;
  renderTable();
}

function renderTable() {
  const total = view.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const slice = view.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  document.getElementById("row-count").textContent =
    total === ALL.length ? `${fmt(total)} videos` : `${fmt(total)} of ${fmt(ALL.length)}`;

  const host = document.getElementById("table-host");
  if (!total) {
    host.innerHTML = `<div class="table-wrap"><div class="no-results">No videos match those filters.</div></div>`;
  } else {
    host.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>${COLS.map((c) => `
          <th class="sortable" data-key="${c.key}" scope="col">${c.label}${
            sortKey === c.key ? ` <span class="arrow">${sortDir === -1 ? "↓" : "↑"}</span>` : ""
          }</th>`).join("")}</tr></thead>
        <tbody>${slice.map((r) => `
          <tr>${COLS.map((c) => {
            const raw = r[c.key];
            if (c.num) {
              const v = parseFloat(raw);
              if (isNaN(v)) return `<td class="num">—</td>`;
              // Compact display, exact number on hover — 40.7M scans better than 40,700,000
              return c.pct
                ? `<td class="num">${v.toFixed(2)}%</td>`
                : `<td class="num" title="${fmt(v)}">${compact(v)}</td>`;
            }
            if (c.key === "title") {
              const href = safeUrl(r.url);
              const label = escapeHtml(raw || "—");
              return `<td class="title" title="${escapeHtml(raw || "")}">${
                href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label}</td>`;
            }
            const dim = ["platform", "format_type", "hook_pattern", "niche_category", "target_audience", "data_source"].includes(c.key);
            return `<td class="${dim ? "dim" : ""}">${escapeHtml(raw || "—")}</td>`;
          }).join("")}</tr>`).join("")}
        </tbody>
      </table></div>`;
    host.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.dataset.key;
        if (sortKey === k) sortDir *= -1;
        else { sortKey = k; sortDir = COLS.find((c) => c.key === k)?.num ? -1 : 1; }
        applyFilters();
      });
    });
  }
  document.getElementById("page-info").textContent = `Page ${page + 1} of ${pages}`;
  document.getElementById("prev").disabled = page === 0;
  document.getElementById("next").disabled = page >= pages - 1;
}

function initControls() {
  for (const f of FILTERS) {
    const sel = document.getElementById(f.id);
    const values = [...new Set(ALL.map((r) => r[f.key]).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">${f.label}</option>` +
      values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    sel.addEventListener("change", applyFilters);
  }
  let t;
  document.getElementById("search").addEventListener("input", () => {
    clearTimeout(t); t = setTimeout(applyFilters, 150);
  });
  document.getElementById("reset").addEventListener("click", () => {
    document.getElementById("search").value = "";
    FILTERS.forEach((f) => (document.getElementById(f.id).value = ""));
    applyFilters();
  });
  document.getElementById("prev").addEventListener("click", () => { page--; renderTable(); });
  document.getElementById("next").addEventListener("click", () => { page++; renderTable(); });
}

// ---------- Client brief ----------
// Sample-size floors. Below these a segment is noise, not a pattern — the
// scoreboard is only trustworthy if thin buckets are labelled as such.
const MIN_N_COMBO = 8;
const MIN_N_SINGLE = 15;
const MIN_N_NICHE = 30;   // below this, fall back to the whole database

const NICHE_KEYWORDS = {
  "Health & Medical": ["health", "med", "clinic", "care", "nurse", "nursing", "doctor", "dental",
    "pharm", "therap", "wellness", "patient", "hospital", "mental", "derm", "vet", "surgery", "emt"],
  "Education & Study": ["edu", "study", "learn", "school", "course", "tutor", "academy", "exam",
    "student", "univers", "class", "teach", "lesson", "quiz", "flashcard"],
  "Fitness": ["fit", "gym", "workout", "train", "muscle", "yoga", "pilates", "run", "athlet",
    "nutrition", "strength", "cardio"],
  "Music & Audio": ["music", "audio", "sound", "song", "beat", "podcast", "guitar", "piano",
    "band", "record", "studio", "vocal", "mix"],
  "Finance & Fintech": ["financ", "fintech", "bank", "invest", "money", "crypto", "trading",
    "loan", "credit", "wealth", "tax", "budget", "payment", "payroll", "insur"],
  "Dating & Relationships": ["dating", "date", "match", "love", "relationship", "single",
    "couple", "romance", "marriage"],
  "Productivity & Apps": ["app", "productiv", "task", "note", "todo", "calendar", "workflow",
    "focus", "habit", "organiz", "planner", "remind"],
  "Marketing & Business": ["market", "agency", "brand", "growth", "seo", "ads", "advert",
    "ecommerce", "shopify", "business", "consult", "sales", "crm", "b2b"],
  "Tech & Software": ["tech", "software", "dev", "code", "coding", "ai", "data", "cloud", "api",
    "platform", "cyber", "engineer", "saas", "app-dev", "robot"],
  "Lifestyle & Entertainment": ["lifestyle", "travel", "food", "recipe", "fashion", "beauty",
    "game", "gaming", "entertain", "movie", "style", "home", "pet"],
};

function inferNiche(rawUrl) {
  let hay = String(rawUrl || "").toLowerCase();
  try { const u = new URL(hay.includes("://") ? hay : "https://" + hay); hay = u.hostname + " " + u.pathname; } catch {}
  hay = hay.replace(/[^a-z]+/g, " ");
  let best = null, bestScore = 0;
  for (const [niche, words] of Object.entries(NICHE_KEYWORDS)) {
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length;  // longer match = stronger
    if (score > bestScore) { bestScore = score; best = niche; }
  }
  return { niche: best, score: bestScore };
}

// ---------- Site reading ----------
// A static page can't fetch a third-party site directly (CORS), so we go
// through public CORS-enabled readers, allowlisted in the CSP. Everything that
// comes back is UNTRUSTED TEXT: parsed inertly (DOMParser — scripts never
// execute) and always escaped before rendering.

function normalizeClientUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes("://") ? s : "https://" + s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.href;
  } catch { return null; }
}

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

/** Shared extraction — DOMParser never executes scripts in the parsed doc. */
function parseHtmlRead(html, via) {
  if (!html || html.length < 200) throw new Error("empty read");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = (sel) => doc.querySelector(sel)?.getAttribute("content") || "";
  const headings = [...doc.querySelectorAll("h1, h2, h3")]
    .map((h) => h.textContent.trim().replace(/\s+/g, " ")).filter((t) => t.length >= 2 && t.length <= 80);
  return {
    via,
    title: (doc.querySelector("title")?.textContent || meta('meta[property="og:title"]')).trim(),
    description: (meta('meta[name="description"]') || meta('meta[property="og:description"]')).trim(),
    headings,
    text: (doc.body?.textContent || "").replace(/\s+/g, " "),
  };
}

/** Route A: allorigins /get wraps the page HTML in JSON (its /raw endpoint is flaky). */
async function readViaAllOrigins(url) {
  const raw = await fetchWithTimeout(
    "https://api.allorigins.win/get?url=" + encodeURIComponent(url), 25000);
  const wrapped = JSON.parse(raw);
  const code = wrapped.status?.http_code;
  if (code && code >= 400) throw new Error("site returned " + code);
  return parseHtmlRead(wrapped.contents || "", "allorigins");
}

/** Route B: codetabs relays raw HTML. */
async function readViaCodetabs(url) {
  const html = await fetchWithTimeout(
    "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url), 25000);
  return parseHtmlRead(html, "codetabs");
}

async function readClientSite(url) {
  try { return await readViaAllOrigins(url); }
  catch (e1) {
    try { return await readViaCodetabs(url); }
    catch (e2) { throw new Error(`allorigins: ${e1.message}; codetabs: ${e2.message}`); }
  }
}

// Headings that are site chrome, not product features.
const GENERIC_HEADINGS = new Set([
  "about", "about us", "contact", "contact us", "pricing", "plans", "login", "log in",
  "sign up", "sign in", "faq", "faqs", "blog", "privacy", "privacy policy", "terms",
  "terms of service", "careers", "home", "menu", "features", "resources", "support",
  "help", "download", "get started", "learn more", "overview", "company", "products",
  "solutions", "testimonials", "reviews", "newsletter", "subscribe", "follow us",
  "team", "our team", "mission", "search", "english", "table of contents",
]);

const AUDIENCE_KEYWORDS = {
  "Students": ["student", "study", "exam", "school", "college", "university", "class", "course", "nclex", "flashcard"],
  "Healthcare Professionals": ["nurse", "nursing", "clinician", "physician", "doctor", "emt", "paramedic", "patient care", "medical professional"],
  "Fitness Enthusiasts": ["workout", "gym", "athlete", "training plan", "lifter", "runner"],
  "Musicians & Creators": ["musician", "artist", "creator", "producer", "songwriter", "content creator"],
  "Entrepreneurs & Marketers": ["founder", "marketer", "agency", "business owner", "entrepreneur", "growth team"],
  "Developers & Founders": ["developer", "engineer", "api", "startup", "saas", "documentation"],
  "Young Professionals": ["professional", "career", "resume", "workplace", "job search"],
};

function analyzeSite(read, url) {
  const hay = (read.title + " " + read.description + " " +
    read.headings.join(" ") + " " + read.text.slice(0, 20000)).toLowerCase();

  // Niche: keyword occurrences weighted by specificity (length), capped so one
  // repeated word can't drown everything else.
  const scores = [];
  for (const [niche, words] of Object.entries(NICHE_KEYWORDS)) {
    let score = 0;
    for (const w of words) {
      const count = hay.split(w).length - 1;
      if (count) score += w.length * Math.min(count, 5);
    }
    if (score) scores.push({ niche, score });
  }
  scores.sort((a, b) => b.score - a.score);
  const confident = scores.length && (scores.length === 1 || scores[0].score >= scores[1].score * 1.4);

  // Features: real product headings, minus chrome.
  const feats = [];
  const seenF = new Set();
  for (const h of read.headings) {
    const clean = h.replace(/\s+/g, " ").trim();
    const k = clean.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (!k || GENERIC_HEADINGS.has(k) || k.length < 4) continue;
    if (/cookie|privacy|©|copyright|all rights/i.test(clean)) continue;
    if (clean.split(" ").length > 9) continue;
    if (seenF.has(k)) continue;
    seenF.add(k);
    feats.push(clean);
    if (feats.length >= 8) break;
  }

  let audience = null, audScore = 0;
  for (const [aud, words] of Object.entries(AUDIENCE_KEYWORDS)) {
    let s = 0;
    for (const w of words) s += (hay.split(w).length - 1);
    if (s > audScore) { audScore = s; audience = aud; }
  }

  let brand = (read.title || "").split(/[|–—:·]/)[0].trim();
  if (!brand || brand.length > 40) {
    try { brand = new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { brand = "the product"; }
  }

  return {
    brand, feats, audience,
    niche: scores[0]?.niche || null,
    nicheRunnerUp: scores[1]?.niche || null,
    confident,
    words: Math.round(read.text.split(/\s+/).length),
  };
}

// Starter hook per hook pattern, grounded in the client's own brand/feature.
// Deterministic templates + escaped insertions — untrusted text never executes.
function starterHook(hookPattern, brand, feat) {
  const f = feat || "this";
  const t = {
    "Curiosity Gap": `Nobody tells you what ${f} actually does — until you see this`,
    "Bold Claim": `${brand} just made everything else feel outdated`,
    "Surprising Stat": `[stat] people struggle with this — ${brand} fixes it in minutes`,
    "Relatable Pain": `POV: you're still doing this manually instead of using ${brand}`,
    "Us vs Them": `People who use ${brand} vs people who don't`,
    "Question": `Why is nobody talking about ${f}?`,
    "Warning": `Stop doing this before you've tried ${brand}`,
    "Social Proof": `Everyone's quietly switching to ${brand} — here's why`,
    "Transformation": `My week before ${brand} vs after`,
    "No Hook": `${brand}. ${f}. That's the video.`,
    "Direct CTA": `Search ${brand} right now — you'll see why in ten seconds`,
    "Audience Call-Out": `If you're serious about this — ${brand} is for you. I gotchu`,
    "Emotional Share": `Honestly? ${brand} is the first thing that's made ${f} feel doable`,
  };
  return t[hookPattern] || `Show ${f} in the first two seconds — no intro`;
}

// ---------- Video embeds ----------
// We don't host any video — playback uses each platform's official embed
// endpoint in a sandboxed iframe (frame-src allowlisted in the CSP). TikTok and
// YouTube embed reliably; Instagram/Facebook sometimes refuse without login,
// so every card keeps an "open on platform" link as the fallback.
//
// Shelf cards are STATIC until clicked: a real thumbnail + play button, no
// iframe. Embeds auto-animate (TikTok especially), and 24 of them at once
// makes the shelf unscannable. One click loads that one video's player.

const TT_THUMBS = new Map();   // video url -> thumbnail url (from TikTok oEmbed)

function thumbFor(row) {
  const p = (row.platform || "").toLowerCase();
  const url = String(row.url || "");
  if (p === "youtube") {
    const id = (url.match(/(?:shorts\/|watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/) || [])[1];
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  }
  if (p === "tiktok") return TT_THUMBS.get(url) || null;
  return null;   // instagram/facebook: no keyless thumbnail — placeholder card
}

/** Resolve TikTok thumbnails via oEmbed and drop them into waiting cards. */
function fillTikTokThumbs(rows) {
  for (const r of rows) {
    const url = String(r.url || "");
    if ((r.platform || "").toLowerCase() !== "tiktok" || !url || TT_THUMBS.has(url)) continue;
    fetch("https://www.tiktok.com/oembed?url=" + encodeURIComponent(url))
      .then((res) => res.ok ? res.json() : null)
      .then((d) => {
        const t = d && typeof d.thumbnail_url === "string" ? d.thumbnail_url : null;
        if (!t || !/^https:\/\/[^/]*tiktokcdn[^/]*\//.test(t)) return;
        TT_THUMBS.set(url, t);
        document.querySelectorAll(`.vframe[data-url="${CSS.escape(url)}"] .vthumb-pending`)
          .forEach((el) => {
            const img = document.createElement("img");
            img.className = "vthumb";
            img.src = t;
            img.alt = "";
            img.loading = "lazy";
            el.replaceWith(img);
          });
      })
      .catch(() => {});
  }
}

/** Swap a static frame for the live player (the one deliberate click). */
function playInFrame(frameEl, row) {
  const emb = embedFor(row);
  if (!emb) return;
  const iframe = document.createElement("iframe");
  // autoplay so the click that loaded the player is also the click that plays
  iframe.src = emb.src + (emb.src.includes("youtube-nocookie") ? "?autoplay=1&playsinline=1" : "");
  iframe.setAttribute("scrolling", "no");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("title", "Video player");
  frameEl.classList.add("playing");
  frameEl.replaceChildren(iframe);
}

function frameHtml(row) {
  const emb = embedFor(row);
  const thumb = thumbFor(row);
  const pending = !thumb && (row.platform || "").toLowerCase() === "tiktok";
  return `
    <div class="vframe ${emb ? emb.cls : ""}" data-url="${escapeHtml(String(row.url || ""))}">
      ${thumb ? `<img class="vthumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">`
        : `<div class="${pending ? "vthumb-pending" : "vthumb-none"}">${pending ? "" : escapeHtml(row.platform || "video")}</div>`}
      ${emb ? `<button type="button" class="vplay" aria-label="Play video">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
      </button>` : ""}
    </div>`;
}
function embedFor(row) {
  const url = String(row.url || "");
  const p = (row.platform || "").toLowerCase();
  // cls drives the frame's aspect ratio: TikTok/Instagram embeds carry header +
  // caption chrome below the video, so their frames must be taller than 9:16 or
  // the iframe scrolls internally.
  if (p === "tiktok") {
    const id = /^\d{15,}$/.test(row.video_id) ? row.video_id : (url.match(/video\/(\d+)/) || [])[1];
    return id ? { src: `https://www.tiktok.com/embed/v2/${id}`, cls: "vf-tiktok" } : null;
  }
  if (p === "youtube") {
    const id = (url.match(/(?:shorts\/|watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/) || [])[1];
    return id ? { src: `https://www.youtube-nocookie.com/embed/${id}`, cls: url.includes("/shorts/") ? "vf-short" : "vf-wide" } : null;
  }
  if (p === "instagram") {
    const code = (url.match(/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/) || [])[1];
    return code ? { src: `https://www.instagram.com/reel/${code}/embed/`, cls: "vf-insta" } : null;
  }
  if (p === "facebook") {
    return url ? { src: `https://www.facebook.com/plugins/video.php?show_text=false&href=${encodeURIComponent(url)}`, cls: "vf-short" } : null;
  }
  return null;
}

// ---------- Tailored scripts ----------
// Deterministic beat templates per format from the locked taxonomy, filled with
// the client's brand, features, and audience from the site analysis. Escaped at
// render time; the exporter escapes for XML separately.
function tailoredScript(row, ctx, slot) {
  const brand = ctx?.brand || "the product";
  const feats = ctx?.feats?.length ? ctx.feats : ["the core feature"];
  const f1 = feats[slot % feats.length];
  const f2 = feats[(slot + 1) % feats.length];
  const aud = ctx?.audience || "your audience";
  const hook = starterHook(row.hook_pattern, brand, f1);
  const fmtName = row.format_type || "Other";

  const beats = {
    "Talking Head": [
      `[0–2s] To camera, no intro: “${hook}”`,
      `[2–8s] Name the pain ${aud.toLowerCase()} feel before ${brand} — one concrete moment, not a list.`,
      `[8–20s] Show ${brand} solving it. Lead with ${f1} — one screen, one action, real pace.`,
      `[20–28s] Payoff: what changed. Mention ${f2} in one sentence as the “and it also…”`,
    ],
    "Listicle": [
      `[0–2s] Text + VO: “${hook}”`,
      `[2–10s] #1 — ${f1}: show it doing the thing, count on screen.`,
      `[10–18s] #2 — ${f2}: cut fast, keep each item under 8s.`,
      `[18–26s] #3 — the sleeper feature nobody expects. Save the best for last.`,
    ],
    "Screen Demo": [
      `[0–2s] Screen recording already mid-action, VO: “${hook}”`,
      `[2–12s] Walk ${f1} start-to-finish. Zoom on taps. No menus tour — one task.`,
      `[12–22s] The result on screen. Before/after split if possible.`,
    ],
    "POV": [
      `[0–2s] Text overlay: “POV: ${aud.toLowerCase()} discovering ${brand} for the first time”`,
      `[2–12s] Act the scenario — the frustration first, then ${f1} as the turn.`,
      `[12–20s] The after-state. Underplay it; let the contrast land.`,
    ],
    "Skit": [
      `[0–2s] Character A mid-crisis: “${hook}”`,
      `[2–14s] Character B (or future-you) solves it with ${brand} — show ${f1} on a phone.`,
      `[14–24s] Punchline callback to the opening crisis.`,
    ],
    "Story Time": [
      `[0–2s] “${hook}” — face to camera, sat down, real.`,
      `[2–15s] The story: where ${aud.toLowerCase()} hit the wall. Specifics sell it.`,
      `[15–25s] How ${brand} (${f1}) changed the ending. Keep it one beat, not an ad read.`,
    ],
    "Green Screen": [
      `[0–2s] You over a screenshot of the client's own site/app: “${hook}”`,
      `[2–14s] Point at ${f1} on screen behind you — react, don't narrate the UI.`,
      `[14–22s] Swap background to the results screen. One-line verdict.`,
    ],
    "Voiceover B-roll": [
      `[0–2s] VO over motion: “${hook}”`,
      `[2–14s] B-roll of the routine ${aud.toLowerCase()} know too well; VO ties it to ${f1}.`,
      `[14–24s] Product close on ${f2}; VO lands the one-sentence pitch.`,
    ],
    "Reaction / Duet": [
      `[0–2s] React to a viral clip in this niche: “${hook}”`,
      `[2–14s] Pause it where it goes wrong — show how ${brand} (${f1}) handles it.`,
      `[14–22s] Side-by-side verdict.`,
    ],
    "Meme / Trend Clip": [
      `[0–2s] Current trend audio; on-screen text: “${hook}” — you emote, don't speak.`,
      `[2–8s] Hold the bit. The text carries the joke about life before ${brand}.`,
      `[8–12s] One beat only: phone flashes ${f1} on screen. No feature tour — the wink is the sell.`,
    ],
  };
  const fallback = [
    `[0–2s] Open on the strongest visual you have, line: “${hook}”`,
    `[2–12s] One problem, one solution: ${brand}'s ${f1}, shown not told.`,
    `[12–22s] Result + one-line payoff for ${aud.toLowerCase()}.`,
  ];
  const ctas = [
    `Search “${brand}” — don't spell out the link.`,
    `“Link in bio if you want to try ${f1} yourself.”`,
    `“Comment ‘${brand.split(" ")[0].toUpperCase()}’ and I'll send it to you.”`,
    `“It's free to try — that's the whole pitch.”`,
  ];
  return {
    heading: `${fmtName} × ${row.hook_pattern || "Other"}`,
    hook,
    beats: beats[fmtName] || fallback,
    cta: `[last 3s] CTA: ${ctas[slot % ctas.length]}`,
  };
}


// ---------- Client learning loop ----------
// After week one, a client's own tracked posts become evidence. Their videos
// join the ranking pool (so real performance competes with the database), and
// formats/hooks that beat their benchmark get boosted while ones that missed
// get demoted — the engine learns client by client.
let LEARN_CLIENT = null;   // client record whose history should shape the shelf

/** Tracked posts with check-ins, shaped like database rows so buildPlays can
    rank them alongside scraped videos. */
function clientRows(client) {
  return (client?.posts || []).filter((p) => p.checkins.length).map((p) => ({
    video_id: p.id, creator: p.creator || client.company, platform: p.platform || "",
    title: p.caption || p.url, views: postLatest(p), likes: 0, comments: 0,
    engagement_rate: "", format_type: p.format, hook_pattern: p.hook,
    niche_category: client.niche || "", target_audience: client.ctx?.audience || "",
    data_source: client.company + " (tracked)", url: p.url,
    _client: true, _ratio: postRatio(p),
  }));
}

/** Multipliers per format and per hook from how this client actually did. */
function clientLearning(client) {
  const fmt = new Map(), hook = new Map();
  const add = (m, k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  for (const p of client?.posts || []) {
    const r = postRatio(p);
    if (r == null) continue;
    add(fmt, p.format, r);
    add(hook, p.hook, r);
  }
  const avg = (m) => new Map([...m].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
  return { fmt: avg(fmt), hook: avg(hook), n: (client?.posts || []).filter((p) => p.checkins.length).length };
}

/** Blend a learned multiplier toward 1 so a single post can't dominate. */
function learnedBoost(learning, format, hook) {
  if (!learning || !learning.n) return 1;
  const f = learning.fmt.get(format), h = learning.hook.get(hook);
  const parts = [f, h].filter((v) => v != null);
  if (!parts.length) return 1;
  const raw = parts.reduce((a, b) => a + b, 0) / parts.length;
  const clamped = Math.max(0.4, Math.min(2.5, raw));
  const weight = Math.min(0.6, 0.15 * learning.n);   // more history, more say
  return 1 + (clamped - 1) * weight;
}

// ---------- Brief cart ----------
const CART_LIMIT = 10;
let CART = new Map();   // rowKey -> row

const rowKey = (r) => (r.platform || "") + "|" + (r.video_id || r.url || r.title);

function buildShelf(pool, relative, count = 24) {
  // Round-robin the formats (each sorted by index) so the shelf isn't 24
  // near-identical listicles — diversity is the point of a browsing surface.
  const byFormat = new Map();
  for (const r of pool) {
    if (!embedFor(r)) continue;
    const f = r.format_type || "Other";
    if (!byFormat.has(f)) byFormat.set(f, []);
    byFormat.get(f).push(r);
  }
  for (const list of byFormat.values()) list.sort((a, b) => relative(b) - relative(a));
  const queues = [...byFormat.entries()]
    .sort((a, b) => relative(b[1][0]) - relative(a[1][0]))
    .map(([, list]) => list);
  const shelf = [];
  let added = true;
  while (shelf.length < count && added) {
    added = false;
    for (const q of queues) {
      if (q.length && shelf.length < count) { shelf.push(q.shift()); added = true; }
    }
  }
  return shelf;
}

function trayHtml() {
  const n = CART.size;
  return `
    <div class="tray-inner">
      <span class="tray-count"><strong>${n}</strong>/${CART_LIMIT} in brief</span>
      <span class="tray-hint">${n < CART_LIMIT ? `check ${CART_LIMIT - n} more to save` : "ready to save"}</span>
      <span class="spacer"></span>
      <button type="button" class="ghost" id="tray-copy" ${n ? "" : "disabled"}>Copy scripts</button>
      <button type="button" class="btn" id="tray-export" ${n >= CART_LIMIT ? "" : "disabled"}
        title="${n >= CART_LIMIT ? "Saves into the Briefs tab — flip through videos and scripts there" : `Unlocks at ${CART_LIMIT} videos`}">
        Save brief</button>
    </div>`;
}

let LAST_TRAY_N = -1;
function refreshTray() {
  const tray = document.getElementById("tray");
  if (!tray) return;
  tray.innerHTML = trayHtml();
  const strong = tray.querySelector(".tray-count strong");
  if (strong && LAST_TRAY_N !== -1 && CART.size !== LAST_TRAY_N) strong.classList.add("bump");
  if (CART.size >= CART_LIMIT && LAST_TRAY_N < CART_LIMIT)
    document.getElementById("tray-export")?.classList.add("ready");
  LAST_TRAY_N = CART.size;
  document.getElementById("tray-export")?.addEventListener("click", saveCurrentBrief);
  document.getElementById("tray-copy")?.addEventListener("click", copyScripts);
}

function scriptHtml(row) {
  const slot = [...CART.keys()].indexOf(rowKey(row));
  const s = tailoredScript(row, BRIEF_CTX, Math.max(slot, 0));
  return `
    <div class="vscript">
      <div class="lbl">Tailored script — ${escapeHtml(s.heading)}</div>
      <p class="vs-hook">“${escapeHtml(s.hook)}”</p>
      ${s.beats.map((b) => `<p class="vs-beat">${escapeHtml(b)}</p>`).join("")}
      <p class="vs-beat vs-cta">${escapeHtml(s.cta)}</p>
    </div>`;
}

// ---------- Video detail modal ----------
// Shelf cards stay light (title + one stat); everything else lives here.
let SHELF_CTX = null;   // { index: Map(key -> row), relative: fn } from the last renderShelf

function setPicked(key, on) {
  const row = SHELF_CTX?.index.get(key);
  if (!row) return false;
  if (on) {
    if (CART.size >= CART_LIMIT) {
      const tray = document.getElementById("tray");
      if (tray) {
        tray.classList.add("shake");
        setTimeout(() => tray.classList.remove("shake"), 500);
      }
      return false;
    }
    CART.set(key, row);
  } else {
    CART.delete(key);
  }
  const card = document.querySelector(`.vcard[data-key="${CSS.escape(key)}"]`);
  if (card) {
    card.classList.toggle("picked", on);
    const cb = card.querySelector(".vcheck");
    if (cb) cb.checked = on;
  }
  refreshTray();
  return true;
}

function modalBody(row) {
  const k = rowKey(row);
  const picked = CART.has(k);
  const emb = embedFor(row);
  const er = row.engagement_rate ? parseFloat(row.engagement_rate).toFixed(2) + "%" : "—";
  const idx = SHELF_CTX ? SHELF_CTX.relative(row).toFixed(2) + "×" : "—";
  const href = safeUrl(row.url);
  const stat = (v, l) => `<div class="metric"><div class="m-val">${v}</div><div class="m-lbl">${l}</div></div>`;
  return `
    <div class="modal-grid">
      <div class="modal-player-host">${emb ? frameHtml(row).replace('class="vframe ', 'class="vframe modal-player ') : `<div class="empty">No embed available</div>`}</div>
      <div class="modal-info">
        <p class="modal-title">${escapeHtml(row.title || "(no caption)")}</p>
        <p class="lbl">${escapeHtml(row.creator || "—")} · ${escapeHtml(row.platform || "")} · ${escapeHtml(row.data_source || "")}
          ${href ? ` · <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">open on platform ↗</a>` : ""}</p>
        <div class="metrics modal-metrics">
          ${stat(compact(views(row)), "Views")}${stat(compact(+row.likes || 0), "Likes")}
          ${stat(compact(+row.comments || 0), "Comments")}${stat(er, "ER")}${stat(idx, "Index")}
        </div>
        <div class="chips">
          ${["format_type", "hook_pattern", "niche_category", "target_audience"]
            .map((d) => row[d] ? `<span class="chip">${escapeHtml(row[d])}</span>` : "").join("")}
        </div>
        ${BRIEF_CTX ? scriptHtml(row) : `<p class="note">Apply client details to generate a tailored script.</p>`}
        <div class="modal-actions">
          <button type="button" class="btn" id="modal-pick">${picked ? "Remove from brief" : "Add to brief"}</button>
          ${BRIEF_CTX ? `<button type="button" class="ghost" id="modal-copy">Copy script</button>` : ""}
        </div>
      </div>
    </div>`;
}

function openModal(key) {
  const row = SHELF_CTX?.index.get(key);
  if (!row) return;
  const modal = document.getElementById("modal");
  document.getElementById("modal-content").innerHTML = modalBody(row);
  modal.hidden = false;
  document.body.classList.add("no-scroll");
  openModalBindings(key, row);
}

function openModalBindings(key, row) {
  const playBtn = document.querySelector("#modal .vplay");
  if (playBtn) playBtn.addEventListener("click", () => {
    playInFrame(document.querySelector("#modal .vframe"), row);
  });
  fillTikTokThumbs([row]);
  const copyBtn = document.getElementById("modal-copy");
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    const slot = Math.max([...CART.keys()].indexOf(key), 0);
    const s = tailoredScript(row, BRIEF_CTX, slot);
    const text = `${s.heading}\nHook: “${s.hook}”\n${s.beats.join("\n")}\n${s.cta}`;
    try { await navigator.clipboard.writeText(text); copyBtn.textContent = "Copied ✓"; } catch {}
  });
  const pickBtn = document.getElementById("modal-pick");
  if (pickBtn && !pickBtn.dataset.bound) {
    pickBtn.dataset.bound = "1";
    pickBtn.addEventListener("click", () => {
      // Update in place — re-rendering the body would stop a playing video.
      if (setPicked(key, !CART.has(key))) {
        pickBtn.textContent = CART.has(key) ? "Remove from brief" : "Add to brief";
      }
    });
  }
}

function closeModal() {
  const modal = document.getElementById("modal");
  modal.hidden = true;
  document.getElementById("modal-content").innerHTML = "";  // stops playback
  document.body.classList.remove("no-scroll");
}

function initModal() {
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.querySelector("#modal .modal-back").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("modal").hidden) closeModal();
  });
}

function renderShelf(niche) {
  const body = document.getElementById("brief-body");
  const own = LEARN_CLIENT ? clientRows(LEARN_CLIENT) : [];
  const base = own.length ? ALL.concat(own) : ALL;
  let pool = niche ? base.filter((r) => r.niche_category === niche) : base;
  const notes = [];
  if (niche && pool.length < MIN_N_NICHE) {
    notes.push(`Only ${pool.length} videos tagged <strong>${escapeHtml(niche)}</strong> — too few to rank
      reliably, so the shelf draws from the whole database instead. Treat it as directional.`);
    pool = base;
  }
  if (own.length) {
    const L = clientLearning(LEARN_CLIENT);
    const up = [...L.fmt].filter(([, v]) => v >= 1.25).map(([k]) => k);
    const down = [...L.fmt].filter(([, v]) => v < 0.75).map(([k]) => k);
    notes.push(`Learning from <strong>${escapeHtml(LEARN_CLIENT.company)}</strong>: ${own.length} tracked post${own.length === 1 ? "" : "s"} are in this ranking${up.length ? `, and <strong>${escapeHtml(up.join(", "))}</strong> ${up.length === 1 ? "is" : "are"} boosted for beating benchmark` : ""}${down.length ? `, <strong>${escapeHtml(down.join(", "))}</strong> demoted for missing it` : ""}.`);
  }

  const bySource = new Map();
  for (const r of pool) {
    const s = r.data_source || "?";
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(views(r));
  }
  const srcMedian = new Map([...bySource].map(([s, vs]) => [s, median(vs) || 1]));
  // Client-tracked rows are scored against the benchmark they were measured
  // against; source-normalising them would divide them by themselves.
  const relative = (r) => (r._client && r._ratio != null)
    ? r._ratio : views(r) / (srcMedian.get(r.data_source || "?") || 1);
  // A client's own posts that beat their benchmark are proven for THIS client —
  // lead with them rather than making them out-compete viral database clips on
  // a raw index they can't win.
  const proven = own.filter((r) => (r._ratio || 0) >= 1).sort((a, b) => b._ratio - a._ratio).slice(0, 4);
  const provenKeys = new Set(proven.map(rowKey));
  const shelf = proven.concat(
    buildShelf(pool, relative, 24 - proven.length).filter((r) => !provenKeys.has(rowKey(r))));

  const { plays } = buildPlays(pool);

  body.innerHTML =
    notes.map((n) => `<div class="warn">${n}</div>`).join("") +
    `<div class="tray" id="tray"></div>
     <div class="shelf">` +
    shelf.map((r) => {
      const k = rowKey(r);
      const checked = CART.has(k);
      return `
      <article class="vcard${checked ? " picked" : ""}" data-key="${escapeHtml(k)}">
        ${frameHtml(r)}
        <div class="vmeta">
          <div class="vtitle">${escapeHtml(r.title || "(no caption)")}</div>
          <div class="vrow">
            ${r._client ? `<span class="proven" title="This client's own post — beat its benchmark">proven ${ratioLabel(r._ratio)}</span>` : ""}
            <span class="vstat" title="views · index vs its source's median">${compact(views(r))} · ${relative(r).toFixed(1)}×</span>
            <button type="button" class="vdetails" data-key="${escapeHtml(k)}">Details</button>
            <label class="vpick"><input type="checkbox" class="vcheck" ${checked ? "checked" : ""}> Add</label>
          </div>
        </div>
      </article>`;
    }).join("") + `</div>` +
    `<details class="playbook"><summary>The scoreboard behind this shelf — top format × hook plays</summary>
      <div id="plays-host"></div></details>`;

  // scoreboard inside the details
  renderPlaysInto(document.getElementById("plays-host"), plays, niche, pool);

  SHELF_CTX = { index: new Map(shelf.map((r) => [rowKey(r), r])), relative };

  body.querySelectorAll(".vcheck").forEach((cb) => {
    cb.addEventListener("change", () => {
      const key = cb.closest(".vcard").dataset.key;
      if (!setPicked(key, cb.checked)) cb.checked = false;
    });
  });
  body.querySelectorAll(".vdetails").forEach((btn) => {
    btn.addEventListener("click", () => openModal(btn.dataset.key));
  });
  body.querySelectorAll(".vplay").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".vcard");
      playInFrame(card.querySelector(".vframe"), SHELF_CTX.index.get(card.dataset.key));
    });
  });
  fillTikTokThumbs(shelf);

  refreshTray();
}

// The old play-card list, now rendered into the collapsible scoreboard.
function renderPlaysInto(host, plays, niche, pool) {
  if (!plays.length) { host.innerHTML = `<div class="empty">Not enough data.</div>`; return; }
  const scope = niche && pool !== ALL ? escapeHtml(niche) : "the whole database";
  host.innerHTML =
    `<p class="note">Scope: ${scope}. Index 1.00 = typical for the video's own source.</p>` +
    `<div class="plays">` + plays.map((p, i) => {
      const conf = confidenceOf(p.n);
      return `
      <article class="play">
        <div class="play-head">
          <div class="rank">${String(i + 1).padStart(2, "0")}</div>
          <div class="minw0">
            <h3 class="play-title">${escapeHtml(p.format)} <span class="x-sep">×</span> ${escapeHtml(p.hook)}</h3>
            <p class="play-why">${fmt(p.n)} videos · <span class="badge ${conf.cls}">${escapeHtml(conf.label)}</span></p>
          </div>
          <div class="metrics">
            <div class="metric"><div class="m-val">${p.index.toFixed(2)}×</div><div class="m-lbl">Index</div></div>
            <div class="metric"><div class="m-val">${compact(p.med)}</div><div class="m-lbl">Median views</div></div>
            <div class="metric"><div class="m-val">${fmt(p.n)}</div><div class="m-lbl">Sample</div></div>
          </div>
        </div>
      </article>`;
    }).join("") + `</div>`;
}

// ---------- Export: .docx built in pure JS ----------
// A .docx is a zip of XML parts. We write STORED (uncompressed) zip entries
// with real CRC32s — no libraries, nothing loaded off-origin, CSP intact.
// Google Docs opens the result directly (drag into Drive → Open with Docs).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files) {   // files: [{name, text}]
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.text);
    const crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true); head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(head.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)],
    { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function para(text, { bold = false, size = 22, spaceAfter = 120 } = {}) {
  return `<w:p><w:pPr><w:spacing w:after="${spaceAfter}"/></w:pPr>` +
    `<w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>` +
    `<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}

function briefDocParts(ctx, items, dateStr) {
  const brand = ctx?.brand || "Client";
  const today = dateStr || new Date().toISOString().slice(0, 10);
  let body = "";
  body += para(`${brand} — Content Brief`, { bold: true, size: 40, spaceAfter: 60 });
  body += para(`${items.length} scripts tailored from the lynxr format database · ${today}`, { size: 20, spaceAfter: 300 });
  if (ctx?.audience) body += para(`Audience: ${ctx.audience}`, { size: 22 });
  if (ctx?.feats?.length) body += para(`Product angles used: ${ctx.feats.join(" · ")}`, { size: 22, spaceAfter: 360 });

  let i = 0;
  for (const row of items) {
    i += 1;
    const s = tailoredScript(row, ctx, i - 1);
    const er = row.engagement_rate ? parseFloat(row.engagement_rate).toFixed(2) + "%" : "n/a";
    body += para(`Script ${i} — ${s.heading}`, { bold: true, size: 28, spaceAfter: 100 });
    body += para(`Hook: “${s.hook}”`, { bold: true, size: 22 });
    for (const b of s.beats) body += para(b, { size: 22 });
    body += para(s.cta, { size: 22, spaceAfter: 160 });
    body += para(`Reference: ${row.title || "(no caption)"}`, { size: 18 });
    body += para(`${row.creator || "—"} on ${row.platform} · ${fmt(views(row))} views · ${fmt(+row.likes || 0)} likes · ${fmt(+row.comments || 0)} comments · ER ${er} · source: ${row.data_source}`, { size: 18 });
    body += para(row.url || "", { size: 18, spaceAfter: 360 });
  }

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}<w:sectPr/></w:body></w:document>`;
  return [
    { name: "[Content_Types].xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: "_rels/.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", text: document },
  ];
}

function downloadDocx(ctx, items, dateStr) {
  const blob = zipStore(briefDocParts(ctx, items, dateStr));
  const a = document.createElement("a");
  const brand = (ctx?.brand || "client").replace(/[^\w -]+/g, "").trim() || "client";
  a.href = URL.createObjectURL(blob);
  a.download = `${brand} — lynxr content brief.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Clients (in-platform, browser localStorage) ----------
// A client folder groups everything for one company: saved briefs plus tracked
// posts with performance check-ins. Legacy flat briefs migrate on first load.
const CLIENTS_KEY = "lynxr_clients";
const LEGACY_BRIEFS_KEY = "lynxr_briefs";

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

function findOrCreateClient(list, company, ctx, niche) {
  const key = String(company || "Client").trim().toLowerCase();
  let c = list.find((x) => (x.company || "").trim().toLowerCase() === key);
  if (!c) {
    c = { id: newId(), company: company || "Client", ctx: ctx || {}, niche: niche || "",
          createdAt: new Date().toISOString(), briefs: [], posts: [] };
    list.unshift(c);
  } else {
    if (ctx) c.ctx = ctx;
    if (niche) c.niche = niche;
  }
  return c;
}

function loadClients() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(CLIENTS_KEY)) || []; } catch {}
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_BRIEFS_KEY)) || []; } catch {}
  if (legacy.length) {
    for (const b of legacy) findOrCreateClient(list, b.company, b.ctx, b.niche).briefs.push(b);
    localStorage.removeItem(LEGACY_BRIEFS_KEY);
    persistClients(list);
  }
  for (const c of list) { c.briefs = c.briefs || []; c.posts = c.posts || []; }
  return list;
}
function persistClients(list) {
  try { localStorage.setItem(CLIENTS_KEY, JSON.stringify(list)); } catch {}
}

/** Save the current cart as a brief inside its client's folder. */
function saveCurrentBrief() {
  if (CART.size < CART_LIMIT) return;
  const company = BRIEF_CTX?.brand || "Client";
  const niche = document.getElementById("brief-niche")?.value || "";
  const rec = {
    id: newId(), company, ctx: BRIEF_CTX || {}, niche,
    createdAt: new Date().toISOString(), items: [...CART.values()],
  };
  const list = loadClients();
  const client = findOrCreateClient(list, company, BRIEF_CTX, niche);
  client.briefs.unshift(rec);
  persistClients(list);

  // Wrap up for the next client: clear cart, reopen the details editor.
  CART = new Map();
  closeModal();
  const editor = document.getElementById("client-editor");
  if (editor) {
    editor.classList.remove("collapsed");
    renderShelf(document.getElementById("brief-niche")?.value || "");
  }
  // Land inside the client folder with the new brief on top.
  CLIENT_VIEW = { id: client.id };
  BRIEF_VIEW = null;
  renderBriefs();
  activateTab("tab-briefs");
}

// ---------- Auto-tagging a pasted post ----------
// Paste a link and we fetch the post's real caption + creator from the
// platform's own oEmbed endpoint, then tag it with the same routing rules the
// database tagger uses. Deterministic, so it runs in-page with no API key —
// every field stays editable, since caption-only tagging is inference.

async function fetchPostMeta(url) {
  const p = (url.match(/^https?:\/\/(?:www\.)?([^/]+)/) || [])[1] || "";
  let endpoint = null;
  if (/tiktok\.com/.test(p)) endpoint = "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url);
  else if (/youtube\.com|youtu\.be/.test(p)) endpoint = "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url);
  if (endpoint) {
    const raw = await fetchWithTimeout(endpoint, 15000);
    const d = JSON.parse(raw);
    return {
      caption: d.title || "",
      creator: (d.author_name || d.author_unique_id || "").replace(/^@/, ""),
      thumb: typeof d.thumbnail_url === "string" ? d.thumbnail_url : "",
      platform: /tiktok/.test(p) ? "tiktok" : "youtube",
    };
  }
  // Instagram/Facebook have no keyless oEmbed — read the page's meta tags.
  const raw = await fetchWithTimeout(
    "https://api.allorigins.win/get?url=" + encodeURIComponent(url), 20000);
  const html = JSON.parse(raw).contents || "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = (s) => doc.querySelector(s)?.getAttribute("content") || "";
  const og = meta('meta[property="og:title"]') || doc.querySelector("title")?.textContent || "";
  return {
    caption: meta('meta[property="og:description"]') || og,
    creator: (og.match(/^([^\s(]+)/) || [])[1] || "",
    thumb: "",
    platform: /instagram/.test(p) ? "instagram" : /facebook/.test(p) ? "facebook" : "",
  };
}

/** Deterministic tagger mirroring the locked taxonomy's routing rules. */
function autoTag(caption, platform) {
  const raw = String(caption || "");
  const t = raw.toLowerCase();
  const stripped = raw.replace(/[#@]\S+/g, "").replace(/\s+/g, " ").trim();
  const has = (...w) => w.some((x) => t.includes(x));

  // format
  let format = "Other";
  if (/^pov\b|pov:/i.test(stripped)) format = "POV";
  else if (/\b(top\s?\d|\d+\s+(things|apps|tips|ways|items)|my top|you need these|part \d)\b/i.test(t)) format = "Listicle";
  else if (has("storytime", "story time") || /\b(passed|i failed|how i (passed|got|did))\b/i.test(t)) format = "Story Time";
  else if (has("green screen", "greenscreen")) format = "Green Screen";
  else if (has("stitch", "duet", "replying to", "reply to")) format = "Reaction / Duet";
  else if (has("app store", "download the app", "screen record", "tutorial", "how to use")) format = "Screen Demo";
  else if (has("it's called", "its called", "search ", "thank me later", "link in bio", "free app")) format = "Talking Head";
  else if (!stripped || stripped.length < 12) format = platform === "tiktok" ? "Meme / Trend Clip" : "Screen Demo";
  else format = "Talking Head";

  // hook — same precedence order as the database tagger
  let hook = "Other";
  if (!stripped || stripped.length < 3) hook = "No Hook";
  else if (/\b(search|download|visit|use|try|follow|comment|tag|go|get|save|watch)\b/i.test(stripped)) hook = "Direct CTA";
  else if (/\b(for my|i gotchu|i got you|hope this helps|good ?luck|attn|calling all|if you'?re a)\b/i.test(t)) hook = "Audience Call-Out";
  else if (/\b(miss|proud|thank you|grateful|so happy|love (my|you))\b/i.test(t)) hook = "Emotional Share";
  else if (/\?\s*$|^(why|how|what|who|when|is|are|do|does|did|can)\b/i.test(stripped)) hook = "Question";
  else if (/\b(stop|don'?t|never|mistake|warning)\b/i.test(t)) hook = "Warning";
  else if (/\b(everyone|everybody|nobody tells|people are)\b/i.test(t)) hook = /nobody tells/i.test(t) ? "Curiosity Gap" : "Social Proof";
  else if (/\b(before|after|changed my|transformed)\b/i.test(t)) hook = "Transformation";
  else if (/\b(best|worst|only|never seen|game ?changer|underrated)\b/i.test(t)) hook = "Bold Claim";
  else if (/\d+([km%]|,\d{3})/i.test(stripped)) hook = "Surprising Stat";
  else if (/\b(struggl|hate when|tired of|why is it so hard|losing it)\b/i.test(t)) hook = "Relatable Pain";
  else hook = "No Hook";

  return { format, hook };
}

// ---------- Performance tracking ----------
/** Benchmark prediction: median views for this format×hook in the client's
    niche pool (falling back to format-only, then the whole pool). Locked in
    when the post is added, so later comparisons are stable. */
function predictViews(niche, format, hook) {
  let pool = niche ? ALL.filter((r) => r.niche_category === niche) : ALL;
  if (pool.length < MIN_N_NICHE) pool = ALL;
  let seg = pool.filter((r) => r.format_type === format && r.hook_pattern === hook);
  if (seg.length < 5) seg = pool.filter((r) => r.format_type === format);
  if (seg.length < 5) seg = pool;
  return Math.max(1, Math.round(median(seg.map(views))));
}

function parseNum(s) {
  const t = String(s || "").trim().toLowerCase().replace(/[, ]/g, "");
  const m = t.match(/^([\d.]+)([km])?$/);
  if (!m) return NaN;
  return Math.round(parseFloat(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1));
}

const postLatest = (p) => p.checkins.length ? p.checkins[p.checkins.length - 1].views : null;

/** Tiny SVG line chart: actual series vs a dashed benchmark line.
    Color comes from the parent's .good/.bad class via currentColor. */
function sparkSvg(points, predicted, w = 240, h = 64) {
  const pad = 7;
  const ys = points.filter((v) => v != null);
  const estSeries = Array.isArray(predicted) ? predicted : null;
  const estFlat = Array.isArray(predicted) ? null : predicted;
  if (!ys.length) {
    // Always show the graph, even empty: frame + dashed benchmark placeholder.
    return `<svg class="spark empty" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" class="spark-axis"/>
      <line x1="${pad}" y1="${h / 2}" x2="${w - pad}" y2="${h / 2}" class="spark-pred"/>
    </svg>`;
  }
  const estVals = estSeries ? estSeries.filter((v) => v != null) : [];
  const maxY = Math.max(...ys, ...(estVals.length ? estVals : [0]), estFlat || 0) * 1.1 || 1;
  const x = (i) => points.length === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (points.length - 1);
  const y = (v) => h - pad - (v / maxY) * (h - 2 * pad);
  const line = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const estLine = estSeries ? estSeries.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ") : null;
  const py = estFlat ? y(estFlat).toFixed(1) : null;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    ${py !== null ? `<line x1="${pad}" y1="${py}" x2="${w - pad}" y2="${py}" class="spark-pred"/>` : ""}
    ${estLine && estSeries.length > 1 ? `<polyline points="${estLine}" class="spark-est"/>` : ""}
    ${estSeries ? estSeries.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" class="spark-est-dot"/>`).join("") : ""}
    ${points.length > 1 ? `<polyline points="${line}" class="spark-line"/>` : ""}
    ${points.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" class="spark-dot"/>`).join("")}
  </svg>`;
}

/** Full chart with x/y axes: dotted estimated slope vs solid actual line.
    Points are {x, y} where x is days since the chart's day zero. */
/** Linear-interpolated value of a series at day x (null if out of range). */
function seriesAt(series, x) {
  if (!series.length) return null;
  if (x < series[0].x || x > series[series.length - 1].x) return null;
  for (let i = 1; i < series.length; i++) {
    if (series[i].x >= x) {
      const a = series[i - 1], b = series[i];
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return series[series.length - 1].y;
}

/** Last known cumulative actual at or before day x — check-ins are discrete,
    so stepping is honest where interpolating would invent numbers. */
function actualAt(series, x) {
  let v = null;
  for (const p of series) if (p.x <= x + 1e-9) v = p.y;
  return v;
}

function chartSvg({ actual = [], est = [], w = 720, h = 210, xMax = 7, yMax = 1, tone = "" }) {
  const padL = 74, padR = 16, padT = 14, padB = 46;   // room for axis titles
  // "Nice" top so ticks are readable view counts, never fractions.
  const niceTop = (v) => {
    if (v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  };
  const top = niceTop(yMax);
  const X = (x) => padL + (Math.min(x, xMax) / xMax) * (w - padL - padR);
  const Y = (y) => padT + (1 - Math.min(y, top) / top) * (h - padT - padB);
  const poly = (pts) => pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");

  const yTicks = [...new Set([0, top / 4, top / 2, (top * 3) / 4, top]
    .filter((v) => v === 0 || v >= 1).map((v) => Math.round(v)))];
  const xStep = xMax <= 8 ? 1 : Math.ceil(xMax / 7);
  const xTicks = [];
  for (let d = 0; d <= xMax; d += xStep) xTicks.push(d);
  const midY = padT + (h - padT - padB) / 2;

  return `<svg class="chart ${tone}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    ${yTicks.map((v) => `
      <line x1="${padL}" y1="${Y(v)}" x2="${w - padR}" y2="${Y(v)}" class="chart-grid"/>
      <text x="${padL - 10}" y="${Y(v) + 3.5}" class="chart-tick" text-anchor="end">${compact(v)}</text>`).join("")}
    ${xTicks.map((d) => `
      <text x="${X(d)}" y="${h - padB + 18}" class="chart-tick" text-anchor="middle">${d}</text>`).join("")}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${h - padB}" class="chart-axis"/>
    <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" class="chart-axis"/>
    <text class="axis-title" text-anchor="middle" transform="translate(18 ${midY}) rotate(-90)">cumulative views</text>
    <text class="axis-title" text-anchor="middle" x="${padL + (w - padL - padR) / 2}" y="${h - 6}">days since brief</text>
    ${est.length > 1 ? `<polyline points="${poly(est)}" class="line-pred"/>` : ""}
    ${xTicks.map((d) => {
      const pv = seriesAt(est, d);
      return pv == null ? "" : `<circle cx="${X(d).toFixed(1)}" cy="${Y(pv).toFixed(1)}" r="2.8" class="dot-pred"/>`;
    }).join("")}
    ${actual.length > 1 ? `<polyline points="${poly(actual)}" class="line-actual"/>` : ""}
    ${xTicks.map((d) => {
      const av = actualAt(actual, d);
      return av == null ? "" : `<circle cx="${X(d).toFixed(1)}" cy="${Y(av).toFixed(1)}" r="3.4" class="dot-actual"/>`;
    }).join("")}
    ${xTicks.map((d) => {
      const pv = seriesAt(est, d), av = actualAt(actual, d);
      const half = (w - padL - padR) / (xTicks.length - 1 || 1) / 2;
      return `<rect class="hit" x="${(X(d) - half).toFixed(1)}" y="${padT}"
        width="${(half * 2).toFixed(1)}" height="${(h - padT - padB).toFixed(1)}"
        data-day="${d}" data-x="${X(d).toFixed(1)}"
        data-pred="${pv == null ? "" : Math.round(pv)}"
        data-actual="${av == null ? "" : Math.round(av)}"/>`;
    }).join("")}
    <line class="hover-rule" x1="0" y1="${padT}" x2="0" y2="${h - padB}" style="display:none"/>
  </svg>`;
}

/** Three-state read of actual against predicted at the same point in time. */
function paceTone(actual, est) {
  if (!actual.length || !est.length) return { tone: "", label: "" };
  const last = actual[actual.length - 1];
  // predicted value interpolated at the actual's latest day
  let target = est[est.length - 1].y;
  for (let i = 1; i < est.length; i++) {
    if (est[i].x >= last.x) {
      const a = est[i - 1], b = est[i];
      const t = b.x === a.x ? 0 : (last.x - a.x) / (b.x - a.x);
      target = a.y + (b.y - a.y) * t;
      break;
    }
  }
  // At day zero the predicted line is still at 0; any real views are ahead.
  if (target <= 0) return last.y > 0
    ? { tone: "good", label: "▲ ahead of pace — early views" }
    : { tone: "", label: "" };
  const r = last.y / target;
  if (r >= 1.1) return { tone: "good", label: `▲ ahead of pace — ${ratioLabel(r)}` };
  if (r <= 0.9) return { tone: "bad", label: `▼ behind pace — ${ratioLabel(r)}` };
  return { tone: "even", label: `on pace — ${ratioLabel(r)}` };
}

const DAY_MS = 86400000;
const daysBetween = (a, b) => Math.max(0, (new Date(a) - new Date(b)) / DAY_MS);

/** The predicted slope: the brief's scripts post evenly across 7 days, each
    contributing its database benchmark in full. Accounts are new but assumed
    properly warmed up, so no ramp discount is applied — the line is what these
    formats should do at full effectiveness. */
function weekEstimateCurve(rec, client) {
  const n = rec.items.length || 1;
  const pts = [{ x: 0, y: 0 }];
  let cum = 0;
  rec.items.forEach((it, i) => {
    cum += predictViews(client.niche, it.format_type, it.hook_pattern);
    pts.push({ x: (i + 1) * (7 / n), y: cum });
  });
  return pts;
}

/** Cumulative actual views over check-in dates, across all of a client's posts. */
function growthSeries(posts) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const events = posts.flatMap((p) =>
    p.checkins.map((c) => ({ d: c.d, id: p.id, views: c.views }))).sort((a, b) => a.d < b.d ? -1 : 1);
  const latest = new Map(), estSeen = new Map();
  const actual = [], pred = [];
  for (const e of events) {
    latest.set(e.id, e.views);
    estSeen.set(e.id, byId.get(e.id)?.predicted || 0);
    actual.push([...latest.values()].reduce((a, b) => a + b, 0));
    pred.push([...estSeen.values()].reduce((a, b) => a + b, 0));
  }
  return { actual, pred };
}


function ratioLabel(ratio) {
  return ratio >= 10 ? ratio.toFixed(0) + "× benchmark"
       : ratio >= 2 ? ratio.toFixed(1) + "× benchmark"
       : (ratio * 100).toFixed(0) + "% of benchmark";
}

function clientVerdict(client) {
  const tracked = client.posts.filter((p) => p.checkins.length);
  if (!tracked.length) return null;
  const actual = tracked.reduce((a, p) => a + postLatest(p), 0);
  const predicted = tracked.reduce((a, p) => a + (p.predicted || 0), 0) || 1;
  return { actual, predicted, ratio: actual / predicted, good: actual >= predicted };
}

const weekPostsOf = (client, briefId) => client.posts.filter((p) => p.briefId === briefId);

function weekVerdict(client, briefId) {
  return clientVerdict({ posts: weekPostsOf(client, briefId) });
}

// Per-post performance ratio vs its locked benchmark (null if no check-ins).
const postRatio = (p) => p.checkins.length ? postLatest(p) / (p.predicted || 1) : null;

function scriptsAsText(ctx, items) {
  let out = `${ctx?.brand || "Client"} — Content Brief (${items.length} scripts)\n\n`;
  let i = 0;
  for (const row of items) {
    i += 1;
    const s = tailoredScript(row, ctx, i - 1);
    out += `SCRIPT ${i} — ${s.heading}\nHook: “${s.hook}”\n`;
    for (const b of s.beats) out += b + "\n";
    out += s.cta + "\n";
    out += `Reference: ${row.title || ""}\n${row.creator || "—"} · ${fmt(views(row))} views · ${row.url || ""}\n\n`;
  }
  return out;
}

async function copyScripts() {
  try {
    await navigator.clipboard.writeText(scriptsAsText(BRIEF_CTX, [...CART.values()]));
    const btn = document.getElementById("tray-copy");
    const old = btn.textContent;
    btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch { /* clipboard denied — saving still works */ }
}

// ---------- Clients tab: folders -> client page -> brief flip-through ----------
let CLIENT_VIEW = null;  // { id } when a client folder is open
let BRIEF_VIEW = null;   // { id, page, dir } when a brief inside it is open

// Two-step delete used everywhere something is gone forever.
// Two-step delete. Deliberately does NOT use confirm(): browsers suppress
// repeat native dialogs (and return false instantly), which silently turned
// every second click into a cancel. The armed state is the confirmation —
// two distinct clicks, a visible red warning, and a 5s auto-disarm.
function armDelete(btn, label, onConfirm) {
  let timer = null;
  const disarm = () => {
    clearTimeout(timer);
    btn.classList.remove("armed");
    btn.textContent = label;
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed");
      btn.textContent = "Click again to delete";
      btn.title = "This cannot be undone";
      timer = setTimeout(disarm, 5000);
      return;
    }
    clearTimeout(timer);
    onConfirm();
  });
  btn.addEventListener("blur", disarm);
}

function renderBriefs() {
  const host = document.getElementById("briefs-host");
  const list = loadClients();

  if (CLIENT_VIEW) {
    const client = list.find((c) => c.id === CLIENT_VIEW.id);
    if (client) {
      if (BRIEF_VIEW) {
        const rec = client.briefs.find((b) => b.id === BRIEF_VIEW.id);
        if (rec) { renderBriefViewer(host, rec, client); return; }
        BRIEF_VIEW = null;
      }
      renderClientPage(host, client, list);
      return;
    }
    CLIENT_VIEW = null;
  }

  if (!list.length) {
    host.innerHTML = `<h2>Clients</h2>
      <div class="empty"><p><strong>No clients yet.</strong></p>
        <p>Save a brief in the New brief tab — its company becomes your first client folder.</p></div>`;
    return;
  }

  host.innerHTML = `<h2>Clients <span class="pill">${list.length}</span></h2>
    <div class="brief-stack">` + list.map((c) => {
      const v = clientVerdict(c);
      return `
      <article class="bcard" data-id="${escapeHtml(c.id)}">
        <div class="bcard-main">
          <div class="bcard-title">${escapeHtml(c.company)}</div>
          <div class="lbl">${escapeHtml(c.niche || "All niches")} · ${c.briefs.length} brief${c.briefs.length === 1 ? "" : "s"}
            · ${c.posts.length} post${c.posts.length === 1 ? "" : "s"}</div>
        </div>
        ${v ? `<span class="verdict ${v.good ? "good" : "bad"}">${v.good ? "▲" : "▼"} ${ratioLabel(v.ratio)}</span>` : ""}
        <button type="button" class="btn b-open">Open</button>
        <button type="button" class="ghost b-del">Delete</button>
      </article>`;
    }).join("") + `</div>`;

  host.querySelectorAll(".bcard").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector(".b-open").addEventListener("click", () => {
      CLIENT_VIEW = { id }; BRIEF_VIEW = null; renderBriefs();
    });
    armDelete(card.querySelector(".b-del"), "Delete", () => {
      persistClients(loadClients().filter((c) => c.id !== id));
      renderBriefs();
    });
  });
}

function renderClientPage(host, client, list) {
  const v = clientVerdict(client);
  const cPosts = client.posts;
  const cDay0 = [...cPosts].map((p) => p.addedAt).sort()[0] || new Date().toISOString();
  const cEvents = cPosts.flatMap((p) => p.checkins.map((c) => ({ d: c.d, id: p.id, views: c.views })))
    .sort((a, b) => a.d < b.d ? -1 : 1);
  const cSeen = new Map(), cEstSeen = new Map();
  const cById = new Map(cPosts.map((p) => [p.id, p]));
  const cActual = [], cEst = [];
  for (const e of cEvents) {
    cSeen.set(e.id, e.views);
    cEstSeen.set(e.id, cById.get(e.id)?.predicted || 0);
    const x = daysBetween(e.d, cDay0);
    cActual.push({ x, y: [...cSeen.values()].reduce((a, b) => a + b, 0) });
    cEst.push({ x, y: [...cEstSeen.values()].reduce((a, b) => a + b, 0) });
  }
  if (cActual.length) { cActual.unshift({ x: 0, y: 0 }); cEst.unshift({ x: 0, y: 0 }); }
  // No tracked estimates yet? Derive the target slope from the client's briefs
  // so the graph shows where they should be from day one.
  if (!cEst.length && client.briefs.length) {
    const curve = weekEstimateCurve(client.briefs[0], client);
    curve.forEach((pt) => cEst.push(pt));
  }
  const cxMax = Math.max(7, ...cActual.map((p) => p.x), ...cEst.map((p) => p.x));
  const cyMax = Math.max(1, ...cActual.map((p) => p.y), ...cEst.map((p) => p.y));
  const cPace = paceTone(cActual, cEst);
  const fmtOptions = [...new Set(ALL.map((r) => r.format_type).filter(Boolean))].sort();
  const hookOptions = [...new Set(ALL.map((r) => r.hook_pattern).filter(Boolean))].sort();

  host.innerHTML = `
    <div class="viewer-top">
      <button type="button" class="ghost" id="cl-back">← All clients</button>
      <div class="minw0">
        <div class="bcard-title">${escapeHtml(client.company)}</div>
        <div class="lbl">${escapeHtml(client.niche || "All niches")}${client.ctx?.audience ? " · " + escapeHtml(client.ctx.audience) : ""}</div>
      </div>
      <div class="spacer"></div>
      <button type="button" class="btn" id="cl-nextweek">Next week's brief${client.posts.some((p) => p.checkins.length) ? " — learns from this week" : ""}</button>
    </div>

    <div class="growth-card ${v ? (v.good ? "good" : "bad") : ""}">
      <div class="growth-head">
        <h2>Growth — total views across tracked posts</h2>
        ${v ? `<span class="verdict ${v.good ? "good" : "bad"}">${v.good ? "▲" : "▼"} ${compact(v.actual)} actual vs ${compact(v.predicted)} benchmark · ${ratioLabel(v.ratio)}</span>`
            : `<span class="lbl">add posts and check-ins below to start the graph</span>`}
      </div>
      ${chartSvg({ actual: cActual, est: cEst, xMax: cxMax, yMax: cyMax, tone: cPace.tone })}
      <div class="chart-key">
        <span><i class="k-est"></i> predicted</span>
        <span><i class="k-act"></i> actual</span>
      </div>
    </div>

    <h2>Tracked posts <span class="pill">${client.posts.length}</span></h2>
    <form class="post-form" id="post-form">
      <input type="url" id="pf-url" placeholder="Paste the post link — we'll read and tag it" required>
      <select id="pf-week" title="Which week's brief this post executes">
        ${client.briefs.map((b, i) => `<option value="${escapeHtml(b.id)}">${i === 0 ? "This week" : "Week of"} ${escapeHtml((b.createdAt || "").slice(0, 10))}</option>`).join("")}
        <option value="">No week</option>
      </select>
      <button type="submit" class="btn" id="pf-add">Add &amp; auto-tag</button>
    </form>
    <p class="note" id="pf-note">Paste a TikTok, YouTube, Instagram, or Facebook link — the caption and creator
      are pulled from the post and tagged automatically against the taxonomy. Format and hook stay editable on
      the row. The benchmark locks in on add; check in with views whenever to plot the trend.</p>

    <div class="post-list">` + client.posts.map((p) => {
      const latest = postLatest(p);
      const good = latest != null && latest >= (p.predicted || 0);
      const href = safeUrl(p.url);
      return `<div class="post-row ${latest != null ? (good ? "good" : "bad") : ""}" data-pid="${escapeHtml(p.id)}">
        <div class="post-main">
          <div class="vtitle">${escapeHtml(p.caption || p.url.replace(/^https?:\/\//, "").slice(0, 70))}</div>
          <div class="lbl">${escapeHtml(p.creator || "—")}${p.platform ? " · " + escapeHtml(p.platform) : ""} · added ${escapeHtml((p.addedAt || "").slice(0, 10))}
            ${href ? ` · <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : ""}</div>
          <div class="post-tags">
            <select class="pt-format" title="Detected format — correct if wrong">${fmtOptions.map((f) => `<option${f === p.format ? " selected" : ""}>${escapeHtml(f)}</option>`).join("")}</select>
            <select class="pt-hook" title="Detected hook — correct if wrong">${hookOptions.map((h) => `<option${h === p.hook ? " selected" : ""}>${escapeHtml(h)}</option>`).join("")}</select>
          </div>
          <div class="post-nums">
            <span class="lbl">benchmark</span> <span class="mono">${compact(p.predicted || 0)}</span>
            <span class="lbl">latest</span> <span class="mono verdict ${latest != null ? (good ? "good" : "bad") : ""}">${latest != null ? compact(latest) : "—"}</span>
            <span class="lbl">${p.checkins.length} check-in${p.checkins.length === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div class="post-spark">${sparkSvg(p.checkins.map((c) => c.views), p.predicted)}</div>
        <form class="checkin-form">
          <input type="text" class="ci-views" placeholder="views now (e.g. 12.5k)" required>
          <button type="submit" class="ghost">Check in</button>
          <button type="button" class="ghost p-del">Delete</button>
        </form>
      </div>`;
    }).join("") + `</div>

    ${client.briefs.length ? `<h2>Weekly briefs <span class="pill">${client.briefs.length}</span></h2>
    <div class="brief-stack">` + client.briefs.map((b) => {
      const wv = weekVerdict(client, b.id);
      const wp = weekPostsOf(client, b.id).length;
      return `
      <article class="bcard" data-bid="${escapeHtml(b.id)}">
        <div class="bcard-main">
          <div class="bcard-title">Week of ${escapeHtml((b.createdAt || "").slice(0, 10))}</div>
          <div class="lbl">${escapeHtml(b.niche || "All niches")} · ${b.items.length} scripts · ${wp} post${wp === 1 ? "" : "s"} tracked</div>
        </div>
        ${wv ? `<span class="verdict ${wv.good ? "good" : "bad"}">${wv.good ? "▲" : "▼"} ${ratioLabel(wv.ratio)}</span>` : ""}
        <button type="button" class="btn br-open">Open</button>
        <button type="button" class="ghost br-docx" title="Download as .docx for Google Docs">.docx</button>
        <button type="button" class="ghost br-del">Delete</button>
      </article>`;
    }).join("") + `</div>` : ""}`;

  document.getElementById("cl-back").addEventListener("click", () => {
    CLIENT_VIEW = null; BRIEF_VIEW = null; renderBriefs();
  });

  document.getElementById("cl-nextweek").addEventListener("click", () => {
    LEARN_CLIENT = loadClients().find((c) => c.id === client.id) || client;
    BRIEF_CTX = client.ctx && Object.keys(client.ctx).length ? client.ctx
              : { brand: client.company, feats: [], audience: null };
    CART = new Map();
    activateTab("tab-brief");
    // Skip the site read — we already know this client; go straight to the shelf.
    renderBrief("").then(() => {
      const b = document.getElementById("ce-brand");
      if (b) b.value = client.company;
      const nSel = document.getElementById("brief-niche");
      if (nSel && client.niche) nSel.value = client.niche;
      const aSel = document.getElementById("ce-audience");
      if (aSel && client.ctx?.audience) aSel.value = client.ctx.audience;
      const fIn = document.getElementById("ce-feats");
      if (fIn && client.ctx?.feats?.length) fIn.value = client.ctx.feats.join(", ");
      document.getElementById("ce-apply")?.click();
    });
  });

  // track a new post — benchmark locked in now
  document.getElementById("post-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = normalizeClientUrl(document.getElementById("pf-url").value);
    const note = document.getElementById("pf-note");
    const btn = document.getElementById("pf-add");
    if (!url) { note.textContent = "That doesn't look like a post link."; return; }
    btn.disabled = true;
    btn.textContent = "Reading post…";
    let meta = { caption: "", creator: "", platform: "" };
    try { meta = await fetchPostMeta(url); }
    catch { note.textContent = "Couldn't read that post — tagged from the link only; correct it on the row."; }
    const { format, hook } = autoTag(meta.caption, meta.platform);
    const fresh = loadClients();
    const c = fresh.find((x) => x.id === client.id);
    c.posts.unshift({
      id: newId(), url, creator: meta.creator || "",
      caption: meta.caption || "", thumb: meta.thumb || "", platform: meta.platform || "",
      format, hook, predicted: predictViews(c.niche, format, hook),
      briefId: document.getElementById("pf-week")?.value || "",
      addedAt: new Date().toISOString(), checkins: [],
    });
    persistClients(fresh);
    renderBriefs();
  });

  // check-ins + post deletion
  host.querySelectorAll(".post-row").forEach((rowEl) => {
    const pid = rowEl.dataset.pid;
    rowEl.querySelector(".checkin-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const n = parseNum(rowEl.querySelector(".ci-views").value);
      if (isNaN(n)) { rowEl.querySelector(".ci-views").select(); return; }
      const fresh = loadClients();
      const p = fresh.find((x) => x.id === client.id)?.posts.find((x) => x.id === pid);
      if (!p) return;
      p.checkins.push({ d: new Date().toISOString().slice(0, 10), views: n });
      persistClients(fresh);
      renderBriefs();
    });
    rowEl.querySelectorAll(".pt-format, .pt-hook").forEach((sel) => {
      sel.addEventListener("change", () => {
        const fresh = loadClients();
        const post = fresh.find((x) => x.id === client.id)?.posts.find((x) => x.id === pid);
        if (!post) return;
        post.format = rowEl.querySelector(".pt-format").value;
        post.hook = rowEl.querySelector(".pt-hook").value;
        post.predicted = predictViews(client.niche, post.format, post.hook);   // re-benchmark
        persistClients(fresh);
        renderBriefs();
      });
    });
    armDelete(rowEl.querySelector(".p-del"), "Delete", () => {
      const fresh = loadClients();
      const c = fresh.find((x) => x.id === client.id);
      c.posts = c.posts.filter((x) => x.id !== pid);
      persistClients(fresh);
      renderBriefs();
    });
  });

  // briefs inside the folder
  host.querySelectorAll(".bcard[data-bid]").forEach((card) => {
    const bid = card.dataset.bid;
    card.querySelector(".br-open").addEventListener("click", () => {
      BRIEF_VIEW = { id: bid, expanded: null }; renderBriefs();
    });
    card.querySelector(".br-docx").addEventListener("click", () => {
      const rec = loadClients().find((c) => c.id === client.id)?.briefs.find((b) => b.id === bid);
      if (rec) downloadDocx(rec.ctx, rec.items, (rec.createdAt || "").slice(0, 10));
    });
    armDelete(card.querySelector(".br-del"), "Delete", () => {
      const fresh = loadClients();
      const c = fresh.find((x) => x.id === client.id);
      c.briefs = c.briefs.filter((b) => b.id !== bid);
      persistClients(fresh);
      renderBriefs();
    });
  });
}

/** The expanded body of a script card: player, stats, tags, the tailored
    script, and this slot's tracked posts — everything in one place. */
function scriptDetailHtml(rec, client, i, matchedPosts) {
  const row = rec.items[i];
  const s = tailoredScript(row, rec.ctx, i);
  const er = row.engagement_rate ? parseFloat(row.engagement_rate).toFixed(2) + "%" : "—";
  const href = safeUrl(row.url);
  const stat = (v, l) => `<div class="metric"><div class="m-val">${v}</div><div class="m-lbl">${l}</div></div>`;
  const slotPosts = weekPostsOf(client, rec.id)
    .filter((p) => p.format === row.format_type && p.hook === row.hook_pattern);
  return `
    <div class="card-detail">
      <div class="cd-player-col">
        ${frameHtml(row).replace('class="vframe ', 'class="vframe viewer-player ')}
      </div>
      <div class="cd-info">
        <p class="modal-title">${escapeHtml(row.title || "(no caption)")}</p>
        <p class="lbl">${escapeHtml(row.creator || "—")} · ${escapeHtml(row.platform || "")} · ${escapeHtml(row.data_source || "")}
          ${href ? ` · <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : ""}</p>
        <div class="metrics modal-metrics">
          ${stat(compact(views(row)), "Views")}${stat(compact(+row.likes || 0), "Likes")}
          ${stat(compact(+row.comments || 0), "Comments")}${stat(er, "ER")}
        </div>
        <div class="chips">
          ${["format_type", "hook_pattern", "niche_category", "target_audience"]
            .map((d) => row[d] ? `<span class="chip">${escapeHtml(row[d])}</span>` : "").join("")}
        </div>
        <div class="vscript">
          <div class="lbl">Tailored script — ${escapeHtml(s.heading)}</div>
          <p class="vs-hook">“${escapeHtml(s.hook)}”</p>
          ${s.beats.map((b) => `<p class="vs-beat">${escapeHtml(b)}</p>`).join("")}
          <p class="vs-beat vs-cta">${escapeHtml(s.cta)}</p>
        </div>
        ${slotPosts.length ? `<div class="lbl">Tracked posts for this script</div>
          <ul class="flag-list">${slotPosts.map((p) => {
            const r = postRatio(p); const ph = safeUrl(p.url);
            return `<li>${r != null ? `<span class="verdict ${r >= 1 ? "good" : "bad"}">${ratioLabel(r)}</span>` : `<span class="lbl">no check-ins</span>`}
              ${ph ? `<a href="${escapeHtml(ph)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.url.replace(/^https?:\/\//, "").slice(0, 50))}</a>` : ""}
              <span class="lbl">${escapeHtml(p.creator || "")}</span></li>`;
          }).join("")}</ul>` : ""}
        <div class="cd-controls">
          <button type="button" class="ghost cd-prev" ${i === 0 ? "disabled" : ""}>← Script ${i}</button>
          <button type="button" class="ghost cd-copy">Copy script</button>
          <button type="button" class="ghost cd-close">Collapse</button>
          <button type="button" class="ghost cd-next" ${i === rec.items.length - 1 ? "disabled" : ""}>Script ${i + 2} →</button>
        </div>
      </div>
    </div>`;
}

/** The week dashboard: the graph is the hero; the 10 scripts support it. */
function weekDashboardHtml(rec, client) {
  const posts = weekPostsOf(client, rec.id);
  const tracked = posts.filter((p) => p.checkins.length);
  const v = weekVerdict(client, rec.id);

  // Week chart: estimated slope from the brief's 10 formats (warm-up adjusted)
  // vs the actual cumulative views from check-ins, both on a days-since-brief axis.
  const est = weekEstimateCurve(rec, client);
  const day0 = rec.createdAt || (posts[0] && posts[0].addedAt) || new Date().toISOString();
  const events = posts.flatMap((p) => p.checkins.map((c) => ({ d: c.d, id: p.id, views: c.views })))
    .sort((a, b) => a.d < b.d ? -1 : 1);
  const seen = new Map();
  const actualPts = events.map((e) => {
    seen.set(e.id, e.views);
    return { x: daysBetween(e.d, day0), y: [...seen.values()].reduce((a, b) => a + b, 0) };
  });
  if (actualPts.length) actualPts.unshift({ x: 0, y: 0 });
  const xMax = Math.max(7, ...actualPts.map((p) => p.x), ...est.map((p) => p.x));
  const yMax = Math.max(1, ...actualPts.map((p) => p.y), ...est.map((p) => p.y));
  const pace = paceTone(actualPts, est);

  // Per-script cards: match this week's posts to each script by format×hook
  const scriptCards = rec.items.map((it, i) => {
    const matched = posts.filter((p) => p.format === it.format_type && p.hook === it.hook_pattern && p.checkins.length);
    const pts = matched.map(postLatest);
    const predSeries = matched.map((p) => p.predicted || 0);
    const pred = matched.length ? Math.round(median(predSeries))
                                : predictViews(client.niche, it.format_type, it.hook_pattern);
    const ratios = matched.map(postRatio);
    const avg = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
    const cls = avg == null ? "" : avg >= 1 ? "good" : "bad";
    const status = avg == null ? "untracked"
      : avg >= 1.25 ? `▲ ${ratioLabel(avg)} — push more`
      : avg >= 1 ? `▲ ${ratioLabel(avg)}`
      : avg >= 0.75 ? `▼ ${ratioLabel(avg)}`
      : `▼ ${ratioLabel(avg)} — change`;
    const expanded = BRIEF_VIEW && BRIEF_VIEW.expanded === i;
    return `<div class="fmt-card expandable ${cls}${expanded ? " expanded" : ""}" data-idx="${i}">
      <div class="fmt-head" role="button" tabindex="0" title="${expanded ? "Collapse" : "Expand for the script, video, and details"}">
        <strong>${i + 1}. ${escapeHtml(it.format_type || "—")} × ${escapeHtml(it.hook_pattern || "—")}</strong>
        <span class="fmt-head-right"><span class="verdict ${cls}">${escapeHtml(status)}</span><span class="caret">${expanded ? "▾" : "▸"}</span></span>
      </div>
      ${sparkSvg(pts, matched.length ? predSeries : pred)}
      ${expanded ? scriptDetailHtml(rec, client, i, matched) : ""}
    </div>`;
  }).join("");

  // Flags: emphasize overperformers, call out underperformers
  const over = tracked.filter((p) => postRatio(p) >= 1.25).sort((a, b) => postRatio(b) - postRatio(a));
  const under = tracked.filter((p) => postRatio(p) < 0.75).sort((a, b) => postRatio(a) - postRatio(b));
  const postLine = (p) => {
    const href = safeUrl(p.url);
    const label = escapeHtml((p.url || "").replace(/^https?:\/\//, "").slice(0, 55));
    return `<li><span class="verdict ${postRatio(p) >= 1 ? "good" : "bad"}">${ratioLabel(postRatio(p))}</span>
      ${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label}
      <span class="lbl">${escapeHtml(p.creator || "")} · ${escapeHtml(p.format)} × ${escapeHtml(p.hook)} · ${compact(postLatest(p))} views</span></li>`;
  };

  // What to change — deterministic reading of the week's numbers
  const recs = [];
  const byScript = rec.items.map((it) => {
    const m = tracked.filter((p) => p.format === it.format_type && p.hook === it.hook_pattern);
    const avg = m.length ? m.reduce((a, p) => a + postRatio(p), 0) / m.length : null;
    return { it, n: m.length, avg };
  });
  for (const b of byScript) {
    if (b.avg != null && b.avg >= 1.25)
      recs.push(`Double down on ${b.it.format_type} × ${b.it.hook_pattern} — running ${ratioLabel(b.avg)}. Brief more of these next week.`);
    if (b.avg != null && b.avg < 0.75)
      recs.push(`Change ${b.it.format_type} × ${b.it.hook_pattern} — at ${ratioLabel(b.avg)}. Swap the hook or replace the format next week.`);
  }
  const untrackedN = byScript.filter((b) => b.n === 0).length;
  if (untrackedN && tracked.length)
    recs.push(`${untrackedN} of ${rec.items.length} scripts have no tracked post yet — post them or replace them.`);
  if (!tracked.length)
    recs.push("Nothing tracked for this week yet — add posts below (Tracked posts on the client page) and check in with views.");

  return `
    <div class="growth-card ${pace.tone}">
      <div class="growth-head">
        <h2>${pace.label ? (pace.tone === "good" ? "Good week — ahead of the predicted slope"
                          : pace.tone === "bad" ? "Behind the predicted slope"
                          : "Tracking the predicted slope") : "This week"}</h2>
        ${pace.label ? `<span class="verdict ${pace.tone}">${escapeHtml(pace.label)}</span>`
                     : `<span class="lbl">the actual line fills in as posts get check-ins</span>`}
      </div>
      ${chartSvg({ actual: actualPts, est, xMax, yMax, tone: pace.tone })}
      <div class="chart-key">
        <span><i class="k-est"></i> predicted — the brief's formats at benchmark</span>
        <span><i class="k-act"></i> actual</span>
      </div>
    </div>

    ${recs.length ? `<div class="recs"><h2>What to change</h2><ul>${recs.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></div>` : ""}

    ${over.length ? `<div class="flag-block good-block"><h2>Overperforming — emphasize these</h2><ul class="flag-list">${over.map(postLine).join("")}</ul></div>` : ""}
    ${under.length ? `<div class="flag-block bad-block"><h2>Underperforming — flagged</h2><ul class="flag-list">${under.map(postLine).join("")}</ul></div>` : ""}

    <h2>The 10 scripts behind the graph</h2>
    <div class="fmt-grid">${scriptCards}</div>`;
}

function renderBriefViewer(host, rec, client) {
  if (BRIEF_VIEW.expanded != null)
    BRIEF_VIEW.expanded = Math.max(0, Math.min(BRIEF_VIEW.expanded, rec.items.length - 1));
  host.innerHTML = `
    <div class="viewer-top">
      <button type="button" class="ghost" id="bv-back">← ${escapeHtml(client?.company || "Back")}</button>
      <div class="minw0">
        <div class="bcard-title">${escapeHtml(rec.company)} — week of ${escapeHtml((rec.createdAt || "").slice(0, 10))}</div>
        <div class="lbl">${escapeHtml(rec.niche || "All niches")}</div>
      </div>
      <div class="spacer"></div>
      <button type="button" class="ghost" id="bv-docx">Download .docx</button>
    </div>
    ${weekDashboardHtml(rec, client)}`;

  document.getElementById("bv-back").addEventListener("click", () => { BRIEF_VIEW = null; renderBriefs(); });
  document.getElementById("bv-docx").addEventListener("click", () =>
    downloadDocx(rec.ctx, rec.items, (rec.createdAt || "").slice(0, 10)));

  const setExpanded = (idx) => {
    BRIEF_VIEW.expanded = idx;
    renderBriefs();
    if (idx != null) {
      const card = document.querySelector(`.fmt-card[data-idx="${idx}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  host.querySelectorAll(".fmt-card.expandable .fmt-head").forEach((head) => {
    const idx = Number(head.closest(".fmt-card").dataset.idx);
    const toggle = () => setExpanded(BRIEF_VIEW.expanded === idx ? null : idx);
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });

  const openIdx = BRIEF_VIEW.expanded;
  if (openIdx != null && rec.items[openIdx]) {
    const row = rec.items[openIdx];
    const detail = host.querySelector(".card-detail");
    detail?.querySelector(".cd-close")?.addEventListener("click", () => setExpanded(null));
    detail?.querySelector(".cd-prev")?.addEventListener("click", () => setExpanded(openIdx - 1));
    detail?.querySelector(".cd-next")?.addEventListener("click", () => setExpanded(openIdx + 1));
    detail?.querySelector(".cd-copy")?.addEventListener("click", async (e) => {
      const sc = tailoredScript(row, rec.ctx, openIdx);
      try {
        await navigator.clipboard.writeText(`${sc.heading}\nHook: \u201c${sc.hook}\u201d\n${sc.beats.join("\n")}\n${sc.cta}`);
        e.target.textContent = "Copied ✓";
      } catch {}
    });
    const play = detail?.querySelector(".vplay");
    if (play) play.addEventListener("click", () => playInFrame(detail.querySelector(".viewer-player"), row));
    fillTikTokThumbs([row]);
  }
}

function confidenceOf(n) {
  if (n >= 25) return { label: "Strong", cls: "strong" };
  if (n >= 12) return { label: "Moderate", cls: "" };
  return { label: "Thin data", cls: "" };
}

function segmentStats(rows) {
  const vs = rows.map(views);
  return { n: rows.length, med: median(vs), rows };
}

/** Build up to 10 ranked plays, ranked by a source-normalised performance index.
 *
 *  Raw view counts are NOT comparable across sources: Medceptor UGC posts run in
 *  the hundreds while scraped viral TikToks run in the hundreds of thousands.
 *  Ranking on raw views would just rediscover "TikTok has more views". So each
 *  video is scored against the median of ITS OWN source — index 1.00 = typical
 *  for where it came from — and segments are ranked on the median of that.
 */
function buildPlays(pool) {
  const bySource = new Map();
  for (const r of pool) {
    const s = r.data_source || "?";
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(views(r));
  }
  const srcMedian = new Map([...bySource].map(([s, vs]) => [s, median(vs) || 1]));
  // Client-tracked rows are scored against the benchmark they were measured
  // against; source-normalising them would divide them by themselves.
  const relative = (r) => (r._client && r._ratio != null)
    ? r._ratio : views(r) / (srcMedian.get(r.data_source || "?") || 1);
  const learning = LEARN_CLIENT ? clientLearning(LEARN_CLIENT) : null;

  const plays = [];
  const seen = new Set();

  const push = (kind, format, hook, rows) => {
    const key = `${format}|${hook}`;
    if (seen.has(key)) return;
    seen.add(key);
    plays.push({
      kind, format, hook, n: rows.length,
      med: median(rows.map(views)),
      index: median(rows.map(relative)) * learnedBoost(learning, format, hook),
      examples: [...rows].sort((a, b) => relative(b) - relative(a)).slice(0, 3),
    });
  };

  // 1. format x hook combos
  const combos = new Map();
  for (const r of pool) {
    const f = r.format_type || "Other", h = r.hook_pattern || "Other";
    const k = f + "|" + h;
    if (!combos.has(k)) combos.set(k, []);
    combos.get(k).push(r);
  }
  const comboList = [...combos.entries()]
    .filter(([, rs]) => rs.length >= MIN_N_COMBO)
    .map(([k, rs]) => ({ k, rs, idx: median(rs.map(relative)) }))
    .sort((a, b) => b.idx - a.idx);
  for (const c of comboList) {
    const [f, h] = c.k.split("|");
    push("combo", f, h, c.rs);
    if (plays.length >= 10) break;
  }

  // 2. fill remaining slots with strong single-dimension plays
  if (plays.length < 10) {
    const single = (key, otherLabel) => {
      const m = new Map();
      for (const r of pool) {
        const v = r[key] || "Other";
        if (!m.has(v)) m.set(v, []);
        m.get(v).push(r);
      }
      return [...m.entries()]
        .filter(([, rs]) => rs.length >= MIN_N_SINGLE)
        .map(([v, rs]) => ({ v, rs, idx: median(rs.map(relative)) }))
        .sort((a, b) => b.idx - a.idx);
    };
    for (const f of single("format_type")) {
      if (plays.length >= 10) break;
      push("format", f.v, "Any hook", f.rs);
    }
    for (const h of single("hook_pattern")) {
      if (plays.length >= 10) break;
      push("hook", "Any format", h.v, h.rs);
    }
  }

  return { plays: plays.slice(0, 10).sort((a, b) => b.index - a.index) };
}

let BRIEF_CTX = null;  // {brand, feats, audience} from the last site read, used in play cards

/** Brand loader: the mark's two blades counter-rotate and keep converging —
    the logo's own "data converging into insight" gesture, used while we read
    the client's site and match it against the database. Stages are advanced
    at real transition points, not on a timer, so the text never lies. */
function showLoader(host, hostname) {
  host.innerHTML = `
    <div class="loader" role="status" aria-live="polite">
      <!-- The mark split into its four arms, each scaling out of the centre in
           clockwise turn, holding as the complete X, then resetting. Arms stop
           at the diamond (9,12)(12,9)(15,12)(12,15) — the void the real logo's
           evenodd rule carves where the two blades cross — so the assembled
           mark keeps its centre gap. -->
      <svg class="loader-mark" viewBox="0 0 24 24" aria-hidden="true">
        <path class="arm a1" fill="currentColor" d="M3 3H6L12 9L9 12L3 6Z"/>
        <path class="arm a2" fill="currentColor" d="M21 3V6L15 12L12 9L18 3Z"/>
        <path class="arm a3" fill="currentColor" d="M15 12L21 18L18 21L12 15Z"/>
        <path class="arm a4" fill="currentColor" d="M12 15L6 21L3 18L9 12Z"/>
      </svg>
      <div class="loader-text">
        <div class="loader-stage" id="loader-stage">${hostname ? `Reading ${escapeHtml(hostname)}` : "Preparing"}</div>
        <div class="lbl loader-sub">matching the client against ${fmt(ALL.length)} videos</div>
      </div>
    </div>`;
  return {
    stage(text) {
      const el = document.getElementById("loader-stage");
      if (el) el.textContent = text;
    },
  };
}

async function renderBrief(rawUrl) {
  const host = document.getElementById("brief-out");
  const hasUrl = String(rawUrl || "").trim().length > 0;
  const url = hasUrl ? normalizeClientUrl(rawUrl) : null;
  if (hasUrl && !url) {
    host.innerHTML = `<div class="warn">That doesn't look like a website address. Try something like
      <code>clientsite.com</code> — or leave it empty and fill in the client details by hand.</div>`;
    return;
  }

  let analysis = null, failReason = null;
  const loader = showLoader(host, url ? new URL(url).hostname : "");
  if (url) {
    try {
      const read = await readClientSite(url);
      loader.stage("Detecting niche, features, and audience");
      await new Promise((r) => setTimeout(r, 60));   // let the stage paint
      analysis = analyzeSite(read, url);
      analysis.title = read.title;
      analysis.description = read.description;
      analysis.via = read.via;
      loader.stage("Matching formats that perform in this niche");
      await new Promise((r) => setTimeout(r, 60));
    } catch (e) {
      failReason = e.message || "unreachable";
    }
  }

  const urlGuess = inferNiche(rawUrl);
  const chosen = analysis?.niche || urlGuess.niche || "";
  BRIEF_CTX = analysis ? { brand: analysis.brand, feats: analysis.feats, audience: analysis.audience } : null;
  CART = new Map();   // a new client = a fresh brief

  const status = analysis
    ? `<div class="site-card">
        <div class="site-head">
          <strong>${escapeHtml(analysis.title || analysis.brand)}</strong>
          <span class="lbl">read ${fmt(analysis.words)} words via ${escapeHtml(analysis.via)}</span>
        </div>
        ${analysis.description ? `<p class="site-desc">${escapeHtml(analysis.description)}</p>` : ""}
        ${!analysis.confident && analysis.nicheRunnerUp ? `
          <div class="lbl mt8">Could also be ${escapeHtml(analysis.nicheRunnerUp)} — check the niche in the details below.</div>` : ""}
      </div>`
    : hasUrl
      ? `<div class="warn">Couldn't read the site (${escapeHtml(failReason || "unknown")}) — it may block
          automated readers. Fill in the client details below and everything still works.</div>`
      : `<div class="note mt14">No URL — fill in the client details below.</div>`;

  // Manual client details: prefilled when the read worked, blank when it didn't.
  // This is the fallback for sites that block scraping AND the correction surface
  // when detection is wrong — Apply re-tailors every script.
  const niches = [...new Set(ALL.map((r) => r.niche_category).filter(Boolean))].sort();
  const audiences = [...new Set(ALL.map((r) => r.target_audience).filter(Boolean))].sort();
  host.innerHTML = status + `
    <div class="client-editor" id="client-editor">
      <div class="ce-head">
        <h3 class="ce-title">Client details</h3>
        <div class="chips" id="ce-chips"></div>
        <button type="button" class="ghost ce-toggle" id="ce-toggle">Edit</button>
      </div>
      <div class="ce-body" id="ce-body">
      <div class="ce-grid">
        <label class="ce-field"><span class="lbl">Company name</span>
          <input type="text" id="ce-brand" value="${escapeHtml(analysis?.brand || "")}" placeholder="e.g. Medceptor"></label>
        <label class="ce-field"><span class="lbl">Niche</span>
          <select id="brief-niche">
            <option value="">Whole database (all niches)</option>
            ${niches.map((n) => `<option value="${escapeHtml(n)}"${n === chosen ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}
          </select></label>
        <label class="ce-field"><span class="lbl">Target audience</span>
          <select id="ce-audience">
            <option value="">Not sure</option>
            ${audiences.map((a) => `<option value="${escapeHtml(a)}"${a === analysis?.audience ? " selected" : ""}>${escapeHtml(a)}</option>`).join("")}
          </select></label>
        <label class="ce-field ce-wide"><span class="lbl">Features / selling points (comma-separated — these get written into the scripts)</span>
          <input type="text" id="ce-feats" value="${escapeHtml((analysis?.feats || []).join(", "))}"
            placeholder="e.g. NCLEX practice questions, case walkthroughs, study planner"></label>
      </div>
      <button type="button" class="btn" id="ce-apply">Apply — build the shelf</button>
      </div>
    </div>
    <div id="brief-body"></div>`;

  const apply = () => {
    const brand = document.getElementById("ce-brand").value.trim();
    const feats = document.getElementById("ce-feats").value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8);
    const audience = document.getElementById("ce-audience").value || null;
    const niche = document.getElementById("brief-niche").value;
    BRIEF_CTX = (brand || feats.length || audience)
      ? { brand: brand || "the product", feats, audience }
      : BRIEF_CTX;
    // Collapse the editor into a one-line summary; Edit re-opens it.
    const chips = [
      BRIEF_CTX?.brand, niche || "All niches", BRIEF_CTX?.audience,
      BRIEF_CTX?.feats?.length ? `${BRIEF_CTX.feats.length} features` : null,
    ].filter(Boolean);
    document.getElementById("ce-chips").innerHTML =
      chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join("");
    document.getElementById("client-editor").classList.add("collapsed");
    renderShelf(niche);
    document.getElementById("brief-body").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  document.getElementById("ce-toggle").addEventListener("click", () => {
    document.getElementById("client-editor").classList.toggle("collapsed");
  });
  document.getElementById("ce-apply").addEventListener("click", apply);
  document.getElementById("brief-niche").addEventListener("change", apply);
  if (analysis) {
    apply();   // read succeeded: collapse to summary and build the shelf
  } else {
    renderShelf(chosen);   // manual path: keep the editor open for filling in
  }
}


function initBrief() {
  const form = document.getElementById("brief-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    LEARN_CLIENT = null;   // a brief started here is fresh unless launched from a client
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try { await renderBrief(document.getElementById("client-url").value); }
    finally { btn.disabled = false; }
  });
}

// ---------- Boot ----------
function renderApp(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    document.querySelector("main").innerHTML = `
      <div class="empty"><p><strong>No data loaded yet.</strong></p>
        <p>Generate <code>data.enc</code> by running the pipeline, then reload.</p></div>`;
    return;
  }
  ALL = rows;
  renderStats(rows);
  renderBars("by-format", countBy(rows, "format_type"), 8, "f-format");
  renderBars("by-hook", countBy(rows, "hook_pattern"), 8, "f-hook");
  renderBars("by-niche", countBy(rows, "niche_category"), 8, "f-niche");
  renderBars("by-source", countBy(rows, "data_source"), 8, "f-source");
  initTabs();
  initModal();
  renderBriefs();
  // Arrow keys flip through an open brief (unless typing in a field).
  document.addEventListener("keydown", (e) => {
    if (!BRIEF_VIEW || document.getElementById("panel-briefs").hidden) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) return;
    if (BRIEF_VIEW.expanded == null) return;
    if (e.key === "ArrowLeft" && BRIEF_VIEW.expanded > 0) { BRIEF_VIEW.expanded--; renderBriefs(); }
    if (e.key === "ArrowRight") { BRIEF_VIEW.expanded++; renderBriefs(); }
  });
  initControls();
  initBrief();
  applyFilters();
}
