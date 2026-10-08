-- The shape of a posted video, as numbers: how long before anyone speaks, how many words in the first three seconds, the longest
-- silence, how long the video runs, and, when the post is linked to one of lynxr's scripts, WHEN each beat of that script was said.
-- Plan: ~/.claude/plans/lynxr-coach-v1.md (steps 1 and 3; the "where in the video" amendment of 2026-10-07 is the `beats` and
-- `repeats` columns).
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/post_tracking.sql and supabase/staff_gate.sql (a shape hangs off a tracked post; is_staff() is in the staff
-- policy). Run it BEFORE the worker that reads it is deployed: a worker that finds the columns missing logs one line and does
-- nothing, so the order is safe in that direction only.
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- WHAT IT IS. pipeline/post_shape.py (Fly only, a lane of track_posts.py's pass) downloads a tracked post's audio with yt-dlp,
-- transcribes it with the Whisper the worker already has, MEASURES it, and throws the transcript away before the function returns.
-- pipeline/coach.py then compares these measurements across ONE creator's own videos and says what differs between the ones that
-- kept growing and the ones that stopped.
--
-- NUMBERS ONLY — NOT ONE WORD OF ANY TRANSCRIPT, EVER. This is the same contract as lynxr_posts ("NO TRANSCRIPTS, EVER",
-- post_tracking.sql) and lynxr_creator_brain, and it is what makes this table safe to exist at all. `beats` holds, for each beat of the
-- creator's own script, an index and two second marks; `repeats` holds pairs of second marks. Neither holds a word, and neither holds a
-- script's text: the script is already stored (lynxr_creators.data) and the app looks a beat up by its index.
--
-- Process state on lynxr_posts (shape_state) is process state only, never data derived from a video — the rule post_match.sql and
-- platform_insights.sql already state. Every existing post starts at 'pending', which is true.
--
-- TRUST BOUNDARY. A creator may read their own numbers (harmless: they are measurements of their own video). Nobody but the pipeline
-- writes. Nothing here is joined into lynxr_sources, lynxr_videos, the agency app, process_campaigns.py or any cross-creator number.
-- The coach's tier-trimmed prose is a different table (supabase/coach.sql).

do $$ begin
  if to_regclass('public.lynxr_posts') is null then
    raise exception 'public.lynxr_posts missing — run supabase/post_tracking.sql first';
  end if;
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
end $$;

-- ── process state on lynxr_posts ──────────────────────────────────────────────────────────────────
--   pending   not shaped yet (every existing post starts here)      ok        shaped: a lynxr_post_shape row exists
--   failed    audio could not be fetched or measured (retried)      skipped   the link is not a plain https link on its own platform
--   too_long  longer than a short-form video: not transcribed
alter table public.lynxr_posts add column if not exists shape_state text not null default 'pending'
  check (shape_state in ('pending','ok','failed','skipped','too_long'));
alter table public.lynxr_posts add column if not exists shape_at timestamptz;
alter table public.lynxr_posts add column if not exists shape_fails int not null default 0;
create index if not exists lynxr_posts_shape_idx on public.lynxr_posts (posted_at desc)
  where shape_state in ('pending','failed');

-- ── the measurements ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.lynxr_post_shape (
  post_id              bigint primary key references public.lynxr_posts(id) on delete cascade,
  creator_id           uuid not null references auth.users(id) on delete cascade,
  built_at             timestamptz not null default now(),
  whisper              text check (whisper is null or length(whisper) <= 80),   -- the model used, so a later swap is visible
  has_speech           boolean not null,
  segments             int not null check (segments >= 0),                        -- how many transcript segments; no words
  duration_s           numeric(6,1) check (duration_s is null or duration_s > 0),
  speech_start_s       numeric(5,1) check (speech_start_s is null or speech_start_s >= 0),
  words_first_3s       int check (words_first_3s is null or words_first_3s >= 0),
  longest_silence_s    numeric(5,1) check (longest_silence_s is null or longest_silence_s >= 0),
  longest_silence_at_s numeric(6,1) check (longest_silence_at_s is null or longest_silence_at_s >= 0),
  best_line_at_s       numeric(6,1) check (best_line_at_s is null or best_line_at_s >= 0),   -- the second the line with the most numbers and names starts
  -- Which of the creator's own scripts the beat times below were measured against (lynxr_posts.adaptation_id at the time). A post
  -- linked to a script AFTER it was shaped is shaped again, because this no longer matches. An id, never script text.
  aligned_to           text check (aligned_to is null or length(aligned_to) between 1 and 100),
  -- [{"i":1,"of":5,"kind":"beat","start_s":0.4,"end_s":3.1,"planned_s":0}, {"i":3,"of":5,"kind":"beat","found":false}, ...]; a beat the script's
  -- format names as its payoff also carries "payoff": true (the flag only: the role's words are never stored)
  beats                jsonb check (beats is null or (jsonb_typeof(beats) = 'array' and jsonb_array_length(beats) <= 24)),
  -- [{"at_s":6.1,"of_s":1.4}, ...]: a stretch of speech that says again what an earlier stretch said. Two second marks, no words.
  repeats              jsonb check (repeats is null or (jsonb_typeof(repeats) = 'array' and jsonb_array_length(repeats) <= 12))
);
create index if not exists lynxr_post_shape_creator_idx on public.lynxr_post_shape (creator_id);

-- ── Row-level security: read your own, staff read all, nobody but the pipeline writes (the quartet of lynxr_post_views) ─────────────
alter table public.lynxr_post_shape enable row level security;
revoke all on table public.lynxr_post_shape from anon;
revoke insert, update, delete, truncate on table public.lynxr_post_shape from authenticated;
grant select on table public.lynxr_post_shape to authenticated;
drop policy if exists "creator reads own shape" on public.lynxr_post_shape;
create policy "creator reads own shape" on public.lynxr_post_shape
  for select to authenticated using (auth.uid() = creator_id);
drop policy if exists "staff read shapes" on public.lynxr_post_shape;
create policy "staff read shapes" on public.lynxr_post_shape
  for select to authenticated using (public.is_staff());

comment on table public.lynxr_post_shape is
  'Numbers measured from the creator''s own posted video: seconds before anyone speaks, words in the first three seconds, the longest silence, the length, and the second at which each beat of the linked script was said. No transcript, no words, no shot list. Derived and safe to drop: the shape lane rebuilds a deleted row.';

notify pgrst, 'reload schema';

-- Checks to run after it (paste one at a time):
--   nothing measured yet (expect: 0):
--     select count(*) from public.lynxr_post_shape;
--   every existing post is pending (expect: pending, then the post count):
--     select shape_state, count(*) from public.lynxr_posts group by 1 order by 2 desc;
--   nothing writable from a browser role, nothing readable by anon (expect: f, f, f, f):
--     select has_table_privilege('authenticated','public.lynxr_post_shape','insert'),
--            has_table_privilege('authenticated','public.lynxr_post_shape','update'),
--            has_table_privilege('authenticated','public.lynxr_post_shape','delete'),
--            has_table_privilege('anon','public.lynxr_post_shape','select');
--   the two policies (expect: 2 rows):
--     select policyname from pg_policies where schemaname = 'public' and tablename = 'lynxr_post_shape';
--
-- ROLLBACK (drops everything this file added; the tracked posts and their view history are untouched):
--   drop table if exists public.lynxr_post_shape;
--   drop index if exists public.lynxr_posts_shape_idx;
--   alter table public.lynxr_posts drop column if exists shape_fails, drop column if exists shape_at,
--     drop column if exists shape_state;
