/* THE LYNXR GUY — the logo, and the one mascot both apps draw (owner, 2026-11-23).
   ---
   Source: the owner's logo kit v2 (~/Lynxr-redesign/logo-kit-v2/lynxr-logo-kit/LOGO-HANDOFF.md); plan
   ~/.claude/plans/lynxr-guy-logo.md. He replaces "the x" (2026-09-14) and its twelve moods. The guy has no faces:
   "the eyes never change shape or position between states. Only the body shifts." So a mood now decides one thing,
   whether he is AWAKE (.is-active, which /lynxr-guy.js turns into the morph):
     awake    "reading" and "writing" when the caller says he is working (loaderMark in both apps, and lynxrMood);
     resting  everything else. The words beside him already say what happened (every surface did, by design).
   Hover, keyboard focus and press wake him through /lynxr-guy.js; nothing here listens for them.
   The API is the x's, kept so no caller changes shape: lynxrAvatar, lynxrMood, lynxrGesture, lynxrMark, lynxrDefs,
   LYNXR_MOODS. The svg's class is "lx-guy", never "lx", so none of the x's CSS can reach him.
   NO INLINE STYLES (style-src 'self'): state is one class, app.css owns every value. Everything is aria-hidden. */
(function (root) {
  "use strict";
  /* GUY MARKUP START: written by /Users/junsahwang/Lynxr-redesign/tools/guy_swap.py from the kit's web/lynxr-guy.snippet.html. Do not edit by hand. */
  var GUY = "<svg viewBox=\"50 55 300 300\" aria-hidden=\"true\" focusable=\"false\"><g class=\"lx-squish\"><path class=\"lx-body\" fill=\"var(--lx-body)\" d=\"M50,205 A150,150 0 1 1 350,205 A150,150 0 1 1 50,205 Z\"/><g class=\"lx-eyes\"><g class=\"lx-blink\" fill=\"none\" stroke=\"var(--lx-eye)\" stroke-width=\"22.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"108.5,227.5 142.2,182.5 176,227.5\" vector-effect=\"non-scaling-stroke\"/><polyline points=\"224,227.5 257.8,182.5 291.5,227.5\" vector-effect=\"non-scaling-stroke\"/></g></g></g></svg>";
  /* GUY MARKUP END */
  var MOODS = ["idle", "reading", "writing", "done", "hyped", "confused", "sorry", "coaching", "giggle", "shock", "hmm", "cool"];
  var WORKING = { reading: true, writing: true };
  function calm() { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function guy(cls, awake, mood) {
    return GUY.replace("<svg ", '<svg class="lx-guy lx-guy--black' + (cls ? " " + cls : "") + (awake ? " is-active" : "") + '"' +
      (mood ? ' data-mood="' + mood + '"' : "") + " ");
  }
  /* A live guy. `awake` true: he is working from the first frame (the loaders), but only in a working mood. */
  function lynxrAvatar(mood, cls, awake) {
    var m = MOODS.indexOf(mood) < 0 ? "idle" : mood;
    return guy(cls, !!awake && !!WORKING[m], m);
  }
  /* The identity mark the scripts draw (the onboarding logo): resting. */
  function lynxrMark(cls) { return guy(cls, false, ""); }
  /* Nothing is shared between guys: the x needed one <svg class="lx-defs"> per page, the guy needs none. */
  function lynxrDefs() { return ""; }
  /* The only writer of a live guy's state: awake for reading and writing, resting for every other mood. */
  function lynxrMood(svg, mood) {
    if (!svg || MOODS.indexOf(mood) < 0) return;
    svg.setAttribute("data-mood", mood);
    if (svg.lxHello) { svg.lxWasActive = !!WORKING[mood]; return; }   // a hello is playing: it restores this when it ends
    svg.classList.toggle("is-active", !!WORKING[mood]);
  }
  /* GESTURES: "hello" wakes him for 1.4 s, then puts back whatever he was before (awake only if he was working).
     Never under reduced motion. "point" belonged to the x's arms and does nothing now. null ends a hello early. */
  function lynxrGesture(svg, name) {
    if (!svg) return;
    var end = function () {
      clearTimeout(svg.lxHello); svg.lxHello = 0;
      svg.classList.toggle("is-active", !!svg.lxWasActive);
    };
    if (svg.lxHello) end();
    if (name !== "hello" || calm()) return;
    svg.lxWasActive = svg.classList.contains("is-active");
    svg.classList.add("is-active");
    svg.lxHello = setTimeout(end, 1400);
  }
  root.lynxrAvatar = lynxrAvatar;
  root.lynxrMood = lynxrMood;
  root.lynxrGesture = lynxrGesture;
  root.lynxrMark = lynxrMark;
  root.lynxrDefs = lynxrDefs;
  root.LYNXR_MOODS = MOODS.slice();

  /* BIND LATE GUYS: /lynxr-guy.js binds every .lx-guy once, at load. Guys the apps paint later (loaders, onboarding,
     the tour, the link wall, declared avatars) are bound here the moment they enter the page, through the script's
     own lynxrGuyInit(), which skips guys it has already bound. One observer for both apps, so no call site changes. */
  if (typeof document !== "undefined" && typeof MutationObserver === "function") {
    new MutationObserver(function (recs) {
      if (typeof root.lynxrGuyInit !== "function") return;
      for (var i = 0; i < recs.length; i++) {
        var added = recs[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1 && (n.classList.contains("lx-guy") || n.querySelector(".lx-guy"))) { root.lynxrGuyInit(); return; }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* DECLARED GUYS IN MARKUP: <span data-lx-mood="…"></span> becomes a resting guy (the how-it-works stages, the
     landing's friend banner). The mood is kept on the svg but never wakes him: several moving mascots on one screen
     would break "nothing else moves". This file is deferred, so the document is parsed by the time it runs. */
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
