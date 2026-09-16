/* ---------------------------------------------------------------------------
   THE SPLIT-FLAP WORDMARK — shared by every surface (the public pages, the
   creator app, the agency app, and the merged home, which carries TWO
   footers in one document). Self-initialising and self-contained: it does
   nothing unless it finds a <footer> containing a .foot-wordmark, and
   exports nothing, so a page that doesn't have one pays nothing for loading
   this file, and no app ever needs to call in.

   Lifted out of app.js's old initFooter() — the wordmark half of that
   function touched no app state (no fmt(), no activateTab(), no rows), so it
   lifts out cleanly. app.js keeps #foot-count and the .foot-link[data-tab]
   wiring, which are agency-only concerns.

   ONE wire() PER FOOTER, not a single instance keyed on an id. The merged
   home has two <footer> elements — the marketing one and the app's in-pane
   one — and only the first can carry id="site-footer"/"foot-wordmark"; the
   second is class-only (see app.css). Querying every <footer> on the page
   and wiring whichever ones actually have a .foot-wordmark inside them
   covers both without either needing an id. */
(() => {
  function wire(foot, mark) {

  // Slot-machine wordmark: each character spins through random glyphs and
  // locks in left-to-right as the footer scrolls into view. At the bottom of
  // the page every slot has stopped on its letter: l y n x r
  const FINAL = mark.textContent.trim() || "lynxr";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;  // static text stays
  // Split-flap, not slot machine: each reel walks the alphabet TOWARD its
  // letter and arrives exactly as it locks — convergence, not noise.
  const REEL = "abcdefghijklmnopqrstuvwxyz.";
  mark.replaceChildren(...[...FINAL].map((ch) => {
    const s = document.createElement("span");
    s.className = "fw-ch spin";
    s.textContent = ch;
    return s;
  }));
  const chars = [...mark.children];
  const N = FINAL.length;
  // PROPORTIONAL LOGO FACE (Albert Sans since the rebrand): lock every slot to
  // its FINAL glyph's advance, in em, so glyphs of different widths passing
  // through the reel cannot shift the word. Canvas measureText, not layout:
  // the footer may be display:none at this point. style.width is CSSOM, which
  // the CSP allows; a style= attribute would be dropped.
  const lockWidths = () => {
    const cs = getComputedStyle(mark);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontWeight} 100px ${cs.fontFamily}`;
    chars.forEach((s, i) => { s.style.width = (ctx.measureText(FINAL[i]).width / 100) + "em"; });
  };
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(lockWidths);

  // Discover scroll sources rather than assume `window`. The creator app's
  // .pane-scroll carries overflow-y: auto and is the element that actually
  // scrolls at desktop widths — the document itself never does there — so a
  // listener bound only to `window` would leave the wordmark frozen on that
  // surface while looking correct everywhere else.
  //
  // NOT "pick the one nearest ancestor with overflow-y:auto, else window":
  // .pane-scroll carries overflow-y:auto UNCONDITIONALLY (app.css:2021, no
  // media query), including under 820px where .shell has no height cap and
  // .pane-scroll's own scrollHeight equals its clientHeight — measured live,
  // confirmed by app.css's own comment at 2499. A `scroll` listener bound
  // only to .pane-scroll there would simply never fire, because there is
  // nothing inside it to scroll; the DOCUMENT is what moves. The same gap
  // bites at init time too: the creator and agency apps start with #app
  // display:none, so whichever element "wins" the walk at script-parse time
  // may not be the one that ends up scrollable after sign-in reveals it.
  // Rather than get that single choice right for every width and every
  // moment, listen on `window` AND every ancestor whose computed overflow-y
  // is auto/scroll — update() is pure and idempotent (it just re-reads
  // getBoundingClientRect(), which is viewport-relative regardless of what
  // scrolled), so a listener that never fires costs nothing, and whichever
  // element turns out to be the real scroller is always covered.
  const scrollSources = [window];
  for (let el = foot.parentElement; el; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") scrollSources.push(el);
  }

  const update = () => {
    const r = foot.getBoundingClientRect();
    // The footer can start life inside a hidden subtree (the creator app's
    // #app and the agency app's #app are both display:none pre-sign-in), and
    // getBoundingClientRect() on a hidden element returns all zeros — dividing
    // by r.height would divide by zero. Bail without writing glyphs; the
    // ResizeObserver below re-runs this once the footer actually has size.
    if (r.height === 0) return;
    // 0 as the footer's top crosses the viewport bottom → 1 when the footer is
    // fully on screen (it's the last element, so that IS the bottom of page).
    const p = Math.min(1, Math.max(0, (innerHeight - r.top) / r.height));
    chars.forEach((s, i) => {
      const lockP = (i + 1) / (N + 1);        // slots lock left-to-right
      if (p >= lockP) {
        if (s.classList.contains("spin")) {   // just arrived: settle in place
          s.classList.remove("spin");
          void s.offsetWidth;
          s.classList.add("settled");
        }
        s.textContent = FINAL[i];
      } else {
        s.classList.add("spin");
        s.classList.remove("settled");
        // Scrubbed by scroll: N flips remain proportional to the distance
        // from this slot's lock point; stationary = frozen.
        const target = Math.max(0, REEL.indexOf(FINAL[i]));
        const total = 6 + i * 2;              // later slots travel further
        const remaining = Math.max(1, Math.ceil(total * (lockP - p) / lockP));
        s.textContent = REEL[(target - (remaining % REEL.length) + REEL.length) % REEL.length];
      }
    });
  };
  scrollSources.forEach((s) => s.addEventListener("scroll", update, { passive: true }));
  addEventListener("resize", update, { passive: true });
  // Covers both the creator app's sign-in reveal and the agency app's tab
  // switches — the footer goes from zero-size to real size in both cases,
  // and this is what re-runs update() without either app needing to call in.
  new ResizeObserver(update).observe(foot);
  update();
  }

  /* THE FOOTER STARTS AT THE BOTTOM EDGE OF THE SCREEN. Owner, 2026-09-15:
     "have it be so that on any display i cant see it unless i scroll down",
     then "make it like the very start is the edge of the display for all
     displays, right now im scrolling too far for it". CSS min-heights got the
     first half and overshot the second: they could not know how tall the
     header above the content is, so the footer began a header's height (plus
     its margin) below the fold. This measures instead. When everything above
     the footer is shorter than one screen, the footer's top margin grows by
     exactly the shortfall, so its top edge sits on the bottom edge of the
     screen with the page scrolled to the top. When the content is taller, the
     margin is left alone and the footer simply follows it.

     - The screen height is the SMALL viewport (100svh, read from a probe), not
       innerHeight: a phone's toolbar changes innerHeight while you scroll, and
       chasing it would make the page jump under your finger.
     - The scroller is whichever box really scrolls: the document, or the
       creator app's #pane-scroll on layouts that cap the shell. For a box, the
       "screen" is its own client height.
     - It is one read and one write in the same task, so nothing is painted in
       between. Margin is set through CSSOM (the CSP drops style= attributes).
     - This runs under reduced motion too: it is layout, not animation. */
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "fixed"; probe.style.left = "-9999px"; probe.style.top = "0";
  probe.style.width = "1px"; probe.style.height = "100svh"; probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);

  function scrollBoxOf(el) {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;   // the document
  }

  const fits = [];
  function fitFold(foot) {
    if (!foot.isConnected || !foot.getClientRects().length) return;
    foot.style.marginTop = "";                              // back to the stylesheet's own margin
    const base = parseFloat(getComputedStyle(foot).marginTop) || 0;
    /* A FLEX-GROWN SIBLING WOULD HIDE THE SHORTFALL. In the creator app,
       .pane-body is `flex: 1 1 auto` inside a column that is at least one
       screen tall, so with the margin cleared it grows into exactly the space
       being measured and the footer looks like it already sits low enough
       (measured: margin 531px where 735px was needed). For the one read, the
       siblings above stop growing; they are put back before anything paints. */
    const grown = [];
    for (let el = foot.previousElementSibling; el; el = el.previousElementSibling) {
      if (parseFloat(getComputedStyle(el).flexGrow) > 0) { grown.push([el, el.style.flexGrow]); el.style.flexGrow = "0"; }
    }
    const box = scrollBoxOf(foot);
    const r = foot.getBoundingClientRect();
    let naturalTop, screen;
    if (box) {
      const b = box.getBoundingClientRect();
      naturalTop = r.top - b.top - box.clientTop + box.scrollTop;
      screen = box.clientHeight;
    } else {
      naturalTop = r.top + scrollY;
      screen = probe.getBoundingClientRect().height || innerHeight;
    }
    grown.forEach(([el, was]) => { el.style.flexGrow = was; });
    const short = Math.round(screen - naturalTop);
    if (short > 0) foot.style.marginTop = (base + short) + "px";
  }

  let queued = 0;
  const refit = () => {
    if (queued) return;
    queued = requestAnimationFrame(() => { queued = 0; fits.forEach((f) => f()); });
  };
  /* CONTENT CAN CHANGE WITHOUT ANY BOX ABOVE CHANGING SIZE. The creator app's
     .pane-body fills its column, so switching from the library to a short
     brand page swaps its contents while its own height stays put, and a
     ResizeObserver never fires (measured: the footer kept the library's
     margin). So DOM changes above the footer also ask for a refit, throttled
     to one every 150ms because the app repaints parts of itself while a
     script is being written. Attribute changes are not watched, so the
     flex-grow write in fitFold cannot feed back into this. */
  let soon = 0;
  const refitSoon = () => {
    if (soon) return;
    soon = setTimeout(() => { soon = 0; refit(); }, 150);
  };

  document.querySelectorAll("footer").forEach((foot) => {
    const mark = foot.querySelector(".foot-wordmark");
    if (!mark) return;
    fits.push(() => fitFold(foot));
    // Everything above the footer decides where it lands: watch those boxes
    // (the app rebuilds #pane-body, reveals #app, opens cards) and the page
    // width. Not the footer's parent — the margin written here resizes that,
    // which would only re-run this to the same answer.
    const ro = new ResizeObserver(refit);
    const mo = new MutationObserver(refitSoon);
    for (let s = foot.previousElementSibling; s; s = s.previousElementSibling) {
      ro.observe(s);
      mo.observe(s, { childList: true, subtree: true, characterData: true });
    }
    ro.observe(foot);
    wire(foot, mark);
  });
  let lastW = innerWidth;
  addEventListener("resize", () => { if (innerWidth !== lastW) { lastW = innerWidth; refit(); } }, { passive: true });
  addEventListener("orientationchange", refit, { passive: true });
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(refit);
  refit();
})();
