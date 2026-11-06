-- Brief files: videos, 5 GB a file, and no per-brief cap (owner, 2026-11-05: "allow me to add video files as well
-- to the briefs, along with images" ... "I thought we made it infinite" ... "a number that ... would be a non-issue").
-- 5 GB (5,000,000,000 bytes) is the most one standard upload to Supabase Storage takes; app.js BF_MAX_FILE matches.
-- First run 2026-11-05 at 500 MB; re-running it moves everything to 5 GB.
--
-- Dashboard → SQL Editor → paste → Run. Safe to re-run.
--
-- THEN, once: Dashboard → Storage → Settings → "Global file size limit" → 10 GB → Save (set 2026-11-05). That is the
-- project's own ceiling (50 MB by default) and no bucket can go above it.
--
-- What it does:
--   1. drops the lynxr_brief_files_cap trigger again (brief_files_uncap.sql's job). On 2026-11-05 the busiest brief
--      held exactly 20 files, the old cap, so that file was most likely never run;
--   2. lets a file row be up to 5 GB (the table's CHECK said 25 MB);
--   3. lets the lynxr-brief-files bucket take MP4, MOV and WebM, up to 5 GB a file.
-- Nothing else changes: who may read or write files (RLS, the creator gate, CM rules) is untouched.
-- app.js (BF_MAX_FILE, BF_TYPES, CB_NOTE_IMG_TYPES) and brief_files.sql say the same, so a re-run of brief_files.sql
-- keeps all three.
--
-- Cost note: Supabase Pro includes 100 GB of storage and 250 GB of egress a month, and every creator a brief reaches
-- downloads its files separately: a 2 GB video sent to 10 creators is 20 GB, if every one of them downloads it.

-- 1. no per-brief cap
drop trigger if exists lynxr_brief_files_cap on public.lynxr_brief_files;
drop function if exists public.lynxr_brief_files_cap();

-- 2. a row may be up to 5 GB
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.lynxr_brief_files'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ~ '\msize\M' loop
    execute format('alter table public.lynxr_brief_files drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.lynxr_brief_files
  add constraint lynxr_brief_files_size_check check (size > 0 and size <= 5000000000);

-- 3. the bucket: videos, 5 GB a file
update storage.buckets
   set file_size_limit = 5000000000,
       allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
                                  'application/pdf', 'application/zip',
                                  'font/otf', 'font/ttf', 'font/woff', 'font/woff2',
                                  'video/mp4', 'video/quicktime', 'video/webm']
 where id = 'lynxr-brief-files';

do $$
begin
  if exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
              where c.relname = 'lynxr_brief_files' and t.tgname = 'lynxr_brief_files_cap') then
    raise exception 'brief_files_video: the cap trigger is still there';
  end if;
  if not exists (select 1 from storage.buckets
                  where id = 'lynxr-brief-files' and file_size_limit = 5000000000
                    and 'video/mp4' = any(allowed_mime_types)) then
    raise exception 'brief_files_video: the lynxr-brief-files bucket was not updated (does it exist? run brief_files.sql first)';
  end if;
  raise notice 'brief_files_video done: no file cap per brief, videos allowed, 5 GB a file. The Global file size limit (Storage -> Settings) must be at least 5 GB.';
end $$;
