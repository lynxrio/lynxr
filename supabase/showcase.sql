-- The "made with lynxr" showcase: real videos, with lynxr-measured numbers, shown on the landing page with consent.
-- Plan: ~/.claude/plans/lynxr-showcase.md
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/profiles.sql, post_tracking.sql, staff_gate.sql, allowance_ledger.sql, billing.sql,
-- agency_roster.sql and campaigns.sql (entries hang off posts and formats; the proof of "made with lynxr" is
-- lynxr_script_charges; roster and comp status decide the material-connection label; is_staff() gates staff).
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- TRUST BOUNDARY.
--   anon       EXECUTE on showcase_public() and NOTHING else. No grant on any showcase table, or on any other table.
--   creators   read their own consent row; write only through set_my_showcase_consent(), link_my_post_script()
--              and read through my_showcase(). They can neither read nor write entries, points or the log.
--   staff      read all four tables; write only through the staff_showcase_* functions.
--   pipeline   (service role) writes check results, covers and measured points (pipeline/showcase.py, Fly only).
--
-- WHAT THE PUBLIC SEES. showcase_public() returns approved, consented, checked entries as a fixed field list
-- (at most 12 entries, 16 points each) and, once at least 3 are ready, nothing otherwise. Consent is read live on
-- every call, so a withdrawal disappears at the next page load. The typical figure is the median day-7 views over
-- every tracked non-staff video of the last 120 days, and is null below 30 videos or 5 creators.
--
-- KILL SWITCH (instant; the landing page falls back to its ordinary card):
--   revoke execute on function public.showcase_public() from anon;

-- 2a. Preflight
do $$ begin
  if to_regclass('public.lynxr_posts') is null then
    raise exception 'public.lynxr_posts missing — run supabase/post_tracking.sql first';
  end if;
  if to_regclass('public.lynxr_post_views') is null then
    raise exception 'public.lynxr_post_views missing — run supabase/post_tracking.sql first';
  end if;
  if to_regclass('public.lynxr_profile_followers') is null then
    raise exception 'public.lynxr_profile_followers missing — run supabase/post_tracking.sql first';
  end if;
  if to_regclass('public.lynxr_profiles') is null then
    raise exception 'public.lynxr_profiles missing — run supabase/profiles.sql first';
  end if;
  if to_regclass('public.lynxr_script_charges') is null then
    raise exception 'public.lynxr_script_charges missing — run supabase/allowance_ledger.sql first';
  end if;
  if to_regclass('public.lynxr_staff') is null then
    raise exception 'public.lynxr_staff missing — run supabase/staff_gate.sql first';
  end if;
  if to_regclass('public.lynxr_roster') is null then
    raise exception 'public.lynxr_roster missing — run supabase/agency_roster.sql first';
  end if;
  if to_regclass('public.lynxr_billing') is null then
    raise exception 'public.lynxr_billing missing — run supabase/billing.sql first';
  end if;
  if to_regclass('public.lynxr_campaign_formats') is null then
    raise exception 'public.lynxr_campaign_formats missing — run supabase/campaigns.sql first';
  end if;
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
end $$;

-- 2b. Tables
-- When the creator linked a post to the script it came from (the proof itself is lynxr_script_charges).
alter table public.lynxr_posts add column if not exists script_linked_at timestamptz;

create table if not exists public.lynxr_showcase_consent (
  creator_id    uuid primary key references auth.users(id) on delete cascade,
  featured      boolean not null default false,
  changed_at    timestamptz not null default now(),
  terms_version text check (terms_version is null or length(terms_version) <= 20)
);

