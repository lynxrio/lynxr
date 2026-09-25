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
  revealCreatorSwitch();   // staff only, decided by the database; not awaited
}

/** Put the gate's status line into a working state: the four-arm mark at text
 *  size, plus what it is doing. `text` is ours, never server-supplied — every
 *  failure message goes through textContent instead. */
function gateBusy(el, text) {
  el.innerHTML = `<span class="loader inline">${loaderMark()}<span>${escapeHtml(text)}</span></span>`;
}

/* FIELD ERRORS — lynxr's own, in place of the browser's validation bubble
   (owner, 2026-09-12). Same contract as markInvalid()/clearInvalid() in
   creator.js, which carries the full reasoning; this file is a separate bundle,
   so it keeps its own copy of the two small helpers.

   Every <form> here carries `novalidate`: the browser never draws a bubble and
   never blocks submit, and each handler's own check decides. That matters most
   for `type="url"`, which refused `clientsite.com` — the exact example the
   brief form's own error tells you to type — and every scheme-less video link,
   before normalizeClientUrl() could add the https:// it exists to add. The
   `type` attributes stay for the phone keyboard, autofill and the app.css
   selectors that key on them. Styling: the [aria-invalid] block at the end of
   app.css. */
function markInvalid(input, msgId) {
  if (!input) return;
  input.setAttribute("aria-invalid", "true");
  const ids = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
  if (msgId && !ids.includes(msgId)) {
    ids.push(msgId);
    input.setAttribute("aria-describedby", ids.join(" "));
    input.dataset.errFor = msgId;
  }
}
function clearInvalid(input) {
  if (!input || input.getAttribute("aria-invalid") !== "true") return false;
  input.removeAttribute("aria-invalid");
  const mine = input.dataset.errFor;
  if (mine) {
    const ids = (input.getAttribute("aria-describedby") || "").split(/\s+/)
      .filter((id) => id && id !== mine);
    if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
    else input.removeAttribute("aria-describedby");
    delete input.dataset.errFor;
  }
  return true;
}
/** A link lynxr can ingest — the same two checks every link form below already
    ran, in one place so the submit refusal and the clear-when-fixed agree. */
const ingestibleLink = (raw) => { const u = normalizeClientUrl(raw); return !!(u && platformOf(u)); };
// Loose on purpose, and the same test the creator gate and the old wait list use.
const emailShapeOk = (s) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s);
let GATE_ERR_TEXT = "";
function gateFieldError(el, text) {
  const err = document.getElementById("err");
  err.textContent = text;
  GATE_ERR_TEXT = text;
  ["email", "pw", "pw2"].forEach((id) => clearInvalid(document.getElementById(id)));
  markInvalid(el, "err");
  el.focus();
  // Retype a password; finish an address — see creator.js gateFieldError().
  if (el.type === "password" && el.value) el.select();
}
// Fixed means fixed: the flag and its sentence go on the edit that satisfies it.
document.getElementById("gate-form").addEventListener("input", () => {
  const emailEl = document.getElementById("email");
  const pw = document.getElementById("pw");
  const pw2 = document.getElementById("pw2");
  const bad = [emailEl, pw, pw2].filter((el) => el.getAttribute("aria-invalid") === "true");
  if (!bad.length) return;
  const ok = (el) => (el === emailEl ? emailShapeOk(el.value.trim())
    : el === pw2 ? el.value === pw.value
    : el.value.length >= (GATE_RESET ? 8 : 1));
  if (bad.every(ok)) {
    bad.forEach(clearInvalid);
    const err = document.getElementById("err");
    if (err.textContent === GATE_ERR_TEXT) err.textContent = "";
  }
});

document.getElementById("gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const emailEl = document.getElementById("email");
  const pw = document.getElementById("pw");
  const err = document.getElementById("err");
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (GATE_RESET) { await saveNewPassword(submitBtn); return; }
  const email = (emailEl?.value || "").trim();
  const password = pw.value;
  if (!email || !password) { gateFieldError(email ? pw : emailEl, "Enter your email and password."); return; }
  if (!emailShapeOk(email)) {
    gateFieldError(emailEl, "Check your email address — it should look like name@example.com.");
    return;
  }
  clearInvalid(emailEl); clearInvalid(pw);

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

/* RESET MODE (2026-09-17: "for the agency side there is no forgot password").
   A password-reset or invite link lands here with a session in the URL
   fragment; sessionFromLink() takes it and calls this. The link already said
   who this is, so the email field goes and the new password is asked twice —
   the same shape as the creator gate's reset mode in creator.js. An invite
   counts too: an invited account has no password yet, and this app signs in
   with nothing else. */
let GATE_RESET = false;
function setResetMode(message) {
  GATE_RESET = true;
  const emailEl = document.getElementById("email");
  const pw = document.getElementById("pw");
  emailEl.hidden = true;
  pw.placeholder = "New password";
  pw.setAttribute("autocomplete", "new-password");
  document.getElementById("pw2-wrap").hidden = false;
  document.getElementById("forgot-wrap").hidden = true;
  document.querySelector('#gate-form button[type="submit"]').textContent = "Save new password";
  document.getElementById("err").textContent = message;
  pw.focus();
}

async function saveNewPassword(submitBtn) {
  const pw = document.getElementById("pw");
  const pw2 = document.getElementById("pw2");
  const err = document.getElementById("err");
  if (pw.value.length < 8) { gateFieldError(pw, "Use at least 8 characters for your password."); return; }
  if (pw.value !== pw2.value) { gateFieldError(pw2, "Those two passwords don't match — retype the second one."); return; }
  clearInvalid(pw); clearInvalid(pw2);
  submitBtn.disabled = true;
  gateBusy(err, "Saving…");
  let saved = false;
  try {
    // sbFetch carries the session the link established, and refreshes it if
    // the person sat on this screen past the hour.
    await sbFetch("/auth/v1/user", { method: "PUT", body: JSON.stringify({ password: pw.value }) });
    saved = true;
    pw.value = ""; pw2.value = "";
    gateBusy(err, "Loading database…");
    const rows = await sbFetchVideos();
    try { await syncClients(); } catch { SYNC_OK = false; }
    unlock(rows);
    updateSyncBadge();
  } catch (ex) {
    const m = (ex && ex.message) || "";
    // Saved but the load failed: the password is set, so say what the load
    // says (a creator account lands here too, and is told so).
    err.textContent = saved
      ? await loadFailureReason(m)
      : /same.*password|different from the old/i.test(m)
        ? "That's the password you already had — pick a different one."
        : "Couldn't save the new password. Ask for a fresh reset link and try again.";
  } finally {
    submitBtn.disabled = false;
  }
}

/* Forgot password. The same request the creator gate makes. Supabase answers
   200 whether or not the address has an account, so the wording must not
   claim a mail was sent. The link comes back to this page when this URL is an
   allowed redirect in Supabase (Authentication → URL Configuration); when it
   isn't, Supabase uses the Site URL instead and the creator app's own reset
   form sets the password — one account, so both apps accept it either way. */
const MAILER_FAILURE = /error sending .*e-?mail|email_send|smtp/i;
document.getElementById("gate-forgot").addEventListener("click", async () => {
  const err = document.getElementById("err");
  const btn = document.getElementById("gate-forgot");
  const emailEl = document.getElementById("email");
  const email = (emailEl.value || "").trim();
  if (!email) { gateFieldError(emailEl, "Enter your email first, then tap Forgot your password."); return; }
  if (!emailShapeOk(email)) {
    gateFieldError(emailEl, "Check your email address — it should look like name@example.com.");
    return;
  }
  clearInvalid(emailEl);
  btn.disabled = true;
  err.textContent = "Sending…";
  try {
    const back = encodeURIComponent(location.origin + location.pathname);
    const res = await fetch(`${SB_URL}/auth/v1/recover?redirect_to=${back}`, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`${res.status} ${body.msg || body.message || ""}`.trim());
    }
    err.textContent = "If that address has an account, a reset link is on its way.";
  } catch (ex) {
    const m = (ex && ex.message) || "";
    err.textContent = /429|rate|too many|for security purposes/i.test(m)
      ? "Too many attempts — wait a minute and try again."
      : MAILER_FAILURE.test(m)
        ? "We couldn't send the reset email — that's a problem on our end, not your connection."
        : "Couldn't send the reset link — check your connection and try again.";
  } finally {
    btn.disabled = false;
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

/* STAFF-ONLY LINK TO THE CREATOR APP (2026-09-14). Mirror of
   revealAgencySwitch() in creator.js, which carries the full reasoning:
   is_staff() decides, RLS is the gate, the link is a convenience, and the two
   apps keep SEPARATE sessions (lynxr_sb_session here, lynxr_creator_session
   there). Never copy a session between them: refresh tokens are single-use,
   and a second use ends the session in both apps.
   Targets / since /creatorsonly/ was retired (2026-09-15): the home page hosts
   the creator app, and a signed-in creator goes straight into it. */
async function revealCreatorSwitch() {
  if (document.getElementById("to-creator")) return;
  let staff = false;
  try {
    staff = (await sbFetch("/rest/v1/rpc/is_staff", { method: "POST", body: "{}" })) === true;
  } catch { return; }
  const signout = document.getElementById("signout");
  if (!staff || !signout || document.getElementById("to-creator")) return;
  const a = document.createElement("a");
  a.className = "ghost";
  a.id = "to-creator";
  a.href = "/";
  a.textContent = "Creator app";
  signout.parentNode.insertBefore(a, signout);
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

// AGENCY GLASS PASS (2026-09-15): the header wordmark is a clickable "home" control —
// the same landing point as the breadcrumb's own "Clients" link (bv-clients/cv-clients/
// cl-back), reachable from any tab.
document.getElementById("home-mark").addEventListener("click", () => {
  activateTab("tab-briefs");
  CLIENT_VIEW = null; BRIEF_VIEW = null; CAMPAIGN_VIEW = null;
  renderBriefs();
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
/** THE LOADING MARK: the lynxr avatar (avatar.js) in a working mood. "reading"
 *  by default, "writing" while a script is being written. Every long wait in
 *  both apps goes through here. A mood change after render goes through
 *  lynxrMood(), never a re-render (see paintEta in creator.js).
 */
function loaderMark(mood = "reading") {
  return typeof lynxrAvatar === "function" ? lynxrAvatar(mood, "loader-mark") : "";
}
/** A decorative lynxr leading an empty or failed panel (AGENCY GLASS PASS,
 *  2026-09-15): idle = nothing here yet, confused = we could not read it.
 *  aria-hidden like every avatar; the words beside it say what happened. */
function emptyMark(mood = "idle") {
  return typeof lynxrAvatar === "function" ? lynxrAvatar(mood, "empty-mark") : "";
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

/* `pct: false` drops the share column. The creator-sources panel uses it: at 19
   rows "53%" is one video's worth of movement per 5.3 points, and a percentage
   invites a confidence the sample cannot support. The scraped corpus keeps its
   percentages — 9,016 rows can carry them. */
function renderBars(hostId, pairs, limit = 8, drillSelectId = null, { pct = true, format = null } = {}) {
  const host = document.getElementById(hostId);
  const shown = pairs.slice(0, limit);
  // The TALLEST bar, not the first one. Every caller before the Ops tab passes
  // pairs sorted descending (countBy, and the audio majors sort), so shown[0][1]
  // WAS the max and this is a no-op for all of them — but a chronological series
  // is not sorted, and under the old line every day taller than day one rendered
  // over 100% and was clipped flat by .bar-track's overflow, so several days all
  // looked identical. It also removes a latent NaN: an all-zero first entry made
  // count/0 NaN, Math.max(NaN, 1) is NaN, and the width came out "NaN%" — which
  // paints nothing at all.
  const max = shown.reduce((m, [, n]) => Math.max(m, n), 0) || 1;
  const total = pairs.reduce((a, [, n]) => a + n, 0) || 1;
  host.innerHTML = shown.map(([label, count]) => `
    <div class="bar-row${drillSelectId && !label.startsWith("(") ? " drill" : ""}" data-val="${escapeHtml(label)}"
         ${drillSelectId ? `role="button" tabindex="0" title="Show these videos in the database"` : ""}>
      <div class="bar-track">
        <div class="bar-fill"></div>
        <div class="bar-label">${escapeHtml(label)}</div>
      </div>
      <div class="bar-count"><span class="bar-n">${escapeHtml(format ? format(count) : fmt(count))}</span>${pct
        ? ` <span class="bar-pct">${(count / total * 100).toFixed(count / total >= 0.1 ? 0 : 1)}%</span>`
        : ""}</div>
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
      setTimeout(() => animateCount(el, shown[i][1], format || ((v) => fmt(Math.round(v))), 650), i * 45));
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
  ["tab-roster", "panel-roster"],
  ["tab-ops", "panel-ops"],
];
function activateTab(tabId) {
  for (const [t, p] of TABS) {
    const on = t === tabId;
    document.getElementById(t).setAttribute("aria-selected", String(on));
    document.getElementById(p).hidden = !on;
  }
  window.scrollTo({ top: 0 });
  // Lazy, and refreshed on re-entry when what we hold is over a minute old —
  // an alarm board showing five-minute-old state is worse than one that says
  // it is loading. NOT a setInterval: this is a look-when-I-want surface, and a
  // background poller in a tab left open all day is a database bill for nobody.
  if (tabId === "tab-ops") ensureOps();
  if (tabId === "tab-roster") rostLoad();
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

/* ---------- Creator sources: the leading half of the database ----------
 *
 * lynxr_sources is one row per video a CREATOR PASTED IN. That is a different
 * kind of evidence from the scraped corpus: somebody who makes videos for a
 * living looked at it and judged it worth remaking, BEFORE the view count
 * proved anything. lynxr_videos can only ever tell you what already worked,
 * which is why every other UGC shop can find the same rows.
 *
 * `tag_count` is the meter. One row per canonical URL, bumped rather than
 * duplicated when a second creator pastes the same video — so tag_count > 1 is
 * two people independently arriving at the same format inside a few days.
 *
 * FOUR THINGS TO KNOW BEFORE CHANGING ANYTHING HERE:
 *
 * 1. THE TABLE IS INVISIBLE WITHOUT AN RLS POLICY. It shipped with none at all
 *    — service-role only, deliberately (creator_tables.sql). The pipeline writes
 *    it with the service key, which bypasses RLS, so nothing ever looked broken;
 *    a signed-in staff browser just got `[]` back. supabase/sources_staff_read.sql
 *    adds the is_staff() select policy. An empty list here is far more likely to
 *    be an unapplied policy than an empty table, which is why the empty state
 *    says so instead of "no results".
 * 2. METRICS ARE NULLABLE AND THAT IS LOAD-BEARING. `views` is NULL when it was
 *    never fetched and 0 when the video genuinely has none. Folding them
 *    together would bury every un-backfilled row at the bottom of a views sort
 *    and read as "these all flopped". Test `== null`, never truthiness.
 * 3. NO OPPORTUNITY SCORE LIVES HERE. The 1-10 score needs REACH — a type's
 *    median views against its niche+platform scope — over pockets of >=12. This
 *    table has neither the volume nor (until backfilled) the views. Client
 *    suggestions therefore still run on the scraped corpus; that is deliberate,
 *    not an oversight.
 * 4. COVERS COME FREE. process_adaptations.py published a frame for every one of
 *    these under sha1(canonUrl(url))[:20] in `lynxr-covers` — the same key
 *    fillHostedCovers() already derives in the browser. Nothing extra is stored
 *    on the row.
 */
let SOURCES = [];            // what staff see: SOURCES_RAW with SOURCE_EDITS laid over it (srcRebuild)
let SOURCES_RAW = [];        // the rows exactly as lynxr_sources returned them
let SOURCE_EDITS = {};       // canonUrl -> staff correction, the SOURCE_EDITS_ROW_ID row as last read
const SRC_OPEN = new Set();  // canonUrls of opened tiles, so a redraw keeps them open
let SOURCES_STATE = "idle";   // idle | loading | ready | error
const SRC_FILTERS = [
  { id: "src-f-platform", key: "platform", label: "All platforms" },
  { id: "src-f-format", key: "format_type", label: "All formats" },
  { id: "src-f-niche", key: "niche_category", label: "All niches" },
];

/** Flatten the jsonb `tags` blob onto the row so countBy/filters — which are
    written against flat keys like format_type — work unchanged on both tables. */
function srcRow(r) {
  const t = r.tags || {};
  return {
    ...r,
    format_type: t.format_type || "",
    hook_pattern: t.hook_pattern || "",
    niche_category: t.niche_category || "",
    target_audience: t.target_audience || "",
    visual_hook: t.visual_hook || "",
    canon: canonUrl(r.url || ""),
  };
}

/** A fetched row with its staff correction laid over it (see SOURCE_EDITS_ROW_ID), flattened by
    srcRow like any other. Corrected beats replace the list, each over the pipeline beat at its
    index so fields a tile never shows are kept. `_edit` marks a corrected row. */
function srcApplyEdit(raw) {
  const e = SOURCE_EDITS[canonUrl(raw.url || "")];
  if (!e) return srcRow(raw);
  const f = raw.format || {}, fe = e.format || {};
  const format = { ...f };
  if (fe.name != null) format.name = fe.name;
  if (fe.why_it_works != null) format.why_it_works = fe.why_it_works;
  if (Array.isArray(fe.beats)) format.beats = fe.beats.map((b, i) => ({ ...((f.beats || [])[i] || {}), ...b }));
  return {
    ...srcRow({
      ...raw,
      title: e.title ?? raw.title,
      creator: e.creator ?? raw.creator,
      tags: { ...(raw.tags || {}), ...(e.tags || {}) },
      format,
    }),
    _edit: e,
  };
}
function srcRebuild() { SOURCES = SOURCES_RAW.map(srcApplyEdit); }

/** An editable field of a source row, by the path its line carries in data-field. */
const SRC_TAG_KEYS = ["format_type", "hook_pattern", "niche_category", "target_audience", "visual_hook"];
function srcFieldValue(r, path) {
  if (!r) return null;
  if (path === "title" || path === "creator") return String(r[path] ?? "");
  if (path.startsWith("tags.")) return SRC_TAG_KEYS.includes(path.slice(5)) ? String((r.tags || {})[path.slice(5)] ?? "") : null;
  if (path === "format.name" || path === "format.why_it_works") return String((r.format || {})[path.slice(7)] ?? "");
  const m = /^beats\.(\d+)\.(seconds|role)$/.exec(path);
  const b = m && ((r.format || {}).beats || [])[+m[1]];
  return b ? String(b[m[2]] ?? "") : null;
}

/** One field of one video's correction set to `val` against the pipeline row `raw`: kept only if it
    differs from the pipeline, cleaned up when nothing is left (null = delete the entry). */
function srcSetField(entry, raw, path, val) {
  const e = entry || {};
  const same = (a, b) => String(a ?? "") === String(b ?? "");
  const fmt0 = raw.format || {};
  if (path === "title" || path === "creator") {
    if (same(val, raw[path])) delete e[path]; else e[path] = val;
  } else if (path.startsWith("tags.")) {
    const k = path.slice(5);
    const tags = { ...(e.tags || {}) };
    if (same(val, (raw.tags || {})[k])) delete tags[k]; else tags[k] = val;
    if (Object.keys(tags).length) e.tags = tags; else delete e.tags;
  } else {
    const fe = { ...(e.format || {}) };
    if (path === "format.name" || path === "format.why_it_works") {
      const k = path.slice(7);
      if (same(val, fmt0[k])) delete fe[k]; else fe[k] = val;
    } else {
      const [, i, part] = /^beats\.(\d+)\.(seconds|role)$/.exec(path);
      const orig = (fmt0.beats || []).map((b) => ({ seconds: b.seconds ?? null, role: b.role ?? "" }));
      const beats = (fe.beats || orig).map((b) => ({ ...b }));
      if (!beats[+i]) throw new Error("no such beat");
      beats[+i][part] = part === "seconds" ? Number(val) : val;
      if (JSON.stringify(beats) === JSON.stringify(orig)) delete fe.beats; else fe.beats = beats;
    }
    if (Object.keys(fe).length) e.format = fe; else delete e.format;
  }
  if (!["title", "creator", "tags", "format"].some((k) => k in e)) return null;
  e.editedAt = new Date().toISOString();
  if (SB_EMAIL) e.editedBy = SB_EMAIL;
  return e;
}

async function fetchSources() {
  SOURCES_STATE = "loading";
  // Everything except `script` and `shots`: the transcript alone is several KB a
  // row and only the opened card ever needs it. 19 rows today, but the whole
  // point is that this table grows, so it is paged-shaped from the start.
  const sel = "canonical_url,url,platform,first_seen_at,last_seen_at,tag_count,"
    + "tags,format,views,likes,comments,creator,title,metrics_at";
  try {
    // The corrections row is read alongside. If it cannot be read the pipeline's values show,
    // and every save reads it again before writing (pushSourceEdit).
    const [rows, edits] = await Promise.all([
      sbFetch(`/rest/v1/lynxr_sources?select=${sel}&order=tag_count.desc,last_seen_at.desc`),
      sbSourceEdits().catch(() => ({})),
    ]);
    SOURCES_RAW = rows || [];
    SOURCE_EDITS = edits;
    srcRebuild();
    SOURCES_STATE = "ready";
  } catch (e) {
    // A 401/403 here is the policy, not the network. Say which.
    SOURCES_RAW = [];
    SOURCES = [];
    SOURCES_STATE = "error";
  }
  return SOURCES;
}

function srcViews(r) { return r.views == null ? null : Number(r.views) || 0; }

function applySrcFilters() {
  const q = (document.getElementById("src-search")?.value || "").trim().toLowerCase();
  const active = SRC_FILTERS
    .map((f) => [f.key, document.getElementById(f.id)?.value || ""])
    .filter(([, v]) => v);
  return SOURCES.filter((r) => {
    for (const [k, v] of active) if ((r[k] || "") !== v) return false;
    if (!q) return true;
    const hay = [r.title, r.creator, r.format_type, r.hook_pattern, r.niche_category,
                 r.target_audience, (r.format || {}).name, r.url]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function srcStats(rows) {
  const withViews = rows.map(srcViews).filter((v) => v != null);
  const repeats = rows.filter((r) => (r.tag_count || 1) > 1).length;
  const days = rows.length
    ? Math.max(1, Math.round(
        (Date.now() - new Date(rows.reduce((m, r) =>
          r.first_seen_at < m ? r.first_seen_at : m, rows[0].first_seen_at)).getTime())
        / 86400000))
    : 0;
  return [
    ["Videos pasted", rows.length, (v) => fmt(Math.round(v)),
      days ? `over ${days} day${days === 1 ? "" : "s"}` : ""],
    // The headline number this table exists to produce. Zero is a real, honest
    // answer while volume is low — it does NOT mean the meter is broken.
    ["Picked twice+", repeats, (v) => fmt(Math.round(v)),
      repeats ? "a format spreading" : "no repeats yet"],
    ["Formats seen", new Set(rows.map((r) => r.format_type).filter(Boolean)).size,
      (v) => fmt(Math.round(v)), ""],
    // Views are absent until the backfill runs, and "0" would be a lie.
    ["Median views", withViews.length ? median(withViews) : null,
      withViews.length ? compact : () => "—",
      withViews.length ? `${fmt(withViews.length)} of ${fmt(rows.length)} measured`
                       : "not fetched yet"],
  ];
}

function renderSrcStats(rows) {
  const cards = srcStats(rows);
  const host = document.getElementById("src-stats");
  if (!host) return;
  host.innerHTML = cards.map(([label, , , sub]) => `
    <div class="stat"><div class="label">${escapeHtml(label)}</div><div class="value"></div>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}</div>`).join("");
  host.querySelectorAll(".value").forEach((el, i) =>
    animateCount(el, cards[i][1] ?? NaN, cards[i][2]));
}

/** One pasted video. Collapsed it is a tile in the #src-list grid (owner,
    2026-09-16: "just make the database view a grid"): the cover is the face,
    the views chip, the .src-chips group and the ↗ ride on it, the title and date
    sit under it. Opened it spans the grid and is the old row again, showing the
    extracted FORMAT — the thing worth reading, and the thing the scraped table
    has no equivalent of. .src-chips is display: contents in the open row, and
    .src-plat-tile (the platform beside a pick count) is drawn on the tile only,
    so an opened card reads exactly as the row did. */
function srcCardHtml(r, open = false) {
  const f = r.format || {};
  const v = srcViews(r);
  const picks = r.tag_count || 1;
  const tags = [
    ["format", "format_type"], ["hook", "hook_pattern"], ["niche", "niche_category"],
    ["audience", "target_audience"], ["visual", "visual_hook"],
  ].filter(([, key]) => r[key]);
  /* EDITABLE (owner, 2026-09-16: "make the database tiles editable too", "on mobile too"): every
     text the opened card shows is an in-place line (agTopHtml / agWireInlineEdit), saved as a staff
     correction, never to lynxr_sources (see SOURCE_EDITS_ROW_ID). Views, platform, picks, date and
     URL are measurements and stay as they are.
     THE TITLE IS EDITED IN THE BODY, not in the header. The header is the <summary>: a click on it
     opens and closes the card, and interactive content inside a <summary> is invalid HTML whose
     clicks and keys would still toggle it. So the header (and the closed tile) keep the title as
     plain text that opens the card, and the opened card leads with a labelled title field;
     saving it updates the header in place. */
  const E = { ag: "src", id: r.canon };
  const line = (path, value, opts) => agTopHtml(value ?? "", path, E, opts);

  return `<details class="bp-item src-item" data-canon="${escapeHtml(r.canon)}"${open ? " open" : ""}>
    <summary>
      <span class="bp-caret" aria-hidden="true">▸</span>
      ${bpThumbHtml({ url: r.url, name: r.title || "" })}
      <span class="bp-name">${escapeHtml(r.title || sourceHostLabel(r.url))}</span>
      <span class="src-chips">${picks > 1
        ? `<span class="chip good" title="${picks} creators pasted this video">${picks}× picked</span>
           <span class="chip src-plat-tile">${escapeHtml(platformLabel(r.url))}</span>`
        : `<span class="chip">${escapeHtml(platformLabel(r.url))}</span>`}${
        r._edit ? `<span class="chip src-edited" title="Corrected by staff; the pipeline's version is kept">edited</span>` : ""}</span>
      ${v == null ? `<span class="chip src-views src-nodata" title="Metrics never fetched — run backfill_source_metrics.py">views —</span>`
                  : `<span class="chip src-views">${compact(v)} views</span>`}
      <span class="bp-when">${escapeHtml(agoLabel(r.last_seen_at))}</span>
      ${safeUrl(r.url || "") ? `<a class="bp-open" href="${escapeHtml(safeUrl(r.url))}"
        target="_blank" rel="noopener noreferrer" title="Open the original">↗</a>` : ""}
    </summary>
    <div class="bp-body">
      <div class="src-field"><span class="src-flbl">title</span>${line("title", r.title, { label: "title", afterLabel: true })}</div>
      ${r.creator ? `<p class="bp-hint src-field">${line("creator", r.creator, { label: "creator handle", cls: "ag-at" })}</p>` : ""}
      ${tags.length ? `<div class="src-tags">${tags.map(([k, key]) =>
        `<span class="src-tag"><i>${escapeHtml(k)}</i>${line(`tags.${key}`, r[key], { label: `${k} tag`, afterLabel: true })}</span>`).join("")}</div>` : ""}
      ${f.name ? `<div class="bp-heading">Format</div>
        <p class="src-fname">${line("format.name", f.name, { label: "format name" })}</p>` : ""}
      ${f.why_it_works ? `<p class="bp-hint src-why">${line("format.why_it_works", f.why_it_works, { label: "why it works", multiline: true })}</p>` : ""}
      ${Array.isArray(f.beats) && f.beats.length ? `<ol class="src-beats">${f.beats.map((b, i) =>
        `<li><span class="src-bt">${line(`beats.${i}.seconds`, String(b.seconds ?? ""),
            { label: `beat ${i + 1} seconds`, inputmode: "decimal" })}${b.seconds != null && b.seconds !== "" ? "s" : ""}</span>${
          line(`beats.${i}.role`, b.role || "", { label: `beat ${i + 1} role` })}</li>`).join("")}</ol>` : ""}
      ${!f.name && !(f.beats || []).length
        ? `<p class="bp-hint">No format extracted for this one yet.</p>` : ""}
      ${r._edit ? SRC_REVERT_HTML : ""}
    </div>
  </details>`;
}
/* Throws this video's corrections away, so it is armed like delete (armDelete, no confirm()). */
const SRC_REVERT_HTML = `<div class="bp-actions src-actions"><button type="button" class="ghost src-revert"
  title="Drop the staff corrections and show the pipeline's version">Revert to pipeline</button></div>`;

/** The URL's host, for a row whose title never arrived. Never the full
    permalink — eight near-identical instagram.com/p/… strings identify nothing. */
function sourceHostLabel(u) {
  const h = hostOf(u);
  return h ? `${platformLabel(u)} · ${h}` : "(untitled)";
}

function renderSources() {
  const host = document.getElementById("src-list");
  if (!host) return;

  if (SOURCES_STATE === "loading") {
    host.innerHTML = `<p class="bp-hint">Reading creator sources…</p>`;
    return;
  }
  // AN EMPTY LIST IS ALMOST CERTAINLY THE POLICY, NOT AN EMPTY TABLE. The rows
  // exist — the pipeline has been writing them since day one — but RLS returns
  // [] rather than an error to a caller with no select policy, so "no results"
  // would send the next person debugging the query instead of the grant.
  if (SOURCES_STATE === "error" || !SOURCES.length) {
    host.innerHTML = `<div class="empty">
      <p><strong>No creator sources readable.</strong></p>
      <p>The pipeline writes <code>lynxr_sources</code> with the service key, which
         bypasses row-level security — so rows can exist here while the browser still
         reads none. If you expected videos, the staff read policy is probably not
         applied yet: run <code>supabase/sources_staff_read.sql</code> in the Supabase
         SQL editor, then reload.</p></div>`;
    ["src-count", "db-src-pill"].forEach((id) => {
      const el = document.getElementById(id); if (el) el.textContent = "0";
    });
    return;
  }

  const rows = applySrcFilters();
  const count = document.getElementById("src-count");
  if (count) count.textContent = rows.length === SOURCES.length
    ? fmt(rows.length) : `${fmt(rows.length)} of ${fmt(SOURCES.length)}`;

  host.innerHTML = rows.length
    ? rows.map((r) => srcCardHtml(r, SRC_OPEN.has(r.canon))).join("")
    : `<p class="bp-hint">Nothing matches those filters.</p>`;
  host.querySelectorAll("details.src-item").forEach((d) => d.addEventListener("toggle", () => {
    if (d.open) SRC_OPEN.add(d.dataset.canon); else SRC_OPEN.delete(d.dataset.canon);
  }));
  bindSourceEdits(host);

  // Covers resolve exactly as they do for blueprint rows — YouTube off the URL,
  // TikTok via oEmbed, and lynxr-covers for everything the pipeline has framed,
  // which is every row in this table.
  const thumbRows = rows.map((r) => bpThumbRow({ url: r.url }));
  fillTikTokThumbs(thumbRows);
  fillHostedCovers(thumbRows);
  host.querySelectorAll("summary a").forEach((el) =>
    el.addEventListener("click", (e) => e.stopPropagation()));
}

/** Everything around the list that counts tags: the bars, the filter menus, the pill. Redrawn
    after a correction, so a corrected tag is a filter option straight away. A filter already
    chosen stays chosen, even if no row carries that value any more. */
function renderSrcChrome() {
  const noPct = { pct: false };   // see the note on renderBars
  renderBars("src-by-format", countBy(SOURCES, "format_type"), 8, null, noPct);
  renderBars("src-by-hook", countBy(SOURCES, "hook_pattern"), 8, null, noPct);
  renderBars("src-by-niche", countBy(SOURCES, "niche_category"), 8, null, noPct);
  renderBars("src-by-platform", countBy(SOURCES, "platform"), 8, null, noPct);
  const pill = document.getElementById("db-src-pill");
  if (pill) pill.textContent = fmt(SOURCES.length);
  for (const f of SRC_FILTERS) {
    const el = document.getElementById(f.id);
    if (!el) continue;
    const keep = el.value;
    const vals = [...new Set([...SOURCES.map((r) => (r[f.key] || "").trim()), keep].filter(Boolean))].sort();
    el.innerHTML = `<option value="">${escapeHtml(f.label)}</option>`
      + vals.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    el.value = keep;
  }
}

function renderSourcesAll() {
  renderSrcStats(SOURCES);
  renderSrcChrome();
  renderSources();
}

/* CORRECTIONS IN PLACE. Every line in an opened tile saves through pushSourceEdit (a fresh read of
   the corrections row, this one field changed, the row written back), then SOURCES is rebuilt so
   search, the filters and the bars read the corrected values. No redraw of the list on a save,
   as with every other in-place line; only a Revert redraws it (opened tiles stay open). */
function bindSourceEdits(host) {
  const rawOf = (canon) => SOURCES_RAW.find((x) => canonUrl(x.url || "") === canon);
  const rowOf = (canon) => SOURCES.find((x) => x.canon === canon);
  const tileOf = (canon) => [...host.querySelectorAll("details.src-item")].find((d) => d.dataset.canon === canon);
  // After a save: the chip, the Revert button and the header title follow the stored state.
  const settle = (canon) => {
    const tile = tileOf(canon), r = rowOf(canon);
    if (!tile || !r) return;
    const name = tile.querySelector("summary > .bp-name");
    if (name) name.textContent = r.title || sourceHostLabel(r.url);
    const chips = tile.querySelector(".src-chips");
    const chip = chips?.querySelector(".src-edited");
    if (r._edit && chips && !chip) chips.insertAdjacentHTML("beforeend",
      `<span class="chip src-edited" title="Corrected by staff; the pipeline's version is kept">edited</span>`);
    if (!r._edit) chip?.remove();
    const body = tile.querySelector(".bp-body");
    const rev = body?.querySelector(".src-actions");
    if (r._edit && body && !rev) { body.insertAdjacentHTML("beforeend", SRC_REVERT_HTML); wireRevert(body.querySelector(".src-revert")); }
    if (!r._edit) rev?.remove();
    const before = new Set(SOURCES.map((x) => x.format_type).filter(Boolean)).size;
    renderSrcChrome();
    if (document.querySelector("#src-stats .stat:nth-child(3) .value")?.textContent !== fmt(before)) renderSrcStats(SOURCES);
  };
  const wireRevert = (btn) => {
    if (!btn) return;
    armDelete(btn, "Revert", async () => {
      const canon = btn.closest("details.src-item")?.dataset.canon;
      if (!canon) return;
      btn.disabled = true;
      try {
        SOURCE_EDITS = await pushSourceEdit(canon, () => null);
      } catch {
        btn.disabled = false;
        agLineMsg(btn, "Couldn't revert. Check the connection and try again.");
        return;
      }
      srcRebuild();
      renderSrcStats(SOURCES);
      renderSrcChrome();
      renderSources();
    });
  };
  host.querySelectorAll(".src-revert").forEach(wireRevert);

  agWireInlineEdit(host, (el) => {
    const canon = el.dataset.agid;
    if (!rawOf(canon)) return null;
    return {
      readTop: (path) => srcFieldValue(rowOf(canon), path),
      check: (path, val) => (/\.seconds$/.test(path) && !/^\d+(\.\d+)?$/.test(val.trim())
        ? "Seconds must be a number, like 12 or 3.5. The “s” is added for you." : ""),
      writeTop: async (path, val) => {
        const raw = rawOf(canon);
        if (!raw) throw new Error("gone");
        SOURCE_EDITS = await pushSourceEdit(canon, (e) => srcSetField(e, raw, path, val));
        srcRebuild();
        return srcFieldValue(rowOf(canon), path);   // seconds come back as the number stored
      },
      failText: () => "Couldn't save that correction. Check the connection and try again.",
      saved: () => settle(canon),
      repaint: () => renderSources(),
    };
  });

  // A tag pill, a beat row or a field row is a bigger target than its words (a phone matters
  // here): a tap anywhere on it edits its value, caret at the end.
  host.querySelectorAll(".src-tag, .src-beats > li, .src-field").forEach((box) => box.addEventListener("click", (e) => {
    if (e.target.closest("[contenteditable], button, a")) return;
    const target = e.target.closest(".src-bt")?.querySelector("[contenteditable]")
      || [...box.querySelectorAll("[contenteditable]")].pop();
    if (!target) return;
    target.focus();
    const sel = getSelection();
    sel.selectAllChildren(target);
    sel.collapseToEnd();
  }));
}

function initSourcesUi() {
  document.getElementById("src-search")?.addEventListener("input", renderSources);
  for (const f of SRC_FILTERS) {
    document.getElementById(f.id)?.addEventListener("change", renderSources);
  }
  document.getElementById("src-reset")?.addEventListener("click", () => {
    const s = document.getElementById("src-search"); if (s) s.value = "";
    for (const f of SRC_FILTERS) {
      const el = document.getElementById(f.id); if (el) el.value = "";
    }
    renderSources();
  });

  // The switch between the two databases. Sources is the default view; the
  // scraped corpus stays one click away and completely unchanged behind it.
  const wire = (btnId, showId, hideId, otherBtnId) =>
    document.getElementById(btnId)?.addEventListener("click", () => {
      document.getElementById(showId).hidden = false;
      document.getElementById(hideId).hidden = true;
      const on = document.getElementById(btnId), off = document.getElementById(otherBtnId);
      on.classList.add("on"); on.setAttribute("aria-pressed", "true");
      off.classList.remove("on"); off.setAttribute("aria-pressed", "false");
    });
  wire("db-mode-sources", "db-sources", "db-archive", "db-mode-archive");
  wire("db-mode-archive", "db-archive", "db-sources", "db-mode-sources");
}

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
          // Empty slots only. Swapping a ytimg thumbnail for ours was tried and
          // reverted: fetch_covers.py SOURCED the YouTube covers from ytimg, so
          // ours are 360x270 — the same 4:3 — and the swap bought nothing but an
          // extra request per row. object-fit below is what actually fixes the
          // shape mismatch.
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
/** The views chip on a card's cover: creator.js's eye glyph (EYE_SVG) and the
    count, with the word kept for screen readers. `text` is already compacted. */
function viewsChipHtml(text, title = "") {
  return `<span class="vchip vviews"${title ? ` title="${escapeHtml(title)}"` : ""}>`
    + `<svg class="ico-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
    + `<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`
    + `${escapeHtml(text)}<span class="sr-only"> views</span></span>`;
}
// The creator twin of this function, embedForUrl(), was removed 2026-08-24
// when the creator app moved to self-hosted 480p clips played in a native
// <video> — see creator.js's refPlayHtml(). No file needs to be kept in sync
// with this one any more; the agency shelf, modal and viewer below still use
// embeds and this function is unchanged.
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

// ---- Opportunity score: 1–10 on the VIDEO TYPE ----
// "43.3× its pocket" was accurate and unreadable. This answers the question a
// brief actually asks — should we make this kind of video? — on two axes:
//
//   ROOM   how crowded this type is: its share of every video in the same
//          niche on the same platform. Less crowded is better.
//   REACH  how it performs: its median views against the median type in that
//          same niche+platform. Higher is better.
//
// A "type" is format × hook, scoped to niche × platform — scoping matters,
// because a TikTok median compared against a YouTube one is meaningless.
// 1 = crowded AND weak (don't bother). 10 = rare AND strong (go now).
//
// The four bounds are the measured p10/p90 of each axis across all 192 types
// with >= POCKET_MIN members, so the scale is calibrated to this corpus rather
// than invented. Log-scaled: both distributions are heavily skewed (share runs
// 1.8%→29%, reach 0.26×→3.04× with a 250× tail). The resulting spread over
// scriptable types is a clean curve from 2 to 10.
const SHARE_LO = 0.018, SHARE_HI = 0.293;
const REACH_LO = 0.26,  REACH_HI = 3.04;
const TYPE_MIN_PEERS = 3;   // a scope needs a few types before ranking means anything
let TYPE_SCORES = null, TYPE_SCORES_FOR = null;

const typeKey = (r) =>
  [r.niche_category, r.platform, r.format_type, r.hook_pattern].join("|");

/** log-normalise x into 0..1 between lo and hi. */
function logNorm(x, lo, hi) {
  if (!(x > 0)) return 0;
  const t = (Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return Math.max(0, Math.min(1, t));
}

/** Map(typeKey -> {score, room, reach, n, med}) over the whole corpus. */
function buildTypeScores(rows) {
  if (TYPE_SCORES && TYPE_SCORES_FOR === rows) return TYPE_SCORES;
  const groups = new Map();
  for (const r of rows) {
    if (views(r) <= 0) continue;
    if (!r.niche_category || !r.platform || !r.format_type || !r.hook_pattern) continue;
    const k = typeKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(views(r));
  }
  // Scope = niche × platform. Both axes are measured inside it.
  const scopes = new Map();
  for (const [k, vs] of groups) {
    if (vs.length < POCKET_MIN) continue;
    const s = k.split("|").slice(0, 2).join("|");
    if (!scopes.has(s)) scopes.set(s, []);
    scopes.get(s).push({ k, n: vs.length, med: median(vs) });
  }
  TYPE_SCORES = new Map();
  for (const [, types] of scopes) {
    if (types.length < TYPE_MIN_PEERS) continue;
    const total = types.reduce((a, t) => a + t.n, 0);
    const scopeMed = median(types.map((t) => t.med)) || 1;
    for (const t of types) {
      const share = t.n / total;
      const reach = t.med / scopeMed;
      const room = 1 - logNorm(share, SHARE_LO, SHARE_HI);
      const good = logNorm(reach, REACH_LO, REACH_HI);
      TYPE_SCORES.set(t.k, {
        score: Math.round(1 + 9 * (0.5 * room + 0.5 * good)),
        room, reach, share, n: t.n, med: t.med,
      });
    }
  }
  TYPE_SCORES_FOR = rows;
  return TYPE_SCORES;
}

/** The 1–10 for this video's type, or null when its type is too thin to judge. */
const typeScore = (r) => buildTypeScores(ALL).get(typeKey(r)) || null;

/** Plain-English read of a score, for the chip's tooltip and the details row. */
function scoreVerdict(s) {
  if (s >= 9) return "wide open and performing — make this now";
  if (s >= 7) return "room to run, and it performs";
  if (s >= 5) return "workable — middle of the pack on both counts";
  if (s >= 3) return "crowded or underperforming — needs a strong angle";
  return "saturated and weak — don't bother";
}

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

  // The 1-10 LEADS the ranking; the per-video edge only orders videos that
  // share a score. As a multiplicative tilt it was useless — `edge` spans
  // orders of magnitude, so it swamped a 0.55-1.5 factor and the top six cards
  // came back 5,5,6,6,7,6 while 10/10 types sat unseen further down. The whole
  // point of the score is "make this kind of video", so it has to sort first.
  // Unscored types rank as a 5 rather than being buried.
  const typeRank = (r) => (typeScore(r)?.score ?? 5);

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
    scored.push({ row: r, edge, tier: typeRank(r), score: edge.x * avatarBoost(r, ctx) });
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
  const byTierThenEdge = (a, b) => (b.tier - a.tier) || (b.score - a.score);
  for (const s of scored.filter((s) => s.edge.x <= cut).sort(byTierThenEdge)) {
    const k = `${s.row.format_type}×${s.row.hook_pattern}`;
    if ((perCombo.get(k) || 0) >= SUGGEST_CAP) continue;
    perCombo.set(k, (perCombo.get(k) || 0) + 1);
    picks.push(s);
    if (picks.length >= count) break;
  }
  return memo({ picks, ...stats, cut });
}

// ---------- Brief cart ----------
// ANY SIZE (owner, 2026-09-22: "it won't let me save the brief unless i got 10 videos in there,
// just make it so i can make the brief at any amount"). There was one number, 10, acting as BOTH
// the floor for Save and the ceiling for picking. Both are gone: one video is a brief, and there
// is no upper stop. Scripts still differ per slot — tailoredScript() indexes its features and CTAs
// with slot % length, so slot 11 reads as well as slot 1.
let CART = new Map();        // rowKey -> row
/* rowKey -> { beats, hook, cta }, for scripts edited in the video modal before the brief exists
   (each part only once edited; hook / cta may be "" = cleared). The rows are the shared database
   rows, so an edit cannot be written onto them; it waits here and becomes the saved item's
   editedBeats / editedHook / editedCta when the brief is saved. Cleared with the cart. */
let DRAFT_EDITS = new Map();
/** A draft as the saved item's override fields. */
function agDraftFields(d) {
  const o = {};
  if (d.beats) o.editedBeats = d.beats;
  if (d.hook != null) o.editedHook = d.hook;
  if (d.cta != null) o.editedCta = d.cta;
  return o;
}

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
      <span class="tray-count"><strong>${n}</strong> ${n === 1 ? "video" : "videos"} in brief</span>
      <span class="tray-hint">${n ? "ready to save" : "check any video to add it"}</span>
      <span class="spacer"></span>
      <button type="button" class="ghost" id="tray-copy" ${n ? "" : "disabled"}>Copy scripts</button>
      <button type="button" class="btn" id="tray-export" ${n ? "" : "disabled"}
        title="${n ? "Saves into the Briefs tab — flip through videos and scripts there" : "Add at least one video"}">
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

const cartSlot = (key) => Math.max([...CART.keys()].indexOf(key), 0);
function scriptHtml(row) {
  const k = rowKey(row);
  const s = agScriptFor(row, BRIEF_CTX, cartSlot(k), DRAFT_EDITS.get(k));
  return `
    <div class="vscript">${agScriptBodyHtml(s, { ag: "dr", id: k })}
    </div>`;
}

// ---------- Video detail modal ----------
// Shelf cards stay light (title + one stat); everything else lives here.
let SHELF_CTX = null;   // { index: Map(key -> row), relative: fn } from the last renderShelf

function setPicked(key, on) {
  const row = SHELF_CTX?.index.get(key);
  if (!row) return false;
  if (on) {
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
    const s = agScriptFor(row, BRIEF_CTX, cartSlot(key), DRAFT_EDITS.get(key));
    const text = `${s.heading}\n${s.hook ? `Hook: “${s.hook}”\n` : ""}${s.beats.join("\n")}\n${s.cta}`;
    try { await navigator.clipboard.writeText(text); copyBtn.textContent = "Copied ✓"; } catch {}
  });
  /* LINE EDITS here are drafts (DRAFT_EDITS) until the brief is saved; saveCurrentBrief moves them
     onto the saved items. Only the script redraws, so a playing video keeps playing. */
  const vscript = document.querySelector("#modal .vscript");
  const syncRevert = (on) => {
    const actions = document.querySelector("#modal .modal-actions");
    let btn = actions?.querySelector(".modal-revert");
    if (!on) { btn?.remove(); return; }
    if (!actions || btn) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost modal-revert";
    btn.textContent = "Revert edits";
    btn.title = "Discard the line edits and show the script as written";
    actions.append(btn);
    armDelete(btn, "Revert edits", () => { DRAFT_EDITS.delete(key); drawScript(); });
  };
  const drawScript = () => {
    if (!vscript || !BRIEF_CTX) return;
    vscript.innerHTML = agScriptBodyHtml(
      agScriptFor(row, BRIEF_CTX, cartSlot(key), DRAFT_EDITS.get(key)), { ag: "dr", id: key });
    wireScript();
    syncRevert(agDraftEdited(DRAFT_EDITS.get(key)));
  };
  const script = () => agScriptFor(row, BRIEF_CTX, cartSlot(key), DRAFT_EDITS.get(key));
  const patchDraft = (part) => DRAFT_EDITS.set(key, { ...(DRAFT_EDITS.get(key) || {}), ...part });
  const wireScript = () => agWireInlineEdit(vscript, () => (BRIEF_CTX ? {
    read: () => script().beats,
    write: (beats) => patchDraft({ beats }),
    readTop: (field) => agTopOf(script(), field),
    writeTop: (field, val) => {
      if (field !== "hook" && field !== "cta") throw new Error("no such line");
      patchDraft({ [field]: agTopStored(script(), field, val) });
    },
    saved: () => { agMarkEdited(vscript.querySelector(".bp-heading")); syncRevert(true); },
    repaint: drawScript,
  } : null));
  wireScript();
  syncRevert(!!BRIEF_CTX && agDraftEdited(DRAFT_EDITS.get(key)));
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
      <form class="post-form" id="av-form" novalidate>
        <input type="url" id="av-url" placeholder="Add a specific video by link — it joins this brief now, full data follows"
          autocomplete="off" spellcheck="false">
        <button type="submit" class="btn" id="av-add">Add video</button>
      </form>
      <p class="note" id="av-note" aria-live="polite">Not in the database yet? Paste any TikTok / Instagram / Facebook / YouTube link. It's added
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
        <div class="vface">
          ${frameHtml(r)}
          ${viewsChipHtml(`${compact(views(r))} · ${relative(r).toFixed(1)}×`, "views · index vs its source's median")}
          ${/^Tier [123]$/.test(r.reach_confidence_tier || "") ? `<span class="vchip tier-chip t${r.reach_confidence_tier.slice(-1)}"
            title="Reach confidence: ${escapeHtml(r.reach_confidence_tier)} — this format×hook combo repeats across ${escapeHtml(r.similar_format_count || "?")} videos averaging ${compact(+r.avg_views_of_similar || 0)} views">${escapeHtml(r.reach_confidence_tier)}</span>` : ""}
        </div>
        <div class="vmeta">
          <div class="vtitle" title="${escapeHtml(r.title || "")}">${escapeHtml(r.title || "(no caption)")}</div>
          <div class="vrow vacts">
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
  /* Clear-when-fixed, and the help text comes back: the refusal below writes
     into #av-note, which is also where the explanation of this form lives. */
  const avField = document.getElementById("av-url");
  const avHelp = document.getElementById("av-note")?.textContent || "";
  avField?.addEventListener("input", () => {
    if (avField.value.trim() && !ingestibleLink(avField.value)) return;
    if (clearInvalid(avField)) document.getElementById("av-note").textContent = avHelp;
  });
  if (avForm) avForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const avUrl = document.getElementById("av-url");
    const url = normalizeClientUrl(avUrl.value);
    const note = document.getElementById("av-note");
    const btn = document.getElementById("av-add");
    const refuse = (text) => { note.textContent = text; markInvalid(avUrl, "av-note"); avUrl.focus(); if (avUrl.value) avUrl.select(); };
    if (!avUrl.value.trim()) { refuse(`Paste a ${SUPPORTED_LIST} video link first.`); return; }
    if (!url) { refuse(`That isn't a link — paste the address of a ${SUPPORTED_LIST} video.`); return; }
    // Same allowlist as the blueprint form — this path calls queueVideoIngest,
    // so an off-platform link becomes a pipeline job too.
    if (!platformOf(url)) {
      const h = hostOf(url);
      refuse(`Only ${SUPPORTED_LIST} links can be ingested`
        + (h ? ` — that one is from ${h}.` : "."));
      return;
    }
    clearInvalid(avUrl);
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
let SB_UID = null;        // auth.uid() of the signed-in staff account; used by agSend()
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
  SB_UID = sess.user?.id || SB_UID;
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
  SB_UID = sess.user?.id || SB_UID;
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
  return rows.filter((r) => r.id !== INGEST_QUEUE_ID && r.id !== TOMBSTONE_ROW_ID && r.id !== SOURCE_EDITS_ROW_ID)
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

// A third reserved row: staff CORRECTIONS to the pasted-video database (owner, 2026-09-16: "make
// the database tiles editable too", and an edit changes "only what staff see"). lynxr_sources is
// read-only to staff and written by the pipeline with the service key, so a correction can never go
// there: it lives here, staff-only through is_staff(), and is laid over the fetched row at render
// time (srcApplyEdit). A re-tag rewrites lynxr_sources and never touches this row, so a correction
// survives it; Revert deletes the video's entry and the pipeline's values show again.
//   data = { [canonUrl]: { title?, creator?, tags?: { format_type?, hook_pattern?, niche_category?,
//            target_audience?, visual_hook? }, format?: { name?, why_it_works?,
//            beats?: [{ seconds, role }] }, editedAt, editedBy? } }
// Only fields that differ from the pipeline are kept; a field typed back to the pipeline's value is
// dropped, and an entry with nothing left in it is deleted. beats, once corrected, is the whole list.
const SOURCE_EDITS_ROW_ID = "source-edits";

async function sbSourceEdits() {
  const rows = await sbFetch(`/rest/v1/lynxr_clients?id=eq.${SOURCE_EDITS_ROW_ID}&select=data`);
  const d = rows?.[0]?.data;
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
}

/** Change ONE video's correction and write the row back. The row is read fresh first, as
    pushSharedTombstones does, so a teammate's correction to another video (or to another field of
    this one) made since the page loaded is kept. `change` gets this video's current entry (a copy,
    or null) and returns the new entry, or null to drop it. Resolves to the whole map as written. */
async function pushSourceEdit(canon, change) {
  const next = { ...(await sbSourceEdits()) };
  const cur = change(next[canon] ? JSON.parse(JSON.stringify(next[canon])) : null);
  if (cur) next[canon] = cur;
  else delete next[canon];
  await sbFetch("/rest/v1/lynxr_clients", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: SOURCE_EDITS_ROW_ID, data: next, updated_by: SB_EMAIL || "" }),
  });
  return next;
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
  // Campaign briefs are staff-only, server-only rows keyed on client_id (no
  // FK) — they never ride the local-storage sync above, so they need their
  // own delete. Formats cascade off the campaign in Postgres.
  sbFetch(`/rest/v1/lynxr_campaigns?client_id=eq.${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
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
    // agEditInFlight: script lines are contenteditable, which the tag test cannot see, and a
    // changed-but-unsaved line has no focus at all.
    const editing = (document.activeElement
      && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) || agEditInFlight();
    // Campaign briefs hold work that lives only in the page until it is sent:
    // pasted links in the composer, an open brand editor, a format editor. A
    // teammate's client edit must not repaint any of those away.
    if (briefsShown && !editing && !cbUnsavedWork()) renderBriefs();
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

/* THE CLIENT-DETAILS DRAFT (owner, 2026-09-22: "just make it so i can add everything manually
   cause it messed up when i put in the link and refreshed all my text … like the creator side
   where i can just type everything in and save it manually").
   Two things went wrong before: reading a site re-rendered the details form, so anything typed was
   replaced by what the reader found (or by blanks when it failed), and the details only ever
   reached storage as part of a saved brief, so a reload lost them. Now every keystroke in the
   editor is kept here, the form fills from this draft FIRST and from the site read only where the
   draft is empty, and "Save client" writes the client into the Clients tab with no brief at all. */
const CLIENT_DRAFT_KEY = "lynxr_client_draft";
function loadClientDraft() {
  try { return JSON.parse(localStorage.getItem(CLIENT_DRAFT_KEY)) || {}; } catch { return {}; }
}
function saveClientDraft(d) {
  try { localStorage.setItem(CLIENT_DRAFT_KEY, JSON.stringify(d)); } catch { /* private window */ }
}

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
  if (!CART.size) return;
  const company = BRIEF_CTX?.brand || "Client";
  const niche = document.getElementById("brief-niche")?.value || "";
  const rec = {
    id: newId(), company, ctx: BRIEF_CTX || {}, niche,
    createdAt: new Date().toISOString(),
    // A script edited in the modal keeps its edits: the draft becomes the item's overrides.
    items: [...CART].map(([k, r]) => (DRAFT_EDITS.has(k) ? { ...r, ...agDraftFields(DRAFT_EDITS.get(k)) } : r)),
  };
  const list = loadClients();
  const client = findOrCreateClient(list, company, BRIEF_CTX, niche);
  client.briefs.unshift(rec);
  persistClients(list);

  // Wrap up for the next client: clear cart, reopen the details editor.
  CART = new Map();
  DRAFT_EDITS = new Map();
  closeModal();
  const editor = document.getElementById("client-editor");
  if (editor) {
    editor.classList.remove("collapsed");
    renderShelf(document.getElementById("brief-niche")?.value || "");
  }
  // Land inside the client folder with the new brief on top.
  CLIENT_VIEW = { id: client.id };
  BRIEF_VIEW = null;
  CAMPAIGN_VIEW = null;
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
    const s = agScriptFor(row, ctx, i - 1, DRAFT_EDITS.get(rowKey(row)));   // what the modal shows
    out += `SCRIPT ${i} — ${s.heading}\n${s.hook ? `Hook: “${s.hook}”\n` : ""}`;
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

/** Make a whole card its own open button: click, Enter or Space. Replaces the
    "Open" button that used to sit on each row — the card is a big obvious
    target and the button was redundant beside it. Controls INSIDE the card
    (the trash icon) stop propagation themselves, so they still win. */
function openOnCard(card, onOpen) {
  card.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, label, select, textarea")) return;
    onOpen();
  });
  card.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target !== card) return;
    e.preventDefault();
    onOpen();
  });
}

/** The trash face shared by every destructive icon button (creator-app style). */
const TRASH_SVG = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`;

function renderBriefs() {
  const host = document.getElementById("briefs-host");
  const list = loadClients();

  // Any render that does not land on a campaign view stops its poll timer, so
  // leaving the view (crumb, back, another client) can never leave it running.
  if (!CAMPAIGN_VIEW || !CLIENT_VIEW) cbStopPoll();

  if (CLIENT_VIEW) {
    const client = list.find((c) => c.id === CLIENT_VIEW.id);
    if (client) {
      // Campaign first: BRIEF_VIEW is cleared whenever a campaign is open, so
      // renderApp's arrow-key brief flipper has nothing to act on here.
      if (CAMPAIGN_VIEW) {
        BRIEF_VIEW = null;
        renderCampaignView(host, client, CAMPAIGN_VIEW.id);
        return;
      }
      if (BRIEF_VIEW) {
        const rec = client.briefs.find((b) => b.id === BRIEF_VIEW.id);
        if (rec) { renderBriefViewer(host, rec, client); return; }
        BRIEF_VIEW = null;
      }
      renderClientPage(host, client);
      return;
    }
    CLIENT_VIEW = null;
    CAMPAIGN_VIEW = null;
    cbStopPoll();
  }

  // AGENCY GLASS PASS (2026-09-15): each view's heading and content float as one island.
  if (!list.length) {
    host.innerHTML = `<div class="section"><h2>Clients</h2>
      <div class="empty">${emptyMark("idle")}<p><strong>No clients yet.</strong></p>
        <p>Save a brief in the New Client tab — its company becomes your first client folder.</p></div></div>`;
    return;
  }

  host.innerHTML = `<div class="section"><h2>Clients <span class="pill">${list.length}</span></h2>
    <div class="brief-stack">` + list.map((c) => `
      <article class="bcard opens" data-id="${escapeHtml(c.id)}"
        role="button" tabindex="0" aria-label="Open ${escapeHtml(c.company)}">
        <div class="bcard-main">
          <div class="bcard-title">${escapeHtml(c.company)}</div>
          <div class="lbl">${escapeHtml(c.niche || "All niches")}${c.ctx?.audience ? " · " + escapeHtml(c.ctx.audience) : ""}
            · ${c.briefs.length} brief${c.briefs.length === 1 ? "" : "s"}</div>
        </div>
        <button type="button" class="ghost danger icon-only b-del"
          aria-label="Delete this client" title="Delete this client">${TRASH_SVG}</button>
      </article>`).join("") + `</div></div>`;

  host.querySelectorAll(".bcard").forEach((card) => {
    const id = card.dataset.id;
    openOnCard(card, () => { CLIENT_VIEW = { id }; BRIEF_VIEW = null; CAMPAIGN_VIEW = null; renderBriefs(); });
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
  // Brand-context fields typed by staff in the Edit brand form (campaign
  // briefs). Content, so .cb-bval keeps their casing; the rows above predate
  // it and are left as they were.
  const brow = (label, val) => val
    ? `<div class="sug-drow"><span class="sug-dk">${label}</span><span class="sug-dv cb-bval">${escapeHtml(String(val))}</span></div>` : "";
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
      ${brow("description", ctx.description)}
      ${brow("tone", ctx.tone)}
      ${brow("cta", ctx.cta)}
      ${brow("site", ctx.site)}
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

/* The same four platforms the creator app accepts, matched the same way — see
   the long note over PLATFORMS in creator.js. Blueprints go through
   process_blueprints.py, which downloads and transcribes exactly like the
   creator pipeline, so an off-platform link costs the same and fails the same.
   Kept as a copy rather than shared: these two files load on different pages
   and have never imported each other. Change one, change the other. */
const PLATFORMS = [
  ["TikTok",    ["tiktok.com"]],
  ["Instagram", ["instagram.com"]],
  // Facebook and YouTube are off — same cut as creator.js, same date, same
  // reason; see the comment there. Old rows keep their labels.
];
const SUPPORTED_LIST = "TikTok or Instagram";
const hostOf = (raw) => {
  try {
    const s = String(raw || "").trim();
    return new URL(s.includes("://") ? s : "https://" + s).hostname
      .toLowerCase().replace(/^www\./, "");
  } catch { return ""; }
};
function platformOf(raw) {
  const host = hostOf(raw);
  if (!host) return null;
  for (const [label, domains] of PLATFORMS) {
    if (domains.some((d) => host === d || host.endsWith("." + d))) return label;
  }
  return null;
}
// "Link" still has to exist: the 9,016-row database and every blueprint saved
// before this gate carry whatever they carried, and thumbFor() keys off it.
const platformLabel = (u) => platformOf(u) || "Link";

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
  const inner = thumb ? `<img class="vthumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">`
    : pending ? `<span class="vthumb-pending"></span>`
    : `<span class="vthumb-none">${escapeHtml(platformLabel(row.url).slice(0, 2))}</span>`;
  // Clicking the frame opens the original post, same as the ↗ at the end of the
  // row — the thumbnail is the bigger target and is what looks like the video.
  // The ELEMENT STAYS `.bp-thumb`, an anchor instead of a span, so every layout
  // rule keeps applying and `[data-url] .vthumb-pending` still finds its slot
  // when a cover arrives late. Uploads have no url and stay a plain span.
  // An UPLOAD has no url, and safeUrl("") is not empty — it resolves against
  // location.origin and returns the current page — so the emptiness has to be
  // tested before safeUrl, not after, or every upload row would link to the app.
  const href = row.url ? safeUrl(row.url) : "";
  const tag = href
    ? `a class="bp-thumb" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"
         aria-label="Open the original post"`
    : `span class="bp-thumb"`;
  return `<${tag} data-url="${escapeHtml(row.url)}">${inner}</${href ? "a" : "span"}>`;
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
/* AGENCY SCRIPT LOOK (owner, 2026-09-15: "for both creator and agency make the scripts look
   like this revamp one", then "make the agency mobile scripts match too"). Beats render in the
   creator app's own markup (creator.js beatRow, and its Original scripts view for timed ones),
   so the creator's script rules paint them: app.css appends an agency selector to each of those
   rules rather than restating a value here. AG_TIMED is the creator's timed beat markup as it
   landed. RENDER ONLY: same data, same words, same handlers. */
const AG_TIMED = { ol: "bp-beats bp-orig", li: "bp-beat", time: "bp-time", trailing: true };
/** One beat card. rows = [[label, kind, value], …], kind is "say" | "do" | "show" | "onscreen";
 *  an empty value drops its row, and a beat with no rows renders nothing. DO, SHOW and ON SCREEN
 *  dim in a spoken script, the way creator.js dims them; a silent script dims nothing, because
 *  there the direction IS the script. The time goes last in the first row (or first, if the
 *  creator's landed grid leads with it), so a second row leaves that grid cell empty. */
function agBeatHtml(t, rows, spoken, timed, edit) {
  /* EDITABLE IN PLACE (owner, 2026-09-16), creator.js beatRow's model: with `edit` ({ ag, id, mode,
     i }) the value span IS the input. data-ag / data-agid say which script it belongs to, data-agmode
     how its stored beat is parsed, data-beat and data-field which part of which beat; agWireInlineEdit
     does the rest. ON SCREEN is the campaign beat's `show` field. Without `edit` it is read-only. */
  const pairs = rows.filter((r) => r[2]).map(([label, kind, value]) => {
    const attrs = !edit ? "" :
      ` contenteditable="plaintext-only" role="textbox" tabindex="0" spellcheck="false"` +
      ` aria-label="${label.toLowerCase()}, beat ${edit.i + 1}" data-edit="beat" data-ag="${edit.ag}"` +
      ` data-agid="${escapeHtml(edit.id)}" data-agmode="${edit.mode}" data-beat="${edit.i}"` +
      ` data-field="${kind === "onscreen" ? "show" : kind}"`;
    return `<span class="bp-lbl bp-lbl-${kind}">${label}</span>` +
      `<span class="bp-val bp-${kind}${spoken && kind !== "say" ? " bp-dim" : ""}"${attrs}>${escapeHtml(value)}</span>`;
  });
  if (!pairs.length) return "";
  if (!timed) return `<li class="bp-beat">${pairs.join("")}</li>`;
  const time = t ? `<span class="${AG_TIMED.time}">${escapeHtml(t)}</span>` : "";
  const first = AG_TIMED.trailing ? pairs[0] + time : time + pairs[0];
  return `<li class="${AG_TIMED.li}">${first}${pairs.slice(1).join("")}</li>`;
}
/** The list: the creator's timed list when the beats carry times, its brand-script list when not. */
function agBeatsHtml(items, timed) {
  return items ? `<ol class="${timed ? AG_TIMED.ol : "bp-beats bp-notime"}">${items}</ol>` : "";
}
/** A tailored script (brief viewer, video modal) in the creator's order: the hook card, the
 *  heading, the beats. A real script parses like a blueprint (spoken words plus ON SCREEN
 *  notes; a shot-by-shot plan is silent). A pattern template's beats are directions, so each
 *  is one DO row — they are instructions, not lines to read out. */
/** How a tailored script's beat strings parse: a real script is spoken or silent (bpBeatHtml), a
 *  pattern template's beats are one DO line each. */
function agScriptMode(s) {
  return !s.real ? "template" : /shot-by-shot plan/.test(s.heading) ? "silent" : "spoken";
}
/** A row's script as it shows: tailoredScript, with the saved line edits (row.editedBeats,
 *  editedHook, editedCta) or an unsaved brief's draft ({ beats, hook, cta }) laid over it. An edited
 *  hook or CTA may be "" (cleared, so not drawn), which is why those test != null. Copy and export
 *  read this as well, so they hand over what is on the screen, not the version underneath. */
function agScriptFor(row, ctx, slot, draft) {
  const s = tailoredScript(row, ctx, slot);
  const e = draft || { beats: row.editedBeats, hook: row.editedHook, cta: row.editedCta };
  const out = { ...s };
  if (e.beats) out.beats = e.beats;
  if (e.hook != null) out.hook = e.hook;
  if (e.cta != null) out.cta = e.cta;
  if (e.beats || e.hook != null || e.cta != null) out.edited = true;
  return out;
}
/** Does a brief item, or a modal draft, carry any line edit? */
const agItemEdited = (it) => !!it && (!!it.editedBeats || it.editedHook != null || it.editedCta != null);
const agDraftEdited = (d) => !!d && (!!d.beats || d.hook != null || d.cta != null);
/** A tailored CTA is stored with its label ("[last 3s] CTA: …"); only the words after it are the
 *  line, so the label is never typed over. [label, words]. */
function agCtaParts(cta) {
  const m = /^(\[[^\]]*\]\s*CTA:\s*)([\s\S]*)$/.exec(String(cta ?? ""));
  return m ? [m[1], m[2]] : ["", String(cta ?? "")];
}
/** A tailored script's hook or CTA as its line shows it (the CTA without its label); null for any
 *  other field (a tailored script has no caption). */
function agTopOf(s, field) {
  return field === "hook" ? String(s.hook ?? "") : field === "cta" ? agCtaParts(s.cta)[1] : null;
}
/** What to store for an edited hook or CTA line: a CTA keeps the label it had; cleared is "". */
function agTopStored(s, field, val) {
  return field === "cta" && val ? agCtaParts(s.cta)[0] + val : val;
}
/** A hook, CTA or caption value as its own in-place line: creator.js's data-edit="top" span.
 *  `edit` is { ag, id }; without it the value is plain text, as before. A caption keeps its line
 *  breaks (.ag-caption, aria-multiline).
 *  quoted: the value is shown in curly quotes. Read-only, they stay literal text; editable, app.css
 *  draws them inside the span (.ag-quoted), because the edit stripe sits 7px left of the words, and
 *  that is exactly where a literal opening quote is: the stripe and the field's wash covered it.
 *  afterLabel: the span follows a label on the same line (a tailored CTA's "[last 3s] CTA:"), so
 *  its left padding is the gap (.ag-after-label) instead of reaching back over the label's colon. */
function agTopHtml(value, field, edit, {
  quoted = false, afterLabel = false, multiline = field === "caption", label = field, cls = "", inputmode = "",
} = {}) {
  if (!edit) return quoted ? `“${escapeHtml(value)}”` : escapeHtml(value);
  return `<span class="bp-val${field === "hook" ? " bp-hookval" : ""}${field === "caption" ? " ag-caption" : ""}` +
    `${quoted ? " ag-quoted" : ""}${afterLabel ? " ag-after-label" : ""}${cls ? " " + cls : ""}"` +
    ` contenteditable="plaintext-only" role="textbox" tabindex="0" spellcheck="false"` +
    `${multiline ? ` aria-multiline="true"` : ""}${inputmode ? ` inputmode="${inputmode}"` : ""}` +
    ` aria-label="${escapeHtml(label)}" data-edit="top" data-ag="${edit.ag}"` +
    ` data-agid="${escapeHtml(edit.id)}" data-field="${escapeHtml(field)}">${escapeHtml(value ?? "")}</span>`;
}
/** One stored beat string as a line card; `edit` makes its lines editable (see agBeatHtml). */
function agBeatLineHtml(bt, mode, edit) {
  if (mode !== "template") return bpBeatHtml(bt, mode === "silent", edit);
  const p = agBeatParse(bt, mode);
  return agBeatHtml(p.t, [["DO", "do", p.do?.v]], false, true, edit);
}
function agScriptBodyHtml(s, edit) {
  const mode = agScriptMode(s);
  const beats = s.beats.map((bt, i) => agBeatLineHtml(bt, mode, edit ? { ...edit, mode, i } : null)).join("");
  const [ctaLbl, ctaWords] = agCtaParts(s.cta);
  return `
      ${s.hook ? `<div class="bp-hook"><span class="bp-hook-lbl">Hook</span>${agTopHtml(s.hook, "hook", edit, { quoted: true })}</div>` : ""}
      <div class="bp-heading">Tailored script — ${escapeHtml(s.heading)}${s.edited ? ` <span class="chip">edited</span>` : ""}</div>
      ${agBeatsHtml(beats, true)}
      ${s.cta ? `<p class="vs-beat vs-cta">${!edit ? escapeHtml(s.cta)
        : escapeHtml(ctaLbl.trimEnd()) + agTopHtml(ctaWords, "cta", edit, { afterLabel: !!ctaLbl })}</p>` : ""}`;
}
/* EVERY LINE IS SHOWN (owner, 2026-09-16: "show the repeated do lines too and make them editable",
   then "make the agency show lines editable too"). A DO or SHOW that repeated the beat before used to
   be blanked (~6 frames are sampled per video, so neighbouring beats often share a shot); a blanked
   line had nothing to click, so that beat could not be edited in place. Nothing collapses now. */
function bpBeatHtml(bt, silent, edit) {
  const p = agBeatParse(bt, silent ? "silent" : "spoken");
  return agBeatHtml(p.t, [["SAY", "say", p.say?.v], ["DO", "do", p.do?.v], ["SHOW", "show", p.show?.v]],
    p.bare || !silent, true, edit);
}

/** THE ONE PARSER for a stored beat string, and it keeps POSITIONS, so an in-place edit can replace
 *  one line's characters and leave every other byte of the string exactly as the pipeline (or the
 *  pencil editor) wrote it. The shapes, from realScript and tailoredScript:
 *    spoken   "[0–3s] words" + optional "\n   ON SCREEN: direction" + optional " — text: “overlay”"
 *    silent   "[4s] direction" + optional " — on-screen text: “overlay”" (the words, if any, are
 *             before an ON SCREEN line exactly as in spoken)
 *    template "[0–2s] direction" — one DO line, the whole text after the time
 *    no "[time]" at all (typed in the pencil editor): the whole string is one SAY line, or one DO
 *             line in a template.
 *  Returns { str, t, bare, say, do, show }; each line is null or { v, s, e, cs, ce }: v is what is
 *  shown and str.slice(s, e) === v; [cs, ce) is the whole clause, separator included, which is what
 *  goes when that line is cleared. The regexes are the ones bpBeatHtml always used, so what renders
 *  is unchanged. */
function agBeatParse(bt, mode) {
  const str = String(bt);
  const out = { str, t: "", bare: false, say: null, do: null, show: null };
  const lead = (x) => x.length - x.trimStart().length;
  const line = (s, v, cs = s, ce = s + v.length) => (v ? { v, s, e: s + v.length, cs, ce } : null);
  const m = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(str);
  if (!m) {
    out.bare = true;
    out[mode === "template" ? "do" : "say"] = line(0, str);
    return out;
  }
  out.t = m[1];
  const r0 = str.length - m[2].length;
  let restS = r0 + lead(m[2]);
  let rest = m[2].trim();
  if (mode === "template") { out.do = line(restS, rest); return out; }

  // Peel the on-screen overlay off the end: — text: “X”  /  — on-screen text: “X”. Only the words
  // between the quote marks are the line; the dash, the label and the quote marks stay put.
  const om = /[—–-]\s*(?:on[- ]screen\s+)?text:\s*[“"]([\s\S]*?)[”"]\s*$/di.exec(rest);
  if (om) {
    const [gs, ge] = om.indices[1];
    const raw = rest.slice(gs, ge);
    const head = rest.slice(0, om.index);
    out.show = line(restS + gs + lead(raw), raw.trim(), restS + head.trimEnd().length, restS + rest.length);
    restS += lead(head);
    rest = head.trim();
  }

  // Then separate the spoken words from the direction.
  const dm = /\n\s*ON SCREEN:\s*([\s\S]*)$/di.exec(rest);
  if (dm) {
    const [gs, ge] = dm.indices[1];
    const raw = rest.slice(gs, ge);
    const head = rest.slice(0, dm.index);
    out.do = line(restS + gs + lead(raw), raw.trim(), restS + dm.index, restS + rest.length);
    out.say = line(restS + lead(head), head.trim());
  } else {
    out[mode === "silent" ? "do" : "say"] = line(restS, rest);
  }
  return out;
}

/** The beat string with one line replaced by `val`, every other byte unchanged. Returns "" when
 *  that empties the whole beat (the beat is deleted, the pencil editor's rule), and null when the
 *  result would not parse back to exactly these lines (a SAY cleared out from above an ON SCREEN
 *  line, a value that itself looks like "— text: “…”", …): that edit is refused rather than
 *  guessed at, and the pencil editor stays the way to restructure a beat. */
function agBeatSplice(bt, mode, field, val) {
  const p = agBeatParse(bt, mode);
  const cur = p[field];
  if (!cur) return null;
  const want = { say: p.say?.v || "", do: p.do?.v || "", show: p.show?.v || "", [field]: val };
  const same = (s) => {
    const q = agBeatParse(s, mode);
    return q.t === p.t && q.bare === p.bare && ["say", "do", "show"].every((k) => (q[k]?.v || "") === want[k]);
  };
  const str = p.str;
  if (val) {
    const s = str.slice(0, cur.s) + val + str.slice(cur.e);
    return same(s) ? s : null;
  }
  if (!want.say && !want.do && !want.show) return "";
  for (const [a, b] of [[cur.cs, cur.ce], [cur.s, cur.e]]) {
    const s = str.slice(0, a) + str.slice(b);
    if (same(s)) return s;
  }
  return null;
}

const agNorm = (v) => (v || "").replace(/\s+/g, " ").trim();
const agText = (v) => String(v ?? "").replace(/\r\n?/g, "\n");   // a caption: exact, bar CRLF
/** Is a script line being typed in, or changed and not yet saved, under `root`? A repaint then would
 *  throw the change away, so every repaint guard asks (creator.js editInFlight, same rule). */
function agEditInFlight(root = document) {
  const a = document.activeElement;
  return !!(a && a.isContentEditable && root.contains(a)) || !!root.querySelector("[data-edit].is-pending");
}
/** Put "edited" beside a heading once, when the first line edit lands (no repaint does it). */
function agMarkEdited(heading) {
  if (!heading || [...heading.querySelectorAll(".chip")].some((c) => c.textContent === "edited")) return;
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = "edited";
  heading.append(" ", chip);
}
/** A note under the script being edited: a refused or failed save. Cleared by the next save or undo. */
function agLineMsg(el, text) {
  // under the beat list, the hook card, or the CTA / caption paragraph the line sits in
  const list = el.closest("ol.bp-beats, .bp-hook, .src-tags, ol.src-beats") || el.parentElement;
  if (!list) return;
  let m = list.nextElementSibling;
  if (!text) { if (m?.classList.contains("ag-edit-msg")) m.remove(); return; }
  if (!m?.classList.contains("ag-edit-msg")) {
    m = document.createElement("p");
    m.className = "bp-msg ag-edit-msg show bad";
    m.setAttribute("role", "status");
    list.after(m);
  }
  m.textContent = text;
}

/** Scroll a line being edited clear of the sticky header and of whatever covers the bottom of the
 *  screen: on a phone the on-screen keyboard shrinks the visual viewport, and the line typed into
 *  must stay above it. Runs on focus and whenever the visual viewport resizes (the keyboard opening).
 *  Does nothing when the line is already in view. */
function agKeepInView(el) {
  if (!el?.isConnected) return;
  const vv = window.visualViewport;
  const r = el.getBoundingClientRect();
  const head = document.querySelector("#app > header")?.getBoundingClientRect().bottom || 0;
  const top = Math.max(vv ? vv.offsetTop : 0, head) + 8;
  const bottom = (vv ? vv.offsetTop + vv.height : innerHeight) - 12;
  if (r.bottom > bottom) window.scrollBy(0, Math.min(r.bottom - bottom, r.top - top));
  else if (r.top < top) window.scrollBy(0, r.top - top);
}
{
  // the visual viewport is what a phone keyboard shrinks; a window resize is the fallback for
  // browsers that resize the layout viewport instead (and does no harm where both fire)
  const keep = () => {
    const a = document.activeElement;
    if (a?.isContentEditable && a.dataset.edit) requestAnimationFrame(() => agKeepInView(a));
  };
  window.visualViewport?.addEventListener("resize", keep);
  window.addEventListener("resize", keep);
}

/* AGENCY SCRIPT LINES, EDITED IN PLACE (owner, 2026-09-16: "make the do lines for any script on any
   side of lynxr be editable the same way"). creator.js's model, line for line: the value span is the
   input, a changed line is not saved until its tick or Enter, the cross or Escape puts it back, blur
   keeps the change pending, and paste is plain text. The same classes (.bp-val[contenteditable],
   .is-pending, .edit-confirm, .edit-ok, .edit-no) carry the same indicator.
   What differs is storage. `store(el)` returns the script a line belongs to:
     { read() -> the current beats, fresh from storage (strings; {t, say, do, show} objects when the
         line's data-agmode is "fields"),
       write(beats) -> saves the whole list as the override (may be async, may throw),
       readTop(field) -> the hook / cta / caption as it shows now (null if the script has none),
       writeTop(field, value) -> saves that one override ("" = cleared, as creator.js allows),
       saved(field) -> marks the script edited on screen, repaint() -> redraws it from storage,
       pencil -> true where the pencil editor exists, failText(ex) -> a failed save's sentence }
   Hook and CTA lines are data-edit="top", like creator.js's (added 2026-09-16: "make the hook and
   cta lines editable too", then "make the caption lines editable too"). A CAPTION KEEPS ITS LINE
   BREAKS: its value is compared and saved as typed (only CRLF becomes LF), where every other line
   collapses whitespace as creator.js does, and Shift+Enter adds a break; Enter still saves. Any
   line with aria-multiline="true" gets that behaviour (a caption; a source's "why it works").
   check(field, value) -> a sentence when the value cannot be saved on that line (nothing is written).
   A string beat is changed through agBeatSplice, so only the edited line's characters move. Before
   writing, the line's stored value must still be the one the page drew; if a sync or another tab
   changed it, the save is refused and the script redrawn rather than written over. */
function agWireInlineEdit(root, store) {
  if (!root) return;
  const rowOf = (el) => el.closest("li.bp-beat, .bp-hook, .src-tag, .src-beats > li") || el.parentElement;
  const multi = (el) => el.getAttribute("aria-multiline") === "true";
  const valOf = (el, v) => (multi(el) ? agText(v) : agNorm(v));
  const clearPending = (el) => {
    el.classList.remove("is-pending");
    rowOf(el).querySelector(".edit-confirm")?.remove();
  };
  const revertEdit = (el) => {
    if (el.dataset.was !== undefined) el.textContent = el.dataset.was;
    clearPending(el);
    agLineMsg(el, "");
  };
  const commitEdit = async (el) => {
    const val = valOf(el, el.textContent);
    const was = valOf(el, el.dataset.was);
    if (val === was) { clearPending(el); return; }            // nothing to save
    const st = store(el);
    if (!st || el.dataset.saving) return;
    const i = Number(el.dataset.beat), field = el.dataset.field, mode = el.dataset.agmode;
    const conflict = () => {
      st.repaint();
      const q = `[data-ag="${el.dataset.ag}"][data-agid="${CSS.escape(el.dataset.agid)}"]`;
      const again = document.querySelector(`[data-edit="${el.dataset.edit}"]${q}[data-field="${field}"]`)
        || document.querySelector(`[data-edit]${q}`);
      if (again) agLineMsg(again, "This script changed since the page drew it, so that line wasn't saved. This is the saved version.");
    };
    if (el.dataset.edit === "top") {
      const now = st.readTop ? st.readTop(field) : null;
      if (now == null || valOf(el, now) !== was) { conflict(); return; }
      const out = val.trim() ? val : "";                      // cleared: the line is not drawn next time
      const why = st.check ? st.check(field, out) : "";       // a value this line cannot hold
      if (why) { agLineMsg(el, why); return; }
      el.dataset.saving = "1";
      let shown;
      try {
        shown = await st.writeTop(field, out);                // may hand back the value as stored
      } catch (ex) {
        agLineMsg(el, st.failText ? st.failText(ex) : "Couldn't save that line. Try again.");
        return;
      } finally {
        delete el.dataset.saving;
      }
      agLineMsg(el, "");
      el.textContent = shown == null ? out : String(shown);
      el.dataset.was = el.textContent;
      clearPending(el);
      st.saved(field);
      return;
    }
    const beats = st.read() || [];
    const cur = beats[i];
    const now = cur == null ? null
      : mode === "fields" ? String(cur[field] ?? "") : (agBeatParse(cur, mode)[field]?.v ?? null);
    if (now === null || agNorm(now) !== was) { conflict(); return; }
    let next;
    if (mode === "fields") {
      const b = { ...cur, [field]: val };
      next = agNorm(b.say) || agNorm(b.do) || agNorm(b.show) ? b : "";
    } else {
      next = agBeatSplice(cur, mode, field, val);
    }
    if (next === null) {
      agLineMsg(el, "That change can't be saved on this line without rewriting the rest of the beat. "
        + (st.pencil ? "Use the pencil to edit the whole beat, or press Esc to undo." : "Press Esc to undo."));
      return;
    }
    const list = beats.slice();
    if (next === "") list.splice(i, 1);                       // every line cleared: the beat goes
    else list[i] = next;
    el.dataset.saving = "1";
    try {
      await st.write(list);
    } catch (ex) {
      agLineMsg(el, st.failText ? st.failText(ex) : "Couldn't save that line. Try again.");
      return;
    } finally {
      delete el.dataset.saving;
    }
    agLineMsg(el, "");
    if (next === "") { st.repaint(); return; }                // the row goes, and later indices shift
    el.textContent = val;
    el.dataset.was = val;                                     // the new baseline for the next Escape
    clearPending(el);
    st.saved(field);
  };
  const showPending = (el) => {
    if (el.classList.contains("is-pending")) return;
    el.classList.add("is-pending");
    const wrap = document.createElement("span");
    wrap.className = "edit-confirm";
    wrap.innerHTML =
      `<button type="button" class="edit-ok" aria-label="Save this line" title="Save this line (Enter)">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg></button>` +
      `<button type="button" class="edit-no" aria-label="Discard this change" title="Discard this change (Esc)">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    // mousedown, as in creator.js: the line keeps its caret until the button has acted. click still
    // reaches a keyboard press (Tab to the tick, Enter), which fires no mousedown.
    const ok = wrap.querySelector(".edit-ok"), no = wrap.querySelector(".edit-no");
    ok.addEventListener("mousedown", (e) => { e.preventDefault(); commitEdit(el); });
    no.addEventListener("mousedown", (e) => { e.preventDefault(); revertEdit(el); });
    ok.addEventListener("click", (e) => { if (e.detail === 0) { commitEdit(el); el.focus(); } });
    no.addEventListener("click", (e) => { if (e.detail === 0) { revertEdit(el); el.focus(); } });
    rowOf(el).appendChild(wrap);
    // the tick and cross sit under the line: on a phone, keep them above the keyboard too
    if (document.activeElement === el) requestAnimationFrame(() => agKeepInView(wrap));
  };
  root.querySelectorAll("[data-edit][data-ag]").forEach((el) => {
    // The undo value is captured at wire time, not on focus (see creator.js for why).
    el.dataset.was = el.textContent;
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData("text/plain");
      document.execCommand("insertText", false, valOf(el, t));
    });
    el.addEventListener("input", () => {
      if (valOf(el, el.textContent) === valOf(el, el.dataset.was)) clearPending(el);
      else showPending(el);
    });
    // stopPropagation: the video modal closes on a document-level Escape, and a line's Escape
    // means "undo this line", not "close". Shift+Enter in a caption is a line break (the browser's
    // own, plain text in a plaintext-only field).
    // A phone keyboard covers the bottom of the screen: keep the line being edited above it.
    el.addEventListener("focus", () => setTimeout(() => { if (document.activeElement === el) agKeepInView(el); }, 300));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.shiftKey && multi(el)) { e.stopPropagation(); return; }
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commitEdit(el); el.blur(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); revertEdit(el); el.blur(); }
    });
  });
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
/* The hook is derived at render time too (realScript: the transcript's hook, else its first
   segment), so an in-place hook edit is an override beside editedBeats: b.editedHook, which may be
   "" (cleared). A blueprint has no CTA or caption line. Revert drops both overrides. */
const bpHook = (b, s) => b.editedHook ?? s?.hook ?? "";
const bpEdited = (b) => !!b.editedBeats || b.editedHook != null;

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
        ${bpHook(b, s) ? `<div class="bp-hook"><span class="bp-hook-lbl">Hook</span>${
          agTopHtml(bpHook(b, s), "hook", { ag: "bp", id: b.id }, { quoted: true })}</div>` : ""}
        <div class="bp-heading">${escapeHtml(s.heading)}${
          bpEdited(b) ? ` <span class="chip">edited</span>` : ""}</div>
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
              ${bpEdited(b) ? `<button type="button" class="ghost bp-revert" data-bpid="${id}"
                title="Discard your edits and show the pipeline's own version">Revert to original</button>` : ""}
            </div>
          </div>`
        : `<ol class="${AG_TIMED.ol}">${(b.editedBeats || s.beats).map((bt, i) =>
            /* each line also edits in place (agWireInlineEdit), into the same b.editedBeats override */
            bpBeatHtml(bt, !b.script?.has_speech,
              { ag: "bp", id: b.id, mode: b.script?.has_speech ? "spoken" : "silent", i })).join("")}</ol>`}
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
    ${/* Same component as the creator app's composer — .composer-row wraps the
          input and the arrow send button in one rounded pill, with .bp-plat
          sitting inline just left of the button. Reusing those classes rather
          than restyling a .post-form keeps the two sides identical for free.
          The outer sticky .composer wrapper is deliberately NOT used: that one
          pins to the foot of the creator's scrolling pane. */""}
    <form class="composer-row bp-form" id="bp-form" novalidate hidden>
      <input type="url" id="bp-url" placeholder="Paste a TikTok / Instagram / Facebook / YouTube link"
        autocomplete="off" spellcheck="false" aria-label="Paste a video link">
      <span class="bp-plat" id="bp-plat"></span>
      <button type="submit" class="composer-send" aria-label="Get the script">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      </button>
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
  // A link inside a <summary> would also toggle the card: the disclosure flip is
  // the summary's own activation behaviour, so the click has to be stopped at
  // the anchor. Its navigation is a default action and still happens.
  // This covers the thumbnail AND the ↗ beside it — the ↗ has always opened the
  // post and flipped the card open behind the new tab, which is the same bug
  // creator.js fixed with stopSummaryLinks(). Re-run on every render; the rows
  // are rebuilt, so the old listeners go with them.
  host.querySelectorAll("summary a").forEach((el) =>
    el.addEventListener("click", (e) => e.stopPropagation()));

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
    const plat = u ? platformOf(u) : null;
    platEl.textContent = u ? (plat || "not supported") : "";
    platEl.className = "bp-plat" + (u ? (plat ? " on" : " on bad") : "");
  };
  if (urlEl) { urlEl.addEventListener("input", showPlat); showPlat(); }
  // Clear-when-fixed: a link that now passes, or a box emptied to start over.
  urlEl?.addEventListener("input", () => {
    if (urlEl.value.trim() && !ingestibleLink(urlEl.value)) return;
    if (!clearInvalid(urlEl)) return;
    const m = document.getElementById("bp-msg");
    if (m) { m.textContent = ""; m.className = "bp-msg"; }
  });

  const bpForm = document.getElementById("bp-form");
  if (bpForm) bpForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rawUrl = (urlEl.value || "").trim();
    const url = rawUrl ? normalizeClientUrl(rawUrl) : null;
    /* An error here stays until the field is fixed (see the input listener
       above) — bpMsg's own 4.5s fade is for confirmations. */
    const refuse = (text) => {
      bpMsg(text, "bad"); clearTimeout(BP_MSG_T);
      markInvalid(urlEl, "bp-msg"); urlEl.focus(); if (rawUrl) urlEl.select();
    };
    if (!rawUrl) { refuse(`Paste a ${SUPPORTED_LIST} video link first.`); return; }
    if (!url) { refuse(`That isn't a link — paste the address of a ${SUPPORTED_LIST} video.`); return; }
    if (!platformOf(url)) {
      const h = hostOf(url);
      refuse(`Blueprints read ${SUPPORTED_LIST} links`
        + (h ? ` — that one is from ${h}.` : "."));
      return;
    }
    clearInvalid(urlEl);
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
    delete b.editedHook;
    persistClients(fresh);
    BP_EDITING.delete(btn.dataset.bpid);
    bpMsg("Back to the pipeline's version.", "good");
    bpKeepOpen(btn.dataset.bpid);
  }));

  /* IN-PLACE LINE EDITS land in the same b.editedBeats override the pencil editor writes (the hook
     in b.editedHook beside it), so the pencil's Revert and the "edited" chip cover all of them. */
  const findBp = (list, bpid) => list.find((c) => c.id === client.id)?.blueprints?.find((x) => x.id === bpid);
  agWireInlineEdit(host.querySelector(".bp-list"), (el) => {
    const bpid = el.dataset.agid;
    if (!findBp(loadClients(), bpid)) return null;
    return {
      pencil: true,
      read: () => {
        const b = findBp(loadClients(), bpid);
        if (!b) return null;
        return b.editedBeats || realScript(bpAsRow(b))?.beats || null;
      },
      write: (beats) => {
        const fresh = loadClients();
        const b = findBp(fresh, bpid);
        if (!b) throw new Error("gone");
        b.editedBeats = beats;
        persistClients(fresh);
      },
      readTop: (field) => {
        const b = findBp(loadClients(), bpid);
        return b && field === "hook" ? bpHook(b, realScript(bpAsRow(b))) : null;
      },
      writeTop: (field, val) => {
        const fresh = loadClients();
        const b = findBp(fresh, bpid);
        if (!b || field !== "hook") throw new Error("gone");
        b.editedHook = val;
        persistClients(fresh);
      },
      saved: () => agMarkEdited(el.closest(".bp-item")?.querySelector(".bp-heading")),
      repaint: () => bpKeepOpen(bpid),
    };
  });

  host.querySelectorAll(".bp-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const b = (loadClients().find((c) => c.id === client.id)?.blueprints || [])
        .find((x) => x.id === btn.dataset.bpid);
      const s = b && realScript(bpAsRow(b));
      if (!s) return;
      // b.editedBeats first: copy has to give you what is on the screen. `s` is
      // rebuilt from the transcript every call, so using s.beats here would
      // quietly hand back the pipeline's version and lose every manual edit.
      const hook = bpHook(b, s);
      const text = `${s.heading}\n` + (hook ? `HOOK: "${hook}"\n\n` : "\n")
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
  // The cover is the card's face (2026-09-16): views and the score ride on it
  // as chips, the creator library tile's layout. frameHtml stays untouched
  // inside .vface, and playInFrame only swaps the frame's own children, so the
  // chips survive a play.
  return `
  <article class="vcard sug-card${picked ? " picked" : ""}" data-key="${escapeHtml(k)}">
    <div class="vface">
      ${frameHtml(row)}
      ${viewsChipHtml(compact(views(row)))}
      ${(() => {
        const t = typeScore(row);
        if (!t) return `<span class="vchip sug-score s-none" title="Too few videos of this type to judge it">\u2013<i>/10</i></span>`;
        const band = t.score >= 7 ? "good" : t.score >= 5 ? "even" : "bad";
        return `<span class="vchip sug-score ${band}" tabindex="0" role="button" aria-label="Opportunity score ${t.score} out of 10">${t.score}<i>/10</i></span>`;
      })()}
    </div>
    <div class="vmeta">
      <div class="vtitle" title="${escapeHtml(row.title || "")}">${escapeHtml(row.title || "(no caption)")}</div>
      <div class="vrow sug-acts">
        <button type="button" class="sug-more" aria-expanded="false">Details</button>
        <label class="vpick"><input type="checkbox" class="sugcheck" ${picked ? "checked" : ""}><span class="vpick-txt">${picked ? "Added" : "Add"}</span></label>
      </div>
      <div class="sug-detail" hidden>
        ${detail("format", `${row.format_type || "\u2014"} \u00d7 ${row.hook_pattern || "\u2014"}`)}
        ${(() => {
          const t = typeScore(row);
          if (!t) return detail("score", "\u2013 (too few videos of this type)");
          return detail("score", `${t.score}/10 \u2014 ${scoreVerdict(t.score)}`)
            + detail("saturation", `${(t.share * 100).toFixed(1)}% of ${row.niche_category} on ${row.platform} (${t.n} videos)`)
            + detail("type reach", `${t.reach.toFixed(1)}\u00d7 the typical type here (${compact(t.med)} median)`);
        })()}
        ${detail("this video", `${edge.x.toFixed(1)}\u00d7 the ${compact(edge.med)} median of its ${edge.n} closest peers`)}
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

// One tooltip node for the whole page, parented to <body>. It CANNOT live
// inside the card: .vcard sets overflow:hidden, so anything overflowing a card
// is clipped. Fixed positioning against the chip's rect sidesteps that and any
// stacking context the grid introduces.
let SCORE_TIP = null;
function scoreTip() {
  if (!SCORE_TIP) {
    SCORE_TIP = document.createElement("div");
    SCORE_TIP.className = "score-tip";
    SCORE_TIP.hidden = true;
    document.body.appendChild(SCORE_TIP);
  }
  return SCORE_TIP;
}

/** Explain the number. Deliberately ONE line — the score, the axes and the
    per-video multiple all live in the card's Details panel, so the hover only
    has to say which way the scale runs. */
function showScoreTip(chip, row) {
  const tip = scoreTip();
  tip.innerHTML = `<span class="st-arrow"></span><p class="st-foot">${
    typeScore(row)
      ? "10 = hardly anyone makes it and it performs. 1 = everyone makes it and it flops."
      : "Too few videos of this type in the database to score it."}</p>`;
  tip.hidden = false;
  // Prefer above the chip, flip below when there is not room, and clamp to the
  // viewport on both axes so a card at any edge still shows the whole thing.
  const r = chip.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  const GAP = 8, EDGE = 8;
  const roomAbove = r.top - GAP, roomBelow = window.innerHeight - r.bottom - GAP;
  const above = tr.height <= roomAbove || roomAbove > roomBelow;
  tip.style.top = Math.max(EDGE, Math.min(window.innerHeight - tr.height - EDGE,
    above ? r.top - tr.height - GAP : r.bottom + GAP)) + "px";
  const left = Math.max(EDGE,
    Math.min(window.innerWidth - tr.width - EDGE, r.left + r.width / 2 - tr.width / 2));
  tip.style.left = left + "px";
  // The arrow points at the CHIP, not at the panel's own centre — the two part
  // company whenever the panel is clamped against a viewport edge.
  tip.classList.toggle("above", above);
  tip.classList.toggle("below", !above);
  const arrow = tip.querySelector(".st-arrow");
  if (arrow) {
    arrow.style.left = Math.max(12, Math.min(tr.width - 22,
      r.left + r.width / 2 - left - 5)) + "px";
  }
}
const hideScoreTip = () => { if (SCORE_TIP) SCORE_TIP.hidden = true; };

/** Wire one suggestion card: play, expand, and the add-to-brief tick. */
function bindSugCard(card, row, client) {
  const chip = card.querySelector(".sug-score");
  if (chip) {
    const show = () => showScoreTip(chip, row);
    chip.addEventListener("mouseenter", show);
    chip.addEventListener("focus", show);
    chip.addEventListener("mouseleave", hideScoreTip);
    chip.addEventListener("blur", hideScoreTip);
  }
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
    // No picks: the section's + (#cb-new) is the campaign composer now, so
    // this slot stays an empty placeholder until something is ticked.
    const slot = document.createElement("span");
    slot.id = "cl-nextbrief";
    slot.hidden = true;
    old.replaceWith(slot);
    return;
  }
  el.addEventListener("click", () => startNextWeekBrief(client));
  old.replaceWith(el);
}

function renderClientPage(host, client) {
  // Briefs are stored newest-first and numbered oldest-first so "Brief 1" is
  // where the client started — cbBriefItems keeps that numbering.
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
      <button type="button" class="ghost" id="cl-brand" aria-expanded="false" aria-controls="cl-brand-box">Edit brand</button>
      <button type="button" class="ghost" id="cl-details" aria-expanded="false">Details</button>
    </div>
    ${clientDetailsHtml(client)}
    ${clientBrandBoxHtml(client)}

    ${suggestionsBoxHtml(client)}

    ${blueprintsBoxHtml(client)}

    ${/* Every brief, both kinds, in one list — see briefsSectionHtml. */""}
    ${briefsSectionHtml(client)}
`;

  bindBlueprints(host, client);
  bindSuggestions(host, client);
  bindClientBrand(host, client);
  bindBriefsSection(host, client);
  document.getElementById("cl-back").addEventListener("click", () => {
    CLIENT_VIEW = null; BRIEF_VIEW = null; CAMPAIGN_VIEW = null; renderBriefs();
  });
  const detBtn = document.getElementById("cl-details");
  detBtn?.addEventListener("click", () => {
    const panel = document.getElementById("cl-details-box");
    const open = panel.hasAttribute("hidden");
    panel.toggleAttribute("hidden", !open);
    detBtn.setAttribute("aria-expanded", String(open));
    detBtn.textContent = open ? "Hide details" : "Details";
  });
  // Brief cards (both kinds) and the section's + are wired in bindBriefsSection.
}

/** The expanded body of a script card: player, stats, tags, the tailored
    script, and this slot's tracked posts — everything in one place. */
function scriptDetailHtml(rec, client, i) {
  const row = rec.items[i];
  const s = agScriptFor(row, rec.ctx, i);   // with this item's saved line edits, if any
  const er = row.engagement_rate ? parseFloat(row.engagement_rate).toFixed(2) + "%" : "—";
  const href = safeUrl(row.url);
  const stat = (v, l) => `<div class="metric"><div class="m-val">${v}</div><div class="m-lbl">${l}</div></div>`;
  // AGENCY SCRIPT LOOK (2026-09-15): the creator's script markup; the video docks right as "The original".
  return `
    <div class="card-detail">
      <div class="ref-split">
      <div class="ref-main cd-info">
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
        <div class="vscript">${agScriptBodyHtml(s, { ag: "br", id: String(i) })}
        </div>
        <div class="cd-controls">
          <button type="button" class="ghost cd-prev" ${i === 0 ? "disabled" : ""}>← Script ${i}</button>
          <button type="button" class="ghost cd-copy">Copy script</button>
          <button type="button" class="ghost cd-close">Collapse</button>
          <button type="button" class="ghost cd-next" ${i === rec.items.length - 1 ? "disabled" : ""}>Script ${i + 2} →</button>
        </div>
      </div>
      <details class="bp-item ref-panel ag-original" open>
        <summary><span class="bp-caret" aria-hidden="true">▸</span><span class="bp-name">The original</span></summary>
        <div class="bp-body"><div class="ref-dock">${frameHtml(row).replace('class="vframe ', 'class="vframe viewer-player ')}</div></div>
      </details>
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
  return `<div class="section"><h2>Scripts <span class="pill">${rec.items.length}</span></h2>
    <div class="fmt-grid">${cards}</div></div>`;
}

function renderBriefViewer(host, rec, client) {
  // briefs are newest-first, so a lower index is a later week
  const total = client.briefs.length;
  const idx = client.briefs.findIndex((b) => b.id === rec.id);
  /* THE BRIEF AS IT IS NOW, read fresh on every call. `rec` is this render's copy and goes stale after
     the first in-place line edit (those write to a fresh loadClients() list and redraw only the
     script), so building from `rec` sent the pre-edit version — that was a bug in Send too. */
  const sendDoc = () => {
    const c = loadClients().find((x) => x.id === client.id) || client;
    return briefSendDoc((c.briefs || []).find((b) => b.id === rec.id) || rec, c);
  };
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
      <div class="minw0">
        <div class="bcard-title">Brief ${total - idx} <span class="pill">${total - idx} of ${total}</span></div>
        <div class="lbl">${escapeHtml(rec.company)} \u00b7 ${escapeHtml((rec.createdAt || "").slice(0, 10))}</div>
      </div>
      <div class="cb-export">
        <button type="button" class="btn cb-send-btn" id="cb-send-toggle"${rec.items.length ? "" : " disabled"}>${CB_ICON.send}<span>Send to creators</span></button>
      </div>
    </div>
    <p class="bp-msg cb-msg" id="bv-send-msg" role="status" aria-live="polite"></p>
    <div id="cb-send-wrap">${cbSendPanelHtml("brief", rec.id)}${cbSentListHtml("brief", rec.id, sendDoc)}</div>
    ${cbSendShowsFiles("brief", rec.id) ? "" : bfSectionHtml("brief", rec.id)}

    ${briefScriptsHtml(rec, client)}`;

  cbBindSend(host, "brief", rec.id, sendDoc,
    () => { if (BRIEF_VIEW?.id === rec.id) renderBriefsKeepScroll(); }, "bv-send-msg");
  if (ROSTER === null && !ROSTER_ERR) rostLoad();
  agEnsureSent("brief", rec.id, () => { if (BRIEF_VIEW?.id === rec.id) renderBriefsKeepScroll(); });
  bfBind(host, "brief", rec.id);   // file actions redraw only the files block — never this viewer

  document.getElementById("bv-back").addEventListener("click", () => { BRIEF_VIEW = null; CAMPAIGN_VIEW = null; renderBriefs(); });
  document.getElementById("bv-clients").addEventListener("click", () => {
    CLIENT_VIEW = null; BRIEF_VIEW = null; CAMPAIGN_VIEW = null; renderBriefs();
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
    /* LINE EDITS in the brief viewer are saved on the brief's own item (items[i].editedBeats, and
       editedHook / editedCta beside it), inside the client record, so they sync like the rest of
       the brief. Read the record fresh each time:
       `rec` and `row` are the render's copies and go stale after the first edit. */
    const liveRec = (list = loadClients()) =>
      list.find((c) => c.id === client.id)?.briefs?.find((b) => b.id === rec.id) || null;
    const vscript = detail?.querySelector(".vscript");
    const syncRevert = (on) => {
      const ctrls = detail?.querySelector(".cd-controls");
      let btn = ctrls?.querySelector(".cd-revert");
      if (!on) { btn?.remove(); return; }
      if (!ctrls || btn) return;
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost cd-revert";
      btn.textContent = "Revert edits";
      btn.title = "Discard the line edits and show the script as written";
      (ctrls.querySelector(".cd-copy") || ctrls.firstElementChild)?.after(btn);
      // Throws every edit on this script away, so it is armed, like delete (no confirm()).
      armDelete(btn, "Revert edits", () => {
        const fresh = loadClients();
        const it = liveRec(fresh)?.items?.[openIdx];
        if (it) { delete it.editedBeats; delete it.editedHook; delete it.editedCta; persistClients(fresh); }
        drawScript();
      });
    };
    const drawScript = () => {
      const r = liveRec();
      const it = r?.items?.[openIdx];
      if (!it || !vscript) { renderBriefs(); return; }
      vscript.innerHTML = agScriptBodyHtml(agScriptFor(it, r.ctx, openIdx), { ag: "br", id: String(openIdx) });
      wireScript();
      bfRepaint("brief", rec.id);                  // its files-on-beats rows, and the files block's lines
      syncRevert(agItemEdited(it));
    };
    const wireScript = () => agWireInlineEdit(vscript, () => ({
      read: () => {
        const r = liveRec();
        const it = r?.items?.[openIdx];
        return it ? agScriptFor(it, r.ctx, openIdx).beats : null;
      },
      write: (beats) => {
        const fresh = loadClients();
        const it = liveRec(fresh)?.items?.[openIdx];
        if (!it) throw new Error("gone");
        it.editedBeats = beats;
        persistClients(fresh);
      },
      readTop: (field) => {
        const r = liveRec();
        const it = r?.items?.[openIdx];
        return it ? agTopOf(agScriptFor(it, r.ctx, openIdx), field) : null;
      },
      writeTop: (field, val) => {
        const fresh = loadClients();
        const r = liveRec(fresh);
        const it = r?.items?.[openIdx];
        if (!it || (field !== "hook" && field !== "cta")) throw new Error("gone");
        it[field === "hook" ? "editedHook" : "editedCta"] = agTopStored(agScriptFor(it, r.ctx, openIdx), field, val);
        persistClients(fresh);
      },
      saved: () => { agMarkEdited(vscript.querySelector(".bp-heading")); syncRevert(true); bfRepaint("brief", rec.id); },
      repaint: drawScript,   // the script only: redrawing the card would stop a playing video
    }));
    wireScript();
    syncRevert(agItemEdited(row));
    detail?.querySelector(".cd-copy")?.addEventListener("click", async (e) => {
      const r = liveRec();
      const sc = agScriptFor(r?.items?.[openIdx] || row, r ? r.ctx : rec.ctx, openIdx);
      try {
        await navigator.clipboard.writeText(
          [sc.heading, sc.hook ? `Hook: \u201c${sc.hook}\u201d` : "", ...sc.beats, sc.cta].filter(Boolean).join("\n"));
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
  const field = document.getElementById("client-url");
  if (hasUrl && !url) {
    host.innerHTML = `<div class="warn" id="client-url-err" role="alert">That doesn't look like a website address. Try something like
      <code>clientsite.com</code> — or leave it empty and fill in the client details by hand.</div>`;
    markInvalid(field, "client-url-err");
    field?.focus(); field?.select();
    return;
  }
  clearInvalid(field);

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
  DRAFT_EDITS = new Map();

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
  // What was typed before wins over what the reader found, and survives a reload. `??`, not `||`:
  // a field the user deliberately cleared stays cleared.
  const draft = loadClientDraft();
  const draftNiche = draft.niche ?? chosen;
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
          <input type="text" id="ce-brand" value="${escapeHtml(draft.brand ?? analysis?.brand ?? "")}" placeholder="e.g. Medceptor"></label>
        <label class="ce-field"><span class="lbl">Niche</span>
          <select id="brief-niche">
            <option value="">Whole database (all niches)</option>
            ${niches.map((n) => `<option value="${escapeHtml(n)}"${n === draftNiche ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}
          </select></label>
        <label class="ce-field"><span class="lbl">Target audience</span>
          <select id="ce-audience">
            <option value="">Not sure</option>
            ${audiences.map((a) => `<option value="${escapeHtml(a)}"${a === (draft.audience ?? analysis?.audience) ? " selected" : ""}>${escapeHtml(a)}</option>`).join("")}
          </select></label>
        <label class="ce-field ce-wide"><span class="lbl">Features / selling points (comma-separated — these get written into the scripts)</span>
          <input type="text" id="ce-feats" value="${escapeHtml(draft.feats ?? (analysis?.feats || []).join(", "))}"
            placeholder="e.g. NCLEX practice questions, case walkthroughs, study planner"></label>
        <div class="ce-field ce-wide"><span class="lbl">Target avatar — who these videos are for (all four shape the ranking)</span>
          <div class="ce-avatar-grid">
            <label class="ce-field"><span class="lbl">Core statistics</span>
              <textarea id="ce-av-stats" rows="2"
                placeholder="e.g. 20–24, 2nd-year nursing student, part-time hospital job, tight budget">${escapeHtml(draft.stats ?? BRIEF_CTX?.avatarParts?.stats ?? "")}</textarea></label>
            <label class="ce-field"><span class="lbl">Daily habits</span>
              <textarea id="ce-av-habits" rows="2"
                placeholder="e.g. studies after night shifts, lives on TikTok study hacks, flashcards on the bus">${escapeHtml(draft.habits ?? BRIEF_CTX?.avatarParts?.habits ?? "")}</textarea></label>
            <label class="ce-field"><span class="lbl">Deep personal goals</span>
              <textarea id="ce-av-goals" rows="2"
                placeholder="e.g. pass the NCLEX first try, land an ICU job, make family proud">${escapeHtml(draft.goals ?? BRIEF_CTX?.avatarParts?.goals ?? "")}</textarea></label>
            <label class="ce-field"><span class="lbl">Major problems</span>
              <textarea id="ce-av-problems" rows="2"
                placeholder="e.g. overwhelmed by content volume, fails practice tests, no study plan, burnout">${escapeHtml(draft.problems ?? BRIEF_CTX?.avatarParts?.problems ?? "")}</textarea></label>
          </div>
        </div>
      </div>
      <div class="ce-actions">
        <button type="button" class="btn" id="ce-apply">Apply — build the shelf</button>
        <button type="button" class="ghost" id="ce-save">Save client</button>
        <span class="lbl" id="ce-msg" role="status" aria-live="polite"></span>
      </div>
      </div>
    </div>
    <div id="brief-body"></div>`;

  const val = (id) => (document.getElementById(id)?.value ?? "");
  const readEditor = () => ({
    brand: val("ce-brand"), niche: val("brief-niche"), audience: val("ce-audience"), feats: val("ce-feats"),
    stats: val("ce-av-stats"), habits: val("ce-av-habits"), goals: val("ce-av-goals"), problems: val("ce-av-problems"),
  });
  const ctxFromEditor = () => {
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
    saveClientDraft(readEditor());
    return niche;
  };
  const apply = () => {
    const niche = ctxFromEditor();
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
  // Every keystroke is kept, so nothing is lost to a reload or to reading a site.
  let draftTimer;
  const editor = document.getElementById("client-editor");
  editor.addEventListener("input", () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveClientDraft(readEditor()), 400);
  });
  editor.addEventListener("change", () => saveClientDraft(readEditor()));
  // Save client: writes these details into the Clients tab on their own, with no brief attached,
  // and leaves the editor open. A brief saved later finds the same client by name and merges.
  document.getElementById("ce-save").addEventListener("click", () => {
    const d = readEditor();
    const msg = document.getElementById("ce-msg");
    if (!d.brand.trim()) {
      document.getElementById("ce-brand").focus();
      if (msg) msg.textContent = "Add a company name first.";
      return;
    }
    const niche = ctxFromEditor();
    const list = loadClients();
    findOrCreateClient(list, BRIEF_CTX?.brand || d.brand.trim(), BRIEF_CTX, niche);
    persistClients(list);
    if (msg) msg.textContent = `Saved — ${d.brand.trim()} is in the Clients tab.`;
  });
  if (analysis) {
    apply();   // read succeeded: collapse to summary and build the shelf
  } else {
    renderShelf(chosen);   // manual path: keep the editor open for filling in
  }
}


function initBrief() {
  const form = document.getElementById("brief-form");
  /* Clear-when-fixed: the warning goes the moment the address parses (or the
     box is emptied — empty is a valid brief, filled in by hand). */
  const field = document.getElementById("client-url");
  field.addEventListener("input", () => {
    if (field.value.trim() && !normalizeClientUrl(field.value)) return;
    if (clearInvalid(field)) document.getElementById("client-url-err")?.remove();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try { await renderBrief(document.getElementById("client-url").value); }
    finally { btn.disabled = false; }
  });
}

// ---------- Campaign briefs ----------
// Agency batch campaign briefs (plan: ~/.claude/plans/agency-batch-campaign-brief.md).
// Paste 1-10 inspiration links for a client, get one editable format per link,
// written by the Fly worker's agency lane (pipeline/process_campaigns.py), then
// export a clean copy for creators. Staff only — lynxr_campaigns and
// lynxr_campaign_formats are gated on is_staff() (supabase/campaigns.sql).
//
// No daily spend cap here (owner decision 2026-09-14): agency work is metered
// under lynxr_costs.lane='agency' for visibility, but nothing in this app or
// the worker enforces a stop. The lane still never touches the creators' own
// 250/day breaker and always runs behind them in the queue.
//
// Everything here is prefixed cb/CB_ to avoid another SB_URL/say-style collision.

const CB_MAX_PASTE = 10;
const CB_MAX_FORMATS = 20;
const CB_POLL_MS = 5000;

let CAMPAIGN_VIEW = null;               // { id } when a campaign brief is open
let CB_CACHE = new Map();               // campaign id -> { campaign, formats, at }
let CB_LISTS = new Map();               // clientId -> { rows, at }

// Sending: who a campaign/legacy brief has been sent to, and whether the send
// panel is open. Keyed by `${sourceKind}:${sourceId}` so campaign and legacy
// briefs share the cache without colliding. Populated lazily, the same
// pattern as CB_CACHE/CB_LOADING above.
let AG_SENT = new Map();                // key -> { rows, error } | undefined = not loaded
const AG_LOADING = new Set();           // keys in flight
const CB_SEND_OPEN = new Set();         // source ids with the send panel open
// What is ticked in an OPEN send panel, per source key. A repaint rebuilds the panel (the campaign
// poll, the roster arriving; dropping a file did too until 2026-09-25 — bfRepaint now redraws only
// the files block), and before 2026-09-24 that unticked everyone and left "Send to 0 creators".
// Cleared on close, Cancel and a successful send.
const CB_SEND_PICKS = new Map();         // key -> Set of creator_id
const agSentKey = (kind, id) => `${kind}:${id}`;

/** Loads (or reloads with force=true) who a source has been sent to. Silent
    on error — the failure is only surfaced from inside the send panel, via
    ROSTER_ERR, so a page that never opens it stays quiet. */
async function agEnsureSent(sourceKind, sourceId, onDone, force) {
  const key = agSentKey(sourceKind, sourceId);
  if (!force && (AG_SENT.has(key) || AG_LOADING.has(key))) return;
  if (force && AG_LOADING.has(key)) return;
  AG_LOADING.add(key);
  try {
    const rows = await agSentFor(sourceKind, sourceId);
    AG_SENT.set(key, { rows, error: null });
  } catch (ex) {
    AG_SENT.set(key, { rows: [], error: cbError(ex) });
  } finally {
    AG_LOADING.delete(key);
    onDone?.();
  }
}

/** Classify a thrown sbFetch error into what the campaign UI can act on.
    sbFetch's Error message is `${status} ${body}` — see its definition above. */
function cbError(ex) {
  const msg = String(ex?.message || ex || "");
  if (/^404\b/.test(msg) || /PGRST205/.test(msg) || /does not exist/i.test(msg)) return "missing";
  if (/^40[13]\b/.test(msg) || /42501/.test(msg)) return "denied";
  return "other";
}

/** The campaign's brand_context shape, read off a lynxr_clients row. Every
    missing field is "" (features []) — never undefined, so brand_block-style
    rendering downstream never has to guard against it. */
function brandContextFromClient(c) {
  const ctx = c.ctx || {};
  const ap = ctx.avatarParts || {};
  return {
    name: ctx.brand || c.company || "",
    company: c.company || "",
    niche: c.niche || "",
    description: ctx.description || "",
    product: ctx.product || "",
    audience: ctx.audience || "",
    audienceNotes: ap.stats || "",
    painPoints: ap.problems || "",
    habits: ap.habits || "",
    goals: ap.goals || "",
    features: ctx.feats || [],
    valueProps: ctx.valueProps || "",
    tone: ctx.tone || "",
    cta: ctx.cta || "",
    site: ctx.site || "",
    notes: ctx.notes || "",
  };
}

/** The reverse of brandContextFromClient: a patch to MERGE into a client's ctx
    (never replace it — activeCreators/videosPerMonth/successViews30d and any
    other existing key must survive). `avatar` is the four avatarParts joined
    by "\n", in the same order renderBrief()'s apply() joins them, so the
    existing keyword matcher keeps working on campaign-sourced brand context. */
function brandContextToClientPatch(bc) {
  const avatarParts = {
    stats: bc.audienceNotes || "",
    problems: bc.painPoints || "",
    habits: bc.habits || "",
    goals: bc.goals || "",
  };
  const avatar = [avatarParts.stats, avatarParts.habits, avatarParts.goals, avatarParts.problems]
    .filter(Boolean).join("\n");
  return {
    niche: bc.niche || "",
    ctx: {
      brand: bc.name || "",
      description: bc.description || "",
      product: bc.product || "",
      audience: bc.audience || "",
      avatarParts,
      feats: (bc.features || []).slice(0, 8),
      valueProps: bc.valueProps || "",
      tone: bc.tone || "",
      cta: bc.cta || "",
      site: bc.site || "",
      notes: bc.notes || "",
      avatar,
    },
  };
}

/** Parse a pasted batch of links into one row per token, deduping within the
    paste and against `existingCanon` (a Set of canonUrl()s already on the
    campaign). Never throws on garbage input. */
function cbParseLinks(text, existingCanon = new Set()) {
  const seen = new Set();
  const tokens = String(text || "").split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  return tokens.map((raw) => {
    const url = normalizeClientUrl(raw);
    if (!url) return { raw, url: null, plat: null, ok: false, why: "not a link" };
    const host = hostOf(url);
    if (host === "youtube.com" || host === "youtu.be") {
      return { raw, url, plat: null, ok: false, why: "youtube" };
    }
    const plat = platformOf(url);
    if (!plat) return { raw, url, plat: null, ok: false, why: "not supported" };
    const key = canonUrl(url);
    if (seen.has(key) || existingCanon.has(key)) return { raw, url, plat, ok: false, why: "duplicate" };
    seen.add(key);
    return { raw, url, plat, ok: true, why: "" };
  });
}

/** The current, editable view of one format: the worker's generated script
    with any staff edits layered on top. */
function cbView(f) {
  return { ...(f.script || {}), ...(f.edited || {}) };
}

function cbProgress(formats) {
  const total = formats.length;
  let ready = 0, failed = 0;
  for (const f of formats) {
    if (f.status === "done") ready++;
    else if (f.status === "error") failed++;
  }
  return { total, ready, failed, working: total - ready - failed };
}

/** Short present-tense words for a queued/running format card. */
function cbStateWords(f) {
  if (f.status === "queued") {
    if (f.retry_at && new Date(f.retry_at).getTime() > Date.now()) return "retrying soon";
    return f.job === "script" ? "analyzed — writing next" : "waiting";
  }
  if (f.status === "running") {
    if (f.phase === "reading") return "reading the video";
    if (f.phase === "analyzing") return "analyzing";
    if (f.phase === "writing") return "writing";
  }
  return "working";
}

// Agency wording — do NOT reuse CREATOR_NOTES (creator.js), which promises
// refunds against a creator's own allowance. Nothing here is refundable.
const CB_ERROR_TEXT = {
  off_platform: "lynxr reads TikTok and Instagram links only right now.",
  fetch_age: "This video is age-restricted, so it can't be opened.",
  fetch_private: "This video is private.",
  fetch_gone: "This video was deleted or made unavailable.",
  fetch_unreadable: "That link isn't a single video lynxr can read.",
  fetch_geo: "This video isn't available where lynxr's servers run.",
  fetch_bot: "The platform blocked the download.",
  fetch_generic: "The video couldn't be downloaded.",
  ai_ours: "The writing step failed on our side after several tries.",
  ai_content: "lynxr couldn't write a usable format from this video.",
};
const cbErrorText = (kind) => CB_ERROR_TEXT[kind] || "Something went wrong with this format.";

const CB_LIGHT = "id,status,job,phase,attempts,retry_at,error_kind,retryable,updated_at";
const CB_FULL = CB_LIGHT + ",campaign_id,position,source_url,error_detail,regen_note,analysis,"
  + "script,script_prev,edited,internal_note,finished_at,cover:source->>cover,clip:source->>clip,"
  + "platform:source->>platform,duration:source->>duration,title:source->meta->>title";

/** Campaigns for one client, with a done/working/failed count per campaign.
    Populates CB_LISTS; call renderBriefsKeepScroll() after to paint it. */
async function cbListCampaigns(clientId) {
  const rows = await sbFetch(`/rest/v1/lynxr_campaigns?client_id=eq.${encodeURIComponent(clientId)}`
    + `&select=id,name,created_at&order=created_at.desc`);
  let counts = new Map();
  if (rows.length) {
    const ids = rows.map((r) => r.id).join(",");
    const formats = await sbFetch(`/rest/v1/lynxr_campaign_formats?campaign_id=in.(${ids})&select=campaign_id,status`);
    for (const f of formats) {
      const c = counts.get(f.campaign_id) || { total: 0, ready: 0, working: 0, failed: 0 };
      c.total++;
      if (f.status === "done") c.ready++;
      else if (f.status === "error") c.failed++;
      else c.working++;
      counts.set(f.campaign_id, c);
    }
  }
  const withCounts = rows.map((r) => ({ ...r, counts: counts.get(r.id) || { total: 0, ready: 0, working: 0, failed: 0 } }));
  CB_LISTS.set(clientId, { rows: withCounts, at: Date.now() });
  return withCounts;
}

/** Create a campaign and its formats in two writes. Returns the new campaign id. */
async function cbCreateCampaign({ clientId, name, instructions, brandContext, urls }) {
  const [campaign] = await sbFetch("/rest/v1/lynxr_campaigns", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      client_id: clientId, name: name || "", instructions: instructions || "",
      brand_context: brandContext || {}, created_by: SB_EMAIL || "",
    }),
  });
  if (urls.length) {
    try {
      await sbFetch("/rest/v1/lynxr_campaign_formats", {
        method: "POST",
        body: JSON.stringify(urls.map((url, i) => ({ campaign_id: campaign.id, position: i, source_url: url }))),
      });
    } catch (e) {
      // The campaign row already landed — don't leave a formats-less orphan
      // behind if this second write fails. Best-effort: if the delete also
      // fails, the composer still surfaces the original error either way.
      await sbFetch(`/rest/v1/lynxr_campaigns?id=eq.${campaign.id}`, { method: "DELETE" }).catch(() => {});
      throw e;
    }
  }
  return campaign.id;
}

/** Full load of one campaign + its formats, into CB_CACHE. */
async function cbLoadCampaign(id) {
  const [campaign, formats] = await Promise.all([
    sbFetch(`/rest/v1/lynxr_campaigns?id=eq.${id}&select=id,client_id,name,instructions,internal_notes,brand_context,created_at`)
      .then((rows) => rows[0]),
    sbFetch(`/rest/v1/lynxr_campaign_formats?campaign_id=eq.${id}&select=${CB_FULL}&order=position.asc`),
  ]);
  const rec = { campaign, formats, at: Date.now() };
  CB_CACHE.set(id, rec);
  return rec;
}

/** Cheap poll: light rows for every format, then a full re-fetch only for the
    ones whose updated_at moved. Returns whether anything changed. */
async function cbPoll(id) {
  const cached = CB_CACHE.get(id);
  if (!cached) { await cbLoadCampaign(id); return true; }
  const light = await sbFetch(`/rest/v1/lynxr_campaign_formats?campaign_id=eq.${id}&select=${CB_LIGHT}`);
  const byId = new Map(cached.formats.map((f) => [f.id, f]));
  const staleIds = light.filter((l) => (byId.get(l.id)?.updated_at) !== l.updated_at).map((l) => l.id);
  const deletedIds = new Set(light.map((l) => l.id));
  let changed = staleIds.length || cached.formats.some((f) => !deletedIds.has(f.id));
  if (staleIds.length) {
    const fresh = await sbFetch(`/rest/v1/lynxr_campaign_formats?id=in.(${staleIds.join(",")})&select=${CB_FULL}`);
    for (const f of fresh) byId.set(f.id, f);
  }
  for (const id2 of byId.keys()) if (!deletedIds.has(id2)) byId.delete(id2);
  cached.formats = light.map((l) => byId.get(l.id)).filter(Boolean)
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  cached.at = Date.now();
  return changed;
}

const cbPatchCampaign = (id, fields) => sbFetch(`/rest/v1/lynxr_campaigns?id=eq.${id}`,
  { method: "PATCH", body: JSON.stringify(fields) });
const cbPatchFormat = (id, fields) => sbFetch(`/rest/v1/lynxr_campaign_formats?id=eq.${id}`,
  { method: "PATCH", body: JSON.stringify(fields) });
const cbDeleteFormat = (id) => sbFetch(`/rest/v1/lynxr_campaign_formats?id=eq.${id}`, { method: "DELETE" });
const cbDeleteCampaign = (id) => sbFetch(`/rest/v1/lynxr_campaigns?id=eq.${id}`, { method: "DELETE" });
const cbAddFormats = (campaignId, urls, startPos) => sbFetch("/rest/v1/lynxr_campaign_formats", {
  method: "POST",
  body: JSON.stringify(urls.map((url, i) => ({ campaign_id: campaignId, position: startPos + i, source_url: url }))),
});

/** The agency lane's last-known state (pipeline/process_campaigns.py writes
    this key). Returns the value object, or null if unwritten/unreadable. */
async function cbLaneState() {
  try {
    const rows = await sbFetch("/rest/v1/lynxr_ops?key=eq.agency.lane&select=value,updated_at");
    return rows[0]?.value || null;
  } catch { return null; }
}

// ---------- Agency roster: who may be sent a brief (plan:
// ~/.claude/plans/agency-send-brief-to-creators.md) ----------
// The roster lives entirely in its own tables (supabase/agency_roster.sql) —
// nothing below writes to lynxr_creators. rost* is the data layer; the
// Creators tab (renderRoster()) is the interface, step 5.

// Client-side mirror of the shape check write_guards.sql uses on the
// waitlist, so a typo is caught before the round trip rather than after.
const ROST_EMAIL_RE = /^[^@\s]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}$/;

let ROSTER = null;      // array of roster rows, or null = not loaded yet
let ROSTER_ERR = "";    // "" | "missing" | "migrate" | "denied" | "other" (see cbError, rostLoad)
// email -> { has_account, confirmed } for rows not yet accepted, from the staff-only
// roster_accounts() (supabase/roster_invite_by_email.sql). null = unknown: the
// function isn't installed or the call failed, and the rows then just don't say.
let ROSTER_ACCTS = null;

async function rostList() {
  return sbFetch("/rest/v1/lynxr_roster?select=email,display_name,campaign,status,creator_id,invited_at,accepted_at,left_at&order=invited_at.desc");
}

async function rostAccounts() {
  try {
    const rows = await sbFetch("/rest/v1/rpc/roster_accounts", { method: "POST", body: "{}" });
    return new Map((rows || []).map((a) => [a.email, a]));
  } catch { return null; }
}

async function rostInvite(email, name, note, campaign) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean || clean.length > 254 || !ROST_EMAIL_RE.test(clean)) {
    throw new Error("That doesn't look like an email address.");
  }
  const prev = (ROSTER || []).find((r) => r.email === clean);
  const body = { email: clean };
  // A re-invite only overwrites what was typed this time; blank boxes keep what's there.
  if (!prev || name) body.display_name = name || "";
  if (!prev || note) body.note = note || "";
  if (!prev || campaign) body.campaign = String(campaign || "").trim().slice(0, 80);
  // Someone who left gets a fresh invite, and the popup again, when invited again.
  if (prev?.status === "left") { body.status = "invited"; body.left_at = null; }
  return sbFetch("/rest/v1/lynxr_roster", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(body),
  });
}

async function rostRemove(email) {
  return sbFetch(`/rest/v1/lynxr_roster?email=eq.${encodeURIComponent(email)}`, { method: "DELETE" });
}

/** The send picker only ever offers accepted members — an invited-or-left
    address can't receive a delivery (the RLS policy in agency_roster.sql
    refuses it too; this just keeps the UI from offering what the database
    would reject). */
const rostAccepted = () => (ROSTER || []).filter((r) => r.status === "accepted");

/** Fills ROSTER / ROSTER_ERR and repaints the Creators tab if it's on screen.
    Reuses cbError's classifier: a 404/PGRST205 (table missing, i.e.
    supabase/agency_roster.sql not applied yet) becomes ROSTER_ERR="missing". */
function rostErrorSentence(ex, verb) {
  const kind = cbError(ex);
  if (kind === "missing") return "The roster isn't installed yet — run supabase/agency_roster.sql in the Supabase SQL editor.";
  if (kind === "denied") return `This account can't ${verb} the roster.`;
  return `Couldn't ${verb} — check the connection and try again.`;
}

async function rostLoad() {
  try {
    const [rows, accts] = await Promise.all([rostList(), rostAccounts()]);
    ROSTER = rows;
    ROSTER_ACCTS = accts;
    ROSTER_ERR = "";
  } catch (ex) {
    ROSTER = null;
    ROSTER_ACCTS = null;
    // 42703 "column lynxr_roster.campaign does not exist" = this plan's SQL isn't applied
    // yet. Checked BEFORE cbError, whose /does not exist/ would call it "missing" and
    // send staff to the wrong file.
    ROSTER_ERR = /campaign/.test(String(ex?.message || "")) ? "migrate" : cbError(ex);
  }
  if (document.getElementById("roster-host")) renderRoster();
}

// ---------- Creators tab: the roster page ----------
// Renders into #roster-host (agencyonly/index.html). Reuses the agency
// vocabulary — .section, .sec-head, .page-head, .bcard, .chip, .lbl,
// .ce-field, .bp-actions, .pill — rather than inventing classes. CSS lives in
// the AGENCY ROSTER + SENDING block at the very end of app.css.

function renderRoster() {
  const host = document.getElementById("roster-host");
  if (!host) return;
  host.innerHTML = rosterHtml();
  bindRoster(host);
}

function rosterHtml() {
  if (ROSTER === null && !ROSTER_ERR) {
    return `<div class="section rost-section"><div class="sec-head"><h2>Creators</h2></div>
      <div class="loader" role="status" aria-live="polite">${loaderMark()}
        <div class="loader-text"><div class="lbl">Loading the roster…</div></div></div></div>`;
  }
  if (ROSTER_ERR === "missing") {
    return `<div class="section rost-section"><div class="sec-head"><h2>Creators</h2></div>
      <p class="note">The roster isn't installed yet — run <code>supabase/agency_roster.sql</code> in the Supabase SQL editor.</p></div>`;
  }
  if (ROSTER_ERR === "migrate") {
    return `<div class="section rost-section"><div class="sec-head"><h2>Creators</h2></div>
      <p class="note">The roster needs one more update — run <code>supabase/roster_invite_by_email.sql</code> in the Supabase SQL editor.</p></div>`;
  }
  if (ROSTER_ERR === "denied") {
    return `<div class="section rost-section"><div class="sec-head"><h2>Creators</h2></div>
      <p class="note">This account can't read the roster.</p></div>`;
  }
  if (ROSTER_ERR) {
    return `<div class="section rost-section"><div class="sec-head"><h2>Creators</h2></div>
      <p class="note">Couldn't load the roster. <button type="button" class="ghost" id="rost-retry">Try again</button></p></div>`;
  }
  const accepted = ROSTER.filter((r) => r.status === "accepted").length;
  return `<div class="section rost-section">
    <div class="sec-head"><h2>Creators <span class="pill">${accepted}</span></h2></div>
    <form class="client-details rost-invite" id="rost-invite-form" novalidate>
      <div class="ce-grid">
        <label class="ce-field"><span class="lbl">Email</span>
          <input type="email" id="rost-email" autocomplete="off" placeholder="them@example.com"></label>
        <label class="ce-field"><span class="lbl">Name (optional)</span>
          <input type="text" id="rost-name" autocomplete="off"></label>
        <label class="ce-field"><span class="lbl">Campaign (optional)</span>
          <input type="text" id="rost-campaign" autocomplete="off" maxlength="80"
            list="rost-campaign-opts" placeholder="e.g. Cloey — shown in their invite">
          <datalist id="rost-campaign-opts">${rostCampaignOptions()}</datalist></label>
        <label class="ce-field ce-wide"><span class="lbl">Note (optional)</span>
          <input type="text" id="rost-note" autocomplete="off" placeholder="agency only — never reaches the creator"></label>
      </div>
      <div class="bp-actions">
        <button type="submit" class="btn" id="rost-invite-go">Invite</button>
      </div>
      <p class="bp-msg cb-msg" id="rost-invite-msg" role="status" aria-live="polite"></p>
    </form>
    <div class="rost-list" id="rost-list">${rosterListHtml()}</div>
  </div>`;
}

/** Suggestions for the Campaign box: the agency's own client names, read straight from the
    Clients cache. Not through loadClients(), which can write while it reads. A datalist
    suggests without restricting, the same as the brand form's niche box. */
function rostCampaignOptions() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(CLIENTS_KEY)) || []; } catch {}
  const names = [...new Set(list.map((c) => String(c?.company || "").trim()).filter(Boolean))].sort();
  return names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");
}

/** One plain sentence per row: what the creator's side looks like right now. */
function rostStateLine(r) {
  if (r.status === "accepted") return "Accepted — you can send them briefs.";
  if (r.status === "left") return "Left the roster. Invite this email again to send them a new invite.";
  if (!ROSTER_ACCTS) return "Invited — waiting for them to accept.";
  const a = ROSTER_ACCTS.get(r.email);
  if (!a || !a.has_account) return "No lynxr account with this email yet — they'll see the invite when they sign up with it.";
  if (!a.confirmed) return "Signed up, but hasn't confirmed their email yet — the invite shows once they do.";
  return "Has a lynxr account — they'll see the invite the next time they open lynxr.";
}

function rosterListHtml() {
  if (!ROSTER.length) {
    return `<div class="empty">${emptyMark("idle")}<p><strong>No creators yet.</strong></p>
      <p>Invite one by email — they'll see the invite as a popup the next time they open lynxr with that email.</p></div>`;
  }
  return `<div class="rost-cards">` + ROSTER.map((r) => {
    const chipCls = r.status === "accepted" ? " good" : r.status === "left" ? " bad" : "";
    const dateIso = r.status === "accepted" ? r.accepted_at : r.status === "left" ? r.left_at : r.invited_at;
    const date = escapeHtml(String(dateIso || "").slice(0, 10));
    const campaign = r.campaign ? ` · ${escapeHtml(r.campaign)}` : "";
    return `<article class="bcard rost-card" data-email="${escapeHtml(r.email)}">
      <div class="bcard-main minw0">
        <div class="bcard-title">${escapeHtml(r.display_name || r.email)}</div>
        <div class="lbl">${escapeHtml(r.email)} · <span class="chip${chipCls}">${escapeHtml(r.status)}</span>${campaign} · ${date}</div>
        <p class="rost-state">${escapeHtml(rostStateLine(r))}</p>
      </div>
      <button type="button" class="ghost danger icon-only rost-remove"
        aria-label="Remove ${escapeHtml(r.email)} from the roster" title="Remove from roster">${TRASH_SVG}</button>
    </article>`;
  }).join("") + `</div>`;
}

function bindRoster(host) {
  document.getElementById("rost-retry")?.addEventListener("click", () => rostLoad());

  const form = document.getElementById("rost-invite-form");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("rost-invite-msg");
    const emailInput = document.getElementById("rost-email");
    const nameInput = document.getElementById("rost-name");
    const noteInput = document.getElementById("rost-note");
    const campaignInput = document.getElementById("rost-campaign");
    const go = document.getElementById("rost-invite-go");
    const was = (ROSTER || []).find((r) => r.email === String(emailInput.value || "").trim().toLowerCase())?.status;
    go.disabled = true;
    try {
      await rostInvite(emailInput.value, nameInput.value.trim(), noteInput.value.trim(), campaignInput.value.trim());
      emailInput.value = ""; nameInput.value = ""; noteInput.value = ""; campaignInput.value = "";
      await rostLoad();
      cbMsg(document.getElementById("rost-invite-msg"), was === "accepted"
        ? "Updated. They're already on the roster."
        : "Invited. They'll see it as a popup the next time they open lynxr with that email.", "good", true);
    } catch (ex) {
      cbMsg(msg, ex?.message && !/^\d/.test(ex.message) ? ex.message : rostErrorSentence(ex, "invite to"), "bad", true);
    } finally {
      const g = document.getElementById("rost-invite-go");
      if (g) g.disabled = false;
    }
  });

  host.querySelectorAll(".rost-remove").forEach((btn) => {
    const card = btn.closest(".rost-card");
    const email = card?.dataset.email;
    armDelete(btn, "Remove", async () => {
      try {
        await rostRemove(email);
        await rostLoad();
      } catch (ex) {
        cbMsg(document.getElementById("rost-invite-msg"), rostErrorSentence(ex, "remove from"), "bad", true);
      }
    });
  });
}

// ---------- Sending a brief to roster creators ----------
// Two source kinds share one delivery path: campaign briefs (agencySendDoc,
// below) and legacy picked-video briefs (briefSendDoc, step 16) both produce
// the identical doc shape, so everything from here down needs no change
// between them.

/** THE ONE DEFINITION of what leaves the agency for a creator's ACCOUNT.
    Read alongside campaignDocHtml just above — that is what a creator sees on
    paper, this is what a creator sees in their own lynxr account, and the two
    must stay in step. An ALLOWLIST, field by field: a column added to
    lynxr_campaign_formats later cannot leak through here, because nothing
    here is a spread.

    client.features rides alongside name/sells/audience — the owner's call,
    2026-09-22: the scripts already name the product's features in their own
    beats, so withholding the list from the brief page was inconsistent with
    what a creator can already read in the script itself. Everything else off
    brand_context (audienceNotes, painPoints, habits, goals, tone, cta,
    valueProps, product, site, notes) stays withheld — that's the agency's
    strategy material, not filming instructions.

    Explicitly absent, and never add: fit, fit_reason, strategy_note,
    internal_note, campaign.internal_notes, regen_note, status, analysis,
    f.source's transcript, shots and tags, every other brand_context key, and
    anything at all off lynxr_videos or the client's posts / blueprints /
    avatar.

    f.source.clip and f.source.cover ARE sent (owner, 2026-09-24: brief videos
    play "native to lynxr"): public lynxr-clips / lynxr-covers objects of the
    post's own video and a frame of it, which the creator's native player
    needs. Nothing the agency wrote. */
function agencySendDoc(campaign, formats, client, prev) {
  const bc = campaign.brand_context || {};
  /* `prev` is the doc creators already have (absent on a first send). A format still in this
     campaign but not ready right now — regenerating, re-queued after "Replace link", or a retry that
     failed — keeps the version creators already have instead of vanishing from their brief. prev's
     formats were built by this same function, so the allowlist below still holds for them. A format
     staff DELETED is not in `formats` at all, so it does leave. Order stays the campaign's. */
  const had = new Map((prev?.formats || []).filter((x) => x && x.id).map((x) => [x.id, x]));
  const done = formats.filter((f) => f.status === "done" || had.has(f.id));
  return {
    v: 1,
    client: {
      name: bc.name || client?.company || "",
      sells: bc.description || "",
      audience: bc.audience || "",
      features: Array.isArray(bc.features) ? bc.features.filter(Boolean) : [],
    },
    title: campaign.name || "",
    instructions: campaign.instructions || "",
    sent_at: new Date().toISOString(),
    formats: done.map((f) => {
      if (f.status !== "done") return had.get(f.id);
      const v = cbView(f);
      const out = {
        id: f.id,
        title: v.title || "",
        source_url: f.source_url || "",
        needs: Array.isArray(v.needs) ? v.needs : [],
        setting: v.setting || "",
        lighting: v.lighting || "",
        framing: v.framing || "",
        audio: v.audio || "",
        hook: v.hook || "",
        delivery: v.delivery || "",
        beats: (v.beats || []).map((b) => ({ t: b.t || "", say: b.say || "", do: b.do || "", show: b.show || "" })),
        cta: v.cta || "",
        caption: v.caption || "",
        note: v.creator_note || "",
      };
      // Named fields, not a spread: the allowlist above still holds. A loaded format carries its clip and
      // cover as top-level aliases (CB_FULL selects `clip:source->>clip, cover:source->>cover` and never
      // `source` itself), so read those first. Reading only `f.source` sent every campaign brief WITHOUT
      // its clip until 2026-09-25, and creators waited on pipeline/brief_clips.py to fill it in.
      const src = f.source || {};
      const clip = typeof f.clip === "string" && f.clip ? f.clip : src.clip;
      const cover = typeof f.cover === "string" && f.cover ? f.cover : src.cover;
      if (typeof clip === "string" && clip) out.clip = clip;
      if (typeof cover === "string" && cover) out.cover = cover;
      return out;
    }),
  };
}

/** A legacy script's beats as the sent doc carries them ({ t, say, do, show }): briefSendDoc's own
    mapping, shared with the files-on-beats rows (bfbFormats) so the fingerprints staff place against
    are made from exactly the words creators receive. */
function agDocBeats(s) {
  const mode = agScriptMode(s);
  return (s.beats || []).map((bt) => {
    const p = agBeatParse(bt, mode);
    return { t: p.t || "", say: p.say?.v || "", do: p.do?.v || "", show: p.show?.v || "" };
  });
}

/** Same delivery, second source (A1): a legacy picked-video brief, sent
    through the identical doc shape agencySendDoc produces above, so the
    creator side needs no branch on where a brief came from.

    Sends no database statistics — no views, likes, comments, engagement_rate,
    data_source, format_type, hook_pattern, niche_category, target_audience —
    those are the agency's asset (decision 5). The video's URL and its own
    caption (row.title) are all a creator needs to find it. Also never sends
    rec.ctx.avatar, rec.ctx.avatarParts or rec.ctx._avatarWords — avatar
    material is internal, same as agencySendDoc's brand_context exclusions.

    client.sells reads the CLIENT's saved description, not rec.ctx.brand (that
    key is the brand's *name*, not a description of what it sells).
    client.features rides alongside name/sells/audience for the same reason
    agencySendDoc's does — the owner's 2026-09-22 amendment to decision 5 is
    the doc shape's rule, not a campaign-only exception, and the two send
    paths are meant to produce identical shapes. */
function briefSendDoc(rec, client) {
  const ctx = rec.ctx || {};
  const briefs = client?.briefs || [];
  const idx = briefs.findIndex((b) => b.id === rec.id);
  const label = idx >= 0 ? `Brief ${briefs.length - idx}` : "Brief";
  return {
    v: 1,
    client: {
      name: rec.company || client?.company || "",
      sells: client?.ctx?.description || "",
      audience: ctx.audience || "",
      features: Array.isArray(client?.ctx?.feats) ? client.ctx.feats.filter(Boolean) : [],
    },
    title: label,
    instructions: "",
    sent_at: new Date().toISOString(),
    formats: (rec.items || []).map((row, i) => {
      const s = agScriptFor(row, ctx, i);
      const mode = agScriptMode(s);
      const beats = agDocBeats(s);
      return {
        id: row.url || String(i),
        title: s.heading || "",
        source_url: row.url || "",
        needs: [],
        setting: "", lighting: "", framing: "", audio: "",
        hook: s.hook || "",
        delivery: mode === "silent" ? "silent" : "spoken",
        beats,
        cta: agCtaParts(s.cta).join(""),
        caption: row.title || "",
        note: "",
      };
    }),
  };
}

/** Send (or re-send) a doc to one or more accepted roster creators.
    Re-sending with the same briefId overwrites the snapshot in place — same
    row, `resolution=merge-duplicates` — rather than creating a second brief,
    and un-revokes anyone in creatorIds who had been unsent. */
async function agSend(doc, sourceKind, sourceId, creatorIds, briefId) {
  briefId = briefId || newId();
  const [client_name, title] = [doc.client?.name || "", doc.title || ""];
  await sbFetch("/rest/v1/lynxr_agency_briefs", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id: briefId, client_name, title, doc,
      source_kind: sourceKind, source_id: String(sourceId), sent_by: SB_UID,
    }),
  });
  await sbFetch("/rest/v1/lynxr_agency_deliveries", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(creatorIds.map((creator_id) => ({ brief_id: briefId, creator_id, revoked_at: null }))),
  });
  return briefId;
}

/** Who a source (one campaign or one legacy brief) has been sent to, mapped
    back to a roster address via the cached ROSTER. PostgREST embeds the
    deliveries through the foreign key in one round trip. */
async function agSentFor(sourceKind, sourceId) {
  // Deliberately does NOT map creator_id -> address here: ROSTER and this
  // fetch are kicked off together (renderCampaignView/renderBriefViewer) and
  // may resolve in either order, so baking the lookup in at fetch time could
  // freeze in a blank email if ROSTER lands second. cbSentListHtml resolves
  // the address at PAINT time instead, off whatever ROSTER holds then.
  // `doc` is the snapshot creators have: the Sent to list compares it with this page, and Update/Send carry in-progress formats over from it.
  return sbFetch(`/rest/v1/lynxr_agency_briefs?source_kind=eq.${encodeURIComponent(sourceKind)}`
    + `&source_id=eq.${encodeURIComponent(String(sourceId))}`
    + `&select=id,created_at,doc,lynxr_agency_deliveries(creator_id,sent_at,revoked_at)`);
}

/** A RENAME REACHES CREATORS STRAIGHT AWAY (owner, 2026-09-25: "when i change the name of brief, have it
    change on the creator side that has the brief as well even if it was already sent out"). Everything
    else a creator has is a snapshot that moves only on Update; the name is the one exception. Only the
    title moves — the row's `title` column (the creator's brief list, via my_agency()) and `doc.title`
    (the brief page, via my_agency_brief()) — so edits staff have NOT sent yet stay unsent, and
    sent_at (their "version is from" date) is left alone. Rows are read fresh, not from AG_SENT, so a
    doc another staff member just updated is not written back stale. Returns how many copies changed
    and how many could not be. RLS: "staff update agency briefs" (agency_roster.sql). */
async function agRenameSent(sourceKind, sourceId, title) {
  let rows;
  try { rows = await agSentFor(sourceKind, sourceId); } catch { return { renamed: 0, failed: -1 }; }
  let renamed = 0, failed = 0;
  for (const r of rows || []) {
    if (!r || !r.id || !r.doc || typeof r.doc !== "object" || r.doc.title === title) continue;
    try {
      await sbFetch(`/rest/v1/lynxr_agency_briefs?id=eq.${encodeURIComponent(r.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title, doc: { ...r.doc, title } }),
      });
      renamed += 1;
    } catch { failed += 1; }
  }
  return { renamed, failed };
}

const agUnsend = (briefId, creatorId) => sbFetch(
  `/rest/v1/lynxr_agency_deliveries?brief_id=eq.${encodeURIComponent(briefId)}&creator_id=eq.${encodeURIComponent(creatorId)}`,
  { method: "PATCH", body: JSON.stringify({ revoked_at: new Date().toISOString() }) });

const agUnsendAll = (briefId) => sbFetch(
  `/rest/v1/lynxr_agency_deliveries?brief_id=eq.${encodeURIComponent(briefId)}&revoked_at=is.null`,
  { method: "PATCH", body: JSON.stringify({ revoked_at: new Date().toISOString() }) });

// ---- Updating a brief that was already sent (owner, 2026-09-23: "allow the agency side the edit
// the scripts and briefs, dont allow the creators to"). A sent brief is a SNAPSHOT
// (lynxr_agency_briefs.doc) that my_agency_brief() hands a creator on every open, so rewriting that
// one column is the whole mechanism: no delivery row changes, nobody unsent is sent it again. ----

/** A doc as one comparable string. Keys are sorted at every level because the stored copy comes
    back from a jsonb column, which does not keep the order agencySendDoc/briefSendDoc wrote them
    in — a plain JSON.stringify would call every sent brief "edited". Keys holding undefined are
    skipped, as JSON drops them on the way in. */
/** Fields on a sent format that nobody at the agency writes: the clip lynxr plays, its cover, and
    the fetch state pipeline/brief_clips.py keeps. The worker fills them in AFTER a send. So a send or
    Update carries them over from the version creators already have (same format id AND the same
    link — a replaced link needs a new clip), and agDocSig ignores them, so a clip arriving never reads
    as "Edited since they got it" and never moves updated_at. */
const AG_CLIP_KEYS = ["clip", "cover", "clip_state", "clip_tries"];
function agCarryClips(formats, prevFormats) {
  const had = new Map((prevFormats || []).filter((x) => x && x.id).map((x) => [x.id, x]));
  return (formats || []).map((f) => {
    const p = f && had.get(f.id);
    if (!p || p.source_url !== f.source_url || f.clip) return f;
    const out = { ...f };
    for (const k of AG_CLIP_KEYS) if (p[k] !== undefined && (out[k] === undefined || out[k] === "")) out[k] = p[k];
    return out;
  });
}
function agDocCanon(v) {
  if (Array.isArray(v)) return `[${v.map(agDocCanon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${agDocCanon(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
/** Everything a creator can read, minus the two stamps ABOUT the doc (sent_at, updated_at). Two
    docs with the same sig are the same version. "" for no doc. */
function agDocSig(doc) {
  if (!doc) return "";
  const { sent_at: _sent, updated_at: _updated, ...rest } = doc;
  if (Array.isArray(rest.formats)) {
    rest.formats = rest.formats.map((f) => {
      if (!f || typeof f !== "object") return f;
      const g = { ...f };
      for (const k of AG_CLIP_KEYS) delete g[k];
      return g;
    });
  }
  return agDocCanon(rest);
}
/** The stamps a creator's copy carries. First send (no prev): the doc as built. Any later write
    over an existing snapshot (Update, or Send again): sent_at stays the original, and updated_at
    moves only when something a creator can read actually changed — so "Updated <date>" on their
    brief page (creator.js renderLynxBrief) never marks a re-send that changed nothing. */
function agStampDoc(doc, prev) {
  if (!doc) return null;
  if (!prev) return doc;
  const out = { ...doc, sent_at: prev.sent_at || doc.sent_at, formats: agCarryClips(doc.formats, prev.formats) };
  delete out.updated_at;
  if (agDocSig(out) !== agDocSig(prev)) out.updated_at = new Date().toISOString();
  else if (prev.updated_at) out.updated_at = prev.updated_at;
  return out;
}
/** Rewrite one sent brief's snapshot in place. Only this lynxr_agency_briefs row changes — the
    delivery rows are not touched, so every sent_at and every unsend stays as it was.
    select=id with return=representation turns a write that matched no row (the brief was deleted,
    or RLS refused it without an error) into a thrown error instead of a false "Updated". */
async function agUpdateSent(briefId, doc) {
  const rows = await sbFetch(`/rest/v1/lynxr_agency_briefs?id=eq.${encodeURIComponent(briefId)}&select=id`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ client_name: doc.client?.name || "", title: doc.title || "", doc }),
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error("0 no sent brief was updated");
}
/** agSendErrorSentence's shape for Update: its "denied" sentence is about an unaccepted invite,
    which cannot be the reason an update of an existing snapshot is refused. */
function agUpdateErrorSentence(ex) {
  const kind = cbError(ex);
  if (kind === "missing") return "Sending isn't installed yet — run supabase/agency_roster.sql in the Supabase SQL editor.";
  if (kind === "denied") return "This account can't update sent briefs.";
  return "Couldn't update — check the connection and try again.";
}

/** Same shape as cbErrorSentence, plus the one error specific to sending: a
    403 on the deliveries insert means the target rostered address is not
    (or is no longer) an accepted member — the RLS policy in
    agency_roster.sql refuses the insert outright rather than silently
    dropping it. */
function agSendErrorSentence(ex) {
  const kind = cbError(ex);
  if (kind === "missing") return "Sending isn't installed yet — run supabase/agency_roster.sql in the Supabase SQL editor.";
  if (kind === "denied") return "That creator has not accepted the invite yet.";
  return "Couldn't send — check the connection and try again.";
}

// ---------- The send panel + sent-to list (steps 8/9, reused verbatim by the
// legacy brief viewer in step 16) ----------
// Shared by the campaign view and renderBriefViewer, keyed by
// sourceKind/sourceId so the two never collide in CB_SEND_OPEN or AG_SENT.
// Not a modal: the agency app has none for this, and confirm() is forbidden —
// every unsend below is the existing two-click armDelete pattern instead.

/** True while the open Send panel is drawing the roster picker — and with it the files block. Mirrors
    cbSendPanelHtml's own branches (open; roster loaded, which also means no ROSTER_ERR; at least one
    accepted creator), so exactly one copy of bfSectionHtml is on the page at any time. */
function cbSendShowsFiles(sourceKind, sourceId) {
  return CB_SEND_OPEN.has(agSentKey(sourceKind, sourceId))
    && !ROSTER_ERR && ROSTER !== null && rostAccepted().length > 0;
}

/** The inline "Send this brief to" panel. */
function cbSendPanelHtml(sourceKind, sourceId) {
  const key = agSentKey(sourceKind, sourceId);
  if (!CB_SEND_OPEN.has(key)) return "";
  if (ROSTER_ERR === "missing") {
    return `<div class="section cb-send-panel">
      <p class="note">Sending isn't installed yet — run <code>supabase/agency_roster.sql</code> in the Supabase SQL editor.</p>
    </div>`;
  }
  if (ROSTER_ERR === "migrate") {
    return `<div class="section cb-send-panel">
      <p class="note">Sending needs one more update — run <code>supabase/roster_invite_by_email.sql</code> in the Supabase SQL editor.</p>
    </div>`;
  }
  if (ROSTER === null) {
    return `<div class="section cb-send-panel">
      <div class="loader" role="status" aria-live="polite">${loaderMark()}
        <div class="loader-text"><div class="lbl">Loading the roster…</div></div></div>
    </div>`;
  }
  const accepted = rostAccepted();
  if (!accepted.length) {
    return `<div class="section cb-send-panel">
      <p class="note">Nobody has accepted a Lynx invite yet — invite them on the Creators tab.</p>
      <button type="button" class="ghost" id="cb-send-goto-roster">Go to Creators</button>
    </div>`;
  }
  const already = new Set((AG_SENT.get(key)?.rows || [])
    .flatMap((b) => (b.lynxr_agency_deliveries || []).filter((d) => !d.revoked_at).map((d) => d.creator_id)));
  const picked = CB_SEND_PICKS.get(key);
  const isOn = (id) => (picked ? picked.has(id) : already.has(id));
  return `<div class="section cb-send-panel">
    <h3>Send this brief to</h3>
    <p class="note">They get this brief as it is now. If you edit it later, press Update under Sent to
      and they get the new version.</p>
    <div class="rost-picker">
      ${accepted.map((r) => `<label class="rost-pick-row">
        <input type="checkbox" class="cb-send-pick" value="${escapeHtml(r.creator_id)}"${isOn(r.creator_id) ? " checked" : ""}>
        <span>${escapeHtml(r.display_name || r.email)} <span class="lbl">${escapeHtml(r.email)}</span></span>
      </label>`).join("")}
    </div>
    ${cbSendShowsFiles(sourceKind, sourceId) ? bfSectionHtml(sourceKind, sourceId, { inSend: true }) : ""}
    <div class="bp-actions">
      <button type="button" class="btn" id="cb-send-go" disabled>Send to 0 creators</button>
      <button type="button" class="ghost" id="cb-send-cancel">Cancel</button>
    </div>
    <p class="bp-msg cb-msg" id="cb-send-msg" role="status" aria-live="polite"></p>
  </div>`;
}

/** "Sent to" list: one row per delivery, an Unsend on each live one, plus
    Unsend for everyone. Visible whenever there's anything to show, whether or
    not the send panel itself is open. Shows nothing about whether a creator
    opened or copied a brief — there is no such data, and there must not be
    (decision 7). */
function cbSentListHtml(sourceKind, sourceId, getDoc) {
  const entry = AG_SENT.get(agSentKey(sourceKind, sourceId));
  if (!entry || entry.error || !entry.rows.length) return "";
  const byId = new Map((ROSTER || []).map((r) => [r.creator_id, r.email]));
  const deliveries = entry.rows.flatMap((b) => (b.lynxr_agency_deliveries || [])
    .map((d) => ({ ...d, briefId: b.id, email: byId.get(d.creator_id) || "" })));
  if (!deliveries.length) return "";
  deliveries.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
  const anyLive = deliveries.some((d) => !d.revoked_at);
  /* UPDATE WHAT THEY SEE. `stale` compares this page with the snapshot WHEN THIS LIST IS DRAWN. An
     in-place edit made after that does not flip it until the next draw, so the note only ever says
     "older" when that was true at draw time; the button is offered either way and says so when
     nothing changed. getDoc is the caller's sendDoc (renderCampaignView / renderBriefViewer). */
  const liveRow = entry.rows.find((b) => (b.lynxr_agency_deliveries || []).some((d) => !d.revoked_at)) || null;
  const liveN = liveRow ? liveRow.lynxr_agency_deliveries.filter((d) => !d.revoked_at).length : 0;
  let stale = false;
  if (liveRow?.doc && getDoc) {
    try { stale = agDocSig(getDoc(liveRow.doc)) !== agDocSig(liveRow.doc); } catch { stale = false; }
  }
  const theirs = liveRow
    ? String(liveRow.doc?.updated_at || liveRow.doc?.sent_at || liveRow.created_at || "").slice(0, 10) : "";
  return `<div class="section cb-sent-section">
    <div class="sec-head"><h3>Sent to</h3>
      ${anyLive ? `<button type="button" class="ghost danger cb-unsend-all" data-brief="${escapeHtml(deliveries[0].briefId)}">Unsend for everyone</button>` : ""}
    </div>
    ${liveRow ? `<p class="note cb-push-note">${stale
        ? "Edited since they got it — they still see the older version."
        : "Edits here reach them when you press Update."}${theirs ? ` Their version is from ${escapeHtml(theirs)}.` : ""}</p>
      <div class="bp-actions cb-push-row">
        <button type="button" class="${stale ? "btn" : "ghost"} cb-push" data-brief="${escapeHtml(liveRow.id)}">Update for ${cbPlural(liveN, "creator", "creators")}</button>
      </div>` : ""}
    ${anyLive ? `<p class="note">Unsending removes it from their app. Anything they already copied into their own library stays theirs.</p>` : ""}
    <div class="cb-sent-list">
      ${deliveries.map((d) => `<article class="bcard cb-sent-row">
        <div class="bcard-main minw0">
          <div class="bcard-title">${escapeHtml(d.email || "—")}</div>
          <div class="lbl">${d.revoked_at ? `unsent ${escapeHtml(String(d.revoked_at).slice(0, 10))}` : `sent ${escapeHtml(String(d.sent_at).slice(0, 10))}`}</div>
        </div>
        ${d.revoked_at
          ? `<span class="chip bad">unsent</span>`
          : `<button type="button" class="ghost danger cb-unsend" data-brief="${escapeHtml(d.briefId)}" data-creator="${escapeHtml(d.creator_id)}">Unsend</button>`}
      </article>`).join("")}
    </div>
  </div>`;
}

/** Binds the send panel + sent-to list rendered by the two functions above.
    `getDoc()` builds the payload only when Send is actually pressed — never
    ahead of time, so a page that never opens the panel never calls it.
    `repaint()` is the caller's own keep-scroll repaint (renderBriefsKeepScroll
    for the campaign view, its equivalent for the legacy brief viewer). */
function cbBindSend(host, sourceKind, sourceId, getDoc, repaint, msgId = "cb-view-msg") {
  const key = agSentKey(sourceKind, sourceId);
  const msgEl = () => document.getElementById(msgId);

  document.getElementById("cb-send-toggle")?.addEventListener("click", () => {
    if (CB_SEND_OPEN.has(key)) { CB_SEND_OPEN.delete(key); CB_SEND_PICKS.delete(key); } else CB_SEND_OPEN.add(key);
    if (CB_SEND_OPEN.has(key) && ROSTER === null && !ROSTER_ERR) rostLoad();
    repaint();
  });
  document.getElementById("cb-send-cancel")?.addEventListener("click", () => {
    CB_SEND_OPEN.delete(key);
    CB_SEND_PICKS.delete(key);
    repaint();
  });
  document.getElementById("cb-send-goto-roster")?.addEventListener("click", () => activateTab("tab-roster"));

  const updateGo = () => {
    const n = host.querySelectorAll(".cb-send-pick:checked").length;
    const go = document.getElementById("cb-send-go");
    if (go) { go.disabled = n === 0; go.textContent = `Send to ${cbPlural(n, "creator", "creators")}`; }
  };
  host.querySelectorAll(".cb-send-pick").forEach((cb) => cb.addEventListener("change", () => {
    CB_SEND_PICKS.set(key, new Set([...host.querySelectorAll(".cb-send-pick:checked")].map((c) => c.value)));
    updateGo();
  }));
  updateGo();

  document.getElementById("cb-send-go")?.addEventListener("click", async (e) => {
    const creatorIds = [...host.querySelectorAll(".cb-send-pick:checked")].map((c) => c.value);
    if (!creatorIds.length) return;
    // Sending again over an existing snapshot is an update too: keep in-progress formats
    // (agencySendDoc's prev), keep the first sent_at, move updated_at only if something changed.
    const prevRow = AG_SENT.get(key)?.rows?.[0] || null;
    const doc = agStampDoc(getDoc(prevRow?.doc || null), prevRow?.doc || null);
    if (!doc) return;
    const existing = prevRow?.id;
    e.currentTarget.disabled = true;
    try {
      await agSend(doc, sourceKind, sourceId, creatorIds, existing);
      await agEnsureSent(sourceKind, sourceId, null, true);
      CB_SEND_OPEN.delete(key);
      CB_SEND_PICKS.delete(key);
      repaint();
      // Files ride on the brief's source, so every file listed now reaches these creators.
      const nFiles = (BF_FILES.get(key)?.rows || []).length;
      cbMsg(msgEl(), `Sent to ${cbPlural(creatorIds.length, "creator", "creators")}${nFiles ? ` with ${cbPlural(nFiles, "file", "files")}` : ""}.`, "good");
    } catch (ex) {
      e.currentTarget.disabled = false;
      cbMsg(document.getElementById("cb-send-msg"), agSendErrorSentence(ex), "bad", true);
    }
  });

  host.querySelectorAll(".cb-unsend").forEach((btn) => {
    armDelete(btn, "Unsend", async () => {
      try {
        await agUnsend(btn.dataset.brief, btn.dataset.creator);
        await agEnsureSent(sourceKind, sourceId, null, true);
        repaint();
      } catch (ex) {
        cbMsg(msgEl(), agSendErrorSentence(ex), "bad", true);
      }
    });
  });
  /* UPDATE (owner, 2026-09-23): rewrite the snapshot creators read with this page's version
     (agUpdateSent). Delivery rows are not touched: nobody unsent gets it back, every sent_at stays.
     A press with nothing changed writes nothing and says so. Not armed — nothing is lost that is not
     still on this page. The button is drawn by cbSentListHtml. */
  host.querySelectorAll(".cb-push").forEach((btn) => btn.addEventListener("click", async () => {
    const row = (AG_SENT.get(key)?.rows || []).find((b) => b.id === btn.dataset.brief);
    if (!row) return;
    const prev = row.doc || null;
    const doc = agStampDoc(getDoc(prev), prev);
    if (!doc) return;
    if (!Array.isArray(doc.formats) || !doc.formats.length) {
      cbMsg(msgEl(), "No format is ready to send — wait for one to finish, or unsend it instead.", "bad", true);
      return;
    }
    if (prev && agDocSig(doc) === agDocSig(prev)) {
      cbMsg(msgEl(), "They already have this version.", "good");
      return;
    }
    const live = (row.lynxr_agency_deliveries || []).filter((d) => !d.revoked_at).length;
    btn.disabled = true;
    try {
      await agUpdateSent(row.id, doc);
      await agEnsureSent(sourceKind, sourceId, null, true);
      repaint();
      cbMsg(msgEl(), `Updated — ${cbPlural(live, "creator sees", "creators see")} it next time they open the brief.`, "good");
    } catch (ex) {
      btn.disabled = false;
      cbMsg(msgEl(), agUpdateErrorSentence(ex), "bad", true);
    }
  }));
  host.querySelectorAll(".cb-unsend-all").forEach((btn) => {
    armDelete(btn, "Unsend for everyone", async () => {
      try {
        await agUnsendAll(btn.dataset.brief);
        await agEnsureSent(sourceKind, sourceId, null, true);
        repaint();
      } catch (ex) {
        cbMsg(msgEl(), agSendErrorSentence(ex), "bad", true);
      }
    });
  });
}

// ---------- Brief files (plan: ~/.claude/plans/brief-file-attachments.md) ----------
// Logos, fonts and brand guides attached to a brief for the creators it is sent
// to. SQL: supabase/brief_files.sql. A file belongs to the brief's SOURCE — the
// same (sourceKind, sourceId) pair agSend records — not to a sent snapshot, so a
// file attached before the first send, or after it, reaches every creator the
// brief is delivered to without a re-send (unlike the brief's text, which is a
// snapshot). Bytes: the PRIVATE bucket below. List: lynxr_brief_files. Creators
// never touch either from here; they read through my_agency_brief_files() and a
// storage policy, both in the SQL file.
const BF_BUCKET = "lynxr-brief-files";
// Mirrors supabase/brief_files.sql — change both together. The bucket enforces
// the per-file size and the types, a trigger enforces the per-brief caps; these
// copies only make a refusal an instant sentence instead of a failed upload.
const BF_MAX_FILE = 25 * 1048576;
const BF_MAX_TOTAL = 50 * 1048576;
const BF_MAX_COUNT = 20;
// Extension -> the Content-Type sent on upload. Decided HERE from the name and
// never from file.type: browsers disagree about fonts and zips
// ("application/x-zip-compressed", "" for .woff2 on some systems), and the
// bucket's allowed_mime_types would refuse whichever one a browser invented.
const BF_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  svg: "image/svg+xml", pdf: "application/pdf", zip: "application/zip",
  otf: "font/otf", ttf: "font/ttf", woff: "font/woff", woff2: "font/woff2",
};
const BF_ACCEPT = Object.keys(BF_TYPES).map((e) => "." + e).join(",");
let BF_FILES = new Map();     // agSentKey(kind, id) -> { rows, error } | undefined = not loaded
const BF_LOADING = new Set(); // keys in flight
const BF_UP = new Map();      // key -> [{ tmp, name, size, pct, file, mime }] uploads in flight; survives repaints
let BF_GUARDED = false;       // bfGuardPage() has run

/** STORAGE ANSWERS AN EXPIRED TOKEN WITH HTTP 400, not 401 — the real status
    is inside the JSON body (storage-api 1.77.5, probed 2026-09-23). So
    sbFetch's refresh-on-401 never fires for a storage call, and the XHR upload
    below has no retry at all. Refresh up front instead, when the access token
    has under two minutes left. Same single-flight SB_REFRESHING as sbFetch. */
async function sbFreshToken() {
  let exp = 0;
  try {
    exp = JSON.parse(atob(String(SB_TOKEN).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp || 0;
  } catch { /* no token, or not a JWT: exp stays 0 */ }
  if (exp * 1000 - Date.now() > 120000) return;
  const rt = sbLoadSession()?.refresh_token;
  if (!rt) return;
  SB_REFRESHING = SB_REFRESHING || sbRefresh(rt).finally(() => { SB_REFRESHING = null; });
  try { await SB_REFRESHING; } catch { /* the request itself will fail and say so */ }
}

/** One object-key segment Supabase Storage accepts and a path cannot escape:
    [A-Za-z0-9_.-] only, never starting or ending with "." or "-", no "..",
    at most 100 characters counted from the END so the extension survives.
    The same alphabet is a CHECK on lynxr_brief_files.path. The file's real
    name is stored separately (lynxr_brief_files.name) — this is only its key. */
function bfSafe(s) {
  const t = String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/\.{2,}/g, ".").replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return t.slice(-100).replace(/^[-.]+/, "") || "file";
}

function bfSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}

/** A thrown sbFetch / upload error -> a short phrase, used as "<file>: <phrase>".
    Storage errors arrive as HTTP 400 with the real status in the body, so the
    body text is matched, not the status. */
function bfErrorSentence(ex, verb) {
  const msg = String(ex?.message || ex || "");
  if (/Bucket not found|NoSuchBucket|PGRST20[25]|does not exist/i.test(msg))
    return "attachments aren't installed yet — run supabase/brief_files.sql in the Supabase SQL editor";
  if (/brief_files_cap/.test(msg)) return `this brief is at its limit (${BF_MAX_COUNT} files, ${bfSize(BF_MAX_TOTAL)})`;
  if (/maximum allowed size|Payload too large|EntityTooLarge|"413"/i.test(msg)) return `over the ${bfSize(BF_MAX_FILE)} limit`;
  if (/mime type|InvalidMimeType|invalid_mime_type|"415"/i.test(msg)) return "that file type isn't allowed";
  if (/row-level security|Unauthorized|AccessDenied|^40[13]\b|42501/i.test(msg)) return "this account can't change brief files";
  return `couldn't ${verb} — check the connection and try again`;
}

/** Loads (or reloads with force=true) one source's file list — the same
    lazy pattern as agEnsureSent. Errors are kept on the entry and shown in
    the section itself. */
async function bfEnsure(kind, sourceId, onDone, force) {
  const key = agSentKey(kind, sourceId);
  if (!force && (BF_FILES.has(key) || BF_LOADING.has(key))) return;
  if (force && BF_LOADING.has(key)) return;
  BF_LOADING.add(key);
  try {
    const rows = await sbFetch(`/rest/v1/lynxr_brief_files?source_kind=eq.${encodeURIComponent(kind)}`
      + `&source_id=eq.${encodeURIComponent(String(sourceId))}`
      + `&select=id,path,name,size,mime,uploaded_at&order=uploaded_at.asc`);
    BF_FILES.set(key, { rows: Array.isArray(rows) ? rows : [], error: null });
  } catch (ex) {
    BF_FILES.set(key, { rows: [], error: cbError(ex) });
  } finally {
    BF_LOADING.delete(key);
    onDone?.();
  }
}

/** One object into the bucket, with upload progress. XMLHttpRequest, not
    fetch: fetch has no upload progress event. x-upsert false — every path
    carries a fresh random segment, so a clash means something is wrong and
    should fail rather than overwrite. Rejects with `${status} ${body}` like
    sbFetch, so bfErrorSentence reads both the same way. */
function bfPutObject(path, file, mime, onPct) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${SB_URL}/storage/v1/object/${BF_BUCKET}/${path}`);
    xhr.setRequestHeader("apikey", SB_KEY);
    xhr.setRequestHeader("Authorization", `Bearer ${SB_TOKEN || SB_KEY}`);
    xhr.setRequestHeader("Content-Type", mime);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.min(100, Math.round((e.loaded / e.total) * 100))); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
      ? resolve()
      : reject(new Error(`${xhr.status} ${String(xhr.responseText || "").slice(0, 160)}`));
    xhr.onerror = () => reject(new Error("0 network"));
    xhr.send(file);
  });
}

/** Validate, then upload one file at a time — a clear order, and never twenty
    25 MB uploads racing each other. Per file: bytes first, then its row, so a
    creator never sees a row whose bytes are missing; a failed row insert
    deletes the bytes it would have pointed at. Every repaint rebuilds #bf-msg,
    so refusals and failures are gathered into one sticky message at the end. */
async function bfUpload(kind, sourceId, files, repaint) {
  const key = agSentKey(kind, sourceId);
  const say = (text, tone, sticky) => cbMsg(document.getElementById("bf-msg"), text, tone, sticky);
  if (!files.length) return;
  const entry = BF_FILES.get(key);
  if (!entry || entry.error) { say("Wait for the file list to load, then try again.", "bad", true); return; }
  const inflight = BF_UP.get(key) || [];
  let count = entry.rows.length + inflight.length;
  let total = entry.rows.reduce((s, r) => s + (Number(r.size) || 0), 0) + inflight.reduce((s, u) => s + u.size, 0);
  const problems = [];
  const queue = [];
  for (const file of files) {
    const dot = file.name.lastIndexOf(".");
    const mime = dot > 0 ? BF_TYPES[file.name.slice(dot + 1).toLowerCase()] : undefined;
    if (!mime) { problems.push(`${file.name}: that file type isn't allowed`); continue; }
    if (!file.size) { problems.push(`${file.name}: the file is empty`); continue; }
    if (file.size > BF_MAX_FILE) { problems.push(`${file.name}: over ${bfSize(BF_MAX_FILE)}`); continue; }
    if (count + 1 > BF_MAX_COUNT) { problems.push(`${file.name}: a brief holds ${BF_MAX_COUNT} files at most`); continue; }
    if (total + file.size > BF_MAX_TOTAL) { problems.push(`${file.name}: this brief's files would pass ${bfSize(BF_MAX_TOTAL)}`); continue; }
    count += 1;
    total += file.size;
    queue.push({ tmp: newId(), name: file.name, size: file.size, pct: 0, file, mime });
  }
  if (!queue.length) { say(`Not added — ${problems.join("; ")}.`, "bad", true); return; }
  BF_UP.set(key, [...inflight, ...queue]);
  repaint();
  if (problems.length) say(`Not added — ${problems.join("; ")}.`, "bad", true);
  let added = 0;
  for (const u of queue) {
    const path = `${kind}/${bfSafe(String(sourceId))}/${bfSafe(newId())}/${bfSafe(u.name)}`;
    try {
      await sbFreshToken();
      await bfPutObject(path, u.file, u.mime, (pct) => {
        u.pct = pct;
        const el = document.querySelector(`[data-bf-up="${u.tmp}"] .bf-pct`);
        if (el) el.textContent = `uploading · ${pct}%`;
      });
      try {
        await sbFetch("/rest/v1/lynxr_brief_files", {
          method: "POST",
          body: JSON.stringify({ source_kind: kind, source_id: String(sourceId), path,
            name: u.name.slice(0, 200), size: u.size, mime: u.mime }),
        });
      } catch (ex) {
        sbDeleteFile(BF_BUCKET, path).catch(() => {});   // no row will ever point at these bytes
        throw ex;
      }
      added += 1;
    } catch (ex) {
      problems.push(`${u.name}: ${bfErrorSentence(ex, "upload")}`);
    }
    BF_UP.set(key, (BF_UP.get(key) || []).filter((x) => x.tmp !== u.tmp));
  }
  await bfEnsure(kind, sourceId, null, true);
  repaint();
  if (problems.length) {
    say(`${added ? `Added ${cbPlural(added, "file", "files")}. ` : ""}Not added — ${problems.join("; ")}.`, "bad", true);
  } else {
    say(`Added ${cbPlural(added, "file", "files")}.`, "good");
  }
}

/** Row first, then bytes: the creator's list and the storage read policy both
    key on the row, so creators lose the file the moment the row goes. A failed
    byte delete leaves an orphan no list points at (storage cost, reaches no one). */
async function bfRemove(id, path) {
  await sbFetch(`/rest/v1/lynxr_brief_files?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  await sbFreshToken();
  await sbDeleteFile(BF_BUCKET, path).catch(() => {});
}

/** A file dropped anywhere except the zone would make the browser open it in
    this tab and leave the app. Installed once per page load. */
function bfGuardPage() {
  if (BF_GUARDED) return;
  BF_GUARDED = true;
  const guard = (e) => {
    if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes("Files")) return;
    if (e.target instanceof Element && e.target.closest(".bf-drop")) return;
    e.preventDefault();
    if (e.type === "dragover") e.dataTransfer.dropEffect = "none";
  };
  window.addEventListener("dragover", guard);
  window.addEventListener("drop", guard);
}

/** "Files for creators" on a brief page — a .cb-block island like "Campaign
    requirements", and like it "shown to creators". Every staff-typed string is
    escaped all the same. Rows in flight come from BF_UP, so a repaint
    mid-upload (the campaign poll, a send) keeps them and their percentage.
    { inSend: true } draws the SAME block inside the open Send panel
    (cbSendPanelHtml; owner, 2026-09-24: "make sure the agency side can add the
    files when the briefs are sent"): no island of its own — it sits in one —
    a heading in the panel's h3 voice, and a note about sending. Its ids are
    fixed (#bf-h, #bf-drop, #bf-input, #bf-msg), so only ONE copy may be on a
    page: the two viewers skip theirs while cbSendShowsFiles() is true. */
function bfSectionHtml(kind, sourceId, { inSend = false } = {}) {
  const key = agSentKey(kind, sourceId);
  const entry = BF_FILES.get(key);
  const head = (extra = "") => inSend
    ? `<div class="cb-block-head"><h3 id="bf-h">Files that go with it</h3>${extra}</div>`
    : `<div class="cb-block-head"><span class="cb-block-title" id="bf-h">Files for creators</span>
      <span class="lbl">shown to creators</span>${extra}</div>`;
  const wrap = (inner) => inSend
    ? `<div class="bf-section bf-in-send" data-bf-key="${escapeHtml(key)}" role="group" aria-labelledby="bf-h">${inner}</div>`
    : `<section class="cb-block bf-section" data-bf-key="${escapeHtml(key)}" aria-labelledby="bf-h">${inner}</section>`;
  if (!entry || entry.error) {
    const text = !entry ? "Loading files…"
      : entry.error === "missing"
        ? "File attachments aren't installed yet — run <code>supabase/brief_files.sql</code> in the Supabase SQL editor."
        : "Couldn't load this brief's files.";
    return wrap(`${head()}
      <p class="note">${text}</p>
      ${entry && entry.error !== "missing" ? `<button type="button" class="ghost cb-small" id="bf-retry">Try again</button>` : ""}`);
  }
  const ups = BF_UP.get(key) || [];
  const total = entry.rows.reduce((s, r) => s + (Number(r.size) || 0), 0);
  const fmts = bfbFormats(kind, sourceId);
  const rows = entry.rows.map((r) => {
    const where = bfbWhere(kind, sourceId, r.id, fmts);
    return `<li class="bf-row">
        <span class="bf-main"><span class="bf-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>${where
          ? `<span class="lbl bf-at" title="${escapeHtml(where)}">${escapeHtml(where)}</span>` : ""}</span>
        <span class="lbl bf-size">${escapeHtml(bfSize(r.size))}</span>
        <button type="button" class="ghost danger cb-small bf-remove" data-id="${escapeHtml(r.id)}"
          data-path="${escapeHtml(r.path)}" data-name="${escapeHtml(r.name)}">Remove</button>
      </li>`;
  }).join("") + ups.map((u) => `<li class="bf-row bf-busy" data-bf-up="${escapeHtml(u.tmp)}">
        <span class="bf-name">${escapeHtml(u.name)}</span>
        <span class="lbl bf-pct">uploading · ${u.pct}%</span>
      </li>`).join("");
  return wrap(`
    ${head(`<span class="lbl bf-total">${cbPlural(entry.rows.length, "file", "files")} · ${bfSize(total)} of ${bfSize(BF_MAX_TOTAL)}</span>`)}
    <label class="bf-drop" id="bf-drop">
      <input type="file" id="bf-input" class="sr-only" multiple accept="${BF_ACCEPT}">
      <span class="bf-drop-main">Drop logos, fonts or brand files here, or <span class="bf-drop-pick">choose files</span></span>
      <span class="lbl">PNG, JPG, WebP, GIF, SVG, PDF, ZIP, OTF, TTF, WOFF · up to ${bfSize(BF_MAX_FILE)} each · ${BF_MAX_COUNT} files and ${bfSize(BF_MAX_TOTAL)} per brief</span>
    </label>
    ${rows ? `<ul class="bf-list">${rows}</ul>` : ""}
    ${bfbNoteHtml(kind, sourceId)}
    <p class="note">${inSend
      ? "Everyone you send this to can download these from the brief. Adding or removing a file later reaches them too — no need to send again."
      : "Everyone this brief is sent to can download these. Adding or removing a file here reaches them straight away — no need to send again."}</p>
    <p class="bp-msg cb-msg" id="bf-msg" role="status" aria-live="polite"></p>`);
}

/** Redraws THIS brief's files block and nothing else. Every file action — the list arriving, an
    upload starting or finishing, a remove, a retry — used to repaint the whole brief viewer, and a
    viewer repaint rebuilds every editor from its SAVED value: an open requirements field, the
    rename box, a format's edit form and a legacy script line all lost what had been typed
    (owner, 2026-09-25: "When I add a file into briefs, all the edits I make on the previous parts
    get erased"). The campaign poll never repaints over an open editor (cbEditorBusy); the files
    block now never repaints anything but itself. The block is found by its data-bf-key, so a
    finish that lands after the page has moved on (another brief, a viewer repaint mid-upload)
    redraws whichever copy is showing, or does nothing. Only the file list feeds the block, and the
    one reader outside it (the "Sent to … with N files" line) reads BF_FILES at send time. */
function bfRepaint(kind, sourceId) {
  bfbPaint(kind, sourceId);                     // the rows under the beats read the same two lists
  const key = agSentKey(kind, sourceId);
  const cur = [...document.querySelectorAll(".bf-section")].find((el) => el.dataset.bfKey === key);
  if (!cur) return;
  const hadFocus = cur.contains(document.activeElement);
  const tpl = document.createElement("template");
  tpl.innerHTML = bfSectionHtml(kind, sourceId, { inSend: cur.classList.contains("bf-in-send") }).trim();
  const next = tpl.content.firstElementChild;
  if (!next) return;
  cur.replaceWith(next);
  bfWire(next, kind, sourceId);
  // Focus was on the file input or a Remove button that no longer exists: keep it in the block.
  if (hadFocus) next.querySelector("#bf-input, #bf-retry")?.focus({ preventScroll: true });
}

/** Starts the list load on first paint and wires the block the viewer just drew (standalone or
    inside the open Send panel — whichever cbSendShowsFiles picked). */
function bfBind(host, kind, sourceId) {
  bfGuardPage();
  const key = agSentKey(kind, sourceId);
  const sec = [...host.querySelectorAll(".bf-section")].find((el) => el.dataset.bfKey === key);
  if (sec) bfWire(sec, kind, sourceId);
  bfbPaint(kind, sourceId, host);                                   // beat rows from what is cached
  bfEnsure(kind, sourceId, () => bfFilesArrived(kind, sourceId));   // first load: the list, then the placements
  bfPlacesEnsure(kind, sourceId, () => bfRepaint(kind, sourceId));  // the list was cached already
}

/** The block's own listeners, scoped to one drawn copy of it. */
function bfWire(sec, kind, sourceId) {
  const key = agSentKey(kind, sourceId);
  const say = (text, tone, sticky) => cbMsg(document.getElementById("bf-msg"), text, tone, sticky);
  const repaint = () => bfRepaint(kind, sourceId);
  const input = sec.querySelector("#bf-input");
  input?.addEventListener("change", () => {
    const files = [...input.files];
    input.value = "";
    bfUpload(kind, sourceId, files, repaint);
  });
  const drop = sec.querySelector("#bf-drop");
  drop?.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    drop.classList.add("over");
  });
  drop?.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop?.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    bfUpload(kind, sourceId, [...(e.dataTransfer?.files || [])], repaint);
  });
  sec.querySelector("#bf-retry")?.addEventListener("click", () => {
    BF_FILES.delete(key);
    BF_PLACES.delete(key);
    repaint();                                   // "Loading files…"
    bfEnsure(kind, sourceId, () => bfFilesArrived(kind, sourceId));
  });
  sec.querySelector("#bf-places-retry")?.addEventListener("click", (e) => {
    e.currentTarget.disabled = true;
    BF_PLACES.delete(key);
    bfPlacesEnsure(kind, sourceId, repaint);
  });
  sec.querySelectorAll(".bf-remove").forEach((btn) => {
    armDelete(btn, "Remove", async () => {
      btn.disabled = true;
      try {
        await bfRemove(btn.dataset.id, btn.dataset.path);
        const pl = BF_PLACES.get(key);           // the database dropped its placements with it (cascade)
        if (pl) pl.rows = pl.rows.filter((p) => p.file_id !== btn.dataset.id);
        await bfEnsure(kind, sourceId, null, true);
        repaint();
        say("Removed.", "good");
      } catch (ex) {
        btn.disabled = false;
        say(`${btn.dataset.name}: ${bfErrorSentence(ex, "remove")}.`, "bad", true);
      }
    });
  });
}

// ---------- Files on beats (plan: ~/.claude/plans/brief-files-at-beats.md) ----------
// Staff put one of a brief's files on a beat of one of its formats ("the logo goes on the opening
// beat"), and every creator the brief reaches sees that file on that beat, with a download.
// SQL: supabase/brief_file_beats.sql. One placement = one row of lynxr_brief_file_beats:
//   file_id    the file. It goes when the file goes: the foreign key cascades.
//   format_id  the id the SENT DOC gives that format (agencySendDoc: the campaign format's uuid;
//              briefSendDoc: the legacy item's video URL, else its index).
//   beat       the beat's 0-based index when it was placed.
//   sigs       up to BF_MAX_SIGS fingerprints of that beat's words (bfBeatSig).
// LIVE, like the files: no re-send. An index shifts when a beat is added, deleted or regenerated, so a
// placement lands on the beat whose words still match, nearest its index (bfResolve). When no beat
// matches (the beat was reworded, deleted, or the format regenerated), staff see the file flagged
// "beat changed" on the beat at its old index, with Keep here, and creators see it only in their
// files list, never on a beat it may not belong to. "Restore previous version" brings the words back,
// and the placement with them. bfBeatSig / bfResolve are copied in creator.js as lynxBeatSig /
// lynxResolveBeat: change them together.
// NEVER REPAINTS A VIEWER. A placement action redraws the rows under the beats (bfbPaint) and the
// files block (bfRepaint) and nothing else, so an open editor keeps its typed text and an open Send
// panel keeps its ticks (owner, 2026-09-25).
let BF_PLACES = new Map();           // agSentKey(kind, id) -> { rows, error } | undefined = not loaded
const BF_PLACES_LOADING = new Set(); // keys in flight
const BF_MAX_SIGS = 4;               // mirrors the CHECK in supabase/brief_file_beats.sql

/** A beat's fingerprint: FNV-1a over its say / do / show, ignoring case and runs of whitespace. The
    time is left out: retiming a beat does not make it another beat. 8 hex characters. creator.js has
    the same function as lynxBeatSig and the two must agree: { say: "Line 1", do: "A move" } is
    "0d4743b8" in both. */
function bfBeatSig(b) {
  const n = (v) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const s = `${n(b?.say)}\n${n(b?.do)}\n${n(b?.show)}`;
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Where placement p lands among beats whose fingerprints are `sigs`: its own index while that beat
    still reads the same, else the nearest beat that does, else -1. Same as lynxResolveBeat. */
function bfResolve(p, sigs) {
  const want = new Set(Array.isArray(p.sigs) ? p.sigs : []);
  const at = Math.max(0, Number(p.beat) || 0);
  if (at < sigs.length && want.has(sigs[at])) return at;
  let best = -1;
  for (let j = 0; j < sigs.length; j++) {
    if (want.has(sigs[j]) && (best < 0 || Math.abs(j - at) < Math.abs(best - at))) best = j;
  }
  return best;
}

/** Where the agency side DRAWS a placement: the beat it resolves to, or (flagged stale) the beat at
    its old index, the last beat when there are fewer now. null when the format has no beats. */
function bfbShown(p, sigs) {
  if (!sigs.length) return null;
  const j = bfResolve(p, sigs);
  return j >= 0 ? { at: j, stale: false }
    : { at: Math.min(Math.max(0, Number(p.beat) || 0), sigs.length - 1), stale: true };
}

/** The formats of one brief as staff see them NOW, in on-screen order: [{ id, n, word, beats }].
    id is the sent doc's format id, n the card's number, word what the agency calls one ("format" on
    a campaign, "script" on a legacy brief), beats [{ say, do, show }], or null while the format has
    no script to put a file on. */
function bfbFormats(kind, sourceId) {
  if (kind === "campaign") {
    const rec = CB_CACHE.get(sourceId);
    if (!rec || !Array.isArray(rec.formats)) return [];
    return cbSorted(rec).map((f, i) => ({
      id: f.id, n: i + 1, word: "format",
      beats: f.script || f.edited ? (cbView(f).beats || []) : null,
    }));
  }
  for (const c of loadClients()) {
    const rec = (c.briefs || []).find((b) => b.id === sourceId);
    if (!rec) continue;
    const ctx = rec.ctx || {};
    return (rec.items || []).map((row, i) => ({
      id: row.url || String(i), n: i + 1, word: "script", beats: agDocBeats(agScriptFor(row, ctx, i)),
    }));
  }
  return [];
}

/** Loads (force: reloads) where this brief's files sit. The query is by file id, so it needs the file
    list first: bfBind calls it for a list that was cached, bfFilesArrived for one that just loaded.
    No files: nothing to ask, and nothing to draw. */
async function bfPlacesEnsure(kind, sourceId, onDone, force) {
  const key = agSentKey(kind, sourceId);
  const files = BF_FILES.get(key);
  if (!files || files.error) return;
  if (BF_PLACES_LOADING.has(key) || (!force && BF_PLACES.has(key))) return;
  const ids = files.rows.map((r) => r.id).filter(Boolean);
  if (!ids.length) { BF_PLACES.set(key, { rows: [], error: null }); onDone?.(); return; }
  BF_PLACES_LOADING.add(key);
  try {
    const rows = await sbFetch(`/rest/v1/lynxr_brief_file_beats?file_id=in.(${ids.map(encodeURIComponent).join(",")})`
      + `&select=id,file_id,format_id,beat,sigs&order=placed_at.asc`);
    BF_PLACES.set(key, { rows: Array.isArray(rows) ? rows : [], error: null });
  } catch (ex) {
    BF_PLACES.set(key, { rows: [], error: cbError(ex) });
  } finally {
    BF_PLACES_LOADING.delete(key);
    onDone?.();
  }
}

/** The file list just arrived (first load, or Try again): draw it, then load where the files sit. */
function bfFilesArrived(kind, sourceId) {
  bfRepaint(kind, sourceId);
  bfPlacesEnsure(kind, sourceId, () => bfRepaint(kind, sourceId));
}

/** Put a file on a beat. The new row is added to BF_PLACES. Two rows for the same file and beat are
    harmless (bfbPaint draws one chip), so there is no unique key to trip over when a placement's
    stored index has drifted from the beat it is drawn on. */
async function bfPlace(kind, sourceId, fileId, formatId, beat, sig) {
  const rows = await sbFetch("/rest/v1/lynxr_brief_file_beats?select=id,file_id,format_id,beat,sigs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ file_id: fileId, format_id: String(formatId), beat, sigs: [sig] }),
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw new Error("0 nothing was placed");
  BF_PLACES.get(agSentKey(kind, sourceId))?.rows.push(row);
}

/** Take a file off a beat. The file itself stays in the brief. */
async function bfUnplace(kind, sourceId, id) {
  await sbFetch(`/rest/v1/lynxr_brief_file_beats?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  const pl = BF_PLACES.get(agSentKey(kind, sourceId));
  if (pl) pl.rows = pl.rows.filter((r) => r.id !== id);
}

/** Keep here: a flagged placement now means beat `beat` as it reads today. Its older fingerprints are
    kept (the newest BF_MAX_SIGS), so a creator whose copy still has the older words keeps seeing the
    file on the right beat until staff press Update. */
async function bfKeep(row, beat, sig) {
  const sigs = [...(row.sigs || []).filter((s) => s !== sig), sig].slice(-BF_MAX_SIGS);
  const rows = await sbFetch(`/rest/v1/lynxr_brief_file_beats?id=eq.${encodeURIComponent(row.id)}`
    + `&select=id,file_id,format_id,beat,sigs`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ beat, sigs }),
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error("0 no placement was updated");
  Object.assign(row, rows[0]);
}

// ---- Files on beats: what staff see — the row under each beat, and the files block's lines ----

/** A failed placement action, in a few words: it shows under the script's beats. */
function bfbErrorSentence(ex) {
  const kind = cbError(ex);
  if (kind === "missing") return "Putting files on beats isn't installed yet.";
  if (kind === "denied") return "This account can't change where files go.";
  return "Couldn't save that — check the connection and try again.";
}

/** One line under a script's beats for a failed file action; "" removes it. Its own element, so it
    never overwrites the line editor's message (agLineMsg). */
function bfbMsg(li, text) {
  const list = li?.closest("ol.bp-beats");
  if (!list) return;
  let m = list.nextElementSibling?.classList.contains("bfb-msg") ? list.nextElementSibling : null;
  if (!text) { m?.remove(); return; }
  if (!m) {
    m = document.createElement("p");
    m.className = "bp-msg bfb-msg show bad";
    m.setAttribute("role", "status");
    list.after(m);
  }
  m.textContent = text;
}

/** One file's row in the files block, second line: "on format 1 · beat 1, format 2 · beat 4 (beat
    changed)". "" when it is on no beat. A placement on a format that was deleted is not listed. */
function bfbWhere(kind, sourceId, fileId, formats) {
  const pl = BF_PLACES.get(agSentKey(kind, sourceId));
  if (!pl || pl.error) return "";
  const byId = new Map(formats.map((f) => [f.id, f]));
  const spots = new Map();                        // "n:at" -> { n, word, at, stale }: one per beat, a match beats a flag
  for (const p of pl.rows) {
    if (p.file_id !== fileId) continue;
    const f = byId.get(p.format_id);
    if (!f) continue;
    const s = bfbShown(p, (f.beats || []).map(bfBeatSig))
      || { at: Math.max(0, Number(p.beat) || 0), stale: true };
    const had = spots.get(`${f.n}:${s.at}`);
    if (!had || (had.stale && !s.stale)) spots.set(`${f.n}:${s.at}`, { n: f.n, word: f.word, at: s.at, stale: s.stale });
  }
  const out = [...spots.values()].sort((a, b) => a.n - b.n || a.at - b.at);
  return out.length
    ? `on ${out.map((o) => `${o.word} ${o.n} · beat ${o.at + 1}${o.stale ? " (beat changed)" : ""}`).join(", ")}` : "";
}

/** The files block's line about beats: not installed, couldn't load, or how to use it. Only once the
    brief has a file, since there is nothing to place before that. */
function bfbNoteHtml(kind, sourceId) {
  const key = agSentKey(kind, sourceId);
  const files = BF_FILES.get(key);
  const pl = BF_PLACES.get(key);
  if (!files || files.error || !files.rows.length || !pl) return "";
  if (pl.error === "missing") {
    return `<p class="note bf-beats-note">Putting files on beats needs one more update — run <code>supabase/brief_file_beats.sql</code> in the Supabase SQL editor.</p>`;
  }
  if (pl.error) {
    return `<p class="note bf-beats-note">Couldn't load which beats these files are on.</p>
      <button type="button" class="ghost cb-small" id="bf-places-retry">Try again</button>`;
  }
  return `<p class="note bf-beats-note">To show creators a file at one moment of the video, press + Add file under that beat in the script.</p>`;
}

/** The row under one beat: a chip per file on it (a flagged one says "beat changed" and offers Keep
    here), then "+ Add file", which opens IN PLACE — no popover to position — into a button per file
    of the brief that is not on this beat yet. */
function bfbRowHtml(i, entries, files) {
  const on = new Set(entries.map((e) => e.file.id));
  const chips = entries.map(({ p, file, stale }) => `<span class="bfb-chip${stale ? " bfb-stale" : ""}">
      <span class="bfb-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      ${stale ? `<span class="bfb-why">beat changed</span>
      <button type="button" class="bfb-keep" data-pid="${escapeHtml(p.id)}"
        aria-label="Keep ${escapeHtml(file.name)} on beat ${i + 1}">Keep here</button>` : ""}
      <button type="button" class="bfb-x" data-pid="${escapeHtml(p.id)}"
        aria-label="Take ${escapeHtml(file.name)} off beat ${i + 1}" title="Take off this beat">${CB_X_SVG}</button>
    </span>`).join("");
  const left = files.filter((f) => !on.has(f.id));
  const add = left.length ? `<details class="bfb-add">
      <summary class="bfb-sum"><span aria-hidden="true">+</span> Add file<span class="sr-only"> to beat ${i + 1}</span></summary>
      <div class="bfb-menu" role="group" aria-label="Files you can put on beat ${i + 1}">${left.map((f) =>
        `<button type="button" class="bfb-pick" data-file="${escapeHtml(f.id)}" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</button>`).join("")}</div>
    </details>` : "";
  return `<div class="bfb" data-bfb-beat="${i}">${chips}${add}</div>`;
}

/** Puts focus back into a beat's rebuilt row: its + Add file, else its last button. */
function bfbFocus(scope, beat) {
  const row = [...scope.querySelectorAll("li.bp-beat > .bfb")].find((r) => Number(r.dataset.bfbBeat) === beat);
  const el = row?.querySelector(".bfb-sum") || [...(row?.querySelectorAll("button") || [])].pop();
  el?.focus({ preventScroll: true });
}

/** Draws the file row under every beat of this brief that is on screen (only those under `root` when
    given), replacing the rows drawn before. Nothing else in a card is touched: a line being typed,
    the pencil form, a playing clip. Draws nothing until the file list and the placements have both
    loaded, when the brief has no files, or while placements are not installed (the files block says
    so). Beats are found by their editable lines' data-beat, which is the index into the beats. */
function bfbPaint(kind, sourceId, root = document) {
  if ((kind === "campaign" ? CAMPAIGN_VIEW : BRIEF_VIEW)?.id !== sourceId) return;
  const key = agSentKey(kind, sourceId);
  const files = BF_FILES.get(key);
  const pl = BF_PLACES.get(key);
  const ready = !!files && !files.error && files.rows.length > 0 && !!pl && !pl.error;
  const formats = bfbFormats(kind, sourceId);
  const scopes = [];
  if (kind === "campaign") {
    const cards = root.matches?.(".cb-format[data-fid]") ? [root] : [...root.querySelectorAll(".cb-format[data-fid]")];
    for (const card of cards) {
      const info = card.querySelector(".cb-info");
      if (info) scopes.push([formats.find((f) => f.id === card.dataset.fid) || null, info]);
    }
  } else {
    const list = root.matches?.(".vscript") ? [root] : [...root.querySelectorAll(".fmt-card[data-idx] .vscript")];
    for (const vs of list) scopes.push([formats[Number(vs.closest(".fmt-card[data-idx]")?.dataset.idx)] || null, vs]);
  }
  const a = document.activeElement;
  for (const [fmt, scope] of scopes) {
    let back = null;                              // the beat whose row held focus
    scope.querySelectorAll("li.bp-beat > .bfb").forEach((row) => {
      if (a && row.contains(a)) back = Number(row.dataset.bfbBeat);
      row.remove();
    });
    if (!ready || !fmt || !fmt.beats || !fmt.beats.length) continue;
    const sigs = fmt.beats.map(bfBeatSig);
    const fileById = new Map(files.rows.map((r) => [r.id, r]));
    const at = new Map();                         // beat index -> [{ p, file, stale }]
    for (const p of pl.rows) {
      if (p.format_id !== fmt.id || !fileById.has(p.file_id)) continue;
      const s = bfbShown(p, sigs);
      if (!s) continue;
      const list = at.get(s.at) || [];
      const entry = { p, file: fileById.get(p.file_id), stale: s.stale };
      const dup = list.findIndex((e) => e.file.id === p.file_id);
      if (dup < 0) list.push(entry);
      else if (list[dup].stale && !s.stale) list[dup] = entry;   // one chip a file: the matching one wins
      at.set(s.at, list);
    }
    scope.querySelectorAll("li.bp-beat").forEach((li) => {
      const i = Number(li.querySelector('[data-edit="beat"][data-beat]')?.dataset.beat);
      if (!Number.isInteger(i) || i < 0 || i >= sigs.length) return;
      li.insertAdjacentHTML("beforeend", bfbRowHtml(i, at.get(i) || [], files.rows));
      bfbWire(li.lastElementChild, kind, sourceId, fmt.id, i, sigs[i]);
    });
    if (back != null) bfbFocus(scope, back);
  }
}

/** One beat row's controls. Each action writes, then redraws the beat rows and the files block
    (bfRepaint), and puts focus back in this beat's row. A failure is said under the script. */
function bfbWire(row, kind, sourceId, formatId, i, sig) {
  const li = row.closest("li.bp-beat");
  const scope = li.closest(".cb-info, .vscript") || document;
  const key = agSentKey(kind, sourceId);
  const act = async (write) => {
    row.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    bfbMsg(li, "");
    let err = null;
    try { await write(); } catch (ex) { err = ex; }
    if (err && cbError(err) === "missing") {
      const pl = BF_PLACES.get(key);
      if (pl) pl.error = "missing";               // the files block now says what to run
    }
    bfRepaint(kind, sourceId);
    if (err) bfbMsg(li, bfbErrorSentence(err));
    bfbFocus(scope, i);
  };
  const add = row.querySelector(".bfb-add");
  add?.addEventListener("toggle", () => {
    if (add.open) document.querySelectorAll("details.bfb-add[open]").forEach((d) => { if (d !== add) d.open = false; });
  });
  add?.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !add.open) return;
    e.preventDefault();
    e.stopPropagation();
    add.open = false;
    add.querySelector(".bfb-sum")?.focus();
  });
  row.querySelectorAll(".bfb-pick").forEach((btn) => btn.addEventListener("click", () =>
    act(() => bfPlace(kind, sourceId, btn.dataset.file, formatId, i, sig))));
  row.querySelectorAll(".bfb-x").forEach((btn) => btn.addEventListener("click", () =>
    act(() => bfUnplace(kind, sourceId, btn.dataset.pid))));
  row.querySelectorAll(".bfb-keep").forEach((btn) => btn.addEventListener("click", () => act(async () => {
    const p = BF_PLACES.get(key)?.rows.find((r) => r.id === btn.dataset.pid);
    if (p) await bfKeep(p, i, sig);
  })));
}

// ---- Staff-action request bodies (Step 13's buttons send these verbatim) ----
const cbRetryBody = () => ({
  status: "queued", attempts: 0, retry_at: null, error_kind: "", error_detail: "",
  retryable: true, phase: "",
});
const cbRegenerateBody = (f, note) => ({
  status: "queued", job: f.analysis ? "script" : "read", regen_note: note || "",
  attempts: 0, retry_at: null, error_kind: "", error_detail: "", phase: "",
});
const cbReplaceLinkBody = (url) => ({
  source_url: url, job: "read", status: "queued", source: null, analysis: null,
  script: null, script_prev: null, edited: null, attempts: 0, retry_at: null,
  error_kind: "", error_detail: "", phase: "",
});
const cbRestoreBody = (f) => ({
  script: f.script_prev.script, edited: f.script_prev.edited,
  script_prev: { script: f.script, edited: f.edited },
});

/** The ONLY definition of what a creator sees. Only "done" formats, position
    order, renumbered 1..N. Never includes strategy_note, internal_note,
    internal_notes, fit/fit_reason, analysis, regen_note, brand_context
    internals or status — those are agency-only and must never export. */
function campaignDocHtml(campaign, formats, client) {
  const bc = campaign.brand_context || {};
  const done = formats.filter((f) => f.status === "done");
  const created = (campaign.created_at || "").slice(0, 10);
  const rows = done.map((f, i) => {
    const v = cbView(f);
    const setup = [["Setting", v.setting], ["Lighting", v.lighting], ["Framing", v.framing], ["Audio", v.audio]]
      .filter(([, val]) => val)
      .map(([lbl, val]) => `<p><strong>${lbl}:</strong> ${escapeHtml(val)}</p>`).join("");
    const beats = (v.beats || []).map((b) => {
      const parts = [];
      if (b.say) parts.push(`<strong>Say:</strong> “${escapeHtml(b.say)}”`);
      if (b.do) parts.push(`<strong>Do:</strong> ${escapeHtml(b.do)}`);
      if (b.show) parts.push(`<strong>On screen:</strong> “${escapeHtml(b.show)}”`);
      return `<li>[${escapeHtml(b.t || "")}] ${parts.join("<br>")}</li>`;
    }).join("");
    const href = safeUrl(f.source_url);
    // The original video sits directly under the title, kept on the same page
    // as it (.cb-doc-head). A worded link for the PDF, and the address itself
    // as plain text beneath it, so a paper print or a viewer that strips link
    // annotations still carries the video.
    return `<section>
      <div class="cb-doc-head">
        <h2>${i + 1}. ${escapeHtml(v.title || v.hook || "Untitled format")}</h2>
        <p class="cb-doc-video">${href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Watch the original video</a>`
          : `<strong>Original video</strong>`}<br><span class="cb-doc-url">${escapeHtml(f.source_url || "")}</span></p>
      </div>
      <p><strong>Needs:</strong> ${escapeHtml((v.needs || []).join(" • "))}</p>
      ${setup}
      <ol>${beats}</ol>
      <p><strong>CTA:</strong> “${escapeHtml(v.cta || "")}”</p>
      <p><strong>Post caption:</strong> ${escapeHtml(v.caption || "")}</p>
      ${v.creator_note ? `<p><strong>Note:</strong> ${escapeHtml(v.creator_note)}</p>` : ""}
    </section>`;
  }).join("");
  return `<article class="cb-doc"><h1>${escapeHtml(campaign.name || "")}</h1>
    <p class="cb-doc-sub">${escapeHtml(bc.name || client?.company || "")} · ${escapeHtml(created)}</p>
    ${campaign.instructions ? `<h2>Campaign requirements</h2><p>${escapeHtml(campaign.instructions)}</p>` : ""}
    ${rows}</article>`;
}

function campaignDocText(campaign, formats, client) {
  const bc = campaign.brand_context || {};
  const done = formats.filter((f) => f.status === "done");
  const created = (campaign.created_at || "").slice(0, 10);
  const lines = [campaign.name || "", `${bc.name || client?.company || ""} · ${created}`, ""];
  if (campaign.instructions) lines.push("CAMPAIGN REQUIREMENTS", campaign.instructions, "");
  done.forEach((f, i) => {
    const v = cbView(f);
    lines.push(`${i + 1}. ${v.title || v.hook || "Untitled format"}`);
    lines.push(`Watch the original video: ${f.source_url || ""}`);
    lines.push(`Needs: ${(v.needs || []).join(" • ")}`);
    for (const [lbl, val] of [["Setting", v.setting], ["Lighting", v.lighting], ["Framing", v.framing], ["Audio", v.audio]]) {
      if (val) lines.push(`${lbl}: ${val}`);
    }
    (v.beats || []).forEach((b) => {
      const parts = [];
      if (b.say) parts.push(`Say: "${b.say}"`);
      if (b.do) parts.push(`Do: ${b.do}`);
      if (b.show) parts.push(`On screen: "${b.show}"`);
      lines.push(`[${b.t || ""}] ${parts.join(" / ")}`);
    });
    lines.push(`CTA: "${v.cta || ""}"`);
    lines.push(`Post caption: ${v.caption || ""}`);
    if (v.creator_note) lines.push(`Note: ${v.creator_note}`);
    lines.push("");
  });
  return lines.join("\n");
}

// ---- Campaign briefs: interface (plan Steps 10-14) ----
// Everything a staff member sees and presses for campaign briefs. The data
// layer above is the only thing that talks to Supabase; nothing below builds a
// request of its own. Styles live in the CAMPAIGN BRIEFS block at the very end
// of app.css (CSS ORDER TRAP, see HANDOFF). CSP: no style="" attribute anywhere
// here — the progress bar and textarea heights are set through CSSOM.

const CB_ICON = {
  up: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
  down: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>`,
  edit: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.8 3.8a2.1 2.1 0 0 1 3 3L8.5 18.1l-4 1 1-4z"/><path d="M14.5 6.1l3.4 3.4"/></svg>`,
  regen: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.35-5.65"/><path d="M20 4v5h-5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
};

/* Session-only editor state, ids only (the BP_EDITING pattern): the working
   copy lives in the form fields until Save, so Cancel needs no undo buffer. */
const CB_EDITING = new Set();     // format ids with the edit form open
const CB_REGEN = new Set();       // format ids with the "what should change?" row open
const CB_REPLACE = new Set();     // failed format ids with the replace-link row open
let CB_FIELD_EDIT = null;         // { id, field: "name" | "instructions" | "internal_notes" | "brand" }
const CB_AGENCY_OPEN = new Set(); // campaign ids whose agency-only <details> is open
let CB_POLL_T = null, CB_POLL_ID = null, CB_POLL_BUSY = false;
let CB_PENDING = false;           // a poll found changes it could not paint yet
let CB_LIST_T = null;
const CB_LIST_BUSY = new Set();
const CB_LOADING = new Set();
const CB_LOAD_ERR = new Map();    // campaign id -> cbError kind of the failed first load
let CB_LANE = null;               // { value, at, fetching }
let CB_ADD_KEEP = null;           // { id, values } typed add-video rows carried across a repaint

/* THE FORMAT LIBRARY (plan: ~/.claude/plans/campaign-format-library.md, 2026-09-25). Every READY
   format of this client's OTHER campaign briefs, grouped by brief, newest first, added to the open
   brief as a COPY born status "done" — the worker never claims it and no model is called. Keyed by
   the OPEN brief's id: its library is "every brief but this one". */
const CB_LIB = new Map();          // open campaign id -> { clientId, groups: [{ c, formats, files }], at } | { error, at }
const CB_LIB_LOADING = new Set();  // open campaign ids with a library load in flight
const CB_LIB_OPEN = new Map();     // open campaign id -> library <details> open (true) / shut (false), once toggled
const CB_LIB_GROUPS = new Map();   // open campaign id -> Set of group (source campaign) ids shown open
const CB_LIB_Q = new Map();        // open campaign id -> the filter's text
let CB_LIB_BUSY = false;           // a library copy is in flight: every Add is disabled
let CB_COPYING = false;            // "Copy to new brief" is in flight
const CB_LIB_FILTER_AT = 12;       // the filter box shows above this many formats

const cbPlural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Grow a textarea.grow to its content. Skipped while the field is not laid
    out (hidden box, closed <details>) — scrollHeight is 0 there and would pin
    the box at zero height; reveal handlers call it again. */
function cbGrow(t) {
  if (!t.getClientRects().length) { t.style.height = ""; return; }
  t.style.height = "auto";
  t.style.height = t.scrollHeight + 2 + "px";
}
function cbWireGrow(root) {
  root.querySelectorAll("textarea.grow").forEach((t) => {
    cbGrow(t);
    if (t.dataset.cbGrow) return;
    t.dataset.cbGrow = "1";
    t.addEventListener("input", () => cbGrow(t));
  });
  root.querySelectorAll("details").forEach((d) => {
    if (d.dataset.cbGrow) return;
    d.dataset.cbGrow = "1";
    d.addEventListener("toggle", () => d.querySelectorAll("textarea.grow").forEach(cbGrow));
  });
}

/** Inline feedback line (.bp-msg). Confirmations fade; errors stay (sticky). */
const CB_MSG_T = new Map();
function cbMsg(el, text, tone, sticky) {
  if (!el) return;
  el.textContent = text;
  el.className = `bp-msg cb-msg show${tone ? " " + tone : ""}`;
  clearTimeout(CB_MSG_T.get(el.id));
  if (!sticky) {
    const id = el.id;
    CB_MSG_T.set(id, setTimeout(() => {
      const e2 = document.getElementById(id);
      if (e2) e2.className = "bp-msg cb-msg";
    }, 4500));
  }
}

function cbErrorSentence(ex, verb) {
  const kind = cbError(ex);
  if (kind === "missing") return "Campaign briefs aren't installed yet — run supabase/campaigns.sql in the Supabase SQL editor.";
  if (kind === "denied") return `This account can't ${verb} campaign briefs.`;
  return `Couldn't ${verb} — check the connection and try again.`;
}

/** Work that exists only in this page until it is sent. startLiveSync checks
    this so a teammate's client edit never repaints it away. */
function cbUnsavedWork() {
  // Any typed link row — the new-brief composer's or the campaign view's
  // add-videos rows — plus a named or instructed composer. The name field is
  // empty by default (its "Brief N" is only a placeholder), so any value in it
  // was typed.
  if ([...document.querySelectorAll(".cb-row-input")].some((i) => i.value.trim())) return true;
  if ((document.getElementById("cb-name")?.value || "").trim()) return true;
  if ((document.getElementById("cb-instructions")?.value || "").trim()) return true;
  if (document.querySelector("#cl-brand-box:not([hidden])")) return true;
  return CB_EDITING.size > 0 || CB_REGEN.size > 0 || CB_REPLACE.size > 0 || !!CB_FIELD_EDIT;
}

// ---------- Link rows: one input per video ----------
/* Used by the new-brief composer and the campaign view's "add videos" box.
   Every rule about a link still comes from cbParseLinks: each row is parsed
   top to bottom with the links above it (and the campaign's existing ones) as
   the duplicate set, so a row's badge and the summary can never disagree with
   what submit sends. URLs never contain whitespace, so a paste or an input
   holding several tokens is split into consecutive rows. */
let CB_ROW_SEQ = 0;
const CB_X_SVG = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

function cbRowHtml() {
  const id = `cb-row-${++CB_ROW_SEQ}`;
  return `<div class="cb-row">
    <label class="cb-row-lbl" for="${id}">Video</label>
    <div class="composer-row cb-row-field">
      <input type="url" class="cb-row-input cb-raw" id="${id}" aria-describedby="${id}-st"
        placeholder="Paste a TikTok or Instagram link" autocomplete="off" autocapitalize="off" spellcheck="false">
      <span class="bp-plat cb-row-badge" id="${id}-st"></span>
      <button type="button" class="ghost icon-only cb-row-del" aria-label="Remove video">${CB_X_SVG}</button>
    </div>
  </div>`;
}

/** kind: "compose" | "add". Numbering starts at `startNo`; at most `max` rows. */
function cbRowsHtml(kind, startNo, max) {
  return `<div class="cb-rows" data-rows="${kind}" data-start="${startNo}" data-max="${max}">
    <div class="cb-row-list">${cbRowHtml()}</div>
    <div class="cb-rows-foot">
      <button type="button" class="ghost cb-small cb-row-add">+ Add video</button>
      <span class="lbl cb-row-cap"></span>
    </div>
    <p class="bp-msg cb-msg" id="cb-rowmsg-${kind}" role="status" aria-live="polite"></p>
  </div>`;
}

/** Parse every row in order. Returns [{input, value, r}] — r is the
    cbParseLinks row for that input, or null when it is empty. */
function cbRowsParse(rowsEl, existing = new Set()) {
  const seen = new Set(existing);
  return [...rowsEl.querySelectorAll(".cb-row-input")].map((input) => {
    const value = input.value.trim();
    const r = value ? cbParseLinks(value, seen)[0] || null : null;
    if (r?.ok) seen.add(canonUrl(r.url));
    return { input, value, r };
  });
}

function cbRowsCount(parsed) {
  const filled = parsed.filter((p) => p.r);
  const ready = filled.filter((p) => p.r.ok).length;
  return { ready, skipped: filled.length - ready };
}

const cbWhySentence = (why) => why === "youtube" ? "YouTube isn't supported yet."
  : why === "duplicate" ? "That video is already in the list."
  : why === "not supported" ? CB_ERROR_TEXT.off_platform : "That isn't a link.";

/** Wire a cbRowsHtml block. Delegated listeners, so rows added later need no
    wiring of their own. Returns { paint, parsed, reset, values, setValues }. */
function cbWireRows(rowsEl, { existing = () => new Set(), onChange = () => {} } = {}) {
  const list = rowsEl.querySelector(".cb-row-list");
  const max = Math.max(1, Number(rowsEl.dataset.max) || CB_MAX_PASTE);
  const start = Number(rowsEl.dataset.start) || 1;
  const addBtn = rowsEl.querySelector(".cb-row-add");
  const cap = rowsEl.querySelector(".cb-row-cap");
  const msg = rowsEl.querySelector(".cb-msg");
  const rows = () => [...list.querySelectorAll(".cb-row")];
  const inputOf = (row) => row?.querySelector(".cb-row-input");

  const paint = () => {
    const rs = rows();
    rs.forEach((row, i) => {
      const n = start + i;
      row.querySelector(".cb-row-lbl").textContent = `Video ${n}`;
      const del = row.querySelector(".cb-row-del");
      del.setAttribute("aria-label", `Remove video ${n}`);
      del.title = `Remove video ${n}`;
      del.hidden = rs.length === 1;
    });
    const parsed = cbRowsParse(rowsEl, existing());
    for (const { input, r } of parsed) {
      const badge = input.parentElement.querySelector(".cb-row-badge");
      if (!r) { badge.textContent = ""; badge.title = ""; badge.className = "bp-plat cb-row-badge"; continue; }
      const text = r.ok ? r.plat : r.why === "youtube" ? "YouTube isn't supported yet" : r.why;
      badge.textContent = text;
      badge.title = text;
      badge.className = "bp-plat cb-row-badge on " + (r.ok ? "good" : r.why === "duplicate" ? "dup" : "bad");
    }
    const full = rs.length >= max;
    addBtn.disabled = full;
    cap.textContent = !full ? ""
      : max >= CB_MAX_PASTE ? `${CB_MAX_PASTE} videos is the limit per batch`
      : `The campaign holds ${CB_MAX_FORMATS} formats — room for ${max} more`;
    onChange(parsed);
  };

  const insertAfter = (row, value = "") => {
    if (rows().length >= max) return null;
    const tpl = document.createElement("template");
    tpl.innerHTML = cbRowHtml().trim();
    const nr = tpl.content.firstElementChild;
    inputOf(nr).value = value;
    if (row) row.after(nr); else list.appendChild(nr);
    return nr;
  };
  const focusEnd = (input) => { input.focus(); const n = input.value.length; try { input.setSelectionRange(n, n); } catch {} };

  // Several links in one input: the first stays here, the rest fill new rows
  // directly below, up to the cap. Says so when some did not fit.
  const spread = (input, tokens) => {
    input.value = tokens[0];
    let row = input.closest(".cb-row");
    let last = input, added = 1, dropped = 0;
    for (let k = 1; k < tokens.length; k++) {
      const nr = insertAfter(row, tokens[k]);
      if (!nr) { dropped = tokens.length - k; break; }
      row = nr; last = inputOf(nr); added++;
    }
    paint();
    focusEnd(last);
    if (dropped) {
      cbMsg(msg, `Only ${max} videos fit here — ${cbPlural(dropped, "link wasn't", "links weren't")} added.`, "bad", true);
    } else {
      cbMsg(msg, `Pasted ${added} links into ${added} rows.`, "good");
    }
  };

  list.addEventListener("paste", (e) => {
    const input = e.target.closest(".cb-row-input");
    if (!input) return;
    const text = e.clipboardData?.getData("text") || "";
    const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
    const tokens = cbParseLinks(input.value.slice(0, a) + text + input.value.slice(b)).map((t) => t.raw);
    if (tokens.length <= 1) return;           // one link: the normal paste
    e.preventDefault();
    spread(input, tokens);
  });
  list.addEventListener("input", (e) => {
    const input = e.target.closest(".cb-row-input");
    if (!input) return;
    const tokens = cbParseLinks(input.value).map((t) => t.raw);
    if (tokens.length > 1) { spread(input, tokens); return; }   // drag-drop, autofill
    paint();
  });
  list.addEventListener("keydown", (e) => {
    const input = e.target.closest(".cb-row-input");
    if (!input || e.key !== "Enter") return;
    e.preventDefault();                       // never submits the form from a row
    if (!input.value.trim() || rows().length >= max) return;
    const nr = insertAfter(input.closest(".cb-row"));
    paint();
    inputOf(nr).focus();
  });
  list.addEventListener("click", (e) => {
    const del = e.target.closest(".cb-row-del");
    if (!del) return;
    const row = del.closest(".cb-row");
    if (rows().length <= 1) return;
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    if (msg) msg.className = "bp-msg cb-msg";   // an "only 10 fit" note is stale now
    paint();
    focusEnd(inputOf(next));
  });
  addBtn.addEventListener("click", () => {
    const nr = insertAfter(rows().at(-1));
    if (!nr) return;
    paint();
    inputOf(nr).focus();
  });

  const setValues = (values) => {
    list.innerHTML = "";
    const vs = (values || []).slice(0, max);
    (vs.length ? vs : [""]).forEach((v) => insertAfter(null, v));
    paint();
  };
  return {
    paint,
    parsed: () => cbRowsParse(rowsEl, existing()),
    values: () => rows().map((r) => inputOf(r).value),
    setValues,
    reset: () => { setValues([]); if (msg) msg.className = "bp-msg cb-msg"; },
  };
}

// ---------- Step 10: brand context form ----------

/** The brand context form, shared by the client page (Edit brand), the new
    campaign composer, and a campaign's agency-only block. Labels are written
    in normal case; the house style lowercases them in CSS. Typed values are
    content and keep their casing (inputs/textareas are on the exclusion list). */
function brandFormHtml(bc, prefix) {
  const niches = [...new Set(ALL.map((r) => r.niche_category).filter(Boolean))].sort();
  const audiences = [...new Set(ALL.map((r) => r.target_audience).filter(Boolean))].sort();
  const fid = (k) => `${prefix}-${k}`;
  /* TYPE ANYTHING (owner, 2026-09-22: "make all of these typeable, no need for dropdown options").
     Niche and target audience were the only two <select>s here, so a client whose niche the database
     has never seen could not be written down. They are text boxes now, with the database's own values
     offered as suggestions — a <datalist> suggests without restricting, and the picked-video shelf
     still filters by exact niche name, so choosing a suggested one keeps that filter working. */
  const listed = (k, label, val, list, ph) => `
    <label class="ce-field"><span class="lbl">${label}</span>
      <input type="text" id="${fid(k)}" data-bf="${k}" value="${escapeHtml(val || "")}"
        list="${fid(k)}-opts" placeholder="${escapeHtml(ph)}" autocomplete="off">
      <datalist id="${fid(k)}-opts">${list.map((v) => `<option value="${escapeHtml(v)}"></option>`).join("")}</datalist></label>`;
  const input = (k, label, val, ph = "", wide = false) => `
    <label class="ce-field${wide ? " ce-wide" : ""}"><span class="lbl">${label}</span>
      <input type="text" id="${fid(k)}" data-bf="${k}" value="${escapeHtml(val || "")}"
        placeholder="${escapeHtml(ph)}" autocomplete="off"></label>`;
  const area = (k, label, val, ph = "") => `
    <label class="ce-field ce-wide"><span class="lbl">${label}</span>
      <textarea class="grow" rows="2" id="${fid(k)}" data-bf="${k}"
        placeholder="${escapeHtml(ph)}">${escapeHtml(val || "")}</textarea></label>`;
  return `<div class="ce-grid cb-brand-form">
    ${input("name", "Brand / product name", bc.name, "e.g. Cloey")}
    ${listed("niche", "Niche", bc.niche, niches, "e.g. fashion & beauty")}
    ${area("description", "Brand description", bc.description, "What it is, in a sentence or two")}
    ${input("product", "Product / app", bc.product)}
    ${listed("audience", "Target audience", bc.audience, audiences, "who it's for")}
    ${area("audienceNotes", "Who it's for, in plain words", bc.audienceNotes)}
    ${area("painPoints", "Main pain points", bc.painPoints)}
    ${input("features", "Key features (comma-separated, up to 8)", (bc.features || []).join(", "), "", true)}
    ${area("valueProps", "Value propositions", bc.valueProps)}
    ${area("tone", "Brand tone and language", bc.tone)}
    ${input("cta", "CTA", bc.cta, "e.g. Download free — link in bio")}
    ${input("site", "Website / app link", bc.site, "https://")}
    ${area("notes", "Previous campaign notes / brand instructions", bc.notes)}
    <details class="ce-wide cb-more"${bc.habits || bc.goals ? " open" : ""}>
      <summary>Daily habits and deep goals</summary>
      <div class="ce-grid cb-more-grid">
        ${area("habits", "Daily habits", bc.habits)}
        ${area("goals", "Deep goals", bc.goals)}
      </div>
    </details>
  </div>`;
}

/** Read a brandFormHtml form back into a brand_context, on top of `base` so
    keys the form does not edit (company) survive. */
function readBrandForm(root, base = {}) {
  const val = (k) => (root.querySelector(`[data-bf="${k}"]`)?.value || "").trim();
  return {
    ...base,
    name: val("name"), niche: val("niche"), description: val("description"), product: val("product"),
    audience: val("audience"), audienceNotes: val("audienceNotes"), painPoints: val("painPoints"),
    features: val("features").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8),
    valueProps: val("valueProps"), tone: val("tone"), cta: val("cta"), site: val("site"),
    notes: val("notes"), habits: val("habits"), goals: val("goals"),
  };
}

/** MERGE a brand context into a client record (never replace its ctx). */
function cbApplyBrandToClient(c, bc) {
  const patch = brandContextToClientPatch(bc);
  c.ctx = { ...(c.ctx || {}), ...patch.ctx };
  c.niche = patch.niche;
}

function clientBrandBoxHtml(client) {
  return `<div class="client-details cb-brand-box" id="cl-brand-box" hidden>
    <div class="cb-block-head"><span class="cb-block-title">Brand context</span>
      <span class="lbl">used when campaign briefs are written</span></div>
    ${brandFormHtml(brandContextFromClient(client), "clb")}
    <div class="bp-actions">
      <button type="button" class="btn" id="cl-brand-save">Save brand</button>
      <button type="button" class="ghost" id="cl-brand-cancel">Cancel</button>
    </div>
  </div>`;
}

function bindClientBrand(host, client) {
  const btn = document.getElementById("cl-brand");
  const box = document.getElementById("cl-brand-box");
  if (!btn || !box) return;
  const setOpen = (open) => {
    box.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      box.querySelectorAll("textarea.grow").forEach(cbGrow);
      box.querySelector('[data-bf="name"]')?.focus();
    }
  };
  // Cancel discards: the form is rebuilt from the stored client, in place, so
  // nothing else on the page (a half-pasted composer) is repainted.
  const cancel = () => {
    box.querySelector(".cb-brand-form").outerHTML = brandFormHtml(brandContextFromClient(client), "clb");
    cbWireGrow(box);
    setOpen(false);
    btn.focus();
  };
  cbWireGrow(box);
  btn.addEventListener("click", () => (box.hidden ? setOpen(true) : cancel()));
  document.getElementById("cl-brand-cancel").addEventListener("click", cancel);
  box.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } });
  document.getElementById("cl-brand-save").addEventListener("click", () => {
    const list = loadClients();
    const c = list.find((x) => x.id === client.id);
    if (!c) return;
    cbApplyBrandToClient(c, readBrandForm(box.querySelector(".cb-brand-form"), brandContextFromClient(c)));
    persistClients(list);
    renderBriefsKeepScroll();
    const again = document.getElementById("cl-brand");
    if (again) {
      again.textContent = "Saved ✓";
      again.focus();
      setTimeout(() => { if (again.isConnected) again.textContent = "Edit brand"; }, 1500);
    }
  });
}

// ---------- Step 11: campaign list + new campaign composer ----------

/* ONE BRIEFS LIST (owner, 2026-09-14). The client page's "Briefs" section
   holds both kinds, newest first, in the same card: the picked-video briefs
   stored on the client record, and campaign briefs from lynxr_campaigns. The
   campaign half is fetched; if that fails (tables not installed, no access,
   offline) the record's briefs still render and one quiet line says why. */

const cbTime = (iso) => new Date(iso || 0).getTime() || 0;

function cbBriefItems(client) {
  const old = client.briefs || [];
  const items = old.map((b, i) => ({ kind: "brief", id: b.id, at: b.createdAt, no: old.length - i, b }));
  for (const r of CB_LISTS.get(client.id)?.rows || []) items.push({ kind: "campaign", id: r.id, at: r.created_at, r });
  return items.sort((x, y) => cbTime(y.at) - cbTime(x.at));
}

/** "Brief N" for a new campaign brief whose name was left empty. */
const cbNextBriefName = (client) => `Brief ${cbBriefItems(client).length + 1}`;

function cbBriefListHtml(client) {
  const entry = CB_LISTS.get(client.id);
  const items = cbBriefItems(client);
  let quiet = "";
  if (!entry) quiet = `<p class="note cb-list-note">Loading campaign briefs…</p>`;
  else if (entry.error === "missing") quiet = `<p class="note cb-list-note">Campaign briefs aren't installed yet — run <code>supabase/campaigns.sql</code> in the Supabase SQL editor.</p>`;
  else if (entry.error === "denied") quiet = `<p class="note cb-list-note">This account can't read campaign briefs.</p>`;
  else if (entry.error) quiet = `<p class="note cb-list-note">Couldn't load campaign briefs. <button type="button" class="ghost cb-small" id="cb-list-retry">Try again</button></p>`;
  if (!items.length) {
    if (!entry) return quiet;
    return `<div class="empty">${emptyMark("idle")}<p><strong>No briefs yet.</strong></p>
      <p>Hit + to paste 1–10 inspiration links — each video becomes a production format.</p></div>${quiet}`;
  }
  const trash = (what) => `<button type="button" class="ghost danger icon-only br-del"
      aria-label="Delete this ${what}" title="Delete this ${what}">${TRASH_SVG}</button>`;
  const latest = (i) => i === 0 ? ` <span class="pill">latest</span>` : "";
  return `<div class="brief-stack">` + items.map((it, i) => {
    const date = escapeHtml(String(it.at || "").slice(0, 10));
    if (it.kind === "brief") {
      return `<article class="bcard opens" data-kind="brief" data-id="${escapeHtml(it.id)}"
          role="button" tabindex="0" aria-label="Open brief ${it.no}">
        <div class="bcard-main">
          <div class="bcard-title">Brief ${it.no}${latest(i)}</div>
          <div class="lbl">${date} · ${it.b.items.length} scripts</div>
        </div>${trash("brief")}
      </article>`;
    }
    const c = it.r.counts;
    const name = it.r.name || "Untitled brief";
    return `<article class="bcard opens" data-kind="campaign" data-id="${escapeHtml(it.id)}"
        role="button" tabindex="0" aria-label="Open campaign brief ${escapeHtml(name)}">
      <div class="bcard-main">
        <div class="bcard-title"><span class="cb-name">${escapeHtml(name)}</span>${latest(i)}</div>
        <div class="lbl cb-meta"><span>${date} · ${cbPlural(c.total, "format", "formats")}${c.working ? ` · ${c.ready} of ${c.total} ready` : ""}</span>
          ${c.failed ? `<span class="chip bad">${c.failed} failed</span>` : ""}</div>
      </div>${trash("campaign brief")}
    </article>`;
  }).join("") + `</div>${quiet}`;
}

function briefsSectionHtml(client) {
  const picks = SUGGEST_PICKS.size;
  const nextName = cbNextBriefName(client);
  return `<div class="section cb-briefs" id="cb-box">
    <div class="sec-head">
      <h2>Briefs <span class="pill" id="cl-brief-count">${cbBriefItems(client).length}</span></h2>
      <span class="cb-sec-actions">
        ${/* The picked-video brief builder stays reachable, but only where it
              ever made sense: after videos are ticked in Suggestions. The + is
              the campaign composer now (owner, 2026-09-14). */""}
        ${picks
          ? `<button type="button" class="btn sec-cta" id="cl-nextbrief">${picks} pick${picks === 1 ? "" : "s"} → brief ${client.briefs.length + 1}</button>`
          : `<span id="cl-nextbrief" hidden></span>`}
        <button type="button" class="lib-plus" id="cb-new" aria-expanded="false" aria-controls="cb-compose"
          title="New brief from inspiration links" aria-label="New brief from inspiration links">${CB_ICON.plus}<span class="lib-plus-txt" aria-hidden="true">New brief</span></button>
      </span>
    </div>
    <form class="client-details cb-compose" id="cb-compose" novalidate hidden>
      <div class="ce-grid">
        <label class="ce-field ce-wide"><span class="lbl">Brief name</span>
          <input type="text" id="cb-name" value="" placeholder="${escapeHtml(nextName)}" autocomplete="off"></label>
        <label class="ce-field ce-wide"><span class="lbl">Campaign instructions — shown to creators at the top of the brief</span>
          <textarea class="grow" rows="3" id="cb-instructions"
            placeholder="e.g. Film in natural light. No competitor logos on screen."></textarea></label>
        <div class="ce-field ce-wide" role="group" aria-labelledby="cb-links-h">
          <span class="lbl" id="cb-links-h">Inspiration videos — one link per row, 5–10 works best</span>
          ${cbRowsHtml("compose", 1, CB_MAX_PASTE)}
        </div>
      </div>
      <p class="cb-link-count" id="cb-link-count" role="status" aria-live="polite"></p>
      <details class="cb-more cb-compose-brand">
        <summary>Brand context for this brief</summary>
        ${brandFormHtml(brandContextFromClient(client), "cbc")}
        <label class="cb-check"><input type="checkbox" id="cb-save-brand">
          <span>Also save these to <span class="cb-name">${escapeHtml(client.company)}</span>'s profile</span></label>
      </details>
      <div class="bp-actions">
        <button type="submit" class="btn" id="cb-go" disabled>Generate 0 formats</button>
        <button type="button" class="ghost" id="cb-cancel">Cancel</button>
      </div>
      <p class="bp-msg cb-msg" id="cb-compose-msg" role="status" aria-live="polite"></p>
    </form>
    <p class="bp-msg cb-msg" id="cb-msg" role="status" aria-live="polite"></p>
    <div id="cl-brief-list">${cbBriefListHtml(client)}</div>
  </div>`;
}

/** The count line and the Generate button, both driven by the link rows. */
function cbPaintComposer(parsed) {
  const count = document.getElementById("cb-link-count");
  const go = document.getElementById("cb-go");
  if (!count || !go) return;
  const { ready, skipped } = cbRowsCount(parsed);
  const n = Math.min(ready, CB_MAX_PASTE);
  const bits = [];
  if (ready || skipped) bits.push(`${cbPlural(ready, "link", "links")} ready` + (skipped ? ` · ${skipped} skipped` : ""));
  if (ready > 0 && ready < 5) bits.push("5–10 works best");
  count.textContent = bits.join(" · ");
  go.disabled = n === 0;
  go.textContent = `Generate ${cbPlural(n, "format", "formats")}`;
}

function cbScheduleList(clientId) {
  clearTimeout(CB_LIST_T);
  const entry = CB_LISTS.get(clientId);
  if (!entry?.rows?.some((r) => r.counts.working > 0)) return;
  const again = () => {
    if (CAMPAIGN_VIEW || BRIEF_VIEW || CLIENT_VIEW?.id !== clientId || !document.getElementById("cl-brief-list")) return;
    if (document.hidden || document.querySelector("#cl-brief-list .br-del.armed")) { CB_LIST_T = setTimeout(again, 30000); return; }
    cbRefreshList(clientId);
  };
  CB_LIST_T = setTimeout(again, 30000);
}

async function cbRefreshList(clientId) {
  if (CB_LIST_BUSY.has(clientId)) return;
  CB_LIST_BUSY.add(clientId);
  try { await cbListCampaigns(clientId); }
  catch (ex) { CB_LISTS.set(clientId, { rows: null, error: cbError(ex), at: Date.now() }); }
  finally { CB_LIST_BUSY.delete(clientId); }
  cbPaintList(clientId);
}

/** Repaint ONLY the briefs list, its count and the composer's "Brief N"
    placeholder — never the whole client page, which would wipe a half-filled
    composer or brand form. */
function cbPaintList(clientId) {
  if (CAMPAIGN_VIEW || BRIEF_VIEW || CLIENT_VIEW?.id !== clientId) return;
  const box = document.getElementById("cl-brief-list");
  const client = loadClients().find((c) => c.id === clientId);
  if (!box || !client) return;
  const focused = document.activeElement?.closest?.("#cl-brief-list .bcard")?.dataset.id;
  box.innerHTML = cbBriefListHtml(client);
  const pill = document.getElementById("cl-brief-count");
  if (pill) pill.textContent = String(cbBriefItems(client).length);
  const name = document.getElementById("cb-name");
  if (name) name.placeholder = cbNextBriefName(client);
  cbBindList(clientId);
  if (focused) [...box.querySelectorAll(".bcard")].find((c) => c.dataset.id === focused)?.focus();
  cbScheduleList(clientId);
}

function cbBindList(clientId) {
  const box = document.getElementById("cl-brief-list");
  if (!box) return;
  const msg = () => document.getElementById("cb-msg");
  box.querySelectorAll(".bcard[data-kind]").forEach((card) => {
    const id = card.dataset.id;
    const del = card.querySelector(".br-del");
    if (card.dataset.kind === "brief") {
      openOnCard(card, () => { BRIEF_VIEW = { id, expanded: null }; CAMPAIGN_VIEW = null; renderBriefs(); });
      armDelete(del, "Delete", () => {
        const fresh = loadClients();
        const c = fresh.find((x) => x.id === clientId);
        if (!c) return;
        c.briefs = c.briefs.filter((b) => b.id !== id);
        persistClients(fresh);
        cbPaintList(clientId);
        refreshNextBriefBtn(c);
        cbMsg(msg(), "Brief deleted.", "good");
      });
      return;
    }
    openOnCard(card, () => {
      CAMPAIGN_VIEW = { id }; BRIEF_VIEW = null;
      renderBriefs();
      window.scrollTo({ top: 0 });
    });
    armDelete(del, "Delete", async () => {
      try {
        await cbDeleteCampaign(id);
        CB_CACHE.delete(id);
        const e = CB_LISTS.get(clientId);
        if (e?.rows) e.rows = e.rows.filter((r) => r.id !== id);
        cbPaintList(clientId);
        cbMsg(msg(), "Campaign brief deleted.", "good");
      } catch (ex) {
        cbPaintList(clientId);
        cbMsg(msg(), cbErrorSentence(ex, "delete"), "bad", true);
      }
    });
  });
  document.getElementById("cb-list-retry")?.addEventListener("click", () => cbRefreshList(clientId));
}

function bindBriefsSection(host, client) {
  const form = document.getElementById("cb-compose");
  const plus = document.getElementById("cb-new");
  const rowsEl = form?.querySelector('[data-rows="compose"]');
  if (!form || !plus || !rowsEl) return;
  const cmsg = () => document.getElementById("cb-compose-msg");
  const ctl = cbWireRows(rowsEl, { onChange: cbPaintComposer });
  ctl.paint();
  const firstRow = () => rowsEl.querySelector(".cb-row-input");
  const setOpen = (open) => {
    form.hidden = !open;
    plus.setAttribute("aria-expanded", String(open));
    if (!open) return;
    form.querySelectorAll("textarea.grow").forEach(cbGrow);
    firstRow()?.focus();
    // Not installed: say so where it matters — at the moment of creating.
    if (CB_LISTS.get(client.id)?.error === "missing") {
      cbMsg(cmsg(), "Campaign briefs aren't installed yet — run supabase/campaigns.sql in the Supabase SQL editor.", "bad", true);
    }
  };
  plus.addEventListener("click", () => setOpen(form.hidden));
  const picksBtn = document.getElementById("cl-nextbrief");
  if (picksBtn?.tagName === "BUTTON") picksBtn.addEventListener("click", () => startNextWeekBrief(client));
  cbWireGrow(form);
  // Cancel discards everything typed; Escape only hides the form.
  document.getElementById("cb-cancel").addEventListener("click", () => {
    form.reset();
    ctl.reset();
    form.querySelectorAll("textarea.grow").forEach(cbGrow);
    const m = cmsg();
    if (m) m.className = "bp-msg cb-msg";
    setOpen(false);
    plus.focus();
  });
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); plus.focus(); }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const go = document.getElementById("cb-go");
    const parsed = ctl.parsed();
    const urls = parsed.filter((p) => p.r?.ok).slice(0, CB_MAX_PASTE).map((p) => p.r.url);
    if (!urls.length) {
      const bad = parsed.find((p) => p.r);
      cbMsg(cmsg(), bad ? cbWhySentence(bad.r.why) : "Paste at least one TikTok or Instagram video link.", "bad", true);
      (bad?.input || firstRow())?.focus();
      return;
    }
    const nameEl = document.getElementById("cb-name");
    const name = nameEl.value.trim() || cbNextBriefName(client);
    const brandContext = readBrandForm(form.querySelector(".cb-brand-form"), brandContextFromClient(client));
    const face = go.textContent;
    go.disabled = true;
    go.textContent = "Creating…";
    try {
      const id = await cbCreateCampaign({
        clientId: client.id, name, instructions: document.getElementById("cb-instructions").value.trim(),
        brandContext, urls,
      });
      if (document.getElementById("cb-save-brand")?.checked) {
        const list = loadClients();
        const c = list.find((x) => x.id === client.id);
        if (c) { cbApplyBrandToClient(c, brandContext); persistClients(list); }
      }
      CB_LISTS.delete(client.id);
      form.reset();
      ctl.reset();                      // releases the live-sync guard
      CAMPAIGN_VIEW = { id }; BRIEF_VIEW = null;
      renderBriefs();
      window.scrollTo({ top: 0 });
    } catch (ex) {
      cbMsg(cmsg(), cbErrorSentence(ex, "create"), "bad", true);
      go.disabled = false;
      go.textContent = face;
    }
  });

  cbBindList(client.id);
  const entry = CB_LISTS.get(client.id);
  // Re-renders of this page are frequent (blueprints, suggestions); refetch
  // only when the list is missing or older than 15s.
  if (!entry || Date.now() - (entry.at || 0) > 15000) cbRefreshList(client.id);
  else cbScheduleList(client.id);
}

// ---------- Step 12: the campaign view ----------

const cbSorted = (rec) => [...rec.formats].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
const cbShortUrl = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

function cbCrumbsHtml(client, here) {
  return `<nav class="crumbs" aria-label="Breadcrumb">
    <button type="button" class="crumb-link" id="cv-clients">Clients</button>
    <span class="crumb-sep">›</span>
    <button type="button" class="crumb-link" id="cv-back">${escapeHtml(client.company)}</button>
    <span class="crumb-sep">›</span>
    <span class="crumb-here cb-name">${escapeHtml(here)}</span>
  </nav>`;
}
function cbBindCrumbs() {
  document.getElementById("cv-clients")?.addEventListener("click", () => {
    CLIENT_VIEW = null; BRIEF_VIEW = null; CAMPAIGN_VIEW = null; renderBriefs();
  });
  document.getElementById("cv-back")?.addEventListener("click", () => {
    CAMPAIGN_VIEW = null; BRIEF_VIEW = null; renderBriefs();
  });
}

function cbMediaHtml(f, cls = "cd-player-col cb-media") {
  const href = f.source_url ? safeUrl(f.source_url) : "";
  const plat = platformOf(f.source_url || "") || (f.platform ? String(f.platform) : "video");
  const cover = f.cover ? safeUrl(f.cover) : "";
  const wrap = (cls, inner) => href
    ? `<a class="${cls}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" aria-label="Open the original video">${inner}</a>`
    : `<span class="${cls}">${inner}</span>`;
  let frame;
  if (f.clip && safeUrl(f.clip)) {
    frame = `<video class="cb-clip" controls preload="metadata" playsinline src="${escapeHtml(safeUrl(f.clip))}"${cover ? ` poster="${escapeHtml(cover)}"` : ""}></video>`;
  } else if (cover) {
    frame = wrap("cb-cover", `<img src="${escapeHtml(cover)}" alt="" loading="lazy">`);
  } else {
    frame = wrap("cb-ph", `<span>${escapeHtml(plat)}</span>`);
  }
  const dur = Number(f.duration) > 0 ? `${Math.round(Number(f.duration))}s` : "";
  return `<div class="${cls}">
    ${frame}
    ${href ? `<a class="cb-open" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">open original ↗</a>` : ""}
    <div class="lbl">${escapeHtml(plat)}${dur ? " · " + dur : ""}</div>
  </div>`;
}

function cbDetailHtml(f) {
  const v = cbView(f);
  const sec = (label, inner) => inner ? `<div class="cb-sec"><div class="bp-heading">${label}</div>${inner}</div>` : "";
  const needs = (v.needs || []).filter(Boolean);
  const setup = [["setting", v.setting], ["lighting", v.lighting], ["framing", v.framing], ["audio", v.audio]]
    .filter(([, x]) => x);
  const timed = (v.beats || []).some((b) => b.t);
  const spoken = (v.beats || []).some((b) => b.say);
  // Each line edits in place (cbBindCard); the beats are fields already, so nothing is parsed.
  const beats = (v.beats || []).map((b, i) => agBeatHtml(b.t || "",
    [["SAY", "say", b.say], ["DO", "do", b.do], ["ON SCREEN", "onscreen", b.show]], spoken, timed,
    { ag: "cb", id: f.id, mode: "fields", i })).join("");
  const why = [f.analysis?.format?.why_it_works, f.analysis?.production?.hook_mechanism,
    f.analysis?.production?.repeatable_because].filter(Boolean);
  const internal = (v.strategy_note || f.internal_note || why.length) ? `
    <div class="cb-internal">
      <div class="bp-heading cb-agency-lbl">Agency only — never exported</div>
      ${v.strategy_note ? `<div class="cb-sec"><div class="bp-heading">Strategy note</div><p>${escapeHtml(v.strategy_note)}</p></div>` : ""}
      ${f.internal_note ? `<div class="cb-sec"><div class="bp-heading">Internal note</div><p>${escapeHtml(f.internal_note)}</p></div>` : ""}
      ${why.length ? `<div class="cb-sec"><div class="bp-heading">Why the original works</div>${why.map((w) => `<p>${escapeHtml(w)}</p>`).join("")}</div>` : ""}
    </div>` : "";
  // Hook, CTA, caption, the four setup values and the creator note edit in place too, into edited.<field> (cbBindCard's writeTop saves any field it is handed). Needs and the title stay pencil-only.
  const top = { ag: "cb", id: f.id };
  // AGENCY SCRIPT LOOK (2026-09-15): the creator's hook card, beat cards and split.
  return `<div class="ref-split cb-split">
    <div class="ref-main cd-info cb-info">
      ${v.hook ? `<div class="bp-hook"><span class="bp-hook-lbl">Hook</span>${agTopHtml(v.hook, "hook", top, { quoted: true })}</div>` : ""}
      ${sec("Needs", needs.length ? `<ul class="cb-needs">${needs.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : "")}
      ${sec("Setup", setup.length ? `<div class="cb-setup">${setup.map(([l, x]) =>
        `<div class="cb-setup-row"><span class="cb-setup-lbl">${l}</span><span class="cb-setup-val">${agTopHtml(x, l, top)}</span></div>`).join("")}</div>` : "")}
      ${sec("Script", agBeatsHtml(beats, timed))}
      ${sec("CTA", v.cta ? `<p class="cb-note">${agTopHtml(v.cta, "cta", top, { quoted: true })}</p>` : "")}
      ${sec("Post caption", v.caption ? `<p class="cb-note">${agTopHtml(v.caption, "caption", top)}</p>` : "")}
      ${sec("Creator note", v.creator_note ? `<p class="cb-note">${agTopHtml(v.creator_note, "creator_note", top, { label: "creator note", multiline: true, cls: "ag-caption" })}</p>` : "")}
      ${internal}
    </div>
    <details class="bp-item ref-panel ag-original" open>
      <summary><span class="bp-caret" aria-hidden="true">▸</span><span class="bp-name">The original</span></summary>
      <div class="bp-body">${cbMediaHtml(f, "ref-dock cb-dock")}</div>
    </details>
  </div>`;
}

function cbBeatFieldHtml(b, i) {
  const area = (k, label) => `<label class="ce-field"><span class="lbl">${label}</span>
    <textarea class="grow" rows="1" data-bt="${k}">${escapeHtml(b[k] || "")}</textarea></label>`;
  return `<fieldset class="cb-beat-field">
    <legend class="cb-lbl">Beat <span class="cb-beat-n">${i + 1}</span></legend>
    <div class="cb-beat-grid">
      <label class="ce-field"><span class="lbl">Time</span>
        <input type="text" data-bt="t" value="${escapeHtml(b.t || "")}" placeholder="0-3s" autocomplete="off"></label>
      ${area("say", "Say")}${area("do", "Do")}${area("show", "On screen")}
    </div>
    <button type="button" class="ghost cb-small cb-beat-remove">Remove beat</button>
  </fieldset>`;
}

function cbEditorHtml(f) {
  const v = cbView(f);
  const area = (k, label, val, rows = 2, wide = true, aud = "") => `
    <label class="ce-field${wide ? " ce-wide" : ""}"><span class="lbl">${label}${aud ? ` <span class="cb-aud">(${aud})</span>` : ""}</span>
      <textarea class="grow" rows="${rows}" data-ed="${k}">${escapeHtml(val || "")}</textarea></label>`;
  return `<form class="cb-editor" novalidate>
    <div class="ce-grid">
      ${area("title", "Title", v.title, 1)}
      ${area("hook", "Hook", v.hook)}
      ${area("needs", "Needs — one per line", (v.needs || []).join("\n"), 3)}
      ${area("setting", "Setting", v.setting, 2, false)}
      ${area("lighting", "Lighting", v.lighting, 2, false)}
      ${area("framing", "Framing", v.framing, 2, false)}
      ${area("audio", "Audio", v.audio, 2, false)}
    </div>
    <div class="cb-lbl">Script beats</div>
    <div class="cb-beat-list">${(v.beats || []).map(cbBeatFieldHtml).join("")}</div>
    <button type="button" class="ghost cb-small cb-beat-add">Add beat</button>
    <div class="ce-grid cb-ed-tail">
      ${area("cta", "CTA", v.cta)}
      ${area("caption", "Post caption", v.caption)}
      ${area("creator_note", "Creator note", v.creator_note, 2, true, "shown to creators")}
      ${area("strategy_note", "Strategy note", v.strategy_note, 2, true, "agency only")}
      ${area("internal_note", "Internal note", f.internal_note, 2, true, "agency only")}
    </div>
    <div class="bp-actions">
      <button type="submit" class="btn cb-ed-save">Save changes</button>
      <button type="button" class="ghost cb-ed-cancel">Cancel</button>
      ${f.edited ? `<button type="button" class="ghost cb-ed-revert" title="Discard the edits and show the generated version">Revert to generated</button>` : ""}
    </div>
  </form>`;
}

function cbReadEditor(form) {
  const val = (k) => (form.querySelector(`[data-ed="${k}"]`)?.value || "").trim();
  const beats = [...form.querySelectorAll(".cb-beat-field")].map((fs) => {
    const g = (k) => (fs.querySelector(`[data-bt="${k}"]`)?.value || "").trim();
    return { t: g("t"), say: g("say"), do: g("do"), show: g("show") };
  }).filter((b) => b.say || b.do || b.show);
  return {
    edited: {
      title: val("title"), hook: val("hook"),
      needs: val("needs").split("\n").map((s) => s.trim()).filter(Boolean),
      setting: val("setting"), lighting: val("lighting"), framing: val("framing"), audio: val("audio"),
      beats, cta: val("cta"), caption: val("caption"),
      creator_note: val("creator_note"), strategy_note: val("strategy_note"),
    },
    internal_note: val("internal_note"),
  };
}

/** One format card. The ONLY markup for a card: the full render and every
    in-place card update (poll, edit, regenerate) both call this, so the two
    paths cannot drift apart. */
function cbCardHtml(f, i, total) {
  const n = i + 1;
  const fid = escapeHtml(f.id);
  const busy = f.status === "queued" || f.status === "running";
  const editing = CB_EDITING.has(f.id);
  const href = f.source_url ? safeUrl(f.source_url) : "";
  const v = cbView(f);
  const hasScript = !!(f.script || f.edited);
  const srcLink = href
    ? `<a class="cb-src cb-raw" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cbShortUrl(f.source_url))}</a>`
    : `<span class="cb-src cb-raw">${escapeHtml(cbShortUrl(f.source_url))}</span>`;
  const ctrls = `<span class="cb-ctrls">
    <button type="button" class="ghost icon-only cb-up" aria-label="Move format ${n} up" title="Move up"${i === 0 || editing ? " disabled" : ""}>${CB_ICON.up}</button>
    <button type="button" class="ghost icon-only cb-down" aria-label="Move format ${n} down" title="Move down"${i === total - 1 || editing ? " disabled" : ""}>${CB_ICON.down}</button>
    ${f.status === "done" && !editing ? `<button type="button" class="ghost icon-only cb-edit" aria-label="Edit format ${n}" title="Edit">${CB_ICON.edit}</button>` : ""}
    ${f.status !== "error" ? `<button type="button" class="ghost icon-only cb-regen" aria-label="Regenerate format ${n}" aria-expanded="${CB_REGEN.has(f.id)}"
      title="${busy ? "Already generating" : "Regenerate"}"${busy || editing ? " disabled" : ""}>${CB_ICON.regen}</button>` : ""}
    <button type="button" class="ghost danger icon-only b-del cb-del" aria-label="Delete format ${n}" title="Delete this format">${TRASH_SVG}</button>
  </span>`;

  let head, body = "", extra = "";
  if (f.status === "done") {
    const weak = typeof v.fit === "number" && v.fit < 0.45;
    head = `<h3 class="cb-fh"><span class="cb-fnum">${n}.</span> <span class="cb-title">${escapeHtml(v.title || v.hook || "Untitled format")}</span></h3>
      <span class="cb-chips">${f.edited ? `<span class="chip">edited</span>` : ""}${weak
        ? `<span class="chip bad" title="${escapeHtml(v.fit_reason || "")}">weak fit<span class="sr-only">: ${escapeHtml(v.fit_reason || "")}</span></span>` : ""}</span>`;
    if (f.script_prev && !editing) {
      extra += `<div class="cb-restore-row"><button type="button" class="ghost cb-small cb-restore">Restore previous version</button></div>`;
    }
    body = editing ? cbEditorHtml(f) : cbDetailHtml(f);
  } else if (busy) {
    head = `<h3 class="cb-fh"><span class="cb-fnum">${n}.</span> ${hasScript ? `<span class="cb-title">${escapeHtml(v.title || v.hook || "")}</span>` : srcLink}</h3>
      <span class="chip cb-state">${loaderMark("writing")}<span>${escapeHtml(cbStateWords(f))}</span></span>`;
    body = `<div class="card-detail cb-detail">${cbMediaHtml(f)}
      <div class="cd-info cb-skel" aria-hidden="true"><i></i><i></i><i></i><i class="short"></i></div></div>`;
  } else {
    head = `<h3 class="cb-fh"><span class="cb-fnum">${n}.</span> ${srcLink}</h3><span class="chip bad">failed</span>`;
    body = `<div class="cb-err-body">
      <p class="cb-err-text">${escapeHtml(cbErrorText(f.error_kind))}</p>
      ${f.error_detail ? `<details class="cb-err-detail"><summary>details</summary><p class="cb-raw">${escapeHtml(f.error_detail)}</p></details>` : ""}
      <div class="bp-actions">
        ${f.retryable ? `<button type="button" class="ghost cb-retry">Try again</button>` : ""}
        <button type="button" class="ghost cb-replace" aria-expanded="${CB_REPLACE.has(f.id)}">Replace link</button>
      </div>
      ${CB_REPLACE.has(f.id) ? `<form class="composer-row cb-replace-form" novalidate>
          <input type="url" class="cb-replace-input" id="cb-rin-${fid}" placeholder="Paste a TikTok or Instagram link"
            aria-label="Replacement link for format ${n}" autocomplete="off" spellcheck="false">
          <button type="submit" class="composer-send" aria-label="Replace the link">${CB_ICON.send}</button>
        </form>` : ""}
    </div>`;
  }
  if (CB_REGEN.has(f.id) && f.status === "done") {
    extra += `<div class="cb-regen-row">
      <label class="ce-field"><span class="lbl">What should change? (optional)</span>
        <textarea class="grow" rows="2" data-regen-note placeholder="e.g. more Gen Z, shorter hook"></textarea></label>
      <div class="bp-actions">
        <button type="button" class="btn cb-regen-go">Regenerate</button>
        <button type="button" class="ghost cb-regen-cancel">Cancel</button>
      </div>
    </div>`;
  }
  return `<article class="fmt-card cb-format cb-${escapeHtml(f.status)}" id="cb-f-${fid}" data-fid="${fid}" tabindex="-1" aria-label="Format ${n}">
    <div class="fmt-head cb-fhead">${head}${ctrls}</div>
    ${extra}${body}
    <p class="bp-msg cb-msg" id="cb-fmsg-${fid}" role="status" aria-live="polite"></p>
  </article>`;
}

function cbRequirementsHtml(campaign, fe) {
  const editing = fe === "instructions";
  return `<section class="cb-block" aria-labelledby="cb-req-h">
    <div class="cb-block-head"><span class="cb-block-title" id="cb-req-h">Campaign requirements</span>
      <span class="lbl">shown to creators</span>
      ${editing ? "" : `<button type="button" class="ghost cb-small cb-field-edit" data-field="instructions">Edit</button>`}</div>
    ${editing ? cbFieldEditorHtml("instructions", campaign.instructions, "Campaign requirements")
      : campaign.instructions ? `<p class="cb-instructions">${escapeHtml(campaign.instructions)}</p>`
      : `<p class="note">No campaign-wide rules. Edit to add some — they print at the top of the brief.</p>`}
  </section>`;
}

function cbFieldEditorHtml(field, value, label) {
  return `<div class="cb-field-editor ce-field" data-field="${field}">
    <textarea class="grow" rows="3" data-fe aria-label="${escapeHtml(label)}">${escapeHtml(value || "")}</textarea>
    <div class="bp-actions">
      <button type="button" class="btn cb-fe-save">Save</button>
      <button type="button" class="ghost cb-fe-cancel">Cancel</button>
    </div>
  </div>`;
}

function cbAgencyHtml(campaign, fe) {
  const bc = campaign.brand_context || {};
  const open = CB_AGENCY_OPEN.has(campaign.id) || fe === "brand" || fe === "internal_notes";
  const rows = [["brand", bc.name], ["company", bc.company], ["niche", bc.niche], ["description", bc.description],
    ["product", bc.product], ["audience", bc.audience], ["who it's for", bc.audienceNotes], ["pain points", bc.painPoints],
    ["features", (bc.features || []).join(", ")], ["value props", bc.valueProps], ["tone", bc.tone], ["cta", bc.cta],
    ["site", bc.site], ["notes", bc.notes], ["daily habits", bc.habits], ["deep goals", bc.goals]].filter(([, x]) => x);
  return `<details class="cb-agency" id="cb-agency"${open ? " open" : ""}>
    <summary>Agency only — never exported</summary>
    <div class="cb-agency-body">
      <div class="cb-block-head"><span class="cb-block-title">Brand context used</span>
        ${fe === "brand" ? "" : `<button type="button" class="ghost cb-small cb-field-edit" data-field="brand">Edit</button>`}</div>
      ${fe === "brand" ? `<div class="cb-field-editor" data-field="brand">
          ${brandFormHtml(bc, "cbv")}
          <p class="note">Saved brand context applies to formats generated or regenerated from now on — existing formats keep their text.</p>
          <div class="bp-actions">
            <button type="button" class="btn cb-fe-save">Save</button>
            <button type="button" class="ghost cb-fe-cancel">Cancel</button>
          </div>
        </div>`
        : rows.length ? `<div class="cd-facts">${rows.map(([k, x]) =>
            `<div class="sug-drow"><span class="sug-dk">${k}</span><span class="sug-dv cb-bval">${escapeHtml(String(x))}</span></div>`).join("")}</div>`
        : `<p class="note">No brand context was saved with this campaign.</p>`}
      <div class="cb-block-head cb-notes-head"><span class="cb-block-title">Internal notes</span>
        ${fe === "internal_notes" ? "" : `<button type="button" class="ghost cb-small cb-field-edit" data-field="internal_notes">Edit</button>`}</div>
      ${fe === "internal_notes" ? cbFieldEditorHtml("internal_notes", campaign.internal_notes, "Internal notes")
        : campaign.internal_notes ? `<p class="cb-internal cb-internal-text">${escapeHtml(campaign.internal_notes)}</p>`
        : `<p class="note">None.</p>`}
    </div>
  </details>`;
}

function cbAddHtml(formats) {
  const room = CB_MAX_FORMATS - formats.length;
  if (room <= 0) {
    return `<p class="note cb-add-box">This campaign holds the maximum of ${CB_MAX_FORMATS} formats. Delete one to add another.</p>`;
  }
  // One batch is at most CB_MAX_PASTE links, and never more than the campaign
  // has room for. Numbering carries on from the formats already here.
  const batch = Math.min(CB_MAX_PASTE, room);
  return `<form class="cb-add-box" id="cb-add" novalidate>
    <div class="cb-block-head"><span class="cb-block-title" id="cb-add-h">Add inspiration videos</span>
      <span class="lbl">up to ${room} more</span></div>
    <div role="group" aria-labelledby="cb-add-h">${cbRowsHtml("add", formats.length + 1, batch)}</div>
    <div class="bp-actions cb-add-actions">
      <button type="submit" class="btn" id="cb-add-go" disabled>Add 0 videos</button>
      <span class="lbl" id="cb-add-count" role="status" aria-live="polite"></span>
    </div>
    <p class="bp-msg cb-msg" id="cb-add-msg" role="status" aria-live="polite"></p>
  </form>`;
}

function renderCampaignView(host, client, id) {
  const rec = CB_CACHE.get(id);
  if (!rec || !rec.campaign) {
    const err = CB_LOAD_ERR.get(id);
    const gone = rec && !rec.campaign;
    let inner;
    if (gone) inner = `<div class="empty"><p>This campaign brief no longer exists.</p></div>`;
    else if (err) {
      const text = err === "missing" ? "Campaign briefs aren't installed yet — run <code>supabase/campaigns.sql</code> in the Supabase SQL editor."
        : err === "denied" ? "This account can't read campaign briefs." : "Couldn't load this campaign brief.";
      inner = `<div class="empty">${emptyMark("confused")}<p>${text}</p>${err === "other" ? `<p><button type="button" class="ghost" id="cb-load-retry">Try again</button></p>` : ""}</div>`;
    } else {
      inner = `<div class="loader" role="status" aria-live="polite">${loaderMark()}
        <div class="loader-text"><div class="lbl">Opening the campaign brief…</div></div></div>`;
    }
    host.innerHTML = cbCrumbsHtml(client, "Campaign brief") + inner;
    cbBindCrumbs();
    document.getElementById("cb-load-retry")?.addEventListener("click", () => { CB_LOAD_ERR.delete(id); renderBriefs(); });
    if (gone) CB_CACHE.delete(id);
    if (!rec && !err && !CB_LOADING.has(id)) {
      CB_LOADING.add(id);
      cbLoadCampaign(id)
        .catch((ex) => { CB_LOAD_ERR.set(id, cbError(ex)); })
        .finally(() => { CB_LOADING.delete(id); if (CAMPAIGN_VIEW?.id === id) renderBriefsKeepScroll(); });
    }
    return;
  }

  CB_PENDING = false;
  const keep = host.dataset.cbView === id ? [...host.querySelectorAll("#cb-add .cb-row-input")].map((i) => i.value) : [];
  CB_ADD_KEEP = keep.some((v) => v.trim()) ? { id, values: keep } : null;
  host.dataset.cbView = id;
  const { campaign } = rec;
  const formats = cbSorted(rec);
  const fe = CB_FIELD_EDIT && CB_FIELD_EDIT.id === id ? CB_FIELD_EDIT.field : null;
  /* THE CAMPAIGN AS IT IS NOW. Read from CB_CACHE on every call, not from this render's `rec`, so an
     in-place edit made since the page drew is in what gets sent. `prev` is the doc creators already
     have (agencySendDoc keeps their version of a format that is mid-regeneration). */
  const sendDoc = (prev) => {
    const r = CB_CACHE.get(id) || rec;
    return agencySendDoc(r.campaign, cbSorted(r), client, prev);
  };
  const name = campaign.name || "Untitled campaign";
  host.innerHTML = `
    ${cbCrumbsHtml(client, name)}
    <div class="page-head cb-head">
      <div class="minw0">
        ${fe === "name"
          ? `<input type="text" class="cb-name-input" id="cb-name-input" value="${escapeHtml(campaign.name || "")}"
               aria-label="Campaign name — Enter saves, Escape cancels" autocomplete="off">`
          : `<div class="cb-title-row"><div class="bcard-title cb-name">${escapeHtml(name)}</div>
               <button type="button" class="ghost icon-only cb-rename" id="cb-rename" aria-label="Rename this campaign" title="Rename">${CB_ICON.edit}</button></div>`}
        <div class="lbl">${escapeHtml((campaign.created_at || "").slice(0, 10))} · <span id="cb-fcount"></span></div>
      </div>
      <div class="cb-export">
        <button type="button" class="btn cb-send-btn" id="cb-send-toggle">${CB_ICON.send}<span>Send to creators</span></button>
        <button type="button" class="ghost cb-copy-new" id="cb-copy-new" data-title="Start the next brief with this one's ready formats, requirements and files. Nothing is regenerated.">Copy to new brief</button>
        <button type="button" class="btn cb-pdf-btn" id="cb-pdf" data-title="Save the creator brief as a PDF: ready formats only, no agency notes.">Download PDF</button>
        <button type="button" class="ghost danger icon-only b-del" id="cb-del-campaign"
          aria-label="Delete this campaign brief" title="Delete this campaign brief">${TRASH_SVG}</button>
      </div>
    </div>
    <p class="note cb-notready" id="cb-notready" hidden></p>
    <p class="bp-msg cb-msg" id="cb-view-msg" role="status" aria-live="polite"></p>
    <div id="cb-send-wrap">${cbSendPanelHtml("campaign", id)}${cbSentListHtml("campaign", id, sendDoc)}</div>
    <div class="cb-progress">
      <div class="cb-progress-line" id="cb-progress-text" role="status" aria-live="polite"></div>
      <div class="cb-bar" aria-hidden="true"><div class="cb-bar-fill" id="cb-bar-fill"></div></div>
      <p class="note cb-lane" id="cb-lane" hidden></p>
    </div>
    ${cbRequirementsHtml(campaign, fe)}
    ${cbSendShowsFiles("campaign", id) ? "" : bfSectionHtml("campaign", id)}
    ${cbAgencyHtml(campaign, fe)}
    ${cbLibHtml(client, id)}
    <div class="fmt-grid cb-grid" id="cb-grid">
      ${formats.length ? formats.map((f, i) => cbCardHtml(f, i, formats.length)).join("")
        : `<div class="empty"><p>No formats in this brief yet. Add one from the format library above, or paste a link below.</p></div>`}
    </div>
    ${cbAddHtml(formats)}`;

  cbBindCrumbs();
  host.querySelectorAll(".cb-format").forEach((card) => cbBindCard(card, id));
  cbBindView(host, client, id);
  cbLibWireView(host, client, id);   // format library + "Copy to new brief" (campaign-format-library.md)
  cbBindSend(host, "campaign", id, sendDoc,
    () => { if (CAMPAIGN_VIEW?.id === id) renderBriefsKeepScroll(); });
  cbWireGrow(host);
  cbPaintSummary(id);
  if (fe === "name") { const inp = document.getElementById("cb-name-input"); inp?.focus(); inp?.select(); }
  else if (fe) host.querySelector(`.cb-field-editor[data-field="${fe}"] :is(textarea, input)`)?.focus();
  if (cbProgress(formats).working > 0) cbEnsurePoll(id); else cbClearPollTimer();
  if (ROSTER === null && !ROSTER_ERR) rostLoad();
  agEnsureSent("campaign", id, () => { if (CAMPAIGN_VIEW?.id === id) renderBriefsKeepScroll(); });
  bfBind(host, "campaign", id);    // file actions redraw only the files block — open editors keep their text
}

/** Progress line, bar, export buttons, not-ready note and lane reason — all
    updated in place, so a poll never has to repaint the page for them. */
function cbPaintSummary(id) {
  const rec = CB_CACHE.get(id);
  if (!rec || CAMPAIGN_VIEW?.id !== id) return;
  const formats = rec.formats;
  const p = cbProgress(formats);
  let reading = 0, writing = 0, queued = 0;
  for (const f of formats) {
    if (f.status === "running") { if (f.phase === "writing") writing++; else reading++; }
    else if (f.status === "queued") queued++;
  }
  const parts = [`${p.ready} of ${p.total} ready`];
  if (reading) parts.push(`${reading} reading`);
  if (writing) parts.push(`${writing} writing`);
  if (queued) parts.push(`${queued} queued`);
  if (p.failed) parts.push(`${p.failed} failed`);
  const text = document.getElementById("cb-progress-text");
  if (text) text.textContent = p.total ? parts.join(" · ") : "No formats yet";
  const fill = document.getElementById("cb-bar-fill");
  if (fill) fill.style.width = p.total ? `${(p.ready / p.total) * 100}%` : "0%";
  const count = document.getElementById("cb-fcount");
  if (count) count.textContent = cbPlural(p.total, "format", "formats");
  for (const bid of ["cb-send-toggle", "cb-copy-new", "cb-pdf"]) {
    const b = document.getElementById(bid);
    if (!b) continue;
    b.disabled = p.ready === 0;
    b.title = p.ready === 0 ? "No format is ready yet" : (b.dataset.title || "");
  }
  // The note under the send button: which formats a send carries (agencySendDoc keeps
  // only status "done"), or — with nothing ready — why the button is disabled. "Copy
  // brief" and "Download PDF" used to sit beside it; both left on 2026-09-23 (owner).
  const nr = document.getElementById("cb-notready");
  if (nr) {
    const left = p.total - p.ready;
    nr.hidden = !(p.total && (left || !p.ready));
    nr.textContent = !p.ready
      ? "Send to creators and Download PDF unlock once a format is ready."
      : `A send or the PDF carries only the ${cbPlural(p.ready, "ready format", "ready formats")} — ${left} still generating or failed.`;
  }
  cbPaintLane(id);
}

/** "Why is nothing happening?" Only asked when something has sat queued for
    more than 2 minutes with nothing running. No spend cap exists (owner,
    2026-09-14), so the only reasons are a missing table or no/stale worker. */
function cbPaintLane(id) {
  const el = document.getElementById("cb-lane");
  const rec = CB_CACHE.get(id);
  if (!el || !rec) return;
  const now = Date.now();
  const running = rec.formats.some((f) => f.status === "running");
  const stuck = !running && rec.formats.some((f) => f.status === "queued"
    && !(f.retry_at && new Date(f.retry_at).getTime() > now)
    && now - new Date(f.updated_at || 0).getTime() > 120000);
  if (!stuck) { el.hidden = true; return; }
  if (CB_LANE && CB_LANE.at && now - CB_LANE.at < 30000) {
    const v = CB_LANE.value;
    const fresh = v && v.at && now - new Date(v.at).getTime() < 15 * 60000;
    el.textContent = fresh && v.state === "tables_missing"
      ? "The worker can't find the campaign tables — run supabase/campaigns.sql in the Supabase SQL editor."
      : "Waiting for the worker.";
    el.hidden = false;
    return;
  }
  if (CB_LANE?.fetching) return;
  CB_LANE = { value: CB_LANE?.value ?? null, at: 0, fetching: true };
  cbLaneState().then((value) => {
    CB_LANE = { value, at: Date.now(), fetching: false };
    if (CAMPAIGN_VIEW?.id === id) cbPaintLane(id);
  });
}

function cbEditorBusy() {
  if (CB_EDITING.size || CB_REGEN.size || CB_REPLACE.size || CB_FIELD_EDIT) return true;
  if ([...document.querySelectorAll("#cb-add .cb-row-input")].some((i) => i.value.trim())) return true;
  const a = document.activeElement;
  const host = document.getElementById("briefs-host");
  return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && host?.contains(a)) || (!!host && agEditInFlight(host));
}
function cbFlushPending(id) {
  if (CB_PENDING && !cbEditorBusy() && CAMPAIGN_VIEW?.id === id) renderBriefsKeepScroll();
}

function cbClearPollTimer() { clearInterval(CB_POLL_T); CB_POLL_T = null; CB_POLL_ID = null; }
/** Leaving the campaign view: stop the poll and forget per-view editor state. */
function cbStopPoll() {
  cbClearPollTimer();
  CB_EDITING.clear(); CB_REGEN.clear(); CB_REPLACE.clear();
  CB_FIELD_EDIT = null; CB_PENDING = false;
}
function cbEnsurePoll(id) {
  if (CB_POLL_T && CB_POLL_ID === id) return;
  cbClearPollTimer();
  CB_POLL_ID = id;
  CB_POLL_T = setInterval(() => cbPollTick(id), CB_POLL_MS);
}

async function cbPollTick(id) {
  if (CAMPAIGN_VIEW?.id !== id) { cbClearPollTimer(); return; }
  if (document.hidden || document.getElementById("panel-briefs")?.hidden || CB_POLL_BUSY) return;
  const rec = CB_CACHE.get(id);
  if (!rec) return;
  if (cbProgress(rec.formats).working === 0) { cbClearPollTimer(); return; }
  CB_POLL_BUSY = true;
  const before = new Map(rec.formats.map((f) => [f.id, JSON.stringify(f)]));
  const order = cbSorted(rec).map((f) => f.id).join(",");
  let changed = false;
  try { changed = await cbPoll(id); } catch { /* transient — the next tick tries again */ }
  finally { CB_POLL_BUSY = false; }
  if (CAMPAIGN_VIEW?.id !== id) return;
  const cur = CB_CACHE.get(id);
  if (!changed || !cur) { cbPaintLane(id); return; }
  if (cbSorted(cur).map((f) => f.id).join(",") !== order) {
    // A format was added, removed or reordered elsewhere: numbering changes.
    if (cbEditorBusy()) { CB_PENDING = true; cbPaintSummary(id); } else renderBriefsKeepScroll();
    return;
  }
  // Same formats, same order: repaint only the cards that changed. A card with
  // an editor open, a focused field or a playing clip is left alone and caught
  // up once the editor closes.
  for (const f of cur.formats) {
    if (before.get(f.id) === JSON.stringify(f)) continue;
    const card = document.getElementById(`cb-f-${f.id}`);
    const a = document.activeElement;
    const focusedField = card && ((a && card.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))
      || agEditInFlight(card));   // a script line being typed in, or changed and unsaved
    const playing = card && [...card.querySelectorAll("video")].some((vd) => !vd.paused);
    if (CB_EDITING.has(f.id) || CB_REGEN.has(f.id) || CB_REPLACE.has(f.id) || focusedField || playing) {
      CB_PENDING = true;
      continue;
    }
    cbRepaintCard(id, f.id);
  }
  cbPaintSummary(id);
  if (cbProgress(cur.formats).working === 0) cbClearPollTimer();
}

function cbRepaintCard(campaignId, fid, focusSel) {
  const rec = CB_CACHE.get(campaignId);
  const old = document.getElementById(`cb-f-${fid}`);
  if (!rec || !old) { renderBriefsKeepScroll(); return; }
  const formats = cbSorted(rec);
  const i = formats.findIndex((x) => x.id === fid);
  if (i < 0) { renderBriefsKeepScroll(); return; }
  const tpl = document.createElement("template");
  tpl.innerHTML = cbCardHtml(formats[i], i, formats.length).trim();
  const card = tpl.content.firstElementChild;
  old.replaceWith(card);
  cbBindCard(card, campaignId);
  cbWireGrow(card);
  bfRepaint("campaign", campaignId);               // its files-on-beats rows, and the files block's "on … beat" lines
  if (focusSel) (card.querySelector(focusSel) || card).focus();
}

async function cbMove(campaignId, fid, dir) {
  const rec = CB_CACHE.get(campaignId);
  if (!rec) return;
  const formats = cbSorted(rec);
  const i = formats.findIndex((x) => x.id === fid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= formats.length) return;
  const a = formats[i], b = formats[j];
  let pa = a.position ?? i, pb = b.position ?? j;
  if (pa === pb) { pa = i; pb = j; }
  a.position = pb; b.position = pa;
  renderBriefsKeepScroll();
  const card = document.getElementById(`cb-f-${fid}`);
  const want = card?.querySelector(dir < 0 ? ".cb-up" : ".cb-down");
  (want && !want.disabled ? want : card?.querySelector(dir < 0 ? ".cb-down" : ".cb-up") || card)?.focus();
  try {
    await Promise.all([cbPatchFormat(a.id, { position: pb }), cbPatchFormat(b.id, { position: pa })]);
  } catch {
    try { await cbLoadCampaign(campaignId); } catch { /* keep the optimistic order on screen */ }
    if (CAMPAIGN_VIEW?.id !== campaignId) return;
    renderBriefsKeepScroll();
    cbMsg(document.getElementById("cb-view-msg"), "Couldn't save the new order — reloaded the campaign.", "bad", true);
  }
}

/** Merge a request body into the cached format after a successful PATCH. The
    worker-derived aliases (cover/clip/…) go with the source a replace clears. */
function cbMergeLocal(f, body) {
  Object.assign(f, body);
  if ("source" in body && body.source === null) Object.assign(f, { cover: null, clip: null, duration: null, title: "" });
  delete f.source;
}

function cbBindCard(card, campaignId) {
  const fid = card.dataset.fid;
  const get = () => CB_CACHE.get(campaignId)?.formats.find((x) => x.id === fid);
  const fmsg = () => document.getElementById(`cb-fmsg-${fid}`);
  const repaint = (sel) => cbRepaintCard(campaignId, fid, sel);
  const after = () => { cbPaintSummary(campaignId); cbEnsurePoll(campaignId); };

  card.querySelector(".cb-up")?.addEventListener("click", () => cbMove(campaignId, fid, -1));
  card.querySelector(".cb-down")?.addEventListener("click", () => cbMove(campaignId, fid, +1));
  /* A line edited in place is written as `edited.beats` (a hook, CTA or caption as `edited.hook`,
     `.cta`, `.caption`), the same override the format editor saves (cbView lays `edited` over
     `script`), so "Revert to generated" undoes all of it. */
  agWireInlineEdit(card.querySelector(".cb-info"), () => (get() ? {
    pencil: true,
    read: () => { const f = get(); return f ? (cbView(f).beats || []) : null; },
    write: async (beats) => {
      const f = get();
      if (!f) throw new Error("gone");
      const edited = { ...(f.edited || {}), beats };
      await cbPatchFormat(fid, { edited });
      f.edited = edited;
    },
    readTop: (field) => { const f = get(); return f ? String(cbView(f)[field] ?? "") : null; },
    writeTop: async (field, val) => {
      const f = get();
      if (!f) throw new Error("gone");
      const edited = { ...(f.edited || {}), [field]: val };
      await cbPatchFormat(fid, { edited });
      f.edited = edited;
    },
    failText: (ex) => cbErrorSentence(ex, "save"),
    saved: (field) => {
      bfRepaint("campaign", campaignId);           // a reworded beat may now be flagged "beat changed"
      // an untitled format is headed by its hook: keep the head in step without a repaint
      const v = get() && cbView(get());
      const title = card.querySelector(".cb-title");
      if (field === "hook" && v && title) title.textContent = v.title || v.hook || "Untitled format";
      const chips = card.querySelector(".cb-chips");
      if (!chips || [...chips.querySelectorAll(".chip")].some((c) => c.textContent === "edited")) return;
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = "edited";
      chips.prepend(chip);
    },
    repaint: () => repaint(),
  } : null));
  card.querySelector(".cb-edit")?.addEventListener("click", () => {
    CB_REGEN.delete(fid); CB_EDITING.add(fid); repaint('[data-ed="title"]');
  });
  card.querySelector(".cb-regen")?.addEventListener("click", () => {
    if (CB_REGEN.has(fid)) { CB_REGEN.delete(fid); repaint(".cb-regen"); cbFlushPending(campaignId); }
    else { CB_REGEN.add(fid); repaint("[data-regen-note]"); }
  });
  card.querySelector(".cb-regen-cancel")?.addEventListener("click", () => {
    CB_REGEN.delete(fid); repaint(".cb-regen"); cbFlushPending(campaignId);
  });
  card.querySelector(".cb-regen-row")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); CB_REGEN.delete(fid); repaint(".cb-regen"); cbFlushPending(campaignId); }
  });
  card.querySelector(".cb-regen-go")?.addEventListener("click", async (e) => {
    const f = get();
    if (!f) return;
    const body = cbRegenerateBody(f, (card.querySelector("[data-regen-note]")?.value || "").trim());
    e.currentTarget.disabled = true;
    try {
      await cbPatchFormat(fid, body);
      cbMergeLocal(f, body);
      CB_REGEN.delete(fid);
      repaint(".cb-state");
      after();
    } catch (ex) {
      e.target.closest("button").disabled = false;
      cbMsg(fmsg(), cbErrorSentence(ex, "regenerate"), "bad", true);
    }
  });
  card.querySelector(".cb-restore")?.addEventListener("click", async (e) => {
    const f = get();
    if (!f?.script_prev) return;
    const body = cbRestoreBody(f);
    e.currentTarget.disabled = true;
    try {
      await cbPatchFormat(fid, body);
      cbMergeLocal(f, body);
      repaint();
      cbMsg(fmsg(), "Previous version restored — the one it replaced is kept as the new previous.", "good");
    } catch (ex) {
      e.target.closest("button").disabled = false;
      cbMsg(fmsg(), cbErrorSentence(ex, "save"), "bad", true);
    }
  });
  card.querySelector(".cb-retry")?.addEventListener("click", async (e) => {
    const f = get();
    if (!f) return;
    const body = cbRetryBody();
    e.currentTarget.disabled = true;
    try {
      await cbPatchFormat(fid, body);
      cbMergeLocal(f, body);
      repaint();
      after();
    } catch (ex) {
      e.target.closest("button").disabled = false;
      cbMsg(fmsg(), cbErrorSentence(ex, "save"), "bad", true);
    }
  });
  card.querySelector(".cb-replace")?.addEventListener("click", () => {
    if (CB_REPLACE.has(fid)) { CB_REPLACE.delete(fid); repaint(".cb-replace"); cbFlushPending(campaignId); }
    else { CB_REPLACE.add(fid); repaint(".cb-replace-input"); }
  });
  const rform = card.querySelector(".cb-replace-form");
  rform?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); CB_REPLACE.delete(fid); repaint(".cb-replace"); cbFlushPending(campaignId); }
  });
  rform?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rec = CB_CACHE.get(campaignId);
    const f = get();
    if (!rec || !f) return;
    const input = rform.querySelector("input");
    const existing = new Set(rec.formats.filter((x) => x.id !== fid).map((x) => canonUrl(x.source_url)));
    const parsed = cbParseLinks(input.value, existing);
    const refuse = (t) => { cbMsg(fmsg(), t, "bad", true); markInvalid(input, `cb-fmsg-${fid}`); input.focus(); };
    if (!parsed.length) return refuse("Paste a TikTok or Instagram video link.");
    if (parsed.length > 1) return refuse("Paste one link to replace this one.");
    const r = parsed[0];
    if (!r.ok) {
      return refuse(r.why === "youtube" ? "YouTube isn't supported yet."
        : r.why === "duplicate" ? "That video is already in this campaign."
        : r.why === "not supported" ? CB_ERROR_TEXT.off_platform : "That isn't a link.");
    }
    const body = cbReplaceLinkBody(r.url);
    try {
      await cbPatchFormat(fid, body);
      cbMergeLocal(f, body);
      CB_REPLACE.delete(fid);
      repaint(".cb-state");
      after();
    } catch (ex) {
      cbMsg(fmsg(), cbErrorSentence(ex, "save"), "bad", true);
    }
  });
  rform?.querySelector("input")?.addEventListener("input", (e) => clearInvalid(e.target));

  // ---- the format editor ----
  const form = card.querySelector(".cb-editor");
  if (form) {
    const renumber = () => form.querySelectorAll(".cb-beat-n").forEach((s, k) => { s.textContent = String(k + 1); });
    const wireRemove = (fs) => fs.querySelector(".cb-beat-remove").addEventListener("click", () => {
      const next = fs.nextElementSibling || fs.previousElementSibling;
      fs.remove();
      renumber();
      (next?.querySelector("input, textarea") || form.querySelector(".cb-beat-add")).focus();
    });
    form.querySelectorAll(".cb-beat-field").forEach(wireRemove);
    form.querySelector(".cb-beat-add").addEventListener("click", () => {
      const list = form.querySelector(".cb-beat-list");
      const tpl = document.createElement("template");
      tpl.innerHTML = cbBeatFieldHtml({}, list.children.length).trim();
      const fs = tpl.content.firstElementChild;
      list.appendChild(fs);
      wireRemove(fs);
      cbWireGrow(fs);
      fs.querySelector("input").focus();
    });
    const close = (sel) => { CB_EDITING.delete(fid); repaint(sel); cbFlushPending(campaignId); };
    form.querySelector(".cb-ed-cancel").addEventListener("click", () => close(".cb-edit"));
    form.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(".cb-edit"); } });
    form.querySelector(".cb-ed-revert")?.addEventListener("click", async (e) => {
      const f = get();
      if (!f) return;
      e.currentTarget.disabled = true;
      try {
        await cbPatchFormat(fid, { edited: null });
        f.edited = null;
        close(".cb-edit");
        cbMsg(fmsg(), "Back to the generated version.", "good");
      } catch (ex) {
        e.target.closest("button").disabled = false;
        cbMsg(fmsg(), cbErrorSentence(ex, "save"), "bad", true);
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = get();
      if (!f) return;
      const body = cbReadEditor(form);
      // Nothing changed: close without writing, so an unchanged Save does not
      // mark the format "edited".
      const v = cbView(f);
      const same = Object.keys(body.edited).every((k) =>
        JSON.stringify(body.edited[k]) === JSON.stringify(k === "needs" || k === "beats"
          ? (k === "needs" ? (v.needs || []).map((s) => String(s).trim()).filter(Boolean)
            : (v.beats || []).map((b) => ({ t: (b.t || "").trim(), say: (b.say || "").trim(), do: (b.do || "").trim(), show: (b.show || "").trim() }))
              .filter((b) => b.say || b.do || b.show))
          : String(v[k] || "").trim()));
      if (same && body.internal_note === (f.internal_note || "").trim()) { close(".cb-edit"); return; }
      const save = form.querySelector(".cb-ed-save");
      save.disabled = true;
      try {
        await cbPatchFormat(fid, body);
        f.edited = body.edited;
        f.internal_note = body.internal_note;
        close(".cb-edit");
        cbMsg(fmsg(), "Saved.", "good");
      } catch (ex) {
        save.disabled = false;
        cbMsg(fmsg(), cbErrorSentence(ex, "save"), "bad", true);
      }
    });
  }

  const del = card.querySelector(".cb-del");
  if (del) armDelete(del, "Delete", async () => {
    const rec = CB_CACHE.get(campaignId);
    try {
      await cbDeleteFormat(fid);
      if (rec) {
        const order = cbSorted(rec).map((x) => x.id);
        const at = order.indexOf(fid);
        rec.formats = rec.formats.filter((x) => x.id !== fid);
        CB_EDITING.delete(fid); CB_REGEN.delete(fid); CB_REPLACE.delete(fid);
        renderBriefsKeepScroll();
        const nextId = order[at + 1] || order[at - 1];
        (nextId ? document.getElementById(`cb-f-${nextId}`) : document.querySelector("#cb-add .cb-row-input"))?.focus();
        cbMsg(document.getElementById("cb-view-msg"), "Format deleted.", "good");
      }
    } catch (ex) {
      cbMsg(fmsg(), cbErrorSentence(ex, "delete"), "bad", true);
    }
  });
}

function cbBindView(host, client, id) {
  const rec = () => CB_CACHE.get(id);
  const vmsg = () => document.getElementById("cb-view-msg");

  // Rename: pencil -> input; Enter saves, Escape cancels.
  document.getElementById("cb-rename")?.addEventListener("click", () => {
    CB_FIELD_EDIT = { id, field: "name" }; renderBriefsKeepScroll();
  });
  const nameInput = document.getElementById("cb-name-input");
  nameInput?.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      CB_FIELD_EDIT = null; renderBriefsKeepScroll();
      document.getElementById("cb-rename")?.focus();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { cbMsg(vmsg(), "A campaign brief needs a name.", "bad", true); return; }
    nameInput.disabled = true;
    try {
      await cbPatchCampaign(id, { name });
      rec().campaign.name = name;
      const row = CB_LISTS.get(client.id)?.rows?.find((r) => r.id === id);
      if (row) row.name = name;
      CB_FIELD_EDIT = null;
      renderBriefsKeepScroll();
      document.getElementById("cb-rename")?.focus();
      // The name also goes to every creator who already has this brief (agRenameSent). Then the Sent to
      // list is re-read so it does not show the rename as an unsent edit; that repaint waits while an
      // editor is open (cbEditorBusy / CB_PENDING), the same rule the campaign poll keeps.
      agRenameSent("campaign", id, name).then(async ({ renamed, failed }) => {
        if (renamed) await agEnsureSent("campaign", id, null, true);
        if (CAMPAIGN_VIEW?.id !== id) return;
        if (renamed) { if (cbEditorBusy()) CB_PENDING = true; else renderBriefsKeepScroll(); }
        if (failed) {
          cbMsg(vmsg(), "Renamed here, but creators who have this brief still see the old name — press Update under Sent to.", "bad", true);
        } else if (renamed) {
          cbMsg(vmsg(), "Renamed — creators who have this brief see the new name.", "good");
        }
      });
    } catch (ex) {
      nameInput.disabled = false;
      nameInput.focus();
      cbMsg(vmsg(), cbErrorSentence(ex, "save"), "bad", true);
    }
  });

  host.querySelectorAll(".cb-field-edit").forEach((btn) => btn.addEventListener("click", () => {
    CB_FIELD_EDIT = { id, field: btn.dataset.field };
    renderBriefsKeepScroll();
  }));
  host.querySelectorAll(".cb-field-editor").forEach((ed) => {
    const field = ed.dataset.field;
    const cancel = () => {
      CB_FIELD_EDIT = null;
      renderBriefsKeepScroll();
      document.querySelector(`.cb-field-edit[data-field="${field}"]`)?.focus();
      cbFlushPending(id);
    };
    ed.querySelector(".cb-fe-cancel").addEventListener("click", cancel);
    ed.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } });
    ed.querySelector(".cb-fe-save").addEventListener("click", async (e) => {
      const r = rec();
      if (!r) return;
      let fields;
      if (field === "brand") fields = { brand_context: readBrandForm(ed.querySelector(".cb-brand-form"), r.campaign.brand_context || {}) };
      else fields = { [field]: (ed.querySelector("[data-fe]").value || "").trim() };
      e.currentTarget.disabled = true;
      try {
        await cbPatchCampaign(id, fields);
        Object.assign(r.campaign, fields);
        CB_FIELD_EDIT = null;
        renderBriefsKeepScroll();
        document.querySelector(`.cb-field-edit[data-field="${field}"]`)?.focus();
        if (field === "brand") {
          cbMsg(vmsg(), "Brand context saved. It applies to formats generated or regenerated from now on — existing formats keep their text.", "good");
        } else cbMsg(vmsg(), "Saved.", "good");
        cbFlushPending(id);
      } catch (ex) {
        e.target.closest("button").disabled = false;
        cbMsg(vmsg(), cbErrorSentence(ex, "save"), "bad", true);
      }
    });
  });

  document.getElementById("cb-agency")?.addEventListener("toggle", (e) => {
    if (e.target.open) CB_AGENCY_OPEN.add(id); else CB_AGENCY_OPEN.delete(id);
  });

  const delBtn = document.getElementById("cb-del-campaign");
  if (delBtn) armDelete(delBtn, "Delete", async () => {
    try {
      await cbDeleteCampaign(id);
      CB_CACHE.delete(id);
      const e2 = CB_LISTS.get(client.id);
      if (e2?.rows) e2.rows = e2.rows.filter((r) => r.id !== id);
      CAMPAIGN_VIEW = null;
      renderBriefs();
      cbMsg(document.getElementById("cb-msg"), "Campaign brief deleted.", "good");
    } catch (ex) {
      cbMsg(vmsg(), cbErrorSentence(ex, "delete"), "bad", true);
    }
  });

  // ---- Download PDF (back 2026-09-25, owner: "bring back the download as pdf option") ----
  document.getElementById("cb-pdf")?.addEventListener("click", () => cbSavePdf(id, client));

  // ---- add inspiration videos (one row per link) ----
  const addForm = document.getElementById("cb-add");
  const addRows = addForm?.querySelector('[data-rows="add"]');
  const existingCanon = () => new Set((rec()?.formats || []).map((f) => canonUrl(f.source_url)));
  const addGo = document.getElementById("cb-add-go");
  const addCount = document.getElementById("cb-add-count");
  const addCtl = addRows ? cbWireRows(addRows, {
    existing: existingCanon,
    onChange: (parsed) => {
      const { ready, skipped } = cbRowsCount(parsed);
      addGo.disabled = ready === 0;
      addGo.textContent = `Add ${cbPlural(ready, "video", "videos")}`;
      addCount.textContent = ready || skipped ? `${ready} ready` + (skipped ? ` · ${skipped} skipped` : "") : "";
    },
  }) : null;
  if (addCtl) {
    // Typed rows survive this view's own repaints (a reorder, a poll catch-up).
    if (CB_ADD_KEEP?.id === id) addCtl.setValues(CB_ADD_KEEP.values); else addCtl.paint();
    CB_ADD_KEEP = null;
  }
  addForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = rec();
    if (!r || !addCtl) return;
    const parsed = addCtl.parsed();
    const ok = parsed.filter((p) => p.r?.ok);
    const amsg = document.getElementById("cb-add-msg");
    if (!ok.length) {
      const bad = parsed.find((p) => p.r);
      cbMsg(amsg, bad ? cbWhySentence(bad.r.why) : "Paste one or more TikTok or Instagram video links.", "bad", true);
      (bad || parsed[0]).input.focus();
      return;
    }
    const urls = ok.map((p) => p.r.url).slice(0, CB_MAX_FORMATS - r.formats.length);
    const maxPos = r.formats.reduce((m, f) => Math.max(m, f.position ?? 0), -1);
    addGo.disabled = true;
    try {
      await cbAddFormats(id, urls, maxPos + 1);
    } catch (ex) {
      addGo.disabled = false;
      cbMsg(amsg, cbErrorSentence(ex, "add links to"), "bad", true);
      return;
    }
    addCtl.reset();                    // before the repaint, so nothing is carried over
    let note = `Added ${cbPlural(urls.length, "video", "videos")}.`;
    try { await cbLoadCampaign(id); }
    catch { note += " Couldn't refresh the list — reload to see them."; }
    if (CAMPAIGN_VIEW?.id !== id) return;
    renderBriefsKeepScroll();
    cbMsg(document.getElementById("cb-add-msg"), note, "good");
    document.querySelector("#cb-add .cb-row-input")?.focus();
  });
}

// ---------- The format library + copies (plan: ~/.claude/plans/campaign-format-library.md) ----------

/** A library row: light columns only — `source` (the worker's whole read) is never listed. */
const CB_LIB_FMT = "id,campaign_id,position,source_url,cover:source->>cover,platform:source->>platform,"
  + "duration:source->>duration,s_title:script->>title,s_hook:script->>hook,e_title:edited->>title,e_hook:edited->>hook";
/** What a copy reads off its source row: every column a finished format's breakdown lives in. */
const CB_COPY_COLS = "id,campaign_id,position,source_url,job,source,analysis,script,edited,internal_note";

/** The title a format card heads with (cbCardHtml: v.title || v.hook), from the light columns. An edit that
    has the key wins even when it is "" — the same as cbView's spread. */
const cbLibTitle = (f) => (f.e_title ?? f.s_title) || (f.e_hook ?? f.s_hook) || cbShortUrl(f.source_url);
/** Canonical links already in the open brief — the identity cbParseLinks already refuses a duplicate on. */
const cbLibHere = (id) => new Set((CB_CACHE.get(id)?.formats || []).map((f) => canonUrl(f.source_url)));

async function cbLibLoad(clientId, openId) {
  const camps = await sbFetch(`/rest/v1/lynxr_campaigns?client_id=eq.${encodeURIComponent(clientId)}`
    + `&id=neq.${openId}&select=id,name,instructions,internal_notes,created_at&order=created_at.desc`);
  let formats = [], files = [];
  if (camps.length) {
    const ids = camps.map((c) => c.id).join(",");
    formats = await sbFetch(`/rest/v1/lynxr_campaign_formats?campaign_id=in.(${ids})&status=eq.done`
      + `&select=${CB_LIB_FMT}&order=position.asc`);
    // Files are optional here: unreadable (not installed, a blip) just means the groups don't count them.
    files = await sbFetch(`/rest/v1/lynxr_brief_files?source_kind=eq.campaign&source_id=in.(${ids})`
      + `&select=id,source_id,path,name,size,mime,uploaded_at&order=uploaded_at.asc`).catch(() => []);
  }
  const groups = camps.map((c) => ({
    c,
    formats: formats.filter((f) => f.campaign_id === c.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    files: (files || []).filter((f) => f.source_id === c.id),
  })).filter((g) => g.formats.length);
  const rec = { clientId, groups, at: Date.now() };
  CB_LIB.set(openId, rec);
  return rec;
}

/** Load once, reuse for 60s; force=true reloads. Repaints only the library block when it lands. */
function cbLibEnsure(client, id, force) {
  const cur = CB_LIB.get(id);
  if (!force && cur && Date.now() - cur.at < 60000) return;
  if (CB_LIB_LOADING.has(id)) return;
  CB_LIB_LOADING.add(id);
  cbLibLoad(client.id, id)
    .catch((ex) => { CB_LIB.set(id, { error: cbError(ex), at: Date.now() }); })
    .finally(() => { CB_LIB_LOADING.delete(id); if (CAMPAIGN_VIEW?.id === id) cbLibRepaint(client, id); });
}

/** Copies finished formats into campaign `targetId` as READY rows. Nothing is regenerated: each new row is
    born status "done" with the source's link, worker read (`source`), analysis, script, staff edits and
    internal note, so the worker's claim (pipeline/campaign_queue.py: status queued, or running with a stale
    lease) never matches it and no model is called. RESET, not copied: id, campaign_id, position (appended
    from startPos), created_at/updated_at (defaults), attempts 0, phase "", retry_at/claimed_* and error_*
    (column defaults), regen_note "", script_prev null (no "Restore previous version" of another brief's
    history), timings null, finished_at = now. A source that is not "done" any more, or whose link is already
    in the target (`here`), is skipped; `room` caps how many land. Returns { added, pairs, skipped } — added
    are CB_FULL-shaped rows for CB_CACHE, pairs are { from: source row (CB_COPY_COLS), to: added row }. */
async function cbCopyFormats(targetId, ids, { startPos = 0, room = CB_MAX_FORMATS, here = new Set() } = {}) {
  const skipped = { here: 0, full: 0, notReady: 0 };
  if (!ids.length) return { added: [], pairs: [], skipped };
  const src = await sbFetch(`/rest/v1/lynxr_campaign_formats?id=in.(${ids.join(",")})&status=eq.done`
    + `&select=${CB_COPY_COLS}&order=position.asc`);
  skipped.notReady = ids.length - src.length;
  const seen = new Set(here);
  const take = [];
  for (const f of src) {
    const k = canonUrl(f.source_url);
    if (seen.has(k)) { skipped.here++; continue; }
    if (take.length >= room) { skipped.full++; continue; }
    seen.add(k);
    take.push(f);
  }
  if (!take.length) return { added: [], pairs: [], skipped };
  const now = new Date().toISOString();
  const rows = take.map((f, i) => ({
    campaign_id: targetId, position: startPos + i, source_url: f.source_url,
    job: f.job || "script", status: "done", phase: "", attempts: 0,
    source: f.source ?? null, analysis: f.analysis ?? null, script: f.script ?? null,
    edited: f.edited ?? null, internal_note: f.internal_note || "",
    script_prev: null, regen_note: "", finished_at: now,
  }));
  const made = await sbFetch("/rest/v1/lynxr_campaign_formats?select=id,position,created_at,updated_at", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(rows),
  });
  // The cards need CB_FULL's shape. Re-read it; if that read fails the rows DID land, so build the same
  // shape from what was sent rather than report a failure that would invite a duplicate retry.
  let full = null;
  try {
    full = await sbFetch(`/rest/v1/lynxr_campaign_formats?id=in.(${made.map((m) => m.id).join(",")})&select=${CB_FULL}`);
  } catch { full = null; }
  const pairs = [];
  for (const m of made) {
    const i = rows.findIndex((r) => r.position === m.position);
    if (i < 0) continue;
    let to = (full || []).find((x) => x.id === m.id);
    if (!to) {
      const b = rows[i], s = b.source || {};
      to = { ...b, id: m.id, created_at: m.created_at, updated_at: m.updated_at,
        retry_at: null, error_kind: "", error_detail: "", retryable: true,
        cover: s.cover ?? null, clip: s.clip ?? null, platform: s.platform ?? null,
        duration: s.duration ?? null, title: s.meta?.title ?? null };
      delete to.source;                        // CB_CACHE never holds the worker's whole read (see CB_FULL)
    }
    pairs.push({ from: take[i], to });
  }
  return { added: pairs.map((p) => p.to), pairs, skipped };
}

/** Copies brief files onto campaign `targetId`, each as NEW bytes at a NEW path — never a second row on the
    same object: bfRemove deletes the bytes and brief_file_readable() gates a creator's download by path, so a
    shared object would vanish from one brief when removed from the other, and be readable through either.
    Storage copies server-side (POST /storage/v1/object/copy: SELECT on the source object + INSERT on the
    destination — brief_files.sql's "staff or delivered creator read" and "staff upload" policies), so nothing
    is re-uploaded. Never x-upsert (that needs an UPDATE policy staff don't have, and would overwrite). A file
    already on the target with the same name and size is reused, not copied. The per-brief caps are checked
    first (the trigger enforces them anyway). Bytes first, then the row; a failed row insert deletes the new
    bytes — bfUpload's order. Returns { copied, here, failed: [{ name, why }], map: source file id -> target
    row } — the map is what cbCopyPlacements points the copied placements at. */
async function bfCopyFiles(srcFiles, targetId) {
  const kind = "campaign", key = agSentKey(kind, targetId);
  const out = { copied: 0, here: 0, failed: [], map: new Map() };
  if (!srcFiles.length) return out;
  await bfEnsure(kind, targetId, null, true);
  const entry = BF_FILES.get(key);
  if (!entry || entry.error) {
    const why = entry?.error === "missing" ? "attachments aren't installed yet" : "couldn't read this brief's files";
    out.failed = srcFiles.map((f) => ({ name: f.name, why }));
    return out;
  }
  const rows = [...entry.rows];
  const inflight = BF_UP.get(key) || [];
  let count = rows.length + inflight.length;
  let total = rows.reduce((s, r) => s + (Number(r.size) || 0), 0) + inflight.reduce((s, u) => s + u.size, 0);
  for (const f of srcFiles) {
    const same = rows.find((r) => r.name === f.name && Number(r.size) === Number(f.size));
    if (same) { out.here++; out.map.set(f.id, same); continue; }
    if (count + 1 > BF_MAX_COUNT) { out.failed.push({ name: f.name, why: `a brief holds ${BF_MAX_COUNT} files at most` }); continue; }
    if (total + (Number(f.size) || 0) > BF_MAX_TOTAL) { out.failed.push({ name: f.name, why: `this brief's files would pass ${bfSize(BF_MAX_TOTAL)}` }); continue; }
    const path = `${kind}/${bfSafe(String(targetId))}/${bfSafe(newId())}/${bfSafe(String(f.path).split("/").pop())}`;
    try {
      await sbFreshToken();                      // storage answers an expired token with 400, not 401
      await sbFetch("/storage/v1/object/copy", {
        method: "POST", body: JSON.stringify({ bucketId: BF_BUCKET, sourceKey: f.path, destinationKey: path }),
      });
      let made;
      try {
        made = await sbFetch("/rest/v1/lynxr_brief_files?select=id,path,name,size,mime,uploaded_at", {
          method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify({ source_kind: kind, source_id: String(targetId), path,
            name: f.name, size: f.size, mime: f.mime || "" }),
        });
      } catch (ex) {
        sbDeleteFile(BF_BUCKET, path).catch(() => {});   // no row will ever point at these bytes
        throw ex;
      }
      const row = made[0];
      rows.push(row); count += 1; total += Number(f.size) || 0;
      out.copied += 1; out.map.set(f.id, row);
    } catch (ex) {
      out.failed.push({ name: f.name, why: bfErrorSentence(ex, "copy") });
    }
  }
  await bfEnsure(kind, targetId, null, true);
  bfRepaint(kind, targetId);                     // the files block + beat rows, and only if on screen
  return out;
}

/** "Add all": fill THIS brief's campaign requirements and internal notes from the source brief's — only where
    this brief's are empty, and never under that field's open editor. brand_context is never copied here.
    Returns "req" (requirements copied), "notes" (only notes), or false. */
async function cbFillBriefFields(id, src) {
  const rec = CB_CACHE.get(id);
  if (!rec) return false;
  const fe = CB_FIELD_EDIT?.id === id ? CB_FIELD_EDIT.field : null;
  const empty = (s) => !String(s || "").trim();
  const fields = {};
  if (fe !== "instructions" && empty(rec.campaign.instructions) && !empty(src.instructions)) fields.instructions = src.instructions;
  if (fe !== "internal_notes" && empty(rec.campaign.internal_notes) && !empty(src.internal_notes)) fields.internal_notes = src.internal_notes;
  if (!Object.keys(fields).length) return false;
  try { await cbPatchCampaign(id, fields); } catch { return false; }
  Object.assign(rec.campaign, fields);
  // In place, so an open editor elsewhere on the page keeps its text; the catch-up repaint draws the same.
  if (fields.instructions) {
    const p = document.querySelector('section[aria-labelledby="cb-req-h"] > p');
    if (p) {
      const n = document.createElement("p");
      n.className = "cb-instructions";
      n.textContent = fields.instructions;
      p.replaceWith(n);
    }
  }
  return fields.instructions ? "req" : "notes";
}

function cbLibHtml(client, id) {
  const lib = CB_LIB.get(id);
  const rec = CB_CACHE.get(id);
  const count = rec?.formats.length || 0;
  const open = CB_LIB_OPEN.has(id) ? CB_LIB_OPEN.get(id) : count < 3;
  const wrap = (sum, inner) => `<details class="cb-block cb-lib" id="cb-lib"${open ? " open" : ""}>
    <summary><span class="cb-block-title" id="cb-lib-h">Format library</span>${sum ? `<span class="lbl cb-lib-sum">${sum}</span>` : ""}</summary>
    <div class="cb-lib-body">${inner}
      <p class="bp-msg cb-msg" id="cb-lib-msg" role="status" aria-live="polite"></p></div>
  </details>`;
  const legacy = (client.briefs || []).length
    ? `<p class="note cb-lib-legacy">Picked-video briefs aren't listed — they have no stored breakdown to copy.</p>` : "";
  if (!lib) return wrap("", `<p class="note">Loading the library…</p>`);
  if (lib.error) {
    return wrap("", `<p class="note">${lib.error === "denied" ? "This account can't read campaign briefs."
      : `Couldn't load the library. <button type="button" class="ghost cb-small" id="cb-lib-retry">Try again</button>`}</p>`);
  }
  const total = lib.groups.reduce((n, g) => n + g.formats.length, 0);
  if (!total) {
    return wrap("", `<p class="note">No other <span class="cb-name">${escapeHtml(client.company)}</span> brief has a ready format yet. This brief's formats show up here in the next one.</p>${legacy}`);
  }
  const here = cbLibHere(id);
  const room = CB_MAX_FORMATS - count;
  const off = CB_LIB_BUSY || room <= 0;
  const q = (CB_LIB_Q.get(id) || "").trim().toLowerCase();
  if (!CB_LIB_GROUPS.has(id)) CB_LIB_GROUPS.set(id, new Set([lib.groups[0].c.id]));
  const shown = CB_LIB_GROUPS.get(id);
  const groups = lib.groups.map((g) => {
    let hits = 0, todo = 0;
    const rows = g.formats.map((f) => {
      const title = cbLibTitle(f);
      const key = `${title} ${f.source_url || ""}`.toLowerCase();
      const hit = !q || key.includes(q);
      if (hit) hits++;
      const inHere = here.has(canonUrl(f.source_url));
      if (!inHere) todo++;
      const cover = f.cover ? safeUrl(f.cover) : "";
      const plat = platformOf(f.source_url || "") || (f.platform ? String(f.platform) : "video");
      const dur = Number(f.duration) > 0 ? ` · ${Math.round(Number(f.duration))}s` : "";
      return `<li class="cb-lib-row" data-fid="${escapeHtml(f.id)}" data-q="${escapeHtml(key)}"${hit ? "" : " hidden"}>
        ${cover ? `<img class="cb-lib-thumb" src="${escapeHtml(cover)}" alt="" loading="lazy">` : `<span class="cb-lib-thumb" aria-hidden="true"></span>`}
        <span class="cb-lib-text"><span class="cb-lib-title cb-title">${escapeHtml(title)}</span><span class="lbl">${escapeHtml(plat)}${dur}</span></span>
        ${inHere ? `<span class="chip cb-lib-here">In this brief</span>`
          : `<button type="button" class="ghost cb-small cb-lib-add" data-fid="${escapeHtml(f.id)}" data-group="${escapeHtml(g.c.id)}"
              aria-label="Add ${escapeHtml(title)} to this brief"${off ? " disabled" : ""}>Add</button>`}
      </li>`;
    }).join("");
    const meta = [String(g.c.created_at || "").slice(0, 10), cbPlural(g.formats.length, "format", "formats")];
    if (g.files.length) meta.push(cbPlural(g.files.length, "file", "files"));
    const isOpen = q ? hits > 0 : shown.has(g.c.id);
    return `<details class="cb-lib-group" data-group="${escapeHtml(g.c.id)}"${isOpen ? " open" : ""}${hits ? "" : " hidden"}>
      <summary><span class="cb-lib-gname cb-name">${escapeHtml(g.c.name || "Untitled brief")}</span> <span class="lbl">${escapeHtml(meta.join(" · "))}</span></summary>
      <div class="cb-lib-gact">
        ${g.files.length ? `<span class="lbl">Add all brings its ${cbPlural(g.files.length, "file", "files")} too.</span>` : ""}
        <button type="button" class="ghost cb-small cb-lib-all" data-group="${escapeHtml(g.c.id)}"
          title="Adds every format not in this brief, plus its files. Fills this brief's requirements only if they're empty."${off || !todo ? " disabled" : ""}>${todo ? `Add all ${todo}` : "All in this brief"}</button>
      </div>
      <ul class="cb-lib-list">${rows}</ul>
    </details>`;
  }).join("");
  const full = room <= 0
    ? `<p class="note cb-lib-full">This brief holds the maximum of ${CB_MAX_FORMATS} formats. Delete one to add from the library.</p>` : "";
  const find = total > CB_LIB_FILTER_AT
    ? `<label class="ce-field cb-lib-find"><span class="sr-only">Filter the library</span><input type="search" id="cb-lib-q"
        value="${escapeHtml(CB_LIB_Q.get(id) || "")}" placeholder="Filter by title or link" autocomplete="off" spellcheck="false"></label>` : "";
  return wrap(`${cbPlural(total, "format", "formats")} from ${cbPlural(lib.groups.length, "other brief", "other briefs")} · added as copies, nothing regenerated`,
    `${full}${find}${groups}${legacy}`);
}

/** Redraws the library block and nothing else — the bfRepaint pattern. Keeps a focused filter focused. */
function cbLibRepaint(client, id) {
  const cur = document.getElementById("cb-lib");
  if (!cur || CAMPAIGN_VIEW?.id !== id) return;
  const typing = document.activeElement?.id === "cb-lib-q";
  const tpl = document.createElement("template");
  tpl.innerHTML = cbLibHtml(client, id).trim();
  const next = tpl.content.firstElementChild;
  if (!next) return;
  cur.replaceWith(next);
  cbLibWire(next, client, id);
  if (typing) {
    const q = next.querySelector("#cb-lib-q");
    q?.focus({ preventScroll: true });
    q?.setSelectionRange?.(q.value.length, q.value.length);
  }
}

/** Filtering hides rows and groups in place — typing never repaints anything. */
function cbLibFilter(box, id) {
  const q = (CB_LIB_Q.get(id) || "").trim().toLowerCase();
  const shown = CB_LIB_GROUPS.get(id) || new Set();
  box.querySelectorAll(".cb-lib-group").forEach((g) => {
    let hits = 0;
    g.querySelectorAll(".cb-lib-row").forEach((r) => {
      const hit = !q || r.dataset.q.includes(q);
      r.hidden = !hit;
      if (hit) hits++;
    });
    g.hidden = hits === 0;
    g.open = q ? hits > 0 : shown.has(g.dataset.group);
  });
}

function cbLibWire(box, client, id) {
  box.addEventListener("toggle", () => CB_LIB_OPEN.set(id, box.open));   // "toggle" does not bubble
  box.querySelectorAll(".cb-lib-group").forEach((g) => g.addEventListener("toggle", () => {
    if ((CB_LIB_Q.get(id) || "").trim()) return;   // a filter opens and shuts groups itself — not a choice to keep
    const s = CB_LIB_GROUPS.get(id) || new Set();
    if (g.open) s.add(g.dataset.group); else s.delete(g.dataset.group);
    CB_LIB_GROUPS.set(id, s);
  }));
  box.querySelector("#cb-lib-retry")?.addEventListener("click", () => {
    CB_LIB.delete(id);
    cbLibRepaint(client, id);                        // "Loading the library…"
    cbLibEnsure(client, id, true);
  });
  const q = box.querySelector("#cb-lib-q");
  q?.addEventListener("input", () => { CB_LIB_Q.set(id, q.value); cbLibFilter(box, id); });
  box.querySelectorAll(".cb-lib-add").forEach((b) => b.addEventListener("click", () =>
    cbLibAdd(client, id, [b.dataset.fid], b.dataset.group, "one")));
  box.querySelectorAll(".cb-lib-all").forEach((b) => b.addEventListener("click", () => {
    const g = CB_LIB.get(id)?.groups?.find((x) => x.c.id === b.dataset.group);
    if (g) cbLibAdd(client, id, g.formats.map((f) => f.id), g.c.id, "all");
  }));
}

/** After an add the pressed button is gone: move to the next Add in that group, else the group, else the
    library — unless the user has already put focus somewhere else. */
function cbLibFocusAfter(groupId, fid) {
  const box = document.getElementById("cb-lib");
  const a = document.activeElement;
  if (!box || (a && a !== document.body && !box.contains(a))) return;
  const g = [...box.querySelectorAll(".cb-lib-group")].find((x) => x.dataset.group === groupId);
  const rows = g ? [...g.querySelectorAll(".cb-lib-row:not([hidden])")] : [];
  const at = fid ? rows.findIndex((r) => r.dataset.fid === fid) : -1;
  const order = at >= 0 ? [...rows.slice(at + 1), ...rows.slice(0, at)] : rows;
  const next = order.map((r) => r.querySelector(".cb-lib-add:not([disabled])")).find(Boolean);
  (next || g?.querySelector("summary") || box.querySelector("summary"))?.focus({ preventScroll: true });
}

/** Called by renderCampaignView after every full render. */
function cbLibWireView(host, client, id) {
  const box = document.getElementById("cb-lib");
  if (box) cbLibWire(box, client, id);
  document.getElementById("cb-copy-new")?.addEventListener("click", () => cbCopyToNewBrief(client, id));
  cbLibEnsure(client, id);
}

/** Appends new format cards to #cb-grid without touching any other card. */
function cbAppendCards(id, newIds) {
  const rec = CB_CACHE.get(id);
  const grid = document.getElementById("cb-grid");
  if (!rec || !grid) return;
  grid.querySelector(":scope > .empty")?.remove();
  const before = [...grid.querySelectorAll(":scope > .cb-format")];
  const prevLast = before[before.length - 1];
  const formats = cbSorted(rec);
  for (const fid of newIds) {
    const i = formats.findIndex((f) => f.id === fid);
    if (i < 0 || document.getElementById(`cb-f-${fid}`)) continue;
    const tpl = document.createElement("template");
    tpl.innerHTML = cbCardHtml(formats[i], i, formats.length).trim();
    const card = tpl.content.firstElementChild;
    grid.append(card);
    cbBindCard(card, id);
    cbWireGrow(card);
  }
  // The card that was last can move down now (its edit form keeps the arrow off — cbCardHtml).
  const down = prevLast?.querySelector(".cb-down");
  if (down && !CB_EDITING.has(prevLast.dataset.fid)) down.disabled = false;
}

function cbLibAfterAdd(client, id, newIds) {
  if (newIds.length) {
    cbAppendCards(id, newIds);
    bfRepaint("campaign", id);         // the new cards' beat-file rows (bfbPaint) and the files block's "on … beat" lines
  }
  cbPaintSummary(id);
  cbLibRepaint(client, id);
  if (!newIds.length) return;
  CB_PENDING = true;   // the add box's numbering and "up to N more" catch up in one full repaint…
  const playing = [...document.querySelectorAll("#cb-grid video")].some((v) => !v.paused);
  if (!playing) cbFlushPending(id);   // …now if nothing is open, else when the open editor closes
}

const CB_PLACES_LOST = "Couldn't copy which beats its files sit on — put them back with + Add file under each beat.";

function cbLibResult({ mode, title, from, n, files, req, skipped, placesLost }) {
  const bits = [];
  if (!n && !files.copied && !req) {
    bits.push(skipped.full ? `This brief holds ${CB_MAX_FORMATS} formats — delete one to add another.`
      : "Nothing to add — it's all in this brief already.");
  } else if (mode === "one" && n === 1) {
    bits.push(`Added “${title}”${files.copied ? ` with ${cbPlural(files.copied, "file", "files")}` : ""} — ready, nothing regenerated.`);
  } else {
    bits.push(`Added ${cbPlural(n, "format", "formats")}${files.copied ? ` and ${cbPlural(files.copied, "file", "files")}` : ""}`
      + ` from ${from}${req === "req" ? ", plus its campaign requirements" : ""} — ready, nothing regenerated.`);
  }
  if (n && skipped.full) bits.push(`${cbPlural(skipped.full, "format", "formats")} didn't fit — a brief holds ${CB_MAX_FORMATS}.`);
  if (skipped.notReady) bits.push(`${cbPlural(skipped.notReady, "format isn't", "formats aren't")} ready any more — skipped.`);
  if (files.failed.length) bits.push(`Not copied: ${files.failed.map((x) => `${x.name} (${x.why})`).join("; ")}.`);
  if (placesLost) bits.push(CB_PLACES_LOST);
  const bad = files.failed.length > 0 || skipped.full > 0 || !!placesLost || (!n && !files.copied && !req);
  return { text: bits.join(" "), tone: bad ? "bad" : "good", sticky: bad };
}

/** mode "one": fids = [one source format]; mode "all": every format of that source brief. Order: formats,
    then files, then placements (they need both the new format ids and the target's file rows). */
async function cbLibAdd(client, id, fids, groupId, mode) {
  const rec = CB_CACHE.get(id);
  const g = CB_LIB.get(id)?.groups?.find((x) => x.c.id === groupId);
  if (!rec || !g || CB_LIB_BUSY || !fids.length) return;
  const room = CB_MAX_FORMATS - rec.formats.length;
  if (room <= 0) {
    cbMsg(document.getElementById("cb-lib-msg"), `This brief holds ${CB_MAX_FORMATS} formats — delete one to add another.`, "bad", true);
    return;
  }
  const title = cbLibTitle(g.formats.find((f) => f.id === fids[0]) || {});
  CB_LIB_BUSY = true;
  cbLibRepaint(client, id);                          // every Add disabled while this runs
  let out = null;                                    // said AFTER the last repaint (a repaint rebuilds #cb-lib-msg)
  let newIds = [];
  try {
    const startPos = rec.formats.reduce((m, f) => Math.max(m, f.position ?? 0), -1) + 1;
    let res;
    try {
      res = await cbCopyFormats(id, fids, { startPos, room, here: cbLibHere(id) });
    } catch (ex) {
      out = { text: cbErrorSentence(ex, "copy formats into"), tone: "bad", sticky: true };
      return;
    }
    // The formats are in: cache first, so they show whatever happens to the files.
    const cur = CB_CACHE.get(id);
    if (cur) for (const f of res.added) if (!cur.formats.some((x) => x.id === f.id)) cur.formats.push(f);
    newIds = res.added.map((f) => f.id);
    const places = g.files.length ? await cbSourcePlaces(g.files) : { rows: [], skip: null };
    const srcFiles = mode === "all" ? g.files : cbPlacedFiles(g.files, places, res.pairs.map((p) => p.from.id));
    let files = { copied: 0, here: 0, failed: [], map: new Map() };
    if (srcFiles.length) files = await bfCopyFiles(srcFiles, id);
    const placed = await cbCopyPlacements(res.pairs, files.map, id, places);
    const req = mode === "all" ? await cbFillBriefFields(id, g.c) : false;
    out = cbLibResult({ mode, title, from: g.c.name || "Untitled brief", n: res.added.length, files, req,
      skipped: res.skipped, placesLost: places.skip === "error" || placed.failed });
  } finally {
    CB_LIB_BUSY = false;
    for (const k of [...CB_LIB.keys()]) if (k !== id) CB_LIB.delete(k);   // other briefs' libraries now count stale
    CB_LISTS.delete(client.id);                                          // the client page's per-brief counts too
    if (CAMPAIGN_VIEW?.id === id) {
      cbLibAfterAdd(client, id, newIds);
      if (out) cbMsg(document.getElementById("cb-lib-msg"), out.text, out.tone, out.sticky);
      cbLibFocusAfter(groupId, mode === "one" ? fids[0] : null);
    }
  }
}

/** One click: a new campaign brief for the same client, pre-filled from this one — every READY format as a
    ready copy, every file as new bytes, every placement on the copied formats, and the requirements,
    internal notes and brand context — then open it. Names it with the next free number ("Week 1" ->
    "Week 2"), else "Brief N". */
async function cbCopyToNewBrief(client, id) {
  const rec = CB_CACHE.get(id);
  const vmsg = () => document.getElementById("cb-view-msg");
  if (!rec || CB_COPYING) return;
  if (cbEditorBusy()) { cbMsg(vmsg(), "Save or cancel the open edit first — the copy takes what's saved.", "bad", true); return; }
  const ready = cbSorted(rec).filter((f) => f.status === "done").map((f) => f.id);
  if (!ready.length) { cbMsg(vmsg(), "No format is ready yet.", "bad", true); return; }
  CB_COPYING = true;
  const btn = document.getElementById("cb-copy-new");
  const face = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Copying…"; }
  const fail = (text) => {
    CB_COPYING = false;
    if (btn?.isConnected) { btn.disabled = false; btn.textContent = face; }
    cbMsg(vmsg(), text, "bad", true);
  };
  const src = rec.campaign;
  if (!CB_LISTS.get(client.id)?.rows) await cbListCampaigns(client.id).catch(() => {});
  const names = new Set((CB_LISTS.get(client.id)?.rows || []).map((r) => r.name));
  let name = cbNextBriefName(client);
  const m = /^(.*?)(\d+)\s*$/.exec(src.name || "");
  if (m) { let k = Number(m[2]) + 1; while (names.has(`${m[1]}${k}`)) k++; name = `${m[1]}${k}`; }
  let nid;
  try {
    const made = await sbFetch("/rest/v1/lynxr_campaigns?select=id", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ client_id: client.id, name, instructions: src.instructions || "",
        internal_notes: src.internal_notes || "", brand_context: src.brand_context || {}, created_by: SB_EMAIL || "" }),
    });
    nid = made[0].id;
  } catch (ex) { fail(cbErrorSentence(ex, "create")); return; }
  let res;
  try {
    res = await cbCopyFormats(nid, ready, { startPos: 0, room: CB_MAX_FORMATS, here: new Set() });
  } catch (ex) {
    await cbDeleteCampaign(nid).catch(() => {});   // never leave an empty half-made brief behind
    fail(cbErrorSentence(ex, "copy formats into"));
    return;
  }
  await bfEnsure("campaign", id, null, true);
  const srcFiles = BF_FILES.get(agSentKey("campaign", id))?.rows || [];
  const places = srcFiles.length ? await cbSourcePlaces(srcFiles) : { rows: [], skip: null };
  const files = await bfCopyFiles(srcFiles, nid);
  const placed = await cbCopyPlacements(res.pairs, files.map, nid, places);
  await cbLoadCampaign(nid).catch(() => {});        // open on real rows; renderCampaignView loads it if this failed
  await agEnsureSent("campaign", nid);              // pre-warm AG_SENT: renderCampaignView's own call would
                                                      // otherwise still be in flight on a brand-new id and its
                                                      // completion would renderBriefsKeepScroll() over this
                                                      // function's own result message below
  CB_COPYING = false;
  CB_LISTS.delete(client.id);
  CB_LIB.clear();
  CAMPAIGN_VIEW = { id: nid }; BRIEF_VIEW = null;
  renderBriefs();
  window.scrollTo({ top: 0 });
  const left = rec.formats.length - res.added.length;
  const lost = places.skip === "error" || placed.failed;
  const bits = [`${name} is ready — copied from ${src.name || "Untitled brief"}: ${cbPlural(res.added.length, "format", "formats")}`
    + `${files.copied ? `, ${cbPlural(files.copied, "file", "files")}` : ""}`
    + `${String(src.instructions || "").trim() ? " and the campaign requirements" : ""}. Nothing was regenerated.`];
  if (left) bits.push(`${cbPlural(left, "format", "formats")} still generating or failed — not copied.`);
  if (files.failed.length) bits.push(`Not copied: ${files.failed.map((x) => `${x.name} (${x.why})`).join("; ")}.`);
  if (lost) bits.push(CB_PLACES_LOST);
  const bad = files.failed.length > 0 || lost;
  cbMsg(document.getElementById("cb-view-msg"), bits.join(" "), bad ? "bad" : "good", bad);
}

/** Where the SOURCE brief's files sit on beats: rows of lynxr_brief_file_beats (supabase/brief_file_beats.sql,
    ~/.claude/plans/brief-files-at-beats.md), read by file id — the same query bfPlacesEnsure makes, but for a
    brief that may not be on screen. { rows, skip }: skip "missing" = that SQL isn't run yet, so copies carry no
    placements and say nothing about it; skip "error" = couldn't read them, and the result message says so. */
async function cbSourcePlaces(srcFiles) {
  const ids = srcFiles.map((f) => f.id).filter(Boolean);
  if (!ids.length) return { rows: [], skip: null };
  try {
    const rows = await sbFetch(`/rest/v1/lynxr_brief_file_beats?file_id=in.(${ids.map(encodeURIComponent).join(",")})`
      + `&select=id,file_id,format_id,beat,sigs&order=placed_at.asc`);
    return { rows: Array.isArray(rows) ? rows : [], skip: null };
  } catch (ex) {
    return { rows: [], skip: cbError(ex) === "missing" ? "missing" : "error" };
  }
}

/** The files a single Add carries: those placed on a beat of one of these source formats. Without placements
    (not installed, unreadable, none) nothing ties a file to a format, so a single Add carries none. */
function cbPlacedFiles(srcFiles, places, fromIds) {
  const want = new Set(fromIds.map(String));
  const ids = new Set(places.rows.filter((p) => want.has(String(p.format_id))).map((p) => p.file_id));
  return srcFiles.filter((f) => ids.has(f.id));
}

/** Re-creates the source's placements on the copies: target file row, new format id, SAME beat index, SAME
    fingerprints. The beats were copied word for word, so each file lands on the same beat — and a placement
    that was "beat changed" on the source stays flagged on the copy, exactly as it was. A placement whose file
    didn't copy is dropped (that file is named in the result). The new rows join the target's cached
    placements, then bfRepaint redraws the files block and the rows under the beats — never the viewer.
    Returns { copied, failed }. */
async function cbCopyPlacements(pairs, fileMap, targetId, places) {
  const out = { copied: 0, failed: false };
  if (!places || places.skip || !places.rows.length || !pairs.length) return out;
  const toOf = new Map(pairs.map((p) => [String(p.from.id), String(p.to.id)]));
  const body = [];
  for (const p of places.rows) {
    const formatId = toOf.get(String(p.format_id));
    const file = fileMap.get(p.file_id);
    if (!formatId || !file) continue;
    body.push({ file_id: file.id, format_id: formatId, beat: Number(p.beat) || 0, sigs: Array.isArray(p.sigs) ? p.sigs : [] });
  }
  if (!body.length) return out;
  const key = agSentKey("campaign", targetId);
  try {
    const rows = await sbFetch("/rest/v1/lynxr_brief_file_beats?select=id,file_id,format_id,beat,sigs", {
      method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(body),
    });
    out.copied = Array.isArray(rows) ? rows.length : 0;
    const pl = BF_PLACES.get(key);
    if (pl && !pl.error && Array.isArray(rows)) pl.rows.push(...rows);
    else await bfPlacesEnsure("campaign", targetId, null, true);   // not loaded yet (a brand-new brief): read them
  } catch {
    out.failed = true;
  }
  bfRepaint("campaign", targetId);
  return out;
}

// ---------- Download PDF ----------
// "Copy brief" and "Download PDF" left the campaign view on 2026-09-23 (owner: "remove this" —
// both). Download PDF came BACK on 2026-09-25 (owner: "bring back the download as pdf option"),
// restored exactly as it was before commit 5cc5260; Copy brief stays gone, so campaignDocText
// (above) is still unreferenced. The PDF prints campaignDocHtml: done formats only, never an
// agency-only field.

/** "<campaign name> — brief", minus anything a filesystem refuses
    (\\ / : * ? " < > | and control characters) and trailing dots/spaces. */
function cbPdfTitle(name) {
  const clean = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 120).trim();
  return `${clean || "Campaign"} — brief`;
}

/** Print only the creator document: a detached #cb-print node plus
    body.cb-printing, which the @media print rules in app.css ("Download PDF") use
    to hide everything else. Cleaned up on afterprint. */
function cbSavePdf(id, client) {
  const rec = CB_CACHE.get(id);
  if (!rec) return;
  document.getElementById("cb-print")?.remove();
  const node = document.createElement("div");
  node.id = "cb-print";
  node.innerHTML = campaignDocHtml(rec.campaign, cbSorted(rec), client);
  document.body.appendChild(node);
  document.body.classList.add("cb-printing");
  const oldTitle = document.title;
  // Chrome's Save as PDF takes its default filename from the title.
  document.title = cbPdfTitle(rec.campaign.name);
  window.addEventListener("afterprint", () => {
    node.remove();
    document.body.classList.remove("cb-printing");
    document.title = oldTitle;
  }, { once: true });
  window.print();
}

// ---------- Ops ----------
/* IS ANYTHING LATE, IS ANYTHING BROKEN, WHAT IS IT COSTING.

   Two reads, both plain PostgREST selects behind is_staff():
     lynxr_ops    — the watchdog's alarm latch, its heartbeats, and the
                    ops.snapshot row it writes at the end of every completed
                    check. `staff read ops` is applied (supabase/ops_table.sql).
     lynxr_costs  — one row per model per pass, written by
                    process_adaptations.record_cost(). `staff read costs` comes
                    from supabase/costs_table.sql, an owner action.

   NO CREATOR DATA IS READ HERE AT ALL, which is why this needs none of the
   security definer machinery supabase/usage_overview.sql needs.

   READ-ONLY, and not merely by convention: neither table has an insert, update
   or delete policy. Do not add a clear-alarm or retry button — the watchdog
   owns alarm state, and two systems deciding what "open" means is how a
   dashboard starts lying. */
let OPS = null;             // { ops: {key: {value, updated_at}}, costs: [...] }
let OPS_STATE = "idle";     // idle | loading | ready | error
let OPS_ERR = "";
let OPS_AT = 0;             // when the current OPS was fetched
const OPS_STALE_MS = 60_000;
const OPS_COST_DAYS = 30;
const OPS_SPEND_DAYS = 14;

async function fetchOps() {
  OPS_STATE = "loading";
  renderOps();
  try {
    const since = new Date(Date.now() - OPS_COST_DAYS * 86400000).toISOString();
    const [opsRows, costRows] = await Promise.all([
      // The whole table: heartbeats, digest.last, ops.snapshot, cost.apify and
      // one row per open alarm. Under a dozen rows by construction.
      sbFetch("/rest/v1/lynxr_ops?select=key,value,updated_at"),
      sbFetch("/rest/v1/lynxr_costs?select=at,model,usd,ok,price_rev"
        + `&at=gte.${encodeURIComponent(since)}&order=at.desc&limit=5000`),
    ]);
    const byKey = {};
    for (const r of opsRows || []) byKey[r.key] = { value: r.value || {}, updated_at: r.updated_at };
    OPS = { ops: byKey, costs: costRows || [] };
    OPS_AT = Date.now();
    OPS_STATE = "ready";
  } catch (ex) {
    OPS = null;
    OPS_ERR = (ex && ex.message) || "";
    OPS_STATE = "error";
  }
  renderOps();
}

function ensureOps() {
  if (OPS_STATE === "loading") return;
  if (OPS_STATE === "idle" || Date.now() - OPS_AT > OPS_STALE_MS) fetchOps();
}

function initOpsUi() {
  // Two buttons, one handler. The section Refresh below is unchanged; the hero
  // needs its own because it is now the only thing on screen and a first screen
  // you cannot re-read is a worse dashboard than a duplicated control.
  document.getElementById("ops-refresh")?.addEventListener("click", fetchOps);
  document.getElementById("ops-hero-refresh")?.addEventListener("click", fetchOps);
}

/** Three causes, three different fixes, and "no data" is none of them — that
    case (an empty lynxr_ops, or an empty lynxr_costs beside a non-empty
    lynxr_ops) is handled where the data is read, not here, because "no rows"
    reads as a genuinely different situation from each of the three below. */
function opsErrorKind(m) {
  if (/PGRST205|Could not find the table|schema cache/i.test(m)) {
    return {
      title: "The cost table is not installed.",
      fix: "Run supabase/costs_table.sql in the Supabase SQL editor, then reload.",
      fixHtml: `Run <code>supabase/costs_table.sql</code> in the Supabase SQL editor,
         then reload.`,
    };
  }
  if (/^401|^403|JWT|not authorized/i.test(m)) {
    return {
      title: "This account is not staff.",
      fix: "lynxr_ops and lynxr_costs are gated on is_staff().",
      fixHtml: `<code>lynxr_ops</code> and <code>lynxr_costs</code> are gated on
         <code>is_staff()</code>.`,
    };
  }
  return {
    title: "Could not load ops.",
    fix: "Check your connection and press Refresh.",
    fixHtml: "Check your connection and press Refresh.",
  };
}

/* One sentence per cause, in two renderings, from ONE decision — because the
   Issues tile on the first screen has to say the same thing as the panel below
   it, and the panel is off-screen when the tile is read. `fix` is the plain
   sentence for the tile; `fixHtml` is the same words with the <code> spans the
   panel has always had. Change a cause here and both move together. */
function opsErrorHtml(m) {
  const k = opsErrorKind(m);
  return `<div class="empty">
    <p><strong>${k.title}</strong></p>
    <p>${k.fixHtml}</p></div>`;
}

/** The state machine. loading/error/ready mirror SOURCES_STATE exactly, for
    the same reason: a look-when-I-want panel has to say plainly which of the
    three it is in, because an empty table and a blocked read look identical
    in the DOM otherwise. */
function renderOps() {
  const alarmsHost = document.getElementById("ops-alarms");
  const at = document.getElementById("ops-at");
  if (!alarmsHost) return;

  // The two hero tiles are painted in EVERY branch, including the two that
  // return early below. They are the whole first screen now, so a branch that
  // left them holding the last good fetch would be exactly the "all good" over
  // a failed query that this panel is built not to say — and worse than before,
  // because the contradiction underneath is off-screen.
  renderOpsHero();

  if (OPS_STATE === "loading") {
    alarmsHost.innerHTML = `<p class="bp-hint">Reading ops…</p>`;
    return;
  }
  if (OPS_STATE === "error" || !OPS) {
    alarmsHost.innerHTML = opsErrorHtml(OPS_ERR);
    // A stale render must never sit above an error — clear every other
    // section rather than leaving whatever the last good fetch painted.
    for (const id of ["ops-late", "ops-running", "ops-stats", "ops-spend", "ops-spend-note", "ops-fixed"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    }
    if (at) at.textContent = "";
    return;
  }

  renderOpsAlarms();
  renderOpsLate();
  renderOpsRunning();
  renderOpsStats();
  renderOpsSpend();
  renderOpsFixed();

  const snapshot = OPS.ops["ops.snapshot"]?.value;
  if (at) at.textContent = snapshot ? agoLabel(snapshot.at) : "never checked";
}

function renderOpsAlarms() {
  const host = document.getElementById("ops-alarms");
  if (!host) return;

  // AN EMPTY lynxr_ops IS ALMOST CERTAINLY THE POLICY, NOT AN EMPTY TABLE —
  // same reasoning as renderSources(). The watchdog has written a heartbeat
  // every minute since day one; a signed-in staff browser getting [] back
  // means supabase/ops_table.sql's staff-read policy probably is not applied.
  if (!Object.keys(OPS.ops).length) {
    host.innerHTML = `<div class="empty">
      <p><strong>No ops data readable.</strong></p>
      <p>If you expected rows, the staff read policy is probably not applied yet:
         run <code>supabase/ops_table.sql</code> in the Supabase SQL editor,
         then reload.</p></div>`;
    return;
  }

  const snapEntry = OPS.ops["ops.snapshot"];
  if (!snapEntry) {
    host.innerHTML = `<div class="empty">
      <p><strong>No check has completed yet.</strong></p>
      <p>The worker has not picked up the deploy that writes
         <code>ops.snapshot</code>. It runs every ~120 seconds once it does.</p></div>`;
    return;
  }
  const snapshot = snapEntry.value || {};
  const alarms = [...(snapshot.alarms || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0));

  // See opsFreshness() for why a fresh heartbeat beside a stale snapshot is not
  // an all-clear. Read from there rather than recomputed, so the Issues tile on
  // the first screen and this panel can never disagree about it.
  const fresh = opsFreshness();
  const freshness = fresh.stale ? `<p class="bp-hint bad">${escapeHtml(fresh.text)}</p>` : "";

  if (!alarms.length) {
    host.innerHTML = freshness + `<p class="bp-hint">Nothing is broken. Last full check
      ${escapeHtml(agoLabel(snapshot.at))} by the ${escapeHtml(snapshot.role || "")} checker.</p>`;
    return;
  }

  const rows = alarms.map((a) => {
    const latch = OPS.ops["alarm." + a.key];
    const openFor = latch
      ? escapeHtml(agoLabel(latch.value?.opened_at))
        + (latch.value?.reminders > 0 ? ` · ${fmt(latch.value.reminders)} reminders` : "")
      : "—";
    return `<tr>
      <td>${escapeHtml(a.key)}<br>${escapeHtml(a.title)}</td>
      <td>${a.page ? `<span class="chip bad">pages</span>` : `<span class="chip">quiet</span>`}
        <span class="chip">p${escapeHtml(String(a.priority))}</span></td>
      <td>${openFor}</td>
      <td class="dim">${escapeHtml(a.body)}</td>
    </tr>`;
  }).join("");

  host.innerHTML = freshness + `<div class="table-wrap"><table>
    <thead><tr><th>alarm</th><th>state</th><th>open for</th><th>detail</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderOpsLate() {
  const host = document.getElementById("ops-late");
  if (!host) return;
  const snapshot = OPS.ops["ops.snapshot"]?.value;
  if (!snapshot) { host.innerHTML = ""; return; }

  // The `inflight:` family is what watchdog.check_all() already decided is
  // late, against INFLIGHT_SLA — read straight off the snapshot, never
  // re-derived, so this can never disagree with the pager.
  const sla = Math.round((snapshot.inflight_sla_s || 0) / 60);
  const inflight = (snapshot.alarms || []).filter((a) => (a.key || "").startsWith("inflight:"));

  if (!inflight.length) {
    host.innerHTML = `<p class="bp-hint">No paste has been in flight longer than ${sla} minutes.</p>`;
    return;
  }
  const many = inflight.find((a) => a.key === "inflight:many");
  if (many) {
    host.innerHTML = `<p class="bp-hint">${escapeHtml(many.title)}</p>`;
    return;
  }
  host.innerHTML = inflight
    .map((a) => `<p class="bp-hint">${escapeHtml(a.key)} · ${escapeHtml(a.body)}</p>`)
    .join("");
}

function renderOpsRunning() {
  const host = document.getElementById("ops-running");
  if (!host) return;
  const now = Date.now();
  const hb = OPS.ops["worker.heartbeat"];
  const fb = OPS.ops["fallback.heartbeat"];
  const snap = OPS.ops["ops.snapshot"];
  const digest = OPS.ops["digest.last"];

  // Budgets read off pipeline/watchdog.py's own thresholds — WORKER_DOWN_MINUTES
  // = 5, FALLBACK_COVER_MINUTES = 15 — so this table can't relabel "fresh"
  // differently from the checker that decides it.
  const rows = [
    ["Fly worker", hb?.updated_at, 5],
    ["GitHub fallback", fb?.updated_at, 15],
    ["Last full check", snap?.value?.at, 10],
  ].map(([what, iso, budgetMin]) => {
    if (!iso) return `<tr><td>${escapeHtml(what)}</td><td class="dim">—</td>
      <td><span class="chip">never seen</span></td></tr>`;
    const ageMin = (now - new Date(iso).getTime()) / 60000;
    const chip = ageMin <= budgetMin ? `<span class="chip good">ok</span>` : `<span class="chip bad">stale</span>`;
    return `<tr><td>${escapeHtml(what)}</td><td>${escapeHtml(agoLabel(iso))}</td><td>${chip}</td></tr>`;
  }).join("");

  // The digest carries a calendar date, not a timestamp — "today or yesterday
  // (UTC)" is fresh, matching the 15:00 UTC cadence.
  const digestDate = digest?.value?.date;
  let digestRow;
  if (!digestDate) {
    digestRow = `<tr><td>Last daily digest</td><td class="dim">—</td>
      <td><span class="chip">never seen</span></td></tr>`;
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
    const fresh = digestDate === today || digestDate === yesterday;
    digestRow = `<tr><td>Last daily digest</td><td>${escapeHtml(digestDate)}</td>
      <td>${fresh ? `<span class="chip good">ok</span>` : `<span class="chip bad">stale</span>`}</td></tr>`;
  }

  host.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>what</th><th>last seen</th><th>state</th></tr></thead>
    <tbody>${rows}${digestRow}</tbody></table></div>`;
}

/** Sums OPS.costs. A row with an EMPTY price_rev is a model with no price on
    file: its usd is a placeholder 0, NOT a measurement of zero, so it is
    counted separately and never added in. Money we did not measure must never
    render as $0 — PRICES' own comment says a stale number "reads as measured
    when it isn't", and an unmeasured one reads worse. */
function opsCostSummary() {
  const rows = OPS.costs || [];
  const byDay = new Map();
  let usd30 = 0, usdFail = 0, unpriced = 0, since = null;
  for (const r of rows) {
    const usd = Number(r.usd) || 0;
    const day = String(r.at || "").slice(0, 10);
    usd30 += usd;
    if (day) byDay.set(day, (byDay.get(day) || 0) + usd);
    if (r.ok === false) usdFail += usd;
    if (r.price_rev === "") unpriced++;
    if (day && (since === null || day < since)) since = day;
  }
  return { usd30, usdFail, passes: rows.length, unpriced, since, byDay };
}

// Matches pipeline/process_adaptations.py's PRICES_REV. NOT derived from the
// rows: an empty lynxr_costs would then render a blank provenance label,
// which is the one thing this panel cannot do. Change both together.
const PRICES_REV_LABEL = "2026-08-12";

/** THE OTHER EMPTY CASE: the read SUCCEEDED and came back with nothing.

    Reaching this branch is itself the proof that lynxr_costs exists and that
    this account can read it — a missing table throws PGRST205 and lands in
    opsErrorKind() instead, which is where the "run supabase/costs_table.sql"
    sentence belongs and where it is correct. Saying it here too cost the owner
    a real evening: he ran the SQL, saw this panel repeat that it might not be
    installed, and concluded the SQL had failed. Never restate a cause the code
    has already disproven by getting this far.

    WHERE THE ACTIVITY LINE COMES FROM, AND WHY NOT FROM THE OBVIOUS PLACE.
    lynxr_script_charges would date the last script exactly, and it is NOT
    readable here: supabase/allowance_ledger.sql gives it no policy for
    `authenticated` at all, service role only. Adding it to fetchOps() would
    return a silent [] from RLS and read as "no script has ever run", which is
    a worse lie than the one being fixed. The watchdog already counts that
    table with the service-role key and publishes the number as
    ops.snapshot.charges_24h, so the line is read from there and dated by the
    snapshot's own timestamp. Do not hard-code a date in here.

    Two renderings from one decision, same contract as opsErrorKind(): `fix` is
    the plain sentence the hero tile shows, `fixHtml` the same words with the
    <code> spans the panel has always had. */
function opsCostEmptyKind() {
  const snap = OPS?.ops?.["ops.snapshot"]?.value;
  const charged = Number(snap?.charges_24h);
  const title = "No cost rows in the last "
    + OPS_COST_DAYS + " days. The table is installed and waiting.";
  const lead = " answered this read, so it exists and this account can see it."
    + " A row is written when the worker finishes a script.";
  const leadTxt = "lynxr_costs" + lead;
  const leadHtml = "<code>lynxr_costs</code>" + lead;

  let when;
  if (!snap || !snap.at) {
    when = " No completed check has been written yet, so there is nothing here to"
      + " date the last script by.";
  } else if (Number.isFinite(charged) && charged > 0) {
    // Reported, not diagnosed. From the browser these two are indistinguishable:
    // a pass that predates the deploy carrying record_cost() legitimately wrote
    // nothing, and a current worker failing to write is a real fault. Naming
    // both is the honest reading; picking one would be the old bug again.
    when = " " + fmt(charged) + " script" + (charged === 1 ? " was" : "s were")
      + " charged in the 24 hours before the last check (" + agoLabel(snap.at)
      + "), and none recorded a cost. A pass that ran before the worker carrying"
      + " record_cost() was deployed writes no row; if it has been deployed"
      + " longer than that, the worker's log will say why.";
  } else {
    when = " No script has been charged in the 24 hours before the last check ("
      + agoLabel(snap.at) + "), so nothing has run for this to record.";
  }
  return { title, fix: leadTxt + when, fixHtml: leadHtml + when };
}

function renderOpsStats() {
  const host = document.getElementById("ops-stats");
  if (!host) return;
  const snapshot = OPS.ops["ops.snapshot"]?.value || {};

  // Ops itself demonstrably answered (renderOpsAlarms already ruled out an
  // unreadable lynxr_ops) and so did lynxr_costs — see opsCostEmptyKind(),
  // which is shared with the hero tile so the two cannot word this two ways.
  if (!(OPS.costs || []).length) {
    const k = opsCostEmptyKind();
    host.innerHTML = `<div class="empty">
      <p><strong>${escapeHtml(k.title)}</strong></p>
      <p>${k.fixHtml}</p></div>`;
    return;
  }

  const { usd30, usdFail, passes } = opsCostSummary();
  const apify = OPS.ops["cost.apify"]?.value;
  const cards = [
    ["Model spend, 30d", usd30, (v) => "$" + Number(v).toFixed(2),
      "measured · list prices " + PRICES_REV_LABEL],
    ["Apify this month", apify ? apify.spent_usd : null,
      apify ? (v) => "$" + Number(v).toFixed(2) : () => "—",
      apify ? "of $" + apify.breaker_usd + " before the breaker" : "meter not configured"],
    ["Scripts charged, 24h", snapshot.charges_24h ?? 0, (v) => fmt(Math.round(v)),
      "cap " + fmt(snapshot.daily_script_cap ?? 0)],
    ["Spent on failures, 30d", usdFail, (v) => "$" + Number(v).toFixed(2),
      `${fmt(passes)} passes recorded`],
  ];
  host.innerHTML = cards.map(([label, , , sub]) => `
    <div class="stat"><div class="label">${escapeHtml(label)}</div><div class="value"></div>
      <div class="sub">${escapeHtml(sub)}</div></div>`).join("");
  host.querySelectorAll(".value").forEach((el, i) =>
    animateCount(el, cards[i][1] ?? NaN, cards[i][2]));
}

function renderOpsSpend() {
  const noteEl = document.getElementById("ops-spend-note");
  const { unpriced, since, byDay } = opsCostSummary();

  // Fourteen UTC days including empty ones — a day with no spend is
  // information, not a gap. renderBars, not a new chart: it already draws
  // through CSSOM (a style="" attribute is silently dropped by the strict CSP,
  // which shipped invisible bar charts here once) and it already has the
  // setTimeout reflow dance that exists because rAF never fires in a hidden tab
  // — and #panel-ops IS hidden until its tab is activated.
  const days = [];
  for (let i = OPS_SPEND_DAYS - 1; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  const pairs = days.map((d) => [d.slice(5), byDay.get(d) || 0]);
  renderBars("ops-spend", pairs, OPS_SPEND_DAYS, null,
             { pct: false, format: (v) => "$" + Number(v).toFixed(2) });

  if (noteEl) {
    let note = `Measuring since ${since || "nothing recorded yet"}.`;
    if (unpriced > 0) {
      note += ` ${fmt(unpriced)} pass${unpriced === 1 ? "" : "es"} ran on a model with no`
        + ` price on file and ${unpriced === 1 ? "is" : "are"} not counted.`;
    }
    noteEl.textContent = note;
  }
}

/* NOT MEASURED. Typed in from an invoice, and only as good as its check date —
   which is why `checked` is rendered next to every figure. A null amount prints
   "— not entered" and is EXCLUDED from the total; inventing a plausible number
   here would be the exact failure this panel exists to avoid, because a guess
   sitting beside two measured figures reads as a third measured figure.

   To fill one in: set `usd`, set `checked` to today, and bump the ?v= stamp on
   all twelve pages. */
const FIXED_COSTS = [
  { name: "Fly — lynxr-worker", usd: null, checked: "",
    source: "1 machine, shared 2 vCPU / 4096 MB, iad, always on, plus a stopped standby (fly.toml)" },
  { name: "Supabase — esakjfogplfszievvabi", usd: null, checked: "",
    source: "plan not recorded in this repo" },
  { name: "Resend", usd: null, checked: "",
    source: "wait-list and transactional mail; plan not recorded in this repo" },
  { name: "lynxr.io", usd: null, checked: "",
    source: "annual registration — divide by 12" },
  { name: "GitHub Actions", usd: 0, checked: "2026-08-20",
    source: "free minutes on a public repo — see .github/workflows/adaptations.yml's header" },
];

function renderOpsFixed() {
  const host = document.getElementById("ops-fixed");
  if (!host) return;
  const rows = FIXED_COSTS.map((c) => `
    <tr><td>${escapeHtml(c.name)}</td>
      <td class="num">${c.usd == null ? "—" : "$" + Number(c.usd).toFixed(2)}</td>
      <td class="dim">${escapeHtml(c.checked || "—")}</td>
      <td class="dim">${escapeHtml(c.source)}</td></tr>`).join("");
  const entered = FIXED_COSTS.filter((c) => c.usd != null);
  const sum = entered.reduce((a, c) => a + Number(c.usd), 0);
  host.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>what</th><th>$ per month</th><th>checked</th><th>what it is</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="bp-hint">${fmt(entered.length)} of ${fmt(FIXED_COSTS.length)} entered
      · $${sum.toFixed(2)} a month accounted for.</p>`;
}

/* ---------- Ops: the first screen ----------
   Owner, 2026-08-20, on the dashboard that shipped the day before: "for the
   dashboard just highlight the status of issues and costs", then "yes just show
   issues and costs and then when i scroll have the other details."

   So the two tiles below own the viewport on entry and the six detail sections
   start under the fold. NOTHING WAS DELETED to make room — every section, every
   degraded state and every provenance label above is untouched; this is put in
   front of them, not instead of them.

   THE TILES ARE NOT A SECOND SOURCE OF TRUTH, and that is the whole design:

     * opsIssuesState() runs the same four questions renderOpsAlarms() runs, in
       the same order — is the table readable, has a check ever completed, is
       that check current, what did it find — and reads the third from the one
       opsFreshness() the panel reads it from.
     * opsCostState() reads opsCostSummary() and FIXED_COSTS, the same two the
       panels below read; no figure is recomputed here.
     * renderOpsHero() is called from renderOps() only, in the same tick and off
       the same OPS object as the six sections. There is no timer, no partial
       update path, and no branch that repaints one without the other, so there
       is nothing for the two to drift on.

   WHY THAT IS WORTH THE PARAGRAPH. A tile reading "nothing is broken" over a
   panel reading "the query failed" was always worse than no tile. Now that the
   panel begins below the fold, a reader can be shown the reassuring half and
   never scroll far enough to find the contradiction. Every case where we cannot
   establish the state therefore says so, in words, on the first screen: an
   unreadable ops table, a check that has never completed, a check that has gone
   stale, and a missing cost table are four DIFFERENT sentences, none of them
   green.

   NO MOTION. These tiles repaint whenever the worker writes a number, which is
   the surface app.css's motion policy explicitly refuses — no animation, no
   transition, and deliberately no animateCount() on the figures either, unlike
   the .stat cards further down the panel. */

/** Is the watchdog's own picture current? Shared by the Issues tile and the
    Needs-attention panel so the two can never disagree.

    A stale snapshot beside a fresh worker.heartbeat means the worker is alive
    but the CHECKER is blind — the false all-clear the 2026-08-18 newline
    incident produced. beat() writes worker.heartbeat before anything is
    checked; ops.snapshot is written only by a run_once() that got all the way
    through, so the two staleness clocks answer different questions. The 10 and
    5 minute budgets are the ones renderOpsRunning() already labels rows with. */
function opsFreshness() {
  const snapshot = OPS?.ops?.["ops.snapshot"]?.value || {};
  const hbEntry = OPS?.ops?.["worker.heartbeat"];
  const hbAgeMin = hbEntry ? (Date.now() - new Date(hbEntry.updated_at).getTime()) / 60000 : Infinity;
  const snapAgeMin = (Date.now() - new Date(snapshot.at || 0).getTime()) / 60000;
  const stale = snapAgeMin > 10;
  return {
    snapAgeMin, hbAgeMin, stale,
    text: !stale
      ? ""
      : hbAgeMin < 5
        ? `The worker is alive but the checker has not completed a pass in `
          + `${Math.round(snapAgeMin)} min — this is not an all-clear.`
        : `Nothing has checked in for ${Math.round(snapAgeMin)} min.`,
  };
}

/** The Issues tile's verdict, as data rather than markup. Four levels, and only
    one of them is reassuring:

      unknown — we could not establish the state. Never reads as green.
      clear   — a completed, CURRENT check found nothing.
      quiet   — open alarms, none of which ring a phone.
      paging  — at least one alarm the pager has already rung for.

    Severity is not flattened into a count: the watchdog's own `page` bit is
    what separates "a creator lost something" from "the daily digest will
    mention it", and the tile keeps that split in both the chips and the list. */
function opsIssuesState() {
  const unknown = (caveat) => ({
    level: "unknown", head: "Can't tell", chips: [{ text: "unknown", tone: "bad" }],
    why: "", caveat, rows: [],
  });

  if (OPS_STATE === "loading") {
    return { level: "unknown", head: "Reading…", chips: [], why: "", caveat: "", rows: [] };
  }
  if (OPS_STATE === "error" || !OPS) {
    // fetchOps() issues both reads in one Promise.all, so either one failing
    // discards both — including a cost-table error, which is why an issues
    // verdict is unavailable for a reason that sounds like it is about money.
    const k = opsErrorKind(OPS_ERR);
    return unknown(k.title + " " + k.fix
      + " Ops and costs are read together, so this left nothing to judge issues by either.");
  }
  // Same reading as renderOpsAlarms(): the watchdog has written a heartbeat
  // every minute since day one, so [] almost certainly means the staff read
  // policy is not applied — not that the table is genuinely empty.
  if (!Object.keys(OPS.ops).length) {
    return unknown("No ops data readable. If you expected rows, run "
      + "supabase/ops_table.sql in the Supabase SQL editor, then reload.");
  }
  const snapEntry = OPS.ops["ops.snapshot"];
  if (!snapEntry) {
    return unknown("No check has completed yet. The worker has not picked up the "
      + "deploy that writes ops.snapshot; it runs every ~120 seconds once it does.");
  }

  const snapshot = snapEntry.value || {};
  const fresh = opsFreshness();
  const alarms = [...(snapshot.alarms || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const paging = alarms.filter((a) => a.page).length;
  const quiet = alarms.length - paging;

  // A STALE CHECK WITH AN EMPTY LIST IS THE ONE CASE THAT MUST NOT READ AS AN
  // ALL-CLEAR — the list is simply old news, and this is the shape the newline
  // incident produced. With alarms in it the list is still true (something WAS
  // found), so the count stands and the staleness rides along as a caveat.
  if (!alarms.length) {
    return fresh.stale ? unknown(fresh.text) : {
      level: "clear", head: "Nothing is broken",
      chips: [{ text: "all clear", tone: "good" }],
      why: `Last full check ${agoLabel(snapshot.at)} by the ${snapshot.role || "unnamed"} checker.`,
      caveat: "", rows: [],
      // What "nothing is broken" does and does not cover, said on the first
      // screen rather than left for the lede of a section below the fold.
      note: "This is the watchdog's whole last pass, paging alarms and"
        + " digest-only ones alike. The phone only rings for the first kind.",
    };
  }

  const chips = [];
  if (paging) chips.push({ text: `${fmt(paging)} paging`, tone: "bad" });
  if (quiet) chips.push({ text: `${fmt(quiet)} quiet`, tone: "" });
  return {
    level: paging ? "paging" : "quiet",
    head: `${fmt(alarms.length)} open issue${alarms.length === 1 ? "" : "s"}`,
    chips,
    why: paging
      ? "The pager has already rung for these."
      : "None of these ring a phone — the daily digest is where they get reported.",
    caveat: fresh.stale ? fresh.text : "",
    rows: alarms,
    note: "Read straight off the watchdog's own latch, not re-derived here."
      + " Nothing on this page can clear an alarm or retry a job — the watchdog owns that.",
  };
}

/** Rising or not, across the two 7-day windows the measurement actually covers.
    Says "not enough history" rather than a percentage when the earlier window
    starts before the first recorded row: a percentage computed against days
    that were never measured would read as a fall from a number that never
    existed, which is the same lie as presenting an estimate as a measurement. */
function opsSpendTrend(byDay, since) {
  const day = (i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
  let recent = 0, prior = 0;
  for (let i = 0; i < 7; i++) recent += byDay.get(day(i)) || 0;
  for (let i = 7; i < 14; i++) prior += byDay.get(day(i)) || 0;
  if (!since || since > day(13)) {
    return { tone: "", text: `$${recent.toFixed(2)} in 7 days · too little history to compare` };
  }
  if (prior === 0) {
    return recent === 0
      ? { tone: "", text: "no spend in 14 days" }
      : { tone: "bad", text: `$${recent.toFixed(2)} in 7 days · nothing in the 7 before` };
  }
  const pct = Math.round(((recent - prior) / prior) * 100);
  if (Math.abs(pct) < 5) return { tone: "", text: `flat vs the 7 days before ($${prior.toFixed(2)})` };
  return {
    tone: pct > 0 ? "bad" : "good",
    text: `${pct > 0 ? "up" : "down"} ${fmt(Math.abs(pct))}% vs the 7 days before`
      + ` ($${prior.toFixed(2)} → $${recent.toFixed(2)})`,
  };
}

/** What the Costs tile says.

    THE HEADLINE IS MEASURED MODEL SPEND AND NOTHING ELSE, and the tile says so
    in words. The three provenance tiers — measured (Anthropic tokens), metered
    (Apify's own ledger), entered by hand (Fly / Supabase / Resend / the domain)
    — stay three separate lines and are NEVER added together, here or anywhere
    else on this page, because four of the five fixed costs have never been
    entered. A grand total that quietly treated those four as zero would be a
    fabricated figure sitting in the place a measured one is expected, which is
    the exact failure this panel exists to avoid. */
function opsCostState() {
  const fixedEntered = FIXED_COSTS.filter((c) => c.usd != null);
  const fixedMissing = FIXED_COSTS.length - fixedEntered.length;
  const fixedSum = fixedEntered.reduce((a, c) => a + Number(c.usd), 0);
  // FIXED_COSTS is a constant in this file, not a query, so this line is the
  // one thing the tile can still state truthfully when every read has failed.
  const fixedLine = {
    k: "fixed, monthly", v: "$" + fixedSum.toFixed(2), tier: "entered by hand",
    note: fixedMissing
      ? `only ${fmt(fixedEntered.length)} of ${fmt(FIXED_COSTS.length)} entered —`
        + ` ${fmt(fixedMissing)} unknown, so this is a floor, not the bill`
      : `all ${fmt(FIXED_COSTS.length)} entered`,
  };

  if (OPS_STATE === "loading") {
    return { level: "unknown", head: "Reading…", chips: [], why: "", caveat: "",
             lines: [fixedLine], note: "" };
  }
  if (OPS_STATE === "error" || !OPS) {
    const k = opsErrorKind(OPS_ERR);
    return { level: "unknown", head: "Can't tell", chips: [{ text: "unknown", tone: "bad" }],
             why: "", caveat: k.title + " " + k.fix, lines: [fixedLine], note: "" };
  }

  const opsReadable = Object.keys(OPS.ops).length > 0;
  const apify = OPS.ops["cost.apify"]?.value;
  const apifyLine = apify
    ? { k: "apify, this month", v: "$" + Number(apify.spent_usd).toFixed(2), tier: "metered",
        note: `apify's own meter · of $${apify.breaker_usd} before the breaker` }
    : {
        k: "apify, this month", v: "—", tier: "metered",
        // Two different absences. "Not configured" would be a claim we cannot
        // make when the whole table came back empty.
        note: opsReadable
          ? "meter not configured — no token is set, so nothing reads apify's spend"
          : "not readable — the ops table returned nothing",
      };

  if (!opsReadable) {
    return {
      level: "unknown", head: "Can't tell", chips: [{ text: "unknown", tone: "bad" }], why: "",
      caveat: "No ops data readable. If you expected rows, run supabase/ops_table.sql "
        + "in the Supabase SQL editor, then reload.",
      lines: [{ k: "model, 30 days", v: "—", tier: "measured", note: "not readable" }, apifyLine, fixedLine],
      note: "",
    };
  }

  if (!(OPS.costs || []).length) {
    // Same sentence as the panel below the fold, from the same function.
    const k = opsCostEmptyKind();
    return {
      level: "unknown", head: "Not measured",
      // Neutral, not bad: the read worked and the table is fine. Nothing here
      // is proven broken, and a red chip on a waiting table is the same
      // overstatement in a different colour.
      chips: [{ text: "no cost rows", tone: "" }], why: "",
      caveat: k.title + " " + k.fix,
      lines: [{ k: "model, 30 days", v: "—", tier: "measured", note: "nothing recorded" },
              apifyLine, fixedLine],
      note: "",
    };
  }

  const { usd30, usdFail, passes, unpriced, since, byDay } = opsCostSummary();
  const trend = opsSpendTrend(byDay, since);
  let note = "That headline is model spend only — the three lines above are three"
    + " different kinds of number and are never added up on this page.";
  if (usdFail > 0) note += ` $${usdFail.toFixed(2)} of it went on passes that failed.`;
  if (unpriced > 0) {
    note += ` ${fmt(unpriced)} pass${unpriced === 1 ? "" : "es"} ran on a model with no price`
      + ` on file and ${unpriced === 1 ? "is" : "are"} not counted.`;
  }
  return {
    level: "ready", head: "$" + usd30.toFixed(2), chips: [{ text: trend.text, tone: trend.tone }],
    why: `Measured model spend, 30 days — real token counts at list prices ${PRICES_REV_LABEL},`
      + ` over ${fmt(passes)} recorded pass${passes === 1 ? "" : "es"}. Measuring since ${since}.`,
    caveat: "", lines: [
      { k: "model, 30 days", v: "$" + usd30.toFixed(2), tier: "measured", note: "real token counts" },
      apifyLine, fixedLine,
    ], note,
  };
}

/** Paints both tiles. Called from renderOps() in every branch — never on its
    own, and never on a timer. Head and body are separate hosts because the head
    carries aria-live: it is the sentence worth announcing when a Refresh lands,
    and the alarm list underneath is not. */
function renderOpsHero() {
  const hosts = {
    ih: document.getElementById("ops-issues-head"),
    ib: document.getElementById("ops-issues-body"),
    ch: document.getElementById("ops-costs-head"),
    cb: document.getElementById("ops-costs-body"),
  };
  if (!hosts.ih || !hosts.ib || !hosts.ch || !hosts.cb) return;

  const TONE = { clear: "good", paging: "bad", quiet: "", unknown: "unknown", ready: "" };
  const chips = (list) => (list || [])
    .filter((c) => c && c.text)
    .map((c) => `<span class="chip${c.tone ? " " + c.tone : ""}">${escapeHtml(c.text)}</span>`)
    .join(" ");
  const head = (st) =>
    `<div class="ops-big ${TONE[st.level] || ""}">${escapeHtml(st.head)}</div>`
    + (st.chips?.length ? `<div class="ops-chips">${chips(st.chips)}</div>` : "")
    + (st.why ? `<p class="ops-why">${escapeHtml(st.why)}</p>` : "")
    + (st.caveat ? `<p class="ops-why bad">${escapeHtml(st.caveat)}</p>` : "");

  const iSt = opsIssuesState();
  hosts.ih.innerHTML = head(iSt);
  // Six is not a page size — a dozen rows is the whole table by construction.
  // It is the point past which the tile would push its own costs twin off the
  // first screen, which is the one thing this layout may not do.
  const shown = (iSt.rows || []).slice(0, 6);
  hosts.ib.innerHTML = shown.map((a) => `
    <div class="ops-alarm">
      <span class="chip${a.page ? " bad" : ""}">${a.page ? "pages" : "quiet"}</span>
      <span class="ops-alarm-t">${escapeHtml(a.title || a.key || "")}</span>
      <span class="ops-alarm-b">${escapeHtml(a.body || "")}</span>
    </div>`).join("")
    + ((iSt.rows || []).length > shown.length
      ? `<p class="ops-note">${fmt(iSt.rows.length - shown.length)} more in
           needs attention, below.</p>`
      : "")
    + (iSt.note ? `<p class="ops-note">${escapeHtml(iSt.note)}</p>` : "");

  const cSt = opsCostState();
  hosts.ch.innerHTML = head(cSt);
  hosts.cb.innerHTML = (cSt.lines || []).map((l) => `
    <div class="ops-line">
      <span class="ops-line-k">${escapeHtml(l.k)}</span>
      <span class="ops-line-v">${escapeHtml(l.v)}</span>
      <span class="ops-line-n">${escapeHtml(l.tier)} · ${escapeHtml(l.note)}</span>
    </div>`).join("")
    + (cSt.note ? `<p class="ops-note">${escapeHtml(cSt.note)}</p>` : "");
}


// ---------- Footer ----------
/** Agency-only footer concerns: the live #foot-count and the .foot-link
    [data-tab] wiring to activateTab(). The split-flap wordmark itself is
    shared across all three surfaces and lives in footer.js, self-initialised
    from the DOM rather than called in from here. */
function initFooter(rows) {
  const count = document.getElementById("foot-count");
  if (count) count.textContent = fmt(rows.length);

  document.querySelectorAll(".foot-link[data-tab]").forEach((b) =>
    b.addEventListener("click", () => activateTab(b.dataset.tab)));
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
  const arcPill = document.getElementById("db-arc-pill");
  if (arcPill) arcPill.textContent = fmt(rows.length);

  // CREATOR SOURCES — the default half of the Database tab. Fetched AFTER the
  // scraped corpus and deliberately not awaited: it is a separate table behind
  // its own policy, and a slow or refused read there must not hold up the rest
  // of the app. renderSourcesAll() paints whatever came back, including the
  // "policy probably not applied" empty state.
  initSourcesUi();
  initOpsUi();
  renderSources();                       // paints the loading line immediately
  fetchSources().then(renderSourcesAll);

  initTabs();
  initModal();
  updateSyncBadge();
  renderBriefs();
  // Arrow keys flip through an open brief (unless typing in a field).
  document.addEventListener("keydown", (e) => {
    if (!BRIEF_VIEW || document.getElementById("panel-briefs").hidden) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) return;
    if (document.activeElement?.isContentEditable) return;   // arrows move the caret in a script line
    if (BRIEF_VIEW.expanded == null) return;
    if (e.key === "ArrowLeft" && BRIEF_VIEW.expanded > 0) { BRIEF_VIEW.expanded--; renderBriefs(); }
    if (e.key === "ArrowRight") { BRIEF_VIEW.expanded++; renderBriefs(); }
  });
  initControls();
  initBrief();
  initFooter(rows);
  applyFilters();
}

/** A reset or invite link comes back here with the session in the URL
    fragment (Supabase's implicit flow). Take it, strip it from the address bar
    so the tokens never sit in history, and ask for a password. Returns true
    when it took over the gate, so the stored-session path doesn't also run.
    Fragments never reach a server, so this is the only place that can read it.
    Same contract as sessionFromLink() in creator.js; separate bundle, own copy. */
async function sessionFromLink() {
  const hash = location.hash || "";
  if (!hash.includes("access_token") && !hash.includes("error")) return false;
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  history.replaceState(null, "", location.pathname + location.search);
  const err = document.getElementById("err");
  if (p.get("error_description") || p.get("error")) {
    // A stored session may still be good, so fall through to it; if it isn't,
    // this sentence is what stays on the gate.
    err.textContent = "That link has expired or was already used. "
      + "Enter your email and tap Forgot your password for a new one.";
    return false;
  }
  const type = p.get("type");
  const access_token = p.get("access_token"), refresh_token = p.get("refresh_token");
  if (!access_token || !refresh_token) return false;
  try {
    // The fragment carries no user object; the email is what updated_by records.
    const res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${access_token}` } });
    if (!res.ok) throw new Error(String(res.status));
    const user = await res.json();
    SB_TOKEN = access_token;
    SB_EMAIL = user.email || null;
    SB_UID = user.id || null;
    sbSaveSession({ access_token, refresh_token, user });
  } catch {
    err.textContent = "Couldn't open that link — ask for a fresh one and try again.";
    return true;
  }
  if (type === "recovery" || type === "invite") {
    setResetMode(type === "invite" ? "Choose a password to finish." : "Set a new password to finish.");
    return true;
  }
  return false;   // any other link (a signup confirmation): the stored session takes it from here
}

// Kick off auto-login last, once every Supabase const above is initialized.
// A reset or invite link wins over a stored session.
(async () => { if (!(await sessionFromLink())) resumeSession(); })();

