-- Lynxr — CMs add creators to their own companies (owner, 2026-10-30). Plan: ~/.claude/plans/lynxr-cm-creators.md
--
-- Owner: "allow the CMs to be able to add creators and send briefs so essentially what gawin and i have but only the
-- essential essential things". Sending is already built (supabase/cm_portal.sql: a CM delivers only to ACCEPTED roster
-- creators whose brand label names the brief's company). This file lets a CM put creators on that roster, for their own
-- companies only.
--
--   cm_creators()        the invited and accepted creators of the calling CM's companies, each with the company ids its
--                        label names. cm_roster() (accepted only) is unchanged; the app falls back to it before this
--                        file is run.
--   cm_invite_creator(p_client, p_email, p_name)
--                        invite an email to one of the CM's companies. The DATABASE writes the brand label (that
--                        company's name); the CM never types one. A new email becomes an invited roster row. An email
--                        already on the roster under other brands gets this company APPENDED to its label (one row per
--                        email, as always). Someone who left the roster is refused (staff re-invite them). NOTHING IS
--                        EMAILED: the creator sees the existing in-app popup the next time they open lynxr signed in
--                        with that confirmed email (my_agency() and accept_agency_invite() are unchanged).
--   cm_remove_creator(p_client, p_email)
--                        take the CM's company off a creator: only the label parts naming that company go. The row is
--                        deleted only when it is a pending invite with no brand left; an accepted creator's row is never
--                        deleted, so their seat and other brands stay.
--   lynxr_cm_roster_log  every change a CM made through these (staff read it). The DAILY CAP counts it: 20 invites or
--                        brands added per CM per rolling 24 hours (v_cap below).
--
-- ENFORCED HERE, NOT IN THE INTERFACE. lynxr_roster still has NO CM policy: a CM cannot read, insert, update or delete
-- it directly. These functions are the only way in; each checks is_cm_for() on the company and takes no identity as a
-- parameter (auth.uid() only). Staff policies and the creator-facing functions are untouched.
--
-- Run AFTER supabase/cm_portal.sql. Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent, safe to
-- re-run; re-running cm_portal.sql does not undo it. Order against the push does not matter: before this runs, a CM's
-- Creators screen is read-only and inviting stays with staff.
-- **No real email address, uuid or name anywhere in this file — the repo is public.**

-- ── 0. Prerequisites ─────────────────────────────────────────────────────────────────────────────────────────────
do $$ begin
  if to_regprocedure('public.is_cm_for(text)') is null
     or to_regprocedure('public.lynxr_brand_key(text)') is null
     or to_regprocedure('public.cm_roster()') is null
     or to_regclass('public.lynxr_cm_clients') is null then
    raise exception 'the CM portal is missing — run supabase/cm_portal.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'lynxr_roster' and column_name = 'campaign') then
    raise exception 'lynxr_roster.campaign missing — run supabase/roster_invite_by_email.sql first';
  end if;
end $$;

-- ── 1. What CMs changed on the roster (and what the daily cap counts) ────────────────────────────────────────────
create table if not exists public.lynxr_cm_roster_log (
  id        bigint generated always as identity primary key,
  cm_id     uuid        not null,   -- the CM's auth.uid(); no FK, so the record and the cap outlive a CM's removal
  client_id text        not null,   -- the company they acted for
  email     text        not null,   -- the roster row they changed
  kind      text        not null check (kind in ('invite', 'add_brand', 'remove_brand', 'cancel')),
  made_at   timestamptz not null default now()
);
create index if not exists lynxr_cm_roster_log_cm_idx on public.lynxr_cm_roster_log (cm_id, made_at desc);
alter table public.lynxr_cm_roster_log enable row level security;
revoke all on table public.lynxr_cm_roster_log from anon;
drop policy if exists "staff read cm roster log" on public.lynxr_cm_roster_log;
create policy "staff read cm roster log"
  on public.lynxr_cm_roster_log for select to authenticated using (public.is_staff());
-- No insert, update or delete policy: only the functions below write it, and nobody rewrites history.

