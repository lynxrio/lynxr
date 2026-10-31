-- Lynxr — the CM MANAGER role (owner, 2026-10-30). Plan: ~/.claude/plans/lynxr-cm-manager.md
--
-- Owner: "we have a cm and then a cm manager that looks over all the cms so allow that manager to add, remove, edit cms
-- to campaigns and also add creators to the lmg side. so he can see all the briefs essentially what gawin and i have".
--
-- A MANAGER is a signed-in lynxr account with a row in lynxr_cm_managers. Only the SQL editor adds one (runbook at the
-- end): there is no insert policy and no function that inserts, so no API call can make anyone a manager, and a manager
-- can never make themselves staff. For EVERY live client a manager can:
--   * read the client's brand fields through mgr_clients() (the allowlist cm_clients() gives a CM) and nothing else of
--     the lynxr_clients row: no legacy picked-video briefs, posts or agency numbers;
--   * read, create, edit and send campaign briefs (formats, files, files on beats, notes and images, the bucket), and
--     delete only briefs they made (created_uid);
--   * send to ANY accepted roster creator, as staff can;
--   * manage CMs: read every CM and assignment, add a CM (staff_add_cm(), now staff OR manager), remove one, tick and
--     untick any CM's clients;
--   * manage the Lynx Media Group roster through mgr_roster(), mgr_invite_creator(), mgr_set_brands() and
--     mgr_remove_creator(): invite, edit brand labels, re-invite someone who left, cancel a pending invite. None of them
--     can mark anyone accepted (only the creator does, accept_agency_invite()), and none deletes an accepted creator's
--     row (staff only); clearing their brands takes them off every client instead. Every change is logged.
-- A manager can NOT read lynxr_videos (suggested videos, the database), ops, costs, sources, billing, staff tables or
-- the roster table, cannot touch legacy picked-video briefs or their sends and files, and cannot write lynxr_clients
-- (no new clients, no brand edits, no deletes).
--
-- ENFORCED HERE, NOT IN THE INTERFACE. Every policy below is ADDED beside the staff and CM ones (Postgres ORs permissive
-- policies) and is named "cm manager ...", so nothing staff or CMs can do changes.
--
-- This file REDEFINES two functions of supabase/cm_portal.sql: my_roles() (adds "manager") and staff_add_cm() (staff OR
-- manager). Re-running cm_portal.sql puts the old two back (managers then fall back to CM or creator), so RE-RUN THIS FILE
-- after any re-run of cm_portal.sql. It also widens lynxr_cm_roster_log (supabase/cm_creators.sql) for manager rows;
-- re-running cm_creators.sql does not undo that.
--
-- Run AFTER supabase/cm_portal.sql and supabase/cm_creators.sql. Dashboard → SQL Editor → New query → paste → Run.
-- Standalone, idempotent, safe to re-run. Order against the push does not matter.
-- **No real email address, uuid or name anywhere in this file — the repo is public.**

-- ── 0. Prerequisites ─────────────────────────────────────────────────────────────────────────────────────────────
do $$ begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
  if to_regprocedure('public.is_cm_for(text)') is null or to_regclass('public.lynxr_cms') is null
     or to_regprocedure('public.lynxr_brand_key(text)') is null or to_regprocedure('public.cm_clients()') is null then
    raise exception 'the CM portal is missing — run supabase/cm_portal.sql first';
  end if;
  if to_regclass('public.lynxr_cm_roster_log') is null or to_regprocedure('public.cm_creators()') is null then
    raise exception 'CMs adding creators is missing — run supabase/cm_creators.sql first';
  end if;
end $$;

-- ── 1. Who is a manager ──────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.lynxr_cm_managers (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text        not null default '',   -- the address it was added under; staff and the manager see it
  added_by uuid,                               -- no FK, so history survives a removal
  added_at timestamptz not null default now()
);
comment on table public.lynxr_cm_managers is
  'CM managers (plan lynxr-cm-manager.md). Added only from the SQL editor; staff may delete. A manager reads every client''s campaign briefs, manages CMs and the roster through functions, and never reads lynxr_videos, lynxr_clients or lynxr_roster directly.';
alter table public.lynxr_cm_managers enable row level security;
revoke all on table public.lynxr_cm_managers from anon;
drop policy if exists "staff or self read cm managers" on public.lynxr_cm_managers;
create policy "staff or self read cm managers"
  on public.lynxr_cm_managers for select to authenticated using (public.is_staff() or user_id = auth.uid());
drop policy if exists "staff delete cm managers" on public.lynxr_cm_managers;
create policy "staff delete cm managers"
  on public.lynxr_cm_managers for delete to authenticated using (public.is_staff());
-- No insert or update policy, and no function inserts here.

-- ── 2. The roster log takes manager rows (supabase/cm_creators.sql made it) ──────────────────────────────────────
-- Every CHECK on the table that mentions kind goes, whatever Postgres named it, and one wider CHECK comes back.
do $$
declare k text;
begin
  for k in select con.conname from pg_constraint con
            where con.conrelid = 'public.lynxr_cm_roster_log'::regclass and con.contype = 'c'
              and pg_get_constraintdef(con.oid) like '%kind%' loop
    execute format('alter table public.lynxr_cm_roster_log drop constraint %I', k);
  end loop;
end $$;
alter table public.lynxr_cm_roster_log add constraint lynxr_cm_roster_log_kind_check
  check (kind in ('invite', 'add_brand', 'remove_brand', 'cancel', 'mgr_invite', 'mgr_brands', 'mgr_remove'));
alter table public.lynxr_cm_roster_log add column if not exists detail text not null default '';
comment on column public.lynxr_cm_roster_log.detail is
  'Manager rows: the brand label written (mgr_invite, mgr_brands) or the status of the row removed (mgr_remove). client_id is empty on manager rows.';

-- ── 3. The checks every manager policy uses (SECURITY DEFINER; each takes no identity: auth.uid() only) ─────────
create or replace function public.is_cm_manager()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lynxr_cm_managers m where m.user_id = auth.uid())
$$;

