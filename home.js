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
// Public by design — the repo is public. Nothing in this file sends it any more: the waitlist moved
// behind the waitlist Edge Function (supabase/functions/waitlist), which needs no key from the page, and
// lynxr_waitlist itself is locked to the server (supabase/waitlist_queue.sql). Left in place, unused,
// so this file's constants stay as they were.
const SB_KEY = "sb_publishable_pTFNX2B94PE_DFLL799w4A_4VcH2xTN";

/* NO GOOGLE SHEET COPY (owner, 2026-11-20: "turn it off"). Waitlist emails used to be mirrored into a Google
   Sheet through a public Apps Script URL. Removed: Supabase (lynxr_waitlist, written only by the waitlist Edge
   Function) is the one place they are stored. supabase/waitlist-sheet.gs is the retired script's source. */

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

   The tag rides along on the join call (wlSubmit below); the waitlist function
   writes it to lynxr_waitlist.consent (supabase/waitlist_queue.sql). */
/* v2 (2026-08-17) widened the promise from "we'll notify you when we launch" to
   launch news PLUS occasional product updates. The tag changed with it, which
   is the whole point of having one: rows carrying launch-notify-v1 agreed to a
   single launch email and NOTHING else, so a product update may not be sent to
   them without asking first. Do not retro-fit v2 onto old rows.
   v3 (2026-11-20) is the referral queue: the same launch news and occasional updates, PLUS the emails the queue
   itself needs: confirm your spot, your spot (on a re-send), and your turn. A leave link is in every one, and
   leaving stops all of it. v2 and v1 rows keep what they agreed to; the release email is the only one a v1 row
   is sent (privacy/index.html says what v3 promises). */
const CONSENT = "waitlist-queue-v3";

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

/* THE INTRO VIDEO (owner, 2026-11-13; plan ~/.claude/plans/landing-intro-video.md). index.html section#lp-intro,
   app.css .lp-intro-card. It plays ONCE, with sound where the browser allows it (SOUND FIRST, MUTED IF REFUSED, below), when
   half of it is on screen, then rests on its last frame; there
   is no loop, so it stops moving. An autoplay pauses when less than half is on screen and picks up again when it
   comes back. Once the visitor has played, paused or scrubbed it, it is theirs: it only pauses when the card is
   fully off screen (or hidden behind the sign-in card: #lp-main is display:none then) and never restarts by
   itself. Under reduced motion, Save-Data, or with no IntersectionObserver it never starts on its own; the poster
   waits with the big play button (preload="none", so nothing downloads until a press).
   Since 2026-11-13 the card is the FIRST screen (plan ~/.claude/plans/landing-video-first.md), so "half on screen" is
   the moment the page loads; a stored session skips autoplay too, and the one primary button (#lp-first-cta)
   shimmers only while the video is not playing. With no element (the
   waitlist page, or a signed-in visit, where enterApp() has removed #lp-main) nothing runs.
   LYNXR'S OWN LIGHT CONTROLS (owner, 2026-11-13: "Yes, light controls"). The browser's bar painted a near-black
   fade over the bottom of this tinted-white card (~40% of it on a phone), and Chromium ignored a click on the
   poster under reduced motion. `controls` stays in the HTML so the video still works if this script never runs;
   it comes off here, and the replacement is built in the same breath, so there is never a moment with neither.
   THE VIDEO DRIVES EVERY PAINTED STATE, NOT THE CLICK (the creator app's wireRefControls rule): play/pause/ended/
   timeupdate/volumechange write the classes and labels, because autoplay below also plays and pauses it.
   A press on any of these controls is the visitor's: it reaches the element as a play/pause/seeking event that
   autoplay did not cause (ours is false), so `theirs` flips exactly as it does for a native control. */
