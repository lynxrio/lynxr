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

-- ---------------------------------------------------------------------------
-- STAFF GATE — must come first; the policies below call is_staff().
--
-- WHY THIS EXISTS NOW. Agency data used to be readable and writable by every
-- `authenticated` user. That was correct while accounts could only be minted by
-- hand in the Supabase dashboard: the only two accounts were the owner and the
-- cofounder. creator.html now offers self-serve signup, and creators share one
-- auth pool with staff — so "any signed-in user" would hand any stranger who
-- signs up full read AND DELETE on every client record, every brief, and the
-- whole video database. Agency tables therefore move to staff-only.
--
-- Creators are unaffected: they own exactly one row in lynxr_creators, which is
-- gated on auth.uid() at the bottom of this file, and nothing else.
create table if not exists public.lynxr_staff (
  id        uuid primary key references auth.users(id) on delete cascade,
  email     text        not null default '',
  added_at  timestamptz not null default now()
);

alter table public.lynxr_staff enable row level security;

-- A signed-in user may check their OWN membership and nothing else — the list
-- of who works here is not creator-readable. There are deliberately no insert,
-- update or delete policies: membership is granted from the dashboard only, so
-- a creator can never promote themselves.
drop policy if exists "user reads own staff row" on public.lynxr_staff;
create policy "user reads own staff row"
  on public.lynxr_staff for select
  to authenticated using (auth.uid() = id);

-- SECURITY DEFINER so the check itself can see the whole table while callers
-- still can't read anyone else's row through the policy above. Pinning
-- search_path stops a caller-controlled schema from shadowing lynxr_staff.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select exists (select 1 from public.lynxr_staff where id = auth.uid()) $$;

revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

-- Seed: everyone who already holds an account becomes staff. Self-serve signup
-- did not exist when those accounts were created, so each one is you or your
-- cofounder. Accounts created AFTER this runs are not promoted — which is the
-- whole point, so run this section BEFORE giving creator.html to anyone.
insert into public.lynxr_staff (id, email)
select id, coalesce(email, '') from auth.users
on conflict (id) do nothing;

-- Never leave the agency app locked out of itself. If the seed matched nothing,
-- stop here rather than applying staff-only policies with no staff.
do $$
begin
  if not exists (select 1 from public.lynxr_staff) then
    raise exception 'lynxr_staff is empty — add yourself before the policies below run, or the agency dashboard locks you out. See the comment above this block.';
  end if;
end $$;

-- Adding a teammate later is one statement:
--   insert into public.lynxr_staff (id, email)
--   select id, email from auth.users where email = 'them@example.com'
--   on conflict (id) do nothing;

