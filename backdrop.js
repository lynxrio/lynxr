/* ---------------------------------------------------------------------------
   THE BACKDROP: six soft blobs, each with a little life of its own.

   Owner, 2026-09-15: "make it still blobs, but have the blobs have some
   variation, also interactive not as in the whole background moves with the
   mouse, but interactive as the shape maybe moves a bit". One fixed, inert
   layer of six blobs is prepended to <body>. Their shapes, colours and
   positions live in app.css (BACKDROP block) and are the --field layers the
   contrast gate measures, so this file must never grow them or move them far.

   What it does:
   - LEAN: only a blob the cursor (or a finger) is near leans toward it, up to
     ~30px, and swells by a few percent. The nearer, the more. The rest stay put.
   - SQUASH: scrolling stretches every blob a touch along the scroll and lets
     it trail a few pixels, then it settles, like jelly.
   On desktop, each blob's slow breathing is plain CSS (.blob-in), not this file.

   Transforms go on .blob through CSSOM, which the CSP allows (a style=
   attribute would be dropped). One requestAnimationFrame loop eases everything
   and stops the moment it settles, so an idle page costs nothing.
   prefers-reduced-motion: the blobs render and never move.

   Deferred, like every script here except theme.js, so <body> exists. */
(() => {
  if (!document.body || document.querySelector(".backdrop")) return;
  const layer = document.createElement("div");
  layer.className = "backdrop";
  layer.setAttribute("aria-hidden", "true");
  const blobs = [];
  for (let i = 1; i <= 6; i++) {
    const el = document.createElement("span");
    el.className = "blob blob-" + i;
    const inner = document.createElement("span");
    inner.className = "blob-in";
    el.appendChild(inner);
    layer.appendChild(el);
    blobs.push({ el, cx: 0, cy: 0, reach: 0, x: 0, y: 0, s: 1 });
  }
  document.body.prepend(layer);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  /* THE WAVE ON HOVER (mouse screens only; touch screens wave every 4s in CSS).
     Owner, 2026-09-15: "for desktop have it wave when i hover over it". The arm
     animation lives in app.css under html.lx-waving. This only keeps that class
     on while the pointer is over a mark or the wordmark, and lets each wave run
     its full 1.1s before stopping or starting the next, so the arm never snaps
     back mid-swing. A timer is used rather than animationend, because some
     browsers never animate SVG mask content and would never fire the event. */
  if (matchMedia("(hover: hover)").matches) {
    const root = document.documentElement;
    const WAVE_MS = 1100;
    let hovering = false, timer = 0;
    const isMark = (el) => !!(el && el.closest && el.closest(".wordmark, .lx, .pane-mark"));
    const wave = () => {
      root.classList.remove("lx-waving");
      void root.offsetWidth;                 // restart the animation from 0
      root.classList.add("lx-waving");
      timer = setTimeout(() => {
        timer = 0;
        if (hovering) wave(); else root.classList.remove("lx-waving");
      }, WAVE_MS);
    };
    document.addEventListener("pointerover", (e) => {
      if (e.pointerType !== "mouse" || !isMark(e.target)) return;
      hovering = true;
      if (!timer) wave();
    }, { passive: true });
    document.addEventListener("pointerout", (e) => {
      if (e.pointerType === "mouse" && isMark(e.target) && !isMark(e.relatedTarget)) hovering = false;
    }, { passive: true });
  }

  const PULL = 30;     // px a blob leans at most
  const SWELL = 0.05;  // how much it grows when you are right on it
  const EASE = 0.08;

  // The untransformed centre and size come from the CSS box, not
  // getBoundingClientRect(), which would include the lean itself.
  const measure = () => {
    for (const b of blobs) {
      const cs = getComputedStyle(b.el);
      b.cx = parseFloat(cs.left);
      b.cy = parseFloat(cs.top);
      b.reach = Math.max(parseFloat(cs.width), parseFloat(cs.height)) * 0.62;
      b.hidden = cs.display === "none";
    }
  };
  measure();
  addEventListener("resize", measure, { passive: true });

  let px = null, py = null;   // pointer, viewport px; null when there is none
  let vel = 0;                // smoothed scroll speed, px per event
  const lastTop = new Map();  // per scroller: the creator app scrolls .pane-scroll
  let raf = 0;

  const tick = () => {
    vel *= 0.88;
    const sq = Math.max(-1, Math.min(1, vel / 36));
    let busy = Math.abs(vel) > 0.3;
    for (const b of blobs) {
      if (b.hidden) continue;
      let tx = 0, ty = 0, ts = 1;
      if (px !== null) {
        const dx = px - b.cx, dy = py - b.cy, d = Math.hypot(dx, dy);
        if (d < b.reach) {
          const k = (1 - d / b.reach) ** 2;
          tx = (dx / (d || 1)) * PULL * k;
          ty = (dy / (d || 1)) * PULL * k;
          ts = 1 + SWELL * k;
        }
      }
      b.x += (tx - b.x) * EASE;
      b.y += (ty - b.y) * EASE;
      b.s += (ts - b.s) * EASE;
      if (Math.abs(tx - b.x) + Math.abs(ty - b.y) + Math.abs(ts - b.s) * 100 > 0.08) busy = true;
      const sx = b.s * (1 - sq * 0.03), sy = b.s * (1 + sq * 0.05);
      b.el.style.transform =
        `translate(${b.x.toFixed(2)}px, ${(b.y - sq * 12).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    }
    raf = busy ? requestAnimationFrame(tick) : 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    px = e.clientX; py = e.clientY; kick();
  }, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => { px = py = null; kick(); });

  const onTouch = (e) => {
    const t = e.touches && e.touches[0];
    if (t) { px = t.clientX; py = t.clientY; kick(); }
  };
  addEventListener("touchstart", onTouch, { passive: true });
  addEventListener("touchmove", onTouch, { passive: true });
  addEventListener("touchend", () => { setTimeout(() => { px = py = null; kick(); }, 350); }, { passive: true });

  // Capture phase: element scroll events do not bubble.
  addEventListener("scroll", (e) => {
    const t = e.target && e.target.nodeType === 1 ? e.target : document;
    const top = t === document ? scrollY : t.scrollTop;
    const prev = lastTop.get(t);
    lastTop.set(t, top);
    if (prev === undefined) return;
    vel = Math.max(-72, Math.min(72, vel * 0.5 + (top - prev)));
    kick();
  }, { passive: true, capture: true });
})();
