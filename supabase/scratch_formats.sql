-- Lynxr — agency campaign briefs: formats WRITTEN FROM SCRATCH, with no source video (owner, 2026-10-13).
-- Plan: ~/.claude/plans/agency-note-images-and-scratch-formats.md
--
-- The agency app's "Write from scratch" (app.js cbWriteCreate) makes a lynxr_campaign_formats row with
-- source_url = '' (the column is NOT NULL, so the empty string IS the marker), status 'done' from birth,
-- job 'script', and no source or analysis. Nothing about such a row is for the worker:
--   * pipeline/campaign_queue.py never claims a row whose source_url is '' (source_url.neq."" in the claim);
--   * the app never offers Regenerate, Try again or Replace link on one, and puts one back to 'done' if it ever
--     finds it otherwise (app.js cbHealScratch).
-- This file is the database's own backstop: a row with no source_url can only ever be 'done'. That stops an app
-- tab opened BEFORE the change (Cloudflare can serve the old app.js for up to 4 hours) from queueing one with
-- Regenerate: the write is refused and that tab says it couldn't regenerate.
--
-- No new column, no policy change (lynxr_campaign_formats stays is_staff() on every verb, supabase/campaigns.sql).
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent. Best run BEFORE pushing the front end;
-- the app works without it.

do $$ begin
  if to_regclass('public.lynxr_campaign_formats') is null then
    raise exception 'lynxr_campaign_formats is missing — run supabase/campaigns.sql first';
  end if;
  if exists (select 1 from public.lynxr_campaign_formats where source_url = '' and status <> 'done') then
    raise exception 'a format with no source_url is not done. Look first: select id, status, job from public.lynxr_campaign_formats where source_url = '''';';
  end if;
end $$;

alter table public.lynxr_campaign_formats drop constraint if exists lynxr_campaign_formats_scratch_done_check;
alter table public.lynxr_campaign_formats add constraint lynxr_campaign_formats_scratch_done_check
  check (source_url <> '' or status = 'done');

comment on constraint lynxr_campaign_formats_scratch_done_check on public.lynxr_campaign_formats is
  'A format written from scratch (source_url = '''') has no video for the worker: it is done from birth and stays done. app.js cbWriteCreate / cbHealScratch; pipeline/campaign_queue.py never claims one.';

-- ── SELF-TEST. Runs every time this file is run and WRITES NOTHING: the inner block raises LX001 at the end, which
-- rolls back everything it did, and the handler turns that into a NOTICE. Any wrong answer raises a real error
-- instead, and then the whole file is rolled back — fix before re-running.
do $$
declare
  cid uuid;
  sid uuid;
  vid uuid;
begin
  begin
    insert into public.lynxr_campaigns (client_id, name) values ('selftest-scratch', 'self-test') returning id into cid;

    -- 1. a format written from scratch is accepted, done
    insert into public.lynxr_campaign_formats (campaign_id, source_url, job, status, script)
      values (cid, '', 'script', 'done',
              '{"title":"t","beats":[{"t":"","say":"hi","do":"","show":"","orig":""}]}'::jsonb)
      returning id into sid;

    -- 2. it cannot be queued (Regenerate from a stale tab) ...
    begin
      update public.lynxr_campaign_formats set status = 'queued', job = 'script' where id = sid;
      raise exception 'a scratch format was queued';
    exception when check_violation then null;
    end;

    -- 3. ... nor marked running or error
    begin
      update public.lynxr_campaign_formats set status = 'running' where id = sid;
      raise exception 'a scratch format was marked running';
    exception when check_violation then null;
    end;
    begin
      update public.lynxr_campaign_formats set status = 'error' where id = sid;
      raise exception 'a scratch format was marked error';
    exception when check_violation then null;
    end;

    -- 4. ... nor born queued (the column default)
    begin
      insert into public.lynxr_campaign_formats (campaign_id, source_url) values (cid, '');
      raise exception 'a scratch format was born queued';
    exception when check_violation then null;
    end;

    -- 5. staff edits still save on it
    update public.lynxr_campaign_formats set edited = '{"hook":"h"}'::jsonb where id = sid;

    -- 6. a video format is untouched by the rule: born queued, then running, error, done
    insert into public.lynxr_campaign_formats (campaign_id, source_url)
      values (cid, 'https://www.tiktok.com/@x/video/1') returning id into vid;
    update public.lynxr_campaign_formats set status = 'running' where id = vid;
    update public.lynxr_campaign_formats set status = 'error' where id = vid;
    update public.lynxr_campaign_formats set status = 'done' where id = vid;

    raise exception 'scratch_formats self-test passed' using errcode = 'LX001';
  exception when sqlstate 'LX001' then
    raise notice 'scratch_formats self-test passed (6 checks) — rolled back, nothing written';
  end;
end $$;

notify pgrst, 'reload schema';

-- ── Check it (after Run) ─────────────────────────────────────────────────────────────────────────────────────────
--   select count(*) filter (where source_url = '') as written_from_scratch, count(*) as formats
--     from public.lynxr_campaign_formats;