-- ── 2. What a CM sees: their companies' invited and accepted creators ────────────────────────────────────────────
-- Same company match as cm_roster() (cm_portal.sql), plus pending invites. A pending invite never carries an account id.
create or replace function public.cm_creators()
returns jsonb language sql stable security definer set search_path = '' as $$
  with mine as (
    select a.client_id,
           public.lynxr_brand_key(c.data->>'company')      as k1,
           public.lynxr_brand_key(c.data->'ctx'->>'brand') as k2
      from public.lynxr_cm_clients a
      join public.lynxr_clients c on c.id = a.client_id
     where a.cm_id = auth.uid()
  ), hits as (
    select r.email, r.creator_id, r.display_name, r.campaign, r.status, r.invited_at, r.accepted_at, m.client_id
      from public.lynxr_roster r
      cross join lateral regexp_split_to_table(r.campaign, '[,;]') as part(label)
      join mine m on public.lynxr_brand_key(part.label) <> ''
                 and public.lynxr_brand_key(part.label) in (m.k1, m.k2)
     where r.status = 'invited' or (r.status = 'accepted' and r.creator_id is not null)
  ), per as (
    select h.email, h.creator_id, h.display_name, h.campaign, h.status, h.invited_at, h.accepted_at,
           jsonb_agg(distinct h.client_id) as client_ids
      from hits h
     group by h.email, h.creator_id, h.display_name, h.campaign, h.status, h.invited_at, h.accepted_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'email', p.email,
           'creator_id', case when p.status = 'accepted' then p.creator_id end,
           'display_name', p.display_name,
           'campaign', p.campaign,
           'status', p.status,
           'invited_at', p.invited_at,
           'accepted_at', p.accepted_at,
           'client_ids', p.client_ids)
         order by p.invited_at desc, p.email), '[]'::jsonb)
    from per p
$$;

-- ── 3. Invite a creator to one of MY companies ───────────────────────────────────────────────────────────────────
-- Answers { ok: true, result: invited | added | already, status } or { ok: false, reason: not_cm | no_brand | bad_email
-- | cap (+ cap) | too_long | left | busy }. The label part written is the company name with commas and semicolons turned
-- into spaces (the separators), which keeps its brand key: "Acme, Inc." is stored as "Acme Inc.", key "acmeinc" both.
create or replace function public.cm_invite_creator(p_client text, p_email text, p_name text default '')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_cap     constant int := 20;   -- invites + brands added, per CM, per rolling 24 hours (plan decision D5)
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_name    text := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 80);
  v_company text;
  v_brand   text;
  v_k1      text;
  v_k2      text;
  v_part    text;
  v_row     public.lynxr_roster%rowtype;
  v_label   text;
  v_used    int;
  n         int;
