// Frame guard: GitHub Pages cannot send an X-Frame-Options/CSP header, and
// frame-ancestors is spec-ignored in meta CSP — so block clickjacking in JS.
// If framed, blank the page and bust out to the real site.
if (window.top !== window.self) {
  document.documentElement.innerHTML = "";
  try { window.top.location = window.location; } catch { window.location.replace("about:blank"); }
}

// The video database lives in Supabase (table lynxr_videos) behind row-level
// security: signed-in users can read it, anonymous visitors get nothing, and
// no write policies exist so a browser can never modify it. This replaced the
// old encrypted data.enc blob — one login is the whole gate, there is no
// second passphrase and no client-side crypto.

const gate = document.getElementById("gate");
const app = document.getElementById("app");

// Belt-and-suspenders: clear any key bytes a prior build may have persisted.
try { sessionStorage.removeItem("lynxr_k"); sessionStorage.removeItem("lynxr_access"); } catch {}

let unlocked = false;
function unlock(rows) {
  if (unlocked) return;   // guard: double-unlock would double-bind listeners
  unlocked = true;
  document.getElementById("err").textContent = "";
  gate.style.display = "none";
  app.style.display = "block";
  renderApp(rows);
  startLiveSync();
}

/** Put the gate's status line into a working state: the four-arm mark at text
 *  size, plus what it is doing. `text` is ours, never server-supplied — every
 *  failure message goes through textContent instead. */
function gateBusy(el, text) {
  el.innerHTML = `<span class="loader inline">${loaderMark()}<span>${escapeHtml(text)}</span></span>`;
}

document.getElementById("gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const emailEl = document.getElementById("email");
  const pw = document.getElementById("pw");
  const err = document.getElementById("err");
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const email = (emailEl?.value || "").trim();
  const password = pw.value;
  if (!email || !password) { err.textContent = "Enter your email and password."; return; }

  submitBtn.disabled = true;
  /* The mark, working — same signal as the site read and the script write.
     Pulling the database is the longest wait in this app (thousands of rows
     over one request), and a line of static text there is indistinguishable
     from a request that has already died.

     textContent for the failure paths below, deliberately: those render
     server-supplied text, and innerHTML would make that an injection. */
  gateBusy(err, "Signing in…");
  let signedIn = false;
  try {
    await sbSignIn(email, password);
    signedIn = true;
    gateBusy(err, "Loading database…");
    const rows = await sbFetchVideos();
    pw.value = "";
    try { await syncClients(); } catch { SYNC_OK = false; }
    unlock(rows);
    updateSyncBadge();
  } catch (ex) {
    const m = (ex && ex.message) || "";
    // Once sign-in succeeded, the credentials were fine — any later failure is
    // the database load, so don't blame the password.
    err.textContent = signedIn
      ? await loadFailureReason(m)
      : (/Invalid login|invalid_grant|Sign-in failed/i.test(m)
          ? "Wrong email or password."
          : "Could not sign in — check your connection.");
    pw.select();
  } finally {
    submitBtn.disabled = false;
  }
});

/** Why the database wouldn't load for an account that just signed in fine.
    Since agency tables went staff-only, the commonest cause is a creator
    account reaching the wrong app: RLS filters every row, so the read comes
    back empty and looks identical to "the pipeline never ran". Ask the
    database which it is rather than guessing — is_staff() is the same check
    the policies use, and it costs one request on the failure path only. */
async function loadFailureReason(m) {
  if (m.includes("videos")) {
    try {
      const staff = await sbFetch("/rest/v1/rpc/is_staff", { method: "POST", body: "{}" });
      if (staff === false) {
        return "That's a creator account — it has no agency access. Ask us for the creator link instead.";
      }
    } catch { /* pre-staff-gate database, or offline: fall through */ }
    return "Signed in, but the database is empty — run pipeline/export_supabase.py.";
  }
  return "Signed in, but couldn't load the database — check your connection.";
}

// Returning session: refresh the token and go straight in, no retyping.
// Invoked at the very end of this file — it reads SB_SESSION_KEY and the other
// Supabase consts, which are declared far below, so it must not run until they
// are initialized (this is a classic top-to-bottom script).
async function resumeSession() {
  const sess = sbLoadSession();
  if (!sess?.refresh_token) return;
  try {
    await sbRefresh(sess.refresh_token);
  } catch {
    sbClearSession();   // stale or revoked — fall back to the login form
    return;
  }
  // The token is good; a data-load hiccup here is transient, so keep the
  // session (the gate stays up and a reload retries) rather than forcing a
  // re-login on every blip.
  try {
    const rows = await sbFetchVideos();
    try { await syncClients(); } catch { SYNC_OK = false; }
    unlock(rows);
    updateSyncBadge();
  } catch (ex) {
    document.getElementById("err").textContent =
      await loadFailureReason((ex && ex.message) || "")
        .catch(() => "Couldn't load the database — reload to retry.");
  }
}

const toggleBtn = document.getElementById("toggle-pw");
toggleBtn.addEventListener("click", () => {
  const pw = document.getElementById("pw");
  const showing = pw.type === "text";
  pw.type = showing ? "password" : "text";
  toggleBtn.setAttribute("aria-pressed", String(!showing));
  const label = showing ? "Show password" : "Hide password";
  toggleBtn.setAttribute("aria-label", label);
  toggleBtn.setAttribute("title", label);
  pw.focus();
});

