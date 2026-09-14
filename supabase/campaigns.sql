-- Agency campaign briefs (plan: ~/.claude/plans/agency-batch-campaign-brief.md).
-- STAFF ONLY. Creators and staff share one auth pool, so every policy here is
-- is_staff(); the public role gets nothing. The worker writes with the
-- service-role key.
--
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent.

do $$ begin
  if not exists (select 1 from public.lynxr_staff) then
    raise exception 'lynxr_staff is empty — run staff_gate.sql first, or these policies hide campaigns from everyone';
  end if;
end $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create table if not exists public.lynxr_campaigns (
  id             uuid primary key default gen_random_uuid(),
  client_id      text        not null,            -- lynxr_clients.id (text); no FK: client rows are upserted/tombstoned by the app's sync
  name           text        not null default '',
  instructions   text        not null default '', -- creator-facing campaign rules, printed at the top of the brief
  internal_notes text        not null default '', -- agency only, never exported
  brand_context  jsonb       not null default '{}'::jsonb, -- snapshot the worker reads; see plan Step 9 for keys
  created_by     text        not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists lynxr_campaigns_client_idx on public.lynxr_campaigns (client_id, created_at desc);

create table if not exists public.lynxr_campaign_formats (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid        not null references public.lynxr_campaigns(id) on delete cascade,
  position      integer     not null default 0,
  source_url    text        not null,
  job           text        not null default 'read'   check (job in ('read','script')),
  status        text        not null default 'queued' check (status in ('queued','running','done','error')),
  phase         text        not null default '',
  attempts      integer     not null default 0,
  retry_at      timestamptz,
  claimed_at    timestamptz,
  claimed_by    text        not null default '',
  error_kind    text        not null default '',
  error_detail  text        not null default '',
  retryable     boolean     not null default true,
  regen_note    text        not null default '',
  source        jsonb,      -- worker: transcript, shots, tags, cover, clip, meta
  analysis      jsonb,      -- worker: {format, production, diag}
  script        jsonb,      -- worker: the generated format (AGENCY_SCRIPT_SCHEMA)
  script_prev   jsonb,      -- worker: {script, edited} before the last regeneration
  edited        jsonb,      -- staff: overrides of script fields; null = unedited
  internal_note text        not null default '', -- staff: agency only, survives regeneration
  timings       jsonb,
  finished_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists lynxr_campaign_formats_campaign_idx on public.lynxr_campaign_formats (campaign_id, position);
create index if not exists lynxr_campaign_formats_queue_idx on public.lynxr_campaign_formats (created_at, position)
  where status in ('queued','running');

drop trigger if exists touch_lynxr_campaigns on public.lynxr_campaigns;
create trigger touch_lynxr_campaigns
  before update on public.lynxr_campaigns
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_lynxr_campaign_formats on public.lynxr_campaign_formats;
create trigger touch_lynxr_campaign_formats
  before update on public.lynxr_campaign_formats
  for each row execute function public.touch_updated_at();

alter table public.lynxr_campaigns enable row level security;
alter table public.lynxr_campaign_formats enable row level security;

revoke all on table public.lynxr_campaigns, public.lynxr_campaign_formats from anon;

drop policy if exists "staff read campaigns" on public.lynxr_campaigns;
create policy "staff read campaigns"
  on public.lynxr_campaigns for select to authenticated using (public.is_staff());
drop policy if exists "staff insert campaigns" on public.lynxr_campaigns;
create policy "staff insert campaigns"
  on public.lynxr_campaigns for insert to authenticated with check (public.is_staff());
drop policy if exists "staff update campaigns" on public.lynxr_campaigns;
create policy "staff update campaigns"
  on public.lynxr_campaigns for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists "staff delete campaigns" on public.lynxr_campaigns;
create policy "staff delete campaigns"
  on public.lynxr_campaigns for delete to authenticated using (public.is_staff());

drop policy if exists "staff read campaign formats" on public.lynxr_campaign_formats;
create policy "staff read campaign formats"
  on public.lynxr_campaign_formats for select to authenticated using (public.is_staff());
drop policy if exists "staff insert campaign formats" on public.lynxr_campaign_formats;
create policy "staff insert campaign formats"
  on public.lynxr_campaign_formats for insert to authenticated with check (public.is_staff());
drop policy if exists "staff update campaign formats" on public.lynxr_campaign_formats;
create policy "staff update campaign formats"
  on public.lynxr_campaign_formats for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists "staff delete campaign formats" on public.lynxr_campaign_formats;
create policy "staff delete campaign formats"
  on public.lynxr_campaign_formats for delete to authenticated using (public.is_staff());

-- Cost ledger gains a lane so agency spend can be metered and reported
-- separately from creators, without touching a single existing row.
alter table public.lynxr_costs add column if not exists lane text not null default 'creator';
create index if not exists lynxr_costs_lane_at_idx on public.lynxr_costs (lane, at desc);

-- Provenance marker only (owner decision 2026-09-14: agency inspiration videos
-- pool into the shared source library through the unmodified upsert_source /
-- upsert_video). Nothing reads this column yet; it changes no behaviour.
-- lynxr_sources stays staff-read / service-role-write — no new policy or grant.
alter table public.lynxr_sources add column if not exists agency_seen_at timestamptz;
comment on column public.lynxr_sources.agency_seen_at is 'Last time the agency campaign lane pooled this video. NULL = never pasted by the agency. Provenance only; nothing reads it yet.';

notify pgrst, 'reload schema';

-- ── Check it ────────────────────────────────────────────────────────────────
--   select count(*) from public.lynxr_campaigns;
--   select status, count(*) from public.lynxr_campaign_formats group by 1;
--   select lane, count(*), sum(usd) from public.lynxr_costs group by 1;
--   select count(*) from public.lynxr_sources where agency_seen_at is not null;
-- (the query above is the only other reference to lynxr_sources in this file)
