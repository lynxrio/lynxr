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

  const openMenu = () => {
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
    /* FOCUS MOVES INTO THE PANEL. Without this, Tab from the burger walks
       through the (hidden) rest of the bar first. */
    const first = menu.querySelector("a, button");
    if (first) first.focus();
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

  if (burger && menu) {
    burger.addEventListener("click", () => {
      if (menuOpen) closeMenu(true); else openMenu();
    });
    /* Selecting an item closes it. The navigation itself may be a same-page
       fragment (/#how from /), which does not reload — so nothing else would
       take the panel down. */
    menu.addEventListener("click", (e) => {
      /* `false`: the navigation owns focus from here. A same-page fragment
         (/#how) moves focus to the target section, and pulling it back to the
         burger would fight that. */
      if (e.target.closest("a")) closeMenu(false);
    });
    addEventListener("keydown", (e) => {
      if (e.key === "Escape" && menuOpen) { e.preventDefault(); closeMenu(true); }
    });
    /* OUTSIDE CLICK. pointerdown rather than click so a drag that starts on the
       page does not leave the panel open behind the finger. Anything inside the
       bar (the burger, the panel) is inside. */
    addEventListener("pointerdown", (e) => {
      /* If focus was INSIDE the panel when it closed, it has to go somewhere
         real — otherwise it lands on <body> and the next Tab restarts from the
         top of the document. */
      if (menuOpen && !bar.contains(e.target)) closeMenu(menu.contains(document.activeElement));
    }, true);
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
  addEventListener("resize", () => { remeasure(); onScroll(); }, { passive: true });
  addEventListener("orientationchange", () => { remeasure(); onScroll(); }, { passive: true });
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
})();
