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
-- One login, not two.
--
-- The site currently needs a typed access code to decrypt data.enc. Adding a
-- Supabase login on top of that would mean two secrets for the same door. So
-- the bundle passphrase lives here instead, readable only once you are signed
-- in: log in, the page fetches it, decryption happens with nobody typing a
-- shared code. Rotating it stays a one-row update plus a re-encrypt.
create table if not exists public.lynxr_secrets (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

alter table public.lynxr_secrets enable row level security;

drop policy if exists "signed-in users read secrets" on public.lynxr_secrets;
create policy "signed-in users read secrets"
  on public.lynxr_secrets for select
  to authenticated using (true);

-- Seed the current bundle passphrase.
insert into public.lynxr_secrets (key, value)
values ('bundle_passphrase', 'lmaotsfiya')
on conflict (key) do update set value = excluded.value, updated_at = now();
