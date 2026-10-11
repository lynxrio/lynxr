-- Lynxr — agency campaign briefs: a note on each beat, for creators (owner, 2026-10-11).
-- Plan: ~/.claude/plans/agency-beat-notes.md
--
--   beat_notes   the notes staff write on a format's beats in the agency editor. Creators get each one under its
--                beat (with a Copy button) in the brief they are sent, and the PDF prints it there. A jsonb array,
--                one entry per note: {"beat": 0-based index, "orig": "8-12s" or "", "sigs": [fingerprints of that
--                beat's words], "text": "…"}. app.js (cbNotesView) decides which beat each note is drawn on.
--                Like staff_needs, the worker never writes it, so a regeneration cannot replace it: `edited`, where
--                a beat's words live, is moved into script_prev by every regenerate.
--
-- STAFF ONLY: no new policy. lynxr_campaign_formats is is_staff() on every verb (supabase/campaigns.sql) and a new
-- column inherits the table's RLS. Creators never read this table: a note reaches them inside the sent doc
-- (lynxr_agency_briefs.doc, built by app.js agencySendDoc), which my_agency_brief() already gates.
--
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent. It can run before or after the front end
-- ships: the agency app probes for the column and offers no notes (and says to run this file) until it exists.

do $$ begin
  if to_regclass('public.lynxr_campaign_formats') is null then
    raise exception 'lynxr_campaign_formats is missing — run supabase/campaigns.sql first';
  end if;
end $$;

alter table public.lynxr_campaign_formats add column if not exists beat_notes jsonb not null default '[]'::jsonb;
alter table public.lynxr_campaign_formats drop constraint if exists lynxr_campaign_formats_beat_notes_check;
-- An array, and at most 128 KB per format. The editor caps a note at 4,000 characters; this is the backstop that keeps
-- one format from crowding the 512 KB sent-doc cap (agency_roster.sql, lynxr_agency_briefs_doc_size).
alter table public.lynxr_campaign_formats add constraint lynxr_campaign_formats_beat_notes_check
  check (jsonb_typeof(beat_notes) = 'array' and octet_length(beat_notes::text) <= 131072);

comment on column public.lynxr_campaign_formats.beat_notes is 'Staff notes on beats, for creators: [{beat, orig, sigs, text}]. The worker never writes it, so a regeneration cannot replace it. Drawn and sent by app.js (cbNotesView, agencySendDoc).';

-- ── SELF-TEST. Runs every time this file is run and WRITES NOTHING: the inner block raises LX001 at the end, which
-- rolls back everything it did, and the handler turns that into a NOTICE. Any wrong answer raises a real error
-- instead, and then the whole file is rolled back — fix before re-running.
do $$
declare
  cid uuid;
  fid uuid;
  r   record;
begin
  begin
    insert into public.lynxr_campaigns (client_id, name) values ('selftest-beat-notes', 'self-test') returning id into cid;
    insert into public.lynxr_campaign_formats (campaign_id, source_url, status)
      values (cid, 'https://www.tiktok.com/@x/video/1', 'done') returning id into fid;

    -- 1. the default
    select f.beat_notes into r from public.lynxr_campaign_formats f where f.id = fid;
    if r.beat_notes <> '[]'::jsonb then raise exception 'default wrong: %', r.beat_notes; end if;

    -- 2. a real note is accepted
    update public.lynxr_campaign_formats
       set beat_notes = '[{"beat":1,"orig":"3-7s","sigs":["f89cc31f"],"text":"Put THIS in the comments"}]'::jsonb
     where id = fid;

    -- 3. anything that is not an array is refused
    begin
      update public.lynxr_campaign_formats set beat_notes = '{"beat":0}'::jsonb where id = fid;
      raise exception 'beat_notes accepted a non-array';
    exception when check_violation then null;
    end;

    -- 4. more than 128 KB is refused
    begin
      update public.lynxr_campaign_formats
         set beat_notes = jsonb_build_array(jsonb_build_object('text', repeat('x', 140000)))
       where id = fid;
      raise exception 'beat_notes accepted 140 KB';
    exception when check_violation then null;
    end;

    raise exception 'beat_notes self-test passed' using errcode = 'LX001';
  exception when sqlstate 'LX001' then
    raise notice 'beat_notes self-test passed (4 checks) — rolled back, nothing written';
  end;
end $$;

notify pgrst, 'reload schema';

-- ── Check it (after Run) ─────────────────────────────────────────────────────────────────────────────────────────
--   select count(*) filter (where beat_notes <> '[]'::jsonb) as with_notes, count(*) as formats
--     from public.lynxr_campaign_formats;
--     -- with_notes is 0 right after the run
