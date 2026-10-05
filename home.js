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

/* THE NAV LOGO WAVES, BOUNCES AROUND THE SCREEN AND LANDS ON THE SIGN-UP CARD (owner, 2026-10-05:
   "have the logo on the top left start out by waving and then bounce around the screen and go towards
   the action buttons here", then "have it just be the one"; a floating version was tried the same day
   and withdrawn: "i hate that, bring back the bounce"). Plan: ~/.claude/plans/lynxr-logo-intro.md.

   THE PERFORMER IS A SEPARATE LIVE AVATAR (.hx-perf), never the nav's own mark: the static mark shares
   the page's #lx-idle mask with the footer's, so moving it would move both. It is mounted EXACTLY over
   the nav logo at the logo's own size (the two are the same art, so the swap is invisible), the nav
   logo goes to opacity 0 under it, and:
     0.00s  hello: the up-right arm waves twice while the X rocks (avatar.js lynxrGesture), happy face
     0.70s  a ~90ms crouch, then it springs off the nav, star-eyed ("hyped") — and the nav's x does NOT
            come back: its spot closes over .3s (on a phone "get started" glides into it instead)
     HOP 1  it falls down the LEFT side, bowed out past the headline, onto the sign-up card's top edge
            near its left end (~1.4s): a soft two-dot puff — and the right card's reveal starts there
     HOP 2  springing straight out of that landing: ONE smooth curve over the headline (apex ~70px above
            its top line) with a small twirl, onto the card's top edge near its right end
     ~2.1s  a soft settle; it looks down at "continue with Google" as the button rings ONCE (softly).
            Then it stays PERCHED, nearly still, parented into the page so it scrolls with it; after
            that it is the calm companion (below).
   Hop 1 is a parabola under gravity with a gentle stretch (legPlan); hop 2 is a Bezier (curveKeys).
   The legs' durations follow their measured length, so the times above are the 1280x800 ones.

   THE RULES ARE THE CARD INTRO'S RULES (the FOUR THINGS block above), across the whole performance:
   every load of the signed-out landing; ANY input anywhere — pointer, focus, key, paste, wheel, touch,
   scroll, resize, the tab going to the background — ends it at once in the finished state (perched,
   no x in the nav, card finished: hxStop); the performer is pointer-events: none, aria-hidden, takes
   no layout, and its perch is chosen by MEASURING the page so it covers no text and no control; no JS
   or a thrown error leaves the hero exactly as it is with no performer at all; reduced motion and a
   background tab never arm it (HX.on is false).
   IT DOES NOT RUN when the gate opens on load (?signup=1, an invite ?e=/?c=, a confirmation, OAuth
   or reset link in the #fragment), when a session is stored (resume() in creator.js takes the visitor
   into the app), or when the sign-up card is not on screen — at 640px and under it is display:none
   (owner, 2026-09-23: "remove this on mobile"), so on a phone there is no performer and the card intro
   runs on its old timeline. If the gate opens or the app replaces the page mid-flight, it ends.

   ONE X ON SCREEN, EVER (owner, 2026-10-05: "dont leave it there at the top, have it just be the one"),
   AND IT COMES DOWN THE PAGE WITH YOU ("have the one lynxr be dynamic so that as i scroll it goes down
   with you"): after landing it is the page's companion (follow, below) and the nav's x never comes
   back. Wherever the performance does not run, the nav keeps its x and there is no companion.

   THE ROUTE IS DATA — the owner drew it on a screenshot (2026-10-05, plan Revision 6): TWO hops, both
   onto the sign-up card. Each stop names what it is measured from, so the same two hops work at every
   size and survive a redesign of either card:
     { from: sel }                       the start: the centre-bottom of the nav logo, at its size
     { land: sel, x, bow, starts }       hop 1: springs off the nav and falls down the LEFT side, bowed
                                         out by up to `bow` px, onto sel's top edge at fraction x of its
                                         width; `starts` makes the right card's reveal begin on impact
     { perch: sel, over, clear, gap,     hop 2, the big one: one arc whose apex is `gap` px above the top
       spin }                            of `clear` (the headline), over its left-centre, onto sel's top
                                         edge as close above `over` as the page's text allows — where it
                                         stays (one smooth curve, curveKeys).
   The apex is lowered only as far as the viewport needs (and the arc still clears the headline). */
/* A list of selectors means "the first one that is on screen": on a phone the sign-up card is
   display:none (owner, 2026-09-23), so both hops land on the right-hand card instead (Revision 7: "have
   it play on the phone and we'll work on the mobile display later"). */
