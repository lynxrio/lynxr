-- Lynxr — agency campaign briefs: "keep it exactly" and the agency's own needs.
-- Plan: ~/.claude/plans/agency-brief-compare-verbatim-needs.md
--
--   script_mode   'adapt' (default: lynxr rewrites the video for the client) | 'verbatim' ("keep it exactly":
--                 the video's own words and shots, built with no script call — pipeline/process_campaigns.py
--                 verbatim_script).
--   staff_needs   the agency's own needs for a format, printed before lynxr's generated ones. Like
--                 internal_note, the worker never writes it, so a regeneration cannot replace it.
--
-- STAFF ONLY: no new policy. lynxr_campaign_formats is is_staff() on every verb (supabase/campaigns.sql)
-- and new columns inherit the table's RLS.
--
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent.
--
-- Run it AFTER the Fly worker shows the deploy that carries this plan's pipeline change (`fly status`).
-- An older worker ignores script_mode and would rewrite a 'keep it exactly' format.
--
-- The column is NOT named `mode`: PostgREST resolves select=mode to Postgres's mode() aggregate (error
-- 42809, seen 2026-10-04).

do $$ begin
  if to_regclass('public.lynxr_campaign_formats') is null then
    raise exception 'lynxr_campaign_formats is missing — run supabase/campaigns.sql first';
  end if;
end $$;

alter table public.lynxr_campaign_formats add column if not exists script_mode text not null default 'adapt';
alter table public.lynxr_campaign_formats drop constraint if exists lynxr_campaign_formats_script_mode_check;
alter table public.lynxr_campaign_formats add constraint lynxr_campaign_formats_script_mode_check
  check (script_mode in ('adapt', 'verbatim'));
alter table public.lynxr_campaign_formats add column if not exists staff_needs jsonb not null default '[]'::jsonb;
alter table public.lynxr_campaign_formats drop constraint if exists lynxr_campaign_formats_staff_needs_check;
alter table public.lynxr_campaign_formats add constraint lynxr_campaign_formats_staff_needs_check
  check (jsonb_typeof(staff_needs) = 'array');

comment on column public.lynxr_campaign_formats.script_mode is 'adapt = rewrite for the client (default); verbatim = "keep it exactly": the video''s own words and shots, no script call (pipeline/process_campaigns.py verbatim_script).';
comment on column public.lynxr_campaign_formats.staff_needs is 'Staff-typed needs, printed before the generated ones. The worker never writes it, so a regeneration cannot replace it.';

-- ── THE BACKFILL. Before this file, a staff member who typed a need saved it into edited.needs next to the
-- generated ones, and a regeneration moved it into "previous version". Any line in edited.needs that the
-- worker did not write (it is not in script.needs) is the agency's own: move it to staff_needs and leave the
-- generated lines in edited.needs. Only touches rows whose staff_needs is still empty, so it is idempotent.
-- Temporary: dropped at the end of this file.
create or replace function public.lynxr_staff_needs_backfill(only_id uuid default null)
returns integer language plpgsql as $$
declare touched integer;
begin
  with typed as (
    select f.id,
      coalesce(jsonb_agg(e.line order by e.ord) filter (where not (coalesce(f.script->'needs', '[]'::jsonb) ? e.line)), '[]'::jsonb) as mine,
      coalesce(jsonb_agg(e.line order by e.ord) filter (where coalesce(f.script->'needs', '[]'::jsonb) ? e.line), '[]'::jsonb) as kept
    from public.lynxr_campaign_formats f
    cross join lateral jsonb_array_elements_text(f.edited->'needs') with ordinality as e(line, ord)
    where jsonb_typeof(f.edited->'needs') = 'array'
      and f.staff_needs = '[]'::jsonb
      and (only_id is null or f.id = only_id)
    group by f.id
  )
  update public.lynxr_campaign_formats f
     set staff_needs = t.mine, edited = jsonb_set(f.edited, '{needs}', t.kept)
    from typed t
   where f.id = t.id and jsonb_array_length(t.mine) > 0;
  get diagnostics touched = row_count;
  return touched;
end $$;
revoke all on function public.lynxr_staff_needs_backfill(uuid) from public, anon, authenticated;

