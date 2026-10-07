-- Automatic script attribution: the state the matcher keeps on each tracked post, the staff-only log of what it decided, and the
-- staff showcase queue's view of how a post got its script link.
-- Plan: ~/.claude/plans/lynxr-adaptation-id.md (step 1 of ~/.claude/plans/lynxr-one-brain-v1.md)
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/post_tracking.sql, supabase/staff_gate.sql and supabase/showcase.sql (a post is what gets a state; is_staff()
-- gates the log; showcase.sql adds lynxr_posts.script_linked_at, which the matcher writes, and defines the staff queue function
-- redefined at the foot of this file). Run it BEFORE the worker that reads it is deployed: a worker that finds the columns
-- missing logs one line and does nothing, so the order is safe in that direction only.
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- WHAT IT IS. pipeline/track_posts.py (Fly only) finds a new post on a verified profile, downloads its audio, transcribes it with
-- the Whisper the worker already has, and scores the words against that creator's own recent scripts (pipeline/post_match.py).
-- When it is sure it writes lynxr_posts.adaptation_id; everything else is logged here for staff and linked to nothing.
-- PRECISION OVER RECALL: a wrong link teaches the brain a lie nothing can detect, a missed link costs nothing.
--
-- match_state, on lynxr_posts (process state only, never data derived from a video):
--   pending     not scored yet (every existing post starts here)      auto        linked by the matcher
--   borderline  scored, not sure enough: logged, not linked           none        no candidate script, or nothing like one
--   skipped     longer than a short-form video: not transcribed       failed      audio could not be fetched (retried a few times)
-- A creator's own link (link_my_post_script() in showcase.sql) never sets match_state: only the matcher ever writes `auto`.
-- One consequence worth knowing: unmarking an auto-link leaves match_state at `auto` (so the matcher can never re-link it), and a
-- later link by hand to a different script would still read `auto`. The staff queue then over-labels a creator's link as
-- machine-made, which is the safe direction. Rolling back by SQL (foot of file) sets match_state to `none`.
--
-- TRUST BOUNDARY. lynxr_match_log is read by staff and written only by the pipeline (service role). A creator has no policy on it
-- at all. Nothing here may be joined into lynxr_sources, lynxr_videos, the agency app or any cross-creator number.
--
-- NO TRANSCRIPTS, EVER. The log holds numbers and script ids. Re-tuning re-downloads, which is free.

do $$ begin
  if to_regclass('public.lynxr_posts') is null then
    raise exception 'public.lynxr_posts missing — run supabase/post_tracking.sql first';
  end if;
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'lynxr_posts' and column_name = 'script_linked_at') then
    raise exception 'public.lynxr_posts.script_linked_at missing — run supabase/showcase.sql first';
  end if;
  if to_regprocedure('public.staff_showcase_candidates()') is null then
    raise exception 'public.staff_showcase_candidates() missing — run supabase/showcase.sql first';
  end if;
end $$;

-- Process state, not video data. The default backfills every existing post as 'pending', which is correct: none has been scored.
alter table public.lynxr_posts add column if not exists match_state text not null default 'pending'
  check (match_state in ('pending','auto','borderline','none','skipped','failed'));
alter table public.lynxr_posts add column if not exists match_tries int not null default 0;
alter table public.lynxr_posts add column if not exists match_at timestamptz;
create index if not exists lynxr_posts_match_idx on public.lynxr_posts (posted_at desc)
  where match_state = 'pending';

create table if not exists public.lynxr_match_log (
  id                    bigint generated always as identity primary key,
  at                    timestamptz not null default now(),
  post_id               bigint not null references public.lynxr_posts(id) on delete cascade,
  creator_id            uuid not null references auth.users(id) on delete cascade,
  decision              text not null check (decision in ('auto','borderline','none')),
  best_adaptation_id    text check (best_adaptation_id is null or length(best_adaptation_id) <= 100),
  best_score            real,
  second_score          real,
  features              jsonb not null default '{}'::jsonb,
  candidates            jsonb not null default '[]'::jsonb,
  verdict               text check (verdict is null or verdict in ('match','not_match','unsure')),
  verdict_adaptation_id text check (verdict_adaptation_id is null or length(verdict_adaptation_id) <= 100),
  reviewed_at           timestamptz
);
create index if not exists lynxr_match_log_review_idx
  on public.lynxr_match_log (decision, at desc) where verdict is null;

-- Row-level security: staff read, nobody but the pipeline writes, and there is no creator policy at all.
alter table public.lynxr_match_log enable row level security;
revoke all on table public.lynxr_match_log from anon;
revoke insert, update, delete, truncate on table public.lynxr_match_log from authenticated;
grant select on table public.lynxr_match_log to authenticated;
drop policy if exists "staff read match log" on public.lynxr_match_log;
create policy "staff read match log" on public.lynxr_match_log
  for select to authenticated using (public.is_staff());