-- A live client: a real lynxr_clients row, not one of the three bookkeeping rows, not tombstoned. INTERNAL: no grant to
-- authenticated (it would tell anyone whether a client id exists); only the mgr_* checks below call it.
create or replace function public.lynxr_live_client(p_client text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_client is not null
     and p_client not in ('ingest-queue', 'deleted-clients', 'source-edits')
     and exists (select 1 from public.lynxr_clients c where c.id = p_client)
     and not exists (select 1 from public.lynxr_clients t
                      where t.id = 'deleted-clients' and coalesce(t.data->'ids', '[]'::jsonb) ? p_client)
$$;

create or replace function public.mgr_client(p_client text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_cm_manager() and public.lynxr_live_client(p_client)
$$;

create or replace function public.mgr_campaign(p_campaign uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_cm_manager() and exists (
    select 1 from public.lynxr_campaigns cp where cp.id = p_campaign and public.lynxr_live_client(cp.client_id))
$$;

-- A brief SOURCE as lynxr_brief_files and lynxr_agency_briefs record it. Campaign briefs only: a legacy picked-video
-- brief ('brief') is never a manager's. Compares as text, so a malformed id cannot throw.
create or replace function public.mgr_source(p_kind text, p_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_kind = 'campaign', false) and public.is_cm_manager() and exists (
    select 1 from public.lynxr_campaigns cp where cp.id::text = p_id and public.lynxr_live_client(cp.client_id))
$$;

-- A storage object key in lynxr-brief-files: <source_kind>/<source id>/<random>/<file> (app.js bfUpload).
create or replace function public.mgr_path(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select split_part(coalesce(p_name, ''), '/', 1) = 'campaign'
         and public.mgr_source('campaign', split_part(coalesce(p_name, ''), '/', 2))
$$;

create or replace function public.mgr_brief(p_brief uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lynxr_agency_briefs b
                  where b.id = p_brief and public.mgr_source(b.source_kind, b.source_id))
$$;

create or replace function public.mgr_file(p_file uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lynxr_brief_files f
                  where f.id = p_file and public.mgr_source(f.source_kind, f.source_id))
$$;

-- May the calling manager deliver brief p_brief to creator p_creator? A campaign brief of a live client, to an ACCEPTED
-- roster creator (any brand), the same reach staff have.
create or replace function public.mgr_may_deliver(p_brief uuid, p_creator uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.mgr_brief(p_brief) and exists (
    select 1 from public.lynxr_roster r where r.creator_id = p_creator and r.status = 'accepted')
$$;

-- ── 4. What the apps read ────────────────────────────────────────────────────────────────────────────────────────
-- REDEFINED from supabase/cm_portal.sql: the same three keys plus "manager".
create or replace function public.my_roles()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'staff', public.is_staff(),
    'cm', exists (select 1 from public.lynxr_cms m where m.user_id = auth.uid()),
    'manager', public.is_cm_manager(),
    'companies', (select count(*) from public.lynxr_cm_clients a
                    join public.lynxr_clients c on c.id = a.client_id
                   where a.cm_id = auth.uid()))
$$;

-- Every live client, as cm_clients() hands a CM their own: an ALLOWLIST of the brand fields brandContextFromClient()
-- (app.js) reads. Never the row's briefs (legacy picked-video briefs hold copies of scraped corpus rows), posts,
-- blueprints or other ctx keys. Empty for anyone who is not a manager.
create or replace function public.mgr_clients()
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
    from public.lynxr_clients c
   where public.is_cm_manager() and public.lynxr_live_client(c.id)
$$;

-- REDEFINED from supabase/cm_portal.sql: staff OR a manager tag an EXISTING, CONFIRMED account as a CM. Still the only
-- way into lynxr_cms; the refusal for anyone else is still "not_staff" (app.js CMS_SAYS reads it).
create or replace function public.staff_add_cm(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_uid   uuid;
  v_conf  timestamptz;
begin
  if not (public.is_staff() or public.is_cm_manager()) then
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

-- ── 5. The roster, for managers: four functions, no table policy ─────────────────────────────────────────────────
-- The brand label as app.js rostBrandLabel stores it: split on , and ;, tidy spaces, drop parts with no letters or
-- digits, keep the first spelling of each brand key, join with ", ". INTERNAL (no grant): the functions below use it.
create or replace function public.lynxr_brand_label(p text)
returns text language sql immutable set search_path = '' as $$
  select coalesce(string_agg(x.part, ', ' order by x.ord), '')
    from (select distinct on (public.lynxr_brand_key(s.label))
                 btrim(regexp_replace(s.label, '\s+', ' ', 'g')) as part, s.ord
            from regexp_split_to_table(coalesce(p, ''), '[,;]') with ordinality as s(label, ord)
           where public.lynxr_brand_key(s.label) <> ''
           order by public.lynxr_brand_key(s.label), s.ord) x
$$;

-- The whole roster, as the staff Creators tab reads it. An account id only on accepted rows. Empty for non-managers.
create or replace function public.mgr_roster()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'email', r.email, 'display_name', r.display_name, 'campaign', r.campaign, 'status', r.status,
           'creator_id', case when r.status = 'accepted' then r.creator_id end,
           'invited_at', r.invited_at, 'accepted_at', r.accepted_at, 'left_at', r.left_at)
         order by r.invited_at desc, r.email), '[]'::jsonb)
    from public.lynxr_roster r
   where public.is_cm_manager()
$$;

-- Invite an email, or update an invite. The staff rule: blank boxes keep what is there; typed brands REPLACE the label;
-- someone who left is invited again (status invited: they must accept again). Never touches status 'accepted',
-- creator_id or accepted_at. Answers { ok: true, result: invited | updated | reinvited, status } or
-- { ok: false, reason: not_manager | bad_email | too_long | busy }.
create or replace function public.mgr_invite_creator(p_email text, p_name text default '', p_brands text default '',
                                                      p_note text default '')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name  text := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 80);
  v_note  text := left(btrim(coalesce(p_note, '')), 500);
  v_label text := public.lynxr_brand_label(p_brands);
  v_row   public.lynxr_roster%rowtype;
  n       int;
begin
  if v_uid is null or not public.is_cm_manager() then
    return jsonb_build_object('ok', false, 'reason', 'not_manager');
  end if;
  if char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_email');
  end if;
  if char_length(v_label) > 80 then
    return jsonb_build_object('ok', false, 'reason', 'too_long');
  end if;
  select r.* into v_row from public.lynxr_roster r where r.email = v_email for update;
  if not found then
    insert into public.lynxr_roster (email, display_name, campaign, note, invited_by)
    values (v_email, v_name, v_label, v_note, v_uid)
    on conflict (email) do nothing;
    get diagnostics n = row_count;
    if n = 0 then
      return jsonb_build_object('ok', false, 'reason', 'busy');
    end if;
    insert into public.lynxr_cm_roster_log (cm_id, client_id, email, kind, detail)
      values (v_uid, '', v_email, 'mgr_invite', v_label);
    return jsonb_build_object('ok', true, 'result', 'invited', 'status', 'invited');
  end if;
  update public.lynxr_roster
     set display_name = case when v_name <> '' then v_name else display_name end,
         note         = case when v_note <> '' then v_note else note end,
         campaign     = case when v_label <> '' then v_label else campaign end,
         status       = case when status = 'left' then 'invited' else status end,
         left_at      = case when status = 'left' then null else left_at end
   where email = v_email;
  insert into public.lynxr_cm_roster_log (cm_id, client_id, email, kind, detail)
    values (v_uid, '', v_email, case when v_row.status = 'left' then 'mgr_invite' else 'mgr_brands' end, v_label);
  return jsonb_build_object('ok', true,
    'result', case when v_row.status = 'left' then 'reinvited' else 'updated' end,
    'status', case when v_row.status = 'left' then 'invited' else v_row.status end);
end;
$$;

-- Set one creator's brand label (it can be cleared: that takes them off every client). Any status. Answers
-- { ok: true, result: updated, status } or { ok: false, reason: not_manager | too_long | gone }.
create or replace function public.mgr_set_brands(p_email text, p_brands text default '')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_label  text := public.lynxr_brand_label(p_brands);
  v_status text;
begin
  if v_uid is null or not public.is_cm_manager() then
    return jsonb_build_object('ok', false, 'reason', 'not_manager');
  end if;
  if char_length(v_label) > 80 then
    return jsonb_build_object('ok', false, 'reason', 'too_long');
  end if;
  update public.lynxr_roster set campaign = v_label where email = v_email returning status into v_status;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;
  insert into public.lynxr_cm_roster_log (cm_id, client_id, email, kind, detail)
    values (v_uid, '', v_email, 'mgr_brands', v_label);
  return jsonb_build_object('ok', true, 'result', 'updated', 'status', v_status);
end;
$$;

-- Delete a PENDING invite or a LEFT row. An accepted creator's row is never deleted here (staff only: it cuts their
-- access to every sent brief). Answers { ok: true, result: removed, status } or
-- { ok: false, reason: not_manager | gone | accepted }.
create or replace function public.mgr_remove_creator(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_row   public.lynxr_roster%rowtype;
begin
  if v_uid is null or not public.is_cm_manager() then
    return jsonb_build_object('ok', false, 'reason', 'not_manager');
  end if;
  select r.* into v_row from public.lynxr_roster r where r.email = v_email for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;
  if v_row.status = 'accepted' then
    return jsonb_build_object('ok', false, 'reason', 'accepted');
  end if;
  delete from public.lynxr_roster where email = v_email;
  insert into public.lynxr_cm_roster_log (cm_id, client_id, email, kind, detail)
    values (v_uid, '', v_email, 'mgr_remove', v_row.status);
  return jsonb_build_object('ok', true, 'result', 'removed', 'status', v_row.status);
end;
$$;

-- ── 6. Grants ────────────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.lynxr_live_client(text)                       from public, anon, authenticated;
revoke all on function public.lynxr_brand_label(text)                       from public, anon, authenticated;
revoke all on function public.is_cm_manager()                               from public, anon;
revoke all on function public.mgr_client(text)                              from public, anon;
revoke all on function public.mgr_campaign(uuid)                            from public, anon;
revoke all on function public.mgr_source(text, text)                        from public, anon;
revoke all on function public.mgr_path(text)                                from public, anon;
revoke all on function public.mgr_brief(uuid)                               from public, anon;
revoke all on function public.mgr_file(uuid)                                from public, anon;
revoke all on function public.mgr_may_deliver(uuid, uuid)                   from public, anon;
revoke all on function public.my_roles()                                    from public, anon;
revoke all on function public.mgr_clients()                                 from public, anon;
revoke all on function public.staff_add_cm(text)                            from public, anon;
revoke all on function public.mgr_roster()                                  from public, anon;
revoke all on function public.mgr_invite_creator(text, text, text, text)    from public, anon;
revoke all on function public.mgr_set_brands(text, text)                    from public, anon;
revoke all on function public.mgr_remove_creator(text)                      from public, anon;
grant execute on function public.is_cm_manager()                            to authenticated;
grant execute on function public.mgr_client(text)                           to authenticated;
grant execute on function public.mgr_campaign(uuid)                         to authenticated;
grant execute on function public.mgr_source(text, text)                     to authenticated;
grant execute on function public.mgr_path(text)                             to authenticated;
grant execute on function public.mgr_brief(uuid)                            to authenticated;
grant execute on function public.mgr_file(uuid)                             to authenticated;
grant execute on function public.mgr_may_deliver(uuid, uuid)                to authenticated;
grant execute on function public.my_roles()                                 to authenticated;
grant execute on function public.mgr_clients()                              to authenticated;
grant execute on function public.staff_add_cm(text)                         to authenticated;
grant execute on function public.mgr_roster()                               to authenticated;
grant execute on function public.mgr_invite_creator(text, text, text, text) to authenticated;
grant execute on function public.mgr_set_brands(text, text)                 to authenticated;
grant execute on function public.mgr_remove_creator(text)                   to authenticated;

-- ── 7. Manager policies, BESIDE the staff and CM ones (every name starts "cm manager "). The leading
--      (select public.is_cm_manager()) is evaluated once per statement, so non-managers pay one lookup. ────────────
drop policy if exists "cm manager read campaigns" on public.lynxr_campaigns;
create policy "cm manager read campaigns"
  on public.lynxr_campaigns for select to authenticated
  using ((select public.is_cm_manager()) and public.mgr_client(client_id));
drop policy if exists "cm manager insert campaigns" on public.lynxr_campaigns;
create policy "cm manager insert campaigns"
  on public.lynxr_campaigns for insert to authenticated
  with check ((select public.is_cm_manager()) and public.mgr_client(client_id) and created_uid = auth.uid());
drop policy if exists "cm manager update campaigns" on public.lynxr_campaigns;
create policy "cm manager update campaigns"
  on public.lynxr_campaigns for update to authenticated
  using ((select public.is_cm_manager()) and public.mgr_client(client_id))
  with check ((select public.is_cm_manager()) and public.mgr_client(client_id));
drop policy if exists "cm manager delete own campaigns" on public.lynxr_campaigns;
create policy "cm manager delete own campaigns"
  on public.lynxr_campaigns for delete to authenticated
  using ((select public.is_cm_manager()) and public.mgr_client(client_id) and created_uid = auth.uid());

drop policy if exists "cm manager read campaign formats" on public.lynxr_campaign_formats;
create policy "cm manager read campaign formats"
  on public.lynxr_campaign_formats for select to authenticated
  using ((select public.is_cm_manager()) and public.mgr_campaign(campaign_id));
drop policy if exists "cm manager insert campaign formats" on public.lynxr_campaign_formats;
create policy "cm manager insert campaign formats"
  on public.lynxr_campaign_formats for insert to authenticated
  with check ((select public.is_cm_manager()) and public.mgr_campaign(campaign_id));
drop policy if exists "cm manager update campaign formats" on public.lynxr_campaign_formats;
create policy "cm manager update campaign formats"
  on public.lynxr_campaign_formats for update to authenticated
  using ((select public.is_cm_manager()) and public.mgr_campaign(campaign_id))
  with check ((select public.is_cm_manager()) and public.mgr_campaign(campaign_id));
drop policy if exists "cm manager delete campaign formats" on public.lynxr_campaign_formats;
create policy "cm manager delete campaign formats"
  on public.lynxr_campaign_formats for delete to authenticated
  using ((select public.is_cm_manager()) and public.mgr_campaign(campaign_id));

drop policy if exists "cm manager read brief files" on public.lynxr_brief_files;
create policy "cm manager read brief files"
  on public.lynxr_brief_files for select to authenticated
  using ((select public.is_cm_manager()) and public.mgr_source(source_kind, source_id));
drop policy if exists "cm manager insert brief files" on public.lynxr_brief_files;
create policy "cm manager insert brief files"
  on public.lynxr_brief_files for insert to authenticated
  with check ((select public.is_cm_manager()) and public.mgr_source(source_kind, source_id));
drop policy if exists "cm manager delete brief files" on public.lynxr_brief_files;
create policy "cm manager delete brief files"
  on public.lynxr_brief_files for delete to authenticated
  using ((select public.is_cm_manager()) and public.mgr_source(source_kind, source_id));

drop policy if exists "cm manager read agency briefs" on public.lynxr_agency_briefs;
create policy "cm manager read agency briefs"
  on public.lynxr_agency_briefs for select to authenticated
  using ((select public.is_cm_manager()) and public.mgr_source(source_kind, source_id));
drop policy if exists "cm manager insert agency briefs" on public.lynxr_agency_briefs;
create policy "cm manager insert agency briefs"
  on public.lynxr_agency_briefs for insert to authenticated
  with check ((select public.is_cm_manager()) and public.mgr_source(source_kind, source_id) and sent_by = auth.uid());
drop policy if exists "cm manager update agency briefs" on public.lynxr_agency_briefs;
create policy "cm manager update agency briefs"
  on public.lynxr_agency_briefs for update to authenticated
  using ((select public.is_cm_manager()) and public.mgr_source(source_kind, source_id))
  with check ((select public.is_cm_manager()) and public.mgr_source(source_kind, source_id));

drop policy if exists "cm manager read agency deliveries" on public.lynxr_agency_deliveries;
create policy "cm manager read agency deliveries"
  on public.lynxr_agency_deliveries for select to authenticated
  using ((select public.is_cm_manager()) and public.mgr_brief(brief_id));
drop policy if exists "cm manager send to accepted roster" on public.lynxr_agency_deliveries;
create policy "cm manager send to accepted roster"
  on public.lynxr_agency_deliveries for insert to authenticated
  with check ((select public.is_cm_manager()) and public.mgr_may_deliver(brief_id, creator_id));
-- Unsending (revoked_at set) is always allowed on a brief they can see; sending again only to an accepted creator.
drop policy if exists "cm manager update agency deliveries" on public.lynxr_agency_deliveries;
create policy "cm manager update agency deliveries"
  on public.lynxr_agency_deliveries for update to authenticated
  using ((select public.is_cm_manager()) and public.mgr_brief(brief_id))
  with check ((select public.is_cm_manager()) and public.mgr_brief(brief_id)
              and (revoked_at is not null or public.mgr_may_deliver(brief_id, creator_id)));

drop policy if exists "cm manager read cms" on public.lynxr_cms;
create policy "cm manager read cms"
  on public.lynxr_cms for select to authenticated using ((select public.is_cm_manager()));
drop policy if exists "cm manager delete cms" on public.lynxr_cms;
create policy "cm manager delete cms"
  on public.lynxr_cms for delete to authenticated using ((select public.is_cm_manager()));
-- No insert policy: staff_add_cm() stays the only way into lynxr_cms.

drop policy if exists "cm manager read cm clients" on public.lynxr_cm_clients;
create policy "cm manager read cm clients"
  on public.lynxr_cm_clients for select to authenticated using ((select public.is_cm_manager()));
drop policy if exists "cm manager assign cm clients" on public.lynxr_cm_clients;
create policy "cm manager assign cm clients"
  on public.lynxr_cm_clients for insert to authenticated
  with check ((select public.is_cm_manager()) and public.mgr_client(client_id));
drop policy if exists "cm manager unassign cm clients" on public.lynxr_cm_clients;
create policy "cm manager unassign cm clients"
  on public.lynxr_cm_clients for delete to authenticated using ((select public.is_cm_manager()));

-- Files on beats: only if supabase/brief_file_beats.sql has been run.
do $$
begin
  if to_regclass('public.lynxr_brief_file_beats') is null then
    raise notice 'lynxr_brief_file_beats not installed: its manager policies were skipped. Run this file again after supabase/brief_file_beats.sql.';
    return;
  end if;
  execute 'drop policy if exists "cm manager read brief file beats" on public.lynxr_brief_file_beats';
  execute 'create policy "cm manager read brief file beats" on public.lynxr_brief_file_beats for select to authenticated using ((select public.is_cm_manager()) and public.mgr_file(file_id))';
  execute 'drop policy if exists "cm manager insert brief file beats" on public.lynxr_brief_file_beats';
  execute 'create policy "cm manager insert brief file beats" on public.lynxr_brief_file_beats for insert to authenticated with check ((select public.is_cm_manager()) and public.mgr_file(file_id))';
  execute 'drop policy if exists "cm manager update brief file beats" on public.lynxr_brief_file_beats';
  execute 'create policy "cm manager update brief file beats" on public.lynxr_brief_file_beats for update to authenticated using ((select public.is_cm_manager()) and public.mgr_file(file_id)) with check ((select public.is_cm_manager()) and public.mgr_file(file_id))';
  execute 'drop policy if exists "cm manager delete brief file beats" on public.lynxr_brief_file_beats';
  execute 'create policy "cm manager delete brief file beats" on public.lynxr_brief_file_beats for delete to authenticated using ((select public.is_cm_manager()) and public.mgr_file(file_id))';
end $$;

-- ── 8. The bucket. Wrapped, like cm_portal.sql: storage.* belongs to the storage service, and a refusal here must not
--      roll back everything above. If it prints "NOT created", do the dashboard steps it names. ────────────────────
do $$
begin
  execute 'drop policy if exists "brief files: cm manager upload" on storage.objects';
  execute 'create policy "brief files: cm manager upload" on storage.objects for insert to authenticated '
       || 'with check (bucket_id = ''lynxr-brief-files'' and public.mgr_path(name))';
  execute 'drop policy if exists "brief files: cm manager read" on storage.objects';
  execute 'create policy "brief files: cm manager read" on storage.objects for select to authenticated '
       || 'using (bucket_id = ''lynxr-brief-files'' and public.mgr_path(name))';
  execute 'drop policy if exists "brief files: cm manager delete" on storage.objects';
  execute 'create policy "brief files: cm manager delete" on storage.objects for delete to authenticated '
       || 'using (bucket_id = ''lynxr-brief-files'' and public.mgr_path(name))';
exception when others then
  raise notice 'CM manager storage policies NOT created (%). Dashboard -> Storage -> Policies -> lynxr-brief-files -> New policy -> For full customization, three times, target role authenticated: (1) "brief files: cm manager upload", INSERT, with check: bucket_id = ''lynxr-brief-files'' and public.mgr_path(name)  (2) "brief files: cm manager read", SELECT, using: the same expression  (3) "brief files: cm manager delete", DELETE, using: the same expression', sqlerrm;
end $$;

-- ── 9. SELF-TEST. Runs every time this file is run and WRITES NOTHING: it stands a real account (not staff, not a CM,
--      not a manager) in as a manager, and when it can, more accounts as an accepted roster creator, a CM, a CM to add,
--      and one staff account; checks every CAN and CANNOT; then raises LX001, which rolls back everything it did; the
--      handler turns that into a NOTICE. Any wrong answer raises a real error, and the whole file is rolled back. ──
do $$
declare
  u uuid; v uuid; c uuid; s uuid; x uuid; x_email text; w uuid;
  ca uuid; cb uuid; cmine uuid; fb uuid; ba uuid; bl uuid; fl uuid;
  n int; j jsonb; t text;
begin
  select a.id into u from auth.users a
   where a.id not in (select st.id from public.lynxr_staff st)
     and a.id not in (select m.user_id from public.lynxr_cms m)
     and a.id not in (select g.user_id from public.lynxr_cm_managers g)
   order by a.created_at limit 1;
  if u is null then
    raise notice 'cm_manager self-test SKIPPED: no account that is not staff, a CM or a manager to stand in for one';
    return;
  end if;
  select a.id into v from auth.users a
   where a.id not in (select st.id from public.lynxr_staff st)
     and a.id not in (select m.user_id from public.lynxr_cms m)
     and a.id not in (select g.user_id from public.lynxr_cm_managers g)
     and a.id not in (select r.creator_id from public.lynxr_roster r where r.creator_id is not null)
     and a.id <> u
   order by a.created_at limit 1;
  select a.id into c from auth.users a
   where a.id not in (select st.id from public.lynxr_staff st)
     and a.id not in (select m.user_id from public.lynxr_cms m)
     and a.id not in (select g.user_id from public.lynxr_cm_managers g)
     and a.id not in (select r.creator_id from public.lynxr_roster r where r.creator_id is not null)
     and a.id <> u and a.id is distinct from v
   order by a.created_at limit 1;
  select a.id, lower(a.email) into x, x_email from auth.users a
   where a.email_confirmed_at is not null and coalesce(a.email, '') <> ''
     and a.id not in (select m.user_id from public.lynxr_cms m)
     and a.id <> u and a.id is distinct from v and a.id is distinct from c
   order by a.created_at limit 1;
  select st.id into s from public.lynxr_staff st order by st.added_at limit 1;

  begin
    -- 0. the label tidy matches app.js rostBrandLabel
    if public.lynxr_brand_label(' Probe Brand ;probe brand, Other ') <> 'Probe Brand, Other'
       or public.lynxr_brand_label('') <> '' or public.lynxr_brand_label(null) <> ''
       or public.lynxr_brand_label(' , ;') <> '' then
      raise exception 'cm_manager self-test 0: lynxr_brand_label does not match app.js rostBrandLabel';
    end if;

    -- the world, written as the SQL editor's own role
    insert into public.lynxr_clients (id, data) values
      ('selftest-mgr-a', '{"company":"Selftest Alpha","niche":"n","ctx":{"brand":"Alpha App","notes":"keep","activeCreators":9},"briefs":[{"id":"legacy"}]}'::jsonb),
      ('selftest-mgr-b', '{"company":"Selftest Beta","ctx":{}}'::jsonb);
    insert into public.lynxr_cm_managers (user_id, email) values (u, 'selftest-mgr@example.invalid');
    if c is not null then
      insert into public.lynxr_cms (user_id, email) values (c, 'selftest-cm@example.invalid');
      insert into public.lynxr_cm_clients (cm_id, client_id) values (c, 'selftest-mgr-a');
    end if;
    insert into public.lynxr_campaigns (client_id, name) values ('selftest-mgr-a', 'A') returning id into ca;
    insert into public.lynxr_campaigns (client_id, name) values ('selftest-mgr-b', 'B') returning id into cb;
    insert into public.lynxr_campaign_formats (campaign_id, source_url)
      values (cb, 'https://www.tiktok.com/@selftest/video/2') returning id into fb;
    insert into public.lynxr_agency_briefs (client_name, title, doc, source_kind, source_id)
      values ('B', 'B', '{}'::jsonb, 'campaign', cb::text) returning id into ba;
    insert into public.lynxr_agency_briefs (client_name, title, doc, source_kind, source_id)
      values ('L', 'L', '{}'::jsonb, 'brief', 'selftest-legacy') returning id into bl;
    insert into public.lynxr_brief_files (source_kind, source_id, path, name, size)
      values ('brief', 'selftest-legacy', 'brief/selftest-legacy/r/a.png', 'a.png', 1) returning id into fl;
    insert into public.lynxr_roster (email, status, campaign) values
      ('selftest-mgr-acc@example.invalid', 'accepted', 'Selftest Alpha'),
      ('selftest-mgr-left@example.invalid', 'left', 'Selftest Beta');
    if v is not null then
      insert into public.lynxr_roster (email, creator_id, status, campaign, accepted_at)
        values ('selftest-mgr-v@example.invalid', v, 'accepted', 'Someone Else', now());
    end if;

    -- become the manager
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    -- 1. who I am
    j := public.my_roles();
    if not coalesce((j->>'manager')::boolean, false) or coalesce((j->>'staff')::boolean, true)
       or coalesce((j->>'cm')::boolean, true) then
      raise exception 'cm_manager self-test 1: my_roles is %', j;
    end if;
    -- 2. every live client's brand fields, and nothing else
    select count(*) into n from jsonb_array_elements(public.mgr_clients()) e
     where e->>'id' in ('selftest-mgr-a', 'selftest-mgr-b');
    if n <> 2 then raise exception 'cm_manager self-test 2: mgr_clients lists % of the 2 test clients', n; end if;
    select e into j from jsonb_array_elements(public.mgr_clients()) e where e->>'id' = 'selftest-mgr-a';
    if j is null or j ? 'briefs' or (j->'ctx') ? 'activeCreators' or j->'ctx'->>'brand' <> 'Alpha App'
       or j->'ctx'->>'notes' <> 'keep' then
      raise exception 'cm_manager self-test 2b: mgr_clients gives %', j;
    end if;
    select count(*) into n from jsonb_array_elements(public.mgr_clients()) e
     where e->>'id' in ('ingest-queue', 'deleted-clients', 'source-edits');
    if n <> 0 then raise exception 'cm_manager self-test 2c: mgr_clients lists a bookkeeping row'; end if;
    -- 3. every brief of every client, and its formats
    select count(*) into n from public.lynxr_campaigns where id in (ca, cb);
    if n <> 2 then raise exception 'cm_manager self-test 3: a manager sees % of the two briefs (want 2)', n; end if;
    select count(*) into n from public.lynxr_campaign_formats where id = fb;
    if n <> 1 then raise exception 'cm_manager self-test 3b: a manager cannot see a brief''s formats'; end if;
    -- 4. a new brief for any client, recorded as mine
    insert into public.lynxr_campaigns (client_id, name) values ('selftest-mgr-b', 'mine') returning id into cmine;
    if (select cp.created_uid from public.lynxr_campaigns cp where cp.id = cmine) is distinct from u then
      raise exception 'cm_manager self-test 4: a manager''s new brief is not recorded as theirs';
    end if;
    -- 5. not for a client that does not exist, nor on a bookkeeping row
    begin
      insert into public.lynxr_campaigns (client_id, name) values ('selftest-mgr-nowhere', 'x');
      raise exception 'cm_manager self-test 5: a manager made a brief for a client that does not exist';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.lynxr_campaigns (client_id, name) values ('ingest-queue', 'x');
      raise exception 'cm_manager self-test 5b: a manager made a brief on a bookkeeping row';
    exception when insufficient_privilege then null;
    end;
    -- 6. edit someone else's brief and its formats; never move it to a client that does not exist
    update public.lynxr_campaigns set name = 'B2' where id = cb;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'cm_manager self-test 6: a manager could not edit someone else''s brief'; end if;
    update public.lynxr_campaign_formats set internal_note = 'x' where id = fb;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'cm_manager self-test 6b: a manager could not edit a format'; end if;
    begin
      update public.lynxr_campaigns set client_id = 'selftest-mgr-nowhere' where id = cb;
      raise exception 'cm_manager self-test 6c: a manager moved a brief to a client that does not exist';
    exception when insufficient_privilege then null;
    end;
    -- 7. delete only my own brief; created_uid cannot be claimed
    delete from public.lynxr_campaigns where id = ca;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'cm_manager self-test 7: a manager deleted a brief they did not make'; end if;
    update public.lynxr_campaigns set created_uid = u where id = ca;
    if (select cp.created_uid from public.lynxr_campaigns cp where cp.id = ca) is not null then
      raise exception 'cm_manager self-test 7b: a manager claimed a brief by rewriting created_uid';
    end if;
    delete from public.lynxr_campaigns where id = cmine;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'cm_manager self-test 7c: a manager could not delete their own brief'; end if;
    -- 8. files and sends: campaign briefs only, never a legacy picked-video brief
    insert into public.lynxr_brief_files (source_kind, source_id, path, name, size)
      values ('campaign', cb::text, 'campaign/' || cb::text || '/selftest/a.png', 'a.png', 1);
    begin
      insert into public.lynxr_brief_files (source_kind, source_id, path, name, size)
        values ('brief', 'selftest-legacy', 'brief/selftest-legacy/s/b.png', 'b.png', 1);
      raise exception 'cm_manager self-test 8: a manager attached a file to a legacy picked-video brief';
    exception when insufficient_privilege then null;
    end;
    select count(*) into n from public.lynxr_brief_files where id = fl;
    if n <> 0 then raise exception 'cm_manager self-test 8b: a manager reads a legacy brief''s file'; end if;
    select count(*) into n from public.lynxr_agency_briefs where id in (ba, bl);
    if n <> 1 then raise exception 'cm_manager self-test 8c: a manager sees % of a campaign send and a legacy send (want 1)', n; end if;
    begin
      insert into public.lynxr_agency_briefs (client_name, title, doc, source_kind, source_id, sent_by)
        values ('L', 'x', '{}'::jsonb, 'brief', 'selftest-legacy', u);
      raise exception 'cm_manager self-test 8d: a manager recorded a send of a legacy picked-video brief';
    exception when insufficient_privilege then null;
    end;
    if not public.mgr_path('campaign/' || cb::text || '/r/a.png')
       or public.mgr_path('brief/selftest-legacy/r/a.png')
       or public.mgr_path('campaign/' || gen_random_uuid()::text || '/r/a.png') then
      raise exception 'cm_manager self-test 8e: mgr_path answers wrong';
    end if;
    -- 9. deliver to any accepted roster creator, and to nobody else
    if v is not null then
      insert into public.lynxr_agency_deliveries (brief_id, creator_id) values (ba, v);
      update public.lynxr_agency_deliveries set revoked_at = now() where brief_id = ba and creator_id = v;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'cm_manager self-test 9: a manager could not unsend their send'; end if;
      if c is not null then
        begin
          insert into public.lynxr_agency_deliveries (brief_id, creator_id) values (ba, c);
          raise exception 'cm_manager self-test 9b: a manager delivered to someone who is not an accepted roster creator';
        exception when insufficient_privilege then null;
        end;
      end if;
    else
      raise notice 'cm_manager self-test: the delivery checks (9) were skipped: they need one more account that is not staff, a CM, a manager or on the roster';
    end if;
    -- 10. closed to a manager
    foreach t in array array['lynxr_videos', 'lynxr_clients', 'lynxr_staff', 'lynxr_roster', 'lynxr_ops', 'lynxr_costs',
                             'lynxr_sources', 'lynxr_feedback', 'lynxr_cm_roster_log'] loop
      if to_regclass('public.' || t) is not null then
        execute format('select count(*) from public.%I', t) into n;
        if n <> 0 then raise exception 'cm_manager self-test 10: a manager reads % rows of %', n, t; end if;
      end if;
    end loop;
    select count(*) into n from public.lynxr_cm_managers;
    if n <> 1 then raise exception 'cm_manager self-test 10b: a manager reads % manager rows (want only their own)', n; end if;
    -- 11. no client writes, no way up
    begin
      insert into public.lynxr_clients (id, data) values ('selftest-mgr-new', '{}'::jsonb);
      raise exception 'cm_manager self-test 11: a manager added a client';
    exception when insufficient_privilege then null;
    end;
    update public.lynxr_clients set data = '{}'::jsonb where id = 'selftest-mgr-a';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'cm_manager self-test 11b: a manager edited a client record'; end if;
    delete from public.lynxr_clients where id = 'selftest-mgr-a';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'cm_manager self-test 11c: a manager deleted a client'; end if;
    begin
      insert into public.lynxr_staff (id, email) values (u, '');
      raise exception 'cm_manager self-test 11d: a manager made themselves staff';
    exception when insufficient_privilege then null;
    end;
    if coalesce(c, s) is not null then
      begin
        insert into public.lynxr_cm_managers (user_id, email) values (coalesce(c, s), '');
        raise exception 'cm_manager self-test 11e: a manager made someone else a manager';
      exception when insufficient_privilege then null;
      end;
    end if;
    update public.lynxr_cm_managers set email = 'x' where user_id = u;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'cm_manager self-test 11f: a manager rewrote the managers table'; end if;
    delete from public.lynxr_cm_managers where user_id = u;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'cm_manager self-test 11g: a manager removed a manager'; end if;
    update public.lynxr_roster set status = 'accepted', creator_id = u where email = 'selftest-mgr-left@example.invalid';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'cm_manager self-test 11h: a manager wrote the roster table directly'; end if;
    -- 12. CMs: see them all, add one, tick and untick a client, remove one
    if c is not null then
      select count(*) into n from public.lynxr_cms where user_id = c;
      if n <> 1 then raise exception 'cm_manager self-test 12: a manager cannot see a CM'; end if;
      select count(*) into n from public.lynxr_cm_clients where cm_id = c;
      if n <> 1 then raise exception 'cm_manager self-test 12b: a manager cannot see a CM''s clients'; end if;
    end if;
    if x is not null then
      j := public.staff_add_cm(x_email);
      if not coalesce((j->>'ok')::boolean, false) then
        raise exception 'cm_manager self-test 12c: staff_add_cm as a manager answered %', j;
      end if;
      insert into public.lynxr_cm_clients (cm_id, client_id) values (x, 'selftest-mgr-b');
      begin
        insert into public.lynxr_cm_clients (cm_id, client_id) values (x, 'selftest-mgr-nowhere');
        raise exception 'cm_manager self-test 12d: a manager put a CM on a client that does not exist';
      exception when insufficient_privilege then null;
      end;
      delete from public.lynxr_cm_clients where cm_id = x and client_id = 'selftest-mgr-b';
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'cm_manager self-test 12e: a manager could not take a CM off a client'; end if;
      delete from public.lynxr_cms where user_id = x;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'cm_manager self-test 12f: a manager could not remove a CM'; end if;
    end if;
    -- 13. the roster, through the functions only
    j := public.mgr_invite_creator('  SelfTest-Mgr-New@Example.invalid ', '  New   Person ',
                                   ' Selftest Alpha ;selftest alpha, Other ', 'agency note');
    if j->>'result' is distinct from 'invited' then raise exception 'cm_manager self-test 13: %', j; end if;
    j := public.mgr_invite_creator('selftest-mgr-new@example.invalid', '', '', '');
    if j->>'result' is distinct from 'updated' then raise exception 'cm_manager self-test 13b: %', j; end if;
    j := public.mgr_set_brands('selftest-mgr-new@example.invalid', repeat('x', 81));
    if j->>'reason' is distinct from 'too_long' then raise exception 'cm_manager self-test 13c: %', j; end if;
    j := public.mgr_invite_creator('not an email');
    if j->>'reason' is distinct from 'bad_email' then raise exception 'cm_manager self-test 13d: %', j; end if;
    j := public.mgr_invite_creator('selftest-mgr-left@example.invalid', '', 'Selftest Beta', '');
    if j->>'result' is distinct from 'reinvited' or j->>'status' is distinct from 'invited' then
      raise exception 'cm_manager self-test 13e: %', j;
    end if;
    j := public.mgr_remove_creator('selftest-mgr-acc@example.invalid');
    if j->>'reason' is distinct from 'accepted' then raise exception 'cm_manager self-test 13f: %', j; end if;
    j := public.mgr_set_brands('selftest-mgr-acc@example.invalid', '');
    if j->>'result' is distinct from 'updated' then raise exception 'cm_manager self-test 13g: %', j; end if;
    select count(*) into n from jsonb_array_elements(public.mgr_roster()) e where e->>'email' like 'selftest-mgr-%';
    if n < 3 then raise exception 'cm_manager self-test 13h: mgr_roster lists % test rows', n; end if;
    execute 'reset role';
    if not exists (select 1 from public.lynxr_roster r
                    where r.email = 'selftest-mgr-new@example.invalid' and r.campaign = 'Selftest Alpha, Other'
                      and r.display_name = 'New Person' and r.note = 'agency note' and r.status = 'invited'
                      and r.invited_by = u and r.creator_id is null) then
      raise exception 'cm_manager self-test 13i: the new invite row is wrong';
    end if;
    if not exists (select 1 from public.lynxr_roster r
                    where r.email = 'selftest-mgr-left@example.invalid' and r.status = 'invited'
                      and r.left_at is null and r.campaign = 'Selftest Beta') then
      raise exception 'cm_manager self-test 13j: re-inviting someone who left went wrong';
    end if;
    if not exists (select 1 from public.lynxr_roster r
                    where r.email = 'selftest-mgr-acc@example.invalid' and r.status = 'accepted' and r.campaign = '') then
      raise exception 'cm_manager self-test 13k: clearing an accepted creator''s brands went wrong';
    end if;
    select count(*) into n from public.lynxr_cm_roster_log l
     where l.cm_id = u and l.kind in ('mgr_invite', 'mgr_brands', 'mgr_remove');
    if n <> 4 then raise exception 'cm_manager self-test 13l: % manager roster changes logged (want 4)', n; end if;
    execute 'set local role authenticated';
    j := public.mgr_remove_creator('selftest-mgr-new@example.invalid');
    if j->>'result' is distinct from 'removed' then raise exception 'cm_manager self-test 13m: %', j; end if;
    j := public.mgr_remove_creator('selftest-mgr-new@example.invalid');
    if j->>'reason' is distinct from 'gone' then raise exception 'cm_manager self-test 13n: %', j; end if;
    execute 'reset role';

    -- 14. a manager who is also tagged CM: still a manager, nothing lost
    insert into public.lynxr_cms (user_id, email) values (u, 'selftest-mgr@example.invalid');
    execute 'set local role authenticated';
    j := public.my_roles();
    if not coalesce((j->>'manager')::boolean, false) or not coalesce((j->>'cm')::boolean, false) then
      raise exception 'cm_manager self-test 14: my_roles for a manager who is also a CM is %', j;
    end if;
    select count(*) into n from public.lynxr_campaigns where id = cb;
    if n <> 1 then raise exception 'cm_manager self-test 14b: being a CM too took a manager''s view away'; end if;
    execute 'reset role';

    -- 15. a plain creator and a CM get none of it
    foreach w in array array[v, c] loop
      continue when w is null;
      perform set_config('request.jwt.claims', json_build_object('sub', w, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      if coalesce((public.my_roles()->>'manager')::boolean, false)
         or public.mgr_clients() <> '[]'::jsonb or public.mgr_roster() <> '[]'::jsonb
         or public.mgr_invite_creator('selftest-mgr-x@example.invalid')->>'reason' is distinct from 'not_manager'
         or public.mgr_set_brands('selftest-mgr-acc@example.invalid', 'x')->>'reason' is distinct from 'not_manager'
         or public.mgr_remove_creator('selftest-mgr-left@example.invalid')->>'reason' is distinct from 'not_manager'
         or public.staff_add_cm('selftest-mgr-x@example.invalid')->>'reason' is distinct from 'not_staff' then
        raise exception 'cm_manager self-test 15: % got manager answers', w;
      end if;
      select count(*) into n from public.lynxr_campaigns where id = cb;
      if n <> 0 then raise exception 'cm_manager self-test 15b: % reads a brief of a client they are not on', w; end if;
      select count(*) into n from public.lynxr_cms where user_id <> w;
      if n <> 0 then raise exception 'cm_manager self-test 15c: % reads other CMs', w; end if;
      select count(*) into n from public.lynxr_cm_managers;
      if n <> 0 then raise exception 'cm_manager self-test 15d: % reads the managers table', w; end if;
      execute 'reset role';
    end loop;

    -- 16. staff unchanged
    if s is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      select count(*) into n from public.lynxr_campaigns where id in (ca, cb);
      if n <> 2 then raise exception 'cm_manager self-test 16: staff see % of the two briefs (want 2)', n; end if;
      if not coalesce((public.my_roles()->>'staff')::boolean, false) then
        raise exception 'cm_manager self-test 16b: my_roles does not say staff';
      end if;
      j := public.staff_add_cm('selftest-mgr-nobody@example.invalid');
      if j->>'reason' is distinct from 'no_account' then
        raise exception 'cm_manager self-test 16c: staff_add_cm for staff answered %', j;
      end if;
      execute 'reset role';
    end if;

    raise exception 'cm_manager self-test passed' using errcode = 'LX001';
  exception when sqlstate 'LX001' then
    raise notice 'cm_manager self-test passed — rolled back, nothing written';
  end;
end $$;

notify pgrst, 'reload schema';

-- ── Runbook (after Run) ─────────────────────────────────────────────────────────────────────────────────────────
-- Expect the notice "cm_manager self-test passed — rolled back, nothing written" (or SKIPPED with its reason).
--
-- Make someone a manager (the account must exist and be confirmed; run here, in the SQL editor):
--   insert into public.lynxr_cm_managers (user_id, email)
--     select id, lower(email) from auth.users
--      where lower(email) = lower('them@example.com') and email_confirmed_at is not null
--     on conflict (user_id) do nothing;
-- Take it away (instant: every manager policy stops matching on the next request):
--   delete from public.lynxr_cm_managers
--    where user_id = (select id from auth.users where lower(email) = lower('them@example.com'));
--
-- Who is a manager:
--   select g.email, g.added_at, (st.id is not null) as also_staff, (m.user_id is not null) as also_cm
--     from public.lynxr_cm_managers g
--     left join public.lynxr_staff st on st.id = g.user_id
--     left join public.lynxr_cms m on m.user_id = g.user_id
--    order by g.added_at;
--
-- What managers changed on the roster, newest first:
--   select l.made_at, g.email as manager, l.kind, l.email, l.detail
--     from public.lynxr_cm_roster_log l left join public.lynxr_cm_managers g on g.user_id = l.cm_id
--    where l.kind in ('mgr_invite', 'mgr_brands', 'mgr_remove') order by l.made_at desc limit 100;
--
-- Policies in place (expect 29; 25 when lynxr_brief_file_beats is not installed; 3 fewer if storage said NOT created):
--   select tablename, policyname from pg_policies
--    where policyname like 'cm manager %' or policyname like 'brief files: cm manager%' order by 1, 2;
--
-- KILL SWITCH, instant: delete from public.lynxr_cm_managers;
