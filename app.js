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
  gate.style.display = "none";
  app.style.display = "block";
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
  [...host.querySelectorAll(".bar-fill")].forEach((el, i) => {
    el.style.width = Math.max((shown[i][1] / max) * 100, 1).toFixed(2) + "%";
  });
  // Overview shows the split; clicking a bar drills into those exact videos.
  if (drillSelectId) {
    host.querySelectorAll(".bar-row.drill").forEach((rowEl) => {
      const go = () => {
        document.getElementById("reset").click();
        document.getElementById(drillSelectId).value = rowEl.dataset.val;
        applyFilters();
        activateTab("tab-database");
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
  ["tab-overview", "panel-overview"],
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

function refreshTray() {
  const tray = document.getElementById("tray");
  if (!tray) return;
  tray.innerHTML = trayHtml();
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
  let pool = niche ? ALL.filter((r) => r.niche_category === niche) : ALL;
  const notes = [];
  if (niche && pool.length < MIN_N_NICHE) {
    notes.push(`Only ${pool.length} videos tagged <strong>${escapeHtml(niche)}</strong> — too few to rank
      reliably, so the shelf draws from the whole database instead. Treat it as directional.`);
    pool = ALL;
  }

  const bySource = new Map();
  for (const r of pool) {
    const s = r.data_source || "?";
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(views(r));
  }
  const srcMedian = new Map([...bySource].map(([s, vs]) => [s, median(vs) || 1]));
  const relative = (r) => views(r) / (srcMedian.get(r.data_source || "?") || 1);
  const shelf = buildShelf(pool, relative);

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
  body += para(`${items.length} scripts tailored from the Lynxr format database · ${today}`, { size: 20, spaceAfter: 300 });
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
  a.download = `${brand} — Lynxr Content Brief.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Saved briefs (in-platform, browser localStorage) ----------
const BRIEFS_KEY = "lynxr_briefs";

function loadBriefs() {
  try { return JSON.parse(localStorage.getItem(BRIEFS_KEY)) || []; } catch { return []; }
}
function persistBriefs(list) {
  try { localStorage.setItem(BRIEFS_KEY, JSON.stringify(list)); } catch {}
}

/** Save the current cart as an in-platform brief (newest stacks on top). */
function saveCurrentBrief() {
  if (CART.size < CART_LIMIT) return;
  const rec = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    company: BRIEF_CTX?.brand || "Client",
    ctx: BRIEF_CTX || {},
    niche: document.getElementById("brief-niche")?.value || "",
    createdAt: new Date().toISOString(),
    items: [...CART.values()],
  };
  const list = loadBriefs();
  list.unshift(rec);
  persistBriefs(list);

  // Wrap up for the next client: clear cart, reopen the details editor.
  CART = new Map();
  closeModal();
  const editor = document.getElementById("client-editor");
  if (editor) {
    editor.classList.remove("collapsed");
    renderShelf(document.getElementById("brief-niche")?.value || "");
  }
  // Land on the stack so the new brief is visibly on top, ready to flip through.
  renderBriefs();
  activateTab("tab-briefs");
}

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

// ---------- Briefs tab: stacked list + flip-through viewer ----------
let BRIEF_VIEW = null;   // { id, page } when a brief is open

function renderBriefs() {
  const host = document.getElementById("briefs-host");
  const list = loadBriefs();

  if (BRIEF_VIEW) {
    const rec = list.find((b) => b.id === BRIEF_VIEW.id);
    if (rec) { renderBriefViewer(host, rec); return; }
    BRIEF_VIEW = null;
  }

  if (!list.length) {
    host.innerHTML = `<h2>Briefs</h2>
      <div class="empty"><p><strong>No saved briefs yet.</strong></p>
        <p>Build one in the Client brief tab — pick 10 videos and hit Save brief.</p></div>`;
    return;
  }

  host.innerHTML = `<h2>Briefs <span class="pill">${list.length}</span></h2>
    <div class="brief-stack">` + list.map((b) => `
      <article class="bcard" data-id="${escapeHtml(b.id)}">
        <div class="bcard-main">
          <div class="bcard-title">${escapeHtml(b.company)}</div>
          <div class="lbl">${escapeHtml((b.createdAt || "").slice(0, 10))}
            · ${escapeHtml(b.niche || "All niches")} · ${b.items.length} videos</div>
        </div>
        <button type="button" class="btn b-open">Open</button>
        <button type="button" class="ghost b-docx" title="Download as .docx for Google Docs">.docx</button>
        <button type="button" class="ghost b-del" title="Delete brief">Delete</button>
      </article>`).join("") + `</div>`;

  host.querySelectorAll(".bcard").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector(".b-open").addEventListener("click", () => {
      BRIEF_VIEW = { id, page: 0 };
      renderBriefs();
    });
    card.querySelector(".b-docx").addEventListener("click", () => {
      const rec = loadBriefs().find((b) => b.id === id);
      if (rec) downloadDocx(rec.ctx, rec.items, (rec.createdAt || "").slice(0, 10));
    });
    card.querySelector(".b-del").addEventListener("click", () => {
      if (!confirm("Delete this brief?")) return;
      persistBriefs(loadBriefs().filter((b) => b.id !== id));
      renderBriefs();
    });
  });
}

function renderBriefViewer(host, rec) {
  const n = rec.items.length;
  const page = Math.min(Math.max(BRIEF_VIEW.page, 0), n - 1);
  BRIEF_VIEW.page = page;
  const row = rec.items[page];
  const s = tailoredScript(row, rec.ctx, page);
  const er = row.engagement_rate ? parseFloat(row.engagement_rate).toFixed(2) + "%" : "—";
  const href = safeUrl(row.url);
  const stat = (v, l) => `<div class="metric"><div class="m-val">${v}</div><div class="m-lbl">${l}</div></div>`;

  host.innerHTML = `
    <div class="viewer-top">
      <button type="button" class="ghost" id="bv-back">← All briefs</button>
      <div class="minw0">
        <div class="bcard-title">${escapeHtml(rec.company)}</div>
        <div class="lbl">${escapeHtml((rec.createdAt || "").slice(0, 10))} · ${escapeHtml(rec.niche || "All niches")}</div>
      </div>
      <div class="spacer"></div>
      <button type="button" class="ghost" id="bv-docx">Download .docx</button>
    </div>
    <div class="viewer">
      <div class="viewer-player-col">
        ${frameHtml(row).replace('class="vframe ', 'class="vframe viewer-player ')}
      </div>
      <div class="viewer-info">
        <div class="lbl">Script ${page + 1} of ${n}</div>
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
      </div>
    </div>
    <div class="pager">
      <button type="button" class="ghost" id="bv-prev" ${page === 0 ? "disabled" : ""}>← Prev</button>
      <span>${page + 1} / ${n}</span>
      <button type="button" class="ghost" id="bv-next" ${page === n - 1 ? "disabled" : ""}>Next →</button>
    </div>`;

  document.getElementById("bv-back").addEventListener("click", () => { BRIEF_VIEW = null; renderBriefs(); });
  document.getElementById("bv-docx").addEventListener("click", () =>
    downloadDocx(rec.ctx, rec.items, (rec.createdAt || "").slice(0, 10)));
  document.getElementById("bv-prev").addEventListener("click", () => { BRIEF_VIEW.page--; renderBriefs(); });
  document.getElementById("bv-next").addEventListener("click", () => { BRIEF_VIEW.page++; renderBriefs(); });
  const play = host.querySelector(".vplay");
  if (play) play.addEventListener("click", () => playInFrame(host.querySelector(".viewer-player"), row));
  fillTikTokThumbs([row]);
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
  const relative = (r) => views(r) / (srcMedian.get(r.data_source || "?") || 1);

  const plays = [];
  const seen = new Set();

  const push = (kind, format, hook, rows) => {
    const key = `${format}|${hook}`;
    if (seen.has(key)) return;
    seen.add(key);
    plays.push({
      kind, format, hook, n: rows.length,
      med: median(rows.map(views)),
      index: median(rows.map(relative)),
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
  if (url) {
    host.innerHTML = `<div class="progress" role="status">Reading ${escapeHtml(new URL(url).hostname)}…</div>`;
    try {
      const read = await readClientSite(url);
      analysis = analyzeSite(read, url);
      analysis.title = read.title;
      analysis.description = read.description;
      analysis.via = read.via;
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
    if (e.key === "ArrowLeft") { BRIEF_VIEW.page--; renderBriefs(); }
    if (e.key === "ArrowRight") { BRIEF_VIEW.page++; renderBriefs(); }
  });
  initControls();
  initBrief();
  applyFilters();
}
