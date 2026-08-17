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
/** THE LOADING MARK — the lynxr X split into its four arms, each scaling out of
 *  the centre in clockwise turn (`arm-in` in app.css).
 *
 *  The four arms stop short of the middle: they meet at (12,9), (15,12),
 *  (12,15) and (9,12), which leaves the diamond gap the wordmark has. Do not
 *  "close" that hole — it is the mark, not a rendering slip, and the whole
 *  point of animating this shape instead of a generic spinner is that the thing
 *  spinning is recognisably lynxr.
 *
 *  It exists in one place because it is now used for every long wait: reading a
 *  brand's site, and writing a script from a link. Three hand-copied SVGs would
 *  drift the moment one arm's path changed.
 */
function loaderMark() {
  return `<svg class="loader-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path class="arm a1" fill="currentColor" d="M3 3H6L12 9L9 12L3 6Z"/>
      <path class="arm a2" fill="currentColor" d="M21 3V6L15 12L12 9L18 3Z"/>
      <path class="arm a3" fill="currentColor" d="M15 12L21 18L18 21L12 15Z"/>
      <path class="arm a4" fill="currentColor" d="M12 15L6 21L3 18L9 12Z"/>
    </svg>`;
}
/** Put a status line into a working state: the mark at text size, plus what it
 *  is doing. `text` is ours, never server-supplied — failures use textContent. */
function gateBusy(el, text) {
  el.innerHTML = `<span class="loader inline">${loaderMark()}<span>${escapeHtml(text)}</span></span>`;
}

/* THE PRIVACY POLICY, WITHOUT LEAVING THE PAGE.
   Agreeing to something you have to navigate away to read is a poor bargain —
   and this link sits inside a half-filled signup form, where a new tab means
   losing your place and the back button means losing the form.

   The text is FETCHED from /privacy/ rather than copied in here, so there is
   one policy to keep accurate instead of two that drift apart. Same-origin, and
   connect-src 'self' is already in this page's CSP.

   The <a> keeps its real href throughout: if the fetch fails, or JS never runs,
   the link still works the ordinary way. A modal is an enhancement here, never
   the only route to the text. */
let POLICY_HTML = null;              // fetched once, reused

async function openPolicy() {
  const modal = document.getElementById("policy-modal");
  const body = document.getElementById("policy-body");
  if (!modal || !body) return false;

  modal.hidden = false;
  document.body.classList.add("modal-open");
  if (POLICY_HTML === null) {
    body.innerHTML = `<div class="loader">${loaderMark()}
      <div class="loader-text"><div class="loader-stage">loading the policy…</div></div></div>`;
    try {
      const res = await fetch("/privacy/", { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      // DOMParser does not run scripts, and /privacy/ ships none — but parsing
      // rather than assigning the whole document also means only the prose is
      // taken, not its <head>, favicons or stylesheet link.
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const main = doc.querySelector(".legal");
      if (!main) throw new Error("no .legal");
      // The in-page copy has its own heading and back-links; the modal supplies
      // both, so strip them rather than showing two of each.
      main.querySelectorAll(".legal-back, .legal-foot, h1").forEach((el) => el.remove());
      POLICY_HTML = main.innerHTML;
    } catch {
      POLICY_HTML = null;
      body.innerHTML = `<p class="bp-hint">couldn't load it here —
        <a href="/privacy/" target="_blank" rel="noopener">open the privacy policy</a> instead.</p>`;
      return true;
    }
  }
  body.innerHTML = POLICY_HTML;
  body.scrollTop = 0;
  document.getElementById("policy-close")?.focus();
  return true;
}

function closePolicy() {
  const modal = document.getElementById("policy-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

/** Every /privacy/ link in the app opens the modal instead of navigating.
    Delegated from the document so it covers links that are rendered later —
    the one in Settings is built by renderYou long after this runs. */
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[href="/privacy/"]');
  if (!a) return;
  // Let a deliberate new-tab click (cmd/ctrl/middle) behave normally.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  if (openPolicy()) e.preventDefault();
});
document.addEventListener("click", (e) => {
  // Backdrop or close button. The card itself stops here via .modal-card.
  if (e.target.id === "policy-modal" || e.target.closest?.("#policy-close")) closePolicy();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("policy-modal")?.hidden) closePolicy();
});

// The prompter's markup is static, and this file is deferred, so the DOM is
// ready here — no need to wait for sign-in the way the rendered views do.
initPrompter();

/** The empty-state demo: a link lands, a script draws itself underneath, on a
 *  loop. Shown where someone has nothing yet and a sentence alone leaves them
 *  guessing what "send a link" actually produces. Decorative — aria-hidden, so
 *  a screen reader gets the wording beside it and not a pile of empty spans. */
function emptyDemo() {
  return `<div class="demo" aria-hidden="true">
      <span class="demo-link"><i class="demo-dot"></i>instagram.com/reel/…</span>
      <span class="demo-arrow">↓</span>
      <span class="demo-card">
        <i class="demo-row r1"></i><i class="demo-row r2"></i><i class="demo-row r3"></i>
      </span>
    </div>`;
}
/** Fit a `.grow` textarea to its text, the way a message composer does.
 *
 *  Height is reset to "auto" before measuring, because scrollHeight can never
 *  report less than the height already set — without the reset the box grows
 *  as you type and then never shrinks back when you delete. A hidden element
 *  measures 0, so leave it alone and re-fit when it is shown.
 */
function autoGrow(el) {
  if (!el || !el.offsetParent) return;
  el.style.height = "auto";
  // An EMPTY field measures its PLACEHOLDER, not its value — and a placeholder
  // wraps to three lines in a narrow pane, so an untouched field opened as a
  // big blank box among one-line inputs. Empty means one row: clearing the
  // inline height hands it back to rows="1".
  if (!el.value) { el.style.height = ""; return; }
  // scrollHeight covers content + padding but NOT the border, while
  // box-sizing: border-box makes the height we set include it. Assigning
  // scrollHeight straight across therefore comes up two pixels short and
  // shaves the bottom off the last line — invisible until a descender lands.
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}
/** Fit now, and on every edit. Blur too: a trim on blur can drop a line. */
function wireGrow(el) {
  if (!el) return;
  autoGrow(el);
  el.addEventListener("input", () => autoGrow(el));
  el.addEventListener("blur", () => autoGrow(el));
}

/** A frame from the source video, for telling one row from another.
 *
 *  The worker uploads it, so it hangs off the adaptation rather than the
 *  library entry — a library row finds it through whichever script was written
 *  from that video. The trash is searched too: a deleted script still knows
 *  what its video looked like, and the library keeps the video regardless.
 *  Returns "" when there is none, and the row renders exactly as it did before.
 */
function coverUrl({ libraryId, canon } = {}) {
  const all = [...(ME.adaptations || []), ...(ME.trash || [])];
  const hit = all.find((x) => (x.source || {}).cover
    && (x.libraryId === libraryId
        || (canon && x.sourceUrl && canonUrl(x.sourceUrl) === canon)));
  return hit ? hit.source.cover : "";
}

/** The thumbnail cell, or nothing at all. */
function thumbHtml(url, label) {
  return url
    ? `<img class="bp-thumb" src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async"
         title="${escapeHtml(label || "")}">`
    : "";
}

/** Keep a click on a link inside a <summary> from also toggling the card.
 *  The browser's disclosure toggle is the summary's activation behaviour, so
 *  stopping the event at the anchor is what prevents it — the anchor's own
 *  navigation is a default action and still happens. Covers the ↗ too, which
 *  until now opened the video AND flipped the card open behind it. */
function stopSummaryLinks(root) {
  root.querySelectorAll("summary a").forEach((el) =>
    el.addEventListener("click", (e) => e.stopPropagation()));
}

/** Animate a <details> SHUT as well as open.
 *
 *  A <details> destroys its content the instant `open` is unset, so a closing
 *  animation has nothing left to run on. This holds the card open, plays
 *  `bp-close`, and only then closes it — so the body visibly lifts back up into
 *  the summary it belongs to instead of vanishing.
 *
 *  Under reduced motion it does NOTHING and lets the browser close natively.
 *  That is not politeness: the blanket `animation: none !important` means
 *  `animationend` would never fire, and the card could never be shut again.
 *  The timeout below is the same guard for a dropped event mid-transition.
 */
function wireDisclosureMotion(root) {
  if (!root) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.querySelectorAll("details.bp-item > summary").forEach((sum) => {
    if (sum.dataset.motion) return;                 // a repaint must not stack handlers
    sum.dataset.motion = "1";
    sum.addEventListener("click", (e) => {
      const card = sum.parentElement;
      if (!card.open) return;                       // opening: CSS bp-open has it
      const body = card.querySelector(":scope > .bp-body");
      if (!body) return;
      e.preventDefault();                           // stop the instant native close
      body.classList.add("bp-closing");
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        body.classList.remove("bp-closing");
        card.open = false;
      };
      body.addEventListener("animationend", finish, { once: true });
      setTimeout(finish, 260);
    });
  });
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
  // Remember the button's FACE, not just its label: some of these are a trash
  // icon, and restoring them with textContent would replace the svg with a
  // word and leave the button permanently wrong after the first disarm.
  const face = btn.innerHTML;
  const disarm = () => {
    clearTimeout(timer);
    btn.classList.remove("armed");
    btn.innerHTML = face;
  };
  /* A double-click used to delete: the first click armed the button and the
     second landed on the armed one milliseconds later, so the safeguard was
     defeated by an ordinary slip of the finger — and this button now sits
     beside Save, which people press often. The armed button therefore ignores
     anything that arrives too quickly to be a considered second press. */
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

// Where this app lives, for the links Supabase mails back — confirmation and
// password reset. It moved off /creator.html to an unlisted directory so the
// homepage can be a public marketing page; a stale value here does not fail
// loudly, it just mails people a 404, so it is defined once and used for both.
// Supabase must also allow it: Authentication -> URL Configuration -> Redirect
// URLs needs https://lynxr.io/** or the link is rejected as an open redirect.
const CREATOR_PATH = "/creatorsonly/";
const SB_SESSION_KEY = "lynxr_creator_session";

let SB_TOKEN = null, SB_EMAIL = null, SB_UID = null, SB_REFRESHING = null;
let SYNC_OK = false;
// library[] is every video the creator has sent, ONE entry per video for the
// whole account — a video belongs to them, not to a brand, so the same link
// scripted for three brands is still one row here.
// adaptations[] are the scripts — kept as a flat top-level array because that
// is exactly what the worker iterates; nesting them inside brands would break
// pipeline/process_adaptations.py.
const BLANK_ME = { name: "", niches: [], brands: [], adaptations: [], library: [],
                   trash: [], contactEmail: "", emailOptIn: false };

/** Delete a script the recoverable way: it moves to the trash with a stamp and
 *  the name of the company it was written for, so Settings can offer it back.
 *  Nothing here is free to remake — a delete used to be the one action in the
 *  app that destroyed something you had paid for, behind a single arm. */
function trashAdaptations(pred) {
  const goes = (ME.adaptations || []).filter(pred);
  if (!goes.length) return 0;
  ME.trash = ME.trash || [];
  for (const a of goes) {
    SEEN.delete(a.id);
    ME.trash.unshift({ ...a, deletedAt: new Date().toISOString() });
  }
  ME.adaptations = ME.adaptations.filter((a) => !pred(a));
  return goes.length;
}
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
async function sbSignUp(email, password, invite) {
  // Tell Supabase where the confirmation link should land, per signup, instead
  // of relying on the project's single Site URL. That setting pointed at
  // localhost, so every confirmation email sent a real user to a page only the
  // developer's laptop could serve. location.origin is whatever host actually
  // served this page, so the link always comes back to the same deployment.
  const back = encodeURIComponent(location.origin + CREATOR_PATH);
  const res = await fetch(`${SB_URL}/auth/v1/signup?redirect_to=${back}`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    // The invite code rides along as signup metadata. GoTrue writes `data` into
    // raw_user_meta_data BEFORE the gate trigger runs, which is the only way the
    // trigger can see a value that isn't the email or the password.
    body: JSON.stringify(invite ? { email, password, data: { invite } }
                                : { email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.msg || body.message || "Sign-up failed");
  if (body.access_token) { adoptSession(body, email); return "in"; }
  return "confirm";
}

/* SEATS. The invited group is finite and the front door closes by itself —
   see the signup gate in supabase/schema.sql. THE DATABASE IS THE LOCK; this
   is only so a full gate can say so in words.

   Fails OPEN on purpose. If the RPC is missing (a database without the
   migration) or the network is down, the page behaves exactly as it did before
   and the trigger still refuses the account — an unreachable check must not
   lock out a creator who is entitled to sign up. */
const FULL_MSG = "lynxr is invite-only and full right now — "
  + "join the waitlist at lynxr.io and we'll come to you as we open up.";
let SEATS_OPEN = null;                       // null = not asked yet
let INVITE_REQUIRED = false;

/* The invite that brought them here. An invite link is
   /creatorsonly/?signup=1&e=<email>&c=<code>, so the common path is one click
   and nothing to type; the code field exists for someone who has the mail open
   on their phone and the app on a laptop. */
const INVITE = new URLSearchParams(location.search).get("c") || "";
const INVITED_EMAIL = new URLSearchParams(location.search).get("e") || "";

async function signupState() {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/signup_state`, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return { open: true, invite_required: false };
    const s = await res.json();
    // A database with no gate row answers null. Treat that as "no gate".
    return s && typeof s === "object" ? s : { open: true, invite_required: false };
  } catch { return { open: true, invite_required: false }; }
}

/* Only ever speaks up in create mode: a closed door is no reason to stop
   someone signing in, and saying "we're full" over the sign-in form would read
   as "your account is gone". */
function applySeatState() {
  if (GATE_MODE !== "up") return;
  // The invite field is shown only when the database says invites are the gate,
  // so the same build serves an open signup, a seat-capped one and an
  // invite-only one without a redeploy.
  const wrap = document.getElementById("invite-wrap");
  if (wrap) wrap.hidden = !INVITE_REQUIRED;
  if (SEATS_OPEN === false) {
    document.getElementById("gate-go").disabled = true;
    document.getElementById("err").textContent = FULL_MSG;
  }
}

function refreshSeats() {
  signupState().then((s) => {
    SEATS_OPEN = s.open !== false;
    INVITE_REQUIRED = s.invite_required === true;
    applySeatState();
  });
}

function signupError(raw) {
  const s = String(raw || "");
  /* The seat gate refusing an account. MEASURED against the live project on
     2026-08-12, because the wording here is not obvious: GoTrue passes the
     trigger's own `raise exception` text straight through as `message`, so what
     arrives is "lynxr: signups are closed — all 4 seats are taken" with a 500,
     NOT the generic "Database error saving new user" that a raise inside
     auth.users is usually said to produce. Both are matched — the second as a
     fallback, since which one you get depends on the GoTrue version and it
     costs nothing to cover.

     Only reachable by a page that was already open when the last seat went;
     signup_open() disables the button before this in the normal case. Re-ask
     on the way out so a genuine database fault doesn't leave the gate claiming
     to be full forever. */
  // Invite refusals, same delivery route as the seat message below: the
  // trigger's own text arrives as `message` with a 500. Named separately
  // because "you're not on the list" and "that code is wrong" are different
  // problems and the second one is fixable by the person reading it.
  if (/no invite for this address/i.test(s))
    return "That email isn't on the invite list. Use the address your invite was sent to, "
      + "or join the waitlist at lynxr.io.";
  if (/invite code does not match/i.test(s))
    return "That invite code isn't right — check the link in your invite email.";

  if (/signups are closed|seats are taken/i.test(s)
      || /database error saving new user|unexpected_failure/i.test(s)) {
    refreshSeats();
    return FULL_MSG;
  }
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
// True from the moment an edit is made until it is safely on the server. The
// sync loop refuses to pull while this is set: a pull mid-debounce replaces ME
// with the server's copy, and the pending write then posts that back over the
// edit that triggered it.
let SAVE_PENDING = false;

function save({ now = false } = {}) {
  SAVE_PENDING = true;
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
    SAVE_PENDING = false;
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
  for (const k of ["niches", "brands", "adaptations", "library", "trash"]) {
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
        // realTitle, so a URL stored by the old sourceLabel fallback does not
        // ride into the rebuilt entry and then block it from ever hydrating.
        title: realTitle(a.title), creator: "", caption: "",
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

/* Brands a script can actually be written FOR. A brand with no name gives the
   model "Brand: ?" with everything else "(not given)", so four calls — three of
   them Opus — would go into a script adapted to nothing.

   Filtering here rather than refusing at send time is what stops an unnamed
   brand becoming a dead end. It used to be one: a lone unnamed brand was
   auto-ticked by composeTargets(), then refused for having no name, with no
   prompt to name it because that prompt was gated on having no brands at all.
   Now it simply is not a target, and the send falls through to the video's
   original script.

   Defined up here with the other slices because renderNewScript() calls it —
   as a `const` it would sit in the temporal dead zone for anything that ran
   during initial evaluation. */
const namedBrands = () => ME.brands.filter((b) => (b.name || "").trim());

// ---------- view routing ----------
// One rail, one pane. VIEW says what the pane is showing; nothing else does.
let VIEW = { kind: "new" };      // opening the app starts a fresh script

function go(view) {
  VIEW = view;
  document.body.classList.remove("side-open");
  renderSide();
  renderPane();
  const s = document.getElementById("pane-scroll");
  if (s) s.scrollTop = 0;
}

// ---------- New script ----------
// Modelled on a chat app's new-chat screen: opening lynxr lands here with an
// empty composer, and pressing "New script" from anywhere returns here empty.
// One job on the page, so there is nothing to read before you can start.
function renderNewScript(head, body) {
  // No page title — the greeting below is the title, and repeating it twice
  // above a one-field form is exactly the clutter this view is avoiding.
  head.innerHTML = `
    <button type="button" class="side-toggle" id="side-open" aria-label="Menu" title="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>`;
  document.getElementById("side-open").addEventListener("click", () =>
    document.body.classList.toggle("side-open"));

  // A brand-new account used to hit a wall here — "Add a company first", with
  // no composer on the page at all. Someone who signs up, pastes the link they
  // came to paste and is told to go and do something else first mostly just
  // leaves: one live account got exactly this far and stopped, with zero
  // companies and nothing in its library. A script does still have to be
  // written FOR something, so the composer now asks for that inline and makes
  // the company as part of the send, instead of sending you away to a form.
  // "No brand yet" means no brand we could WRITE for. A brand that exists but
  // has never been named is the same situation from the creator's side, and
  // gating this on ME.brands.length left them with no prompt and no send.
  const firstRun = !namedBrands().length;

  // Centred greeting over the app's EXISTING composer component. The markup of
  // the composer is deliberately untouched — the `composer-inline` /
  // `composer-row` pair is what all its styling hangs off, and rebuilding it
  // with a different structure dropped those classes and made the input and
  // send button vanish entirely.
  body.innerHTML = `
    <div class="newscript">
      <div class="newscript-greet">
        <svg class="newscript-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M3 3h3l15 15-3 3L3 6zM21 3v3L6 21l-3-3L18 3z"/></svg>
        ${/* One line, doing both jobs. "What are we making?" asked a question
              the composer below already asks, and needed a second line of
              small text to explain what to put in it — so the screen opened
              with a prompt, an explanation, and only then the box. This says
              what lynxr does and what to do next in the same five words, which
              is all a returning creator needs and enough for a new one. */""}
        <h1 class="newscript-h">paste a video, get a script</h1>
      </div>
      ${firstRun ? `<p class="nobrand">
        <button type="button" class="linkish" id="nobrand-add">Add a brand</button>
        to get scripts written for them</p>` : ""}
      <div class="composer composer-inline" id="composer">
        <div class="composer-for" id="composer-for"></div>
        <form class="composer-row" id="composer-form">
          <input type="url" id="composer-url" placeholder="Paste a TikTok / Instagram / YouTube link"
            autocomplete="off" spellcheck="false" aria-label="Paste a video link">
          <span class="bp-plat" id="composer-plat"></span>
          <button type="submit" class="composer-send" id="composer-send" aria-label="Get the script">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
          </button>
        </form>
        <p class="composer-note" id="composer-note"></p>
      </div>
    </div>`;

  renderComposeFor();
  wireComposer();
  document.getElementById("nobrand-add")?.addEventListener("click", addBrand);
  // Focus on desktop only — on a phone the keyboard would spring up and cover
  // the company picker before you've chosen who the script is for.
  if (window.matchMedia("(min-width: 761px)").matches) {
    document.getElementById("composer-url")?.focus();
  }
}

/* KEYBOARD-AWARE HEIGHT ------------------------------------------------------
   The composer sits at the foot of the page, which is exactly where a phone
   puts its keyboard. `interactive-widget=resizes-content` in the viewport meta
   handles Chrome and most Android browsers; iOS Safari ignores it and does NOT
   shrink dvh for the keyboard either, so the composer would end up behind it.

   visualViewport is the one measurement that is correct everywhere: it reports
   the area actually visible to the user. Publishing it as --vvh lets the layout
   follow the keyboard up and back down on every device that has one.

   Throttled through rAF because iOS fires resize continuously through the
   keyboard animation, and writing a custom property on every one of those
   events re-runs layout for the whole page mid-animation. */
function trackVisibleHeight() {
  const vv = window.visualViewport;
  if (!vv) return;                       // older browser: the dvh fallback stands
  let queued = false;
  const publish = () => {
    queued = false;
    document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
  };
  const onChange = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(publish);
  };
  publish();
  vv.addEventListener("resize", onChange);
  vv.addEventListener("scroll", onChange);
}
trackVisibleHeight();

function renderSide() {
  document.getElementById("side-who").textContent = SB_EMAIL || "";
  const used = Math.min(scriptsUsed(), SCRIPT_CAP);
  const quota = document.getElementById("side-quota");
  document.getElementById("side-quota-text").textContent =
    used >= SCRIPT_CAP ? `${SCRIPT_CAP}/${SCRIPT_CAP} — none left`
                       : `${used}/${SCRIPT_CAP} scripts · ${SCRIPT_CAP - used} left`;
  // Width via CSSOM, not a style attribute: the CSP drops inline styles, and
  // this exact mistake once shipped bar charts that rendered as nothing.
  document.getElementById("side-quota-fill").style.width = `${(used / SCRIPT_CAP) * 100}%`;
  quota.classList.toggle("spent", used >= SCRIPT_CAP);
  document.getElementById("nav-library-n").textContent = ME.library.length || "";
  document.getElementById("nav-new").classList.toggle("on", VIEW.kind === "new");
  document.getElementById("nav-library").classList.toggle("on", VIEW.kind === "library");
  document.getElementById("nav-you").classList.toggle("on", VIEW.kind === "you");
  document.getElementById("nav-feedback").classList.toggle("on", VIEW.kind === "feedback");

  const host = document.getElementById("side-list");
  if (!ME.brands.length) {
    host.innerHTML = `<p class="side-empty">No brands yet — add the first company you make videos for.</p>`;
    return;
  }
  // Original scripts are NOT listed here. The rail is companies you write for,
  // and a script that belongs to no company is not one of them — it reached
  // this list once and read as a brand called "Original scripts". They live in
  // the Library, as its third grouping mode.
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

/* renderOriginals() lived here: a standalone page listing every script that
   belonged to no brand. It is gone, and so is its `originals` view. The
   Library's "Original scripts" tab shows the same set, and the scripts
   themselves now render inline inside each Library entry — so the page was
   both unreachable (nothing linked to it once the loose group went) and a
   second place with the same name, which is what made the two easy to
   confuse in the first place. */

function renderPane() {
  const head = document.getElementById("pane-head");
  const body = document.getElementById("pane-body");
  if (VIEW.kind === "new") return renderNewScript(head, body);
  if (VIEW.kind === "you") return renderYou(head, body);
  if (VIEW.kind === "feedback") return renderFeedback(head, body);
  if (VIEW.kind === "brand") {
    const b = brandById(VIEW.id);
    if (b) return renderBrand(head, body, b);
    VIEW = { kind: "new" };                // deleted on another device
  }
  return renderLibrary(head, body);
}

function addBrand() {
  // Pressing this twice used to mint a second blank company, and again, and
  // again — a rail full of "Untitled company" rows that all look identical and
  // none of which can be scripted for (a nameless company is refused at send).
  // If a blank one is already waiting, go finish that instead of adding to the
  // pile.
  const blank = ME.brands.find((b) => !(b.name || "").trim());
  if (blank) {
    go({ kind: "brand", id: blank.id });
    // Land on the field that finishes it — the website box when the lookup
    // panel is up, the name field when they chose to type it in.
    const field = document.querySelector("#pane-body .b-lookup")
      || document.querySelector("#pane-body .b-name");
    if (field) field.focus();
    flashMsg("brand-flash", "Add this brand here first.", "bad");
    return;
  }
  const b = { id: newId(), name: "", site: "", description: "", objective: "",
              niche: "", code: trackCode("LYNX") };
  ME.brands.push(b);
  save();
  go({ kind: "brand", id: b.id });
  const first = document.querySelector("#pane-body .b-name");
  if (first) { first.focus(); }
}

/* Brands whose owner chose to type the details rather than give a website.
   Kept in memory only: it exists to stop the lookup panel reappearing while
   they are still on the page, and a brand with a name never shows it again
   anyway, so there is nothing worth persisting. */
const BRAND_MANUAL = new Set();

/* Brands asking for the website panel back after leaving it — either by
   choosing "Add manually", or after a read that failed. Needed because the
   panel normally only shows for a brand with NO site, and a failed read
   deliberately keeps the URL that was typed. */
const RETRY_LOOKUP = new Set();

/** The one question a new brand asks. Fills name, what-it-is and niche from the
    company's own homepage, then hands over to the normal editor. */
/* Set while a lookup panel is on screen, so the header's tick can run it. The
   panel used to carry its own "Get the details" button beside the tick, making
   confirmation a two-button decision — press one to fetch, the other to keep —
   when it is really one action: take this website and set the brand up from it. */
let BRAND_LOOKUP_RUN = null;

/* Set by a successful lookup, consumed by the render that follows it. The old
   confirmation was a paragraph of green text explaining where the details went,
   which is a lot of reading for "they are behind that button" — a small arrow
   pointing at Details says it without a sentence. */
let POINT_AT_DETAILS = false;

/** Point at Details for a few seconds. Used after a website read AND after the
    details are typed in by hand — either way the brand is now set up and the
    fields have gone behind a button, which is worth saying once. */
function showDetailPoint() {
  const point = document.getElementById("detail-point");
  if (!point) return;
  point.hidden = false;
  setTimeout(() => {
    const again = document.getElementById("detail-point");
    if (again) again.hidden = true;
  }, 6000);
}

function wireBrandLookup(b) {
  const panel = document.getElementById("brand-lookup");
  const input = panel.querySelector(".b-lookup");
  const msg = document.getElementById("lookup-msg");

  const openEditor = () => {
    BRAND_MANUAL.add(b.id);
    /* Clearing RETRY_LOOKUP is not optional. `fresh` is
         RETRY_LOOKUP.has(id) || (!b.site && !BRAND_MANUAL.has(id))
       and the first clause SHORT-CIRCUITS — so once "use their website
       instead" had put the id in RETRY_LOOKUP, adding to BRAND_MANUAL was never
       even read and the lookup panel rendered again. "Add manually" looked
       dead: it fired, re-rendered, and landed on the same screen.
       The two successful-lookup paths already clear it; this one did not. */
    RETRY_LOOKUP.delete(b.id);
    go({ kind: "brand", id: b.id });     // re-render without the lookup panel
  };

  document.getElementById("lookup-skip").addEventListener("click", openEditor);

  const run = async () => {
    const tick = document.getElementById("brand-details");
    const url = asUrl(input.value.trim());
    if (!url) {
      msg.textContent = input.value.trim()
        ? "That's not a website — try lynxr.io, or add the details manually."
        : "Paste their website, or add the details manually.";
      msg.className = "lookup-hint";
      input.focus();
      return;
    }
    /* Rotating status while the read is in flight. These describe what the
       read ACTUALLY does — fetch the page, then pull out the name, what they
       sell, the niche and the audience — rather than claiming a numbered step
       is happening at a given moment. The fetch is most of the wall clock and
       the analysis is near-instant, so per-stage claims would be theatre; this
       is ambient and truthful about the job as a whole. */
    let phase = 0, phaseTimer = null;
    const PHASES = ["Reading their site", "Looking for what they sell",
                    "Working out their niche", "Finding who it's for"];
    const stopPhases = () => {
      clearInterval(phaseTimer); phaseTimer = null;
      document.getElementById("lookup-loader")?.setAttribute("hidden", "");
      const live = document.getElementById("lookup-msg");
      if (live) live.className = "lookup-hint";
    };
    if (tick) {
      // Swap the tick for a spinner and keep the button's own markup so the
      // tick comes back if the read fails. A dimmed, pulsing tick was not
      // legible as "working" — loader-glow animates opacity, which overrode
      // the static dim and left it flickering between full and near-full.
      tick.disabled = true;
      tick.dataset.face = tick.innerHTML;
      tick.innerHTML = `<svg class="ico spin" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.4" stroke-linecap="round" aria-hidden="true"
        ><path d="M12 3a9 9 0 1 0 9 9"/></svg>`;
      tick.setAttribute("aria-label", "Reading their site");
    }
    msg.textContent = PHASES[0];
    msg.className = "lookup-hint working";   // .working supplies the moving dots
    document.getElementById("lookup-loader")?.removeAttribute("hidden");
    // 2.6s, not 1.1s: at the old pace the words changed faster than they could
    // be read, which reads as flicker rather than progress.
    phaseTimer = setInterval(() => {
      phase = (phase + 1) % PHASES.length;
      const live = document.getElementById("lookup-msg");
      if (!live) return stopPhases();      // panel gone: nothing to write to
      live.textContent = PHASES[phase];
    }, 2600);
    try {
      const got = analyzeCompanySite(await readCompanySite(url), url);
      b.name = got.name || b.name;
      b.site = url;
      b.description = got.description || "";
      b.niche = got.niche || "";
      if (b.name) b.code = trackCode(b.name);
      save();
      // Straight into the normal view: the panel is gone, the fields are
      // filled, and Details is there to correct anything that came back wrong.
      stopPhases();
      RETRY_LOOKUP.delete(b.id);
      POINT_AT_DETAILS = true;
      go({ kind: "brand", id: b.id });
    } catch {
      /* The read failed — plenty of sites block automated readers. Don't leave
         them sitting on a panel that just failed with nothing to do but press
         the same button again: move them to the manual form, which is the
         thing that still works.

         The URL is KEPT. It is probably correct — the reader is what failed —
         and it goes to the model with every script, so throwing it away would
         cost them something for a failure that was ours. Keeping it also means
         the Website field shows on the manual form, so they can see and fix it.

         No need to restore the tick here: go() re-renders the header. */
      stopPhases();
      RETRY_LOOKUP.delete(b.id);
      b.site = url;
      save();
      BRAND_MANUAL.add(b.id);
      go({ kind: "brand", id: b.id });
      flashMsg("brand-flash", "Couldn't read that site — add the details here.", "bad");
    }
  };

  BRAND_LOOKUP_RUN = run;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); run(); }
  });
  if (window.matchMedia("(min-width: 761px)").matches) input.focus();
}

