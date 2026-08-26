/* THE THEME, BEFORE THE FIRST PAINT.
   ---
   `style-src 'self'` with no 'unsafe-inline' means the usual trick — a two-line
   inline <script> in <head> — is not available here: it would be CSP-blocked on
   all twelve public pages and the theme would arrive late or not at all. So it
   is an external file instead, loaded WITHOUT `defer` in <head>.

   No defer is the whole point. Every other script in this repo is deferred and
   runs after the document is parsed, which is after the browser is free to
   paint — that is a dark flash on a light page, on every navigation. A
   render-blocking classic script in <head> runs before any box is painted.

   It is placed AFTER the stylesheet <link> so the preload scanner has already
   started the CSS request; the two fetch in parallel and first paint waits on
   the CSS either way, so this costs no extra round trip on the critical path.

   Nothing else belongs in this file. It must stay small enough that blocking
   on it is free, and it must never throw: localStorage raises in private mode
   and on a blocked-cookies origin, and an exception here would abort parsing. */
(function () {
  try {
    if (localStorage.getItem("lynxr_theme") === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    }
  } catch (e) { /* no storage: the default (dark) is the right answer */ }

  /* THE ONE-CLICK TOGGLE, wired by DELEGATION from this same file.

     Owner, 2026-08-26: "have everyone be able to change it with one click and
     then it toggles that side with a light bulb icon and a moon icon." The
     .theme-toggle buttons live in the markup of every bar and rail; wiring
     them HERE, on one document-level listener, is what lets a single file
     serve all fourteen pages and both apps with no per-page script edits —
     and delegation attached before the DOM exists catches buttons that are
     rendered later (the creator app builds its rail from JS).

     This is the only place the attribute is flipped. The apps LISTEN (the
     lynxr-theme event below) rather than flip, so there is exactly one writer
     — the same one-writer rule paintEta() follows, for the same reason.

     Still nothing here may throw: the try/catch on storage stays, and a page
     with no toggle on it simply never matches the closest(). */
  /* The buttons render with aria-pressed="false" in static markup; on a page
     that arrives already light, say so the moment they exist. The VISUAL needs
     no such sync — the knob reads the attribute through CSS. */
  document.addEventListener("DOMContentLoaded", function () {
    var light = document.documentElement.getAttribute("data-theme") === "light";
    document.querySelectorAll(".theme-toggle").forEach(function (t) {
      t.setAttribute("aria-pressed", light ? "true" : "false");
    });
  });

  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest && e.target.closest(".theme-toggle");
    if (!btn) return;
    var light = document.documentElement.getAttribute("data-theme") !== "light";
    if (light) document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("lynxr_theme", light ? "light" : "dark"); } catch (err) {}
    /* aria-pressed on EVERY instance, not just the one clicked — a page can
       hold two (bar + burger menu) and they must not disagree. */
    document.querySelectorAll(".theme-toggle").forEach(function (t) {
      t.setAttribute("aria-pressed", light ? "true" : "false");
    });
    /* The apps mirror the choice into their own stores (ME.theme in the
       creator app) without owning the flip. */
    document.dispatchEvent(new CustomEvent("lynxr-theme", { detail: { theme: light ? "light" : "dark" } }));
  });
})();
