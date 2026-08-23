/* ---------------------------------------------------------------------------
   THE SPLIT-FLAP WORDMARK — shared by all three surfaces (the public pages,
   the creator app, the agency app). Self-initialising and self-contained: it
   does nothing unless it finds #foot-wordmark and #site-footer, and exports
   nothing, so a page that doesn't have a footer pays nothing for loading
   this file, and no app ever needs to call in.

   Lifted out of app.js's old initFooter() — the wordmark half of that
   function touched no app state (no fmt(), no activateTab(), no rows), so it
   lifts out cleanly. app.js keeps #foot-count and the .foot-link[data-tab]
   wiring, which are agency-only concerns. */
(() => {
  const mark = document.getElementById("foot-wordmark");
  const foot = document.getElementById("site-footer");
  if (!mark || !foot) return;

  // Slot-machine wordmark: each character spins through random glyphs and
  // locks in left-to-right as the footer scrolls into view. At the bottom of
  // the page every slot has stopped on its letter: l y n x r .
  const FINAL = mark.textContent.trim() || "lynxr.";
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
})();
