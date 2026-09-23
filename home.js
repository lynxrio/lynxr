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

/* THE STAGE PICKER on / ("for any creator, at any stage"). Four toggle
   buttons, one card. The copy lives in the markup (each button's data-title /
   data-text, and stage 1's already in the card for a visitor without JS), so
   this only moves aria-pressed and copies two strings — nothing to drift.

   THE PAGE DRIVES IT, AT EVERY WIDTH (owner, 2026-09-22: "on desktop keep it
   the way it was the horizonal dynamic from the vertical scroll", then for the
   phone "do it so that as i scroll down, this section just scrolls, similar to
   how the desktop scroll works"). With .hs-live app.css makes the section tall
   and sticks its .lp-in in the middle of the screen, so the page holds on the
   block while each quarter of the run selects the next stage. Above 640px that
   block is a horizontal row of four, below it a column of four; the mechanism
   is identical and this file does not care which is on screen.

   A PHONE-ONLY CONTAINED SCROLLER lived here for part of the same day — the
   column was its own 130px scroll box and a swipe inside it moved the stages.
   It is deleted, not disabled, on the owner's instruction above.

   NOTHING HERE IS TOLD A NUMBER. The run is the section's height less the
   sticky block's, both measured, so app.css can be retuned — different per
   width, as it is — without touching this file. .hs-live is set only when the
   block actually fits the screen and never under prefers-reduced-motion; what
   is left then is the plain click-and-arrow row, which is also the no-JS
   state. A click or an arrow key scrolls to that stage's quarter rather than
   fighting the scroll, so position and selection cannot disagree. Unselected
   avatars are paused in CSS. */
const stageSec = document.querySelector("section.hs");
const stageRow = document.querySelector(".hs-row");
if (stageSec && stageRow && $("hs-title") && $("hs-text")) {
  const stageIn = stageSec.querySelector(".lp-in");
  const stages = [...stageRow.querySelectorAll(".hs-stage")];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let current = 0;
  const paint = (i) => {
    current = i;
    stages.forEach((b, k) => b.setAttribute("aria-pressed", String(k === i)));
    $("hs-title").textContent = stages[i].dataset.title || "";
    $("hs-text").textContent = stages[i].dataset.text || "";
    const lbl = stages[i].querySelector(".hs-lbl");
    if ($("hs-step") && lbl) $("hs-step").textContent = `${i + 1} of ${stages.length} \u00b7 ${lbl.textContent.trim()}`;
    // The card's action follows the stage (owner, 2026-09-22): data-stage picks the aside (and,
    // on the last stage, the links instead of the composer) in CSS; the placeholder comes off
    // the lit button's data-ph so the words stay in the markup.
    const card = $("hs-card");
    if (card) {
      card.dataset.stage = String(i);
      const field = card.querySelector("input[type=url]");
      if (field && stages[i].dataset.ph) field.placeholder = stages[i].dataset.ph;
    }
  };

  const live = () => stageSec.classList.contains("hs-live");
  // Where the run starts in the document, and how long it is. The sticky block
  // begins holding when its own top reaches its CSS `top` offset, and lets go
  // when the section's bottom catches it, so the run is the difference in
  // their heights — measured, never assumed.
  const span = () => {
    const top = stageSec.getBoundingClientRect().top + scrollY;
    const stick = parseFloat(getComputedStyle(stageIn).top) || 0;
    return { start: top - stick, run: Math.max(1, stageSec.offsetHeight - stageIn.offsetHeight) };
  };
  const fromScroll = () => {
    if (!live()) return;
    const { start, run } = span();
    const p = Math.min(Math.max((scrollY - start) / run, 0), 0.9999);
    const i = Math.floor(p * stages.length);
    if (i !== current) paint(i);
  };
  // Measured, not a magic px: the mode only makes sense when the whole block
  // can be on screen at once. A landscape phone falls back to the plain row.
  const setLive = () => {
    stageSec.classList.toggle("hs-live", !reduce.matches && innerHeight >= stageIn.offsetHeight + 32);
    fromScroll();
  };
  // Straight on the scroll event, not via requestAnimationFrame: a frame callback never runs in a
  // tab that isn't painting, which froze the stage on the first one it missed. The work is one
  // rect read and, only when the stage actually changes, four attribute writes.
  addEventListener("scroll", fromScroll, { passive: true });
  reduce.addEventListener("change", setLive);

  const select = (i, focus) => {
    if (i !== current) paint(i);
    if (focus) stages[i].focus({ preventScroll: true });
    if (!live()) {
      // A SAFETY NET, NOT A MODE. The row is a plain grid at both widths today,
      // so both of these are 0 and this does nothing. If it is ever given an
      // overflow again, the chosen stage still gets put in view instead of
      // being selected somewhere off the edge of its own container.
      const y = stageRow.scrollHeight - stageRow.clientHeight;
      const x = stageRow.scrollWidth - stageRow.clientWidth;
      if (x > 0) stageRow.scrollLeft = stages[i].offsetLeft;
      else if (y > 0) stageRow.scrollTop = stages[i].offsetTop;
      return;
    }
    const { start, run } = span();
    scrollTo({ top: start + run * (i + 0.5) / stages.length, behavior: reduce.matches ? "auto" : "smooth" });
  };
  stageRow.addEventListener("click", (e) => {
    const i = stages.indexOf(e.target.closest(".hs-stage"));
    if (i >= 0) select(i, false);
  });
  stageRow.addEventListener("keydown", (e) => {
    const i = stages.indexOf(e.target.closest(".hs-stage"));
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: stages.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(Math.min(Math.max(to, 0), stages.length - 1), true);
  });
  // A resize can cross the breakpoint, change the run, or turn the mode off.
  addEventListener("resize", setLive);
  setLive();
}

