-- Lynxr creator tables — the MINIMUM needed to sign into creator.html.
-- Dashboard → SQL Editor → New query → paste → Run.
--
-- WHY THIS FILE EXISTS SEPARATELY. schema.sql is one transaction: it also
-- rewrites the agency policies, reads auth.users, and touches storage.objects,
-- and if any of that fails in your project's SQL editor the whole thing rolls
-- back and these tables never appear. This file has no such dependencies —
-- no auth.users read, no storage, no is_staff() — so there is nothing left to
-- fail. Run it to unblock testing, then run the full schema.sql for the staff
-- gate before any outside creator gets an account.

-- The trigger below needs this; it already exists if schema.sql ever ran, and
-- create-or-replace is harmless either way.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- CREATOR SIDE (lynxr creator app — see output/LYNXR_SPEC_v2.md)
--
-- SECURITY NOTE, and the reason this table exists at all: lynxr_clients grants
-- every signed-in user full read/write ("one team"), which is right for the
-- agency but WRONG the moment outside creators have logins. Creators must not
-- see each other, and must never see agency client data. So creator state
-- lives here, keyed on auth.uid(), with owner-only policies — a creator can
-- only ever touch their own row, enforced by the database rather than the UI.
--
-- data holds: {name, niches[], brands[], library[], adaptations[]}. Brands
-- carry a per-brand consent flag ('full' | 'private'); spec §1.1 defaults
-- brands that are not Lynx clients to 'private', which keeps their performance
-- out of any cross-brand intelligence.
--
-- The creator app is organised as one FOLDER PER COMPANY, mirroring the agency
-- app's client folders. brands[] holds those companies (the key stays `brands`
-- because process_adaptations.py's brand_digest reads it).
--
-- library[] is the shelf of sources worth remaking, each filed to exactly one
-- company via brandId — saving happens inside a folder, so a video only ever
-- exists in the context of the company it might be remade for. Entries are
-- {id, url, canon, platform, title, creator, caption, note, brandId, addedAt}
-- and are unique on (canon, brandId): one video pasted three ways is one entry,
-- but two companies each keep their own copy with their own note. Each
-- adaptation carries libraryId pointing back at the entry it came from.
--
-- adaptations[] deliberately stays a FLAT top-level array rather than nesting
-- inside each company — it is exactly what the worker iterates.
--
-- Self-serve signup goes through Supabase Auth directly, so a creator's row
-- here is created by their first save, not by any admin step.
create table if not exists public.lynxr_creators (
  id          uuid primary key references auth.users(id) on delete cascade,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.lynxr_creators enable row level security;

drop policy if exists "creator reads own row"   on public.lynxr_creators;
drop policy if exists "creator inserts own row" on public.lynxr_creators;
drop policy if exists "creator updates own row" on public.lynxr_creators;
drop policy if exists "creator deletes own row" on public.lynxr_creators;

create policy "creator reads own row"
  on public.lynxr_creators for select
  to authenticated using (auth.uid() = id);

create policy "creator inserts own row"
  on public.lynxr_creators for insert
  to authenticated with check (auth.uid() = id);

create policy "creator updates own row"
  on public.lynxr_creators for update
  to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create policy "creator deletes own row"
  on public.lynxr_creators for delete
  to authenticated using (auth.uid() = id);

-- The adaptation worker (pipeline/process_adaptations.py) reads every row with
-- the service-role key, which bypasses RLS by design.

drop trigger if exists lynxr_creators_touch on public.lynxr_creators;
create trigger lynxr_creators_touch
  before update on public.lynxr_creators
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- SHARED SOURCE LIBRARY (step 1 of the build plan: "get creators their scripts
-- AND add it to our database")
--
-- Every source video a creator pastes lands here once, keyed by canonical URL,
-- with whatever the worker managed to extract. This is the Lynx-side asset that
-- accumulates: it is how one creator's discovery becomes visible to the agency.
--
-- SECURITY: there are deliberately NO policies for `authenticated`. Creators
-- and agency staff share one Supabase auth pool, so any authenticated policy
-- here would expose the whole library to every creator (spec §1.1 / §20 forbid
-- that). Only the service-role key — the pipeline — can read or write this
-- table. When the agency dashboard needs it, add a roles table and gate on
-- that; do not loosen this to `authenticated`.
--
-- `consent` mirrors the brand's setting at tag time: rows from brands marked
-- 'private' must be excluded from any cross-brand analysis.
create table if not exists public.lynxr_sources (
  canonical_url  text primary key,
  url            text        not null,
  platform       text        not null default '',
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  tag_count      integer     not null default 1,
  consent        text        not null default 'private',
  script         jsonb,      -- verbatim transcript + segments (Whisper)
  shots          jsonb,      -- shot list (framing + on-screen text per beat)
  tags           jsonb,      -- locked-taxonomy tags = the FAMILY (spec §4.1)
  format         jsonb       -- extracted reusable structure = the FORMAT
);

create index if not exists lynxr_sources_platform_idx on public.lynxr_sources (platform);
create index if not exists lynxr_sources_seen_idx     on public.lynxr_sources (last_seen_at desc);

alter table public.lynxr_sources enable row level security;
-- (no policies on purpose — service-role only; see the note above)