// ---------- brand view ----------
function renderBrand(head, body, b) {
  const scripts = brandScripts(b);
  const ready = scripts.filter((a) => a.status === "done" && a.adaptation).length;
  const writing = scripts.filter(isWriting).length;

  head.innerHTML = `
    <button type="button" class="side-toggle" id="side-open" aria-label="Menu" title="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <div class="pane-title">
      <div class="bcard-title" id="brand-heading">${escapeHtml(b.name || "Untitled brand")}</div>
      ${/* No standing script COUNT here any more — the list of scripts is
            directly below and counts itself, and on a phone that chip pushed
            Details and the bin onto a second line.
            The "writing" chip stays, because it is not a count: it is the only
            sign that something is in progress on a page that would otherwise
            look finished while a script is still being written. */""}
      ${writing ? `<span class="chip bp-wait"><i class="bp-dot"></i>${writing} writing</span>` : ""}
      <div class="spacer"></div>
      <button type="button" class="ghost" id="brand-details">Details</button>
      <button type="button" class="ghost danger icon-only b-del" title="Delete this brand"
        aria-label="Delete this brand"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>
    </div>
    ${/* Arrow LAST so it lands under Details. Leading with it put the arrow at
          the start of the row, ~170px to the left of the button it means. */""}
    <p class="detail-point" id="detail-point" hidden>Brand details are in here<svg
      class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      ><path d="M12 19V5M5 12l7-7 7 7"/></svg></p>
    <p class="pane-sub" id="brand-sub">${escapeHtml(b.niche || "No niche set")}${
      b.objective ? " · " + escapeHtml(b.objective) : ""} · ${plural(scripts.length, "script")}</p>`;

  // A brand nobody has filled in yet asks for ONE thing: the website. Every
  // other field is something the company already says about itself on its own
  // homepage, and a creator typing it from memory produces a worse answer than
  // the source does. The full editor is one click away behind Details, and
  // opens automatically the moment the lookup finishes or is skipped.
  // Once the brand has a name it is SET UP, and the website panel is never
  // shown again — editing a live brand happens in Details, by hand. Re-reading
  // a site would silently overwrite a name, description and niche the creator
  // may have corrected themselves, which is not a thing a "back" button should
  // be able to do.
  const named = !!(b.name || "").trim();
  const fresh = !named
    && (RETRY_LOOKUP.has(b.id) || (!b.site && !BRAND_MANUAL.has(b.id)));
  // Offered while the brand is still unnamed — naming it is what the panel is
  // for. After a failed read the site IS set (we keep what was typed), so the
  // old `!b.site` condition hid the way back exactly when it was most wanted.
  const backToLookup = !fresh && !named;
  const readFailed = backToLookup && !!b.site;

  body.innerHTML = `
    <p class="composer-note" id="brand-flash" role="status" aria-live="polite"></p>
    ${fresh ? `
    <div class="section lookup" id="brand-lookup">
      <p class="lookup-label">Brand website</p>
      <input type="text" class="b-lookup" autocomplete="off" spellcheck="false"
        value="${escapeHtml(b.site || "")}" placeholder="lynxr.io">
      <p class="lookup-hint" id="lookup-msg"></p>
      ${/* The app's established loading mark, not a second invention: the X
            split into four arms that scale out of the centre in clockwise
            turn. Same markup and animation the agency app uses while it reads
            a client site — the identical job, so the identical signal. */""}
      <div class="lookup-loader" id="lookup-loader" hidden>${loaderMark()}</div>
    </div>
    ${/* Outside the box, mirroring "use their website instead" on the manual
          form. The two panels are one choice seen from either side, so the way
          across sits in the same place on both — under the card, not inside it.
          Leaving the panel is not one of the panel's own fields. */""}
    <button type="button" class="linkish b-back-link" id="lookup-skip">Add manually</button>` : ""}
    <div class="section client-editor${fresh ? " collapsed" : " collapsed"}" id="brand-editor">
      <div class="ce-body">
        <div class="ce-grid">
          <label class="ce-field"><span class="lbl">Brand name</span>
            <input type="text" class="b-name" value="${escapeHtml(b.name || "")}" placeholder="e.g. lynxr"></label>
          ${/* Only shown once there IS one — i.e. the lookup found it. Asking for
                a website on the manual form is asking the question the lookup
                already exists to answer, and anyone on this form got here by
                saying they did not have one. */""}
          ${b.site ? `<label class="ce-field"><span class="lbl">Website</span>
            <input type="url" class="b-site" value="${escapeHtml(b.site)}" placeholder="https://…"></label>` : ""}
          <label class="ce-field ce-wide"><span class="lbl">What is it?</span>
            <textarea class="b-desc grow" rows="1"
              placeholder="e.g. scripts for UGC creators">${escapeHtml(b.description || "")}</textarea></label>
          <label class="ce-field"><span class="lbl">Campaign objective</span>
            <input type="text" class="b-obj" value="${escapeHtml(b.objective || "")}" placeholder="e.g. creator sign-ups"></label>
          <label class="ce-field"><span class="lbl">Niche</span>
            <input type="text" class="b-niche" value="${escapeHtml(b.niche || "")}" placeholder="e.g. Creator tools"></label>
        </div>
        <p class="bp-msg" id="brand-msg" role="status" aria-live="polite"></p>
      </div>
    </div>
    ${/* BELOW the box, not inside it. Leaving the form is not one of the form's
          fields, and sitting above "Brand name" it read as a heading for the
          panel it takes you out of. The arrow says which direction you are
          going — this returns to the website panel you came from. */""}
    ${backToLookup ? `<button type="button" class="linkish b-back-link" id="b-back-lookup"
      >&larr; ${readFailed ? "Try again" : "Use their website instead"}</button>` : ""}
    ${/* Hidden until the brand has a name. A script is written FOR a company,
          so offering "add a script" before there is one to write for is an
          invitation to a refusal — better not to offer it at all than to shake
          the form at someone who took us up on it. */""}
    ${(b.name || "").trim() ? `
    <div class="lib-head">
      <h2>Scripts <span class="pill">${scripts.length}</span></h2>
      <button type="button" class="lib-plus" id="brand-add" title="New script" aria-label="New script">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
          aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
    <div id="ad-list"></div>` : ""}`;

  document.getElementById("side-open").addEventListener("click", () =>
    document.body.classList.toggle("side-open"));

  const editor = document.getElementById("brand-editor");
  const toggle = document.getElementById("brand-details");
  // Open the full editor for a half-set-up brand — unless the lookup panel is
  // showing, which is the one question we want answered first.
  if (!b.name && !fresh) editor.classList.remove("collapsed");
  BRAND_LOOKUP_RUN = null;          // cleared first: a stale handle from the
  if (fresh) wireBrandLookup(b);    // previous brand would run against it

  if (POINT_AT_DETAILS) { POINT_AT_DETAILS = false; showDetailPoint(); }
  document.getElementById("b-back-lookup")?.addEventListener("click", () => {
    BRAND_MANUAL.delete(b.id);
    RETRY_LOOKUP.add(b.id);          // brings the panel back even with a site set
    go({ kind: "brand", id: b.id });
  });

  // "What is it?" wraps instead of scrolling sideways. A collapsed editor is
  // display:none, where every measurement is 0, so re-fit when it opens.
  const fitDesc = () => autoGrow(editor.querySelector(".b-desc"));

  // A brand is set up once, and the toggle above the empty fields used to read
  // "Done" — which names a state, not an action, so it reads as a label on
  // finished work rather than the button you press to keep what you typed.
  // People filled the form in and navigated away past it. Until the brand has
  // been through setup once it says "Save" and carries the solid fill, so it
  // is the most obvious thing in the row. (Every keystroke is already saved;
  // this is the confirmation people look for, and its absence read as loss.)
  let firstRun = !b.name;
  const syncToggle = () => {
    const open = !editor.classList.contains("collapsed");
    // Save is a green tick, matching the red trash below it. "Done" and
    // "Details" stay words — they name a place to go, which an icon cannot.
    if (firstRun) {
      toggle.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M4 12.5l5.5 5.5L20 7"/></svg>`;
      toggle.title = "Save this brand";
      toggle.setAttribute("aria-label", "Save this brand");
    } else {
      toggle.textContent = open ? "Done" : "Details";
      toggle.removeAttribute("title");
      toggle.removeAttribute("aria-label");
    }
    toggle.classList.toggle("icon-only", firstRun);
    toggle.classList.toggle("good", firstRun);
    toggle.classList.toggle("pane-save", false);
  };
  syncToggle();
  fitDesc();

  /* SETTING A BRAND UP MEANS FILLING IT IN.
     Every field on this form is rendered only when it applies — Website, for
     instance, appears only when the lookup found one — so "all the inputs" is
     literally every input and textarea still standing in the editor. No list of
     field names to keep in step with the markup.

     Enforced on the SAVE press only, not on "Done" for a brand that already
     exists. That is not squeamishness: 2 of the 4 brands on live accounts are
     missing `objective` and `niche` (they predate those fields). Gating "Done"
     on completeness would open the editor on one of those brands and refuse to
     let the creator back out of it — a trap, on their own data. They still get
     the fields marked, so it is fixable; it just isn't compulsory. */
  const editorFields = () =>
    [...editor.querySelectorAll(".ce-field input, .ce-field textarea")];

  /** Marks every empty field and returns the first, or null when all are set. */
  const markEmpty = () => {
    let first = null;
    editorFields().forEach((el) => {
      const empty = !el.value.trim();
      el.classList.toggle("ce-missing", empty);
      if (empty && !first) first = el;
    });
    return first;
  };
  // Clear a field's flag the moment it stops being empty, so the form stops
  // shouting while you are still fixing it.
  editor.addEventListener("input", (e) => {
    if (e.target.value.trim()) e.target.classList.remove("ce-missing");
  });

  toggle.addEventListener("click", () => {
    // With the lookup panel up, the tick IS "read this website and set the
    // brand up". It re-renders on success, so nothing below this runs.
    if (BRAND_LOOKUP_RUN) { BRAND_LOOKUP_RUN(); return; }
    const open = !editor.classList.contains("collapsed");
    if (firstRun && open) {
      const missing = markEmpty();
      if (missing) {
        // The label goes in verbatim and in quotes. Lower-casing it read as
        // "Fill in what is it? — …", because one of these labels is a question.
        const label = missing.closest(".ce-field")?.querySelector(".lbl")?.textContent || "every field";
        const left = editorFields().filter((el) => !el.value.trim()).length;
        flashMsg("brand-msg", `Fill in “${label}”${left > 1 ? ` and ${left - 1} more` : ""} — every field feeds the script.`, "bad");
        missing.focus();
        return;                                // refuse: the editor stays open
      }
    }
    const wasSetup = firstRun;                 // this press was "Save"
    editor.classList.toggle("collapsed");
    if (firstRun && editor.classList.contains("collapsed")) firstRun = false;
    /* Saving a brand for the first time RE-RENDERS, rather than just collapsing
       the editor. The Scripts heading and its + button are emitted only once the
       brand has a name — and when this page was built it had none, so pressing
       Save left a brand with no way to add a script to it until you navigated
       away and came back. (It showed "Brand details are in here ↑" above an
       empty page, which read as the save having failed.)

       This is the same move the successful website read makes below: set
       POINT_AT_DETAILS, then go(). Both routes now end in the same place. */
    if (wasSetup && editor.classList.contains("collapsed")) {
      POINT_AT_DETAILS = true;
      go({ kind: "brand", id: b.id });
      return;                                  // the DOM below is gone
    }
    syncToggle();
    fitDesc();
  });

  // Bind, don't re-render — the creator is mid-word in these fields.
  //
  // Resolve the brand by ID on every keystroke rather than closing over the
  // object. pull() rebuilds ME from the server response, so every brand object
  // is REPLACED on each sync; a handler holding the old one then writes into a
  // detached copy that save() never sends. That is why company details silently
  // failed to stick — and the `editing` guard below made it permanent, because
  // it skips the re-render (and therefore the rebind) precisely while you type.
  const bind = (sel, key) => {
    const el = editor.querySelector(sel);
    // Not every field is always rendered — Website only appears once there is
    // one. Without this guard a missing field throws here and takes the whole
    // editor down with it.
    if (!el) return;
    el.addEventListener("input", (e) => {
      const live = brandById(b.id);
      if (!live) return;               // deleted on another device mid-edit
      live[key] = e.target.value;
      if (key === "name") {
        document.getElementById("brand-heading").textContent = live.name || "Untitled brand";
        renderSide();
      }
      save();
    });
    // Trim on BLUR, never on input: trimming mid-keystroke makes it impossible
    // to type a space between two words, because the space is eaten the moment
    // it is typed. Without this pass a pasted name keeps its padding — one live
    // account carries a brand called "Medceptor " with a trailing space, which
    // then reads as a different company everywhere the name is compared.
    el.addEventListener("blur", () => {
      const live = brandById(b.id);
      if (!live) return;
      const trimmed = (live[key] || "").trim();
      if (trimmed === live[key]) return;
      live[key] = trimmed;
      el.value = trimmed;
      if (key === "name") {
        document.getElementById("brand-heading").textContent = live.name || "Untitled brand";
        renderSide();
      }
      save();
    });
  };
  bind(".b-name", "name"); bind(".b-site", "site"); bind(".b-desc", "description");
  bind(".b-obj", "objective"); bind(".b-niche", "niche");
  wireGrow(editor.querySelector(".b-desc"));

  // Same plus as the Library's, and it does one thing more: standing in a
  // company is the answer to "who is this for", so it arrives at the composer
  // with this company already ticked instead of asking again.
  // Only rendered once the brand has a name, so there is nothing to guard
  // against here any more — the optional chaining covers the unnamed case.
  document.getElementById("brand-add")?.addEventListener("click", () => {
    COMPOSE_FOR = new Set([b.id]);
    go({ kind: "new" });
  });

  // Deleting a brand takes its scripts — to the trash, not to nothing, so a
  // mistyped company name deleted in a hurry doesn't cost a dozen scripts.
  // The videos stay in the Library: they were yours before any brand existed.
  // Two buttons, one action. The editor's Delete is unreachable while the
  // lookup panel is up (the editor is collapsed behind Details), so a brand
  // made by mistake had no way out of this screen — and the "name your other
  // brand first" guard meant it also blocked making another one.
  const removeBrand = () => {
    ME.brands = ME.brands.filter((x) => x.id !== b.id);
    trashAdaptations((a) => a.brandId === b.id);
    save({ now: true });
    // Deleting the last brand used to land on the Library, which is a list of
    // what you have saved — the least useful answer to "I just cleared this
    // out." The new-script page is where the next thing starts, so go there.
    go(ME.brands.length ? { kind: "brand", id: ME.brands[0].id } : { kind: "new" });
  };
  armDelete(head.querySelector(".b-del"), "Delete this brand", removeBrand);


  renderScripts(b);
}

