-- Agency sends a brief to roster creators (plan:
-- ~/.claude/plans/agency-send-brief-to-creators.md). STAFF ONLY on the write
-- side; the creator side reads through four SECURITY DEFINER functions and
-- never touches these tables directly.
--
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent.
-- **No real email address, code or uuid anywhere in this file — the repo is
-- public.**

do $$ begin
  if to_regclass('public.lynxr_staff') is null then
    raise exception 'lynxr_staff missing — run supabase/staff_gate.sql first';
  end if;
  if not exists (select 1 from public.lynxr_staff) then
    raise exception 'lynxr_staff is empty — these policies would hide the roster from everyone';
  end if;
  if to_regprocedure('public.new_invite_code()') is null then
    raise exception 'public.new_invite_code() missing — run supabase/invites.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------------
-- lynxr_roster: one row per invited address. Invite-before-account — the seat
-- is claimed later by accept_agency_invite(), which fills in creator_id.
-- The join code reuses public.new_invite_code() from invites.sql (alphabet
-- without I, O, 0, 1 — codes get read out loud). Do NOT redefine it here.
create table if not exists public.lynxr_roster (
  email        text primary key check (email = lower(email) and email <> ''),
  code         text not null default public.new_invite_code(),
  creator_id   uuid references auth.users(id) on delete cascade,
  status       text not null default 'invited' check (status in ('invited','accepted','left')),
  display_name text not null default '',   -- what staff call them; never reaches the creator
  note         text not null default '',   -- agency only
  invited_by   uuid,                       -- staff auth.uid(); no FK, so history survives a staff removal
  invited_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  left_at      timestamptz
);
-- One account, one seat (decision 3).
create unique index if not exists lynxr_roster_creator_uidx
  on public.lynxr_roster (creator_id) where creator_id is not null;

-- lynxr_agency_briefs: the creator-facing SNAPSHOT, built once at send time by
-- agencySendDoc() / briefSendDoc() in app.js. Not a live reference — see the
-- plan's "security model" section for why.
create table if not exists public.lynxr_agency_briefs (
  id          uuid primary key default gen_random_uuid(),
  client_name text not null default '',
  title       text not null default '',
  doc         jsonb not null,             -- the creator-facing snapshot; built by agencySendDoc() in app.js
  source_kind text not null default 'campaign' check (source_kind in ('campaign','brief')),
  source_id   text not null default '',   -- provenance ONLY; never read for content
  sent_by     uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint lynxr_agency_briefs_doc_size check (octet_length(doc::text) <= 524288)
);