create table if not exists public.lynxr_showcase_entries (
  id               bigint generated always as identity primary key,
  pub_id           text not null unique default substr(md5(gen_random_uuid()::text), 1, 12),
  kind             text not null check (kind in ('creator','agency')),
  creator_id       uuid references auth.users(id) on delete cascade,                    -- kind creator
  post_id          bigint unique references public.lynxr_posts(id) on delete cascade,   -- kind creator
  platform         text not null check (platform in ('tiktok','instagram')),
  handle           text not null check (handle ~ '^[a-z0-9._]{1,30}$'),
  url              text not null check (length(url) <= 300),
  canonical_url    text not null check (length(canonical_url) <= 300),
  posted_at        timestamptz,
  made_with        text not null check (made_with in ('creator_linked','staff_confirmed')),
  made_with_note   text check (made_with_note is null or length(made_with_note) between 10 and 500),
  made_with_format uuid references public.lynxr_campaign_formats(id) on delete set null,
  consent_note     text check (consent_note is null or length(consent_note) between 10 and 500),
  consent_on       date,
  sponsor          text check (sponsor in ('none','brand_ok')),
  sponsor_note     text check (sponsor_note is null or length(sponsor_note) between 5 and 500),
  connection       text check (connection in ('none','agency','comp')),
  status           text not null check (status in ('approved','rejected','removed','withdrawn')),
  rank             int not null default 0 check (rank between -100 and 100),
  check_status     text not null default 'pending' check (check_status in ('pending','ok','not_found','mismatch','failed')),
  check_fails      int not null default 0,
  checked_at       timestamptz,
  next_measure_at  timestamptz,
  cover_path       text check (cover_path is null or cover_path ~ '^showcase/[a-f0-9]{12}-[a-f0-9]{16}\.jpg$'),
  added_by         uuid references auth.users(id) on delete set null,
  added_at         timestamptz not null default now(),
  decided_by       uuid references auth.users(id) on delete set null,
  decided_at       timestamptz,
  note             text check (note is null or length(note) <= 500),
  constraint sc_kind_creator check (kind <> 'creator' or (creator_id is not null and post_id is not null and made_with = 'creator_linked')),
  constraint sc_kind_agency check (kind <> 'agency' or (creator_id is null and post_id is null and made_with = 'staff_confirmed'
                                    and made_with_note is not null and consent_note is not null and consent_on is not null)),
  constraint sc_approved_complete check (status <> 'approved' or (sponsor is not null and connection is not null)),
  constraint sc_brand_ok_note check (sponsor is distinct from 'brand_ok' or sponsor_note is not null)
);
create unique index if not exists lynxr_showcase_live_url on public.lynxr_showcase_entries (canonical_url) where status = 'approved';
create index if not exists lynxr_showcase_status_idx on public.lynxr_showcase_entries (status, check_status);

create table if not exists public.lynxr_showcase_points (      -- fresh public reads by the pipeline
  entry_id  bigint not null references public.lynxr_showcase_entries(id) on delete cascade,
  at        timestamptz not null default now(),
  day       int check (day is null or day between 0 and 3650),  -- whole days after posted_at; null if unknown
  views     bigint check (views is null or views >= 0),
  followers bigint check (followers is null or followers >= 0),
  primary key (entry_id, at)
);

create table if not exists public.lynxr_showcase_log (         -- append-only audit trail
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  entry_id   bigint,                                              -- no FK: the history outlives the entry
  creator_id uuid references auth.users(id) on delete set null,
  actor      uuid references auth.users(id) on delete set null,   -- null = the pipeline
  actor_role text not null check (actor_role in ('creator','staff','pipeline')),
  action     text not null check (action in ('consent_on','consent_off','script_linked','script_unlinked','approved',
               'rejected','removed','restored','ranked','noted','added_agency','checked_ok','check_failed','withdrawn')),
  detail     jsonb not null default '{}'::jsonb                   -- never a handle, email or note text
);

-- 2c. Row-level security: creators read their own consent row, staff read everything, nobody but the functions
-- below and the pipeline writes. anon has no grant on any of these tables.
alter table public.lynxr_showcase_consent enable row level security;
alter table public.lynxr_showcase_entries enable row level security;
alter table public.lynxr_showcase_points  enable row level security;
alter table public.lynxr_showcase_log     enable row level security;

revoke all on table public.lynxr_showcase_consent from anon;
revoke all on table public.lynxr_showcase_entries from anon;
revoke all on table public.lynxr_showcase_points  from anon;
revoke all on table public.lynxr_showcase_log     from anon;
revoke insert, update, delete, truncate on table public.lynxr_showcase_consent from authenticated;
revoke insert, update, delete, truncate on table public.lynxr_showcase_entries from authenticated;
revoke insert, update, delete, truncate on table public.lynxr_showcase_points  from authenticated;
revoke insert, update, delete, truncate on table public.lynxr_showcase_log     from authenticated;
grant select on table public.lynxr_showcase_consent to authenticated;
grant select on table public.lynxr_showcase_entries to authenticated;
grant select on table public.lynxr_showcase_points  to authenticated;
grant select on table public.lynxr_showcase_log     to authenticated;

drop policy if exists "creator reads own showcase consent" on public.lynxr_showcase_consent;
create policy "creator reads own showcase consent" on public.lynxr_showcase_consent
  for select to authenticated using (auth.uid() = creator_id);
