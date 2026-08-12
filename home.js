/* lynxr — the public homepage.
   One job beyond looking right: if this browser already holds a creator
   session, swap the "Create your account" call to action for "Continue",
   so a returning creator is not invited to sign up again.

   Reads localStorage on its own origin and nothing else — the CSP on this
   page allows no connections at all. Note the agency app is deliberately not
   mentioned here; it lives on an unlisted path handed out by invitation. */
try {
  const sess = JSON.parse(localStorage.getItem("lynxr_creator_session") || "null");
  const email = sess?.user?.email;
  if (email) {
    const go = document.querySelector(".home-go");
    const alt = document.querySelector(".home-alt");
    if (go) { go.textContent = "Continue"; go.setAttribute("href", "creator.html"); }
    // A stored session may well have expired, so this is a hint, not a claim.
    if (alt) { alt.textContent = `signed in as ${email}`; alt.removeAttribute("href"); }
  }
} catch { /* unreadable or cleared — the default call to action stands */ }
