/* lynxr — the public pages. One script, two of them:

     /            the marketing page. No form. All this file does there is
                  carry a ?ref= / ?utm_ campaign tag onto the "try it" link so
                  attribution survives the hop.
     /waitlist/   the form. Takes an email, writes it to Supabase, mirrors it
                  to a Google Sheet.

   Every wiring below is guarded on its element existing, which is what lets
   one file serve both pages — and what stops a missing element on one of them
   throwing before the other page's wiring has run.

   Neither app is mentioned on either page. Both live on unlisted paths handed
   out by invitation, and a link on a public page would undo that. A returning
   creator has the URL already; these pages do not need to help them. */

/* THE WHOLE FILE IS AN IIFE, AND THAT IS LOAD-BEARING — NOT STYLE.
   The merged landing page (Stage A, 2026-08-26) loads home.js AND creator.js
   as classic scripts on ONE document for the first time. Both declared
   top-level `const SB_URL` / `const SB_KEY`; the second declaration is an
   early SyntaxError that aborted ALL of creator.js before one statement ran —
   the hero composer and the gate simply never wired. Both also declare
   `say()`, which would not even error: the later declaration silently rebinds
   the earlier one's calls. Wrapping THIS file (248 lines, nothing outside it
   references any of its names — verified) rather than creator.js (7,600
   lines whose globals the verification harness uses) makes every top-level
   name here private and retires both collisions at once. Do not unwrap; do
   not add a new top-level declaration below outside the IIFE. */
(function () {


const SB_URL = "https://esakjfogplfszievvabi.supabase.co";
// Public by design — the repo is public. It is safe only because the waitlist
// policy grants INSERT and nothing else: no one can read the list back with it.
const SB_KEY = "sb_publishable_pTFNX2B94PE_DFLL799w4A_4VcH2xTN";

/* A convenience mirror of the waitlist into a Google Sheet, so signups show up
   somewhere you actually look instead of only in the Supabase dashboard.

   Paste the Apps Script /exec URL here — see supabase/waitlist-sheet.gs for the
   two-minute deploy. Left empty, the mirror is simply skipped and Supabase
   still gets every signup, so shipping this before the script is deployed
   breaks nothing.

   Sheet: docs.google.com/spreadsheets/d/1ypPfMkF6jpyQJ-9WCNoyjcjTenXrePhMz2uv96LjScY */
const WAITLIST_SHEET_URL =
  "https://script.google.com/macros/s/AKfycbyFGbycer3b7rH2FS-tzHGcYcX4ywQpBrWpVFkXaEzKHlUWDn82fnZhv5DddT4gGqjG/exec";

const $ = (id) => document.getElementById(id);

/* WHERE THE SIGNUP CAME FROM.

   `source` is a column the schema always had ("which page/campaign") that this
   page never filled in — every row said "landing", so the list could tell you
   how many people joined and never which link they came from.

   Order matters, most trustworthy first:

     1. ?ref=... — a tag YOU put on a link before sharing it. The only one that
        survives everywhere, because it's part of the URL rather than something
        the platform decides to pass along.
     2. ?utm_source=... — same idea, for links that already carry UTMs.
     3. The referring site's HOSTNAME, recorded as "ref:tiktok.com".
        Weak: TikTok and the Instagram in-app browser usually strip the
        referrer entirely, so treat a bare "landing" as "unknown", not "typed
        it in directly".

   Only the hostname is ever stored, never the full referring URL — that can
   carry search terms or private path segments, and none of it is our business.

   Read at load rather than at submit, so it reflects how the visitor actually
   arrived. */
const SOURCE_MAX = 40;

/** Keep it to a small, boring charset. Nothing renders this column, but it
    lands in a database and a spreadsheet, and neither wants surprises. */
function cleanSource(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9._:-]/g, "");
  return s.slice(0, SOURCE_MAX);
}

function signupSource() {
  try {
    const q = new URLSearchParams(location.search);
    const tagged = cleanSource(q.get("ref") || q.get("utm_source"));
    if (tagged) return tagged;

    if (document.referrer) {
      const host = new URL(document.referrer).hostname.replace(/^www\./, "");
      // Ignore our own pages — arriving from lynxr.io isn't a traffic source.
      if (host && host !== location.hostname) {
        const tag = cleanSource("ref:" + host);
        if (tag) return tag;
      }
    }
  } catch { /* a malformed URL or referrer is not worth failing a signup over */ }
  return "landing";
}

const SOURCE = signupSource();

/* WHAT THEY AGREED TO.
   Stored per signup, because the promise on the page has already been reworded
   more than once and "what did this person actually consent to" is answerable
   only if each row carries its own answer.

   A version TAG, not the sentence: the sentence is in index.html (.wait-sub)
   and in git history. Bump this whenever that promise changes MEANING — going
   from "we'll email you at launch" to anything broader is a new tag, and the
   old rows keep the narrower one they were given.

   Needs supabase/waitlist_consent.sql to have been run. Until then the column
   does not exist and PostgREST rejects the whole insert, so this is sent only
   when the column is confirmed present — see the retry in the submit handler. */
/* v2 (2026-08-17) widened the promise from "we'll notify you when we launch" to
   launch news PLUS occasional product updates. The tag changed with it, which
   is the whole point of having one: rows carrying launch-notify-v1 agreed to a
   single launch email and NOTHING else, so a product update may not be sent to
   them without asking first. Do not retro-fit v2 onto old rows. */
const CONSENT = "launch-and-updates-v2";

/** Fire-and-forget. Apps Script answers with a 302 the browser will not let us
    read, so this is mode:"no-cors" and its success cannot be confirmed from
    here — which is why it is never allowed to affect what the visitor sees.
    Supabase is the record; this is a copy. */
function mirrorToSheet(email) {
  if (!WAITLIST_SHEET_URL) return;
  try {
    fetch(WAITLIST_SHEET_URL, {
      method: "POST",
      mode: "no-cors",
      // text/plain keeps it a CORS "simple request" — a JSON content-type
      // would trigger a preflight that Apps Script does not answer.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ email, source: SOURCE, created_at: new Date().toISOString() }),
    }).catch(() => {});
  } catch { /* the signup is already in Supabase; the mirror is optional */ }
}

function say(text, kind) {
  const el = $("wait-msg");
  el.textContent = text;
  el.className = "wait-msg" + (kind ? " " + kind : "");
}

/* Deliberately loose. A regex that "properly" validates an address rejects
   real ones, and the cost of a typo here is one dead row — while the cost of
   turning away a real creator is the whole point of the page. */
const looksLikeEmail = (s) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s);

/* CARRYING A CAMPAIGN TAG ONTO EVERY LINK THAT NEEDS IT, on / only.

   The wait list is a separate page now, so a campaign tag put on the link that
   was shared — lynxr.io/?ref=tiktokbio — sits in the URL of the page BEFORE the
   form and would be dropped at the hop. Every signup would then read "landing",
   which is the exact blindness the source column was added to fix.

   Used to be one hard-coded element (#try-it, the old CTA). The merged home
   dropped that element and added a second link that needs the same treatment
   — the gate's seats-full fallback (#gate-full-link) — so this is now a loop
   over every element carrying data-carry-utm rather than a single lookup.

   Only the two keys signupSource() actually reads are carried (`ref`, and
   anything utm_*): forwarding the whole query string would drag arbitrary
   visitor-supplied junk onto our own URL for no gain. An existing key on the
   href always wins, so a hand-written link cannot be overridden by a query
   param. Failure on any one link must never break the others or the page —
   each is wrapped separately, and every plain href is a working navigation on
   its own with JS off entirely. */
for (const el of document.querySelectorAll("[data-carry-utm]")) {
  try {
    const from = new URLSearchParams(location.search);
    const to = new URL(el.getAttribute("href"), location.href);
    for (const [k, v] of from) {
      if ((k === "ref" || k.startsWith("utm_")) && !to.searchParams.has(k)) {
        to.searchParams.set(k, v);
      }
    }
    if (to.search) el.setAttribute("href", to.pathname + to.search);
  } catch { /* a malformed query is not worth breaking the only button on */ }
}

/* THE HERO'S SIGN-UP BOX (owner, 2026-09-23: "where the lynxr was, put a sign up
   box", then, on a claude.ai sign-in card: "something like this", "but in our
   styling").

   IT INVENTS NO AUTH, AND IT IS NOT A <form>. Every control in the box is a
   `data-gate="up"` / `data-gate="in"` control, exactly like the pricing CTAs:
   creator.js delegates every [data-gate] click on the document to the real gate
   (showGate, #gate) and accepts both values. This file adds the two hand-offs
   nobody else can do, and nothing more:

     1. THE TYPED ADDRESS. Whatever is in #hxs-email is copied into the gate's own
        email field (#email) BEFORE the gate opens, so the real create-account
        form arrives pre-filled instead of asking for it twice. The cursor then goes
        to the password, the one thing left to type.
     2. GOOGLE. #hxs-google does not start an OAuth flow itself — there is exactly
        one Google button on this site, the gate's own #oauth-google, and it carries
        the busy state and oauthStart(). This opens the gate in create-account mode and CLICKS that button, so the visitor goes
        straight into the real Google flow from the hero. There is no tick box any more (owner,
        2026-09-25): the line under these buttons, "by continuing you agree to the terms and privacy
        policy", is the agreement, and the gate shows the same line. If the gate is not offering
        Google at that moment (it hides the provider block when invites are required or seats are
        closed), nothing is clicked and the visitor simply lands on the real gate.

   WHY THE LISTENER IS ON THE BOX AND NOT ON THE DOCUMENT: creator.js's is on the
   document, in the bubble phase. A listener on an ancestor nearer the target runs
   first, so the field is filled before showGate() reads and focuses it. Nothing
   here calls preventDefault — the gate's handler owns that — and with creator.js
   absent or broken the email control and the sign-in line are still real links to
   /?signup=1 and /, which work with JS off entirely.

   ENTER MAY NOT RELOAD THE PAGE. There is no <form> around the field, so the
   browser cannot implicitly submit it; Enter is routed to the same control by
   hand instead, so the key still does the obvious thing. */
