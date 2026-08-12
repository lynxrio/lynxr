/* lynxr — creator side.

   A RAIL AND A PANE, not a tabbed page. Brands live in the rail the way
   conversations do in a chat app: pick one and the pane fills with its scripts,
   with a composer pinned at the foot to send the next link. Above them sits
   LIBRARY — every original video the creator has ever sent, kept exactly once
   for the whole account, listing which brands each one turned into a script
   for. A video belongs to the creator, not to a brand, which is why the same
   link scripted for three brands is still one row there.

   Theme is the agency app's, deliberately: same palette, same Share Tech Mono,
   same dot grid, same chip / bp-item / client-editor vocabulary out of the
   shared app.css. Only the furniture is rearranged.

   Deliberately a SEPARATE app from the agency side. Spec §1.1 and §20 require
   that a creator never sees another creator's numbers, the agency dashboard, or
   client business data — so this file never touches lynxr_clients or
   lynxr_videos, and its own table (lynxr_creators) is owner-only at the
   database level, not merely hidden in the UI.

   Naming note: the UI says "brand", the stored key is `brands[]` — the same
   thing the worker reads (brand_digest in process_adaptations.py).

   Scoping note (spec §6.3): the randomized CONTROL arm is an agency-campaign
   mechanic. A self-serve creator came here for a script, so withholding one on
   30% of posts would be a hostile product. Lift for creators is measured the
   §11 fallback way — against their own non-Lynxr posts — and the control arm
   stays on the agency side where Lynx owns the brief slots. */

// ---------- shared helpers (kept in sync with app.js on purpose) ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeUrl(u) {
  try {
    const p = new URL(String(u), location.origin);
    return (p.protocol === "http:" || p.protocol === "https:") ? p.href : "";
  } catch { return ""; }
}
function normalizeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes("://") ? s : "https://" + s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.href;
  } catch { return null; }
}
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
const platformLabel = (u) => /tiktok\.com/.test(u) ? "TikTok"
  : /instagram\.com/.test(u) ? "Instagram"
  : /youtube\.com|youtu\.be/.test(u) ? "YouTube" : "Link";
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const listOf = (xs) => xs.length < 2 ? (xs[0] || "")
  : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function agoLabel(iso) {
  const t = new Date(iso || 0).getTime();
  if (!t) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return String(iso).slice(0, 10);
}

/** Two-click delete. `confirm()` is unusable here — browsers suppress repeated
    dialogs and then return false instantly, so a "confirmation" silently stops
    confirming. Copied from app.js so both apps disarm identically. */
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

/** Short, speakable, unambiguous code for the creator to say on camera —
    spec §6.2. This is the one attribution path that works today with no
    router and no platform cooperation: the viewer types it, the brand reports
    the redemption, and that conversion is exactly attributed to this video.
    No I/O/0/1 — they get misheard and mistyped. */
function trackCode(brandName) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let tail = "";
  for (let i = 0; i < 4; i++) tail += abc[Math.floor(Math.random() * abc.length)];
  const head = String(brandName || "LYNX").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) || "LYNX";
  return `${head}${tail}`;
}

// ---------- Supabase ----------
const SB_URL = "https://esakjfogplfszievvabi.supabase.co";
const SB_KEY = "sb_publishable_pTFNX2B94PE_DFLL799w4A_4VcH2xTN";
const SB_SESSION_KEY = "lynxr_creator_session";

let SB_TOKEN = null, SB_EMAIL = null, SB_UID = null, SB_REFRESHING = null;
let SYNC_OK = false;
// library[] is every video the creator has sent, ONE entry per video for the
// whole account — a video belongs to them, not to a brand, so the same link
// scripted for three brands is still one row here.
// adaptations[] are the scripts — kept as a flat top-level array because that
// is exactly what the worker iterates; nesting them inside brands would break
// pipeline/process_adaptations.py.
const BLANK_ME = { name: "", niches: [], brands: [], adaptations: [], library: [] };
let ME = { ...BLANK_ME };

const saveSession = (s) => { try { localStorage.setItem(SB_SESSION_KEY, JSON.stringify(s)); } catch {} };
const loadSession = () => { try { return JSON.parse(localStorage.getItem(SB_SESSION_KEY)); } catch { return null; } };
const clearSession = () => { try { localStorage.removeItem(SB_SESSION_KEY); } catch {} };

function adoptSession(sess, fallbackEmail) {
  SB_TOKEN = sess.access_token;
  SB_EMAIL = sess.user?.email || fallbackEmail || SB_EMAIL;
  SB_UID = sess.user?.id || SB_UID;
  saveSession(sess);
}

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
  adoptSession(await res.json(), email);
}

/** Self-serve account creation. Returns "in" when Supabase handed back a
    session (email confirmation is off — go straight into the app) or "confirm"
    when it didn't.

    "confirm" covers two cases on purpose. The honest one is a genuinely new
    address awaiting its confirmation link. The other is an address that already
    has an account: Supabase answers that with a decoy user carrying no
    identities, deliberately, so this endpoint can't be used to find out who has
    an account here. Telling the two apart would undo that, so both get the same
    "check your email" answer. */
async function sbSignUp(email, password) {
  // Tell Supabase where the confirmation link should land, per signup, instead
  // of relying on the project's single Site URL. That setting pointed at
  // localhost, so every confirmation email sent a real user to a page only the
  // developer's laptop could serve. location.origin is whatever host actually
  // served this page, so the link always comes back to the same deployment.
  const back = encodeURIComponent(location.origin + "/creator.html");
  const res = await fetch(`${SB_URL}/auth/v1/signup?redirect_to=${back}`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.msg || body.message || "Sign-up failed");
  if (body.access_token) { adoptSession(body, email); return "in"; }
  return "confirm";
}

function signupError(raw) {
  const s = String(raw || "");
  if (/already registered|already been registered|user already/i.test(s))
    return "That email already has an account — sign in instead.";
  if (/password/i.test(s) && /short|least|weak|characters/i.test(s))
    return "That password is too short — use at least 8 characters.";
  if (/valid email|invalid.*email|email.*invalid|unable to validate/i.test(s))
    return "That doesn't look like a valid email address.";
  if (/rate|too many|429|for security purposes/i.test(s))
    return "Too many attempts — wait a minute and try again.";
  if (/signups? not allowed|signup.*disabled|not allowed for this instance/i.test(s))
    return "Sign-ups are closed right now — ask Lynx for an invite.";
  return "Couldn't create the account — check your connection and try again.";
}

async function sbRefresh(refresh_token) {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token }),
  });
  if (!res.ok) throw new Error("refresh failed");
  adoptSession(await res.json());
}