const HX_ROUTE = [
  { from: ".lp-bar a.wordmark > svg.mark" },
  { land: [".hxs", ".hx-panel"], x: 0.1, bow: 36, starts: true },
  { perch: [".hxs", ".hx-panel"], over: ["#hxs-google", ".hx-panel"], clear: "#hx-buddy-h", gap: 70, spin: true },
];
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
  // Every stop must be on screen now, or there is no performance (a phone: .hxs is display:none).
  for (const stop of HX_ROUTE) {
    for (const s of [stop.from, stop.land, stop.perch, stop.over, stop.clear]) {
      if (s && !hxPick(s)) { sec.classList.remove("hx-hold"); return; }
    }
  }
  PERF.on = true;
  PERF.armed = performance.now();
  // Watchdog: whatever happens below, the card never waits more than 4.5s for its cue.
  setTimeout(() => { if (!HX.started && !HX.over) hxStop(); }, 4500);
})();
if (HX.on && !PERF.on) hxStart();

addEventListener("DOMContentLoaded", () => {
  if (!PERF.on || HX.over) return;
  /* avatar.js has to have run, and the scripts after this one (creator.js is ~12k lines) must not
     have held DOMContentLoaded so long that the card has sat paused in front of a visitor: past
     600ms from arming, the performance is skipped and the card starts on its own. */
  if (typeof window.lynxrAvatar !== "function" || typeof window.lynxrGesture !== "function" ||
      performance.now() - PERF.armed > 600) {
    PERF.on = false; hxStart(); return;
  }
  try { perform(); } catch (ex) { PERF.on = false; if (PERF.end) PERF.end(); else hxStop(); }
});

