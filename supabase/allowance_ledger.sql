-- Lynxr allowance ledger — closes the three ways around the script-count cap.
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- The cap has always lived inside lynxr_creators.data — a JSONB blob the
-- creator owns and PATCHes wholesale on every save. That makes it a courtesy,
-- not a control, and there are THREE independent ways around it today, not
-- two:
--
--   1. `ME.adaptations = []; ME.trash = []; save({now:true})` from the
--      console — the count the worker read is gone, so the next paste looks
--      like the first one.
--   2. Sign up again. A fresh row starts the count at zero. (Closed
--      separately by switching signup to invite-only — see the runbook
--      below — but a determined creator with a second email still resets
--      their OWN allowance this way without this ledger.)
--   3. Paste a link, then set that entry's `addedAt` to something ancient
--      (e.g. "0001-01-01T00:00:00Z") and save. The worker's old allowance was
--      `sorted(adaptations + trash, key=addedAt)[:cap]` — the OLDEST `cap`
--      entries by that field — so a back-dated entry sorts to the front and
--      pushes an already-finished one out of the window. Nothing is re-run
--      (finished entries fail wants_work()) and nothing is refused: unlimited
--      scripts, `cap` at a time, by editing one field the creator controls.
--
-- All three exist because the ledger and the data being metered live in the
-- same place the creator can write. The fix is to move the ledger somewhere
-- they cannot: two tables with no `authenticated` policies at all, read back
-- through a SECURITY DEFINER function that exposes only two numbers.
--
-- ---------------------------------------------------------------------------
-- THE TABLES
-- ---------------------------------------------------------------------------

-- One row per script the account has ever been CHARGED for. The primary key
-- is what makes double-charging structurally impossible, and living outside
-- lynxr_creators is what makes it unresettable: the creator owns that blob
-- and PATCHes it whole on every save; they cannot PATCH this table at all.
create table if not exists public.lynxr_script_charges (
  adaptation_id text        primary key,
  creator_id    uuid        not null references auth.users(id) on delete cascade,
  charged_at    timestamptz not null default now()
);
create index if not exists lynxr_charges_creator_idx
  on public.lynxr_script_charges (creator_id, charged_at desc);
alter table public.lynxr_script_charges enable row level security;
-- NO policies for anon or authenticated, on purpose — service-role only,
-- exactly like lynxr_sources. The creator reads their number through
-- my_allowance() below, which they cannot forge.

-- Per-account grant. Absent row = the default. This is how the note the
-- worker already writes ("Ask us to raise the limit") gets honoured:
--   insert into public.lynxr_allowance (id, granted, note)
--   values ('<uuid>', 100, 'why') on conflict (id) do update set granted = 100;
create table if not exists public.lynxr_allowance (
  id          uuid        primary key references auth.users(id) on delete cascade,
  granted     int         not null default 25,
  period_days int         not null default 0,   -- 0 = lifetime; >0 = rolling window
  note        text        not null default '',
  updated_at  timestamptz not null default now()
);
alter table public.lynxr_allowance enable row level security;
-- NO authenticated policies. Same reason.
--
-- `period_days` is present from day one and defaults to 0 (lifetime). It is
-- what turns a lifetime trial into a subscription quota later WITHOUT another
-- migration: charge_scripts() and my_allowance() below already honour it.
-- Switching a paying creator to a monthly quota is exactly this one UPDATE:
--
--   update public.lynxr_allowance set granted = 200, period_days = 30
--    where id = '<uuid>';

-- ---------------------------------------------------------------------------
-- THE FUNCTIONS
-- ---------------------------------------------------------------------------

-- WHAT THE PAGE ASKS. Never a raw table read: the creator sees their own two
-- numbers and nothing else, and cannot write either.
create or replace function public.my_allowance()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'used', (
      select count(*) from public.lynxr_script_charges c
       where c.creator_id = auth.uid()
         and (a.period_days = 0
              or c.charged_at > now() - make_interval(days => a.period_days))),
    'granted', a.granted,
    'period_days', a.period_days)
  from (select coalesce((select l.granted     from public.lynxr_allowance l where l.id = auth.uid()), 25)     as granted,
               coalesce((select l.period_days from public.lynxr_allowance l where l.id = auth.uid()), 0)      as period_days) a;
$$;
revoke all on function public.my_allowance() from public, anon;
grant execute on function public.my_allowance() to authenticated;

