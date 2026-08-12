-- Lynxr staff gate — standalone, no dependencies, safe to run on its own.
-- Dashboard → SQL Editor → New query → paste → Run.
--
-- WHAT THIS FIXES. lynxr_clients granted every `authenticated` user full read,
-- write AND DELETE, and lynxr_videos was readable by any signed-in user. That
-- was correct while the only accounts were staff, minted by hand. Creator
-- signup is now open on a live public site, so today any stranger who signs up
-- can read and delete every client record and read all 9,003 video rows.
--
-- After this, agency tables answer only to accounts listed in lynxr_staff.
-- Creators are unaffected: they own one row in lynxr_creators, gated on
-- auth.uid(), and never touched these tables.

create table if not exists public.lynxr_staff (
  id        uuid primary key references auth.users(id) on delete cascade,
  email     text        not null default '',
  added_at  timestamptz not null default now()
);

alter table public.lynxr_staff enable row level security;

-- A signed-in user may check their OWN membership and nothing else — the list
-- of who works here is not creator-readable. No insert/update/delete policies
-- exist, so membership is granted from this editor only and nobody can promote
-- themselves.
drop policy if exists "user reads own staff row" on public.lynxr_staff;
create policy "user reads own staff row"
  on public.lynxr_staff for select
  to authenticated using (auth.uid() = id);

-- SECURITY DEFINER so the check itself sees the whole table while callers still
-- cannot read anyone else's row. Pinning search_path stops a caller-controlled
-- schema shadowing lynxr_staff.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select exists (select 1 from public.lynxr_staff where id = auth.uid()) $$;

revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

-- SEED. Named explicitly, NOT "everyone who already has an account" — that
-- would now promote the creator-side test signups too.
insert into public.lynxr_staff (id, email)
select id, coalesce(email, '') from auth.users
where email in ('lynxmedianetwork@gmail.com')
on conflict (id) do nothing;

-- Refuse to apply staff-only policies with nobody in the table. Without this a
-- typo in the address above locks you out of your own dashboard, recoverable
-- only from the Supabase UI.
do $$
declare n integer;
begin
  select count(*) into n from public.lynxr_staff;
  if n = 0 then
    raise exception 'lynxr_staff is empty — the seed matched no account. Check the address and re-run; policies NOT changed.';
  end if;
  raise notice 'staff members: %', n;
end $$;

-- ---------------------------------------------------------------------------
-- lynxr_clients: staff only (was: every authenticated user)
drop policy if exists "signed-in users read all clients"   on public.lynxr_clients;
drop policy if exists "signed-in users write all clients"  on public.lynxr_clients;
drop policy if exists "signed-in users update all clients" on public.lynxr_clients;
drop policy if exists "signed-in users delete all clients" on public.lynxr_clients;
drop policy if exists "staff read all clients"   on public.lynxr_clients;
drop policy if exists "staff write all clients"  on public.lynxr_clients;
drop policy if exists "staff update all clients" on public.lynxr_clients;
drop policy if exists "staff delete all clients" on public.lynxr_clients;

create policy "staff read all clients"
  on public.lynxr_clients for select to authenticated using (public.is_staff());
create policy "staff write all clients"
  on public.lynxr_clients for insert to authenticated with check (public.is_staff());
create policy "staff update all clients"
  on public.lynxr_clients for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy "staff delete all clients"
  on public.lynxr_clients for delete to authenticated using (public.is_staff());

-- lynxr_videos: staff only. The agency's core asset, and creator.js never
-- reads it, so a signed-in creator has no reason to see any of it.
drop policy if exists "signed-in users read videos" on public.lynxr_videos;
drop policy if exists "staff read videos"           on public.lynxr_videos;
create policy "staff read videos"
  on public.lynxr_videos for select to authenticated using (public.is_staff());

-- Feedback: staff can now read it (the table already exists).
drop policy if exists "staff read feedback" on public.lynxr_feedback;
create policy "staff read feedback"
  on public.lynxr_feedback for select to authenticated using (public.is_staff());

-- Blueprint storage, wrapped: storage.objects is owned by the storage
-- extension and this can fail on permissions. Unguarded that would roll back
-- everything above it, which is exactly how "I ran the SQL and nothing
-- happened" happens.
do $$
begin
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
  raise notice 'Blueprint storage policies skipped (%). Everything else applied.', sqlerrm;
end $$;
