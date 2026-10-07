-- Post tracking: the videos posted on a creator's verified profiles, their view /
-- like / comment counts over time, and the follower count of each profile once a day.
-- Plan: ~/.claude/plans/lynxr-onboarding-and-post-tracking.md (Phase B)
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/profiles.sql, supabase/billing.sql and supabase/staff_gate.sql
-- (profiles are what a post hangs off; features_for() decides who is tracked;
-- is_staff() is in the staff policies).
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- WHO IS TRACKED. Only accounts holding the post_tracking feature: the max plan,
-- or a row in lynxr_feature_grants (see the one-liners at the foot). The check is
-- has_post_tracking(), callable by the service role only, asked by
-- pipeline/track_posts.py on the Fly worker before every scan. Verification of a
-- profile (profiles.sql) is for every tier; nothing below runs for free or pro.
--
-- THREE TABLES, ONE OWNER EACH.
--   lynxr_posts              one row per video found on a verified profile, with its latest counts.
--   lynxr_post_views         snapshots of one post's counts at checkpoints (day 0 when found, then days
--                            1, 3, 7 and 30). `day` is whole days after posted_at. Its views / likes /
--                            comments are what the goal's progress bars read.
--   lynxr_profile_followers  one follower-count snapshot per verified profile per UTC day.
--
-- WHICH GOAL READS WHAT.
--   views per video        average views at day 7 over the latest 5 videos   -> lynxr_post_views.views
--   likes per video        average likes at day 7 over the latest 5 videos   -> lynxr_post_views.likes
--   followers (total)      latest follower count vs target, and the trend    -> lynxr_profile_followers
--
-- TRUST BOUNDARY. A creator's posts and numbers feed only their own views and staff
-- reads. Never lynxr_sources, lynxr_videos, the agency app or any cross-creator
-- number. A creator writes NOTHING here: no insert, update or delete grant on any of
-- the three tables, and no function that writes them. The pipeline (service role)
-- is the only writer.
--
-- WHAT DELETES ROWS. Posts and follower snapshots cascade from their profile
-- (remove_my_profile in profiles.sql) and from the account (on delete cascade from
-- auth.users). Ending max does not delete anything: the checks stop and what was
-- found stays as a read-only record.
--
-- NO TRANSCRIPTS, EVER. A post row holds its link, when it was posted, the first
-- 1000 characters of its public caption, and public counts. Nothing the lynxr
-- pipeline derives from a video (transcript, shot list, tags) is stored here.
--
-- `pasted` rows (origin) are reserved for a later "paste a video you posted" path;
-- nothing writes them yet, and tracked rows must carry a handle.

do $$ begin
  if to_regclass('public.lynxr_profiles') is null then
    raise exception 'public.lynxr_profiles missing — run supabase/profiles.sql first';
  end if;
  if to_regprocedure('public.features_for(uuid)') is null then
    raise exception 'public.features_for(uuid) missing — run supabase/billing.sql first';
  end if;
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
end $$;

create table if not exists public.lynxr_posts (
  id              bigint generated always as identity primary key,
  creator_id      uuid not null references auth.users(id) on delete cascade,
  platform        text not null check (platform in ('tiktok','instagram')),
  handle          text check (handle is null or handle ~ '^[a-z0-9._]{1,30}$'),
  origin          text not null default 'tracked' check (origin in ('tracked','pasted')),
  url             text not null check (length(url) <= 300),
  canonical_url   text not null check (length(canonical_url) <= 300),
  caption         text check (caption is null or length(caption) <= 1000),
  posted_at       timestamptz,
  added_at        timestamptz not null default now(),
  adaptation_id   text check (adaptation_id is null or length(adaptation_id) between 1 and 100),  -- which lynxr script it came from: set by the creator through link_my_post_script() (supabase/showcase.sql) or automatically by the matcher (supabase/post_match.sql, pipeline/post_match.py); match_state = 'auto' tells the second from the first
  views           bigint check (views is null or views >= 0),      -- null = unknown, never zero-by-default
  likes           bigint check (likes is null or likes >= 0),
  comments        bigint check (comments is null or comments >= 0),
  metrics_at      timestamptz,
  next_measure_at timestamptz,                                      -- null = no checkpoint left, or tracking stopped
  measure_fails   int not null default 0,
  unique (creator_id, canonical_url),
  constraint lynxr_posts_tracked_has_handle check (origin <> 'tracked' or handle is not null),
  constraint lynxr_posts_profile_fk foreign key (creator_id, platform, handle)
    references public.lynxr_profiles (creator_id, platform, handle) on delete cascade
);
create index if not exists lynxr_posts_creator_idx on public.lynxr_posts (creator_id, posted_at desc);
create index if not exists lynxr_posts_due_idx on public.lynxr_posts (next_measure_at) where next_measure_at is not null;

