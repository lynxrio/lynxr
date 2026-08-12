-- Lynxr creator feedback — standalone, no dependencies.
-- Dashboard → SQL Editor → New query → paste → Run.
--
-- WHY SEPARATE FROM schema.sql: the copy in schema.sql gives staff a read
-- policy via public.is_staff(), which does not exist until the staff gate has
-- been run. Running that whole file is a bigger change than you want right now,
-- and if any part of it fails the SQL editor rolls back everything including
-- this table. Nothing below depends on anything.

create table if not exists public.lynxr_feedback (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid references auth.users(id) on delete set null,
  email       text        not null default '',
  kind        text        not null default 'idea',   -- 'broken' | 'idea'
  message     text        not null,
  page        text        not null default '',
  created_at  timestamptz not null default now()
);

create index if not exists lynxr_feedback_created_idx
  on public.lynxr_feedback (created_at desc);

alter table public.lynxr_feedback enable row level security;

-- A creator may write their own feedback and read NOTHING — not even their own.
-- There is deliberately no select policy for `authenticated`, so no creator can
-- read anyone else's. You read it with the service-role key, in the dashboard's
-- table editor, or in the Google Sheet mirror.
drop policy if exists "creator writes own feedback" on public.lynxr_feedback;
create policy "creator writes own feedback"
  on public.lynxr_feedback for insert
  to authenticated with check (auth.uid() = creator_id);

-- If the staff gate is already in place, give staff read access too. Wrapped so
-- this file still runs cleanly on a database that has never seen is_staff().
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'is_staff') then
    execute 'drop policy if exists "staff read feedback" on public.lynxr_feedback';
    execute 'create policy "staff read feedback" on public.lynxr_feedback '
         || 'for select to authenticated using (public.is_staff())';
    raise notice 'staff read policy added';
  else
    raise notice 'is_staff() not found — feedback is service-role readable only for now. '
                 'Re-run this file after applying the staff gate to add staff reads.';
  end if;
end $$;
