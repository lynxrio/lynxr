/* lynxr — the front door.
   Two doors, two apps, two stored sessions. This page does one small useful
   thing beyond linking: it reads the sessions already in this browser and
   labels the card you are signed into, so you can tell at a glance which side
   you are on rather than clicking through to find out.

   Nothing is sent anywhere — the CSP on this page allows no connections at all
   — and nothing is written. It only reads localStorage on its own origin. */

const DOORS = [
  ["lynxr_sb_session", "who-agency"],       // app.js
  ["lynxr_creator_session", "who-creator"], // creator.js
];

for (const [key, target] of DOORS) {
  const el = document.getElementById(target);
  if (!el) continue;
  let email = "";
  try {
    // A stored session says who last signed in here; it may well have expired,
    // so this is a hint, never a claim that you are still authenticated.
    email = JSON.parse(localStorage.getItem(key) || "null")?.user?.email || "";
  } catch { /* unreadable or cleared — the card just stays unlabelled */ }
  if (!email) continue;
  el.textContent = email;
  el.className = "pick-who on";
  const card = el.closest(".pick-card");
  if (card) card.classList.add("known");
}