const hxsBox = document.querySelector(".hxs");
if (hxsBox) {
  const mail = $("hxs-email");
  /* The gate's fields are looked up at CLICK time, not now: on a page without the
     gate (there is none today, but this file is shared) every one of these is
     simply skipped and the plain hrefs still navigate. */
  const carry = () => {
    const to = $("email");
    const v = mail && mail.value.trim();
    if (to && v) to.value = v;
  };
  const toGoogle = () => {
    const box = $("gate-oauth"), btn = $("oauth-google");
    if (!(box && btn && !box.hidden && !btn.hidden && !btn.disabled)) return;
    btn.click();
  };
  hxsBox.addEventListener("click", (e) => {
    if (!e.target.closest("[data-gate]")) return;
    carry();
    // After creator.js's own handler has opened the gate and moved focus to #email.
    if (e.target.closest("#hxs-google")) setTimeout(toGoogle, 0);
    // The typed address is already in the form, so the next thing to type is the password.
    else if (e.target.closest("#hxs-go") && mail && mail.value.trim()) setTimeout(() => $("pw")?.focus(), 0);
  });
  if (mail) {
    mail.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();              // no form to submit, but stop any UA default dead
      $("hxs-go")?.click();            // the same control, so the same gate mode; carry() runs on it
    });
  }
}

/* THE HERO'S INTRO: THE PANEL WRITES ITSELF TOP TO BOTTOM (owner, 2026-09-25: "have everything load
   from top to bottom, like lynxr is writing the landing page", then "i mean just in this box" — so the
   headline, subline and sign-up card outside the panel stay on screen from frame 0). One pass, ~2.3s,
   from t0 (hxStart):

     0.45s  the COACH row: pill, then its headline types (.45-.80s), "learn more" at .80s
     1.08s  the three dots are written and start to ripple
     1.30s  the SCRIPT headline types (to 1.62s); the paste box fades in at 1.62s
     1.90s  the "new here? create your free account" row (phone) fades in
     2.30s  the intro ends

   THERE IS NO MASCOT IN THE PANEL ANY MORE (owner, 2026-10-05: "have it just be the one and the visual
   get rid of the lynxr"). The buddy that sat in the card's bottom band and played a whistle, then a
   pencil, over this timeline (2026-09-22 to 2026-10-05) is gone with its band; the one x on the page
   is the nav logo, which bounces down and starts this timeline on its first landing (the performer below).

   FOUR THINGS IT MAY NOT DO, worst first:
   1. (Was: play once per session. The owner wants it on EVERY load — see armHeroIntro — so the
      escape hatch below, any touch of the hero ending it instantly, is what keeps it bearable.)
   2. Gate the composer. The field is live from the first frame — never disabled, never moved —
      and ANY touch of the hero (pointer, focus, key, paste) ends the intro on the spot and
      leaves the finished hero behind. Delaying the one element that converts, to show a
      mascot, is not a trade this page makes.
   3. Hide the hero when scripting is off. The stylesheet's default IS the finished state; all
      the hiding lives under .hx-anim, which only this file adds and only once it has decided
      to play. No JS, blocked JS, an error thrown earlier: the whole hero is simply there.
   4. Move anything. The reveal is opacity plus a 7px rise, and the composer gets opacity only,
      so the one element people click never shifts under the pointer.
   Reduced motion: it does not run at all — the hero is finished immediately.

   THE CLASS GOES ON HERE, AT THE TOP LEVEL, not in a DOMContentLoaded handler: the deferred scripts
   run before the first paint (measured on this page: DOMContentLoaded 55ms, first paint 68ms), so
   nothing is ever painted and then hidden. */
/* STARTED IS NOT ARMED (2026-10-05, the nav-logo performer below). The card's intro is ARMED before
   the first paint (.hx-anim, the typed headlines) but STARTS at hxStart: at once when there is no
   performer — exactly the old timeline, t0 at the top level — or at the moment the performer first
   lands on the sign-up card. Until then .hx-hold pauses every one of the intro's CSS animations in its
   delay (fill: both, so the rows sit at their first frame).
   hxEnd is the card's own finish (natural, at t0 + 2.3s). hxStop is an INTERRUPT — a touch, a
   scroll, a resize — and finishes everything at once: the performer perched, the card finished. */
