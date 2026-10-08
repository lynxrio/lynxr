-- The coach's note: what lynxr says about a creator's own posted videos, kept where only the service role can write it and only
-- my_coach() can read it, trimmed to the creator's depth BEFORE it leaves the database.
-- Plan: ~/.claude/plans/lynxr-coach-v1.md (step 2).
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/post_tracking.sql, supabase/billing.sql (features_for, entitlement_for) and supabase/post_shape.sql. The worker
-- that writes the note (pipeline/brain.py) logs one line and carries on when this table is missing, so this order is safe and the
-- reverse is merely a no-op.
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- WHY A TABLE OF ITS OWN. lynxr_creator_brain is readable by its owner, so storing the paid depth in it would hand a free creator the
-- pro and max text over the REST API. The note therefore lives here, with NO grant and NO policy for any browser role (the pattern of
-- lynxr_oauth_states in platform_insights.sql), and the only way in is my_coach(), which is security definer and returns less to a
-- free creator than to a pro one, less to a pro one than to max. Only the one-line `working_on[].said` is mirrored into the brain,
-- because the script writer reads it and because a one-line tip is what free is sold.
--
-- WHAT THE NOTE HOLDS. Sentences made from numbers lynxr measured (view counts, seconds, word counts), plus, per video, the moments it
-- can name from the creator's own audio ("second 4.2, where you say again what you said at second 0.8"). It holds no transcript and no
-- script text, and it never says anything about viewers, an audience, a platform or an algorithm: nothing here measures those.
--
-- THE DELETE PROMISE. /data-deletion/ says removing a profile deletes everything found on it and anything derived from it. The note is
-- derived from the posts, so the trigger at the foot deletes it the moment any post of the creator goes (profile removal and account
-- deletion both reach it through the foreign key) and empties the one mirrored line in the brain. The next pass rebuilds it from what
-- is left.

do $$ begin
  if to_regclass('public.lynxr_posts') is null then
    raise exception 'public.lynxr_posts missing — run supabase/post_tracking.sql first';
  end if;
  if to_regprocedure('public.features_for(uuid)') is null or to_regprocedure('public.entitlement_for(uuid)') is null then
    raise exception 'public.features_for / entitlement_for missing — run supabase/billing.sql first';
  end if;
  if to_regclass('public.lynxr_post_shape') is null then
    raise exception 'public.lynxr_post_shape missing — run supabase/post_shape.sql first';
  end if;
end $$;

create table if not exists public.lynxr_coach_notes (
  creator_id uuid primary key references auth.users(id) on delete cascade,
  body       jsonb not null,
  built_at   timestamptz not null default now()
);

alter table public.lynxr_coach_notes enable row level security;
-- Service role only (it bypasses RLS). NO policy and NO grant of any kind to a browser role: the absence is the point. Do not "make it
-- consistent" with the tables that creators read.
revoke all on table public.lynxr_coach_notes from anon, authenticated;

comment on table public.lynxr_coach_notes is
  'The coach''s note for one creator, written by the pipeline and read only through my_coach(), which trims it to the creator''s depth. Numbers and templated sentences only: no transcript, no script text. Derived and safe to drop: the brain lane rebuilds it.';

-- ── the depth rule, in one place ──────────────────────────────────────────────────────────────────
-- Keeps only the named keys of one object. Internal: no browser role may call it, and the definer function below does not need them to.
create or replace function public.coach_pick(p jsonb, keys text[])
returns jsonb language sql immutable set search_path = ''
as $$
  select coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(coalesce(p, '{}'::jsonb)) e where e.key = any(keys)), '{}'::jsonb);
$$;
revoke all on function public.coach_pick(jsonb, text[]) from public, anon, authenticated;

