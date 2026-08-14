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

/** The client's own experiment ledger: every format×hook combo they've
    actually posted, with a verdict. "failed" combos are RETIRED for this
    client — the shelf refuses them and pulls the next-best untried combo from
    the main database instead. One catastrophic post (<0.5×) retires a combo;
    a mild miss needs a second data point before retirement, so one unlucky
    upload can't kill a good idea. */
function comboVerdicts(client) {
  const stats = new Map();
  for (const p of client?.posts || []) {
    const r = postRatio(p);
    if (r == null || !p.format || !p.hook) continue;
    const k = `${p.format}×${p.hook}`;
    if (!stats.has(k)) stats.set(k, []);
    stats.get(k).push(r);
  }
  const out = new Map();
  for (const [k, rs] of stats) {
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
    const status = avg >= 1 ? "proven"
      : (rs.length >= 2 && avg < 0.75) || avg < 0.5 ? "failed"
      : "testing";
    out.set(k, { n: rs.length, avg, status });
  }
  return out;
}

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

function buildShelf(pool, relative, count = 24, learning = null, verdicts = null) {
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
    // Retired for THIS client: underperformed when they actually tried it.
    // Dropping the combo here is what pulls its replacement up from the
    // main database — the next-ranked untried combo takes the slots.
    .filter(([k]) => verdicts?.get(k)?.status !== "failed")
    .map(([, list]) => {
      list.sort((a, b) => relative(a) - relative(b));           // ascending
      const med = relative(list[Math.floor(list.length / 2)]);
      const boost = learning
        ? learnedBoost(learning, list[0].format_type, list[0].hook_pattern) : 1;
      return { list, med: med * boost };
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
  const own = LEARN_CLIENT ? clientRows(LEARN_CLIENT) : [];
  const base = own.length ? ALL.concat(own) : ALL;
  let pool = niche ? base.filter((r) => r.niche_category === niche) : base;
  const notes = [];
  if (niche && pool.length < MIN_N_NICHE) {
    notes.push(`Only ${pool.length} videos tagged <strong>${escapeHtml(niche)}</strong> — too few to rank
      reliably, so the shelf draws from the whole database instead. Treat it as directional.`);
    pool = base;
  }
  let learning = null, verdicts = null;
  if (own.length) {
    learning = clientLearning(LEARN_CLIENT);
    verdicts = comboVerdicts(LEARN_CLIENT);
    const up = [...learning.fmt].filter(([, v]) => v >= 1.25).map(([k]) => k);
    const down = [...learning.fmt].filter(([, v]) => v < 0.75).map(([k]) => k);
    notes.push(`Learning from <strong>${escapeHtml(LEARN_CLIENT.company)}</strong>: ${own.length} tracked post${own.length === 1 ? "" : "s"} are in this ranking${up.length ? `, and <strong>${escapeHtml(up.join(", "))}</strong> ${up.length === 1 ? "is" : "are"} boosted for beating benchmark` : ""}${down.length ? `, <strong>${escapeHtml(down.join(", "))}</strong> demoted for missing it` : ""}.`);
    const retired = [...verdicts].filter(([, v]) => v.status === "failed");
    if (retired.length) {
      notes.push(`Retired for ${escapeHtml(LEARN_CLIENT.company)} after underperforming:
        ${retired.map(([k, v]) => `<strong>${escapeHtml(k)}</strong> (${ratioLabel(v.avg)} over ${v.n} post${v.n === 1 ? "" : "s"})`).join(", ")}
        — replaced below with the next-best combos from the database they haven't tried yet.`);
    }
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
  // Client-tracked rows are scored against the benchmark they were measured
  // against; source-normalising them would divide them by themselves.
  const relative = (r) => (r._client && r._ratio != null)
    ? r._ratio : views(r) / (srcMedian.get(srcKey(r)) || 1);
  // A client's own posts that beat their benchmark are proven for THIS client —
  // lead with them rather than making them out-compete viral database clips on
  // a raw index they can't win.
  const proven = own.filter((r) => (r._ratio || 0) >= 1).sort((a, b) => b._ratio - a._ratio).slice(0, 4);
  const provenKeys = new Set(proven.map(rowKey));
  // Avatar-aware scoring: performance index × how directly the video speaks
  // to the client's declared target person.
  BRIEF_CTX && (BRIEF_CTX._avatarWords = avatarWords(BRIEF_CTX.avatar));
  const scored = (r) => relative(r) * avatarBoost(r, BRIEF_CTX);
  if (BRIEF_CTX?.avatar || BRIEF_CTX?.audience) {
    notes.push(`Ranking is tilted toward the target avatar${BRIEF_CTX.audience ? ` (<strong>${escapeHtml(BRIEF_CTX.audience)}</strong> tag boosted)` : ""}${BRIEF_CTX._avatarWords?.length ? ` and captions matching: <em>${escapeHtml(BRIEF_CTX._avatarWords.slice(0, 8).join(", "))}</em>` : ""}.`);
  }
  const shelf = proven.concat(
    buildShelf(pool, scored, 24 - proven.length, learning, verdicts)
      .filter((r) => !provenKeys.has(rowKey(r))));

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
            ${r._client ? `<span class="proven" title="This client's own post — beat its benchmark">proven ${ratioLabel(r._ratio)}</span>` : ""}
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
  const attempt = () => fetch(SB_URL + path, {
    ...opts,
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
  const SIGNALS = ",creator_followers,saves,save_ratio,views_to_followers,"
    + "reach_confidence_tier,similar_format_count,avg_views_of_similar";
  let FIELDS = BASE + SIGNALS;
  try {
    await sbFetch(`/rest/v1/lynxr_videos?select=${FIELDS}&limit=1`);
  } catch {
    FIELDS = BASE;
  }
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let batch;
    try {
      batch = await sbFetch(
        `/rest/v1/lynxr_videos?select=${FIELDS}&order=platform.asc,video_id.asc`,
        { headers: { "Range-Unit": "items", Range: `${from}-${from + PAGE - 1}` } });
    } catch (ex) {
      // 416 = asked past the last row (count was an exact multiple of PAGE).
      if (from > 0 && String(ex.message).startsWith("416")) break;
      throw ex;
    }
    rows.push(...(batch || []));
    if (!batch || batch.length < PAGE) break;
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
    // avatar, and a wholesale assignment used to silently destroy the campaign
    // plan fields (videosPerMonth, successViews30d) on every saved brief.
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
// Owner-calibrated expectations (2026-08-03, measured on the Cloey campaign):
//  · cold accounts (first ~10 days): ~530/video measured in week 1
//  · warmed accounts: posts are EXPECTED to average 1–1.5K views
//  · success pace (15K/video avg) comes from breakouts landing ON TOP of
//    this baseline — actual above the band = hits are landing.
const OWNER_COLD = { low: 350, mid: 530, high: 800 };
const OWNER_WARM = { low: 1000, mid: 1250, high: 1500 };

// ---- Train/test calibration ----
// Campaigns marked "training" (Cloey first) TEACH the model; campaigns marked
// "testing" are held out — their bands come only from the trained model, never
// from their own numbers, so the next campaign genuinely validates what the
// training campaigns learned.
const TRAIN_MIN_POSTS = 20;   // below this, the owner's hand-measured band stands
let TRAINED_CACHE = null;     // recomputing per chart-day would re-parse localStorage 31×

/** The warmed band LEARNED from training campaigns: 20th/50th/80th percentile
    of mature (≥7-day-old) post views. Falls back to the owner constants until
    the training pool is big enough to trust. */
function trainedBand() {
  if (TRAINED_CACHE && Date.now() - TRAINED_CACHE.at < 5000) return TRAINED_CACHE.band;
  const vals = [];
  for (const c of loadClients()) {
    if (c.ctx?.calibrationRole !== "training") continue;
    for (const p of c.posts || []) {
      if (!p.checkins.length) continue;
      if ((Date.now() - new Date(p.addedAt).getTime()) / 86400000 < 7) continue;
      vals.push(p.checkins[p.checkins.length - 1].views);
    }
  }
  let band;
  if (vals.length < TRAIN_MIN_POSTS) {
    band = { ...OWNER_WARM, n: vals.length, source: "owner" };
  } else {
    // Enough real data: the data wins in BOTH directions — a trained model
    // that can only agree with or exceed the prior isn't learning.
    vals.sort((a, b) => a - b);
    const q = (f) => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))];
    band = { low: q(0.2), mid: q(0.5), high: q(0.8), n: vals.length, source: "trained" };
  }
  TRAINED_CACHE = { at: Date.now(), band };
  return band;
}

/** Out-of-sample scorecard for a held-out (testing) campaign: how often did
    mature posts land inside the band the model predicted for their posting
    day, and how far off was the middle? This only means anything because
    planRange refuses to fit itself to a testing campaign's own numbers. */
function validationReport(client) {
  if ((client.ctx?.calibrationRole || "") !== "testing") return null;
  const posts = (client.posts || []).filter((p) => p.checkins.length
    && (Date.now() - new Date(p.addedAt).getTime()) / 86400000 >= 7);
  if (posts.length < 5) return { n: posts.length, ready: false };
  let inBand = 0;
  const ratios = [];
  for (const p of posts) {
    const r = planRange(client, p.addedAt);
    if (!r) continue;
    const v = p.checkins[p.checkins.length - 1].views;
    if (v >= r.low && v <= r.high) inBand++;
    ratios.push(v / r.mid);
  }
  return { n: posts.length, ready: true, inBand, hitRate: inBand / posts.length,
           bias: median(ratios) };
}

/** The campaign's REALISTIC per-video expectation at a moment in time — used
    only by campaign-level charts and health, never as a single post's bar.
    Self-calibrating: the MEDIAN view count of the client's own trailing-14-day
    posts sets the baseline (median so one breakout can't ratchet the bar up —
    breakouts are supposed to land ON TOP of the band, not move it), and the
    baseline never drops below the owner-calibrated floor. Testing campaigns
    skip self-calibration entirely — see trainedBand above. */
function planRange(client, atISO) {
  const vpm = client?.ctx?.videosPerMonth;
  if (!vpm) return null;
  const at = atISO ? new Date(atISO).getTime() : Date.now();
  const from = at - 14 * 86400000;
  // If the trailing 14 days run hotter than the owner band, the data wins:
  // expectations ratchet up, never down below the owner floor.
  const COLD = OWNER_COLD;
  const WARM = OWNER_WARM;
  const t0 = new Date(client.createdAt || Date.now()).getTime();
  const campaignDays = (at - t0) / 86400000;
  if (campaignDays < 10) return COLD;
  // Held-out campaign: predict from the TRAINED model only. Fitting the band
  // to this campaign's own trailing numbers would make the test meaningless.
  if (client?.ctx?.calibrationRole === "testing") {
    const t = trainedBand();
    return { low: t.low, mid: t.mid, high: t.high };
  }
  // Two honesty rules for the trailing window: posts must be ≥3 days old at
  // `at` (day-one numbers would drag the baseline down), and only check-ins
  // that existed by `at` count — the band drawn for a past date must not know
  // the future, or historical corridors rise to meet the actual line.
  const vals = (client.posts || []).map((p) => {
    const added = new Date(p.addedAt).getTime();
    if (added < from || added > at - 3 * 86400000) return null;
    let v = null;
    for (const c of p.checkins) if (new Date(c.d).getTime() <= at) v = c.views;
    return v;
  }).filter((v) => v != null);
  // Warmed but data-sparse: hold the owner's warmed band, never the cold one.
  if (vals.length < 5) return WARM;
  const mid = Math.max(WARM.mid, Math.round(median(vals)));
  return { low: Math.max(WARM.low, Math.round(mid * 0.8)),
           mid,
           high: Math.max(WARM.high, Math.round(mid * 1.5)) };
}

function planPerVideo(client, atISO) {
  const r = planRange(client, atISO);
  return r ? r.mid : null;
}

function predictViews(niche, format, hook, client, atISO, platform) {
  // A single post's bar: the client's OWN posted history — their median on the
  // same platform (or format when tagged) — so "beating benchmark" means
  // beating what THIS campaign typically does, not an aspiration.
  let pool = null, own = null;
  const company = client?.company;
  if (company) {
    own = ALL.filter((r) => r.data_source === company);
    if (own.length >= 5) pool = own;
  }
  if (!pool) {
    pool = niche ? ALL.filter((r) => r.niche_category === niche) : ALL;
    if (pool.length < MIN_N_NICHE) pool = ALL;
  }
  let seg = pool.filter((r) => r.format_type === format && r.hook_pattern === hook);
  if (seg.length < 5 && own && platform)
    seg = pool.filter((r) => (r.platform || "").toLowerCase() === platform.toLowerCase());
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
  // Markers earn their place only on sparse series — the viewBox stretches to
  // the container, so on a 20-point series 3px dots render as fat beads.
  // Dense series read as clean lines; sparse ones keep their point markers.
  const showDots = points.length <= 8;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    ${py !== null ? `<line x1="${pad}" y1="${py}" x2="${w - pad}" y2="${py}" class="spark-pred"/>` : ""}
    ${estLine && estSeries.length > 1 ? `<polyline points="${estLine}" class="spark-est"/>` : ""}
    ${estSeries && estSeries.length <= 8 ? estSeries.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2" class="spark-est-dot"/>`).join("") : ""}
    ${points.length > 1 ? `<polyline points="${line}" class="spark-line"/>` : ""}
    ${showDots ? points.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.4" class="spark-dot"/>`).join("")
               : `<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(points[points.length - 1]).toFixed(1)}" r="2.4" class="spark-dot"/>`}
  </svg>`;
}

/** Full chart with x/y axes: dotted estimated slope vs solid actual line.
    Points are {x, y} where x is days since the chart's day zero. */
/** Linear-interpolated value of a series at day x (null if out of range). */
function seriesAt(series, x) {
  if (!series.length) return null;
  const EPS = 1e-6;   // (i+1)*(7/n) lands at 6.999999… for the final point
  if (x < series[0].x - EPS || x > series[series.length - 1].x + EPS) return null;
  for (let i = 1; i < series.length; i++) {
    if (series[i].x >= x) {
      const a = series[i - 1], b = series[i];
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return series[series.length - 1].y;
}

function chartSvg({ actual = [], est = [], estLow = [], estHigh = [], goalLine = [], w = 720, h = 210, xMax = 7, yMax = 1, tone = "", xLabel = "days since brief" }) {
  const banded = estLow.length > 1 && estHigh.length > 1;
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
    <text class="axis-title" text-anchor="middle" x="${padL + (w - padL - padR) / 2}" y="${h - 6}">${xLabel}</text>
    ${banded ? `<polygon points="${poly(estLow)} ${poly([...estHigh].reverse())}" class="chart-band"/>
      <polyline points="${poly(estLow)}" class="line-pred line-band"/>
      <polyline points="${poly(estHigh)}" class="line-pred line-band"/>` : ""}
    ${goalLine.length > 1 ? `<polyline points="${poly(goalLine)}" class="line-goal"/>` : ""}
    ${!banded && est.length > 1 ? `<polyline points="${poly(est)}" class="line-pred"/>` : ""}
    ${!banded ? xTicks.map((d) => {
      const pv = seriesAt(est, d);
      return pv == null ? "" : `<circle cx="${X(d).toFixed(1)}" cy="${Y(pv).toFixed(1)}" r="2.8" class="dot-pred"/>`;
    }).join("") : ""}
    ${actual.length > 1 ? `<polyline points="${poly(actual)}" class="line-actual" pathLength="1"/>` : ""}
    ${xTicks.map((d) => {
      const av = seriesAt(actual, d);
      return av == null ? "" : `<circle cx="${X(d).toFixed(1)}" cy="${Y(av).toFixed(1)}" r="3.4" class="dot-actual"/>`;
    }).join("")}
    ${xTicks.map((d) => {
      const pv = seriesAt(est, d), av = seriesAt(actual, d);
      const half = (w - padL - padR) / (xTicks.length - 1 || 1) / 2;
      return `<rect class="hit" x="${(X(d) - half).toFixed(1)}" y="${padT}"
        width="${(half * 2).toFixed(1)}" height="${(h - padT - padB).toFixed(1)}"
        data-day="${d}" data-x="${X(d).toFixed(1)}"
        data-pred="${pv == null ? "" : Math.round(pv)}"
        data-predlo="${banded && seriesAt(estLow, d) != null ? Math.round(seriesAt(estLow, d)) : ""}"
        data-predhi="${banded && seriesAt(estHigh, d) != null ? Math.round(seriesAt(estHigh, d)) : ""}"
        data-actual="${av == null ? "" : Math.round(av)}"/>`;
    }).join("")}
    <line class="hover-rule" x1="0" y1="${padT}" x2="0" y2="${h - padB}" style="display:none"/>
  </svg>`;
}

/** Three-state read of actual against predicted at the same point in time. */
function paceTone(actual, est, estLow, estHigh) {
  if (!actual.length || !est.length) return { tone: "", label: "" };
  const last = actual[actual.length - 1];
  // With an expected RANGE: judge against the corridor, not a single line.
  if (estLow?.length && estHigh?.length) {
    const lo = seriesAt(estLow, last.x), hi = seriesAt(estHigh, last.x);
    if (lo != null && hi != null && hi > 0) {
      if (last.y > hi) return { tone: "good", label: `▲ above range — ${compact(last.y)} vs ${compact(lo)}–${compact(hi)}` };
      if (last.y < lo) return { tone: "bad", label: `▼ below range — ${compact(last.y)} vs ${compact(lo)}–${compact(hi)}` };
      return { tone: "even", label: `in range — ${compact(last.y)} vs ${compact(lo)}–${compact(hi)}` };
    }
  }
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
/** The expected RANGE for a campaign brief: cumulative floor / mid / ceiling
    curves. The actual line should land inside low–high; mid is the target. */
function weekEstimateBand(rec, client) {
  const vpm = client?.ctx?.videosPerMonth;
  if (!vpm) return null;
  const t0 = new Date(rec.createdAt || Date.now()).getTime();
  // A brief accrues plan volume only over its ACTIVE window — from creation
  // until the next brief takes over (or now). Without the clamp every past
  // brief kept accruing a full month of expectation against one week of
  // posts (drifting to "At risk"), while the old 7-day floor judged a
  // day-old brief against a week it hadn't been given yet.
  const succ = (client.briefs || [])
    .map((b) => new Date(b.createdAt || 0).getTime())
    .filter((t) => t > t0);
  const end = Math.min(Date.now(), succ.length ? Math.min(...succ) : Infinity);
  const days = Math.max(1, Math.min(31, Math.ceil((end - t0) / 86400000)));
  const low = [{ x: 0, y: 0 }], mid = [{ x: 0, y: 0 }], high = [{ x: 0, y: 0 }];
  let cl = 0, cm = 0, ch = 0;
  const daily = vpm / 30.44;
  for (let d = 1; d <= days; d++) {
    const r = planRange(client, new Date(t0 + d * 86400000).toISOString());
    cl += daily * r.low; cm += daily * r.mid; ch += daily * r.high;
    low.push({ x: d, y: Math.round(cl) });
    mid.push({ x: d, y: Math.round(cm) });
    high.push({ x: d, y: Math.round(ch) });
  }
  const success = client?.ctx?.successViews30d
    ? [{ x: 0, y: 0 }, { x: days, y: Math.round((client.ctx.successViews30d / 30) * days) }]
    : [];
  return { low, mid, high, success };
}

function weekEstimateCurve(rec, client) {
  // Campaign clients: the target is volume × warm-up-adjusted per-video goal —
  // the briefed formats set WHAT to post; the campaign plan sets how much.
  const vpm = client?.ctx?.videosPerMonth;
  if (vpm) {
    // The plan spans the brief's actual life — daily volume × the realistic
    // per-video expectation at each day.
    return weekEstimateBand(rec, client).mid;
  }
  const n = rec.items.length || 1;
  const pts = [{ x: 0, y: 0 }];
  let cum = 0;
  rec.items.forEach((it, i) => {
    // An awaiting-ingest item has no real tags — predicting a whole-pool
    // median for an unknown video would inflate the estimate line.
    if (!it._pending) cum += predictViews(client.niche, it.format_type, it.hook_pattern, client, rec.createdAt);
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
  const tracked = (client.posts || []).filter((p) => p.checkins.length);
  if (!tracked.length) return null;
  // Campaign clients: the SAME plan yardstick as the client page — one truth
  // everywhere. Non-campaign clients keep the per-post benchmark sum.
  if (client.ctx?.videosPerMonth) {
    const ch = campaignHealth(client);
    return { actual: ch.actual, predicted: ch.predicted, ratio: ch.ratio,
             good: ch.ratio >= 1, planBased: true };
  }
  const actual = tracked.reduce((a, p) => a + postLatest(p), 0);
  const predicted = tracked.reduce((a, p) => a + (p.predicted || 0), 0) || 1;
  return { actual, predicted, ratio: actual / predicted, good: actual >= predicted };
}

const weekPostsOf = (client, briefId) => client.posts.filter((p) => p.briefId === briefId);

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


/** Hover a day column to compare predicted vs actual at that point. */
function bindChartHover(scope) {
  scope.querySelectorAll(".growth-card").forEach((card) => {
    const svg = card.querySelector(".chart");
    if (!svg || card.querySelector(".chart-tip")) return;
    card.classList.add("has-tip");
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    card.appendChild(tip);
    const rule = svg.querySelector(".hover-rule");
    const vbWidth = svg.viewBox.baseVal.width || 720;

    svg.querySelectorAll(".hit").forEach((hit) => {
      const show = () => {
        const pred = hit.dataset.pred === "" ? null : +hit.dataset.pred;
        const lo = hit.dataset.predlo === "" || hit.dataset.predlo == null ? null : +hit.dataset.predlo;
        const hi = hit.dataset.predhi === "" || hit.dataset.predhi == null ? null : +hit.dataset.predhi;
        const act = hit.dataset.actual === "" ? null : +hit.dataset.actual;
        let tone = "", delta = "";
        if (act != null && lo != null && hi != null) {
          tone = act > hi ? "good" : act < lo ? "bad" : "even";
          delta = act > hi ? "above the expected range"
                : act < lo ? `${Math.round((act / lo) * 100)}% of the range floor`
                : "within the expected range";
        } else if (act != null && pred) {
          const ratio = act / pred;
          tone = ratio >= 1.1 ? "good" : ratio <= 0.9 ? "bad" : "even";
          delta = ratioLabel(ratio);
        }
        tip.innerHTML =
          `<div class="tip-day">Day ${hit.dataset.day}</div>
           <div class="tip-row"><i class="k-est"></i>expected<b>${lo != null && hi != null ? `${compact(lo)}–${compact(hi)}` : (pred == null ? "—" : compact(pred))}</b></div>
           <div class="tip-row"><i class="k-act ${tone}"></i>actual<b class="${tone}">${act == null ? "no check-in" : compact(act)}</b></div>
           ${delta ? `<div class="tip-delta ${tone}">${delta}</div>` : ""}`;
        tip.hidden = false;
        // viewBox x -> rendered px (uniform scale: SVG is full-width, height auto)
        const svgRect = svg.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const scale = svgRect.width / (vbWidth || 1);
        const px = (+hit.dataset.x) * scale + (svgRect.left - cardRect.left);
        tip.style.left = px.toFixed(1) + "px";
        tip.classList.toggle("flip", px > cardRect.width - 150);
        if (rule) {
          rule.setAttribute("x1", hit.dataset.x);
          rule.setAttribute("x2", hit.dataset.x);
          rule.style.display = "";
        }
      };
      const hide = () => { tip.hidden = true; if (rule) rule.style.display = "none"; };
      hit.addEventListener("mouseenter", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", hide);
      hit.addEventListener("blur", hide);
      hit.setAttribute("tabindex", "0");
    });
  });
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
    <div class="brief-stack">` + list.map((c) => {
      const v = clientVerdict(c);
      return `
      <article class="bcard" data-id="${escapeHtml(c.id)}">
        <div class="bcard-main">
          <div class="bcard-title">${escapeHtml(c.company)}</div>
          <div class="lbl">${escapeHtml(c.niche || "All niches")} · ${c.briefs.length} brief${c.briefs.length === 1 ? "" : "s"}
            · ${c.posts.length} post${c.posts.length === 1 ? "" : "s"}</div>
        </div>
        ${v ? `<span class="verdict ${v.good ? "good" : "bad"}">${v.good ? "▲" : "▼"} ${v.planBased ? `${Math.round(v.ratio * 100)}% of plan` : ratioLabel(v.ratio)}</span>` : ""}
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
      deleteClient(id);
      renderBriefs();
    });
  });
}


/** Start next week's brief for a client, carrying their learning across. */

/** One glanceable health read: a ratio, a tone, and a plain label. */
function healthOf(ratio, n) {
  if (!n) return { tone: "idle", dot: "○", label: "Not tracked", ratio: null };
  if (ratio >= 1.25) return { tone: "good", dot: "●", label: "Strong", ratio };
  if (ratio >= 1.0)  return { tone: "good", dot: "●", label: "Healthy", ratio };
  if (ratio >= 0.75) return { tone: "even", dot: "●", label: "On pace", ratio };
  if (ratio >= 0.5)  return { tone: "bad",  dot: "●", label: "Slipping", ratio };
  return { tone: "bad", dot: "●", label: "At risk", ratio };
}

function campaignHealth(client) {
  const tracked = client.posts.filter((p) => p.checkins.length);
  const actual = tracked.reduce((a, p) => a + postLatest(p), 0);
  // Campaign clients: health = the SAME yardstick as the chart — actual views
  // vs the plan accumulated to today. One viral post can't call a behind-pace
  // campaign "Strong" against a pile of medians.
  let predicted, planBased = false;
  const vpm = client.ctx?.videosPerMonth;
  if (vpm) {
    planBased = true;
    // No day cap: actual accumulates over the campaign's whole life, so the
    // plan must too — a capped denominator inflated every campaign to
    // "Strong" from month three onward, mechanically.
    const t0 = new Date(client.createdAt || Date.now()).getTime();
    const days = Math.max(1, Math.ceil((Date.now() - t0) / 86400000));
    predicted = 0;
    for (let d = 1; d <= days; d++)
      predicted += (vpm / 30.44) * planPerVideo(client, new Date(t0 + d * 86400000).toISOString());
    predicted = Math.round(predicted);
  } else {
    predicted = tracked.reduce((a, p) => a + (p.predicted || 0), 0);
  }
  const h = healthOf(predicted ? actual / predicted : 0, tracked.length);
  const beat = tracked.filter((p) => postRatio(p) >= 1).length;
  let successRatio = null;
  if (client.ctx?.successViews30d) {
    const t0 = new Date(client.createdAt || Date.now()).getTime();
    const days = Math.max(1, (Date.now() - t0) / 86400000);
    successRatio = actual / ((client.ctx.successViews30d / 30) * days);
  }
  return { ...h, actual, predicted, planBased, successRatio, posts: tracked.length, beat,
           briefs: client.briefs.length, totalPosts: client.posts.length };
}

function briefHealth(client, briefId) {
  const posts = weekPostsOf(client, briefId);
  const tracked = posts.filter((p) => p.checkins.length);
  const actual = tracked.reduce((a, p) => a + postLatest(p), 0);
  // Campaign clients: a brief's bar is the expected band over ITS window —
  // the same yardstick as its chart, so the card can never contradict it.
  let predicted;
  const rec = client.briefs?.find((b) => b.id === briefId);
  if (client.ctx?.videosPerMonth && rec) {
    const band = weekEstimateBand(rec, client);
    predicted = band ? band.mid[band.mid.length - 1].y : 0;
  } else {
    predicted = tracked.reduce((a, p) => a + (p.predicted || 0), 0);
  }
  const h = healthOf(predicted ? actual / predicted : 0, tracked.length);
  return { ...h, actual, predicted, posts: posts.length, tracked: tracked.length,
           beat: tracked.filter((p) => postRatio(p) >= 1).length };
}

function startNextWeekBrief(client) {
  LEARN_CLIENT = loadClients().find((c) => c.id === client.id) || client;
  BRIEF_CTX = client.ctx && Object.keys(client.ctx).length ? client.ctx
            : { brand: client.company, feats: [], audience: null };
  CART = new Map();
  activateTab("tab-brief");
  renderBrief("").then(() => {
    const b = document.getElementById("ce-brand");
    if (b) b.value = client.company;
    const nSel = document.getElementById("brief-niche");
    if (nSel && client.niche) nSel.value = client.niche;
    const aSel = document.getElementById("ce-audience");
    if (aSel && client.ctx?.audience) aSel.value = client.ctx.audience;
    const fIn = document.getElementById("ce-feats");
    if (fIn && client.ctx?.feats?.length) fIn.value = client.ctx.feats.join(", ");
    const vpmIn = document.getElementById("ce-vpm");
    if (vpmIn && client.ctx?.videosPerMonth) vpmIn.value = client.ctx.videosPerMonth;
    const sIn = document.getElementById("ce-success");
    if (sIn && client.ctx?.successViews30d) sIn.value = client.ctx.successViews30d;
    const roleIn = document.getElementById("ce-calrole");
    if (roleIn && client.ctx?.calibrationRole) roleIn.value = client.ctx.calibrationRole;
    const parts = client.ctx?.avatarParts
      || (client.ctx?.avatar ? { stats: client.ctx.avatar } : null);   // legacy single-field avatars
    if (parts) {
      for (const [key, id] of [["stats", "ce-av-stats"], ["habits", "ce-av-habits"],
                               ["goals", "ce-av-goals"], ["problems", "ce-av-problems"]]) {
        const el = document.getElementById(id);
        if (el && parts[key]) el.value = parts[key];
      }
    }
    document.getElementById("ce-apply")?.click();
  });
}

/** Collapsed avatar card for the client page — there when needed, out of the
    way when not. Renders nothing if no avatar was ever set. */
function avatarBoxHtml(client) {
  const parts = client.ctx?.avatarParts
    || (client.ctx?.avatar ? { stats: client.ctx.avatar } : null);
  if (!parts || !Object.values(parts).some(Boolean)) return "";
  const sections = [
    ["Core statistics", parts.stats], ["Daily habits", parts.habits],
    ["Deep personal goals", parts.goals], ["Major problems", parts.problems],
  ].filter(([, v]) => v);
  return `<details class="avatar-box">
    <summary>Target avatar</summary>
    <div class="avatar-grid">${sections.map(([label, text]) => `
      <div><div class="av-label">${escapeHtml(label)}</div>
        <div class="av-text">${escapeHtml(text)}</div></div>`).join("")}
    </div>
  </details>`;
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
  // Add-by-link lives on the creator app now (creator.html), not here. The
  // agency side only DISPLAYS blueprints the pipeline has already produced —
  // bindBlueprints guards every form element, so dropping the form is safe and
  // retry / copy / delete on existing entries keep working.
  return `<div class="section blueprints-box">
    <h2>Video blueprints <span class="pill">${bps.length}</span></h2>
    <p class="bp-msg" id="bp-msg" role="status" aria-live="polite"></p>
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

/** The client's own mini-database: what THIS campaign's numbers say works.
    Platform medians, the campaign's proven format×hook combos (when tagged),
    and top posts — all from their tracked posts, nothing borrowed from the
    main database. The main database still powers next-brief SUGGESTIONS. */
function clientTrendsHtml(client) {
  const tracked = (client.posts || []).filter((p) => p.checkins.length);
  if (tracked.length < 5) return "";
  const latest = (p) => p.checkins[p.checkins.length - 1].views;

  const byPlat = new Map();
  for (const p of tracked) {
    if (!byPlat.has(p.platform)) byPlat.set(p.platform, []);
    byPlat.get(p.platform).push(p);
  }
  const platRows = [...byPlat.entries()]
    .map(([plat, ps]) => ({ plat, n: ps.length, med: median(ps.map(latest)),
                            top: Math.max(...ps.map(latest)) }))
    .sort((a, b) => b.med - a.med);

  const combos = new Map();
  for (const p of tracked) {
    if (!p.format || !p.hook) continue;
    const k = `${p.format} × ${p.hook}`;
    if (!combos.has(k)) combos.set(k, []);
    combos.get(k).push(latest(p) / (p.predicted || 1));
  }

  // Format × creator: a winning format is often a winning format FOR SOMEONE —
  // the same play can run 2× for one creator and die for another, and the
  // campaign-wide average hides exactly that. A format is only credited to a
  // creator when it ACTUALLY overperforms for them: ≥1.25× benchmark (the
  // same bar the script cards call "push more") on ≥2 posts. Ties and losers
  // are simply absent — this card is the brief-planning shortlist, per creator.
  const fc = new Map();   // format -> Map(creator -> ratios[])
  for (const p of tracked) {
    if (!p.format) continue;
    const cr = (p.creator || "").trim() || "—";
    if (!fc.has(p.format)) fc.set(p.format, new Map());
    const m = fc.get(p.format);
    if (!m.has(cr)) m.set(cr, []);
    m.get(cr).push(latest(p) / (p.predicted || 1));
  }
  const byCreator = new Map();   // creator -> [{format, n, avg}] proven only
  for (const [format, m] of fc) {
    for (const [cr, rs] of m) {
      if (rs.length < 2) continue;
      const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
      if (avg < 1.25) continue;
      if (!byCreator.has(cr)) byCreator.set(cr, []);
      byCreator.get(cr).push({ format, n: rs.length, avg });
    }
  }
  const crRows = [...byCreator.entries()]
    .map(([cr, fs]) => ({ cr, fs: fs.sort((a, b) => b.avg - a.avg) }))
    .sort((a, b) => b.fs[0].avg - a.fs[0].avg)
    .slice(0, 8);
  const comboRows = [...combos.entries()]
    .filter(([, rs]) => rs.length >= 2)
    .map(([k, rs]) => ({ k, n: rs.length, avg: rs.reduce((a, b) => a + b, 0) / rs.length }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 6);

  const top = [...tracked].sort((a, b) => latest(b) - latest(a)).slice(0, 3);

  return `<div class="section client-trends">
    <h2>What works for ${escapeHtml(client.company)} <span class="pill">${tracked.length} posts</span></h2>
    <div class="trends-grid">
      <div class="trend-card">
        <div class="tc-label">By platform — median views</div>
        ${platRows.map((r) => `<div class="tc-row"><span>${escapeHtml(r.plat)}</span>
          <span class="mono">${compact(r.med)} <i class="tc-dim">med</i> · ${compact(r.top)} <i class="tc-dim">top</i> · ${r.n}</span></div>`).join("")}
      </div>
      ${comboRows.length ? `<div class="trend-card">
        <div class="tc-label">Formats proven in this campaign</div>
        ${comboRows.map((r) => `<div class="tc-row ${r.avg >= 1 ? "good" : "bad"}"><span>${escapeHtml(r.k)}</span>
          <span class="mono">${ratioLabel(r.avg)} · ${r.n} posts</span></div>`).join("")}
      </div>` : ""}
      ${crRows.length ? `<div class="trend-card">
        <div class="tc-label">Proven formats by creator <i class="tc-dim">— ≥1.25× on ≥2 posts; brief these again</i></div>
        ${crRows.map((r) => `<div class="tc-row fc-row"><span>${escapeHtml(r.cr)}</span>
          <span class="fc-cells">${r.fs.map((f) =>
            `<span class="verdict good">${escapeHtml(f.format)} · ${ratioLabel(f.avg)} · ${f.n}</span>`).join("")}</span>
        </div>`).join("")}
      </div>` : ""}
      <div class="trend-card">
        <div class="tc-label">Top posts</div>
        ${top.map((p) => {
          const href = safeUrl(p.url);
          const label = escapeHtml((p.caption || p.url).slice(0, 42));
          return `<div class="tc-row"><span>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label}</span>
            <span class="mono">${compact(latest(p))} · ${escapeHtml(p.platform)}</span></div>`;
        }).join("")}
      </div>
    </div>
  </div>`;
}

function renderClientPage(host, client) {
  // Briefs are stored newest-first; number them oldest-first so "Brief 1" is
  // where the client started and the number never changes as weeks are added.
  const total = client.briefs.length;
  const briefNo = (idx) => total - idx;

  // This month's posts, so the client-level graph answers "how is this month
  // going" rather than blending in everything since the account opened.
  const now = new Date();
  const monthKey = now.toISOString().slice(0, 7);
  const monthName = now.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const monthPosts = client.posts.filter((p) =>
    (p.addedAt || "").slice(0, 7) === monthKey || p.checkins.some((c) => c.d.slice(0, 7) === monthKey));

  // The month chart spans the CALENDAR MONTH — x is the day of the month,
  // not days since the first tracked post.
  const day0 = monthKey + "-01T00:00:00Z";
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  // Views EARNED this month, not lifetime totals: a post carried over from a
  // previous month subtracts its last pre-month check-in as a baseline —
  // otherwise a July post at 50K hands August 50K of "actual" on day one.
  const base = new Map();
  for (const p of monthPosts) {
    let b = 0;
    for (const c of p.checkins) if (c.d < day0) b = c.views;
    if (b) base.set(p.id, b);
  }
  const events = monthPosts.flatMap((p) =>
    p.checkins.filter((c) => c.d >= monthKey).map((c) => ({ d: c.d, id: p.id, views: c.views })))
    .sort((a, b) => a.d < b.d ? -1 : 1);
  const seenA = new Map();
  const mActual = [];
  let mEst = [];
  for (const e of events) {
    seenA.set(e.id, Math.max(0, e.views - (base.get(e.id) || 0)));
    mActual.push({ x: daysBetween(e.d, day0), y: [...seenA.values()].reduce((a, b) => a + b, 0) });
  }
  if (mActual.length) mActual.unshift({ x: Math.max(0, mActual[0].x - 1), y: 0 });
  // Predicted: campaign clients get the month's PLAN — daily posting volume ×
  // the warm-up-adjusted per-video target, accumulated across the calendar
  // month. Others fall back to the sum of tracked posts' predicted values.
  const vpm = client.ctx?.videosPerMonth;
  let mLow = [], mHigh = [];
  const mGoal = client.ctx?.successViews30d
    ? [{ x: 0, y: 0 }, { x: daysInMonth, y: Math.round((client.ctx.successViews30d / 30) * daysInMonth) }]
    : [];
  if (vpm) {
    let cl = 0, cm = 0, chi = 0;
    mEst.push({ x: 0, y: 0 }); mLow.push({ x: 0, y: 0 }); mHigh.push({ x: 0, y: 0 });
    for (let d = 1; d <= daysInMonth; d++) {
      const at = new Date(now.getFullYear(), now.getMonth(), d).toISOString();
      const r = planRange(client, at);
      cl += (vpm / 30.44) * r.low; cm += (vpm / 30.44) * r.mid; chi += (vpm / 30.44) * r.high;
      mLow.push({ x: d, y: Math.round(cl) });
      mEst.push({ x: d, y: Math.round(cm) });
      mHigh.push({ x: d, y: Math.round(chi) });
    }
  } else {
    const byId = new Map(monthPosts.map((p) => [p.id, p]));
    const seenE = new Map();
    for (const e of events) {
      seenE.set(e.id, byId.get(e.id)?.predicted || 0);
      mEst.push({ x: daysBetween(e.d, day0), y: [...seenE.values()].reduce((a, b) => a + b, 0) });
    }
    if (mEst.length) mEst.unshift({ x: 0, y: 0 });
    if (!mEst.length && client.briefs.length) mEst = weekEstimateCurve(client.briefs[0], client);
  }
  const mxMax = daysInMonth;
  const myMax = Math.max(1, ...mActual.map((p) => p.y), ...mEst.map((p) => p.y), ...mHigh.map((p) => p.y));
  const mPace = paceTone(mActual, mEst, mLow, mHigh);
  const ch = campaignHealth(client);

  host.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb">
      <button type="button" class="crumb-link" id="cl-back">Clients</button>
      <span class="crumb-sep">›</span>
      <span class="crumb-here">${escapeHtml(client.company)}</span>
    </nav>
    <div class="page-head">
      <div class="bcard-title">${escapeHtml(client.company)}</div>
      <div class="lbl">${escapeHtml(client.niche || "All niches")}${client.ctx?.audience ? " · " + escapeHtml(client.ctx.audience) : ""}</div>
    </div>
    ${avatarBoxHtml(client)}

    <div class="health-row">
      <div class="health-card ${ch.tone}">
        <div class="h-label">Campaign health</div>
        <div class="h-value"><span class="h-dot">${ch.dot}</span>${escapeHtml(ch.label)}</div>
        <div class="h-sub">${ch.ratio != null
          ? (ch.planBased ? `${Math.round(ch.ratio * 100)}% of expected${ch.successRatio != null ? ` · ${Math.round(ch.successRatio * 100)}% of success pace` : ""}` : escapeHtml(ratioLabel(ch.ratio)))
          : "no posts tracked yet"}</div>
      </div>
      <div class="health-card">
        <div class="h-label">Beating benchmark</div>
        <div class="h-value">${ch.beat}<span class="h-of">/${ch.posts || 0}</span></div>
        <div class="h-sub">posts tracked</div>
      </div>
      <div class="health-card">
        <div class="h-label">Views this campaign</div>
        <div class="h-value">${compact(ch.actual)}</div>
        <div class="h-sub">vs ${compact(ch.predicted)} ${ch.planBased ? "plan to date" : "predicted"}</div>
      </div>
      <div class="health-card">
        <div class="h-label">Briefs</div>
        <div class="h-value">${ch.briefs}</div>
        <div class="h-sub">${ch.totalPosts} post${ch.totalPosts === 1 ? "" : "s"} total</div>
      </div>
      ${(() => {
        const vr = validationReport(client);
        if (!vr) return "";
        if (!vr.ready) return `<div class="health-card idle">
          <div class="h-label">Model test — held out</div>
          <div class="h-value">Collecting</div>
          <div class="h-sub">${vr.n}/5 mature posts (≥7 days old)</div>
        </div>`;
        const tone = vr.hitRate >= 0.6 ? "good" : vr.hitRate >= 0.4 ? "even" : "bad";
        return `<div class="health-card ${tone}">
          <div class="h-label">Model test — held out</div>
          <div class="h-value">${Math.round(vr.hitRate * 100)}%<span class="h-of"> in band</span></div>
          <div class="h-sub">median actual = ${Math.round(vr.bias * 100)}% of predicted mid · ${vr.n} posts</div>
        </div>`;
      })()}
    </div>

    <div class="growth-card ${mPace.tone}">
      <div class="growth-head">
        <h2>${escapeHtml(monthName)} — predicted vs actual</h2>
        ${mPace.label ? `<span class="verdict ${mPace.tone}">${escapeHtml(mPace.label)}</span>`
                      : `<span class="lbl">open a brief below and track its posts to start the actual line</span>`}
      </div>
      ${chartSvg({ actual: mActual, est: mEst, estLow: mLow, estHigh: mHigh, goalLine: mGoal, xMax: mxMax, yMax: myMax, tone: mPace.tone, xLabel: "day of the month" })}
      <div class="chart-key">
        <span><i class="k-est"></i> predicted</span>
        <span><i class="k-act"></i> actual</span>
        <span class="lbl">${monthPosts.length} post${monthPosts.length === 1 ? "" : "s"} tracked this month</span>
      </div>
    </div>

    ${clientTrendsHtml(client)}

    ${blueprintsBoxHtml(client)}

    <h2>Briefs <span class="pill">${total}</span></h2>
    ${total ? `<div class="brief-stack">` + client.briefs.map((b, i) => {
      const bh = briefHealth(client, b.id);
      return `
      <article class="bcard ${bh.tone}" data-bid="${escapeHtml(b.id)}">
        <div class="bcard-main">
          <div class="bcard-title">Brief ${briefNo(i)}${i === 0 ? ` <span class="pill">latest</span>` : ""}</div>
          <div class="lbl">${escapeHtml((b.createdAt || "").slice(0, 10))} · ${b.items.length} scripts
            · ${bh.tracked}/${bh.posts} post${bh.posts === 1 ? "" : "s"} tracked${bh.tracked ? ` · ${bh.beat} beating benchmark` : ""}</div>
        </div>
        <span class="health-chip ${bh.tone}"><span class="h-dot">${bh.dot}</span>${escapeHtml(bh.label)}${bh.ratio != null ? ` · ${escapeHtml(ratioLabel(bh.ratio))}` : ""}</span>
        <button type="button" class="btn br-open">Open</button>
        <button type="button" class="ghost br-docx" title="Download as .docx for Google Docs">.docx</button>
        <button type="button" class="ghost br-del">Delete</button>
      </article>`;
    }).join("") + `</div>`
    : `<div class="empty"><p><strong>No briefs yet.</strong></p>
        <p>Build one in the New Client tab — it files here as Brief 1.</p></div>`}

    <div class="nextweek">
      <div class="minw0">
        <h2>Next brief${client.posts.some((p) => p.checkins.length) ? " — learns from tracked posts" : ""}</h2>
        <p class="lbl">${client.posts.some((p) => p.checkins.length)
          ? `Builds on what actually performed for ${escapeHtml(client.company)}: winning formats boosted, misses demoted, and posts that beat benchmark leading the shelf.`
          : `Track posts inside a brief and the next one will learn from what performed.`}</p>
      </div>
      <button type="button" class="btn" id="cl-nextbrief">Build brief ${total + 1}</button>
    </div>`;

  bindChartHover(host);
  bindBlueprints(host, client);
  document.getElementById("cl-back").addEventListener("click", () => {
    CLIENT_VIEW = null; BRIEF_VIEW = null; renderBriefs();
  });
  document.getElementById("cl-nextbrief").addEventListener("click", () => startNextWeekBrief(client));

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
  // Slot-bound posts always belong here; tag matching needs REAL tags on both
  // sides (blank === blank must not count as a match).
  const slotPosts = weekPostsOf(client, rec.id)
    .filter((p) => p.slotIdx === i
      || (row.format_type && row.hook_pattern
          && p.format === row.format_type && p.hook === row.hook_pattern));
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

  // Week chart: estimated slope from the brief's 10 formats (warm-up adjusted)
  // vs the actual cumulative views from check-ins, both on a days-since-brief axis.
  const band = weekEstimateBand(rec, client);
  const est = band ? band.mid : weekEstimateCurve(rec, client);
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
  const yMax = Math.max(1, ...actualPts.map((p) => p.y), ...est.map((p) => p.y), ...(band?.high || []).map((p) => p.y));
  const pace = paceTone(actualPts, est, band?.low, band?.high);

  // Per-script cards: a post binds to its card by SLOT when it was created
  // from that brief item (track-all), falling back to format×hook matching
  // for posts added by hand.
  const scriptCards = rec.items.map((it, i) => {
    // Blank tags match NOTHING — otherwise every untagged post "matches"
    // every untagged slot and all ten cards show identical fake stats.
    const tagged = it.format_type && it.hook_pattern;
    const byTag = tagged
      ? posts.filter((p) => p.format === it.format_type && p.hook === it.hook_pattern)
      : [];
    const bySlot = posts.filter((p) => p.slotIdx === i);
    const matchedAll = [...new Map([...bySlot, ...byTag].map((p) => [p.id, p])).values()];
    const matched = matchedAll.filter((p) => p.checkins.length);
    const pts = matched.map(postLatest);
    const predSeries = matched.map((p) => p.predicted || 0);
    const pred = matched.length ? Math.round(median(predSeries))
                                : predictViews(client.niche, it.format_type, it.hook_pattern, client, rec.createdAt);
    const ratios = matched.map(postRatio);
    const avg = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
    const cls = avg == null ? "" : avg >= 1 ? "good" : "bad";
    const status = avg == null
      ? (matchedAll.length ? "tracked — no check-ins yet" : "untracked")
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

  return {
    dash: `
    <div class="growth-card ${pace.tone}">
      <div class="growth-head">
        <h2>${pace.label ? (pace.tone === "good" ? "Good week — ahead of the predicted slope"
                          : pace.tone === "bad" ? "Behind the predicted slope"
                          : "Tracking the predicted slope") : "This week"}</h2>
        ${pace.label ? `<span class="verdict ${pace.tone}">${escapeHtml(pace.label)}</span>`
                     : `<span class="lbl">the actual line fills in as posts get check-ins</span>`}
      </div>
      ${chartSvg({ actual: actualPts, est, estLow: band?.low || [], estHigh: band?.high || [], goalLine: band?.success || [], xMax, yMax, tone: pace.tone })}
      <div class="chart-key">
        <span><i class="k-est"></i> expected — realistic pace for these accounts</span>
        <span><i class="k-act"></i> actual</span>
      </div>
    </div>

    ${over.length ? `<details class="flag-block good-block"><summary>Overperforming — emphasize these <span class="pill">${over.length}</span></summary><ul class="flag-list">${over.map(postLine).join("")}</ul></details>` : ""}
    ${under.length ? `<details class="flag-block bad-block"><summary>Underperforming — flagged <span class="pill">${under.length}</span></summary><ul class="flag-list">${under.map(postLine).join("")}</ul></details>` : ""}`,
    scripts: `
    <h2>The 10 scripts behind the graph</h2>
    <div class="fmt-grid">${scriptCards}</div>`,
  };
}

function renderBriefViewer(host, rec, client) {
  // briefs are newest-first, so a lower index is a later week
  const total = client.briefs.length;
  const idx = client.briefs.findIndex((b) => b.id === rec.id);
  const trackedThisWeek = weekPostsOf(client, rec.id).some((p) => p.checkins.length);
  const briefPosts = weekPostsOf(client, rec.id);
  const fmtOptions = [...new Set(ALL.map((r) => r.format_type).filter(Boolean))].sort();
  const hookOptions = [...new Set(ALL.map((r) => r.hook_pattern).filter(Boolean))].sort();
  if (BRIEF_VIEW.expanded != null)
    BRIEF_VIEW.expanded = Math.max(0, Math.min(BRIEF_VIEW.expanded, rec.items.length - 1));
  const dash = weekDashboardHtml(rec, client);
  host.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb">
      <button type="button" class="crumb-link" id="bv-clients">Clients</button>
      <span class="crumb-sep">›</span>
      <button type="button" class="crumb-link" id="bv-back">${escapeHtml(client?.company || "Back")}</button>
      <span class="crumb-sep">›</span>
      <span class="crumb-here">Brief ${total - idx}</span>
      <div class="spacer"></div>
      <button type="button" class="ghost week-arrow" id="wk-prev" ${idx >= total - 1 ? "disabled" : ""}
        title="${idx >= total - 1 ? "No earlier brief" : "Earlier brief"}">←</button>
      <button type="button" class="ghost week-arrow" id="wk-next" ${idx <= 0 ? "disabled" : ""}
        title="${idx <= 0 ? "No later brief" : "Later brief"}">→</button>
      <button type="button" class="ghost" id="bv-docx">.docx</button>
    </nav>
    <div class="page-head">
      <div class="bcard-title">Brief ${total - idx} <span class="pill">${total - idx} of ${total}</span></div>
      <div class="lbl">${escapeHtml(rec.company)} · ${escapeHtml((rec.createdAt || "").slice(0, 10))}</div>
    </div>
    ${dash.dash}

    <details class="flag-block posts-block">
    <summary>Posts from this brief <span class="pill">${briefPosts.length}</span></summary>
    ${(() => {
      const have = new Set(client.posts.filter((p) => p.url).map((p) => canonUrl(p.url)));
      const untracked = rec.items.filter((it) => it.url && !have.has(canonUrl(it.url))).length;
      return untracked ? `<div class="track-all-row">
        <button type="button" class="btn" id="pf-track-all">Track all ${untracked} brief video${untracked === 1 ? "" : "s"}</button>
        <span class="note">each one becomes a tracked post bound to its script card — check in with views below</span>
      </div>` : "";
    })()}
    <form class="post-form" id="post-form">
      <input type="url" id="pf-url" placeholder="Paste the post link — we'll read and tag it" required>
      <button type="submit" class="btn" id="pf-add">Add &amp; auto-tag</button>
    </form>
    <p class="note" id="pf-note">Paste a TikTok, YouTube, or Instagram link — the caption and creator
      are read from the post and tagged automatically. Format and hook stay editable on the row. The benchmark
      locks in on add; check in with views to plot the actual line above.</p>
    <div class="post-list">${briefPosts.map((p) => {
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
    }).join("")}</div>
    </details>

    ${dash.scripts}`;

  bindChartHover(host);
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
  // Track-all: every brief item with a URL that isn't already a tracked post
  // becomes one, bound to its script slot (slotIdx) so the card shows ITS
  // video even while tags are blank awaiting ingestion. Benchmarks lock from
  // the item's tags, or auto-tagging its caption when the tags are blank —
  // same rule as the by-hand form.
  const trackAllBtn = document.getElementById("pf-track-all");
  if (trackAllBtn) trackAllBtn.addEventListener("click", () => {
    const fresh = loadClients();
    const c = fresh.find((x) => x.id === client.id);
    if (!c) return;
    const have = new Set(c.posts.filter((p) => p.url).map((p) => canonUrl(p.url)));
    let added = 0;
    rec.items.forEach((it, i) => {
      if (!it.url || have.has(canonUrl(it.url))) return;
      const { format, hook } = it.format_type && it.hook_pattern
        ? { format: it.format_type, hook: it.hook_pattern }
        : autoTag(it.title || "", it.platform);
      c.posts.unshift({
        id: newId(), url: it.url, creator: it.creator || "",
        caption: it.title || "", thumb: "", platform: it.platform || "",
        format, hook, predicted: predictViews(c.niche, format, hook, c, null, it.platform),
        briefId: rec.id, slotIdx: i,
        addedAt: new Date().toISOString(), checkins: [],
      });
      have.add(canonUrl(it.url));
      added++;
    });
    if (added) { persistClients(fresh); renderBriefs(); }
  });

  const postForm = document.getElementById("post-form");
  if (postForm) {
    postForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const url = normalizeClientUrl(document.getElementById("pf-url").value);
      const note = document.getElementById("pf-note");
      const btn = document.getElementById("pf-add");
      if (!url) { note.textContent = "That doesn't look like a post link."; return; }
      btn.disabled = true; btn.textContent = "Reading post…";
      let meta = { caption: "", creator: "", platform: "" };
      try { meta = await fetchPostMeta(url); }
      catch { note.textContent = "Couldn't read that post — tagged from the link only; correct it on the row."; }
      const { format, hook } = autoTag(meta.caption, meta.platform);
      const fresh = loadClients();
      const c = fresh.find((x) => x.id === client.id);
      c.posts.unshift({
        id: newId(), url, creator: meta.creator || "",
        caption: meta.caption || "", thumb: meta.thumb || "", platform: meta.platform || "",
        format, hook, predicted: predictViews(c.niche, format, hook, c, null, meta.platform),
        briefId: rec.id,                       // implicit: the brief you're inside
        addedAt: new Date().toISOString(), checkins: [],
      });
      persistClients(fresh);
      renderBriefs();
    });
  }

  host.querySelectorAll(".post-row").forEach((rowEl) => {
    const pid = rowEl.dataset.pid;
    rowEl.querySelector(".checkin-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const n = parseNum(rowEl.querySelector(".ci-views").value);
      if (isNaN(n)) { rowEl.querySelector(".ci-views").select(); return; }
      const fresh = loadClients();
      const post = fresh.find((x) => x.id === client.id)?.posts.find((x) => x.id === pid);
      if (!post) return;
      post.checkins.push({ d: new Date().toISOString().slice(0, 10), views: n });
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
        post.predicted = predictViews(client.niche, post.format, post.hook, client, post.addedAt, post.platform);
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
  // Client-tracked rows are scored against the benchmark they were measured
  // against; source-normalising them would divide them by themselves.
  const relative = (r) => (r._client && r._ratio != null)
    ? r._ratio : views(r) / (srcMedian.get(srcKey(r)) || 1);
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
        <label class="ce-field"><span class="lbl">Campaign plan — videos / month (blank = no campaign yardstick)</span>
          <input type="number" id="ce-vpm" min="1" step="1" value="${BRIEF_CTX?.videosPerMonth || ""}" placeholder="e.g. 90"></label>
        <label class="ce-field"><span class="lbl">Success target — views / 30 days for THIS client</span>
          <input type="text" id="ce-success" value="${BRIEF_CTX?.successViews30d || ""}" placeholder="e.g. 300K (3M ÷ 10 creators)"></label>
        <label class="ce-field"><span class="lbl">Calibration role — how this campaign relates to the model</span>
          <select id="ce-calrole">
            <option value=""${!BRIEF_CTX?.calibrationRole ? " selected" : ""}>Auto — self-calibrating</option>
            <option value="training"${BRIEF_CTX?.calibrationRole === "training" ? " selected" : ""}>Training — teaches the model (Cloey)</option>
            <option value="testing"${BRIEF_CTX?.calibrationRole === "testing" ? " selected" : ""}>Testing — held out, validates the model</option>
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
    const videosPerMonth = Math.max(0, parseInt(document.getElementById("ce-vpm")?.value, 10) || 0) || null;
    const successRaw = (document.getElementById("ce-success")?.value || "").trim();
    const successViews30d = successRaw ? (parseNum(successRaw) || null) : null;
    const calibrationRole = document.getElementById("ce-calrole")?.value || "";
    BRIEF_CTX = (brand || feats.length || audience || avatar || videosPerMonth || successViews30d)
      ? { brand: brand || "the product", feats, audience, avatar, avatarParts,
          videosPerMonth, successViews30d, calibrationRole }
      : BRIEF_CTX;
    // Collapse the editor into a one-line summary; Edit re-opens it.
    const chips = [
      BRIEF_CTX?.brand, niche || "All niches", BRIEF_CTX?.audience,
      BRIEF_CTX?.feats?.length ? `${BRIEF_CTX.feats.length} features` : null,
      BRIEF_CTX?.avatar ? "avatar set" : null,
      BRIEF_CTX?.videosPerMonth ? `${BRIEF_CTX.videosPerMonth}/mo plan` : null,
      BRIEF_CTX?.successViews30d ? `${compact(BRIEF_CTX.successViews30d)}/30d target` : null,
      BRIEF_CTX?.calibrationRole ? `model: ${BRIEF_CTX.calibrationRole}` : null,
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