(function introVideo() {
  const v = document.getElementById("lp-intro-video");
  const card = v && v.closest(".lp-intro-card");
  if (!v || !card || !document.body.classList.contains("home")) return;
  v.muted = false;                                  // sound by default; the property (not the HTML attribute) is what plays
  const cta = document.getElementById("lp-first-cta");          // the page's one primary button (index.html)
  let ours = false;     // the next play/pause event is one this code caused
  let theirs = false;   // the visitor has touched it: autoplay keeps its hands off from here on
  let autoMuted = false;    // muted only because the browser refused sound before any press (SOUND FIRST, MUTED IF REFUSED)
  v.addEventListener("play", () => { if (ours) ours = false; else theirs = true; });
  v.addEventListener("pause", () => { if (ours) ours = false; else if (!v.ended) theirs = true; });
  v.addEventListener("seeking", () => { if (!ours) theirs = true; });
  const calm = matchMedia("(prefers-reduced-motion: reduce)");

  /* ---- the controls. Built with DOM calls; the only markup strings are SVG paths (no style attributes: CSP). ---- */
  const svg = (cls, body, filled) => `<svg class="lpv-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" ${filled
    ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;
  const PLAY = svg("i-play", '<path d="M8 5.5v13l10.5-6.5z"/>', true);
  const PAUSE = svg("i-pause", '<path d="M7 5h3.4v14H7zm6.6 0H17v14h-3.4z"/>', true);
  const AGAIN = svg("i-again", '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>', false);
  const button = (cls, html) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = `lpv-btn ${cls}`; b.innerHTML = html;
    return b;
  };
  const big = button("lpv-big", PLAY);                            // the poster's one obvious target (Fitts)
  big.setAttribute("aria-label", "Play the video");
  const bar = document.createElement("div");
  bar.className = "lpv-bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Video controls");
  const toggle = button("lpv-toggle", PLAY + PAUSE + AGAIN);
  const time = document.createElement("span");
  time.className = "lpv-time";
  const scrub = document.createElement("div");
  scrub.className = "lpv-scrub";
  /* The fill and the thumb move by TRANSFORM, not width/left: a moving box is a layout shift in Chromium's CLS
     (it logged one per frame) and a layout per frame; a transform is neither. */
  scrub.innerHTML = '<div class="lpv-rail" aria-hidden="true"><i class="lpv-fill"></i></div><i class="lpv-knob" aria-hidden="true"></i>';
  const fill = scrub.querySelector(".lpv-fill"), knob = scrub.querySelector(".lpv-knob");
  const place = (p) => {                                          // CSSOM, never a style="" attribute (CSP)
    p = Math.max(0, Math.min(1, p || 0));
    fill.style.transform = `scaleX(${p})`;
    knob.style.transform = `translateX(${p * 100}%)`;
  };
  const seek = document.createElement("input");
  seek.className = "lpv-seek"; seek.type = "range"; seek.min = "0"; seek.max = "1"; seek.step = "0.01"; seek.value = "0";
  seek.setAttribute("aria-label", "Seek through the video");
  scrub.append(seek);
  const sound = button("lpv-sound", svg("i-quiet", '<path d="M4 9v6h4l5 4V5L8 9H4zM17 10l4 4m0-4l-4 4"/>', false)
    + svg("i-loud", '<path d="M4 9v6h4l5 4V5L8 9H4zM16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10"/>', false));
  sound.hidden = true;                                            // until the file proves it has an audio track
  const full = button("lpv-full", svg("i-in", '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', false)
    + svg("i-out", '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>', false));
  bar.append(toggle, time, scrub, sound, full);
  card.append(big, bar);
  v.controls = false;
  v.tabIndex = -1;            // focusable by click/script (so Space/K work after a click on the frame), not a tab stop
  card.classList.add("lpv", "is-fresh", "is-shown");

  const dur = () => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0);
  const clock = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  /* THE READOUT NEVER CHANGES WIDTH. This font's digits are not all one width, so "0:01" and "0:00" differ by a
     few px, which resized the slider beside it (another layout shift). Once the duration and the web font are
     known, the readout gets a min-width for its widest possible text: every digit as the font's widest digit.
     Measured with a canvas, so no layout is forced. */
  let timeFit = false;
  const fitTime = () => {
    if (timeFit || !dur() || (document.fonts && document.fonts.status !== "loaded")) return;
    const cs = getComputedStyle(time), ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if ("letterSpacing" in ctx && cs.letterSpacing !== "normal") ctx.letterSpacing = cs.letterSpacing;
    const wide = Math.max(...[..."0123456789"].map((n) => ctx.measureText(n).width));
    const tpl = `${clock(dur())} / ${clock(dur())}`;
    let w = 0;
    for (const ch of tpl) w += /\d/.test(ch) ? wide : ctx.measureText(ch).width;
    time.style.minWidth = `${Math.ceil(w) + 1}px`;
    timeFit = true;
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => sync());
  let dragging = false;
  const sync = () => {                                            // the one writer of position: fill, readout, slider
    const d = dur(), t = Math.min(v.currentTime || 0, d || Infinity);
    card.classList.toggle("is-idle", !d);
    seek.disabled = !d;
    if (d && Number(seek.max) !== d) seek.max = String(d);
    place(d ? t / d : 0);
    fitTime();
    const label = d ? `${clock(t)} / ${clock(d)}` : clock(t);     // no duration yet: say only what is known
    if (time.textContent !== label) time.textContent = label;
    if (dragging || document.activeElement === seek) return;      // a focused slider is not re-announced 4x a second
    if (d) seek.value = String(t);
    const vt = d ? `${clock(t)} of ${clock(d)}` : `${clock(t)}`;
    if (seek.getAttribute("aria-valuetext") !== vt) seek.setAttribute("aria-valuetext", vt);
  };
  const keyFocus = () => !!card.querySelector(":focus-visible");  // keyboard focus holds the bar; a mouse click does not
  const paint = () => {                                           // play/pause/ended state, from the element itself
    const playing = !v.paused && !v.ended;
    const wasFresh = card.classList.contains("is-fresh");
    if (playing || v.currentTime > 0) card.classList.remove("is-fresh");
    card.classList.toggle("is-playing", playing);
    card.classList.toggle("is-ended", v.ended);
    if (cta) cta.classList.toggle("onb-shim", !playing);          // it moves only while the video does not (one thing moves at a time)
    const [lab, tip] = playing ? ["Pause the video", "Pause"] : v.ended ? ["Play the video again", "Play again"] : ["Play the video", "Play"];
    toggle.setAttribute("aria-label", lab); toggle.title = tip;
    if (!playing) show(false);                                    // paused or ended: the bar stays up
    else if (wasFresh && !card.matches(":hover") && !keyFocus()) card.classList.remove("is-shown");   // autoplay: no flash
    else hideSoon();
    tick();
  };
  let raf = 0;                                                    // a smooth fill while it plays and the bar is up
  const tick = () => {
    cancelAnimationFrame(raf);
    if (!v.paused && !v.ended && card.classList.contains("is-shown")) raf = requestAnimationFrame(() => { sync(); tick(); });
  };

  /* SHOW / HIDE. Up while paused, ended, focused inside or dragged; during playback it goes ~2 s after the
     pointer last moved over the card (or at once when the pointer leaves). Autoplay starting does not raise it:
     nothing should appear on the page because of a scroll. The fade is CSS, and off under reduced motion. */
  let hideTimer = 0;
  const show = (thenHide) => {
    clearTimeout(hideTimer);
    card.classList.add("is-shown");
    tick();
    if (thenHide) hideSoon();
  };
  const hideSoon = (ms = 2000) => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (v.paused || v.ended || dragging || keyFocus()) return;
      card.classList.remove("is-shown");
    }, ms);
  };
  const playing = () => !v.paused && !v.ended;
  card.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") show(playing()); });
  card.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && playing()) hideSoon(0); });
  card.addEventListener("focusin", () => show(false));
  card.addEventListener("focusout", () => { if (playing()) hideSoon(); });

  /* SOUND ON, FROM THE START: the one way out of the browser's muted autoplay (SOUND below). Unmuted, back to 0:00 so
     the visitor hears it from the beginning, playing. Must run inside the visitor's press (the browser allows sound
     only then). Setting currentTime is a seek the visitor caused, so `theirs` flips and autoplay keeps its hands off. */
  const soundFromStart = () => {
    setAuto(false);
    v.muted = false;
    v.currentTime = 0;
    if (v.paused || v.ended) v.play().catch(() => {});
    show(playing());
  };
  const flip = () => {                                            // the visitor's play / pause / replay
    if (v.paused || v.ended) {
      if (autoMuted) { soundFromStart(); return; }                // a press to play a muted-by-the-browser video means "with sound"
      v.play().catch(() => {});                                   // refused: the poster and the play button stay
    } else v.pause();
  };
  big.addEventListener("click", () => { flip(); v.focus({ preventScroll: true }); });
  toggle.addEventListener("click", flip);
  /* A CLICK OR TAP ANYWHERE ON THE FRAME TOGGLES PLAY / PAUSE, like YouTube, on a desktop AND a phone (owner,
     2026-11-14: "when i tap it pauses like youtube"). It also brings the bar up so the new state shows (paused: the
     big play button and the bar stay; playing: the bar fades ~2 s later). ONE EXCEPTION: while it plays muted only
     because the browser refused sound, the first tap turns the sound on and starts it again from 0:00 instead of
     pausing (owner, 2026-11-14: "the launch video doesnt start with the audio, fix that so it plays with audio as
     default"), as YouTube and Instagram do with a muted autoplay. Every tap after that pauses / plays. */
  v.addEventListener("click", () => {
    if (autoMuted && playing()) { soundFromStart(); return; }
    flip(); show(playing());
  });
  seek.addEventListener("pointerdown", () => { dragging = true; show(false); });
  const endDrag = () => { if (!dragging) return; dragging = false; sync(); if (playing()) hideSoon(); };
  seek.addEventListener("pointerup", endDrag);
  seek.addEventListener("pointercancel", endDrag);
  seek.addEventListener("input", () => {
    const d = dur(); if (!d) return;
    v.currentTime = Math.min(Number(seek.value), d);
    place(Number(seek.value) / d);
    time.textContent = `${clock(Number(seek.value))} / ${clock(d)}`;
    seek.setAttribute("aria-valuetext", `${clock(Number(seek.value))} of ${clock(d)}`);
  });
  seek.addEventListener("blur", sync);
  /* Arrows move by a step a person can use (step="0.01" is for dragging): a tenth of the video, 1 s to 5 s.
     Home/End stay native. */
  seek.addEventListener("keydown", (e) => {
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    const d = dur();
    if (!dir || !d || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const t = Math.max(0, Math.min(d, v.currentTime + dir * Math.max(1, Math.min(5, d / 10))));
    v.currentTime = t; seek.value = String(t);
    seek.setAttribute("aria-valuetext", `${clock(t)} of ${clock(d)}`);
    show(playing());
  });
  /* KEYBOARD: Space and K toggle anywhere in the card, except that Space on a button presses that button
     (on the play button that is the same toggle; on full screen it must stay full screen). The slider keeps
     its native arrows / Home / End. */
  card.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== "k" && !(k === " " && !(e.target instanceof HTMLButtonElement))) return;
    e.preventDefault();
    flip();
    show(playing());
  });

  /* SOUND. The owner's launch video has its music track (2026-11-14) and index.html says so with data-audio="on",
     so the sound button is there from the first play. Without data-audio a silent file gets no volume button: the
     button appears by itself once the FILE says it has an audio track; it starts with sound on where the
     browser allows it (SOUND FIRST, MUTED IF REFUSED, below). data-audio="on"/"off" on the <video> overrides the sniffing if a browser ever guesses
     wrong. The sniff: Firefox mozHasAudio, Safari audioTracks.length (both known at loadedmetadata), Chromium
     webkitAudioDecodedByteCount > 0 (only known once some audio has decoded, so it is re-asked while playing and
     settled "silent" after a second of playback with nothing decoded). */
  let audio = v.dataset.audio === "on" ? true : v.dataset.audio === "off" ? false : null;
  const sniff = () => {
    if (audio !== null || v.readyState < 1) return;
    if (typeof v.mozHasAudio === "boolean") audio = v.mozHasAudio;
    else if (v.audioTracks && typeof v.audioTracks.length === "number") audio = v.audioTracks.length > 0;
    else if (typeof v.webkitAudioDecodedByteCount === "number") {
      if (v.webkitAudioDecodedByteCount > 0) audio = true;
      else if (v.currentTime > 1) audio = false;
    } else audio = false;
    if (audio !== null) { sound.hidden = !audio; card.classList.toggle("has-audio", audio); }
  };
  if (audio !== null) { sound.hidden = !audio; card.classList.toggle("has-audio", audio); }
  /* SOUND FIRST, MUTED IF REFUSED (owner, 2026-11-14: "autoplay with the audio and everything"). Autoplay asks for
     sound first (v.muted = false at the top). Browsers refuse sound before the visitor has pressed something
     (Chromium allows it for a site the visitor already watches a lot; Safari never), so on a refusal it plays
     MUTED instead (autoplay, below): the video never sits stopped because sound was refused. NOTHING ON THE VIDEO
     SAYS SO (owner, 2026-11-14: the "turn sound on" pill: "get rid of that"; removed). The visitor's first tap on the
     frame (above), or FIRST PRESS ANYWHERE ELSE ON THE PAGE (wake, below), turns the sound on AND starts the video
     again from 0:00, so they hear it from the beginning: the earliest moment any browser allows sound. The bar's
     sound button works as normal throughout, and the visitor's choice sticks. */
  const setAuto = (on) => { autoMuted = on; card.classList.toggle("is-automuted", on); };
  const paintSound = () => {
    card.classList.toggle("is-muted", v.muted);
    sound.setAttribute("aria-label", v.muted ? "Turn the sound on" : "Turn the sound off");
    sound.title = v.muted ? "Sound on" : "Sound off";
    if (!v.muted && autoMuted) setAuto(false);                    // sound is on, however it got there
  };
  sound.addEventListener("click", () => { setAuto(false); v.muted = !v.muted; });   // the visitor's choice sticks
  /* THE FIRST PRESS ANYWHERE TURNS THE SOUND ON (owner, 2026-11-14: "fix that so it plays with audio as default").
     No page can start sound before the visitor has pressed something on it; that is the browser's rule, not ours. So
     while it plays muted for that reason, the visitor's first click, tap or key ANYWHERE on the page turns the sound
     on and starts it again from 0:00. pointerup / touchend because a touch only counts once the finger lifts; a
     scroll swipe never counts, and navigator.userActivation.isActive (where it exists) confirms the browser agrees,
     so a press it would refuse never unmutes (Chromium PAUSES a video unmuted without one). Left alone: presses
     inside the video card (its own handlers, above), presses that do something else (a link or button such as "get
     started" and "sign in", a form field, the sign-up card: no sound arriving under it), and Tab / Escape /
     shortcuts. Paused or ended (it played out muted, or it is off screen): the sound is simply on for the next play. */
  const wake = (e) => {
    if (!autoMuted) return;
    if (navigator.userActivation ? !navigator.userActivation.isActive : e.type === "touchend") return;
    if (e.type === "keydown" && (e.key === "Tab" || e.key === "Escape" || e.ctrlKey || e.metaKey || e.altKey)) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && (card.contains(t) || t.closest("a, button, input, select, textarea, label, summary, [contenteditable], [role='button'], [data-gate], #gate"))) return;
    if (playing()) soundFromStart();
    else { setAuto(false); v.muted = false; }
  };
  for (const ev of ["pointerup", "touchend", "keydown"]) document.addEventListener(ev, wake, { capture: true, passive: true });

  /* FULL SCREEN: THE CARD, not the <video>, so these controls come along. iPhone Safari has no element
     full screen, only webkitEnterFullscreen() on the video, which hands over to the system player and its own
     controls; it needs metadata, which exists by the time the bar (hidden until the first play) is reachable. */
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const elFS = !!(card.requestFullscreen || card.webkitRequestFullscreen) && !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const vidFS = typeof v.webkitEnterFullscreen === "function";
  full.hidden = !(elFS || vidFS);
  full.addEventListener("click", () => {
    if (fsEl() === card) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (elFS) {
      const r = (card.requestFullscreen || card.webkitRequestFullscreen).call(card);
      if (r && r.catch) r.catch(() => {});
    } else if (v.readyState >= 1) v.webkitEnterFullscreen();
  });
  const paintFull = () => {
    const on = fsEl() === card;
    card.classList.toggle("is-full", on);
    full.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
    full.title = on ? "Exit full screen" : "Full screen";
  };
  document.addEventListener("fullscreenchange", paintFull);
  document.addEventListener("webkitfullscreenchange", paintFull);

  /* SLOW: a stall longer than half a second shows a quiet ring where the big button sits. */
  let waitTimer = 0;
  v.addEventListener("waiting", () => { clearTimeout(waitTimer); waitTimer = setTimeout(() => card.classList.add("is-waiting"), 500); });
  const unwait = () => { clearTimeout(waitTimer); card.classList.remove("is-waiting"); };
  for (const ev of ["playing", "pause", "ended", "seeked", "canplay"]) v.addEventListener(ev, unwait);

  for (const ev of ["play", "pause", "ended", "playing"]) v.addEventListener(ev, paint);
  for (const ev of ["timeupdate", "durationchange", "loadedmetadata", "seeked", "emptied"]) v.addEventListener(ev, sync);
  for (const ev of ["loadedmetadata", "loadeddata", "timeupdate", "playing"]) v.addEventListener(ev, sniff);
  v.addEventListener("volumechange", paintSound);
  paintSound(); paintFull(); sync(); paint();

  /* ---- autoplay: unchanged from the first build ---- */
  const thrifty = !!(navigator.connection && navigator.connection.saveData);
  let signedIn = false;                                          // a stored session: creator.js is taking the page into the app
  try { signedIn = !!localStorage.getItem("lynxr_creator_session"); } catch { /* storage blocked: treat as signed out */ }
  /* A waitlisted visitor is about to land on their queue page (wlBoot below: a ?spot= link, or this device keeps their
     spot link and no friend's invite came with the visit), so the video would only play, unseen, under it. */
  let toQueue = false;
  try {
    const q = new URLSearchParams(location.search);
    const kept = JSON.parse(localStorage.getItem("lynxr_wl_spot") || "null");
    toQueue = /^[0-9a-f]{32}$/i.test(q.get("spot") || "")
      || (!q.has("gift") && !!kept && /^[0-9a-f]{32}$/.test(String(kept.token || "")));
  } catch { /* storage blocked: nothing kept, so no queue page to land on */ }
  if (calm.matches || thrifty || signedIn || toQueue || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver((list) => {
    const en = list[list.length - 1];
    if (en.isIntersecting && en.intersectionRatio >= 0.5) {
      if (!theirs && v.paused && !v.ended && !document.hidden) {
        ours = true;
        v.play().catch((err) => {
          ours = false;
          /* Sound refused (NotAllowedError, no press on the page yet): the same play, muted, with the sound waiting
             for the first press. Anything else (an AbortError from a pause, or a refusal that was already muted:
             iOS Low Power Mode, a strict browser) leaves the poster and the play button. */
          if (!err || err.name !== "NotAllowedError" || v.muted || theirs || !v.paused || document.hidden) return;
          v.muted = true;
          setAuto(true);
          ours = true;
          v.play().catch(() => { ours = false; });
        });
      }
    } else if (!v.paused && (!theirs || !en.isIntersecting)) {
      ours = true;
      v.pause();
    }
  }, { threshold: [0, 0.5, 1] });
  io.observe(v);
  calm.addEventListener("change", () => {
    if (!calm.matches) return;
    io.disconnect();
    if (!v.paused && !theirs) { ours = true; v.pause(); }
  });
})();

/* THE CARDS' PICTURES MOVE WITH THE SCROLL, SLOWLY ENOUGH TO SEE (owner, 2026-11-14: "slight animations ... that relates to
   the scroll ... all displays possible"; then "have the effects be slower. right now its too quick to even see"; app.css
   "THE CARDS' PICTURES MOVE WITH THE SCROLL"). This script drives them in EVERY browser: CSS's own scroll-linked
   animations (the @supports path in app.css) can never move slower than the scroll itself, and a quick flick finished
   them in a fraction of a second. #lp-how gets .lp-scrub-js, which makes every moving piece a PAUSED 1 s CSS animation;
   this sets each one's currentTime (Web Animations API, no style attribute: CSP-safe) from its card's progress through
   the screen (0 = the card's top at the bottom of the screen, 1 = its bottom at the top: CSS's `cover` range), mapped
   through the piece's own --lpm-a / --lpm-b window. THE DRAWN PROGRESS FOLLOWS THE SCROLL AT A CAPPED SPEED: at most
   SPEED of the card's progress per second, easing into where the scroll put it over its last stretch (TAU). So a
   slow scroll moves the pictures with it (a quarter-second behind), while a fast one plays each card's sequence over
   about 1.5 s instead of in one frame (the stretches where no piece moves, below .10 and above .48, are skipped, so
   there is no dead wait). Scrolling back up runs it backwards the same way. A rAF loop runs only while a
   card on screen is still catching up, then stops: nothing runs on a still page once the pictures have settled.
   Cards off screen are set at once (0 below, 1 above): nothing animates where nobody sees it. A card already on
   screen when the page loads starts settled. Under reduced motion it stops (app.css gives the pieces no animation
   then) and starts again if reduced motion is switched back off. Without IntersectionObserver or
   element.getAnimations it never starts, and app.css's CSS-only path (where supported) or the static design remains. */
(function cardScrub() {
  const how = document.getElementById("lp-how");
  if (!how || !document.body.classList.contains("home")) return;
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  if (!("IntersectionObserver" in window) || typeof how.getAnimations !== "function") return;
  const SPEED = 0.25;  // card progress per second, at most: a card's pieces (between .10 and .48) take ~1.5 s or more
  const TAU = 0.25;    // seconds: the ease into the target once it is close
  const LO = 0.1, HI = 0.48;   // app.css: no piece moves below .10 or above .48, so the drawn progress skips those stretches
  const cards = [...how.querySelectorAll(".lp-how-card")];
  const span = new WeakMap();                                     // animation -> [a, b], read once from its piece's CSS
  const windowOf = (anim) => {
    let w = span.get(anim);
    if (!w) {
      const fx = anim.effect, cs = getComputedStyle(fx.target, fx.pseudoElement || null);
      w = [parseFloat(cs.getPropertyValue("--lpm-a")) || 0, parseFloat(cs.getPropertyValue("--lpm-b")) || 1];
      span.set(anim, w);
    }
    return w;
  };
  const shown = new Map();                                        // card -> the progress drawn now
  const setCard = (card, p) => {
    shown.set(card, p);
    for (const anim of card.getAnimations({ subtree: true })) {
      const [a, b] = windowOf(anim);
      anim.currentTime = Math.min(1, Math.max(0, (p - a) / (b - a))) * 1000;
    }
  };
  const live = new Set();
  let raf = 0, last = 0;
  const frame = (now) => {
    raf = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    const vh = innerHeight;
    let busy = false;
    for (const c of live) {
      const r = c.getBoundingClientRect();
      const goal = Math.min(1, Math.max(0, (vh - r.top) / (vh + r.height)));
      if (!shown.has(c)) { setCard(c, goal); continue; }          // on screen at load: start settled
      let p = shown.get(c);
      if (goal > p && p < LO) p = Math.min(goal, LO);            // nothing to see down there: no dead wait before it moves
      else if (goal < p && p > HI) p = Math.max(goal, HI);
      const d = goal - p;
      if (Math.abs(d) < 0.0005) { if (p !== shown.get(c) || d) setCard(c, goal); continue; }
      let step = d * (1 - Math.exp(-dt / TAU));
      const cap = SPEED * dt;
      if (Math.abs(step) > cap) step = Math.sign(d) * cap;
      setCard(c, p + step);
      busy = true;
    }
    if (busy) raf = requestAnimationFrame(frame);
    else last = 0;
  };
  const ask = () => { if (!raf) raf = requestAnimationFrame(frame); };
  const io = new IntersectionObserver((list) => {
    for (const en of list) {
      if (en.isIntersecting) live.add(en.target);
      else { live.delete(en.target); setCard(en.target, en.boundingClientRect.top < 0 ? 1 : 0); }
    }
    ask();
  });
  const start = () => {                                           // the class first: it creates the paused animations
    how.classList.add("lp-scrub-js");
    for (const c of cards) io.observe(c);                         // observing reports every card once, so each gets set
    addEventListener("scroll", ask, { passive: true });
    addEventListener("resize", ask, { passive: true });
  };
  const stop = () => {
    io.disconnect(); live.clear(); shown.clear();
    cancelAnimationFrame(raf); raf = 0; last = 0;
    removeEventListener("scroll", ask);
    removeEventListener("resize", ask);
    how.classList.remove("lp-scrub-js");
  };
  calm.addEventListener("change", () => (calm.matches ? stop() : start()));
  if (!calm.matches) start();
})();

/* ===========================================================================================================
   THE WAITLIST — client logic (owner, 2026-11-20; plan ~/.claude/plans/waitlist-referral-queue.md, step 7).

   Public sign-up is a referral queue released in batches. Everything the browser may do goes through ONE door, the
   waitlist Edge Function (supabase/functions/waitlist): join, "your spot", send-it-again, leave. The table behind it
   is locked to the server (supabase/waitlist_queue.sql), so there is no direct write to fall back on. Nothing in a
   browser is ever answered an email address, a private token or an invite code: those travel by email to the person
   they belong to. The one thing the page holds is the person's own spot token, and only after they arrived through
   the link in an email (?spot=).

   This block is LOGIC. It does not paint the cards: the markup is in index.html (#gate-wait, #gate-spot) and the
   painters are assigned to WL_UI below by the interface step (plan step 10). Until they are, a call still runs and
   nothing is drawn. Every lookup of an element is guarded, so a page without the markup does nothing at all.

   THE URL. A link carries ?join=<share code> (a friend's link), ?spot=<private token> (+ &confirm=<token> to confirm
   the address, + &stop=1 to leave), or ?gift=<invite code> (a friend's personal invite link: "you're invited", plan
   ~/.claude/plans/waitlist-beli-referrals.md). They are read ONCE at load, then removed from the address bar with replaceState,
   keeping every other parameter and the fragment (creator.js reads signup, e, c, lynx, paste, obtest after this).
   They are QUERY parameters, never a #fragment: site.js strips fragments 120 ms after load.

   WHAT IS KEPT ON THE DEVICE (localStorage, always in try/catch; the page works with it empty)
     lynxr_wl_spot  {token, at}   the private link to the person's own spot, written only after the server has
                                  recognised it (a spot answer of unconfirmed / waiting / released), dropped on none / left
     lynxr_wl_join  {code, at}    a friend's share code, kept 30 days, so a person who opens the link now and joins
                                  tomorrow still credits the friend
     lynxr_wl_gift  {code, at}    a friend's invite code (?gift=), kept 30 days, so "join the waitlist" later reopens the
                                  invite instead; dropped once it is claimed, used up, dead, or invites are off

   THE FLOW (owner, 2026-11-20: "enter their email and then they get sent to a refer a friend ... but they can also just
   leave that page and go to their queue position display"): join card -> REFER screen (text a friend, copy the link,
   skip) -> THE QUEUE PAGE (their place in line, their home while they wait). A visitor whose device keeps their spot
   link lands straight on the queue page (wlBoot); a friend's ?join= or ?gift= link shows the friend's banner on the
   landing instead (WL_UI.banner), and a ?gift= invite beats a kept spot (it skips the line).

   ?wltest=<scenario> (localhost / 127.0.0.1 ONLY) swaps the network for canned answers so every card can be looked at
   without sending anything: wait, wait-ref, new (the refer screen a join opens), new-next, new-nomail, exists, account,
   limited, error, unconfirmed, waiting, confirmed, released, left, none, stop (the queue page); crew, founding,
   released-discord (its crew line, title and Discord link); invite and gift-invite (the landing with a friend's banner
   for a ?join= / a ?gift= link); gift, gift-used, gift-none, gift-off, gift-open (the invite card as a friend's link
   opens it), gift-claimed, gift-nomail, gift-again, gift-account, gift-busy (the same, then claimed with
   friend@example.invalid). It never touches localStorage. (story is parked with the story image: see the painter.)
   =========================================================================================================== */
const WL_FN = `${SB_URL}/functions/v1/waitlist`;
const WL_SPOT_KEY = "lynxr_wl_spot";
const WL_JOIN_KEY = "lynxr_wl_join";
const WL_JOIN_TTL = 30 * 24 * 3600 * 1000;
const WL_CODE = /^[A-HJ-NP-Z2-9]{8}$/;         // the invite-code alphabet: no I, O, 0 or 1
const WL_TOKEN = /^[0-9a-f]{32}$/;
const WL_TEST_TOKEN = "f".repeat(32);
const WL_GIFT_KEY = "lynxr_wl_gift";
/* The only Discord links the page will ever show (the same rule as the database CHECK and the function's DISCORD_RE). */
const WL_DISCORD = /^https:\/\/(discord\.gg\/[A-Za-z0-9-]{2,32}|discord\.com\/invite\/[A-Za-z0-9-]{2,32})$/;
/* The prewritten share message (C58). Sentence case on purpose: it is the creator's own message in another app, where no
   CSS lowercases it. */
const WL_SHARE_MSG = "Join me on the lynxr waitlist. Paste a video you love and lynxr writes you a script to remake it.";
/* The create card's one line when a gift link routes someone there (C50 / C51 / C52; creator.js paints it). */
const WL_GIFT_ACCOUNT_SAYS = "You don't need an invite. Create your account below, or sign in if you already have one.";
const WL_GIFT_OPEN_SAYS = "lynxr is open right now. Create your account below.";
const WL_GIFT_READY_SAYS = "Your invite is ready. Continue with Google with this email, or choose a password and enter the code from your email.";
/* The create card's line when "create your account" on a released queue page opens it (C103). The spot answer never
   carries the email or the code (both went by email), so it asks for the address they joined with and shows the code box. */
const WL_RELEASED_SAYS = "You're in. Use the email you joined with: continue with Google, or choose a password and enter the code from your email.";

/** The painters. The interface step assigns these; the logic below calls them with the answer and never draws. */
const WL_UI = {
  loading: null,   // (what: "spot" | "join")            a call is in flight
  wait: null,      // (email)                            the wait card was opened (email prefill, or "")
  joined: null,    // (answer, email)                    the answer to a join: {status: new|exists|account|bad_email|limited|off|error, ...}
  spot: null,      // (answer, {token, confirm, stop})   the answer to a spot load: {state: unconfirmed|waiting|released|left|none|limited|off|error, ...}
  gift: null,      // (answer, {code, phase: "peek"|"claim", email})   a gift link: peek {state: ok|used_up|none|off|limited|error},
                   //                                    claim {status: claimed|again|bad_email|used_up|none|off|busy|limited|error, mailed}
  banner: null,    // (kind: "join" | "gift" | "used" | "none" | "off")   the friend's banner on the landing
};

/** The five keys read at load: valid values only (anything else is ignored, never stored, never sent). */
const WL_ARRIVAL = (() => {
  const out = { join: "", spot: "", confirm: "", stop: false, gift: "" };
  try {
    const q = new URLSearchParams(location.search);
    const j = (q.get("join") || "").trim().toUpperCase();
    if (WL_CODE.test(j)) out.join = j;
    const s = (q.get("spot") || "").trim().toLowerCase();
    if (WL_TOKEN.test(s)) out.spot = s;
    const c = (q.get("confirm") || "").trim().toLowerCase();
    if (WL_TOKEN.test(c)) out.confirm = c;
    out.stop = q.get("stop") === "1";
    const g = (q.get("gift") || "").trim().toUpperCase();
    if (WL_CODE.test(g)) out.gift = g;
    let had = false;
    for (const k of ["join", "spot", "confirm", "stop", "gift"]) if (q.has(k)) { q.delete(k); had = true; }
    if (had) {
      const qs = q.toString();
      history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    }
  } catch { /* a malformed URL is not worth failing the page over */ }
  return out;
})();

const WLTEST = (() => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return null;
  let name;
  try { name = new URLSearchParams(location.search).get("wltest"); } catch { return null; }
  if (name === null) return null;
  name = name.trim().toLowerCase() || "wait";
  const NEW = { status: "new", position: 7, ref_code: "ABCDEFGH", mailed: true, batch_size: 100, places: 10 };
  const JOIN = {
    wait: NEW, "wait-ref": NEW, new: NEW,
    "new-next": { ...NEW, position: 42, batch_size: 30 },     // behind the next batch: "invite k friends to reach it"
    "new-nomail": { ...NEW, mailed: false },
    exists: { status: "exists", mailed: true },
    account: { status: "account" }, limited: { status: "limited" }, error: { status: "error" },
  };
  const SPOT_BASE = { ref_code: "ABCDEFGH", referrals: 0, crew: 0, title_crew: 3, just_confirmed: false, batch_size: 100, places: 10 };
  const DISCORD = "https://discord.gg/lynxrtest";              // a fixture value: the real link lives only in the database
  const FOUNDING = { ...SPOT_BASE, state: "waiting", position: 31, crew: 3, referrals: 3, title: "founding", discord: DISCORD };
  const SPOT = {
    unconfirmed: { ...SPOT_BASE, state: "unconfirmed", position: 7 },
    waiting: { ...SPOT_BASE, state: "waiting", position: 142, crew: 2, referrals: 2 },
    confirmed: { ...SPOT_BASE, state: "waiting", position: 7, just_confirmed: true },
    released: { ...SPOT_BASE, state: "released", crew: 2, referrals: 2 },
    left: { ...SPOT_BASE, state: "left" },
    none: { state: "none" },
    stop: { ...SPOT_BASE, state: "waiting", position: 142, referrals: 3 },     // opened with the leave link
    crew: { ...SPOT_BASE, state: "waiting", position: 142, crew: 1, referrals: 1, discord: DISCORD },
    founding: FOUNDING,
    story: FOUNDING,                                                         // the painter also draws the story image
    "released-discord": { ...SPOT_BASE, state: "released", crew: 2, referrals: 2, discord: DISCORD },
  };
  /* A friend's invite link: what gift_peek answers, and (for the claim scenarios) what the claim with
     friend@example.invalid answers. A second claim (send it again) answers "again". */
  const PEEK = { gift: "ok", "gift-used": "used_up", "gift-none": "none", "gift-off": "off", "gift-open": "open",
    "gift-claimed": "ok", "gift-nomail": "ok", "gift-again": "ok", "gift-account": "ok", "gift-busy": "ok", "gift-invite": "ok" };
  const BANNER = { invite: "join", "gift-invite": "gift" };          // the landing with a friend's banner, nothing opened
  const CLAIM = {
    gift: { status: "claimed", mailed: true },
    "gift-claimed": { status: "claimed", mailed: true }, "gift-nomail": { status: "claimed", mailed: false },
    "gift-again": { status: "again", mailed: true }, "gift-account": { status: "account" }, "gift-busy": { status: "busy" },
  };
  if (!(name in JOIN) && !(name in SPOT) && !(name in PEEK) && !(name in BANNER)) return null;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  let claims = 0;
  return {
    name,
    kind: name in BANNER ? "banner" : name in SPOT ? "spot" : name in PEEK ? "gift" : "wait",
    banner: BANNER[name] || "",
    claimNow: name in CLAIM && name !== "gift",                   // the claim scenarios claim at once; "gift" waits for a person
    async call(body) {
      await pause(250);                                      // a visible network moment
      if (body.action === "join") return { ...(JOIN[name] || NEW) };
      if (body.action === "spot") return { ...(SPOT[name] || SPOT.waiting) };
      if (body.action === "resend") return { ok: true, mailed: true };
      if (body.action === "stop") return { ok: true };
      if (body.action === "gift_peek") return { state: PEEK[name] || "ok" };
      if (body.action === "gift") {
        claims += 1;
        if (claims > 1 && ["claimed", "again"].includes((CLAIM[name] || {}).status)) return { status: "again", mailed: true };
        return { ...(CLAIM[name] || CLAIM.gift) };
      }
      return { status: "error" };
    },
  };
})();

const wlStore = (key, val) => { if (WLTEST) return; try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private window */ } };
const wlDrop = (key) => { if (WLTEST) return; try { localStorage.removeItem(key); } catch { /* private window */ } };
const wlRead = (key) => {
  if (WLTEST) return null;
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v && typeof v === "object" ? v : null; } catch { return null; }
};

/** The stored private link to the person's own spot, or "". */
function wlStoredSpot() {
  const v = wlRead(WL_SPOT_KEY);
  return v && WL_TOKEN.test(String(v.token || "")) ? v.token : "";
}

/** A friend's share code. A fresh ?join= replaces an older one; one older than 30 days is dropped. Returns "" for none. */
function wlRef() {
  if (WLTEST) return WLTEST.name === "wait-ref" || WLTEST.name === "invite" ? "ABCDEFGH" : "";
  if (WL_ARRIVAL.join) { wlStore(WL_JOIN_KEY, { code: WL_ARRIVAL.join, at: Date.now() }); return WL_ARRIVAL.join; }
  const v = wlRead(WL_JOIN_KEY);
  if (v && WL_CODE.test(String(v.code || "")) && Date.now() - Number(v.at) < WL_JOIN_TTL) return v.code;
  if (v) wlDrop(WL_JOIN_KEY);
  return "";
}
if (WL_ARRIVAL.join) wlRef();    // keep the share code the moment the link is opened, even if they never touch the card

/** A friend's invite code (?gift=), the same way: a fresh arrival replaces a stored one; older than 30 days is dropped. */
function wlGift() {
  if (WLTEST) return WLTEST.kind === "gift" || WLTEST.banner === "gift" ? "ABCDEFGH" : "";
  if (WL_ARRIVAL.gift) { wlStore(WL_GIFT_KEY, { code: WL_ARRIVAL.gift, at: Date.now() }); return WL_ARRIVAL.gift; }
  const v = wlRead(WL_GIFT_KEY);
  if (v && WL_CODE.test(String(v.code || "")) && Date.now() - Number(v.at) < WL_JOIN_TTL) return v.code;
  if (v) wlGiftForget();
  return "";
}
if (WL_ARRIVAL.gift) wlGift();

/** Forget a friend's invite: the kept code AND this visit's ?gift= (wlGift() would otherwise hand the arrival back and
    store it again, so a dead invite reopened its dead card instead of the join card). */
function wlGiftForget() { WL_ARRIVAL.gift = ""; wlDrop(WL_GIFT_KEY); }

/** "Use a different email": forget the private link, the friend's code and the friend's invite on this device. */
function wlForget() { wlDrop(WL_SPOT_KEY); wlDrop(WL_JOIN_KEY); wlGiftForget(); }

/** One call to the function. A CORS "simple request": a string body and NO headers, so the browser sends text/plain
    and never a preflight (the function reads req.text()). Always resolves: an object, or {status:"error"}. */
async function wlCall(body) {
  if (WLTEST) return WLTEST.call(body);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(WL_FN, { method: "POST", body: JSON.stringify(body), signal: ctl.signal });
    const js = await res.json();
    return js && typeof js === "object" ? js : { status: "error" };
  } catch {
    return { status: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** JOIN. `raw` is what was typed. Resolves the answer after handing it to the painter. A malformed address is refused
    here without a request (status "bad_email"). A "new" row is mirrored to the sheet, as every new row always was;
    "account" (invited, on the roster, or already signed up) gets a line saying the email already has access and to sign
    in; no password box opens from the waitlist (owner, 2026-11-20). */
async function wlSubmit(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!looksLikeEmail(email)) {
    const bad = { status: "bad_email" };
    if (WL_UI.joined) WL_UI.joined(bad, email);
    return bad;
  }
  if (WL_UI.loading) WL_UI.loading("join");
  const res = await wlCall({ action: "join", email, ref: wlRef(), source: SOURCE, consent: CONSENT });
  const out = res && typeof res.status === "string" ? res : { status: "error" };
  if (out.status === "account" && typeof gateAccessFromWaitlist === "function") gateAccessFromWaitlist(email);   // no create card: see creator.js
  if (WL_UI.joined) WL_UI.joined(out, email);
  return out;
}

/** SPOT: the answer to a private link. {state: ...}; anything unrecognised becomes {state:"error"}. A state the server
    recognises as the person's own (unconfirmed / waiting / released) keeps the token on this device; none / left drop it. */
async function wlSpot(token, ctx) {
  const c = ctx || {};
  const body = { action: "spot", token };
  if (c.confirm && WL_TOKEN.test(c.confirm)) body.confirm = c.confirm;
  const res = await wlCall(body);
  const out = res && typeof res.state === "string" ? res : { state: "error" };
  if (out.state === "unconfirmed" || out.state === "waiting" || out.state === "released") wlStore(WL_SPOT_KEY, { token, at: Date.now() });
  else if (out.state === "none" || out.state === "left") wlDrop(WL_SPOT_KEY);
  return out;
}

/** Open the spot card for `token` ({confirm, stop} from the link), load it, hand the answer to the painter. */
async function wlOpenSpot(token, ctx) {
  const c = ctx || {};
  if (typeof showGate === "function") showGate("spot");
  if (WL_UI.loading) WL_UI.loading("spot");
  const out = await wlSpot(token, c);
  if (WL_UI.spot) WL_UI.spot(out, { token, confirm: !!c.confirm, stop: !!c.stop });
  return out;
}

/** "Send it again" from a spot card. {ok, mailed, wait_s?}. */
async function wlResend(token) {
  const res = await wlCall({ action: "resend", token });
  return { ok: res.ok === true, mailed: res.mailed === true, wait_s: Number(res.wait_s) || 0 };
}

/** GIFT, step one: open the "you're invited" card for a friend's invite code and ask whether it still works. The answer
    never names the giver. Dead, used-up or paused invites forget the stored code; while sign-up is open the invite means
    nothing, so the create card opens instead. */
let wlPeeked = null;          // {code, out}: the banner's peek, so "claim your invite" opens the card without asking twice
async function wlGiftOpen(code) {
  if (typeof showGate === "function") showGate("gift");
  if (wlPeeked && wlPeeked.code === code && wlPeeked.out.state === "ok") {
    WL_UI.gift?.(wlPeeked.out, { code, phase: "peek" });
    return wlPeeked.out;
  }
  WL_UI.loading?.("gift");
  const res = await wlCall({ action: "gift_peek", code });
  const out = res && typeof res.state === "string" ? res : { state: "error" };
  if (out.state === "none" || out.state === "used_up" || out.state === "off") wlGiftForget();
  if (out.state === "open") {
    wlGiftForget();
    if (typeof gateUpFromWaitlist === "function") gateUpFromWaitlist("", WL_GIFT_OPEN_SAYS);
    return out;
  }
  WL_UI.gift?.(out, { code, phase: "peek" });
  return out;
}

/** THE GIFT BANNER: a friend's ?gift= link (or one kept on this device) lands on the landing with the friend's banner and
    "claim your invite" as its one button (owner, 2026-11-20: the banner the other person sees; the gift card stays one
    press away). Asked once, here: a dead, used-up or paused invite says so on the banner and the button goes back to
    "join the waitlist"; while sign-up is open the create card opens, as before. Trouble keeps the invite banner (the
    card retries). */
async function wlGiftBanner(code) {
  WL_UI.banner?.("gift");
  const res = await wlCall({ action: "gift_peek", code });
  const out = res && typeof res.state === "string" ? res : { state: "error" };
  wlPeeked = { code, out };
  if (out.state === "none" || out.state === "used_up" || out.state === "off") {
    wlGiftForget();
    WL_UI.banner?.(out.state === "used_up" ? "used" : out.state);
  } else if (out.state === "open") {
    wlGiftForget();
    if (typeof showGate === "function") showGate("up");
    if (typeof gateUpFromWaitlist === "function") gateUpFromWaitlist("", WL_GIFT_OPEN_SAYS);
  }
  return out;
}

/** GIFT, step two: claim it with an email. The invite (and its code) goes to that inbox by email; the answer carries
    neither. No source and no consent: a gift claim joins no mailing list. */
async function wlGiftClaim(code, raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!looksLikeEmail(email)) {
    const bad = { status: "bad_email" };
    WL_UI.gift?.(bad, { code, phase: "claim", email });
    return bad;
  }
  WL_UI.loading?.("giftclaim");
  const res = await wlCall({ action: "gift", code, email });
  const out = res && typeof res.status === "string" ? res : { status: "error" };
  if (["claimed", "again", "account", "used_up", "none", "open"].includes(out.status)) wlGiftForget();
  if (out.status === "account" && typeof gateUpFromWaitlist === "function") gateUpFromWaitlist(email, WL_GIFT_ACCOUNT_SAYS);
  if (out.status === "open" && typeof gateUpFromWaitlist === "function") gateUpFromWaitlist(email, WL_GIFT_OPEN_SAYS);
  WL_UI.gift?.(out, { code, phase: "claim", email });
  return out;
}

/** "Leave the waitlist". Resolves {ok}; on success the stored private link is dropped. */
async function wlLeave(token) {
  const res = await wlCall({ action: "stop", token });
  if (res.ok === true) { wlDrop(WL_SPOT_KEY); return { ok: true }; }
  return { ok: false };
}

/** THE BRIDGE creator.js calls (window.lynxrWaitlist.open). With no email: a friend's invite kept on this device opens
    that invite first (it skips the line, so it beats a place in line), else a stored private link opens the queue page;
    otherwise the wait card, with `email` put in the field (so a person who typed it on the sign-in card does not retype
    it). A dead invite was dropped when its banner asked, so it never comes back here. */
function wlOpen(email) {
  const addr = typeof email === "string" ? email.trim() : "";
  const gift = addr || (WLTEST && WLTEST.banner !== "gift") ? "" : wlGift();
  if (gift) { wlGiftOpen(gift); return; }
  const stored = addr ? "" : wlStoredSpot();
  if (stored) { wlOpenSpot(stored, {}); return; }
  if (typeof showGate === "function") showGate("wait");
  const field = $("wl-email");
  if (field && addr) {
    field.value = addr;
    field.dispatchEvent(new Event("input", { bubbles: true }));   // the painter enables the button from this
  }
  if (WL_UI.wait) WL_UI.wait(addr);
}
window.lynxrWaitlist = { open: wlOpen };

/* ===========================================================================================================
   THE WAITLIST SCREENS — the painters (plan ~/.claude/plans/waitlist-referral-queue.md, step 10; the crew line, title,
   Discord link and the invite card from ~/.claude/plans/waitlist-beli-referrals.md, steps B9-B11; the refer screen, the
   queue page and the friend's banner from the owner's simplification, 2026-11-20: "the most simple and easy to follow
   thing ever ... no need for fluff"). The logic above calls WL_UI; these draw. index.html holds the fixed markup
   (#gate-wait, #gate-refer, #gate-spot, #gate-gift, and #lp-invite on the landing); creator.js setGateMode decides which
   block shows. Every server value goes in with textContent; the only nodes made here are plain elements built with DOM
   calls (no markup strings, no style attributes: CSP).
   THE SCREENS
     join card   one field, one button, the legal line.
     refer       right after a join: "+10" huge, its label small, TEXT A FRIEND (an sms: link that opens the phone's
                 Messages with the prewritten message and their link; a computer gets "copy your link" first and the
                 system share sheet where there is one), copy link, and "skip, see my place in line".
     queue page  their home while they wait (a page, no card, no app chrome): "coming soon", the place in line huge, one
                 short line, one button, at most two quiet links.
     banner      a friend's ?join= / ?gift= link: the landing's one button wrapped in a card that says a friend sent them.
   ONE THING MOVES PER SCREEN: #wl-go (join card, only once an email is typed: disabled stops .onb-shim); #wlr-text on a
   phone's refer screen, #wlr-copy on a computer's; the queue page's one button; #wlg-go on the invite card (once an
   email is typed) or its one "join the waitlist" dead end; the banner's #lp-first-cta. "Leave the waitlist?" moves
   nothing on purpose: a destructive choice is never pushed. app.css switches the shimmer off under reduced motion. No
   confetti: joining is not the first win.
   STATES: join (empty, typing, bad address, joining, limited, paused, offline, trouble, already in line, account ->
   create card); refer (phone / computer, copied, copy refused -> the link shown to press and hold, from a join / from
   the queue page); queue page (loading, unconfirmed from a join / from a link, mail not sent, waiting, just confirmed,
   founding creator, crew, released -> create your account, leave?, left, dead link, limited / paused / trouble with
   "try again"). The C-numbers are the plan's copy list (~/.claude/plans/waitlist-copy-review.md).
   =========================================================================================================== */
(function wlPaint() {
  const wait = $("gate-wait"), spotCard = $("gate-spot");
  if (!wait || !spotCard) return;
  const field = $("wl-email"), go = $("wl-go"), form = $("wl-form");
  const num = $("wl-num"), lbl = $("wl-num-lbl"), line = $("wl-line"), batchLine = $("wl-batch");
  const friends = $("wl-friends"), acts = $("wl-acts");
  if (!field || !go || !form || !num || !lbl || !line || !acts) return;
  // optional (the HTML is not cache-stamped, so an old page simply lacks them)
  const titleEl = $("wl-title"), discordRow = $("wl-discord-row"), discordA = $("wl-discord");
  const storyGo = $("wl-story-go"), storyPrev = $("wl-story-prev");        // parked with the story image: absent from the page
  const rBig = $("wlr-big"), rLink = $("wlr-link"), rText = $("wlr-text"), rCopy = $("wlr-copy"), rShare = $("wlr-share"), rSkip = $("wlr-skip");
  const referOk = !!($("gate-refer") && rBig && rLink && rText && rCopy && rSkip);
  line.tabIndex = -1;                                             // focus lands on it when a page has no number

  const SAYS = {
    bad: "Check your email address — it should look like name@example.com.",                          // C12
    access: "This email already has access to lynxr. Sign in below.",                                  // C120
    limited: "Too many tries from this connection. Wait a few minutes and try again.",
    off: "The waitlist is paused for a moment. Try again later.",
    offline: "That didn't send. Check your connection and try again.",
    trouble: "The waitlist is having trouble right now. Try again in a minute.",
    joining: "Joining…",
    loading: "Loading your place in line…",
    label: "your place in line",                                                                       // C14
    sentTo: (email) => `Confirm your email to hold it. We sent a link to ${email}.`,                     // C15
    inInbox: "Confirm your email to hold it. The link is in your inbox.",
    confirmed: "Confirmed. You're in line.",                                                            // C16
    nextBatch: (n) => `You're in the next batch of ${n}.`,                                              // C17
    invite: (k) => `Invite ${k} ${k === 1 ? "friend" : "friends"} to reach the next batch.`,
    moveUp: "Invite friends to move up",                                                               // C104
    soon: "coming soon", yourTurn: "it's your turn",                                                   // C105
    onList: "you're on the list", moveUpTag: "move up the line",                                       // C106
    text: "Text a friend", copyLink: "Copy link", copyYours: "Copy your link", shareSheet: "Share",     // C107
    copied: "Copied", hold: "Press and hold the link to copy it.",
    skip: "Skip, see my place in line", back: "Back to my place in line",                             // C108
    crew: "Your crew: ",                                                                               // C42
    crewMore: (k) => ` · ${k} more to become a founding creator`,
    exists: "You're already in line. We've emailed you a link to your spot.",                           // C19
    existsQuiet: "You're already in line. The link to your spot is in your inbox.",
    noMail: "We couldn't send your email just now. Press send it again in a few minutes.",              // C20
    inWord: "You're in",                                                                               // C21
    released: "Your batch is open. Create your account with the email you joined with.",              // C109
    create: "Create your account", needCode: "Need the code? ",
    made: "Already made your account?", signIn: "Sign in",
    left: "You've left the waitlist.", joinAgain: "Join again",                                        // C22
    leaveQ: "Leave the waitlist? You'll lose your place in line.",                                      // C23
    leave: "Leave the waitlist", keep: "Keep my spot",
    dead: "This link doesn't work anymore.", join: "Join the waitlist",                                // C24
    again: "Send it again", againIn: (s) => `Send it again in ${s}s`, other: "Use a different email",
    sentAgain: "Sent again. Check your inbox and spam folder.",
    soonS: (s) => `We sent one moments ago. You can ask for another in ${s} seconds.`,
    retry: "Try again",
    // story image (parked, C44)
    storyShare: "Share to your story", storySave: "Save story image",
    storySaved: "Saved. Post it to your story from your phone.", storyFail: "Couldn't make the image. Try again.",
  };
  const errEl = () => $("err");
  const say = (text) => { const e = errEl(); if (e) e.textContent = text; };
  const busy = (text) => {                                        // the gate's own "working" mark (creator.js gateBusy)
    const e = errEl(); if (!e) return;
    if (typeof gateBusy === "function") gateBusy(e, text); else e.textContent = text;
  };
  const flag = (on) => {                                          // creator.js markInvalid / clearInvalid, when present
    if (on) { if (typeof markInvalid === "function") markInvalid(field, "err"); }
    else if (typeof clearInvalid === "function") clearInvalid(field);
  };
  const mode = (m) => { if (typeof setGateMode === "function") setGateMode(m); };
  const failSays = (status) => (status === "limited" ? SAYS.limited : status === "off" ? SAYS.off
    : navigator.onLine === false ? SAYS.offline : SAYS.trouble);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const linkBtn = (text, onClick) => { const b = el("button", "linkish", text); b.type = "button"; b.addEventListener("click", onClick); return b; };
  const row = (...kids) => { const p = el("p", "gate-other"); p.append(...kids); return p; };
  const primary = (text, onClick) => {                            // a screen's one moving button
    const b = el("button", "btn onb-shim wl-act-go", text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  };
  /* The small line over the big number on the two pages ("coming soon", "you're on the list"). Built once, first in
     each page's .wl-main, so the markup needs nothing new for it. */
  const eyebrow = (block, text) => {
    const main = block?.querySelector(".wl-main");
    if (!main) return;
    let e = main.querySelector(".wl-eyebrow");
    if (!e) { e = el("p", "wl-eyebrow"); main.prepend(e); }
    e.textContent = text;
  };

  /* ---------------- the join card ---------------- */
  let joining = false;
  const ready = () => { go.disabled = joining || !looksLikeEmail(field.value.trim()); };
  const paintWait = () => {
    joining = false;
    go.removeAttribute("aria-busy");
    flag(false);
    ready();
  };
  field.addEventListener("input", () => {
    ready();
    if (field.getAttribute("aria-invalid") === "true" && looksLikeEmail(field.value.trim())) {
      flag(false);
      const e = errEl();
      if (e && e.textContent === SAYS.bad) e.textContent = "";
    }
  });
  /* Enter with the button still disabled does nothing in a browser (no implicit submit), so say why here. */
  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !go.disabled || joining) return;
    e.preventDefault();
    say(SAYS.bad);
    flag(true);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (joining) return;
    wlSubmit(field.value);
  });

  /* ---------------- "send it again", with a cooldown on the button ---------------- */
  const cooled = (btn, seconds) => {
    clearInterval(btn._wlT);
    let left = Math.max(0, Math.ceil(Number(seconds) || 0));
    const paint = () => { btn.disabled = left > 0; btn.textContent = left > 0 ? SAYS.againIn(left) : SAYS.again; };
    paint();
    if (left > 0) btn._wlT = setInterval(() => { left -= 1; paint(); if (left <= 0) clearInterval(btn._wlT); }, 1000);
  };

  /* ---------------- the queue page ---------------- */
  let shown = null;                                               // {a, c}: the queue page on screen, for the refer screen's way back
  const clearSpot = () => {
    num.replaceChildren(); num.hidden = true; num.classList.remove("is-word", "is-long", "is-longer");
    lbl.textContent = ""; lbl.hidden = true;
    line.textContent = ""; line.hidden = true;
    if (batchLine) { batchLine.textContent = ""; batchLine.hidden = true; }
    if (friends) { friends.replaceChildren(); friends.hidden = true; }
    if (titleEl) titleEl.hidden = true;
    if (discordRow) discordRow.hidden = true;
    if (discordA) discordA.removeAttribute("href");
    storyFor = null;
    for (const b of acts.querySelectorAll("button")) clearInterval(b._wlT);
    acts.replaceChildren();
  };
  const setNum = (pos) => {
    const sr = el("span", "sr-only", "Your place in line: ");
    const text = "#" + Number(pos).toLocaleString("en-US");
    num.replaceChildren(sr, document.createTextNode(text));
    num.classList.toggle("is-long", text.length >= 5 && text.length < 7);    // "#1,234": a size down (app.css)
    num.classList.toggle("is-longer", text.length >= 7);                    // "#12,345" and up: two sizes down
    num.hidden = false;
    lbl.textContent = SAYS.label;
    lbl.setAttribute("aria-hidden", "true");                      // the number already carries it for a screen reader
    lbl.hidden = false;
  };
  const setLine = (text) => { line.textContent = text; line.hidden = !text; };
  const setBatch = (a) => {
    if (!batchLine) return;
    const pos = Number(a.position), size = Number(a.batch_size), places = Number(a.places);
    let text = "";
    if (pos > 0 && size > 0) {
      if (pos <= size) text = SAYS.nextBatch(size);
      else if (places > 0) {
        const k = Math.ceil((pos - size) / places);
        if (k <= 20) text = SAYS.invite(k);                       // far back, "invite 12,336 friends" helps nobody: the button says it
      }
    }
    batchLine.textContent = text;
    batchLine.hidden = !text;
  };
  /* "Your crew: N · K more to become a founding creator" (C42): ONE short line, and only once someone has joined with
     their link (no "bring 3 friends" pitch at zero: the button already says it). Confirmed spots only. */
  const setCrew = (a) => {
    if (!friends) return;
    const n = Math.max(0, Number(a.crew ?? a.referrals) || 0), t = Math.max(0, Number(a.title_crew) || 0);
    if (n === 0) { friends.replaceChildren(); friends.hidden = true; return; }
    const tail = a.title === "founding" || t <= 0 || n >= t ? "" : SAYS.crewMore(t - n);
    friends.replaceChildren(document.createTextNode(SAYS.crew), el("strong", "wl-crew-n", n.toLocaleString("en-US")),
      ...(tail ? [document.createTextNode(tail)] : []));
    friends.hidden = false;
  };
  const setTitle = (a) => { if (titleEl) titleEl.hidden = a.title !== "founding"; };
  /* The Discord link: only a link the page itself recognises as a Discord invite (WL_DISCORD), never from the markup. */
  const setDiscord = (a) => {
    if (!discordRow || !discordA) return;
    const ok = typeof a.discord === "string" && WL_DISCORD.test(a.discord);
    if (ok) discordA.href = a.discord; else discordA.removeAttribute("href");
    discordRow.hidden = !ok;
  };
  const codeOf = (a) => { const code = String(a.ref_code || "").toUpperCase(); return WL_CODE.test(code) ? code : ""; };
  const focusOn = (t) => { try { t.focus({ preventScroll: true }); } catch { /* fine */ } };
  const focusCard = () => focusOn(!num.hidden ? num : line);

  /* "Use a different email": forget this device's link and friend's code, back to the join card, the address selected. */
  const otherEmail = () => {
    wlForget();
    mode("wait");
    paintWait();
    field.focus();
    field.select();
  };
  /* In-page moves: no second history entry (showGate pushes one each time it opens the card, and it is open). */
  const toWait = () => { mode("wait"); paintWait(); field.focus(); };
  const reload = async (token, ctx) => {
    WL_UI.loading("spot");
    const out = await wlSpot(token, ctx);
    paintSpot(out, { token, confirm: !!ctx.confirm, stop: !!ctx.stop });
  };
  /* "Send it again" for an unconfirmed spot. After a fresh join it asks the join again (the page holds no token yet);
     from a link it asks for a resend. The first email's 60 s cooldown counts from when it went, not from this paint. */
  const againBtn = (c, joinedSpot) => {
    const again = linkBtn(SAYS.again, async () => {
      again.disabled = true;
      busy("Sending…");
      if (joinedSpot) {
        const r = await wlCall({ action: "join", email: c.email, ref: wlRef(), source: SOURCE, consent: CONSENT });
        const sent = (r.status === "new" || r.status === "exists") && r.mailed === true;
        say(sent ? SAYS.sentAgain : r.status === "new" || r.status === "exists" ? SAYS.noMail : failSays(r.status));
        if (sent) c.sentAt = Date.now();
        cooled(again, sent ? 60 : 0);
      } else {
        const r = await wlResend(c.token);
        say(r.ok && r.mailed ? SAYS.sentAgain : r.wait_s ? SAYS.soonS(r.wait_s) : SAYS.noMail);
        cooled(again, r.ok && r.mailed ? 60 : r.wait_s);
      }
    });
    if (joinedSpot && c.mailed && c.sentAt) cooled(again, 60 - (Date.now() - c.sentAt) / 1000);
    return again;
  };

  /** Paint an answer on the queue page. `a` is a spot answer ({state, position, ref_code, referrals, crew, title,
      just_confirmed, batch_size, places, discord}); `c` says where it came from: {token, confirm, stop} for a link,
      {join: true, email, mailed, sentAt} for a fresh join. */
  const paintSpot = (a, c) => {
    mode("spot");                                                 // also clears the gate's status line
    clearSpot();
    eyebrow(spotCard, SAYS.soon);
    shown = { a, c };
    const st = a.state;
    if ((st === "waiting" || st === "unconfirmed") && c.stop) {   // opened with the leave link (C23)
      setNum(a.position);
      setTitle(a);
      setLine(SAYS.leaveQ);
      const leave = el("button", "ghost wl-leave", SAYS.leave);
      leave.type = "button";
      leave.addEventListener("click", async () => {
        leave.disabled = true;
        busy("Leaving…");
        const r = await wlLeave(c.token);
        if (r.ok) paintSpot({ state: "left" }, { token: c.token });
        else { leave.disabled = false; say(SAYS.trouble); }
      });
      acts.append(leave, row(linkBtn(SAYS.keep, () => reload(c.token, {}))));
    } else if (st === "waiting" || st === "unconfirmed") {
      setNum(a.position);
      if (st === "unconfirmed") setLine(c.join ? (c.mailed ? SAYS.sentTo(c.email) : SAYS.noMail) : SAYS.inInbox);
      else if (a.just_confirmed) setLine(SAYS.confirmed);
      setTitle(a);
      setBatch(a);
      if (st === "waiting") { setCrew(a); setDiscord(a); }       // confirmed only: never on an unconfirmed page
      const code = codeOf(a);
      if (code && referOk) acts.append(primary(SAYS.moveUp, () => paintRefer(code, false)));
      if (st === "unconfirmed") acts.append(row(againBtn(c, !!c.join)));
      acts.append(row(linkBtn(SAYS.other, otherEmail)));
    } else if (st === "released") {
      eyebrow(spotCard, SAYS.yourTurn);
      num.textContent = SAYS.inWord;
      num.classList.add("is-word");
      num.hidden = false;
      setLine(SAYS.released);
      acts.append(primary(SAYS.create, () => {
        if (typeof gateUpFromWaitlist === "function") gateUpFromWaitlist("", WL_RELEASED_SAYS, { askCode: true });   // C103
      }));
      const again = linkBtn(SAYS.again, async () => {
        again.disabled = true;
        busy("Sending…");
        const r = await wlResend(c.token);
        say(r.ok && r.mailed ? SAYS.sentAgain : r.wait_s ? SAYS.soonS(r.wait_s) : SAYS.noMail);
        cooled(again, r.ok && r.mailed ? 60 : r.wait_s);
      });
      const signIn = linkBtn(SAYS.signIn, () => { mode("in"); $("email")?.focus(); });
      acts.append(row(document.createTextNode(SAYS.needCode), again), row(document.createTextNode(SAYS.made + " "), signIn));
      setDiscord(a);
    } else if (st === "left") {
      setLine(SAYS.left);
      acts.append(primary(SAYS.joinAgain, toWait));
    } else if (st === "none") {
      setLine(SAYS.dead);
      acts.append(primary(SAYS.join, toWait));
    } else {                                                      // limited / off / error: say so, offer a retry
      setLine(failSays(st));
      acts.append(row(linkBtn(SAYS.retry, () => reload(c.token, { confirm: c.confirm ? WL_ARRIVAL.confirm : "", stop: c.stop }))));
    }
    focusCard();
  };

  /* ---------------- the refer screen ----------------
     TEXT A FRIEND. On a phone it is a real link to the Messages app with the message already written: iOS reads
     `sms:&body=…`, Android `sms:?body=…` (both URL-encoded). A link, not a script, so the tap itself opens Messages and
     no in-app browser can swallow it as a popup. On a computer there is no texting to hand to, so "copy your link" is
     the button and the system share sheet (Messages on a Mac) is offered where the browser has one. The message is
     WL_SHARE_MSG + the link, in the creator's own casing (CSS lowercases only what is drawn here, never what is sent). */
  const PLATFORM = (() => {
    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";   // iPadOS asks as a Mac
    if (/Android/i.test(ua)) return "android";
    return "";
  })();
  let shareUrl = "";
  const shareText = () => `${WL_SHARE_MSG} ${shareUrl}`;
  const smsHref = (body) => (PLATFORM === "ios" ? "sms:&body=" : "sms:?body=") + encodeURIComponent(body);
  const copyLink = async (btn, label) => {
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(shareUrl); ok = true; } } catch { /* refused */ }
    if (ok) {
      btn.textContent = SAYS.copied;
      clearTimeout(btn._wlC);
      btn._wlC = setTimeout(() => { btn.textContent = label; }, 1500);
      return;
    }
    rLink.hidden = false;                                         // copy refused: show the link to press and hold
    try { getSelection().selectAllChildren(rLink); } catch { /* nothing to select */ }
    say(SAYS.hold);
  };
  const paintRefer = (code, fresh) => {
    if (!referOk) return;
    shareUrl = `${location.origin}/?join=${code}`;
    mode("refer");
    eyebrow($("gate-refer"), fresh ? SAYS.onList : SAYS.moveUpTag);
    rLink.textContent = shareUrl;
    rLink.hidden = true;
    const phone = !!PLATFORM;
    if (phone) rText.href = smsHref(shareText()); else rText.removeAttribute("href");
    rText.hidden = !phone;
    rCopy.className = phone ? "ghost wl-r-alt" : "btn onb-shim wl-r-go";   // the one moving button: #wlr-text on a phone
    rCopy.textContent = rCopy.dataset.label = phone ? SAYS.copyLink : SAYS.copyYours;
    if (rShare) rShare.hidden = phone || typeof navigator.share !== "function";
    rSkip.textContent = fresh ? SAYS.skip : SAYS.back;
    focusOn(rBig);
  };
  if (referOk) {
    rCopy.addEventListener("click", () => copyLink(rCopy, rCopy.dataset.label || SAYS.copyLink));
    rShare?.addEventListener("click", async () => {
      try { await navigator.share({ title: "lynxr", text: WL_SHARE_MSG, url: shareUrl }); }
      catch (e) { if (!e || e.name !== "AbortError") copyLink(rCopy, rCopy.dataset.label || SAYS.copyYours); }
    });
    rSkip.addEventListener("click", () => { if (shown) paintSpot(shown.a, shown.c); });
  }

  /* ---------------- the friend's banner on the landing ----------------
     The page's one button (#lp-first-cta) inside a card that says a friend sent them (C110-C112). The video above makes
     room for it (body.wl-invited in app.css). The button still runs creator.js's [data-gate="wait"] -> wlOpen: a kept
     invite opens the invite card, a kept share code rides along on the join. */
  const inv = $("lp-invite"), invT = $("lp-invite-t"), invS = $("lp-invite-s"), cta = $("lp-first-cta");
  const BANNER = {
    join: ["A friend invited you to lynxr", "Join and they move up 10 places.", SAYS.join],                // C110
    gift: ["A friend gave you an invite", "Skip the waitlist and make your account now.", "Claim your invite"],   // C111
    used: ["This invite has been used", "You can still join the waitlist.", SAYS.join],                  // C112
    none: ["This invite link doesn't work", "You can still join the waitlist.", SAYS.join],
    off: ["Invites are paused right now", "You can still join the waitlist.", SAYS.join],
  };
  WL_UI.banner = (kind) => {
    const b = BANNER[kind];
    if (!b || !inv || !invT || !invS || !cta) return;
    invT.textContent = b[0];
    invS.textContent = b[1];
    cta.textContent = b[2];
    inv.hidden = false;
    inv.parentElement.classList.add("is-invited");
    document.body.classList.add("wl-invited");
  };

  /* ---------------- the story image (B10) — PARKED 2026-11-20 ----------------
     The owner asked for the simplest flow ("no need for fluff"), so the refer screen offers text and copy only and the
     story button is gone from the page. The renderer stays, unreached (storyGo is null without #wl-story-go): add that
     button back to #gate-refer and call setStory(answer) from paintRefer to bring it back.
     A 1080x1920 PNG drawn by the browser on a <canvas> (the canvas API is not governed by the CSP; img-src has no
     blob: or data:, so the image is NEVER put in an <img>: the preview, fixture only, is the canvas itself). The x is
     drawn with paths from /favicon.svg's geometry (no image load); the font is the self-hosted Albert Sans. The copy is
     lowercased at draw time (CSS cannot reach a canvas; the source keeps its case); the link keeps its capitals.
     Rendered ahead of the tap, so navigator.share still has the click's user activation. Nothing is sent anywhere. */
  const STORY = { im: "I'm", line: "in line for lynxr", title: "Founding creator", join: "Join with my link" };   // C45
  const FACE = '"Albert Sans", system-ui, sans-serif';
  let storyFor = null;                                            // {position, code, title} of the card on screen
  const storyCache = { key: "", blob: null };
  const storyKey = (d) => `${d.position}|${d.code}|${d.title || ""}`;
  const rrPath = (x, y, w, h, r) => {
    const p = new Path2D();
    p.moveTo(x + r, y);
    p.arcTo(x + w, y, x + w, y + h, r); p.arcTo(x + w, y + h, x, y + h, r);
    p.arcTo(x, y + h, x, y, r); p.arcTo(x, y, x + w, y, r);
    p.closePath();
    return p;
  };
  async function wlStoryRender(d) {
    try { await Promise.all([document.fonts.load(`800 100px "Albert Sans"`), document.fonts.load(`600 100px "Albert Sans"`)]); }
    catch { /* system-ui stands in */ }
    const cv = document.createElement("canvas");
    cv.width = 1080; cv.height = 1920;
    const ctx = cv.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    const low = (c) => String(c).toLowerCase();
    // background: tinted ink, never pure black
    const bg = ctx.createLinearGradient(0, 0, 0, 1920);
    bg.addColorStop(0, "#2a1846"); bg.addColorStop(0.6, "#120c22"); bg.addColorStop(1, "#0c0a18");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, 1080, 1920);
    const glow = (x, y, r, c) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, c); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, 1080, 1920);
    };
    glow(540, 520, 700, "rgba(123,97,255,0.35)");
    glow(160, 1500, 600, "rgba(255,126,184,0.18)");
    // the x: four glass arms (favicon.svg, viewBox 0 0 120 120), scale 2.5, its centre (60, 62) at (540, 400)
    if (typeof Path2D.prototype.addPath === "function" && typeof DOMMatrix === "function") {
      const arm = rrPath(43, 10, 34, 60, 17), xp = new Path2D();
      for (const deg of [-45, 45, 135, -135]) xp.addPath(arm, new DOMMatrix().translate(60, 62).rotate(deg).translate(-60, -62));
      ctx.save();
      ctx.translate(540, 400); ctx.scale(2.5, 2.5); ctx.translate(-60, -62);
      const g1 = ctx.createLinearGradient(10, 0, 110, 118);
      g1.addColorStop(0, "#ffb38a"); g1.addColorStop(0.48, "#ff7eb8"); g1.addColorStop(1, "#7b61ff");
      ctx.fillStyle = g1; ctx.fill(xp);
      const g2 = ctx.createLinearGradient(0, 14, 0, 108);
      g2.addColorStop(0, "rgba(246,244,255,.2)"); g2.addColorStop(0.5, "rgba(246,244,255,0)"); g2.addColorStop(1, "rgba(58,20,120,.32)");
      ctx.fillStyle = g2; ctx.fill(xp);
      ctx.fillStyle = "#f6f4ff";
      ctx.fill(rrPath(47, 48.5, 8, 13, 4)); ctx.fill(rrPath(65, 48.5, 8, 13, 4));
      ctx.translate(60, 70);
      ctx.beginPath(); ctx.moveTo(-5, 0); ctx.quadraticCurveTo(0, 4, 5, 0);
      ctx.strokeStyle = "#f6f4ff"; ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
      ctx.restore();
    }
    // the glass panel
    const panel = rrPath(96, 640, 888, 760, 64);
    ctx.fillStyle = "rgba(18,16,32,0.62)"; ctx.fill(panel);
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(246,244,255,0.14)"; ctx.stroke(panel);
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    const text = (t, y, font, color) => { ctx.font = font; ctx.fillStyle = color; ctx.fillText(t, 540, y); };
    text(low(STORY.im), 760, `600 64px ${FACE}`, "#cdc8e2");
    const big = "#" + Number(d.position).toLocaleString("en-US");
    let size = 360;
    for (; size > 160; size -= 10) { ctx.font = `800 ${size}px ${FACE}`; if (ctx.measureText(big).width <= 760) break; }
    text(big, 1060, `800 ${size}px ${FACE}`, "#f6f4ff");
    text(low(STORY.line), 1180, `600 64px ${FACE}`, "#cdc8e2");
    const pill = (label, cy, h, padX, font, fill, stroke, lw) => {
      ctx.font = font;
      const w = Math.min(1000, ctx.measureText(label).width + padX * 2);
      const p = rrPath(540 - w / 2, cy - h / 2, w, h, h / 2);
      if (fill) { ctx.fillStyle = fill; ctx.fill(p); }
      ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke(p);
      ctx.textBaseline = "middle"; ctx.fillStyle = "#f6f4ff"; ctx.fillText(label, 540, cy + 2);
      ctx.textBaseline = "alphabetic";
    };
    if (d.title === "founding") pill(low(STORY.title), 1290, 84, 36, `600 44px ${FACE}`, null, "rgba(246,244,255,0.5)", 3);
    // below the panel: the link, with its capitals (content). Nothing important above y 250 or below y 1690.
    text(low(STORY.join), 1530, `500 44px ${FACE}`, "#aca6c6");
    const url = `${location.host}/?join=${d.code}`;
    let us = 52;
    for (; us > 30; us -= 2) { ctx.font = `600 ${us}px ${FACE}`; if (ctx.measureText(url).width <= 920) break; }
    pill(url, 1622, 104, 40, `600 ${us}px ${FACE}`, "rgba(246,244,255,0.08)", "rgba(246,244,255,0.18)", 2);
    return cv;
  }
  const storyBlob = async (d) => {
    const key = storyKey(d);
    if (storyCache.key === key && storyCache.blob) return storyCache.blob;
    const cv = await wlStoryRender(d);
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    if (!blob) throw new Error("no blob");
    storyCache.key = key; storyCache.blob = blob;
    return blob;
  };
  const canShareFiles = () => {
    try { return !!navigator.canShare?.({ files: [new File([""], "x.png", { type: "image/png" })] }); } catch { return false; }
  };
  const setStory = (a) => {
    if (!storyGo) return;
    const code = String(a.ref_code || "").toUpperCase();
    const pos = Number(a.position);
    if (!WL_CODE.test(code) || !(pos > 0)) { storyGo.hidden = true; return; }
    storyFor = { position: pos, code, title: a.title === "founding" ? "founding" : null };
    storyGo.textContent = canShareFiles() ? SAYS.storyShare : SAYS.storySave;
    storyGo.hidden = false;
    const want = storyFor;
    const ahead = () => { if (storyFor === want) storyBlob(want).catch(() => { /* rendered again on the tap */ }); };
    if (typeof requestIdleCallback === "function") requestIdleCallback(ahead, { timeout: 1500 }); else setTimeout(ahead, 200);
    if (WLTEST && WLTEST.name === "story" && storyPrev) {        // fixture only: the image itself, in the card
      wlStoryRender(want).then((cv) => { if (storyFor !== want) return; cv.setAttribute("aria-hidden", "true"); storyPrev.replaceChildren(cv); storyPrev.hidden = false; });
    }
  };
  storyGo?.addEventListener("click", async () => {
    const d = storyFor;
    if (!d) return;
    let blob;
    try { blob = await storyBlob(d); } catch { say(SAYS.storyFail); return; }
    const file = new File([blob], `lynxr-waitlist-${d.position}.png`, { type: "image/png" });
    let shareable = false;
    try { shareable = !!navigator.canShare?.({ files: [file] }); } catch { shareable = false; }
    if (shareable) {
      try { await navigator.share({ files: [file], title: "lynxr" }); return; }     // files only: some targets refuse text + files
      catch (e) { if (e && e.name === "AbortError") return; }                         // anything else: save it instead
    }
    try {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = file.name; link.hidden = true;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      say(SAYS.storySaved);
    } catch { say(SAYS.storyFail); }
  });
  /* ---------------- the invite card (B11): a friend's ?gift= link ----------------
     Peek: ok -> the form (one field, one moving button once an address is typed); used up / dead / paused -> one line and
     one moving "join the waitlist"; limited / trouble -> say so, "try again". Claim: claimed / again -> "check your email"
     and three quiet actions; busy -> the dead end; account / open -> creator.js has already switched to the create card. */
  const gift = $("gate-gift"), gBig = $("wlg-big"), gLbl = $("wlg-lbl"), gLine = $("wlg-line"), gForm = $("wlg-form");
  const gField = $("wlg-email"), gGo = $("wlg-go"), gPromise = $("wlg-promise"), gActs = $("wlg-acts");
  const giftOk = !!(gift && gBig && gLbl && gLine && gForm && gField && gGo && gActs);
  const GIFT = {
    used: "This invite has been used. You can still join the waitlist.",                               // C49
    dead: "This invite link doesn't work.",
    off: "Invites are paused right now. You can still join the waitlist.",
    busy: "Lots of invites are being claimed today. Try again tomorrow, or join the waitlist.",
    opening: "Opening your invite…", claiming: "Claiming…", sending: "Sending…",                        // C47
    check: "Check your email",                                                                         // C48
    sent: (email) => `Your invite is on its way to ${email}. Open it to make your account. It's held for 14 days.`,
    again: "You've already claimed an invite. We've emailed it to you again.",
    againQuiet: "You've already claimed an invite. It's in your inbox.",
    makeNow: "Make my account now",
  };
  let gCode = "", gEmail = "", gClaiming = false;
  const gText = giftOk ? { big: gBig.textContent, lbl: gLbl.textContent, line: gLine.textContent } : null;
  if (giftOk) gLine.tabIndex = -1;
  const gReady = () => { if (giftOk) gGo.disabled = gClaiming || !looksLikeEmail(gField.value.trim()); };
  const gFlag = (on) => {
    if (on) { if (typeof markInvalid === "function") markInvalid(gField, "err"); }
    else if (typeof clearInvalid === "function") clearInvalid(gField);
  };
  const gFocus = () => { const t = gBig && !gBig.hidden ? gBig : gLine; try { t.focus({ preventScroll: true }); } catch { /* fine */ } };
  /* "Join the waitlist" from a dead invite: the person's own spot if this device has one, else the wait card. In-card
     move, so no second history entry; never back to the invite (a "busy" code is still kept for tomorrow). */
  const giftToWait = () => {
    const stored = wlStoredSpot();
    if (stored) { wlOpenSpot(stored, {}); return; }
    toWait();
  };
  const gReset = () => {
    gBig.textContent = gText.big; gBig.hidden = true;
    gLbl.textContent = gText.lbl; gLbl.hidden = true;
    gLine.textContent = ""; gLine.hidden = true;
    gForm.hidden = true;
    if (gPromise) gPromise.hidden = true;
    gActs.replaceChildren();
  };
  const gDeadEnd = (text) => {
    gReset();
    gLine.textContent = text; gLine.hidden = false;
    gActs.append(primary(SAYS.join, giftToWait));
  };
  const gFormState = () => {
    gReset();
    gBig.hidden = false; gLbl.hidden = false;
    gLine.textContent = gText.line; gLine.hidden = false;
    gForm.hidden = false;
    if (gPromise) gPromise.hidden = false;
    gClaiming = false;
    gGo.removeAttribute("aria-busy");
    gReady();
  };
  const paintGift = (a, c) => {
    if (!giftOk) return;
    gCode = c.code || gCode;
    if (c.email) gEmail = c.email;
    const st = c.phase === "peek" ? a.state : a.status;
    if (st === "account" || st === "open") return;                // creator.js has opened the create card (C50 / C51)
    gClaiming = false;
    gGo.removeAttribute("aria-busy");
    if (c.phase === "peek") say("");
    if (st === "ok") { gFormState(); gFocus(); return; }
    if (st === "used_up") { gDeadEnd(GIFT.used); gFocus(); return; }
    if (st === "none") { gDeadEnd(GIFT.dead); gFocus(); return; }
    if (st === "off") { gDeadEnd(GIFT.off); gFocus(); return; }
    if (st === "busy") { say(""); gDeadEnd(GIFT.busy); gFocus(); return; }
    if (st === "bad_email") { gReady(); say(SAYS.bad); gFlag(true); gField.focus(); return; }
    if (st === "claimed" || st === "again") {
      gReset();
      say("");
      const mailed = a.mailed === true;
      gBig.textContent = GIFT.check; gBig.hidden = false;
      gLine.textContent = st === "claimed" ? (mailed ? GIFT.sent(gEmail) : SAYS.noMail) : (mailed ? GIFT.again : GIFT.againQuiet);
      gLine.hidden = false;
      const again = linkBtn(SAYS.again, async () => {
        again.disabled = true;
        await wlGiftClaim(gCode, gEmail);                             // answered "again": this card repaints itself
      });
      const now = linkBtn(GIFT.makeNow, () => {
        if (typeof gateUpFromWaitlist === "function") gateUpFromWaitlist(gEmail, WL_GIFT_READY_SAYS, { askCode: true });   // C52
      });
      const other = linkBtn(SAYS.other, () => { gFormState(); gField.focus(); gField.select(); });
      gActs.append(row(again), row(now), row(other));
      if (mailed) cooled(again, 60);                                  // an email just went
      gFocus();
      return;
    }
    // limited / error: on the claim the form stays as it was; on the peek, a retry
    if (c.phase === "claim") { gReady(); say(failSays(st)); return; }
    gReset();
    gLine.textContent = failSays(st); gLine.hidden = false;
    gActs.append(row(linkBtn(SAYS.retry, () => wlGiftOpen(gCode))));
    gFocus();
  };
  if (giftOk) {
    gField.addEventListener("input", () => {
      gReady();
      if (gField.getAttribute("aria-invalid") === "true" && looksLikeEmail(gField.value.trim())) {
        gFlag(false);
        const e = errEl();
        if (e && e.textContent === SAYS.bad) e.textContent = "";
      }
    });
    gField.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !gGo.disabled || gClaiming) return;
      e.preventDefault();
      say(SAYS.bad);
      gFlag(true);
    });
    gForm.addEventListener("submit", (e) => {
      e.preventDefault();
      if (gClaiming) return;
      wlGiftClaim(gCode, gField.value);
    });
  }
  WL_UI.gift = (out, ctx) => paintGift(out || {}, ctx || {});

  WL_UI.loading = (what) => {
    if (what === "gift") {
      if (giftOk) { gReset(); gFlag(false); }
      busy(GIFT.opening);
      return;
    }
    if (what === "giftclaim") {
      if (!giftOk) return;
      gClaiming = true;
      if (!gForm.hidden) { gGo.disabled = true; gGo.setAttribute("aria-busy", "true"); busy(GIFT.claiming); }
      else busy(GIFT.sending);
      return;
    }
    if (what === "join") {
      joining = true;
      go.disabled = true;
      go.setAttribute("aria-busy", "true");
      busy(SAYS.joining);
      return;
    }
    clearSpot();
    eyebrow(spotCard, SAYS.soon);
    busy(SAYS.loading);
  };
  WL_UI.wait = () => paintWait();
  /* A new join goes to the refer screen first (owner: "they get sent to a refer a friend ... and are encouraged to");
     its skip lands on the queue page painted from this same answer, so nothing is asked twice. */
  WL_UI.joined = (out, email) => {
    joining = false;
    go.removeAttribute("aria-busy");
    ready();
    const s = out.status;
    if (s === "account") { say(SAYS.access); return; }             // no password box from the waitlist (owner, 2026-11-20)
    if (s === "bad_email") { say(SAYS.bad); flag(true); field.focus(); return; }
    if (s === "new") {
      const a = { state: "unconfirmed", position: out.position, ref_code: out.ref_code, referrals: 0,
        batch_size: out.batch_size, places: out.places };
      const c = { join: true, email, mailed: out.mailed === true, sentAt: out.mailed === true ? Date.now() : 0 };
      const code = codeOf(a);
      if (code && referOk) { shown = { a, c }; paintRefer(code, true); } else paintSpot(a, c);
      return;
    }
    if (s === "exists") { say(out.mailed ? SAYS.exists : SAYS.existsQuiet); return; }
    say(failSays(s));
  };
  WL_UI.spot = (out, ctx) => paintSpot(out, ctx || {});
})();