-- my_coach(): copy of my_insights()'s shape (stable, security definer, empty search_path, signed-in only).
--   free  the one tip, and the newest video's one-line read of itself. Nothing else.
--   pro   the tip with its evidence, and every video's read, its numbers against the creator's own median, and the moments in it.
--   max   the whole note, including the raw measurements per video and the tip's history.
-- The depth is the CALLER's, resolved here with the same two functions the rest of billing uses (max = the advanced_coaching feature,
-- pro = the pro plan); both are service-role-only, which is exactly why this function has to be security definer. A free creator
-- calling this directly gets exactly what the app would show them, never the pro text: the trimming is in the database, not in the app.
create or replace function public.my_coach()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  uid   uuid := auth.uid();
  depth text;
  b     jsonb;
  ts    timestamptz;
  ps    jsonb;
  wo    jsonb;
  top   jsonb;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if 'advanced_coaching' = any(public.features_for(uid)) then
    depth := 'max';
  elsif (select e.plan_code from public.entitlement_for(uid) e) = 'pro' then
    depth := 'pro';
  else
    depth := 'free';
  end if;

  select n.body, n.built_at into b, ts from public.lynxr_coach_notes n where n.creator_id = uid;
  if b is null then
    return jsonb_build_object('tier', depth, 'state', 'none');
  end if;
  if depth = 'max' then
    return b || jsonb_build_object('tier', depth, 'built_at', ts);
  end if;

  if depth = 'pro' then
    top := public.coach_pick(b, array['state', 'not_yet', 'platform', 'median_views']);
    select coalesce(jsonb_agg(public.coach_pick(p.value, array['post_id','curve','days','views','from_h','by_h','views7','times_median','verdict','line','prose','moments'])
                              order by p.ord), '[]'::jsonb)
      into ps from jsonb_array_elements(coalesce(b -> 'posts', '[]'::jsonb)) with ordinality p(value, ord);
    select coalesce(jsonb_agg(public.coach_pick(w.value, array['said','because','since']) order by w.ord), '[]'::jsonb)
      into wo from jsonb_array_elements(coalesce(b -> 'working_on', '[]'::jsonb)) with ordinality w(value, ord) where w.ord <= 1;
  else
    top := public.coach_pick(b, array['state', 'not_yet', 'platform']);
    select coalesce(jsonb_agg(public.coach_pick(p.value, array['post_id','curve','days','from_h','by_h','times_median','verdict','line'])
                              order by p.ord), '[]'::jsonb)
      into ps from jsonb_array_elements(coalesce(b -> 'posts', '[]'::jsonb)) with ordinality p(value, ord) where p.ord <= 1;
    select coalesce(jsonb_agg(public.coach_pick(w.value, array['said']) order by w.ord), '[]'::jsonb)
      into wo from jsonb_array_elements(coalesce(b -> 'working_on', '[]'::jsonb)) with ordinality w(value, ord) where w.ord <= 1;
  end if;
  return top || jsonb_build_object('tier', depth, 'built_at', ts, 'working_on', wo, 'posts', ps);
end $$;
revoke all on function public.my_coach() from public, anon;
grant execute on function public.my_coach() to authenticated;

-- ── the delete promise (see the header) ───────────────────────────────────────────────────────────
-- security definer because a creator removing their own profile has no write grant on either table, and must not be given one.
-- Idempotent: deleting an absent note and emptying an already-empty line are both no-ops. Runs through `execute` for the brain, so this
-- file does not hard-require supabase/creator_brain.sql.
create or replace function public.coach_post_deleted()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.lynxr_coach_notes where creator_id = old.creator_id;
  if to_regclass('public.lynxr_creator_brain') is not null then
    execute 'update public.lynxr_creator_brain set body = jsonb_set(body, ''{working_on}'', ''[]''::jsonb) where creator_id = $1 and body ? ''working_on'''
      using old.creator_id;
  end if;
  return old;
end $$;
revoke all on function public.coach_post_deleted() from public, anon, authenticated;

drop trigger if exists lynxr_posts_coach_deleted on public.lynxr_posts;
create trigger lynxr_posts_coach_deleted
  after delete on public.lynxr_posts
  for each row execute function public.coach_post_deleted();

notify pgrst, 'reload schema';

-- Checks to run after it (paste one at a time):
--   nothing readable from a browser role (expect: f, f, f):
--     select has_table_privilege('authenticated','public.lynxr_coach_notes','select'),
--            has_table_privilege('anon','public.lynxr_coach_notes','select'),
--            has_function_privilege('authenticated','public.coach_pick(jsonb,text[])','execute');
--   no policy at all (expect: 0 rows):
--     select policyname from pg_policies where schemaname = 'public' and tablename = 'lynxr_coach_notes';
--   the depth rule, with no note yet, as the owner signed in through the SQL editor's impersonation or from the app's console
--   (expect: {"tier": "max", "state": "none"} for a max account):
--     select public.my_coach();
--   the trim, against a made-up note: free must NOT contain 'because', 'moments', 'shape' or 'prose' (expect: t, t, t, t):
--     with b as (select '{"state":"ready","working_on":[{"said":"a","because":"b"}],"posts":[{"post_id":1,"line":"l","prose":"p","moments":[],"shape":{}}]}'::jsonb as v)
--     select not (public.coach_pick((v -> 'working_on') -> 0, array['said']) ? 'because'),
--            not (public.coach_pick((v -> 'posts') -> 0, array['post_id','line']) ? 'prose'),
--            not (public.coach_pick((v -> 'posts') -> 0, array['post_id','line']) ? 'moments'),
--            not (public.coach_pick((v -> 'posts') -> 0, array['post_id','line']) ? 'shape') from b;
--
-- ROLLBACK:
--   drop trigger if exists lynxr_posts_coach_deleted on public.lynxr_posts;
--   drop function if exists public.coach_post_deleted();
--   drop function if exists public.my_coach();
--   drop function if exists public.coach_pick(jsonb, text[]);
--   drop table if exists public.lynxr_coach_notes;