drop policy if exists "staff read showcase consent" on public.lynxr_showcase_consent;
create policy "staff read showcase consent" on public.lynxr_showcase_consent
  for select to authenticated using (public.is_staff());
drop policy if exists "staff read showcase entries" on public.lynxr_showcase_entries;
create policy "staff read showcase entries" on public.lynxr_showcase_entries
  for select to authenticated using (public.is_staff());
drop policy if exists "staff read showcase points" on public.lynxr_showcase_points;
create policy "staff read showcase points" on public.lynxr_showcase_points
  for select to authenticated using (public.is_staff());
drop policy if exists "staff read showcase log" on public.lynxr_showcase_log;
create policy "staff read showcase log" on public.lynxr_showcase_log
  for select to authenticated using (public.is_staff());
-- No creator policy on entries, points or log: a creator learns their own status only through my_showcase().

comment on table public.lynxr_showcase_consent is
  'Whether a creator lets lynxr feature their videos on lynxr.io. A creator reads their own row; staff read all; written only by set_my_showcase_consent(). anon has no grant.';
comment on table public.lynxr_showcase_entries is
  'Videos approved (or not) for the lynxr.io showcase. Staff read; written only by the staff_showcase_* functions and the pipeline. The public sees a fixed field list through showcase_public() and nothing else. anon has no grant.';
comment on table public.lynxr_showcase_points is
  'Fresh public view/follower counts the pipeline read for a showcase entry. Staff read; the pipeline writes. anon has no grant.';
comment on table public.lynxr_showcase_log is
  'Append-only history of showcase decisions (ids and counts only, never handles or notes). Staff read; written by the functions and the pipeline. anon has no grant.';

-- 2d. The one public function. It is the security core: do not add a field without updating the self-test's exact key
-- list below and parsePayload() in showcase.js.
create or replace function public.showcase_public()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  min_entries constant int := 3;          -- mirrors showcase.js SHOWCASE_MIN
  out_entries jsonb; n int; typ jsonb;
