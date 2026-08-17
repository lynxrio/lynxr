-- Lynxr — open lynxr_sources to staff, and give it metrics.
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent.
--
-- WHY THIS EXISTS. lynxr_sources is the videos CREATORS PASTED IN — the leading
-- signal. lynxr_videos (9,016 scraped rows) is lagging: it holds videos that
-- already performed, which is exactly why competitors can find them too. The
-- agency app's Database tab now reads THIS table, with the scraped corpus moved
-- behind a backup button.
--
-- Two things were in the way, both fixed here:
--
--   1. RLS. The table had NO policies at all — service-role only, on purpose
--      (see creator_tables.sql). The pipeline writes it with the service key,
--      which bypasses RLS entirely, so nothing was broken; but a signed-in
--      staff browser reading it got back an empty array, not an error. That is
--      why the app could never show it.
--   2. NO METRICS. The table has no view/like/comment column, so nothing in it
--      could be ranked by reach — only by tag_count and recency.

-- ── 1. Metrics ──────────────────────────────────────────────────────────────
-- Named to match lynxr_videos so one mental model covers both tables, and so a
-- future union of the two does not need aliasing.
--
-- NULL, not 0, is the default on purpose. A creator-pasted video whose metrics
-- were never fetched is UNKNOWN; a video with genuinely no views is 0. Folding
-- those together would put every un-backfilled row at the bottom of a views
-- sort and read as "these all flopped". `views is null` is the honest filter.
alter table public.lynxr_sources add column if not exists views        bigint;
alter table public.lynxr_sources add column if not exists likes        bigint;
alter table public.lynxr_sources add column if not exists comments     bigint;
alter table public.lynxr_sources add column if not exists duration     real;
alter table public.lynxr_sources add column if not exists creator      text;
alter table public.lynxr_sources add column if not exists title        text;
-- When the numbers were read. Views on a 3-day-old reel and a 3-month-old one
-- are not the same measurement, and without this there is no way to tell a
-- fresh count from a stale one.
alter table public.lynxr_sources add column if not exists metrics_at   timestamptz;

comment on column public.lynxr_sources.views is
  'Public view count from yt-dlp at metrics_at. NULL = never fetched, which is
   NOT the same as 0 — see the note in sources_staff_read.sql.';

-- The two sorts the app actually issues: "what are creators picking up on"
-- (tag_count) and "what came in lately" (last_seen_at, already indexed).
create index if not exists lynxr_sources_tagcount_idx
  on public.lynxr_sources (tag_count desc, last_seen_at desc);

-- ── 2. Staff read ───────────────────────────────────────────────────────────
-- SELECT ONLY, and only for staff. Deliberately no insert/update/delete policy:
-- this table is written by the pipeline with the service key, which bypasses
-- RLS, so the browser never needs write access and must not have it. A creator
-- who signs up gets nothing here — same pool of auth accounts, different gate.
drop policy if exists "staff read sources" on public.lynxr_sources;
create policy "staff read sources"
  on public.lynxr_sources for select
  to authenticated using (public.is_staff());

-- Refuse to leave the table readable if the staff table is empty — otherwise a
-- policy referencing is_staff() with nobody in lynxr_staff silently hides the
-- data from everyone including you, and it looks identical to "the query is
-- wrong". Same guard staff_gate.sql uses.
do $$
begin
  if not exists (select 1 from public.lynxr_staff) then
    raise exception
      'lynxr_staff is empty — run staff_gate.sql first, or this policy hides lynxr_sources from everyone';
  end if;
end $$;

-- ── 3. Check it ─────────────────────────────────────────────────────────────
-- Run these after. The first must be true FOR YOU (signed in as staff in the
-- SQL editor it will be false — auth.uid() is null there — so verify from the
-- app instead, or with a staff user's JWT).
--   select public.is_staff();
--   select count(*) from public.lynxr_sources;                 -- expect 19+
--   select count(*) from public.lynxr_sources where views is null;  -- expect 19 until backfilled
--
-- Reading the policy is not evidence it works. HANDOFF's rule stands: re-run
-- the live probe after any RLS change — a creator account must still get 0 rows
-- from this table.
