-- Lynxr — a table for the watchdog to remember what it already told the owner.
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent.
--
-- WHY THIS EXISTS. pipeline/watchdog.py evaluates a fixed set of invariants
-- against the live database and pushes a notification to the owner's phone
-- (ntfy.sh) when one breaks. Without somewhere durable to remember "this
-- alarm is already open", every tick that finds the same problem would page
-- again — and without somewhere durable to remember "the worker is still
-- alive", a restart of whichever process is checking would look like a fresh
-- outage. This table is that memory. Two key families live in it:
--
--   worker.heartbeat   one row, written by the Fly worker every ~60s, so an
--                       independent checker (the GitHub fallback loop) can
--                       tell "worker is dead" from "I haven't looked yet".
--   alarm.<key>         one row per open alarm (e.g. alarm.worker-down,
--                       alarm.inflight:a1b2c3d4), so raise_alarm() pages once
--                       per episode instead of once per tick, and clear_alarm()
--                       can send a quiet "resolved" the moment it clears.
--
-- DEGRADES SAFELY IF THIS TABLE DOES NOT EXIST YET. watchdog.py's ops_get /
-- ops_put / ops_del all catch the failure and fall back to an in-process
-- dict latch — worse (no memory across restarts, so a page can repeat after
-- one), but never a crash and never silence. The code in this plan is safe to
-- ship before this SQL is run; running it just makes the latch durable.

create table if not exists public.lynxr_ops (
  key        text primary key,
  value      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The one query the digest and any future ops panel actually issues: "what
-- changed recently". Same shape as lynxr_sources_tagcount_idx's reasoning —
-- index the sort that will actually be used, not every column.
create index if not exists lynxr_ops_updated_idx on public.lynxr_ops (updated_at desc);

alter table public.lynxr_ops enable row level security;

-- SELECT ONLY, and only for staff. Deliberately no insert/update/delete
-- policy: the pipeline writes with the service-role key, which bypasses RLS,
-- exactly like lynxr_sources — the browser never needs write access and must
-- not have it.
drop policy if exists "staff read ops" on public.lynxr_ops;
create policy "staff read ops"
  on public.lynxr_ops for select to authenticated using (public.is_staff());

-- Refuse to leave the table readable if the staff table is empty — otherwise a
-- policy referencing is_staff() with nobody in lynxr_staff silently hides the
-- data from everyone including you, and it looks identical to "the query is
-- wrong". Same guard sources_staff_read.sql and staff_gate.sql use.
do $$
begin
  if not exists (select 1 from public.lynxr_staff) then
    raise exception
      'lynxr_staff is empty — run staff_gate.sql first, or this policy hides lynxr_ops from everyone';
  end if;
end $$;

-- ── Check it ────────────────────────────────────────────────────────────────
-- Run these after. The first must be true FOR YOU (signed in as staff in the
-- SQL editor it will be false — auth.uid() is null there — so verify from the
-- app instead, or with a staff user's JWT).
--   select public.is_staff();
--   select * from public.lynxr_ops order by updated_at desc;
--   select * from public.lynxr_ops where key = 'worker.heartbeat';