begin
  with live as (
    select e.id, e.pub_id, e.kind, e.creator_id, e.post_id, e.platform, e.handle, e.url, e.posted_at,
           e.cover_path, e.connection, e.rank, e.decided_at
      from public.lynxr_showcase_entries e
     where e.status = 'approved' and e.check_status = 'ok' and e.cover_path is not null
       and (
         (e.kind = 'creator'
           and exists (select 1 from public.lynxr_showcase_consent c where c.creator_id = e.creator_id and c.featured)
           and exists (select 1 from public.lynxr_posts p where p.id = e.post_id and p.adaptation_id is not null)
           and not exists (select 1 from public.lynxr_staff s where s.id = e.creator_id))
         or
         (e.kind = 'agency'   -- a creator's own opt-out in the app also hides agency entries on their verified handle
           and not exists (select 1 from public.lynxr_profiles pr
                            where pr.platform = e.platform and pr.handle = e.handle and pr.verified_at is not null
                              and not exists (select 1 from public.lynxr_showcase_consent c2
                                               where c2.creator_id = pr.creator_id and c2.featured))))
     order by e.rank desc, e.decided_at desc nulls last
     limit 12
  ),
  pts as (     -- measured (day, views) from both sources, one per day, the latest measurement of that day wins
    select distinct on (x.entry_id, x.day) x.entry_id, x.day, x.views, x.at
      from (select l.id entry_id, v.day, v.views, v.at
              from live l join public.lynxr_post_views v on v.post_id = l.post_id
             where l.kind = 'creator' and v.views is not null
            union all
            select p.entry_id, p.day, p.views, p.at
              from public.lynxr_showcase_points p join live l on l.id = p.entry_id
             where p.views is not null and p.day is not null) x
     order by x.entry_id, x.day, x.at desc
  ),
  ranked as (
    select pts.*, row_number() over (partition by entry_id order by day) ra,
                  row_number() over (partition by entry_id order by day desc) rd from pts
  ),
  series as (  -- the first point plus the latest 15
    select entry_id, jsonb_agg(jsonb_build_array(day, views) order by day) pts
      from ranked where ra = 1 or rd <= 15 group by entry_id
  ),
  latest as (  -- the newest views measurement, whatever its day
    select distinct on (y.entry_id) y.entry_id, y.views, y.at
      from (select l.id entry_id, v.views, v.at
              from live l join public.lynxr_post_views v on v.post_id = l.post_id
             where l.kind = 'creator' and v.views is not null
            union all
            select p.entry_id, p.views, p.at
              from public.lynxr_showcase_points p join live l on l.id = p.entry_id
             where p.views is not null) y
     order by y.entry_id, y.at desc
  ),
  fol as (     -- creator: the profile's daily counts; agency: the entry's own points
    select z.entry_id,
           (array_agg(z.followers order by z.on_day asc))[1] f0, min(z.on_day) d0,
           (array_agg(z.followers order by z.on_day desc))[1] f1, max(z.on_day) d1
      from (select l.id entry_id, f.day on_day, f.followers
              from live l join public.lynxr_posts p on p.id = l.post_id
              join public.lynxr_profile_followers f
                on f.creator_id = p.creator_id and f.platform = p.platform and f.handle = p.handle
             where l.kind = 'creator'
            union all
            select p.entry_id, (p.at at time zone 'utc')::date, p.followers
              from public.lynxr_showcase_points p join live l on l.id = p.entry_id
             where l.kind = 'agency' and p.followers is not null) z
     group by z.entry_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.pub_id, 'platform', l.platform, 'handle', l.handle, 'url', l.url, 'cover', l.cover_path,
           'posted', to_char(l.posted_at at time zone 'utc', 'YYYY-MM-DD'),
           'tag', nullif(l.connection, 'none'),
           'views', lt.views, 'views_on', to_char(lt.at at time zone 'utc', 'YYYY-MM-DD'),
           'points', coalesce(s.pts, '[]'::jsonb),
           'followers', case when fo.d1 - fo.d0 >= 7 then jsonb_build_object(
                          'from', fo.f0, 'from_on', to_char(fo.d0, 'YYYY-MM-DD'),
                          'to', fo.f1, 'to_on', to_char(fo.d1, 'YYYY-MM-DD')) end
         ) order by l.rank desc, l.decided_at desc nulls last), '[]'::jsonb), count(*)
    into out_entries, n
    from live l join latest lt on lt.entry_id = l.id
    left join series s on s.entry_id = l.id
    left join fol fo on fo.entry_id = l.id;

  select case when count(*) >= 30 and count(distinct d.creator_id) >= 5 then jsonb_build_object(
              'views', round(percentile_cont(0.5) within group (order by d.views))::bigint, 'n', count(*), 'day', 7) end
    into typ
    from (select distinct on (p.id) p.id, p.creator_id, v.views
            from public.lynxr_posts p join public.lynxr_post_views v on v.post_id = p.id
           where p.posted_at > now() - interval '120 days' and v.day between 7 and 10 and v.views is not null
             and not exists (select 1 from public.lynxr_staff s where s.id = p.creator_id)
           order by p.id, v.day) d;

  return jsonb_build_object('v', 1, 'typical', typ,
                            'entries', case when n >= min_entries then out_entries else '[]'::jsonb end);
end $$;
revoke all on function public.showcase_public() from public;
grant execute on function public.showcase_public() to anon, authenticated;

