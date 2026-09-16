/* ---------------------------------------------------------------------------
   THE BACKDROP: six soft blobs that answer the mouse on desktop and the scroll
   on phones.

   Owner, 2026-09-15: "make it still blobs, but have the blobs have some
   variation, also interactive not as in the whole background moves with the
   mouse", then "make the background interactive with the mouse on desktop and
   scroll for mobile". One fixed, inert layer of six blobs is prepended to
   <body>. Their shapes, colours and positions live in app.css (BACKDROP block).

   MOUSE SCREENS (hover: hover): each blob is pulled toward the cursor, up to
   60px, by how close the cursor is to it, and the nearest ones swell by a few
   percent. Near blobs move a lot and far ones barely move, so the background
   never slides as one sheet. A soft white light also follows the cursor
   (owner, 2026-09-15, again: "back the background interactive with the mouse
   for desktop" — the 70px pull alone measured as ~40px on a 700px blob, too
   little to notice). Scrolling adds a small jelly squash.

   TOUCH SCREENS (hover: none): scrolling swirls the blobs. The whole group
   turns slowly around the middle of the screen and spreads outward, up to 12%,
   as you scroll, with the same jelly squash on every flick.

   THESE LIMITS ARE CONTRAST LIMITS. Text sits on this page, and blobs that
   drift into each other darken the ground under it. Measured 2026-09-15 with
   the rebrand gate's light-theme bound (ground luminance >= .6705):
   - Desktop: random 70px pulls on all six blobs plus the swell leave the
     worst point at .6809. Around 80px they would reach the bound. Stretching
     a blob toward the cursor was tried and FAILED (12% stretch: .6617), so
     visibility comes from the light instead: white over this light ground
     can only raise luminance, so it can never cost contrast.
   - Phones: the swirl is a rigid turn plus an outward spread, so no two blobs
     ever get closer than at rest. Its worst point is .6745 over a full turn.
     Moving phone blobs independently, even by 30px, failed (.6328), which is
     why phones swirl instead of lean.
   Don't raise PULL or SPREAD, and don't give phone blobs individual moves,
   without re-running that measurement.

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
  const spot = document.createElement("span");   // the cursor light (mouse screens)
  spot.className = "spot";
  layer.appendChild(spot);
  document.body.prepend(layer);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const mouseScreen = matchMedia("(hover: hover) and (pointer: fine)");
  const PULL = 60;       // px, desktop: how far a blob is drawn to the cursor at most
  const SWELL = 0.05;    // desktop: growth when the cursor is right on a blob
  const TURN = 0.055;    // degrees per px scrolled, phones: 1000px of scroll turns the group 55deg
  const SPREAD = 0.12;   // phones: how far the group spreads outward at most
  const EASE = 0.08;

  // The untransformed centre and size come from the CSS box, not
  // getBoundingClientRect(), which would include the motion itself.
  let vw = innerWidth, vh = innerHeight;
  const measure = () => {
    vw = innerWidth; vh = innerHeight;
    for (const b of blobs) {
      const cs = getComputedStyle(b.el);
      b.cx = parseFloat(cs.left);
      b.cy = parseFloat(cs.top);
      b.reach = Math.max(Math.max(parseFloat(cs.width), parseFloat(cs.height)) * 1.1, 900);
      b.hidden = cs.display === "none";
    }
    kick();
  };

  let px = null, py = null;   // cursor, viewport px; null when there is none
  let lx = -9999, ly = -9999; // eased light position
  let vel = 0;                // smoothed scroll speed, px per event
  let top = 0;                // how far the active scroller has scrolled
  let ang = 0, spread = 0;    // eased swirl state (phones)
  const lastTop = new Map();  // per scroller: the creator app scrolls .pane-scroll
  let raf = 0;

  const tick = () => {
    vel *= 0.88;
    const sq = Math.max(-1, Math.min(1, vel / 36));
    let busy = Math.abs(vel) > 0.3;
    const mouse = mouseScreen.matches;

    // phones: the target swirl for the current scroll position
    const angT = mouse ? 0 : top * TURN * Math.PI / 180;
    const spreadT = mouse ? 0 : SPREAD * Math.abs(Math.sin(top / 900));
    ang += (angT - ang) * EASE;
    spread += (spreadT - spread) * EASE;
    if (Math.abs(angT - ang) > 0.0005 || Math.abs(spreadT - spread) > 0.0005) busy = true;
    const cos = Math.cos(ang), sin = Math.sin(ang), grow = 1 + spread, mx = vw / 2, my = vh / 2;

    for (const b of blobs) {
      if (b.hidden) continue;
      let tx = 0, ty = 0, ts = 1;
      if (mouse) {
        if (px !== null) {
          const dx = px - b.cx, dy = py - b.cy, d = Math.hypot(dx, dy);
          if (d < b.reach) {
            const k = 1 - d / b.reach;
            tx = (dx / (d || 1)) * PULL * k;
            ty = (dy / (d || 1)) * PULL * k;
            ts = 1 + SWELL * k;
          }
        }
      } else {
        // rigid turn about the screen centre, plus an outward spread
        const rx = b.cx - mx, ry = b.cy - my;
        tx = mx + grow * (rx * cos - ry * sin) - b.cx;
        ty = my + grow * (rx * sin + ry * cos) - b.cy;
      }
      if (mouse) {
        b.x += (tx - b.x) * 0.12;
        b.y += (ty - b.y) * 0.12;
      } else {
        b.x = tx; b.y = ty;       // the swirl state is already eased above, and must stay rigid
      }
      b.s += (ts - b.s) * EASE;
      if (Math.abs(tx - b.x) + Math.abs(ty - b.y) + Math.abs(ts - b.s) * 100 > 0.08) busy = true;
      const sx = b.s * (1 - sq * 0.03), sy = b.s * (1 + sq * 0.05);
      b.el.style.transform =
        `translate(${b.x.toFixed(2)}px, ${(b.y - sq * 8).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    }
    if (mouse && px !== null) {
      if (lx < -9000) { lx = px; ly = py; }
      lx += (px - lx) * 0.18; ly += (py - ly) * 0.18;
      spot.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`;
      if (Math.abs(px - lx) + Math.abs(py - ly) > 0.5) busy = true;
    }
    raf = busy ? requestAnimationFrame(tick) : 0;
  };
  function kick() { if (!raf) raf = requestAnimationFrame(tick); }

  measure();
  addEventListener("resize", measure, { passive: true });
  mouseScreen.addEventListener?.("change", measure);

  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    px = e.clientX; py = e.clientY;
    if (mouseScreen.matches) layer.classList.add("has-spot");
    kick();
  }, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => { px = py = null; layer.classList.remove("has-spot"); kick(); });

  // Capture phase: element scroll events do not bubble.
  addEventListener("scroll", (e) => {
    const t = e.target && e.target.nodeType === 1 ? e.target : document;
    const now = t === document ? scrollY : t.scrollTop;
    const prev = lastTop.get(t);
    lastTop.set(t, now);
    top = Math.max(0, now);
    if (prev === undefined) { kick(); return; }
    vel = Math.max(-72, Math.min(72, vel * 0.5 + (now - prev)));
    kick();
  }, { passive: true, capture: true });
})();