-- lynxr_agency_deliveries: who a brief was sent to, and whether it is still
-- live. revoked_at non-null = unsent; the read functions refuse it.
create table if not exists public.lynxr_agency_deliveries (
  brief_id   uuid not null references public.lynxr_agency_briefs(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  sent_at    timestamptz not null default now(),
  revoked_at timestamptz,                  -- non-null = unsent; the read functions refuse it
  primary key (brief_id, creator_id)
);
create index if not exists lynxr_agency_deliveries_creator_idx
  on public.lynxr_agency_deliveries (creator_id) where revoked_at is null;

-- The doc size cap follows write_guards.sql's reasoning: a creator fetches
-- their briefs on every app load, so one oversized doc is everyone's egress
-- bill. 512 KB is ~10× a ten-format brief.

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists touch_lynxr_agency_briefs on public.lynxr_agency_briefs;
create trigger touch_lynxr_agency_briefs
  before update on public.lynxr_agency_briefs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.lynxr_roster            enable row level security;
alter table public.lynxr_agency_briefs     enable row level security;
alter table public.lynxr_agency_deliveries enable row level security;

revoke all on table public.lynxr_roster            from anon;
revoke all on table public.lynxr_agency_briefs     from anon;
revoke all on table public.lynxr_agency_deliveries from anon;

-- NO anon/authenticated policies on any of the three, on purpose — the same
-- pattern as lynxr_sources, lynxr_script_charges, lynxr_allowance and the four
-- lynxr_billing* tables. Everything a creator may see comes back through
-- my_agency() / my_agency_brief(), which expose only the fields that are safe
-- to hand them. A browser must never be able to read another creator's row,
-- or the roster's note/code/invited_by columns.

drop policy if exists "staff read roster" on public.lynxr_roster;
create policy "staff read roster"
  on public.lynxr_roster for select to authenticated using (public.is_staff());
drop policy if exists "staff insert roster" on public.lynxr_roster;
create policy "staff insert roster"
  on public.lynxr_roster for insert to authenticated with check (public.is_staff());
drop policy if exists "staff update roster" on public.lynxr_roster;
create policy "staff update roster"
  on public.lynxr_roster for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists "staff delete roster" on public.lynxr_roster;
create policy "staff delete roster"
  on public.lynxr_roster for delete to authenticated using (public.is_staff());

drop policy if exists "staff read agency briefs" on public.lynxr_agency_briefs;
create policy "staff read agency briefs"
  on public.lynxr_agency_briefs for select to authenticated using (public.is_staff());
drop policy if exists "staff insert agency briefs" on public.lynxr_agency_briefs;
create policy "staff insert agency briefs"
  on public.lynxr_agency_briefs for insert to authenticated with check (public.is_staff());
drop policy if exists "staff update agency briefs" on public.lynxr_agency_briefs;
create policy "staff update agency briefs"
  on public.lynxr_agency_briefs for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists "staff delete agency briefs" on public.lynxr_agency_briefs;
create policy "staff delete agency briefs"
  on public.lynxr_agency_briefs for delete to authenticated using (public.is_staff());

drop policy if exists "staff read agency deliveries" on public.lynxr_agency_deliveries;
create policy "staff read agency deliveries"
  on public.lynxr_agency_deliveries for select to authenticated using (public.is_staff());
-- The one non-obvious policy — decision 1 + 2, enforced in the database
-- rather than the UI: staff may only create a delivery row for a roster
-- member who has actually accepted, never an invited-or-left address.
drop policy if exists "staff send to accepted roster only" on public.lynxr_agency_deliveries;
create policy "staff send to accepted roster only"
  on public.lynxr_agency_deliveries for insert to authenticated
  with check (public.is_staff() and exists (
    select 1 from public.lynxr_roster r
     where r.creator_id = lynxr_agency_deliveries.creator_id
       and r.status = 'accepted'));
drop policy if exists "staff update agency deliveries" on public.lynxr_agency_deliveries;
create policy "staff update agency deliveries"
  on public.lynxr_agency_deliveries for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists "staff delete agency deliveries" on public.lynxr_agency_deliveries;
create policy "staff delete agency deliveries"
  on public.lynxr_agency_deliveries for delete to authenticated using (public.is_staff());

-- ---------------------------------------------------------------------------
-- FUNCTIONS — all SECURITY DEFINER, search_path pinned empty so every
-- reference below is schema-qualified, and none of them take a creator
-- identity as a parameter: each one filters on auth.uid() internally, which
-- is what makes "creator B cannot read creator A's brief" structural.
-- ---------------------------------------------------------------------------

drop function if exists public.my_agency();
create or replace function public.my_agency()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_row   public.lynxr_roster%rowtype;
  v_state text;
  v_briefs jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('state', 'none', 'briefs', '[]'::jsonb);
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid;

  select r.* into v_row
    from public.lynxr_roster r
   where r.creator_id = v_uid or (r.creator_id is null and r.email = v_email)
   order by (r.creator_id = v_uid) desc nulls last
   limit 1;

  if not found then
    return jsonb_build_object('state', 'none', 'briefs', '[]'::jsonb);
  end if;

  v_state := v_row.status;

  if v_state = 'accepted' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', b.id,
             'title', b.title,
             'client_name', b.client_name,
             'sent_at', d.sent_at,
             'formats', coalesce(jsonb_array_length(b.doc->'formats'), 0)
           ) order by d.sent_at desc), '[]'::jsonb)
      into v_briefs
      from public.lynxr_agency_deliveries d
      join public.lynxr_agency_briefs b on b.id = d.brief_id
     where d.creator_id = v_uid and d.revoked_at is null;
  else
    v_briefs := '[]'::jsonb;
  end if;

  return jsonb_build_object('state', v_state, 'briefs', v_briefs);