/** On DOMContentLoaded, which fires AFTER the deferred creator.js has run (it owns showGate and the session).
    Who lands where, first match wins: a signed-in creator -> the app (creator.js); a ?spot= link -> the queue page; a
    friend's invite (?gift=, or one kept here) -> the landing with the invite banner; a card creator.js already opened
    for a link (release / invite / brief link) or a confirmation / provider return in the #fragment -> left alone; this
    device keeps their spot link -> THE QUEUE PAGE (a returning waitlister never sees the marketing page again); a
    friend's share code (?join=, or kept 30 days) -> the landing with the friend's banner. */
function wlBoot() {
  if (!$("gate-wait")) return;                                  // no waitlist markup on this page: nothing to do
  if (WLTEST) {
    if (WLTEST.kind === "banner") {
      if (WLTEST.banner === "gift") wlGiftBanner("ABCDEFGH"); else WL_UI.banner?.("join");
      return;
    }
    if (WLTEST.kind === "spot") {
      wlOpenSpot(WL_TEST_TOKEN, { confirm: WLTEST.name === "confirmed" ? WL_TEST_TOKEN : "", stop: WLTEST.name === "stop" });
      return;
    }
    if (WLTEST.kind === "gift") {
      wlGiftOpen("ABCDEFGH").then((out) => { if (WLTEST.claimNow && out.state === "ok") wlGiftClaim("ABCDEFGH", "friend@example.invalid"); });
      return;
    }
    wlOpen("");
    if (WLTEST.name !== "wait" && WLTEST.name !== "wait-ref") wlSubmit("you@example.invalid");   // the card the answer opens
    return;
  }
  let signedIn = false;
  try { signedIn = !!localStorage.getItem("lynxr_creator_session"); } catch { /* treat as signed out */ }
  if (signedIn) return;                                         // a signed-in creator lands in the app, not on the waitlist
  if (WL_ARRIVAL.spot) { wlOpenSpot(WL_ARRIVAL.spot, { confirm: WL_ARRIVAL.confirm, stop: WL_ARRIVAL.stop }); return; }
  const gift = wlGift();
  if (gift) { wlGiftBanner(gift); return; }
  if (document.body.classList.contains("gate-on")) return;      // creator.js opened the card for a link: that wins
  if (/access_token|refresh_token|error/.test(location.hash)) return;
  const kept = wlStoredSpot();
  if (kept) { wlOpenSpot(kept, {}); return; }
  if (wlRef()) WL_UI.banner?.("join");
}
if (document.readyState === "complete") wlBoot();
else document.addEventListener("DOMContentLoaded", wlBoot);
})();