// ---------- New script ----------
// One place to send a link, and the record of everything ever sent. A video
// belongs to the creator, not to a brand: the same link scripted for three
// companies is still one entry here, listing where each script went.
let LIB_Q = "";
// "brand" answers "what does this client have?"; "all" answers "what have I
// saved?". Both are real questions, so the Library offers both rather than
// picking one. Not persisted — it resets to By company each visit.
let LIB_MODE = "brand";
const LIB_SEARCH_AT = 4;      // searching three items is noise; the box stays hidden

/** Scope sentinel for libraryItemHtml: show only the scripts that belong to NO
 *  company. A Symbol rather than a magic string — it cannot collide with a real
 *  brand id no matter how ids are generated later, and it stays truthy, which
 *  matters because a falsy scope already means "show every script on this
 *  video". */
const SCOPE_ORIGINAL = Symbol("original scripts only");

function renderLibrary(head, body) {
  head.innerHTML = `
    <button type="button" class="side-toggle" id="side-open" aria-label="Menu" title="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    ${/* The + sits on the title row, not down with the tabs. On a phone it had
          a line of its own between the tabs and the first video, which read as
          a stray control belonging to neither. Up here it pairs with the
          heading it acts on, and the tabs get the full width back. */""}
    <div class="pane-title"><div class="bcard-title">Library</div>
      <span class="pill">${ME.library.length}</span>
      <div class="spacer"></div>
      <button type="button" class="lib-plus" id="lib-add" title="New script" aria-label="New script">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
          aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button></div>
    <p class="pane-sub">Every video you've sent.</p>`;

  document.getElementById("side-open").addEventListener("click", () =>
    document.body.classList.toggle("side-open"));

  body.innerHTML = `
    <div class="section">
      <div class="lib-head">
        <div class="lib-modes" role="tablist" aria-label="How to group the library">
          <button type="button" class="lib-mode${LIB_MODE === "brand" ? " on" : ""}"
            id="lib-mode-brand" role="tab" aria-selected="${LIB_MODE === "brand"}">By brand</button>
          <button type="button" class="lib-mode${LIB_MODE === "all" ? " on" : ""}"
            id="lib-mode-all" role="tab" aria-selected="${LIB_MODE === "all"}">All videos</button>
          ${/* The third question this list answers: "what did the video itself
                say?" — the scripts that belong to no company. They are otherwise
                only visible as a loose block at the bottom of By company, which
                is where they go to be missed. */""}
          <button type="button" class="lib-mode${LIB_MODE === "original" ? " on" : ""}"
            id="lib-mode-original" role="tab" aria-selected="${LIB_MODE === "original"}">Original scripts</button>
        </div>
      </div>
      <p class="composer-note" id="lib-flash" role="status" aria-live="polite"></p>
      ${ME.library.length >= LIB_SEARCH_AT ? `<div class="lib-tools">
        <input type="search" id="lib-q" placeholder="Search titles, captions, creators"
          autocomplete="off" spellcheck="false" value="${escapeHtml(LIB_Q)}">
        <span class="lib-shown" id="lib-shown"></span>
      </div>` : ""}
      <div id="lib-list"></div>
    </div>`;

  document.getElementById("lib-add").addEventListener("click", () => go({ kind: "new" }));
  const setMode = (m) => { LIB_MODE = m; renderLibrary(head, body); };
  document.getElementById("lib-mode-brand").addEventListener("click", () => setMode("brand"));
  document.getElementById("lib-mode-all").addEventListener("click", () => setMode("all"));
  document.getElementById("lib-mode-original").addEventListener("click", () => setMode("original"));

  const qEl = document.getElementById("lib-q");
  if (qEl) qEl.addEventListener("input", (e) => {
    LIB_Q = e.target.value;
    paintLibraryList();
    const again = document.getElementById("lib-q");
    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  });

  paintLibraryList();
}

/** Just the list — so a keystroke in the search box does not rebuild the
    composer underneath the cursor. */
function paintLibraryList() {
  const host = document.getElementById("lib-list");
  if (!host) return;

  if (!ME.library.length) {
    host.innerHTML = `<div class="empty lib-empty">
      ${emptyDemo()}
      <p><strong>Nothing in your library yet.</strong></p>
      <p>Find a video worth remaking, paste the link, and pick who it's for. We write the script
      and it shows up here — one entry per video, however many companies you script it for.</p>
      <div class="bp-actions"><button type="button" class="btn" id="lib-empty-cta">Add your first script</button></div>
    </div>`;
    host.querySelector("#lib-empty-cta").addEventListener("click", () => go({ kind: "new" }));
    return;
  }

  // Backfills captions for entries that never got one. Deliberately not
  // awaited: the list paints now and each name drops in as it arrives.
  hydrateStale();

  const q = LIB_Q.trim().toLowerCase();
  const shown = ME.library.filter((it) => !q || [it.title, it.caption, it.creator, it.url]
    .some((v) => String(v || "").toLowerCase().includes(q)));

  const tally = document.getElementById("lib-shown");
  if (tally) tally.textContent = shown.length === ME.library.length ? "" : `${shown.length} of ${ME.library.length}`;

  if (!shown.length) {
    host.innerHTML = `<div class="empty"><p>Nothing you've sent matches that.</p></div>`;
    return;
  }

  if (LIB_MODE === "brand") {
    // One block per company, so "what does Cloey actually have?" is answerable
    // at a glance. A video reused across three companies appears under each —
    // that repetition IS the answer to the question this view asks.
    const blocks = ME.brands.map((b) => {
      const items = shown.filter((it) => libScripts(it).some((a) => a.brandId === b.id));
      if (!items.length) return "";
      const ready = ME.adaptations.filter((a) => a.brandId === b.id && a.status === "done").length;
      const busy = ME.adaptations.filter((a) => a.brandId === b.id && isWriting(a)).length;
      return `<section class="lib-group">
        <div class="lib-group-head">
          <button type="button" class="lib-group-name linkish" data-bid="${escapeHtml(b.id)}">${
            escapeHtml(b.name || "Untitled company")}</button>
          <span class="lib-group-meta">${ready} ready${busy ? ` · ${busy} writing` : ""}</span>
        </div>
        <div class="bp-list">${items.map((it) => libraryItemHtml(it, b.id)).join("")}</div>
      </section>`;
    }).filter(Boolean).join("");

    // Videos saved but never scripted for anyone still need a home here, or
    // they are invisible in this view.
    //
    // Scripts that belong to NO brand deliberately do NOT get a block here any
    // more — this view is brands, and they have their own tab now. They used to
    // appear as a loose "Original scripts" group, which put the same name in two
    // places on one screen.
    const orphans = shown.filter((it) => !libScripts(it).length);

    const loose = (title, items, meta) => items.length ? `<section class="lib-group">
      <div class="lib-group-head">
        <span class="lib-group-name">${title}</span>
        <span class="lib-group-meta">${items.length} ${meta}</span>
      </div>
      <div class="bp-list">${items.map((it) => libraryItemHtml(it)).join("")}</div>
    </section>` : "";

    host.innerHTML = (blocks + loose("Not scripted yet", orphans, "saved"))
      || `<div class="empty"><p>No scripts yet. Send a link and they'll group by brand here.</p></div>`;
    host.querySelectorAll(".lib-group-name[data-bid]").forEach((el) =>
      el.addEventListener("click", () => go({ kind: "brand", id: el.dataset.bid })));
  } else if (LIB_MODE === "original") {
    /* Every video that has an original script — NOT just the ones whose only
       script is original. A video can be scripted for a company AND have the
       video's own words kept; asking for original scripts should show that one
       too. (The loose block in By company mode is deliberately narrower: there
       its job is to catch what no company block would show.)
       SCOPE_ORIGINAL then hides the brand scripts inside the card, so the tab
       shows what it says it shows. */
    const items = shown.filter((it) => libScripts(it).some((a) => !a.brandId));
    host.innerHTML = items.length
      ? `<div class="bp-list">${items.map((it) => libraryItemHtml(it, SCOPE_ORIGINAL)).join("")}</div>`
      : `<div class="empty"><p><strong>No original scripts yet.</strong></p>
          <p>Send a link without picking a company and you'll get the video's own
          words, shots and structure back.</p></div>`;
  } else {
    host.innerHTML = `<div class="bp-list">${shown.map((it) => libraryItemHtml(it)).join("")}</div>`;
  }
  stopSummaryLinks(host);
  // The Library now renders real script cards inside its entries, so they need
  // the same Copy / Rewrite / Delete wiring the brand pages give them. Without
  // this every button inside a nested script is inert.
  wireAdaptationCards(host);
  wireDisclosureMotion(host);

  /* ONE VIDEO OPEN AT A TIME, for the same reason as one script: an open entry
     runs to a screen or more, so two at once means scrolling past the first to
     find out what the second even is.
     Matched on data-lid, not on identity: "By brand" renders the SAME video
     once under every brand that has a script from it, and those copies are one
     thing. Closing a video's own twin would fight alsoWriteFor(), which
     deliberately reopens every copy after writing a new script. */
  const entries = [...host.querySelectorAll("details.lib-item")];
  entries.forEach((d) => d.addEventListener("toggle", () => {
    if (!d.open) return;
    entries.forEach((other) => {
      if (other.dataset.lid !== d.dataset.lid) other.open = false;
    });
  }));

  host.querySelectorAll(".lib-item").forEach((card) => {
    const item = ME.library.find((l) => l.id === card.dataset.lid);
    if (!item) return;

    // One tap = one more script from a video already saved. Keeping the card
    // open across the repaint matters: the creator is usually adding two or
    // three companies in a row and a collapsing card loses their place.
    card.querySelectorAll(".lib-also-b").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      const co = brandById(btn.dataset.bid);
      await alsoWriteFor(item, [btn.dataset.bid], () => {
        paintLibraryList();
        // By company mode renders the same video under every company that has a
        // script from it, so there can be several copies of this card. Reopen
        // all of them — querySelector would pick an arbitrary one and collapse
        // the card the creator was actually working in.
        document.querySelectorAll(`.lib-item[data-lid="${CSS.escape(item.id)}"]`)
          .forEach((el) => { el.open = true; });
      });
      flashMsg("lib-flash", `Writing it for ${co ? co.name : "that company"} — it'll appear here.`, "good");
    }));
    /* Delete the video and everything written from it. Scoped to `card`, not
       the document: in "by brand" mode one video renders under every company
       that has a script from it, so there are several .l-del buttons for the
       same entry and a document-wide query would wire the wrong one.

       The scripts go to Trash rather than vanishing — same as deleting them
       one by one — so this is recoverable. The library row itself is dropped,
       because an entry whose video you removed has nothing left to point at. */
    const del = card.querySelector(".l-del");
    if (del) armDelete(del, "Delete video", () => {
      trashAdaptations((a) => a.libraryId === item.id
        || (!a.libraryId && a.sourceUrl && canonUrl(a.sourceUrl) === item.canon));
      ME.library = ME.library.filter((l) => l.id !== item.id);
      save(); renderSide(); renderPane();
    });
  });
}

/** One saved video as a card.
 *
 *  `scopeBrandId` is set when the card is rendered inside a company's group:
 *  the status chip and the script list then describe THAT company only.
 *  Without it a video scripted for two companies showed the same "writing 1"
 *  chip under both, so a finished Cloey script read as still being written
 *  because Medceptor's copy was — the exact question this view exists to
 *  answer, answered wrongly. */
