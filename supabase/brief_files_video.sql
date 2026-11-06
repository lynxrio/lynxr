-- Brief files: videos, 500 MB a file, and no per-brief cap (owner, 2026-11-05: "allow me to add video files as well
-- to the briefs, along with images" ... "I thought we made it infinite").
--
-- Dashboard → SQL Editor → paste → Run. Safe to re-run.
--
-- THEN, once: Dashboard → Storage → Settings → "Upload file size limit" → 500 MB → Save. That is the project's own
-- ceiling (50 MB by default) and no bucket can go above it, so without this step a video over 50 MB is refused.
--
-- What it does:
--   1. drops the lynxr_brief_files_cap trigger again (brief_files_uncap.sql's job). On 2026-11-05 the busiest brief
--      held exactly 20 files, the old cap, so that file was most likely never run;
--   2. lets a file row be up to 500 MB (the table's CHECK said 25 MB);
--   3. lets the lynxr-brief-files bucket take MP4, MOV and WebM, up to 500 MB a file.
-- Nothing else changes: who may read or write files (RLS, the creator gate, CM rules) is untouched.
-- app.js (BF_MAX_FILE, BF_TYPES, CB_NOTE_IMG_TYPES) and brief_files.sql say the same, so a re-run of brief_files.sql
-- keeps all three.
--
-- Cost note: Supabase Pro includes 100 GB of storage and 250 GB of egress a month, and every creator a brief reaches
-- downloads its files separately: a 200 MB video sent to 10 creators is 2 GB.

-- 1. no per-brief cap
drop trigger if exists lynxr_brief_files_cap on public.lynxr_brief_files;
drop function if exists public.lynxr_brief_files_cap();

-- 2. a row may be up to 500 MB
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
  add constraint lynxr_brief_files_size_check check (size > 0 and size <= 524288000);

-- 3. the bucket: videos, 500 MB a file
update storage.buckets
   set file_size_limit = 524288000,
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
                  where id = 'lynxr-brief-files' and file_size_limit = 524288000
                    and 'video/mp4' = any(allowed_mime_types)) then
    raise exception 'brief_files_video: the lynxr-brief-files bucket was not updated (does it exist? run brief_files.sql first)';
  end if;
  raise notice 'brief_files_video done: no file cap per brief, videos allowed, 500 MB a file. Now set Storage -> Settings -> Upload file size limit to 500 MB.';
end $$;
