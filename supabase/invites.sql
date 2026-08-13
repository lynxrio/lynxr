-- Lynxr invites — run this once in the Supabase SQL editor, AFTER signup_gate.sql.
-- Dashboard → SQL Editor → New query → paste → Run.
--
-- Mirrored at the foot of schema.sql for fresh applies. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS (owner's ask, 2026-08-12)
-- ---------------------------------------------------------------------------
-- The seat gate answers "how many outsiders may exist". At a waitlist of a
-- thousand people the question changes to "WHICH of them may exist", and a
-- counter cannot express that: tell fifty waitlisted people they're in, and the
-- first fifty strangers who find the URL take the places instead. The path and
-- the publishable key are both in a public repo, so that is not paranoia.
--
-- So: an invite is issued per EMAIL, carries a one-time CODE, and is consumed
-- at signup. Nobody without one gets in, however many seats are free.
--
-- THIS ALSO REPLACES EMAIL CONFIRMATION AS THE VERIFICATION STEP, which is the
-- reason `mailer_autoconfirm` can stay on. A confirmation email proves someone
-- can read that inbox. An invite code delivered to that inbox proves the same
-- thing — and it proves it BEFORE the account exists rather than after, using
-- an email you send yourself instead of Supabase's built-in mailer, which is a
-- few messages an hour and not a delivery service. When you do wire real SMTP
-- you can switch confirmation on as well; the app already handles both answers
-- from /auth/v1/signup, so that is a dashboard toggle and not a code change.
--
-- ---------------------------------------------------------------------------
-- THE SWITCH
-- ---------------------------------------------------------------------------
-- Defaults to OFF, so applying this file changes nothing about how signup
-- behaves today — the seat gate keeps running exactly as it does now. Turn it
-- on when you start working from the waitlist:
--
--   update public.lynxr_signup_gate set require_invite = true where id = 1;
--
-- NOTE: when require_invite is on, invites ARE the cap and `seats` is ignored.
-- Otherwise issuing 50 invites against 4 seats would refuse 46 of them, which
-- is the kind of double-gate that looks like a bug at 2am.
alter table public.lynxr_signup_gate
  add column if not exists require_invite boolean not null default false;

-- ---------------------------------------------------------------------------
-- THE INVITES
-- ---------------------------------------------------------------------------
-- One row per invited address. `email` is the primary key, so re-inviting the
-- same person updates rather than duplicates.
create table if not exists public.lynxr_invites (
  email        text        primary key,
  code         text        not null,
  note         text        not null default '',   -- why you invited them
  created_at   timestamptz not null default now(),
  redeemed_at  timestamptz,                       -- null = still outstanding
  redeemed_by  uuid                               -- auth.users.id, once used
);

alter table public.lynxr_invites enable row level security;

-- No anon or authenticated policies AT ALL. The signup path never reads this
-- table from the browser — the trigger does, as definer. An anon-readable
-- invite table would hand every code to anyone holding the publishable key,
-- which is in the public repo.
drop policy if exists "staff read invites" on public.lynxr_invites;
create policy "staff read invites"
  on public.lynxr_invites for select
  to authenticated using (public.is_staff());

drop policy if exists "staff write invites" on public.lynxr_invites;
create policy "staff write invites"
  on public.lynxr_invites for all
  to authenticated using (public.is_staff()) with check (public.is_staff());

-- Codes get read off a screen and typed, or said out loud down a phone, so the
-- alphabet drops I, O, 0 and 1 — the same rule the adaptation tracking codes
-- use, for the same reason.
create or replace function public.new_invite_code()
returns text
language sql
volatile
as $$
  select string_agg(
    substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 8);
$$;

-- ---------------------------------------------------------------------------
-- WHAT THE PAGE ASKS
-- ---------------------------------------------------------------------------
-- One call, two facts, no counts: whether the door is open at all, and whether
-- an invite code is needed to walk through it. Never returns how many seats are
-- left — that is a business number and this endpoint is anonymous.
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
              when g.require_invite then true      -- judged per-email instead
              else (select count(*) from auth.users u
                     where lower(u.email) <> all (g.internal)) < g.seats
            end)
    from public.lynxr_signup_gate g
   where g.id = 1;
$$;

grant execute on function public.signup_state() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- THE LOCK
-- ---------------------------------------------------------------------------
-- Replaces enforce_signup_seats. Still BEFORE INSERT on auth.users, still
-- fail-open on a missing config row, and still lets internal addresses through
-- untouched.
--
-- The code travels as signup metadata: creator.js posts
-- {email, password, data:{invite:"..."}} and GoTrue lands `data` in
-- raw_user_meta_data before this runs, so the trigger can read it.
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
    return new;                                   -- unconfigured: not our business
  end if;

  if lower(new.email) = any (g.internal) then
    return new;                                   -- yours, always
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

    -- Burn it. Same transaction as the insert, so a signup that fails later
    -- rolls the redemption back with it and the invite stays usable.
    update public.lynxr_invites
       set redeemed_at = now(), redeemed_by = new.id
     where email = inv.email;

    return new;                                   -- invites are the cap; seats ignored
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

-- ---------------------------------------------------------------------------
-- WORKING THE WAITLIST
-- ---------------------------------------------------------------------------
-- Invite the 50 longest-waiting people who don't have an invite yet:
--
--   insert into public.lynxr_invites (email, code, note)
--   select w.email, public.new_invite_code(), 'wave 1'
--     from public.lynxr_waitlist w
--    where not exists (select 1 from public.lynxr_invites i where i.email = w.email)
--    order by w.created_at
--    limit 50
--   on conflict (email) do nothing;
--
-- Then read out the links to send. Each one lands on the signup form with the
-- address and code already filled in:
--
--   select email,
--          'https://lynxr.io/creatorsonly/?signup=1&e=' || email || '&c=' || code as link
--     from public.lynxr_invites
--    where redeemed_at is null
--    order by created_at;
--
-- Who has actually joined:
--
--   select email, created_at, redeemed_at from public.lynxr_invites
--    order by redeemed_at nulls last, created_at;
--
-- Un-invite someone who has not signed up yet:
--
--   delete from public.lynxr_invites where email = 'them@example.com' and redeemed_at is null;
