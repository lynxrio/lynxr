-- Brief-level matching: which agency brief a tracked post was made for, kept where only staff can read it.
-- Plan: ~/.claude/plans/lynxr-loop-v2.md (Part 2). Builds on supabase/post_match.sql and supabase/agency_roster.sql.
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/post_tracking.sql, supabase/staff_gate.sql, supabase/post_match.sql and supabase/agency_roster.sql, and BEFORE the
-- push that deploys the worker reading it (a worker that meets the missing function treats the brief half as off).
-- **No real email, uuid, handle or brand in this file — the repo is public.**
--
-- WHAT IT IS. pipeline/track_posts.py's match lane transcribes a new post and scores it against the creator's own scripts. With
-- TRACK_BRIEF=1 it also scores the same in-memory words against every format of every brief DELIVERED to that creator
-- (pipeline/brief_match.py), whether or not they pressed "Add to my library", and decides at the brief/campaign level when formats of
-- one brief tie. lynxr_posts.adaptation_id still means "the creator's own script"; a brief link never goes there.
--
-- STAFF ONLY. lynxr_post_briefs has no creator policy at all, and the creator's brain, coach and writer never read it.
-- NO TRANSCRIPTS, EVER: ids, scores and one path word.

do $$ begin
  if to_regclass('public.lynxr_posts') is null then
    raise exception 'public.lynxr_posts missing — run supabase/post_tracking.sql first';
  end if;
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
  if to_regclass('public.lynxr_match_log') is null then
    raise exception 'public.lynxr_match_log missing — run supabase/post_match.sql first';
  end if;
  if to_regclass('public.lynxr_agency_deliveries') is null or to_regclass('public.lynxr_agency_briefs') is null then
    raise exception 'agency tables missing — run supabase/agency_roster.sql first';
  end if;
end $$;

-- path: script = the creator's own library copy of a brief format was auto-linked (adaptation_id set too); format = a delivered format
-- won outright; brief = brief/campaign level, format_id only when one format clearly led; staff = reserved for a link made by hand.
create table if not exists public.lynxr_post_briefs (
  post_id       bigint primary key references public.lynxr_posts(id) on delete cascade,
  creator_id    uuid not null references auth.users(id) on delete cascade,
  brief_id      uuid not null references public.lynxr_agency_briefs(id) on delete cascade,
  format_id     text check (format_id is null or length(format_id) <= 2048),        -- a legacy brief's format id is its source URL
  adaptation_id text check (adaptation_id is null or length(adaptation_id) <= 100),
  path          text not null check (path in ('script','format','brief','staff')),
  score         real,
  linked_at     timestamptz not null default now()
);
create index if not exists lynxr_post_briefs_brief_idx on public.lynxr_post_briefs (brief_id);
create index if not exists lynxr_post_briefs_creator_idx on public.lynxr_post_briefs (creator_id);

alter table public.lynxr_post_briefs enable row level security;
revoke all on table public.lynxr_post_briefs from anon;
revoke insert, update, delete, truncate on table public.lynxr_post_briefs from authenticated;
grant select on table public.lynxr_post_briefs to authenticated;
drop policy if exists "staff read post briefs" on public.lynxr_post_briefs;
create policy "staff read post briefs" on public.lynxr_post_briefs
  for select to authenticated using (public.is_staff());

comment on table public.lynxr_post_briefs is
  'Staff only: which agency brief a tracked post was made for, worked out by the match lane. Ids, a score and a path word; never a transcript or caption. Derived: re-scoring rebuilds it. Never read by the creator brain, the coach or the writer.';

-- The brief half of each match decision, beside the script half the log already holds. Numbers and ids only.
alter table public.lynxr_match_log add column if not exists brief_id uuid;
alter table public.lynxr_match_log add column if not exists brief_path text check (brief_path is null or brief_path in ('script','format','brief'));
alter table public.lynxr_match_log add column if not exists brief jsonb not null default '{}'::jsonb;

