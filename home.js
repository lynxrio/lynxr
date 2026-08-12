/* lynxr — the public landing page.
   One job: take an email for the waitlist.

   Neither app is mentioned here. Both live on unlisted paths handed out by
   invitation, and a link on the public homepage would undo that. A returning
   creator has the URL already; the page does not need to help them. */

const SB_URL = "https://esakjfogplfszievvabi.supabase.co";
// Public by design — the repo is public. It is safe only because the waitlist
// policy grants INSERT and nothing else: no one can read the list back with it.
const SB_KEY = "sb_publishable_pTFNX2B94PE_DFLL799w4A_4VcH2xTN";

const $ = (id) => document.getElementById(id);

function say(text, kind) {
  const el = $("wait-msg");
  el.textContent = text;
  el.className = "wait-msg" + (kind ? " " + kind : "");
}

/* Deliberately loose. A regex that "properly" validates an address rejects
   real ones, and the cost of a typo here is one dead row — while the cost of
   turning away a real creator is the whole point of the page. */
const looksLikeEmail = (s) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s);

$("wait-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("wait-email");
  const email = input.value.trim().toLowerCase();
  const btn = $("wait-go");

  if (!looksLikeEmail(email)) {
    say("That doesn't look like an email address.", "bad");
    input.focus();
    return;
  }

  btn.disabled = true;
  say("Adding you…");
  try {
    const res = await fetch(`${SB_URL}/rest/v1/lynxr_waitlist`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        "Content-Type": "application/json",
        // return=minimal because the policy allows INSERT and not SELECT, so
        // asking for the row back would fail a write that actually succeeded.
        //
        // And deliberately NOT resolution=merge-duplicates: that turns the
        // insert into an UPSERT, which Postgres checks against the UPDATE
        // policy as well — and there isn't one, by design, so every submission
        // came back "new row violates row-level security policy" even though
        // the insert itself was allowed. A repeat email is handled by letting
        // it 409 below, which is what we want anyway.
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ email, source: "landing" }),
    });

    // 409 means the email is already on the list. That is a success from the
    // visitor's side, and saying "already there" would confirm to a stranger
    // which addresses have signed up.
    if (res.ok || res.status === 409) {
      $("wait-form").hidden = true;
      say("You're on the list. We'll be in touch.", "good");
      return;
    }
    // The table not existing is the one failure worth naming precisely — it is
    // a deployment step, not the visitor's problem, and it looks identical to
    // a network error from out here.
    const body = await res.text();
    if (body.includes("PGRST205")) {
      say("The waitlist isn't set up yet. Try again shortly.", "bad");
    } else {
      say("That didn't send. Try again in a moment.", "bad");
    }
  } catch {
    say("That didn't send — check your connection.", "bad");
  } finally {
    btn.disabled = false;
  }
});
