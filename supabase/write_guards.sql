-- Lynxr write guards — bounds on what anyone (creator or anonymous visitor)
-- may write, where nothing bounded them before.
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
--
-- IF `validate constraint` FAILS LOUDLY below, that is the constraint
-- working, not a bug in this file: it means a row already on the table
-- violates the new rule. Find it and decide what to do with it BEFORE
-- re-running — do not weaken the check to make the error go away. To find
-- the offending row(s):
--
--   select id, octet_length(data::text) as bytes from public.lynxr_creators
--    where octet_length(data::text) > 1048576;
--
--   select email from public.lynxr_waitlist
--    where not (email ~ '^[^@[:space:]]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}$'
--               and length(email) <= 254);

-- A creator's row is fetched whole by the worker's discovery pass for EVERY
-- creator on every sweep. One oversized blob is therefore everyone's problem
-- — it degrades the queue for the whole cohort — and Supabase egress on every
-- pass. 1 MB is ~8x the largest real row measured (101,626 bytes across three
-- creators, HANDOFF 2026-08-17).
alter table public.lynxr_creators
  drop constraint if exists lynxr_creators_data_size;
alter table public.lynxr_creators
  add constraint lynxr_creators_data_size
  check (octet_length(data::text) <= 1048576) not valid;
alter table public.lynxr_creators validate constraint lynxr_creators_data_size;

-- The only table an anonymous visitor may write to, and it accepts any
-- string at all today. This is not spam prevention — it is keeping the
-- column to the shape every consumer already assumes (the mirrored Google
-- Sheet, any export, the owner reading it by eye).
alter table public.lynxr_waitlist
  drop constraint if exists lynxr_waitlist_email_shape;
alter table public.lynxr_waitlist
  add constraint lynxr_waitlist_email_shape
  check (email ~ '^[^@[:space:]]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}$'
         and length(email) <= 254);
