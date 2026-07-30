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

function renderBars(hostId, pairs, limit = 8) {
  const host = document.getElementById(hostId);
  const shown = pairs.slice(0, limit);
  const max = shown.length ? shown[0][1] : 1;
  host.innerHTML = shown.map(([label, count]) => `
    <div class="bar-row">
      <div class="bar-track">
        <div class="bar-fill" style="width:${(count / max) * 100}%"></div>
        <div class="bar-label">${escapeHtml(label)}</div>
      </div>
      <div class="bar-count">${fmt(count)}</div>
    </div>`).join("");
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
];
function initTabs() {
  for (const [tabId, panelId] of TABS) {
    document.getElementById(tabId).addEventListener("click", () => {
      for (const [t, p] of TABS) {
        const on = t === tabId;
        document.getElementById(t).setAttribute("aria-selected", String(on));
        document.getElementById(p).hidden = !on;
      }
      window.scrollTo({ top: 0 });
    });
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
              return `<td class="num">${isNaN(v) ? "—" : fmt(v) + (c.pct ? "%" : "")}</td>`;
            }
            return `<td class="${c.cls || ""}" title="${escapeHtml(raw || "")}">${escapeHtml(raw || "—")}</td>`;
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

function renderBrief(rawUrl) {
  const host = document.getElementById("brief-out");
  const { niche, score } = inferNiche(rawUrl);
  const niches = [...new Set(ALL.map((r) => r.niche_category).filter(Boolean))].sort();
  const chosen = niche || "";

  host.innerHTML = `
    <div class="detected">
      <span class="lbl">Niche</span>
      <select id="brief-niche" aria-label="Niche to build the brief from">
        <option value="">Whole database (all niches)</option>
        ${niches.map((n) => `<option value="${escapeHtml(n)}"${n === chosen ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}
      </select>
      <span class="lbl">${score ? "inferred from the URL" : "no keyword match — pick one"}</span>
    </div>
    <div id="brief-body"></div>`;
  document.getElementById("brief-niche").addEventListener("change", (e) => renderPlays(e.target.value));
  renderPlays(chosen);
}

function renderPlays(niche) {
  const body = document.getElementById("brief-body");
  let pool = niche ? ALL.filter((r) => r.niche_category === niche) : ALL;
  let notes = [];

  if (niche && pool.length < MIN_N_NICHE) {
    notes.push(`Only ${pool.length} videos tagged <strong>${escapeHtml(niche)}</strong> — too few to rank
      reliably, so this brief uses the whole database instead. Treat it as directional.`);
    pool = ALL;
  }

  const { plays } = buildPlays(pool);
  if (!plays.length) {
    body.innerHTML = `<div class="empty">Not enough data to build a brief for this niche.</div>`;
    return;
  }
  if (plays.length < 10) {
    notes.push(`Only ${plays.length} segments clear the minimum sample size
      (${MIN_N_COMBO}+ videos for a format×hook play), so fewer than 10 are shown rather than padding with noise.`);
  }

  const scope = niche && pool !== ALL ? escapeHtml(niche) : "the whole database";
  body.innerHTML =
    notes.map((n) => `<div class="warn">${n}</div>`).join("") +
    `<p class="note">Scope: ${scope}. Each video is scored against the median of its own
       source, so <strong>index 1.00 = typical</strong> for where it came from — a 900-view
       Medceptor post and a 900,000-view viral TikTok are judged on the same scale. Plays are
       ranked on the median index of their videos.</p>` +
    `<div class="plays">` + plays.map((p, i) => {
      const conf = confidenceOf(p.n);
      return `
      <article class="play">
        <div class="play-head">
          <div class="rank">${String(i + 1).padStart(2, "0")}</div>
          <div style="min-width:0">
            <h3 class="play-title">${escapeHtml(p.format)} <span style="color:var(--text-3)">×</span> ${escapeHtml(p.hook)}</h3>
            <p class="play-why">${fmt(p.n)} videos ·
              <span class="badge ${conf.cls}">${escapeHtml(conf.label)}</span></p>
          </div>
          <div class="metrics">
            <div class="metric"><div class="m-val">${p.index.toFixed(2)}×</div><div class="m-lbl">Index</div></div>
            <div class="metric"><div class="m-val">${compact(p.med)}</div><div class="m-lbl">Median views</div></div>
            <div class="metric"><div class="m-val">${fmt(p.n)}</div><div class="m-lbl">Sample</div></div>
          </div>
        </div>
        <div class="examples">${p.examples.map((ex) => {
          const href = safeUrl(ex.url);
          const label = escapeHtml(ex.title || "(no caption)");
          return `<div class="ex">
            <span class="ex-title">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label}</span>
            <span class="ex-meta">${escapeHtml(ex.creator || "—")} · ${compact(views(ex))} views</span>
          </div>`;
        }).join("")}</div>
      </article>`;
    }).join("") + `</div>`;
}

function initBrief() {
  document.getElementById("brief-form").addEventListener("submit", (e) => {
    e.preventDefault();
    renderBrief(document.getElementById("client-url").value);
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
  renderBars("by-format", countBy(rows, "format_type"));
  renderBars("by-hook", countBy(rows, "hook_pattern"));
  renderBars("by-niche", countBy(rows, "niche_category"));
  renderBars("by-source", countBy(rows, "data_source"));
  initTabs();
  initControls();
  initBrief();
  applyFilters();
}
