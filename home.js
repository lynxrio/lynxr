/* lynxr — the public pages. One script, two of them:

     /            the marketing page. No form. All this file does there is
                  carry a ?ref= / ?utm_ campaign tag onto the "try it" link so
                  attribution survives the hop.
     /waitlist/   the form. Takes an email, writes it to Supabase, mirrors it
                  to a Google Sheet.

   Every wiring below is guarded on its element existing, which is what lets
   one file serve both pages — and what stops a missing element on one of them
   throwing before the other page's wiring has run.

   Neither app is mentioned on either page. Both live on unlisted paths handed
   out by invitation, and a link on a public page would undo that. A returning
   creator has the URL already; these pages do not need to help them. */

const SB_URL = "https://esakjfogplfszievvabi.supabase.co";
// Public by design — the repo is public. It is safe only because the waitlist
// policy grants INSERT and nothing else: no one can read the list back with it.
const SB_KEY = "sb_publishable_pTFNX2B94PE_DFLL799w4A_4VcH2xTN";

/* A convenience mirror of the waitlist into a Google Sheet, so signups show up
   somewhere you actually look instead of only in the Supabase dashboard.

   Paste the Apps Script /exec URL here — see supabase/waitlist-sheet.gs for the
   two-minute deploy. Left empty, the mirror is simply skipped and Supabase
   still gets every signup, so shipping this before the script is deployed
   breaks nothing.

   Sheet: docs.google.com/spreadsheets/d/1ypPfMkF6jpyQJ-9WCNoyjcjTenXrePhMz2uv96LjScY */
const WAITLIST_SHEET_URL =
  "https://script.google.com/macros/s/AKfycbyFGbycer3b7rH2FS-tzHGcYcX4ywQpBrWpVFkXaEzKHlUWDn82fnZhv5DddT4gGqjG/exec";

const $ = (id) => document.getElementById(id);

/* WHERE THE SIGNUP CAME FROM.

   `source` is a column the schema always had ("which page/campaign") that this
   page never filled in — every row said "landing", so the list could tell you
   how many people joined and never which link they came from.

   Order matters, most trustworthy first:

     1. ?ref=... — a tag YOU put on a link before sharing it. The only one that
        survives everywhere, because it's part of the URL rather than something
        the platform decides to pass along.
     2. ?utm_source=... — same idea, for links that already carry UTMs.
     3. The referring site's HOSTNAME, recorded as "ref:tiktok.com".
        Weak: TikTok and the Instagram in-app browser usually strip the
        referrer entirely, so treat a bare "landing" as "unknown", not "typed
        it in directly".

   Only the hostname is ever stored, never the full referring URL — that can
   carry search terms or private path segments, and none of it is our business.

   Read at load rather than at submit, so it reflects how the visitor actually
   arrived. */
const SOURCE_MAX = 40;

/** Keep it to a small, boring charset. Nothing renders this column, but it
    lands in a database and a spreadsheet, and neither wants surprises. */
function cleanSource(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9._:-]/g, "");
  return s.slice(0, SOURCE_MAX);
}

function signupSource() {
  try {
    const q = new URLSearchParams(location.search);
    const tagged = cleanSource(q.get("ref") || q.get("utm_source"));
    if (tagged) return tagged;

    if (document.referrer) {
      const host = new URL(document.referrer).hostname.replace(/^www\./, "");
      // Ignore our own pages — arriving from lynxr.io isn't a traffic source.
      if (host && host !== location.hostname) {
        const tag = cleanSource("ref:" + host);
        if (tag) return tag;
      }
    }
  } catch { /* a malformed URL or referrer is not worth failing a signup over */ }
  return "landing";
}

const SOURCE = signupSource();

/* WHAT THEY AGREED TO.
   Stored per signup, because the promise on the page has already been reworded
   more than once and "what did this person actually consent to" is answerable
   only if each row carries its own answer.

   A version TAG, not the sentence: the sentence is in index.html (.wait-sub)
   and in git history. Bump this whenever that promise changes MEANING — going
   from "we'll email you at launch" to anything broader is a new tag, and the
   old rows keep the narrower one they were given.

   Needs supabase/waitlist_consent.sql to have been run. Until then the column
   does not exist and PostgREST rejects the whole insert, so this is sent only
   when the column is confirmed present — see the retry in the submit handler. */
/* v2 (2026-08-17) widened the promise from "we'll notify you when we launch" to
   launch news PLUS occasional product updates. The tag changed with it, which
   is the whole point of having one: rows carrying launch-notify-v1 agreed to a
   single launch email and NOTHING else, so a product update may not be sent to
   them without asking first. Do not retro-fit v2 onto old rows. */
const CONSENT = "launch-and-updates-v2";