document.getElementById("signout").addEventListener("click", () => {
  sbClearSession();
  SB_TOKEN = null;
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
/** THE LOADING MARK — the lynxr X split into its four arms, each scaling out of
 *  the centre in clockwise turn (`arm-in` in app.css). Mirrored in creator.js.
 *
 *  The arms meet at (12,9), (15,12), (12,15) and (9,12), leaving the diamond
 *  the real logo's evenodd rule carves where its two blades cross. That hole is
 *  the mark — never close it.
 */
function loaderMark() {
  return `<svg class="loader-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path class="arm a1" fill="currentColor" d="M3 3H6L12 9L9 12L3 6Z"/>
      <path class="arm a2" fill="currentColor" d="M21 3V6L15 12L12 9L18 3Z"/>
      <path class="arm a3" fill="currentColor" d="M15 12L21 18L18 21L12 15Z"/>
      <path class="arm a4" fill="currentColor" d="M12 15L6 21L3 18L9 12Z"/>
    </svg>`;
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

/* SATURATION — which formats are crowded, and which still have room.
 *
 * The premise of the agency is being early: a format is worth using while it
 * still beats the feed and before every other UGC shop is running it. That
 * needs two numbers per format, and neither is enough alone.
 *
 *   SATURATION  what share of the database uses this format. Crowded formats
 *               are ones the algorithm — and our competitors — have seen a lot
 *               of already.
 *   REACH       the MEDIAN views of videos using it. Median, not mean: one
 *               50-million-view outlier would otherwise promote a dead format.
 *
 * Why not the views-per-follower index alone, which looks like the smarter
 * metric? MEASURED on the live database: Skit scores 17.65 on index — third
 * best — on a median of 3,216 views. That is small accounts doing well for
 * their size, which is a real thing but not a reach opportunity. Index rewards
 * being small; this view is for finding formats that travel.
 *
 * HONEST LIMIT, and it is why the label says "of our database" rather than
 * "of the algorithm": saturation here is measured over what we scraped, and
 * what we scraped is a choice. A format nobody collects looks unsaturated
 * because it is unobserved. Treat it as a strong hint, not a fact.
 */
function renderSaturation(rows) {
  const host = document.getElementById("saturation");
  if (!host) return;
  const list = formatSaturation(rows);
  if (!list.length) { host.innerHTML = `<p class="note">Not enough tagged videos yet.</p>`; return; }

  host.innerHTML = list.map((o) => {
    const pct = o.share * 100;
    // Three bands, named rather than numbered — "31% of the database" is the
    // fact, "crowded" is the decision it implies.
    const band = pct >= 15 ? "hot" : pct >= 5 ? "warm" : "open";
    const word = band === "hot" ? "crowded" : band === "warm" ? "filling up" : "room to run";
    return `
      <div class="sat-row drill" data-val="${escapeHtml(o.name)}" role="button" tabindex="0"
           title="Show these videos in the database">
        <div class="sat-head">
          <span class="sat-name">${escapeHtml(o.name)}</span>
          <span class="sat-reach">${fmt(Math.round(o.reach))} median views</span>
        </div>
        <div class="sat-meter" aria-hidden="true"><i class="sat-fill sat-${band}"></i></div>
        <div class="sat-foot">
          <span class="sat-word sat-${band}-t">${word}</span>
          <span class="sat-share">${pct.toFixed(pct >= 10 ? 0 : 1)}% of our database · ${fmt(o.n)} videos</span>
        </div>
      </div>`;
  }).join("");

  // Widths via CSSOM — style="" attributes are dropped by the strict CSP, which
  // is exactly how the bar charts once shipped as invisible.
  // Scaled against a 35% ceiling rather than 100%: the most crowded format in
  // the database sits at ~31%, so a bar drawn against 100% would leave every
  // format looking equally empty and the meter would say nothing.
  const CEILING = 0.35;
  host.querySelectorAll(".sat-row").forEach((row, i) => {
    row.querySelector(".sat-fill").style.width =
      `${Math.min(100, (list[i].share / CEILING) * 100).toFixed(1)}%`;
  });

  // Clicking a format filters the table to it, same as the bar charts do.
  host.querySelectorAll(".sat-row").forEach((row) => {
    const go = () => {
      const sel = document.getElementById("f-format");
      if (sel) { sel.value = row.dataset.val; sel.dispatchEvent(new Event("change")); }
      document.getElementById("table-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

function formatSaturation(rows) {
  const num = (x) => { const n = Number(String(x ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
  const by = new Map();
  for (const r of rows) {
    const f = (r.format_type || "").trim();
    if (!f) continue;
    if (!by.has(f)) by.set(f, []);
    by.get(f).push(num(r.views));
  }
  const total = [...by.values()].reduce((a, v) => a + v.length, 0) || 1;
  const out = [];
  for (const [name, views] of by) {
    // Under ~20 videos a median is noise, and this view drives real decisions.
    if (views.length < 20) continue;
    out.push({ name, n: views.length, share: views.length / total, reach: median(views) });
  }
  // Rank by room-to-run: best reach among the least crowded. Normalising both
  // to the observed range keeps one axis from dominating on units alone.
  const maxReach = Math.max(...out.map((o) => o.reach), 1);
  const maxShare = Math.max(...out.map((o) => o.share), 0.0001);
  for (const o of out) o.score = (o.reach / maxReach) * (1 - o.share / maxShare);
  return out.sort((a, b) => b.score - a.score);
}

function renderBars(hostId, pairs, limit = 8, drillSelectId = null) {
  const host = document.getElementById(hostId);
  const shown = pairs.slice(0, limit);
  const max = shown.length ? shown[0][1] : 1;
  const total = pairs.reduce((a, [, n]) => a + n, 0) || 1;
  host.innerHTML = shown.map(([label, count]) => `
    <div class="bar-row${drillSelectId && !label.startsWith("(") ? " drill" : ""}" data-val="${escapeHtml(label)}"
         ${drillSelectId ? `role="button" tabindex="0" title="Show these videos in the database"` : ""}>
      <div class="bar-track">
        <div class="bar-fill"></div>
        <div class="bar-label">${escapeHtml(label)}</div>
      </div>
      <div class="bar-count"><span class="bar-n">${fmt(count)}</span> <span class="bar-pct">${(count / total * 100).toFixed(count / total >= 0.1 ? 0 : 1)}%</span></div>
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
    // Counts climb with their bars, on the same stagger.
    [...host.querySelectorAll(".bar-n")].forEach((el, i) =>
      setTimeout(() => animateCount(el, shown[i][1], (v) => fmt(Math.round(v)), 650), i * 45));
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

/** Count a number element up from 0 to its real value. The formatter runs on
    every frame so "10.2B" counts through "3.1B", "7.8B", … not raw digits.
    Ends on the exact formatted target even in hidden tabs (rAF stalls there). */
function animateCount(el, target, format, dur = 900) {
  const done = () => { el.textContent = format(target); };
  if (!isFinite(target) || matchMedia("(prefers-reduced-motion: reduce)").matches) return done();
  // Timer-driven, not rAF: rAF is starved in embedded/background contexts and
  // the counter would snap straight to the end. ~33fps is plenty for digits.
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const timer = setInterval(() => {
    const p = Math.min(1, (performance.now() - t0) / dur);
    el.textContent = format(target * ease(p));
    if (p >= 1) { clearInterval(timer); done(); }
  }, 30);
}

function renderStats(rows) {
  const totalViews = rows.reduce((a, r) => a + views(r), 0);
  const ers = rows.map((r) => parseFloat(r.engagement_rate)).filter((n) => !isNaN(n));
  const avgEr = ers.length ? ers.reduce((a, b) => a + b, 0) / ers.length : null;
  const creators = new Set(rows.map((r) => r.creator).filter(Boolean)).size;
  const cards = [
    ["Videos", rows.length, (v) => fmt(Math.round(v)), ""],
    ["Total views", totalViews, compact, fmt(totalViews)],
    ["Avg engagement", avgEr, avgEr === null ? () => "—" : (v) => v.toFixed(2) + "%", `${fmt(ers.length)} with data`],
    ["Creators", creators, (v) => fmt(Math.round(v)), ""],
  ];
  document.getElementById("stats").innerHTML = cards.map(([label, , , sub]) => `
    <div class="stat"><div class="label">${label}</div><div class="value"></div>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}</div>`).join("");
  document.querySelectorAll("#stats .value").forEach((el, i) =>
    animateCount(el, cards[i][1] ?? NaN, cards[i][2]));
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
  { key: "length_bucket", label: "Length" },
  { key: "cta_type", label: "CTA" },
  { key: "visual_hook", label: "Visual hook" },
  { key: "audio_trend", label: "Audio" },
  { key: "hook_delivery", label: "Delivery" },
  { key: "creator_followers", label: "Followers", num: true },
  { key: "saves", label: "Saves", num: true },
  { key: "save_ratio", label: "Save %", num: true, ratioPct: true },
  { key: "reach_confidence_tier", label: "Tier" },
  { key: "data_source", label: "Source" },
];
const FILTERS = [
  { id: "f-source", key: "data_source", label: "All sources" },
  { id: "f-platform", key: "platform", label: "All platforms" },
  { id: "f-format", key: "format_type", label: "All formats" },
  { id: "f-hook", key: "hook_pattern", label: "All hooks" },
  { id: "f-niche", key: "niche_category", label: "All niches" },
  { id: "f-length", key: "length_bucket", label: "All lengths" },
  { id: "f-cta", key: "cta_type", label: "All CTAs" },
  { id: "f-visual", key: "visual_hook", label: "All visual hooks" },
  { id: "f-audio", key: "audio_trend", label: "All audio" },
  { id: "f-tier", key: "reach_confidence_tier", label: "All tiers" },
];

let ALL = [];
let URL_INDEX = new Map();   // url -> row, for brief items that predate full ingestion
let view = [];
let page = 0;
let sortKey = "views";
let sortDir = -1;

function numOf(r, k) { const v = parseFloat(r[k]); return isNaN(v) ? -1 : v; }

function applyFilters() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const active = FILTERS.map((f) => [f.key, document.getElementById(f.id).value]);
  for (const f of FILTERS) {
    const sel = document.getElementById(f.id);
    sel.classList.toggle("active", !!sel.value);
  }
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
              if (c.ratioPct) return `<td class="num">${(v * 100).toFixed(1)}%</td>`;
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
            const dim = ["platform", "format_type", "hook_pattern", "niche_category", "target_audience",
                         "length_bucket", "cta_type", "visual_hook", "audio_trend", "hook_delivery", "data_source"].includes(c.key);
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
    let values = [...new Set(ALL.map((r) => r[f.key]).filter(Boolean))].sort();
    // Unbounded vocabularies (audio track names) would make the dropdown
    // unusable — only offer values with enough rows to be worth filtering on.
    if (values.length > 40) {
      const counts = new Map();
      for (const r of ALL) counts.set(r[f.key], (counts.get(r[f.key]) || 0) + 1);
      values = values.filter((v) => (counts.get(v) || 0) >= 10);
    }
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

/** Canonical key for "is this the same video?" across pasted variants —
    share links carry tracking queries, hosts vary (www./m.), YouTube has two
    URL shapes. Tracking params are dropped but YouTube's ?v= is the identity
    and is kept (youtu.be/ID becomes youtube.com/watch?v=ID). vm.tiktok.com
    short links are opaque redirects and can't be resolved client-side, so
    they stay their own key. */
function canonUrl(raw) {
  try {
    const s = String(raw || "").trim();
    const u = new URL(s.includes("://") ? s : "https://" + s);
    let host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
    let path = u.pathname.replace(/\/+$/, "");
    let key = "";
    if (host === "youtu.be") { key = "?v=" + path.slice(1); host = "youtube.com"; path = "/watch"; }
    else if (host === "youtube.com" && u.searchParams.get("v")) key = "?v=" + u.searchParams.get("v");
    return host + path + key;
  } catch { return String(raw || "").trim().replace(/\/$/, ""); }
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
// YouTube embed reliably; Instagram sometimes refuses without login,
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
  return null;   // instagram: no keyless thumbnail — placeholder card
}

// ---- Covers we host ourselves ----
// pipeline/fetch_covers.py already caches an opening frame per video, and
// upload_covers.py publishes them to the PUBLIC lynxr-covers bucket under the
// same key process_adaptations.py uses for creator covers:
//
//     sha1(canonUrl(url)).slice(0, 20) + ".jpg"
//
// This is the only cover source that works for INSTAGRAM — it publishes no
// keyless thumbnail endpoint and its CDN is not in img-src — and it saves the
// per-card oEmbed round-trip to tiktok.com for the rest.
// Lazy, not a top-level const: SB_URL is declared further down the file, so
// reading it here at evaluation time would hit the temporal dead zone and throw
// before the app ever boots.
const coverBase = () => SB_URL + "/storage/v1/object/public/lynxr-covers/";
const HOSTED_COVERS = new Map();   // canonical url -> cover url ("" = none)

async function coverKey(url) {
  const bytes = new TextEncoder().encode(canonUrl(url));
  const hash = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0"))
    .join("").slice(0, 20);
}

/** Point every waiting frame at its hosted cover, if one was published. */
function fillHostedCovers(rows) {
  for (const r of rows) {
    const url = String(r.url || "");
    if (!url || HOSTED_COVERS.has(url)) continue;
    HOSTED_COVERS.set(url, "");            // in-flight guard
    coverKey(url).then((key) => {
      const src = coverBase() + key + ".jpg";
      // Probe before swapping: a row whose cover was never uploaded would
      // otherwise replace a working TikTok/YouTube thumbnail with a broken one.
      const probe = new Image();
      probe.onload = () => {
        HOSTED_COVERS.set(url, src);
        document.querySelectorAll(`[data-url="${CSS.escape(url)}"]`).forEach((host) => {
          const slot = host.querySelector(".vthumb-pending, .vthumb-none");
          if (!slot) return;               // already has a real thumbnail
          const img = document.createElement("img");
          img.className = "vthumb";
          img.src = src;
          img.alt = "";
          img.loading = "lazy";
          slot.replaceWith(img);
        });
      };
      probe.src = src;
    }).catch(() => {});
  }
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
        // Any data-url host, not just .vframe — blueprint rows use .bp-thumb.
        document.querySelectorAll(`[data-url="${CSS.escape(url)}"] .vthumb-pending`)
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
  return null;
}

// ---------- Tailored scripts ----------
// Deterministic beat templates per format from the locked taxonomy, filled with
// the client's brand, features, and audience from the site analysis. Escaped at
// render time; the exporter escapes for XML separately.
/** The recreation blueprint: exactly what a creator needs to remake the
    video. Spoken words verbatim on the video's REAL timestamps (Whisper
    segments), each beat annotated with what's on screen at that moment
    (shot description + on-screen text, read from extracted frames). Silent
    videos get a shot-by-shot plan — their script IS the screen.
    Returns null when the row has no evidence (then the labeled template runs). */
function realScript(row) {
  const parse = (v) => { try { return JSON.parse(v || "[]"); } catch { return []; } };
  const segs = parse(row.transcript_segments);     // [[start, end, "words"], ...]
  const shots = parse(row.visual_cues);            // [{t, visual, onscreen_text}, ...]
  const raw = (row.transcript || "").trim();

  const shotAt = (a, b) => {
    // Best shot for a time window: prefer inside it, else the nearest.
    let best = null, bestD = Infinity;
    for (const s of shots) {
      const d = s.t >= a && s.t < b ? 0 : Math.min(Math.abs(s.t - a), Math.abs(s.t - b));
      if (d < bestD) { best = s; bestD = d; }
    }
    return bestD <= 4 ? best : null;
  };
  const screenNote = (s) => {
    if (!s) return "";
    const txt = (s.onscreen_text || "").trim();
    return `\n   ON SCREEN: ${s.visual}${txt ? ` — text: “${txt}”` : ""}`;
  };

  // Path 1 — spoken video with real timestamps: beats are the actual segments,
  // grouped to ~5 readable beats, each with its moment's visual.
  if (segs.length) {
    const total = segs[segs.length - 1][1] || 1;
    const target = Math.max(4, total / 5);
    const beats = [];
    let curStart = segs[0][0], curEnd = segs[0][1], curText = [];
    const flush = () => {
      if (!curText.length) return;
      beats.push(`[${Math.round(curStart)}–${Math.round(curEnd)}s] ${curText.join(" ")}`
        + screenNote(shotAt(curStart, curEnd)));
      curText = [];
    };
    for (const [s, e, text] of segs) {
      if (curText.length && (e - curStart) > target) { flush(); curStart = s; }
      curEnd = e;
      curText.push(text.trim());
    }
    flush();
    return {
      heading: `${row.format_type || "Format"} — full recreation blueprint (verbatim words + what's on screen)`,
      hook: (row.hook_spoken || segs[0][2] || "").trim(),
      beats,
      cta: "",
      real: true,
    };
  }

  // Path 2 — silent video with a shot list: the screen IS the script.
  if (shots.length) {
    const beats = shots.map((s) => {
      const txt = (s.onscreen_text || "").trim();
      return `[${Math.round(s.t)}s] ${s.visual}${txt ? ` — on-screen text: “${txt}”` : ""}`;
    });
    const firstTxt = shots.map((s) => (s.onscreen_text || "").trim()).find(Boolean);
    return {
      heading: `${row.format_type || "Format"} — shot-by-shot plan (no speech; the screen carries it)`,
      hook: firstTxt || shots[0].visual,
      beats,
      cta: "",
      real: true,
    };
  }

  // Path 3 — transcript text only (no timestamps yet): estimated beat timing.
  if (raw.length < 40) return null;
  const sents = (raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [raw]).map((s) => s.trim()).filter(Boolean);
  const mid = { "0–10s": 8, "11–20s": 16, "21–34s": 27, "35–59s": 45, "60s+": 70 }[row.length_bucket];
  const secs = mid || Math.max(8, Math.round(raw.split(/\s+/).length / 2.5));
  const nBeats = Math.min(4, sents.length);
  const perBeat = Math.ceil(sents.length / nBeats);
  const totalChars = raw.length || 1;
  const beats = [];
  let t = 0;
  for (let i = 0; i < sents.length; i += perBeat) {
    const group = sents.slice(i, i + perBeat);
    const span = Math.max(1, Math.round((group.join(" ").length / totalChars) * secs));
    beats.push(`[${t}–${Math.min(t + span, secs)}s] ${group.join(" ")}` + screenNote(shotAt(t, t + span)));
    t += span;
  }
  return {
    heading: `${row.format_type || "Format"} — the video's exact script (verbatim)`,
    hook: (row.hook_spoken || sents[0] || "").trim(),
    beats,
    cta: "",
    real: true,
  };
}

function tailoredScript(row, ctx, slot) {
  // Self-heal: an item saved before its video was fully ingested upgrades to
  // the database row (real transcript, tags, shots) the moment it exists.
  if (row && !row.transcript && row.url) {
    const full = URL_INDEX.get(canonUrl(row.url));
    if (full && full.transcript) row = { ...row, ...full };
  }
  const real = realScript(row);
  if (real) return real;
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
    heading: `${fmtName} × ${row.hook_pattern || "Other"} — pattern template (no transcript yet)`,
    hook,
    beats: beats[fmtName] || fallback,
    cta: `[last 3s] CTA: ${ctas[slot % ctas.length]}`,
  };
}

/** Pull the real spoken words for a set of rows from Supabase and attach them
    in place. Rows picked into a brief keep the fields, so saved briefs carry
    the real scripts. Fails silently (template fallback) if the columns don't
    exist yet or the query errors. */
async function enrichTranscripts(rows) {
  const need = rows.filter((r) => r.transcript === undefined && !r._client && r.video_id);
  if (!need.length) return;
  const ids = [...new Set(need.map((r) => `"${String(r.video_id).replace(/"/g, "")}"`))];
  // If the full select fails (a column not migrated yet), retry with ever
  // smaller column sets — partial evidence beats template fallback.
  const selects = [
    "platform,video_id,hook_spoken,transcript,transcript_segments,visual_cues",
    "platform,video_id,hook_spoken,transcript",
    "platform,video_id",
  ];
  let got = [];
  for (const sel of selects) {
    try {
      got = await sbFetch(`/rest/v1/lynxr_videos?select=${sel}&video_id=in.(${ids.join(",")})`);
      break;
    } catch { /* try the next, smaller select */ }
  }
  const byKey = new Map(got.map((g) => [`${g.platform}|${g.video_id}`, g]));
  for (const r of rows) {
    const g = byKey.get(`${r.platform}|${r.video_id}`);
    r.hook_spoken = g?.hook_spoken || "";
    r.transcript = g?.transcript || "";
    r.transcript_segments = g?.transcript_segments || "";
    r.visual_cues = g?.visual_cues || "";
  }
}


// ---------- Target-demographic scoring ----------

/** How well a video speaks to the client's target avatar. Two signals:
    the structured audience tag (exact match boosted, clearly-other demoted)
    and keyword overlap between the avatar description and the caption. Small
    multipliers — the avatar tilts the ranking, it doesn't replace it. */
const AVATAR_STOP = new Set(("the,a,an,and,or,of,to,in,on,for,with,who,that,they,their,them,is,are,was,be," +
  "between,into,who,what,when,really,very,just,like,about,from,this,these,those,her,his,she,he").split(","));
function avatarWords(text) {
  return [...new Set(((text || "").toLowerCase().match(/[a-z][a-z-]{3,}/g) || []))]
    .filter((w) => !AVATAR_STOP.has(w)).slice(0, 24);
}
function avatarBoost(r, ctx) {
  let b = 1;
  if (ctx?.audience && r.target_audience) {
    if (r.target_audience === ctx.audience) b *= 1.15;
    else if (r.target_audience !== "Other") b *= 0.94;
  }
  const words = ctx?._avatarWords;
  if (words?.length) {
    const hay = (r.title || "").toLowerCase();
    let hits = 0;
    for (const w of words) if (hay.includes(w)) hits++;
    b *= 1 + Math.min(0.25, hits * 0.05);
  }
  return b;
}

// ---------- Client-matched video suggestions ----------
// The shelf ranks FORMATS (buildShelf groups by format × hook and ranks the
// combo). This ranks VIDEOS, because a format's aggregate hides its own
// winners: Talking Head is the worst format by median reach in this corpus and
// still supplies the most individual overperformers.
//
// The obvious score is `views / avg_views_of_similar` — the column the pipeline
// already ships. Measured on the master CSV it has two defects that make it
// wrong to use raw:
//
//  1. Its group key is (niche, format, hook) with NO platform, so it compares a
//     YouTube Short against viral TikToks. Median score by platform: tiktok
//     0.204, instagram 0.110, youtube 0.012 — a 17× handicap that removed
//     YouTube from the top 200 entirely (0 rows).
//  2. It is a MEAN, so one 10M-view clip in a pocket makes every other member
//     look like a failure. Corpus median score was 0.128 — i.e. "the typical
//     video loses to its own pocket by 8×", which is an artefact, not a fact.
//
// So the denominator is rebuilt here: same grouping PLUS platform, and a MEDIAN
// over measured rows only — the same guard renderShelf's srcMedian uses. That
// puts the corpus median back at 1.00 and 50.5% of videos above their pocket,
// which is what "beat the typical video like you" should mean.
const POCKET_MIN = 12;      // members before a pocket's median is worth trusting
const OUTLIER_PCT = 0.97;   // top 3% of beaters are lottery wins, not plays
const SUGGEST_CAP = 2;      // per format × hook, so one pocket can't fill the list
let POCKETS = null;         // Map(pocketKey -> median views), memoized against ALL
let POCKETS_FOR = null;

// ---- What counts as organic UGC you could actually remake ----
// The shelf was surfacing 11–23M-view runway reposts and meme aggregators.
// Those top every performance sort and are worthless as a brief: there is no
// script to tweak and no creator to imitate. Three gates fix it, measured on
// the master CSV:
//
//  · FORMAT. "Meme / Trend Clip" (1,724 rows) is the repost bucket and
//    "Reaction / Duet" is commentary on someone else's video. Neither is a
//    thing you write a script for. Everything else in the taxonomy is.
//  · CREATOR SIZE. `creator_followers` fills 70% of rows: median 8,157,
//    p90 74,100, max 3.2M. A 3M-follower media brand pulling 11M views is not
//    reproducible by a UGC creator; an 8K-follower account pulling 200K is
//    exactly the thing to copy. Unknown followers are KEPT — dropping the 30%
//    blind rows costs more than it buys.
//  · VIEW CEILING. Corpus p95 is 2.5M and p99 is 9.6M, so the tail is where
//    the lottery winners live. Each niche's own p95 is the cut.
const SCRIPTABLE_FORMATS = new Set([
  "Talking Head", "Listicle", "Story Time", "Screen Demo",
  "Voiceover B-roll", "POV", "Skit", "Green Screen",
]);
const MEGA_FOLLOWERS = 500000;
const VIEW_CEILING_PCT = 0.95;
// Median similar_format_count across the corpus — the pivot for "is this
// pocket more or less crowded than typical".
const SAT_PIVOT = 41;

const pocketKey = (r) =>
  [r.niche_category, r.format_type, r.hook_pattern, r.platform].join("|");

/** Median views per (niche × format × hook × platform), over measured rows. */
function buildPockets(rows) {
  if (POCKETS && POCKETS_FOR === rows) return POCKETS;
  const groups = new Map();
  for (const r of rows) {
    // 0 views means "the platform never told us" far more often than "nobody
    // watched" — yt-dlp returns no count for Instagram Reels at all. Averaging
    // those in collapses a pocket to 0 and every measured member then scores as
    // its raw view count. Same trap renderShelf documents.
    if (views(r) <= 0) continue;
    if (!r.niche_category || !r.format_type || !r.hook_pattern || !r.platform) continue;
    const k = pocketKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(views(r));
  }
  POCKETS = new Map();
  for (const [k, vs] of groups) {
    if (vs.length < POCKET_MIN) continue;
    const m = median(vs);
    if (m > 0) POCKETS.set(k, { med: m, n: vs.length });
  }
  POCKETS_FOR = rows;
  return POCKETS;
}

/** How far this ONE video beat the typical video in its own pocket. */
function videoEdge(r) {
  const p = buildPockets(ALL).get(pocketKey(r));
  if (!p || views(r) <= 0) return null;
  return { x: views(r) / p.med, med: p.med, n: p.n };
}

/** Per-video picks for a client: videos in their niche that beat their own
    pocket, tilted by the client's target audience and avatar, minus anything
    they have already been briefed. */
// suggestionsBoxHtml builds the cards and bindSuggestions re-derives the same
// rows to wire them up, so an unmemoized call scores the whole corpus twice on
// every client-page render. Keyed on everything that can change the answer.
let SUGGEST_CACHE = null;

function clientSuggestions(client, count = 8) {
  const cacheKey = [client.id, client.niche, client.briefs?.length,
                    client.ctx?.audience, client.ctx?.avatar, count].join(" ");
  if (SUGGEST_CACHE && SUGGEST_CACHE.key === cacheKey && SUGGEST_CACHE.rows === ALL)
    return SUGGEST_CACHE.val;

  const niche = client.niche || "";
  let pool = niche ? ALL.filter((r) => r.niche_category === niche) : ALL;
  let widened = false;
  if (niche && pool.length < MIN_N_NICHE) { pool = ALL; widened = true; }

  // Never re-suggest a video this client has already been given.
  const briefed = new Set();
  for (const b of client.briefs || []) for (const it of b.items || []) briefed.add(rowKey(it));

  // Shallow copy: avatarBoost caches its keyword list on the ctx, and the
  // client record is persisted — don't write scratch state into it.
  const ctx = { ...(client.ctx || {}) };
  ctx._avatarWords = avatarWords(ctx.avatar);

  // This niche's own view ceiling — above it you are looking at a lottery win,
  // not a play. Taken per-niche because Health & Medical tops out around 280K
  // while Fashion & Beauty runs to 3.5M; one global number would gut the first
  // and let the second through.
  const poolViews = pool.map(views).filter((v) => v > 0).sort((a, b) => a - b);
  const viewCeiling = poolViews.length
    ? poolViews[Math.floor(poolViews.length * VIEW_CEILING_PCT)] : Infinity;

  // Least saturated wins ties: a pocket with fewer entrants has more room left.
  // sqrt so a pocket 4× more crowded is penalised 2×, not 4× — crowding is a
  // tilt on the ranking, not a veto.
  const satBoost = (r) => {
    const n = parseFloat(r.similar_format_count);
    if (!n || n <= 0) return 1;
    return Math.max(0.65, Math.min(1.5, Math.sqrt(SAT_PIVOT / n)));
  };

  // Count WHY rows drop out, so an empty section can say which wall it hit
  // instead of rendering nothing and looking broken.
  let playable = 0, pocketed = 0, seenBefore = 0, notUgc = 0;
  const scored = [];
  for (const r of pool) {
    if (briefed.has(rowKey(r))) { seenBefore++; continue; }
    if (!embedFor(r)) continue;              // must be playable in the page
    playable++;
    // Organic-UGC gates — see SCRIPTABLE_FORMATS above for the measurements.
    const followers = parseFloat(r.creator_followers);
    if (!SCRIPTABLE_FORMATS.has(r.format_type)
        || (followers && followers > MEGA_FOLLOWERS)
        || views(r) > viewCeiling) { notUgc++; continue; }
    const edge = videoEdge(r);
    if (!edge) continue;                     // its pocket is too thin to judge
    pocketed++;
    if (edge.x < 1) continue;                // must beat the typical video like it
    scored.push({ row: r, edge, score: edge.x * satBoost(r) * avatarBoost(r, ctx) });
  }
  const stats = { widened, pool: pool.length, playable, pocketed, seenBefore,
                  notUgc, beat: scored.length };
  const memo = (val) => { SUGGEST_CACHE = { key: cacheKey, rows: ALL, val }; return val; };
  if (!scored.length) return memo({ picks: [], ...stats });

  // Belt and braces on top of the view ceiling: within what survived, drop the
  // top 3% by edge. The ceiling catches absolute outliers, this catches a video
  // that beat a very small pocket by an implausible multiple.
  const cut = [...scored].sort((a, b) => a.edge.x - b.edge.x)
    [Math.floor(scored.length * OUTLIER_PCT)]?.edge.x ?? Infinity;

  const picks = [];
  const perCombo = new Map();
  for (const s of scored.filter((s) => s.edge.x <= cut).sort((a, b) => b.score - a.score)) {
    const k = `${s.row.format_type}×${s.row.hook_pattern}`;
    if ((perCombo.get(k) || 0) >= SUGGEST_CAP) continue;
    perCombo.set(k, (perCombo.get(k) || 0) + 1);
    picks.push(s);
    if (picks.length >= count) break;
  }
  return memo({ picks, ...stats, cut });
}

// ---------- Brief cart ----------
const CART_LIMIT = 10;
let CART = new Map();        // rowKey -> row

const rowKey = (r) => (r.platform || "") + "|" + (r.video_id || r.url || r.title);

function buildShelf(pool, relative, count = 24) {
  // Trend-first ranking: a video earns its slot because its format × hook
  // combo performs REPEATEDLY, not because it alone blew up. Combos need
  // MIN_COMBO tagged videos; they're ranked by the median index of their
  // members (robust to one lucky outlier). From each combo we surface the
  // upper-middle band — the videos that show the trend is reproducible —
  // and explicitly skip the single biggest outlier in large combos.
  const MIN_COMBO = 4;
  const byCombo = new Map();
  for (const r of pool) {
    if (!embedFor(r)) continue;
    if (!r.format_type || !r.hook_pattern) continue;
    const k = `${r.format_type}×${r.hook_pattern}`;
    if (!byCombo.has(k)) byCombo.set(k, []);
    byCombo.get(k).push(r);
  }
  const combos = [...byCombo.entries()]
    .filter(([, list]) => list.length >= MIN_COMBO)
    .map(([, list]) => {
      list.sort((a, b) => relative(a) - relative(b));           // ascending
      return { list, med: relative(list[Math.floor(list.length / 2)]) };
    })
    .sort((a, b) => b.med - a.med);

  // Per-combo queue: from the median up, best-first, minus the top outlier
  // when the combo is big enough to afford dropping it. Cap 3 per combo so
  // one strong combo can't fill the shelf.
  const queues = combos.map(({ list }) => {
    const lo = Math.floor(list.length / 2);
    const hi = list.length >= 8 ? list.length - 1 : list.length;
    return list.slice(lo, hi).reverse().slice(0, 3);
  });

  const seen = new Set();
  const shelf = [];
  let added = true;
  while (shelf.length < count && added) {
    added = false;
    for (const q of queues) {
      if (q.length && shelf.length < count) {
        const r = q.shift();
        if (!seen.has(rowKey(r))) { shelf.push(r); seen.add(rowKey(r)); }
        added = true;
      }
    }
  }

  // Small or thinly-tagged pools may not fill from combos — top up with the
  // best remaining individuals so the shelf is never short.
  if (shelf.length < count) {
    const rest = pool.filter((r) => embedFor(r) && !seen.has(rowKey(r)))
      .sort((a, b) => relative(b) - relative(a));
    for (const r of rest) {
      if (shelf.length >= count) break;
      shelf.push(r); seen.add(rowKey(r));
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
      ${s.cta ? `<p class="vs-beat vs-cta">${escapeHtml(s.cta)}</p>` : ""}
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
    const txt = card.querySelector(".vpick-txt");
    if (txt) txt.textContent = on ? "Added" : "Add";
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

async function renderShelf(niche) {
  const body = document.getElementById("brief-body");
  let pool = niche ? ALL.filter((r) => r.niche_category === niche) : ALL;
  const notes = [];
  if (niche && pool.length < MIN_N_NICHE) {
    notes.push(`Only ${pool.length} videos tagged <strong>${escapeHtml(niche)}</strong> — too few to rank
      reliably, so the shelf draws from the whole database instead. Treat it as directional.`);
    pool = ALL;
  }

  // Comparison group = source × platform: a scraped IG reel is scored against
  // scraped IG reels, not against viral TikToks or UGC campaign posts.
  const srcKey = (r) => (r.data_source || "?") + "|" + (r.platform || "?");
  const bySource = new Map();
  for (const r of pool) {
    // 0 views almost always means "the platform never told us", not "nobody
    // watched it" — yt-dlp returns no view count for Instagram Reels at all, so
    // every creator-submitted Reel lands as 0. Averaging those zeros in
    // collapses the group's median to 0, the `|| 1` fallback below takes over,
    // and any row in that group that DOES carry real views is then scored as
    // its RAW view count: one Reel indexes at ~80,000 while every correctly
    // normalised row sits near 1.00, and it owns the entire shelf. So the
    // median is taken over measured rows only. Unmeasured rows still score 0
    // and rank last, which is the honest answer for "we don't know".
    if (views(r) <= 0) continue;
    const s = srcKey(r);
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(views(r));
  }
  const srcMedian = new Map([...bySource].map(([s, vs]) => [s, median(vs) || 1]));
  const relative = (r) => views(r) / (srcMedian.get(srcKey(r)) || 1);
  // Avatar-aware scoring: performance index × how directly the video speaks
  // to the client's declared target person.
  BRIEF_CTX && (BRIEF_CTX._avatarWords = avatarWords(BRIEF_CTX.avatar));
  const scored = (r) => relative(r) * avatarBoost(r, BRIEF_CTX);
  if (BRIEF_CTX?.avatar || BRIEF_CTX?.audience) {
    notes.push(`Ranking is tilted toward the target avatar${BRIEF_CTX.audience ? ` (<strong>${escapeHtml(BRIEF_CTX.audience)}</strong> tag boosted)` : ""}${BRIEF_CTX._avatarWords?.length ? ` and captions matching: <em>${escapeHtml(BRIEF_CTX._avatarWords.slice(0, 8).join(", "))}</em>` : ""}.`);
  }
  const shelf = buildShelf(pool, scored, 24);

  // Fetch the shelf's real spoken scripts so every card's tailored script can
  // adapt the video's own words rather than fall back to a format template.
  await enrichTranscripts(shelf);
  notes.push("Ranked by repeatable trends: format × hook combos proven across multiple videos "
    + "(median index, one-off viral outliers excluded) — not single lucky uploads.");

  const { plays } = buildPlays(pool);

  body.innerHTML =
    notes.map((n) => `<div class="warn">${n}</div>`).join("") +
    `<div class="add-video">
      <form class="post-form" id="av-form">
        <input type="url" id="av-url" placeholder="Add a specific video by link — it joins this brief now, full data follows"
          autocomplete="off" spellcheck="false">
        <button type="submit" class="btn" id="av-add">Add video</button>
      </form>
      <p class="note" id="av-note">Not in the database yet? Paste any TikTok / Instagram / YouTube link. It's added
        to this brief immediately with what the platform reveals, queued for full ingestion (real metrics, tags,
        verbatim script) on the next pipeline run — the brief upgrades itself when that lands.</p>
    </div>
    <div class="tray" id="tray"></div>
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
            ${/^Tier [123]$/.test(r.reach_confidence_tier || "") ? `<span class="tier-chip t${r.reach_confidence_tier.slice(-1)}"
              title="Reach confidence: ${escapeHtml(r.reach_confidence_tier)} — this format×hook combo repeats across ${escapeHtml(r.similar_format_count || "?")} videos averaging ${compact(+r.avg_views_of_similar || 0)} views">${escapeHtml(r.reach_confidence_tier)}</span>` : ""}
            <button type="button" class="vdetails" data-key="${escapeHtml(k)}">Details</button>
            <label class="vpick"><input type="checkbox" class="vcheck" ${checked ? "checked" : ""}><span class="vpick-txt">${checked ? "Added" : "Add"}</span></label>
          </div>
        </div>
      </article>`;
    }).join("") + `</div>` +
    `<details class="playbook"><summary>The scoreboard behind this shelf — top format × hook plays</summary>
      <div id="plays-host"></div></details>`;

  // scoreboard inside the details
  renderPlaysInto(document.getElementById("plays-host"), plays, niche, pool);

  SHELF_CTX = { index: new Map(shelf.map((r) => [rowKey(r), r])), relative };

  // Add-by-link: a video not in the database joins the brief NOW with what
  // the platform reveals client-side, and is queued for full pipeline
  // ingestion (metrics, tags, verbatim script). Briefs self-heal once the
  // ingested row exists — see tailoredScript's URL lookup.
  const avForm = document.getElementById("av-form");
  if (avForm) avForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = normalizeClientUrl(document.getElementById("av-url").value);
    const note = document.getElementById("av-note");
    const btn = document.getElementById("av-add");
    if (!url) { note.textContent = "That doesn't look like a video link."; return; }
    const clean = canonUrl;
    let row = [...SHELF_CTX.index.values()].find((r) => r.url && clean(r.url) === clean(url))
      || ALL.find((r) => r.url && clean(r.url) === clean(url));
    const existed = !!row;
    btn.disabled = true; btn.textContent = "Reading…";
    if (!row) {
      let meta = { caption: "", creator: "", platform: "" };
      try { meta = await fetchPostMeta(url); } catch {}
      row = { video_id: "", url, title: meta.caption || url, creator: meta.creator || "",
              platform: (meta.platform || "").toLowerCase(), views: "", likes: "", comments: "",
              engagement_rate: "", format_type: "", hook_pattern: "",
              niche_category: niche || "", target_audience: "",
              data_source: "Scraped", source_type: "hand_picked", _pending: true };
      queueVideoIngest(url, row.niche_category).catch(() => {});
    }
    const k = rowKey(row);
    SHELF_CTX.index.set(k, row);
    const ok = setPicked(k, true);
    note.textContent = !ok ? "Brief is full — uncheck something first."
      : existed ? "Already in the database — added to the brief with full data."
      : "Added to the brief · queued for full ingestion (real metrics, tags, and the verbatim script land on the next pipeline run).";
    const shelfEl = body.querySelector(".shelf");
    if (ok && shelfEl && !body.querySelector(`.vcard[data-key="${CSS.escape(k)}"]`)) {
      const card = document.createElement("article");
      card.className = "vcard picked";
      card.dataset.key = k;
      card.innerHTML = `<div class="vmeta"><div class="vtitle">${escapeHtml(row.title || url)}</div>
        <div class="vrow"><span class="vstat">${row._pending ? "awaiting ingest" : compact(views(row)) + " views"}</span>
        <label class="vpick"><input type="checkbox" class="vcheck" checked><span class="vpick-txt">Added</span></label></div></div>`;
      shelfEl.prepend(card);
      card.querySelector(".vcheck").addEventListener("change", (ev) => setPicked(k, ev.target.checked));
    }
    btn.disabled = false; btn.textContent = "Add video";
    document.getElementById("av-url").value = "";
  });

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

// ---------- Supabase: shared workspace for the team ----------
// Two people, one set of clients. localStorage is per-browser, so a client
// saved on one machine was invisible on the other; this syncs through Postgres
// instead. The publishable key below is public by design — the repo is public
// too — which is only safe because row-level security grants access to signed-in
// users exclusively (see supabase/schema.sql). Anonymous readers get nothing.
const SB_URL = "https://esakjfogplfszievvabi.supabase.co";
const SB_KEY = "sb_publishable_pTFNX2B94PE_DFLL799w4A_4VcH2xTN";
const SB_SESSION_KEY = "lynxr_sb_session";

let SB_TOKEN = null;      // access token for the signed-in user
let SB_EMAIL = null;
let SYNC_OK = false;      // false => running local-only, and the UI says so

function sbSaveSession(sess) {
  try { localStorage.setItem(SB_SESSION_KEY, JSON.stringify(sess)); } catch {}
}
function sbLoadSession() {
  try { return JSON.parse(localStorage.getItem(SB_SESSION_KEY)); } catch { return null; }
}
function sbClearSession() {
  try { localStorage.removeItem(SB_SESSION_KEY); } catch {}
}

// One shared in-flight refresh: parallel 401s must not each burn the (single
// use) refresh token — the second refresh would fail and sign everyone out.
let SB_REFRESHING = null;

async function sbFetch(path, opts = {}) {
  // onResponse lets a caller read response HEADERS (sbFetchVideos needs
  // Content-Range for the row count). Pulled out of the init object so it is
  // never handed to fetch().
  const { onResponse, ...init } = opts;
  const attempt = () => fetch(SB_URL + path, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_TOKEN || SB_KEY}`,   // re-read on every try
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  let res = await attempt();
  // Access tokens expire after an hour. Mid-session that made every write 401
  // and the badge fell to "local only" — refresh once and retry instead.
  if (res.status === 401 && sbLoadSession()?.refresh_token) {
    try {
      SB_REFRESHING = SB_REFRESHING
        || sbRefresh(sbLoadSession().refresh_token).finally(() => { SB_REFRESHING = null; });
      await SB_REFRESHING;
      res = await attempt();
    } catch { /* refresh failed — fall through to the normal error */ }
  }
  if (onResponse) onResponse(res);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  // Writes come back 200/201 with an EMPTY body (PostgREST only returns rows
  // when asked via Prefer: return=representation). res.json() on empty threw,
  // which made every successful save look like a sync failure.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Sign in with email + password. Returns the session or throws. */
async function sbSignIn(email, password) {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error_description || body.msg || "Sign-in failed");
  }
  const sess = await res.json();
  SB_TOKEN = sess.access_token;
  SB_EMAIL = sess.user?.email || email;
  sbSaveSession(sess);
  return sess;
}

/** Refresh an expired token so a returning session does not force a re-login. */
async function sbRefresh(refresh_token) {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token }),
  });
  if (!res.ok) throw new Error("refresh failed");
  const sess = await res.json();
  SB_TOKEN = sess.access_token;
  SB_EMAIL = sess.user?.email || SB_EMAIL;
  sbSaveSession(sess);
  return sess;
}

/** The full video database, RLS-gated to signed-in users. PostgREST caps a
    response at 1,000 rows and the table holds ~2,640, so page with Range
    headers until a short page arrives. Field names and types mirror the old
    data.enc JSON exactly (engagement_rate stays a string on purpose). */
async function sbFetchVideos() {
  const BASE = "video_id,creator,platform,title,views,likes,comments,engagement_rate,"
    + "format_type,hook_pattern,niche_category,target_audience,data_source,url,"
    + "length_bucket,audio_trend,cta_type,visual_hook,hook_delivery";
  // Signal columns land in Supabase after the code ships — probe once and
  // fall back to the base list so a lagging migration can't blank the site.
  // views_to_followers is deliberately NOT fetched: nothing reads it (the other
  // signal columns all surface in the database table), and it cost ~29 KB
  // gzipped on every cold load. Re-add it here if a view ever needs it.
  const SIGNALS = ",creator_followers,saves,save_ratio,"
    + "reach_confidence_tier,similar_format_count,avg_views_of_similar";
  const PAGE = 1000;

  // One page fetch. `wantCount` asks PostgREST for the exact row total, which
  // comes back on Content-Range as "0-999/9016".
  const page = (fields, from, wantCount) => {
    let total = null;
    return sbFetch(
      `/rest/v1/lynxr_videos?select=${fields}&order=platform.asc,video_id.asc`,
      {
        headers: {
          "Range-Unit": "items", Range: `${from}-${from + PAGE - 1}`,
          ...(wantCount ? { Prefer: "count=exact" } : {}),
        },
        onResponse: (res) => {
          const n = (res.headers.get("Content-Range") || "").split("/")[1];
          if (n && n !== "*") total = Number(n);
        },
      }).then((batch) => ({ batch: batch || [], total }));
  };

  // The first request does three jobs at once: it proves the signal columns
  // exist (they land in Supabase after the code ships, and a lagging migration
  // must not blank the site), fetches page one, and reports the row total.
  // That total is what lets every REMAINING page be asked for concurrently —
  // ~9,000 rows used to arrive over 10 strictly sequential round-trips plus a
  // throwaway probe, and the browser sat on a loader for all of them.
  let FIELDS = BASE + SIGNALS;
  let first;
  try {
    first = await page(FIELDS, 0, true);
  } catch {
    FIELDS = BASE;
    first = await page(FIELDS, 0, true);
  }
  const rows = [...first.batch];

  if (first.total != null) {
    const starts = [];
    for (let from = PAGE; from < first.total; from += PAGE) starts.push(from);
    // Promise.all preserves order, so rows land in exactly the sequence the
    // old sequential walk produced.
    const rest = await Promise.all(starts.map((from) => page(FIELDS, from, false)));
    for (const r of rest) rows.push(...r.batch);
  } else if (first.batch.length === PAGE) {
    // No usable count header — walk sequentially rather than guess.
    for (let from = PAGE; ; from += PAGE) {
      let batch;
      try { batch = (await page(FIELDS, from, false)).batch; }
      catch (ex) {
        // 416 = asked past the last row (count was an exact multiple of PAGE).
        if (String(ex.message).startsWith("416")) break;
        throw ex;
      }
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
  }
  if (!rows.length) throw new Error("videos table is empty");
  return rows;
}

// ---------- Client sync ----------
// Per-client rows, so edits to different clients never collide. Same-client
// edits resolve by whichever was written last, which is right for two people.
// A reserved lynxr_clients row that is NOT a client: the video-ingest queue.
// The site appends URLs the owner wants in the database; the local pipeline
// (daily task or an interactive session) scrapes, tags, and scripts them.
const INGEST_QUEUE_ID = "ingest-queue";

async function sbPullClients() {
  const rows = await sbFetch("/rest/v1/lynxr_clients?select=id,data,updated_at");
  return rows.filter((r) => r.id !== INGEST_QUEUE_ID && r.id !== TOMBSTONE_ROW_ID)
    .map((r) => ({ ...r.data, id: r.id, _remote_updated: r.updated_at }));
}

/** Queue a video URL for full pipeline ingestion (scrape → tag → script). */
async function queueVideoIngest(url, niche) {
  let queue = { urls: [] };
  try {
    const rows = await sbFetch(`/rest/v1/lynxr_clients?id=eq.${INGEST_QUEUE_ID}&select=data`);
    if (rows[0]?.data?.urls) queue = rows[0].data;
  } catch {}
  if (!queue.urls.some((u) => canonUrl(u.url) === canonUrl(url)))
    queue.urls.push({ url, niche: niche || "", requestedAt: new Date().toISOString() });
  await sbFetch("/rest/v1/lynxr_clients", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: INGEST_QUEUE_ID, data: queue, updated_by: SB_EMAIL || "" }),
  });
}

/** Blueprints are link-only, so nothing is uploaded from the browser. This
    stays for cleanup of any legacy entry that still carries a storage path. */
async function sbDeleteFile(bucket, path) {
  await sbFetch(`/storage/v1/object/${bucket}/${path}`, { method: "DELETE" });
}

async function sbPushClient(client) {
  await sbFetch("/rest/v1/lynxr_clients", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: client.id, data: client, updated_by: SB_EMAIL || "" }),
  });
}

// A second reserved row: team-wide deletion tombstones. Local tombstones only
// protect the device that deleted; every OTHER account's cache would happily
// re-push the dead client. The shared set keeps an id dead for the whole team.
const TOMBSTONE_ROW_ID = "deleted-clients";

async function sbSharedTombstones() {
  const rows = await sbFetch(`/rest/v1/lynxr_clients?id=eq.${TOMBSTONE_ROW_ID}&select=data`);
  return new Set(rows[0]?.data?.ids || []);
}

async function pushSharedTombstones(ids) {
  const remote = await sbSharedTombstones().catch(() => new Set());
  const union = new Set([...remote, ...ids]);
  if (union.size === remote.size) return;   // nothing new to record
  await sbFetch("/rest/v1/lynxr_clients", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: TOMBSTONE_ROW_ID, data: { ids: [...union] }, updated_by: SB_EMAIL || "" }),
  });
}

async function sbDeleteClient(id) {
  await sbFetch(`/rest/v1/lynxr_clients?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Deleted-client tombstones: sync would otherwise resurrect any client whose
    remote row outlives the local delete (offline delete, failed request, or a
    delete issued before the first persist seeded the diff tracker). A
    tombstone keeps the id dead until the remote row is confirmed gone. */
const TOMBSTONES_KEY = "lynxr_deleted_clients";
const loadTombstones = () => {
  try { return new Set(JSON.parse(localStorage.getItem(TOMBSTONES_KEY)) || []); }
  catch { return new Set(); }
};
const saveTombstones = (set) => {
  try { localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([...set])); } catch {}
};

/** The one true way to delete a client: local removal + tombstone + an
    immediate, explicit remote delete (not the persist diff, which only knows
    ids seen since page load). */
function deleteClient(id) {
  const t = loadTombstones();
  t.add(id);
  saveTombstones(t);
  persistClients(loadClients().filter((c) => c.id !== id));
  sbDeleteClient(id).catch(() => {});          // tombstone re-tries on next sync
  pushSharedTombstones([id]).catch(() => {});  // and the whole team honors it
}

/** Merge local and remote, push anything the server has not seen, and adopt
    the result locally. Runs once at startup so a machine that worked offline
    contributes rather than being overwritten. */
async function syncClients() {
  if (!SB_TOKEN) return;
  const remote = await sbPullClients();
  const local = loadClientsLocal();
  // Honor deletions first, TEAM-wide: adopt the shared tombstone set (so a
  // delete on any account sticks on every account), contribute our local
  // tombstones to it, and re-issue the remote delete while the row survives.
  const tombs = loadTombstones();
  try {
    const shared = await sbSharedTombstones();
    if ([...tombs].some((id) => !shared.has(id))) pushSharedTombstones(tombs).catch(() => {});
    for (const id of shared) tombs.add(id);
    saveTombstones(tombs);
  } catch { /* offline — local tombstones still hold on this device */ }
  if (tombs.size) {
    for (const c of remote) {
      if (tombs.has(c.id)) sbDeleteClient(c.id).catch(() => {});
    }
  }
  const byId = new Map(remote.filter((c) => !tombs.has(c.id)).map((c) => [c.id, c]));
  const toPush = [];
  for (const l of local) {
    if (tombs.has(l.id)) continue;
    const r = byId.get(l.id);
    if (!r) { byId.set(l.id, l); toPush.push(l); continue; }
    // Newest write wins. Clock skew between devices is possible but a stale
    // fingerprint never stamps, so only real edits ever compete. Legacy copies
    // without timestamps fall back to whichever side holds more work.
    const lt = l.updatedAt || null;
    const rt = r.updatedAt || r._remote_updated || null;
    let localWins;
    if (lt && rt) localWins = lt > rt;
    else {
      const score = (c) => (c.briefs?.length || 0) * 100 + (c.posts?.length || 0);
      localWins = score(l) > score(r);
    }
    if (localWins) { byId.set(l.id, l); toPush.push(l); }
  }
  for (const c of toPush) await sbPushClient(c);
  const merged = [...byId.values()];
  persistClientsLocal(merged);
  CLIENT_SNAPSHOTS = new Map(merged.map((c) => [c.id, clientFingerprint(c)]));
  // Seed the persist diff tracker so a delete-first session still issues the
  // remote DELETE (it diffs against ids seen at last persist).
  window.__lastClientIds = merged.map((c) => c.id);
  SYNC_OK = true;
  return merged;
}

// "Whatever one account sees, they all see" — without waiting for a reload.
// Re-pull on tab focus and on a slow heartbeat; re-render the clients tab only
// when the data actually changed and the user isn't mid-keystroke in a field
// (a teammate's update must never eat a half-typed form).
let LIVE_SYNC_STARTED = false;
function startLiveSync() {
  if (LIVE_SYNC_STARTED) return;
  LIVE_SYNC_STARTED = true;
  const tick = async () => {
    if (!SB_TOKEN || document.hidden) return;
    const before = JSON.stringify(loadClientsLocal());
    try { await syncClients(); } catch { SYNC_OK = false; }
    updateSyncBadge();
    if (JSON.stringify(loadClientsLocal()) === before) return;
    const briefsShown = !document.getElementById("panel-briefs")?.hidden;
    const editing = document.activeElement
      && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (briefsShown && !editing) renderBriefs();
  };
  setInterval(tick, 90000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}

function updateSyncBadge() {
  const el = document.getElementById("sync-state");
  if (!el) return;
  el.className = "sync-state " + (SYNC_OK ? "ok" : "bad");
  // Two spans so narrow screens can drop the email but keep the sync signal.
  el.replaceChildren();
  const word = document.createElement("span");
  word.className = "sync-word";
  word.textContent = SYNC_OK ? "● syncing" : "● local only — not syncing";
  el.appendChild(word);
  if (SYNC_OK && SB_EMAIL) {
    const mail = document.createElement("span");
    mail.className = "sync-mail";
    mail.textContent = "· " + SB_EMAIL;
    el.appendChild(mail);
  }
  el.title = SYNC_OK
    ? "Clients are shared with your team through Supabase"
    : "Could not reach Supabase; changes are saved on this device only";
}

// ---------- Clients (local cache, mirrored to Supabase) ----------
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
    // MERGE, never replace: the brief editor only knows brand/feats/audience/
    // avatar, so a wholesale assignment would drop anything else already stored
    // on the client (its tracked posts predate the tracking removal).
    if (ctx) c.ctx = { ...c.ctx, ...ctx };
    if (niche) c.niche = niche;
  }
  return c;
}

function loadClientsLocal() {
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
function persistClientsLocal(list) {
  try { localStorage.setItem(CLIENTS_KEY, JSON.stringify(list)); } catch {}
}

// Every caller still uses loadClients/persistClients; persisting now also
// mirrors to Supabase in the background so the other machine sees it.
function loadClients() { return loadClientsLocal(); }

// One-team semantics: every account is the same workspace, so a device may
// only push what IT changed — re-pushing its whole cached list would overwrite
// teammates' fresh edits with stale copies. Each client carries updatedAt,
// stamped only when its content actually changes on this device; sync then
// resolves conflicts by newest write. `_remote_updated`/`updatedAt` are
// excluded from the fingerprint so stamping itself never reads as a change.
const clientFingerprint = (c) => {
  const { _remote_updated, updatedAt, ...rest } = c;
  return JSON.stringify(rest);
};
let CLIENT_SNAPSHOTS = new Map();   // id -> fingerprint at last sync/push

function persistClients(list) {
  const stamp = new Date().toISOString();
  const tombs = loadTombstones();
  const dirty = [];
  for (const c of list) {
    if (tombs.has(c.id)) continue;
    const fp = clientFingerprint(c);
    if (CLIENT_SNAPSHOTS.get(c.id) !== fp) {
      c.updatedAt = stamp;
      CLIENT_SNAPSHOTS.set(c.id, fp);
      dirty.push(c);
    }
  }
  persistClientsLocal(list);
  if (!SB_TOKEN) return;
  const before = new Set((window.__lastClientIds || []));
  const now = new Set(list.map((c) => c.id));
  window.__lastClientIds = [...now];
  let failed = false;
  Promise.all([
    // A failed push forgets its snapshot so the next persist retries it.
    ...dirty.map((c) => sbPushClient(c).catch(() => { failed = true; CLIENT_SNAPSHOTS.delete(c.id); })),
    ...[...before].filter((id) => !now.has(id)).map((id) => sbDeleteClient(id).catch(() => { failed = true; })),
  ]).then(() => {
    SYNC_OK = !failed;
    updateSyncBadge();
  });
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
  // Instagram has no keyless oEmbed — read the page's meta tags.
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
    platform: /instagram/.test(p) ? "instagram" : "",
  };
}

/** Deterministic tagger mirroring the locked taxonomy's routing rules. */


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


/** Hover a day column to compare predicted vs actual at that point. */

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
  // Remember the button's FACE, not just its label: several of these are a
  // trash icon, and restoring them with textContent replaced the svg with a
  // word — so the first arm-then-disarm left the button reading "Delete"
  // forever. Matches creator.js, which already learned this.
  const face = btn.innerHTML;
  const disarm = () => {
    clearTimeout(timer);
    btn.classList.remove("armed");
    btn.innerHTML = face;
  };
  /* A double-click used to delete outright: the first click armed the button
     and the second landed on the armed one milliseconds later, defeating the
     safeguard with an ordinary slip. Ignore a second press that arrives too
     fast to be considered. */
  let armedAt = 0;
  const SETTLE_MS = 450;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed");
      btn.innerHTML = "Are you sure?";
      btn.title = "This cannot be undone";
      armedAt = performance.now();
      timer = setTimeout(disarm, 5000);
      return;
    }
    if (performance.now() - armedAt < SETTLE_MS) return;   // that was a double-click
    clearTimeout(timer);
    onConfirm();
  });
  btn.addEventListener("blur", disarm);
}

/** The trash face shared by every destructive icon button (creator-app style). */
const TRASH_SVG = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`;

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
      renderClientPage(host, client);
      return;
    }
    CLIENT_VIEW = null;
  }

  if (!list.length) {
    host.innerHTML = `<h2>Clients</h2>
      <div class="empty"><p><strong>No clients yet.</strong></p>
        <p>Save a brief in the New Client tab — its company becomes your first client folder.</p></div>`;
    return;
  }

  host.innerHTML = `<h2>Clients <span class="pill">${list.length}</span></h2>
    <div class="brief-stack">` + list.map((c) => `
      <article class="bcard" data-id="${escapeHtml(c.id)}">
        <div class="bcard-main">
          <div class="bcard-title">${escapeHtml(c.company)}</div>
          <div class="lbl">${escapeHtml(c.niche || "All niches")}${c.ctx?.audience ? " · " + escapeHtml(c.ctx.audience) : ""}
            · ${c.briefs.length} brief${c.briefs.length === 1 ? "" : "s"}</div>
        </div>
        <button type="button" class="btn b-open">Open</button>
        <button type="button" class="ghost danger icon-only b-del"
          aria-label="Delete this client" title="Delete this client">${TRASH_SVG}</button>
      </article>`).join("") + `</div>`;

  host.querySelectorAll(".bcard").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector(".b-open").addEventListener("click", () => {
      CLIENT_VIEW = { id }; BRIEF_VIEW = null; renderBriefs();
    });
    armDelete(card.querySelector(".b-del"), "Delete", () => {
      deleteClient(id);
      renderBriefs();
    });
  });
}

/** Build the next brief straight from the videos ticked in Suggestions.
    This used to hand off to the New Client tab — its site-lookup form, its own
    parallel video shelf and a "0/10 in brief" tray — which made no sense as the
    answer to "+" on a client that already exists and whose videos you had just
    picked. The brief is created here and opened, and the New Client tab goes
    back to being only what it says: onboarding a brand-new client. */
function startNextWeekBrief(client) {
  const items = [...SUGGEST_PICKS.values()];
  if (!items.length) {
    // Nothing ticked: send them to the thing they need to do first rather than
    // creating an empty brief or navigating away.
    const box = document.querySelector(".suggest-box");
    if (box) {
      box.scrollIntoView({ behavior: "smooth", block: "start" });
      sugHint("Tick the videos you want, then hit + again \u2014 they go straight into the brief.");
    }
    return;
  }
  const list = loadClients();
  const c = list.find((x) => x.id === client.id);
  if (!c) return;
  const rec = {
    id: newId(), company: c.company, ctx: c.ctx || {}, niche: c.niche || "",
    createdAt: new Date().toISOString(), items,
  };
  c.briefs.unshift(rec);
  persistClients(list);
  SUGGEST_PICKS = new Map();
  SUGGEST_SHOWN_FOR = null;          // rescore: briefed videos drop out
  SUGGEST_CACHE = null;
  BRIEF_VIEW = { id: rec.id, expanded: null };
  renderBriefs();
}

/** Transient note above the suggestions grid. Uses the `hidden` attribute
    rather than a CSS collapse — see the .sug-hint rules for why. */
let SUG_HINT_T = null;
function sugHint(text) {
  const box = document.querySelector(".suggest-box");
  const grid = box && box.querySelector(".suggest-grid");
  if (!grid) return;
  let el = box.querySelector(".sug-hint");
  if (!el) {
    el = document.createElement("p");
    el.className = "sug-hint";
    grid.before(el);
  }
  el.textContent = text;
  // Re-trigger the shake even when the hint is already up: removing the node
  // from layout and forcing a reflow is what restarts a CSS animation.
  el.hidden = true;
  void el.offsetWidth;
  el.hidden = false;
  clearTimeout(SUG_HINT_T);
  // ~14 words at a slow 3.5 words/sec, plus a beat to notice it moved.
  // Re-queries rather than closing over `el`: any re-render of the client page
  // swaps the node out, and the captured one would then be detached — the
  // timer would fire against nothing and the visible hint would never leave.
  SUG_HINT_T = setTimeout(() => {
    document.querySelectorAll(".sug-hint").forEach((n) => { n.hidden = true; });
  }, 7000);
}


/** Collapsed avatar card for the client page — there when needed, out of the
    way when not. Renders nothing if no avatar was ever set. */
/** Everything recorded about a client, behind the header's Details button.
    Replaces the old avatar-only box: the avatar was the only field you could
    see on this page, while the niche, audience and features that actually
    drive the suggestion ranking were invisible unless you opened a brief. */
function clientDetailsHtml(client) {
  const ctx = client.ctx || {};
  const parts = ctx.avatarParts || (ctx.avatar ? { stats: ctx.avatar } : null);
  const row = (label, val) => val
    ? `<div class="sug-drow"><span class="sug-dk">${label}</span><span class="sug-dv">${escapeHtml(String(val))}</span></div>` : "";
  const avatar = [
    ["Core statistics", parts?.stats], ["Daily habits", parts?.habits],
    ["Deep personal goals", parts?.goals], ["Major problems", parts?.problems],
  ].filter(([, v]) => v);
  return `<div class="client-details" id="cl-details-box" hidden>
    <div class="cd-facts">
      ${row("company", client.company)}
      ${row("niche", client.niche)}
      ${row("audience", ctx.audience)}
      ${row("brand", ctx.brand)}
      ${row("features", (ctx.feats || []).join(", "))}
      ${row("briefs", client.briefs.length)}
      ${row("blueprints", (client.blueprints || []).length)}
      ${row("added", (client.createdAt || "").slice(0, 10))}
    </div>
    ${avatar.length ? `<div class="avatar-grid">${avatar.map(([label, text]) => `
      <div><div class="av-label">${escapeHtml(label)}</div>
        <div class="av-text">${escapeHtml(text)}</div></div>`).join("")}
    </div>` : ""}
  </div>`;
}

/** Per-client raw-video blueprints: upload a video file → the next pipeline
    pass transcribes it locally (Whisper, no API cost, nothing leaves the
    owner's machine) → the exact spoken script with timed beats renders here.
    The upload goes to the private lynxr-blueprints bucket; the entry in the
    client record carries status queued → done/error and self-heals via sync. */
/** A finished blueprint shaped as a database row, so realScript renders the
    IDENTICAL recreation blueprint database videos get — verbatim beats with
    per-beat shot cues, or a shot-by-shot plan for silent videos. */
function bpAsRow(b) {
  return {
    transcript_segments: JSON.stringify(b.script?.segments || []),
    visual_cues: JSON.stringify(b.shots || []),
    transcript: b.script?.text || (b.script?.segments || []).map((s) => s[2]).join(" "),
    hook_spoken: b.script?.hook || "",
    format_type: b.tags?.format_type || "",
  };
}

/** "just now" / "12 min ago" / "3h ago" / a date — a queued entry's age is the
    useful fact (how long until the pipeline picks it up), not its calendar day. */
function agoLabel(iso) {
  const t = new Date(iso || 0).getTime();
  if (!t) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return String(iso).slice(0, 10);
}

const platformLabel = (u) => /tiktok\.com/.test(u) ? "TikTok"
  : /instagram\.com/.test(u) ? "Instagram"
  : /youtube\.com|youtu\.be/.test(u) ? "YouTube" : "Link";

/** A blueprint shaped just enough for thumbFor(), which keys off platform+url. */
const bpThumbRow = (b) => ({
  url: String(b.url || ""),
  platform: platformLabel(String(b.url || "")).toLowerCase(),
  video_id: "",
});

/** Cover art for a blueprint row.
    YouTube resolves straight off the URL and TikTok arrives via oEmbed, both
    already allowed by the agency CSP's img-src. INSTAGRAM CANNOT: it publishes
    no keyless thumbnail, and its CDN is not in img-src either — so those rows
    get the same labelled placeholder the shelf uses rather than a broken image.
    Fixing that for real means the pipeline storing a cover (it already samples
    frames for the shot list) plus a CSP entry. */
function bpThumbHtml(b) {
  const row = bpThumbRow(b);
  const thumb = thumbFor(row);
  const pending = !thumb && row.platform === "tiktok";
  return `<span class="bp-thumb" data-url="${escapeHtml(row.url)}">${
    thumb ? `<img class="vthumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">`
    : pending ? `<span class="vthumb-pending"></span>`
    : `<span class="vthumb-none">${escapeHtml(platformLabel(row.url).slice(0, 2))}</span>`}</span>`;
}

/** One beat, split into the three things a creator actually needs:
      SAY   — the verbatim words (Whisper segments)
      DO    — the direction for that moment (shot list `visual`)
      SHOW  — the text on screen (shot list `onscreen_text`)
    realScript emits these fused into one string — "[0–2s] words\n   ON SCREEN:
    direction — text: “overlay”" — because database rows render it as prose.
    Blueprints get the same beats (identical grouping and nearest-shot matching,
    by construction) but pulled apart into labelled rows. `silent` marks a
    no-speech video, where the whole beat is direction and nothing is said. */
function bpBeatHtml(bt, silent, prev) {
  const m = String(bt).match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  if (!m) return `<li class="bp-beat"><span class="bp-t"></span><span class="bp-lbl">SAY</span><span class="bp-val">${escapeHtml(bt)}</span></li>`;
  let rest = m[2].trim();

  // Peel the on-screen overlay off the end: — text: “X”  /  — on-screen text: “X”
  let show = "";
  const om = rest.match(/[—–-]\s*(?:on[- ]screen\s+)?text:\s*[“"]([\s\S]*?)[”"]\s*$/i);
  if (om) { show = om[1].trim(); rest = rest.slice(0, om.index).trim(); }

  // Then separate the spoken words from the direction.
  let say = "", direction = "";
  const dm = rest.match(/\n\s*ON SCREEN:\s*([\s\S]*)$/i);
  if (dm) { direction = dm[1].trim(); say = rest.slice(0, dm.index).trim(); }
  else if (silent) { direction = rest; }
  else { say = rest; }

  // Only ~6 frames are sampled per video, so a long beat often lands on the
  // same shot as the one before it. Repeating the direction would read as
  // "do this again"; blank it instead — an unchanged shot is still running.
  if (prev) {
    const wasDir = direction, wasShow = show;
    if (direction && direction === prev.direction) direction = "";
    if (show && show === prev.show) show = "";
    prev.direction = wasDir || prev.direction;
    prev.show = wasShow || prev.show;
  }

  const row = (label, value, dim) => value
    ? `<span class="bp-lbl">${label}</span><span class="bp-val${dim ? " bp-dim" : ""}">${escapeHtml(value)}</span>`
    : "";
  const rows = [row("SAY", say), row("DO", direction, true), row("SHOW", show, true)].filter(Boolean);
  if (!rows.length) return "";
  return `<li class="bp-beat">
    <span class="bp-t">${escapeHtml(m[1])}</span>${rows[0]}
    ${rows.slice(1).map((r) => `<span></span>${r}`).join("\n    ")}
  </li>`;
}

// Status at last paint, so an entry that flips queued -> done while the page is
// open announces itself (opens + flashes) instead of quietly changing a chip.
const BP_SEEN = new Map();
const BP_FLASH = new Set();
/* Which blueprints are open for editing. Ids only — the working copy lives in
   the textareas until Save, so Cancel needs no undo buffer and a reload cannot
   resurrect a half-finished edit. Not persisted, deliberately: "open in the
   editor" is a state of this session, not of the blueprint. */
const BP_EDITING = new Set();

function blueprintsBoxHtml(client) {
  const bps = client.blueprints || [];
  const item = (b) => {
    const justReady = BP_SEEN.get(b.id) === "queued" && b.status === "done";
    if (justReady) BP_FLASH.add(b.id);
    BP_SEEN.set(b.id, b.status);
    const flash = BP_FLASH.has(b.id);
    BP_FLASH.delete(b.id);

    const bhref = b.url ? safeUrl(b.url) : null;
    const s = b.status === "done" ? realScript(bpAsRow(b)) : null;
    // "done" alone doesn't mean there's a script: a music-only video finishes
    // successfully with nothing to show, and calling that "script ready" sends
    // you clicking into an empty row.
    // A blueprint is only complete with BOTH halves: the spoken script
    // (local Whisper, free) and the visual layer (shot list + tags, paid).
    // Say which one you're looking at rather than calling half of it "ready".
    const hasShots = !!(b.shots || []).length;
    const chip = b.status === "error" ? `<span class="chip bad">couldn't fetch</span>`
      : b.status !== "done" ? `<span class="chip bp-wait"><i class="bp-dot"></i>waiting for pipeline</span>`
      : !s ? `<span class="chip">no speech found</span>`
      : hasShots ? `<span class="chip good">blueprint ready</span>`
      : `<span class="chip">script only</span>`;
    const id = escapeHtml(b.id);

    let body;
    if (b.status === "queued") {
      body = `<p class="bp-hint">Queued. The pipeline checks every few minutes — the verbatim
        script and timed beats appear here on their own, no need to stay on this page.</p>`;
    } else if (b.status === "error") {
      body = `<p class="bp-hint bad">${escapeHtml(b.note || "The video couldn't be downloaded.")}</p>
        <div class="bp-actions">
          <button type="button" class="ghost bp-retry" data-bpid="${id}">Try again</button>
          <span class="bp-icons">
            <button type="button" class="ghost danger icon-only bp-del" data-bpid="${id}"
              aria-label="Delete this blueprint" title="Delete this blueprint">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
            </button>
          </span>
        </div>`;
    } else if (s) {
      // Missing visuals is the common case while API credits are out, and it
      // is invisible in the beats themselves — they just quietly lack their
      // ON SCREEN line. Name it, rather than letting it read as "that's all
      // this video had".
      const partial = !hasShots || !b.tags;
      const outOfCredits = /credit balance/i.test(b.note || "");
      body = `
        ${b.tags ? `<div class="chips bp-tags">${["format_type", "hook_pattern", "niche_category", "target_audience", "visual_hook"]
          .map((d) => b.tags[d] ? `<span class="chip">${escapeHtml(b.tags[d])}</span>` : "").join("")}</div>` : ""}
        ${partial ? `<p class="bp-hint bp-partial">Spoken words only — no ${[!hasShots ? "shot list" : "", !b.tags ? "tags" : ""].filter(Boolean).join(" or ")}.
            ${outOfCredits
              ? `The visual pass (framing and on-screen text beneath each beat) runs on the Anthropic API and the balance is empty. Top up, then hit Try again.`
              : escapeHtml(b.note || "The visual pass didn't run.")}</p>`
          : b.note ? `<p class="bp-hint">${escapeHtml(b.note)}</p>` : ""}
        ${s.hook ? `<div class="bp-hook"><span class="bp-hook-lbl">Hook</span>“${escapeHtml(s.hook)}”</div>` : ""}
        <div class="bp-heading">${escapeHtml(s.heading)}${
          b.editedBeats ? ` <span class="chip">edited</span>` : ""}</div>
        ${/* EDITING. The beats shown are DERIVED at render time —
              realScript(bpAsRow(b)) rebuilds them from the Whisper transcript
              and the shot list every paint — so there is nothing in the record
              to type into. An edit is therefore stored as an OVERRIDE
              (b.editedBeats) rather than written over the source: the
              transcript stays exactly as the pipeline produced it, "Try again"
              still has real data to rebuild from, and Revert is free.

              The textareas hold the beat STRINGS verbatim, in the same
              "[0-9s] words / ON SCREEN: … — text: "…"" shape the renderer
              parses. Editing the parsed pieces and re-serialising them would
              risk mangling a format we only read with a regex; editing the
              string round-trips exactly. */""}
        ${BP_EDITING.has(b.id) ? `
          <div class="bp-editor">
            ${(b.editedBeats || s.beats).map((bt, i) => `
              <textarea class="bp-beat-edit grow" data-i="${i}" rows="2"
                aria-label="Beat ${i + 1}">${escapeHtml(bt)}</textarea>`).join("")}
            <div class="bp-actions">
              <button type="button" class="btn bp-save" data-bpid="${id}">Save changes</button>
              <button type="button" class="ghost bp-cancel" data-bpid="${id}">Cancel</button>
              ${b.editedBeats ? `<button type="button" class="ghost bp-revert" data-bpid="${id}"
                title="Discard your edits and show the pipeline's own version">Revert to original</button>` : ""}
            </div>
          </div>`
        : `<ol class="bp-beats">${(() => {
            const carry = { direction: "", show: "" };
            return (b.editedBeats || s.beats).map((bt) => bpBeatHtml(bt, !b.script?.has_speech, carry)).join("");
          })()}</ol>`}
        ${/* Same action row as the creator app's script cards: icon-only copy,
              edit and delete, pushed right by .bp-icons so the destructive one
              is not adjacent to the one you press most. "Try again" keeps its
              words — it is rare, and no icon says "re-run the pipeline". */""}
        <div class="bp-actions">
          ${partial ? `<button type="button" class="ghost bp-retry" data-bpid="${id}">Try again</button>` : ""}
          <span class="bp-icons">
            <button type="button" class="ghost icon-only bp-copy" data-bpid="${id}"
              aria-label="Copy this script" title="Copy this script">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
            </button>
            ${BP_EDITING.has(b.id) ? "" : `
            <button type="button" class="ghost icon-only bp-edit" data-bpid="${id}"
              aria-label="Edit this script" title="Edit this script">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><path d="M16.8 3.8a2.1 2.1 0 0 1 3 3L8.5 18.1l-4 1 1-4z"/><path d="M14.5 6.1l3.4 3.4"/></svg>
            </button>`}
            <button type="button" class="ghost danger icon-only bp-del" data-bpid="${id}"
              aria-label="Delete this blueprint" title="Delete this blueprint">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
            </button>
          </span>
        </div>`;
    } else {
      const sc = b.script || {};
      body = `<p class="bp-hint">Whisper found no usable speech${sc.language ? ` — detected ${escapeHtml(sc.language)}` : ""}${sc.duration ? `, ${Math.round(sc.duration)}s of audio` : ""}.
        Usually that means the video is music-only; a visual shot list would still describe it.</p>
        ${b.note ? `<p class="bp-hint">${escapeHtml(b.note)}</p>` : ""}
        <div class="bp-actions">
          <button type="button" class="ghost bp-retry" data-bpid="${id}">Try again</button>
          <span class="bp-icons">
            <button type="button" class="ghost danger icon-only bp-del" data-bpid="${id}"
              aria-label="Delete this blueprint" title="Delete this blueprint">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
            </button>
          </span>
        </div>`;
    }

    return `<details class="bp-item bp-${escapeHtml(b.status)}${flash ? " bp-flash" : ""}"${justReady ? " open" : ""} data-bpid="${id}">
      <summary>
        <span class="bp-caret" aria-hidden="true">▸</span>
        ${bpThumbHtml(b)}
        <span class="bp-name">${escapeHtml(b.name || "video")}</span>
        ${chip}
        <span class="bp-when">${escapeHtml(agoLabel(b.addedAt))}</span>
        ${bhref ? `<a class="bp-open" href="${escapeHtml(bhref)}" target="_blank" rel="noopener noreferrer" title="Open the original post">↗</a>` : ""}
      </summary>
      ${/* Delete moved INTO each branch's action row (with copy, as icons) so
            there is one row of controls rather than a row plus a loose button
            underneath. Every branch renders exactly one .bp-del — do not add
            one back here, or armDelete wires two buttons to the same id. */""}
      <div class="bp-body">
        ${body}
      </div>
    </details>`;
  };
  // The creator app has its own composer, but the agency side needs its own way
  // in: a blueprint here is filed against THIS client, and staff paste links for
  // clients who never touch creator.html. This form went missing for a while and
  // nothing complained — bindBlueprints null-guards every element, so the
  // handlers just went quiet. Keep the ids in sync with bindBlueprints.
  return `<div class="section blueprints-box">
    <div class="sec-head">
      <h2>Video blueprints <span class="pill">${bps.length}</span></h2>
      <button type="button" class="lib-plus" id="bp-add"
        title="Add a video by link" aria-label="Add a video by link">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
          aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
    ${/* Starts hidden; the + above reveals it (bindBlueprints sets
          .hidden = false). `hidden` alone is not enough — .post-form sets
          display:flex, and an author rule outranks the UA [hidden] rule, so
          .bp-form[hidden] in app.css is what actually keeps it off the page.

          The note stays a sibling and follows the form's state through the
          .bp-form[hidden] ~ #bp-note rule, so the + needs to touch only the
          form. Inside the form it became a flex item and .note's 70ch cap let
          it sit beside the button instead of taking its own row.

          The submit button carries no id — the + above owns #bp-add, and
          type="submit" is what submits a form. */""}
    <form class="post-form bp-form" id="bp-form" hidden>
      <span class="bp-field">
        <input type="url" id="bp-url" placeholder="Paste a TikTok / Instagram / YouTube link"
          autocomplete="off" spellcheck="false">
        <span class="bp-plat" id="bp-plat"></span>
      </span>
      <button type="submit" class="btn">Get script</button>
    </form>
    <p class="bp-msg" id="bp-msg" role="status" aria-live="polite"></p>
    <p class="note" id="bp-note">Paste a posted video's link — the pipeline transcribes it on our
      machine (nothing goes to a third party) and the exact spoken script with timed beats appears
      here.</p>
    ${bps.length ? `<div class="bp-list">${bps.map(item).join("")}</div>`
                 : `<p class="note">No blueprints yet.</p>`}
  </div>`;
}

/** Transient inline feedback — replaces overwriting the permanent help text,
    which left stale error copy sitting under the field forever. */
let BP_MSG_T = null;
function bpMsg(text, tone) {
  const el = document.getElementById("bp-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `bp-msg show${tone ? " " + tone : ""}`;
  clearTimeout(BP_MSG_T);
  BP_MSG_T = setTimeout(() => {
    const e2 = document.getElementById("bp-msg");
    if (e2) e2.className = "bp-msg";
  }, 4500);
}

/** Re-render the client page without the scroll jump a full innerHTML swap
    otherwise causes — the blueprints list sits well below the fold. */
function renderBriefsKeepScroll() {
  const y = window.scrollY;
  renderBriefs();
  window.scrollTo({ top: y });
}

function bindBlueprints(host, client) {
  // Covers arrive asynchronously and drop into the pending slots bpThumbHtml
  // left behind. The hosted pass is what can fill an INSTAGRAM row: if the same
  // video was ever turned into a creator script, process_adaptations.py already
  // published its frame under the same canonUrl key.
  const bpRows = (client.blueprints || []).map(bpThumbRow);
  fillTikTokThumbs(bpRows);
  fillHostedCovers(bpRows);

  // The + reveals the add-by-link form and puts the cursor in it. Written
  // against whatever form is present rather than rendering one here, because
  // the form itself is being restored separately — if it is not on the page
  // yet, say so instead of doing nothing.
  document.getElementById("bp-add")?.addEventListener("click", () => {
    const form = document.getElementById("bp-form");
    const url = document.getElementById("bp-url");
    if (!form || !url) {
      bpMsg("The add-by-link form isn't on this page yet — paste the link in the creator app for now.", "bad");
      return;
    }
    form.hidden = false;
    url.focus();
  });
  // Link-only: a pasted post URL becomes a queued blueprint entry. The pipeline
  // fetches the media itself (yt-dlp), so nothing is uploaded from the browser.
  const urlEl = document.getElementById("bp-url");
  const platEl = document.getElementById("bp-plat");
  // Recognize the platform as the link is typed/pasted, so it's obvious the URL
  // parsed before submitting rather than after.
  const showPlat = () => {
    if (!urlEl || !platEl) return;
    const raw = (urlEl.value || "").trim();
    const u = raw ? normalizeClientUrl(raw) : null;
    platEl.textContent = u ? platformLabel(u) : "";
    platEl.className = "bp-plat" + (u ? " on" : "");
  };
  if (urlEl) { urlEl.addEventListener("input", showPlat); showPlat(); }

  const bpForm = document.getElementById("bp-form");
  if (bpForm) bpForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rawUrl = (urlEl.value || "").trim();
    const url = rawUrl ? normalizeClientUrl(rawUrl) : null;
    if (!rawUrl) { bpMsg("Paste a video link first.", "bad"); urlEl.focus(); return; }
    if (!url) { bpMsg("That doesn't look like a video link.", "bad"); urlEl.select(); return; }
    const fresh = loadClients();
    const c = fresh.find((x) => x.id === client.id);
    if (!c) return;
    c.blueprints = c.blueprints || [];
    if (c.blueprints.some((b) => b.url && canonUrl(b.url) === canonUrl(url))) {
      bpMsg("That link is already in the list.", "bad");
      return;
    }
    // Queue FIRST, fetch the caption after: the oEmbed round-trip took about a
    // second, and making the row wait on it made adding feel broken.
    const id = newId();
    c.blueprints.unshift({ id, name: url.replace(/^https?:\/\//, "").slice(0, 60), url,
                           status: "queued", addedAt: new Date().toISOString() });
    persistClients(fresh);
    urlEl.value = "";
    showPlat();
    BP_FLASH.add(id);
    bpMsg("Queued — the script lands here on its own.", "good");
    renderBriefsKeepScroll();

    // A caption is a far better label than a URL tail. Patch the row in place
    // when it arrives; no re-render, so nothing the user is reading moves.
    try {
      const meta = await fetchPostMeta(url);
      if (!meta.caption) return;
      const list = loadClients();
      const cc = list.find((x) => x.id === client.id);
      const bb = cc?.blueprints?.find((x) => x.id === id);
      if (!bb) return;
      bb.name = meta.caption.slice(0, 60);
      persistClients(list);
      const nameEl = document.querySelector(`.bp-item[data-bpid="${CSS.escape(id)}"] .bp-name`);
      if (nameEl) nameEl.textContent = bb.name;
    } catch { /* oEmbed blocked or unsupported — the URL tail stands */ }
  });

  host.querySelectorAll(".bp-retry").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fresh = loadClients();
      const c = fresh.find((x) => x.id === client.id);
      const b = c?.blueprints?.find((x) => x.id === btn.dataset.bpid);
      if (!b) return;
      b.status = "queued";
      delete b.note;
      delete b.attemptedAt;
      persistClients(fresh);
      bpMsg("Re-queued for the next pipeline pass.", "good");
      renderBriefsKeepScroll();
    });
  });
  /* MANUAL EDITING of a blueprint. Nothing here calls the API or costs
     anything — it rewrites text the pipeline already produced.

     Every one of these re-renders, which rebuilds the <details> from scratch
     and loses the open state, so the card snaps shut on save and hides the
     change you just made. Reopen it after each paint — the same fix the
     creator app needed. */
  const bpKeepOpen = (bpid) => {
    renderBriefsKeepScroll();
    document.querySelectorAll(`.bp-item[data-bpid="${CSS.escape(bpid)}"]`)
      .forEach((el) => { el.open = true; });
  };
  host.querySelectorAll(".bp-edit").forEach((btn) => btn.addEventListener("click", () => {
    BP_EDITING.add(btn.dataset.bpid);
    bpKeepOpen(btn.dataset.bpid);
  }));
  host.querySelectorAll(".bp-cancel").forEach((btn) => btn.addEventListener("click", () => {
    BP_EDITING.delete(btn.dataset.bpid);
    bpKeepOpen(btn.dataset.bpid);
  }));
  host.querySelectorAll(".bp-save").forEach((btn) => btn.addEventListener("click", () => {
    const card = btn.closest(".bp-item");
    const beats = [...card.querySelectorAll(".bp-beat-edit")]
      .map((t) => t.value.trim())
      .filter(Boolean);            // a beat cleared to nothing is one you deleted
    const fresh = loadClients();
    const c = fresh.find((x) => x.id === client.id);
    const b = c?.blueprints?.find((x) => x.id === btn.dataset.bpid);
    if (!b) return;
    b.editedBeats = beats;
    persistClients(fresh);
    BP_EDITING.delete(btn.dataset.bpid);
    bpMsg("Saved.", "good");
    bpKeepOpen(btn.dataset.bpid);
  }));
  /* Revert drops the override so the derived version shows again. The
     transcript and shot list were never touched, so this always has something
     to fall back to. */
  host.querySelectorAll(".bp-revert").forEach((btn) => btn.addEventListener("click", () => {
    const fresh = loadClients();
    const c = fresh.find((x) => x.id === client.id);
    const b = c?.blueprints?.find((x) => x.id === btn.dataset.bpid);
    if (!b) return;
    delete b.editedBeats;
    persistClients(fresh);
    BP_EDITING.delete(btn.dataset.bpid);
    bpMsg("Back to the pipeline's version.", "good");
    bpKeepOpen(btn.dataset.bpid);
  }));

  host.querySelectorAll(".bp-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = (loadClients().find((c) => c.id === client.id)?.blueprints || [])
        .find((x) => x.id === btn.dataset.bpid);
      const s = b && realScript(bpAsRow(b));
      if (!s) return;
      // b.editedBeats first: copy has to give you what is on the screen. `s` is
      // rebuilt from the transcript every call, so using s.beats here would
      // quietly hand back the pipeline's version and lose every manual edit.
      const text = `${s.heading}\n` + (s.hook ? `HOOK: "${s.hook}"\n\n` : "\n")
        + (b.editedBeats || s.beats).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied ✓";
        setTimeout(() => { btn.textContent = "Copy script"; }, 1500);
      } catch { /* clipboard denied */ }
    });
  });
  host.querySelectorAll(".bp-del").forEach((btn) => {
    armDelete(btn, "Delete", () => {
      const fresh = loadClients();
      const c = fresh.find((x) => x.id === client.id);
      if (!c) return;
      const b = (c.blueprints || []).find((x) => x.id === btn.dataset.bpid);
      c.blueprints = (c.blueprints || []).filter((x) => x.id !== btn.dataset.bpid);
      persistClients(fresh);
      BP_SEEN.delete(btn.dataset.bpid);
      // Legacy uploads still hold a storage object — clean it up best-effort.
      if (b && b.status === "queued" && b.path) sbDeleteFile("lynxr-blueprints", b.path).catch(() => {});
      renderBriefsKeepScroll();
    });
  });
}