-- 2e. Creator functions. Each acts on auth.uid() alone.
create or replace function public.set_my_showcase_consent(p_on boolean, p_terms text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  on_ boolean := coalesce(p_on, false);
  n   int := 0;
begin
  if uid is null then raise exception 'not signed in'; end if;
  insert into public.lynxr_showcase_consent (creator_id, featured, changed_at, terms_version)
  values (uid, on_, now(), left(p_terms, 20))
  on conflict (creator_id) do update
    set featured = excluded.featured, changed_at = excluded.changed_at, terms_version = excluded.terms_version;
  if not on_ then
    -- withdrawn is for good: turning it back on puts the videos back in the staff queue, and staff approve each again
    update public.lynxr_showcase_entries
       set status = 'withdrawn', cover_path = null, decided_at = now(), decided_by = uid
     where creator_id = uid and status = 'approved';
    get diagnostics n = row_count;
  end if;
  insert into public.lynxr_showcase_log (creator_id, actor, actor_role, action, detail)
  values (uid, uid, 'creator', case when on_ then 'consent_on' else 'consent_off' end,
          jsonb_build_object('withdrawn', n));
  return jsonb_build_object('ok', true, 'featured', on_, 'withdrawn', n);
end $$;
revoke all on function public.set_my_showcase_consent(boolean, text) from public, anon;
grant execute on function public.set_my_showcase_consent(boolean, text) to authenticated;

create or replace function public.link_my_post_script(p_post_id bigint, p_adaptation_id text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  p   public.lynxr_posts;
  aid text := nullif(trim(coalesce(p_adaptation_id, '')), '');
  ch  timestamptz;
begin
  if uid is null then raise exception 'not signed in'; end if;
  select * into p from public.lynxr_posts where id = p_post_id and creator_id = uid;
  if not found then return jsonb_build_object('ok', false, 'why', 'no_post'); end if;

  if aid is null then                       -- unmark
    update public.lynxr_posts set adaptation_id = null, script_linked_at = null where id = p.id;
    update public.lynxr_showcase_entries
       set status = 'withdrawn', cover_path = null, decided_at = now(), decided_by = uid
     where post_id = p.id and status = 'approved';
    insert into public.lynxr_showcase_log (creator_id, actor, actor_role, action, detail)
    values (uid, uid, 'creator', 'script_unlinked', jsonb_build_object('post_id', p.id));
    return jsonb_build_object('ok', true);
  end if;

  -- the proof: a script lynxr charged THIS account for. The creator cannot write lynxr_script_charges.
  select c.charged_at into ch from public.lynxr_script_charges c where c.adaptation_id = aid and c.creator_id = uid;
  if not found then return jsonb_build_object('ok', false, 'why', 'no_record'); end if;
  if p.posted_at is not null and ch > p.posted_at then
    return jsonb_build_object('ok', false, 'why', 'after_post');
  end if;
  update public.lynxr_posts set adaptation_id = aid, script_linked_at = now() where id = p.id;
  insert into public.lynxr_showcase_log (creator_id, actor, actor_role, action, detail)
  values (uid, uid, 'creator', 'script_linked', jsonb_build_object('post_id', p.id));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.link_my_post_script(bigint, text) from public, anon;
grant execute on function public.link_my_post_script(bigint, text) to authenticated;

-- Stable, not volatile: it only reads. (plpgsql rather than sql so a signed-out caller gets the same 'not signed in'.)
create or replace function public.my_showcase()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in'; end if;
  return jsonb_build_object(
    'featured',   coalesce((select c.featured from public.lynxr_showcase_consent c where c.creator_id = uid), false),
    'changed_at', (select c.changed_at from public.lynxr_showcase_consent c where c.creator_id = uid),
    'approved',   coalesce((select jsonb_agg(e.post_id order by e.post_id)
                              from public.lynxr_showcase_entries e
                             where e.creator_id = uid and e.status = 'approved'
                               and e.check_status = 'ok' and e.cover_path is not null), '[]'::jsonb));
end $$;
revoke all on function public.my_showcase() from public, anon;
grant execute on function public.my_showcase() to authenticated;

-- 2f. Staff functions. Each first checks is_staff(). Every write logs one row (ids only, never a handle or note text).
-- Returns are {"ok":true,...} or {"ok":false,"why":"<code>"}; app.js maps the codes to sentences.
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

create or replace function public.staff_showcase_decide(
  p_post_id bigint, p_decision text, p_connection text, p_sponsor text, p_sponsor_note text, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid  uuid := auth.uid();
  p    public.lynxr_posts;
  hint text;
  snote text := nullif(trim(coalesce(p_sponsor_note, '')), '');
  approving boolean := (p_decision = 'approve');
  eid  bigint;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  if p_decision is null or p_decision not in ('approve','reject') then
    return jsonb_build_object('ok', false, 'why', 'bad_choice');
  end if;

  -- re-check every candidate condition: consent or the script link may have changed since the list was loaded
  select pp.* into p
    from public.lynxr_posts pp
   where pp.id = p_post_id and pp.adaptation_id is not null and pp.handle is not null
     and exists (select 1 from public.lynxr_script_charges sc
                  where sc.adaptation_id = pp.adaptation_id and sc.creator_id = pp.creator_id)
     and exists (select 1 from public.lynxr_showcase_consent co where co.creator_id = pp.creator_id and co.featured)
     and not exists (select 1 from public.lynxr_staff s where s.id = pp.creator_id)
     and not exists (select 1 from public.lynxr_showcase_entries e where e.post_id = pp.id and e.status <> 'withdrawn');
  if not found then return jsonb_build_object('ok', false, 'why', 'not_candidate'); end if;

  if approving then
    hint := case
              when exists (select 1 from public.lynxr_roster r where r.creator_id = p.creator_id and r.status = 'accepted') then 'agency'
              when exists (select 1 from public.lynxr_billing b where b.creator_id = p.creator_id and b.provider = 'comp') then 'comp'
              else 'none' end;
    if p_connection is null or p_connection not in ('none','agency','comp')
       or p_sponsor is null or p_sponsor not in ('none','brand_ok') then
      return jsonb_build_object('ok', false, 'why', 'bad_choice');
    end if;
    if hint <> 'none' and p_connection = 'none' then
      return jsonb_build_object('ok', false, 'why', 'connection_hidden');
    end if;
    if p_sponsor = 'brand_ok' and (snote is null or length(snote) < 5) then
      return jsonb_build_object('ok', false, 'why', 'brand_note');
    end if;
    if exists (select 1 from public.lynxr_showcase_entries e
                where e.canonical_url = p.canonical_url and e.status = 'approved' and e.post_id is distinct from p.id) then
      return jsonb_build_object('ok', false, 'why', 'duplicate');
    end if;
  end if;

  insert into public.lynxr_showcase_entries
    (kind, creator_id, post_id, platform, handle, url, canonical_url, posted_at, made_with,
     status, sponsor, sponsor_note, connection, note, added_by, decided_by, decided_at)
  values
    ('creator', p.creator_id, p.id, p.platform, p.handle, p.url, p.canonical_url, p.posted_at, 'creator_linked',
     case when approving then 'approved' else 'rejected' end,
     case when approving then p_sponsor end,
     case when approving and p_sponsor = 'brand_ok' then left(snote, 500) end,
     case when approving then p_connection end,
     left(p_note, 500), uid, uid, now())
  on conflict (post_id) do update
    set made_with = 'creator_linked', status = excluded.status, sponsor = excluded.sponsor,
        sponsor_note = excluded.sponsor_note, connection = excluded.connection, note = excluded.note,
        check_status = 'pending', check_fails = 0, cover_path = null, next_measure_at = null,
        decided_by = uid, decided_at = now()
  returning id into eid;

  insert into public.lynxr_showcase_log (entry_id, creator_id, actor, actor_role, action, detail)
  values (eid, p.creator_id, uid, 'staff', case when approving then 'approved' else 'rejected' end,
          jsonb_build_object('post_id', p.id));
  return jsonb_build_object('ok', true, 'id', eid);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'why', 'duplicate');
end $$;
revoke all on function public.staff_showcase_decide(bigint, text, text, text, text, text) from public, anon;
grant execute on function public.staff_showcase_decide(bigint, text, text, text, text, text) to authenticated;

create or replace function public.staff_showcase_add_agency(
  p_url text, p_handle text, p_consent_note text, p_consent_on date, p_made_with_note text, p_format_id uuid,
  p_sponsor text, p_sponsor_note text, p_connection text, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid   uuid := auth.uid();
  u     text := regexp_replace(trim(coalesce(p_url, '')), '[?#].*$', '');
  m     text[];
  plat  text;
  h     text;
  given text := nullif(lower(regexp_replace(trim(coalesce(p_handle, '')), '^@', '')), '');
  canon text;
  snote text := nullif(trim(coalesce(p_sponsor_note, '')), '');
  cnote text := trim(coalesce(p_consent_note, ''));
  mnote text := trim(coalesce(p_made_with_note, ''));
  eid   bigint;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;

  m := regexp_match(lower(u), '^https://www\.tiktok\.com/@([a-z0-9._]{1,30})/video/[0-9]{5,25}/?$');
  if m is not null then
    plat := 'tiktok'; h := m[1]; canon := regexp_replace(lower(u), '/$', '');
    if given is not null and given <> h then return jsonb_build_object('ok', false, 'why', 'handle_mismatch'); end if;
  elsif u ~ '^https://www\.instagram\.com/(reel|reels|p)/[A-Za-z0-9_-]{5,40}/?$' then
    plat := 'instagram'; h := given; canon := regexp_replace(u, '/$', '');
    if h is null or h !~ '^[a-z0-9._]{1,30}$' then return jsonb_build_object('ok', false, 'why', 'bad_handle'); end if;
  else
    return jsonb_build_object('ok', false, 'why', 'bad_url');
  end if;

  if length(cnote) not between 10 and 500 or p_consent_on is null or p_consent_on > current_date then
    return jsonb_build_object('ok', false, 'why', 'consent');
  end if;
  if length(mnote) not between 10 and 500 then return jsonb_build_object('ok', false, 'why', 'made_with'); end if;
  if p_format_id is not null
     and not exists (select 1 from public.lynxr_campaign_formats f where f.id = p_format_id) then
    return jsonb_build_object('ok', false, 'why', 'format');
  end if;
  if p_sponsor is null or p_sponsor not in ('none','brand_ok') or p_connection is null or p_connection not in ('none','agency','comp') then
    return jsonb_build_object('ok', false, 'why', 'bad_choice');
  end if;
  if p_sponsor = 'brand_ok' and (snote is null or length(snote) < 5) then
    return jsonb_build_object('ok', false, 'why', 'brand_note');
  end if;

  if exists (select 1 from public.lynxr_showcase_entries e where e.canonical_url = canon and e.status = 'approved') then
    return jsonb_build_object('ok', false, 'why', 'duplicate');
  end if;
  -- a creator with a verified lynxr profile on this handle must opt in themselves
  if exists (select 1 from public.lynxr_profiles pr
              where pr.platform = plat and pr.handle = h and pr.verified_at is not null
                and not exists (select 1 from public.lynxr_showcase_consent c where c.creator_id = pr.creator_id and c.featured)) then
    return jsonb_build_object('ok', false, 'why', 'has_account_no_consent');
  end if;

  insert into public.lynxr_showcase_entries
    (kind, platform, handle, url, canonical_url, made_with, made_with_note, made_with_format, consent_note, consent_on,
     sponsor, sponsor_note, connection, status, next_measure_at, added_by, decided_by, decided_at, note)
  values
    ('agency', plat, h, canon, canon, 'staff_confirmed', left(mnote, 500), p_format_id, left(cnote, 500), p_consent_on,
     p_sponsor, case when p_sponsor = 'brand_ok' then left(snote, 500) end, p_connection, 'approved', now(), uid, uid, now(),
     left(p_note, 500))
  returning id into eid;

  insert into public.lynxr_showcase_log (entry_id, actor, actor_role, action, detail)
  values (eid, uid, 'staff', 'added_agency', '{}'::jsonb);
  return jsonb_build_object('ok', true, 'id', eid);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'why', 'duplicate');
end $$;
revoke all on function public.staff_showcase_add_agency(text, text, text, date, text, uuid, text, text, text, text) from public, anon;
grant execute on function public.staff_showcase_add_agency(text, text, text, date, text, uuid, text, text, text, text) to authenticated;

create or replace function public.staff_showcase_set(p_id bigint, p_action text, p_rank int, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  e   public.lynxr_showcase_entries;
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
  select * into e from public.lynxr_showcase_entries where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'why', 'not_found'); end if;

  if p_action = 'remove' then
    update public.lynxr_showcase_entries
       set status = 'removed', cover_path = null, decided_by = uid, decided_at = now() where id = e.id;
    insert into public.lynxr_showcase_log (entry_id, creator_id, actor, actor_role, action)
    values (e.id, e.creator_id, uid, 'staff', 'removed');
  elsif p_action = 'restore' then
    if e.status not in ('removed','rejected') then return jsonb_build_object('ok', false, 'why', 'bad_choice'); end if;
    if e.kind = 'creator' and not (
         exists (select 1 from public.lynxr_showcase_consent c where c.creator_id = e.creator_id and c.featured)
         and exists (select 1 from public.lynxr_posts p where p.id = e.post_id and p.adaptation_id is not null)) then
      return jsonb_build_object('ok', false, 'why', 'no_consent');
    end if;
    update public.lynxr_showcase_entries
       set status = 'approved', check_status = 'pending', check_fails = 0, cover_path = null, next_measure_at = null,
           decided_by = uid, decided_at = now() where id = e.id;
    insert into public.lynxr_showcase_log (entry_id, creator_id, actor, actor_role, action)
    values (e.id, e.creator_id, uid, 'staff', 'restored');
  elsif p_action = 'rank' then
    update public.lynxr_showcase_entries set rank = greatest(-100, least(100, coalesce(p_rank, 0))) where id = e.id;
    insert into public.lynxr_showcase_log (entry_id, creator_id, actor, actor_role, action)
    values (e.id, e.creator_id, uid, 'staff', 'ranked');
  elsif p_action = 'note' then
    update public.lynxr_showcase_entries set note = left(p_note, 500) where id = e.id;
    insert into public.lynxr_showcase_log (entry_id, creator_id, actor, actor_role, action)
    values (e.id, e.creator_id, uid, 'staff', 'noted');
  else
    return jsonb_build_object('ok', false, 'why', 'bad_choice');
  end if;
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'why', 'duplicate');
end $$;
revoke all on function public.staff_showcase_set(bigint, text, int, text) from public, anon;
grant execute on function public.staff_showcase_set(bigint, text, int, text) to authenticated;

-- 2g. SELF-TEST. Runs every time this file is run and WRITES NOTHING: the inner block raises LX001 at the end, which
-- rolls back everything it did, and the handler turns that into a NOTICE. Any wrong answer raises a real error
-- instead, and then the whole file is rolled back — fix before re-running. Agency rows only, so no auth.users row.
-- It is skipped when approved entries already exist (the counts below assume an empty showcase).
do $$
declare
  r    jsonb;
  keys text;
  i    int;
  eid  bigint;
  first_id bigint;
begin
  if exists (select 1 from public.lynxr_showcase_entries where status = 'approved') then
    raise notice 'showcase self-test skipped: live entries exist';
    return;
  end if;
  begin
    -- 1. three approved, checked agency entries, each with two measured points 8 days apart
    for i in 1..3 loop
      insert into public.lynxr_showcase_entries
        (kind, platform, handle, url, canonical_url, made_with, made_with_note, consent_note, consent_on,
         sponsor, connection, status, check_status, cover_path)
      values ('agency', 'tiktok', 'selftest' || i,
              'https://www.tiktok.com/@selftest' || i || '/video/1234567890' || i,
              'https://www.tiktok.com/@selftest' || i || '/video/1234567890' || i,
              'staff_confirmed', 'self-test only, rolled back', 'self-test only, rolled back', current_date,
              'none', case when i = 1 then 'agency' else 'none' end, 'approved', 'ok',
              'showcase/00000000000' || i || '-000000000000000' || i || '.jpg')
      returning id into eid;
      if i = 1 then first_id := eid; end if;
      insert into public.lynxr_showcase_points (entry_id, at, day, views, followers)
      values (eid, now() - interval '8 days', 0, 100 * i, 1000), (eid, now(), 8, 5000 * i, 1500);
    end loop;

    -- 2. the public answer: three entries, exactly the documented keys, no typical figure unless real data earns one
    r := public.showcase_public();
    if jsonb_array_length(r->'entries') <> 3 then
      raise exception 'expected 3 entries, got %', jsonb_array_length(r->'entries');
    end if;
    select string_agg(k, ',' order by k) into keys from jsonb_object_keys(r->'entries'->0) k;
    if keys <> 'cover,followers,handle,id,platform,points,posted,tag,url,views,views_on' then
      raise exception 'entry keys are %', keys;
    end if;
    if jsonb_typeof(r->'typical') <> 'null'
       and not ((r->'typical') ? 'views' and (r->'typical') ? 'n' and (r->'typical') ? 'day') then
      raise exception 'typical has the wrong shape: %', r->'typical';
    end if;

    -- 3. below three, nothing is returned
    update public.lynxr_showcase_entries set status = 'removed', cover_path = null where id = first_id;
    r := public.showcase_public();
    if jsonb_array_length(r->'entries') <> 0 then
      raise exception 'fewer than 3 live entries must return none, got %', jsonb_array_length(r->'entries');
    end if;

    -- 4. an approved agency entry without a consent note is refused
    begin
      insert into public.lynxr_showcase_entries
        (kind, platform, handle, url, canonical_url, made_with, made_with_note, sponsor, connection, status)
      values ('agency', 'tiktok', 'selftest9', 'https://www.tiktok.com/@selftest9/video/123456789',
              'https://www.tiktok.com/@selftest9/video/123456789', 'staff_confirmed', 'self-test only, rolled back',
              'none', 'none', 'approved');
      raise exception 'an agency entry without consent was accepted';
    exception when check_violation then null;
    end;

    raise exception 'showcase self-test passed' using errcode = 'LX001';
  exception when sqlstate 'LX001' then
    raise notice 'showcase self-test passed (4 checks) — rolled back, nothing written';
  end;
end $$;

-- 2h. The foot
notify pgrst, 'reload schema';

-- CHECKS (run one at a time; expected answers in the comments).
--   select count(*) from information_schema.tables where table_schema = 'public' and table_name like 'lynxr_showcase_%';   -- 4
--   select has_function_privilege('anon', 'public.showcase_public()', 'execute');                       -- t
--   select has_function_privilege('anon', 'public.staff_showcase_candidates()', 'execute');             -- f
--   select has_function_privilege('anon', 'public.set_my_showcase_consent(boolean,text)', 'execute');   -- f
--   select has_function_privilege('anon', 'public.link_my_post_script(bigint,text)', 'execute');        -- f
--   select public.showcase_public();                                         -- {"v": 1, "entries": [], "typical": null}
-- KILL SWITCH (the landing page falls back to its ordinary card at once):
--   revoke execute on function public.showcase_public() from anon;
-- Bring it back:
--   grant execute on function public.showcase_public() to anon;
