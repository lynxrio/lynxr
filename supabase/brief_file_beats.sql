-- Brief files on beats: staff put one of a brief's files on one beat of one of
-- its formats ("the logo goes on the opening beat"), and every creator the
-- brief is delivered to sees that file on that beat, with a download.
-- Plan: ~/.claude/plans/brief-files-at-beats.md
--
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent.
-- Run AFTER supabase/brief_files.sql (this file points at lynxr_brief_files).
-- It creates one table and one function and redefines nothing any other file
-- owns. **No real email address, uuid or object path anywhere in this file —
-- the repo is public.**
--
-- ONE ROW = ONE FILE ON ONE BEAT OF ONE FORMAT.
--   file_id    the file. Removing the file removes its placements (cascade).
--   format_id  the id the SENT DOC gives that format: a campaign format's uuid
--              (agencySendDoc), or a legacy brief's video URL (briefSendDoc).
--   beat       the beat's 0-based index when it was placed.
--   sigs       one to four 8-hex fingerprints of that beat's words
--              (bfBeatSig in app.js = lynxBeatSig in creator.js).
-- LIVE, like the files: a placement joins through its file to the brief's
-- SOURCE at read time, so one added or removed after sending reaches creators
-- with no re-send. A beat's index shifts when beats are added, deleted or
-- regenerated, so both apps put the file on the beat whose words still match,
-- nearest the stored index. When no beat matches (reworded, deleted,
-- regenerated), a creator sees the file only in "files from lynx", and staff
-- see it flagged "beat changed" with Keep here. Keep here appends the new
-- fingerprint and keeps the older ones, so a creator whose copy is older still
-- sees the file on the right beat until staff press Update.
--
-- SECURITY — the model of brief_files.sql:
--   * lynxr_brief_file_beats: is_staff() policies only, none for creators. It
--     holds no creator data at all.
--   * Creators read through my_agency_brief_file_beats(p_id): SECURITY
--     DEFINER, search_path pinned empty, filters on auth.uid() internally with
--     my_agency_brief()'s gates (delivered to the caller, not unsent, accepted
--     roster member). It returns each file's path; the download itself still
--     goes through brief_files.sql's storage policy, unchanged.

do $$ begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
  if to_regclass('public.lynxr_brief_files') is null then
    raise exception 'lynxr_brief_files missing — run supabase/brief_files.sql first';
  end if;
end $$;

create table if not exists public.lynxr_brief_file_beats (
  id         uuid primary key default gen_random_uuid(),
  file_id    uuid not null references public.lynxr_brief_files(id) on delete cascade,
  format_id  text not null check (format_id <> '' and char_length(format_id) <= 2048),
  beat       int  not null check (beat >= 0 and beat < 200),
  sigs       text[] not null check (
               cardinality(sigs) between 1 and 4
               and array_position(sigs, null) is null
               and array_to_string(sigs, ',') ~ '^[0-9a-f]{8}(,[0-9a-f]{8}){0,3}$'),
  placed_by  uuid default auth.uid(),      -- staff; no FK, same as lynxr_brief_files.uploaded_by
  placed_at  timestamptz not null default now()
);
-- No unique key on (file_id, format_id, beat), on purpose: the stored index
-- drifts from the beat a placement is drawn on once beats move, and a unique
-- key would then refuse a correct placement. Two rows for one file on one beat
-- draw as one chip.
create index if not exists lynxr_brief_file_beats_file_idx
  on public.lynxr_brief_file_beats (file_id);

alter table public.lynxr_brief_file_beats enable row level security;
revoke all on table public.lynxr_brief_file_beats from anon;

drop policy if exists "staff read brief file beats" on public.lynxr_brief_file_beats;
create policy "staff read brief file beats"
  on public.lynxr_brief_file_beats for select to authenticated using (public.is_staff());
