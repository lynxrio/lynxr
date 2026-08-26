/* ---------------------------------------------------------------------------
   THE PUBLIC PAGES' TOP BAR — hides on the way down, comes back on the way up,
   and below 760px collapses into a burger with a drop-down panel.

   PUBLIC PAGES ONLY, and that is a hard boundary rather than a convenience.
   This file is loaded by /, /waitlist/, /faq/, /terms/, /privacy/ and
   /accessibility/ and nothing else, and it does nothing at all unless it finds
   a `.lp-bar`. It must NEVER be given to the creator or agency app: the creator
   app's `.pane-head` is sticky on desktop and static under 820px, and
   scrollCardIntoView reads getComputedStyle(head).position to work out how far
   to offset a card it is scrolling to the top. A header that hides and shows
   would turn that offset into a moving target and silently break the card
   scroll — the failure would look like "the scroll is slightly wrong
   sometimes", which is the worst kind to track down.
   --------------------------------------------------------------------------- */
(() => {
  const bar = document.querySelector(".lp-bar");
  if (!bar) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* SMOOTH SCROLL TO A SECTION, public pages only. The rule and its
     prefers-reduced-motion guard both live in app.css under `html.lp-smooth` —
     all this does is opt this document in, which is what keeps it off the two
     apps (whose own scrollCardIntoView would fight a smooth container). */
  document.documentElement.classList.add("lp-smooth");

  /* ---- A LINK STRAIGHT TO ONE ANSWER: /faq/#who-owns-the-scripts ----

     WHAT THE BROWSER DOES UNAIDED, MEASURED (Chromium, 1440x900, on a first
     navigation and on a same-document hash change alike): it DOES open the
     <details> the target sits inside, and it DOES scroll — but it parks that
     block ~12.6px from the top of the viewport, ignoring the
     `html { scroll-padding-top: 76px }` near the top of app.css. Every other
     anchor on this site honours that padding (the homepage's /#how lands at
     75.6px), so this is specific to the auto-expand-a-details path, and it is
     not cosmetic: the floating capsule's bottom edge sits at y=72, so on a jump
     that scrolls UPWARD — the direction that leaves the bar on screen — the
     QUESTION is entirely behind the capsule and the answer's first line starts
     0.8px above its bottom edge. An answer arriving with its own question
     invisible is exactly what a citable anchor must not do.

     Verified NOT to be `html.lp-smooth`: with the class suppressed, and with
     scripting disabled altogether, the landing is byte-identical (y=1765,
     block top 12.6). The smooth rule is innocent here.

     SCOPED TO A TARGET INSIDE A <details>, deliberately. An ordinary section
     anchor already lands correctly on the native path and is left on it —
     re-implementing the homepage's section scroll here would be a second
     mechanism to keep in step with the first.

     THE ELEMENT SCROLLED IS THE <details>, NOT THE <p> CARRYING THE id. These
     ids exist to be cited; an answer whose question is off the top of the
     screen is a quote with nothing to attach it to. block:"start" against the
     existing scroll-padding puts the question 4px clear of the capsule.

     NO scroll-margin-top, ON EITHER ELEMENT. scroll-padding on the container
     STACKS with a scroll-margin on the target — the decision note above
     `html.lp-smooth` in app.css records the 164px landing that mistake already
     produced once on the homepage sections.

     `behavior` IS PASSED EXPLICITLY, WHICH IS WHY `reduced` IS READ HERE. An
     omitted behavior inherits the CSS scroll-behavior, and that is precisely
     what app.css's prefers-reduced-motion guard flips to `auto`; hard-coding
     "smooth" would drive straight through the guard. The MediaQueryList is
     live, so turning the setting on mid-visit is honoured on the next jump. */
  const jumpToAnswer = () => {
    const raw = location.hash.slice(1);
    if (!raw) return;
    let id = raw;
    try { id = decodeURIComponent(raw); } catch { /* a stray % — use it raw */ }
    const el = document.getElementById(id) || document.getElementById(raw);
    const box = el && el.closest("details");
    if (!box) return;                 // a section anchor, or nothing: leave it alone
    box.open = true;
    /* TWO FRAMES, not none. The block has only just been expanded and its own
       height decides where it lands, so scrolling in this same task would
       measure the collapsed box. The second frame is also what puts this AFTER
       the browser's own fragment scroll — this file is deferred, so it runs
       BEFORE that — and landing last is what makes the position deterministic
       instead of a race between the two. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      box.scrollIntoView({ block: "start", behavior: reduced.matches ? "auto" : "smooth" });
    }));
  };
  /* Both entry points: a fresh navigation carrying a fragment, and a fragment
     that changes with the document already open. */
  addEventListener("hashchange", jumpToAnswer);
  jumpToAnswer();

  /* ------------------------------------------------------------------ menu --
     Declared BEFORE the scroll logic because setHidden() consults it: an open
     panel is a child of the bar, so a bar that slid away would take the menu
     with it. Two braces, not one — this flag, and the
     `.lp-bar.lp-menu-live.lp-bar-away { transform: none }` rule in app.css, so
     a stale class cannot matter either. */
  const burger = bar.querySelector(".lp-burger");
  const menu = bar.querySelector(".lp-menu");
  /* The same media query the CSS collapses at. One number in two places is a
     drift waiting to happen, so if this ever moves, move it in app.css's
     `@media (max-width: 760px)` too. */
  const narrow = window.matchMedia("(max-width: 760px)");
  let menuOpen = false;
  let closeTimer = 0;
  let lockedY = 0;

  const setHidden = (v) => {
    /* Refuses to hide while the panel is open. */
    if (v && menuOpen) v = false;
    if (v === hidden) return;
    hidden = v;
    /* A class, not a style attribute: style-src is 'self' with no
       'unsafe-inline', so an inline style="" would be dropped silently. */
    bar.classList.toggle("lp-bar-away", v);
  };

  const lockScroll = () => {
    lockedY = window.scrollY;
    /* CSSOM, not a style attribute — same CSP reason as the class above.
       position:fixed rather than overflow:hidden because iOS ignores the latter
       on <body>; the offset is put back byte-for-byte on close. */
    document.body.style.top = `${-lockedY}px`;
    document.body.classList.add("lp-menu-open");
  };
  const unlockScroll = () => {
    document.body.classList.remove("lp-menu-open");
    document.body.style.top = "";
    /* `instant`, EXPLICITLY. The document is `scroll-behavior: smooth` now, so a
       plain scrollTo here would ANIMATE the restore — you would watch the page
       glide back to where it already was before the link you tapped got a chance
       to move it. This is a restore, not a journey. */
    window.scrollTo({ top: lockedY, left: 0, behavior: "instant" });
    /* The bar's own bookkeeping has to agree with where the page actually is,
       or the first scroll after a close computes a delta against a stale
       `last` and can hide the bar instantly. */
    last = lockedY;
  };

  const openMenu = (viaKeyboard) => {
    if (!burger || !menu || menuOpen) return;
    clearTimeout(closeTimer);
    menuOpen = true;
    /* `hidden` comes off FIRST and `is-open` goes on in the next frame: a
       transition cannot run from display:none, so setting both together would
       make the panel appear fully open with no animation. */
    menu.hidden = false;
    bar.classList.add("lp-menu-live");
    setHidden(false);
    requestAnimationFrame(() => { if (menuOpen) menu.classList.add("is-open"); });
    burger.setAttribute("aria-expanded", "true");
    burger.setAttribute("aria-label", "close menu");
    lockScroll();
    /* FOCUS MOVES INTO THE PANEL — but only for a KEYBOARD open. Without it,
       Tab from the burger walks the hidden rest of the bar first; with it on
       a TAP, Chrome treats the programmatic focus as focus-visible and draws
       a ring around "how it works" that the owner read as broken ("this is
       fucked up"). A pointer open leaves focus on the burger; the Esc and
       outside-tap closers are document-level and never needed it. */
    if (viaKeyboard) menu.querySelector("a, button")?.focus();
  };

  const closeMenu = (returnFocus) => {
    if (!burger || !menu || !menuOpen) return;
    menuOpen = false;
    menu.classList.remove("is-open");
    burger.setAttribute("aria-expanded", "false");
    burger.setAttribute("aria-label", "menu");
    unlockScroll();
    /* THE PANEL'S LINKS MUST LEAVE THE TAB ORDER, and opacity does not do that
       — they would stay focusable and a Tab would land on something invisible.
       `hidden` is set after the fade so the fade is visible at all; under
       reduced motion there is no transition, so it is immediate. A timer, not
       transitionend, because with `transition: none` that event never fires and
       the panel would stay tabbable forever. */
    const wait = reduced.matches ? 0 : 190;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!menuOpen) menu.hidden = true; }, wait);
    bar.classList.remove("lp-menu-live");
    if (returnFocus) burger.focus();
  };

  /* DECLARED HERE, ASSIGNED INSIDE THE IF — because LP_TEARDOWN below is
     IIFE-level and must remove them. As `const`s inside the block they were
     invisible to it, and the FIRST CALL of LP_TEARDOWN threw
     "onKeydown is not defined" — a bug typeof-checking the teardown never
     caught, found only when enterApp() actually called it. On a page with no
     burger they stay undefined and the teardown's removeEventListener calls
     are no-ops, which is the correct behaviour there. */
  let onKeydown, onPointerdown;
  if (burger && menu) {
    burger.addEventListener("click", (e) => {
      /* e.detail is 0 for a keyboard "click" and >0 for a pointer one. */
      if (menuOpen) closeMenu(true); else openMenu(e.detail === 0);
    });
    /* Selecting an item closes it. The navigation itself may be a same-page
       fragment (/#how from /), which does not reload — so nothing else would
       take the panel down. */
    menu.addEventListener("click", (e) => {
      /* `false`: the navigation owns focus from here. A same-page fragment
         (/#how) moves focus to the target section, and pulling it back to the
         burger would fight that. `[data-gate]` is added alongside `a` because
         the merged home's panel also holds a <button data-gate> ("sign in"),
         which is not an <a> and would otherwise leave the panel open over the
         gate it just opened. */
      if (e.target.closest("a, [data-gate]")) closeMenu(false);
    });
    onKeydown = (e) => {
      if (e.key === "Escape" && menuOpen) { e.preventDefault(); closeMenu(true); }
    };
    addEventListener("keydown", onKeydown);
    /* OUTSIDE CLICK. pointerdown rather than click so a drag that starts on the
       page does not leave the panel open behind the finger. Anything inside the
       bar (the burger, the panel) is inside. */
    onPointerdown = (e) => {
      /* If focus was INSIDE the panel when it closed, it has to go somewhere
         real — otherwise it lands on <body> and the next Tab restarts from the
         top of the document. */
      if (menuOpen && !bar.contains(e.target)) closeMenu(menu.contains(document.activeElement));
    };
    addEventListener("pointerdown", onPointerdown, true);
    /* Growing past the breakpoint hides the burger by CSS, which would leave
       the body scroll-locked with no visible way to unlock it. */
    narrow.addEventListener("change", () => { if (!narrow.matches) closeMenu(false); });
  }

  /* ---------------------------------------------------------------- scroll -- */
  /* At or above this, the bar is shown no matter what the direction logic
     thinks. "Scrolled to the top" must always mean "the bar is there". */
  const TOP = 8;
  /* Ignore direction changes smaller than this. A trackpad twitch or a single
     pixel of jitter would otherwise flicker the bar in and out, which is far
     more noticeable than the feature itself. */
  const DELTA = 14;

  let last = 0;
  let ticking = false;
  let hidden = false;
  /* THE SCROLL HANDLER READS NO LAYOUT. scrollHeight is a full-document layout
     read, and doing one on every animation frame while the page is scrolling —
     in frames where the class was just written — forces a synchronous reflow
     and is the classic cause of a stuttering sticky header. It is cached here
     instead and refreshed only when the document can actually have changed
     height: a resize, an orientation change, or a <details> opening on /faq/.
     scrollY is the only thing read per frame, and it is read BEFORE anything is
     written. */
  let maxScroll = 0;
  const remeasure = () => {
    maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  };

  const read = () => {
    ticking = false;
    /* Under reduced motion the bar simply stays. An element that pops in and
       out with no transition is more disorienting than one that does not move,
       and this is a convenience rather than something the page needs. */
    if (reduced.matches) { setHidden(false); return; }

    /* CLAMPED, because iOS momentum scrolling overshoots at both ends: pulling
       past the top gives a negative scrollY and pulling past the bottom gives
       one larger than the scrollable range. Either reads as a direction change
       and flashes the bar on a rubber-band. */
    const y = Math.min(Math.max(0, window.scrollY), maxScroll);

    if (y <= TOP) { setHidden(false); last = y; return; }

    const d = y - last;
    /* Below the threshold, `last` is deliberately NOT updated — otherwise a
       slow drag would never accumulate past DELTA and the bar would never
       react at all. */
    if (Math.abs(d) < DELTA) return;
    setHidden(d > 0);
    last = y;
  };

  /* One read per frame at most. A raw scroll handler doing layout reads fires
     dozens of times a frame on a trackpad. */
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(read);
  };

  addEventListener("scroll", onScroll, { passive: true });
  const onResize = () => { remeasure(); onScroll(); };
  const onOrient = () => { remeasure(); onScroll(); };
  addEventListener("resize", onResize, { passive: true });
  addEventListener("orientationchange", onOrient, { passive: true });
  /* <details> on /faq/ changes the page height when it opens, which moves the
     bottom clamp. Capturing, because `toggle` does not bubble. */
  addEventListener("toggle", remeasure, true);

  /* TABBING INTO A HIDDEN BAR would put focus on something nobody can see,
     which is a real failure rather than a rough edge. focusin bubbles, so this
     catches the wordmark, all three nav links, the CTA and the burger. */
  bar.addEventListener("focusin", () => setHidden(false));

  reduced.addEventListener("change", () => { if (reduced.matches) setHidden(false); });

  /* Set the initial state without animating into it: at load the bar is
     already shown and `hidden` is already false, so setHidden(false) is a
     no-op and no class is toggled on first paint. */
  remeasure();
  read();

  /* THE MERGED HOME TEARS THIS DOWN. On `/` the same document also hosts the
     creator app, and three of the effects above reach it: html.lp-smooth
     fights scrollCardIntoView, jumpToAnswer force-opens a <details> (the
     library is made of them), and the capturing `toggle` listener does a
     full-document scrollHeight read on every disclosure. creator.js's
     enterApp() calls this the moment sign-in succeeds. Idempotent. */
  /* THE HERO PLACEHOLDER TYPES ITSELF OUT (owner: "have it type out with an
     animation"). The full text comes from the markup, so copy edits stay in
     one place; reduced-motion gets it instantly; the first focus or keystroke
     ends the show and hands over the full text — an animation must never race
     a person already typing. One-shot, so LP_TEARDOWN has nothing to undo. */
  /* TAPPING THE PASTE BOX MUST NOT REVEAL THE PAGE BELOW (owner, twice —
     the meta swap alone did not stop it). The scroll is the BROWSER's own
     focus behaviour: it scrolls the document until the input clears the
     software keyboard, and on a centered hero that drags the sections into
     view. So while composing, the hero group moves to the TOP of the screen
     (html.lp-composing — the input is then already clear of any keyboard and
     the browser has nothing to scroll for), and a scroll pin holds the
     document at 0 as the backstop for engines that scroll anyway. Both end on
     blur. Desktop is unaffected in practice: no keyboard, no browser scroll,
     and the brief top-align only while the caret is in the box. */
  const heroInput = document.getElementById("lp-composer-url");
  if (heroInput) {
    const pin = () => { if (scrollY !== 0) scrollTo(0, 0); };
    heroInput.addEventListener("focus", () => {
      document.documentElement.classList.add("lp-composing");
      scrollTo(0, 0);
      addEventListener("scroll", pin);
    });
    heroInput.addEventListener("blur", () => {
      document.documentElement.classList.remove("lp-composing");
      removeEventListener("scroll", pin);
    });
  }
  if (heroInput && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const full = heroInput.placeholder;
    heroInput.placeholder = "";
    let i = 0;
    const tick = setInterval(() => {
      i += 1;
      heroInput.placeholder = full.slice(0, i);
      if (i >= full.length) clearInterval(tick);
    }, 55);
    heroInput.addEventListener("focus", () => {
      clearInterval(tick); heroInput.placeholder = full;
    }, { once: true });
  }

  window.LP_TEARDOWN = () => {
    closeMenu(false);
    document.documentElement.classList.remove("lp-smooth");
    removeEventListener("hashchange", jumpToAnswer);
    removeEventListener("scroll", onScroll);
    removeEventListener("resize", onResize);
    removeEventListener("orientationchange", onOrient);
    removeEventListener("toggle", remeasure, true);
    removeEventListener("keydown", onKeydown);
    removeEventListener("pointerdown", onPointerdown, true);
  };
})();