/** Videos picked on the client page, carried into the next brief's cart.
    rowKey -> row, cleared once startNextWeekBrief has consumed them. */
let SUGGEST_PICKS = new Map();

// Six fills two rows of three and keeps the section above the fold; the rest
// arrive three at a time so the grid never reflows into a ragged row. Reset per
// client so opening a different folder doesn't inherit the last one's depth.
const SUGGEST_PAGE = 6;
const SUGGEST_STEP = 3;
let SUGGEST_SHOWN = SUGGEST_PAGE;
let SUGGEST_SHOWN_FOR = null;

/** One suggestion card. Extracted so "load more" can APPEND new cards to the
    existing grid instead of re-rendering the whole section — re-rendering threw
    away already-loaded thumbnails and any open detail panel, and it let the
    browser's scroll anchoring pin the button in place. */
function sugCardHtml({ row, edge }) {
  const k = rowKey(row);
  const picked = SUGGEST_PICKS.has(k);
  const href = safeUrl(row.url);
  const er = row.engagement_rate ? parseFloat(row.engagement_rate).toFixed(2) + "%" : "\u2014";
  // Collapsed shows only the two facts that decide "is this worth a look":
  // how far it beat its pocket, and how big it got. Everything else is one
  // click away — eight cards of full metadata is a wall, not a shelf.
  const detail = (label, val) => val
    ? `<div class="sug-drow"><span class="sug-dk">${label}</span><span class="sug-dv">${escapeHtml(String(val))}</span></div>` : "";
  return `
  <article class="vcard sug-card${picked ? " picked" : ""}" data-key="${escapeHtml(k)}">
    ${frameHtml(row)}
    <div class="vmeta">
      <div class="vtitle" title="${escapeHtml(row.title || "")}">${escapeHtml(row.title || "(no caption)")}</div>
      <div class="vrow">
        <span class="sug-edge" title="This video's views divided by the median of the ${edge.n} videos sharing its niche, format, hook and platform">${edge.x.toFixed(1)}\u00d7 its pocket</span>
        <span class="vstat">${compact(views(row))} views</span>
      </div>
      <div class="vrow sug-acts">
        <button type="button" class="sug-more" aria-expanded="false">Details</button>
        <label class="vpick"><input type="checkbox" class="sugcheck" ${picked ? "checked" : ""}><span class="vpick-txt">${picked ? "Added" : "Add"}</span></label>
      </div>
      <div class="sug-detail" hidden>
        ${detail("format", `${row.format_type || "\u2014"} \u00d7 ${row.hook_pattern || "\u2014"}`)}
        ${detail("beat", `${compact(edge.med)} median across ${edge.n} videos`)}
        ${detail("platform", row.platform)}
        ${detail("creator", row.creator)}
        ${detail("niche", row.niche_category)}
        ${detail("audience", row.target_audience)}
        ${detail("visual hook", row.visual_hook)}
        ${detail("cta", row.cta_type)}
        ${detail("length", row.length_bucket)}
        ${detail("engagement", er)}
        ${detail("likes", compact(+row.likes || 0))}
        ${detail("comments", compact(+row.comments || 0))}
        ${href ? `<a class="sug-open" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">open on ${escapeHtml(row.platform || "platform")} \u2197</a>` : ""}
      </div>
    </div>
  </article>`;
}

/** The load-more control, rebuilt in place as the remaining count changes. */
const sugMoreRowHtml = (left) => left
  ? `<div class="sug-more-row">
      <button type="button" class="ghost" id="sug-loadmore">Load ${Math.min(SUGGEST_STEP, left)} more
        <span class="lbl">${left} left</span></button>
    </div>`
  : "";

/** Per-VIDEO suggestions for this client. Deliberately separate from the shelf:
    the shelf answers "which format should they run", this answers "which video
    should they copy", and the two disagree — the format with the worst median
    reach supplies the most individual overperformers. */
function suggestionsBoxHtml(client) {
  // Reset the reveal depth when a different client's folder opens.
  if (SUGGEST_SHOWN_FOR !== client.id) { SUGGEST_SHOWN = SUGGEST_PAGE; SUGGEST_SHOWN_FOR = client.id; }
  // Score deeper than we show, so "load more" has somewhere to go.
  const { picks: all, widened, pocketed, seenBefore } = clientSuggestions(client, 30);
  const picks = all.slice(0, SUGGEST_SHOWN);
  const more = all.length - picks.length;
  // An empty section that renders nothing reads as a broken feature. Say which
  // wall it hit — the niche is too thin, or they have already been shown
  // everything that clears the bar.
  if (!picks.length) {
    const why = !client.niche
      ? `This client has no niche set, so there is nothing to match against. Set one on their next brief.`
      : !pocketed
      ? `Not enough tagged videos in <strong>${escapeHtml(client.niche)}</strong> yet to judge any of them
         fairly — a video is only scored once its niche × format × hook × platform pocket holds
         ${POCKET_MIN} others to compare it against.`
      : seenBefore
      ? `Everything in <strong>${escapeHtml(client.niche)}</strong> that beats its own pocket is already in
         one of their ${client.briefs.length} brief${client.briefs.length === 1 ? "" : "s"}.`
      : `Nothing in <strong>${escapeHtml(client.niche)}</strong> currently beats the median of its own pocket.`;
    return `<div class="section suggest-box">
      <h2>Suggested videos for ${escapeHtml(client.company)}</h2>
      <div class="empty"><p>${why}</p></div>
    </div>`;
  }
  return `<div class="section suggest-box">
    <h2>Suggested videos for ${escapeHtml(client.company)} <span class="pill">${all.length}</span></h2>
    ${/* The how-it-works paragraph that used to sit here is gone — the scoring
          is documented in HANDOFF.md and the per-card "N× its pocket" chip
          carries the same fact where it is actually useful. The widened
          warning stays: that one is about the DATA being thin, not about the
          method, and it changes how much you should trust the row. */""}
    ${widened ? `<p class="lbl">Too few videos tagged <strong>${escapeHtml(client.niche)}</strong>
      to rank reliably, so this draws from the whole database — treat it as directional.</p>` : ""}
    <div class="suggest-grid">
      ${picks.map(sugCardHtml).join("")}
    </div>
    ${sugMoreRowHtml(more)}
  </div>`;
}

/** Wire one suggestion card: play, expand, and the add-to-brief tick. */
function bindSugCard(card, row, client) {
  card.querySelector(".vplay")?.addEventListener("click", () => {
    playInFrame(card.querySelector(".vframe"), row);
  });
  // Toggled in place rather than re-rendered: a re-render would collapse every
  // other open card (the same trap the <details> keepOpen helpers work around).
  const more = card.querySelector(".sug-more");
  more?.addEventListener("click", () => {
    const panel = card.querySelector(".sug-detail");
    const open = panel.hasAttribute("hidden");
    panel.toggleAttribute("hidden", !open);
    more.setAttribute("aria-expanded", String(open));
    more.textContent = open ? "Hide details" : "Details";
    card.classList.toggle("open", open);
  });
  card.querySelector(".sugcheck")?.addEventListener("change", (e) => {
    const on = e.target.checked;
    if (on) SUGGEST_PICKS.set(card.dataset.key, row);
    else SUGGEST_PICKS.delete(card.dataset.key);
    card.classList.toggle("picked", on);
    const txt = card.querySelector(".vpick-txt");
    if (txt) txt.textContent = on ? "Added" : "Add";
    refreshNextBriefBtn(client);
  });
}

/** Play buttons, the add-to-brief toggles, and load-more for the grid. */
function bindSuggestions(host, client) {
  const box = host.querySelector(".suggest-box");
  if (!box) return;
  const all = clientSuggestions(client, 30).picks;
  const rows = new Map(all.map(({ row }) => [rowKey(row), row]));
  fillTikTokThumbs([...rows.values()]);
  fillHostedCovers([...rows.values()]);

  box.querySelectorAll(".sug-card").forEach((card) => {
    const row = rows.get(card.dataset.key);
    if (row) bindSugCard(card, row, client);
  });

  const wireLoadMore = () => {
    const btn = box.querySelector("#sug-loadmore");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const grid = box.querySelector(".suggest-grid");
      const from = SUGGEST_SHOWN;
      SUGGEST_SHOWN = Math.min(SUGGEST_SHOWN + SUGGEST_STEP, all.length);
      const added = all.slice(from, SUGGEST_SHOWN);

      // APPEND rather than re-render. Re-rendering the section threw away
      // already-decoded thumbnails and any open detail panel, and — because the
      // browser anchors scroll to keep visible content still — it pinned this
      // button at the same spot on screen while the page silently scrolled 800px.
      // Appending pushes the button down past the new row instead, which is
      // where it belongs: out of the way until you want it again.
      const tmp = document.createElement("div");
      tmp.innerHTML = added.map(sugCardHtml).join("");
      const fresh = [...tmp.children];
      fresh.forEach((card) => {
        grid.appendChild(card);
        const row = rows.get(card.dataset.key);
        if (row) bindSugCard(card, row, client);
      });
      fillTikTokThumbs(added.map((p) => p.row));
      fillHostedCovers(added.map((p) => p.row));

      // Rebuild the control in place with the new remaining count.
      const row = box.querySelector(".sug-more-row");
      const left = all.length - SUGGEST_SHOWN;
      if (!left) { row.remove(); return; }
      const holder = document.createElement("div");
      holder.innerHTML = sugMoreRowHtml(left);
      row.replaceWith(holder.firstElementChild);
      wireLoadMore();
    });
  };
  wireLoadMore();
}

/** Swap the Briefs header button between bare + and the labelled CTA as videos
    are ticked. Replaced wholesale rather than relabelled: the two are different
    elements (icon button vs .btn), and writing textContent onto the icon one
    would eat its svg — the same trap armDelete had. */
function refreshNextBriefBtn(client) {
  const old = document.getElementById("cl-nextbrief");
  if (!old) return;
  const total = client.briefs.length;
  const el = document.createElement("button");
  el.type = "button";
  el.id = "cl-nextbrief";
  if (SUGGEST_PICKS.size) {
    el.className = "btn sec-cta";
    el.textContent = `${SUGGEST_PICKS.size} pick${SUGGEST_PICKS.size === 1 ? "" : "s"} \u2192 brief ${total + 1}`;
  } else {
    el.className = "lib-plus";
    el.title = `Build brief ${total + 1}`;
    el.setAttribute("aria-label", el.title);
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
      stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
  }
  el.addEventListener("click", () => startNextWeekBrief(client));
  old.replaceWith(el);
}

function renderClientPage(host, client) {
  // Briefs are stored newest-first; number them oldest-first so "Brief 1" is
  // where the client started and the number never changes as weeks are added.
  const total = client.briefs.length;
  const briefNo = (idx) => total - idx;

  host.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb">
      <button type="button" class="crumb-link" id="cl-back">Clients</button>
      <span class="crumb-sep">\u203a</span>
      <span class="crumb-here">${escapeHtml(client.company)}</span>
    </nav>
    <div class="page-head">
      <div class="minw0">
        <div class="bcard-title">${escapeHtml(client.company)}</div>
        <div class="lbl">${escapeHtml(client.niche || "All niches")}${client.ctx?.audience ? " \u00b7 " + escapeHtml(client.ctx.audience) : ""}</div>
      </div>
      <button type="button" class="ghost" id="cl-details" aria-expanded="false">Details</button>
    </div>
    ${clientDetailsHtml(client)}

    ${suggestionsBoxHtml(client)}

    ${blueprintsBoxHtml(client)}

    <div class="sec-head">
      <h2>Briefs <span class="pill">${total}</span></h2>
      ${/* Replaces the "next brief" block that used to sit at the bottom of the
            page: same action, attached to the thing it creates instead of
            stranded below the brief list. Bare + until videos are ticked above,
            then it names the count it is carrying — the tick and the button are
            far apart on screen, so the button has to say what it picked up. */""}
      ${SUGGEST_PICKS.size
        ? `<button type="button" class="btn sec-cta" id="cl-nextbrief">${SUGGEST_PICKS.size} pick${SUGGEST_PICKS.size === 1 ? "" : "s"} \u2192 brief ${total + 1}</button>`
        : `<button type="button" class="lib-plus" id="cl-nextbrief"
             title="Build brief ${total + 1}" aria-label="Build brief ${total + 1}">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
               aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
           </button>`}
    </div>
    ${total ? `<div class="brief-stack">` + client.briefs.map((b, i) => `
      <article class="bcard" data-bid="${escapeHtml(b.id)}">
        <div class="bcard-main">
          <div class="bcard-title">Brief ${briefNo(i)}${i === 0 ? ` <span class="pill">latest</span>` : ""}</div>
          <div class="lbl">${escapeHtml((b.createdAt || "").slice(0, 10))} \u00b7 ${b.items.length} scripts</div>
        </div>
        <button type="button" class="btn br-open">Open</button>
        <button type="button" class="ghost danger icon-only br-del"
          aria-label="Delete this brief" title="Delete this brief">${TRASH_SVG}</button>
      </article>`).join("") + `</div>`
    : `<div class="empty"><p><strong>No briefs yet.</strong></p>
        <p>Tick videos above and hit + to start Brief 1 with them already in the cart.</p></div>`}
`;

  bindBlueprints(host, client);
  bindSuggestions(host, client);
  document.getElementById("cl-back").addEventListener("click", () => {
    CLIENT_VIEW = null; BRIEF_VIEW = null; renderBriefs();
  });
  const detBtn = document.getElementById("cl-details");
  detBtn?.addEventListener("click", () => {
    const panel = document.getElementById("cl-details-box");
    const open = panel.hasAttribute("hidden");
    panel.toggleAttribute("hidden", !open);
    detBtn.setAttribute("aria-expanded", String(open));
    detBtn.textContent = open ? "Hide details" : "Details";
  });
  document.getElementById("cl-nextbrief").addEventListener("click", () => startNextWeekBrief(client));

  host.querySelectorAll(".bcard[data-bid]").forEach((card) => {
    const bid = card.dataset.bid;
    card.querySelector(".br-open").addEventListener("click", () => {
      BRIEF_VIEW = { id: bid, expanded: null }; renderBriefs();
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
function scriptDetailHtml(rec, client, i) {
  const row = rec.items[i];
  const s = tailoredScript(row, rec.ctx, i);
  const er = row.engagement_rate ? parseFloat(row.engagement_rate).toFixed(2) + "%" : "—";
  const href = safeUrl(row.url);
  const stat = (v, l) => `<div class="metric"><div class="m-val">${v}</div><div class="m-lbl">${l}</div></div>`;
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
          ${s.cta ? `<p class="vs-beat vs-cta">${escapeHtml(s.cta)}</p>` : ""}
        </div>
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
/** The brief's script cards: one per video, expandable into the full player,
    tags, and tailored script. */
function briefScriptsHtml(rec, client) {
  const cards = rec.items.map((it, i) => {
    const expanded = BRIEF_VIEW && BRIEF_VIEW.expanded === i;
    return `<div class="fmt-card expandable${expanded ? " expanded" : ""}" data-idx="${i}">
      <div class="fmt-head" role="button" tabindex="0" title="${expanded ? "Collapse" : "Expand for the script, video, and details"}">
        <strong>${i + 1}. ${escapeHtml(it.format_type || "\u2014")} \u00d7 ${escapeHtml(it.hook_pattern || "\u2014")}</strong>
        <span class="fmt-head-right"><span class="lbl">${compact(views(it))} views</span><span class="caret">${expanded ? "\u25be" : "\u25b8"}</span></span>
      </div>
      ${expanded ? scriptDetailHtml(rec, client, i) : ""}
    </div>`;
  }).join("");
  return `<h2>Scripts <span class="pill">${rec.items.length}</span></h2>
    <div class="fmt-grid">${cards}</div>`;
}

function renderBriefViewer(host, rec, client) {
  // briefs are newest-first, so a lower index is a later week
  const total = client.briefs.length;
  const idx = client.briefs.findIndex((b) => b.id === rec.id);
  if (BRIEF_VIEW.expanded != null)
    BRIEF_VIEW.expanded = Math.max(0, Math.min(BRIEF_VIEW.expanded, rec.items.length - 1));
  host.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb">
      <button type="button" class="crumb-link" id="bv-clients">Clients</button>
      <span class="crumb-sep">\u203a</span>
      <button type="button" class="crumb-link" id="bv-back">${escapeHtml(client?.company || "Back")}</button>
      <span class="crumb-sep">\u203a</span>
      <span class="crumb-here">Brief ${total - idx}</span>
      <div class="spacer"></div>
      <button type="button" class="ghost week-arrow" id="wk-prev" ${idx >= total - 1 ? "disabled" : ""}
        title="${idx >= total - 1 ? "No earlier brief" : "Earlier brief"}">\u2190</button>
      <button type="button" class="ghost week-arrow" id="wk-next" ${idx <= 0 ? "disabled" : ""}
        title="${idx <= 0 ? "No later brief" : "Later brief"}">\u2192</button>
    </nav>
    <div class="page-head">
      <div class="bcard-title">Brief ${total - idx} <span class="pill">${total - idx} of ${total}</span></div>
      <div class="lbl">${escapeHtml(rec.company)} \u00b7 ${escapeHtml((rec.createdAt || "").slice(0, 10))}</div>
    </div>

    ${briefScriptsHtml(rec, client)}`;

  document.getElementById("bv-back").addEventListener("click", () => { BRIEF_VIEW = null; renderBriefs(); });
  document.getElementById("bv-clients").addEventListener("click", () => {
    CLIENT_VIEW = null; BRIEF_VIEW = null; renderBriefs();
  });
  document.getElementById("wk-prev").addEventListener("click", () => {
    if (idx < total - 1) { BRIEF_VIEW = { id: client.briefs[idx + 1].id, expanded: null }; renderBriefs(); }
  });
  document.getElementById("wk-next").addEventListener("click", () => {
    if (idx > 0) { BRIEF_VIEW = { id: client.briefs[idx - 1].id, expanded: null }; renderBriefs(); }
  });



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
        await navigator.clipboard.writeText(
          [sc.heading, `Hook: \u201c${sc.hook}\u201d`, ...sc.beats, sc.cta].filter(Boolean).join("\n"));
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

/** Build up to 10 ranked plays, ranked by a source-normalised performance index.
 *
 *  Raw view counts are NOT comparable across sources: Medceptor UGC posts run in
 *  the hundreds while scraped viral TikToks run in the hundreds of thousands.
 *  Ranking on raw views would just rediscover "TikTok has more views". So each
 *  video is scored against the median of ITS OWN source — index 1.00 = typical
 *  for where it came from — and segments are ranked on the median of that.
 */
function buildPlays(pool) {
  // Comparison group = source × platform (see the shelf ranking above).
  const srcKey = (r) => (r.data_source || "?") + "|" + (r.platform || "?");
  const bySource = new Map();
  for (const r of pool) {
    // 0 views almost always means "the platform never told us", not "nobody
    // watched it" — yt-dlp returns no view count for Instagram Reels at all, so
    // every creator-submitted Reel lands as 0. Averaging those zeros in
    // collapses the group's median to 0, the `|| 1` fallback below takes over,
    // and any row in that group that DOES carry real views is then scored as
    // its RAW view count: one Reel indexes at ~80,000 while every correctly
    // normalised row sits near 1.00, and it owns the entire shelf. So the
    // median is taken over measured rows only. Unmeasured rows still score 0
    // and rank last, which is the honest answer for "we don't know".
    if (views(r) <= 0) continue;
    const s = srcKey(r);
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(views(r));
  }
  const srcMedian = new Map([...bySource].map(([s, vs]) => [s, median(vs) || 1]));
  const relative = (r) => views(r) / (srcMedian.get(srcKey(r)) || 1);

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

/** Brand loader: the mark's two blades counter-rotate and keep converging —
    the logo's own "data converging into insight" gesture, used while we read
    the client's site and match it against the database. Stages are advanced
    at real transition points, not on a timer, so the text never lies. */
function showLoader(host, hostname) {
  host.innerHTML = `
    <div class="loader" role="status" aria-live="polite">
      ${loaderMark()}
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
        <div class="ce-field ce-wide"><span class="lbl">Target avatar — who these videos are for (all four shape the ranking)</span>
          <div class="ce-avatar-grid">
            <label class="ce-field"><span class="lbl">Core statistics</span>
              <textarea id="ce-av-stats" rows="2"
                placeholder="e.g. 20–24, 2nd-year nursing student, part-time hospital job, tight budget">${escapeHtml(BRIEF_CTX?.avatarParts?.stats || "")}</textarea></label>
            <label class="ce-field"><span class="lbl">Daily habits</span>
              <textarea id="ce-av-habits" rows="2"
                placeholder="e.g. studies after night shifts, lives on TikTok study hacks, flashcards on the bus">${escapeHtml(BRIEF_CTX?.avatarParts?.habits || "")}</textarea></label>
            <label class="ce-field"><span class="lbl">Deep personal goals</span>
              <textarea id="ce-av-goals" rows="2"
                placeholder="e.g. pass the NCLEX first try, land an ICU job, make family proud">${escapeHtml(BRIEF_CTX?.avatarParts?.goals || "")}</textarea></label>
            <label class="ce-field"><span class="lbl">Major problems</span>
              <textarea id="ce-av-problems" rows="2"
                placeholder="e.g. overwhelmed by content volume, fails practice tests, no study plan, burnout">${escapeHtml(BRIEF_CTX?.avatarParts?.problems || "")}</textarea></label>
          </div>
        </div>
      </div>
      <button type="button" class="btn" id="ce-apply">Apply — build the shelf</button>
      </div>
    </div>
    <div id="brief-body"></div>`;

  const apply = () => {
    const brand = document.getElementById("ce-brand").value.trim();
    const feats = document.getElementById("ce-feats").value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8);
    const audience = document.getElementById("ce-audience").value || null;
    const avatarParts = {
      stats: document.getElementById("ce-av-stats").value.trim(),
      habits: document.getElementById("ce-av-habits").value.trim(),
      goals: document.getElementById("ce-av-goals").value.trim(),
      problems: document.getElementById("ce-av-problems").value.trim(),
    };
    // The joined text feeds the keyword matcher; the parts keep the form.
    const avatar = Object.values(avatarParts).filter(Boolean).join("\n");
    const niche = document.getElementById("brief-niche").value;
    // Campaign plan: these two numbers are what turn on the plan yardstick
    // (expected-range corridor, success pace, plan-based health) everywhere.
    BRIEF_CTX = (brand || feats.length || audience || avatar)
      ? { brand: brand || "the product", feats, audience, avatar, avatarParts }
      : BRIEF_CTX;
    // Collapse the editor into a one-line summary; Edit re-opens it.
    const chips = [
      BRIEF_CTX?.brand, niche || "All niches", BRIEF_CTX?.audience,
      BRIEF_CTX?.feats?.length ? `${BRIEF_CTX.feats.length} features` : null,
      BRIEF_CTX?.avatar ? "avatar set" : null,
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

// ---------- Footer ----------
/** The giant footer wordmark fills left-to-right as the footer scrolls into
    view, completing exactly at the bottom of the page. Width is set through
    element.style (CSSOM) — allowed under the strict CSP, unlike style="". */
function initFooter(rows) {
  const count = document.getElementById("foot-count");
  if (count) count.textContent = fmt(rows.length);

  document.querySelectorAll(".foot-link[data-tab]").forEach((b) =>
    b.addEventListener("click", () => activateTab(b.dataset.tab)));

  // Slot-machine wordmark: each character spins through random glyphs and
  // locks in left-to-right as the footer scrolls into view. At the bottom of
  // the page every slot has stopped on its letter: l y n x r .
  const mark = document.getElementById("foot-wordmark");
  const foot = document.getElementById("site-footer");
  if (!mark || !foot) return;
  const FINAL = mark.textContent.trim() || "lynxr.";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;  // static text stays
  // Split-flap, not slot machine: each reel walks the alphabet TOWARD its
  // letter and arrives exactly as it locks — convergence, not noise.
  const REEL = "abcdefghijklmnopqrstuvwxyz.";
  mark.replaceChildren(...[...FINAL].map((ch) => {
    const s = document.createElement("span");
    s.className = "fw-ch spin";
    s.textContent = ch;
    return s;
  }));
  const chars = [...mark.children];
  const N = FINAL.length;
  const update = () => {
    const r = foot.getBoundingClientRect();
    // 0 as the footer's top crosses the viewport bottom → 1 when the footer is
    // fully on screen (it's the last element, so that IS the bottom of page).
    const p = Math.min(1, Math.max(0, (innerHeight - r.top) / r.height));
    chars.forEach((s, i) => {
      const lockP = (i + 1) / (N + 1);        // slots lock left-to-right
      if (p >= lockP) {
        if (s.classList.contains("spin")) {   // just arrived: settle in place
          s.classList.remove("spin");
          void s.offsetWidth;
          s.classList.add("settled");
        }
        s.textContent = FINAL[i];
      } else {
        s.classList.add("spin");
        s.classList.remove("settled");
        // Scrubbed by scroll: N flips remain proportional to the distance
        // from this slot's lock point; stationary = frozen.
        const target = Math.max(0, REEL.indexOf(FINAL[i]));
        const total = 6 + i * 2;              // later slots travel further
        const remaining = Math.max(1, Math.ceil(total * (lockP - p) / lockP));
        s.textContent = REEL[(target - (remaining % REEL.length) + REEL.length) % REEL.length];
      }
    });
  };
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update, { passive: true });
  update();
}

// ---------- Boot ----------
function renderApp(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    document.querySelector("main").innerHTML = `
      <div class="empty"><p><strong>No data loaded yet.</strong></p>
        <p>Load the database with <code>pipeline/export_supabase.py</code>, then reload.</p></div>`;
    return;
  }
  ALL = rows;
  URL_INDEX = new Map(rows.filter((r) => r.url).map((r) => [canonUrl(r.url), r]));
  renderStats(rows);
  renderSaturation(rows);
  renderBars("by-format", countBy(rows, "format_type"), 8, "f-format");
  renderBars("by-hook", countBy(rows, "hook_pattern"), 8, "f-hook");
  renderBars("by-niche", countBy(rows, "niche_category"), 8, "f-niche");
  renderBars("by-platform", countBy(rows, "platform"), 8, "f-platform");
  renderBars("by-cta", countBy(rows, "cta_type"), 8, "f-cta");
  renderBars("by-visual", countBy(rows, "visual_hook"), 8, "f-visual");
  renderBars("by-length", countBy(rows, "length_bucket"), 8, "f-length");
  // audio_trend holds the platform's sound label, so its tail is hundreds of
  // one-off track names. A sound only earns its own bar at >=1% of the
  // database; the rest roll up so the panel reads as a split, not a playlist.
  const audioPairs = countBy(rows, "audio_trend");
  const audioMin = rows.length * 0.01;
  const majors = audioPairs.filter(([l, n]) => n >= audioMin || l === "(untagged)");
  const tail = audioPairs.filter(([l, n]) => n < audioMin && l !== "(untagged)");
  const tailSum = tail.reduce((a, [, n]) => a + n, 0);
  if (tailSum) majors.push([`(${fmt(tail.length)} named sounds)`, tailSum]);
  renderBars("by-audio", majors.sort((a, b) => b[1] - a[1]), 8, "f-audio");
  initTabs();
  initModal();
  updateSyncBadge();
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
  initFooter(rows);
  applyFilters();
}

// Kick off auto-login last, once every Supabase const above is initialized.
resumeSession();

