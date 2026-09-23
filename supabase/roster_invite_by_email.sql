-- Invite a creator by EMAIL, no join code (owner, 2026-09-23: "i send the invite
-- through their email they used and then when they sign in or load up lynxr they
-- get a popup"). Plan: ~/.claude/plans/roster-invite-by-email.md.
--
-- Dashboard → SQL Editor → New query → paste → Run. Standalone, idempotent.
-- Run AFTER supabase/agency_roster.sql — and again after it if that file is ever
-- re-run, because it would put the old my_agency() back.
-- **No real email address or uuid anywhere in this file — the repo is public.**
--
-- WHAT CHANGES
--   1. lynxr_roster.campaign — an optional, CREATOR-FACING label staff type on
--      the invite ("Cloey"). The creator's popup reads "Lynx Media Group invited
--      you to the Cloey campaign."
--   2. my_agency() returns it, and matches a not-yet-accepted row by email only
--      when that address is confirmed.
--   3. accept_agency_invite() takes NO code: it accepts the invited row whose
--      email is the signed-in account's own confirmed email. The code-taking
--      accept_agency_invite(text) is dropped. The `code` column stays, unused,
--      so nothing that reads the table breaks.
--   4. roster_accounts() — STAFF ONLY: for each roster email not yet accepted,
--      whether a lynxr account exists and whether it is confirmed, so the
--      Creators tab can say "no lynxr account with this email yet".
--
-- WHY AN EMAIL MATCH IS ENOUGH — AND THE ONE SETTING IT RESTS ON
-- The 2026-09-22 design asked for a code on the belief that autoconfirm was on.
-- Checked 2026-09-23: /auth/v1/settings reports mailer_autoconfirm = false, so
-- a password account cannot sign in until it has confirmed its inbox, and
-- Google sign-in carries Google's own verified email. The signed-in email IS
-- proof of the inbox. The functions below also require
-- auth.users.email_confirmed_at, but that does NOT survive the setting being
-- turned off: with "Confirm email" off, Supabase stamps email_confirmed_at at
-- signup, and anyone could sign up as an invited address and take the seat
-- (and every brief sent to it). KEEP "Confirm email" ON in Supabase Auth's
-- email provider settings. supabase/invites.sql says autoconfirm "can stay
-- on" — that was written for signup invites and is WRONG for the roster.

do $$ begin
  if to_regclass('public.lynxr_roster') is null then
    raise exception 'lynxr_roster missing — run supabase/agency_roster.sql first';
  end if;
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. THE CAMPAIGN LABEL
-- ---------------------------------------------------------------------------
-- Creator-facing, unlike display_name and note, which never leave the agency.
-- 80 characters is a long client name with room to spare; the app caps it too.
alter table public.lynxr_roster
  add column if not exists campaign text not null default ''
    check (char_length(campaign) <= 80);

comment on column public.lynxr_roster.campaign is
  'CREATOR-FACING. Optional label staff type on the invite; my_agency() returns it and the creator app shows "invited you to the <campaign> campaign".';
comment on column public.lynxr_roster.code is
  'UNUSED since 2026-09-23 (roster_invite_by_email.sql): accept is keyed on the confirmed email. Kept so older reads do not break.';

-- ---------------------------------------------------------------------------
-- 2. my_agency() — same as agency_roster.sql's, plus `campaign`, plus the
--    confirmed-email condition on the by-email match.
-- ---------------------------------------------------------------------------
create or replace function public.my_agency()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text;
  v_confirmed boolean := false;
  v_row       public.lynxr_roster%rowtype;
  v_state     text;
  v_briefs    jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('state', 'none', 'briefs', '[]'::jsonb);
  end if;

  -- The auth.users row, lowercased — the same lookup accept_agency_invite()
  -- uses. Not the JWT's email claim, which can lag an email change.
  select lower(u.email), (u.email_confirmed_at is not null)
    into v_email, v_confirmed
    from auth.users u where u.id = v_uid;

  select r.* into v_row
    from public.lynxr_roster r
   where r.creator_id = v_uid
      or (coalesce(v_confirmed, false) and r.creator_id is null and r.email = v_email)
   order by (r.creator_id = v_uid) desc nulls last
   limit 1;

  if not found then
    return jsonb_build_object('state', 'none', 'briefs', '[]'::jsonb);
  end if;

  v_state := v_row.status;

  if v_state = 'accepted' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', b.id,
             'title', b.title,
             'client_name', b.client_name,
             'sent_at', d.sent_at,
             'formats', coalesce(jsonb_array_length(b.doc->'formats'), 0)
           ) order by d.sent_at desc), '[]'::jsonb)
      into v_briefs
      from public.lynxr_agency_deliveries d
      join public.lynxr_agency_briefs b on b.id = d.brief_id
     where d.creator_id = v_uid and d.revoked_at is null;
  else
    v_briefs := '[]'::jsonb;
  end if;

  return jsonb_build_object('state', v_state, 'briefs', v_briefs, 'campaign', v_row.campaign);
