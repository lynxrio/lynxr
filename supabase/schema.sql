-- Lynxr shared state — run this once in the Supabase SQL editor.
-- Dashboard → SQL Editor → New query → paste → Run.
--
-- WHY IT IS SHAPED THIS WAY
-- One row per client rather than a single blob: two people editing different
-- clients then never conflict, and only edits to the same client race (last
-- write wins, which is fine for two people).
--
-- SECURITY: this repo is public, so the publishable key in app.js is public
-- too. That is the designed pattern ONLY when row-level security requires a
-- real login — otherwise anyone who reads the repo could read and rewrite your
-- client data. So these policies grant access to the `authenticated` role only,
-- never to `anon`.

create table if not exists public.lynxr_clients (
  id          text primary key,
  data        jsonb       not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create index if not exists lynxr_clients_updated_at_idx
  on public.lynxr_clients (updated_at desc);

alter table public.lynxr_clients enable row level security;

-- Everyone signed in shares one workspace: you and your cofounder see and edit
-- the same clients, exactly as asked. Anonymous visitors get nothing.
drop policy if exists "signed-in users read all clients"   on public.lynxr_clients;
drop policy if exists "signed-in users write all clients"  on public.lynxr_clients;
drop policy if exists "signed-in users update all clients" on public.lynxr_clients;
drop policy if exists "signed-in users delete all clients" on public.lynxr_clients;

create policy "signed-in users read all clients"
  on public.lynxr_clients for select
  to authenticated using (true);

create policy "signed-in users write all clients"
  on public.lynxr_clients for insert
  to authenticated with check (true);

create policy "signed-in users update all clients"
  on public.lynxr_clients for update
  to authenticated using (true) with check (true);

create policy "signed-in users delete all clients"
  on public.lynxr_clients for delete
  to authenticated using (true);

-- Keep updated_at honest on every write so sync can order changes.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists lynxr_clients_touch on public.lynxr_clients;
create trigger lynxr_clients_touch
  before update on public.lynxr_clients
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- lynxr_secrets is RETIRED. It once held the data.enc bundle passphrase, which
-- was committed in plaintext to this public repo and must be treated as leaked.
-- Nothing reads it now (the video rows live in lynxr_videos below), so drop it
-- outright — this removes the leaked value from the live database when the file
-- is re-run. Do NOT recreate it to store secrets; a public repo is the wrong
-- place to document a table that holds them.
drop table if exists public.lynxr_secrets;

-- ---------------------------------------------------------------------------
-- The video database itself: 2,640+ tagged videos, one row per video.
-- Replaces the encrypted data.enc blob the page used to download and decrypt.
-- Read-only for signed-in users; NO write policies exist, so browsers can
-- never modify it — writes go through the pipeline with the service-role key
-- (pipeline/export_supabase.py), which bypasses RLS by design.
--
-- Types mirror what the front end already expects from the old JSON bundle:
-- video_id stays text (TikTok ids overflow JS numbers), engagement_rate stays
-- text (the UI truthiness-checks it before parseFloat; a numeric 0 would
-- change behavior), counts are bigint and arrive in JS as plain numbers.
create table if not exists public.lynxr_videos (
  platform         text not null,
  video_id         text not null,
  creator          text not null default '',
  title            text not null default '',
  views            bigint not null default 0,
  likes            bigint not null default 0,
  comments         bigint not null default 0,
  engagement_rate  text not null default '',
  format_type      text not null default '',
  hook_pattern     text not null default '',
  niche_category   text not null default '',
  target_audience  text not null default '',
  data_source      text not null default '',
  -- url is NOT unique-constrained on purpose: the upsert arbitrates only on the
  -- (platform, video_id) primary key, so a separate url UNIQUE would abort the
  -- whole load if a re-scrape ever brought the same url under a new id.
  url              text not null,
  -- Extra taxonomy dimensions (pipeline/tag_extra_dims.py). length_bucket and
  -- audio_trend are mechanical; cta_type/visual_hook/onscreen_text/hook_delivery
  -- come from the multimodal pass. All blank until that pass runs.
  length_bucket    text not null default '',
  audio_trend      text not null default '',
  cta_type         text not null default '',
  visual_hook      text not null default '',
  onscreen_text    text not null default '',
  hook_delivery    text not null default '',
  -- The video's own words (pipeline/attach_transcripts.py): the verbatim
  -- spoken hook and the transcript (capped ~900 chars). These power tailored
  -- scripts that adapt the real script instead of a format template.
  hook_spoken      text not null default '',
  transcript       text not null default '',
  updated_at       timestamptz not null default now(),
  primary key (platform, video_id)
);

-- Idempotent add for tables created before these columns existed.
alter table public.lynxr_videos add column if not exists length_bucket text not null default '';
alter table public.lynxr_videos add column if not exists audio_trend   text not null default '';
alter table public.lynxr_videos add column if not exists cta_type      text not null default '';
alter table public.lynxr_videos add column if not exists visual_hook   text not null default '';
alter table public.lynxr_videos add column if not exists onscreen_text text not null default '';
alter table public.lynxr_videos add column if not exists hook_delivery text not null default '';
alter table public.lynxr_videos add column if not exists hook_spoken   text not null default '';
alter table public.lynxr_videos add column if not exists transcript    text not null default '';

alter table public.lynxr_videos enable row level security;

drop policy if exists "signed-in users read videos" on public.lynxr_videos;
create policy "signed-in users read videos"
  on public.lynxr_videos for select
  to authenticated using (true);

drop trigger if exists lynxr_videos_touch on public.lynxr_videos;
create trigger lynxr_videos_touch
  before update on public.lynxr_videos
  for each row execute function public.touch_updated_at();