end;
$$;

revoke all on function public.my_agency() from public, anon;
grant execute on function public.my_agency() to authenticated;

drop function if exists public.my_agency_brief(uuid);
create or replace function public.my_agency_brief(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select b.doc
    from public.lynxr_agency_deliveries d
    join public.lynxr_agency_briefs b on b.id = d.brief_id
    join public.lynxr_roster r on r.creator_id = d.creator_id
   where d.brief_id = p_id
     and d.creator_id = auth.uid()
     and d.revoked_at is null
     and r.status = 'accepted';
$$;

revoke all on function public.my_agency_brief(uuid) from public, anon;
grant execute on function public.my_agency_brief(uuid) to authenticated;

-- Returns {"ok": false} for a wrong code, an unknown address and a stale
-- session alike — one answer, no oracle.
drop function if exists public.accept_agency_invite(text);
create or replace function public.accept_agency_invite(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  n       int;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_email is null or v_email = '' then
    return jsonb_build_object('ok', false);
  end if;

  -- One account, one seat (decision 3) — pre-checked so the unique index
  -- never has to raise.
  if exists (
    select 1 from public.lynxr_roster
     where creator_id = v_uid and email <> v_email
  ) then
    return jsonb_build_object('ok', false);
  end if;

  update public.lynxr_roster
     set creator_id = v_uid, status = 'accepted', accepted_at = now(), left_at = null
   where email = v_email
     and btrim(coalesce(p_code, '')) <> ''
     and upper(code) = upper(btrim(p_code))
     and (creator_id is null or creator_id = v_uid)
     and status in ('invited', 'left');

  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0);
end;
$$;

revoke all on function public.accept_agency_invite(text) from public, anon;
grant execute on function public.accept_agency_invite(text) to authenticated;

drop function if exists public.leave_agency();
create or replace function public.leave_agency()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n int;
begin
  update public.lynxr_roster
     set status = 'left', left_at = now()
   where creator_id = auth.uid() and status = 'accepted';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0);
end;
$$;

revoke all on function public.leave_agency() from public, anon;
grant execute on function public.leave_agency() to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Invite someone (do NOT paste a real address into this file — run it in the editor):
--   insert into public.lynxr_roster (email, display_name, note, invited_by)
--   values (lower('them@example.com'), 'Their name', 'wave 1', auth.uid())
--   on conflict (email) do nothing;
--
-- The code to read out on Discord:
--   select email, code, status from public.lynxr_roster where status <> 'accepted' order by invited_at;
--
-- Who is on the roster:
--   select email, status, (creator_id is not null) as has_account, invited_at, accepted_at, left_at
--     from public.lynxr_roster order by invited_at desc;
--
-- What has been sent, and how much of it is still live:
--   select b.title, b.client_name, b.created_at,
--          count(*) filter (where d.revoked_at is null)     as live,
--          count(*) filter (where d.revoked_at is not null) as unsent
--     from public.lynxr_agency_briefs b
--     left join public.lynxr_agency_deliveries d on d.brief_id = b.id
--    group by b.id, b.title, b.client_name, b.created_at order by b.created_at desc;
--
-- ISOLATION PROOF — one creator cannot read another's delivered briefs. Read-only,
-- rolled back, run in the SQL editor with two real uuids from auth.users:
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<CREATOR-B-UUID>","role":"authenticated"}';
--     select public.my_agency_brief('<BRIEF-ID-SENT-TO-A-ONLY>');   -- expect: null
--     select public.my_agency();                                    -- expect: state none/…, briefs []
--     select count(*) from public.lynxr_agency_briefs;               -- expect: 0
--     select count(*) from public.lynxr_agency_deliveries;           -- expect: 0
--     select count(*) from public.lynxr_roster;                      -- expect: 0
--   rollback;
