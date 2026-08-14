-- ---------------------------------------------------------------------------
-- WAITLIST CONSENT RECORD (2026-08-17)
-- Dashboard -> SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- ---------------------------------------------------------------------------
-- lynxr_waitlist already stores email, source and created_at. What it does not
-- store is WHAT THE PERSON AGREED TO, and that is the part you would actually
-- need if a signup ever disputed being emailed.
--
-- The promise on the landing page has been reworded several times already
-- ("we'll come to you as we open up" -> "we'll notify you when we launch"), so
-- "the consent text" is not one fixed string — it is whatever was on screen on
-- the day that row was created. Storing a version tag per row is how you can
-- still answer the question a year later.
--
-- Deliberately a short tag rather than the full sentence: the sentence lives in
-- index.html and in git history, and copying prose into every row makes the
-- table heavier without making it more true.

alter table public.lynxr_waitlist
  add column if not exists consent text not null default '';

comment on column public.lynxr_waitlist.consent is
  'Version tag for the promise shown at signup, e.g. launch-notify-v1. The text
   itself lives in index.html (.wait-sub). Bump the tag in home.js whenever that
   promise changes meaning.';

-- The insert policy is unchanged: anon may INSERT and nothing else, so a
-- visitor can write their own consent tag but can never read the list back.
-- No policy change is needed for a new column, but re-stating it here because
-- "I added a column, do I need to touch RLS?" is the obvious next question.
-- (Answer: no. Policies are per-table, not per-column.)
