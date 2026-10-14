-- Lynxr — the CM role and the CM portal (owner, 2026-10-13). Plan: ~/.claude/plans/lynxr-cm-portal.md
--
-- A CM is a signed-in lynxr account that staff have tagged. A CM builds campaign briefs for the companies staff put
-- them on, and nothing else: no scraped videos, no other clients, no ops, no billing, no staff tables, no picked-video
-- (legacy) briefs, and from the client records only the brand fields a brief is written from.
--
-- ENFORCED HERE, NOT IN THE INTERFACE. Every policy below is ADDED beside the staff ones (Postgres ORs permissive
-- policies), so nothing staff can do changes. Creators are untouched: no policy here matches an account that is not
-- in lynxr_cms.
--
--   lynxr_cms          who is a CM. Staff add one with staff_add_cm(email) (the account must exist and be confirmed)
--                      and remove one with a delete. A CM reads only their own row. Nobody can add themselves.
--   lynxr_cm_clients   which companies (lynxr_clients.id) each CM is on. Staff only write it.
--   lynxr_campaigns    a CM reads, creates and edits the briefs of their companies, and deletes only briefs they made
--                      (created_uid, new: set by the database, frozen by a trigger).
--   lynxr_campaign_formats, lynxr_brief_files, lynxr_brief_file_beats, the lynxr-brief-files bucket:
--                      read and write for briefs of their companies.
--   lynxr_agency_briefs, lynxr_agency_deliveries:
--                      a CM sends their companies' briefs, only to accepted roster creators whose brand label
--                      (lynxr_roster.campaign) names that brief's company: its company name or the brand on its details,
--                      compared by lynxr_brand_key(), the same loose key as app.js rostBrandKey.
--   lynxr_clients      NO policy for CMs. cm_clients() hands a CM the brand fields of their companies and nothing else.
--   lynxr_roster       NO policy for CMs. cm_roster() hands a CM the creators they may send to.
--
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent, safe to re-run. Order against the push does
-- not matter: before this runs, the app treats every account exactly as it does today.
-- **No real email address, uuid or object path anywhere in this file — the repo is public.**

-- ── 0. Prerequisites ─────────────────────────────────────────────────────────────────────────────────────────────
do $$ begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
  if not exists (select 1 from public.lynxr_staff) then
    raise exception 'lynxr_staff is empty — run supabase/staff_gate.sql first';
  end if;
  if to_regclass('public.lynxr_campaign_formats') is null then
    raise exception 'campaign tables missing — run supabase/campaigns.sql first';
  end if;
  if to_regclass('public.lynxr_agency_deliveries') is null then
    raise exception 'lynxr_agency_deliveries missing — run supabase/agency_roster.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'lynxr_roster' and column_name = 'campaign') then
    raise exception 'lynxr_roster.campaign missing — run supabase/roster_invite_by_email.sql first';
  end if;
  if to_regclass('public.lynxr_brief_files') is null then
    raise exception 'lynxr_brief_files missing — run supabase/brief_files.sql first';
  end if;
end $$;

-- ── 1. Who is a CM, and on which companies ──────────────────────────────────────────────────────────────────────
create table if not exists public.lynxr_cms (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text        not null default '',   -- the address it was added under; shown to staff only
  added_by uuid,                               -- staff auth.uid(); no FK, so history survives a staff removal
  added_at timestamptz not null default now()
);

create table if not exists public.lynxr_cm_clients (
  cm_id     uuid not null references public.lynxr_cms(user_id) on delete cascade,
  client_id text not null check (client_id <> '' and char_length(client_id) <= 200
                                 and client_id not in ('ingest-queue', 'deleted-clients', 'source-edits')),
  added_by  uuid default auth.uid(),
  added_at  timestamptz not null default now(),
  primary key (cm_id, client_id)
);
create index if not exists lynxr_cm_clients_client_idx on public.lynxr_cm_clients (client_id);

alter table public.lynxr_cms        enable row level security;
alter table public.lynxr_cm_clients enable row level security;
revoke all on table public.lynxr_cms, public.lynxr_cm_clients from anon;

drop policy if exists "staff or self read cms" on public.lynxr_cms;
create policy "staff or self read cms"
  on public.lynxr_cms for select to authenticated using (public.is_staff() or user_id = auth.uid());
drop policy if exists "staff delete cms" on public.lynxr_cms;
create policy "staff delete cms"
  on public.lynxr_cms for delete to authenticated using (public.is_staff());
-- No insert or update policy: staff_add_cm() is the only way in.

