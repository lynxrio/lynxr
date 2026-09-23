/* THE LYNXR AVATAR — the X with a face, as one reusable component.
   ---
   Geometry, moods and paint are ported from the owner-approved prototype
   (~/.claude/plans/lynxr-rebrand-assets/x-avatar-prototype.html, concept
   "a · the x"), with the two things this site forbids taken out:

   1. NO INLINE STYLES. The prototype posed each arm with style="transform…"
      and staggered loops with style="animation-delay…". `style-src 'self'`
      drops those silently. Here every pose, loop and delay is a CLASS or the
      root's data-mood attribute, and app.css owns the values
      (.lx[data-mood="…"] .lx-a0 { transform: rotate(…) }). Changing mood is
      one attribute write, so the arms get the CSS transition for free.
   2. NO innerHTML MORPHING. Every face and every extra for all eight moods is
      emitted once; CSS shows only the current mood's group. A hidden group is
      display:none, so its loops do not run and cost nothing.

   Four capsule arms live inside a <mask>, and ONE unrotated gradient paints
   their union. Per-arm gradients would rotate with each arm and show seams
   where arms overlap, which is why the mask exists. A live instance animates
   its arms, so each gets its own mask id (lx-m-1, lx-m-2, …). The paint
   servers that never animate (#lx-glass, #lx-shade, #lx-soft, and the static
   idle mask #lx-idle) are shared from ONE <svg class="lx-defs"> per page,
   which is always rendered (0x0, never display:none — a gradient inside a
   display:none subtree does not paint in Chrome or Firefox).

   Everything is aria-hidden: every surface that shows the avatar already says
   in words what is happening. */