function libraryItemHtml(item, scopeBrandId) {
  const all = libScripts(item);
  const made = scopeBrandId === SCOPE_ORIGINAL ? all.filter((a) => !a.brandId)
    : scopeBrandId ? all.filter((a) => a.brandId === scopeBrandId)
    : all;
  const spare = brandsWithout(item);
  const href = safeUrl(item.url || "");
  const waiting = made.filter(isWriting).length;
  const done = made.filter((a) => a.status === "done").length;
  const chip = !made.length ? `<span class="chip">not scripted</span>`
    : waiting ? `<span class="chip bp-wait"><i class="bp-dot"></i>writing ${waiting}</span>`
    : done ? `<span class="chip good">${plural(done, "script")}</span>`
    : `<span class="chip bad">couldn't fetch</span>`;

  return `<details class="bp-item lib-item" data-lid="${escapeHtml(item.id)}">
    <summary>
      <span class="bp-caret" aria-hidden="true">▸</span>
      ${thumbHtml(coverUrl({ libraryId: item.id, canon: item.canon }), sourceLabel(item))}
      <span class="bp-name">${escapeHtml(sourceLabel(item))}</span>
      <span class="chip lib-plat">${escapeHtml(item.platform || "Link")}</span>
      ${chip}
      <span class="bp-when">${escapeHtml(agoLabel(item.addedAt))}</span>
      ${href ? `<a class="bp-open" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open the original">↗</a>` : ""}
    </summary>
    <div class="bp-body">
      ${item.creator ? `<p class="bp-hint">@${escapeHtml(item.creator)}</p>` : ""}
      ${item.caption ? `<p class="bp-hint lib-cap">${escapeHtml(item.caption)}</p>` : ""}
      ${/* THE SCRIPT ITSELF, right here. This used to be a list of links, each
            one navigating away — to a brand page, or to a standalone originals
            page that has since been deleted — so reading a script you were
            already looking at cost two clicks and a change of scene. The card
            is the same one the brand pages render, so nothing about a script
            looks or behaves differently for being inline.

            A single script opens expanded: you opened the video to read it.
            Several stay collapsed, because then the list IS the choice. */""}
      ${/* No "N scripts from this" heading: the entry's own summary already
            carries a "1 script" chip, so the heading restated the count
            directly under it. The scripts are self-evidently the scripts. */""}
      ${made.length ? `<div class="bp-list lib-scripts">${made.map((a) => adaptationHtml(
            a, a.brandId ? (brandById(a.brandId) || {}).name : null,
            { nested: true, bare: made.length === 1 }
          )).join("")}</div>`
        : `<p class="bp-hint">No script from this one yet.</p>`}

      ${spare.length ? `<div class="bp-heading">Also write this for</div>
        <div class="chips lib-also">${spare.map((b) => `
          <button type="button" class="chip pick lib-also-b" data-bid="${escapeHtml(b.id)}"
            >+ ${escapeHtml(b.name)}</button>`).join("")}</div>`
        : ""}
      ${/* "All your brands already have this one." used to sit here when there
            was nobody left to offer. It stated the absence of an option nobody
            was looking for — the chips simply not being there says it, and
            says it without a line of text. */""}
      ${/* The entry's own delete, back after a spell without one. Removing it
            left videos with NO script — the "not scripted" rows — with no way
            out of the Library at all, since the only delete lived inside a
            script card that those entries do not have.

            "Delete video" against a script card's plain "Delete": the noun is
            the whole difference, and it is enough. That was the real problem
            the first time round — two buttons both saying "delete" inside a
            box-in-a-box, where it was genuinely unclear which one took what.
            The nesting is flat now and the labels name their own scope. */""}
      ${/* Deleting is PER SCRIPT: each card carries its own trash, and an entry
            that has scripts shows no entry-level delete at all. A second trash
            underneath them removed the whole video, and nothing about the two
            icons said which was which.

            The one exception is an entry with NO scripts — the "not scripted"
            rows. Their only delete would live inside a script card they do not
            have, so without this they could never leave the Library. It is also
            the only case where the two cannot be confused: there is nothing
            else to delete. */""}
      ${!made.length ? `<div class="bp-actions">
        <button type="button" class="ghost danger icon-only l-del"
          aria-label="Delete this video" title="Delete this video">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
        </button>
      </div>` : ""}
    </div>
  </details>`;
}

// ---------- you ----------
function renderYou(head, body) {
  head.innerHTML = `
    <button type="button" class="side-toggle" id="side-open" aria-label="Menu" title="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <div class="pane-title"><div class="bcard-title">Settings</div></div>
    <p class="pane-sub">Goes into every script, so it sounds like you.</p>`;
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
        ${/* No "best email" field: the address is already collected at sign-in,
              and asking again produced a second address to keep in step with
              the first for no benefit. `contactEmail` stays in the record —
              anyone who set one keeps it, and the feedback form still prefers
              it — there is just no longer a way to set a new one. */""}
        <label class="ce-field"><span class="lbl">Can we email you about lynxr?</span>
          <select id="me-optin">
            <option value="no"${ME.emailOptIn ? "" : " selected"}>No — account emails only</option>
            <option value="yes"${ME.emailOptIn ? " selected" : ""}>Yes — updates and questions are fine</option>
          </select></label>
      </div>
      <button type="button" class="btn" id="me-save">Save</button>
      <p class="bp-msg" id="me-msg" role="status" aria-live="polite"></p>
    </div>

    <div class="section">
      <h2>Trash <span class="pill">${(ME.trash || []).length}</span></h2>
      <div id="trash-list"></div>
    </div>

    <div class="section">
      <h2>Account</h2>
      ${/* Which account you are signed into, ABOVE the buttons that act on it.
            It sat below them, which meant "sign out" and "delete account"
            appeared before the thing they would sign out of or delete — you
            read the action, then found out whose account it was. */""}
      ${SB_EMAIL ? `<p class="note me-who">${escapeHtml(SB_EMAIL)}</p>` : ""}
      ${/* .me-actions opts this row out of the phone rule that makes action
            buttons grow to fill the row. That rule is right on a script card,
            where the buttons are the point and want big tap targets — here it
            stretched "delete account" to several times the width of "sign out",
            making the irreversible one the largest thing on the page. */""}
      <div class="bp-actions me-actions">
        ${/* Plain ghost, not .danger. Signing out is reversible — you log back
              in — so red was overstating it, and with a genuinely destructive
              Delete account sitting beside it, two red buttons made the one
              that cannot be undone no louder than the one that can. */""}
        <button type="button" class="ghost" id="signout">Sign out</button>
        <button type="button" class="ghost danger" id="account-del">Delete account</button>
        ${/* IN the button row, not on a line of its own below it — pushed to the
              far right and bottom-aligned, so it sits level with the buttons
              instead of floating in the gap underneath them.

              The gate links the policy too, but a creator who signed up months
              ago never sees the gate again, and this is the page they come to
              when they want to know what happens to their data.

              NOT .gate-fine — that class sets `border-bottom` on its links, and
              the phone rule adds padding plus a text underline for the tap
              target. Both drew, so every link had two lines under it: the
              underline against the text and the border at the bottom of the
              padding box. .me-links owns its style so only one can win.

              rel="noopener noreferrer" on the socials: they open in a new tab,
              and noreferrer keeps this app's unlisted URL out of the Referer
              header sent to tiktok and instagram. */""}
        <span class="me-links">
          <a href="https://www.instagram.com/lynxr.io/" target="_blank" rel="noopener noreferrer">instagram</a>
          <span class="x-sep">&middot;</span>
          <a href="https://www.tiktok.com/@lynxr.io" target="_blank" rel="noopener noreferrer">tiktok</a>
          <span class="x-sep">&middot;</span>
          <a href="/privacy/" target="_blank" rel="noopener">privacy policy</a>
        </span>
      </div>
      <p class="note" id="del-msg" role="status" aria-live="polite"></p>
    </div>`;

  renderTrash();

  // Single click: signing out is reversible, so the two-click arm the repo
  // uses for real deletes would just be friction. It already sits behind a
  // page rather than in the rail, which is the protection that matters.
  document.getElementById("signout").addEventListener("click", () => {
    clearSession();
    location.reload();
  });

  /* Deleting the account. Two-click armed, like every other destructive action
     here — and unlike Sign out beside it, because this one cannot be undone.
     (No confirm(): browsers suppress a repeated dialog and it returns false
     instantly, which would silently turn "delete" into "do nothing".)

     The work happens in Postgres. delete_own_account() is SECURITY DEFINER and
     takes no arguments, so it can only ever delete auth.uid() — the caller. The
     account row goes, and lynxr_creators follows it via ON DELETE CASCADE, so
     the brands, library, scripts and trash go with it. Nothing is left behind
     for us to clean up by hand, which is what the privacy page promises. */
  armDelete(document.getElementById("account-del"), "Delete account", async () => {
    const btn = document.getElementById("account-del");
    btn.disabled = true;
    flashMsg("del-msg", "Deleting your account…");
    try {
      const res = await sbFetch("/rest/v1/rpc/delete_own_account", { method: "POST" });
      // PGRST202 is "function not found" — supabase/delete_account.sql has not
      // been run in this project. Name it precisely: everything else here looks
      // identical to a network failure from the browser, and "try again" would
      // be wrong advice for a deployment step that will never fix itself.
      if (!res.ok) {
        const why = await res.text();
        flashMsg("del-msg", why.includes("PGRST202")
          ? "Account deletion isn't switched on yet — email us and we'll do it by hand."
          : "That didn't go through. Try again, or email us.", "bad");
        btn.disabled = false;
        return;
      }
      // The account is gone, so the session it belongs to is meaningless. Clear
      // it locally before reloading, or the app boots holding a token for a
      // user that no longer exists.
      clearSession();
      location.reload();
    } catch {
      flashMsg("del-msg", "That didn't go through — check your connection.", "bad");
      btn.disabled = false;
    }
  });

  document.getElementById("me-save").addEventListener("click", () => {
    ME.name = document.getElementById("me-name").value.trim();
    ME.niches = document.getElementById("me-niches").value.split(",").map((x) => x.trim()).filter(Boolean);
    ME.emailOptIn = document.getElementById("me-optin").value === "yes";
    save({ now: true });
    flashMsg("me-msg", "Saved.", "good");
  });

}

/** The trash list inside Settings. Restore puts a script back on its company;
 *  if that company is gone the script would have nowhere to live, so it is
 *  offered against the companies that still exist instead of failing. */
/** What a SCRIPT is called — in the Trash view and on the script cards alike.
    An adaptation carries its own copy of the title, taken when it was written,
    so one created before its caption loaded stored the old URL fallback — and
    both views rendered that copy directly.

    Resolved the way the Library does it: the live library entry first, because
    it may have hydrated since this script was thrown away; then the entry's own
    copy; then sourceLabel()'s platform wording. Matched on libraryId OR
    canonical URL, since a trash entry can outlive the library row it was made
    from and a sibling entry for the same video may still carry the caption. */
function entryLabel(a) {
  const url = a.sourceUrl || "";
  const canon = url ? canonUrl(url) : "";
  const item = (ME.library || []).find((l) =>
    l.id === a.libraryId || (canon && l.canon === canon));
  return realTitle(item && item.title) || realTitle(a.title)
    || sourceLabel({ url, platform: platformLabel(url), title: "",
                     creator: (item && item.creator) || "" });
}

function renderTrash() {
  const host = document.getElementById("trash-list");
  if (!host) return;
  const items = ME.trash || [];
  if (!items.length) {
    host.innerHTML = `<p class="bp-hint">Nothing deleted.</p>`;
    return;
  }
  // Same backfill the Library runs. Without it, Trash could only ever heal as a
  // side effect of visiting another view, and hydrate() now writes through to
  // ME.trash, so asking here is what makes these rows name themselves.
  hydrateStale();
  host.innerHTML = `<div class="bp-list">${items.map((a) => {
    const gone = !brandById(a.brandId);
    const ad = a.adaptation || {};
    /* The frame, same as everywhere else. Deciding what to restore off eight
       near-identical instagram.com/p/… URLs meant reading permalinks; the
       thumbnail is how you actually recognise which video it was.
       Falls back to coverUrl() because a trash entry keeps its own copy of
       `source` — if that copy predates covers, a sibling of the same video
       still has one (coverUrl already searches the trash as well as the live
       list), and thumbHtml renders nothing at all when neither does. */
    const cover = (a.source || {}).cover
      || coverUrl({ libraryId: a.libraryId, canon: a.sourceUrl ? canonUrl(a.sourceUrl) : "" });
    return `<div class="bp-item trash-row" data-adid="${escapeHtml(a.id)}">
      ${thumbHtml(cover, a.title || "")}
      ${/* .trash-main is a toggle on a phone only: the meta line is hidden there
            and tapping the title drops it down. On desktop the meta is always
            visible and the class this sets does nothing. */""}
      <div class="trash-main" data-adid="${escapeHtml(a.id)}">
        <div class="bp-name"><span class="trash-caret" aria-hidden="true">\u25b8</span>${escapeHtml(entryLabel(a))}</div>
        ${/* The hook is wrapped so the phone can drop it: it is the longest part
              of this line and the least useful when you are deciding whether to
              restore something. Brand and age stay. */""}
        <p class="bp-hint">${escapeHtml(a.brandName || "—")}${gone ? " · company deleted" : ""}
          · deleted ${escapeHtml(agoLabel(a.deletedAt))}${ad.hook ? `<span class="trash-hook"> · “${escapeHtml(ad.hook.slice(0, 60))}”</span>` : ""}</p>
      </div>
      <span class="trash-actions">
        ${(() => { const href = safeUrl(a.sourceUrl || "");
          return href ? `<a class="bp-open" href="${escapeHtml(href)}" target="_blank"
            rel="noopener noreferrer" title="Open the original video">\u2197</a>` : ""; })()}
        ${/* Icon + word. The phone hides the word (see .trash-restore-txt) so all
              three controls fit on the thumbnail's line instead of costing a
              whole extra row. */""}
        <button type="button" class="ghost trash-restore" data-adid="${escapeHtml(a.id)}" title="Restore">
          ${/* A bin with an arrow lifting out of it — "take this back out of the
                trash", rather than the generic undo curl, which reads as
                "revert an edit". Same 24-box and 1.8 stroke as the delete icon
                beside it, so the pair looks like a set. */""}
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M12 9V2"/><path d="M9 5l3-3 3 3"/><path d="M4 11h16"/><path
              d="M6 11l1 9a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-9"/></svg>
          <span class="trash-restore-txt">Restore</span>
        </button>
        ${/* Removes the script from YOUR trash only. The pasted video itself
              stays in lynxr_sources — that table is keyed by canonical URL and
              shared across every creator, so one person emptying their bin must
              never take a source row out from under the others. Same rule
              delete_account.sql already follows. */""}
        <button type="button" class="ghost danger icon-only trash-purge" data-adid="${escapeHtml(a.id)}"
          aria-label="Delete permanently" title="Delete permanently \u2014 the video stays in the shared library">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
        </button>
      </span>
    </div>`;
  }).join("")}</div>`;

  /* Permanent delete drops the entry from ME.trash and nothing else. It does
     NOT touch lynxr_sources: that row describes a public video, is keyed by
     canonical URL and is shared by every creator, so emptying one bin must not
     remove it for anyone else. Two-click armed, like every other destructive
     control here. */
  host.querySelectorAll(".trash-main").forEach((main) => main.addEventListener("click", () => {
    main.closest(".trash-row")?.classList.toggle("open");
  }));

  host.querySelectorAll(".trash-purge").forEach((btn) => armDelete(btn, "Delete permanently", () => {
    const i = (ME.trash || []).findIndex((x) => x.id === btn.dataset.adid);
    if (i < 0) return;
    ME.trash.splice(i, 1);
    save({ now: true });
    renderSide(); renderPane();
  }));

  host.querySelectorAll(".trash-restore").forEach((btn) => btn.addEventListener("click", () => {
    const i = (ME.trash || []).findIndex((x) => x.id === btn.dataset.adid);
    if (i < 0) return;
    const [a] = ME.trash.splice(i, 1);
    delete a.deletedAt;
    // Its company may have been deleted since. Rather than refuse, put it with
    // the first company that still exists and say so — the script is the
    // expensive part, and which folder it sits in is easy to change.
    if (!brandById(a.brandId) && (ME.brands || []).length) {
      a.brandId = ME.brands[0].id;
      a.brandName = ME.brands[0].name;
    }
    ME.adaptations.unshift(a);
    save({ now: true });
    renderSide(); renderPane();
    say(`Restored to ${a.brandName || "your scripts"}.`, "good");
  }));
}

function renderFeedback(head, body) {
  head.innerHTML = `
    <button type="button" class="side-toggle" id="side-open" aria-label="Menu" title="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <div class="pane-title"><div class="bcard-title">Feedback</div></div>
    <p class="pane-sub">Early software — tell us what's broken.</p>`;
  document.getElementById("side-open").addEventListener("click", () =>
    document.body.classList.toggle("side-open"));

  body.innerHTML = `
    <div class="section">
      <p class="lede"><strong>Send anything — especially the small stuff.</strong> Half a sentence
        is fine. The tiny annoyances are the ones we can't see from the inside.</p>
      <div class="ce-grid">
        <label class="ce-field"><span class="lbl">What kind of thing is it?</span>
          <select id="fb-kind">
            <option value="broken">Something is broken</option>
            <option value="idea">Something could be better</option>
          </select></label>
        <label class="ce-field"><span class="lbl">Reply to you at</span>
          <input type="email" id="fb-email" value="${escapeHtml(ME.contactEmail || SB_EMAIL || "")}"
            autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="optional"></label>
        <label class="ce-field ce-wide"><span class="lbl">What happened, or what would you want instead?</span>
          <textarea id="fb-msg" rows="5"
            placeholder="e.g. the script for my Reel came back with the wrong hook, or: I want to reorder the beats"></textarea></label>
      </div>
      <button type="button" class="btn" id="fb-send">Send it</button>
      <p class="bp-msg" id="fb-out" role="status" aria-live="polite"></p>
    </div>`;

  document.getElementById("fb-send").addEventListener("click", () => sendFeedback());
}

/** Replace the form with a real acknowledgement. Someone who took the time to
    write up a bug deserves more than a line of grey text that fades after five
    seconds — and if they cannot tell whether it sent, they will either send it
    twice or stop bothering. Both are worse than a panel they dismiss. */
