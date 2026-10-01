/* ---------------------------------------------------------------------------
   THE BACKDROP: six soft blobs that live behind every page — they breathe,
   notice you, answer the mouse on desktop and the scroll on phones.

   Owner, 2026-09-15: "make it still blobs, but have the blobs have some
   variation, also interactive not as in the whole background moves with the
   mouse", then "make the background interactive with the mouse on desktop and
   scroll for mobile". One fixed, inert layer of six blobs is prepended to
   <body>. Their shapes, colours and positions live in app.css (BACKDROP block).

   Owner, 2026-09-28: "have it feel almost alive for all views, as if lynxr is
   alive like he is the content creation buddy for you". So the blobs
   live, calmly, in every view:
   - BREATH. Each blob slowly draws in and lets go on its own clock (the --t
     column of the CSS table x 0.4: 6.8-11.6s), each axis on its own phase so
     the shape turns over as it breathes. At most 3% in, never past its own
     size, so a breath can only lighten the ground. This replaces the CSS
     breathing, which grew a blob 4% on one axis.
   - SWAY (desktop and tablet): each blob wanders round its rest point on two
     slow sines an axis (periods 31-52s), 6-14px (2% of its box), under 3px a
     second. Phones don't sway: their layout clears the contrast bound by only
     .0018 at 430x932, so on a phone the blobs only breathe.
   - NOTICE. The first input after 6s of quiet (a mouse move, a scroll, a
     key, a tap, coming back to the window) is noticed: one extra 2.5% draw-in
     that runs through the blobs nearest-first, peaking 0.27s later, gone in
     about 1.5s. A draw-in, never a move: the background never shifts as a
     whole (ruled out on 2026-09-15).
   - RIPPLE. A click or tap nudges nearby blobs straight away from it (at
     most 16px, zero at a blob's own centre) and they drift home. One push,
     never a pull: nothing ever turns toward the cursor.
   - HUSH. While you type (any input event) the breath and sway fade out in
     about a second and come back 2.5s after the last keystroke. The same
     behind any open dialog ([aria-modal="true"]) and while another window is
     in front. A hidden tab runs nothing at all.
   Measured 2026-09-28: idle, the most any blob strays is 12.6px, at 2.4px a
   second; 2.5s into typing, and 4s behind a dialog, nothing draws in by more
   than .3% or moves faster than .1px a second. While only life moves, the
   loop draws 20 frames a second. Headless Brave put that at about 20ms of
   main-thread time a second (the agency app's Database page: 1.6 -> 21.0),
   with scrolling as smooth as before (p95 frame 16.7-16.8ms, none > 25ms).

   MOUSE SCREENS (hover: hover): THE CURSOR STIRS THE COLOUR. Owner,
   2026-09-28: "it looks like the bubbles rotate around the mouse some times,
   have the whole thing just be smoother and interactive background". The
   2026-09-25 design pushed each blob AWAY from the cursor, and it orbited.
   Measured in headless Brave with real mouse input, and reproduced to within
   0.1-2.7px (parks, jumps, circles) by an offline copy of its tick(). The
   push was aimed from the blob's own displaced position, so a sideways step
   turned the push with it. With the cursor parked on a blob's rest centre
   there was no sideways restoring force at all: a ring of equilibria about
   132px out. At 50px off centre the force was 28% of normal. Neighbour
   shoves (APART), the SMEAR leftovers and an under-damped spring (6%
   overshoot) then carried blobs around the cursor. A slow straight drift
   swung blob 6 half way round the passing cursor (186deg), it kept turning
   54deg round a stopped cursor after a small circle, and a jump onto it
   swung it 18% past its mark (blob 4: 97%). Aiming from the rest centre
   instead only moves the problem: the direction flips as the cursor crosses
   the centre. So there is no push any more:
   - STIR. Every px the cursor travels carries each blob GAIN px the same
     way, weighted by a Gaussian of the cursor's distance from that blob's
     REST centre (sigma = half the blob's box, never under 240px). Near blobs
     move most and far ones barely, so the background never slides as one
     sheet (ruled out on 2026-09-15). The carry points the way the hand went,
     never toward or away from the cursor, so nothing has a reason to circle.
   - RETURN. The carry fades home with a 0.8s time constant, so the colour
     drifts back within about 3s of the mouse stopping. It retracts along a
     straight line, because every blob's carry shrinks by the same factor
     each frame and a still cursor adds nothing. Only a wall or APART holding
     one axis bends it: measured, at most 6px sideways.
   - MAX, 90px, soft (tanh), is the most any blob is carried. A fast sweep
     lands near it; a slow drift carries a blob 20-50px.
   - APART: no two blobs may close nearer than their RESTING gap. Only the
     deficit is split between the pair, along their centre line, and it acts
     on the targets, not the moving blobs, so it can't feed back. At rest it
     is exactly zero, so the layout the contrast gate measured is untouched.
     The wander, the ripple and the phone swirl all go through it too.
   - KEEP, 60px, is how near a window edge a blob's centre may come, written
     from each rest centre outwards so a blob the CSS parks near an edge is
     never yanked off it. What the wall refuses becomes SQUASH: leaned on with
     PRESS (70px) of unspent carry, a blob goes 12% flatter across that wall
     and 6.6% taller along it. Never bigger on both axes, so a press can only
     move paint, never add it.
   - SMOOTH: two first-order lags of 0.06s in series, which is a critically
     damped follower: 50% of a step in 0.10s, 90% in 0.23s, and no overshoot.
     Its impulse response is never negative, so a blob never passes a target
     it was heading for and never leaves the box its targets stayed in.
   All of it runs on elapsed time, not frames, so a 120Hz display moves
   exactly like a 60Hz one. Scrolling still adds the jelly squash, unchanged.

   TOUCH SCREENS (hover: none): scrolling swirls the blobs. The whole group
   turns slowly around the middle of the screen and spreads outward, up to 12%,
   as you scroll, with the same jelly squash on every flick. The swirl is the
   2026-09-15 one, now timed in seconds (0.2s ease, the old 0.08 a frame at
   60Hz), and it is rigid, so it has nothing to orbit. On top of it the blobs
   breathe, notice you and ripple from a tap, like the desktop, and on a
   tablet (wider than 760px) they sway too.

   THESE LIMITS ARE CONTRAST LIMITS. Text sits on this page, and blobs that
   drift into each other darken the ground under it. The bound is the rebrand
   gate's light-theme one: ground luminance >= .6705, which is what --good
   (#146b3e) needs for 4.5:1. Life is built so it can only lighten: a breath,
   a notice and a squash never make a blob bigger on both axes, and every
   move goes through APART.

   MEASURED 2026-09-28: headless Brave over CDP, real input only, the page's
   own content hidden so the shot IS the ground, and the relative luminance
   of every painted pixel. Desktop: 49 parks on a 7x7 grid including the
   corners, screencast frames DURING real drags along each edge, fast sweeps
   both ways, both diagonals and a four-corner slam, and 80 shots over two
   minutes of idle life. Touch views: the whole scroll range, 12 taps with
   shots during each ripple, and 60 shots over 90s of idle life. Worst over
   everything, with the 2026-09-25 code's worst in brackets:
   - 1280x800 .6918 (.6918), 1440x900 .6918 (.6918), 1920x1080 .6852
     (.6852). The stir alone once took one 1440 drag frame to .6902.
   - tablets: 820x1180 .6990 (.6918), 1180x820 .6924 (.6918).
   - phones: 375x812 .6788, 390x844 .6785, 393x852 .6739, 430x932 .6723,
     each the same as before: a phone blob only draws in, and a tap's ripple
     goes through APART. 430x932 is the tightest place on the site, +.0018
     over the bound, at rest.
   Don't raise GAIN, MAX, WANDER or RIPPLE, don't let a breath grow a blob,
   and don't drop APART, without re-running that measurement.

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
    blobs.push({ el, i: i - 1, cx: 0, cy: 0, sig: 1, rest: [], ux: 0, uy: 0, ex: 0, ey: 0, ax: 0, ay: 0, x: 0, y: 0, pw: 0, ph: 0 });
  }
  document.body.prepend(layer);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const mouseScreen = matchMedia("(hover: hover) and (pointer: fine)");
  // the stir (mouse screens)
  const GAIN = 0.6;      // px a blob is carried per px the cursor travels right over its rest centre
  const RETURN = 0.8;    // s: time constant of the colour drifting home once the mouse stops
  const SMOOTH = 0.06;   // s: each of the two lags in series (critically damped: no overshoot)
  const MAX = 90;        // px: the most any blob is carried (soft limit)
  const STEP = 120;      // px: one pointer event counts for at most this much travel
  const KEEP = 60;       // px: how near the window edge a blob's centre may come
  const PRESS = 70;      // px: carry refused by a wall that counts as leaning on it with all your weight
  const LEAN = 0.096;    // s: how fast a wall squash comes and goes
  const SQUASH = 0.12;   // shrink across a wall a blob is pressed into
  const BULGE = 0.55;    // share of that squash handed back on the other axis
  // life (every view)
  const BREATH = 0.03;   // the most a blob draws in at the bottom of a breath; it never grows past its size
  const WANDER = 0.02;   // how far a blob sways, as a share of its box (6-14px); 0 on phones, see below
  const RIPPLE = 16;     // px: the most a click or tap pushes a blob
  const NOTICE = 0.025;  // extra draw-in when lynxr notices you
  const QUIET = 6;       // s without input after which the next input is noticed
  const HUSH = 2.5;      // s after the last keystroke before life comes back
  const IDLE_FPS = 20;   // frames a second while only life is moving (it moves under 3px a second)
  // phones and tablets (hover: none)
  const TURN = 0.055;    // degrees per px scrolled: 1000px of scroll turns the group 55deg
  const SPREAD = 0.12;   // how far the group spreads outward at most
  const EASE = 0.2;      // s: the swirl's ease (0.08 a frame at 60Hz)
  const SETTLE = 0.13;   // s: how fast the scroll squash dies away (0.88 a frame at 60Hz)

  // The untransformed centre and size come from the CSS box, not
  // getBoundingClientRect(), which would include the motion itself.
  let vw = innerWidth, vh = innerHeight, off = false, phone = false;
  const measure = () => {
    vw = innerWidth; vh = innerHeight;
    off = getComputedStyle(layer).display === "none";   // print, reduced transparency
    phone = vw <= 760;                                    // the phone layout in app.css
    for (const b of blobs) {
      const cs = getComputedStyle(b.el);
      b.cx = parseFloat(cs.left);
      b.cy = parseFloat(cs.top);
      const size = Math.max(parseFloat(cs.width), parseFloat(cs.height));
      b.sig = Math.max(size * 0.5, 240);
      b.hidden = cs.display === "none";
      // Each blob keeps its own time: the breath column of the CSS table (--t) sets its period.
      b.period = (parseFloat(cs.getPropertyValue("--t")) || 22) * 0.4;
      b.sway = phone || !WANDER ? 0 : Math.min(14, Math.max(6, size * WANDER));
      // The box a centre may sit in. Written from the rest centre outwards, so
      // a blob whose CSS parks it near (or past) an edge is never yanked off it.
      b.loX = Math.min(b.cx, KEEP); b.hiX = Math.max(b.cx, vw - KEEP);
      b.loY = Math.min(b.cy, KEEP); b.hiY = Math.max(b.cy, vh - KEEP);
    }
    // Rest gaps: the separation only ever resists closing BELOW these.
    for (let i = 0; i < blobs.length; i++)
      for (let j = 0; j < blobs.length; j++)
        blobs[i].rest[j] = Math.hypot(blobs[i].cx - blobs[j].cx, blobs[i].cy - blobs[j].cy);
    kick();
  };

  let lx = null, ly = null;   // last cursor position, viewport px; null when there is none
  let vel = 0;                // smoothed scroll speed, px per event
  let top = 0;                // how far the active scroller has scrolled
  let ang = 0, spread = 0;    // eased swirl state (touch screens)
  const lastTop = new Map();  // per scroller: the creator app scrolls .pane-scroll
  let raf = 0, lastT = 0;
  let clock = 0;              // s of life lived; stands still while the tab is hidden
  let life = 0;               // 0 = still, 1 = fully alive; fades in on load
  let hushUntil = 0, modal = false, modalAt = -1, modalTimer = 0, away = !document.hasFocus();
  let lastInput = -1e9, lastHot = -1e9;
  let noticeAt = -1e9, nx = 0, ny = 0;

  const now = () => performance.now() / 1000;
  // A dialog is open: the backdrop holds still behind it.
  const checkModal = () => {
    modal = false;
    for (const d of document.querySelectorAll('[aria-modal="true"]')) if (d.getClientRects().length) { modal = true; break; }
  };
  // Input after a quiet spell is NOTICED: a draw-in that runs through the
  // blobs nearest-first, like something looking up. Never a move, so the
  // background never shifts as a whole.
  const input = (x, y) => {
    const t = now();
    if (t - lastInput >= QUIET) { noticeAt = t; nx = x; ny = y; }
    lastInput = lastHot = t;
    kick();
  };

  const tick = (ms) => {
    const t = ms / 1000;
    const hot = t - lastHot < 1.5;
    // Only life moving: no need for every frame.
    if (lastT && !hot && t - lastT < 1 / IDLE_FPS - 0.004) { raf = requestAnimationFrame(tick); return; }
    const dt = lastT ? Math.min(0.1, t - lastT) : 1 / 60;
    lastT = t;
    clock += dt;
    if (t - modalAt > 0.5) { modalAt = t; checkModal(); }
    const calm = modal || away || now() < hushUntil;
    const lifeT = calm ? 0 : 1;
    life += (lifeT - life) * (1 - Math.exp(-dt / (lifeT < life ? 0.35 : 1.2)));
    let busy = life > 0.002 || lifeT > 0;

    vel *= Math.exp(-dt / SETTLE);
    const sq = Math.max(-1, Math.min(1, vel / 36));
    if (Math.abs(vel) > 0.3) busy = true;
    const mouse = mouseScreen.matches;

    // touch screens: the target swirl for the current scroll position
    const angT = mouse ? 0 : top * TURN * Math.PI / 180;
    const spreadT = mouse ? 0 : SPREAD * Math.abs(Math.sin(top / 900));
    const ease = 1 - Math.exp(-dt / EASE);
    ang += (angT - ang) * ease;
    spread += (spreadT - spread) * ease;
    if (Math.abs(angT - ang) > 0.0005 || Math.abs(spreadT - spread) > 0.0005) busy = true;
    const cos = Math.cos(ang), sin = Math.sin(ang), grow = 1 + spread, mx = vw / 2, my = vh / 2;

    const follow = 1 - Math.exp(-dt / SMOOTH), lean = 1 - Math.exp(-dt / LEAN), fade = Math.exp(-dt / RETURN);
    // Where each blob is headed: its swirl (touch screens), plus the carry
    // (stir and ripple, fading home, soft-limited to MAX), plus its sway.
    for (const b of blobs) {
      b.ux *= fade; b.uy *= fade;
      const m = Math.hypot(b.ux, b.uy), k = m > 1e-6 ? MAX * Math.tanh(m / MAX) / m : 0;
      if (m > 0.05) busy = true;
      const s = b.sway * life, c = clock, n = b.i;
      b.ex = b.ux * k + s * (0.6 * Math.sin(c / (4.9 + n * 0.6) + n * 1.9) + 0.4 * Math.sin(c / (8.3 - n * 0.5) + n * 0.7));
      b.ey = b.uy * k + s * (0.6 * Math.sin(c / (5.7 + n * 0.5) + n * 2.3) + 0.4 * Math.sin(c / (7.6 - n * 0.4) + n * 1.1));
      if (mouse) { b.sx = 0; b.sy = 0; }
      else {
        const rx = b.cx - mx, ry = b.cy - my;
        b.sx = mx + grow * (rx * cos - ry * sin) - b.cx;
        b.sy = my + grow * (rx * sin + ry * cos) - b.cy;
      }
    }
    // Nothing may crowd closer than the resting layout: that is the whole
    // contrast argument. Only the deficit, split between the pair along
    // their centre line, so at rest this is 0. The swirl is rigid and only
    // spreads, so on touch screens this only ever corrects the extras.
    for (let pass = 0; pass < 3; pass++)
      for (let i = 0; i < blobs.length; i++)
        for (let j = i + 1; j < blobs.length; j++) {
          const p = blobs[i], o = blobs[j];
          if (p.hidden || o.hidden) continue;
          const dx = p.cx + p.sx + p.ex - o.cx - o.sx - o.ex, dy = p.cy + p.sy + p.ey - o.cy - o.sy - o.ey, d = Math.hypot(dx, dy) || 1;
          const deficit = p.rest[j] - d;
          if (deficit > 0) { const k = deficit / 2 / d; p.ex += dx * k; p.ey += dy * k; o.ex -= dx * k; o.ey -= dy * k; }
        }

    for (const b of blobs) {
      if (b.hidden) continue;
      let tx = b.ex, ty = b.ey;
      if (mouse) {
        // Confined to the window: what the walls refuse becomes the squash.
        const wx = b.cx + tx, wy = b.cy + ty;
        let overX = 0, overY = 0;
        if (wx < b.loX) overX = b.loX - wx; else if (wx > b.hiX) overX = b.hiX - wx;
        if (wy < b.loY) overY = b.loY - wy; else if (wy > b.hiY) overY = b.hiY - wy;
        tx += overX; ty += overY;
        const pwT = Math.min(1, Math.abs(overX) / PRESS), phT = Math.min(1, Math.abs(overY) / PRESS);
        b.pw += (pwT - b.pw) * lean; b.ph += (phT - b.ph) * lean;
        if (Math.abs(pwT - b.pw) + Math.abs(phT - b.ph) > 0.002) busy = true;
      } else b.pw = b.ph = 0;
      // Two lags in series: critically damped, so it arrives without overshoot.
      b.ax += (tx - b.ax) * follow; b.ay += (ty - b.ay) * follow;
      b.x += (b.ax - b.x) * follow; b.y += (b.ay - b.y) * follow;
      if (Math.abs(tx - b.x) + Math.abs(ty - b.y) + Math.abs(b.ax - b.x) + Math.abs(b.ay - b.y) > 0.05) busy = true;
      // The breath: each axis draws in on its own phase, so the shape turns
      // over as it breathes. Only ever smaller than the blob's own size.
      const th = 2 * Math.PI * clock / b.period + b.i * 1.7;
      let bx = BREATH * life * (1 - Math.cos(th)) / 2, by = BREATH * life * (1 - Math.cos(th + 0.9 + b.i * 0.15)) / 2;
      // The notice: one extra draw-in, nearest blob first, gone in about 1.2s.
      const since = t - noticeAt - Math.hypot(b.cx - nx, b.cy - ny) / 4000;
      if (since > 0 && since < 1.6) {
        const pulse = NOTICE * (since / 0.25) * Math.exp(1 - since / 0.25);
        bx += pulse; by += pulse * 0.6; busy = true;
      }
      // Squashed across the wall it leans on, a little taller for it — never
      // bigger on both axes, so a press can only ever move paint, not add it.
      const kx = 1 - SQUASH * b.pw + SQUASH * BULGE * b.ph;
      const ky = 1 - SQUASH * b.ph + SQUASH * BULGE * b.pw;
      const sx = (1 - bx) * kx * (1 - sq * 0.03), sy = (1 - by) * ky * (1 + sq * 0.05);
      b.el.style.transform =
        `translate(${(b.sx + b.x).toFixed(2)}px, ${(b.sy + b.y - sq * 8).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    }
    raf = busy && !off && !document.hidden ? requestAnimationFrame(tick) : 0;
    if (!raf) lastT = 0;
    // Stopped behind a dialog: look again twice a second, no frames, until it closes.
    clearTimeout(modalTimer);
    if (!raf && modal) modalTimer = setTimeout(kick, 500);
  };
  function kick() { if (!raf && !off && !document.hidden) raf = requestAnimationFrame(tick); }

  measure();
  addEventListener("resize", measure, { passive: true });
  mouseScreen.addEventListener?.("change", measure);

  // The stir: each move carries every blob along the move, weighted by how
  // near the cursor passed to that blob's rest centre.
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const x = e.clientX, y = e.clientY;
    if (lx !== null && mouseScreen.matches) {
      let dx = x - lx, dy = y - ly;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        if (len > STEP) { dx *= STEP / len; dy *= STEP / len; }
        const mx = (x + lx) / 2, my = (y + ly) / 2;
        for (const b of blobs) {
          if (b.hidden) continue;
          const q = Math.hypot(b.cx - mx, b.cy - my) / b.sig, w = GAIN * Math.exp(-q * q);
          b.ux += dx * w; b.uy += dy * w;
        }
        input(x, y);
      }
    }
    lx = x; ly = y;
  }, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => { lx = ly = null; });

  // A click or tap sends a ripple: blobs near it are nudged straight away
  // from it and drift back. Zero at a blob's own centre, largest at 0.7
  // sigma, so there is no direction to flip. One push, never a pull.
  addEventListener("click", (e) => {
    if (!e.detail) return;   // keyboard "clicks" have no place on the screen
    const x = e.clientX, y = e.clientY;
    for (const b of blobs) {
      if (b.hidden) continue;
      const dx = b.cx - x, dy = b.cy - y, q = Math.hypot(dx, dy) / b.sig;
      const k = RIPPLE * 2.33 * Math.exp(-q * q) / b.sig;
      b.ux += dx * k; b.uy += dy * k;
    }
    input(x, y);
  }, { passive: true, capture: true });

  // Typing hushes it: the breath and sway fade out while you write and come
  // back HUSH seconds after the last keystroke.
  let hushTimer = 0;
  addEventListener("input", () => {
    hushUntil = now() + HUSH;
    input(vw / 2, vh / 2);
    clearTimeout(hushTimer);
    hushTimer = setTimeout(kick, HUSH * 1000 + 50);
  }, { passive: true, capture: true });
  addEventListener("keydown", () => { checkModal(); input(vw / 2, vh / 2); }, { passive: true, capture: true });

  // Hidden tab: nothing runs. Another window in front: it goes still (and
  // then stops) until you come back. Coming back after a while is noticed.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; lastT = 0; }
    else input(vw / 2, vh / 2);
  });
  addEventListener("blur", () => { away = true; kick(); });
  addEventListener("focus", () => { away = false; input(vw / 2, vh / 2); });

  // Capture phase: element scroll events do not bubble.
  addEventListener("scroll", (e) => {
    const t = e.target && e.target.nodeType === 1 ? e.target : document;
    const pos = t === document ? scrollY : t.scrollTop;
    const prev = lastTop.get(t);
    lastTop.set(t, pos);
    top = Math.max(0, pos);
    if (prev === undefined) { kick(); return; }
    vel = Math.max(-72, Math.min(72, vel * 0.5 + (pos - prev)));
    input(vw / 2, vh / 2);
  }, { passive: true, capture: true });
})();
