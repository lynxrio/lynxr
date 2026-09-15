/* THE THEME: LIGHT ONLY, BEFORE THE FIRST PAINT.
   ---
   Owner, 2026-09-15: "also get rid of the dark mode". lynxr is light only.
   This line stamps data-theme="light" on <html> before any box is painted, and
   the html[data-theme="light"] block in app.css carries the whole look. The dark
   values in app.css's :root are dormant, not deleted: removing this one line
   would bring dark back, which is also why the toggles are hidden in CSS rather
   than torn out of 24 pages.

   Why it is a file and not an inline <script>: `script-src 'self'` with no
   'unsafe-inline' blocks inline scripts on every page. It is loaded WITHOUT
   `defer` in <head>, after the stylesheet <link>, so it runs before first paint
   and there is no dark flash on the way to light.

   The localStorage write keeps the creator app agreeing: it only adopts a
   theme synced from a creator's profile when this device has none stored, and
   its applyTheme() now paints light regardless.

   Nothing else belongs in this file, and it must never throw: localStorage
   raises in private mode and on a blocked-cookies origin. */
(function () {
  document.documentElement.setAttribute("data-theme", "light");
  try { localStorage.setItem("lynxr_theme", "light"); } catch (e) { /* no storage: the attribute is enough */ }
})();
