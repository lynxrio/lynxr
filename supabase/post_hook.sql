-- The opening of a POSTED video against lynxr's hook rules: a craft score, the verdict words, and a few second marks. Nothing else.
-- Plan: ~/.claude/plans/lynxr-loop-v2.md (Part 3, step 17), reusing the design of ~/.claude/plans/lynxr-hook-scorer-2.md (part E).
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/post_tracking.sql and supabase/post_shape.sql (a posted-opening row hangs off a tracked post and is made in the
-- shape lane). Run it BEFORE the push that deploys the worker reading it: a worker that finds the columns missing logs one line and does
-- nothing, so the order is safe in that direction only.
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- WHAT IT IS. pipeline/post_hook.py (Fly only, a step of pipeline/post_shape.py's lane) is handed a posted video's transcript while it
-- exists, grades the opening against the rules in pipeline/hook_score.py with ONE model call, and writes the result here. The
-- transcript is never stored: only the numbers and the verdict words below. It is off until HOOK_POST=1 on Fly, and the privacy page
-- must say so first.
--
-- A CRAFT SCORE, NOT A VIEW PREDICTION. pipeline/hook_views.py checks it against views for the owner. Nothing shows it to a creator.
--
-- NO TRANSCRIPTS, EVER. No quote, no promise, no best line and no model reasoning is kept: `verdicts` holds the words pass, partial,
-- fail and n/a under the rule ids; `opener` is one of a fixed list of filler phrases (a check constraint, so a transcript word cannot
-- be stored there even by mistake).
--
-- SERVICE ROLE ONLY. No grant and no policy for any browser role (the pattern of lynxr_coach_notes). The owner reads it in the SQL
-- editor, and nothing in the app reads it.

do $$ begin
  if to_regclass('public.lynxr_posts') is null then raise exception 'public.lynxr_posts missing — run supabase/post_tracking.sql first'; end if;
  if to_regclass('public.lynxr_post_shape') is null then raise exception 'public.lynxr_post_shape missing — run supabase/post_shape.sql first'; end if;
end $$;

-- Process state only (the rule post_shape.sql states): pending = not looked at yet; ok = scored; nospeech = nothing said (no call);
-- failed = the call or the write failed (never retried automatically: set it back to pending by hand); skipped = out of scope
-- (an opted-out creator, or the audio was the song rather than the post).
alter table public.lynxr_posts add column if not exists hook_state text not null default 'pending'
  check (hook_state in ('pending','ok','nospeech','failed','skipped'));
alter table public.lynxr_posts add column if not exists hook_at timestamptz;
create index if not exists lynxr_posts_hook_idx on public.lynxr_posts (posted_at desc) where hook_state = 'pending';

create table if not exists public.lynxr_post_hook (
  post_id        bigint primary key references public.lynxr_posts(id) on delete cascade,
  creator_id     uuid not null references auth.users(id) on delete cascade,
  built_at       timestamptz not null default now(),
  adaptation_id  text check (adaptation_id is null or length(adaptation_id) between 1 and 100),
  rubric_version text not null check (length(rubric_version) <= 40),
  post_sha       text check (post_sha is null or length(post_sha) <= 64),
  scorer_model   text check (scorer_model is null or length(scorer_model) <= 60),
  score          int check (score is null or score between 0 and 100),
  verdicts       jsonb check (verdicts is null or (jsonb_typeof(verdicts) = 'object' and octet_length(verdicts::text) <= 400)),
  reason_line    int check (reason_line is null or reason_line between 0 and 40),
  reason_at_s    numeric(6,1) check (reason_at_s is null or reason_at_s >= 0),
  speech_start_s numeric(5,1) check (speech_start_s is null or speech_start_s >= 0),
  opener         text check (opener is null or opener in ('okay so','ok so','alright so','all right so','so today','so basically','hi guys','hey guys','hi everyone','hey everyone','hello everyone','what''s up guys','hey y''all','so','um','uh','okay','ok')),
  script_score   int check (script_score is null or script_score between 0 and 100),
  script_h1      text check (script_h1 is null or script_h1 in ('pass','partial','fail')),
  usd            numeric(10,6),
  error          text check (error is null or length(error) <= 80)
);
create index if not exists lynxr_post_hook_creator_idx on public.lynxr_post_hook (creator_id);

-- Service role only: NO grant and NO policy for any browser role (the lynxr_coach_notes pattern). The owner reads it in the SQL editor.
alter table public.lynxr_post_hook enable row level security;
revoke all on table public.lynxr_post_hook from anon, authenticated;

comment on table public.lynxr_post_hook is
  'The opening of a posted video against lynxr''s hook rules: a craft score, verdict words and second marks. No transcript, no quote, no model reasoning. Owner analysis only; never shown to creators. Rows die with the post.';

notify pgrst, 'reload schema';

-- Checks to run after it (paste one at a time):
--   every post is pending (expect: pending, then the post count):
--     select hook_state, count(*) from public.lynxr_posts group by 1;
--   nothing scored yet (expect: 0):
--     select count(*) from public.lynxr_post_hook;
--   no browser role can read it (expect: f, f):
--     select has_table_privilege('authenticated','public.lynxr_post_hook','select'), has_table_privilege('anon','public.lynxr_post_hook','select');
--   no policy at all (expect: 0 rows):
--     select policyname from pg_policies where schemaname = 'public' and tablename = 'lynxr_post_hook';
--
-- ROLLBACK (set HOOK_POST=0 on Fly FIRST; the tracked posts and their shapes are untouched):
--   drop table if exists public.lynxr_post_hook;
--   drop index if exists public.lynxr_posts_hook_idx;
--   alter table public.lynxr_posts drop column if exists hook_at, drop column if exists hook_state;