/* THE HERO'S INTRO: THE BUDDY PICKS UP A WHISTLE, THEN A PENCIL (owner, 2026-09-22: "have lynxr
   have a pencil and reveal the script writing portion and then have lnxr get a whistle and
   reveal the coach part, its like a load animation" — then, on mockup H, "have the same
   animation we have now, but have it start with the content coach and then the script writing",
   so the two props swapped places and the reveal targets are now the ONE panel's two rows).
   Same budget, one pass, ~1.8s end to end:

     0.00s  a whistle arrives in the top-right hand; face -> coaching
     0.40s  the panel itself fades in, just ahead of its first row (never an empty glass box)
     0.45s  the panel's COACH row follows: pill, headline, preview bubble, 52ms apart
     0.90s  the whistle goes; 1.06s a pencil arrives in the lower-left hand; face -> writing
     1.30s  the hairline and the panel's SCRIPT row follow, same stagger, last lands at 1.796s
     1.80s  prop down, face -> idle, and the ambient "alive" loop below takes over

   The avatar doing all of this is the BIG BUDDY on the left, finished from frame 0 — it has to
   be, it is the thing performing. It is the same .hx-seam host as before, moved and resized.

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

   THE CLASS GOES ON HERE, AT THE TOP LEVEL, not in the DOMContentLoaded handler below: the
   deferred scripts run before the first paint (measured on this page: DOMContentLoaded 55ms,
   first paint 68ms), so nothing is ever painted and then hidden. The avatar's own beats have
   to wait for DOMContentLoaded — avatar.js renders the seam span there — so they are
   scheduled against this same t0 and the two halves of the timeline cannot drift apart. */
const HX = { on: false, over: false, t0: 0, timers: [], hand: null };
const hxAt = (ms, fn) => { HX.timers.push(setTimeout(fn, Math.max(0, ms - (performance.now() - HX.t0)))); };
const hxEnd = () => {
  if (HX.over) return;
  HX.over = true;
  for (const t of HX.timers) clearTimeout(t);
  HX.timers.length = 0;
  const sec = document.querySelector(".hx");
  if (sec) sec.classList.remove("hx-anim");   // default CSS = the finished hero, so this is the snap
  if (HX.hand) HX.hand();                      // the avatar: prop down, idle, then alive
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
  sec.classList.add("hx-anim");
  hxAt(1800, hxEnd);
  for (const ev of ["pointerdown", "focusin", "keydown", "paste"]) {
    sec.addEventListener(ev, hxEnd, { capture: true, passive: true });
  }
})();

/* THE SEAM AVATAR IS ALIVE (owner, 2026-09-22: "have this wave too from time to time and cycle
   through other emotions randomly", then "make it seem alive almost"). The X between the two
   halves of the hero:
   - WAVES now and then (and once on arrival): the top-right arm swings, the same motion as the
     identity mark's wave, played with the Web Animations API so no stylesheet is needed;
   - DRIFTS through its other moods at random — happy, hyped, reading, writing, coaching, a rare
     puzzled look — holding each for a couple of seconds, then back to idle (which blinks on its own);
   - BREATHES: a slow few-pixel bob, forever;
   - LOOKS at you: on a mouse screen the face leans a few units toward the cursor.
   Moods are the avatar's own data-mood states (app.css poses them), so this only writes one
   attribute. "sorry" is left out on purpose: a sad face on the front page reads as an error.
   Reduced motion: none of it runs. Off screen or in a background tab: the mood loop waits.
   avatar.js renders the span after this file runs (script order), so start on DOMContentLoaded. */