create table if not exists public.lynxr_clients (
  id          text primary key,
  data        jsonb       not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create index if not exists lynxr_clients_updated_at_idx
  on public.lynxr_clients (updated_at desc);

alter table public.lynxr_clients enable row level security;

-- Staff share one workspace: you and your cofounder see and edit the same
-- clients, exactly as asked. Anonymous visitors get nothing — and neither does
-- a signed-in creator, which is the change from the original `using (true)`.
drop policy if exists "signed-in users read all clients"   on public.lynxr_clients;
drop policy if exists "signed-in users write all clients"  on public.lynxr_clients;
drop policy if exists "signed-in users update all clients" on public.lynxr_clients;
drop policy if exists "signed-in users delete all clients" on public.lynxr_clients;
drop policy if exists "staff read all clients"   on public.lynxr_clients;
drop policy if exists "staff write all clients"  on public.lynxr_clients;
drop policy if exists "staff update all clients" on public.lynxr_clients;
drop policy if exists "staff delete all clients" on public.lynxr_clients;

create policy "staff read all clients"
  on public.lynxr_clients for select
  to authenticated using (public.is_staff());

create policy "staff write all clients"
  on public.lynxr_clients for insert
  to authenticated with check (public.is_staff());

create policy "staff update all clients"
  on public.lynxr_clients for update
  to authenticated using (public.is_staff()) with check (public.is_staff());

create policy "staff delete all clients"
  on public.lynxr_clients for delete
  to authenticated using (public.is_staff());

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

-- Staff only. This is the agency's core asset — 9,000+ scraped, tagged and
-- transcribed rows — and creator.js never reads it, so a signed-in creator has
-- no reason to see any of it.
drop policy if exists "signed-in users read videos" on public.lynxr_videos;
drop policy if exists "staff read videos"          on public.lynxr_videos;
create policy "staff read videos"
  on public.lynxr_videos for select
  to authenticated using (public.is_staff());

drop trigger if exists lynxr_videos_touch on public.lynxr_videos;
create trigger lynxr_videos_touch
  before update on public.lynxr_videos
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Client video blueprints: the site uploads a raw video per client into this
-- private bucket; pipeline/process_blueprints.py (owner's machine) transcribes
-- it locally with Whisper and writes the verbatim script + timed beats back
-- into the client's row, then deletes the object. Files are transient.
-- Free-tier note: per-file limit is 50MB unless raised in the dashboard.
--
-- WRAPPED DEFENSIVELY ON PURPOSE. storage.objects and storage.buckets are owned
-- by the storage extension, and depending on the project the SQL editor's role
-- may not own them — the statements then fail with "must be owner of table
-- objects" / "permission denied". Because the editor runs the whole script in
-- ONE transaction, an unguarded failure here rolls back every table above it,
-- which looks exactly like "I ran the SQL and nothing happened".
--
-- The exception handler confines any such failure to this block: the tables and
-- policies above still commit, and you get a NOTICE telling you to set these
-- three policies from Storage → Policies in the dashboard instead. Nothing on
-- the creator side depends on them.
do $$
begin
  insert into storage.buckets (id, name, public)
    values ('lynxr-blueprints', 'lynxr-blueprints', false)
    on conflict (id) do nothing;

  -- Staff only, for the same reason as lynxr_clients: these objects belong to
  -- agency campaigns, and creators share the auth pool.
  execute 'drop policy if exists "team uploads blueprint videos" on storage.objects';
  execute 'create policy "team uploads blueprint videos" on storage.objects '
       || 'for insert to authenticated '
       || 'with check (bucket_id = ''lynxr-blueprints'' and public.is_staff())';

  execute 'drop policy if exists "team reads blueprint videos" on storage.objects';
  execute 'create policy "team reads blueprint videos" on storage.objects '
       || 'for select to authenticated '
       || 'using (bucket_id = ''lynxr-blueprints'' and public.is_staff())';

  execute 'drop policy if exists "team deletes blueprint videos" on storage.objects';
  execute 'create policy "team deletes blueprint videos" on storage.objects '
       || 'for delete to authenticated '
       || 'using (bucket_id = ''lynxr-blueprints'' and public.is_staff())';
exception when others then
  raise notice 'Blueprint storage policies skipped (%). Everything else applied. Set them from Storage -> Policies if you still use blueprint uploads.', sqlerrm;
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
-- `consent` is vestigial: the per-brand "is this a Lynx client?" opt-out was
-- removed 2026-08-11 and every source now pools into the shared library, so the
-- column is always 'full'. Kept rather than dropped so existing rows and the
-- upsert body stay valid. Nothing brand-identifying is stored here — the row
-- describes a public video, not who sent it or who it was for.
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


-- ---------------------------------------------------------------------------
-- CREATOR FEEDBACK — "what's broken, what should be better".
--
-- A separate table rather than a field on lynxr_creators so you can read every
-- creator's feedback in ONE query instead of walking every row's jsonb, and so
-- deleting a creator's account does not silently delete what they told you
-- (on delete set null, not cascade).
--
-- SECURITY: a creator may INSERT their own feedback and nothing else. There is
-- no select policy for `authenticated`, so no creator can read anyone's
-- feedback — including their own. Staff read it via is_staff(); the pipeline
-- reads it with the service-role key.
create table if not exists public.lynxr_feedback (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid references auth.users(id) on delete set null,
  email       text        not null default '',   -- who to reply to, if they said
  kind        text        not null default 'idea',  -- 'broken' | 'idea'
  message     text        not null,
  page        text        not null default '',   -- where they were when they wrote it
  created_at  timestamptz not null default now()
);

create index if not exists lynxr_feedback_created_idx on public.lynxr_feedback (created_at desc);

alter table public.lynxr_feedback enable row level security;

drop policy if exists "creator writes own feedback" on public.lynxr_feedback;
create policy "creator writes own feedback"
  on public.lynxr_feedback for insert
  to authenticated with check (auth.uid() = creator_id);

drop policy if exists "staff read feedback" on public.lynxr_feedback;
create policy "staff read feedback"
  on public.lynxr_feedback for select
  to authenticated using (public.is_staff());


-- ---------------------------------------------------------------------------
-- WAITLIST — the public landing page's email capture (2026-08-12)
-- ---------------------------------------------------------------------------
-- lynxr.io is a marketing page now; the app itself lives on an unlisted path
-- handed out by invitation. This is the only table an ANONYMOUS visitor may
-- write to, so it is deliberately the narrowest surface in the schema:
--
--   * insert only, and only for `anon` — nobody can read the list back, not
--     even the person who just joined it. An email list readable with the
--     publishable key (which is in this public repo) would be a leak.
--   * unique on email, so a double-tap or a refresh is not two rows.
--   * no free-text field. Nothing here is rendered anywhere, but a form open
--     to the internet with a message box is a spam magnet and an XSS surface.
--
-- Read it in the dashboard, or with the service-role key.
create table if not exists public.lynxr_waitlist (
  email       text        primary key,
  source      text        not null default 'landing',  -- which page/campaign
  created_at  timestamptz not null default now()
);

alter table public.lynxr_waitlist enable row level security;

drop policy if exists "anyone may join the waitlist" on public.lynxr_waitlist;
create policy "anyone may join the waitlist"
  on public.lynxr_waitlist for insert
  to anon, authenticated with check (true);

drop policy if exists "staff read the waitlist" on public.lynxr_waitlist;
create policy "staff read the waitlist"
  on public.lynxr_waitlist for select
  to authenticated using (public.is_staff());


-- ---------------------------------------------------------------------------
-- SIGNUP SEATS — signup closes itself once the invited group is full
-- (owner's ask, 2026-08-12)
-- ---------------------------------------------------------------------------
-- Mirrored in supabase/signup_gate.sql, which is the standalone copy to paste
-- if you only want this part. Keep the two in step if you edit either.
--
-- Four outside creators, then /auth/v1/signup starts refusing. The rule lives
-- in Postgres because the publishable key and the app's path are both in this
-- public repo — a check in creator.js is a suggestion anyone can skip by
-- POSTing to the endpoint directly. creator.js asks signup_open() as well, but
-- only so the gate can say "we're full" in words instead of showing a 500.
--
-- Sign-in is untouched: existing creators keep working whether or not seats
-- remain. This closes the front door only.
--
-- `internal` is the list of addresses that DO NOT consume a seat — yours, your
-- cofounder's, and the test aliases. Everyone else counts.
create table if not exists public.lynxr_signup_gate (
  id        int    primary key default 1,
  seats     int    not null default 4,
  internal  text[] not null default '{}',
  constraint lynxr_signup_gate_one_row check (id = 1)
);

-- Seeded ONCE. `do nothing` is deliberate: re-running this file must never
-- silently reopen signups you have since closed, or wipe an address you added
-- to `internal` by hand.
insert into public.lynxr_signup_gate (id, seats, internal)
values (1, 4, array[
  'junsaemail@gmail.com',
  'gawinhsu99@gmail.com',
  'lynxmedianetwork@gmail.com',
  'lynxrnetwork@gmail.com',
  -- Aliases and .edu addresses of the same two people.
  'junsaemail+t1@gmail.com',
  'junsaemail+t2@gmail.com',
  'gawin@bu.edu',
  'junsa@bu.edu'
])
on conflict (id) do nothing;

alter table public.lynxr_signup_gate enable row level security;

drop policy if exists "staff read the signup gate" on public.lynxr_signup_gate;
create policy "staff read the signup gate"
  on public.lynxr_signup_gate for select
  to authenticated using (public.is_staff());

-- Boolean, never a count. "3 seats left" would tell any anonymous visitor how
-- many creators lynxr has.
create or replace function public.signup_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*)
            from auth.users u
            join public.lynxr_signup_gate g on g.id = 1
           where lower(u.email) <> all (g.internal))
         < (select seats from public.lynxr_signup_gate where id = 1);
$$;

grant execute on function public.signup_open() to anon, authenticated;

-- FAIL-OPEN on a missing config row: a dropped table should cost you an
-- unwanted signup, not lock every account out of your own product.
create or replace function public.enforce_signup_seats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.lynxr_signup_gate%rowtype;
  taken int;
begin
  select * into g from public.lynxr_signup_gate where id = 1;
  if not found then
    return new;
  end if;

  if lower(new.email) = any (g.internal) then
    return new;
  end if;

  select count(*) into taken
    from auth.users u
   where lower(u.email) <> all (g.internal);

  if taken >= g.seats then
    -- GoTrue turns this into a generic 500, so the text is for your logs.
    raise exception 'lynxr: signups are closed — all % seats are taken', g.seats
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.enforce_signup_seats() to supabase_auth_admin;

drop trigger if exists lynxr_signup_seats on auth.users;
create trigger lynxr_signup_seats
  before insert on auth.users
  for each row execute function public.enforce_signup_seats();

-- NOTE: this applies to the dashboard too. Once seats are full, "Add user" in
-- Authentication → Users fails the same way. To let someone in after that:
--   update public.lynxr_signup_gate set seats = seats + 1 where id = 1;
--   update public.lynxr_signup_gate
--      set internal = internal || 'them@example.com' where id = 1;


-- ---------------------------------------------------------------------------
-- INVITES — which specific people may sign up (owner's ask, 2026-08-12)
-- ---------------------------------------------------------------------------
-- Mirrored in supabase/invites.sql, the standalone copy. Keep the two in step.
--
-- The seat gate above answers "how many outsiders may exist". At a waitlist of
-- a thousand people the question becomes "WHICH of them", and a counter cannot
-- express that: tell fifty waitlisted people they're in and the first fifty
-- strangers who find the URL take the places. The path and the publishable key
-- are both in this public repo, so that is not paranoia.
--
-- This also REPLACES EMAIL CONFIRMATION as the verification step, which is why
-- mailer_autoconfirm can stay on. A confirmation email proves someone can read
-- an inbox; an invite code delivered to that inbox proves the same thing, before
-- the account exists, using an email you send rather than Supabase's built-in
-- mailer (a few messages an hour, not a delivery service).
--
-- Defaults to OFF so applying this changes nothing today. Turn on with:
--   update public.lynxr_signup_gate set require_invite = true where id = 1;
-- When on, invites ARE the cap and `seats` is ignored — otherwise 50 invites
-- against 4 seats would refuse 46 of them.
alter table public.lynxr_signup_gate
  add column if not exists require_invite boolean not null default false;

create table if not exists public.lynxr_invites (
  email        text        primary key,
  code         text        not null,
  note         text        not null default '',
  created_at   timestamptz not null default now(),
  redeemed_at  timestamptz,
  redeemed_by  uuid
);

alter table public.lynxr_invites enable row level security;

-- No anon/authenticated policies: the browser never reads this table. The
-- trigger does, as definer. An anon-readable invite table would hand every code
-- to anyone holding the publishable key.
drop policy if exists "staff read invites" on public.lynxr_invites;
create policy "staff read invites"
  on public.lynxr_invites for select
  to authenticated using (public.is_staff());

drop policy if exists "staff write invites" on public.lynxr_invites;
create policy "staff write invites"
  on public.lynxr_invites for all
  to authenticated using (public.is_staff()) with check (public.is_staff());

-- Codes get typed and read aloud, so the alphabet drops I, O, 0 and 1 — same
-- rule as the adaptation tracking codes.
create or replace function public.new_invite_code()
returns text
language sql
volatile
as $$
  select string_agg(
    substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 8);
$$;

-- One call, two facts, no counts.
drop function if exists public.signup_open();

create or replace function public.signup_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'invite_required', g.require_invite,
    'open', case
              when g.require_invite then true
              else (select count(*) from auth.users u
                     where lower(u.email) <> all (g.internal)) < g.seats
            end)
    from public.lynxr_signup_gate g
   where g.id = 1;
$$;

grant execute on function public.signup_state() to anon, authenticated;

-- The code travels as signup metadata: creator.js posts
-- {email, password, data:{invite:"..."}} and GoTrue lands `data` in
-- raw_user_meta_data before this trigger runs.
drop trigger if exists lynxr_signup_seats on auth.users;
drop function if exists public.enforce_signup_seats();

create or replace function public.enforce_signup_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  g        public.lynxr_signup_gate%rowtype;
  inv      public.lynxr_invites%rowtype;
  supplied text;
  taken    int;
begin
  select * into g from public.lynxr_signup_gate where id = 1;
  if not found then
    return new;
  end if;

  if lower(new.email) = any (g.internal) then
    return new;
  end if;

  if g.require_invite then
    select * into inv
      from public.lynxr_invites
     where lower(email) = lower(new.email)
       and redeemed_at is null;

    if not found then
      raise exception 'lynxr: no invite for this address'
        using errcode = 'check_violation';
    end if;

    supplied := upper(coalesce(new.raw_user_meta_data->>'invite', ''));
    if supplied = '' or supplied <> upper(inv.code) then
      raise exception 'lynxr: invite code does not match'
        using errcode = 'check_violation';
    end if;

    -- Same transaction as the insert, so a signup that fails later rolls the
    -- redemption back with it and the invite stays usable.
    update public.lynxr_invites
       set redeemed_at = now(), redeemed_by = new.id
     where email = inv.email;

    return new;
  end if;

  select count(*) into taken
    from auth.users u
   where lower(u.email) <> all (g.internal);

  if taken >= g.seats then
    raise exception 'lynxr: signups are closed — all % seats are taken', g.seats
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.enforce_signup_gate() to supabase_auth_admin;

drop trigger if exists lynxr_signup_gate on auth.users;
create trigger lynxr_signup_gate
  before insert on auth.users
  for each row execute function public.enforce_signup_gate();