/** Access tokens expire hourly; refresh once and retry rather than dumping the
    creator back to the login screen mid-session. */
async function sbFetch(path, opts = {}) {
  const attempt = () => fetch(SB_URL + path, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_TOKEN || SB_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  let res = await attempt();
  if (res.status === 401 && loadSession()?.refresh_token) {
    try {
      SB_REFRESHING = SB_REFRESHING
        || sbRefresh(loadSession().refresh_token).finally(() => { SB_REFRESHING = null; });
      await SB_REFRESHING;
      res = await attempt();
    } catch { /* fall through to the normal error */ }
  }
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  const text = await res.text();          // writes come back 200 with an empty body
  return text ? JSON.parse(text) : null;
}

// ---------- persistence ----------
// One row per creator, keyed on auth.uid(); RLS makes it unreachable by anyone
// else. Saves are debounced because typing in a company form fires constantly.
let SAVE_T = null;
function save({ now = false } = {}) {
  renderSyncBadge("saving");
  clearTimeout(SAVE_T);
  const run = async () => {
    try {
      await sbFetch("/rest/v1/lynxr_creators", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: SB_UID, data: ME }),
      });
      SYNC_OK = true;
    } catch { SYNC_OK = false; }
    renderSyncBadge();
  };
  if (now) return run();
  SAVE_T = setTimeout(run, 800);
  return Promise.resolve();
}

/** Fill in anything a stored row predates, and return whether it changed —
    the caller saves only when it did, so a clean row costs no write. The
    library shipped after scripts did, so every existing adaptation needs a
    library entry retrofitted or a creator's earlier pastes would be missing
    from the company folder they now browse. */
function normalizeMe() {
  ME = { ...BLANK_ME, ...ME };
  let changed = false;
  for (const k of ["niches", "brands", "adaptations", "library"]) {
    if (!Array.isArray(ME[k])) { ME[k] = []; changed = true; }
  }

  // The Library holds one entry per VIDEO, account-wide. An earlier build kept
  // a separate copy per brand, so the same link sent to three brands showed up
  // three times — collapse those onto the oldest entry and repoint its scripts.
  const byCanon = new Map();
  const merged = [];
  for (const l of ME.library) {
    const keep = byCanon.get(l.canon);
    if (!keep) { byCanon.set(l.canon, l); merged.push(l); continue; }
    keep.title = keep.title || l.title;
    keep.creator = keep.creator || l.creator;
    keep.caption = keep.caption || l.caption;
    if (l.addedAt && (!keep.addedAt || l.addedAt < keep.addedAt)) keep.addedAt = l.addedAt;
    for (const a of ME.adaptations) if (a.libraryId === l.id) a.libraryId = keep.id;
    changed = true;
  }
  ME.library = merged;
  for (const l of ME.library) {
    if ("brandId" in l) { delete l.brandId; changed = true; }   // a video is not a brand's
    if ("note" in l && !l.note) { delete l.note; changed = true; }
  }

  // Every script needs a Library entry behind it, including ones written before
  // the Library existed.
  for (const a of ME.adaptations) {
    if (!a.sourceUrl) continue;
    const key = canonUrl(a.sourceUrl);
    let item = byCanon.get(key);
    if (!item) {
      item = {
        id: newId(), url: a.sourceUrl, canon: key, platform: platformLabel(a.sourceUrl),
        title: a.title || "", creator: "", caption: "",
        addedAt: a.addedAt || new Date().toISOString(),
      };
      byCanon.set(key, item);
      ME.library.push(item);
      changed = true;
    }
    if (a.libraryId !== item.id) { a.libraryId = item.id; changed = true; }
  }
  return changed;
}

async function pull() {
  const rows = await sbFetch(`/rest/v1/lynxr_creators?id=eq.${SB_UID}&select=data`);
  if (rows && rows[0]?.data) ME = { ...BLANK_ME, ...rows[0].data };
  SYNC_OK = true;
  if (normalizeMe()) save();
}

function renderSyncBadge(state) {
  const el = document.getElementById("sync-state");
  if (!el) return;
  // The rail already prints the address underneath, so the badge is just the
  // state — repeating the email there read as a second account.
  el.className = "sync-state " + (state === "saving" ? "" : SYNC_OK ? "ok" : "bad");
  el.textContent = state === "saving" ? "● saving" : SYNC_OK ? "● synced" : "● not syncing";
}

// ---------- transient messages ----------
const MSG_T = new Map();
function flashMsg(elId, text, tone) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className = `${el.id === "composer-note" ? "composer-note" : "bp-msg"} show${tone ? " " + tone : ""}`;
  clearTimeout(MSG_T.get(elId));
  MSG_T.set(elId, setTimeout(() => {
    const e2 = document.getElementById(elId);
    if (e2) e2.className = e2.id === "composer-note" ? "composer-note" : "bp-msg";
  }, 5000));
}
const say = (text, tone) => flashMsg("composer-note", text, tone);

// ---------- slices ----------
const brandScripts = (b) => ME.adaptations.filter((a) => a.brandId === b.id);

/** Every script written from one saved video, across all brands. Matched on
    libraryId, falling back to canonical URL for rows backfilled from before
    the library existed. */
function libScripts(item) {
  return ME.adaptations.filter((a) => a.libraryId === item.id
    || (!a.libraryId && a.sourceUrl && canonUrl(a.sourceUrl) === item.canon));
}

const brandById = (id) => ME.brands.find((b) => b.id === id);

// ---------- view routing ----------
// One rail, one pane. VIEW says what the pane is showing; nothing else does.
let VIEW = { kind: "library" };

function go(view) {
  // The picker follows you: landing in a brand selects that brand and nothing
  // else, so the common case (send this link here) needs no clicks at all.
  if (view.kind !== "brand" || view.id !== VIEW.id) COMPOSE_FOR = null;
  VIEW = view;
  document.body.classList.remove("side-open");
  renderSide();
  renderPane();
  const s = document.getElementById("pane-scroll");
  if (s) s.scrollTop = 0;
}

function renderSide() {
  document.getElementById("side-who").textContent = SB_EMAIL || "";
  document.getElementById("nav-library-n").textContent = ME.library.length || "";
  document.getElementById("nav-library").classList.toggle("on", VIEW.kind === "library");
  document.getElementById("nav-you").classList.toggle("on", VIEW.kind === "you");

  const host = document.getElementById("side-list");
  if (!ME.brands.length) {
    host.innerHTML = `<p class="side-empty">No brands yet — add the first company you make videos for.</p>`;
    return;
  }
  host.innerHTML = ME.brands.map((b) => {
    const n = brandScripts(b).length;
    const on = VIEW.kind === "brand" && VIEW.id === b.id;
    return `<button type="button" class="side-item${on ? " on" : ""}" data-bid="${escapeHtml(b.id)}">
      <span class="side-label">${escapeHtml(b.name || "Untitled brand")}</span>
      <span class="side-count">${n || ""}</span>
    </button>`;
  }).join("");
  host.querySelectorAll(".side-item").forEach((el) =>
    el.addEventListener("click", () => go({ kind: "brand", id: el.dataset.bid })));
}