drop policy if exists "staff or self read cm clients" on public.lynxr_cm_clients;
create policy "staff or self read cm clients"
  on public.lynxr_cm_clients for select to authenticated using (public.is_staff() or cm_id = auth.uid());
drop policy if exists "staff assign cm clients" on public.lynxr_cm_clients;
create policy "staff assign cm clients"
  on public.lynxr_cm_clients for insert to authenticated
  with check (public.is_staff()
              and exists (select 1 from public.lynxr_clients c where c.id = lynxr_cm_clients.client_id));
drop policy if exists "staff unassign cm clients" on public.lynxr_cm_clients;
create policy "staff unassign cm clients"
  on public.lynxr_cm_clients for delete to authenticated using (public.is_staff());

-- ── 2. Who made a brief ──────────────────────────────────────────────────────────────────────────────────────────
-- Existing rows get NULL (made by staff before CMs existed). New rows get the inserting account. The trigger keeps it
-- from ever being rewritten, so a CM cannot claim someone else's brief to delete it.
alter table public.lynxr_campaigns add column if not exists created_uid uuid default auth.uid();
comment on column public.lynxr_campaigns.created_uid is
  'auth.uid() of the account that made the brief (default; frozen by trigger). A CM may delete only briefs where this is them. NULL = made before cm_portal.sql.';

create or replace function public.lynxr_campaigns_keep_creator()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.created_uid := old.created_uid;
  return new;
end $$;
drop trigger if exists lynxr_campaigns_keep_creator on public.lynxr_campaigns;
create trigger lynxr_campaigns_keep_creator
  before update on public.lynxr_campaigns
  for each row execute function public.lynxr_campaigns_keep_creator();

-- ── 3. The checks every CM policy uses (SECURITY DEFINER: they read the tables without RLS; each filters on
--      auth.uid() itself and takes no identity as a parameter) ──────────────────────────────────────────────────
-- The loose brand key, the same as app.js rostBrandKey: tidy spaces, drop a trailing " campaign", strip accents,
-- lowercase, keep letters and digits only. "OncourseAI" = "oncourse ai" = "Oncourse-AI campaign".
create or replace function public.lynxr_brand_key(p text)
returns text language sql immutable set search_path = '' as $$
  select lower(regexp_replace(
           regexp_replace(
             normalize(regexp_replace(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), '\s+campaign$', '', 'i'), NFKD),
             '[' || chr(768) || '-' || chr(879) || ']', '', 'g'),
           '[^[:alnum:]]+', '', 'g'))
$$;

create or replace function public.is_cm_for(p_client text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lynxr_cm_clients a where a.cm_id = auth.uid() and a.client_id = p_client)
$$;

create or replace function public.is_cm_for_campaign(p_campaign uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1
                   from public.lynxr_campaigns cp
                   join public.lynxr_cm_clients a on a.client_id = cp.client_id
                  where cp.id = p_campaign and a.cm_id = auth.uid())
$$;

-- A brief SOURCE (source_kind, source_id), as lynxr_brief_files and lynxr_agency_briefs record it. Only campaign
-- briefs: a legacy picked-video brief ('brief') is never a CM's. Compares as text, so a malformed id cannot throw.
create or replace function public.cm_owns_source(p_kind text, p_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_kind = 'campaign', false) and exists (
    select 1
      from public.lynxr_campaigns cp
      join public.lynxr_cm_clients a on a.client_id = cp.client_id
     where cp.id::text = p_id and a.cm_id = auth.uid())
$$;

-- A storage object key in lynxr-brief-files: <source_kind>/<source id>/<random>/<file> (app.js bfUpload).
create or replace function public.cm_owns_path(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select split_part(coalesce(p_name, ''), '/', 1) = 'campaign'
         and public.cm_owns_source('campaign', split_part(coalesce(p_name, ''), '/', 2))
$$;

create or replace function public.cm_owns_brief(p_brief uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lynxr_agency_briefs b
                  where b.id = p_brief and public.cm_owns_source(b.source_kind, b.source_id))
$$;

create or replace function public.cm_owns_file(p_file uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lynxr_brief_files f
                  where f.id = p_file and public.cm_owns_source(f.source_kind, f.source_id))
$$;

-- May the calling CM deliver brief p_brief to creator p_creator? Only a campaign brief of a company the CM is on, and
-- only to an ACCEPTED roster creator one of whose brand labels names that company (company name or brand name).
create or replace function public.cm_may_deliver(p_brief uuid, p_creator uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.lynxr_agency_briefs b
      join public.lynxr_campaigns cp on b.source_kind = 'campaign' and cp.id::text = b.source_id
      join public.lynxr_cm_clients a on a.client_id = cp.client_id and a.cm_id = auth.uid()
      join public.lynxr_clients c on c.id = cp.client_id
      join public.lynxr_roster r on r.creator_id = p_creator and r.status = 'accepted'
      cross join lateral regexp_split_to_table(r.campaign, '[,;]') as part(label)
     where b.id = p_brief
       and public.lynxr_brand_key(part.label) <> ''
       and public.lynxr_brand_key(part.label) in (public.lynxr_brand_key(c.data->>'company'),
                                                   public.lynxr_brand_key(c.data->'ctx'->>'brand')))
$$;

-- ── 4. What the apps read ────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.my_roles()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'staff', public.is_staff(),
    'cm', exists (select 1 from public.lynxr_cms m where m.user_id = auth.uid()),
    'companies', (select count(*) from public.lynxr_cm_clients a
                    join public.lynxr_clients c on c.id = a.client_id
                   where a.cm_id = auth.uid()))