const HX = { on: false, over: false, started: false, t0: 0, timers: [] };
const PERF = { on: false, end: null, armed: 0 };
const hxAt = (ms, fn) => { HX.timers.push(setTimeout(fn, Math.max(0, ms - (performance.now() - HX.t0)))); };
const hxEnd = () => {
  if (HX.over) return;
  HX.over = true;
  for (const t of HX.timers) clearTimeout(t);
  HX.timers.length = 0;
  const sec = document.querySelector(".hx");
  if (sec) sec.classList.remove("hx-anim", "hx-hold");   // default CSS = the finished hero, so this is the snap
};
const hxStart = () => {
  if (!HX.on || HX.started || HX.over) return;
  HX.started = true;
  HX.t0 = performance.now();
  document.querySelector(".hx")?.classList.remove("hx-hold");   // the paused CSS timeline runs from here
  hxAt(2300, hxEnd);   // the panel writes top to bottom; its last row ("new here", phone) lands ~2.2s
};
const hxStop = () => {
  if (PERF.end) PERF.end();
  hxEnd();
  barIntroEnd();
};
(function armHeroIntro() {
  const sec = document.querySelector("body.home .hx");
  if (!sec || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  /* Opened in a background tab: play nothing. Timers there are throttled to a second at a
     time, so the beats would land minutes later, over a hero the visitor is already reading.
     The session is NOT spent — the next arrival with the tab in front gets the intro. */
  if (document.hidden) return;
  /* EVERY LOAD (owner, 2026-09-22: "everytime on reload, have the main load animation happen").
     There was a once-per-session gate here (sessionStorage "lx-hx-intro"); the owner removed it.
     The two other skips stay: reduced motion, and a tab that opened in the background. */
  HX.on = true;
  HX.t0 = performance.now();
  /* TYPED OUT (owner, 2026-09-24: "for the loading animation, make it more like typed out"). The
     panel's two headlines arrive one character at a time inside their row's own window — the
     coach line over .45–.80s, the script line over 1.30–1.62s.
     Done by splitting each h2 into per-character spans (createElement + textContent, never
     innerHTML) that app.css fades in on a per-character delay: the FULL text is in the layout from
     frame 0, only opacity moves, so the line wraps exactly as it will when finished and nothing
     shifts. The h2 keeps its text for assistive tech via aria-label; the spans are aria-hidden.
     Only done here, on the path that plays the intro — no JS, reduced motion and background tabs
     never split anything. Snapping (hxEnd) removes .hx-anim and every span is simply text. */
  /* The panel's two headlines only (owner, 2026-09-25: "i mean just in this box" — the headline and
     subline outside the panel stay on screen from frame 0). */
  const windows = [[".hx-row-coach .hx-h2", 0.45, 0.35], [".hx-row-script .hx-h2", 1.30, 0.32]];
  for (const [selector, t0, span] of windows) {
    const h2 = sec.querySelector(selector);
    if (!h2 || h2.classList.contains("hx-type")) continue;
    const text = h2.textContent;
    h2.setAttribute("aria-label", text);
    h2.textContent = "";
    const chars = Array.from(text);
    const dt = span / Math.max(1, chars.length);
    chars.forEach((ch, i) => {
      const el = document.createElement("span");
      el.className = "hx-ch";
      el.textContent = ch;
      el.setAttribute("aria-hidden", "true");
      const at = (t0 + i * dt).toFixed(3) + "s";
      el.style.animationDelay = at;                       // this character keys in here
      el.style.setProperty("--hx-d", at);                 // ...and its caret shows from here
      el.style.setProperty("--hx-hold", (i === chars.length - 1 ? 0.3 : dt).toFixed(3) + "s");
      h2.appendChild(el);
    });
    h2.classList.add("hx-type");
  }
  sec.classList.add("hx-anim");
  for (const ev of ["pointerdown", "focusin", "keydown", "paste"]) {
    sec.addEventListener(ev, hxStop, { capture: true, passive: true });
  }
})();

/* THE NAV LOGO'S X FLOATS OFF, WANDERS, GASPS AT THE SIGN-UP BUTTONS AND SETTLES ON THE RIGHT CARD
   (owner, 2026-10-06: "for the bounce thing, have it just float and wander and then be in shock when it
   sees the continue with google or email and then go to the right side and be like mmm interesting thats
   cool with emotions and as i scroll down have it follow my cursor"). This replaces the two-hop bounce of
   2026-10-05 (plan ~/.claude/plans/lynxr-logo-intro.md, Revisions 3-12). A plain float was tried and
   withdrawn that day ("i hate that, bring back the bounce"); this one is a float with a story.

   THE PERFORMER IS A SEPARATE LIVE AVATAR (.hx-perf), never the nav's own mark: the static mark shares
   the page's #lx-idle mask with the footer's, so moving it would move both. It is mounted EXACTLY over
   the nav logo at the logo's own size (the two are the same art, so the swap is invisible), the nav
   logo goes to opacity 0 under it, and:
     0.00s  hello: the up-right arm waves (avatar.js lynxrGesture), happy face
     0.60s  it lifts off the nav — no crouch, no spring — and the nav's x does NOT come back: its spot
            closes over .3s (on a phone "get started" glides into it). The right card starts writing
            itself here, so it is finished by the time the x comes to read it.
     THE ROUTE IS THE OWNER'S, drawn on a screenshot (2026-10-06, redrawn the same evening: "this is the new path"):
     OUT    one weightless drift (~2s): out of the logo with a curve, a long sweep right across the open
            band between the bar and the headline, a turn, then straight down just RIGHT of the headline's
            ink onto the sign-up card's top-right corner. A slow bob (app.css hx-perf-float), a lean into
            the way it is going, eyes looking where it goes.
     ~2.6s  THE DOUBLE-TAKE, floating over that corner: it looks down at the buttons and gasps — the
            "shock" face (eyes pop, a "!", arms up) and a little startle jump. "continue with Google"
            rings, then its eyes drop to "continue with email", which rings too (once per page view).
     HOP    ~3.8s, a short curve up and to the right, to its home just off the video card's left edge.
     ~4.7s  "hmm": a squint down at the card, thinking dots, a slow nod — mmm, interesting
     ~6.0s  "cool": happy eyes, sparkles, approving nods — that's cool. Then idle, floating there:
            that corner is its HOME.
   On a phone the sign-up card is hidden: it floats down onto the right card's top edge near its right
   end, gasps at that card's "create your free account" / paste box, then drifts along the edge to the
   top-left corner (home). The times are the 1440x900 ones; the drift's length is measured, its pace fixed.

   THE RULES ARE THE CARD INTRO'S RULES (the FOUR THINGS block above), across the whole performance:
   every load of the signed-out landing; ANY input anywhere — pointer press, focus, key, paste, wheel,
   touch, scroll, resize, the tab going to the background — ends it at once in the finished state (on
   the right card, no x in the nav, card finished: hxStop); merely moving the mouse does not. While it
   performs the x is pointer-events: none, aria-hidden and takes no layout; where it rests is chosen by
   MEASURING the page so it covers no text and no control; no JS or a thrown error leaves the hero
   exactly as it is with no performer at all; reduced motion and a background tab never arm it.
   IT DOES NOT RUN when the gate opens on load (?signup=1, an invite ?e=/?c=, a confirmation, OAuth
   or reset link in the #fragment), when a session is stored (resume() in creator.js takes the visitor
   into the app), or when the cards are not on screen. If the gate opens or the app replaces the page
   mid-flight, it ends.

   ONE X ON SCREEN, EVER (owner, 2026-10-05: "dont leave it there at the top, have it just be the one"):
   after the story it is the page's companion (below) and the nav's x never comes back. Wherever the
   performance does not run, the nav keeps its x and there is no companion. */
const HX_STORY = {
  from: ".lp-bar a.wordmark > svg.mark",
  // the card whose buttons it gasps at (the first on screen: on a phone the sign-up card is display:none)...
  notice: [".hxs", ".hx-panel"],
  // ...and those buttons, per card, in the order its eyes find them
  see: [["#hxs-google", "#hxs-go"], [".hx-new-link", "#lp-composer-form"]],
  rest: ".hx-panel",         // "the right side": it ends floating over this card's top-LEFT corner (home)
  clear: "#hx-buddy-h",      // the headline: the wander keeps to the open band above it
};
/* A list of selectors means "the first one that is on screen". */
const hxPick = (sel) => {
  for (const s of [].concat(sel)) {
    const el = document.querySelector(s), r = el && el.getBoundingClientRect();
    if (r && r.width && r.height) return el;
  }
  return null;
};
(function armPerformer() {
  const sec = document.querySelector("body.home .hx");
  if (!HX.on || !sec) return;   // reduced motion, a background tab, not the landing
  if (/[?&](signup=1|e=|c=)/.test(location.search) || /access_token|refresh_token|error|type=/.test(location.hash)) return;
  try { if (localStorage.getItem("lynxr_creator_session")) return; } catch { /* storage blocked: carry on */ }
  if (document.body.classList.contains("gate-on") || scrollY > 0) return;
  /* HOLD FIRST, MEASURE SECOND: the measuring below forces the first style pass, which is the moment
     the card's CSS animations start — so the hold has to be on before it, and comes off again if the
     performance turns out not to be possible. */
  sec.classList.add("hx-hold");
  for (const s of [HX_STORY.from, HX_STORY.notice, HX_STORY.rest]) {
    if (!hxPick(s)) { sec.classList.remove("hx-hold"); return; }
  }
  PERF.on = true;
  PERF.armed = performance.now();
  // Watchdog: whatever happens below, the card never waits more than 4.5s for its cue.
  setTimeout(() => { if (!HX.started && !HX.over) hxStop(); }, 4500);
})();
if (HX.on && !PERF.on) hxStart();

/* THE BAR IS THERE AT FIRST (owner, 2026-10-06: "for both desktop and mobile, have it first start with the entire nav bar so
   users know that when they scroll the other options are there"). Set here, at the top level, before the first paint: the
   page opens with the whole bar down (app.css .hx-bar-intro). It goes up as the x lifts away from the logo (perform), or on
   any interrupt (the snap), or 2.2s after load where the x does not perform at all. Scrolled already (a reload halfway
   down): nothing to do, the bar is down anyway. */
const BAR_INTRO = document.querySelector("body.home .lp-bar");
const barIntroEnd = () => { if (BAR_INTRO) BAR_INTRO.classList.remove("hx-bar-intro"); };
if (BAR_INTRO && scrollY <= 8) {
  BAR_INTRO.classList.add("hx-bar-intro");
  if (!PERF.on) addEventListener("DOMContentLoaded", () => setTimeout(barIntroEnd, 2200));
}

addEventListener("DOMContentLoaded", () => {
  if (!PERF.on || HX.over) return;
  /* avatar.js has to have run, and the scripts after this one (creator.js is ~12k lines) must not
     have held DOMContentLoaded so long that the card has sat paused in front of a visitor: past
     600ms from arming, the performance is skipped and the card starts on its own. */
  if (typeof window.lynxrAvatar !== "function" || typeof window.lynxrGesture !== "function" ||
      performance.now() - PERF.armed > 600) {
    PERF.on = false; hxStart(); setTimeout(() => barIntroEnd(), 2200); return;
  }
  try { perform(); } catch (ex) { PERF.on = false; if (PERF.end) PERF.end(); else hxStop(); }
});

function perform() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const logo = document.querySelector(HX_STORY.from);
  const card = hxPick(HX_STORY.rest);                       // the right card: where the story ends, the x's home
  const noticeSels = [].concat(HX_STORY.notice);
  const ni = noticeSels.findIndex((s) => hxPick(s));
  const noticeCard = hxPick(noticeSels[ni]);
  const seen = (HX_STORY.see[ni] || []).map((s) => document.querySelector(s)).filter((el) => el && visible(el)).slice(0, 2);
  const SIZE = innerWidth <= 640 ? 34 : 44;                 // Revision 11: smaller, cute not busy
  const FOOT = SIZE * 10 / 120;                             // the X's painted bottom sits 10 units above its box
  const LIFT = 6;                                           // it floats: at rest its feet hover this far above the edge
  const wrap = document.createElement("div");
  wrap.className = "hx-perf";
  wrap.setAttribute("aria-hidden", "true");
  const sq = document.createElement("div");
  sq.className = "hx-perf-sq";
  sq.innerHTML = lynxrAvatar("done");                       // trusted markup from avatar.js, no user input
  wrap.appendChild(sq);
  const svg = sq.querySelector("svg.lx");
  wrap.style.width = wrap.style.height = SIZE + "px";
  const pops = [];       // the one-shot body moves on the inner box (startle, settle, twirl)
  const timers = [];
  const off = new AbortController();
  let driftRaf = 0;

  /* Positions are FEET (bottom-centre). The wrapper turns and grows about its CENTRE, so the translate
     lifts the box by the size it has not grown into yet and the feet stay put. */
  const pose = (x, y, s, r = 0) => `translate(${(x - SIZE / 2).toFixed(2)}px, ${(y - SIZE + (SIZE - s) / 2).toFixed(2)}px) rotate(${r.toFixed(1)}deg) scale(${(s / SIZE).toFixed(4)})`;

  /* WHAT IT MAY NOT COVER, MEASURED ON THE PAINTED PAGE: a box (viewport px) is blocked if any control
     is under the painted x or any line of text comes within PAD of it, or if it is off screen. A 5x5 grid of elementsFromPoint finds what
     is under it; a control under any point blocks; an element's own text blocks if a rect of it comes
     within PAD of the box. The x itself never counts. */
  const PAD = 6;
  const CONTROL = "a, button, input, select, textarea, label, summary, [role=button], [tabindex]";
  const blocked = (left, top, size = SIZE) => {
    if (left < 2 || top < 2 || left + size > innerWidth - 2 || top + size > innerHeight - 2) return true;
    // sample the box grown by PAD, so a shrink-wrapped line of text just beside it is found too
    const seenEls = new Set(), L0 = Math.max(0, left - PAD), T0 = Math.max(0, top - PAD), W = size + 2 * PAD;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      for (const el of document.elementsFromPoint(Math.min(innerWidth - 1, L0 + W * i / 4), Math.min(innerHeight - 1, T0 + W * j / 4))) {
        if (!wrap.contains(el)) seenEls.add(el);
      }
    }
    for (const el of seenEls) {
      /* A control blocks if it is under the painted x itself — not the pad, and not the empty FOOT strip
         under the X's feet, which is meant to sit on the edge of whatever it perches on. */
      const ctl = el.closest(CONTROL);
      if (ctl) {
        const q = ctl.getBoundingClientRect();
        if (left < q.right && left + size > q.left && top < q.bottom && top + size - FOOT - 1 > q.top) return true;
      }
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        for (const r of rg.getClientRects()) {
          if (r.width && left - PAD < r.right && left + size + PAD > r.left && top - PAD < r.bottom && top + size + PAD > r.top) return true;
        }
      }
    }
    return false;
  };
  /* A PERCH: feet `lift` px above `el`'s top edge, as near `prefer` (an x) as the page allows, walking
     outward right first, between lo and hi. null if every spot is blocked. */
  const spotOn = (el, prefer, lo, hi, lift = 0) => {
    const c = el.getBoundingClientRect();
    const top = c.top + FOOT - SIZE - lift;
    for (let d = 0; d <= Math.max(prefer - lo, hi - prefer); d += 4) {
      for (const x of [prefer + d, prefer - d]) {
        if (x < lo || x > hi) continue;
        if (!blocked(x - SIZE / 2, top)) return x;
      }
    }
    return null;
  };
  /* WHERE IT GOES ON A TOUCH SCREEN: THE OWNER'S TARGETS (owner, 2026-10-05: "i essentially want this
     main x to direct the users attention to what i want"; plan Revision 8). Any element in index.html
     marked data-lx-spot is a target — a STATION of the touch guide (THE COMPANION, below), visited as it
     comes into the reading band. Optional: data-lx-side="left|right|top" (where it stands; default the
     first clear side, measured) and data-lx-mood (its face there; default idle). See the comment at the
     top of <main> in index.html. (With a mouse it follows the cursor instead.)
     A PLACE is { el, target, spot() -> { x, dy } | null }: feet at viewport x, and dy below el's top edge.
       the HERO's place, for every hero target, is HOME: floating over the right card's top-left corner,
         where the story ends, looking at that card's first target (the paste box);
       any other target: BESIDE it — on its top edge near its right end, or standing on its baseline
         to its right or left — the first side that covers nothing (blocked). */
  const anchorOf = (el) => {
    /* Never INSIDE a control (a link or a button would take the x into its own hit area and click),
       and never inside a box that clips it: walk up to the first ancestor that is neither. */
    let a = el;
    while (a.parentElement && (a.closest(CONTROL) || getComputedStyle(a).overflow !== "visible")) a = a.parentElement;
    if (getComputedStyle(a).position === "static") a.classList.add("hx-perf-host");
    return a;
  };
  const heroSec = document.querySelector("#lp-main > .hx");
  const homeTarget = () => { for (const t of card.querySelectorAll("[data-lx-spot]")) if (visible(t)) return t; return card; };
  /* HOME (owner, 2026-10-06: "have the lynxr x be on the left side of this"): floating just off the right card's LEFT
     edge, a third of the way down, facing the video — when there is a clear gap there (a desktop: the gutter between
     the two cards). Without one (a phone: the card is the screen's width) it floats over the card's top-left corner. */
  const heroPlace = { el: card, hero: true, get target() { return homeTarget(); }, spot: () => {
    const c = card.getBoundingClientRect();
    const sx = c.left - SIZE / 2 - 14, sy = c.top + Math.min(c.height * 0.3, 220);   // centre of the x
    if (c.left - SIZE - 14 > 8 && !blocked(sx - SIZE / 2, sy - SIZE / 2)) return { x: sx, dy: sy - c.top + SIZE / 2, side: "left" };
    const x = spotOn(card, c.left + SIZE / 2 + 8, c.left + SIZE / 2 + 2, c.left + c.width * 0.5, LIFT);
    return x == null ? null : { x, dy: FOOT - LIFT, side: "top" };
  } };
  const besideSpot = (t) => {
    const b = t.getBoundingClientRect();
    if (!b.width) return null;
    const want = t.getAttribute("data-lx-side");
    const tries = {
      top: () => { const x = spotOn(t, b.right - SIZE * 0.7, b.left + SIZE / 2, b.right - SIZE * 0.2); return x == null ? null : { x, dy: FOOT }; },
      right: () => { const x = b.right + SIZE / 2 + 8, y = b.bottom + FOOT; return blocked(x - SIZE / 2, y - SIZE) ? null : { x, dy: y - b.top }; },
      left: () => { const x = b.left - SIZE / 2 - 8, y = b.bottom + FOOT; return blocked(x - SIZE / 2, y - SIZE) ? null : { x, dy: y - b.top }; },
    };
    for (const side of want && tries[want] ? [want] : ["top", "right", "left"]) {
      const sp = tries[side]();
      if (sp) return { ...sp, side };
    }
    return null;
  };
  const places = new Map();
  const placeFor = (t) => {
    if (!t) return null;
    if (heroSec && heroSec.contains(t) && card.isConnected) return heroPlace;
    if (!places.has(t)) places.set(t, { el: t, target: t, spot: () => besideSpot(t) });
    return places.get(t);
  };
  let place = heroPlace;
  /* THE SHOWCASE MAY SWAP THE CARD'S CONTENT (showcase.js, plan lynxr-showcase.md): home's target is read
     fresh each time (heroPlace.target), and the guide's measured stations are dropped and re-measured. */
  document.addEventListener("lx:spots", () => { if (C.started) onScroll(); });
  /* ONE soft ring per target per page view: a ring element laid over the target (its own radius),
     transform and opacity only, removed when it has played. The target itself is never touched. */
  const rung = new WeakSet();
  const ring = (t) => {
    if (!t || rung.has(t) || reduce.matches) return;
    rung.add(t);
    const r = t.getBoundingClientRect();
    const el = document.createElement("i");
    el.className = "hx-perf-ring";
    el.setAttribute("aria-hidden", "true");
    el.style.left = r.left + "px"; el.style.top = r.top + "px";
    el.style.width = r.width + "px"; el.style.height = r.height + "px";
    el.style.borderRadius = getComputedStyle(t).borderRadius;
    document.body.appendChild(el);
    el.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.05, 1.32)" }],
      { duration: 900, easing: "cubic-bezier(.2, .7, .3, 1)", fill: "forwards" }).finished.then(() => el.remove()).catch(() => el.remove());
  };
  /* SIT: parented to the place's anchor at the measured spot, transform cleared — the page scrolls it. */
  const sit = (pl = place, at = null) => {
    if (F.raf) { cancelAnimationFrame(F.raf); F.raf = 0; }
    place = pl;
    const sp = at || pl.spot() || { x: card.getBoundingClientRect().right - SIZE, dy: FOOT - LIFT };
    const a = anchorOf(pl.el);
    const ar = a.getBoundingClientRect(), c = pl.el.getBoundingClientRect();
    wrap.style.transform = "";
    wrap.classList.add("hx-perf-sat");
    wrap.classList.remove("hx-perf-moving", "hx-perf-follow");
    wrap.style.right = "auto";
    wrap.style.left = (sp.x - SIZE / 2 - ar.left - a.clientLeft).toFixed(1) + "px";
    wrap.style.top = (c.top + sp.dy - SIZE - ar.top - a.clientTop).toFixed(1) + "px";
    if (wrap.parentElement !== a) a.appendChild(wrap);
  };
  // its face at rest: the target's data-lx-mood, else idle — nearly still, it blinks (Revision 11)
  const moodAt = () => (place && place.target && place.target.getAttribute("data-lx-mood")) || "idle";
  /* Where the eyes rest. The pointer-follow leans them off this and back; everything that looks
     somewhere writes it through look(). */
  let faceBase = "";
  const face = svg.querySelector(".lx-face");
  const look = (tr) => { faceBase = tr; if (face) face.style.transform = tr; };
  const LOOK = { l: "translate(-4px, 2px)", r: "translate(4px, 2px)", d: "translate(1px, 5px)", dl: "translate(-2px, 5px)" };
  /* POINT toward an element: the arm on its side reaches toward it for ~0.5s (avatar.js "point"), the
     eyes look at it. pointAt(sp) points at the place's own target. */
  const pointToward = (el, side) => {
    if (!el) return;
    const b = el.getBoundingClientRect(), f = wrap.getBoundingClientRect();
    const dx = b.left + b.width / 2 - (f.left + f.width / 2), below = b.top > f.bottom - 4;
    const dir = Math.abs(dx) > 60 || !below ? (dx < 0 ? "l" : "r") : (side === "top" && dx < 0 ? "dl" : "d");
    lynxrMood(svg, moodAt());
    look(LOOK[dir]);
    if (!reduce.matches) {
      lynxrGesture(svg, "point", dir);
      later(520, () => lynxrGesture(svg, null));
    }
  };
  const pointAt = (sp) => {
    const t = place && place.target;
    if (!t) return;
    pointToward(t, sp && sp.side);
    ring(t);
  };
  /* The nav's spot closes (app.css .hx-perf-gone: the mark's width and the link's gap go to 0) and the
     instant-hide class comes off in the same frame, so nothing flashes. It never comes back while the
     x is on the page (Revision 7). On a phone the bar shows the mark ONLY (no word), so closing it would
     leave a link with nothing in it: there the home link leaves the bar's layout altogether (on the home
     page it is redundant) and "get started" glides from the right end into its spot, a FLIP on transform
     (~280ms), so nothing reflows under a finger mid-tap; the menu button stays right (owner, Revision 10:
     "have the get started button go to the left where it was"). */
  const mark = logo.parentElement;
  const word = mark.querySelector("span");
  /* THE NAME LEAVES WITH THE X (owner, 2026-10-06: "once the lynxr x leaves, have this text also leave but smoothly and
     tastefully like it was by design"). On a desktop, where the top of the page has no bar, the letters of "lynxr"
     dissolve one after another, left to right, drifting a little after the x as it goes (app.css .hx-wl); they come back
     the same way whenever the bar comes down (scrolled, or focus in it) and leave again at the top. The mark's spot is
     closed only once the letters are gone, so nothing visibly slides. The link keeps its name for assistive tech. On a
     phone the bar is always there (owner), so the word stays. */
  let wordOut = false;
  const nameLeaves = () => {
    if (wordOut || !word) return false;
    wordOut = true;
    const text = word.textContent;
    mark.setAttribute("aria-label", text);
    word.textContent = "";
    for (const ch of text) { const l = document.createElement("span"); l.className = "hx-wl"; l.textContent = ch; l.setAttribute("aria-hidden", "true"); word.appendChild(l); }
    void word.offsetWidth;                         // the letters' visible state is painted before they are told to go
    mark.classList.add("hx-word-out");
    timers.push(setTimeout(() => { mark.classList.add("hx-perf-gone"); logo.classList.remove("hx-perf-src"); }, 760));
    return true;
  };
  const closeSpot = () => {
    if (word && word.getBoundingClientRect().width) {
      if (nameLeaves()) return;
      mark.classList.add("hx-perf-gone"); logo.classList.remove("hx-perf-src"); return;
    }
    const bar = mark.closest(".lp-bar-in"), cta = bar && bar.querySelector(".lp-actions > .btn");
    if (!bar || !cta || bar.classList.contains("hx-bar-left")) return;
    const before = cta.getBoundingClientRect();
    bar.classList.add("hx-bar-left");                  // app.css: the link leaves the layout, the CTA goes left
    const after = cta.getBoundingClientRect();
    if (!reduce.matches && cta.animate) {
      cta.animate([{ transform: `translateX(${(before.left - after.left).toFixed(1)}px)` }, { transform: "none" }],
        { duration: 280, easing: "cubic-bezier(.3, .7, .3, 1)" });
    }
  };
  let watch = null;
  const cleanup = () => {
    off.abort();
    if (watch) watch.disconnect();
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    cancelAnimationFrame(driftRaf); driftRaf = 0;
    PERF.end = null;
  };
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  // the landing is gone (signed in: enterApp removed #lp-main) — so is the x
  const gone = () => !card.isConnected || !document.body.classList.contains("home");

  /* ONCE IT IS HOME, IT IS ALIVE (owner, 2026-10-05: "when i hover over the lynxr once its in place,
     have it be like im tickling it and he laughs or something cute. also have it wave from time to
     time"). Only after the story, or after the snap; never in flight, never while it follows the cursor
     (it takes no pointer then: every click goes straight through).
     TICKLE. The x itself takes the pointer while it rests (.hx-perf-live: pointer-events on the mascot
     only — it floats above the card's edge, clear of every control and line of text, measured). Pointer
     in: a ~1.1s giggle — the "giggle" face, a wiggle with a little squash, three tiny hearts popping off.
     Kept there: a softer giggle loop. Out: idle again at once. A burst within 600ms of the last one does
     not restart (no flicker on a jittery edge). A TAP (touch or pen) gives one burst and nothing else.
     WAVE. While settled, the intro's hello every 30-45s — only with the tab visible, the pointer
     elsewhere and no field focused, and at most 3 times a page view (Revision 11: rare).
     EYES. On a desktop, resting at home, the eyes lean toward the pointer when it is within ~300px.
     Reduced motion: no wiggle, hearts or waves; only the face changes while hovered. */
  let alive = false;
  const live = () => {
    if (alive || gone()) return;
    alive = true;
    wrap.classList.add("hx-perf-live");
    const still = () => reduce.matches;
    let hovered = false, lastBurst = -1e9, soft = null, burst = [];
    const restFace = () => { lynxrMood(svg, C.mode === "dock" ? "idle" : moodAt()); };
    const hearts = () => {
      for (let k = 0; k < 3; k++) {
        const h = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        h.setAttribute("viewBox", "0 0 24 24");
        h.setAttribute("class", "hx-perf-heart");
        h.setAttribute("aria-hidden", "true");
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", "M12 21s-7.5-4.6-9.6-9.2A5.2 5.2 0 0 1 12 6.3a5.2 5.2 0 0 1 9.6 5.5C19.5 16.4 12 21 12 21z");
        p.setAttribute("fill", ["#ff7eb8", "#7b61ff", "#ffa078"][k]);
        h.appendChild(p);
        wrap.appendChild(h);
        const dx = (k - 1) * 22, rise = 26 + (k === 1 ? 10 : 0);
        h.animate([
          { opacity: 0, transform: "translate(-50%, 0) scale(.3)" },
          { opacity: 1, transform: `translate(calc(-50% + ${dx * 0.5}px), -${rise * 0.5}px) scale(1)`, offset: 0.3 },
          { opacity: 0, transform: `translate(calc(-50% + ${dx}px), -${rise}px) scale(.8)` },
        ], { duration: 760, delay: k * 90, easing: "ease-out", fill: "both" }).finished.then(() => h.remove()).catch(() => h.remove());
      }
    };
    const wiggle = (amp, ms, iterations = 1) => sq.animate([
      { transform: "none" },
      { transform: `rotate(${-amp}deg) scale(1.06, .92)`, offset: 0.2 },
      { transform: `rotate(${amp}deg) scale(.97, 1.04)`, offset: 0.45 },
      { transform: `rotate(${-amp * 0.6}deg) scale(1.04, .95)`, offset: 0.7 },
      { transform: "none" },
    ], { duration: ms, iterations, easing: "ease-in-out" });
    const stopSoft = () => { if (soft) { soft.cancel(); soft = null; } };
    const giggle = (touch) => {
      lynxrMood(svg, "giggle");
      if (still()) return;
      const now = performance.now();
      if (now - lastBurst < 600) return;
      lastBurst = now;
      stopSoft();
      burst.forEach((a) => a.cancel());
      burst = [wiggle(9, 1100)];
      hearts();
      burst[0].finished.then(() => {
        burst = [];
        if (hovered && !touch) soft = wiggle(4, 900, Infinity);   // still being tickled: a softer giggle
        else restFace();
      }).catch(() => {});
    };
    wrap.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse" || C.mode !== "sat") return;   // touch and pen: the tap below; only at home
      hovered = true;
      giggle(false);
    });
    wrap.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      hovered = false;
      stopSoft();
      if (!burst.length) restFace();
    });
    // it starts following the cursor: whatever tickle was going on stops
    wrap.addEventListener("lx:unhover", () => { hovered = false; stopSoft(); burst.forEach((a) => a.cancel()); burst = []; });
    wrap.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      e.preventDefault();                                  // a tap on decoration does nothing else
      giggle(true);
    });

    // THE WAVE, RARELY (Revision 11): every 30-45s, at most 3 a page view; only settled, on screen, not
    // hovered, and nobody typing anywhere on the page.
    let waves = 0;
    const settled = () => C.still && C.mode !== "fly" && !wrap.classList.contains("hx-perf-duck") && sitOrCornerVisible();
    const sitOrCornerVisible = () => { const r = wrap.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
    const typing = () => { const a = document.activeElement; return !!(a && a.matches("input, textarea, [contenteditable]")); };
    const next = () => setTimeout(tryWave, 30000 + Math.random() * 15000);
    const tryWave = () => {
      if (waves >= 3 || gone()) return;
      if (!still() && !document.hidden && settled() && !hovered && !burst.length && !typing()) {
        waves++;
        lynxrGesture(svg, "hello");
        setTimeout(() => lynxrGesture(svg, null), 750);
      }
      next();
    };
    next();
    /* EYES ON THE POINTER while it rests at home (desktop, Revision 11): within ~300px the eyes lean
       toward it, at most 3 units of the 120 box; further away they go back to wherever they were
       looking. No body movement. Only while it is home. */
    if (matchMedia("(hover: hover)").matches) {
      addEventListener("pointermove", (e) => {
        if (!face || still() || hovered || C.mode !== "sat" || !wrap.isConnected) return;
        const r = wrap.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), d = Math.hypot(dx, dy);
        if (d > 300 || d < 1) { if (face.style.transform !== faceBase) face.style.transform = faceBase; return; }
        face.style.transform = `translate(${(dx / d * 3).toFixed(2)}px, ${(dy / d * 3).toFixed(2)}px)`;
      }, { passive: true });
    }
  };

  /* THE COMPANION, AFTER THE STORY (or the snap). It is the page's one moving x. When the bar comes down it flies up into
     it and is the logo again; when the bar goes up it flies home to the video card (see dock, below). The same on every
     device (owner, 2026-10-06: first for phones, then "the lynxr x going back to the top for mobile, do the same for
     desktop" — it replaced a cursor-follow on desktop and a station-hopping guide on phones, both from earlier that day).
     One spring motor moves it (step); a rAF loop runs only while it moves. Not armed under reduced motion (HX.on false). */
  const C = { mode: "sat", p: null, dest: null, still: true, started: false, quietT: 0 };
  const vv = window.visualViewport;
  const viewH = () => (vv ? vv.height : innerHeight);
  const barBottom = () => { const b = document.querySelector(".lp-bar"); const r = b && b.getBoundingClientRect(); return r && r.bottom > 0 ? r.bottom : 0; };
  const feetNow = () => { const r = wrap.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom }; };
  // a place's spot, if the place is fully on screen below the bar: { x, dy, side } or null
  const spotInView = (pl) => {
    if (!pl || !pl.el.isConnected) return null;
    const c = pl.el.getBoundingClientRect();
    // the bar only counts while it is down: at the top it is not there, and the hero (centred) may start inside its 64px
    if (!c.width || c.top - SIZE < (scrollY > 8 ? barBottom() : 0) + 8 || c.bottom + FOOT > viewH() - 8) return null;
    return pl.spot();
  };
  const put = (x, y, r = 0) => { wrap.style.transform = pose(x, y, SIZE, r); };
  const unsit = () => {   // from sitting (in the page) to fixed in the viewport, at the same spot
    const f = feetNow();
    wrap.classList.remove("hx-perf-sat");
    wrap.style.left = wrap.style.top = wrap.style.right = "";
    document.body.appendChild(wrap);
    C.p = f;
    put(f.x, f.y);
  };
  // arrival: a tiny twirl — the x turns once about its upright axis (a squeeze to edge-on and back)
  const twirl = () => {
    if (reduce.matches) return;
    pops.push(sq.animate([{ transform: "none" }, { transform: "scale(-1, 1)", offset: 0.5 }, { transform: "none" }],
      { duration: 420, easing: "ease-in-out" }));
  };

  /* THE MOTOR. F is the x's feet in viewport px and their velocity. Modes:
       fly     chasing C.dest — { pl, dx, dy, side, t }: feet at pl.el's rect + (dx, dy), read fresh every
               frame so a target that scrolls is chased where it is now — or "dock" (the bar's logo spot)
       sat     landed in the page (sit), the browser scrolls it
       dock    in the bar beside the word, at the logo's size, fixed */
  const F = { x: 0, y: 0, vx: 0, vy: 0, t: 0, raf: 0, lean: 0, moving: false };
  /* IT GOES BACK TO THE BAR (owner, 2026-10-06: "for mobile have the same top nav bar things where it goes away and only
     appears when i scroll down and then as i scroll down bring the lynxr x back to the top next to lynxr", then the same
     for desktop).
     Past 8px the bar comes down (site.js, same threshold); the x flies up into it and takes its old place beside the word
     "lynxr" — the logo again, shrinking to the logo's size as it arrives, with a little wave — and rides there (both are
     fixed to the screen, so nothing lags). Back at the top the bar goes up and the x flies home to the video card. No pointer
     while it is in the bar: a tap there is a tap on the home link. This replaces the guide that hopped between stations
     (earlier the same day); the plans have x's of their own now (planBuddies, below). */
  const docked = () => scrollY > 8;
  const dockPos = () => { const r = logo.getBoundingClientRect(); return { x: r.left + r.height / 2, y: r.bottom, s: r.height }; };
  const destPos = (d) => {
    if (d === "dock") return dockPos();
    const r = d.pl.el.getBoundingClientRect();
    return { x: r.left + d.dx, y: r.top + d.dy };
  };
  const land = () => {
    const d = C.dest;
    wrap.classList.remove("hx-perf-moving");
    C.still = true;
    F.moving = false;
    if (d === "dock") {
      C.mode = "dock";
      const p = dockPos();
      F.x = p.x; F.y = p.y; F.lean = 0;
      wrap.style.transform = pose(p.x, p.y, p.s);
      wrap.classList.add("hx-perf-docked");
      lynxrMood(svg, "done");
      look("");
      if (!reduce.matches) { lynxrGesture(svg, "hello"); later(750, () => lynxrGesture(svg, null)); }
      later(1500, () => { if (C.mode === "dock") lynxrMood(svg, "idle"); });
      return;
    }
    const pos = destPos(d);
    sit(d.pl, { x: pos.x, dy: d.dy });
    C.mode = "sat";
    lynxrMood(svg, moodAt());
    look("");
    twirl();
    later(200, () => { if (C.mode === "sat" && place === d.pl) pointAt({ side: d.side }); });   // points; the target rings once
  };
  const step = (t) => {
    F.raf = 0;
    if (C.mode !== "fly") return;
    if (gone()) { wrap.remove(); return; }
    const dt = Math.min(0.05, Math.max(0.001, (t - F.t) / 1000));
    F.t = t;
    const g = destPos(C.dest);
    // a soft spring a touch under critical damping: it floats after its goal and settles with no bounce to speak of
    const K = 85, D = 2 * Math.sqrt(K) * 0.9;
    F.vx += (K * (g.x - F.x) - D * F.vx) * dt;
    F.vy += (K * (g.y - F.y) - D * F.vy) * dt;
    F.x += F.vx * dt; F.y += F.vy * dt;
    const speed = Math.hypot(F.vx, F.vy), dist = Math.hypot(g.x - F.x, g.y - F.y);
    F.lean += (Math.max(-14, Math.min(14, F.vx * 0.02)) - F.lean) * 0.25;
    C.p = { x: F.x, y: F.y };
    // into the bar it shrinks to the logo's size over its last 120px
    const s = C.dest === "dock" ? SIZE + (g.s - SIZE) * Math.max(0, 1 - dist / 120) : SIZE;
    wrap.style.transform = pose(F.x, F.y, s, F.lean);
    if (face && speed > 40) {   // flying: eyes where it is going
      face.style.transform = `translate(${(F.vx / speed * 3).toFixed(2)}px, ${(F.vy / speed * 2.5).toFixed(2)}px)`;
    }
    // a happy face while it moves, idle (blinking) once it has caught up — with a little hysteresis
    if (!F.moving && speed > 90) { F.moving = true; lynxrMood(svg, "done"); }
    if (dist < 0.6 && speed < 6) {
      F.x = g.x; F.y = g.y; F.vx = F.vy = 0;
      C.p = { x: F.x, y: F.y };
      land();
      return;
    }
    C.still = false;
    wrap.classList.add("hx-perf-moving");
    F.raf = requestAnimationFrame(step);
  };
  const wake = () => { if (!F.raf && C.mode === "fly") { F.t = performance.now(); F.raf = requestAnimationFrame(step); } };
  // leave wherever it is (home, the bar, mid-flight) and chase a destination
  const flyTo = (d) => {
    if (C.mode === "dock") { wrap.classList.remove("hx-perf-docked"); if (d !== "dock") mark.classList.add("hx-perf-gone"); }
    if (C.mode === "sat") unsit();
    if (C.mode !== "fly") { const f = C.p || feetNow(); F.x = f.x; F.y = f.y; F.vx = F.vy = 0; }
    C.dest = d;
    C.mode = "fly";
    C.still = false;
    lynxrGesture(svg, null);
    wrap.dispatchEvent(new Event("lx:unhover"));
    wrap.classList.remove("hx-perf-duck");
    wrap.classList.add("hx-perf-follow");   // no pointer while it flies or sits in the bar
    wake();
  };
  const homeDest = () => {
    const sp = spotInView(heroPlace);
    return sp ? { pl: heroPlace, dx: sp.x - card.getBoundingClientRect().left, dy: sp.dy, side: sp.side, t: null } : null;
  };

  // into the bar: the logo's spot opens again (still invisible under the x); out of it: home, and the spot closes behind it
  const dock = () => { mark.classList.remove("hx-perf-gone"); logo.classList.add("hx-perf-src"); flyTo("dock"); };
  const undock = () => { const d = homeDest(); if (d) flyTo(d); };
  const inDock = () => C.mode === "dock" || (C.mode === "fly" && C.dest === "dock");

  const onScroll = () => {
    if (gone()) return;
    if (document.body.classList.contains("lp-menu-open")) return;   // the open phone menu pins the page at 0: not a real return to the top
    clearTimeout(C.quietT);
    if (docked()) { if (!inDock()) dock(); }
    else if (inDock()) C.quietT = setTimeout(() => { if (!docked() && inDock()) undock(); }, 120);
  };
  const follow = () => {
    if (C.started) return;
    C.started = true;
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", () => {
      if (C.mode === "sat" && place) sit(place);   // re-measure the spot for the new layout
      if (C.mode === "fly") wake();
      if (C.mode === "dock") { const p = dockPos(); wrap.style.transform = pose(p.x, p.y, p.s); }
      onScroll();
    }, { passive: true });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) onScroll(); });
  };

  /* THE SNAP — any input, the watchdog, or a thrown error. If the hero has gone (signed in: enterApp
     removed #lp-main) the performer goes with it and the nav keeps its x; otherwise it is home on the
     right card and the nav's spot is closed. */
  PERF.end = () => {
    cleanup();
    barIntroEnd();
    for (const a of pops) a.cancel();
    if (gone()) { wrap.remove(); logo.classList.remove("hx-perf-src"); mark.classList.remove("hx-perf-gone"); mark.closest(".lp-bar-in")?.classList.remove("hx-bar-left"); return; }
    closeSpot();
    lynxrGesture(svg, null);
    sit(heroPlace);
    lynxrMood(svg, moodAt());
    look("");
    for (const t of seen) rung.add(t);           // an interrupted story does not ring later either
    rung.add(heroPlace.target);
    follow();
    live();
    if (scrollY > 2) onScroll();                  // a scroll ended it: start following straight away
  };

  // MOUNT, exactly over the nav logo.
  const L = logo.getBoundingClientRect();
  const start = { x: L.left + L.width / 2, y: L.bottom, s: L.width };
  wrap.style.transform = pose(start.x, start.y, start.s);
  document.body.appendChild(wrap);
  logo.classList.add("hx-perf-src");

  // Every interruption is an hxStop, from anywhere on the page, once. (A mouse that only moves is not one.)
  const stop = () => hxStop();
  for (const ev of ["pointerdown", "focusin", "keydown", "paste", "wheel", "touchstart"]) {
    document.addEventListener(ev, stop, { capture: true, passive: true, signal: off.signal });
  }
  addEventListener("scroll", stop, { passive: true, signal: off.signal });
  addEventListener("resize", stop, { signal: off.signal });
  document.addEventListener("visibilitychange", stop, { signal: off.signal });
  reduce.addEventListener?.("change", stop, { signal: off.signal });
  // The gate opening, or the app replacing the page, mid-flight.
  watch = new MutationObserver(() => {
    if (document.body.classList.contains("gate-on") || !document.body.classList.contains("home")) hxStop();
  });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  /* A DRIFT: one smooth, weightless curve through feet positions (Catmull-Rom, resampled by ARC LENGTH
     so the pace is even), played on rAF under one ease-in-out (sine), with a lean into the direction of
     travel and the eyes looking where it goes. The size grows from the nav logo's to SIZE over the
     first quarter of the first drift. The bob is the CSS float on the inner box (app.css). */
  const pathOf = (P) => {
    const Q = [P[0], ...P, P[P.length - 1]], out = [];
    const cr = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
    for (let i = 1; i < Q.length - 2; i++) {
      for (let k = 0; k < 24; k++) {
        const t = k / 24;
        out.push({ x: cr(Q[i - 1].x, Q[i].x, Q[i + 1].x, Q[i + 2].x, t), y: cr(Q[i - 1].y, Q[i].y, Q[i + 1].y, Q[i + 2].y, t) });
      }
    }
    out.push(P[P.length - 1]);
    const len = [0];
    for (let i = 1; i < out.length; i++) len.push(len[i - 1] + Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y));
    return { out, len, L: len[len.length - 1] || 1 };
  };
  const posAt = (path, s) => {
    let i = 1;
    while (i < path.len.length - 1 && path.len[i] < s) i++;
    const a = path.out[i - 1], b = path.out[i], seg = (path.len[i] - path.len[i - 1]) || 1, u = Math.min(1, Math.max(0, (s - path.len[i - 1]) / seg));
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  };
  const drift = (P, pace, done, s0 = SIZE) => {
    const path = pathOf(P);
    const ms = Math.round(Math.min(pace[2], Math.max(pace[1], pace[0] * path.L)));
    const t0 = performance.now();
    let last = null, lean = 0;
    wrap.classList.add("hx-perf-moving");
    const frame = (t) => {
      driftRaf = 0;
      if (!PERF.end) return;
      const u = Math.min(1, (t - t0) / ms);
      const e = 0.5 - 0.5 * Math.cos(Math.PI * u);
      const p = posAt(path, e * path.L);
      if (last) {
        const dt = Math.max(1, t - last.t) / 1000, vx = (p.x - last.x) / dt, vy = (p.y - last.y) / dt, v = Math.hypot(vx, vy);
        lean += (Math.max(-10, Math.min(10, vx * 0.02)) - lean) * 0.2;
        if (v > 40) look(`translate(${(vx / v * 3).toFixed(2)}px, ${(vy / v * 2.5).toFixed(2)}px)`);
      }
      last = { x: p.x, y: p.y, t };
      wrap.style.transform = pose(p.x, p.y, s0 + (SIZE - s0) * Math.min(1, e * 4), lean);
      if (u >= 1) { done(); return; }
      driftRaf = requestAnimationFrame(frame);
    };
    driftRaf = requestAnimationFrame(frame);
  };

  /* THE STORY, measured once, now. Feet positions in viewport coordinates. */
  const vw = innerWidth;
  const nc = noticeCard.getBoundingClientRect(), cc = card.getBoundingClientRect();
  const top0 = barBottom() + SIZE + 14;                                   // its box stays clear of the bar
  // the headline's INK — its text lines, not its box: the box is as wide as the column and the text is centred in it
  const ink = (() => {
    const h = hxPick(HX_STORY.clear);
    if (!h) return null;
    const rg = document.createRange(); rg.selectNodeContents(h);
    const rs = [...rg.getClientRects()].filter((r) => r.width);
    if (!rs.length) return null;
    return { left: Math.min(...rs.map((r) => r.left)), right: Math.max(...rs.map((r) => r.right)),
      top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)) };
  })();
  const two = noticeCard !== card && !!ink;    // both cards on screen (not a phone)
  /* WHERE IT GASPS: floating over the sign-up card's top edge near its RIGHT end, just clear of the headline's ink (the
     owner's redrawn route, 2026-10-06: "this is the new path"); a phone: the right card, near its right end. */
  const nPrefer = two ? Math.min(nc.right - SIZE / 2 - 10, Math.max(nc.left + nc.width * 0.85, ink.right + SIZE / 2 + 12)) : nc.left + nc.width * 0.75;
  const nx = spotOn(noticeCard, nPrefer, nc.left + SIZE / 2, nc.right - SIZE / 2, LIFT);
  const N = { x: nx ?? nPrefer, y: nc.top + FOOT - LIFT };
  const Rsp = heroPlace.spot() || { x: cc.left + SIZE / 2 + 8, dy: FOOT - LIFT };
  const R = { x: Rsp.x, y: cc.top + Rsp.dy };
  /* THE ROUTE, as the owner drew it (2026-10-06, second drawing): out of the logo with a curve, a long sweep right across
     the open band between the bar and the headline, a turn, then straight DOWN just right of the headline's ink onto N.
     `band` is that sweep's height: halfway between the bar and the ink's top (feet, so the box sits inside the gap). */
  const sweep = two ? Math.max(top0, (barBottom() + ink.top) / 2 + SIZE / 2) : 0;
  const W = two
    ? [start, { x: start.x + 26, y: start.y + (sweep - start.y) * 0.6 }, { x: start.x + (N.x - start.x) * 0.3, y: sweep },
       { x: N.x - 70, y: sweep + 2 }, { x: N.x, y: sweep + 64 }, { x: N.x, y: Math.max(sweep + 90, ink.bottom) }, N]
    : [start, { x: vw * 0.55, y: (start.y + N.y) / 2 }, N];
  // THEN A SHORT HOP up and to the right, to home beside the video card
  const ARC = two
    ? [N, { x: N.x + (R.x - N.x) * 0.35, y: Math.max(top0, Math.min(N.y, R.y) - 36) }, R]
    : [N, { x: (N.x + R.x) / 2, y: Math.max(top0, Math.min(N.y, R.y) - 24) }, R];

  /* THE DOUBLE-TAKE: a gasp and a little startle jump; the first button rings, then its eyes drop to the second. */
  const notice = () => {
    if (!PERF.end) return;
    wrap.classList.remove("hx-perf-moving");
    lynxrMood(svg, "shock");
    look(two ? "translate(-2px, 5px)" : "translate(2px, 4px)");    // down at the buttons (below-left of the corner)
    pops.push(sq.animate([
      { transform: "none" },
      { transform: "translateY(-12px) scale(.94, 1.08)", offset: 0.35 },
      { transform: "translateY(0) scale(1.08, .92)", offset: 0.7 },
      { transform: "none" },
    ], { duration: 420, easing: "ease-out" }));
    later(80, () => ring(seen[0]));
    if (seen[1]) later(560, () => { if (PERF.end) { look("translate(1px, 6px)"); ring(seen[1]); } });
    later(1200, toRight);
  };
  /* TO THE RIGHT SIDE: the big arc over the headline onto the right card's top-left corner, arriving with a soft dip. */
  const toRight = () => {
    if (!PERF.end) return;
    lynxrMood(svg, "idle");
    /* Measure home again now: the showcase (showcase.js) may have swapped the card for its own shape since the
       route was measured, and the x must land on the card that is actually there. */
    const fresh = heroPlace.spot();
    if (fresh) {
      Rsp.x = R.x = fresh.x; Rsp.dy = fresh.dy; Rsp.side = fresh.side; R.y = card.getBoundingClientRect().top + fresh.dy;
      if (two && ARC.length === 3) ARC[1] = { x: N.x + (R.x - N.x) * 0.35, y: Math.max(top0, Math.min(N.y, R.y) - 36) };
    }
    drift(ARC, [1.6, 900, 1700], react);
  };
  /* "mmm, interesting" — then "that's cool" — then it is home. */
  const react = () => {
    if (!PERF.end) return;
    wrap.classList.remove("hx-perf-moving");
    pops.push(sq.animate([{ transform: "none" }, { transform: "translateY(3px) scale(1.04, .96)", offset: 0.4 }, { transform: "none" }],
      { duration: 380, easing: "ease-out" }));
    lynxrMood(svg, "hmm");
    look(Rsp.side === "left" ? "translate(4px, 1px)" : "translate(3px, 4px)");   // at the video beside it / below it
    later(1300, () => {
      if (!PERF.end) return;
      lynxrMood(svg, "cool");
      look("");
      later(1200, () => {
        if (!PERF.end) return;
        cleanup();
        sit(heroPlace, Rsp);
        lynxrMood(svg, moodAt());
        rung.add(heroPlace.target);
        follow();
        later(300, live);
      });
    });
  };

  /* HELLO at the nav (0.6s), then it simply lifts off and wanders — or, on a phone (no sign-up card beside it), JUST DROPS
     STRAIGHT DOWN from the logo to its spot on the video card (owner, 2026-10-06: "for mobile lynxr x have it just go
     straight down") and does its "hmm… cool" there. */
  lynxrGesture(svg, "hello");
  later(600, () => {
    if (!PERF.end) return;
    lynxrGesture(svg, null);
    lynxrMood(svg, "idle");
    hxStart();                                     // the right card writes itself while the x wanders
    later(60, closeSpot);                          // it has left the logo's box by now
    later(420, barIntroEnd);                       // ...and the bar it left goes up, the name dissolving with it
    if (two) { drift(W, [2.4, 1500, 2400], notice, start.s); return; }
    const fresh = heroPlace.spot();                // the showcase may have changed the card since the route was measured
    if (fresh) { Rsp.x = R.x = fresh.x; Rsp.dy = fresh.dy; Rsp.side = fresh.side; R.y = card.getBoundingClientRect().top + fresh.dy; }
    drift([start, R], [2.2, 900, 1600], react, start.s);
  });
}

