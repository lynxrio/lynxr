-- Brief files: logos, fonts and brand guides the agency attaches to a brief,
-- downloadable by every roster creator that brief is delivered to.
-- Plan: ~/.claude/plans/brief-file-attachments.md
--
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent.
-- Run AFTER supabase/staff_gate.sql and supabase/agency_roster.sql. Its order
-- relative to supabase/roster_invite_by_email.sql does not matter — nothing
-- here redefines a function that file (or agency_roster.sql) owns.
-- **No real email address, uuid or object path anywhere in this file — the
-- repo is public.**
--
-- WHAT A FILE BELONGS TO: a brief's SOURCE — (source_kind, source_id), the
-- same pair agSend() in app.js writes onto lynxr_agency_briefs — never the
-- sent snapshot. The two creator-side reads below join
-- delivery -> brief -> source -> files at READ time, so a file attached before
-- the first send, or after it, reaches every creator the brief is delivered to
-- with no re-send, and a removed file stops reaching them at once. The brief's
-- TEXT stays a snapshot (agency_roster.sql); only the attachments are live.
--
-- SECURITY — the model of agency_roster.sql, extended to one bucket:
--   * lynxr_brief_files: is_staff() policies, NO creator policies.
--   * Bucket lynxr-brief-files is PRIVATE: no public URL exists. On
--     storage.objects, staff may insert / select / delete in it. Anyone else
--     may SELECT (download or list) an object only when
--     brief_file_readable(name) is true: the object is attached to a brief
--     delivered to auth.uid(), that delivery is not unsent, and the caller is
--     an accepted roster member — the gates of my_agency_brief(). A creator
--     holding another brief's object path gets "Object not found". Enforced
--     here, not in the interface.
--   * The creator lists files through my_agency_brief_files(p_id): SECURITY
--     DEFINER, search_path pinned empty, filters on auth.uid() internally.
--   Unsend (revoked_at) and leaving the roster cut the files off in the same
--   instant they cut off the brief. Staff read every file, by design.
--
-- LIMITS — mirrored as the BF_* constants in app.js; change both together.
--   25 MB a file ............... storage.buckets.file_size_limit
--                                (the Free plan caps any file at 50 MB)
--   20 files and 50 MB a brief . lynxr_brief_files_cap(), below
--   png jpg webp gif svg pdf zip otf ttf woff woff2 ... allowed_mime_types
--   Why this tight: the Free plan's 5 GB/month egress quota restricted this
--   project once already (2026-09-07), and every creator a brief reaches
--   downloads its files separately — 50 MB sent to ten creators is 0.5 GB.
--   No video, for the same reason.

do $$ begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
  if to_regclass('public.lynxr_agency_deliveries') is null then
    raise exception 'lynxr_agency_deliveries missing — run supabase/agency_roster.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE LIST
-- ---------------------------------------------------------------------------
-- path is the object key in the bucket: <source_kind>/<source id>/<random>/<file>,
-- every segment from bfSafe() in app.js. The CHECK repeats that alphabet so no
-- row can ever point a creator's download outside this shape.
create table if not exists public.lynxr_brief_files (
  id          uuid primary key default gen_random_uuid(),
  source_kind text not null check (source_kind in ('campaign', 'brief')),
  source_id   text not null check (source_id <> ''),
  path        text not null unique check (
                path ~ '^(campaign|brief)/[A-Za-z0-9_][A-Za-z0-9_.-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*$'
                and position('..' in path) = 0
                and split_part(path, '/', 1) = source_kind),
  name        text not null check (name <> '' and char_length(name) <= 200),  -- the real file name, shown to people
  size        bigint not null check (size > 0 and size <= 26214400),
  mime        text not null default '',
  uploaded_by uuid default auth.uid(),      -- staff; no FK, same as lynxr_roster.invited_by
  uploaded_at timestamptz not null default now()
);
create index if not exists lynxr_brief_files_source_idx
  on public.lynxr_brief_files (source_kind, source_id);

