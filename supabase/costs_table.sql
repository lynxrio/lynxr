-- Lynxr — what the pipeline actually spent, per pass, per model.
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent.
--
-- WHY THIS EXISTS. pipeline/process_adaptations.py has counted tokens per model
-- per script since 2026-08-16 (note_usage) and priced them (log_usage, PRICES)
-- — and then sent the dollar figure to log.info and nowhere else. There has
-- never been a queryable cost history, so "are costs going up" could only be
-- answered by scrolling Fly logs that do not survive a deploy. This table is
-- that history.
--
-- WHY IT IS NOT A COLUMN ON lynxr_script_charges. refund_script() DELETES the
-- charge row whenever a pass produced nothing (process_adaptations.refund()),
-- and a pass that produced nothing is exactly the pass whose cost matters most
-- — three Opus calls before a 529 cost the same as three that worked. A cost
-- ledger that a refund erases is not a cost ledger.
--
-- WHY A PLAIN STAFF-READ POLICY IS RIGHT HERE, unlike lynxr_creators. Every
-- column below is our own operational number. There is no creator id, no email,
-- no source URL, no title, no script — only `id8`, the same first-8-characters
-- of an adaptation id that watchdog.py already puts in an alarm body. So a
-- reviewed select policy is the narrow tool, and the security definer function
-- supabase/usage_overview.sql needs is unnecessary here. Do not wrap this.
--
-- WHY TOKENS **AND** DOLLARS. PRICES is a hand-maintained table and its own
-- comment warns that a stale number "reads as measured when it isn't". Storing
-- the token counts alongside the dollars means a price change can be re-applied
-- to history instead of silently invalidating it; `price_rev` records which
-- price list produced the number.
--
-- READ-ONLY FROM THE BROWSER, ENFORCED BY THE DATABASE: there is no insert,
-- update or delete policy. The pipeline writes with the service-role key, which
-- bypasses RLS, exactly like lynxr_sources and lynxr_ops.
--
-- THIS FILE DOES NOT REDEFINE ANY FUNCTION THAT LIVES ELSEWHERE. It calls
-- public.is_staff() (defined in supabase/schema.sql / staff_gate.sql) inside a
-- policy's USING clause; it does not `create or replace function` it or
-- anything else. Nothing here can shadow a newer definition the way a stray
-- re-run of allowance_ledger.sql can. To prove which version of is_staff() is
-- live: `select prosrc from pg_proc where proname = 'is_staff';` in the SQL
-- editor.

create table if not exists public.lynxr_costs (
  id                 bigint generated always as identity primary key,
  at                 timestamptz not null default now(),
  -- First 8 characters of the adaptation id. NEVER the full id, never the
  -- creator id, never a URL. Enough to correlate one expensive pass with an
  -- alarm body; not enough to attribute spend to a person.
  id8                text        not null default '',
  ok                 boolean     not null,   -- did this pass produce a usable result
  model              text        not null,
  calls              int         not null default 0,
  tokens_in          bigint      not null default 0,
  tokens_out         bigint      not null default 0,
  tokens_cache_write bigint      not null default 0,
  tokens_cache_read  bigint      not null default 0,
  usd                numeric(12,6) not null default 0,
  -- '' means NO PRICE WAS ON FILE for this model and `usd` is a placeholder,
  -- not a measurement of zero. The Ops tab counts these separately and says so.
  price_rev          text        not null default ''
);
create index if not exists lynxr_costs_at_idx on public.lynxr_costs (at desc);

alter table public.lynxr_costs enable row level security;

drop policy if exists "staff read costs" on public.lynxr_costs;
create policy "staff read costs"
  on public.lynxr_costs for select to authenticated using (public.is_staff());

-- PostgREST caches the schema; a missing table reads in the browser as a 404
-- (PGRST205) and this is a one-line way to rule that out.
notify pgrst, 'reload schema';

-- Same guard ops_table.sql and sources_staff_read.sql use: refuse to leave a
-- staff-gated object in place with nobody in the staff table, because that
-- looks identical to "the query is wrong".
do $$
begin
  if not exists (select 1 from public.lynxr_staff) then
    raise exception
      'lynxr_staff is empty — run staff_gate.sql first, or this policy hides lynxr_costs from everyone';
  end if;
end $$;

-- ── Check it ────────────────────────────────────────────────────────────────
--   select count(*), sum(usd) from public.lynxr_costs;
--   select date_trunc('day', at) d, sum(usd) from public.lynxr_costs
--    group by 1 order by 1 desc limit 14;
--   select model, count(*), sum(usd) from public.lynxr_costs group by 1;
-- Nothing appears until the pipeline change in this plan is DEPLOYED to Fly.
