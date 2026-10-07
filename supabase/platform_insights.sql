-- Connected accounts: the per-video watch-time figures a creator's own Instagram (and, once approved, TikTok) account reports, the
-- encrypted token that lets lynxr read them, the one-shot state that carries identity across the platform's redirect, and the
-- functions that read status and DISCONNECT.
-- Plan: ~/.claude/plans/lynxr-social-insights.md
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
-- Run AFTER supabase/post_tracking.sql (a figure hangs off a tracked post), supabase/profiles.sql (a token hangs off a verified
-- profile) and supabase/staff_gate.sql (is_staff() is in the staff policies). supabase/ops_table.sql and supabase/creator_brain.sql
-- are used if they exist and are not required: the functions below check for them at call time, never at create time.
-- Run it BEFORE the insights-connect Edge Function is deployed and BEFORE the worker that reads it is pushed: the function and the
-- worker both log one line and do nothing when these tables are missing, so that order is safe and the reverse is not.
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- THE PRIVACY POLICY IS THE SPEC. privacy/index.html ("connecting an instagram or tiktok account") and data-deletion/index.html
-- ("disconnecting an instagram or tiktok account") are live and promise, in these words, that on disconnect lynxr deletes the access
-- token AND the performance figures read from that platform AND the summary of what lynxr had learned from them. So DISCONNECT IS A
-- DELETE, NOT A STOP. This is the opposite of lynxr_post_views, which keeps its history for as long as the account exists.
-- revoke_insights() below is the single place that promise is kept, and every path reaches it: the Settings button
-- (disconnect_my_insights), Meta's deauthorize callback, and a token the platform has rejected (both through the insights-connect
-- function). Removing the profile the token hangs off, or deleting the account, deletes the same rows by foreign key.
--
-- THREE TABLES.
--   lynxr_oauth_states       one row per connect in flight. The only thing that carries WHO across the platform's redirect, because the
--                            callback arrives with no session and no cookie. Service role only; no policy, no grant, on purpose.
--   lynxr_platform_tokens    one row per connected profile, the access token ENCRYPTED (AES-256-GCM; the key lives only in the Edge
--                            Function's secrets, never here and never on the worker). A creator can NOT read their own row, unlike every
--                            other creator table in this repo, because the row holds a credential. They read status through my_insights().
--   lynxr_post_insights      snapshots of one post's watch figures, shaped like lynxr_post_views so the two line up on `day`.
--
-- WHAT THE FIGURES ARE. Two points on the curve, never the curve: the average time watched, and one completion-ish share (TikTok: the
-- share who watched to the end; Instagram: the share who skipped inside the first three seconds). Neither platform's API exposes a
-- retention graph, and no copy may imply one. Both are LIFETIME aggregates: never subtract two avg_watch_ms values (an average over a
-- growing population is not differenceable); the newest snapshot is the most complete one.
--
-- TRUST BOUNDARY. Nothing here is joined into lynxr_sources, lynxr_videos, the agency app, process_campaigns.py or any cross-creator
-- number. A creator writes nothing but through disconnect_my_insights(); the pipeline (service role) writes figures; the Edge Function
-- (service role) writes tokens and states.

do $$ begin
  if to_regclass('public.lynxr_posts') is null then
    raise exception 'public.lynxr_posts missing — run supabase/post_tracking.sql first';
  end if;
  if to_regclass('public.lynxr_profiles') is null then
    raise exception 'public.lynxr_profiles missing — run supabase/profiles.sql first';
  end if;
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
end $$;

-- ── process state on lynxr_posts (never data derived from a video) ────────────────────────────────
-- insights_state: pending (not read yet) · ok · unsupported (a post this platform has no watch figure for, e.g. a feed video that is
-- not a reel: never retried) · too_old (reserved) · failed (retried a few times, then for good) · no_token (the profile is not
-- connected, or was disconnected). Every existing post starts at 'pending', which is true; the worker only ever polls the ones whose
-- profile has an active token.
alter table public.lynxr_posts add column if not exists platform_media_id text
  check (platform_media_id is null or length(platform_media_id) <= 64);
alter table public.lynxr_posts add column if not exists duration_s int
  check (duration_s is null or (duration_s > 0 and duration_s <= 3600));
alter table public.lynxr_posts add column if not exists insights_state text not null default 'pending'
  check (insights_state in ('pending','ok','unsupported','too_old','failed','no_token'));
alter table public.lynxr_posts add column if not exists insights_at timestamptz;
alter table public.lynxr_posts add column if not exists insights_fails int not null default 0;
create index if not exists lynxr_posts_insights_idx on public.lynxr_posts (posted_at desc)
  where insights_state in ('pending','ok');

-- ── Table A: a connect in flight ──────────────────────────────────────────────────────────────────
create table if not exists public.lynxr_oauth_states (
  state      text primary key check (length(state) between 32 and 128),
  creator_id uuid not null references auth.users(id) on delete cascade,
  platform   text not null check (platform in ('tiktok','instagram')),
  handle     text not null check (handle ~ '^[a-z0-9._]{1,30}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- ── Table B: the encrypted token, one per connected profile ───────────────────────────────────────
create table if not exists public.lynxr_platform_tokens (
  creator_id       uuid not null references auth.users(id) on delete cascade,
  platform         text not null check (platform in ('tiktok','instagram')),
  handle           text not null check (handle ~ '^[a-z0-9._]{1,30}$'),
  platform_user_id text not null check (length(platform_user_id) <= 64),
  token_cipher     text not null,                 -- base64 AES-256-GCM, 12-byte nonce prepended
  refresh_cipher   text,                          -- TikTok only; null on Instagram
  key_id           text not null,                 -- first 8 hex of sha256(key): a rotated key is diagnosable, not mysterious
  scopes           text not null default '',      -- exactly what the platform granted
  connected_at     timestamptz not null default now(),
  expires_at       timestamptz,                   -- of the access token
  refreshed_at     timestamptz,
  last_poll_at     timestamptz,
  poll_fails       int not null default 0,
  status           text not null default 'active' check (status in ('active','needs_reconnect')),
  primary key (creator_id, platform, handle),
  -- What makes "removing a username disconnects it too" (data-deletion/index.html) true in the database rather than in code. The same
  -- device as lynxr_profile_followers.
  constraint lynxr_platform_tokens_profile_fk foreign key (creator_id, platform, handle)
    references public.lynxr_profiles (creator_id, platform, handle) on delete cascade
);
-- Meta's deauthorize callback names an Instagram-scoped user id and nothing else: it is looked up here.
create index if not exists lynxr_platform_tokens_uid_idx on public.lynxr_platform_tokens (platform, platform_user_id);

-- ── Table C: the figures ──────────────────────────────────────────────────────────────────────────
create table if not exists public.lynxr_post_insights (
  post_id         bigint not null references public.lynxr_posts(id) on delete cascade,
  creator_id      uuid not null references auth.users(id) on delete cascade,
  platform        text not null check (platform in ('tiktok','instagram')),
  day             int not null check (day between 0 and 3650),      -- whole days after posted_at, same as lynxr_post_views.day
  at              timestamptz not null default now(),
  avg_watch_ms    bigint check (avg_watch_ms is null or avg_watch_ms >= 0),
  total_watch_ms  bigint check (total_watch_ms is null or total_watch_ms >= 0),
  finished_rate   numeric check (finished_rate is null or (finished_rate >= 0 and finished_rate <= 1)),        -- TikTok full_video_watched_rate
  skipped_3s_rate numeric check (skipped_3s_rate is null or (skipped_3s_rate >= 0 and skipped_3s_rate <= 1)), -- Instagram reels_skip_rate
  reach           bigint check (reach is null or reach >= 0),
  sources         jsonb,                                            -- TikTok impression_sources, verbatim; null on Instagram
  primary key (post_id, day)
);
create index if not exists lynxr_post_insights_creator_idx on public.lynxr_post_insights (creator_id);

-- ── Row-level security ────────────────────────────────────────────────────────────────────────────
alter table public.lynxr_oauth_states     enable row level security;
alter table public.lynxr_platform_tokens  enable row level security;
alter table public.lynxr_post_insights    enable row level security;

-- lynxr_oauth_states: service role only (it bypasses RLS). NO policy and NO grant of any kind to authenticated: a creator must not be
-- able to read, or forge, a state row. The absence of a policy is the point; do not "make it consistent" with the tables below.
revoke all on table public.lynxr_oauth_states from anon, authenticated;

-- lynxr_platform_tokens: the creator does NOT read their own row, because the row holds a credential (even encrypted, it is not theirs
-- to carry around, and a mis-set policy later must yield nothing readable). There is NO table-level select for authenticated, and the
-- one policy below is staff-only, so Ops can see that a connection exists. Staff get a COLUMN grant that leaves out token_cipher and
-- refresh_cipher, so even a staff session can never read a credential through the API. (A policy alone grants nothing: without some
-- select privilege the staff policy would be dead.) A creator reads their own status only through my_insights().
revoke all on table public.lynxr_platform_tokens from anon;
revoke insert, update, delete, truncate, select on table public.lynxr_platform_tokens from authenticated;
grant select (creator_id, platform, handle, platform_user_id, key_id, scopes, connected_at, expires_at, refreshed_at,
              last_poll_at, poll_fails, status)
  on table public.lynxr_platform_tokens to authenticated;
drop policy if exists "staff read platform tokens" on public.lynxr_platform_tokens;
create policy "staff read platform tokens" on public.lynxr_platform_tokens
  for select to authenticated using (public.is_staff());

-- lynxr_post_insights: read your own, staff read all, nobody but the pipeline writes (the four policies of lynxr_post_views).
revoke all on table public.lynxr_post_insights from anon;
revoke insert, update, delete, truncate on table public.lynxr_post_insights from authenticated;
grant select on table public.lynxr_post_insights to authenticated;
drop policy if exists "creator reads own post insights" on public.lynxr_post_insights;
create policy "creator reads own post insights" on public.lynxr_post_insights
  for select to authenticated using (auth.uid() = creator_id);
drop policy if exists "staff read post insights" on public.lynxr_post_insights;
create policy "staff read post insights" on public.lynxr_post_insights
  for select to authenticated using (public.is_staff());

comment on table public.lynxr_oauth_states is
  'One row per platform connect in flight; carries the creator across the platform redirect. Service role only: no grant and no policy for any browser role, deliberately.';
comment on table public.lynxr_platform_tokens is
  'The encrypted access token that lets lynxr read a creator''s own watch-time figures. The creator cannot read their own row (it holds a credential); staff see everything except the cipher columns. Deleted by revoke_insights() on disconnect, by foreign key when the profile or account goes. Never joined into lynxr_sources, lynxr_videos, the agency app or any cross-creator number.';
comment on table public.lynxr_post_insights is
  'Lifetime watch figures read from a creator''s own connected account, snapshotted at day = whole days after posted_at. Never subtract two avg_watch_ms values. Same trust boundary as lynxr_posts; deleted on disconnect.';

-- ── Function 1: THE PRIVACY PROMISE, in one place ─────────────────────────────────────────────────
-- Service role only. In order: the token, the figures, the post state, the summary. Returns the number of token rows deleted.
-- The summary is "what lynxr had learned from them": the `how_people_watch` key of the creator's brain document. It is a key removal
-- and not a row delete, because deleting the row would throw away the cached voice line and buy a needless model call. It runs through
-- `execute` so this file does not hard-require supabase/creator_brain.sql.
create or replace function public.revoke_insights(p_creator uuid, p_platform text, p_handle text)
returns int language plpgsql volatile security definer set search_path = ''
as $$
declare n int;
begin
  delete from public.lynxr_platform_tokens
   where creator_id = p_creator and platform = p_platform and handle = p_handle;
  get diagnostics n = row_count;

  delete from public.lynxr_post_insights i
   using public.lynxr_posts p
   where i.post_id = p.id and i.creator_id = p_creator and i.platform = p_platform and p.handle = p_handle;

  update public.lynxr_posts
     set insights_state = 'no_token', insights_at = null, insights_fails = 0, platform_media_id = null
   where creator_id = p_creator and platform = p_platform and handle = p_handle;

  if to_regclass('public.lynxr_creator_brain') is not null then
    execute 'update public.lynxr_creator_brain set body = body - ''how_people_watch'' where creator_id = $1' using p_creator;
  end if;
  return n;
end $$;
revoke all on function public.revoke_insights(uuid, text, text) from public, anon, authenticated;
grant execute on function public.revoke_insights(uuid, text, text) to service_role;

-- ── The same promise, for the paths that never call revoke_insights ───────────────────────────────
-- revoke_insights() covers Disconnect, Meta's deauthorize callback and a rejected token. It does NOT cover REMOVING A PROFILE or
-- DELETING THE ACCOUNT: those delete the token row by foreign key, so the function never runs and `how_people_watch` would sit in the
-- brain document until the next nightly rebuild — up to about 20 hours. /data-deletion/ is already live and promises that removing a
-- profile deletes "everything found on it" and "anything derived from them", so a 20-hour tail is a published promise we would be
-- breaking. This trigger closes it at the one chokepoint every path goes through: the token row disappearing.
--
-- Idempotent on purpose. revoke_insights() deletes the token first, which fires this too, and stripping an absent key is a no-op.
-- security definer because a creator removing their own profile has no write grant on lynxr_creator_brain, and must not be given one.
create or replace function public.insights_token_deleted()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if to_regclass('public.lynxr_creator_brain') is not null then
    execute 'update public.lynxr_creator_brain set body = body - ''how_people_watch'' where creator_id = $1'
      using old.creator_id;
  end if;
  return old;
end $$;

drop trigger if exists lynxr_platform_tokens_deleted on public.lynxr_platform_tokens;
create trigger lynxr_platform_tokens_deleted
  after delete on public.lynxr_platform_tokens
  for each row execute function public.insights_token_deleted();

-- ── Function 2: the Disconnect button ─────────────────────────────────────────────────────────────
-- Acts on auth.uid() alone. There is no id parameter, deliberately (the reasoning of delete_account.sql): a creator can only ever
-- disconnect their own. The handle is lowercased and @-stripped exactly as remove_my_profile() does it.
create or replace function public.disconnect_my_insights(p_platform text, p_handle text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  h   text := lower(regexp_replace(trim(coalesce(p_handle, '')), '^@', ''));
  n   int;
begin
  if uid is null then raise exception 'not signed in'; end if;
  n := public.revoke_insights(uid, p_platform, h);
  return jsonb_build_object('ok', true, 'removed', n);
end $$;
revoke all on function public.disconnect_my_insights(text, text) from public, anon;
grant execute on function public.disconnect_my_insights(text, text) to authenticated;

-- ── Function 3: status for the Settings card (never a token, never a cipher) ──────────────────────
-- `platforms` says which platforms are OFFERED, from lynxr_ops key 'insights.platforms' (default both off). That is how the app turns a
-- platform on the day its review passes: one row in the SQL editor, no code edit, no stamp bump.
create or replace function public.my_insights()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  plat jsonb := '{"instagram": false, "tiktok": false}'::jsonb;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if to_regclass('public.lynxr_ops') is not null then
    execute 'select coalesce((select value from public.lynxr_ops where key = ''insights.platforms''), $1)' into plat using plat;
  end if;
  return jsonb_build_object(
    'platforms', jsonb_build_object('instagram', coalesce((plat -> 'instagram') = 'true'::jsonb, false),
                                    'tiktok',    coalesce((plat -> 'tiktok') = 'true'::jsonb, false)),
    'connected', coalesce((select jsonb_agg(jsonb_build_object('platform', t.platform, 'handle', t.handle,
                                                               'since', t.connected_at, 'status', t.status)
                                             order by t.connected_at)
                             from public.lynxr_platform_tokens t where t.creator_id = uid), '[]'::jsonb));
end $$;
revoke all on function public.my_insights() from public, anon;
grant execute on function public.my_insights() to authenticated;

notify pgrst, 'reload schema';

-- Checks to run after it (paste one at a time):
--   nothing connected yet (expect: 0):
--     select count(*) from public.lynxr_platform_tokens;
--   nothing readable that should not be (expect: f, f, f, f):
--     select has_table_privilege('authenticated','public.lynxr_platform_tokens','select'),
--            has_table_privilege('authenticated','public.lynxr_oauth_states','select'),
--            has_table_privilege('anon','public.lynxr_post_insights','select'),
--            has_function_privilege('authenticated','public.revoke_insights(uuid,text,text)','execute');
--   the cipher columns are not granted to any browser role (expect: 0 rows):
--     select column_name from information_schema.column_privileges
--      where table_schema = 'public' and table_name = 'lynxr_platform_tokens'
--        and grantee in ('authenticated','anon') and column_name in ('token_cipher','refresh_cipher');
--   the oauth state table has no policy at all (expect: 0 rows):
--     select policyname from pg_policies where schemaname = 'public' and tablename = 'lynxr_oauth_states';
--   the new columns landed and every existing post is 'pending' (expect: pending, then a count):
--     select insights_state, count(*) from public.lynxr_posts group by 1 order by 2 desc;
--
-- TURN A PLATFORM ON (the Connect button appears at the next page load; nothing else to deploy). Leave it unset to ship dark.
-- Do this only after the Meta app is live for the accounts that will press the button:
--   insert into public.lynxr_ops (key, value) values ('insights.platforms', '{"instagram":true,"tiktok":false}'::jsonb)
--   on conflict (key) do update set value = excluded.value, updated_at = now();
-- Turn it off again (existing connections keep working; only the button goes):
--   delete from public.lynxr_ops where key = 'insights.platforms';
--
-- THE PROOF OF THE PROMISE, after a real connect and a real Disconnect (expect: 0, 0, false):
--     select count(*) from public.lynxr_platform_tokens;
--     select count(*) from public.lynxr_post_insights;
--     select body ? 'how_people_watch' from public.lynxr_creator_brain where creator_id = '<uuid>';
--
-- ROLLBACK (drops everything this file added; the tracked posts and their view history are untouched):
--   drop function if exists public.my_insights();
--   drop function if exists public.disconnect_my_insights(text, text);
--   drop trigger if exists lynxr_platform_tokens_deleted on public.lynxr_platform_tokens;
--   drop function if exists public.insights_token_deleted();
--   drop function if exists public.revoke_insights(uuid, text, text);
--   drop table if exists public.lynxr_post_insights;
--   drop table if exists public.lynxr_platform_tokens;
--   drop table if exists public.lynxr_oauth_states;
--   drop index if exists public.lynxr_posts_insights_idx;
--   alter table public.lynxr_posts drop column if exists insights_fails, drop column if exists insights_at,
--     drop column if exists insights_state, drop column if exists duration_s, drop column if exists platform_media_id;