function renderPane() {
  const head = document.getElementById("pane-head");
  const body = document.getElementById("pane-body");
  const composer = document.getElementById("composer");
  composer.hidden = VIEW.kind !== "brand";
  if (VIEW.kind === "brand") renderComposeFor();

  if (VIEW.kind === "you") return renderYou(head, body);
  if (VIEW.kind === "brand") {
    const b = brandById(VIEW.id);
    if (b) return renderBrand(head, body, b);
    VIEW = { kind: "library" };            // deleted on another device
    composer.hidden = true;
  }
  return renderLibrary(head, body);
}

function addBrand() {
  const b = { id: newId(), name: "", site: "", description: "", objective: "",
              niche: "", code: trackCode("LYNX") };
  ME.brands.push(b);
  save();
  go({ kind: "brand", id: b.id });
  const first = document.querySelector("#pane-body .b-name");
  if (first) { first.focus(); }
}

// ---------- brand view ----------
function renderBrand(head, body, b) {
  const scripts = brandScripts(b);
  const ready = scripts.filter((a) => a.status === "done" && a.adaptation).length;
  const writing = scripts.filter((a) => a.status === "queued").length;

  head.innerHTML = `
    <button type="button" class="ghost side-toggle" id="side-open">☰ Brands</button>
    <div class="pane-title">
      <div class="bcard-title" id="brand-heading">${escapeHtml(b.name || "Untitled brand")}</div>
      ${writing ? `<span class="chip bp-wait"><i class="bp-dot"></i>${writing} writing</span>`
        : ready ? `<span class="chip good">${plural(ready, "script")}</span>` : ""}
      <div class="spacer"></div>
      <button type="button" class="ghost" id="brand-details">Details</button>
    </div>
    <p class="pane-sub" id="brand-sub">${escapeHtml(b.niche || "No niche set")}${
      b.objective ? " · " + escapeHtml(b.objective) : ""} · ${plural(scripts.length, "script")}</p>`;

  body.innerHTML = `
    <div class="section client-editor collapsed" id="brand-editor">
      <div class="ce-body">
        <p class="lbl">These go to the model with every link you send, so the more specific they
          are, the better the script.</p>
        <div class="ce-grid">
          <label class="ce-field"><span class="lbl">Brand name</span>
            <input type="text" class="b-name" value="${escapeHtml(b.name || "")}" placeholder="e.g. Medceptor"></label>
          <label class="ce-field"><span class="lbl">Website</span>
            <input type="url" class="b-site" value="${escapeHtml(b.site || "")}" placeholder="https://…"></label>
          <label class="ce-field ce-wide"><span class="lbl">What is it?</span>
            <input type="text" class="b-desc" value="${escapeHtml(b.description || "")}"
              placeholder="e.g. NCLEX practice questions for nursing students"></label>
          <label class="ce-field"><span class="lbl">Campaign objective</span>
            <input type="text" class="b-obj" value="${escapeHtml(b.objective || "")}" placeholder="e.g. free-trial signups"></label>
          <label class="ce-field"><span class="lbl">Niche</span>
            <input type="text" class="b-niche" value="${escapeHtml(b.niche || "")}" placeholder="e.g. Education"></label>
        </div>
        <div class="bp-actions"><button type="button" class="ghost b-del">Delete this brand</button></div>
      </div>
    </div>
    <h2>Scripts <span class="pill">${scripts.length}</span></h2>
    <div id="ad-list"></div>`;

  document.getElementById("side-open").addEventListener("click", () =>
    document.body.classList.toggle("side-open"));

  const editor = document.getElementById("brand-editor");
  const toggle = document.getElementById("brand-details");
  if (!b.name) editor.classList.remove("collapsed");
  const syncToggle = () => { toggle.textContent = editor.classList.contains("collapsed") ? "Details" : "Done"; };
  syncToggle();
  toggle.addEventListener("click", () => { editor.classList.toggle("collapsed"); syncToggle(); });

  // Bind, don't re-render — the creator is mid-word in these fields.
  const bind = (sel, key) => editor.querySelector(sel).addEventListener("input", (e) => {
    b[key] = e.target.value;
    if (key === "name") {
      document.getElementById("brand-heading").textContent = b.name || "Untitled brand";
      renderSide();
    }
    save();
  });
  bind(".b-name", "name"); bind(".b-site", "site"); bind(".b-desc", "description");
  bind(".b-obj", "objective"); bind(".b-niche", "niche");

  // Deleting a brand takes its scripts. The videos stay in the Library —
  // they were yours before any brand existed, and they outlive it.
  armDelete(editor.querySelector(".b-del"), "Delete this brand", () => {
    ME.brands = ME.brands.filter((x) => x.id !== b.id);
    ME.adaptations = ME.adaptations.filter((a) => a.brandId !== b.id);
    save({ now: true });
    go(ME.brands.length ? { kind: "brand", id: ME.brands[0].id } : { kind: "library" });
  });

  renderScripts(b);
}

// ---------- library view ----------
// Every original video ever sent, once. A video belongs to the creator, not to
// a brand: the same link can end up scripted for three of them and it is still
// one entry here, listing where it went.
let LIB_Q = "";

