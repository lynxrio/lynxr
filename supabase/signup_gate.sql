-- Lynxr signup seats — run this once in the Supabase SQL editor.
-- Dashboard → SQL Editor → New query → paste → Run.
--
-- This block is also included at the foot of schema.sql, so a fresh apply of
-- the whole schema installs it too. Both are safe to re-run: the seed uses
-- `on conflict do nothing`, so re-running never resets seats you have edited.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES (owner's ask, 2026-08-12)
-- ---------------------------------------------------------------------------
-- Signup closes ITSELF once the invited group is full. Four outside creators,
-- then `/auth/v1/signup` starts refusing — no dashboard toggle to remember, no
-- window where the invite link quietly works for strangers.
--
-- WHY IN THE DATABASE AND NOT IN creator.js
-- The publishable key and the app's path are both in this public repo, so a
-- check in the page is a suggestion: anyone who reads the repo can POST to the
-- signup endpoint directly and skip it. Postgres is the only place the rule
-- cannot be routed around. creator.js checks signup_open() too, but only so the
-- gate can say "we're full" in words instead of showing a 500 — the lock here
-- is the one that counts.
--
-- WHAT IT DOES NOT DO
-- Sign-in is untouched. Everyone who already has an account keeps working
-- normally, whether or not seats remain. This closes the FRONT DOOR only.
--
-- ---------------------------------------------------------------------------
-- ONE ROW OF CONFIGURATION
-- ---------------------------------------------------------------------------
-- `internal` is the list of addresses that DO NOT consume a seat — yours, your
-- cofounder's, and the test aliases. Everyone else counts. Seeded below with
-- the eight accounts that existed on 2026-08-12; edit the array to change who
-- is "ours", or bump `seats` to open more places.
create table if not exists public.lynxr_signup_gate (
  id        int    primary key default 1,
  seats     int    not null default 4,
  internal  text[] not null default '{}',
  constraint lynxr_signup_gate_one_row check (id = 1)
);

-- Seeded ONCE. `do nothing` on conflict is deliberate: re-running schema.sql
-- must never silently reopen signups you have since closed, or wipe an address
-- you added to `internal` by hand.
insert into public.lynxr_signup_gate (id, seats, internal)
values (1, 4, array[
  'junsaemail@gmail.com',
  'gawinhsu99@gmail.com',
  'lynxmedianetwork@gmail.com',
  'lynxrnetwork@gmail.com',
  -- Aliases and .edu addresses of the same two people. They are yours, so they
  -- should not eat seats meant for creators. Remove any you would rather count.
  'junsaemail+t1@gmail.com',
  'junsaemail+t2@gmail.com',
  'gawin@bu.edu',
  'junsa@bu.edu'
])
on conflict (id) do nothing;

alter table public.lynxr_signup_gate enable row level security;

-- Nobody reads the raw row from the browser. The seat count is a business fact
-- and the internal list is a list of your own addresses; neither belongs behind
-- the publishable key. The page asks signup_open() instead, which answers a
-- bare yes/no. Staff can read the row itself.
drop policy if exists "staff read the signup gate" on public.lynxr_signup_gate;
create policy "staff read the signup gate"
  on public.lynxr_signup_gate for select
  to authenticated using (public.is_staff());

-- ---------------------------------------------------------------------------
-- THE ANSWER THE PAGE ASKS FOR
-- ---------------------------------------------------------------------------
-- Boolean, never a count. "3 seats left" would tell any anonymous visitor how
-- many creators lynxr has, which is nobody's business but yours.
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

-- ---------------------------------------------------------------------------
-- THE LOCK
-- ---------------------------------------------------------------------------
-- BEFORE INSERT on auth.users, so it refuses the account rather than cleaning
-- one up afterwards.
--
-- FAIL-OPEN, on purpose. If the configuration row is missing the trigger allows
-- the signup instead of refusing every account in the project. A dropped table
-- should cost you an unwanted signup, not lock you out of your own product —
-- the same reasoning as the staff gate's guard against an empty staff table.
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
    return new;                               -- unconfigured: not our business
  end if;

  -- Your own addresses never consume a seat, and are never refused one.
  if lower(new.email) = any (g.internal) then
    return new;
  end if;

  select count(*) into taken
    from auth.users u
   where lower(u.email) <> all (g.internal);

  if taken >= g.seats then
    -- GoTrue turns any exception here into a generic 500 ("Database error
    -- saving new user"), so this text is for YOUR logs, not the visitor's
    -- screen. creator.js is what says it in English.
    raise exception 'lynxr: signups are closed — all % seats are taken', g.seats
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- GoTrue inserts as `supabase_auth_admin`; make sure it can reach the function.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.enforce_signup_seats() to supabase_auth_admin;

drop trigger if exists lynxr_signup_seats on auth.users;
create trigger lynxr_signup_seats
  before insert on auth.users
  for each row execute function public.enforce_signup_seats();

-- ---------------------------------------------------------------------------
-- HEADS UP: this gate applies to the DASHBOARD too
-- ---------------------------------------------------------------------------
-- Once the seats are full, "Add user" in Authentication → Users fails the same
-- way a self-serve signup does — it is the same insert. To let someone in
-- after that, do one of these first:
--
--   update public.lynxr_signup_gate set seats = seats + 1 where id = 1;
--   update public.lynxr_signup_gate
--      set internal = internal || 'them@example.com' where id = 1;
--
-- WHO IS USING THE SEATS (run in the SQL editor):
--
--   select u.email, u.created_at, u.last_sign_in_at
--     from auth.users u, public.lynxr_signup_gate g
--    where g.id = 1 and lower(u.email) <> all (g.internal)
--    order by u.created_at;