-- Per-brief caps. Staff are the only writers, so this guards against a
-- mistake, not an attacker: two uploads landing in the same instant can pass
-- it together by one file.
create or replace function public.lynxr_brief_files_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  n     int;
  total bigint;
begin
  select count(*), coalesce(sum(f.size), 0) into n, total
    from public.lynxr_brief_files f
   where f.source_kind = new.source_kind and f.source_id = new.source_id;
  if n >= 20 or total + new.size > 52428800 then
    raise exception 'brief_files_cap: a brief holds at most 20 files and 50 MB' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists lynxr_brief_files_cap on public.lynxr_brief_files;
create trigger lynxr_brief_files_cap
  before insert on public.lynxr_brief_files
  for each row execute function public.lynxr_brief_files_cap();

alter table public.lynxr_brief_files enable row level security;
revoke all on table public.lynxr_brief_files from anon;

-- Staff only. No update policy: a file is added or removed, never edited.
drop policy if exists "staff read brief files" on public.lynxr_brief_files;
create policy "staff read brief files"
  on public.lynxr_brief_files for select to authenticated using (public.is_staff());
drop policy if exists "staff insert brief files" on public.lynxr_brief_files;
create policy "staff insert brief files"
  on public.lynxr_brief_files for insert to authenticated with check (public.is_staff());
drop policy if exists "staff delete brief files" on public.lynxr_brief_files;
create policy "staff delete brief files"
  on public.lynxr_brief_files for delete to authenticated using (public.is_staff());

-- ---------------------------------------------------------------------------
-- THE CREATOR SIDE — two SECURITY DEFINER functions with the gates of
-- my_agency_brief(). Neither takes a creator identity as a parameter.
-- NEVER DROP brief_file_readable: the storage policy below depends on it,
-- so dropping it would make a re-run of this file fail. create or replace only.
-- ---------------------------------------------------------------------------
create or replace function public.brief_file_readable(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.lynxr_brief_files f
      join public.lynxr_agency_briefs b
        on b.source_kind = f.source_kind and b.source_id = f.source_id
      join public.lynxr_agency_deliveries d on d.brief_id = b.id
      join public.lynxr_roster r on r.creator_id = d.creator_id
     where f.path = p_path
       and d.creator_id = auth.uid()
       and d.revoked_at is null
       and r.status = 'accepted');
$$;

revoke all on function public.brief_file_readable(text) from public, anon;
grant execute on function public.brief_file_readable(text) to authenticated;

create or replace function public.my_agency_brief_files(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'path', f.path, 'name', f.name, 'size', f.size, 'mime', f.mime,
           'uploaded_at', f.uploaded_at
         ) order by f.uploaded_at, f.name), '[]'::jsonb)
    from public.lynxr_agency_deliveries d
    join public.lynxr_agency_briefs b on b.id = d.brief_id
    join public.lynxr_roster r on r.creator_id = d.creator_id
    join public.lynxr_brief_files f
      on f.source_kind = b.source_kind and f.source_id = b.source_id
   where d.brief_id = p_id
     and d.creator_id = auth.uid()
     and d.revoked_at is null
     and r.status = 'accepted';
$$;