create table if not exists public.lynxr_post_views (
  post_id    bigint not null references public.lynxr_posts(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  day        int not null check (day between 0 and 3650),
  at         timestamptz not null default now(),
  views      bigint check (views is null or views >= 0),
  likes      bigint check (likes is null or likes >= 0),
  comments   bigint check (comments is null or comments >= 0),
  primary key (post_id, day)
);
create index if not exists lynxr_post_views_creator_idx on public.lynxr_post_views (creator_id);

-- One follower count per verified profile per UTC day. Cascades from the profile, so removing a
-- profile removes its follower history with it. Followers are not a per-post number, so this is its
-- own table rather than a column on lynxr_profiles (which a creator can read but never write, and
-- which holds verification state only).
create table if not exists public.lynxr_profile_followers (
  creator_id uuid not null references auth.users(id) on delete cascade,
  platform   text not null check (platform in ('tiktok','instagram')),
  handle     text not null check (handle ~ '^[a-z0-9._]{1,30}$'),
  day        date not null,
  at         timestamptz not null default now(),
  followers  bigint not null check (followers >= 0),
  primary key (creator_id, platform, handle, day),
  constraint lynxr_profile_followers_profile_fk foreign key (creator_id, platform, handle)
    references public.lynxr_profiles (creator_id, platform, handle) on delete cascade
);

-- When the worker last tried to read this profile's follower count (success or failure). It is what makes a
-- failing profile wait pipeline/track_posts.py TRACK_FOLLOW_RETRY_H before the next try, instead of paying for a
-- paid Instagram lookup on every pass. A column on lynxr_profiles (read-only to creators) rather than on the
-- snapshot table, because a failed try has no snapshot to hang off.
alter table public.lynxr_profiles add column if not exists followers_try_at timestamptz;

-- Row-level security: read your own, staff read all, nobody but the pipeline writes.
alter table public.lynxr_posts              enable row level security;
alter table public.lynxr_post_views         enable row level security;
alter table public.lynxr_profile_followers  enable row level security;

revoke all on table public.lynxr_posts              from anon;
revoke all on table public.lynxr_post_views         from anon;
revoke all on table public.lynxr_profile_followers  from anon;
revoke insert, update, delete, truncate on table public.lynxr_posts              from authenticated;
revoke insert, update, delete, truncate on table public.lynxr_post_views         from authenticated;
revoke insert, update, delete, truncate on table public.lynxr_profile_followers  from authenticated;
grant select on table public.lynxr_posts              to authenticated;
grant select on table public.lynxr_post_views         to authenticated;
grant select on table public.lynxr_profile_followers  to authenticated;

drop policy if exists "creator reads own posts" on public.lynxr_posts;
create policy "creator reads own posts" on public.lynxr_posts
  for select to authenticated using (auth.uid() = creator_id);
drop policy if exists "staff read posts" on public.lynxr_posts;
create policy "staff read posts" on public.lynxr_posts
  for select to authenticated using (public.is_staff());

drop policy if exists "creator reads own post views" on public.lynxr_post_views;
create policy "creator reads own post views" on public.lynxr_post_views
  for select to authenticated using (auth.uid() = creator_id);
drop policy if exists "staff read post views" on public.lynxr_post_views;
create policy "staff read post views" on public.lynxr_post_views
  for select to authenticated using (public.is_staff());

drop policy if exists "creator reads own follower counts" on public.lynxr_profile_followers;
create policy "creator reads own follower counts" on public.lynxr_profile_followers
  for select to authenticated using (auth.uid() = creator_id);
drop policy if exists "staff read follower counts" on public.lynxr_profile_followers;
create policy "staff read follower counts" on public.lynxr_profile_followers
  for select to authenticated using (public.is_staff());

comment on table public.lynxr_posts is
  'Videos found on a creator''s verified TikTok/Instagram profiles, with public counts. Feeds only the owner''s views and staff reads; never lynxr_sources, lynxr_videos, the agency app or any cross-creator number. No transcripts.';
comment on table public.lynxr_post_views is
  'Snapshots of one tracked post''s public view / like / comment counts at checkpoints (day = whole days after posted_at). Same trust boundary as lynxr_posts.';
comment on table public.lynxr_profile_followers is
  'One public follower count per verified profile per UTC day. Same trust boundary as lynxr_posts.';

-- Who is tracked. Service role only: the browser reads has-feature from my_plan().features, for display
-- only. This is what the worker asks, and it is the real gate.
create or replace function public.has_post_tracking(p uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select 'post_tracking' = any(public.features_for(p)); $$;
revoke all on function public.has_post_tracking(uuid) from public, anon, authenticated;
grant execute on function public.has_post_tracking(uuid) to service_role;

notify pgrst, 'reload schema';

-- Grant tracking to one account (the max plan carries it too; max is not for sale yet), by hand here only:
--   insert into public.lynxr_feature_grants (creator_id, feature, note)
--   values ('<uuid>', 'post_tracking', 'test') on conflict do nothing;
-- Take it away again (history stays; scans and measurements stop):
--   delete from public.lynxr_feature_grants where creator_id = '<uuid>' and feature = 'post_tracking';
--
-- Checks to run after it (paste one at a time):
--   counts of what has been found:
--     select (select count(*) from public.lynxr_posts) posts,
--            (select count(*) from public.lynxr_post_views) snapshots,
--            (select count(*) from public.lynxr_profile_followers) follower_days;
--   six policies (expect: 6 rows):
--     select tablename, policyname from pg_policies where schemaname = 'public'
--      and tablename in ('lynxr_posts','lynxr_post_views','lynxr_profile_followers') order by 1, 2;
--   the browser roles must not reach the function (expect: f, f):
--     select has_function_privilege('anon', 'public.has_post_tracking(uuid)', 'execute'),
--            has_function_privilege('authenticated', 'public.has_post_tracking(uuid)', 'execute');