function perform() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const logo = document.querySelector(HX_ROUTE[0].from);
  const last = HX_ROUTE[HX_ROUTE.length - 1];
  const card = hxPick(last.perch), over = hxPick(last.over);
  // the plan's 48-56px, a little smaller on a tablet, ~38px on a phone (Revision 7)
  const SIZE = innerWidth <= 640 ? 34 : 44;   // Revision 11: smaller, cute not busy
  const FOOT = SIZE * 10 / 120;                            // the X's painted bottom sits 10 units above its box
  const wrap = document.createElement("div");
  wrap.className = "hx-perf";
  wrap.setAttribute("aria-hidden", "true");
  const sq = document.createElement("div");
  sq.className = "hx-perf-sq";
  sq.innerHTML = lynxrAvatar("done");                      // trusted markup from avatar.js, no user input
  wrap.appendChild(sq);
  const svg = sq.querySelector("svg.lx");
  wrap.style.width = wrap.style.height = SIZE + "px";
  const anims = [];      // the flight, on the wrapper
  const pops = [];       // the squashes, on the inner box; a natural landing lets its last one finish
  const timers = [];
  const off = new AbortController();

  /* Positions are FEET (bottom-centre). The wrapper turns and grows about its CENTRE (a spin about the
     feet would cartwheel it across the screen), so the translate lifts the box by the size it has not
     grown into yet and the feet stay put; the inner box squashes and stretches about the feet. */
  const pose = (x, y, s, r = 0) => `translate(${(x - SIZE / 2).toFixed(2)}px, ${(y - SIZE + (SIZE - s) / 2).toFixed(2)}px) rotate(${r.toFixed(1)}deg) scale(${(s / SIZE).toFixed(4)})`;
  const rect = (sel) => hxPick(sel).getBoundingClientRect();

  /* WHAT IT MAY NOT COVER, MEASURED ON THE PAINTED PAGE: a box (viewport px) is blocked if any control
     is under the painted x or any line of text comes within PAD of it, or if it is off screen. A 4x4 grid of elementsFromPoint finds what
     is under it; a control under any point blocks; an element's own text blocks if a rect of it comes
     within PAD of the box. The x itself never counts. */
  const PAD = 6;
  const CONTROL = "a, button, input, select, textarea, label, summary, [role=button], [tabindex]";
  const blocked = (left, top, size = SIZE) => {
    if (left < 2 || top < 2 || left + size > innerWidth - 2 || top + size > innerHeight - 2) return true;
    // sample the box grown by PAD, so a shrink-wrapped line of text just beside it is found too
    const seen = new Set(), L0 = Math.max(0, left - PAD), T0 = Math.max(0, top - PAD), W = size + 2 * PAD;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      for (const el of document.elementsFromPoint(Math.min(innerWidth - 1, L0 + W * i / 4), Math.min(innerHeight - 1, T0 + W * j / 4))) {
        if (!wrap.contains(el)) seen.add(el);
      }
    }
    for (const el of seen) {
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
  /* A PERCH: feet on `el`'s top edge, as near `prefer` (an x) as the page allows, walking outward right
     first, between lo and hi. null if every spot is blocked. */
  const spotOn = (el, prefer, lo, hi) => {
    const c = el.getBoundingClientRect();
    const top = c.top + FOOT - SIZE;
    for (let d = 0; d <= Math.max(prefer - lo, hi - prefer); d += 4) {
      for (const x of [prefer + d, prefer - d]) {
        if (x < lo || x > hi) continue;
        if (!blocked(x - SIZE / 2, top)) return x;
      }
    }
    return null;
  };
  /* WHERE IT GOES: THE OWNER'S TARGETS (owner, 2026-10-05: "i essentially want this main x to direct the
     users attention to what i want"; plan Revision 8). Any element in index.html marked data-lx-spot is
     a target; the section of #lp-main that fills most of the viewport decides which (its first target
     that is on screen). Optional: data-lx-side="left|right|top" (where it stands; default the first
     clear side, measured) and data-lx-mood (its face there; default "done", happy). See the comment at
     the top of <main> in index.html.
     A PLACE is { el, spot() -> { x, dy } | null }: feet at viewport x, and dy below el's top edge.
       the HERO target sits where the intro lands it: the landing card's top edge, ~88% across, over
         the right end of `over` (the Google button; on a phone the panel, which holds the paste box);
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
  const heroPlace = { el: card, hero: true, spot: () => {
    const b = over.getBoundingClientRect(), c = card.getBoundingClientRect();
    const x = spotOn(card, Math.min(b.right - SIZE / 2, c.left + c.width * 0.88), b.left + SIZE / 2, b.right - SIZE / 2);
    return x == null ? null : { x, dy: FOOT, side: "top" };
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
    if (!places.has(t)) places.set(t, heroSec && heroSec.contains(t) && card.isConnected ? { ...heroPlace, target: t } : { el: t, target: t, spot: () => besideSpot(t) });
    return places.get(t);
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // the section filling most of the viewport, and its first on-screen target (or null)
  const wantedTarget = () => {
    const main = document.getElementById("lp-main");
    if (!main) return null;
    /* "Fills most of the screen" as a SHARE of what that section could show: a short section that is
       wholly on screen (the closing band on a phone, 340px) beats a tall one that is partly on screen. */
    let best = null, most = 0;
    for (const sec of main.children) {
      const r = sec.getBoundingClientRect();
      const seen = Math.min(innerHeight, r.bottom) - Math.max(0, r.top);
      const share = seen / Math.max(1, Math.min(r.height, innerHeight)) + seen / 1e5;   // ties: more px
      if (seen > 0 && share > most) { most = share; best = sec; }
    }
    if (!best) return null;
    for (const t of best.querySelectorAll("[data-lx-spot]")) if (visible(t)) return t;
    return null;
  };
  const heroTarget = () => { for (const t of (heroSec ? heroSec.querySelectorAll("[data-lx-spot]") : [])) if (visible(t)) return t; return null; };
  let place = placeFor(heroTarget()) || { ...heroPlace, target: over };
  /* THE SHOWCASE MAY SWAP THE CARD (showcase.js, plan lynxr-showcase.md): the hero's targets change. Before the x has
     landed, re-pick its target; after, let the normal quiet-then-decide path move it. */
  document.addEventListener("lx:spots", () => {
    if (C.started) { onScroll(); return; }
    const t = heroTarget();
    if (t && place && place.target !== t) place = placeFor(t) || place;
  });
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
    for (const a of anims) a.cancel();
    anims.length = 0;
    place = pl;
    const sp = at || pl.spot() || { x: over.getBoundingClientRect().right - SIZE / 2, dy: FOOT };
    const a = anchorOf(pl.el);
    const ar = a.getBoundingClientRect(), c = pl.el.getBoundingClientRect();
    wrap.style.transform = "";
    wrap.classList.add("hx-perf-sat");
    wrap.style.right = "auto";
    wrap.style.left = (sp.x - SIZE / 2 - ar.left - a.clientLeft).toFixed(1) + "px";
    wrap.style.top = (c.top + sp.dy - SIZE - ar.top - a.clientTop).toFixed(1) + "px";
    if (wrap.parentElement !== a) a.appendChild(wrap);
  };
  // its face at rest: the target's data-lx-mood, else idle — nearly still, it blinks (Revision 11)
  const moodAt = () => (place && place.target && place.target.getAttribute("data-lx-mood")) || "idle";
  /* Where the eyes rest. The pointer-follow (live) leans them off this and back; everything that
     looks somewhere writes it through look(). */
  let faceBase = "";
  const look = (tr) => { faceBase = tr; const f = svg.querySelector(".lx-face"); if (f) f.style.transform = tr; };
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
  const lookDown = () => {
    lynxrGesture(svg, null);
    lynxrMood(svg, moodAt());
    look("translate(-1px, 5px)");   // eyes on the buttons below it
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
  const closeSpot = () => {
    if (word && word.getBoundingClientRect().width) { mark.classList.add("hx-perf-gone"); logo.classList.remove("hx-perf-src"); return; }
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
  const fx = new Set();   // the shadows and puffs on screen; removed on landing and on the snap
  const cleanup = () => {
    for (const el of fx) el.remove();
    fx.clear();
    off.abort();
    if (watch) watch.disconnect();
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    PERF.end = null;
  };

  /* ONCE PERCHED, IT IS ALIVE (owner, 2026-10-05: "when i hover over the lynxr once its in place, have
     it be like im tickling it and he laughs or something cute. also have it wave from time to time").
     Only after it has landed, or after the snap; never in flight.
     TICKLE. The x itself takes the pointer now (.hx-perf-live: pointer-events on the mascot only — it
     sits above the card's edge, clear of every control and line of text, measured). Pointer in: a
     ~1.1s giggle — the "giggle" face, a wiggle with a little squash, three tiny hearts popping off. Kept
     there: a softer giggle loop. Out: idle again at once. A burst within 600ms of the last one does
     not restart (no flicker on a jittery edge). A TAP (touch or pen) gives one burst and nothing else:
     the x is aria-hidden, focusable by nothing, and covers no link, so a tap has nothing to follow.
     WAVE. While settled, the intro's hello every 30-45s — only with the tab visible, the pointer
     elsewhere and no field focused, and at most 3 times a page view (Revision 11: rare).
     EYES. On a desktop the eyes lean toward the pointer when it is within ~300px.
     Reduced motion: no wiggle, hearts or waves; only the face changes while hovered. */
  let alive = false;
  const live = () => {
    if (alive || !card.isConnected) return;
    alive = true;
    wrap.classList.add("hx-perf-live");
    const still = () => reduce.matches;
    let hovered = false, lastBurst = -1e9, soft = null, burst = [];
    const restFace = () => { lynxrMood(svg, moodAt()); };
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
      if (e.pointerType !== "mouse") return;               // touch and pen: the tap below
      hovered = true;
      giggle(false);
    });
    wrap.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      hovered = false;
      stopSoft();
      if (!burst.length) restFace();
    });
    wrap.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      e.preventDefault();                                  // a tap on decoration does nothing else
      giggle(true);
    });

    // THE WAVE, RARELY (Revision 11): every 30-45s, at most 3 a page view; only settled, on screen, not
    // hovered, and nobody typing anywhere on the page.
    let waves = 0;
    const settled = () => C.still && C.mode !== "glide" && !wrap.classList.contains("hx-perf-duck") && sitOrCornerVisible();
    const sitOrCornerVisible = () => { const r = wrap.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
    const typing = () => { const a = document.activeElement; return !!(a && a.matches("input, textarea, [contenteditable]")); };
    const next = () => setTimeout(tryWave, 30000 + Math.random() * 15000);
    const tryWave = () => {
      if (waves >= 3 || !card.isConnected) return;
      if (!still() && !document.hidden && settled() && !hovered && !burst.length && !typing()) {
        waves++;
        lynxrGesture(svg, "hello");
        setTimeout(() => lynxrGesture(svg, null), 750);
      }
      next();
    };
    next();
    /* EYES ON THE POINTER (desktop, Revision 11): within ~300px the eyes lean toward it, at most 3 units
       of the 120 box; further away they go back to wherever they were looking. No body movement. */
    if (matchMedia("(hover: hover)").matches) {
      const face = svg.querySelector(".lx-face");
      addEventListener("pointermove", (e) => {
        if (!face || still() || hovered || C.mode === "glide" || !wrap.isConnected) return;
        const r = wrap.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), d = Math.hypot(dx, dy);
        if (d > 300 || d < 1) { if (face.style.transform !== faceBase) face.style.transform = faceBase; return; }
        face.style.transform = `translate(${(dx / d * 3).toFixed(2)}px, ${(dy / d * 3).toFixed(2)}px)`;
      }, { passive: true });
    }
  };

  /* THE COMPANION — CALM (owner, 2026-10-05: "have the one lynxr be dynamic so that as i scroll it goes
     down with you", then "have the movement of the x less distracting... a cute wow hes so cute rather
     than a nuisance to the actual site and the info"; plan Revisions 7, 8 and 11). After the landing
     (or the snap) it is the page's one x, and it moves RARELY, BRIEFLY and SOFTLY:
       - while the reader scrolls (or types) it does not move at all: sitting, the page carries it;
         in the corner, it stays put; a move in progress stops where it is;
       - ~700ms after scrolling stops, if its spot has changed, it makes ONE soft move: a single curved
         glide (0.6-0.9s, ease-in-out) and a tiny twirl on arrival — or, for a short hop or from off
         screen, a fade out and back in at the new spot;
       - its spot is the section's target (data-lx-spot) when that is on screen, else the corner slot
         (bottom right, clear of every control and line of text — or hidden if the edge is busy);
       - settled, it is nearly still: slow breathing and a blink (app.css), a rare wave, eyes on the
         pointer when it is near (desktop).
     A rAF loop runs only during a glide. Not armed under reduced motion (HX.on is false). */
  const C = { mode: "sat", p: null, raf: 0, glide: null, still: true, started: false, quietT: 0 };
  const vv = window.visualViewport;
  const phone = () => innerWidth <= 640;
  const barBottom = () => { const b = document.querySelector(".lp-bar"); const r = b && b.getBoundingClientRect(); return r && r.bottom > 0 ? r.bottom : 0; };
  const slotHome = () => {   // feet position of the default slot
    const h = vv ? vv.offsetTop + vv.height : innerHeight;
    return { x: innerWidth - (phone() ? 12 : 24) - SIZE / 2, y: h - (phone() ? 20 : 72) };
  };
  const freeSlot = () => {   // the clear spot along the right edge nearest the default one, or null
    const s = slotHome(), top0 = barBottom() + 8;
    for (let d = 0; d < innerHeight; d += 8) {
      for (const y of [s.y - d, s.y + d]) {
        if (y - SIZE < top0 || y > s.y + 40) continue;
        if (!blocked(s.x - SIZE / 2, y - SIZE)) return { x: s.x, y };
      }
    }
    return null;
  };
  const feetNow = () => { const r = wrap.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom }; };
  // a place's spot, if the place is fully on screen below the bar: { x, dy, side } or null
  const spotInView = (pl) => {
    if (!pl || !pl.el.isConnected) return null;
    const c = pl.el.getBoundingClientRect();
    if (!c.width || c.top - SIZE < barBottom() + 8 || c.bottom + FOOT > innerHeight - 8) return null;
    return pl.spot();
  };
  const sitVisible = () => {   // is the sitting x still (partly) on screen?
    const r = wrap.getBoundingClientRect();
    return r.bottom > barBottom() && r.top < innerHeight;
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
  /* A LOOK-THROUGH (owner: "for the options of subscriptions have it go through the options", made calm
     in Revision 11): targets marked data-lx-tour="<name>" + data-lx-order are looked at in order. The
     first time the x settles at a target of a tour, it stays where it is and points at each stop in
     turn (~0.7s apiece, each gets one soft ring), then looks back at its own target. Once per page
     view; it stops the moment the x moves again. Stops not on screen are skipped. */
  const toursDone = new Set();
  const tourOf = (el) => (el && el.getAttribute("data-lx-tour")) || null;
  const tourStops = (name) => [...document.querySelectorAll("[data-lx-spot][data-lx-tour]")]
    .filter((el) => tourOf(el) === name && visible(el))
    .sort((a, b) => (+a.getAttribute("data-lx-order") || 0) - (+b.getAttribute("data-lx-order") || 0));
  const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.bottom > barBottom() && r.top < innerHeight; };
  const lookTour = (pl, sp) => {
    const name = tourOf(pl.target);
    if (!name || toursDone.has(name)) return false;
    toursDone.add(name);
    const stops = tourStops(name).filter(onScreen);
    stops.forEach((el, i) => later(300 + i * 700, () => {
      if (C.mode === "sat" && place === pl) { pointToward(el); ring(el); }
    }));
    later(300 + stops.length * 700, () => { if (C.mode === "sat" && place === pl) pointAt(sp); });
    return true;
  };
  // arrival: a tiny twirl — the x turns once about its upright axis (a squeeze to edge-on and back)
  const twirl = () => {
    if (reduce.matches) return;
    pops.push(sq.animate([{ transform: "none" }, { transform: "scale(-1, 1)", offset: 0.5 }, { transform: "none" }],
      { duration: 420, easing: "ease-in-out" }));
  };
  const arrive = (pl, sp) => {
    C.glide = null;
    wrap.classList.remove("hx-perf-moving");
    if (pl) {
      sit(pl, sp);
      C.mode = "sat";
      twirl();
      if (!lookTour(pl, sp)) later(200, () => pointAt(sp));   // points, and the target rings once
    } else {
      C.mode = "corner";
    }
    C.still = true;
  };
  /* ONE SOFT MOVE to a place's spot (pl, sp) or, pl null, to the corner. Fades for a short hop or when
     it starts off screen; otherwise a single curved glide, the curve bowing upward a little. */
  const moveTo = (pl, sp) => {
    const from = C.mode === "sat" ? feetNow() : (C.p || feetNow());
    if (C.mode === "sat") unsit();
    const dest = pl ? (() => { const c = pl.el.getBoundingClientRect(); return { x: sp.x, y: c.top + sp.dy }; })() : freeSlot();
    if (!dest) {   // no clear corner: stay out of sight until the next settle finds one
      wrap.classList.add("hx-perf-duck"); C.mode = "corner"; C.p = from; return;
    }
    const D = Math.hypot(dest.x - from.x, dest.y - from.y);
    const seen = from.y > barBottom() && from.y - SIZE < innerHeight;
    C.still = false;
    wrap.classList.add("hx-perf-moving");
    if (D < 140 || !seen || wrap.classList.contains("hx-perf-duck")) {
      wrap.classList.add("hx-perf-duck");
      later(seen ? 190 : 0, () => {
        C.p = dest; put(dest.x, dest.y);
        wrap.classList.remove("hx-perf-duck");
        arrive(pl, sp);
      });
      return;
    }
    C.mode = "glide";
    C.glide = { from, dest, pl, sp, t0: performance.now(), ms: Math.round(Math.min(900, Math.max(600, 560 + D * 0.35))), h: Math.min(60, D * 0.18) };
    C.raf = requestAnimationFrame(tick);
  };
  const tick = (t) => {
    C.raf = 0;
    const G2 = C.glide;
    if (!G2 || !wrap.isConnected) return;
    const u = Math.min(1, (t - G2.t0) / G2.ms);
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;   // ease-in-out
    // the destination moves with the page only if the reader scrolls, and then the glide has stopped
    const x = G2.from.x + (G2.dest.x - G2.from.x) * e;
    const y = G2.from.y + (G2.dest.y - G2.from.y) * e - G2.h * Math.sin(Math.PI * e);
    C.p = { x, y };
    put(x, y);
    if (u >= 1) { arrive(G2.pl, G2.sp); return; }
    C.raf = requestAnimationFrame(tick);
  };
  // where it should be now, and the one move to get there (if any)
  const decide = () => {
    if (!wrap.isConnected || !card.isConnected || document.hidden || C.mode === "glide") return;
    const want = placeFor(wantedTarget());
    const sp = want ? spotInView(want) : null;
    if (C.mode === "sat" && want === place && sitVisible()) return;          // already there
    if (sp) { moveTo(want, sp); return; }
    if (C.mode === "corner" && !wrap.classList.contains("hx-perf-duck")) return;   // already in the corner
    moveTo(null, null);
  };
  const QUIET = 700;
  const onScroll = () => {
    // never moves while the reader scrolls: a glide in progress stops where it is
    if (C.mode === "glide") {
      cancelAnimationFrame(C.raf); C.raf = 0; C.glide = null;
      C.mode = "corner"; wrap.classList.remove("hx-perf-moving");
    }
    clearTimeout(C.quietT);
    C.quietT = setTimeout(decide, QUIET);
  };
  const follow = () => {
    if (C.started) return;
    C.started = true;
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", () => {
      if (C.mode === "sat" && place) sit(place);   // re-measure the spot for the new layout
      onScroll();
    }, { passive: true });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) onScroll(); });
  };

  /* THE SNAP — any input, the watchdog, or a thrown error. If the hero has gone (signed in: enterApp
     removed #lp-main) the performer goes with it and the nav keeps its x; otherwise it is perched and
     the nav's spot is closed. */
  PERF.end = () => {
    cleanup();
    for (const a of pops) a.cancel();
    if (!card.isConnected) { wrap.remove(); logo.classList.remove("hx-perf-src"); mark.classList.remove("hx-perf-gone"); mark.closest(".lp-bar-in")?.classList.remove("hx-bar-left"); return; }
    closeSpot();
    lookDown();
    sit();
    if (place.target) rung.add(place.target);   // an interrupted intro does not ring later either
    follow();
    live();
  };

  // MOUNT, exactly over the nav logo.
  const L = logo.getBoundingClientRect();
  const start = { x: L.left + L.width / 2, y: L.bottom, s: L.width };
  wrap.style.transform = pose(start.x, start.y, start.s);
  document.body.appendChild(wrap);
  logo.classList.add("hx-perf-src");

  // Every interruption is an hxStop, from anywhere on the page, once.
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

  // THE ROUTE, measured once, now. Feet positions in viewport coordinates.
  const pts = [start];
  for (const s of HX_ROUTE.slice(1)) {
    if (s.land) {
      const r = rect(s.land);
      pts.push({ x: r.left + r.width * (s.x ?? 0.1), y: r.top + FOOT, s: SIZE, bow: s.bow || 0, starts: !!s.starts, lift: 24 });
    } else if (s.perch) {
      // the apex's FEET sit `gap` above the headline's top line
      pts.push({ x: (heroPlace.spot() || { x: over.getBoundingClientRect().right - SIZE / 2 }).x, y: rect(s.perch).top + FOOT, s: SIZE, perch: true, spin: !!s.spin,
        apexY: s.clear ? rect(s.clear).top - (s.gap ?? 70) : null, lean: -0.3 });
    }
  }
  const G = 4800;                                          // px/s^2: snappy, the whole show is ~3.5s
  // b carries the leg: lift (apex above the higher end) or apexY (an absolute apex), bow, spin, lean.
  const legPlan = (a, b, hop) => {
    // the box's top stays 4px inside the viewport (6px more on the spin: a turned box is wider)
    const top = a.s + (b.s - a.s) * 0.35 + (b.spin ? 10 : 4);
    const want = b.apexY != null ? Math.min(b.apexY, Math.min(a.y, b.y) - 24) : Math.min(a.y, b.y) - (b.lift ?? 24);
    const apex = Math.max(top, want);
    const hA = Math.max(0, a.y - apex), hB = Math.max(0, b.y - apex);
    const tUp = Math.sqrt(2 * hA / G), tDown = Math.sqrt(2 * hB / G);
    return { apex, hA, hB, tau: tUp / ((tUp + tDown) || 1), ms: Math.max(hop ? 160 : 480, Math.round((tUp + tDown) * 1000)) };
  };
  const legKeys = (a, b, hop = false) => {
    const L = legPlan(a, b, hop);
    const N = 36, move = [], body = [];
    const vMax = Math.sqrt(2 * G * Math.max(L.hA, L.hB, 1));
    const inside = SIZE / 2 + 6;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const y = t < L.tau ? L.apex + L.hA * ((L.tau - t) / L.tau) ** 2 : L.apex + L.hB * ((t - L.tau) / (1 - L.tau || 1)) ** 2;
      /* x: constant speed, except `lean` shifts the apex toward the start (over the headline's left-centre)
         and `bow` swings the path outward — to the LEFT — and back, never past the viewport's edge */
      const u = t + (b.lean || 0) * t * (1 - t);
      const bow = b.bow ? Math.min(b.bow, Math.max(0, Math.min(a.x, b.x) - inside)) * Math.sin(Math.PI * t) : 0;
      const x = a.x + (b.x - a.x) * u - bow;
      const s = a.s + (b.s - a.s) * Math.min(1, t * 1.4);
      // vertical speed now, as a share of this leg's fastest: drives the stretch
      const vy = Math.sqrt(2 * G * Math.max(0, y - L.apex));   // energy: speed at this depth below the apex
      const k = Math.min(1, vy / vMax) * 0.08 * Math.min(1, b.s / 40);   // a gentle stretch
      const lean = Math.max(-12, Math.min(12, (b.x - a.x) / 40)) * Math.sin(Math.PI * t);
      move.push({ transform: pose(x, Math.max(SIZE + 4, y), s, lean) });
      body.push({ transform: `scale(${(1 - k * 0.8).toFixed(3)}, ${(1 + k).toFixed(3)})` });
    }
    return { move, body, ms: L.ms };
  };

  /* CONTACT CUES: a soft shadow on the surface it is about to land on, growing and darkening as it
     falls, and a tiny puff of three brand dots on each impact. Both are fixed, pointer-events: none,
     transform/opacity only (app.css .hx-perf-shadow / .hx-perf-puff), and gone the moment it lands. */
  const shadowFor = (b, ms) => {
    const el = document.createElement("i");
    el.className = "hx-perf-shadow";
    el.setAttribute("aria-hidden", "true");
    const w = b.s * 0.9;
    el.style.width = w + "px";
    el.style.left = (b.x - w / 2) + "px";
    el.style.top = (b.y - FOOT - 4) + "px";
    document.body.appendChild(el); fx.add(el);
    el.animate([{ opacity: 0, transform: "scale(.35)" }, { opacity: 0.15, transform: "scale(.6)", offset: 0.6 }, { opacity: 0.55, transform: "scale(1)" }],
      { duration: ms, easing: "ease-in", fill: "forwards" });
    return el;
  };
  const dropShadow = (el) => {
    if (!el) return;
    el.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 220, fill: "forwards" }).finished.then(() => { el.remove(); fx.delete(el); }).catch(() => {});
  };
  const puff = (b) => {
    const el = document.createElement("i");
    el.className = "hx-perf-puff";
    el.setAttribute("aria-hidden", "true");
    el.style.left = b.x + "px";
    el.style.top = (b.y - FOOT) + "px";
    for (let k = 0; k < 2; k++) {                     // two dots, softly (Revision 11)
      const d = document.createElement("b");
      el.appendChild(d);
      const dx = k ? 9 : -9, dy = -6;                   // two dots, out to the sides
      d.animate([{ opacity: 0.9, transform: "translate(-50%, -50%) scale(1)" }, { opacity: 0, transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.4)` }],
        { duration: 260, easing: "ease-out", fill: "forwards" });
    }
    document.body.appendChild(el); fx.add(el);
    later(280, () => { el.remove(); fx.delete(el); });
  };
  /* IMPACT: squash flat (~0.8 / 1.2) for ~80ms, then recover past round (a tiny overshoot) and settle;
     the face blinks with it. */
  const impact = (k = 1) => {
    pops.push(sq.animate([
      { transform: "none" },
      { transform: `scale(${1 + 0.2 * k}, ${1 - 0.2 * k})`, offset: 0.35 },
      { transform: `scale(${1 - 0.06 * k}, ${1 + 0.06 * k})`, offset: 0.7 },
      { transform: "none" },
    ], { duration: 230, easing: "ease-out" }));
    const face = svg.querySelector(".lx-face");
    if (face) pops.push(face.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(.1)", offset: 0.4 }, { transform: "scaleY(1)" }],
      { duration: 140, easing: "ease-in-out" }));
  };
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  /* HOP 2 AS ONE CURVE (owner: "i also want the bounce from left to right of the left bubble to be
     smoother"; plan Revision 12). A cubic Bezier from the first landing over the headline to the perch,
     its middle reaching the planned apex, sampled densely and keyed by ARC LENGTH (so the linear keys
     run at constant speed) and played as ONE Web Animation under ONE ease-in-out: one smooth speed
     hump, no joins, nothing read from the page per frame. The body leaves the first landing with that
     landing's squash already in it (springing out of it, no hitch), turns once edge-on and back over the
     arc (the small twirl), and arrives with a soft settle, not a slam. */
  const curveKeys = (a, b, apexY) => {
    const c = (Math.max(SIZE + 6, apexY) - (a.y + b.y) / 8) * 4 / 3;   // control height giving that apex at t=.5
    const P = [a, { x: a.x + (b.x - a.x) * 0.18, y: c }, { x: a.x + (b.x - a.x) * 0.72, y: c }, b];
    const at = (t) => { const m = 1 - t; return { x: m * m * m * P[0].x + 3 * m * m * t * P[1].x + 3 * m * t * t * P[2].x + t * t * t * P[3].x,
      y: m * m * m * P[0].y + 3 * m * m * t * P[1].y + 3 * m * t * t * P[2].y + t * t * t * P[3].y }; };
    const pts2 = []; for (let i = 0; i <= 64; i++) pts2.push(at(i / 64));
    const len = [0]; for (let i = 1; i < pts2.length; i++) len.push(len[i - 1] + Math.hypot(pts2[i].x - pts2[i - 1].x, pts2[i].y - pts2[i - 1].y));
    const L = len[len.length - 1] || 1;
    const move = pts2.map((p, i) => ({ offset: len[i] / L, transform: pose(p.x, p.y, SIZE, 6 * Math.sin(Math.PI * len[i] / L) * Math.sign(b.x - a.x)) }));
    const body = pts2.map((p, i) => {
      const q = len[i] / L, sx = Math.cos(2 * Math.PI * q), sq0 = Math.max(0, 1 - q / 0.12) * 0.1;   // squash springing out
      return { offset: q, transform: `scale(${((1 + sq0) * (Math.abs(sx) < 0.08 ? 0.08 * Math.sign(sx || 1) : sx)).toFixed(3)}, ${(1 - sq0).toFixed(3)})` };
    });
    return { move, body, ms: Math.round(Math.min(720, Math.max(520, 380 + L * 0.45))) };
  };
  const fly = (i) => {
    if (!PERF.end) return;
    const a = pts[i - 1], b = pts[i];
    const curve = b.perch && b.apexY != null;
    const leg = curve ? curveKeys(a, b, b.apexY) : legKeys(a, b);
    const ease = curve ? "cubic-bezier(.45, 0, .4, 1)" : "linear";
    const anim = wrap.animate(leg.move, { duration: leg.ms, easing: ease, fill: "forwards" });
    anims.push(anim, sq.animate(leg.body, { duration: leg.ms, easing: ease }));
    const shade = shadowFor(b, leg.ms);
    anim.finished.then(() => {
      if (!PERF.end) return;
      dropShadow(shade);
      if (b.starts) hxStart();                       // the first landing IS the right card's cue
      if (!b.perch) { puff(b); fly(i + 1); return; }  // hop 2 springs straight out of this landing's squash
      /* LANDED: a soft settle about the feet, and it looks down at its target as the target rings once.
         Then it is perched: nearly still, breathing and blinking. */
      pops.push(sq.animate([{ transform: "none" }, { transform: "scale(1.05, .95)", offset: 0.35 }, { transform: "none" }],
        { duration: 300, easing: "ease-out" }));
      later(120, () => {
        if (!PERF.end) return;
        wrap.classList.remove("hx-perf-moving");
        lookDown();
        ring(place.target);                          // the hero target rings once
        cleanup();
        sit();
        follow();
        later(900, live);                            // after the ring: tickles and waves from here
      });
    }).catch(() => {});
  };

  /* HELLO at the nav (0.7s), then ANTICIPATION: a ~90ms crouch, and it springs — star-eyed. */
  lynxrGesture(svg, "hello");
  later(700, () => {
    lynxrGesture(svg, null);
    const crouch = sq.animate([{ transform: "none" }, { transform: "scale(1.06, .9)" }], { duration: 90, easing: "ease-out", fill: "forwards" });
    pops.push(crouch);
    crouch.finished.then(() => {
      if (!PERF.end) return;
      crouch.cancel();
      lynxrMood(svg, "hyped");
      wrap.classList.add("hx-perf-moving");          // will-change only while it flies
      later(60, closeSpot);                            // it has left the logo's box by now
      fly(1);
    }).catch(() => {});
  });
}

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