-- THE CHARGE. Atomic and idempotent: re-charging an id already in the table
-- is a no-op (a re-claimed entry must not cost twice), and the LIMIT is
-- evaluated inside the same statement as the insert, so two workers cannot
-- both see room for the last script. Returns the ids that are now charged —
-- the caller treats exactly those as its allowance and refuses the rest.
create or replace function public.charge_scripts(p_creator uuid, p_ids text[])
returns setof text language plpgsql volatile security definer set search_path = ''
as $$
declare
  g   int;
  pd  int;
  spent int;
begin
  select coalesce(l.granted, 25), coalesce(l.period_days, 0) into g, pd
    from (select 1) x left join public.lynxr_allowance l on l.id = p_creator;
  select count(*) into spent from public.lynxr_script_charges c
   where c.creator_id = p_creator
     and (pd = 0 or c.charged_at > now() - make_interval(days => pd));

  return query
  with want as (
    select id, ord from unnest(p_ids) with ordinality as t(id, ord)
  ),
  already as (
    select w.id from want w
      join public.lynxr_script_charges c on c.adaptation_id = w.id
     where c.creator_id = p_creator
  ),
  fresh as (
    select w.id from want w
     where w.id not in (select id from already)
     order by w.ord
     limit greatest(g - spent, 0)
  ),
  ins as (
    insert into public.lynxr_script_charges (adaptation_id, creator_id)
    select id, p_creator from fresh
    on conflict (adaptation_id) do nothing
    returning adaptation_id
  )
  select id from already union all select adaptation_id from ins;
end $$;

-- THE REFUND. Only ever called when a download failed before any model call,
-- so nothing was actually spent. Never exposed to a creator.
create or replace function public.refund_script(p_id text)
returns void language sql volatile security definer set search_path = ''
as $$ delete from public.lynxr_script_charges where adaptation_id = p_id; $$;

revoke all on function public.charge_scripts(uuid, text[]) from public, anon, authenticated;
revoke all on function public.refund_script(text)          from public, anon, authenticated;
grant execute on function public.charge_scripts(uuid, text[]) to service_role;
grant execute on function public.refund_script(text)          to service_role;

-- ---------------------------------------------------------------------------
-- OPERATIONAL ONE-LINERS
-- ---------------------------------------------------------------------------
--
-- Raise (or lower) one creator's grant:
--
--   insert into public.lynxr_allowance (id, granted, note)
--   values ('<uuid>', 100, 'asked for more, 2026-xx-xx')
--   on conflict (id) do update set granted = excluded.granted,
--                                  note = excluded.note,
--                                  updated_at = now();
--
-- Top spenders, lifetime:
--
--   select creator_id, count(*) as scripts
--     from public.lynxr_script_charges
--    group by creator_id
--    order by scripts desc
--    limit 20;
--
-- Last 24h of charges:
--
--   select creator_id, adaptation_id, charged_at
--     from public.lynxr_script_charges
--    where charged_at > now() - interval '24 hours'
--    order by charged_at desc;
--
-- ---------------------------------------------------------------------------
-- RUNBOOK: switching the tester gate from seats to invites
-- ---------------------------------------------------------------------------
-- This is an OWNER action — nothing in this file runs it. Signup is closed
-- today by seat exhaustion (seats: 4, taken), not by anything that names WHO
-- may sign up. That is not the same lock: it keeps out nobody in particular,
-- and setting `seats` higher to let testers in would reopen the door to any
-- stranger who reads this (public) repo. Three statements, in order:
--
--   -- 1. Prove the trigger the whole gate depends on is actually installed.
--   select tgname, tgenabled from pg_trigger
--    where tgrelid = 'auth.users'::regclass and not tgisinternal;
--   --    want a row: lynxr_signup_gate, tgenabled = 'O'
--   --    (if this returns no row, supabase/invites.sql needs applying first —
--   --    nothing server-side is enforcing signup at all yet)
--
--   -- 2. Invites become the cap; `seats` is ignored from here on.
--   update public.lynxr_signup_gate set require_invite = true where id = 1;
--
--   -- 3. Issue five. Codes are generated in the database, never chosen by
--   --    hand — do not paste a real address or code into this file, or any
--   --    other file in this public repo.
--   insert into public.lynxr_invites (email, code, note)
--   values ('them@example.com', public.new_invite_code(), 'tester wave 1')
--   on conflict (email) do nothing;
--
--   select email, 'https://lynxr.io/creatorsonly/?signup=1&e=' || email || '&c=' || code
--     from public.lynxr_invites where redeemed_at is null order by created_at;