function renderLibrary(head, body) {
  head.innerHTML = `
    <button type="button" class="ghost side-toggle" id="side-open">☰ Brands</button>
    <div class="pane-title">
      <div class="bcard-title">Library</div>
      <span class="pill">${ME.library.length}</span>
    </div>
    <p class="pane-sub">Every video you've sent, kept once — with the scripts each one turned into.</p>`;

  document.getElementById("side-open").addEventListener("click", () =>
    document.body.classList.toggle("side-open"));

  if (!ME.library.length) {
    body.innerHTML = `<div class="empty"><p><strong>Nothing here yet.</strong></p>
      <p>Open a brand and paste a link at the bottom. Every video you send lands here,
      whichever brand you sent it for.</p></div>`;
    return;
  }

  const q = LIB_Q.trim().toLowerCase();
  const shown = ME.library.filter((it) => !q || [it.title, it.caption, it.creator, it.url]
    .some((v) => String(v || "").toLowerCase().includes(q)));

  body.innerHTML = `
    ${ME.library.length >= 4 ? `<div class="lib-tools">
      <input type="search" id="lib-q" placeholder="Search titles, captions, creators"
        autocomplete="off" spellcheck="false" value="${escapeHtml(LIB_Q)}">
      <span class="lib-shown">${shown.length === ME.library.length ? "" : `${shown.length} of ${ME.library.length}`}</span>
    </div>` : ""}
    ${shown.length ? `<div class="bp-list">${shown.map(libraryItemHtml).join("")}</div>`
      : `<div class="empty"><p>Nothing in your library matches that.</p></div>`}`;

  const qEl = document.getElementById("lib-q");
  if (qEl) qEl.addEventListener("input", (e) => {
    LIB_Q = e.target.value;
    renderLibrary(head, body);
    const again = document.getElementById("lib-q");
    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  });

  body.querySelectorAll(".lib-item").forEach((card) => {
    const item = ME.library.find((l) => l.id === card.dataset.lid);
    if (!item) return;
    card.querySelectorAll(".lib-jump").forEach((btn) => btn.addEventListener("click", () => {
      const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
      if (!a) return;
      go({ kind: "brand", id: a.brandId });
      const target = document.querySelector(`#ad-list [data-adid="${CSS.escape(a.id)}"]`);
      if (target) { target.open = true; target.scrollIntoView({ block: "center" }); }
    }));
    armDelete(card.querySelector(".l-del"), "Remove from library", () => {
      ME.library = ME.library.filter((l) => l.id !== item.id);
      save();
      renderSide();
      renderLibrary(head, body);
    });
  });
}

function libraryItemHtml(item) {
  const made = libScripts(item);
  const href = safeUrl(item.url || "");
  const waiting = made.filter((a) => a.status === "queued").length;
  const done = made.filter((a) => a.status === "done").length;
  const chip = !made.length ? `<span class="chip">not scripted</span>`
    : waiting ? `<span class="chip bp-wait"><i class="bp-dot"></i>writing ${waiting}</span>`
    : done ? `<span class="chip good">${plural(done, "script")}</span>`
    : `<span class="chip bad">couldn't fetch</span>`;

  return `<details class="bp-item lib-item" data-lid="${escapeHtml(item.id)}">
    <summary>
      <span class="bp-caret" aria-hidden="true">▸</span>
      <span class="bp-name">${escapeHtml(sourceLabel(item))}</span>
      <span class="chip lib-plat">${escapeHtml(item.platform || "Link")}</span>
      ${chip}
      <span class="bp-when">${escapeHtml(agoLabel(item.addedAt))}</span>
      ${href ? `<a class="bp-open" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open the original">↗</a>` : ""}
    </summary>
    <div class="bp-body">
      ${item.creator ? `<p class="bp-hint">@${escapeHtml(item.creator)}</p>` : ""}
      ${item.caption ? `<p class="bp-hint lib-cap">${escapeHtml(item.caption)}</p>` : ""}
      ${made.length ? `<div class="bp-heading">Scripts from this</div>
        <ul class="lib-made">${made.map((a) => `
          <li><button type="button" class="linkish lib-jump" data-adid="${escapeHtml(a.id)}">${
            escapeHtml(a.brandName || "Brand")}</button>
            <span class="lib-made-state">${a.status === "done" ? "ready"
              : a.status === "error" ? "couldn't fetch" : "being written"}</span></li>`).join("")}</ul>`
        : `<p class="bp-hint">No script from this one yet — open a brand and send the link again.</p>`}
      <div class="bp-actions"><button type="button" class="ghost l-del">Remove from library</button></div>
    </div>
  </details>`;
}

// ---------- you ----------
function renderYou(head, body) {
  head.innerHTML = `
    <button type="button" class="ghost side-toggle" id="side-open">☰ Brands</button>
    <div class="pane-title"><div class="bcard-title">You</div></div>
    <p class="pane-sub">Goes to the model with every script, so it sounds like you.</p>`;
  document.getElementById("side-open").addEventListener("click", () =>
    document.body.classList.toggle("side-open"));

  body.innerHTML = `
    <div class="section">
      <div class="ce-grid">
        <label class="ce-field"><span class="lbl">Your name</span>
          <input type="text" id="me-name" value="${escapeHtml(ME.name || "")}" placeholder="e.g. Sarah"></label>
        <label class="ce-field"><span class="lbl">Your niches (comma-separated)</span>
          <input type="text" id="me-niches" value="${escapeHtml((ME.niches || []).join(", "))}"
            placeholder="e.g. EMT education, study, fitness"></label>
      </div>
      <button type="button" class="btn" id="me-save">Save</button>
      <p class="bp-msg" id="me-msg" role="status" aria-live="polite"></p>
    </div>`;

  document.getElementById("me-save").addEventListener("click", () => {
    ME.name = document.getElementById("me-name").value.trim();
    ME.niches = document.getElementById("me-niches").value.split(",").map((s) => s.trim()).filter(Boolean);
    save({ now: true });
    flashMsg("me-msg", "Saved.", "good");
  });
}

// ---------- the library record ----------
// One entry per video, keyed on canonical URL across the WHOLE account — not
// per brand. The same link sent for three brands is one row here that lists
// all three scripts.
function ensureLibraryItem(url, extra = {}) {
  const canon = canonUrl(url);
  const found = ME.library.find((l) => l.canon === canon);
  if (found) { Object.assign(found, extra); return { item: found, isNew: false }; }
  const item = {
    id: newId(), url, canon, platform: platformLabel(url),
    title: "", creator: "", caption: "",
    addedAt: new Date().toISOString(), ...extra,
  };
  ME.library.unshift(item);
  return { item, isNew: true };
}

/** What a card is called before — or instead of — a real title. A bare URL
    reads as a bug; "@emt.kayla on TikTok" reads as a video whose caption
    hasn't loaded. */
function sourceLabel(item) {
  if (item.title) return item.title;
  const handle = (item.url.match(/(?:tiktok\.com|instagram\.com)\/@([A-Za-z0-9._]+)/) || [])[1];
  if (handle) return `@${handle} on ${item.platform}`;
  const tail = item.url.replace(/^https?:\/\/(www\.|m\.)?/, "").replace(/\?.*$/, "");
  return tail.length > 52 ? tail.slice(0, 52) + "…" : tail;
}

// ---------- the composer ----------
// Paste a link at the foot of a brand and it becomes that brand's next script.
// A link is often worth remaking for more than one company, so the brand you
// are standing in is pre-ticked and the rest are one click away — one send,
// one library entry, a separate script per company.
let COMPOSE_FOR = null;      // Set of brand ids; null means "just this brand"

function composeTargets() {
  if (!COMPOSE_FOR) return VIEW.kind === "brand" ? [VIEW.id] : [];
  return ME.brands.filter((b) => COMPOSE_FOR.has(b.id)).map((b) => b.id);
}

function renderComposeFor() {
  const host = document.getElementById("composer-for");
  if (!host) return;
  if (ME.brands.length < 2) { host.replaceChildren(); return; }   // nothing to choose
  const on = new Set(composeTargets());
  host.innerHTML = `<span class="lbl">Write it for</span>` + ME.brands.map((b) => `
    <button type="button" class="for-chip${on.has(b.id) ? " on" : ""}" data-bid="${escapeHtml(b.id)}"
      aria-pressed="${on.has(b.id)}">
      <span class="tick" aria-hidden="true">✓</span>${escapeHtml(b.name || "Untitled brand")}
    </button>`).join("");

  host.querySelectorAll(".for-chip").forEach((chip) => chip.addEventListener("click", () => {
    const next = new Set(composeTargets());
    const id = chip.dataset.bid;
    if (next.has(id)) next.delete(id); else next.add(id);
    // Never leave it pointing at nothing — the last chip off means "just here".
    COMPOSE_FOR = next.size ? next : null;
    renderComposeFor();
  }));
}

function wireComposer() {
  const input = document.getElementById("composer-url");
  const badge = document.getElementById("composer-plat");
  const showPlat = () => {
    const u = normalizeUrl(input.value);
    badge.textContent = u ? platformLabel(u) : "";
    badge.className = "bp-plat" + (u ? " on" : "");
  };
  input.addEventListener("input", showPlat);

  document.getElementById("composer-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (VIEW.kind !== "brand") return;
    const b = brandById(VIEW.id);
    if (!b) return;
    const raw = (input.value || "").trim();
    if (!raw) { say("Paste a video link first.", "bad"); input.focus(); return; }
    const url = normalizeUrl(raw);
    if (!url) { say("That doesn't look like a video link.", "bad"); input.select(); return; }

    // One library entry however many companies it is written for.
    const { item } = ensureLibraryItem(url);
    const targets = composeTargets().map(brandById).filter(Boolean);
    const queued = [], skipped = [];
    for (const target of targets) {
      const res = queueAdaptation(item, target);
      (res.ok ? queued : skipped).push(target.name || "that brand");
    }
    if (!queued.length) {
      say(skipped.length === 1
        ? `You've already got a ${skipped[0]} script from that video.`
        : `Already scripted for ${listOf(skipped)}.`, "bad");
      return;
    }
    input.value = "";
    showPlat();
    await save({ now: true });
    renderSide();
    renderPane();
    say(`On it — ${listOf(queued)} ${queued.length > 1 ? "scripts land" : "script lands"} here`
        + ` on their own.${skipped.length ? ` (${listOf(skipped)} already had one.)` : ""}`, "good");
    hydrate(item);
  });
}

