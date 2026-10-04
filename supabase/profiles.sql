-- Profiles a creator posts from: public TikTok / Instagram usernames, and the
-- bio-code check that proves each one is theirs.
-- Plan: ~/.claude/plans/lynxr-onboarding-and-post-tracking.md (Phase A)
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/staff_gate.sql (the staff policy calls is_staff()).
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- EVERY TIER. Adding a profile and verifying it is part of setup for free, pro
-- and max alike. Verification happens in pipeline/track_posts.py on the Fly
-- worker (a code in the profile's public bio). Scanning a verified profile for
-- new videos, and measuring them (Phase B), is for accounts holding the
-- post_tracking feature only.
--
-- ONE ROW = ONE PROFILE OF ONE CREATOR.
--   verify_code  generated here, shown to its owner, looked for in the bio.
--   verified_at  set only by the pipeline (service role). A verified (platform,
--                handle) belongs to one creator: the partial unique index.
--   platform_uid the platform's own account number, recorded at verification so
--                a username that later passes to someone else reads "changed".
--   status       unverified | verified | code_not_found | taken | private |
--                not_found | unavailable | changed
--   verify_tries checks spent. The caps mirror pipeline/track_posts.py
--                TRACK_IG_VERIFY_TRIES (10) / TRACK_TT_VERIFY_TRIES (200) and
--                are repeated in request_profile_check below.
--
-- TRUST BOUNDARY. Profiles feed only their owner's own views and staff reads.
-- Never lynxr_sources, lynxr_videos, the agency app or any cross-creator number.
-- A creator writes NOTHING directly: no insert, update or delete grant. The
-- three functions below are the only door, and each acts on auth.uid() alone.
-- (A creator cannot mark their own profile verified: there is no write grant.)
--
-- WHAT DELETES ROWS: the account (on delete cascade from auth.users), and
-- remove_my_profile(). Nothing else.
--
-- ONLY A SIGNED-IN CALLER CAN CREATE A PROFILE OR RECEIVE ITS CODE. The setup
-- stepper shown before sign-up holds usernames in the browser and calls
-- set_my_profile once the account exists. The code is generated here, never in
-- the browser, so a client cannot pick a code that already sits in someone
-- else's bio.

do $$ begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
end $$;

create table if not exists public.lynxr_profiles (
  creator_id         uuid not null references auth.users(id) on delete cascade,
  platform           text not null check (platform in ('tiktok','instagram')),
  handle             text not null check (handle ~ '^[a-z0-9._]{1,30}$'),
  added_at           timestamptz not null default now(),
  verify_code        text not null default ('lynxr-' || substr(md5(gen_random_uuid()::text), 1, 6)),
  verified_at        timestamptz,
  platform_uid       text check (platform_uid is null or length(platform_uid) <= 64),
  status             text not null default 'unverified'
                     check (status in ('unverified','verified','code_not_found','taken','private','not_found','unavailable','changed')),
  verify_tries       int not null default 0,
  check_requested_at timestamptz,
  last_checked_at    timestamptz,
  last_scan_at       timestamptz,     -- Phase B (pipeline/track_posts.py scan): attempted
  last_scan_ok_at    timestamptz,     -- Phase B: succeeded
  watermark_at       timestamptz,     -- Phase B: newest posted_at seen
  primary key (creator_id, platform, handle)
);
create unique index if not exists lynxr_profiles_verified_handle
  on public.lynxr_profiles (platform, handle) where verified_at is not null;

alter table public.lynxr_profiles enable row level security;
revoke all on table public.lynxr_profiles from anon;
revoke insert, update, delete, truncate on table public.lynxr_profiles from authenticated;
grant select on table public.lynxr_profiles to authenticated;
drop policy if exists "creator reads own profiles" on public.lynxr_profiles;
create policy "creator reads own profiles" on public.lynxr_profiles
  for select to authenticated using (auth.uid() = creator_id);
drop policy if exists "staff read profiles" on public.lynxr_profiles;
create policy "staff read profiles" on public.lynxr_profiles
  for select to authenticated using (public.is_staff());
comment on table public.lynxr_profiles is
  'Public TikTok/Instagram usernames a creator added, and their bio-code verification. Feeds only the owner''s views and staff reads; never lynxr_sources, lynxr_videos, the agency app or any cross-creator number.';

create or replace function public.set_my_profile(p_platform text, p_handle text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  h   text := lower(regexp_replace(trim(coalesce(p_handle, '')), '^@', ''));
  r   public.lynxr_profiles;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if p_platform is null or p_platform not in ('tiktok','instagram') or h !~ '^[a-z0-9._]{1,30}$' then
    return jsonb_build_object('ok', false, 'why', 'bad_handle');
  end if;
  if exists (select 1 from public.lynxr_profiles
              where platform = p_platform and handle = h and verified_at is not null and creator_id <> uid) then
    return jsonb_build_object('ok', false, 'why', 'taken');
  end if;
  -- 4 mirrors creator.js PROFILES_MAX
  if (select count(*) from public.lynxr_profiles where creator_id = uid) >= 4
     and not exists (select 1 from public.lynxr_profiles where creator_id = uid and platform = p_platform and handle = h) then
    return jsonb_build_object('ok', false, 'why', 'too_many_profiles');
  end if;
  insert into public.lynxr_profiles (creator_id, platform, handle) values (uid, p_platform, h)
    on conflict (creator_id, platform, handle) do nothing;
  select * into r from public.lynxr_profiles where creator_id = uid and platform = p_platform and handle = h;
  return jsonb_build_object('ok', true, 'platform', r.platform, 'handle', r.handle,
                            'verify_code', r.verify_code, 'status', r.status);
end $$;

create or replace function public.remove_my_profile(p_platform text, p_handle text)
returns boolean language plpgsql volatile security definer set search_path = ''
as $$
declare uid uuid := auth.uid(); n int;
begin
  if uid is null then raise exception 'not signed in'; end if;
  delete from public.lynxr_profiles
   where creator_id = uid and platform = p_platform
     and handle = lower(regexp_replace(trim(coalesce(p_handle, '')), '^@', ''));
  get diagnostics n = row_count;
  return n > 0;
end $$;

create or replace function public.request_profile_check(p_platform text, p_handle text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  h   text := lower(regexp_replace(trim(coalesce(p_handle, '')), '^@', ''));
  r   public.lynxr_profiles;
  cap int := case when p_platform = 'instagram' then 10 else 200 end;  -- mirrors TRACK_IG_VERIFY_TRIES / TRACK_TT_VERIFY_TRIES
begin
  if uid is null then raise exception 'not signed in'; end if;
  select * into r from public.lynxr_profiles
   where creator_id = uid and platform = p_platform and handle = h and verified_at is null;
  if not found then return jsonb_build_object('ok', false, 'why', 'no_profile'); end if;
  if r.verify_tries >= cap then return jsonb_build_object('ok', false, 'why', 'too_many'); end if;
  update public.lynxr_profiles set check_requested_at = now()
   where creator_id = uid and platform = p_platform and handle = h;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.set_my_profile(text, text) from public, anon;
revoke all on function public.remove_my_profile(text, text) from public, anon;
revoke all on function public.request_profile_check(text, text) from public, anon;
grant execute on function public.set_my_profile(text, text) to authenticated;
grant execute on function public.remove_my_profile(text, text) to authenticated;
grant execute on function public.request_profile_check(text, text) to authenticated;

notify pgrst, 'reload schema';

-- Checks to run after it (paste one at a time):
--   counts by platform and status:
--     select platform, status, count(*) from public.lynxr_profiles group by 1, 2 order by 1, 2;
--   the anonymous role must not reach the function (expect: f):
--     select has_function_privilege('anon', 'public.set_my_profile(text,text)', 'execute');
--   two policies (expect: 2 rows):
--     select policyname from pg_policies where schemaname = 'public' and tablename = 'lynxr_profiles';
