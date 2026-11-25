/* lynxr-guy.js: the logo kit's web/lynxr-guy.js (owner, 2026-11-23; ~/Lynxr-redesign/logo-kit-v2/lynxr-logo-kit/),
   copied by /Users/junsahwang/Lynxr-redesign/tools/guy_swap.py with the three marked lynxr patches. Do not edit by hand: change the kit or the
   script. Loaded with defer on every page that has a guy. */
/* lynxr guy — smooth circle -> blob morph. No dependencies, ~3 KB.
   Include once (defer). Every .lx-guy on the page wakes up on hover, keyboard focus, press/tap,
   or while it has the .is-active class (add/remove it from your own code, e.g. while a script
   is generating). The circle's outline stretches into the blob and eases back — one shape, no
   cross-fade. Respects prefers-reduced-motion. */
(function () {
  var REST_D = 'M50,205 A150,150 0 1 1 350,205 A150,150 0 1 1 50,205 Z';
  var S = {"rest":[[349.7,214.0],[345.3,242.1],[335.5,269.3],[320.0,295.1],[298.2,318.4],[270.2,337.6],[236.7,350.4],[200.0,355.0],[163.3,350.4],[129.8,337.6],[101.8,318.4],[80.0,295.1],[64.5,269.3],[54.7,242.1],[50.3,214.0],[51.3,185.2],[58.2,156.1],[71.7,127.3],[92.8,100.1],[122.1,76.8],[158.7,60.8],[200.0,55.0],[241.3,60.8],[277.9,76.8],[307.2,100.1],[328.3,127.3],[341.8,156.1],[348.7,185.2]],"keys":[[[365.6,214.0],[348.2,242.7],[327.3,266.0],[310.0,288.3],[292.9,312.7],[268.3,334.2],[235.3,345.0],[200.0,343.6],[167.1,336.1],[135.4,327.7],[103.5,316.5],[75.2,298.4],[55.0,273.2],[42.6,244.5],[34.6,214.0],[33.0,181.7],[45.1,150.8],[73.2,128.3],[109.5,117.8],[142.9,113.6],[171.1,106.9],[200.0,96.1],[233.8,88.5],[269.8,91.1],[303.2,104.4],[332.3,124.6],[356.0,150.3],[369.0,181.3]],[[344.3,214.0],[332.7,239.7],[325.8,265.3],[316.7,292.8],[296.5,316.6],[266.0,330.2],[232.7,335.4],[200.0,339.2],[165.2,343.4],[127.5,341.5],[93.2,327.5],[68.1,303.2],[51.0,274.8],[38.6,245.2],[33.8,214.0],[43.8,183.8],[68.9,160.5],[98.5,145.4],[122.2,131.4],[141.8,111.6],[166.4,89.1],[200.0,74.3],[237.9,73.4],[274.2,83.5],[307.6,99.6],[336.6,121.7],[354.4,151.0],[355.5,183.9]],[[352.2,214.0],[344.9,242.0],[330.0,267.1],[309.3,287.9],[287.2,306.6],[264.5,327.5],[236.6,350.0],[200.0,365.4],[159.4,364.6],[124.7,346.6],[100.7,319.6],[84.5,292.0],[71.8,266.3],[62.4,240.6],[58.5,214.0],[59.5,186.8],[63.8,158.4],[73.7,128.6],[94.3,101.7],[126.7,85.0],[164.3,81.6],[200.0,86.4],[232.9,91.7],[266.8,96.5],[301.2,106.4],[329.8,126.3],[346.9,154.0],[353.2,184.4]],[[353.4,214.0],[352.2,243.4],[344.8,273.1],[331.9,303.1],[308.7,329.5],[274.4,344.8],[235.8,346.8],[200.0,342.1],[166.5,338.2],[132.0,333.7],[99.5,320.8],[77.9,296.5],[69.7,267.2],[67.1,239.7],[61.9,214.0],[56.3,186.2],[59.1,156.5],[74.1,128.9],[97.6,105.2],[125.9,83.6],[160.2,66.1],[200.0,61.1],[237.6,74.2],[264.7,100.2],[282.4,126.4],[300.3,146.2],[322.7,163.9],[343.3,186.3]]]};
  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var T0 = performance.now();

  function loopPts(t) {
    var u = ((t % 12) / 12) * 4, i = Math.floor(u) % 4, f = u - Math.floor(u);
    f = 0.5 - 0.5 * Math.cos(Math.PI * f);
    var A = S.keys[i], B = S.keys[(i + 1) % 4];
    return A.map(function (p, j) { return [p[0] + (B[j][0] - p[0]) * f, p[1] + (B[j][1] - p[1]) * f]; });
  }
  function toPath(P) {
    var n = P.length, o = 'M' + P[0][0].toFixed(1) + ',' + P[0][1].toFixed(1);
    for (var i = 0; i < n; i++) {
      var p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
      o += 'C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ',' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) +
           ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ',' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) +
           ' ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1);
    }
    return o + 'Z';
  }

  function Guy(el) {
    var body = el.querySelector('.lx-body'), eyes = el.querySelector('.lx-eyes');
    if (!body) return;
    var wake = 0, target = 0, raf = 0, last = 0, hover = false, focus = false, press = false, tapTimer = 0;

    function sync() {
      target = (hover || focus || press || el.classList.contains('is-active')) ? 1 : 0;
      if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
    }
    function frame(now) {
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016; last = now;
      var reduce = mq.matches, k = reduce ? 1 : 1 - Math.exp(-dt / 0.3);
      wake += (target - wake) * k;
      if (Math.abs(target - wake) < 0.002) wake = target;
      if (wake === 0 && target === 0) {
        raf = 0; body.setAttribute('d', REST_D);
        if (eyes) eyes.setAttribute('transform', 'translate(0 0)');
        el.classList.remove('is-awake'); return;
      }
      var t = Math.max(0, (now - T0) / 1000), w = wake * wake * (3 - 2 * wake);
      // lynxr patch 3 of 3: the first frame's timestamp can precede T0 (the script's own load time) when a guy is
      // bound already awake (patch 2), which made t negative, loopPts() read S.keys[-1] and the loop die with a
      // TypeError. Found 2026-11-23 on 404.html; a user-woken guy can never hit it.
      var blob = reduce ? S.keys[0] : loopPts(t);
      var br = reduce ? 0 : ((1 - Math.cos(2 * Math.PI * t / 4.2)) / 2) * w;
      var sx = 1 + 0.035 * br, sy = 1 + 0.045 * br;
      var pts = S.rest.map(function (p, i) {
        var x = p[0] + (blob[i][0] - p[0]) * w, y = p[1] + (blob[i][1] - p[1]) * w;
        return [200 + (x - 200) * sx, 216 + (y - 216) * sy];
      });
      body.setAttribute('d', toPath(pts));
      if (eyes) eyes.setAttribute('transform', 'translate(0 ' + (-6 * w - 3 * br).toFixed(2) + ')');
      el.classList.toggle('is-awake', wake > 0.25);
      raf = requestAnimationFrame(frame);
    }

    el.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') { hover = true; sync(); } });
    el.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') { hover = false; sync(); } });
    el.addEventListener('focus', function () { focus = el.matches(':focus-visible'); sync(); });
    el.addEventListener('blur', function () { focus = false; sync(); });
    el.addEventListener('pointerdown', function (e) {
      press = true; el.classList.add('is-pressed'); sync();
      if (e.pointerType !== 'mouse') { clearTimeout(tapTimer); tapTimer = setTimeout(function () { press = false; sync(); }, 3000); }
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      el.addEventListener(ev, function (e) { el.classList.remove('is-pressed'); if (e.pointerType === 'mouse') { press = false; sync(); } });
    });
    // react when your code adds/removes .is-active
    var active = el.classList.contains('is-active');
    // lynxr patch 1 of 3: react only when .is-active itself changes. The kit's observer also fired on the
    // script's own is-awake / is-pressed writes, which kept requestAnimationFrame running at rest forever.
    new MutationObserver(function () {
      var a = el.classList.contains('is-active');
      if (a !== active) { active = a; sync(); }
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
    // lynxr patch 2 of 3: a guy that already has .is-active when bound (404, loaders) wakes at once.
    if (active) sync();
  }

  function init() { document.querySelectorAll('.lx-guy').forEach(function (el) { if (!el.__lxGuy) { el.__lxGuy = 1; Guy(el); } }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.lynxrGuyInit = init; // call again if you add guys to the page later
})();