comment on table public.lynxr_match_log is
  'Staff review only: what the automatic script matcher decided for each tracked post. Numbers and script ids, never transcript text, never a caption, never a handle. Rows die with the post and with the account. Nothing here may be joined into lynxr_sources, lynxr_videos, the agency app or any cross-creator number.';

-- The staff showcase queue, with how each post got its script link. REPLACES the function of the same name in showcase.sql
-- (identical except for the three fields marked NEW), so it runs here, in the file the owner applies for this change. Re-running
-- showcase.sql afterwards puts the old version back: run this file again after it.
--   match_state  the post's state ('auto' = the matcher linked it; anything else = the creator did)
--   link_by      'machine' or 'creator', the plain word staff should read before approving
--   match_score  the matcher's score for that link, from the newest 'auto' log row for the same script (null for a creator's link)
-- Staff approve every entry by hand, and for an auto-link they are checking the LINK as well as the video.
create or replace function public.staff_showcase_candidates()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(c.j order by c.views desc nulls last)
      from (select p.views,
                   jsonb_build_object(
                     'post_id', p.id, 'platform', p.platform, 'handle', p.handle, 'url', p.url,
                     'posted_at', p.posted_at, 'views', p.views, 'metrics_at', p.metrics_at,
                     'script_at', sc.charged_at,
                     'again', (e.id is not null),
                     'match_state', p.match_state,                                                      -- NEW
                     'link_by', case when p.match_state = 'auto' then 'machine' else 'creator' end,     -- NEW
                     'match_score', (select l.best_score from public.lynxr_match_log l                 -- NEW
                                      where l.post_id = p.id and l.decision = 'auto'
                                        and l.best_adaptation_id = p.adaptation_id
                                      order by l.at desc limit 1),
                     'hint', case
                               when exists (select 1 from public.lynxr_roster r
                                             where r.creator_id = p.creator_id and r.status = 'accepted') then 'agency'
                               when exists (select 1 from public.lynxr_billing b
                                             where b.creator_id = p.creator_id and b.provider = 'comp') then 'comp'
                               else 'none' end) j
              from public.lynxr_posts p
              join public.lynxr_script_charges sc on sc.adaptation_id = p.adaptation_id and sc.creator_id = p.creator_id
              join public.lynxr_showcase_consent co on co.creator_id = p.creator_id and co.featured
              left join public.lynxr_showcase_entries e on e.post_id = p.id
             where p.adaptation_id is not null and p.handle is not null
               and not exists (select 1 from public.lynxr_staff s where s.id = p.creator_id)
               and (e.id is null or e.status = 'withdrawn')
             order by p.views desc nulls last
             limit 50) c), '[]'::jsonb);
end $$;
revoke all on function public.staff_showcase_candidates() from public, anon;
grant execute on function public.staff_showcase_candidates() to authenticated;

notify pgrst, 'reload schema';

-- Checks to run after it (paste one at a time):
--   every post now has a match state, and the backfill landed:
--     select match_state, count(*) from public.lynxr_posts group by 1 order by 2 desc;
--   THE PROOF, once the worker has run: a real post carrying the id of the script that produced it:
--     select id, platform, posted_at, adaptation_id, match_state, script_linked_at
--       from public.lynxr_posts where match_state = 'auto' order by script_linked_at desc limit 10;
--   the near misses the thresholds have to be tuned against:
--     select id, at, post_id, decision, best_score, second_score, features
--       from public.lynxr_match_log where verdict is null order by decision, at desc limit 50;
--   the log is staff-only (expect: one row, "staff read match log"):
--     select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'lynxr_match_log';
--   no creator or visitor can reach it (expect: f, f):
--     select has_table_privilege('anon', 'public.lynxr_match_log', 'select'),
--            has_table_privilege('anon', 'public.lynxr_match_log', 'insert');
--   the staff queue carries the link's origin (expect: t):
--     select pg_get_functiondef('public.staff_showcase_candidates()'::regprocedure) like '%link_by%';
--   the queue function is still executable by staff and not by visitors (expect: f):
--     select has_function_privilege('anon', 'public.staff_showcase_candidates()', 'execute');
--
-- Marking a judgement in the log (the review loop, by hand, one row at a time):
--   update public.lynxr_match_log
--      set verdict = 'match', verdict_adaptation_id = '<script id>', reviewed_at = now()
--    where id = <log id>;
--
-- Safety valve — undo one wrong link, or every auto-link (a creator's own links are never match_state = 'auto'):
--   update public.lynxr_posts set adaptation_id = null, script_linked_at = null, match_state = 'none' where id = <post id>;
--   update public.lynxr_posts set adaptation_id = null, script_linked_at = null, match_state = 'none' where match_state = 'auto';
--   An undone link that was already approved for the showcase must be withdrawn there too (staff queue, or
--   update public.lynxr_showcase_entries set status = 'withdrawn', cover_path = null where post_id = <post id> and status = 'approved';).