drop policy if exists "staff insert brief file beats" on public.lynxr_brief_file_beats;
create policy "staff insert brief file beats"
  on public.lynxr_brief_file_beats for insert to authenticated with check (public.is_staff());
drop policy if exists "staff update brief file beats" on public.lynxr_brief_file_beats;
create policy "staff update brief file beats"
  on public.lynxr_brief_file_beats for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
drop policy if exists "staff delete brief file beats" on public.lynxr_brief_file_beats;
create policy "staff delete brief file beats"
  on public.lynxr_brief_file_beats for delete to authenticated using (public.is_staff());

-- The creator side. Takes no creator identity as a parameter.
create or replace function public.my_agency_brief_file_beats(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'path', f.path, 'format_id', p.format_id, 'beat', p.beat, 'sigs', to_jsonb(p.sigs)
         ) order by p.format_id, p.beat, f.uploaded_at, f.name), '[]'::jsonb)
    from public.lynxr_agency_deliveries d
    join public.lynxr_agency_briefs b on b.id = d.brief_id
    join public.lynxr_roster r on r.creator_id = d.creator_id
    join public.lynxr_brief_files f
      on f.source_kind = b.source_kind and f.source_id = b.source_id
    join public.lynxr_brief_file_beats p on p.file_id = f.id
   where d.brief_id = p_id
     and d.creator_id = auth.uid()
     and d.revoked_at is null
     and r.status = 'accepted';
$$;

revoke all on function public.my_agency_brief_file_beats(uuid) from public, anon;
grant execute on function public.my_agency_brief_file_beats(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- CHECKS — run each on its own after the file. Each DO block ends in a raise
-- so it ROLLS BACK everything it did and PRINTS its result as the error
-- message (the SQL editor shows only the last statement's output, so a
-- begin … rollback block would print nothing).
--
-- 1. In place:
--   select to_regclass('public.lynxr_brief_file_beats') is not null as tbl,
--          to_regprocedure('public.my_agency_brief_file_beats(uuid)') is not null as fn,
--          (select count(*) from pg_policies where tablename = 'lynxr_brief_file_beats') as policies;
--     -- expect true, true, 4
--
-- 2. Removing a file removes its placements (the cascade):
--   do $$
--   declare fid uuid; n_before int; n_after int;
--   begin
--     insert into public.lynxr_brief_files (source_kind, source_id, path, name, size)
--       values ('brief', 'check-cascade', 'brief/check-cascade/x/check.png', 'check.png', 1)
--       returning id into fid;
--     insert into public.lynxr_brief_file_beats (file_id, format_id, beat, sigs)
--       values (fid, 'check-format', 0, array['0d4743b8']);
--     select count(*) into n_before from public.lynxr_brief_file_beats where file_id = fid;
--     delete from public.lynxr_brief_files where id = fid;
--     select count(*) into n_after from public.lynxr_brief_file_beats where file_id = fid;
--     raise exception 'CASCADE CHECK, rolled back: before %, after % (expect 1, 0)', n_before, n_after;
--   end $$;
--
-- 3. ISOLATION — two real uuids from auth.users: A received the brief, B is a
--    NON-STAFF account that did not (candidates:
--      select id, email from auth.users
--       where id not in (select id from public.lynxr_staff)
--         and id not in (select creator_id from public.lynxr_agency_deliveries);).
--   do $$
--   declare v text; n int;
--   begin
--     perform set_config('request.jwt.claims', '{"sub":"<CREATOR-B-UUID>","role":"authenticated"}', true);
--     execute 'set local role authenticated';
--     v := public.my_agency_brief_file_beats('<BRIEF-ID-SENT-TO-A>')::text;
--     select count(*) into n from public.lynxr_brief_file_beats;
--     raise exception 'ISOLATION CHECK, rolled back: rpc %, table rows % (expect [] and 0)', v, n;
--   end $$;
--   The same block with <CREATOR-A-UUID>: expect the placements of that brief's
--   files, and 0 table rows (the table itself stays staff-only).