$$;

-- The calling CM's companies: an ALLOWLIST of the brand fields brandContextFromClient() (app.js) reads. Never the
-- row's briefs (legacy picked-video briefs hold copies of scraped corpus rows), posts, blueprints or other ctx keys.
create or replace function public.cm_clients()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'company', coalesce(c.data->>'company', ''),
           'niche', coalesce(c.data->>'niche', ''),
           'ctx', jsonb_build_object(
             'brand',       coalesce(c.data->'ctx'->>'brand', ''),
             'description', coalesce(c.data->'ctx'->>'description', ''),
             'product',     coalesce(c.data->'ctx'->>'product', ''),
             'audience',    coalesce(c.data->'ctx'->>'audience', ''),
             'avatarParts', jsonb_build_object(
               'stats',    coalesce(c.data->'ctx'->'avatarParts'->>'stats', ''),
               'problems', coalesce(c.data->'ctx'->'avatarParts'->>'problems', ''),
               'habits',   coalesce(c.data->'ctx'->'avatarParts'->>'habits', ''),
               'goals',    coalesce(c.data->'ctx'->'avatarParts'->>'goals', '')),
             'feats',       case when jsonb_typeof(c.data->'ctx'->'feats') = 'array'
                                 then c.data->'ctx'->'feats' else '[]'::jsonb end,
             'valueProps',  coalesce(c.data->'ctx'->>'valueProps', ''),
             'tone',        coalesce(c.data->'ctx'->>'tone', ''),
             'cta',         coalesce(c.data->'ctx'->>'cta', ''),
             'site',        coalesce(c.data->'ctx'->>'site', ''),
             'notes',       coalesce(c.data->'ctx'->>'notes', '')))
         order by lower(coalesce(c.data->>'company', ''))), '[]'::jsonb)
    from public.lynxr_cm_clients a
    join public.lynxr_clients c on c.id = a.client_id
   where a.cm_id = auth.uid()
     and c.id not in ('ingest-queue', 'deleted-clients', 'source-edits')
     and not exists (select 1 from public.lynxr_clients t
                      where t.id = 'deleted-clients' and coalesce(t.data->'ids', '[]'::jsonb) ? c.id)
$$;

-- The accepted roster creators the calling CM may send to, each with the CM's company ids their label names.
create or replace function public.cm_roster()
returns jsonb language sql stable security definer set search_path = '' as $$
  with mine as (
    select a.client_id,
           public.lynxr_brand_key(c.data->>'company')      as k1,
           public.lynxr_brand_key(c.data->'ctx'->>'brand') as k2
      from public.lynxr_cm_clients a
      join public.lynxr_clients c on c.id = a.client_id
     where a.cm_id = auth.uid()
  ), hits as (
    select r.creator_id, r.email, r.display_name, r.campaign, m.client_id
      from public.lynxr_roster r
      cross join lateral regexp_split_to_table(r.campaign, '[,;]') as part(label)
      join mine m on public.lynxr_brand_key(part.label) <> ''
                 and public.lynxr_brand_key(part.label) in (m.k1, m.k2)
     where r.status = 'accepted' and r.creator_id is not null
  ), per as (
    select h.creator_id, h.email, h.display_name, h.campaign, jsonb_agg(distinct h.client_id) as client_ids
      from hits h
     group by h.creator_id, h.email, h.display_name, h.campaign
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'creator_id', p.creator_id, 'email', p.email, 'display_name', p.display_name,
           'campaign', p.campaign, 'status', 'accepted', 'client_ids', p.client_ids)
         order by lower(coalesce(nullif(p.display_name, ''), p.email))), '[]'::jsonb)
    from per p
$$;

