/* ---------------------------------------------------------------------------
   THE PUBLIC PAGES' TOP BAR — hides on the way down, comes back on the way up.

   PUBLIC PAGES ONLY, and that is a hard boundary rather than a convenience.
   This file is loaded by / and /faq/ and nothing else, and it does nothing at
   all unless it finds a `.lp-bar`. It must NEVER be given to the creator or
   agency app: the creator app's `.pane-head` is sticky on desktop and static
   under 820px, and scrollCardIntoView reads getComputedStyle(head).position to
   work out how far to offset a card it is scrolling to the top. A header that
   hides and shows would turn that offset into a moving target and silently
   break the card scroll — the failure would look like "the scroll is slightly
   wrong sometimes", which is the worst kind to track down.

   /waitlist/, /terms/, /privacy/ and /accessibility/ have no `.lp-bar` at all
   (they carry a wordmark or a back-link in the flow), so they are unaffected
   whether or not this file ever reaches them.
   --------------------------------------------------------------------------- */
(() => {
  const bar = document.querySelector(".lp-bar");
  if (!bar) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

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

  const setHidden = (v) => {
    if (v === hidden) return;
    hidden = v;
    /* A class, not a style attribute: style-src is 'self' with no
       'unsafe-inline', so an inline style="" would be dropped silently. */
    bar.classList.toggle("lp-bar-away", v);
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
     catches the wordmark, all three nav links and the CTA. */
  bar.addEventListener("focusin", () => setHidden(false));

  reduced.addEventListener("change", () => { if (reduced.matches) setHidden(false); });

  /* Set the initial state without animating into it: at load the bar is
     already shown and `hidden` is already false, so setHidden(false) is a
     no-op and no class is toggled on first paint. */
  remeasure();
  read();
})();