-- ── SELF-TEST. Runs every time this file is run and WRITES NOTHING: the inner block raises LX001 at the end,
-- which rolls back everything it did, and the handler turns that into a NOTICE. Any wrong answer raises a
-- real error instead, and then the whole file is rolled back — fix before re-running.
do $$
declare
  cid uuid;
  fid uuid;
  gid uuid;
  k   integer;
  r   record;
begin
  begin
    insert into public.lynxr_campaigns (client_id, name) values ('selftest-mode-needs', 'self-test') returning id into cid;
    insert into public.lynxr_campaign_formats (campaign_id, source_url, status)
      values (cid, 'https://www.tiktok.com/@x/video/1', 'done') returning id into fid;

    -- 1. the defaults
    select f.script_mode, f.staff_needs into r from public.lynxr_campaign_formats f where f.id = fid;
    if r.script_mode <> 'adapt' or r.staff_needs <> '[]'::jsonb then
      raise exception 'defaults wrong: script_mode %, staff_needs %', r.script_mode, r.staff_needs;
    end if;

    -- 2. script_mode refuses a value outside the two
    begin
      update public.lynxr_campaign_formats set script_mode = 'rewrite' where id = fid;
      raise exception 'script_mode accepted a bad value';
    exception when check_violation then null;
    end;

    -- 3. staff_needs refuses anything that is not an array
    begin
      update public.lynxr_campaign_formats set staff_needs = '"one"'::jsonb where id = fid;
      raise exception 'staff_needs accepted a non-array';
    exception when check_violation then null;
    end;

    -- 4. the backfill moves typed lines out of edited.needs and keeps the generated ones
    insert into public.lynxr_campaign_formats (campaign_id, source_url, status, script, edited)
      values (cid, 'https://www.tiktok.com/@x/video/2', 'done',
              '{"needs":["Gen one","Gen two"]}'::jsonb,
              '{"needs":["Typed one","Gen two","Typed two"],"hook":"h"}'::jsonb)
      returning id into gid;
    k := public.lynxr_staff_needs_backfill(gid);
    if k <> 1 then raise exception 'backfill touched % rows, expected 1', k; end if;

    -- 5. what it left behind
    select f.staff_needs, f.edited into r from public.lynxr_campaign_formats f where f.id = gid;
    if r.staff_needs <> '["Typed one","Typed two"]'::jsonb then
      raise exception 'staff_needs after backfill: %', r.staff_needs;
    end if;
    if r.edited->'needs' <> '["Gen two"]'::jsonb or r.edited->>'hook' <> 'h' then
      raise exception 'edited after backfill: %', r.edited;
    end if;

    -- 6. idempotent
    k := public.lynxr_staff_needs_backfill(gid);
    if k <> 0 then raise exception 'a second backfill touched % rows, expected 0', k; end if;

    -- 7. a format with nothing typed is left alone
    k := public.lynxr_staff_needs_backfill(fid);
    if k <> 0 then raise exception 'backfill touched an untyped format (% rows)', k; end if;

    raise exception 'campaign_mode_needs self-test passed' using errcode = 'LX001';
  exception when sqlstate 'LX001' then
    raise notice 'campaign_mode_needs self-test passed (7 checks) — rolled back, nothing written';
  end;
end $$;

-- ── The real backfill: every live format whose staff typed needs into edited.needs.
do $$ declare k integer; begin
  k := public.lynxr_staff_needs_backfill();
  raise notice 'staff needs: % format(s) had typed needs moved into staff_needs', k;
end $$;

drop function public.lynxr_staff_needs_backfill(uuid);

notify pgrst, 'reload schema';

-- ── Check it (after Run) ─────────────────────────────────────────────────────────────────────────────────
--   select script_mode, count(*) from public.lynxr_campaign_formats group by 1;
--     -- all 'adapt' right after the run
--   select left(id::text, 8), staff_needs, edited->'needs' from public.lynxr_campaign_formats
--    where staff_needs <> '[]'::jsonb;
--     -- 6 rows as of 2026-10-04: b7ebd070, 5e777a27, c3a8cedd, d68433ac, 0ae59bbf, 64d8e3d0