-- Staff tag an EXISTING, CONFIRMED account as a CM by its email. The only way into lynxr_cms.
create or replace function public.staff_add_cm(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_uid   uuid;
  v_conf  timestamptz;
begin
  if not public.is_staff() then
    return jsonb_build_object('ok', false, 'reason', 'not_staff');
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_email');
  end if;
  select u.id, u.email_confirmed_at into v_uid, v_conf
    from auth.users u where lower(u.email) = v_email
   order by u.created_at limit 1;
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_account');
  end if;
  if v_conf is null then
    return jsonb_build_object('ok', false, 'reason', 'unconfirmed');
  end if;
  if exists (select 1 from public.lynxr_cms m where m.user_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;
  insert into public.lynxr_cms (user_id, email, added_by) values (v_uid, v_email, auth.uid());
  return jsonb_build_object('ok', true, 'user_id', v_uid, 'email', v_email);
end;
$$;

revoke all on function public.lynxr_brand_key(text)          from public, anon;
revoke all on function public.is_cm_for(text)                from public, anon;
revoke all on function public.is_cm_for_campaign(uuid)       from public, anon;
revoke all on function public.cm_owns_source(text, text)     from public, anon;
revoke all on function public.cm_owns_path(text)             from public, anon;
revoke all on function public.cm_owns_brief(uuid)            from public, anon;
revoke all on function public.cm_owns_file(uuid)             from public, anon;
revoke all on function public.cm_may_deliver(uuid, uuid)     from public, anon;
revoke all on function public.my_roles()                     from public, anon;
revoke all on function public.cm_clients()                   from public, anon;
revoke all on function public.cm_roster()                    from public, anon;
revoke all on function public.staff_add_cm(text)             from public, anon;
grant execute on function public.lynxr_brand_key(text)       to authenticated;
grant execute on function public.is_cm_for(text)             to authenticated;
grant execute on function public.is_cm_for_campaign(uuid)    to authenticated;
grant execute on function public.cm_owns_source(text, text)  to authenticated;
grant execute on function public.cm_owns_path(text)          to authenticated;
grant execute on function public.cm_owns_brief(uuid)         to authenticated;
grant execute on function public.cm_owns_file(uuid)          to authenticated;
grant execute on function public.cm_may_deliver(uuid, uuid)  to authenticated;
grant execute on function public.my_roles()                  to authenticated;
grant execute on function public.cm_clients()                to authenticated;
grant execute on function public.cm_roster()                 to authenticated;
grant execute on function public.staff_add_cm(text)          to authenticated;

-- ── 5. CM policies, BESIDE the staff ones (every name starts "cm ") ─────────────────────────────────────────────
drop policy if exists "cm read campaigns" on public.lynxr_campaigns;
create policy "cm read campaigns"
  on public.lynxr_campaigns for select to authenticated using (public.is_cm_for(client_id));
drop policy if exists "cm insert campaigns" on public.lynxr_campaigns;
create policy "cm insert campaigns"
  on public.lynxr_campaigns for insert to authenticated
  with check (public.is_cm_for(client_id) and created_uid = auth.uid());
drop policy if exists "cm update campaigns" on public.lynxr_campaigns;
create policy "cm update campaigns"
  on public.lynxr_campaigns for update to authenticated
  using (public.is_cm_for(client_id)) with check (public.is_cm_for(client_id));
drop policy if exists "cm delete own campaigns" on public.lynxr_campaigns;
create policy "cm delete own campaigns"
  on public.lynxr_campaigns for delete to authenticated
  using (public.is_cm_for(client_id) and created_uid = auth.uid());

drop policy if exists "cm read campaign formats" on public.lynxr_campaign_formats;
create policy "cm read campaign formats"
  on public.lynxr_campaign_formats for select to authenticated using (public.is_cm_for_campaign(campaign_id));
drop policy if exists "cm insert campaign formats" on public.lynxr_campaign_formats;
create policy "cm insert campaign formats"
  on public.lynxr_campaign_formats for insert to authenticated with check (public.is_cm_for_campaign(campaign_id));
drop policy if exists "cm update campaign formats" on public.lynxr_campaign_formats;
create policy "cm update campaign formats"
  on public.lynxr_campaign_formats for update to authenticated
  using (public.is_cm_for_campaign(campaign_id)) with check (public.is_cm_for_campaign(campaign_id));
drop policy if exists "cm delete campaign formats" on public.lynxr_campaign_formats;
create policy "cm delete campaign formats"
  on public.lynxr_campaign_formats for delete to authenticated using (public.is_cm_for_campaign(campaign_id));

drop policy if exists "cm read brief files" on public.lynxr_brief_files;
create policy "cm read brief files"
  on public.lynxr_brief_files for select to authenticated using (public.cm_owns_source(source_kind, source_id));
drop policy if exists "cm insert brief files" on public.lynxr_brief_files;
create policy "cm insert brief files"
  on public.lynxr_brief_files for insert to authenticated with check (public.cm_owns_source(source_kind, source_id));
drop policy if exists "cm delete brief files" on public.lynxr_brief_files;
create policy "cm delete brief files"
  on public.lynxr_brief_files for delete to authenticated using (public.cm_owns_source(source_kind, source_id));

drop policy if exists "cm read agency briefs" on public.lynxr_agency_briefs;
create policy "cm read agency briefs"
  on public.lynxr_agency_briefs for select to authenticated using (public.cm_owns_source(source_kind, source_id));
drop policy if exists "cm insert agency briefs" on public.lynxr_agency_briefs;
create policy "cm insert agency briefs"
  on public.lynxr_agency_briefs for insert to authenticated
  with check (public.cm_owns_source(source_kind, source_id) and sent_by = auth.uid());
drop policy if exists "cm update agency briefs" on public.lynxr_agency_briefs;
create policy "cm update agency briefs"
  on public.lynxr_agency_briefs for update to authenticated
  using (public.cm_owns_source(source_kind, source_id)) with check (public.cm_owns_source(source_kind, source_id));

drop policy if exists "cm read agency deliveries" on public.lynxr_agency_deliveries;
create policy "cm read agency deliveries"
  on public.lynxr_agency_deliveries for select to authenticated using (public.cm_owns_brief(brief_id));
drop policy if exists "cm send to company creators" on public.lynxr_agency_deliveries;
create policy "cm send to company creators"
  on public.lynxr_agency_deliveries for insert to authenticated with check (public.cm_may_deliver(brief_id, creator_id));
-- Unsending (revoked_at set) is always allowed on their own briefs; sending again only to a creator they may reach.
drop policy if exists "cm update agency deliveries" on public.lynxr_agency_deliveries;
create policy "cm update agency deliveries"
  on public.lynxr_agency_deliveries for update to authenticated
  using (public.cm_owns_brief(brief_id))
  with check (public.cm_owns_brief(brief_id) and (revoked_at is not null or public.cm_may_deliver(brief_id, creator_id)));

-- Files on beats: only if supabase/brief_file_beats.sql has been run.
do $$
begin
  if to_regclass('public.lynxr_brief_file_beats') is null then
    raise notice 'lynxr_brief_file_beats not installed: its CM policies were skipped. Run this file again after supabase/brief_file_beats.sql.';
    return;
  end if;
  execute 'drop policy if exists "cm read brief file beats" on public.lynxr_brief_file_beats';
  execute 'create policy "cm read brief file beats" on public.lynxr_brief_file_beats for select to authenticated using (public.cm_owns_file(file_id))';
  execute 'drop policy if exists "cm insert brief file beats" on public.lynxr_brief_file_beats';
  execute 'create policy "cm insert brief file beats" on public.lynxr_brief_file_beats for insert to authenticated with check (public.cm_owns_file(file_id))';
  execute 'drop policy if exists "cm update brief file beats" on public.lynxr_brief_file_beats';
  execute 'create policy "cm update brief file beats" on public.lynxr_brief_file_beats for update to authenticated using (public.cm_owns_file(file_id)) with check (public.cm_owns_file(file_id))';
  execute 'drop policy if exists "cm delete brief file beats" on public.lynxr_brief_file_beats';
  execute 'create policy "cm delete brief file beats" on public.lynxr_brief_file_beats for delete to authenticated using (public.cm_owns_file(file_id))';
end $$;

-- ── 6. The bucket. Wrapped, like brief_files.sql: storage.* belongs to the storage service, and a refusal here must
--      not roll back everything above. If it prints "NOT created", do the dashboard steps it names. ──────────────
do $$
begin
  execute 'drop policy if exists "brief files: cm upload" on storage.objects';
  execute 'create policy "brief files: cm upload" on storage.objects for insert to authenticated '
       || 'with check (bucket_id = ''lynxr-brief-files'' and public.cm_owns_path(name))';
  execute 'drop policy if exists "brief files: cm read" on storage.objects';
  execute 'create policy "brief files: cm read" on storage.objects for select to authenticated '
       || 'using (bucket_id = ''lynxr-brief-files'' and public.cm_owns_path(name))';
  execute 'drop policy if exists "brief files: cm delete" on storage.objects';
  execute 'create policy "brief files: cm delete" on storage.objects for delete to authenticated '
       || 'using (bucket_id = ''lynxr-brief-files'' and public.cm_owns_path(name))';
exception when others then
  raise notice 'CM storage policies NOT created (%). Dashboard -> Storage -> Policies -> lynxr-brief-files -> New policy -> For full customization, three times, target role authenticated: (1) "brief files: cm upload", INSERT, with check: bucket_id = ''lynxr-brief-files'' and public.cm_owns_path(name)  (2) "brief files: cm read", SELECT, using: the same expression  (3) "brief files: cm delete", DELETE, using: the same expression', sqlerrm;
end $$;

-- ── 7. SELF-TEST. Runs every time this file is run and WRITES NOTHING: it stands a real non-staff account in as a CM
--      (and, when it can, two more as roster creators and one staff account as staff), checks what each can and
--      cannot do, then raises LX001, which rolls back everything it did; the handler turns that into a NOTICE. Any
--      wrong answer raises a real error instead, and the whole file is rolled back — fix before re-running. ────────
do $$
declare
  u uuid; v uuid; w uuid; s uuid;
  ca uuid; cb uuid; cmine uuid; fa uuid; fb uuid; ba uuid; bb uuid;
  n int; j jsonb; t text;
begin
  select x.id into u from auth.users x
   where x.id not in (select st.id from public.lynxr_staff st)
     and x.id not in (select m.user_id from public.lynxr_cms m)
   order by x.created_at limit 1;
  if u is null then
    raise notice 'cm_portal self-test SKIPPED: no account that is neither staff nor a CM to stand in for one';
    return;
  end if;
  select x.id into v from auth.users x
   where x.id not in (select st.id from public.lynxr_staff st)
     and x.id not in (select m.user_id from public.lynxr_cms m)
     and x.id not in (select r.creator_id from public.lynxr_roster r where r.creator_id is not null)
     and x.id <> u
   order by x.created_at limit 1;
  select x.id into w from auth.users x
   where x.id not in (select st.id from public.lynxr_staff st)
     and x.id not in (select m.user_id from public.lynxr_cms m)
     and x.id not in (select r.creator_id from public.lynxr_roster r where r.creator_id is not null)
     and x.id <> u and x.id is distinct from v
   order by x.created_at limit 1;
  select st.id into s from public.lynxr_staff st order by st.added_at limit 1;

  begin
    -- the world, written as the SQL editor's own role
    insert into public.lynxr_clients (id, data) values
      ('selftest-cm-a', '{"company":"Selftest Alpha","niche":"n","ctx":{"brand":"Alpha App","notes":"keep","activeCreators":9},"briefs":[{"id":"legacy"}]}'::jsonb),
      ('selftest-cm-b', '{"company":"Selftest Beta","ctx":{}}'::jsonb);
    insert into public.lynxr_cms (user_id, email) values (u, 'selftest@example.invalid');
    insert into public.lynxr_cm_clients (cm_id, client_id) values (u, 'selftest-cm-a');
    insert into public.lynxr_campaigns (client_id, name) values ('selftest-cm-a', 'A') returning id into ca;
    insert into public.lynxr_campaigns (client_id, name) values ('selftest-cm-b', 'B') returning id into cb;
    insert into public.lynxr_campaign_formats (campaign_id, source_url)
      values (ca, 'https://www.tiktok.com/@selftest/video/1') returning id into fa;
    insert into public.lynxr_campaign_formats (campaign_id, source_url)
      values (cb, 'https://www.tiktok.com/@selftest/video/2') returning id into fb;
    insert into public.lynxr_agency_briefs (client_name, title, doc, source_kind, source_id)
      values ('A', 'A', '{}'::jsonb, 'campaign', ca::text) returning id into ba;
    insert into public.lynxr_agency_briefs (client_name, title, doc, source_kind, source_id)
      values ('B', 'B', '{}'::jsonb, 'campaign', cb::text) returning id into bb;
    if v is not null and w is not null then
      insert into public.lynxr_roster (email, creator_id, status, campaign) values
        ('selftest-v@example.invalid', v, 'accepted', 'Alpha App, Other'),
        ('selftest-w@example.invalid', w, 'accepted', 'Selftest Beta');
    end if;

    -- 0. the brand key equals app.js rostBrandKey on these inputs
    if public.lynxr_brand_key('Oncourse-AI campaign') <> 'oncourseai'
       or public.lynxr_brand_key('  Café   Glow ') <> 'cafeglow'
       or public.lynxr_brand_key('') <> '' or public.lynxr_brand_key(null) <> '' then
      raise exception 'cm self-test 0: lynxr_brand_key does not match app.js rostBrandKey';
    end if;

    -- become the CM
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    j := public.my_roles();
    if (j->>'staff')::boolean or not (j->>'cm')::boolean or (j->>'companies')::int <> 1 then
      raise exception 'cm self-test 1: my_roles is %', j;
    end if;
    j := public.cm_clients();
    if jsonb_array_length(j) <> 1 or j->0->>'id' <> 'selftest-cm-a' or (j->0) ? 'briefs'
       or (j->0->'ctx') ? 'activeCreators' or j->0->'ctx'->>'brand' <> 'Alpha App' then
      raise exception 'cm self-test 2: cm_clients is %', j;
    end if;
    select count(*) into n from public.lynxr_campaigns where id in (ca, cb);
    if n <> 1 then raise exception 'cm self-test 3: a CM sees % of the two briefs (want 1)', n; end if;
    select count(*) into n from public.lynxr_campaign_formats where id in (fa, fb);
    if n <> 1 then raise exception 'cm self-test 4: a CM sees % of the two formats (want 1)', n; end if;
    begin
      insert into public.lynxr_campaigns (client_id, name) values ('selftest-cm-b', 'x');
      raise exception 'cm self-test 5: a CM made a brief for a company they are not on';
    exception when insufficient_privilege then null;
    end;
    insert into public.lynxr_campaigns (client_id, name) values ('selftest-cm-a', 'mine') returning id into cmine;
    if (select c.created_uid from public.lynxr_campaigns c where c.id = cmine) is distinct from u then
      raise exception 'cm self-test 6: a CM''s new brief is not recorded as theirs';
    end if;
    begin
      update public.lynxr_campaigns set client_id = 'selftest-cm-b' where id = ca;
      raise exception 'cm self-test 7: a CM moved a brief to a company they are not on';
    exception when insufficient_privilege then null;
    end;
    update public.lynxr_campaigns set name = 'x' where id = cb;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'cm self-test 8: a CM renamed another company''s brief'; end if;
    update public.lynxr_campaign_formats set internal_note = 'x' where id = fb;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'cm self-test 8b: a CM edited another company''s format'; end if;
    delete from public.lynxr_campaigns where id = ca;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'cm self-test 9: a CM deleted a brief they did not make'; end if;
    update public.lynxr_campaigns set created_uid = u where id = ca;
    if (select c.created_uid from public.lynxr_campaigns c where c.id = ca) is not null then
      raise exception 'cm self-test 10: a CM claimed a brief by rewriting created_uid';
    end if;
    delete from public.lynxr_campaigns where id = cmine;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'cm self-test 11: a CM could not delete their own brief'; end if;
    foreach t in array array['lynxr_videos', 'lynxr_clients', 'lynxr_staff', 'lynxr_roster', 'lynxr_ops',
                             'lynxr_costs', 'lynxr_sources', 'lynxr_feedback'] loop
      if to_regclass('public.' || t) is not null then
        execute format('select count(*) from public.%I', t) into n;
        if n <> 0 then raise exception 'cm self-test 12: a CM reads % rows of %', n, t; end if;
      end if;
    end loop;
    select count(*) into n from public.lynxr_cm_clients where cm_id <> u;
    if n <> 0 then raise exception 'cm self-test 12b: a CM reads another CM''s companies'; end if;
    begin
      insert into public.lynxr_cm_clients (cm_id, client_id) values (u, 'selftest-cm-b');
      raise exception 'cm self-test 13: a CM put themselves on a company';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.lynxr_staff (id, email) values (u, '');
      raise exception 'cm self-test 13b: a CM made themselves staff';
    exception when insufficient_privilege then null;
    end;
    if coalesce((public.staff_add_cm('selftest@example.invalid')->>'ok')::boolean, false) then
      raise exception 'cm self-test 13c: a CM tagged someone a CM';
    end if;
    select count(*) into n from public.lynxr_agency_briefs where id in (ba, bb);
    if n <> 1 then raise exception 'cm self-test 14: a CM sees % of the two sent briefs (want 1)', n; end if;
    begin
      insert into public.lynxr_agency_briefs (client_name, title, doc, source_kind, source_id, sent_by)
        values ('B', 'x', '{}'::jsonb, 'campaign', cb::text, u);
      raise exception 'cm self-test 14b: a CM recorded a send for another company''s brief';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.lynxr_brief_files (source_kind, source_id, path, name, size)
        values ('campaign', cb::text, 'campaign/' || cb::text || '/selftest/a.png', 'a.png', 1);
      raise exception 'cm self-test 15: a CM attached a file to another company''s brief';
    exception when insufficient_privilege then null;
    end;
    insert into public.lynxr_brief_files (source_kind, source_id, path, name, size)
      values ('campaign', ca::text, 'campaign/' || ca::text || '/selftest/a.png', 'a.png', 1);
    if not public.cm_owns_path('campaign/' || ca::text || '/r/a.png')
       or public.cm_owns_path('campaign/' || cb::text || '/r/a.png')
       or public.cm_owns_path('brief/' || ca::text || '/r/a.png') then
      raise exception 'cm self-test 16: cm_owns_path answers wrong';
    end if;
    if v is not null and w is not null then
      j := public.cm_roster();
      if jsonb_array_length(j) <> 1 or j->0->>'creator_id' <> v::text
         or j->0->'client_ids' <> '["selftest-cm-a"]'::jsonb then
        raise exception 'cm self-test 17: cm_roster is %', j;
      end if;
      insert into public.lynxr_agency_deliveries (brief_id, creator_id) values (ba, v);
      begin
        insert into public.lynxr_agency_deliveries (brief_id, creator_id) values (ba, w);
        raise exception 'cm self-test 18: a CM sent a brief to another company''s creator';
      exception when insufficient_privilege then null;
      end;
      begin
        insert into public.lynxr_agency_deliveries (brief_id, creator_id) values (bb, v);
        raise exception 'cm self-test 18b: a CM sent another company''s brief';
      exception when insufficient_privilege then null;
      end;
      update public.lynxr_agency_deliveries set revoked_at = now() where brief_id = ba and creator_id = v;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'cm self-test 18c: a CM could not unsend their own send'; end if;
    else
      raise notice 'cm_portal self-test: the send checks (17-18) were skipped: they need two more accounts that are not staff, not a CM and not on the roster';
    end if;
    execute 'reset role';

    -- a plain creator sees none of it
    if v is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      select count(*) into n from public.lynxr_campaigns where id in (ca, cb);
      if n <> 0 then raise exception 'cm self-test 19: a creator sees % briefs', n; end if;
      if public.cm_clients() <> '[]'::jsonb or public.cm_roster() <> '[]'::jsonb
         or (public.my_roles()->>'cm')::boolean then
        raise exception 'cm self-test 19b: a creator gets CM answers';
      end if;
      execute 'reset role';
    end if;

    -- staff still see and do everything
    if s is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      select count(*) into n from public.lynxr_campaigns where id in (ca, cb);
      if n <> 2 then raise exception 'cm self-test 20: staff see % of the two briefs (want 2)', n; end if;
      if not (public.my_roles()->>'staff')::boolean then
        raise exception 'cm self-test 20b: my_roles does not say staff';
      end if;
      delete from public.lynxr_campaigns where id = cb;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'cm self-test 20c: staff could not delete a brief'; end if;
      execute 'reset role';
    end if;

    raise exception 'cm_portal self-test passed' using errcode = 'LX001';
  exception when sqlstate 'LX001' then
    raise notice 'cm_portal self-test passed — rolled back, nothing written';
  end;
end $$;

notify pgrst, 'reload schema';

-- ── Runbook (after Run) ─────────────────────────────────────────────────────────────────────────────────────────
-- Expect the notice "cm_portal self-test passed — rolled back, nothing written" (or SKIPPED with its reason).
--
-- Make someone a CM: agency app → Creators → CMs → Add CM (the account must exist and be confirmed), then tick their
-- companies. From this editor instead (you are not "staff" here, so staff_add_cm() answers not_staff):
--   insert into public.lynxr_cms (user_id, email)
--     select id, lower(email) from auth.users
--      where lower(email) = lower('them@example.com') and email_confirmed_at is not null;
--   insert into public.lynxr_cm_clients (cm_id, client_id)
--     select id, '<lynxr_clients.id>' from auth.users where lower(email) = lower('them@example.com');
--
-- Who is a CM, on what:
--   select m.email, m.added_at,
--          coalesce(array_agg(c.data->>'company' order by c.data->>'company') filter (where c.id is not null), '{}') as companies
--     from public.lynxr_cms m
--     left join public.lynxr_cm_clients a on a.cm_id = m.user_id
--     left join public.lynxr_clients c on c.id = a.client_id
--    group by m.user_id, m.email, m.added_at order by m.added_at;
--
-- Briefs CMs made:
--   select c.name, c.client_id, m.email, c.created_at
--     from public.lynxr_campaigns c join public.lynxr_cms m on m.user_id = c.created_uid order by c.created_at desc;
--
-- Policies in place (expect 24; 21 when lynxr_brief_file_beats is not installed):
--   select tablename, policyname, cmd from pg_policies
--    where policyname like 'cm %' or policyname like 'brief files: cm%' order by 1, 2;
--
-- KILL SWITCH, instant: delete from public.lynxr_cms;   (every CM policy then matches nobody; assignments go with it)