function acknowledgeFeedback(row) {
  const body = document.getElementById("pane-body");
  if (!body) return;
  const broken = row.kind === "broken";
  body.innerHTML = `
    <div class="section">
      <div class="fb-thanks">
        <div class="fb-tick" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
               stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 7"/></svg>
        </div>
        <h2 class="fb-thanks-h">Got it — thank you.</h2>
        <p class="fb-thanks-p">Your ${broken ? "bug report" : "suggestion"} has been received and
          will be reviewed by the team. We read every one of these, and they genuinely decide what
          gets built next.</p>
        ${row.email ? `<p class="fb-thanks-sub">If we need more detail we'll reply to
          <strong>${escapeHtml(row.email)}</strong>.</p>`
        : `<p class="fb-thanks-sub">You didn't leave an email, so we can't follow up on this one —
          add one under You &amp; settings if you'd like us to.</p>`}
        <div class="bp-actions">
          <button type="button" class="btn" id="fb-again">Send something else</button>
        </div>
      </div>
    </div>`;
  document.getElementById("fb-again").addEventListener("click", () => renderPane());
}

/* Feedback is written TWICE, on purpose.

   Supabase is the record: RLS-protected, always reachable, and the thing to
   trust if the two ever disagree. The Google Sheet is a convenience mirror so
   feedback lands somewhere you already read.

   The mirror goes through a Google Apps Script web app rather than the Sheets
   API, because this site is static and public — any Google credential shipped
   to the browser would be readable by everyone. An Apps Script deployed as
   "anyone can access" needs no credential at all; it just accepts a POST.

   That endpoint is public, so treat the Sheet as append-only and slightly
   spammable, and Supabase as the source of truth. Sending is fire-and-forget
   (`no-cors`): Apps Script answers with a redirect the browser will not let us
   read, so we cannot confirm it landed — which is exactly why the Supabase
   write is the one whose result the creator is shown. */
const FEEDBACK_SHEET_URL =
  "https://script.google.com/macros/s/AKfycby65vSjjDqXCzLv_1wG49_01maywtyPHDgW1x1srdQSI36Ogg1CxHQYaEYLcRG28RrsCw/exec";

function mirrorToSheet(row) {
  if (!FEEDBACK_SHEET_URL) return;
  try {
    // text/plain dodges the CORS preflight Apps Script will not answer.
    fetch(FEEDBACK_SHEET_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(row),
    }).catch(() => {});
  } catch { /* the Supabase row already landed; the mirror is a bonus */ }
}

async function sendFeedback() {
  const btn = document.getElementById("fb-send");
  const msg = document.getElementById("fb-msg");
  const text = (msg.value || "").trim();
  if (!text) { flashMsg("fb-out", "Write a line or two first.", "bad"); msg.focus(); return; }

  const row = {
    creator_id: SB_UID,
    email: (document.getElementById("fb-email")?.value || "").trim() || SB_EMAIL || "",
    kind: document.getElementById("fb-kind").value,
    message: text.slice(0, 4000),
    page: location.pathname,
  };

  btn.disabled = true;
  try {
    await sbFetch("/rest/v1/lynxr_feedback", { method: "POST", body: JSON.stringify(row) });
    mirrorToSheet({ ...row, name: ME.name || "", created_at: new Date().toISOString() });
    msg.value = "";
    acknowledgeFeedback(row);
  } catch (ex) {
    flashMsg("fb-out", /PGRST205|schema cache/i.test(ex.message || "")
      ? "Couldn't send — the feedback table isn't set up yet (run supabase/schema.sql)."
      : "Couldn't send that — check your connection and try again.", "bad");
  } finally { btn.disabled = false; }
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

/** A stored title that is really a permalink.

    Not a hypothetical: the brief builder sets an adaptation's `title` to
    sourceLabel(item) at the moment it is written, and sourceLabel USED to
    return the URL when the caption had not loaded yet. So the string was
    saved into the record — and because it is a non-empty string, every
    `title || fallback` test in this file was satisfied by it and no fallback
    ever ran. The same value then rode into library entries rebuilt from
    adaptations (`title: a.title || ""`).

    Treating it as absent is what lets those records heal rather than keep the
    URL for good. Matched on the known video hosts only, so a caption that
    merely mentions a link is left alone. */
const URLISH_TITLE = /^(https?:\/\/)?(www\.|m\.)?(instagram\.com|tiktok\.com|youtube\.com|youtu\.be)\//i;
function realTitle(s) {
  const t = String(s || "").trim();
  return URLISH_TITLE.test(t) ? "" : t;
}

/** What a card is called before — or instead of — a real title. A bare URL
    reads as a bug; "@emt.kayla on TikTok" reads as a video whose caption
    hasn't loaded.

    A URL is never the answer now, not even last. An Instagram reel URL carries
    no handle to fall back on (`/reels/DRVQX4RAafH/`), so it used to render the
    shortcode — which names nothing a person recognises. What is left says what
    the entry IS, and the cover frame, the platform chip and the ↗ beside it are
    what tell two un-hydrated rows apart. That is the job make_cover() exists
    for. Rare either way: hydration only reaches this line when every relay
    failed. */
function sourceLabel(item) {
  const named = realTitle(item.title);
  if (named) return named;
  const handle = (item.url.match(/(?:tiktok\.com|instagram\.com)\/@([A-Za-z0-9._]+)/) || [])[1]
    || item.creator;
  if (handle) return `@${handle} on ${item.platform}`;
  const kind = /\/reels?\//.test(item.url) ? "reel"
    : /instagram\.com\/p\//.test(item.url) ? "post"
    : /\/shorts\//.test(item.url) ? "short" : "video";
  return item.platform === "Link" ? `Saved ${kind}` : `${item.platform} ${kind}`;
}

// ---------- the composer ----------
// Paste a link at the foot of a brand and it becomes that brand's next script.
// A link is often worth remaking for more than one company, so the brand you
// are standing in is pre-ticked and the rest are one click away — one send,
// one library entry, a separate script per company.
let COMPOSE_FOR = null;      // Set of brand ids; null means "just this brand"

// How many scripts one account may ever have written. Four model calls each,
// three of them Opus, so this is a spend limit before it is a product rule.
// The WORKER enforces the same number (--cap / SCRIPT_CAP) and that is the one
// that counts — this row belongs to the creator, so the check below can be
// walked around from the browser console. Keep the two in step.
const SCRIPT_CAP = 50;
// Counted against the allowance whether or not the creator still has it. Every
// one of these was four model calls that were actually paid for, so deleting a
// script must not hand the money back — otherwise 50 is not a limit, it is a
// limit on how many you keep. Deleted scripts go to the trash rather than
// vanishing, so this is just "everything ever made".
const scriptsUsed = () => (ME.adaptations || []).length + (ME.trash || []).length;

/** Which companies the pasted link is for. Links are sent from one place now,
    so there is no "current brand" to assume — the ticks are the whole answer.
    With a single company there is nothing to choose, so it is pre-ticked; with
    several, sending requires an explicit pick rather than guessing. */
function composeTargets() {
  const named = namedBrands();
  if (!COMPOSE_FOR) return named.length === 1 ? [named[0].id] : [];
  return named.filter((b) => COMPOSE_FOR.has(b.id)).map((b) => b.id);
}

function renderComposeFor() {
  const host = document.getElementById("composer-for");
  if (!host) return;
  // Only NAMED brands are offered. A half-made brand used to appear here as a
  // tickable "Untitled brand" chip, which is an invitation to pick something
  // that cannot be written for. With none of them named there is nothing to
  // choose between, and the send produces the video's original script.
  const named = namedBrands();
  if (!named.length) { host.innerHTML = ""; return; }
  const on = new Set(composeTargets());
  // "Write for", not "write it for": there is no "it" yet at this point — the
  // composer below is still empty, so the label referred to a video the
  // creator has not pasted.
  host.innerHTML = `<span class="lbl">Write for</span>` + named.map((b) => `
    <button type="button" class="for-chip${on.has(b.id) ? " on" : ""}" data-bid="${escapeHtml(b.id)}"
      aria-pressed="${on.has(b.id)}">
      <span class="tick" aria-hidden="true">✓</span>${escapeHtml(b.name || "Untitled brand")}
    </button>`).join("");

  host.querySelectorAll(".for-chip").forEach((chip) => chip.addEventListener("click", () => {
    const next = new Set(composeTargets());
    const id = chip.dataset.bid;
    if (next.has(id)) next.delete(id); else next.add(id);
    // An empty set is a real state now: untick everything and sending refuses,
    // rather than silently guessing a brand for you.
    COMPOSE_FOR = next;
    renderComposeFor();
  }));
}

function wireComposer() {
  const input = document.getElementById("composer-url");
  const badge = document.getElementById("composer-plat");
  // The composer only exists while the New script view is rendered. Without
  // this guard the top-level call below threw on every page load — and because
  // it threw at module scope, every statement after it (including the
  // confirmation-link handler) silently never ran.
  if (!input || !badge) return;
  const showPlat = () => {
    const u = normalizeUrl(input.value);
    badge.textContent = u ? platformLabel(u) : "";
    badge.className = "bp-plat" + (u ? " on" : "");
  };
  input.addEventListener("input", showPlat);

  document.getElementById("composer-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = (input.value || "").trim();
    if (!raw) { say("Paste a video link first.", "bad"); input.focus(); return; }
    const url = normalizeUrl(raw);
    if (!url) { say("That doesn't look like a video link.", "bad"); input.select(); return; }

    // Refuse before making anything — a company created and then blocked by
    // the cap would leave an empty folder behind.
    const room = SCRIPT_CAP - scriptsUsed();
    if (room <= 0) {
      say(`That's all ${SCRIPT_CAP} scripts. Ask for more from Feedback in the menu.`, "bad");
      return;
    }

    // NO COMPANY YET IS A VALID SEND (owner, 2026-08-13). Making a brand-new
    // account set a company up before it can see anything is the wall that lost
    // a live account once already. So the link goes through as-is and comes
    // back as the video's OWN script — what was said, the shots, the structure.
    // The prompt above the composer, and the card itself, then offer to rewrite
    // it for a company, which is a far easier thing to say yes to once you have
    // seen the machine work.
    if (!ME.brands.length) {
      const { item } = ensureLibraryItem(url);
      const res = queueAdaptation(item, null);
      if (!res.ok) { say(res.reason, "bad"); return; }
      input.value = "";
      showPlat();
      await save({ now: true });
      renderSide();
      // The Library is where it lands, same as any other send — the entry is
      // already there with its "writing" chip.
      go({ kind: "library" });
      flashMsg("composer-note",
        "Reading it now — you'll get the video's own script.", "good");
      return;
    }

    // composeTargets() only ever returns NAMED brands, so an unnamed one can no
    // longer be ticked-by-default and then block the send. That combination —
    // one brand, no name — used to be a dead end: auto-ticked, then refused for
    // having no name, with no way through and no prompt explaining it.
    const targets = composeTargets().map(brandById).filter(Boolean);

    // Nothing ticked means one of two very different things.
    if (!targets.length) {
      // They HAVE brands worth writing for and picked none — ask.
      if (namedBrands().length) {
        say("Tick which brand this is for.", "bad");
        return;
      }
      // They have no usable brand at all, so send an ORIGINAL SCRIPT: the
      // video's own words, shots and structure, with no rewrite. This is a
      // real result, not a fallback for a failure.
      if (room <= 0) {
        say(`That's all ${SCRIPT_CAP} scripts. Ask for more from Feedback in the menu.`, "bad");
        return;
      }
      const { item: solo } = ensureLibraryItem(url);
      const res = queueAdaptation(solo, null);
      if (!res.ok) {
        say("You've already got the original script from that video.", "bad");
        return;
      }
      input.value = "";
      showPlat();
      await save({ now: true });
      renderSide();
      renderComposeFor();
      say("On it — reading the video for its original script.", "good");
      go({ kind: "library" });
      return;
    }

    // Ticking four companies is four scripts, so the cap has to be checked
    // against the number of TARGETS rather than the number of sends.
    if (targets.length > room) {
      say(`That's ${targets.length} scripts and you have ${room} left of ${SCRIPT_CAP}. `
        + `Untick ${targets.length - room} to send it.`, "bad");
      return;
    }

    // One library entry however many companies it is written for.
    const { item } = ensureLibraryItem(url);
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
    renderComposeFor();

    const msg = `On it — ${listOf(queued)} ${queued.length > 1 ? "scripts are" : "script is"} being written.`
      + `${skipped.length ? ` (${listOf(skipped)} already had one.)` : ""}`;

    // Sending from the New script page moves you to the Library, where the new
    // entry is already sitting with its "writing your script" chip and its
    // estimate. Staying on an emptied composer would look like nothing
    // happened — the confirmation belongs next to the thing it created.
    if (VIEW.kind === "new") {
      go({ kind: "library" });
      flashMsg("lib-flash", msg, "good");
    } else {
      paintLibraryList();
      say(msg, "good");
    }
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

/* READING A COMPANY'S WEBSITE ----------------------------------------------
   Ported from the agency app, which has done this since launch. Asking a
   creator to WRITE a description of someone else's product is asking the wrong
   person: they make videos, they do not own the positioning, and what they type
   in a hurry is worse than what the company already says about itself on its
   own homepage. So we read the homepage instead.

   Two relays because neither is reliable alone, and a browser cannot fetch a
   third-party page directly. Both are already allowed by this page's CSP. */
async function readViaAllOrigins(url) {
  const raw = await fetchWithTimeout(
    "https://api.allorigins.win/get?url=" + encodeURIComponent(url), 20000);
  const wrapped = JSON.parse(raw);
  const code = wrapped.status?.http_code;
  if (code && code >= 400) throw new Error("site returned " + code);
  return parseSiteHtml(wrapped.contents || "");
}