end;
$$;

revoke all on function public.my_agency() from public, anon;
grant execute on function public.my_agency() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. accept_agency_invite() — no argument. Accepts the signed-in account's
--    own invite, found by its own confirmed email. Nothing to guess, so
--    nothing to brute-force: an account can only ever reach the row
--    addressed to it.
-- ---------------------------------------------------------------------------
drop function if exists public.accept_agency_invite(text);
drop function if exists public.accept_agency_invite();
create or replace function public.accept_agency_invite()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text;
  v_confirmed boolean := false;
  n           int;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  select lower(u.email), (u.email_confirmed_at is not null)
    into v_email, v_confirmed
    from auth.users u where u.id = v_uid;
  if v_email is null or v_email = '' or not coalesce(v_confirmed, false) then
    return jsonb_build_object('ok', false);
  end if;

  -- Already accepted under this address: a second tab or a double press.
  if exists (
    select 1 from public.lynxr_roster
     where creator_id = v_uid and email = v_email and status = 'accepted'
  ) then
    return jsonb_build_object('ok', true);
  end if;

  -- One account, one seat (decision 3) — pre-checked so the unique index
  -- never has to raise.
  if exists (
    select 1 from public.lynxr_roster
     where creator_id = v_uid and email <> v_email
  ) then
    return jsonb_build_object('ok', false);
  end if;

  update public.lynxr_roster
     set creator_id = v_uid, status = 'accepted', accepted_at = now(), left_at = null
   where email = v_email
     and (creator_id is null or creator_id = v_uid)
     and status = 'invited';

  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0);
end;
$$;

revoke all on function public.accept_agency_invite() from public, anon;
grant execute on function public.accept_agency_invite() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. roster_accounts() — STAFF ONLY. Returns nothing at all to anyone else.
--    Staff can already see auth.users in the dashboard; this only puts the
--    same yes/no on the Creators tab, and only for addresses on the roster.
-- ---------------------------------------------------------------------------
drop function if exists public.roster_accounts();
create or replace function public.roster_accounts()
returns table (email text, has_account boolean, confirmed boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select r.email,
         exists (select 1 from auth.users u where lower(u.email) = r.email),
         exists (select 1 from auth.users u
                  where lower(u.email) = r.email and u.email_confirmed_at is not null)
    from public.lynxr_roster r
   where public.is_staff()
     and r.status <> 'accepted'
   order by r.invited_at desc;
$$;

revoke all on function public.roster_accounts() from public, anon;
grant execute on function public.roster_accounts() to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- CHECKS — read-only, run after the file.
--   select oid::regprocedure from pg_proc
--    where pronamespace = 'public'::regnamespace and proname = 'accept_agency_invite';
--     -- expect exactly one row: accept_agency_invite()
--   select column_name, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'lynxr_roster' and column_name = 'campaign';
--     -- expect one row, default ''::text
--
-- Invite someone by hand (the Creators tab does this; never paste a real address into this file):
--   insert into public.lynxr_roster (email, display_name, campaign, invited_by)
--   values (lower('them@example.com'), 'Their name', 'Cloey', auth.uid())
--   on conflict (email) do update set campaign = excluded.campaign;
--
-- PROOF — an account cannot accept an invite addressed to someone else. Rolled back.
-- <OTHER-CREATOR-UUID> is any real auth.users id whose email is NOT probe-invite@example.com.
--   begin;
--     insert into public.lynxr_roster (email, campaign) values ('probe-invite@example.com', 'Probe');
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<OTHER-CREATOR-UUID>","role":"authenticated"}';
--     select public.accept_agency_invite();   -- expect {"ok": false}
--     select public.my_agency();              -- expect that account's own state; campaign never "Probe"
--     select * from public.roster_accounts(); -- expect 0 rows (not staff)
--   rollback;
-- The same block with a STAFF uuid as sub: roster_accounts() lists
-- probe-invite@example.com with has_account = false, confirmed = false.
