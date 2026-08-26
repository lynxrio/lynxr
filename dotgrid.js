/* lynxr — the pointer-reactive dot lattice, shared by every page.
   Lives in one file because all three surfaces want it: the public homepage,
   the creator app and the agency app. It used to be duplicated in app.js and
   creator.js, which meant a third copy every time a page was added.

   The canvas draws the WHOLE grid — exactly one set of dots, aligned with the
   CSS lattice in app.css that it replaces — and swells the ones nearest the
   cursor. Mouse only; touch and prefers-reduced-motion keep the static CSS
   grid and this never runs.

   It sizes itself through the width/height ATTRIBUTES, never inline styles:
   the strict CSP discards those, and .dot-fx already spans the viewport via
   the stylesheet. */
(function initDotGrid() {
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!fine || still) return;

  const GAP = 34;      // matches the CSS lattice spacing
  const REACH = 78;    // px of influence around the cursor
  const DOT_R = 1.3;   // resting radius, matches the CSS lattice
  const DOT_A = 0.06;  // resting alpha; the COLOUR comes from --dot-rgb, see readDot()

  const canvas = document.createElement("canvas");
  canvas.className = "dot-fx";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  document.body.classList.add("dots-live");   // retires the CSS lattice

  const ctx = canvas.getContext("2d");

  /* The one colour in this file, and it is not a literal: --dot-rgb is
     declared in app.css (`255, 255, 255` dark, `25, 24, 19` light) so the
     canvas lattice and the CSS lattice in `body::before` can never disagree
     about what a dot is. Read from documentElement because that is where the
     theme attribute lives and where :root's custom properties resolve. */
  let dotRgb = "255,255,255";
  const readDot = () => {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--dot-rgb").trim();
    if (v) dotRgb = v;
  };
  readDot();
  let viewW = 0, viewH = 0, dpr = 1, px = -9999, py = -9999, queued = false;

  // Drawn in device pixels and snapped to the device grid, so the dots stay
  // razor-sharp at any zoom or display density.
  const draw = () => {
    queued = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const half = GAP / 2;
    for (let x = half; x < viewW + half; x += GAP) {
      for (let y = half; y < viewH + half; y += GAP) {
        const d = Math.hypot(x - px, y - py);
        let r = DOT_R, a = DOT_A;
        if (d < REACH) {
          const ease = (1 - d / REACH) ** 2;   // 0 at the edge, 1 under the cursor
          r = DOT_R + ease * 1.8;
          a = DOT_A + ease * 0.30;
        }
        ctx.beginPath();
        ctx.arc(Math.round(x * dpr), Math.round(y * dpr), r * dpr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${dotRgb},${a.toFixed(3)})`;
        ctx.fill();
      }
    }
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };

  const sizeCanvas = () => {
    // Follow the real pixel ratio (browser zoom changes it) so the canvas
    // never renders below the display's resolution.
    dpr = Math.min(window.devicePixelRatio || 1, 4);
    viewW = document.documentElement.clientWidth || window.innerWidth;
    viewH = document.documentElement.clientHeight || window.innerHeight;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    draw();
  };
  // Zoom changes devicePixelRatio without always firing resize.
  const watchDpr = () => {
    window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      .addEventListener("change", () => { sizeCanvas(); watchDpr(); }, { once: true });
  };

  sizeCanvas();
  watchDpr();
  window.addEventListener("resize", sizeCanvas);
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    px = e.clientX; py = e.clientY;
    queue();
  }, { passive: true });

  // Pointer gone: settle every dot back to its resting size.
  const rest = () => { px = -9999; py = -9999; queue(); };
  document.addEventListener("pointerleave", rest);
  window.addEventListener("blur", rest);

  /* The theme can flip while the page is open — the Settings control does it
     live, without a reload. A canvas keeps whatever was last painted into it,
     so without this the old dots would sit there permanently: white dots
     invisible on paper, and the swell under the cursor drawing in the wrong
     ink. An attribute observer rather than a custom event keeps this file
     independent of creator.js, which is the whole reason it is shared. */
  new MutationObserver(() => { readDot(); draw(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
