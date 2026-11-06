-- Brief size limits, lifted (owner, 2026-11-05: "No limits on anything" ... "lift both").
--
-- Dashboard → SQL Editor → paste → Run. Safe to re-run. Writes no rows.
--
-- What it does:
--   1. notes on one format: up to 10 MB (was 128 KB). The editor no longer limits a note's length (it was 4,000
--      characters), so this is only a backstop: 10 MB is about 2,500 notes of 4,000 characters, or tens of
--      thousands of images and videos in notes.
--   2. one sent brief (lynxr_agency_briefs.doc, what creators receive): up to 50 MB (was 512 KB). Without this, a brief
--      with long notes would be refused at Send.
-- Files are not in either: their bytes live in storage (brief_files_video.sql, 5 GB a file, no count limit).
-- beat_notes.sql and agency_roster.sql say the same numbers, so a re-run of either keeps them.

alter table public.lynxr_campaign_formats drop constraint if exists lynxr_campaign_formats_beat_notes_check;
alter table public.lynxr_campaign_formats add constraint lynxr_campaign_formats_beat_notes_check
  check (jsonb_typeof(beat_notes) = 'array' and octet_length(beat_notes::text) <= 10485760);

alter table public.lynxr_agency_briefs drop constraint if exists lynxr_agency_briefs_doc_size;
alter table public.lynxr_agency_briefs add constraint lynxr_agency_briefs_doc_size
  check (octet_length(doc::text) <= 52428800);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lynxr_campaign_formats_beat_notes_check'
                  and pg_get_constraintdef(oid) like '%10485760%') then
    raise exception 'brief_limits: the notes limit was not raised';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lynxr_agency_briefs_doc_size'
                  and pg_get_constraintdef(oid) like '%52428800%') then
    raise exception 'brief_limits: the sent-brief limit was not raised';
  end if;
  raise notice 'brief_limits done: notes up to 10 MB a format, a sent brief up to 50 MB, no length limit on a note in the editor';
end $$;