addEventListener("DOMContentLoaded", () => {
  const host = document.querySelector(".hx-seam");
  const svg = host && host.querySelector("svg.lx");
  if (!svg || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rand = (a, b) => a + Math.random() * (b - a);
  const MOODS = [["done", 3], ["hyped", 2], ["reading", 2], ["writing", 2], ["coaching", 2], ["confused", 1]];
  let last = "idle";
  let onScreen = true;
  /* SMOOTH SWITCHES (owner: "have the switch between emotions smoother"). A face is shown by
     display, which cannot transition, so the face and its extras fade out, the mood changes while
     they're invisible, and they fade back in. The arms already ease between poses in CSS; on this
     one avatar they get a slower, softer curve (set through CSSOM, which the CSP allows). */
  const soft = "transform .9s cubic-bezier(.33, 1.18, .5, 1)";
  const armEase = (t) => { for (const el of svg.querySelectorAll(".lx-arm, .lx-body")) el.style.transition = t; };
  armEase(soft);
  let switching = null;
  const setMood = (m, out = 180, back = 320) => {
    if (svg.getAttribute("data-mood") === m) return;
    const layers = [svg.querySelector(".lx-face"), svg.querySelector(".lx-extras")].filter(Boolean);
    if (!layers.length || !layers[0].animate) { svg.setAttribute("data-mood", m); return; }
    if (switching) switching.forEach((a) => a.cancel());
    const outs = layers.map((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: out, easing: "ease-in", fill: "forwards" }));
    switching = outs;
    outs[0].finished.then(() => {
      svg.setAttribute("data-mood", m);
      layers.forEach((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: back, easing: "ease-out" }));
      outs.forEach((a) => a.cancel());
      switching = null;
    }).catch(() => {});
  };
  const pickMood = () => {
    const pool = MOODS.filter(([m]) => m !== last);
    let r = Math.random() * pool.reduce((sum, [, w]) => sum + w, 0);
    for (const [m, w] of pool) { if ((r -= w) < 0) return m; }
    return pool[0][0];
  };
  const wave = () => {
    const arm = svg.querySelector(".lx-a1");
    if (!arm || !arm.animate) return;
    arm.animate([
      { transform: "rotate(45deg)" }, { transform: "rotate(8deg)", offset: 0.2 },
      { transform: "rotate(34deg)", offset: 0.45 }, { transform: "rotate(8deg)", offset: 0.7 },
      { transform: "rotate(45deg)" },
    ], { duration: 1500, easing: "ease-in-out" });
  };
  // Breathing: the whole mark rises and settles a few pixels, slowly, forever.
  if (svg.animate) {
    svg.animate([{ transform: "translateY(0)" }, { transform: "translateY(-5px)" }, { transform: "translateY(0)" }],
      { duration: 3400, iterations: Infinity, easing: "ease-in-out" });
  }
  // The mood loop. Each beat is either a wave (in idle) or a mood held for a moment, then idle again.
  const tick = () => {
    if (!svg.isConnected) return;                       // signed in: #lp-main is gone
    if (!onScreen || document.hidden) { setTimeout(tick, 1500); return; }
    if (Math.random() < 0.35) {
      last = "idle"; setMood("idle"); wave();
      setTimeout(tick, rand(3200, 5600));
      return;
    }
    last = pickMood(); setMood(last);
    setTimeout(() => { setMood("idle"); setTimeout(tick, rand(2400, 4400)); }, rand(1800, 3000));
  };
  /* HELLO ON ARRIVAL — or, on the first load of a session, after the intro above, which ends
     on this avatar going idle and would otherwise be greeted over the top of. The intro's
     avatar beats live here because this is where setMood is; its clock is the intro's t0. */
  const alive = () => { armEase(soft); setTimeout(() => { wave(); setTimeout(tick, rand(2600, 4000)); }, 260); };
  /* The intro's own last beat already crossfades the face back to idle; only step in if it
     did not get that far (a click at 600ms ends the intro from wherever it was). Calling
     setMood on top of a crossfade CANCELS it, which measured as the face dipping twice. */
  HX.hand = () => {
    lynxrProp(svg, null);
    if (!switching && svg.getAttribute("data-mood") !== "idle") setMood("idle", 120, 260);
    alive();
  };
  if (HX.on && !HX.over) {
    armEase("transform .34s cubic-bezier(.34, 1.3, .6, 1)");   // a beat, not a 0.9s amble
    /* The face is SET, not crossfaded, for this first one: setMood fades .lx-extras, which is
       the layer the props live in, so a crossfade here would dip the whistle to nothing 200ms
       after it arrived (measured). Nothing has been painted yet either, so there is nothing to
       fade from. Every later beat puts the face change and the prop change in ONE window. */
    lynxrMood(svg, "coaching");
    lynxrProp(svg, "whistle");
    hxAt(900, () => { lynxrProp(svg, "out"); setMood("writing", 150, 200); });
    hxAt(1060, () => lynxrProp(svg, "pencil"));
    hxAt(1640, () => lynxrProp(svg, "out"));
    hxAt(1690, () => setMood("idle", 90, 200));   // resting face by ~1.78s, as the pencil goes
    // 1800 is hxEnd's, armed at the top level so it fires even if this handler never ran.
  } else {
    setTimeout(() => { wave(); setTimeout(tick, rand(2600, 4000)); }, 900);
  }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(host);
  }
  // Eyes on you: on a mouse screen the face leans toward the cursor, at most 3 units of the 120 box.
  const face = svg.querySelector(".lx-face");
  if (face && matchMedia("(hover: hover)").matches) {
    face.style.transition = "transform .35s ease-out";
    addEventListener("pointermove", (e) => {
      if (!onScreen) return;
      const r = svg.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 400) * 3;
      face.style.transform = `translate(${(dx / d * k).toFixed(2)}px, ${(dy / d * k).toFixed(2)}px)`;
    }, { passive: true });
  }
});

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
