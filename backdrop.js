/* ---------------------------------------------------------------------------
   THE BACKDROP: six soft blobs that answer the mouse on desktop and the scroll
   on phones.

   Owner, 2026-09-15: "make it still blobs, but have the blobs have some
   variation, also interactive not as in the whole background moves with the
   mouse", then "make the background interactive with the mouse on desktop and
   scroll for mobile". One fixed, inert layer of six blobs is prepended to
   <body>. Their shapes, colours and positions live in app.css (BACKDROP block).

   MOUSE SCREENS (hover: hover): THE CURSOR SHOVES THE COLOUR ABOUT. Owner,
   2026-09-25: "instead of the highlight, have it move the colors around like
   squish them confined to the border of the window size and then its like the
   mouse moves the colors around". So the white cursor light is gone — the
   .spot element and its CSS with it — and the old pull TOWARD the cursor is
   now a push AWAY from it, on a spring:
   - PUSH, 140px, is what a blob the cursor is sitting on top of is shoved by,
     falling off as a smoothstep over the blob's reach. Near blobs move a lot
     (measured 85-100px), far ones a few, so the background never slides as one
     sheet — which is the thing the owner ruled out on 2026-09-15.
   - SMEAR, 60px, drags whatever a fast sweep passes along the sweep's own
     direction. Without it a repulsion field reads as a force field; with it,
     it reads as moving the colour.
   - APART: no two blobs may close nearer than their RESTING gap. Only the
     deficit is resisted, so at rest the force is exactly zero and the layout
     the contrast gate measured is untouched. This is the whole contrast
     argument, and it is why the push may be twice what the pull could be.
   - KEEP, 60px, is how near a window edge a blob's CENTRE may come, written
     from each rest centre outwards so a blob the CSS parks near an edge is
     never yanked off it. What the wall refuses becomes SQUASH: leaned on with
     PRESS (70px) of unspent shove, a blob goes 12% flatter across that wall
     and 6.6% taller along it. Never bigger on both axes, so a press can only
     move paint, never add it.
   - SPRING/DAMP carry all of it: ~0.2s to arrive with ~6% of overshoot, ~0.6s
     to settle back when the cursor leaves. Scrolling still adds a jelly squash.

   TOUCH SCREENS (hover: none): scrolling swirls the blobs. The whole group
   turns slowly around the middle of the screen and spreads outward, up to 12%,
   as you scroll, with the same jelly squash on every flick. UNCHANGED by the
   2026-09-25 rewrite, and verified so: same real scroll gesture at 393x852,
   old code and new, every blob's matrix equal to within 0.01px.

   THESE LIMITS ARE CONTRAST LIMITS. Text sits on this page, and blobs that
   drift into each other darken the ground under it. The bound is the rebrand
   gate's light-theme one: ground luminance >= .6705, which is what --good
   (#146b3e) needs for 4.5:1.

   MEASURED 2026-09-25, and not by a model this time: headless Brave over CDP,
   real Input.dispatchMouseEvent, the page's own content hidden so the shot IS
   the ground, and the relative luminance of every painted pixel. 49 settled
   cursor parks on a grid including all four corners, plus ~900 screencast
   frames taken DURING real drags along each edge, fast sweeps across the
   middle both ways, both diagonals and a four-corner slam.
   - 1280x800: rest floor .6918, worst over everything .6902 (mid-drag down the
     right edge). The motion costs .0016 and clears the bound by .0197.
   - 1440x900, 1024x768, 800x700: worst .6918 — the motion costs nothing
     measurable; every pose and frame sits on the rest floor.
   - 1920x1080: worst .6852, which IS that size's rest floor (the blobs are
     sized in vw, so they overlap more on a wide screen). Motion cost: none.
   - Dark, informational (theme.js only ever paints light): worst luminance
     .0332 at 1440x900 and .0328 at 1280x800, against the .0503 dark bound.
   For contrast, the code this replaced — a 60px pull TOWARD the cursor — was
   re-measured through the same harness at .6879, i.e. it cost .0039, twice
   what this does while moving blobs half as far. Pushing apart, and refusing
   to let two blobs crowd, is what buys the bigger motion. That is also why the
   2026-09-15 attempt failed: stretching a blob toward the cursor (12%) hit
   .6617, and the white light was the workaround. It is not needed now.
   Don't raise PUSH or SMEAR, don't drop APART, and don't give phone blobs
   individual moves, without re-running that measurement.

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
    blobs.push({ el, cx: 0, cy: 0, reach: 0, rest: [], x: 0, y: 0, vx: 0, vy: 0, gx: 0, gy: 0, pw: 0, ph: 0, s: 1 });
  }
  document.body.prepend(layer);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const mouseScreen = matchMedia("(hover: hover) and (pointer: fine)");
  const PUSH = 140;      // px, desktop: how far the cursor shoves a blob it is sitting on
  const SMEAR = 60;      // px, desktop: the extra shove a fast sweep drags a blob along by
  const SPRING = 0.04;   // desktop: share of the gap to the target taken as acceleration each frame
  const DAMP = 0.78;     // desktop: share of velocity kept each frame
  const KEEP = 60;       // px, desktop: how near the window edge a blob's centre may come
  const APART = 0.6;     // desktop: how firmly two blobs refuse to close in on their rest gap
  const PRESS = 70;      // px, desktop: shove refused by a wall that counts as leaning on it with all your weight
  const SQUASH = 0.12;   // desktop: shrink across a wall a blob is pressed into
  const BULGE = 0.55;    // desktop: share of that squash handed back on the other axis
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
      // The box a centre may sit in. Written from the rest centre outwards, so
      // a blob whose CSS parks it near (or past) an edge is never yanked off it.
      b.loX = Math.min(b.cx, KEEP); b.hiX = Math.max(b.cx, vw - KEEP);
      b.loY = Math.min(b.cy, KEEP); b.hiY = Math.max(b.cy, vh - KEEP);
    }
    // Rest gaps: the separation force only ever resists closing BELOW these.
    for (let i = 0; i < blobs.length; i++)
      for (let j = 0; j < blobs.length; j++)
        blobs[i].rest[j] = Math.hypot(blobs[i].cx - blobs[j].cx, blobs[i].cy - blobs[j].cy);
    kick();
  };

  let px = null, py = null;   // cursor, viewport px; null when there is none
  let pvx = 0, pvy = 0;       // smoothed pointer velocity, px per frame
  let lastX = 0, lastY = 0;
  let vel = 0;                // smoothed scroll speed, px per event
  let top = 0;                // how far the active scroller has scrolled
  let ang = 0, spread = 0;    // eased swirl state (phones)
  const lastTop = new Map();  // per scroller: the creator app scrolls .pane-scroll
  let raf = 0;

  const tick = () => {
    vel *= 0.88;
    pvx *= 0.82; pvy *= 0.82;
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

    if (mouse) {
      if (Math.abs(pvx) + Math.abs(pvy) > 0.2) busy = true;
      for (const b of blobs) { b.gx = b.cx + b.x; b.gy = b.cy + b.y; }
    }

    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      if (b.hidden) continue;
      let tx = 0, ty = 0;
      if (mouse) {
        if (px !== null) {
          // The cursor shoves the blob AWAY from itself, hardest when it is on
          // top of the centre, and drags it along the way the cursor is moving.
          const dx = b.gx - px, dy = b.gy - py, d = Math.hypot(dx, dy);
          if (d < b.reach) {
            const q = 1 - d / b.reach, k = q * q * (3 - 2 * q);   // smoothstep: near blobs move a lot, far ones barely
            tx = (dx / (d || 1)) * PUSH * k + Math.max(-SMEAR, Math.min(SMEAR, pvx * 1.6)) * k;
            ty = (dy / (d || 1)) * PUSH * k + Math.max(-SMEAR, Math.min(SMEAR, pvy * 1.6)) * k;
          }
        }
        // Nothing may crowd closer than the resting layout: that is the whole
        // contrast argument. Only the deficit is resisted, so at rest this is 0.
        for (let j = 0; j < blobs.length; j++) {
          if (j === i || blobs[j].hidden) continue;
          const o = blobs[j];
          const dx = b.gx - o.gx, dy = b.gy - o.gy, d = Math.hypot(dx, dy) || 1;
          const deficit = b.rest[j] - d;
          if (deficit > 0) { tx += (dx / d) * APART * deficit; ty += (dy / d) * APART * deficit; }
        }
        // Confined to the window: what the walls refuse becomes the squash.
        const wx = b.cx + tx, wy = b.cy + ty;
        let overX = 0, overY = 0;
        if (wx < b.loX) overX = b.loX - wx; else if (wx > b.hiX) overX = b.hiX - wx;
        if (wy < b.loY) overY = b.loY - wy; else if (wy > b.hiY) overY = b.hiY - wy;
        tx += overX; ty += overY;
        const pwT = Math.min(1, Math.abs(overX) / PRESS), phT = Math.min(1, Math.abs(overY) / PRESS);
        b.pw += (pwT - b.pw) * 0.16; b.ph += (phT - b.ph) * 0.16;
        if (Math.abs(pwT - b.pw) + Math.abs(phT - b.ph) > 0.002) busy = true;
      } else {
        // rigid turn about the screen centre, plus an outward spread
        const rx = b.cx - mx, ry = b.cy - my;
        tx = mx + grow * (rx * cos - ry * sin) - b.cx;
        ty = my + grow * (rx * sin + ry * cos) - b.cy;
      }
      if (mouse) {
        b.vx = (b.vx + (tx - b.x) * SPRING) * DAMP;
        b.vy = (b.vy + (ty - b.y) * SPRING) * DAMP;
        b.x += b.vx; b.y += b.vy;
        // The spring may overshoot the wall by a few px: absorb it, do not bounce.
        const gx = b.cx + b.x, gy = b.cy + b.y;
        if (gx < b.loX) { b.x += b.loX - gx; if (b.vx < 0) b.vx = 0; }
        else if (gx > b.hiX) { b.x += b.hiX - gx; if (b.vx > 0) b.vx = 0; }
        if (gy < b.loY) { b.y += b.loY - gy; if (b.vy < 0) b.vy = 0; }
        else if (gy > b.hiY) { b.y += b.hiY - gy; if (b.vy > 0) b.vy = 0; }
        if (Math.abs(tx - b.x) + Math.abs(ty - b.y) > 0.08 || Math.abs(b.vx) + Math.abs(b.vy) > 0.04) busy = true;
      } else {
        b.x = tx; b.y = ty;       // the swirl state is already eased above, and must stay rigid
        b.pw = b.ph = 0;
      }
      b.s += (1 - b.s) * EASE;
      // Squashed across the wall it leans on, a little taller for it — never
      // bigger on both axes, so a press can only ever move paint, not add it.
      const kx = 1 - SQUASH * b.pw + SQUASH * BULGE * b.ph;
      const ky = 1 - SQUASH * b.ph + SQUASH * BULGE * b.pw;
      const sx = b.s * kx * (1 - sq * 0.03), sy = b.s * ky * (1 + sq * 0.05);
      b.el.style.transform =
        `translate(${b.x.toFixed(2)}px, ${(b.y - sq * 8).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    }
    raf = busy ? requestAnimationFrame(tick) : 0;
  };
  function kick() { if (!raf) raf = requestAnimationFrame(tick); }

  measure();
  addEventListener("resize", measure, { passive: true });
  mouseScreen.addEventListener?.("change", measure);

  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    if (px !== null) { pvx = pvx * 0.4 + (e.clientX - lastX) * 0.6; pvy = pvy * 0.4 + (e.clientY - lastY) * 0.6; }
    px = lastX = e.clientX; py = lastY = e.clientY;
    kick();
  }, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => { px = py = null; pvx = pvy = 0; kick(); });

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
