-- Brief files: no per-brief cap (owner, 2026-10-26: "can you change it so that
-- the briefs hold more than just 20 images" ... "like it infinite").
--
-- Dashboard → SQL Editor → paste → Run. Safe to re-run.
--
-- What it does: drops the lynxr_brief_files_cap trigger and its function, which
-- refused a brief's 21st file or anything past 50 MB in total. Nothing else
-- changes:
--   * one file is still limited by the bucket (storage.buckets.file_size_limit,
--     25 MB), and a note image by the app (10 MB);
--   * who may read or write files (RLS, the creator gate, CM rules) is untouched.
-- app.js sets BF_MAX_COUNT / BF_MAX_TOTAL to Infinity to match, and
-- brief_files.sql no longer creates the trigger, so a re-run of it can't bring
-- the cap back.
--
-- Cost note: Supabase Pro includes 100 GB of storage and 250 GB of egress a
-- month. Every creator a brief reaches downloads its files separately.

drop trigger if exists lynxr_brief_files_cap on public.lynxr_brief_files;
drop function if exists public.lynxr_brief_files_cap();

do $$
begin
  if exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
              where c.relname = 'lynxr_brief_files' and t.tgname = 'lynxr_brief_files_cap') then
    raise exception 'brief_files_uncap: the cap trigger is still there';
  end if;
  raise notice 'brief_files_uncap done: briefs have no file-count or total-size cap (one file is still at most 25 MB)';
end $$;
