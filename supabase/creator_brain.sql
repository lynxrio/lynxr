-- The creator brain: one derived JSONB document per creator, rebuilt on a schedule by the worker.
-- Plan: ~/.claude/plans/lynxr-brain-doc.md (step 2 of ~/.claude/plans/lynxr-one-brain-v1.md)
--
-- It is DERIVED and SAFE TO DROP: everything in it is worked out from a creator's own tracked posts and their own onboarding
-- answers, and the worker (pipeline/brain.py, the brain_pass lane at the end of pipeline/track_posts.py's pass) can rebuild it.
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/post_tracking.sql and supabase/staff_gate.sql (the document is built from lynxr_posts and its snapshots;
-- is_staff() is in the staff policy). Run it BEFORE the worker that writes it is deployed: a worker that finds the table
-- missing logs one line and does nothing, so the order is safe in that direction only.
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- TRUST BOUNDARY. The brain is built from the creator's own posts and their own onboarding answers. It is read by its owner and
-- by staff, and written only by the pipeline (service role). It never reaches lynxr_sources, lynxr_videos, the agency app or any
-- cross-creator number, and the agency script path (pipeline/process_campaigns.py, AGENCY_SCRIPT_SYSTEM) never reads it.
--
-- DERIVED, NOT A RECORD. Deleting a row costs nothing: the lane rebuilds it on its next pass. That is the v1 answer to "the brain is
-- wrong about me". There is no correction UI, by design: a creator should not have to correct lynxr, so the derivation says less
-- rather than guessing, and a wrong line is a bug in the derivation.
--
-- NO TRANSCRIPTS, EVER. Like lynxr_posts, the document holds captions and public counts, never a transcript, a shot list or a tag.
--
-- Deleting an account deletes its row: the foreign key below cascades, and supabase/delete_account.sql (which deletes auth.users and
-- lets the keys do the rest) needs no change.

do $$ begin
  if to_regclass('public.lynxr_posts') is null then
    raise exception 'public.lynxr_posts missing — run supabase/post_tracking.sql first';
  end if;
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
end $$;

create table if not exists public.lynxr_creator_brain (
  creator_id uuid primary key references auth.users(id) on delete cascade,
  body       jsonb not null,
  built_at   timestamptz not null default now()
);
create index if not exists lynxr_creator_brain_built_idx on public.lynxr_creator_brain (built_at);

-- Row-level security: a creator reads their own, staff read all, nobody but the pipeline writes.
alter table public.lynxr_creator_brain enable row level security;
revoke all on table public.lynxr_creator_brain from anon;
revoke insert, update, delete, truncate on table public.lynxr_creator_brain from authenticated;
grant select on table public.lynxr_creator_brain to authenticated;
drop policy if exists "creator reads own brain" on public.lynxr_creator_brain;
create policy "creator reads own brain" on public.lynxr_creator_brain
  for select to authenticated using (auth.uid() = creator_id);
drop policy if exists "staff read brains" on public.lynxr_creator_brain;
create policy "staff read brains" on public.lynxr_creator_brain
  for select to authenticated using (public.is_staff());

comment on table public.lynxr_creator_brain is
  'Derived, one row per creator: what lynxr has learned from the creator''s own tracked posts and onboarding answers. Rebuilt on a schedule by the worker, safe to drop, holds no transcripts. Read by its owner and by staff; never lynxr_sources, lynxr_videos, the agency app or any cross-creator number.';

notify pgrst, 'reload schema';

-- Checks to run after it (paste one at a time):
--   an empty table until the worker has run (expect: 0):
--     select count(*) from public.lynxr_creator_brain;
--   two policies (expect: 2 rows, "creator reads own brain" and "staff read brains"):
--     select policyname from pg_policies where schemaname = 'public'
--        and tablename = 'lynxr_creator_brain' order by 1;
--   a creator can write nothing and a visitor can read nothing (expect: f, f, f, f):
--     select has_table_privilege('authenticated','public.lynxr_creator_brain','insert'),
--            has_table_privilege('authenticated','public.lynxr_creator_brain','update'),
--            has_table_privilege('authenticated','public.lynxr_creator_brain','delete'),
--            has_table_privilege('anon','public.lynxr_creator_brain','select');
--
-- ROLLBACK (the whole undo; run both lines):
--   drop table public.lynxr_creator_brain;
--   notify pgrst, 'reload schema';
-- Nothing else is affected: no other table has a foreign key to it, no function reads it, and the worker recreates the rows once
-- the table is back.
