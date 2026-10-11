-- The hook scorer's rows: one per scored script, holding every version of the opening that was graded (the original and any
-- rework), the rubric it was graded against and what the grading cost. Written only by the pipeline (service role).
-- Plan: ~/.claude/plans/lynxr-hook-scorer.md (step 6).
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/staff_gate.sql (public.is_staff). The worker (pipeline/process_adaptations.py, write_hook_score) logs one line
-- and carries on while this table is missing, so running it before or after the push are both safe, and nothing writes here at all
-- until HOOK_SCORE is switched on.
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- WHAT THE NUMBER IS. A craft score from lynxr's own hook rules (pipeline/hook_score.py, rubric_version). It is NOT a prediction of
-- views, watch time or retention, and has not been validated against performance. The model returns pass / partial / fail per rule
-- and code turns those into original_score and final_score.
--
-- WHY IT IS TRAINING-READY. adaptation_id is the same id lynxr_posts.adaptation_id holds, so a score can be put next to what the
-- post earned in one query (below). rubric_version, rubric_sha and rework_sha say exactly which rules and prompts produced a row.

do $$ begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
end $$;

create table if not exists public.lynxr_hook_scores (
  id              bigint generated always as identity primary key,
  creator_id      uuid not null references auth.users(id) on delete cascade,
  adaptation_id   text not null check (length(adaptation_id) between 1 and 100),
  created_at      timestamptz not null default now(),
  mode            text not null check (mode in ('score','rework')),
  outcome         text not null check (outcome in ('scored','above_bar','low_fit','reworked','kept','error','timeout')),
  rubric_version  text not null check (length(rubric_version) <= 40),
  rubric_sha      text check (rubric_sha is null or length(rubric_sha) <= 64),
  rework_sha      text check (rework_sha is null or length(rework_sha) <= 64),
  scorer_model    text check (scorer_model is null or length(scorer_model) <= 60),
  rework_model    text check (rework_model is null or length(rework_model) <= 60),
  threshold       int,
  min_gain        int,
  max_reworks     int,
  original_score  int check (original_score is null or original_score between 0 and 100),
  final_score     int check (final_score is null or final_score between 0 and 100),
  chosen          int not null default 0 check (chosen >= 0),
  hook_changed    boolean not null default false,
  delivery        text check (delivery is null or delivery in ('spoken','silent')),
  format_name     text check (format_name is null or length(format_name) <= 200),
  fit             numeric,
  versions        jsonb not null default '[]'::jsonb check (octet_length(versions::text) <= 65536),
  usage           jsonb not null default '{}'::jsonb,
  seconds         numeric,
  usd             numeric,
  error           text check (error is null or length(error) <= 80)
);
create index if not exists lynxr_hook_scores_adaptation_idx on public.lynxr_hook_scores (adaptation_id, created_at desc);
create index if not exists lynxr_hook_scores_creator_idx on public.lynxr_hook_scores (creator_id, created_at desc);

-- Row-level security: read your own, staff read all, nobody but the pipeline (service role) writes.
alter table public.lynxr_hook_scores enable row level security;

revoke all on table public.lynxr_hook_scores from anon;
revoke insert, update, delete, truncate on table public.lynxr_hook_scores from authenticated;
grant select on table public.lynxr_hook_scores to authenticated;

drop policy if exists "creator reads own hook scores" on public.lynxr_hook_scores;
create policy "creator reads own hook scores" on public.lynxr_hook_scores
  for select to authenticated using (auth.uid() = creator_id);
drop policy if exists "staff read hook scores" on public.lynxr_hook_scores;
create policy "staff read hook scores" on public.lynxr_hook_scores
  for select to authenticated using (public.is_staff());

comment on table public.lynxr_hook_scores is
  'A craft score from lynxr''s hook rules for one script''s opening, not a view prediction. Holds the hook text of each version (the creator''s own script). Deleted with the account through the cascade.';

notify pgrst, 'reload schema';

-- Checks to run after it (paste one at a time):
--   privileges (expect: t, f, f):
--     select has_table_privilege('authenticated','public.lynxr_hook_scores','select'),
--            has_table_privilege('authenticated','public.lynxr_hook_scores','insert'),
--            has_table_privilege('anon','public.lynxr_hook_scores','select');
--   the policies (expect: 2 rows, both select):
--     select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'lynxr_hook_scores' order by 1;
--
-- THE ONE-QUERY CORRELATION: score next to what the post earned a week in (expect 0-1 rows today; only a few posts are linked to a script):
--     with h as (
--       select distinct on (adaptation_id) adaptation_id, creator_id, original_score, final_score, hook_changed, rubric_version, created_at
--       from public.lynxr_hook_scores
--       where outcome in ('scored','above_bar','low_fit','reworked','kept')
--       order by adaptation_id, created_at desc)
--     select h.*, p.platform, p.posted_at, v.views as views_day7
--     from h
--     join public.lynxr_posts p on p.adaptation_id = h.adaptation_id and p.creator_id = h.creator_id
--     left join public.lynxr_post_views v on v.post_id = p.id and v.day = 7;
--
-- ROLLBACK:
--   drop policy if exists "creator reads own hook scores" on public.lynxr_hook_scores;
--   drop policy if exists "staff read hook scores" on public.lynxr_hook_scores;
--   drop table if exists public.lynxr_hook_scores;