(function (root) {
  "use strict";
  var W = "#fff", VIO = "#7b61ff", SWEAT = "#6fb5ff";
  var MOODS = ["idle", "reading", "writing", "done", "hyped", "confused", "sorry", "coaching"];
  var L = [51, 55], R = [69, 55], EW = 8, EH = 13;
  var uid = 0;
  function n(v) { return Math.round(v * 100) / 100; }
  function pill(cx, cy, w, h) {
    return '<rect x="' + n(cx - w / 2) + '" y="' + n(cy - h / 2) + '" width="' + n(w) + '" height="' + n(h) + '" rx="' + n(w / 2) + '" fill="' + W + '"/>';
  }
  function line(d, w, color) {
    return '<path d="' + d + '" stroke="' + (color || W) + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
  }
  function star(cx, cy, r, fill, cls) {
    var k = r * 0.2;
    return '<path class="' + cls + '" d="M' + n(cx) + " " + n(cy - r) + "Q" + n(cx + k) + " " + n(cy - k) + " " + n(cx + r) + " " + n(cy) +
      "Q" + n(cx + k) + " " + n(cy + k) + " " + n(cx) + " " + n(cy + r) + "Q" + n(cx - k) + " " + n(cy + k) + " " + n(cx - r) + " " + n(cy) +
      "Q" + n(cx - k) + " " + n(cy - k) + " " + n(cx) + " " + n(cy - r) + 'Z" fill="' + fill + '"/>';
  }
  function sad(cx, cy, w, h, side) {
    var x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, yb = cy + h / 2, r = w / 2, d = h * 0.4;
    var tl = side === "l" ? y0 + d : y0, tr = side === "l" ? y0 : y0 + d;
    return '<path d="M' + n(x0) + " " + n(tl) + "L" + n(x1) + " " + n(tr) + "V" + n(yb - r) + "A" + n(r) + " " + n(r) + " 0 0 1 " + n(x0) + " " + n(yb - r) + 'Z" fill="' + W + '"/>';
  }
  function eyes(s) {
    var w = EW, h = EH;
    switch (s) {
      case "idle":     return '<g class="lx-blink">' + pill(L[0], L[1], w, h) + pill(R[0], R[1], w, h) + "</g>";
      case "reading":  return '<g class="lx-scan">' + pill(L[0], L[1], w, h * 0.72) + pill(R[0], R[1], w, h * 0.72) + "</g>";
      case "writing":  return '<g class="lx-nod">' + pill(L[0], L[1] + h * 0.28, w, h * 0.5) + pill(R[0], R[1] + h * 0.28, w, h * 0.5) + "</g>";
      case "done":     return line("M" + n(L[0] - w * 0.75) + " " + n(L[1] + h * 0.15) + "q" + n(w * 0.75) + " " + n(-h * 0.6) + " " + n(w * 1.5) + " 0" +
                                   "M" + n(R[0] - w * 0.75) + " " + n(R[1] + h * 0.15) + "q" + n(w * 0.75) + " " + n(-h * 0.6) + " " + n(w * 1.5) + " 0", n(w * 0.45));
      case "hyped":    return star(L[0], L[1], h * 0.56, W, "lx-tw") + star(R[0], R[1], h * 0.56, W, "lx-tw lx-dl1");
      case "confused": return pill(L[0], L[1], w, h) + pill(R[0], R[1] - h * 0.18, w * 0.9, h * 0.55);
      // sheepish: droopy eyes glancing aside (no brows: owner, 2026-09-15)
      case "sorry":    return sad(L[0] + 1.5, L[1] + 2, w, h * 0.78, "l") + sad(R[0] + 1.5, R[1] + 2, w, h * 0.78, "r");
      case "coaching": return pill(L[0], L[1], w, h) + pill(R[0], R[1] - h * 0.1, w, h * 1.15);
    }
    return "";
  }
  function mouth(s) {
    var inner = "";
    switch (s) {
      case "idle":     inner = line("M-5 0q5 4 10 0", 3); break;
      case "reading":  inner = line("M-3.5 0h7", 3); break;
      case "writing":  inner = line("M-3 .5q3-1.6 6 0", 2.8); break;
      case "done":     inner = line("M-8-1q8 8 16 0", 3.4); break;
      case "hyped":    inner = '<path d="M-7.5-2.5h15q-.5 9.5-7.5 9.5t-7.5-9.5z" fill="' + W + '"/>'; break;
      case "confused": inner = line("M-8 0q2-3 4 0t4 0t4 0t4 0", 2.8); break;
      case "sorry":    inner = line("M-4.5 3q4.5-4.2 9 0", 2.8); break;
      case "coaching": inner = '<ellipse class="lx-talk" cx="0" cy="1" rx="4.2" ry="3.6" fill="' + W + '"/>'; break;
    }
    return '<g transform="translate(60 70)">' + inner + "</g>";
  }
  function extras(s) {
    if (s === "hyped") return star(18, 40, 6, VIO, "lx-tw") + star(102, 40, 5, VIO, "lx-tw lx-dl3") + star(60, 5, 3.5, VIO, "lx-tw lx-dl5");
    if (s === "confused") return '<g class="lx-bob"><g transform="translate(24 14) rotate(14)">' +
      line("M-4.5-5.5q0-5.5 4.8-5.5q4.7 0 4.7 4.6q0 3.6-4.7 5.4v3", 3.4, VIO) + '<circle cy="8.4" r="2.1" fill="' + VIO + '"/></g></g>';
    if (s === "sorry") return '<g class="lx-drip"><path transform="translate(70 22) scale(.85)" d="M0-7.5c3.2 4.6 4.8 7.3 4.8 9.6a4.8 4.8 0 0 1-9.6 0c0-2.3 1.6-5 4.8-9.6z" fill="' + SWEAT + '"/></g>';
    if (s === "writing") return '<circle class="lx-dot" cx="52" cy="8" r="2.6" fill="' + VIO + '"/>' +
      '<circle class="lx-dot lx-dl2" cx="60" cy="8" r="2.6" fill="' + VIO + '"/>' + '<circle class="lx-dot lx-dl4" cx="68" cy="8" r="2.6" fill="' + VIO + '"/>';
    return "";
  }
  /* PROPS: artwork a mood does NOT own (the landing hero's intro, 2026-09-22).
     `extras(mood)` is keyed on data-mood, so putting the pencil in "writing"
     would hand one to every writing avatar on the site — the loader, the
     composer button, the creator app's states. These two are emitted for every
     live avatar the same way the extras are, stay display:none like them, and
     are shown only when the ROOT carries .lx-prop-pencil / .lx-prop-whistle
     (lynxrProp below). No existing mood renders differently anywhere.

     Each is wrapped twice on purpose, because a CSS transform replaces the
     whole transform, so one element cannot carry two of them:
       .lx-hold  rides the hand — app.css gives it the arm's own keyframes and
                 the arm's origin (60,62), so the prop never drifts off the
                 hand it is held in;
       .lx-pop   the prop's own entrance/exit, about its own end of the pencil;
       the inner <g transform>  places and angles it, as a plain attribute.
     Both are drawn from the hand OUTWARD: white barrels with a violet edge, so
     they read over the arm's pink-violet gradient AND over the page behind it —
     a solid violet prop measured as mush against the arm it is held in. */
  function props(s) {
    if (s === "pencil") {
      /* held in the BOTTOM-RIGHT hand (.lx-a2), pointing down-right at the page
         (owner, 2026-09-22: "actually put the pencil on the bottom right limb",
         after "put the item in the same limb for both" — so the whistle below
         moved to this same hand). Was the lower-left hand until then. */
      var p = '<rect x="-3.6" y="-16" width="7.2" height="22" rx="2" fill="' + W + '" stroke="' + VIO + '" stroke-width="2.2"/>' +
        '<path d="M-3.6 5.4h7.2L0 16z" fill="' + W + '" stroke="' + VIO + '" stroke-width="2.2" stroke-linejoin="round"/>' +
        '<rect x="-3.6" y="-16" width="7.2" height="5" rx="2" fill="' + VIO + '"/>' +
        '<path d="M-1.5 11.4h3L0 16z" fill="' + VIO + '"/>';
      return '<g class="lx-hold"><g class="lx-pop"><g transform="translate(85 94) rotate(-42)">' + p + "</g></g></g>";
    }
    /* THE WHISTLE IS DRAWN TWICE, in two different hands, and CSS shows one
       (owner, 2026-09-22: "for mobile have the pencil on the right bottom and
       whistle on the left bottom limb" — on a desktop it stays top-right).
       IT HAD TO BE TWO GROUPS. The "emit every state, show one" rule holds for
       MOODS, but not for props: each prop was emitted once, with its hand
       baked into a plain SVG transform attribute that CSS cannot reach. The
       .lx-hold wrapper can only orbit the whole object about the avatar's
       centre, which would carry the artwork round upside down, and .lx-pop is
       already spent on the entrance/exit. So the second placement is a second
       group, ~0.4KB of markup per live avatar, and the media query picks it —
       which keeps the phone rule and the desktop rule fully independent, with
       no rule having to un-apply another. Both answer the same one class,
       .lx-prop-whistle, so lynxrProp and PROPS are untouched. */
    if (s === "whistle" || s === "whistle-lo") {
      var w = '<rect x="-15" y="-3.4" width="14" height="6.8" rx="3" fill="' + W + '" stroke="' + VIO + '" stroke-width="2.2"/>' +
        '<circle cx="4.6" cy="0" r="8.4" fill="' + W + '" stroke="' + VIO + '" stroke-width="2.2"/>' +
        '<circle cx="4.6" cy="-2.6" r="2.1" fill="' + VIO + '"/>' +
        '<circle cx="13.4" cy="-5.6" r="2.5" fill="none" stroke="' + VIO + '" stroke-width="1.9"/>' +
        '<g class="lx-toot">' + line("M18.5-5.2q4 5.2 0 10.4", 2.4, VIO) + '</g><g class="lx-toot lx-dl2">' + line("M24-8.6q6.6 8.6 0 17.2", 2.2, VIO) + "</g>";
      /* whistle    = the TOP-RIGHT hand (.lx-a1), mouthpiece toward the face;
         whistle-lo = the BOTTOM-LEFT hand (.lx-a3), mouthpiece still toward the
                      face (up-right from there) so the toots blow away from the
                      body, down-left, clear of the panel below it on a phone. */
      var at = s === "whistle"
        ? 'translate(80 24) rotate(-16) scale(.88)'
        : 'translate(39 97) rotate(124) scale(.88)';
      return '<g class="lx-hold"><g class="lx-pop"><g transform="' + at + '">' + w + "</g></g></g>";
    }
    return "";
  }
  /* The prop NAMES lynxrProp accepts (one class each) and the prop GROUPS drawn
     (whistle-lo is a second placement of the whistle, not a third prop). */
  var PROPS = ["pencil", "whistle"];
  var PROP_ART = ["pencil", "whistle", "whistle-lo"];
  var ARM = '<rect x="43" y="10" width="34" height="60" rx="17" fill="#fff"/>';
  function paint(maskId) {
    var m = 'mask="url(#' + maskId + ')"';
    return '<rect x="-20" y="-20" width="160" height="160" fill="url(#lx-glass)" ' + m + "/>" +
      '<rect x="-20" y="-20" width="160" height="160" fill="url(#lx-shade)" ' + m + "/>" +
      '<g class="lx-hl" ' + m + '><ellipse cx="42" cy="36" rx="30" ry="10" transform="rotate(-40 42 36)" fill="#fff" opacity=".4" filter="url(#lx-soft)"/></g>';
  }

  /* A live avatar: all eight moods present, one showing. `cls` is appended to
     the root's class list (e.g. "loader-mark" for the loader's sizing). */
  function lynxrAvatar(mood, cls) {
    ensureDefs();
    var id = "lx-m-" + (++uid);
    var m = MOODS.indexOf(mood) < 0 ? "idle" : mood;
    var arms = "";
    for (var i = 0; i < 4; i++) arms += '<g class="lx-arm lx-a' + i + '"><g class="lx-w lx-w' + i + '">' + ARM + "</g></g>";
    var faces = "", xs = "";
    for (var k = 0; k < MOODS.length; k++) {
      faces += '<g class="lx-f lx-f-' + MOODS[k] + '">' + eyes(MOODS[k]) + mouth(MOODS[k]) + "</g>";
      var x = extras(MOODS[k]);
      if (x) xs += '<g class="lx-x lx-x-' + MOODS[k] + '">' + x + "</g>";
    }
    for (var q = 0; q < PROP_ART.length; q++) xs += '<g class="lx-x lx-x-' + PROP_ART[q] + '">' + props(PROP_ART[q]) + "</g>";
    return '<svg class="lx' + (cls ? " " + cls : "") + '" data-mood="' + m + '" viewBox="0 0 120 120" aria-hidden="true" focusable="false">' +
      '<defs><mask id="' + id + '" maskUnits="userSpaceOnUse" x="-20" y="-20" width="160" height="160"><g class="lx-spin">' + arms + "</g></mask></defs>" +
      '<g class="lx-loop"><g class="lx-body">' + paint(id) + '<g class="lx-face">' + faces + "</g></g></g>" +
      '<g class="lx-extras">' + xs + "</g></svg>";
  }
  /* The static identity mark (nav, footer, gate, rail): idle, never animates,
     shares the page's #lx-idle mask. Kept byte-identical in every HTML page. */
  function lynxrMark(cls) {
    return '<svg class="' + cls + ' lx lx-still" viewBox="0 0 120 120" aria-hidden="true" focusable="false">' +
      paint("lx-idle") + '<g class="lx-face">' + eyes("idle").replace(' class="lx-blink"', "") + mouth("idle") + "</g></svg>";
  }
  function lynxrDefs() {
    var arms = "";
    [-45, 45, 135, -135].forEach(function (a) { arms += '<rect x="43" y="10" width="34" height="60" rx="17" fill="#fff" transform="rotate(' + a + ' 60 62)"/>'; });
    return '<svg class="lx-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>' +
      '<linearGradient id="lx-glass" x1="10" y1="0" x2="110" y2="118" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffb38a"/><stop offset=".48" stop-color="#ff7eb8"/><stop offset="1" stop-color="#7b61ff"/></linearGradient>' +
      '<linearGradient id="lx-shade" x1="0" y1="14" x2="0" y2="108" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#3a1478" stop-opacity=".32"/></linearGradient>' +
      '<filter id="lx-soft" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="3"/></filter>' +
      '<mask id="lx-idle" maskUnits="userSpaceOnUse" x="-20" y="-20" width="160" height="160">' + arms + "</mask>" +
      "</defs></svg>";
  }
  function ensureDefs() {
    if (typeof document === "undefined" || document.getElementById("lx-glass") || !document.body) return;
    document.body.insertAdjacentHTML("afterbegin", lynxrDefs());
  }
  /* The only writer of a live avatar's mood. A no-op when nothing changes, so
     paintEta() can call it every tick without restarting a loop. */
  function lynxrMood(svg, mood) {
    if (!svg || MOODS.indexOf(mood) < 0 || svg.getAttribute("data-mood") === mood) return;
    svg.setAttribute("data-mood", mood);
  }
  /* The only writer of a live avatar's PROP, the same way lynxrMood is the only
     writer of its mood. `prop` is "pencil", "whistle", null (empty-handed) or
     "out" — which keeps the prop on screen while app.css plays its exit, so the
     caller can drop it with lynxrProp(svg, null) once that has finished. */
  function lynxrProp(svg, prop) {
    if (!svg) return;
    if (prop === "out") { svg.classList.add("lx-prop-out"); return; }
    svg.classList.remove("lx-prop-out");
    for (var i = 0; i < PROPS.length; i++) svg.classList.toggle("lx-prop-" + PROPS[i], PROPS[i] === prop);
  }
  root.lynxrAvatar = lynxrAvatar;
  root.lynxrMood = lynxrMood;
  root.lynxrProp = lynxrProp;
  root.lynxrMark = lynxrMark;
  root.lynxrDefs = lynxrDefs;
  root.LYNXR_MOODS = MOODS.slice();

  /* DECORATIVE AVATARS IN MARKUP. A page can drop <span class="lp-av"
     data-lx-mood="reading"></span> anywhere and it becomes a live avatar in
     that mood (the landing's how-it-works steps and closing line, 2026-09-15).
     This file is deferred, so the document is parsed by the time it runs. */
  function renderDeclared() {
    var els = document.querySelectorAll("[data-lx-mood]:not([data-lx-done])");
    for (var i = 0; i < els.length; i++) {
      els[i].innerHTML = lynxrAvatar(els[i].getAttribute("data-lx-mood"));
      els[i].setAttribute("data-lx-done", "");
    }
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", renderDeclared);
    else renderDeclared();
  }
})(typeof window !== "undefined" ? window : globalThis);