async function readViaCodetabs(url) {
  return parseSiteHtml(await fetchWithTimeout(
    "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url), 20000));
}

async function readCompanySite(url) {
  try { return await readViaAllOrigins(url); }
  catch { return await readViaCodetabs(url); }
}

/** DOMParser never executes scripts in the parsed document, so a hostile page
    cannot run anything here — it is inert markup by the time we read it. */
function parseSiteHtml(html) {
  if (!html || html.length < 200) throw new Error("empty read");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = (sel) => doc.querySelector(sel)?.getAttribute("content") || "";
  return {
    title: (doc.querySelector("title")?.textContent || meta('meta[property="og:title"]')).trim(),
    description: (meta('meta[name="description"]') || meta('meta[property="og:description"]')).trim(),
    headings: [...doc.querySelectorAll("h1, h2, h3")]
      .map((h) => h.textContent.trim().replace(/\s+/g, " "))
      .filter((t) => t.length >= 2 && t.length <= 80),
    text: (doc.body?.textContent || "").replace(/\s+/g, " "),
  };
}

const SITE_NICHES = {
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
    "platform", "cyber", "engineer", "saas", "robot"],
  "Lifestyle & Entertainment": ["lifestyle", "travel", "food", "recipe", "fashion", "beauty",
    "game", "gaming", "entertain", "movie", "style", "home", "pet"],
};

/** Name, what it is, and a niche — everything brand_digest() needs, taken from
    the company's own words rather than the creator's guess. */
function analyzeCompanySite(read, url) {
  const hay = (read.title + " " + read.description + " " +
    read.headings.join(" ") + " " + read.text.slice(0, 20000)).toLowerCase();

  let best = null, bestScore = 0;
  for (const [niche, words] of Object.entries(SITE_NICHES)) {
    let score = 0;
    for (const w of words) {
      const count = hay.split(w).length - 1;
      if (count) score += w.length * Math.min(count, 5);
    }
    if (score > bestScore) { bestScore = score; best = niche; }
  }

  // The <title> is usually "Brand — tagline"; the first segment is the name.
  let name = (read.title || "").split(/[|–—:·]/)[0].trim();
  if (!name || name.length > 40) {
    try { name = new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { name = ""; }
  }

  // The meta description is the company's own one-line pitch. Failing that,
  // the first real heading — which is what a homepage leads with.
  const desc = read.description
    || read.headings.find((h) => h.split(" ").length >= 3 && h.length <= 120)
    || "";

  return { name, description: desc.slice(0, 300), niche: best || "" };
}

/** "medceptor.com", "https://x.co/y" -> a URL. Anything else -> null, and we
    treat what they typed as a plain company name. */
function asUrl(raw) {
  const s = (raw || "").trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(s)) return "https://" + s;
  return null;
}

/** Instagram never publishes a bare caption. It wraps the SAME text in
    boilerplate on both og tags, in two different shapes:

      og:title        Stephanie | Study Tips on Instagram: "<caption>"
      og:description  862K likes, 1,699 comments - stephyapps on <date>: "<caption>"

    Neither one IS a title; both CONTAIN one. Lifting the quoted span out is
    what makes an Instagram row read like the TikTok row beside it, which
    arrives from oEmbed as the bare caption already.

    Matched against those two shapes specifically rather than "text after a
    colon". A caption can legitimately contain `said: "no"`, and a YouTube
    title can legitimately contain a colon at all ("How to cook: the basics") —
    a looser rule saws both in half. Measured on a live reel: og:title 233
    chars, og:description 258, identical caption inside each. */
function unwrapCaption(s) {
  const t = String(s || "").replace(/\s+$/, "");
  if (!t) return "";
  const m = t.match(/\bon (?:Instagram|Threads)\s*:\s*["“”](.*)$/s)
    || t.match(/\bon\s+\w+\s+\d{1,2},\s*\d{4}\s*:\s*["“”](.*)$/s);
  // The closing quote may be followed by a full stop and trailing space.
  if (m) return m[1].replace(/["“”][\s.]*$/, "").trim();
  return t.replace(/^[\d.,]+[KM]?\s*likes?,\s*[\d.,]+[KM]?\s*comments?\s*[-–—]\s*/i, "").trim();
}

/** A dead, private or mistyped link does not 404 — it redirects to the
    platform's own landing page, whose og:title is the product name. That is not
    a caption, and letting it through titles the row "TikTok - Make Your Day",
    which is worse than the URL it replaced because every dead link then looks
    identical. Measured with an invalid TikTok id: both relays returned exactly
    that string, and the creator regex read "TikTok" as the handle. Rejecting it
    leaves the caption empty, so sourceLabel() falls back to "TikTok video". */
const PLATFORM_BOILERPLATE =
  /^(tiktok(\s*-\s*make your day)?|instagram|youtube|login\s*[•·|]\s*instagram|instagram photos and videos|before you continue to youtube)$/i;

function metaFromHtml(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const meta = (s) => doc.querySelector(s)?.getAttribute("content") || "";
  const og = meta('meta[property="og:title"]') || doc.querySelector("title")?.textContent || "";
  const desc = meta('meta[property="og:description"]');
  // og:description carries the @handle that og:title leaves out — it names the
  // ACCOUNT ("stephyapps") where og:title gives the display name ("Stephanie").
  const handle = (og.match(/@([A-Za-z0-9._]+)/) || [])[1]
    || (desc.match(/[-–—]\s*([A-Za-z0-9._]+)\s+on\s+\w+\s+\d/) || [])[1] || "";
  // Same preference order as before — description, then title — so the only
  // behaviour that changes is the unwrapping.
  const caption = unwrapCaption(desc) || unwrapCaption(og) || og;
  // Both fields go together: the same landing page that supplies a product
  // name as the caption supplies "TikTok" as the handle.
  if (PLATFORM_BOILERPLATE.test(caption.trim())) return { caption: "", creator: "" };
  return {
    caption,
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
  /* allorigins is asked for /raw, not /get, on purpose. /get wraps the page in
     a JSON envelope, and measured against a live Instagram reel that envelope
     came back TRUNCATED — HTTP 200, 74KB, an unterminated string — so
     JSON.parse threw and discarded og tags we had ALREADY downloaded. The
     caption was sitting in those bytes. /raw returns the HTML itself (350KB,
     no envelope), so there is nothing that can half-arrive.

     Asked twice because the failures are intermittent upstream 522s rather
     than refusals: over three tries /raw carried the caption twice and timed
     out once, while /get was unusable 3 times out of 3. codetabs stays as the
     spare, though it was answering 522 itself when this was measured. */
  const relays = [
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
    "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url),
  ];
  let best = null;
  for (const relay of relays) {
    try {
      const meta = metaFromHtml(await fetchWithTimeout(relay, 20000));
      // A relay that answers with an error page parses fine and yields nothing.
      // Keep trying rather than returning that as the answer.
      if (meta.caption) return meta;
      best = best || meta;
    } catch { /* next relay */ }
  }
  return best || { caption: "", creator: "" };
}

/** Best-effort, fired after the card is already on screen: saving stays instant
    and the entry gets its proper name a second later. A failure is silent — an
    un-hydrated card reads fine, so a red message would be noise. */
async function hydrate(item) {
  if (realTitle(item.title) && item.caption) return;
  let meta;
  try { meta = await fetchSourceMeta(item.url); }
  catch { return; }
  const live = ME.library.find((l) => l.id === item.id);
  if (!live) return;                            // removed while the request was out
  live.caption = live.caption || meta.caption || "";
  live.creator = live.creator || meta.creator || "";
  live.title = realTitle(live.title)
    || (meta.caption || "").replace(/\s+/g, " ").trim().slice(0, 90);
  // Trash too. A deleted script keeps its own copy of the title, and only the
  // live list was ever updated — so a trashed entry held the old URL fallback
  // for good, which is exactly what the Trash view was rendering.
  for (const a of [...ME.adaptations, ...(ME.trash || [])]) {
    if (a.libraryId === live.id && live.title) a.title = live.title;
  }
  save();
  const editing = document.activeElement
    && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (!editing) { renderSide(); renderPane(); }   // titles land in both views
}

/* hydrate() only ever ran at send time, so an entry whose relays were down that
   minute stayed unnamed for good — and every Instagram entry saved before the
   /raw fix is in exactly that state. The Library asks again for anything still
   untitled, which is what turns an old `instagram.com/reels/...` row into its
   caption without the creator re-pasting anything.

   One at a time, and tracked in a session Set rather than a flag on the record:
   a relay round-trip measured 4-13s, so twenty entries firing at once would
   stall behind each other; and hydrate() re-renders on success, which calls
   back into here — the Set is what stops that becoming a loop, while still
   letting a NEXT visit retry the ones that failed, since these failures are
   intermittent 522s rather than permanent. */
/* id -> attempts, not a plain Set, because ONE failure must not be final.
   fetchSourceMeta already tries three relays, but allorigins answered 522 on
   roughly a third of measured calls, so a first sweep reliably leaves a couple
   of entries unnamed — and marking them tried meant they sat on "Instagram
   post" until a reload. Two passes: everything once, then whatever is still
   unnamed. Bounded, so a genuinely dead link cannot loop. */
const HYDRATE_TRIED = new Map();
const HYDRATE_PASSES = 2;
let HYDRATING = false;

/** Name a SCRIPT straight from its own source URL.

    hydrate() works through the Library, which is the right route while a
    library entry exists — but a trashed script can outlive the entry it was
    made from (delete the video, keep the bin), and then there is nothing left
    to hydrate and the row sits on "Instagram post" for good. This asks for the
    caption directly and writes it onto the record itself.

    Matched on canonical URL, not id, so one lookup names every sibling script
    of the same video at once — the same link scripted for three brands is
    three records here. */
async function hydrateScript(rec) {
  const url = rec.sourceUrl || "";
  if (!url) return;
  let meta;
  try { meta = await fetchSourceMeta(url); } catch { return; }
  const title = (meta.caption || "").replace(/\s+/g, " ").trim().slice(0, 90);
  if (!title) return;

  const canon = canonUrl(url);
  for (const a of [...(ME.adaptations || []), ...(ME.trash || [])]) {
    if (a.sourceUrl && canonUrl(a.sourceUrl) === canon && !realTitle(a.title)) a.title = title;
  }
  const item = (ME.library || []).find((l) => l.canon === canon);
  if (item) {
    item.title = realTitle(item.title) || title;
    item.caption = item.caption || meta.caption || "";
    item.creator = item.creator || meta.creator || "";
  }
  save();
  const editing = document.activeElement
    && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (!editing) { renderSide(); renderPane(); }
}

async function hydrateStale() {
  if (HYDRATING) return;
  HYDRATING = true;
  const tries = (id) => HYDRATE_TRIED.get(id) || 0;
  const note = (id) => HYDRATE_TRIED.set(id, tries(id) + 1);
  try {
    // Pass 1 names everything it can; pass 2 picks up whatever a flaky relay
    // dropped. Anything still unnamed after that is left for the next visit.
    for (let pass = 1; pass <= HYDRATE_PASSES; pass++) {
      for (;;) {
        // Library entries first: hydrate() fills caption and creator too, which
        // the card bodies show, where a script record only carries a title.
        const item = ME.library.find((l) => !realTitle(l.title) && tries(l.id) < pass);
        if (item) { note(item.id); await hydrate(item); continue; }
        // Then anything the Library cannot reach — chiefly trashed scripts whose
        // library row is gone, which is every "Instagram post" row in the bin.
        const rec = [...(ME.adaptations || []), ...(ME.trash || [])]
          .find((a) => a.sourceUrl && !realTitle(a.title) && tries(a.id) < pass);
        if (!rec) break;
        note(rec.id);
        await hydrateScript(rec);
      }
    }
  } finally { HYDRATING = false; }
}

// ---------- scripts ----------

/** Still being written.
 *
 *  The worker claims an adaptation before it spends anything, flipping it
 *  "queued" -> "running" so two triggers firing at once can't both process it.
 *  To a creator that distinction is invisible and should stay that way: both
 *  states mean "we're on it". Every status test in this file goes through here
 *  rather than comparing to "queued", which would drop a claimed script out of
 *  the counts and render it as neither waiting nor ready. */
function isWriting(a) {
  return a.status === "queued" || a.status === "running";
}

// How long a script actually takes, from measurement rather than guesswork.
// The worker (io.lynxr.adaptations) polls every 5 minutes and takes at most 2
// adaptations per creator per pass; the work itself came in at 49s, 55s and 78s
// on the first live scripts. So what a creator waits for is almost entirely
// queue position, not processing — which is why the estimate below counts
// passes rather than pretending to know a duration.
const POLL_MIN = 5;
const PER_PASS = 2;
const WORK_MIN = 2;

/** Everything of this creator's still waiting, oldest first — the same order
    the worker now uses, so position here is position there. */
function writingQueue() {
  return ME.adaptations.filter(isWriting)
    .sort((a, b) => String(a.addedAt || "").localeCompare(String(b.addedAt || "")));
}

function etaFor(a) {
  const pos = writingQueue().findIndex((x) => x.id === a.id);
  const passes = Math.floor((pos < 0 ? 0 : pos) / PER_PASS) + 1;
  const est = passes * POLL_MIN + WORK_MIN;
  const waited = a.addedAt ? (Date.now() - new Date(a.addedAt).getTime()) / 60000 : 0;
  // Overdue is worth saying out loud. Silently showing "about 7 minutes" to
  // someone who has been waiting half an hour is how a pilot loses trust.
  if (waited > est + POLL_MIN) {
    return { late: true, text: `Taking longer than usual — sent ${Math.round(waited)} minutes ago. Still queued; it'll retry on its own.` };
  }
  return { late: false, text: `Usually ready within about ${est} minutes.` };
}

/** Companies that do NOT already have a script from this source video. */
function brandsWithout(item) {
  const taken = new Set(libScripts(item).filter((a) => a.status !== "error").map((a) => a.brandId));
  return ME.brands.filter((b) => !taken.has(b.id) && (b.name || "").trim());
}

/** Queue the same saved video for more companies, from wherever it's shown.
    This is the whole point of the library holding one entry per video: a
    source worth remaking is usually worth remaking for more than one client,
    and re-pasting the link to do it was busywork. */
async function alsoWriteFor(item, brandIds, afterRender) {
  const queued = [], skipped = [];
  for (const id of brandIds) {
    const co = brandById(id);
    if (!co) continue;
    (queueAdaptation(item, co).ok ? queued : skipped).push(co.name || "that company");
  }
  if (!queued.length) return;
  await save({ now: true });
  renderSide();
  if (afterRender) afterRender();
}

/** The one place a saved video becomes a queued script. Caller saves. */
/** `co` may be null: a creator with no company yet still gets the video read
    and its own script handed back. The worker treats a missing brandId as a
    finished job rather than an error, and stops before the rewrite. */
function queueAdaptation(item, co) {
  /* ONE SCRIPT PER VIDEO PER BRAND. No exceptions and no `force` escape hatch:
     the parameter existed for "run it again", which is gone, and leaving it in
     meant a single caller could quietly reintroduce duplicates — which is
     exactly how the same video ended up with two scripts for one brand.

     A video with no brand (co === null) is treated the same way, keyed on
     brandId null, so the original script cannot be produced twice either.
     `status !== "error"` is what lets a failed read be retried: a script that
     never arrived is not a duplicate of anything. */
  const dupe = ME.adaptations.find((a) => (a.brandId || null) === (co ? co.id : null)
    && a.status !== "error"
    && a.sourceUrl && canonUrl(a.sourceUrl) === item.canon);
  if (dupe) {
    return { ok: false, id: dupe.id,
             reason: isWriting(dupe)
               ? "That one's already being written — it'll appear here."
               : co ? `You've already got a ${co.name || "brand"} script from that video.`
                    : "You've already got that video's script." };
  }
  const id = newId();
  ME.adaptations.unshift({
    id, libraryId: item.id, sourceUrl: item.url,
    brandId: co ? co.id : null,
    brandName: co ? (co.name || "Untitled brand") : "",
    title: sourceLabel(item),
    status: "queued", addedAt: new Date().toISOString(),
    code: trackCode(co ? co.name : "LYNX"),   // spec §6.2 / R3 — issued at brief time
  });
  return { ok: true, id };
}

// Status at last paint, so a script that finishes while the page is open
// announces itself instead of quietly swapping a chip.
const SEEN = new Map();
const FLASH = new Set();

/* WHICH SCRIPTS ARE OPEN FOR EDITING. Ids only — the edits themselves live in
   the textareas until Save, so Cancel is simply a re-render and needs no undo
   buffer. Not persisted: a half-finished edit should not survive a reload as a
   silent draft nobody remembers making. */
const EDITING = new Set();

/** The script, as fields you can change.
 *
 *  Editing is plain textareas over the same shape the model returns — hook,
 *  a row per beat, cta, caption — rather than a rich editor, because what a
 *  creator actually wants to fix is a word choice or a line that does not sound
 *  like them. Nothing here calls the API: this is the creator's own writing, it
 *  costs nothing, and it cannot fail.
 *
 *  Beats keep their SAY / DO / SHOW split rather than collapsing to one box.
 *  Flattening them would lose which line is spoken and which is an instruction,
 *  and scriptText() and the Copy button both read those fields by name.
 */
/** Read every open textarea back onto the adaptation.
 *
 *  Called before ANY re-render that must not lose what is typed — Save, and
 *  also adding or removing a beat, since those rebuild the list from the data
 *  and would otherwise discard edits made to the other beats first. */
function stashEdits(host, a) {
  const scope = host.querySelector(`.ed[data-adid="${CSS.escape(a.id)}"]`);
  if (!scope || !a.adaptation) return;
  const beats = Array.isArray(a.adaptation.beats)
    ? a.adaptation.beats.map((b) => ({ ...b })) : [];
  scope.querySelectorAll(".ed-input").forEach((el) => {
    const v = el.value.trim();
    if (el.dataset.beat === undefined) { a.adaptation[el.dataset.field] = v; return; }
    const b = beats[Number(el.dataset.beat)];
    if (b) b[el.dataset.field] = v;
  });
  a.adaptation.beats = beats;
}

function scriptEditor(a, ad, silent) {
  const id = escapeHtml(a.id);
  const beats = Array.isArray(ad.beats) ? ad.beats : [];
  const field = (label, name, value, rows) => `
    <label class="ed-field"><span class="lbl">${label}</span>
      <textarea class="ed-input grow" rows="${rows || 1}" data-adid="${id}"
        data-field="${name}">${escapeHtml(value || "")}</textarea></label>`;
  return `
    <div class="ed" data-adid="${id}">
      ${field(silent ? "Opening card" : "Hook", "hook", ad.hook, 2)}
      <div class="bp-heading">${silent ? "Shots" : "Beats"}</div>
      <ol class="ed-beats">${beats.map((b, i) => `
        <li class="ed-beat">
          <span class="ed-n">${i + 1}</span>
          <div class="ed-beat-fields">
            ${silent ? "" : `
            <label class="ed-field"><span class="lbl">say</span>
              <textarea class="ed-input grow" rows="1" data-adid="${id}"
                data-beat="${i}" data-field="say">${escapeHtml(b.say || "")}</textarea></label>`}
            <label class="ed-field"><span class="lbl">do</span>
              <textarea class="ed-input grow" rows="1" data-adid="${id}"
                data-beat="${i}" data-field="do">${escapeHtml(b.do || "")}</textarea></label>
            <label class="ed-field"><span class="lbl">show</span>
              <textarea class="ed-input grow" rows="1" data-adid="${id}"
                data-beat="${i}" data-field="show">${escapeHtml(b.show || "")}</textarea></label>
          </div>
          ${/* Removing a beat is the one structural edit worth having — a
                script that runs one beat too long is the commonest fix, and
                without this the only way to shorten it is a rewrite. */""}
          <button type="button" class="ghost danger icon-only ed-drop" data-adid="${id}"
            data-beat="${i}" aria-label="Remove this beat" title="Remove this beat">
            <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>
          </button>
        </li>`).join("")}</ol>
      <button type="button" class="linkish ed-add" data-adid="${id}">+ add a beat</button>
      ${field(silent ? "Final card" : "CTA", "cta", ad.cta, 1)}
      ${field("Caption", "caption", ad.caption, 2)}
    </div>`;
}

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
  /* Each row carries its TYPE as a class. SAY, DO and SHOW are three different
     instructions — words to speak, an action to perform, literal text to put on
     screen — and they were rendering identically in silent scripts, where `dim`
     is false for both DO and SHOW. A wall of same-weight text with a 9.5px
     label as the only distinction is unreadable at a glance, and these are read
     while filming. */
  const row = (label, v, dim) => v
    ? `<span class="bp-lbl bp-lbl-${label.toLowerCase()}">${label}</span><span class="bp-val bp-${label.toLowerCase()}${dim ? " bp-dim" : ""}">${escapeHtml(v)}</span>`
    : "";
  // No timing column. These are recreation beats, not a cut list — the order
  // is the instruction, and "0-4s" invited people to match a stopwatch to a
  // video they are deliberately not copying shot for shot. The `t` values are
  // still stored. (The agency blueprints still show theirs: they annotate a
  // specific existing video, where the timestamp is the point. Hence the
  // scoped .bp-notime class rather than editing the shared .bp-beat grid.)
  // SPOKEN scripts are SAY and DO only. SHOW was a third line to read on every
  // beat when the words are the thing you came for, and it mostly restated the
  // hook as an on-screen caption. It is still extracted and stored — nothing
  // downstream loses it — it just isn't in the way.
  //
  // SILENT scripts keep it, because there it IS the script: `say` is empty by
  // design on every beat, and dropping SHOW would leave a shot list with the
  // actual content missing.
  const rows = [row("SAY", say), row("DO", doIt, !silent),
                silent ? row("SHOW", show, false) : ""].filter(Boolean);
  if (!rows.length) return "";
  return `<li class="bp-beat">${rows.join("")}</li>`;
}

function scriptText(a) {
  const ad = a.adaptation || {};
  const quiet = ad.delivery === "silent"
    || (Array.isArray(ad.beats) && ad.beats.length && ad.beats.every((b) => !(b.say || "").trim()));
  const lines = [`${a.brandName || "Script"} — from ${a.sourceUrl || ""}`, ""];
  if (quiet) lines.push("NO VOICEOVER — shot by shot, the SHOW lines go on screen.", "");
  if (ad.hook) lines.push(`${quiet ? "OPENING CARD" : "HOOK"}: "${ad.hook}"`, "");
  for (const b of ad.beats || []) {
    if (b.say) lines.push(`  SAY:  ${b.say}`);
    if (b.do) lines.push(`  DO:   ${b.do}`);
    if (quiet && b.show) lines.push(`  SHOW: ${b.show}`);   // matches the card: silent only
  }
  if (ad.cta) lines.push("", `${quiet ? "FINAL CARD" : "CTA"}: ${ad.cta}`);
  if (ad.caption) lines.push("", `CAPTION: ${ad.caption}`);
  return lines.join("\n");
}

/* ---------- THE TELEPROMPTER ----------

   Reading a script off a phone means looking at the middle of the screen, and
   the front camera is at the TOP — so the footage shows someone reading, eyes
   visibly off-axis. Everything here exists to close that gap: the reading band
   is pinned to the top of the viewport, right under the lens, and the controls
   are pushed to the bottom where a thumb can reach them without the hand
   crossing the frame.

   It scrolls at a constant rate, the way a real teleprompter does — varying
   speed per beat is unreadable. What the beats DO supply is the finish line:
   `t` ("0-3s", "3-7s") gives the video's intended length, so the scroll is
   paced to end when the video should. A generic teleprompter has to ask for a
   words-per-minute setting; this one already knows.

   No recording here, deliberately. That is a much heavier feature — camera
   permissions, codec support, the mirrored-preview/unmirrored-output trap, and
   somewhere to put the file — and the reading half is useful on its own. */

const TP = { raf: 0, y: 0, playing: false, pxPerSec: 0, last: 0, lock: null };
const TP_PREFS = "lynxr.prompter";
// Speaking pace when a script carries no usable `t` values. 140 wpm is an
// unhurried piece-to-camera; the creator can trim it live with the − / + keys.
const TP_WPM = 140;

function tpPrefs() {
  try { return JSON.parse(localStorage.getItem(TP_PREFS)) || {}; } catch { return {}; }
}
function tpSavePrefs(p) {
  try { localStorage.setItem(TP_PREFS, JSON.stringify(p)); } catch { /* private mode */ }
}

/** The video's intended length, from the beats' own `t` ranges. 0 when the
    script predates `t` or the values don't parse — the caller falls back to
    counting words. */
function scriptSeconds(ad) {
  let end = 0;
  for (const b of (ad.beats || [])) {
    const t = String(b.t || "");
    const span = t.match(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)/);
    if (span) { end = Math.max(end, parseFloat(span[2])); continue; }
    const one = t.match(/(\d+(?:\.\d+)?)/);
    if (one) end = Math.max(end, parseFloat(one[1]));
  }
  return end;
}

/** What actually gets read aloud, in order. A spoken script reads its `say`
    lines with `do` beside them as a dim stage direction; a silent one has no
    `say` at all, so the `show` cards become the script — the same swap the
    card and the copied text already make. `show` is never surfaced on a spoken
    script: it is text for the EDIT, not for the mouth, and putting it in the
    reading lane invites people to say it out loud. */
function prompterLines(ad, silent) {
  const out = [];
  if (ad.hook) out.push({ kind: silent ? "card" : "hook", text: String(ad.hook).trim(), cue: "" });
  for (const b of (ad.beats || [])) {
    const words = String((silent ? b.show : b.say) || "").trim();
    const cue = String(b.do || "").trim();
    if (words) out.push({ kind: silent ? "card" : "say", text: words, cue });
    else if (cue) out.push({ kind: "cue", text: "", cue });
  }
  if (ad.cta) out.push({ kind: silent ? "card" : "cta", text: String(ad.cta).trim(), cue: "" });
  return out.filter((l) => l.text || l.cue);
}

function tpEl(id) { return document.getElementById(id); }

function openPrompter(a) {
  const ad = a && a.adaptation;
  const wrap = tpEl("tp");
  if (!ad || !wrap) return;
  const silent = ad.delivery === "silent"
    || (Array.isArray(ad.beats) && ad.beats.length && ad.beats.every((b) => !(b.say || "").trim()));
  const lines = prompterLines(ad, silent);
  if (!lines.length) return;

  const scroll = tpEl("tp-scroll");
  scroll.innerHTML = lines.map((l) => `<div class="tp-line tp-${l.kind}">
      ${l.text ? `<span class="tp-words">${escapeHtml(l.text)}</span>` : ""}
      ${l.cue ? `<span class="tp-cue">${escapeHtml(l.cue)}</span>` : ""}
    </div>`).join("");
  tpEl("tp-brand").textContent = a.brandName || "your script";

  const p = tpPrefs();
  applyTpSize(p.size || 34);
  TP.speed = p.speed || 1;

  wrap.hidden = false;
  document.body.classList.add("modal-open");

  /* Rate is measured AFTER the overlay is visible: a hidden element has no
     layout, so scrollHeight would be 0 and every script would scroll instantly.
     Two frames — one for the unhide, one for the font metrics to settle. */
  /* Parked at the top, NOT playing. Opening the prompter is when you get the
     phone into position and read the first line — if the script starts moving
     on open, the take is already behind you before you have framed yourself.
     Nothing scrolls until the record button is pressed. */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    tpMeasure(ad, lines);
    tpSeek(0);
    tpPlay(false);
  }));
  tpWakeLock();
  /* Camera up front, before the script moves. Two reasons: you cannot frame a
     shot you cannot see, and asking for the permission HERE means the prompt
     is answered while nothing is happening — request it at record time instead
     and the "allow camera" dialog lands on top of the 3-2-1, so the countdown
     runs out while the creator is still tapping it. Refused or absent, this
     quietly stays a teleprompter. */
  tpCamera();
}

/** px/sec such that the script finishes when the video should. */
function tpMeasure(ad, lines) {
  const scroll = tpEl("tp-scroll");
  const band = tpEl("tp-band");
  // The run is the text plus one band-height of lead-out, so the last line
  // travels up to the reading position instead of stopping at the bottom edge.
  TP.run = Math.max(1, scroll.scrollHeight + band.clientHeight * 0.6);
  let secs = scriptSeconds(ad);
  if (!secs) {
    const words = lines.reduce((n, l) => n + (l.text ? l.text.split(/\s+/).length : 0), 0);
    secs = Math.max(4, (words / TP_WPM) * 60);
  }
  TP.pxPerSec = TP.run / secs;
  TP.secs = secs;
  tpEl("tp-len").textContent = `${Math.round(secs)}s`;
}

function applyTpSize(px) {
  // CSSOM, not a style attribute — style-src is 'self' with no 'unsafe-inline',
  // so an inline style attribute here is silently dropped.
  tpEl("tp-scroll").style.fontSize = `${px}px`;
  TP.size = px;
}

function tpSeek(y) {
  TP.y = Math.max(0, Math.min(y, TP.run || 0));
  tpEl("tp-scroll").style.transform = `translate3d(0, ${-TP.y}px, 0)`;
}

function tpPlay(on) {
  TP.playing = on;
  const btn = tpEl("tp-play");
  if (btn) {
    // aria-pressed ONLY — CSS swaps the two faces off it. Never write
    // textContent here: it would replace both svgs with a word and the button
    // would degrade to text permanently (the armDelete bug).
    btn.setAttribute("aria-pressed", String(on));
    // The same button records when there is a camera and merely scrolls when
    // there is not, so it has to say which it is about to do. Calling it
    // "Pause" while it is stopping a take would be a lie about what happens.
    const rec = !!REC.stream;
    const label = on ? (rec ? "Stop recording" : "Pause")
                     : (rec ? "Start recording" : "Play");
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
  }
  cancelAnimationFrame(TP.raf);
  if (!on) return;
  TP.last = 0;
  const step = (ts) => {
    if (!TP.playing) return;
    if (TP.last) tpSeek(TP.y + TP.pxPerSec * TP.speed * ((ts - TP.last) / 1000));
    TP.last = ts;
    if (TP.y >= (TP.run || 0)) { tpPlay(false); return; }   // reached the end
    TP.raf = requestAnimationFrame(step);
  };
  TP.raf = requestAnimationFrame(step);
}

function tpSpeed(mult) {
  TP.speed = Math.max(0.4, Math.min(2.5, Math.round(mult * 10) / 10));
  tpEl("tp-rate").textContent = `${TP.speed.toFixed(1)}×`;
  tpSavePrefs({ ...tpPrefs(), speed: TP.speed });
}

/* A phone that sleeps mid-take is the one failure that costs a whole
   performance, so hold the screen awake while the prompter is up. Progressive
   enhancement — unsupported browsers just behave as before. */
async function tpWakeLock() {
  try { TP.lock = await navigator.wakeLock.request("screen"); } catch { TP.lock = null; }
}

/* ---------- RECORDING ----------

   The centre button is one control with two jobs, because on a phone they are
   the same moment: hit record and the script starts moving. Splitting them
   would mean pressing play, then reaching for record while already on camera.

   Nothing is uploaded. The recording is held in memory and handed to the
   device — hosting creator footage means storage cost, upload waits, and a far
   heavier privacy posture than the video LINKS this app deals in today. */

const REC = { stream: null, rec: null, chunks: [], on: false, url: "", counting: false, timer: 0 };

/* iOS Safari and Chrome disagree on container support, and an unsupported
   mimeType throws rather than falling back. Ask, in order of preference, and
   let the browser choose if it likes none of them. */
function recMime() {
  const want = ["video/mp4;codecs=h264,aac", "video/mp4",
                "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const m of want) {
    try { if (window.MediaRecorder?.isTypeSupported?.(m)) return m; } catch { /* keep looking */ }
  }
  return "";
}

async function tpCamera() {
  if (REC.stream) return true;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return false;
  try {
    REC.stream = await navigator.mediaDevices.getUserMedia({
      // Portrait, front camera — this is filmed on a phone, held up.
      video: { facingMode: "user", width: { ideal: 1080 }, height: { ideal: 1920 } },
      audio: true,
    });
  } catch { return false; }               // denied, or no camera on this device
  const v = tpEl("tp-cam");
  v.srcObject = REC.stream;
  v.play().catch(() => { /* autoplay policy — the stream still records */ });
  tpEl("tp").classList.add("tp-live");
  return true;
}

/** 3 … 2 … 1. Resolves false if the creator pressed stop while it ran. */
function tpCountdown(from) {
  const el = tpEl("tp-count");
  return new Promise((done) => {
    let n = from;
    REC.counting = true;
    el.hidden = false;
    const tick = () => {
      if (!REC.counting) { el.hidden = true; done(false); return; }
      if (n === 0) { el.hidden = true; REC.counting = false; done(true); return; }
      el.textContent = String(n);
      n -= 1;
      REC.timer = setTimeout(tick, 1000);
    };
    tick();
  });
}

async function tpStartRecording() {
  const hasCam = await tpCamera();
  // No camera, or permission refused: fall back to being a plain teleprompter
  // rather than refusing to do anything. Reading the script is the part that
  // always works.
  if (!hasCam) { tpSeek(0); tpPlay(true); return; }

  tpPlay(false);
  tpSeek(0);
  if (!(await tpCountdown(3))) return;    // cancelled mid-count

  REC.chunks = [];
  const mime = recMime();
  try {
    REC.rec = new MediaRecorder(REC.stream, mime ? { mimeType: mime } : undefined);
  } catch { REC.rec = new MediaRecorder(REC.stream); }
  REC.rec.ondataavailable = (e) => { if (e.data && e.data.size) REC.chunks.push(e.data); };
  REC.rec.onstop = tpFinishRecording;
  REC.rec.start();
  REC.on = true;
  tpEl("tp").classList.add("tp-rec");
  tpPlay(true);                            // script and camera start together
}

function tpStopRecording() {
  // Cancel a countdown that has not finished — pressing stop during "3, 2, 1"
  // should abandon the take, not queue one up.
  if (REC.counting) {
    REC.counting = false;
    clearTimeout(REC.timer);
    tpEl("tp-count").hidden = true;
    return;
  }
  tpPlay(false);
  tpEl("tp").classList.remove("tp-rec");
  REC.on = false;
  try { REC.rec?.state !== "inactive" && REC.rec?.stop(); } catch { /* already stopped */ }
}

/** The take is done. Hand it to the device — never to a server. */
function tpFinishRecording() {
  if (!REC.chunks.length) return;
  const type = REC.rec?.mimeType || "video/mp4";
  if (REC.url) URL.revokeObjectURL(REC.url);
  REC.url = URL.createObjectURL(new Blob(REC.chunks, { type }));
  REC.chunks = [];
  const ext = /mp4/.test(type) ? "mp4" : "webm";
  const link = tpEl("tp-save");
  if (!link) return;
  link.href = REC.url;
  link.download = `lynxr-take.${ext}`;
  link.hidden = false;
}

/** One button, two jobs. */
function tpMainButton() {
  if (REC.on || REC.counting) { tpStopRecording(); return; }
  tpStartRecording();
}

function closePrompter() {
  const wrap = tpEl("tp");
  if (!wrap || wrap.hidden) return;
  if (REC.on || REC.counting) tpStopRecording();
  tpPlay(false);
  /* Release the camera explicitly. Hiding the overlay leaves the tracks live —
     the recording light stays on and the creator has no way to tell the app
     let go, which is the kind of thing that costs you their trust exactly
     once. Stop every track, then drop the element's reference to the stream. */
  for (const t of (REC.stream?.getTracks() || [])) { try { t.stop(); } catch { /* gone */ } }
  REC.stream = null;
  const cam = tpEl("tp-cam");
  if (cam) cam.srcObject = null;
  wrap.classList.remove("tp-live", "tp-rec");
  wrap.hidden = true;
  document.body.classList.remove("modal-open");
  try { TP.lock?.release(); } catch { /* already gone */ }
  TP.lock = null;
}

function initPrompter() {
  const wrap = tpEl("tp");
  if (!wrap) return;
  tpEl("tp-close").addEventListener("click", closePrompter);
  tpEl("tp-play").addEventListener("click", tpMainButton);
  // Rewind only. Restart is what you press after a fluffed take, and that is
  // the moment you want to breathe and reset — not be read at again instantly.
  tpEl("tp-restart").addEventListener("click", () => { tpPlay(false); tpSeek(0); });
  tpEl("tp-slower").addEventListener("click", () => tpSpeed(TP.speed - 0.1));
  tpEl("tp-faster").addEventListener("click", () => tpSpeed(TP.speed + 0.1));
  const resize = (d) => {
    applyTpSize(Math.max(18, Math.min(72, TP.size + d)));
    tpSavePrefs({ ...tpPrefs(), size: TP.size });
    // The run length depends on how tall the text is, so re-measure or the
    // pacing silently drifts after a resize.
    TP.run = Math.max(1, tpEl("tp-scroll").scrollHeight + tpEl("tp-band").clientHeight * 0.6);
    TP.pxPerSec = TP.run / (TP.secs || 1);
  };
  tpEl("tp-smaller").addEventListener("click", () => resize(-3));
  tpEl("tp-bigger").addEventListener("click", () => resize(3));
  // Tapping the reading band toggles play — the controls are a thumb-stretch
  // away at the bottom, and mid-take you want the biggest possible target.
  tpEl("tp-band").addEventListener("click", () => tpPlay(!TP.playing));
  document.addEventListener("keydown", (e) => {
    if (wrap.hidden) return;
    if (e.key === "Escape") { closePrompter(); return; }
    if (e.key === " ") { e.preventDefault(); tpPlay(!TP.playing); }
    if (e.key === "ArrowUp") { e.preventDefault(); tpSeek(TP.y - 60); }
    if (e.key === "ArrowDown") { e.preventDefault(); tpSeek(TP.y + 60); }
  });
}

/** opts.open   — render already expanded. Used inside a Library entry the
 *                creator has just opened: they opened it to read the script, so
 *                a second disclosure to reach it is the step this removes.
 *  opts.nested — this card is inside a Library entry. That entry already shows
 *                the video's thumbnail and its title, so repeating both here
 *                said nothing and made one video look like two. Nested cards
 *                are labelled by what actually differs between them — the brand
 *                each was written for — and drop the thumbnail.
 */
function adaptationHtml(a, liveName, opts = {}) {
  const { open: forceOpen = false, nested = false, bare = false } = opts;
  const prevSeen = SEEN.get(a.id);
  const justReady = (prevSeen === "queued" || prevSeen === "running") && a.status === "done";
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
    : !a.brandId ? `<span class="chip good">original script</span>`
    : `<span class="chip">source only</span>`;
  const href = safeUrl(a.sourceUrl || "");
  const id = escapeHtml(a.id);
  // brandName was snapshotted when this was queued, so it goes stale the moment
  // the brand is renamed. Prefer what the brand is called now.
  const brandNow = liveName || a.brandName || "this brand";
  // The same source is usually worth remaking for more than one client, and
  // the library already holds it — so offer the other companies right here
  // rather than making the creator go and paste the link again.
  const srcItem = ME.library.find((l) => l.id === a.libraryId)
    || (a.sourceUrl ? ME.library.find((l) => l.canon === canonUrl(a.sourceUrl)) : null);
  const reuse = srcItem ? brandsWithout(srcItem) : [];

  let body;
  if (isWriting(a)) {
    const eta = etaFor(a);
    /* The same mark the brand lookup uses. This is the longest wait in the app
       — a link goes off to be transcribed, watched and rewritten — and it used
       to be two lines of grey text, which reads the same whether the worker is
       running or has died. A moving mark says "still going" on its own.
       The small "writing" chips in the library lists stay as dots: a 46px
       animation inside a status chip would be noise, and those are glanced at
       rather than waited on. */
    body = `<div class="loader" role="status" aria-live="polite">
        ${loaderMark()}
        <div class="loader-text">
          <div class="loader-stage">${a.brandId
            ? `Writing it for ${escapeHtml(brandNow)}`
            : "Reading the video for its original script"}</div>
          ${/* .bp-eta carries the colour and size; .bp-hint is deliberately NOT
                here, because its `margin: 6px 0 10px` overrides .loader-sub's
                tighter 2px and pushes the ETA off the mark it belongs to. */""}
          <div class="loader-sub bp-eta${eta.late ? " bp-partial" : ""}">${escapeHtml(eta.text)}</div>
        </div>
      </div>`;
  } else if (a.status === "error") {
    body = `<p class="bp-hint bad">${escapeHtml(a.note || "That video couldn't be downloaded.")}</p>
      <div class="bp-actions"><button type="button" class="ghost ad-retry" data-adid="${id}">Try again</button></div>`;
  } else if (ad) {
    const carry = { do: "", show: "" };
    body = `
      ${/* A good score explains nothing the script itself doesn't say better, and
            it pushed the hook — the thing you came for — below the fold. Only the
            poor-fit warning still shows: that one changes what you'd do next. */""}
      ${lowFit ? `<p class="bp-hint bp-partial"><strong>This format doesn't really suit ${escapeHtml(brandNow)}.</strong>
          ${escapeHtml(ad.fit_reason || "")} The script below is written anyway, but a format that fits
          would do better than forcing this one.</p>` : ""}
      ${a.format?.name ? `<div class="chips bp-tags"><span class="chip">${escapeHtml(a.format.name)}</span>
        ${a.source?.tags?.format_type ? `<span class="chip">${escapeHtml(a.source.tags.format_type)}</span>` : ""}
        ${a.source?.tags?.hook_pattern ? `<span class="chip">${escapeHtml(a.source.tags.hook_pattern)}</span>` : ""}</div>` : ""}
      ${a.note ? `<p class="bp-hint">${escapeHtml(a.note)}</p>` : ""}
      ${EDITING.has(a.id) ? scriptEditor(a, ad, silent) : `
      ${ad.hook ? `<div class="bp-hook"><span class="bp-hook-lbl">${
        silent ? "Opening card" : "Hook"}</span>“${escapeHtml(ad.hook)}”</div>` : ""}
      ${silent ? `<p class="bp-hint">No voiceover — put the SHOW line on screen at each beat.</p>` : ""}
      ${/* Silent scripts get no heading. "Shot by shot" sat directly above a
            list of shots, under a line that already says "no voiceover — put
            the show line on screen at each beat", so it named what was
            self-evident twice over. Spoken scripts keep theirs: there the beats
            follow a hook and a delivery note, so the label marks where the
            script itself starts. */""}
      ${silent ? "" : `<div class="bp-heading">Your script</div>`}
      <ol class="bp-beats bp-notime">${(ad.beats || []).map((b) => beatRow(b, carry, silent)).join("")}</ol>
      ${ad.cta ? `<p class="bp-hint"><strong>${silent ? "Final card" : "CTA"}:</strong> ${escapeHtml(ad.cta)}</p>` : ""}
      ${ad.caption ? `<p class="bp-hint"><strong>Caption:</strong> ${escapeHtml(ad.caption)}</p>` : ""}`}
      ${/* format.why_it_works is still extracted and stored — it is useful to the
            model and to step 2's clustering — it just isn't shown. It explains the
            format to someone who already has the script, which is analysis nobody
            asked for at the bottom of the thing they came to film. */""}
      <div class="bp-actions">
        ${/* The teleprompter leads this row, and is the only labelled button
              here: copy/edit/delete are things you do TO the script, this is
              the thing you do WITH it. Named for what it shows — a silent
              script has no words to read aloud, so its SHOW lines are cue
              cards, the same rename the hook and CTA already take. */""}
        ${EDITING.has(a.id) ? "" : `<button type="button" class="btn ad-prompt" data-adid="${id}"
          >${silent ? "Cue cards" : "Teleprompter"}</button>`}
        ${EDITING.has(a.id) ? `
          <button type="button" class="btn ad-save" data-adid="${id}">Save changes</button>
          <button type="button" class="ghost ad-cancel" data-adid="${id}">Cancel</button>`
        : `${/* No rewrite button. Asking the model again spent another script
                from the allowance to produce a different-but-equivalent answer,
                and the pencil now covers the real need — changing a line that
                does not sound like you — for nothing. A creator who genuinely
                wants a fresh take can send the link again.

                Edit and delete sit on THIS row rather than a separate one
                below: they are things you do to this script, same as copying
                it, and a second row of buttons underneath read as a different
                kind of control. Pushed right by .bp-icons so the destructive
                one is not adjacent to the one you press most. */""}
          <span class="bp-icons">
            <button type="button" class="ghost icon-only ad-copy" data-adid="${id}"
              aria-label="Copy this script" title="Copy this script">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
            </button>
            <button type="button" class="ghost icon-only ad-edit" data-adid="${id}"
              aria-label="Edit this script" title="Edit this script">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><path d="M16.8 3.8a2.1 2.1 0 0 1 3 3L8.5 18.1l-4 1 1-4z"/><path d="M14.5 6.1l3.4 3.4"/></svg>
            </button>
            <button type="button" class="ghost danger icon-only ad-del" data-adid="${id}"
              aria-label="Delete this script" title="Delete this script">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
            </button>
          </span>`}
      </div>
      ${reuse.length && !EDITING.has(a.id) ? `<div class="bp-heading">Also write this for</div>
        <div class="chips lib-also">${reuse.map((b) => `
          <button type="button" class="chip pick ad-also" data-adid="${id}" data-bid="${escapeHtml(b.id)}"
            >+ ${escapeHtml(b.name)}</button>`).join("")}</div>` : ""}`;
  } else if (!a.brandId) {
    /* THE ORIGINAL SCRIPT — a finished result, not a failure.
       This branch used to be shared with "the rewrite failed", so a creator who
       asked for the original got "Read, but not written yet" and a Try again
       button that would spend another script and produce the same answer. The
       two cases are opposites and are told apart by brandId. */
    const src = a.source || {};
    const scr = src.script || {};
    const segs = Array.isArray(scr.segments) ? scr.segments : [];
    const shots = Array.isArray(src.shots) ? src.shots : [];
    const t = (n) => `${Math.round(Number(n) || 0)}s`;
    body = `
      ${a.format?.name ? `<div class="chips bp-tags"><span class="chip">${escapeHtml(a.format.name)}</span>
        ${src.tags?.format_type ? `<span class="chip">${escapeHtml(src.tags.format_type)}</span>` : ""}
        ${src.tags?.hook_pattern ? `<span class="chip">${escapeHtml(src.tags.hook_pattern)}</span>` : ""}</div>` : ""}
      ${segs.length ? `<div class="bp-heading">What they say</div>
        <ol class="bp-beats">${segs.map(([st, , txt]) => `
          <li class="bp-beat"><span class="bp-t">${escapeHtml(t(st))}</span>
            <span class="bp-lbl bp-lbl-say">SAY</span><span class="bp-val bp-say">${escapeHtml(String(txt || "").trim())}</span></li>`).join("")}</ol>`
        : `<p class="bp-hint">No speech &mdash; this one is carried by what's on screen.</p>`}
      ${/* SHOW rows are .bp-dim, SAY rows are not — the same weighting the
            agency blueprints use (row("SAY", say) plain, row("SHOW", …, true)
            dimmed) and the same one beatRow() applies to brand scripts. The
            words are what you came to read; the visuals are the annotation
            around them, and printing both in full white made the two compete.
            This branch was the one place that never got the treatment. */""}
      ${shots.length ? `<div class="bp-heading">What's on screen</div>
        <ol class="bp-beats">${shots.map((sh) => `
          <li class="bp-beat"><span class="bp-t">${escapeHtml(t(sh.t))}</span>
            <span class="bp-lbl bp-lbl-show">SHOW</span><span class="bp-val bp-show bp-dim">${escapeHtml(sh.visual || "")}${
              (sh.onscreen_text || "").trim() ? `\n“${escapeHtml(sh.onscreen_text.trim())}”` : ""}</span></li>`).join("")}</ol>` : ""}
      <div class="bp-actions">
        <button type="button" class="ghost ad-copy" data-adid="${id}">Copy</button>
        ${/* No rewrite here either — same reason as on a brand script. This is
              the video's own transcript, so "ask again" would return the same
              words anyway. */""}
        <button type="button" class="btn ad-brandify" data-adid="${id}">Write this for a brand</button>
      </div>`;
  } else {
    body = `<p class="bp-hint">Read, but not written yet. ${escapeHtml(a.note || "")}</p>
      <div class="bp-actions"><button type="button" class="ghost ad-retry" data-adid="${id}">Try again</button></div>`;
  }

  const statusClass = `bp-${isWriting(a) ? "queued" : escapeHtml(a.status)}${flash ? " bp-flash" : ""}`;
  /* A written script carries its own copy / edit / delete icons on the actions
     row inside `body`, so it gets nothing here — rendering this as well put a
     second pencil and a second trash on every card.

     The other branches (the original transcript, a failed read) have no such
     row, and still need a way to be deleted. */
  const deleteBtn = ad ? "" : `
      <div class="bp-foot">
        <button type="button" class="ghost danger icon-only ad-del" data-adid="${id}"
          aria-label="Delete this script" title="Delete this script">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            ><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>
        </button>
      </div>`;

  /* BARE: no summary row at all, just the script.
     Used for the ONLY script on a Library entry. Opening the entry is already
     the decision — a second disclosure underneath it, labelled with a brand
     name the group heading above has just said, was two clicks and two labels
     for one thing. With several scripts the rows come back, because then the
     list is a genuine choice between them. */
  if (bare) {
    return `<div class="bp-item lib-bare ${statusClass}" data-adid="${id}">
      <div class="bp-body">${body}${deleteBtn}</div>
    </div>`;
  }

  return `<details class="bp-item ${statusClass}"${justReady || forceOpen ? " open" : ""} data-adid="${id}">
    <summary>
      <span class="bp-caret" aria-hidden="true">▸</span>
      ${nested ? "" : thumbHtml((a.source || {}).cover, entryLabel(a))}
      ${/* Same resolver the Trash view uses: prefers the live library entry's
            caption, falls back to the platform wording, never a permalink. */""}
      <span class="bp-name">${escapeHtml(nested
        ? (a.brandId ? brandNow : "Original script")
        : entryLabel(a))}</span>
      ${/* Nested, a green "script ready" sits next to the finished script it is
            describing, under an entry whose own chip already counts it — three
            ways of saying the same thing. Writing and error chips STAY: those
            say something the collapsed card otherwise cannot. */""}
      ${nested && a.status === "done" ? "" : chip}
      ${/* Same for the timestamp: the entry above carries the video's own. */""}
      ${nested ? "" : `<span class="bp-when">${escapeHtml(agoLabel(a.addedAt))}</span>`}
      ${/* The ↗ is the parent entry's link too when nested — same video, same
            URL — so it only appears on a standalone card. */""}
      ${href && !nested ? `<a class="bp-open" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open the original">↗</a>` : ""}
    </summary>
    <div class="bp-body">${body}${deleteBtn}</div>
  </details>`;
}

function renderScripts(b) {
  const host = document.getElementById("ad-list");
  if (!host) return;
  const list = brandScripts(b);
  if (!list.length) {
    /* A brand you have just finished setting up lands here, so this is the
       first thing a new creator sees after the form — "No scripts yet." alone
       named the state and left them to work out the next move. */
    host.innerHTML = `<div class="empty lib-empty">
      ${emptyDemo()}
      ${/* No explanatory line under the heading: the little animation above it
            already shows a link going in and a script coming out, and the
            button says what pressing it does. The sentence restated both. */""}
      <p><strong>No scripts yet.</strong></p>
      <div class="bp-actions"><button type="button" class="btn" id="brand-empty-cta">Create first script</button></div>
    </div>`;
    host.querySelector("#brand-empty-cta").addEventListener("click", () => go({ kind: "new" }));
    return;
  }
  host.innerHTML = `<div class="bp-list">${list.map((a) => adaptationHtml(a, b.name)).join("")}</div>`;
  wireAdaptationCards(host);
}

/* Everything an adaptation card can do, wired against whatever host it was
   rendered into. Extracted from renderScripts because the Library renders
   cards too: an ORIGINAL script belongs to no brand, so no brand page can list
   it, and before this it was written, stored, and visible nowhere. */
function wireAdaptationCards(host) {
  if (!host) return;
  stopSummaryLinks(host);

  host.querySelectorAll(".ad-prompt").forEach((btn) => btn.addEventListener("click", () => {
    const a = (ME.adaptations || []).find((x) => x.id === btn.dataset.adid);
    if (a) openPrompter(a);
  }));

  /* ONE SCRIPT OPEN AT A TIME. A script runs to a couple of screens, so two
     expanded at once meant scrolling through the first to discover the second
     — and in the Library, where each entry can hold a script per brand, three
     open at once buried the page.

     Wired per-element rather than delegated: the `toggle` event does not
     bubble. Scoped to [data-adid] so it closes SCRIPTS only — the Library
     entries around them are .bp-item too, and folding those would shut the
     video you are reading inside. Assigning .open re-fires toggle on the ones
     being closed, but they exit on the !d.open guard, so there is no loop. */
  const cards = [...host.querySelectorAll("details.bp-item[data-adid]")];
  cards.forEach((d) => d.addEventListener("toggle", () => {
    if (!d.open) return;
    cards.forEach((other) => { if (other !== d) other.open = false; });
  }));

  host.querySelectorAll(".ad-copy").forEach((btn) => btn.addEventListener("click", async () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a) return;
    try {
      await navigator.clipboard.writeText(scriptText(a));
      /* Swap the ICON, not the text. This button used to say "Copy script" and
         confirmed by setting textContent — which on an icon button replaces the
         svg with a word and leaves it permanently wrong, because the restore
         put the old label back rather than the drawing. Remember innerHTML,
         show a tick, put the drawing back. */
      const face = btn.innerHTML;
      btn.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M20 6L9 17l-5-5"/></svg>`;
      btn.classList.add("ok");
      setTimeout(() => { btn.innerHTML = face; btn.classList.remove("ok"); }, 1400);
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
  /* The .ad-again handler lived here — "run it again", a second model pass over
     the same video. Removed with its button: it spent a script from the
     allowance to produce a different-but-equivalent answer, and editing by hand
     covers the real need for nothing. Its `force: true` flag went with it — see
     queueAdaptation, which now enforces one script per video per brand with no
     way around it. */

  /* MANUAL EDITING — the creator's own words, not another model run. Open,
     close and save are all a re-render around the EDITING set; the textareas
     hold the working copy until Save, so Cancel needs no undo buffer and a
     reload cannot resurrect a half-finished edit. Nothing here calls the API,
     spends from the allowance, or can fail. */
  /* Every one of these re-renders the pane, which rebuilds the <details> from
     scratch and loses the open state — so the card you were editing snaps shut
     the moment you save, hiding the change you just made. Reopen it after each
     paint. In "by brand" mode the same script can appear in more than one
     place, so reopen ALL copies rather than an arbitrary first match. */
  const keepOpen = (adid) => {
    renderPane();
    document.querySelectorAll(`.bp-item[data-adid="${CSS.escape(adid)}"]`)
      .forEach((el) => {
        el.open = true;
        /* In the Library the script card is nested INSIDE its video entry, and
           reopening the script alone left it sitting inside a collapsed parent
           — so pressing edit looked like it closed the card, and you had to
           open the video again to reach the editor that was already there.
           On a brand page there is no parent and this is a no-op. */
        const entry = el.parentElement?.closest("details.lib-item");
        if (entry) entry.open = true;
      });
  };
  host.querySelectorAll(".ad-edit").forEach((btn) => btn.addEventListener("click", () => {
    EDITING.add(btn.dataset.adid);
    keepOpen(btn.dataset.adid);
  }));
  host.querySelectorAll(".ad-cancel").forEach((btn) => btn.addEventListener("click", () => {
    EDITING.delete(btn.dataset.adid);
    keepOpen(btn.dataset.adid);
  }));
  host.querySelectorAll(".ad-save").forEach((btn) => btn.addEventListener("click", () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a || !a.adaptation) return;
    stashEdits(host, a);
    /* A beat emptied to nothing is one the creator deleted by clearing it, so
       drop it rather than leave a blank row that renders as a gap. */
    a.adaptation.beats = (a.adaptation.beats || []).filter((b) =>
      (b.say || "").trim() || (b.do || "").trim() || (b.show || "").trim());
    a.editedAt = new Date().toISOString();
    EDITING.delete(a.id);
    save({ now: true });
    renderSide(); keepOpen(a.id);
    say("Saved your changes.", "good");
  }));
  host.querySelectorAll(".ed-add").forEach((btn) => btn.addEventListener("click", () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a || !a.adaptation) return;
    stashEdits(host, a);          // or adding a beat throws away the edit so far
    a.adaptation.beats = [...(a.adaptation.beats || []), { say: "", do: "", show: "" }];
    keepOpen(a.id);
  }));
  host.querySelectorAll(".ed-drop").forEach((btn) => btn.addEventListener("click", () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a || !a.adaptation) return;
    stashEdits(host, a);
    const i = Number(btn.dataset.beat);
    a.adaptation.beats = (a.adaptation.beats || []).filter((_, n) => n !== i);
    keepOpen(a.id);
  }));

  host.querySelectorAll(".ad-del").forEach((btn) => armDelete(btn, "Delete script", () => {
    trashAdaptations((x) => x.id === btn.dataset.adid);
    save(); renderSide(); renderPane();   // the video stays in the Library
  }));

  /* Turn an original script into a brand script. The video is already in the
     library, so this is the same "also write this for" move the finished cards
     offer — the only difference is that a creator who got here may have no
     brand yet, which is the moment asking for one is a favour rather than a
     toll gate.

     It re-runs the pipeline rather than reusing the source already stored on
     the entry. Reuse would be cheaper (~$0.05 against ~$0.13) and quicker, and
     is worth doing — but it means restructuring the paid worker, which is not
     something to ship untested. Filed in the handoff. */
  host.querySelectorAll(".ad-brandify").forEach((btn) => btn.addEventListener("click", () => {
    const a = ME.adaptations.find((x) => x.id === btn.dataset.adid);
    if (!a) return;
    const item = ME.library.find((l) => l.id === a.libraryId)
      || (a.sourceUrl ? ME.library.find((l) => l.canon === canonUrl(a.sourceUrl)) : null);
    if (!item) { say("That video isn't in your library any more.", "bad"); return; }

    const named = namedBrands();
    if (!named.length) {
      // No brand to write for yet — send them to make one. addBrand() lands on
      // the new brand with the website lookup open, and the video is still in
      // the Library waiting when they come back.
      say("Add a brand first — then write this for them.", "good");
      addBrand();
      return;
    }
    const spare = brandsWithout(item);
    if (!spare.length) {
      say("Every brand already has a script from this video.", "bad");
      return;
    }
    // One brand: no picker needed. Several: the Library row already lists them
    // as chips, so send them there rather than inventing a second picker.
    if (spare.length === 1) alsoWriteFor(item, [spare[0].id]);
    else { go({ kind: "library" }); say("Pick which brand to write it for.", "good"); }
  }));
}