begin
  if v_uid is null or p_client is null or not public.is_cm_for(p_client) then
    return jsonb_build_object('ok', false, 'reason', 'not_cm');
  end if;
  select btrim(regexp_replace(regexp_replace(coalesce(c.data->>'company', ''), '[,;]+', ' ', 'g'), '\s+', ' ', 'g')),
         btrim(regexp_replace(regexp_replace(coalesce(c.data->'ctx'->>'brand', ''), '[,;]+', ' ', 'g'), '\s+', ' ', 'g')),
         public.lynxr_brand_key(c.data->>'company'),
         public.lynxr_brand_key(c.data->'ctx'->>'brand')
    into v_company, v_brand, v_k1, v_k2
    from public.lynxr_clients c
   where c.id = p_client
     and c.id not in ('ingest-queue', 'deleted-clients', 'source-edits')
     and not exists (select 1 from public.lynxr_clients t
                      where t.id = 'deleted-clients' and coalesce(t.data->'ids', '[]'::jsonb) ? c.id);
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_cm');
  end if;
  v_part := case when public.lynxr_brand_key(v_company) <> '' then v_company else v_brand end;
  if public.lynxr_brand_key(v_part) = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_brand');
  end if;
  if char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_email');
  end if;

  -- One call per CM at a time, so two quick presses cannot both slip under the cap.
  perform pg_advisory_xact_lock(hashtextextended('lynxr.cm_invite.' || v_uid::text, 0));
  select count(*) into v_used from public.lynxr_cm_roster_log l
   where l.cm_id = v_uid and l.kind in ('invite', 'add_brand') and l.made_at > now() - interval '24 hours';

  select r.* into v_row from public.lynxr_roster r where r.email = v_email for update;
  if not found then
    if v_used >= v_cap then
      return jsonb_build_object('ok', false, 'reason', 'cap', 'cap', v_cap);
    end if;
    if char_length(v_part) > 80 then
      return jsonb_build_object('ok', false, 'reason', 'too_long');
    end if;
    insert into public.lynxr_roster (email, display_name, campaign, invited_by)
    values (v_email, v_name, v_part, v_uid)
    on conflict (email) do nothing;
    get diagnostics n = row_count;
    if n = 0 then   -- someone made this row a moment ago
      return jsonb_build_object('ok', false, 'reason', 'busy');
    end if;
    insert into public.lynxr_cm_roster_log (cm_id, client_id, email, kind) values (v_uid, p_client, v_email, 'invite');
    return jsonb_build_object('ok', true, 'result', 'invited', 'status', 'invited');
  end if;

  if v_row.status = 'left' then
    return jsonb_build_object('ok', false, 'reason', 'left');
  end if;
  if exists (select 1 from regexp_split_to_table(v_row.campaign, '[,;]') as part(label)
              where public.lynxr_brand_key(part.label) <> ''
                and public.lynxr_brand_key(part.label) in (v_k1, v_k2)) then
    return jsonb_build_object('ok', true, 'result', 'already', 'status', v_row.status);
  end if;
  if v_used >= v_cap then
    return jsonb_build_object('ok', false, 'reason', 'cap', 'cap', v_cap);
  end if;
  v_label := case when btrim(v_row.campaign) = '' then v_part else btrim(v_row.campaign) || ', ' || v_part end;
  if char_length(v_label) > 80 then
    return jsonb_build_object('ok', false, 'reason', 'too_long');
  end if;
  update public.lynxr_roster set campaign = v_label where email = v_email;   -- display_name, note, status untouched
  insert into public.lynxr_cm_roster_log (cm_id, client_id, email, kind) values (v_uid, p_client, v_email, 'add_brand');
  return jsonb_build_object('ok', true, 'result', 'added', 'status', v_row.status);
end;
$$;