/* THE PLANS' OWN X'S (owner, 2026-10-06: "bring the x's back to the payment options on the deadspace next to the price",
   then "have the most premium package be happier and the free is normal"). One live avatar per plan, beside its price
   (index.html .lp-plan-x; avatar.js draws it from data-lx-mood), and its mood climbs with the plan: free "idle" (calm,
   blinking), pro "done" (happy), max "hyped" (star eyes, sparkles, a bouncy hop). So does its greeting the first time its
   card is mostly on screen — free a wave, pro a hop and a wave, max a hop, a spin and a wave — the three a beat apart; then
   they float (app.css), and every 5-8s one of those on screen waves. Decorative. Reduced motion: their faces only. */
(function planBuddies() {
  addEventListener("DOMContentLoaded", () => {
    if (!document.body.classList.contains("home") || typeof window.lynxrAvatar !== "function") return;
    const xs = [...document.querySelectorAll(".lp-plan-x")];
    for (const x of xs) if (!x.querySelector("svg.lx")) { x.innerHTML = lynxrAvatar("done"); x.setAttribute("data-lx-done", ""); }   // trusted markup
    if (!xs.length || matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const wave = (x) => {
      const svg = x.querySelector("svg.lx");
      if (!svg) return;
      lynxrGesture(svg, "hello");
      setTimeout(() => lynxrGesture(svg, null), 750);
    };
    const party = (x) => {
      const svg = x.querySelector("svg.lx");
      if (!svg) return;
      const mood = x.getAttribute("data-lx-mood") || "done";
      if (mood === "idle") { wave(x); return; }                              // free: a plain hello
      const hop = [
        { transform: "none" },
        { transform: "translateY(-12px) rotate(-10deg)", offset: 0.3 },
        { transform: "translateY(0) scale(1.1, .9)", offset: 0.62 },
        { transform: "none" },
      ];
      const spin = [
        { transform: "none" },
        { transform: "translateY(-12px) rotate(-10deg)", offset: 0.18 },
        { transform: "translateY(0) scale(1.1, .9)", offset: 0.34 },
        { transform: "translateY(-16px) scaleX(-1)", offset: 0.55 },          // a spin, mid-air
        { transform: "translateY(0) scale(1.08, .92)", offset: 0.74 },
        { transform: "none" },
      ];
      const big = mood === "hyped";
      if (!big) lynxrMood(svg, "giggle");
      x.animate(big ? spin : hop, { duration: big ? 1400 : 800, easing: "ease-in-out" })
        .finished.then(() => { lynxrMood(svg, mood); wave(x); }).catch(() => {});
    };
    const partied = new WeakSet();
    const io = new IntersectionObserver((list) => {
      for (const en of list) {
        const x = en.target;
        x.lxOn = en.isIntersecting && en.intersectionRatio >= 0.6;
        if (x.lxOn && !partied.has(x)) { partied.add(x); setTimeout(() => party(x), 160 * xs.indexOf(x)); }
      }
    }, { threshold: [0, 0.6, 1] });
    xs.forEach((x) => io.observe(x));
    const now = () => {
      const on = xs.filter((x) => x.lxOn);
      if (on.length && !document.hidden) wave(on[Math.floor(Math.random() * on.length)]);
      setTimeout(now, 5000 + Math.random() * 3000);
    };
    setTimeout(now, 6000);
  });
})();

if ($("wait-form")) $("wait-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("wait-email");
  const email = input.value.trim().toLowerCase();
  const btn = $("wait-go");

  if (!looksLikeEmail(email)) {
    say("that doesn't look like an email address.", "bad");
    input.focus();
    return;
  }

  btn.disabled = true;
  say("adding you…");
  try {
    const send = (row) => fetch(`${SB_URL}/rest/v1/lynxr_waitlist`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        "Content-Type": "application/json",
        // return=minimal because the policy allows INSERT and not SELECT, so
        // asking for the row back would fail a write that actually succeeded.
        //
        // And deliberately NOT resolution=merge-duplicates: that turns the
        // insert into an UPSERT, which Postgres checks against the UPDATE
        // policy as well — and there isn't one, by design, so every submission
        // came back "new row violates row-level security policy" even though
        // the insert itself was allowed. A repeat email is handled by letting
        // it 409 below, which is what we want anyway.
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });

    let res = await send({ email, source: SOURCE, consent: CONSENT });
    // PGRST204 is "column not found" — waitlist_consent.sql has not been run in
    // this project yet. PostgREST rejects the WHOLE insert when a payload names
    // a column that does not exist, so shipping the consent tag first would
    // have turned every signup into a failure. A real signup is worth more than
    // its consent tag, so drop the tag and keep the address. Narrow on purpose:
    // any other error still surfaces to the visitor below.
    if (!res.ok && res.status !== 409) {
      const why = await res.clone().text();
      if (why.includes("PGRST204")) res = await send({ email, source: SOURCE });
    }

    // 409 means the email is already on the list. That is a success from the
    // visitor's side, and saying "already there" would confirm to a stranger
    // which addresses have signed up.
    if (res.ok || res.status === 409) {
      // Only mirror a genuinely new signup. A 409 means they are already on
      // the list, and copying that to the sheet would add a duplicate row for
      // someone who simply submitted twice.
      if (res.ok) mirrorToSheet(email);
      $("wait-form").hidden = true;
      // The promise line goes with the form. Leaving "leave your email for
      // launch news" sitting above "you're on the list" reads as a submit that
      // did not take — the card has to end in ONE state, not two.
      if ($("wait-sub")) $("wait-sub").hidden = true;
      // Restates the promise rather than widening it. The confirmation is the
      // last thing they read, so it must not quietly enlarge the consent —
      // anything vaguer ("we'll be in touch", "expect news") would claim more
      // than the form above asked for.
      say("you're on the list. we'll update you about the launch.", "good");
      return;
    }
    // The table not existing is the one failure worth naming precisely — it is
    // a deployment step, not the visitor's problem, and it looks identical to
    // a network error from out here.
    const body = await res.text();
    if (body.includes("PGRST205")) {
      say("the waitlist isn't set up yet. try again shortly.", "bad");
    } else {
      say("that didn't send. try again in a moment.", "bad");
    }
  } catch {
    say("that didn't send — check your connection.", "bad");
  } finally {
    btn.disabled = false;
  }
});
})();
