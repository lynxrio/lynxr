/* lynxr — THE STAGE PICKER ("for any creator, at any stage").

   Loaded by /how-it-works/ and /how-it-works/coach/ only, which is where the
   section lives since 2026-09-23 (owner: "put this section in the how it works
   section" / "no need for it on the main landing page", then "have that stay
   there for both script and coach"). It used to be the middle of home.js, on
   the landing page; nothing of it is left there.

   Four toggle buttons, one card. The copy lives in the MARKUP (each button's
   data-title / data-text, and stage 1's already in the card for a visitor
   without JS), so this file only moves aria-pressed and copies two strings —
   nothing to drift.

   THE PAGE DRIVES IT, AT EVERY WIDTH (owner, 2026-09-22: "on desktop keep it
   the way it was the horizonal dynamic from the vertical scroll", then for the
   phone "do it so that as i scroll down, this section just scrolls, similar to
   how the desktop scroll works"). With .hs-live app.css makes the section tall
   and sticks its .lp-in in the middle of the screen, so the page holds on the
   block while each quarter of the run selects the next stage. Above 640px that
   block is a horizontal row of four, below it a column of four; the mechanism
   is identical and this file does not care which is on screen.

   NOTHING HERE IS TOLD A NUMBER. The run is the section's height less the
   sticky block's, both measured, so app.css can be retuned — different per
   width, as it is — without touching this file. .hs-live is set only when the
   block actually fits the screen and never under prefers-reduced-motion; what
   is left then is the plain click-and-arrow row, which is also the no-JS
   state. A click or an arrow key scrolls to that stage's quarter rather than
   fighting the scroll, so position and selection cannot disagree. Unselected
   avatars are paused in CSS.

   NO DOM ASSUMPTION BEYOND THE SECTION ITSELF. It finds `section.hs`, its own
   `.lp-in`, and the ids inside its own card — never #lp-main, never body.home,
   neither of which exists on these pages. Every lookup is guarded, so the file
   is inert on a page without the section.

   THE CARD HAS NO COMPOSER HERE. These pages do not load creator.js, so a
   form[data-hero] on them would be inert; stage 1 shows a link back to the
   landing instead (owner: "link back to the landing"). That is why there is no
   placeholder-swapping here — the data-ph attributes went with the composer.

   An IIFE, like home.js and for the same reason: these pages also load site.js
   and footer.js as classic scripts on one document, and a top-level `const`
   collision between any two of them is a SyntaxError that aborts a whole file
   before its first statement runs. */
(function () {

const $ = (id) => document.getElementById(id);

const stageSec = document.querySelector("section.hs");
const stageRow = stageSec && stageSec.querySelector(".hs-row");
const stageIn = stageSec && stageSec.querySelector(".lp-in");
if (!stageSec || !stageRow || !stageIn || !$("hs-title") || !$("hs-text")) return;

const stages = [...stageRow.querySelectorAll(".hs-stage")];
if (!stages.length) return;
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
let current = 0;
const paint = (i) => {
  current = i;
  stages.forEach((b, k) => b.setAttribute("aria-pressed", String(k === i)));
  $("hs-title").textContent = stages[i].dataset.title || "";
  $("hs-text").textContent = stages[i].dataset.text || "";
  const lbl = stages[i].querySelector(".hs-lbl");
  if ($("hs-step") && lbl) $("hs-step").textContent = `${i + 1} of ${stages.length} · ${lbl.textContent.trim()}`;
  // The card's slot follows the stage (owner, 2026-09-22): data-stage picks the aside, and the
  // one of {stage 1's link, the library strip, the week strip, stage 4's links} that shows, in CSS.
  const card = $("hs-card");
  if (card) {
    card.dataset.stage = String(i);
    // Restart the stage visuals' pop-in (app.css .hs-in): remove, force a reflow, add.
    card.classList.remove("hs-in");
    void card.offsetWidth;
    card.classList.add("hs-in");
  }
};

const live = () => stageSec.classList.contains("hs-live");
// Where the run starts in the document, and how long it is. The sticky block
// begins holding when its own top reaches its CSS `top` offset, and lets go
// when the section's bottom catches it, so the run is the difference in
// their heights — measured, never assumed.
const span = () => {
  const top = stageSec.getBoundingClientRect().top + scrollY;
  const stick = parseFloat(getComputedStyle(stageIn).top) || 0;
  return { start: top - stick, run: Math.max(1, stageSec.offsetHeight - stageIn.offsetHeight) };
};
const fromScroll = () => {
  if (!live()) return;
  const { start, run } = span();
  const p = Math.min(Math.max((scrollY - start) / run, 0), 0.9999);
  const i = Math.floor(p * stages.length);
  if (i !== current) paint(i);
};
// Measured, not a magic px: the mode only makes sense when the whole block
// can be on screen at once. A landscape phone falls back to the plain row.
const setLive = () => {
  stageSec.classList.toggle("hs-live", !reduce.matches && innerHeight >= stageIn.offsetHeight + 32);
  fromScroll();
};
// Straight on the scroll event, not via requestAnimationFrame: a frame callback never runs in a
// tab that isn't painting, which froze the stage on the first one it missed. The work is one
// rect read and, only when the stage actually changes, four attribute writes.
addEventListener("scroll", fromScroll, { passive: true });
reduce.addEventListener("change", setLive);

const select = (i, focus) => {
  if (i !== current) paint(i);
  if (focus) stages[i].focus({ preventScroll: true });
  if (!live()) {
    // A SAFETY NET, NOT A MODE. The row is a plain grid at both widths today,
    // so both of these are 0 and this does nothing. If it is ever given an
    // overflow again, the chosen stage still gets put in view instead of
    // being selected somewhere off the edge of its own container.
    const y = stageRow.scrollHeight - stageRow.clientHeight;
    const x = stageRow.scrollWidth - stageRow.clientWidth;
    if (x > 0) stageRow.scrollLeft = stages[i].offsetLeft;
    else if (y > 0) stageRow.scrollTop = stages[i].offsetTop;
    return;
  }
  const { start, run } = span();
  scrollTo({ top: start + run * (i + 0.5) / stages.length, behavior: reduce.matches ? "auto" : "smooth" });
};
stageRow.addEventListener("click", (e) => {
  const i = stages.indexOf(e.target.closest(".hs-stage"));
  if (i >= 0) select(i, false);
});
stageRow.addEventListener("keydown", (e) => {
  const i = stages.indexOf(e.target.closest(".hs-stage"));
  if (i < 0) return;
  const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: stages.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  select(Math.min(Math.max(to, 0), stages.length - 1), true);
});
// A resize can cross the breakpoint, change the run, or turn the mode off.
addEventListener("resize", setLive);
setLive();

})();