-- ── 4. Take MY company off a creator ─────────────────────────────────────────────────────────────────────────────
-- Answers { ok: true, result: cancelled | removed, status } or { ok: false, reason: not_cm | gone | not_yours }.
-- Only the label parts whose brand key is this company's go; the others are kept, tidied, in their order.
create or replace function public.cm_remove_creator(p_client text, p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_k1    text;
  v_k2    text;
  v_row   public.lynxr_roster%rowtype;
  v_hit   boolean;
  v_label text;
begin
  if v_uid is null or p_client is null or not public.is_cm_for(p_client) then
    return jsonb_build_object('ok', false, 'reason', 'not_cm');
  end if;
  select public.lynxr_brand_key(c.data->>'company'), public.lynxr_brand_key(c.data->'ctx'->>'brand')
    into v_k1, v_k2
    from public.lynxr_clients c where c.id = p_client;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_cm');
  end if;
  select r.* into v_row from public.lynxr_roster r where r.email = v_email for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;
  select bool_or(public.lynxr_brand_key(p.label) <> '' and public.lynxr_brand_key(p.label) in (v_k1, v_k2)),
         coalesce(string_agg(btrim(regexp_replace(p.label, '\s+', ' ', 'g')), ', ' order by p.ord)
                    filter (where public.lynxr_brand_key(p.label) <> ''
                              and public.lynxr_brand_key(p.label) not in (v_k1, v_k2)), '')
    into v_hit, v_label
    from regexp_split_to_table(v_row.campaign, '[,;]') with ordinality as p(label, ord);
  if not coalesce(v_hit, false) then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;
  if v_row.status = 'invited' and v_label = '' then
    delete from public.lynxr_roster where email = v_email;
    insert into public.lynxr_cm_roster_log (cm_id, client_id, email, kind) values (v_uid, p_client, v_email, 'cancel');
    return jsonb_build_object('ok', true, 'result', 'cancelled', 'status', 'invited');
  end if;
  update public.lynxr_roster set campaign = v_label where email = v_email;   -- an accepted row is never deleted here
  insert into public.lynxr_cm_roster_log (cm_id, client_id, email, kind) values (v_uid, p_client, v_email, 'remove_brand');
  return jsonb_build_object('ok', true, 'result', 'removed', 'status', v_row.status);
end;
$$;

revoke all on function public.cm_creators()                         from public, anon;
revoke all on function public.cm_invite_creator(text, text, text)   from public, anon;
revoke all on function public.cm_remove_creator(text, text)         from public, anon;
grant execute on function public.cm_creators()                      to authenticated;
grant execute on function public.cm_invite_creator(text, text, text) to authenticated;
grant execute on function public.cm_remove_creator(text, text)      to authenticated;

-- ── 5. SELF-TEST. Runs every time this file is run and WRITES NOTHING: it stands a real non-staff account in as a CM
--      (and, when it can, one more as a plain creator and one more as an accepted roster creator), checks every rule,
--      then raises LX001, which rolls back everything it did; the handler turns that into a NOTICE. Any wrong answer
--      raises a real error instead, and the whole file is rolled back — fix before re-running. ───────────────────────
do $$
declare
  u uuid; v uuid; w uuid;
  j jsonb; n int;
begin
  select x.id into u from auth.users x
   where x.id not in (select st.id from public.lynxr_staff st)
     and x.id not in (select m.user_id from public.lynxr_cms m)
   order by x.created_at limit 1;
  if u is null then
    raise notice 'cm_creators self-test SKIPPED: no account that is neither staff nor a CM to stand in for one';
    return;
  end if;
  select x.id into v from auth.users x
   where x.id not in (select st.id from public.lynxr_staff st)
     and x.id not in (select m.user_id from public.lynxr_cms m)
     and x.id <> u
   order by x.created_at limit 1;
  select x.id into w from auth.users x
   where x.id not in (select st.id from public.lynxr_staff st)
     and x.id not in (select m.user_id from public.lynxr_cms m)
     and x.id not in (select r.creator_id from public.lynxr_roster r where r.creator_id is not null)
     and x.id <> u and x.id is distinct from v
   order by x.created_at limit 1;

  begin
    -- the world, written as the SQL editor's own role
    insert into public.lynxr_clients (id, data) values
      ('selftest-cmc-a', '{"company":"Selftest Alpha","ctx":{"brand":"Alpha App"}}'::jsonb),
      ('selftest-cmc-b', '{"company":"Selftest Beta","ctx":{}}'::jsonb),
      ('selftest-cmc-c', '{"company":"Selftest, Gamma","ctx":{}}'::jsonb);
    insert into public.lynxr_cms (user_id, email) values (u, 'selftest@example.invalid');
    insert into public.lynxr_cm_clients (cm_id, client_id) values (u, 'selftest-cmc-a'), (u, 'selftest-cmc-c');
    insert into public.lynxr_roster (email, display_name, campaign, status) values
      ('selftest-b1@example.invalid', 'Staff Name', 'Selftest Beta', 'invited'),
      ('selftest-ab@example.invalid', '', 'Selftest Beta, Alpha App', 'invited'),
      ('selftest-left@example.invalid', '', 'Selftest Beta', 'left');
    if w is not null then
      insert into public.lynxr_roster (email, creator_id, status, campaign, accepted_at)
        values ('selftest-w@example.invalid', w, 'accepted', 'Selftest Beta', now());
    end if;

    -- become the CM
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    -- 1. a CM sees their companies' creators (here: one pending invite, via the brand name) and nothing else
    j := public.cm_creators();
    if jsonb_array_length(j) <> 1 or j->0->>'email' <> 'selftest-ab@example.invalid' or j->0->>'status' <> 'invited'
       or j->0->'client_ids' <> '["selftest-cmc-a"]'::jsonb or (j->0->>'creator_id') is not null then
      raise exception 'cm_creators self-test 1: cm_creators is %', j;
    end if;

    -- 2. a new address on my company: invited, lowercased, labelled by the database
    j := public.cm_invite_creator('selftest-cmc-a', '  SelfTest-New@Example.invalid ', '  New   Person ');
    if j->>'result' is distinct from 'invited' then raise exception 'cm_creators self-test 2: %', j; end if;
    -- 3. a company I am not on: refused
    j := public.cm_invite_creator('selftest-cmc-b', 'selftest-x@example.invalid', '');
    if j->>'reason' is distinct from 'not_cm' then raise exception 'cm_creators self-test 3: %', j; end if;
    -- 4. another brand's pending invite: my company is appended; nothing else changes
    j := public.cm_invite_creator('selftest-cmc-a', 'selftest-b1@example.invalid', 'Not This');
    if j->>'result' is distinct from 'added' or j->>'status' is distinct from 'invited' then
      raise exception 'cm_creators self-test 4: %', j;
    end if;

    execute 'reset role';
    if not exists (select 1 from public.lynxr_roster r
                    where r.email = 'selftest-new@example.invalid' and r.campaign = 'Selftest Alpha'
                      and r.display_name = 'New Person' and r.status = 'invited' and r.invited_by = u
                      and r.creator_id is null) then
      raise exception 'cm_creators self-test 2b: the new invite row is wrong';
    end if;
    if exists (select 1 from public.lynxr_roster r where r.email = 'selftest-x@example.invalid') then
      raise exception 'cm_creators self-test 3b: a refused invite still made a row';
    end if;
    if not exists (select 1 from public.lynxr_roster r
                    where r.email = 'selftest-b1@example.invalid' and r.campaign = 'Selftest Beta, Selftest Alpha'
                      and r.display_name = 'Staff Name' and r.status = 'invited') then
      raise exception 'cm_creators self-test 4b: the appended label (or the untouched name) is wrong';
    end if;
    execute 'set local role authenticated';

    -- 5. already there, by company name and by brand name: nothing changes, nothing is counted
    j := public.cm_invite_creator('selftest-cmc-a', 'selftest-b1@example.invalid', '');
    if j->>'result' is distinct from 'already' then raise exception 'cm_creators self-test 5: %', j; end if;
    j := public.cm_invite_creator('selftest-cmc-a', 'selftest-ab@example.invalid', '');
    if j->>'result' is distinct from 'already' then raise exception 'cm_creators self-test 5b: %', j; end if;
    -- 6. someone who left: refused; a malformed address: refused
    j := public.cm_invite_creator('selftest-cmc-a', 'selftest-left@example.invalid', '');
    if j->>'reason' is distinct from 'left' then raise exception 'cm_creators self-test 6: %', j; end if;
    j := public.cm_invite_creator('selftest-cmc-a', 'not an email', '');
    if j->>'reason' is distinct from 'bad_email' then raise exception 'cm_creators self-test 6b: %', j; end if;
    -- 7. a company name with a comma is stored without it, and still matches as one brand
    j := public.cm_invite_creator('selftest-cmc-c', 'selftest-g@example.invalid', '');
    if j->>'result' is distinct from 'invited' then raise exception 'cm_creators self-test 7: %', j; end if;
    select count(*) into n from jsonb_array_elements(public.cm_creators()) e
     where e->>'email' = 'selftest-g@example.invalid' and e->'client_ids' = '["selftest-cmc-c"]'::jsonb;
    if n <> 1 then raise exception 'cm_creators self-test 7b: the comma company''s creator is not listed under it'; end if;

    -- 8. taking my company off
    j := public.cm_remove_creator('selftest-cmc-b', 'selftest-b1@example.invalid');
    if j->>'reason' is distinct from 'not_cm' then raise exception 'cm_creators self-test 8: %', j; end if;
    j := public.cm_remove_creator('selftest-cmc-a', 'selftest-left@example.invalid');
    if j->>'reason' is distinct from 'not_yours' then raise exception 'cm_creators self-test 8b: %', j; end if;
    j := public.cm_remove_creator('selftest-cmc-a', 'selftest-b1@example.invalid');
    if j->>'result' is distinct from 'removed' then raise exception 'cm_creators self-test 8c: %', j; end if;
    j := public.cm_remove_creator('selftest-cmc-a', 'selftest-b1@example.invalid');
    if j->>'reason' is distinct from 'not_yours' then raise exception 'cm_creators self-test 8d: %', j; end if;
    j := public.cm_remove_creator('selftest-cmc-a', 'selftest-ab@example.invalid');
    if j->>'result' is distinct from 'removed' then raise exception 'cm_creators self-test 8e: %', j; end if;
    j := public.cm_remove_creator('selftest-cmc-a', 'selftest-new@example.invalid');
    if j->>'result' is distinct from 'cancelled' then raise exception 'cm_creators self-test 8f: %', j; end if;
    j := public.cm_remove_creator('selftest-cmc-a', 'selftest-nobody@example.invalid');
    if j->>'reason' is distinct from 'gone' then raise exception 'cm_creators self-test 8g: %', j; end if;

    -- 9. an accepted creator on another brand: added (and offered for sending), then taken off; never deleted
    if w is not null then
      j := public.cm_invite_creator('selftest-cmc-a', 'selftest-w@example.invalid', '');
      if j->>'result' is distinct from 'added' or j->>'status' is distinct from 'accepted' then
        raise exception 'cm_creators self-test 9: %', j;
      end if;
      select count(*) into n from jsonb_array_elements(public.cm_roster()) e
       where e->>'creator_id' = w::text and e->'client_ids' = '["selftest-cmc-a"]'::jsonb;
      if n <> 1 then raise exception 'cm_creators self-test 9b: the accepted creator is not offered for sending'; end if;
      j := public.cm_remove_creator('selftest-cmc-a', 'selftest-w@example.invalid');
      if j->>'result' is distinct from 'removed' or j->>'status' is distinct from 'accepted' then
        raise exception 'cm_creators self-test 9c: %', j;
      end if;
    else
      raise notice 'cm_creators self-test: the accepted-creator checks (9, 12) were skipped: they need one more account that is not staff, not a CM and not on the roster';
    end if;

    -- 10. the roster and the log stay closed to a CM except through the functions
    select count(*) into n from public.lynxr_roster;
    if n <> 0 then raise exception 'cm_creators self-test 10: a CM reads % roster rows', n; end if;
    select count(*) into n from public.lynxr_cm_roster_log;
    if n <> 0 then raise exception 'cm_creators self-test 10b: a CM reads % log rows', n; end if;
    begin
      update public.lynxr_roster set campaign = 'hijacked' where email like 'selftest-%';
      get diagnostics n = row_count;
      if n <> 0 then raise exception 'cm_creators self-test 10c: a CM relabelled % roster rows directly', n; end if;
    exception when insufficient_privilege then null;
    end;
    begin
      delete from public.lynxr_roster where email like 'selftest-%';
      get diagnostics n = row_count;
      if n <> 0 then raise exception 'cm_creators self-test 10d: a CM deleted % roster rows directly', n; end if;
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.lynxr_roster (email, campaign) values ('selftest-direct@example.invalid', 'Selftest Alpha');
      raise exception 'cm_creators self-test 10e: a CM inserted a roster row directly';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.lynxr_cm_roster_log (cm_id, client_id, email, kind)
        values (u, 'selftest-cmc-a', 'selftest-direct@example.invalid', 'cancel');
      raise exception 'cm_creators self-test 10f: a CM wrote the log directly';
    exception when insufficient_privilege then null;
    end;
    execute 'reset role';

    -- 11. what the database holds now (read as the editor)
    if exists (select 1 from public.lynxr_roster r where r.email = 'selftest-new@example.invalid') then
      raise exception 'cm_creators self-test 11: the cancelled invite is still there';
    end if;
    if not exists (select 1 from public.lynxr_roster r
                    where r.email = 'selftest-b1@example.invalid' and r.campaign = 'Selftest Beta'
                      and r.display_name = 'Staff Name' and r.status = 'invited') then
      raise exception 'cm_creators self-test 11b: removing my company did not keep the other brand';
    end if;
    if not exists (select 1 from public.lynxr_roster r
                    where r.email = 'selftest-ab@example.invalid' and r.campaign = 'Selftest Beta' and r.status = 'invited') then
      raise exception 'cm_creators self-test 11c: removing by brand name went wrong';
    end if;
    if not exists (select 1 from public.lynxr_roster r
                    where r.email = 'selftest-g@example.invalid' and r.campaign = 'Selftest Gamma') then
      raise exception 'cm_creators self-test 11d: the comma company was not stored without its comma';
    end if;
    if not exists (select 1 from public.lynxr_roster r
                    where r.email = 'selftest-left@example.invalid' and r.campaign = 'Selftest Beta' and r.status = 'left') then
      raise exception 'cm_creators self-test 11e: a refused call changed someone who left';
    end if;
    select count(*) into n from public.lynxr_cm_roster_log l
     where l.cm_id = u and l.client_id like 'selftest-cmc-%' and l.kind = 'cancel';
    if n <> 1 then raise exception 'cm_creators self-test 11f: % cancels logged (want 1)', n; end if;

    -- 12. an accepted creator whose only brand is mine: taken off, the row stays (accepted, no brand)
    if w is not null then
      if not exists (select 1 from public.lynxr_roster r
                      where r.email = 'selftest-w@example.invalid' and r.campaign = 'Selftest Beta' and r.status = 'accepted') then
        raise exception 'cm_creators self-test 12: the accepted creator''s other brand was not kept';
      end if;
      update public.lynxr_roster set campaign = 'Selftest Alpha' where email = 'selftest-w@example.invalid';
      perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      j := public.cm_remove_creator('selftest-cmc-a', 'selftest-w@example.invalid');
      if j->>'result' is distinct from 'removed' then raise exception 'cm_creators self-test 12b: %', j; end if;
      execute 'reset role';
      if not exists (select 1 from public.lynxr_roster r
                      where r.email = 'selftest-w@example.invalid' and r.campaign = '' and r.status = 'accepted'
                        and r.creator_id = w) then
        raise exception 'cm_creators self-test 12c: an accepted creator''s row was deleted or changed';
      end if;
    end if;

    -- 13. the daily cap: fill this CM's last 24 hours to 20, then one more is refused; older entries do not count
    select count(*) into n from public.lynxr_cm_roster_log l
     where l.cm_id = u and l.kind in ('invite', 'add_brand') and l.made_at > now() - interval '24 hours';
    insert into public.lynxr_cm_roster_log (cm_id, client_id, email, kind)
      select u, 'selftest-cmc-a', 'selftest-cap@example.invalid', 'invite' from generate_series(1, 20 - n);
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    j := public.cm_invite_creator('selftest-cmc-a', 'selftest-over@example.invalid', '');
    if j->>'reason' is distinct from 'cap' or (j->>'cap')::int <> 20 then
      raise exception 'cm_creators self-test 13: the 21st invite in 24 hours was not refused: %', j;
    end if;
    j := public.cm_invite_creator('selftest-cmc-c', 'selftest-g@example.invalid', '');
    if j->>'result' is distinct from 'already' then
      raise exception 'cm_creators self-test 13b: "already there" was blocked by the cap: %', j;
    end if;
    execute 'reset role';
    update public.lynxr_cm_roster_log set made_at = now() - interval '25 hours' where cm_id = u;
    execute 'set local role authenticated';
    j := public.cm_invite_creator('selftest-cmc-a', 'selftest-over@example.invalid', '');
    if j->>'result' is distinct from 'invited' then
      raise exception 'cm_creators self-test 13c: entries older than 24 hours still counted: %', j;
    end if;
    execute 'reset role';

    -- 14. a plain creator gets nothing from any of it
    if v is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      if public.cm_creators() <> '[]'::jsonb
         or public.cm_invite_creator('selftest-cmc-a', 'selftest-v@example.invalid', '')->>'reason' is distinct from 'not_cm'
         or public.cm_remove_creator('selftest-cmc-a', 'selftest-g@example.invalid')->>'reason' is distinct from 'not_cm' then
        raise exception 'cm_creators self-test 14: an account that is not a CM got CM answers';
      end if;
      execute 'reset role';
    end if;

    raise exception 'cm_creators self-test passed' using errcode = 'LX001';
  exception when sqlstate 'LX001' then
    raise notice 'cm_creators self-test passed — rolled back, nothing written';
  end;
end $$;

notify pgrst, 'reload schema';

-- ── Runbook (after Run) ─────────────────────────────────────────────────────────────────────────────────────────
-- Expect the notice "cm_creators self-test passed — rolled back, nothing written" (or SKIPPED with its reason).
--
-- What CMs changed on the roster, newest first:
--   select l.made_at, m.email as cm, l.kind, l.email, c.data->>'company' as company
--     from public.lynxr_cm_roster_log l
--     left join public.lynxr_cms m on m.user_id = l.cm_id
--     left join public.lynxr_clients c on c.id = l.client_id
--    order by l.made_at desc limit 100;
--
-- Change the daily cap: edit v_cap in cm_invite_creator() above (and CM_CREW_CAP in app.js, which only words the
-- refusal), then re-run this file.
--
-- KILL SWITCH for CM inviting only (CMs keep building and sending briefs; re-running this file undoes it):
--   revoke execute on function public.cm_invite_creator(text, text, text) from authenticated;
-- The whole CM role, instantly: delete from public.lynxr_cms;