revoke all on function public.my_agency_brief_files(uuid) from public, anon;
grant execute on function public.my_agency_brief_files(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- THE BUCKET + ITS POLICIES. Wrapped, like clips_bucket.sql and schema.sql:
-- storage.* belongs to the storage service and the editor's role may not be
-- allowed to touch it; unwrapped, that failure would roll back everything
-- above. Two blocks, so one failing does not skip the other. If either prints
-- "NOT created", do the dashboard steps its notice names — without them
-- nothing uploads (no bucket) or nothing downloads (no policies).
-- ---------------------------------------------------------------------------
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('lynxr-brief-files', 'lynxr-brief-files', false, 26214400,
          array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
                'application/pdf', 'application/zip',
                'font/otf', 'font/ttf', 'font/woff', 'font/woff2'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
exception when others then
  raise notice 'lynxr-brief-files bucket NOT created (%). Dashboard -> Storage -> New bucket: name lynxr-brief-files, Public bucket OFF, Restrict file size ON = 25 MB, Allowed MIME types = image/png, image/jpeg, image/webp, image/gif, image/svg+xml, application/pdf, application/zip, font/otf, font/ttf, font/woff, font/woff2.', sqlerrm;
end $$;

do $$
begin
  execute 'drop policy if exists "brief files: staff upload" on storage.objects';
  execute 'create policy "brief files: staff upload" on storage.objects '
       || 'for insert to authenticated '
       || 'with check (bucket_id = ''lynxr-brief-files'' and public.is_staff())';
  execute 'drop policy if exists "brief files: staff or delivered creator read" on storage.objects';
  execute 'create policy "brief files: staff or delivered creator read" on storage.objects '
       || 'for select to authenticated '
       || 'using (bucket_id = ''lynxr-brief-files'' and (public.is_staff() or public.brief_file_readable(name)))';
  execute 'drop policy if exists "brief files: staff delete" on storage.objects';
  execute 'create policy "brief files: staff delete" on storage.objects '
       || 'for delete to authenticated '
       || 'using (bucket_id = ''lynxr-brief-files'' and public.is_staff())';
exception when others then
  raise notice 'brief files storage policies NOT created (%). Dashboard -> Storage -> Policies -> lynxr-brief-files -> New policy -> For full customization, three times, target role authenticated: (1) "brief files: staff upload", INSERT, with check: bucket_id = ''lynxr-brief-files'' and public.is_staff()  (2) "brief files: staff or delivered creator read", SELECT, using: bucket_id = ''lynxr-brief-files'' and (public.is_staff() or public.brief_file_readable(name))  (3) "brief files: staff delete", DELETE, using: bucket_id = ''lynxr-brief-files'' and public.is_staff()', sqlerrm;
end $$;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- CHECKS — run each after the file.
--
-- 1. Everything is in place:
--   select id, public, file_size_limit, allowed_mime_types
--     from storage.buckets where id = 'lynxr-brief-files';
--     -- expect 1 row: public false, 26214400, the 11 types
--   select policyname, cmd from pg_policies
--    where schemaname = 'storage' and tablename = 'objects' and policyname like 'brief files:%'
--    order by 1;
--     -- expect 3 rows: DELETE, SELECT, INSERT
--   select to_regprocedure('public.my_agency_brief_files(uuid)') is not null as list_fn,
--          to_regprocedure('public.brief_file_readable(text)') is not null as read_fn;
--     -- expect true, true
--
-- 2. No OTHER policy lets every signed-in user read every object. Every row's
--    qual / with_check must name a bucket_id; one that does not is a hole that
--    would expose these files too:
--   select policyname, cmd, roles, qual, with_check from pg_policies
--    where schemaname = 'storage' and tablename = 'objects' order by policyname;
--
-- 3. What is attached where:
--   select source_kind, source_id, name, size, path, uploaded_at
--     from public.lynxr_brief_files order by uploaded_at desc limit 20;
--   select id, title, client_name, source_kind, source_id from public.lynxr_agency_briefs;
--
-- 4. ISOLATION PROOF — read-only, rolled back. Two real uuids from auth.users:
--    A received the brief; B is a NON-STAFF account that did not (staff read
--    every file by design, so B must not be in lynxr_staff). Candidates for B:
--      select id, email from auth.users
--       where id not in (select id from public.lynxr_staff)
--         and id not in (select creator_id from public.lynxr_agency_deliveries);
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<CREATOR-B-UUID>","role":"authenticated"}';
--     select public.my_agency_brief_files('<BRIEF-ID-SENT-TO-A>');                    -- expect: []
--     select public.brief_file_readable('<PATH-OF-A-FILE-ON-THAT-BRIEF>');            -- expect: false
--     select count(*) from storage.objects where bucket_id = 'lynxr-brief-files';     -- expect: 0
--     select count(*) from public.lynxr_brief_files;                                  -- expect: 0
--   rollback;
--   The same block with <CREATOR-A-UUID>: expect the file list, true, the number
--   of files on briefs A holds, and 0 (the table itself stays staff-only).