// ---------- source metadata ----------
async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

function metaFromHtml(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const meta = (s) => doc.querySelector(s)?.getAttribute("content") || "";
  const og = meta('meta[property="og:title"]') || doc.querySelector("title")?.textContent || "";
  const handle = (og.match(/@([A-Za-z0-9._]+)/) || [])[1] || "";
  return {
    caption: meta('meta[property="og:description"]') || og,
    creator: handle || (og.match(/^([^\s(|·]+)/) || [])[1] || "",
  };
}

/** Three routes, tried in order, because no single one covers every platform.
    YouTube answers its own oEmbed with CORS headers. TikTok's oEmbed refuses
    plenty of callers outright (400, no CORS header) and Instagram publishes no
    keyless oEmbed at all, so both fall through to a read-only proxy scraping
    the page's og: tags — the same two relays app.js uses, in the same order,
    because allorigins is more reliable and codetabs is the spare. */
async function fetchSourceMeta(url) {
  const oembed = /tiktok\.com/.test(url)
    ? "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url)
    : /youtube\.com|youtu\.be/.test(url)
    ? "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url)
    : null;
  if (oembed) {
    try {
      const d = JSON.parse(await fetchWithTimeout(oembed, 15000));
      if (d && d.title) {
        return {
          caption: String(d.title),
          creator: String(d.author_name || d.author_unique_id || "").replace(/^@/, ""),
        };
      }
    } catch { /* fall through to the proxies */ }
  }
  try {
    const wrapped = JSON.parse(await fetchWithTimeout(
      "https://api.allorigins.win/get?url=" + encodeURIComponent(url), 20000));
    return metaFromHtml(wrapped.contents);
  } catch { /* spare relay */ }
  return metaFromHtml(await fetchWithTimeout(
    "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url), 20000));
}

/** Best-effort, fired after the card is already on screen: saving stays instant
    and the entry gets its proper name a second later. A failure is silent — an
    un-hydrated card reads fine, so a red message would be noise. */
async function hydrate(item) {
  if (item.title && item.caption) return;
  let meta;
  try { meta = await fetchSourceMeta(item.url); }
  catch { return; }
  const live = ME.library.find((l) => l.id === item.id);
  if (!live) return;                            // removed while the request was out
  live.caption = live.caption || meta.caption || "";
  live.creator = live.creator || meta.creator || "";
  live.title = live.title || (meta.caption || "").replace(/\s+/g, " ").trim().slice(0, 90);
  for (const a of ME.adaptations) {
    if (a.libraryId === live.id && live.title) a.title = live.title;
  }
  save();
  const editing = document.activeElement
    && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (!editing) { renderSide(); renderPane(); }
}

// ---------- scripts ----------

/** The one place a saved video becomes a queued script. Caller saves. */
function queueAdaptation(item, co) {
  const dupe = ME.adaptations.find((a) => a.brandId === co.id && a.status !== "error"
    && a.sourceUrl && canonUrl(a.sourceUrl) === item.canon);
  if (dupe) {
    return { ok: false, id: dupe.id,
             reason: dupe.status === "queued"
               ? "That one's already being written — it'll appear here."
               : `You've already got a ${co.name || "brand"} script from that video.` };
  }
  const id = newId();
  ME.adaptations.unshift({
    id, libraryId: item.id, sourceUrl: item.url, brandId: co.id,
    brandName: co.name || "Untitled brand",
    title: sourceLabel(item),
    status: "queued", addedAt: new Date().toISOString(),
    code: trackCode(co.name),             // spec §6.2 / R3 — issued at brief time
  });
  return { ok: true, id };
}

// Status at last paint, so a script that finishes while the page is open
// announces itself instead of quietly swapping a chip.
const SEEN = new Map();
const FLASH = new Set();

function beatRow(bt, carry, silent) {
  let say = (bt.say || "").trim();
  let doIt = (bt.do || "").trim();
  let show = (bt.show || "").trim();
  // Collapsing repeats keeps a spoken script readable — the words are the
  // point and an unchanged shot is still running. A silent video is the
  // opposite: DO and SHOW *are* the script, and blanking them would drop the
  // beat entirely, so every beat is printed in full and nothing is dimmed.
  if (carry && !silent) {
    const wasDo = doIt, wasShow = show;
    if (doIt && doIt === carry.do) doIt = "";
    if (show && show === carry.show) show = "";
    carry.do = wasDo || carry.do;
    carry.show = wasShow || carry.show;
  }
  const row = (label, v, dim) => v
    ? `<span class="bp-lbl">${label}</span><span class="bp-val${dim ? " bp-dim" : ""}">${escapeHtml(v)}</span>`
    : "";
  const rows = [row("SAY", say), row("DO", doIt, !silent), row("SHOW", show, !silent)].filter(Boolean);
  if (!rows.length) return "";
  return `<li class="bp-beat">
    <span class="bp-t">${escapeHtml(bt.t || "")}</span>${rows[0]}
    ${rows.slice(1).map((r) => `<span></span>${r}`).join("")}
  </li>`;
}

function scriptText(a) {
  const ad = a.adaptation || {};
  const quiet = ad.delivery === "silent"
    || (Array.isArray(ad.beats) && ad.beats.length && ad.beats.every((b) => !(b.say || "").trim()));
  const lines = [`${a.brandName || "Script"} — from ${a.sourceUrl || ""}`, ""];
  if (quiet) lines.push("NO VOICEOVER — shot by shot, the SHOW lines go on screen.", "");
  if (ad.hook) lines.push(`${quiet ? "OPENING CARD" : "HOOK"}: "${ad.hook}"`, "");
  for (const b of ad.beats || []) {
    lines.push(`[${b.t || ""}]`);
    if (b.say) lines.push(`  SAY:  ${b.say}`);
    if (b.do) lines.push(`  DO:   ${b.do}`);
    if (b.show) lines.push(`  SHOW: ${b.show}`);
  }
  if (ad.cta) lines.push("", `${quiet ? "FINAL CARD" : "CTA"}: ${ad.cta}`);
  if (a.code) lines.push(`CODE: ${a.code}`);
  if (ad.caption) lines.push("", `CAPTION: ${ad.caption}`);
  return lines.join("\n");
}

function adaptationHtml(a, liveName) {
  const justReady = SEEN.get(a.id) === "queued" && a.status === "done";
  if (justReady) FLASH.add(a.id);
  SEEN.set(a.id, a.status);
  const flash = FLASH.has(a.id);
  FLASH.delete(a.id);

  const ad = a.adaptation;
  const lowFit = ad && typeof ad.fit === "number" && ad.fit < 0.45;
  // Trust the model's own `delivery`, but fall back to the beats so scripts
  // written before that field existed still render as silent when they are.
  const silent = !!ad && (ad.delivery === "silent"
    || (Array.isArray(ad.beats) && ad.beats.length
        && ad.beats.every((b) => !(b.say || "").trim())));
  const chip = a.status === "error" ? `<span class="chip bad">couldn't fetch</span>`
    : a.status !== "done" ? `<span class="chip bp-wait"><i class="bp-dot"></i>writing your script</span>`
    : lowFit ? `<span class="chip">poor fit</span>`
    : ad ? `<span class="chip good">script ready</span>`
    : `<span class="chip">source only</span>`;
  const href = safeUrl(a.sourceUrl || "");
  const id = escapeHtml(a.id);
  // brandName was snapshotted when this was queued, so it goes stale the moment
  // the brand is renamed. Prefer what the brand is called now.
  const brandNow = liveName || a.brandName || "this brand";

  let body;
  if (a.status === "queued") {
    body = `<p class="bp-hint">Queued. The source gets transcribed, the format underneath it pulled
      out, and the script written for ${escapeHtml(brandNow)}. It appears here
      on its own — no need to stay on this page.</p>`;
  } else if (a.status === "error") {
    body = `<p class="bp-hint bad">${escapeHtml(a.note || "That video couldn't be downloaded.")}</p>
      <div class="bp-actions"><button type="button" class="ghost ad-retry" data-adid="${id}">Try again</button></div>`;
  } else if (ad) {
    const carry = { do: "", show: "" };
    body = `
      ${lowFit ? `<p class="bp-hint bp-partial"><strong>This format doesn't really suit ${escapeHtml(brandNow)}.</strong>
          ${escapeHtml(ad.fit_reason || "")} The script below is written anyway, but a format that fits
          would do better than forcing this one.</p>`
        : ad.fit_reason ? `<p class="bp-hint">Fit ${Math.round((ad.fit || 0) * 100)}% — ${escapeHtml(ad.fit_reason)}</p>` : ""}
      ${a.format?.name ? `<div class="chips bp-tags"><span class="chip">${escapeHtml(a.format.name)}</span>
        ${a.source?.tags?.format_type ? `<span class="chip">${escapeHtml(a.source.tags.format_type)}</span>` : ""}
        ${a.source?.tags?.hook_pattern ? `<span class="chip">${escapeHtml(a.source.tags.hook_pattern)}</span>` : ""}</div>` : ""}
      ${a.note ? `<p class="bp-hint">${escapeHtml(a.note)}</p>` : ""}
      ${ad.hook ? `<div class="bp-hook"><span class="bp-hook-lbl">${
        silent ? "Opening card" : "Hook"}</span>“${escapeHtml(ad.hook)}”</div>` : ""}
      ${silent ? `<p class="bp-hint">No voiceover — this one is read, not heard, so it still works
        on mute. Film the shots below and put the SHOW line on screen at each beat.</p>` : ""}
      <div class="bp-heading">${silent ? "Shot by shot" : "Your script"}</div>
      <ol class="bp-beats">${(ad.beats || []).map((b) => beatRow(b, carry, silent)).join("")}</ol>
      ${ad.cta ? `<p class="bp-hint"><strong>${silent ? "Final card" : "CTA"}:</strong> ${escapeHtml(ad.cta)}</p>` : ""}
      ${a.code ? `<p class="bp-hint">${silent ? "Put your code" : "Say your code"}
        <strong>${escapeHtml(a.code)}</strong> ${silent ? "on the final card" : "out loud"} so this
        video's signups can be traced back to it.</p>` : ""}
      ${ad.caption ? `<p class="bp-hint"><strong>Caption:</strong> ${escapeHtml(ad.caption)}</p>` : ""}
      ${a.format?.why_it_works ? `<p class="bp-hint">Why this format works: ${escapeHtml(a.format.why_it_works)}</p>` : ""}
      <div class="bp-actions">
        <button type="button" class="ghost ad-copy" data-adid="${id}">Copy script</button>
      </div>`;
  } else {
    body = `<p class="bp-hint">The source was read but the script hasn't been written yet.
      ${escapeHtml(a.note || "")}</p>
      <div class="bp-actions"><button type="button" class="ghost ad-retry" data-adid="${id}">Try again</button></div>`;
  }

  return `<details class="bp-item bp-${escapeHtml(a.status)}${flash ? " bp-flash" : ""}"${justReady ? " open" : ""} data-adid="${id}">
    <summary>
      <span class="bp-caret" aria-hidden="true">▸</span>
      <span class="bp-name">${escapeHtml(a.title || (a.sourceUrl || "").replace(/^https?:\/\//, "").slice(0, 52))}</span>
      ${chip}
      <span class="bp-when">${escapeHtml(agoLabel(a.addedAt))}</span>
      ${href ? `<a class="bp-open" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open the original">↗</a>` : ""}
    </summary>
    <div class="bp-body">
      ${body}
      <button type="button" class="ghost ad-del" data-adid="${id}">Delete</button>
    </div>
  </details>`;
}

function renderScripts(b) {
  const host = document.getElementById("ad-list");
  if (!host) return;
  const list = brandScripts(b);
  if (!list.length) {
    host.innerHTML = `<div class="empty"><p><strong>No scripts yet.</strong></p>
      <p>Paste a link at the bottom of this page. Tick the companies it should be written for,
      and a script comes back for each — the video files itself in your Library either way.</p></div>`;
    return;
  }
  host.innerHTML = `<div class="bp-list">${list.map((a) => adaptationHtml(a, b.name)).join("")}</div>`;

  host.querySelectorAll(".ad-copy").forEach((btn) => btn.addEventListener("click", async () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a) return;
    try {
      await navigator.clipboard.writeText(scriptText(a));
      btn.textContent = "Copied ✓";
      setTimeout(() => { btn.textContent = "Copy script"; }, 1500);
    } catch { /* clipboard denied */ }
  }));
  host.querySelectorAll(".ad-retry").forEach((btn) => btn.addEventListener("click", () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a) return;
    a.status = "queued";
    delete a.note; delete a.attemptedAt;
    save(); renderSide(); renderPane();
    say("Re-queued — it'll be picked up on the next pass.", "good");
  }));
  host.querySelectorAll(".ad-del").forEach((btn) => armDelete(btn, "Delete", () => {
    ME.adaptations = ME.adaptations.filter((x) => x.id !== btn.dataset.adid);
    SEEN.delete(btn.dataset.adid);
    save(); renderSide(); renderPane();   // the video stays in the Library
  }));
}

// ---------- boot ----------
function renderAll() {
  // Land on a brand when there is one — an empty Library is a dead end for
  // someone who just signed up.
  if (VIEW.kind === "library" && ME.brands.length) VIEW = { kind: "brand", id: ME.brands[0].id };
  renderSide();
  renderPane();
  renderSyncBadge();
}

let unlocked = false;
function unlock() {
  if (unlocked) return;
  unlocked = true;
  document.getElementById("err").textContent = "";
  document.getElementById("gate").style.display = "none";
  document.getElementById("app").style.display = "block";
  renderAll();
  startLiveSync();
}

/** Scripts are written off-page, so poll while the tab is visible and repaint
    only when something actually changed — and never mid-keystroke. */
let LIVE_STARTED = false;
function startLiveSync() {
  if (LIVE_STARTED) return;
  LIVE_STARTED = true;
  const tick = async () => {
    if (!SB_TOKEN || document.hidden) return;
    const before = JSON.stringify(ME.adaptations);
    try { await pull(); } catch { SYNC_OK = false; }
    renderSyncBadge();
    if (JSON.stringify(ME.adaptations) === before) return;
    const editing = document.activeElement
      && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (!editing) { renderSide(); renderPane(); }   // counts and scripts move together
  };
  setInterval(tick, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}

// The gate does double duty: sign in, or create an account. One form, one
// extra field, so the two paths can't drift apart.
let GATE_MODE = "in";
function setGateMode(mode) {
  GATE_MODE = mode;
  const up = mode === "up";
  const pw = document.getElementById("pw");
  document.getElementById("gate-tagline").textContent = up ? "create your account" : "for creators";
  document.getElementById("pw2-wrap").hidden = !up;
  document.getElementById("pw2").value = "";
  document.getElementById("gate-go").textContent = up ? "Create account" : "Enter";
  pw.setAttribute("autocomplete", up ? "new-password" : "current-password");
  pw.placeholder = up ? "Password — 8 characters or more" : "Password";
  document.getElementById("switch-lede").textContent =
    up ? "Already have an account?" : "Don't have an account?";
  document.getElementById("switch-mode").textContent = up ? "Sign in" : "Create one";
  document.getElementById("err").textContent = "";
}

document.getElementById("switch-mode").addEventListener("click", () => {
  setGateMode(GATE_MODE === "up" ? "in" : "up");
  document.getElementById(document.getElementById("email").value ? "pw" : "email").focus();
});

document.getElementById("gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  const btn = document.getElementById("gate-go");
  const email = (document.getElementById("email").value || "").trim();
  const pw = document.getElementById("pw");
  const pw2 = document.getElementById("pw2");
  if (!email || !pw.value) { err.textContent = "Enter your email and password."; return; }

  if (GATE_MODE === "up") {
    if (pw.value.length < 8) { err.textContent = "Use at least 8 characters."; pw.select(); return; }
    if (pw.value !== pw2.value) { err.textContent = "Those two passwords don't match."; pw2.select(); return; }
    btn.disabled = true;
    err.textContent = "Creating your account…";
    try {
      const outcome = await sbSignUp(email, pw.value);
      pw.value = ""; pw2.value = "";
      if (outcome === "confirm") {
        setGateMode("in");
        // Both cases land here and we can't tell them apart without leaking
        // who has an account (see sbSignUp), so name both. The old wording
        // said only "check your email", which sent anyone re-using an existing
        // address off to wait for a link that is never sent.
        err.textContent = "If that address is new, check your email for the confirmation link. "
          + "If you've signed up before, just sign in — no new email is sent.";
        return;
      }
      await pull();
      unlock();
    } catch (ex) {
      err.textContent = signupError(ex.message);
    } finally { btn.disabled = false; }
    return;
  }

  btn.disabled = true;
  err.textContent = "Signing in…";
  let signedIn = false;
  try {
    await sbSignIn(email, pw.value);
    signedIn = true;
    pw.value = "";
    await pull();
    unlock();
  } catch (ex) {
    const m = ex.message || "";
    // Once sign-in succeeded the password was fine, so never blame it for what
    // is really a failure to load the account.
    err.textContent = signedIn ? accountLoadError(m)
      : /Email not confirmed/i.test(m)
      ? "Confirm your email first — check your inbox for the link."
      : /Invalid login|invalid_grant|Sign-in failed/i.test(m)
      ? "Wrong email or password."
      : "Could not sign in — check your connection.";
    pw.select();
  } finally { btn.disabled = false; }
});

/** Signed in, but the account wouldn't load. The commonest cause by a mile is
    that supabase/schema.sql has never been run, so lynxr_creators does not
    exist and PostgREST answers PGRST205. Reporting that as "check your
    connection" is how you end up retyping a correct password and then trying
    to create an account you already have. */
function accountLoadError(m) {
  if (/PGRST205|PGRST106|lynxr_creators|schema cache/i.test(m)) {
    return "Signed in — but the creator tables don't exist yet. Run supabase/schema.sql in the Supabase SQL editor.";
  }
  return "Signed in, but couldn't load your account — reload to retry.";
}

document.getElementById("toggle-pw").addEventListener("click", () => {
  const pw = document.getElementById("pw");
  const showing = pw.type === "text";
  pw.type = showing ? "password" : "text";
  const label = showing ? "Show password" : "Hide password";
  const b = document.getElementById("toggle-pw");
  b.setAttribute("aria-pressed", String(!showing));
  b.setAttribute("aria-label", label);
  b.setAttribute("title", label);
  pw.focus();
});

document.getElementById("signout").addEventListener("click", () => {
  clearSession();
  location.reload();
});

document.getElementById("side-new").addEventListener("click", addBrand);
document.getElementById("nav-library").addEventListener("click", () => go({ kind: "library" }));
document.getElementById("nav-you").addEventListener("click", () => go({ kind: "you" }));
wireComposer();

/* ---------- Interactive dot grid ----------
   The same pointer-reactive lattice the agency app runs, ported verbatim so
   both sides of the product share one backdrop. The canvas draws the WHOLE
   grid — exactly one set of dots, aligned with the CSS lattice it replaces —
   and swells the ones nearest the cursor. Mouse only; touch and
   prefers-reduced-motion keep the static CSS grid from app.css.

   It sizes itself through the width/height ATTRIBUTES, never inline styles:
   the strict CSP discards those, and .dot-fx already spans the viewport via
   the stylesheet. */
(function initDotGrid() {
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!fine || still) return;

  const GAP = 34;      // matches the CSS lattice spacing
  const REACH = 78;    // px of influence around the cursor
  const DOT_R = 1.3;   // resting radius, matches the CSS lattice
  const DOT_A = 0.06;  // resting alpha — light dots, this theme is dark

  const canvas = document.createElement("canvas");
  canvas.className = "dot-fx";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  document.body.classList.add("dots-live");   // retires the CSS lattice

  const ctx = canvas.getContext("2d");
  let viewW = 0, viewH = 0, dpr = 1, px = -9999, py = -9999, queued = false;

  // Drawn in device pixels and snapped to the device grid, so the dots stay
  // razor-sharp at any zoom or display density.
  const draw = () => {
    queued = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const half = GAP / 2;
    for (let x = half; x < viewW + half; x += GAP) {
      for (let y = half; y < viewH + half; y += GAP) {
        const d = Math.hypot(x - px, y - py);
        let r = DOT_R, a = DOT_A;
        if (d < REACH) {
          const ease = (1 - d / REACH) ** 2;   // 0 at the edge, 1 under the cursor
          r = DOT_R + ease * 1.8;
          a = DOT_A + ease * 0.30;
        }
        ctx.beginPath();
        ctx.arc(Math.round(x * dpr), Math.round(y * dpr), r * dpr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        ctx.fill();
      }
    }
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };

  const sizeCanvas = () => {
    // Follow the real pixel ratio (browser zoom changes it) so the canvas
    // never renders below the display's resolution.
    dpr = Math.min(window.devicePixelRatio || 1, 4);
    viewW = document.documentElement.clientWidth || window.innerWidth;
    viewH = document.documentElement.clientHeight || window.innerHeight;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    draw();
  };
  // Zoom changes devicePixelRatio without always firing resize.
  const watchDpr = () => {
    window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      .addEventListener("change", () => { sizeCanvas(); watchDpr(); }, { once: true });
  };

  sizeCanvas();
  watchDpr();
  window.addEventListener("resize", sizeCanvas);
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    px = e.clientX; py = e.clientY;
    queue();
  }, { passive: true });

  // Pointer gone: settle every dot back to its resting size.
  const rest = () => { px = -9999; py = -9999; queue(); };
  document.addEventListener("pointerleave", rest);
  window.addEventListener("blur", rest);
})();

/** A confirmation (or recovery) link comes back here with the session in the
    URL fragment. Take it, strip it out of the address bar so the tokens never
    sit in history or get pasted into a chat, and go straight in — otherwise a
    creator clicks "confirm", lands on the login form, and has to type the
    password they set thirty seconds ago.

    Fragments never reach a server, so this is the only place that can read it;
    GitHub Pages sees nothing. */
async function sessionFromLink() {
  const hash = location.hash || "";
  if (!hash.includes("access_token") && !hash.includes("error")) return false;
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  history.replaceState(null, "", location.pathname + location.search);

  const err = p.get("error_description") || p.get("error");
  if (err) {
    document.getElementById("err").textContent = /expired|invalid/i.test(err)
      ? "That confirmation link has expired — sign up again to get a new one."
      : decodeURIComponent(err).replace(/\+/g, " ");
    return false;
  }
  const access_token = p.get("access_token"), refresh_token = p.get("refresh_token");
  if (!access_token || !refresh_token) return false;
  try {
    // The fragment carries no user object, and we need the id to read the row.
    const res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${access_token}` } });
    if (!res.ok) return false;
    adoptSession({ access_token, refresh_token, user: await res.json() });
    return true;
  } catch { return false; }
}

// Arriving from a confirmation link, or a session already stored here.
(async function resume() {
  if (await sessionFromLink()) {
    try { await pull(); unlock(); return; }
    catch (ex) { document.getElementById("err").textContent = accountLoadError(ex.message || ""); return; }
  }
  const sess = loadSession();
  if (!sess?.refresh_token) return;
  try { await sbRefresh(sess.refresh_token); }
  catch { clearSession(); return; }
  try { await pull(); unlock(); }
  catch (ex) { document.getElementById("err").textContent = accountLoadError(ex.message || ""); }
})();