-- What the matcher scores against, assembled here so the worker never pulls a whole brief doc. Service role only.
create or replace function public.brief_corpus_for(p_creator uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'brief_id', b.id,
           'client_name', coalesce(nullif(b.doc->'client'->>'name', ''), b.client_name),
           'group', case when coalesce(b.source_id, '') <> '' then b.source_kind || ':' || b.source_id else 'brief:' || b.id::text end,
           'sent_at', d.sent_at,
           'formats', coalesce((select jsonb_agg(jsonb_build_object(
                                   'id', f->>'id',
                                   'delivery', coalesce(f->>'delivery', ''),
                                   'hook', coalesce(f->>'hook', ''),
                                   'cta', coalesce(f->>'cta', ''),
                                   'caption', coalesce(f->>'caption', ''),
                                   'beats', coalesce((select jsonb_agg(jsonb_build_object('say', coalesce(bt->>'say', '')))
                                                        from jsonb_array_elements(coalesce(f->'beats', '[]'::jsonb)) bt), '[]'::jsonb)))
                                  from jsonb_array_elements(coalesce(b.doc->'formats', '[]'::jsonb)) f
                                 where coalesce(f->>'id', '') <> ''), '[]'::jsonb))
         order by d.sent_at desc), '[]'::jsonb)
    from public.lynxr_agency_deliveries d
    join public.lynxr_agency_briefs b on b.id = d.brief_id
   where d.creator_id = p_creator and d.revoked_at is null;
$$;
revoke all on function public.brief_corpus_for(uuid) from public, anon, authenticated;
grant execute on function public.brief_corpus_for(uuid) to service_role;

-- What the agency app draws under a brief: the posts linked to it. Staff only (the is_staff() check is the only gate: security definer).
create or replace function public.staff_brief_posts(p_briefs uuid[])
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'post_id', p.id, 'brief_id', pb.brief_id, 'creator_id', pb.creator_id,
             'platform', p.platform, 'url', p.url, 'posted_at', p.posted_at, 'views', p.views,
             'views7', (select v.views from public.lynxr_post_views v
                         where v.post_id = p.id and v.views is not null and v.day between 7 and 10
                         order by v.day limit 1),
             'path', pb.path, 'format_id', pb.format_id, 'score', pb.score, 'linked_at', pb.linked_at,
             'format_title', (select f->>'title' from jsonb_array_elements(coalesce(b.doc->'formats', '[]'::jsonb)) f
                               where f->>'id' = pb.format_id limit 1))
           order by p.posted_at desc nulls last)
      from public.lynxr_post_briefs pb
      join public.lynxr_posts p on p.id = pb.post_id
      join public.lynxr_agency_briefs b on b.id = pb.brief_id
     where pb.brief_id = any(p_briefs)), '[]'::jsonb);
end $$;
revoke all on function public.staff_brief_posts(uuid[]) from public, anon;
grant execute on function public.staff_brief_posts(uuid[]) to authenticated;

notify pgrst, 'reload schema';

-- Checks to run after it (paste one at a time):
--   staff only (expect one row, SELECT):
--     select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'lynxr_post_briefs';
--   no visitor read, no creator write (expect f, f):
--     select has_table_privilege('anon','public.lynxr_post_briefs','select'), has_table_privilege('authenticated','public.lynxr_post_briefs','insert');
--   the corpus is service-role only (expect f, f):
--     select has_function_privilege('anon','public.brief_corpus_for(uuid)','execute'), has_function_privilege('authenticated','public.brief_corpus_for(uuid)','execute');
--   the staff list is not for visitors (expect f):
--     select has_function_privilege('anon','public.staff_brief_posts(uuid[])','execute');
--   the log has the three new columns (expect 3):
--     select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'lynxr_match_log' and column_name in ('brief_id','brief_path','brief');
--   one roster creator's corpus (paste their id; expect an array of briefs, each with formats holding only id/delivery/hook/cta/caption/beats[].say):
--     select public.brief_corpus_for('<ROSTER-CREATOR-UUID>');
--
-- ONE-OFF, run only AFTER the worker that reads this file is deployed AND TRACK_BRIEF=1 is set: re-match the posts scored before
-- delivered formats were candidates. Free (one audio download each, on Fly). Safe to run again to re-score them.
--   update public.lynxr_posts p set match_state = 'pending'
--    where p.adaptation_id is null and p.origin = 'tracked' and p.match_state in ('none','borderline')
--      and p.posted_at > now() - interval '45 days'
--      and exists (select 1 from public.lynxr_agency_deliveries d
--                   where d.creator_id = p.creator_id and d.revoked_at is null and d.sent_at <= p.posted_at + interval '1 hour');
--
-- ROLLBACK (set TRACK_BRIEF=0 on Fly FIRST, or log writes will fail on the dropped columns):
--   drop function if exists public.staff_brief_posts(uuid[]);
--   drop function if exists public.brief_corpus_for(uuid);
--   alter table public.lynxr_match_log drop column if exists brief, drop column if exists brief_path, drop column if exists brief_id;
--   drop table if exists public.lynxr_post_briefs;