/** Fire-and-forget. Apps Script answers with a 302 the browser will not let us
    read, so this is mode:"no-cors" and its success cannot be confirmed from
    here — which is why it is never allowed to affect what the visitor sees.
    Supabase is the record; this is a copy. */
function mirrorToSheet(email) {
  if (!WAITLIST_SHEET_URL) return;
  try {
    fetch(WAITLIST_SHEET_URL, {
      method: "POST",
      mode: "no-cors",
      // text/plain keeps it a CORS "simple request" — a JSON content-type
      // would trigger a preflight that Apps Script does not answer.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ email, source: SOURCE, created_at: new Date().toISOString() }),
    }).catch(() => {});
  } catch { /* the signup is already in Supabase; the mirror is optional */ }
}

function say(text, kind) {
  const el = $("wait-msg");
  el.textContent = text;
  el.className = "wait-msg" + (kind ? " " + kind : "");
}

/* Deliberately loose. A regex that "properly" validates an address rejects
   real ones, and the cost of a typo here is one dead row — while the cost of
   turning away a real creator is the whole point of the page. */
const looksLikeEmail = (s) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s);

/* THE "TRY IT" BUTTON, on / only.

   The wait list is a separate page now, so a campaign tag put on the link that
   was shared — lynxr.io/?ref=tiktokbio — sits in the URL of the page BEFORE the
   form and would be dropped at the hop. Every signup would then read "landing",
   which is the exact blindness the source column was added to fix.

   Only the two keys signupSource() actually reads are carried (`ref`, and
   anything utm_*): forwarding the whole query string would drag arbitrary
   visitor-supplied junk onto our own URL for no gain. An existing key on the
   href always wins, so a hand-written link cannot be overridden by a query
   param. Failure here must never break the link — it is wrapped, and the
   plain href is a working navigation on its own with JS off entirely. */
const tryIt = $("try-it");
if (tryIt) {
  try {
    const from = new URLSearchParams(location.search);
    const to = new URL(tryIt.getAttribute("href"), location.href);
    for (const [k, v] of from) {
      if ((k === "ref" || k.startsWith("utm_")) && !to.searchParams.has(k)) {
        to.searchParams.set(k, v);
      }
    }
    if (to.search) tryIt.setAttribute("href", to.pathname + to.search);
  } catch { /* a malformed query is not worth breaking the only button on */ }
}

if ($("wait-form")) $("wait-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("wait-email");
  const email = input.value.trim().toLowerCase();
  const btn = $("wait-go");

  if (!looksLikeEmail(email)) {
    say("that doesn't look like an email address.", "bad");
    input.focus();
    return;
  }

  btn.disabled = true;
  say("adding you…");
  try {
    const send = (row) => fetch(`${SB_URL}/rest/v1/lynxr_waitlist`, {
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
      body: JSON.stringify(row),
    });

    let res = await send({ email, source: SOURCE, consent: CONSENT });
    // PGRST204 is "column not found" — waitlist_consent.sql has not been run in
    // this project yet. PostgREST rejects the WHOLE insert when a payload names
    // a column that does not exist, so shipping the consent tag first would
    // have turned every signup into a failure. A real signup is worth more than
    // its consent tag, so drop the tag and keep the address. Narrow on purpose:
    // any other error still surfaces to the visitor below.
    if (!res.ok && res.status !== 409) {
      const why = await res.clone().text();
      if (why.includes("PGRST204")) res = await send({ email, source: SOURCE });
    }

    // 409 means the email is already on the list. That is a success from the
    // visitor's side, and saying "already there" would confirm to a stranger
    // which addresses have signed up.
    if (res.ok || res.status === 409) {
      // Only mirror a genuinely new signup. A 409 means they are already on
      // the list, and copying that to the sheet would add a duplicate row for
      // someone who simply submitted twice.
      if (res.ok) mirrorToSheet(email);
      $("wait-form").hidden = true;
      // The promise line goes with the form. Leaving "leave your email for
      // launch news" sitting above "you're on the list" reads as a submit that
      // did not take — the card has to end in ONE state, not two.
      if ($("wait-sub")) $("wait-sub").hidden = true;
      // Restates the promise rather than widening it. The confirmation is the
      // last thing they read, so it must not quietly enlarge the consent —
      // anything vaguer ("we'll be in touch", "expect news") would claim more
      // than the form above asked for.
      say("you're on the list. we'll update you about the launch.", "good");
      return;
    }
    // The table not existing is the one failure worth naming precisely — it is
    // a deployment step, not the visitor's problem, and it looks identical to
    // a network error from out here.
    const body = await res.text();
    if (body.includes("PGRST205")) {
      say("the waitlist isn't set up yet. try again shortly.", "bad");
    } else {
      say("that didn't send. try again in a moment.", "bad");
    }
  } catch {
    say("that didn't send — check your connection.", "bad");
  } finally {
    btn.disabled = false;
  }
});