// ---------- boot ----------
function renderAll() {
  // Land on New script. It is where the work happens — a brand page is a shelf
  // you visit to read what came back, not the thing you open the app to do.
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
    if (SAVE_PENDING) return;          // never pull over an unsaved edit
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
/* Three modes, one form: sign in, create an account, and set a new password
   after a reset link. "reset" is the odd one — the person is already
   authenticated by the link they clicked, so it asks for no email and no old
   password, only the replacement. */
/* Which version of the privacy policy a new account agreed to. Bump it when the
   policy changes in a way that matters — the date in privacy/index.html is the
   human version of the same thing. Old rows keep the version they accepted. */
const PRIVACY_VERSION = "2026-08-17";

let GATE_MODE = "in";
function setGateMode(mode) {
  GATE_MODE = mode;
  const up = mode === "up";
  const reset = mode === "reset";
  const sent = mode === "sent";      // account made; waiting on the email link
  const pw = document.getElementById("pw");
  document.getElementById("gate-tagline").textContent =
    sent ? "check your email"
      : reset ? "choose a new password" : up ? "create your account" : "for creators";
  // The email is known from the link; asking for it again invites a typo that
  // would silently reset nothing.
  document.getElementById("email").hidden = reset;
  document.getElementById("pw2-wrap").hidden = !(up || reset);
  document.getElementById("pw2").value = "";
  // Agreement belongs to creating an account and nothing else. It is also
  // cleared on every mode change, so switching away and back cannot leave a
  // tick behind that the creator never made.
  document.getElementById("agree-wrap").hidden = !up;
  document.getElementById("agree").checked = false;
  document.getElementById("gate-go").textContent =
    reset ? "Save new password" : up ? "Create account" : "Enter";
  pw.setAttribute("autocomplete", up || reset ? "new-password" : "current-password");
  pw.placeholder = up || reset ? "Password — 8 characters or more" : "Password";
  /* "sent" is the state after a successful signup: the account exists and the
     only thing left is the link in their inbox. The whole form goes, because
     every field in it is refused until they confirm — offering a filled-in
     password box that cannot work is the app inviting a failure it already
     knows about. */
  document.getElementById("gate-form").hidden = sent;
  // Nothing to switch to mid-reset, and no point offering another reset mail.
  document.querySelector(".gate-switch").hidden = reset;
  document.getElementById("forgot-wrap").hidden = up || reset || sent;
  /* In "sent" this doubles as the safeguard the old wording carried in a
     sentence. sbSignUp cannot tell a NEW address from one that already has an
     account without leaking which is which, so both land here — and someone who
     re-used an existing address is waiting for a link that was never sent.
     "already have an account? sign in" is exactly what they need, and it says
     the same thing to everyone, so it leaks nothing. */
  document.getElementById("switch-lede").textContent =
    up || sent ? "Already have an account?" : "Don't have an account?";
  document.getElementById("switch-mode").textContent = up || sent ? "Sign in" : "Create one";
  document.getElementById("err").textContent = "";
  // The resend link belongs to a failed sign-in, not to the create form.
  document.getElementById("resend-wrap").hidden = true;
  // Both modes share one submit button, so a seat refusal that disabled it must
  // be lifted on the way back to sign-in or existing creators are locked out by
  // a rule that was never about them.
  document.getElementById("gate-go").disabled = false;
  if (up) { if (SEATS_OPEN === null) refreshSeats(); else applySeatState(); }
}

// The homepage CTA links to ?signup=1, so "Create your account" lands on the
// create form rather than the sign-in form the visitor has no credentials for.
if (/[?&]signup=1\b/.test(location.search)) setGateMode("up");

/* An invite link carries both halves — ?e=<address>&c=<code> — so the invited
   person types a password and nothing else. Filling these in is also the only
   way the address is guaranteed to match the invite: retyping it is where the
   typo lives, and a mismatched address reads as "you're not invited". */
if (INVITED_EMAIL) {
  document.getElementById("email").value = INVITED_EMAIL;
  setGateMode("up");
}
if (INVITE) {
  const f = document.getElementById("invite");
  if (f) f.value = INVITE;
}

/* Forgot password. Supabase answers /recover with 200 whether or not the
   address exists — deliberately, so the endpoint can't be used to find out who
   has an account — so the wording below must not claim a mail was sent. */
document.getElementById("gate-forgot").addEventListener("click", async () => {
  const err = document.getElementById("err");
  const btn = document.getElementById("gate-forgot");
  const email = (document.getElementById("email").value || "").trim();
  if (!email) {
    err.textContent = "Enter your email first, then tap Forgot your password.";
    document.getElementById("email").focus();
    return;
  }
  btn.disabled = true;
  err.textContent = "Sending…";
  try {
    // Same per-request redirect as signup: the link must come back to whichever
    // host served this page, not to the project's single Site URL.
    const back = encodeURIComponent(location.origin + CREATOR_PATH);
    const res = await fetch(`${SB_URL}/auth/v1/recover?redirect_to=${back}`, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error(String(res.status));
    err.textContent = "If that address has an account, a reset link is on its way. "
      + "Open it on this device and you can set a new password.";
  } catch (ex) {
    err.textContent = /429|rate/i.test(ex.message)
      ? "Too many attempts — wait a minute and try again."
      : "Couldn't send the reset link — check your connection and try again.";
  } finally { btn.disabled = false; }
});

/* Recovery for an address that never got its link, or whose link expired.
   Without this the only route is to sign up again — and Supabase answers a
   repeat signup for an existing address with a decoy that sends nothing, so
   the creator would be told to check an inbox nothing is coming to. With
   confirmation on and 50+ signups, some will land here; a dead end at the
   front door is the most expensive kind. */
let RESEND_FOR = "";

function showResend(email) {
  RESEND_FOR = email;
  document.getElementById("resend-wrap").hidden = false;
}

document.getElementById("gate-resend").addEventListener("click", async () => {
  const btn = document.getElementById("gate-resend");
  const err = document.getElementById("err");
  const email = RESEND_FOR || (document.getElementById("email").value || "").trim();
  if (!email) { err.textContent = "Enter your email first."; return; }
  btn.disabled = true;
  err.textContent = "Sending…";
  try {
    // Same per-request redirect as signup, so the link comes back to whichever
    // host served this page rather than the project's single Site URL.
    const back = encodeURIComponent(location.origin + CREATOR_PATH);
    const res = await fetch(`${SB_URL}/auth/v1/resend?redirect_to=${back}`, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "signup", email }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error_description || body.msg || body.message || "failed");
    err.textContent = "Sent — check your inbox, and your spam folder.";
    document.getElementById("resend-wrap").hidden = true;
  } catch (ex) {
    const m = String(ex.message || "");
    // Supabase answers /resend with 200 even for an address that is already
    // confirmed — the same refusal to confirm who has an account that signup
    // makes. So there is no "already confirmed" case to report here; only a
    // genuine transport or rate-limit failure reaches this branch.
    err.textContent = /rate|too many|429|for security purposes/i.test(m)
      ? "Too many emails just now — wait a minute and try again."
      : "Couldn't send it. Check the address and try again.";
  } finally { btn.disabled = false; }
});

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

  /* Setting a new password after a reset link. Checked BEFORE the email test
     below, because this mode deliberately has no email field — the link
     already said who this is. */
  if (GATE_MODE === "reset") {
    if (pw.value.length < 8) { err.textContent = "Use at least 8 characters."; pw.select(); return; }
    if (pw.value !== pw2.value) { err.textContent = "Those two passwords don't match."; pw2.select(); return; }
    btn.disabled = true;
    err.textContent = "Saving…";
    try {
      // sbFetch carries the recovery session the link established, and refreshes
      // it if the person sat on this screen past the hour.
      await sbFetch("/auth/v1/user", { method: "PUT", body: JSON.stringify({ password: pw.value }) });
      pw.value = ""; pw2.value = "";
      await pull();
      unlock();
    } catch (ex) {
      err.textContent = /same.*password|different from the old/i.test(ex.message || "")
        ? "That's the password you already had — pick a different one."
        : "Couldn't save the new password. Ask for a fresh reset link and try again.";
      btn.disabled = false;
    }
    return;
  }

  if (!email || !pw.value) { err.textContent = "Enter your email and password."; return; }

  if (GATE_MODE === "up") {
    // Known-full: refuse here rather than sending a request that can only come
    // back as a 500. If the answer never arrived (SEATS_OPEN === null) the
    // signup goes ahead and the trigger decides — the check is a courtesy.
    if (SEATS_OPEN === false) { err.textContent = FULL_MSG; return; }
    if (pw.value.length < 8) { err.textContent = "Use at least 8 characters."; pw.select(); return; }
    if (pw.value !== pw2.value) { err.textContent = "Those two passwords don't match."; pw2.select(); return; }
    /* Checked here rather than with the `required` attribute: this form shares
       one submit handler with sign-in and password reset, where the box is
       hidden — and a hidden `required` control blocks submission with a browser
       bubble pointing at something nobody can see. */
    if (!document.getElementById("agree").checked) {
      err.textContent = "Please agree to the privacy policy to create an account.";
      return;
    }
    btn.disabled = true;
    err.textContent = "Creating your account…";
    try {
      const code = (document.getElementById("invite")?.value || INVITE).trim();
      const outcome = await sbSignUp(email, pw.value, code);
      pw.value = ""; pw2.value = "";
      if (outcome === "confirm") {
        /* "sent" hides the form outright. Nothing in it works until the link in
           their inbox is clicked, so leaving a password box on screen only
           invites an attempt that is refused. The "already have an account?
           sign in" line below the message covers the other case this branch
           lands on — a re-used address, where no email is sent — without
           naming which of the two happened, which sbSignUp deliberately will
           not reveal. */
        setGateMode("sent");
        err.textContent = "thanks — your account is created. "
          + "check your email for the link that signs you in.";
        return;
      }
      await pull();
      /* Record the agreement on the creator's own row, the same way the wait
         list records its consent tag: a version and a timestamp, so "what did
         this person actually agree to" stays answerable after the policy is
         reworded. Set before unlock() so the first save carries it. */
      ME.privacyAccepted = { version: PRIVACY_VERSION, at: new Date().toISOString() };
      save();
      unlock();
    } catch (ex) {
      err.textContent = signupError(ex.message);
    } finally { btn.disabled = false; }
    return;
  }

  btn.disabled = true;
  /* The mark, working — the same signal the brand lookup and the script write
     use. Every failure line below stays on textContent: those render messages
     derived from server responses, and innerHTML would make that an injection. */
  gateBusy(err, "Signing in…");
  let signedIn = false;
  try {
    await sbSignIn(email, pw.value);
    signedIn = true;
    pw.value = "";
    gateBusy(err, "Loading your account…");
    await pull();
    unlock();
  } catch (ex) {
    const m = ex.message || "";
    // Once sign-in succeeded the password was fine, so never blame it for what
    // is really a failure to load the account.
    if (/Email not confirmed/i.test(m)) showResend(email);
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

document.getElementById("side-new").addEventListener("click", addBrand);

// Always a FRESH composer, exactly like pressing new-chat: re-rendering the
// view is what clears the field and resets the company picker.
document.getElementById("nav-new").addEventListener("click", () => go({ kind: "new" }));

// Tapping the dimmed page closes the drawer. The scrim is a ::after
// pseudo-element on <body> so it can't carry its own handler — clicks on it
// land on <body>. Rail items already close it via go(); this covers the far
// more common "open it, change my mind, tap the page" gesture, which
// previously left the menu stuck open.
document.addEventListener("click", (e) => {
  if (!document.body.classList.contains("side-open")) return;
  if (e.target.closest("#side") || e.target.closest("#side-open")) return;
  document.body.classList.remove("side-open");
});

document.getElementById("nav-library").addEventListener("click", () => go({ kind: "library" }));
document.getElementById("nav-you").addEventListener("click", () => go({ kind: "you" }));
document.getElementById("nav-feedback").addEventListener("click", () => go({ kind: "feedback" }));

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
    // A recovery link authenticates but does NOT change the password. Dropping
    // straight into the app would look like success while leaving the old
    // password in place — so the next sign-in fails exactly as before and the
    // reset appears not to have worked. Say so by asking for the new one.
    return p.get("type") === "recovery" ? "recovery" : true;
  } catch { return false; }
}

// Arriving from a confirmation link, or a session already stored here.
(async function resume() {
  const link = await sessionFromLink();
  if (link === "recovery") {
    setGateMode("reset");
    document.getElementById("pw").focus();
    document.getElementById("err").textContent = "Set a new password to finish.";
    return;
  }
  if (link) {
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

