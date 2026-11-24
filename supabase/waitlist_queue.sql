-- Lynxr — the public waitlist as a queue: private position links, referral links worth 10 places, a staff
-- "release the next 100" button, and a sign-up gate that still lets Lynx Media Group campaign creators in.
-- Plan: ~/.claude/plans/waitlist-referral-queue.md (owner, 2026-11-20); revised by ~/.claude/plans/waitlist-no-confirm.md
-- (owner, 2026-11-21): NO EMAIL CONFIRMATION. Everyone is in line from the moment they join, they get one welcome email
-- with the link to their place, and a friend's join counts for the referrer at once (see THE MOVE).
-- Dashboard → SQL Editor → New query → paste this whole file → Run. Standalone, idempotent, safe to re-run over the live
-- install: the first run after the 2026-11-21 revision also runs the one-time switch (section 1i4) that puts every
-- never-confirmed entry in line at its original place and credits their referrers, once.
-- Needs, already applied live: staff_gate.sql, signup_gate.sql, invites.sql, agency_roster.sql, schema.sql's
-- lynxr_waitlist plus waitlist_consent.sql, waitlist_unsubscribe.sql and write_guards.sql.
-- **No real email address, invite code or uuid anywhere in this file — the repo is public.**
--
-- WHAT RUNNING THIS DOES TO SIGN-UP: NOTHING. It installs the queue and a new gate function, but
-- lynxr_signup_gate.require_invite is NOT flipped here. Public sign-up closes only when you run, after the new
-- front end is live (plan step 20):
--     update public.lynxr_signup_gate set require_invite = true where id = 1;
--
-- WHAT IT BUILDS
--   lynxr_waitlist            gains the queue columns. Every existing row is backfilled (legacy = true, counted as
--                             confirmed — decision D6; one commented line below flips that) and the table is LOCKED to
--                             the server: no browser, signed in or not, can insert, update, delete or read the
--                             tokens. The Edge Function supabase/functions/waitlist (service role) is the only writer.
--                             (2026-11-21) also seen_at (first time the private link was opened), credit + credited_at
--                             (what this friend's join did for their referrer) and display_name (the invite name).
--                             confirmed_at stays as the "in line since" time: release, positions and stats key on it.
--   lynxr_waitlist_settings   one row: batch_size (100), places per referral (10), max_credits per person (20), and
--                             (2026-11-21) credit_when ('join' | 'open'), credit_day (0 = no limit), no_credit_domains.
--                             Change by SQL, no deploy:  update public.lynxr_waitlist_settings set places = 5;
--   lynxr_waitlist_meter      per-visitor and global counters (a hashed IP, never the IP) for the function's limits
--                             and the daily cap on waitlist email.
--   the queue functions       waitlist_join / waitlist_spot / waitlist_credit / waitlist_mail_info /
--                             waitlist_mark_mailed / waitlist_stop / waitlist_release / waitlist_unmailed /
--                             waitlist_let_in, all service_role only, plus staff_waitlist_stats() for the agency app.
--   the gate                  lynxr_signup_verdict() + a rewritten enforce_signup_gate() (same trigger on auth.users).
--   the community layer       (plan ~/.claude/plans/waitlist-beli-referrals.md, owner 2026-11-20)
--     lynxr_members           one row per account: its personal ?gift= code, a hand-set bonus, the founding-creator title.
--     lynxr_gift_claims       one row per friend inbox that claimed a gift: who gave it, pending / redeemed, mail throttle.
--     lynxr_crew              the referral graph: one edge per (friend, how) keyed on folded emails, filled in with account
--                             ids as soon as either side has an account. The future friend graph (kudos) reads it.
--     my_gifts()              the ONE new function a signed-in creator may call: counts only, never a friend's address.
--     waitlist_gift_peek / waitlist_gift_claim / waitlist_gift_mark / lynxr_gift_prune / lynxr_link_account /
--     lynxr_wl_crew / lynxr_wl_title_check    server-only (service_role), called by the Edge Function and the trigger.
--     lynxr_after_signup      a NEW trigger on auth.users (AFTER INSERT): links a new account to its gift claim, its crew
--                             edges and its waitlist title. Wrapped so it can never block a sign-up.
--     four new columns on lynxr_waitlist_settings: gifts (3), gift_day (100), title_crew (3), discord_url (null).
--   no-confirmation layer     (plan ~/.claude/plans/waitlist-no-confirm.md, owner 2026-11-21), section 1i3 / 1i4
--     lynxr_wl_credit_friend  decides ONCE what one friend's join does for their referrer, records it on the friend's row
--     lynxr_wl_uncredit       moves a referrer back (used by waitlist_strip)
--     waitlist_strip          the staff tool: take back the credits of friends who never opened their email (SQL editor)
--     waitlist_set_name / waitlist_ref_name   the optional invite name ("Maya is inviting you to lynxr")
--     lynxr_wl_from_confirm   the one-time switch from "confirm to count" to "join to count" (run once, section 1i4)
--
-- THE MOVE ("a friend joins with your link, you go up 10 places"). Exactly `places` positions, applied when the
-- friend JOINS (owner, 2026-11-21; it was "when the friend confirms" until then), never above #1, and at most
-- `max_credits` friends per person. Guards, none of which adds a step for a real person: the Edge Function's join
-- meter (5 an hour, 20 a day per connection) and its per-link limit (WL_CREDIT_IP_DAY, 3 credited joins per friend's
-- link per connection per day), inbox folding (Gmail dots and +tags, and + on Outlook/iCloud/Proton/Fastmail) and no
-- self-referral, the cap above, a list of disposable domains whose joins earn no credit (no_credit_domains), an optional
-- per-person daily limit (credit_day, off at launch), and "each friend inbox counts once, ever". Leaving the waitlist
-- does NOT take a credit back. seen_at records whether the friend ever opened their email; it gates nothing unless you
-- switch to credit_when = 'open' (a friend counts the first time they open their link). Order is a numeric sort_key; a
-- move gives the person a new key strictly between two existing ones, so nobody ever ties and nobody else's key changes.
--
-- WHO CAN STILL MAKE AN ACCOUNT WHEN require_invite IS ON
--   1. the `internal` list on lynxr_signup_gate (yours, always);
--   2. any email on lynxr_roster with status 'invited' — Lynx Media Group campaign creators — by password OR Google,
--      no code. This is how campaign creators get in today and it stays open. NOTE roster-first is new: a creator
--      must be invited on the roster BEFORE they can create an account;
--   3. any email with an outstanding lynxr_invites row — a released waitlister or a "let one person in" — by
--      password with the code from their link, or by Google with the same address (Google proves the address,
--      so no code is asked for);
--   4. nobody else. The Supabase dashboard's "Add user" / "Invite user" are refused for anyone else too, exactly as
--      the seat gate always did.
-- Alternative considered and not used: Supabase's "Before User Created" auth hook (dashboard-configured; it can
-- return a clean 4xx with a message). The trigger on auth.users already exists, is proven live and needs no dashboard
-- step, so it stays the one gate.
--
-- KILL SWITCHES (instant)
--   reopen sign-up:     update public.lynxr_signup_gate set require_invite = false where id = 1;
--   stop the waitlist:  the Edge Function secret WAITLIST_MODE = off  (or nomail to stop only the email)
--   invites off:        update public.lynxr_waitlist_settings set gifts = 0 where id = 1;
--   no new claims today: update public.lynxr_waitlist_settings set gift_day = 0 where id = 1;
--   stop the title:     update public.lynxr_waitlist_settings set title_crew = 0 where id = 1;
--   hide Discord:       update public.lynxr_waitlist_settings set discord_url = null where id = 1;
--   stop the after-sign-up bookkeeping:  drop trigger if exists lynxr_after_signup on auth.users;
--                       (sign-up itself is unaffected either way; only crew / title linking stops)
--   count a friend on first OPEN instead of on join (if farming shows up):
--                       update public.lynxr_waitlist_settings set credit_when = 'open' where id = 1;
--   a daily limit per person (0 = none):   update public.lynxr_waitlist_settings set credit_day = 10 where id = 1;
--   add a disposable domain (its joins earn no credit):
--                       update public.lynxr_waitlist_settings set no_credit_domains = array_append(no_credit_domains, '<domain>') where id = 1;
--   clear an invite name:  update public.lynxr_waitlist set display_name = null where email = '<their email>';
--   the Edge Function secret WL_CREDIT_IP_DAY (default 3; 0 = no referral counts at all) limits credited joins per
--   friend's link per connection per day.
--
-- SET THE DISCORD LINK (shows on the spot card and in every waitlist email within seconds, no deploy; the database
-- refuses anything that is not a discord.gg/<code> or discord.com/invite/<code> link):
--   update public.lynxr_waitlist_settings set discord_url = 'https://discord.gg/<code>' where id = 1;
--
-- RETENTION (privacy page, plan P6). waitlist_join() opportunistically deletes, at most 200 rows a call, entries
-- released more than 90 days ago (since 2026-11-21 everyone is in line from the moment they join, so there is no
-- "never confirmed" entry to delete). Leavers stay as tombstones.
--
-- LOOK AT IT (after Run)
--   select count(*) filter (where confirmed_at is not null and released_at is null and unsubscribed_at is null) as waiting,
--          count(*) filter (where credit in ('moved', 'crew')) as referred,
--          count(*) filter (where seen_at is null and released_at is null and unsubscribed_at is null) as never_opened,
--          count(*) filter (where released_at is not null and batch <> 0) as let_in,
--          count(*) filter (where unsubscribed_at is not null) as left
--     from public.lynxr_waitlist;
--   select email, sort_key, referrals, confirmed_at from public.lynxr_waitlist
--    where confirmed_at is not null and released_at is null and unsubscribed_at is null order by sort_key limit 20;
-- WATCH (read-only): who gained most from friends lately, and how many of those friends never opened their email
--   select r.email, r.referrals, r.title, count(*) as friends,
--          count(*) filter (where f.credited_at > now() - interval '24 hours') as last_24h,
--          count(*) filter (where f.seen_at is null) as never_opened,
--          count(distinct split_part(f.email, '@', 2)) as domains
--     from public.lynxr_waitlist r
--     join public.lynxr_waitlist f on f.referred_by = r.email and f.credit in ('moved', 'crew')
--    group by r.email, r.referrals, r.title order by last_24h desc, never_opened desc limit 20;
-- STRIP:  select public.waitlist_strip('<their email>');               -- friends who never opened their email
--         select public.waitlist_strip('<their email>', 'all', true);  -- every credit, and delete those friends' entries
-- Release by hand instead of the staff button:   select public.waitlist_release(100, true);   -- dry run
-- Export for the owner's eyes ONLY to ~/Desktop, never inside the repo (a waitlist CSV is every address).

-- ── 1a. Prerequisites ────────────────────────────────────────────────────────────────────────────────────────────
do $$ begin
  if to_regclass('public.lynxr_waitlist') is null then
    raise exception 'lynxr_waitlist missing — run supabase/schema.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'lynxr_waitlist' and column_name = 'consent') then
    raise exception 'lynxr_waitlist.consent missing — run supabase/waitlist_consent.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'lynxr_waitlist' and column_name = 'unsubscribed_at') then
    raise exception 'lynxr_waitlist.unsubscribed_at missing — run supabase/waitlist_unsubscribe.sql first';
  end if;
  if to_regclass('public.lynxr_invites') is null then
    raise exception 'lynxr_invites missing — run supabase/invites.sql first';
  end if;
  if to_regclass('public.lynxr_roster') is null then
    raise exception 'lynxr_roster missing — run supabase/agency_roster.sql first';
  end if;
  if to_regclass('public.lynxr_staff') is null then
    raise exception 'lynxr_staff missing — run supabase/staff_gate.sql first';
  end if;
  if to_regclass('public.lynxr_signup_gate') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'lynxr_signup_gate' and column_name = 'require_invite') then
    raise exception 'lynxr_signup_gate.require_invite missing — run supabase/signup_gate.sql then supabase/invites.sql first';
  end if;
  if to_regprocedure('public.new_invite_code()') is null then
    raise exception 'public.new_invite_code() missing — run supabase/invites.sql first';
  end if;
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'public.is_staff() missing — run supabase/staff_gate.sql first';
  end if;
end $$;

-- ── 1b. Settings: one row, staff can read it, nobody can write it from a browser ─────────────────────────────────
create table if not exists public.lynxr_waitlist_settings (
  id          int primary key default 1 check (id = 1),
  batch_size  int not null default 100 check (batch_size between 1 and 1000),
  places      int not null default 10  check (places between 0 and 1000),
  max_credits int not null default 20  check (max_credits >= 0)
);
insert into public.lynxr_waitlist_settings (id) values (1) on conflict do nothing;
-- The community knobs (changeable by SQL, no deploy). Added after the seed insert so a re-run, and any earlier partial
-- run, both work. discord_url is NULL until the owner sets it: null = the Discord link is hidden everywhere.
alter table public.lynxr_waitlist_settings
  add column if not exists gifts       int not null default 3   check (gifts between 0 and 100),          -- invites per account; 0 = off
  add column if not exists gift_day    int not null default 100 check (gift_day between 0 and 100000),    -- claims per rolling 24 h, everyone together; 0 = no new claims
  add column if not exists title_crew  int not null default 3   check (title_crew between 0 and 100),     -- confirmed friends that earn the title; 0 = stop awarding it
  add column if not exists discord_url text constraint lynxr_wl_discord_shape check (discord_url is null or
    discord_url ~ '^https://(discord\.gg/[A-Za-z0-9-]{2,32}|discord\.com/invite/[A-Za-z0-9-]{2,32})$');
-- No-confirmation knobs (owner, 2026-11-21). credit_when: 'join' = a friend counts the moment they join (the default);
-- 'open' = the first time they open their private link (a one-line fallback if farming shows up). credit_day: the most
-- friends one person can be credited for in a rolling 24 h; 0 = no limit. no_credit_domains: joins from these domains are
-- recorded but earn the referrer nothing. from_confirm_at is set once lynxr_wl_from_confirm() has run (section 1i4).
alter table public.lynxr_waitlist_settings
  add column if not exists credit_when text not null default 'join' check (credit_when in ('join', 'open')),
  add column if not exists credit_day  int  not null default 0      check (credit_day between 0 and 1000),
  add column if not exists no_credit_domains text[] not null default array[
    'mailinator.com','guerrillamail.com','guerrillamail.net','sharklasers.com','grr.la','10minutemail.com','temp-mail.org',
    'tempmail.com','tempmail.net','yopmail.com','yopmail.net','trashmail.com','getnada.com','maildrop.cc','dispostable.com',
    'throwawaymail.com','mailnesia.com','fakeinbox.com','mintemail.com','emailondeck.com','mohmal.com','tempail.com',
    'tempr.email','discard.email','spamgourmet.com','mytemp.email','burnermail.io','inboxkitten.com','moakt.com',
    'emailfake.com']::text[],
  add column if not exists from_confirm_at timestamptz;   -- set once lynxr_wl_from_confirm() has run (section 1i4)
alter table public.lynxr_waitlist_settings enable row level security;
revoke all on table public.lynxr_waitlist_settings from anon, authenticated;
grant select on table public.lynxr_waitlist_settings to authenticated;
grant select, insert, update, delete on table public.lynxr_waitlist_settings to service_role;
drop policy if exists "staff read waitlist settings" on public.lynxr_waitlist_settings;
create policy "staff read waitlist settings"
  on public.lynxr_waitlist_settings for select
  to authenticated using (public.is_staff());

-- ── 1c. The queue columns on lynxr_waitlist ──────────────────────────────────────────────────────────────────────
alter table public.lynxr_waitlist
  add column if not exists email_norm       text,           -- lynxr_wl_norm(email): gmail dots / +tags folded, so one inbox is one place
  add column if not exists view_token       text,           -- private link to the person's own spot; shows position, never the email
  add column if not exists confirm_token    text,           -- RETIRED 2026-11-21 (nothing sets it any more); lynxr_wl_from_confirm() nulls the old ones
  add column if not exists ref_code         text,           -- their share code (same alphabet as invite codes)
  add column if not exists referred_by      text references public.lynxr_waitlist (email) on update cascade on delete set null,
  add column if not exists sort_key         numeric,        -- queue order, smallest first; a move picks a key between two others
  add column if not exists confirmed_at     timestamptz,
  add column if not exists referrals        int not null default 0,   -- credited friends (capped by max_credits)
  add column if not exists released_at      timestamptz,
  add column if not exists batch            int,            -- >0 release batch · 0 retired (already had an account) · -1 let in by hand ·
                                                            -- -2 skipped the line with a friend's gift
  add column if not exists release_mailed_at timestamptz,
  add column if not exists mailed_at        timestamptz,    -- last confirm/spot email
  add column if not exists mail_day         date,           -- UTC day mail_n counts
  add column if not exists mail_n           int not null default 0,
  add column if not exists mail_pending     boolean not null default false,   -- an email was owed and not sent (cap or Resend down)
  add column if not exists legacy           boolean not null default false,   -- joined before the queue existed
  add column if not exists title            text check (title in ('founding')),   -- "founding creator": earned at title_crew confirmed friends, permanent
  add column if not exists title_at         timestamptz,
  -- the no-confirmation columns (owner, 2026-11-21)
  add column if not exists seen_at          timestamptz,    -- the first time the private link was opened (waitlist_spot); gates nothing by default
  add column if not exists credit           text,           -- what THIS friend's join did for their referrer; null = not decided yet (see lynxr_wl_credit_friend)
  add column if not exists credited_at      timestamptz,    -- when it counted ('moved' | 'crew' only)
  add column if not exists display_name     text;           -- the optional invite name: first word, 1-20 letters (waitlist_set_name)

-- credit: moved | crew | none | domain | day | stripped. display_name: the same shape the Edge Function and the page enforce
-- (first word only, 1 to 20 characters, no digits, spaces, control characters or the punctuation listed below).
alter table public.lynxr_waitlist drop constraint if exists lynxr_wl_credit_shape;
alter table public.lynxr_waitlist add constraint lynxr_wl_credit_shape
  check (credit is null or credit in ('moved', 'crew', 'none', 'domain', 'day', 'stripped'));
alter table public.lynxr_waitlist drop constraint if exists lynxr_wl_name_shape;
alter table public.lynxr_waitlist add constraint lynxr_wl_name_shape
  check (display_name is null or (char_length(display_name) between 1 and 20
         and display_name !~ '[[:cntrl:][:space:][:digit:]]'
         and translate(display_name, '<>@/\:.,;!?#$%&*+=~^|"()[]{}_`', '') = display_name));
create index if not exists lynxr_waitlist_referred_by_idx on public.lynxr_waitlist (referred_by);

create sequence if not exists public.lynxr_waitlist_seq;

-- ── 1d. Folding an address to the inbox it really is ─────────────────────────────────────────────────────────────
-- Gmail ignores dots and anything after +; the other providers listed ignore anything after +. Every other domain is
-- left alone, so test labels like delivered+x@resend.dev stay distinct.
create or replace function public.lynxr_wl_norm(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  s    text := lower(btrim(coalesce(p, '')));
  at_  int;
  loc  text;
  dom  text;
  plus int;
begin
  if position('@' in s) = 0 then
    return s;
  end if;
  at_ := length(s) - position('@' in reverse(s)) + 1;      -- the LAST @
  loc := substr(s, 1, at_ - 1);
  dom := substr(s, at_ + 1);
  if dom in ('gmail.com', 'googlemail.com') then
    plus := position('+' in loc);
    if plus > 0 then loc := substr(loc, 1, plus - 1); end if;
    loc := replace(loc, '.', '');
    if loc = '' then return s; end if;
    return loc || '@gmail.com';
  elsif dom in ('outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'mac.com',
                'proton.me', 'protonmail.com', 'fastmail.com') then
    plus := position('+' in loc);
    if plus > 0 then loc := substr(loc, 1, plus - 1); end if;
    if loc = '' then return s; end if;
    return loc || '@' || dom;
  end if;
  return s;
end $$;
revoke all on function public.lynxr_wl_norm(text) from public, anon, authenticated;
grant execute on function public.lynxr_wl_norm(text) to service_role;

-- ── 1e. Backfill the rows that existed before the queue ──────────────────────────────────────────────────────────
-- Only rows with no sort_key yet, so a re-run touches nothing. Oldest first.
do $$
declare
  r    record;
  k    numeric := coalesce((select ceil(max(w.sort_key)) from public.lynxr_waitlist w), 0);
  norm text;
  code text;
begin
  for r in select w.email, w.created_at from public.lynxr_waitlist w where w.sort_key is null order by w.created_at, w.email loop
    k := k + 1;
    norm := public.lynxr_wl_norm(r.email);
    loop
      code := public.new_invite_code();
      exit when not exists (select 1 from public.lynxr_waitlist x where x.ref_code = code);
    end loop;
    update public.lynxr_waitlist w
       set email_norm = case when exists (select 1 from public.lynxr_waitlist o where o.email_norm = norm)
                             then null else norm end,       -- two rows, one inbox: the LATER one keeps no norm
           view_token = replace(gen_random_uuid()::text, '-', ''),
           ref_code   = code,
           sort_key   = k,
           legacy     = true,
           confirmed_at = r.created_at                        -- D6 default: they count as confirmed, at the front.
                                                              -- To make them confirm first, replace this line with:  confirmed_at = null
     where w.email = r.email;
  end loop;
end $$;

select setval('public.lynxr_waitlist_seq',
              greatest(coalesce((select ceil(max(w.sort_key)) from public.lynxr_waitlist w), 0),
                       (select s.last_value from public.lynxr_waitlist_seq s),
                       1)::bigint);

alter table public.lynxr_waitlist alter column sort_key   set default nextval('public.lynxr_waitlist_seq');
alter table public.lynxr_waitlist alter column sort_key   set not null;
alter table public.lynxr_waitlist alter column view_token set default replace(gen_random_uuid()::text, '-', '');
alter table public.lynxr_waitlist alter column view_token set not null;
-- A default, so an insert by hand (dashboard, an old import script) still produces a valid row. The queue's own
-- inserts always pass a code and retry on the unique index.
alter table public.lynxr_waitlist alter column ref_code   set default public.new_invite_code();
alter table public.lynxr_waitlist alter column ref_code   set not null;

create unique index if not exists lynxr_waitlist_email_norm_uidx on public.lynxr_waitlist (email_norm);
create unique index if not exists lynxr_waitlist_view_token_uidx on public.lynxr_waitlist (view_token);
create unique index if not exists lynxr_waitlist_ref_code_uidx   on public.lynxr_waitlist (ref_code);
create unique index if not exists lynxr_waitlist_sort_key_uidx   on public.lynxr_waitlist (sort_key);
-- The set a position counts over.
create index if not exists lynxr_waitlist_counted_idx
  on public.lynxr_waitlist (sort_key)
  where confirmed_at is not null and released_at is null and unsubscribed_at is null;

-- ── 1f. Lock the table to the server ─────────────────────────────────────────────────────────────────────────────
-- The old "anyone may join the waitlist" policy let a browser INSERT any row — including a chosen referred_by or
-- confirmed_at. Nothing in a browser writes this table any more; the Edge Function (service role) does.
drop policy if exists "anyone may join the waitlist" on public.lynxr_waitlist;
revoke all on table public.lynxr_waitlist from anon;
revoke insert, update, delete, truncate, references, trigger on table public.lynxr_waitlist from authenticated;
revoke select on table public.lynxr_waitlist from authenticated;
-- Staff still read the list (the existing "staff read the waitlist" policy), but only these columns: the tokens,
-- the share code and the throttle state are unreadable from any browser.
grant select (email, source, created_at, consent, unsubscribed_at, confirmed_at, referrals, released_at, batch, legacy, title,
              seen_at, credit, credited_at, display_name)
  on table public.lynxr_waitlist to authenticated;
grant select, insert, update, delete on table public.lynxr_waitlist to service_role;
grant usage, select, update on sequence public.lynxr_waitlist_seq to service_role;

-- Backstop: a re-run of schema.sql recreates the anon insert policy. Even then a browser role cannot write.
create or replace function public.lynxr_waitlist_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'lynxr: join through the waitlist function'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists lynxr_waitlist_guard on public.lynxr_waitlist;
create trigger lynxr_waitlist_guard
  before insert or update on public.lynxr_waitlist
  for each row execute function public.lynxr_waitlist_guard();

-- ── 1g. The meter: hashed-IP counters for the function's limits, and the daily cap on waitlist email ─────────────
create table if not exists public.lynxr_waitlist_meter (
  bucket     text        primary key,   -- <kind>-h:<hash>:<YYYY-MM-DDTHH> | <kind>-d:<hash>:<YYYY-MM-DD> | <kind>-all:<YYYY-MM-DD> | mail-all:<YYYY-MM-DD>
  n          int         not null default 0,
  expires_at timestamptz not null
);
create index if not exists lynxr_waitlist_meter_expires_idx on public.lynxr_waitlist_meter (expires_at);
alter table public.lynxr_waitlist_meter enable row level security;
revoke all on table public.lynxr_waitlist_meter from anon, authenticated;
grant select, insert, update, delete on table public.lynxr_waitlist_meter to service_role;

-- Returns 'ok' (counted) or why not: 'ip_hour' | 'ip_day' | 'all_day' | 'bad_ip' | 'bad_kind'. One advisory lock
-- serialises every call; nothing is counted unless everything passes. Only a 32-hex HMAC is stored.
create or replace function public.waitlist_take(p_ip text, p_kind text, p_hour int, p_day int, p_all int)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  t   timestamptz := now();
  k_h text;
  k_d text;
  k_g text;
begin
  if p_ip is null or p_ip !~ '^[0-9a-f]{32}$' then return 'bad_ip'; end if;
  if p_kind is null or p_kind !~ '^[a-z]{1,12}$' then return 'bad_kind'; end if;
  k_h := p_kind || '-h:'   || p_ip || ':' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24');
  k_d := p_kind || '-d:'   || p_ip || ':' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  k_g := p_kind || '-all:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  perform pg_advisory_xact_lock(hashtext('lynxr.waitlist_take'));
  delete from public.lynxr_waitlist_meter where expires_at < t;
  if coalesce((select m.n from public.lynxr_waitlist_meter m where m.bucket = k_g), 0) >= p_all  then return 'all_day'; end if;
  if coalesce((select m.n from public.lynxr_waitlist_meter m where m.bucket = k_d), 0) >= p_day  then return 'ip_day';  end if;
  if coalesce((select m.n from public.lynxr_waitlist_meter m where m.bucket = k_h), 0) >= p_hour then return 'ip_hour'; end if;
  insert into public.lynxr_waitlist_meter as m (bucket, n, expires_at) values
    (k_h, 1, t + interval '2 hours'),
    (k_d, 1, t + interval '2 days'),
    (k_g, 1, t + interval '2 days')
  on conflict (bucket) do update set n = m.n + 1;
  return 'ok';
end $$;
revoke all on function public.waitlist_take(text, text, int, int, int) from public, anon, authenticated;
grant execute on function public.waitlist_take(text, text, int, int, int) to service_role;

-- How many of p_n emails may go today under the global cap p_cap (UTC day). Counts that many.
create or replace function public.waitlist_mail_take(p_n int, p_cap int)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  t       timestamptz := now();
  k       text := 'mail-all:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  used    int;
  allowed int;
begin
  if coalesce(p_n, 0) <= 0 then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('lynxr.waitlist_mail_take'));
  delete from public.lynxr_waitlist_meter where expires_at < t;
  used := coalesce((select m.n from public.lynxr_waitlist_meter m where m.bucket = k), 0);
  allowed := greatest(0, least(p_n, coalesce(p_cap, 0) - used));
  if allowed > 0 then
    insert into public.lynxr_waitlist_meter as m (bucket, n, expires_at) values (k, allowed, t + interval '2 days')
    on conflict (bucket) do update set n = m.n + excluded.n;
  end if;
  return allowed;
end $$;
revoke all on function public.waitlist_mail_take(int, int) from public, anon, authenticated;
grant execute on function public.waitlist_mail_take(int, int) to service_role;

-- ── 1g2. Community tables: members, gift claims, the crew graph ──────────────────────────────────────────────────
-- All server-written. A browser reads exactly one of them (lynxr_members, its OWN row, through RLS) and gets everything
-- else only as counts through my_gifts(). Nothing in a browser reads lynxr_gift_claims or lynxr_crew: they hold other
-- people's email addresses.

-- One row per account. Made on the first my_gifts() call (or when a title is carried over). A signed-in person may read
-- their own row, staff may read all; nobody writes it from a browser.
create table if not exists public.lynxr_members (
  id         uuid primary key references auth.users (id) on delete cascade,
  gift_code  text unique,                                          -- the personal ?gift= code, made on first my_gifts()
  gift_bonus int not null default 0 check (gift_bonus between 0 and 1000),   -- extra invites, set by hand in SQL
  title      text check (title in ('founding')),
  title_at   timestamptz,
  created_at timestamptz not null default now()
);
alter table public.lynxr_members enable row level security;
revoke all on table public.lynxr_members from anon, authenticated;
grant select on table public.lynxr_members to authenticated;
grant select, insert, update, delete on table public.lynxr_members to service_role;
drop policy if exists "member reads own row" on public.lynxr_members;
create policy "member reads own row"
  on public.lynxr_members for select
  to authenticated using (auth.uid() = id);
drop policy if exists "staff read members" on public.lynxr_members;
create policy "staff read members"
  on public.lynxr_members for select
  to authenticated using (public.is_staff());

-- One row per friend inbox that claimed a gift. email_norm is unique: ONE gift per inbox, ever (until pruned). A claim
-- that is never turned into an account is deleted after 14 days (lynxr_gift_prune) and the gift goes back to the giver.
create table if not exists public.lynxr_gift_claims (
  id          bigint generated always as identity primary key,
  giver_id    uuid not null references auth.users (id) on delete cascade,
  email       text not null,                                       -- the friend's address as they typed it (lower, trimmed)
  email_norm  text not null unique,                                -- lynxr_wl_norm(email)
  created_at  timestamptz not null default now(),
  mailed_at   timestamptz,                                         -- "send it again" throttle, same shape as lynxr_waitlist's
  mail_day    date,
  mail_n      int not null default 0,
  redeemed_at timestamptz,                                         -- the friend made their account (set by lynxr_after_signup)
  member_id   uuid references auth.users (id) on delete set null
);
create index if not exists lynxr_gift_claims_giver_idx on public.lynxr_gift_claims (giver_id);
alter table public.lynxr_gift_claims enable row level security;      -- on, with NO policies: no browser role reads it
revoke all on table public.lynxr_gift_claims from anon, authenticated;
grant select, insert, update, delete on table public.lynxr_gift_claims to service_role;

-- THE CREW: the referral graph, and later the friend graph. One edge per (friend, how they came): a waitlist friend counts
-- when they JOIN (since 2026-11-21; lynxr_wl_credit_friend), a gifted friend when they CREATE their account (the code they
-- needed came by email, so that is the real action). Keyed on FOLDED emails (lynxr_wl_norm) because most edges are written before either side has
-- an account; inviter_id / member_id are filled in as soon as an account exists (lynxr_after_signup, or at write time when
-- it already does). One edge per (friend, via): the first inviter keeps the credit, a rejoin never counts twice.
-- Kudos later = "an edge exists between these two account ids, either direction" (both ids set).
-- RETENTION: an edge is pruned with the waitlist entry it came from (waitlist_join, at most 200 a call) unless that side
-- has an account; it cascades away with either account.
create table if not exists public.lynxr_crew (
  inviter_norm text not null,                                      -- lynxr_wl_norm of the inviter's email
  member_norm  text not null,                                      -- lynxr_wl_norm of the friend's email
  via          text not null check (via in ('waitlist', 'gift')),
  inviter_id   uuid references auth.users (id) on delete cascade,  -- filled once the inviter has an account
  member_id    uuid references auth.users (id) on delete cascade,  -- filled once the friend has an account
  counted_at   timestamptz not null default now(),                 -- the friend's real action
  primary key (member_norm, via)
);
create index if not exists lynxr_crew_inviter_norm_idx on public.lynxr_crew (inviter_norm);
create index if not exists lynxr_crew_inviter_id_idx   on public.lynxr_crew (inviter_id);
create index if not exists lynxr_crew_member_id_idx    on public.lynxr_crew (member_id);
alter table public.lynxr_crew enable row level security;             -- on, with NO policies
revoke all on table public.lynxr_crew from anon, authenticated;
grant select, insert, update, delete on table public.lynxr_crew to service_role;

-- ── 1h. The gate — the one change to sign-up enforcement ─────────────────────────────────────────────────────────
-- Never an RPC: revoked from every browser role. enforce_signup_gate() (definer) is the only caller.
--   'ok'        let them in            'invite'    let them in AND burn their invite
--   'no_invite' refuse                 'bad_code'  refuse (wrong or missing code on a password sign-up)
--   'full'      refuse (seat gate, require_invite off)
-- Volatile on purpose: it reads rows changed earlier in the same transaction (the self-test does).
create or replace function public.lynxr_signup_verdict(p_email text, p_provider text, p_code text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  g     public.lynxr_signup_gate%rowtype;
  e     text := lower(btrim(coalesce(p_email, '')));
  inv   public.lynxr_invites%rowtype;
  taken int;
begin
  select * into g from public.lynxr_signup_gate where id = 1;
  if not found then
    return 'ok';                                  -- unconfigured: not our business (as invites.sql)
  end if;

  if e = any (g.internal) then
    return 'ok';                                  -- yours, always
  end if;

  if not g.require_invite then                    -- today's behaviour, unchanged: the seat gate
    select count(*) into taken
      from auth.users u
     where lower(u.email) <> all (g.internal);
    if taken >= g.seats then return 'full'; end if;
    return 'ok';
  end if;

  -- Lynx Media Group campaign creators: any sign-in method, no code.
  if exists (select 1 from public.lynxr_roster r where r.email = e and r.status = 'invited') then
    return 'ok';
  end if;

  select * into inv
    from public.lynxr_invites i
   where lower(i.email) = e
     and i.redeemed_at is null
   order by i.created_at desc
   limit 1;
  if not found then
    return 'no_invite';
  end if;

  if coalesce(p_provider, 'email') <> 'email' then
    return 'invite';                              -- Google proves the address; the invite is bound to it
  end if;
  if upper(coalesce(p_code, '')) = '' or upper(p_code) <> upper(inv.code) then
    return 'bad_code';
  end if;
  return 'invite';
end $$;
revoke all on function public.lynxr_signup_verdict(text, text, text) from public, anon, authenticated;
grant execute on function public.lynxr_signup_verdict(text, text, text) to service_role;

-- Same name as before, so the existing trigger keeps pointing at it. The refusal texts are the ones creator.js
-- already matches, so a browser still holding the old page gets a sensible sentence.
create or replace function public.enforce_signup_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text;
begin
  v := public.lynxr_signup_verdict(new.email,
                                   new.raw_app_meta_data->>'provider',
                                   new.raw_user_meta_data->>'invite');
  if v = 'no_invite' then
    raise exception 'lynxr: no invite for this address'
      using errcode = 'check_violation';
  elsif v = 'bad_code' then
    raise exception 'lynxr: invite code does not match'
      using errcode = 'check_violation';
  elsif v = 'full' then
    raise exception 'lynxr: signups are closed — all seats are taken'
      using errcode = 'check_violation';
  elsif v = 'invite' then
    -- Burn it. Same transaction as the insert, so a sign-up that fails later rolls the redemption back with it.
    update public.lynxr_invites
       set redeemed_at = now(), redeemed_by = new.id
     where lower(email) = lower(new.email)
       and redeemed_at is null;
  end if;
  return new;
end $$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.enforce_signup_gate() to supabase_auth_admin;

drop trigger if exists lynxr_signup_seats on auth.users;       -- the stray one HANDOFF warns about
drop trigger if exists lynxr_signup_gate on auth.users;
create trigger lynxr_signup_gate
  before insert on auth.users
  for each row execute function public.enforce_signup_gate();

-- ── 1i. The queue functions ──────────────────────────────────────────────────────────────────────────────────────
-- Lock order everywhere: the advisory lock 'lynxr_waitlist_order' FIRST, then row locks. That is what keeps
-- two simultaneous joins from deadlocking on a shared referrer.

-- Where a sort_key stands: 1 + the in-line (confirmed_at set), unreleased, still-subscribed rows ahead of it. Since
-- 2026-11-21 every entry is in line from the moment it joins; confirmed_at is simply "in line since". Volatile for the same
-- reason as the verdict.
create or replace function public.lynxr_wl_position(p_key numeric)
returns int
language sql
volatile
security definer
set search_path = ''
as $$
  select 1 + count(*)::int
    from public.lynxr_waitlist w
   where w.confirmed_at is not null
     and w.released_at is null
     and w.unsubscribed_at is null
     and w.sort_key < p_key;
$$;
revoke all on function public.lynxr_wl_position(numeric) from public, anon, authenticated;
grant execute on function public.lynxr_wl_position(numeric) to service_role;

-- May this person be emailed now? 15 minutes since the last one, and at most 3 on a UTC day.
create or replace function public.lynxr_wl_mail_ok(p_mailed timestamptz, p_day date, p_n int)
returns boolean
language sql
stable
set search_path = ''
as $$
  select (p_mailed is null or p_mailed < now() - interval '15 minutes')
     and (p_day is distinct from (now() at time zone 'utc')::date or coalesce(p_n, 0) < 3);
$$;
revoke all on function public.lynxr_wl_mail_ok(timestamptz, date, int) from public, anon, authenticated;
grant execute on function public.lynxr_wl_mail_ok(timestamptz, date, int) to service_role;

-- An invite the address can use: reuses an outstanding one, and re-opens one that was redeemed by an account
-- that no longer exists (callers have already refused addresses that have an account). Returns its code.
create or replace function public.lynxr_wl_invite(p_email text, p_note text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_e    text := lower(btrim(coalesce(p_email, '')));
  v_code text;
begin
  insert into public.lynxr_invites as i (email, code, note)
  select v_e, public.new_invite_code(), coalesce(p_note, '')
   where not exists (select 1 from public.lynxr_invites x where lower(x.email) = v_e and x.redeemed_at is null)
  on conflict (email) do update
    set code = excluded.code, note = excluded.note, created_at = now(), redeemed_at = null, redeemed_by = null
    where i.redeemed_at is not null;
  select i.code into v_code
    from public.lynxr_invites i
   where lower(i.email) = v_e and i.redeemed_at is null
   order by i.created_at desc
   limit 1;
  return v_code;
end $$;
revoke all on function public.lynxr_wl_invite(text, text) from public, anon, authenticated;
grant execute on function public.lynxr_wl_invite(text, text) to service_role;

-- THE MOVE. See the header. Called by lynxr_wl_credit_friend() (when a friend joins, or first opens their link under
-- credit_when = 'open', or in the one-time switch); takes the same advisory lock.
create or replace function public.waitlist_credit(p_email text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a       public.lynxr_waitlist%rowtype;
  v_places int := coalesce((select s.places from public.lynxr_waitlist_settings s where s.id = 1), 10);
  v_max    int := coalesce((select s.max_credits from public.lynxr_waitlist_settings s where s.id = 1), 20);
  p       int;
  target  int;
  kprev   numeric;
  knext   numeric;
  newk    numeric;
begin
  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));
  select * into a from public.lynxr_waitlist w where w.email = p_email for update;
  if a.email is null or a.released_at is not null or a.unsubscribed_at is not null then
    return;                                                   -- gone, let in, or left: nothing to move
  end if;
  if a.referrals >= v_max then
    return;                                                   -- the cap: extra friends are not counted
  end if;

  p := public.lynxr_wl_position(a.sort_key);
  target := greatest(1, p - v_places);

  if target < p then
    if target = 1 then
      -- to the very front: strictly below every other key
      newk := (select min(w.sort_key) from public.lynxr_waitlist w where w.email <> a.email) - 1;
    else
      -- between the counted row that will be ahead of them (rank target-1, not counting them) and whatever
      -- row (counted or not) follows it. Multiply, never divide: exact numeric, so keys never collide.
      select w.sort_key into kprev
        from public.lynxr_waitlist w
       where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null
         and w.email <> a.email
       order by w.sort_key
       offset target - 2 limit 1;
      knext := (select min(w.sort_key) from public.lynxr_waitlist w where w.sort_key > kprev and w.email <> a.email);
      newk := (kprev + knext) * 0.5;
    end if;
    update public.lynxr_waitlist w set sort_key = newk, referrals = w.referrals + 1 where w.email = a.email;
  else
    update public.lynxr_waitlist w set referrals = w.referrals + 1 where w.email = a.email;   -- already #1
  end if;
end $$;
revoke all on function public.waitlist_credit(text) from public, anon, authenticated;
grant execute on function public.waitlist_credit(text) to service_role;

-- JOIN. Returns the full picture to the Edge Function, which strips it to status/mailed/position (and, for a brand-new
-- entry only, its own view token) before it answers a browser. Never writes a row for an address that already has (or may
-- make) an account. Since 2026-11-21 a new row is in line at once (confirmed_at = now(), no confirm token) and a friend's
-- join credits their referrer here (lynxr_wl_credit_friend). The kind of a new row is 'spot', never 'welcome' or 'confirm':
-- a deployed older Edge Function maps any unknown kind to its confirm email with a dead link, and the FUNCTION picks the
-- welcome email from status = 'new'.
create or replace function public.waitlist_join(p_email text, p_ref text, p_source text, p_consent text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_e        text := lower(btrim(coalesce(p_email, '')));
  v_norm     text;
  v_src      text;
  v_cons     text;
  v_ref      text;
  g          public.lynxr_signup_gate%rowtype;
  w          public.lynxr_waitlist%rowtype;
  v_referrer text;
  v_tries    int := 0;
  v_raced    boolean := false;
  v_may      boolean;
  v_kind     text;
  v_code     text;
  v_when     text := coalesce((select s.credit_when from public.lynxr_waitlist_settings s where s.id = 1), 'join');
begin
  if v_e !~ '^[^@[:space:]]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}$' or length(v_e) > 254 then
    return jsonb_build_object('status', 'bad_email');
  end if;

  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));

  v_norm := public.lynxr_wl_norm(v_e);
  v_src  := left(regexp_replace(lower(coalesce(p_source, '')), '[^a-z0-9._:-]', '', 'g'), 40);
  if v_src = '' then v_src := 'landing'; end if;
  v_cons := left(regexp_replace(lower(coalesce(p_consent, '')), '[^a-z0-9-]', '', 'g'), 40);
  v_ref  := upper(btrim(coalesce(p_ref, '')));
  if v_ref !~ '^[A-HJ-NP-Z2-9]{8}$' then v_ref := null; end if;

  -- Retention (D10), at most 200 rows a call: entries released more than 90 days ago. (Since 2026-11-21 everyone is in
  -- line from the moment they join, so there is no "never confirmed after 30 days" entry any more.)
  delete from public.lynxr_waitlist x
   where x.email in (
     select p.email from public.lynxr_waitlist p
      where p.released_at is not null and p.released_at < now() - interval '90 days'
      order by p.created_at
      limit 200);
  -- Community retention (plan beli B1), same lock already held: claimed gifts nobody used within 14 days go back to the
  -- giver, and crew edges are dropped with the waitlist entry they came from — unless that side has an account.
  perform public.lynxr_gift_prune();
  delete from public.lynxr_crew cx
   where (cx.member_norm, cx.via) in (
     select x.member_norm, x.via from public.lynxr_crew x
      where (x.member_id is null
             and not exists (select 1 from public.lynxr_waitlist wm
                              where wm.email_norm = x.member_norm
                                 or (wm.email_norm is null and public.lynxr_wl_norm(wm.email) = x.member_norm)))
         or (x.inviter_id is null
             and not exists (select 1 from public.lynxr_waitlist wi
                              where wi.email_norm = x.inviter_norm
                                 or (wi.email_norm is null and public.lynxr_wl_norm(wi.email) = x.inviter_norm)))
      order by x.counted_at
      limit 200);

  -- Account route: internal, a roster invite, an outstanding invite, or a real account. No row is written.
  select * into g from public.lynxr_signup_gate where id = 1;
  if (g.id is not null and v_e = any (g.internal))
     or exists (select 1 from public.lynxr_roster r where r.email = v_e and r.status = 'invited')
     or exists (select 1 from public.lynxr_invites i where lower(i.email) = v_e and i.redeemed_at is null)
     or exists (select 1 from auth.users u where lower(u.email) = v_e) then
    return jsonb_build_object('status', 'account');
  end if;

  -- Whose link brought them (never themselves, never someone who left).
  if v_ref is not null then
    select r.email into v_referrer
      from public.lynxr_waitlist r
     where r.ref_code = v_ref and r.email_norm is distinct from v_norm and r.email <> v_e and r.unsubscribed_at is null;
  end if;

  select * into w
    from public.lynxr_waitlist x
   where x.email_norm = v_norm or x.email = v_e
   order by (x.email = v_e) desc
   limit 1
   for update;

  if w.email is not null then
    if w.unsubscribed_at is not null then
      -- Rejoin at the back, in line at once. created_at restarts the retention clock. A friend already credited
      -- once (credit is set, whatever it was) keeps that decision and is never credited again; one who was not
      -- takes the link of THIS request.
      update public.lynxr_waitlist x
         set unsubscribed_at = null, confirmed_at = now(), confirm_token = null,
             sort_key = nextval('public.lynxr_waitlist_seq'),
             created_at = now(), mailed_at = null, mail_pending = false,
             released_at = null, batch = null, release_mailed_at = null,
             referred_by = case when x.credit is null then v_referrer else x.referred_by end,
             consent = coalesce(nullif(v_cons, ''), x.consent)
       where x.email = w.email
       returning * into w;
      if v_when = 'join' and w.credit is null and w.referred_by is not null then
        perform public.lynxr_wl_credit_friend(w.email);
        select * into w from public.lynxr_waitlist x where x.email = w.email;
      end if;
    end if;

    v_may := public.lynxr_wl_mail_ok(w.mailed_at, w.mail_day, w.mail_n);
    if w.released_at is not null and w.batch is distinct from 0 then
      select i.code into v_code from public.lynxr_invites i
       where lower(i.email) = lower(w.email) and i.redeemed_at is null order by i.created_at desc limit 1;
      v_kind := case when v_code is null then 'spot' else 'release' end;
    else
      v_kind := 'spot';
    end if;
    return jsonb_build_object('status', 'exists', 'email', w.email, 'kind', v_kind,
                              'view_token', w.view_token,
                              'ref_code', w.ref_code, 'position', public.lynxr_wl_position(w.sort_key),
                              'code', case when v_kind = 'release' then v_code else null end,
                              'may_mail', v_may);
  end if;

  -- New. Retry on a unique violation (a share-code collision); an address that raced in is treated as existing.
  loop
    v_tries := v_tries + 1;
    begin
      insert into public.lynxr_waitlist (email, email_norm, source, consent, confirmed_at, ref_code, referred_by)
      values (v_e, v_norm, v_src, v_cons, now(), public.new_invite_code(), v_referrer)
      returning * into w;
      exit;
    exception when unique_violation then
      select * into w from public.lynxr_waitlist y where y.email = v_e or y.email_norm = v_norm limit 1;
      if w.email is not null then
        v_raced := true;
        exit;
      end if;
      if v_tries >= 3 then
        return jsonb_build_object('status', 'error');
      end if;
    end;
  end loop;

  if v_raced then
    return jsonb_build_object('status', 'exists', 'email', w.email, 'kind', 'spot',
                              'view_token', w.view_token,
                              'ref_code', w.ref_code, 'position', public.lynxr_wl_position(w.sort_key),
                              'code', null, 'may_mail', false);
  end if;

  -- A friend's join counts now (credit_when = 'join'); under 'open' it counts the first time they open their link.
  if v_when = 'join' and v_referrer is not null then
    perform public.lynxr_wl_credit_friend(w.email);
  end if;

  return jsonb_build_object('status', 'new', 'email', w.email, 'kind', 'spot',
                            'view_token', w.view_token,
                            'ref_code', w.ref_code, 'position', public.lynxr_wl_position(w.sort_key),
                            'may_mail', true);
end $$;
revoke all on function public.waitlist_join(text, text, text, text) from public, anon, authenticated;
grant execute on function public.waitlist_join(text, text, text, text) to service_role;

-- SPOT: what the private link shows. NEVER the email, a token or an invite code. The first time a private link is opened
-- it records seen_at (and, under credit_when = 'open', credits whoever's link brought that friend). p_confirm is ignored:
-- it is kept so the deployed Edge Function, and the confirm links already sitting in inboxes, keep working as plain links.
create or replace function public.waitlist_spot(p_token text, p_confirm text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  w        public.lynxr_waitlist%rowtype;
  v_state  text;
  v_pos    int;
  v_size   int;
  v_places int;
  v_tcrew  int;
  v_disc   text;
  n        int;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('state', 'none');
  end if;
  select * into w from public.lynxr_waitlist x where x.view_token = p_token;
  if w.email is null then
    return jsonb_build_object('state', 'none');
  end if;

  if w.seen_at is null then
    perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));   -- advisory first, then the row (see 1i)
    -- Not "update ... returning * into w": a no-row update (someone else opened it first) would blank w.
    update public.lynxr_waitlist x set seen_at = now() where x.email = w.email and x.seen_at is null;
    get diagnostics n = row_count;
    if n > 0 and coalesce((select s.credit_when from public.lynxr_waitlist_settings s where s.id = 1), 'join') = 'open' then
      perform public.lynxr_wl_credit_friend(w.email);
    end if;
    select * into w from public.lynxr_waitlist x where x.email = w.email;
  end if;

  v_state := case when w.unsubscribed_at is not null then 'left'
                  when w.released_at is not null     then 'released'
                  else 'waiting' end;
  if v_state = 'waiting' then
    v_pos := public.lynxr_wl_position(w.sort_key);
  end if;
  select s.batch_size, s.places, s.title_crew, s.discord_url into v_size, v_places, v_tcrew, v_disc
    from public.lynxr_waitlist_settings s where s.id = 1;

  -- A whitelist, never a row: no email, token or invite code can leave through here. title, discord and name are absent
  -- when null (jsonb_strip_nulls); crew is a number, never who is in it; name is the person's own invite name.
  return jsonb_strip_nulls(jsonb_build_object(
    'state', v_state, 'position', v_pos, 'ref_code', w.ref_code, 'referrals', w.referrals,
    'batch_size', coalesce(v_size, 100), 'places', coalesce(v_places, 10),
    'crew', public.lynxr_wl_crew(coalesce(w.email_norm, public.lynxr_wl_norm(w.email)), null),
    'title', w.title, 'title_crew', coalesce(v_tcrew, 3), 'discord', v_disc, 'name', w.display_name));
end $$;
revoke all on function public.waitlist_spot(text, text) from public, anon, authenticated;
grant execute on function public.waitlist_spot(text, text) to service_role;

-- "Send it again" from a spot link. Same throttle as join.
create or replace function public.waitlist_mail_info(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  w       public.lynxr_waitlist%rowtype;
  v_kind  text;
  v_code  text;
  v_last  timestamptz;
  v_day   date := (now() at time zone 'utc')::date;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('ok', false, 'wait_s', 0, 'reason', 'none');
  end if;
  select * into w from public.lynxr_waitlist x where x.view_token = p_token;
  if w.email is null then
    return jsonb_build_object('ok', false, 'wait_s', 0, 'reason', 'none');
  end if;
  if w.unsubscribed_at is not null then
    return jsonb_build_object('ok', false, 'wait_s', 0, 'reason', 'left');
  end if;

  if w.released_at is not null and w.batch is distinct from 0 then
    select i.code into v_code from public.lynxr_invites i
     where lower(i.email) = lower(w.email) and i.redeemed_at is null order by i.created_at desc limit 1;
    v_kind := case when v_code is null then 'spot' else 'release' end;
  else
    v_kind := 'spot';
  end if;

  v_last := case when v_kind = 'release' then w.release_mailed_at else w.mailed_at end;
  if v_last is not null and v_last > now() - interval '15 minutes' then
    return jsonb_build_object('ok', false,
      'wait_s', ceil(extract(epoch from (v_last + interval '15 minutes' - now())))::int);
  end if;
  if v_kind <> 'release' and w.mail_day = v_day and w.mail_n >= 3 then
    return jsonb_build_object('ok', false,
      'wait_s', ceil(extract(epoch from (((v_day + 1)::timestamp at time zone 'utc') - now())))::int);
  end if;

  return jsonb_build_object('ok', true, 'email', w.email, 'kind', v_kind,
                            'view_token', w.view_token,
                            'ref_code', w.ref_code, 'position', public.lynxr_wl_position(w.sort_key),
                            'code', case when v_kind = 'release' then v_code else null end);
end $$;
revoke all on function public.waitlist_mail_info(text) from public, anon, authenticated;
grant execute on function public.waitlist_mail_info(text) to service_role;

-- Record what the Edge Function did with the mail.
--   'spot'              sent (the welcome email and "your place in line" are both 'spot' since 2026-11-21): mailed_at =
--                       now, the day's count rolls, the pending flag clears. 'confirm' is still accepted, the same way,
--                       so a deployed older Edge Function that has an email in flight keeps working.
--   'pending'           an email was owed and was NOT sent (daily cap, or Resend refused): "Send them" retries
--   'release'           the release email went: release_mailed_at = now
create or replace function public.waitlist_mark_mailed(p_emails text[], p_kind text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
begin
  if p_emails is null or coalesce(array_length(p_emails, 1), 0) = 0 then return; end if;
  if p_kind in ('confirm', 'spot') then
    update public.lynxr_waitlist w
       set mailed_at = now(),
           mail_n = case when w.mail_day = v_day then w.mail_n + 1 else 1 end,
           mail_day = v_day,
           mail_pending = false
     where w.email = any (p_emails);
  elsif p_kind = 'pending' then
    update public.lynxr_waitlist w set mail_pending = true where w.email = any (p_emails);
  elsif p_kind = 'release' then
    update public.lynxr_waitlist w set release_mailed_at = now() where w.email = any (p_emails);
  end if;
end $$;
revoke all on function public.waitlist_mark_mailed(text[], text) from public, anon, authenticated;
grant execute on function public.waitlist_mark_mailed(text[], text) to service_role;

-- Leave the list (the one-click link in every email, and the "leave the waitlist" button).
create or replace function public.waitlist_stop(p_token text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return false; end if;
  update public.lynxr_waitlist w set unsubscribed_at = now()
   where w.view_token = p_token and w.unsubscribed_at is null;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.waitlist_stop(text) from public, anon, authenticated;
grant execute on function public.waitlist_stop(text) to service_role;

-- RELEASE the next p_n (at most 1000). Dry: returns {batch, count} and writes nothing. Real: first retires people
-- who already have an account, then gives each of the next p_n an invite and stamps them released.
create or replace function public.waitlist_release(p_n int, p_dry boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n    int := least(coalesce(p_n, 0), 1000);
  v_dry  boolean := coalesce(p_dry, false);
  v_k    int;
  v_last timestamptz;
  v_cnt  int;
  v_rows jsonb := '[]'::jsonb;
  r      record;
  v_code text;
begin
  if v_n < 1 then
    return jsonb_build_object('error', 'bad_n');
  end if;
  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));

  select max(w.released_at) into v_last from public.lynxr_waitlist w where w.batch > 0;
  if not v_dry and v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object('error', 'too_soon');           -- a double press
  end if;
  select coalesce(max(w.batch), 0) + 1 into v_k from public.lynxr_waitlist w where w.batch > 0;

  if v_dry then
    select count(*)::int into v_cnt from (
      select 1 from public.lynxr_waitlist w
       where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null
         and not exists (select 1 from auth.users u where lower(u.email) = lower(w.email))
       order by w.sort_key
       limit v_n) s;
    return jsonb_build_object('batch', v_k, 'count', v_cnt);
  end if;

  update public.lynxr_waitlist w set released_at = now(), batch = 0
   where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null
     and exists (select 1 from auth.users u where lower(u.email) = lower(w.email));

  for r in
    select w.email, w.view_token from public.lynxr_waitlist w
     where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null
       and not exists (select 1 from auth.users u where lower(u.email) = lower(w.email))
     order by w.sort_key
     limit v_n
  loop
    v_code := public.lynxr_wl_invite(r.email, 'waitlist batch ' || v_k);
    update public.lynxr_waitlist w set released_at = now(), batch = v_k where w.email = r.email;
    v_rows := v_rows || jsonb_build_object('email', r.email, 'view_token', r.view_token, 'code', v_code);
  end loop;

  return jsonb_build_object('batch', v_k, 'rows', v_rows);
end $$;
revoke all on function public.waitlist_release(int, boolean) from public, anon, authenticated;
grant execute on function public.waitlist_release(int, boolean) to service_role;

-- Released people whose release email has not gone out (cap, or Resend was down): for "Send them".
create or replace function public.waitlist_unmailed()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
           'email', s.email, 'view_token', s.view_token, 'code', s.code)), '[]'::jsonb))
    into v
    from (
      select w.email, w.view_token, i.code
        from public.lynxr_waitlist w
        join lateral (select x.code from public.lynxr_invites x
                       where lower(x.email) = lower(w.email) and x.redeemed_at is null
                       order by x.created_at desc limit 1) i on true
       where w.released_at is not null and w.batch is distinct from 0
         and w.release_mailed_at is null and w.unsubscribed_at is null
       order by w.released_at, w.email
       limit 1000) s;
  return v;
end $$;
revoke all on function public.waitlist_unmailed() from public, anon, authenticated;
grant execute on function public.waitlist_unmailed() to service_role;

-- "Let one person in": an invite now, whoever they are; marks their waitlist row if they had one.
create or replace function public.waitlist_let_in(p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_e    text := lower(btrim(coalesce(p_email, '')));
  v_code text;
  v_view text;
begin
  if v_e !~ '^[^@[:space:]]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}$' or length(v_e) > 254 then
    return jsonb_build_object('status', 'bad_email');
  end if;
  if exists (select 1 from auth.users u where lower(u.email) = v_e) then
    return jsonb_build_object('status', 'has_account');
  end if;
  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));
  v_code := public.lynxr_wl_invite(v_e, 'waitlist let-in');
  update public.lynxr_waitlist w
     set released_at = coalesce(w.released_at, now()), batch = coalesce(w.batch, -1)
   where w.email_norm = public.lynxr_wl_norm(v_e) or w.email = v_e
   returning w.view_token into v_view;
  return jsonb_build_object('status', 'ok', 'email', v_e, 'code', v_code, 'view_token', v_view);
end $$;
revoke all on function public.waitlist_let_in(text) from public, anon, authenticated;
grant execute on function public.waitlist_let_in(text) to service_role;

-- The agency card's numbers. The only function here a browser may call, and it answers null to anyone who is not staff.
create or replace function public.staff_waitlist_stats()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if not public.is_staff() then
    return null;
  end if;
  select jsonb_build_object(
    'waiting',      count(*) filter (where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null),
    'referred',     count(*) filter (where w.credit in ('moved', 'crew')),
    'unseen',       count(*) filter (where w.seen_at is null and w.released_at is null and w.unsubscribed_at is null),
    'released',     count(*) filter (where w.released_at is not null and w.batch is distinct from 0),
    'joined',       (select count(*) from public.lynxr_invites i where i.note like 'waitlist%' and i.redeemed_at is not null),
    'left',         count(*) filter (where w.unsubscribed_at is not null),
    'unmailed',     count(*) filter (where w.released_at is not null and w.batch is distinct from 0
                                       and w.release_mailed_at is null and w.unsubscribed_at is null),
    'pending_mail', count(*) filter (where w.mail_pending and w.unsubscribed_at is null),
    'last_batch',   max(w.batch) filter (where w.batch > 0),
    'last_batch_at', max(w.released_at) filter (where w.batch > 0),
    'batch_size',   coalesce((select s.batch_size from public.lynxr_waitlist_settings s where s.id = 1), 100),
    'places',       coalesce((select s.places from public.lynxr_waitlist_settings s where s.id = 1), 10),
    'gifted',       (select count(*) from public.lynxr_gift_claims),
    'gift_joined',  (select count(*) from public.lynxr_gift_claims c where c.redeemed_at is not null))
    into v
    from public.lynxr_waitlist w;
  return v;
end $$;
revoke all on function public.staff_waitlist_stats() from public, anon;
grant execute on function public.staff_waitlist_stats() to authenticated, service_role;

-- ── 1i2. Gifts, crew, title ──────────────────────────────────────────────────────────────────────────────────────
-- (plan beli B1.) Same lock order as 1i: the advisory lock 'lynxr_waitlist_order' FIRST, then row locks. Everything here
-- is server-only except my_gifts(), which returns the caller's OWN counts and never a friend's address.

-- How many distinct friends an inviter has brought: by folded email (edges written before the inviter had an account) OR
-- by account id (edges linked since). Volatile: it reads rows written earlier in the same transaction.
create or replace function public.lynxr_wl_crew(p_norm text, p_uid uuid)
returns int
language sql
volatile
security definer
set search_path = ''
as $$
  select count(distinct c.member_norm)::int
    from public.lynxr_crew c
   where (p_norm is not null and c.inviter_norm = p_norm)
      or (p_uid is not null and c.inviter_id = p_uid);
$$;
revoke all on function public.lynxr_wl_crew(text, uuid) from public, anon, authenticated;
grant execute on function public.lynxr_wl_crew(text, uuid) to service_role;

-- Award the founding-creator title when an inviter's crew reaches settings.title_crew. Permanent once earned; the owner
-- stops new awards with title_crew = 0. The title lands on the waitlist row (if any) and, when the inviter has an
-- account, on lynxr_members. Callers pass the inviter's folded email, their address, and their account id if known.
create or replace function public.lynxr_wl_title_check(p_norm text, p_email text, p_uid uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  t     int;
  v_uid uuid;
begin
  select s.title_crew into t from public.lynxr_waitlist_settings s where s.id = 1;
  t := coalesce(t, 3);
  if t <= 0 or p_norm is null then
    return;
  end if;
  v_uid := coalesce(p_uid, (select u.id from auth.users u where lower(u.email) = lower(p_email) limit 1));
  if public.lynxr_wl_crew(p_norm, v_uid) < t then
    return;
  end if;
  update public.lynxr_waitlist w set title = 'founding', title_at = now()
   where (w.email_norm = p_norm or w.email = lower(p_email)) and w.title is null;
  if v_uid is not null then
    insert into public.lynxr_members as m (id, title, title_at) values (v_uid, 'founding', now())
    on conflict (id) do update
      set title = coalesce(m.title, excluded.title), title_at = coalesce(m.title_at, excluded.title_at);
  end if;
end $$;
revoke all on function public.lynxr_wl_title_check(text, text, uuid) from public, anon, authenticated;
grant execute on function public.lynxr_wl_title_check(text, text, uuid) to service_role;

-- Withdraw gifts nobody used: at most 200 claims that are 14 days old and still unredeemed. The friend's gift invite is
-- deleted, a waitlister who skipped the line goes back to their old place (their sort_key never changed), and the claim
-- row is deleted so the giver's count drops. Callers hold the 'lynxr_waitlist_order' lock first (this writes lynxr_waitlist).
create or replace function public.lynxr_gift_prune()
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c public.lynxr_gift_claims%rowtype;
  n   int := 0;
begin
  for v_c in
    select * from public.lynxr_gift_claims k
     where k.redeemed_at is null and k.created_at < now() - interval '14 days'
     order by k.id
     limit 200
  loop
    delete from public.lynxr_invites i
     where lower(i.email) = v_c.email and i.redeemed_at is null and i.note = 'gift';
    update public.lynxr_waitlist w
       set released_at = null, batch = null, release_mailed_at = null
     where w.batch = -2
       and (w.email_norm = v_c.email_norm or w.email = v_c.email)
       and not exists (select 1 from auth.users u where lower(u.email) = lower(w.email));
    delete from public.lynxr_gift_claims d where d.id = v_c.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.lynxr_gift_prune() from public, anon, authenticated;
grant execute on function public.lynxr_gift_prune() to service_role;

-- What the gift card needs to know before it asks for an email. Never the giver's id, email or name.
--   none (no such link) · open (sign-up is open, an invite means nothing) · off (invites paused) · used_up · ok
create or replace function public.waitlist_gift_peek(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code  text := upper(btrim(coalesce(p_code, '')));
  g       public.lynxr_signup_gate%rowtype;
  m       public.lynxr_members%rowtype;
  v_gifts int;
  v_used  int;
begin
  if v_code !~ '^[A-HJ-NP-Z2-9]{8}$' then
    return jsonb_build_object('state', 'none');
  end if;
  select * into g from public.lynxr_signup_gate where id = 1;
  if not found or not g.require_invite then
    return jsonb_build_object('state', 'open');
  end if;
  select s.gifts into v_gifts from public.lynxr_waitlist_settings s where s.id = 1;
  v_gifts := coalesce(v_gifts, 3);
  if v_gifts <= 0 then
    return jsonb_build_object('state', 'off');
  end if;
  select * into m from public.lynxr_members x where x.gift_code = v_code;
  if m.id is null then
    return jsonb_build_object('state', 'none');
  end if;
  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));
  perform public.lynxr_gift_prune();
  select count(*)::int into v_used from public.lynxr_gift_claims k where k.giver_id = m.id;
  if v_used >= v_gifts + m.gift_bonus then
    return jsonb_build_object('state', 'used_up');
  end if;
  return jsonb_build_object('state', 'ok');
end $$;
revoke all on function public.waitlist_gift_peek(text) from public, anon, authenticated;
grant execute on function public.waitlist_gift_peek(text) to service_role;

-- The ONE place a gift is spent. Spending is exactly once: the order lock serialises every claim and the unique index on
-- the friend's folded inbox backs it. Returns the full picture (email, code) to the Edge Function, which strips it to
-- status/mailed before it answers a browser.
--   bad_email · none · open · off · account (nothing spent: they already have, or may make, an account) ·
--   again (their own pending claim: re-sent, never re-spent) · busy (gift_day) · used_up · claimed
create or replace function public.waitlist_gift_claim(p_code text, p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_e     text := lower(btrim(coalesce(p_email, '')));
  v_code  text := upper(btrim(coalesce(p_code, '')));
  v_norm  text;
  v_gifts int;
  v_day   int;
  v_inv   text;
  g       public.lynxr_signup_gate%rowtype;
  m       public.lynxr_members%rowtype;
  c       public.lynxr_gift_claims%rowtype;
begin
  if v_e !~ '^[^@[:space:]]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}$' or length(v_e) > 254 then
    return jsonb_build_object('status', 'bad_email');
  end if;
  if v_code !~ '^[A-HJ-NP-Z2-9]{8}$' then
    return jsonb_build_object('status', 'none');
  end if;

  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));
  perform public.lynxr_gift_prune();

  select * into g from public.lynxr_signup_gate where id = 1;
  if not found or not g.require_invite then
    return jsonb_build_object('status', 'open');
  end if;
  select s.gifts, s.gift_day into v_gifts, v_day from public.lynxr_waitlist_settings s where s.id = 1;
  v_gifts := coalesce(v_gifts, 3);
  v_day   := coalesce(v_day, 100);
  if v_gifts <= 0 then
    return jsonb_build_object('status', 'off');
  end if;
  select * into m from public.lynxr_members x where x.gift_code = v_code;
  if m.id is null then
    return jsonb_build_object('status', 'none');
  end if;

  v_norm := public.lynxr_wl_norm(v_e);
  select * into c from public.lynxr_gift_claims k where k.email_norm = v_norm;
  if c.id is not null then
    if c.redeemed_at is not null then
      return jsonb_build_object('status', 'account');
    end if;
    -- Their own pending claim: re-send, never re-spend.
    select i.code into v_inv
      from public.lynxr_invites i
     where lower(i.email) = c.email and i.redeemed_at is null
     order by i.created_at desc
     limit 1;
    if v_inv is null then
      v_inv := public.lynxr_wl_invite(c.email, 'gift');              -- the invite vanished: make it again
    end if;
    return jsonb_build_object('status', 'again', 'email', c.email, 'code', v_inv,
                              'may_mail', public.lynxr_wl_mail_ok(c.mailed_at, c.mail_day, c.mail_n));
  end if;

  -- Account route (nothing is spent): internal, a roster invite, an outstanding invite, or a real account.
  if (g.id is not null and v_e = any (g.internal))
     or exists (select 1 from public.lynxr_roster r where r.email = v_e and r.status = 'invited')
     or exists (select 1 from public.lynxr_invites i where lower(i.email) = v_e and i.redeemed_at is null)
     or exists (select 1 from auth.users u where lower(u.email) = v_e)
     or exists (select 1 from auth.users u where public.lynxr_wl_norm(u.email) = v_norm) then
    return jsonb_build_object('status', 'account');
  end if;

  if (select count(*) from public.lynxr_gift_claims k where k.created_at > now() - interval '24 hours') >= v_day then
    return jsonb_build_object('status', 'busy');
  end if;
  if (select count(*) from public.lynxr_gift_claims k where k.giver_id = m.id) >= v_gifts + m.gift_bonus then
    return jsonb_build_object('status', 'used_up');
  end if;

  insert into public.lynxr_gift_claims (giver_id, email, email_norm) values (m.id, v_e, v_norm);
  v_inv := public.lynxr_wl_invite(v_e, 'gift');
  -- A waitlister skips the line. Their sort_key is untouched, so a lapsed gift (lynxr_gift_prune) puts them back.
  update public.lynxr_waitlist w set released_at = now(), batch = -2
   where (w.email_norm = v_norm or w.email = v_e) and w.released_at is null and w.unsubscribed_at is null;
  return jsonb_build_object('status', 'claimed', 'email', v_e, 'code', v_inv, 'may_mail', true);
end $$;
revoke all on function public.waitlist_gift_claim(text, text) from public, anon, authenticated;
grant execute on function public.waitlist_gift_claim(text, text) to service_role;

-- The gift email went. Rolls the claim's "send it again" throttle exactly as waitlist_mark_mailed does for the queue,
-- and marks a gifted waitlister's release email as sent so "Send them" does not mail them a second, generic one.
create or replace function public.waitlist_gift_mark(p_email text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_e   text := lower(btrim(coalesce(p_email, '')));
  v_day date := (now() at time zone 'utc')::date;
begin
  if v_e = '' then
    return;
  end if;
  update public.lynxr_gift_claims k
     set mailed_at = now(),
         mail_n = case when k.mail_day = v_day then k.mail_n + 1 else 1 end,
         mail_day = v_day
   where k.email = v_e;
  update public.lynxr_waitlist w
     set release_mailed_at = coalesce(w.release_mailed_at, now())
   where w.batch = -2 and (w.email = v_e or w.email_norm = public.lynxr_wl_norm(v_e));
end $$;
revoke all on function public.waitlist_gift_mark(text) from public, anon, authenticated;
grant execute on function public.waitlist_gift_mark(text) to service_role;

-- A new account: link it to its gift claim, its crew edges and its waitlist title. Called by the lynxr_after_signup
-- trigger below (and by hand for an account made before the trigger existed). Takes the order lock (it writes the queue).
create or replace function public.lynxr_link_account(p_uid uuid, p_email text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_e     text;
  v_norm  text;
  v_giver uuid;
  v_ge    text;
begin
  if p_uid is null or p_email is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));
  v_e    := lower(btrim(p_email));
  v_norm := public.lynxr_wl_norm(v_e);

  -- 1. a gift claim becomes a joined friend, and the giver's crew grows
  update public.lynxr_gift_claims k set redeemed_at = now(), member_id = p_uid
   where k.email_norm = v_norm and k.redeemed_at is null
   returning k.giver_id into v_giver;
  if v_giver is not null then
    select lower(u.email) into v_ge from auth.users u where u.id = v_giver;
    insert into public.lynxr_crew (inviter_norm, member_norm, via, inviter_id, member_id)
    values (public.lynxr_wl_norm(v_ge), v_norm, 'gift', v_giver, p_uid)
    on conflict (member_norm, via) do update set member_id = excluded.member_id;
    perform public.lynxr_wl_title_check(public.lynxr_wl_norm(v_ge), v_ge, v_giver);
  end if;

  -- 2. their waitlist edge (made when they joined) and edges where they invited others now carry the account id
  update public.lynxr_crew set member_id  = p_uid where member_norm  = v_norm and member_id  is null;
  update public.lynxr_crew set inviter_id = p_uid where inviter_norm = v_norm and inviter_id is null;

  -- 3. carry a title earned on the waitlist
  insert into public.lynxr_members as m (id, title, title_at)
    select p_uid, w.title, w.title_at from public.lynxr_waitlist w
     where (w.email_norm = v_norm or w.email = v_e) and w.title is not null
     limit 1
  on conflict (id) do update
    set title = coalesce(m.title, excluded.title), title_at = coalesce(m.title_at, excluded.title_at);

  -- 4. a crew built while waiting may already qualify
  perform public.lynxr_wl_title_check(v_norm, v_e, p_uid);
end $$;
revoke all on function public.lynxr_link_account(uuid, text) from public, anon, authenticated;
grant execute on function public.lynxr_link_account(uuid, text) to service_role;

-- The after-sign-up bookkeeping. BOOKKEEPING MUST NEVER BLOCK A SIGN-UP: the whole body is wrapped, so a bug here costs a
-- crew edge or a title, never an account. The gate itself is enforce_signup_gate(), unchanged and BEFORE insert.
create or replace function public.lynxr_after_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is not null then
    begin
      perform public.lynxr_link_account(new.id, new.email);
    exception when others then
      raise warning 'lynxr_after_signup: %', sqlerrm;
    end;
  end if;
  return null;
end $$;
revoke all on function public.lynxr_after_signup() from public, anon, authenticated;
grant execute on function public.lynxr_after_signup() to supabase_auth_admin;

drop trigger if exists lynxr_after_signup on auth.users;
create trigger lynxr_after_signup
  after insert on auth.users
  for each row execute function public.lynxr_after_signup();

-- What the creator app's "Invite friends" view reads: the caller's OWN invite link and counts, nothing about who the
-- friends are. Makes the caller's member row and personal code on first call. The only function in this section a
-- browser may call; it answers null for anyone who is not signed in.
create or replace function public.my_gifts()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  s       public.lynxr_waitlist_settings%rowtype;
  g       public.lynxr_signup_gate%rowtype;
  m       public.lynxr_members%rowtype;
  v_code  text;
  v_e     text;
  v_used  int;
  v_join  int;
  v_total int;
begin
  if v_uid is null then
    return null;
  end if;
  select * into s from public.lynxr_waitlist_settings x where x.id = 1;
  select * into g from public.lynxr_signup_gate x where x.id = 1;
  if coalesce(s.gifts, 3) <= 0 then
    return jsonb_build_object('on', false);
  end if;

  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));
  perform public.lynxr_gift_prune();
  insert into public.lynxr_members (id) values (v_uid) on conflict do nothing;
  select * into m from public.lynxr_members x where x.id = v_uid for update;
  if m.gift_code is null then
    loop
      v_code := public.new_invite_code();
      exit when not exists (select 1 from public.lynxr_members x where x.gift_code = v_code);
    end loop;
    update public.lynxr_members x set gift_code = v_code where x.id = v_uid returning * into m;
  end if;

  select lower(u.email) into v_e from auth.users u where u.id = v_uid;
  select count(*)::int, (count(*) filter (where k.redeemed_at is not null))::int
    into v_used, v_join
    from public.lynxr_gift_claims k where k.giver_id = v_uid;
  v_total := coalesce(s.gifts, 3) + m.gift_bonus;

  return jsonb_build_object(
    'on', true,
    'gate_open', not coalesce(g.require_invite, false),
    'code', m.gift_code,
    'total', v_total,
    'left', greatest(0, v_total - v_used),
    'waiting', v_used - v_join,
    'joined', v_join,
    'crew', public.lynxr_wl_crew(public.lynxr_wl_norm(v_e), v_uid),
    'title', m.title);
end $$;
revoke all on function public.my_gifts() from public, anon;
grant execute on function public.my_gifts() to authenticated, service_role;

-- ── 1i3. A friend's join counts (owner, 2026-11-21) ──────────────────────────────────────────────────────────────────
-- Plan ~/.claude/plans/waitlist-no-confirm.md. Everyone is in line from the moment they join, and a friend's join moves the
-- referrer up. Same lock order as 1i: the advisory lock 'lynxr_waitlist_order' FIRST, then row locks. Everything here is
-- server-only (service_role, or the owner in the SQL editor): a browser reaches it only through the Edge Function.

-- Decides, ONCE, what one friend's join does for the person whose link brought them, records the decision on the FRIEND's
-- row (credit, credited_at) and returns it. Callers: waitlist_join (the friend joined or rejoined), waitlist_spot (the
-- friend first opened their link, only under credit_when = 'open') and lynxr_wl_from_confirm (the one-time switch).
-- The five words:
--   moved    the referrer moved up `places` positions, or was already #1: counted, and the crew grew
--   crew     counted in the crew but nobody moved: the referrer hit max_credits, or was already let in
--   none     nothing counted: the referrer left or does not exist, or this inbox already counted for someone (once, ever)
--   domain   the friend's address is on a disposable domain (settings.no_credit_domains)
--   day      the referrer already has settings.credit_day credited friends in the last 24 hours
-- Returns null (and writes nothing) when there is nothing to decide: no such row, no referrer, already decided, or left.
create or replace function public.lynxr_wl_credit_friend(p_email text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  f        public.lynxr_waitlist%rowtype;
  rf       public.lynxr_waitlist%rowtype;
  s        public.lynxr_waitlist_settings%rowtype;
  v_c      text;
  v_edge   int;
  v_before int;
  v_after  int;
begin
  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));
  select * into f from public.lynxr_waitlist x where x.email = p_email for update;
  if f.email is null or f.referred_by is null or f.credit is not null or f.unsubscribed_at is not null then
    return null;
  end if;
  select * into s from public.lynxr_waitlist_settings x where x.id = 1;
  select * into rf from public.lynxr_waitlist x where x.email = f.referred_by;
  if rf.email is null or rf.unsubscribed_at is not null then
    v_c := 'none';
  elsif split_part(lower(f.email), '@', 2) = any (coalesce(s.no_credit_domains, '{}'::text[])) then
    v_c := 'domain';
  elsif coalesce(s.credit_day, 0) > 0
        and (select count(*) from public.lynxr_waitlist x
              where x.referred_by = rf.email and x.credit in ('moved', 'crew')
                and x.credited_at > now() - interval '24 hours') >= s.credit_day then
    v_c := 'day';
  else
    insert into public.lynxr_crew (inviter_norm, member_norm, via, inviter_id, member_id)
    values (coalesce(rf.email_norm, public.lynxr_wl_norm(rf.email)), coalesce(f.email_norm, public.lynxr_wl_norm(f.email)),
            'waitlist',
            (select u.id from auth.users u where lower(u.email) = lower(rf.email) limit 1),
            (select u.id from auth.users u where lower(u.email) = lower(f.email) limit 1))
    on conflict (member_norm, via) do nothing;
    get diagnostics v_edge = row_count;
    if v_edge = 0 then
      v_c := 'none';                                   -- this inbox already counted for someone: once, ever
    else
      -- The crew edge and the title come first and do not depend on the move: a referrer who was already let in still
      -- gets their crew counted, but no move (waitlist_credit ignores released and left rows, and the cap).
      perform public.lynxr_wl_title_check(coalesce(rf.email_norm, public.lynxr_wl_norm(rf.email)), rf.email, null);
      v_before := rf.referrals;
      perform public.waitlist_credit(rf.email);         -- the existing move: exactly `places`, never above #1, the cap
      select x.referrals into v_after from public.lynxr_waitlist x where x.email = rf.email;
      v_c := case when coalesce(v_after, 0) > coalesce(v_before, 0) then 'moved' else 'crew' end;
    end if;
  end if;
  update public.lynxr_waitlist x
     set credit = v_c, credited_at = case when v_c in ('moved', 'crew') then now() else null end
   where x.email = f.email;
  return v_c;
end $$;
revoke all on function public.lynxr_wl_credit_friend(text) from public, anon, authenticated;
grant execute on function public.lynxr_wl_credit_friend(text) to service_role;

-- Moves a referrer BACK `places` positions, never past the back, and takes one off their referrals. Used by
-- waitlist_strip to undo a credit that moved them. A referrer who was let in, left or is not in line just loses the count.
create or replace function public.lynxr_wl_uncredit(p_email text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a        public.lynxr_waitlist%rowtype;
  v_places int := coalesce((select s.places from public.lynxr_waitlist_settings s where s.id = 1), 10);
  p        int;
  n        int;
  target   int;
  kprev    numeric;
  knext    numeric;
  newk     numeric;
begin
  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));
  select * into a from public.lynxr_waitlist w where w.email = p_email for update;
  if a.email is null then
    return;
  end if;
  if a.released_at is not null or a.unsubscribed_at is not null or a.confirmed_at is null then
    update public.lynxr_waitlist w set referrals = greatest(0, w.referrals - 1) where w.email = a.email;
    return;
  end if;
  p := public.lynxr_wl_position(a.sort_key);
  select count(*)::int into n from public.lynxr_waitlist w
   where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null;
  target := least(n, p + v_places);
  if target > p then
    select w.sort_key into kprev from public.lynxr_waitlist w
     where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null and w.email <> a.email
     order by w.sort_key offset target - 2 limit 1;
    knext := (select min(w.sort_key) from public.lynxr_waitlist w where w.sort_key > kprev and w.email <> a.email);
    -- nothing after kprev at all: a fresh key from the sequence is "the back" and can never collide with a new join's
    newk := case when knext is null then nextval('public.lynxr_waitlist_seq')::numeric else (kprev + knext) * 0.5 end;
    update public.lynxr_waitlist w set sort_key = newk, referrals = greatest(0, w.referrals - 1) where w.email = a.email;
  else
    update public.lynxr_waitlist w set referrals = greatest(0, w.referrals - 1) where w.email = a.email;
  end if;
end $$;
revoke all on function public.lynxr_wl_uncredit(text) from public, anon, authenticated;
grant execute on function public.lynxr_wl_uncredit(text) to service_role;

-- STAFF TOOL, run in the SQL editor (the owner is the only caller; every browser role is refused). Takes back what friends
-- earned a referrer. p_scope 'unseen' = only friends who never opened their email; 'all' = every credited friend. p_drop
-- also deletes those friends' entries, so fakes stop holding places and never get a release email; without it they stay in
-- line with credit = 'stripped'. A title earned with friends that were taken back goes too (the one exception to
-- "permanent once earned"). Answers {stripped, dropped, referrals, title, position} or {error: none | bad_scope}.
--   select public.waitlist_strip('<their email>');                    -- friends who never opened their email
--   select public.waitlist_strip('<their email>', 'all', true);       -- every credit, and delete those friends' entries
create or replace function public.waitlist_strip(p_referrer text, p_scope text default 'unseen', p_drop boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_e    text := lower(btrim(coalesce(p_referrer, '')));
  r      public.lynxr_waitlist%rowtype;
  f      record;
  v_uids uuid[];
  v_n    int := 0;
  v_d    int := 0;
  v_t    int;
  v_norm text;
  v_fn   text;
begin
  if coalesce(p_scope, '') not in ('unseen', 'all') then
    return jsonb_build_object('error', 'bad_scope');
  end if;
  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));
  select * into r from public.lynxr_waitlist w
   where w.email = v_e or w.email_norm = public.lynxr_wl_norm(v_e)
   order by (w.email = v_e) desc
   limit 1;
  if r.email is null then
    return jsonb_build_object('error', 'none');
  end if;
  v_norm := coalesce(r.email_norm, public.lynxr_wl_norm(r.email));
  select array_agg(distinct x.id) into v_uids from (
    select u.id from auth.users u where lower(u.email) = r.email
    union
    select c.inviter_id from public.lynxr_crew c where c.inviter_norm = v_norm and c.inviter_id is not null) x;
  for f in select w.email, w.email_norm, w.credit from public.lynxr_waitlist w
            where w.referred_by = r.email and w.credit in ('moved', 'crew') and (p_scope = 'all' or w.seen_at is null)
            order by w.created_at desc loop
    v_fn := coalesce(f.email_norm, public.lynxr_wl_norm(f.email));
    if f.credit = 'moved' then
      perform public.lynxr_wl_uncredit(r.email);
    end if;
    delete from public.lynxr_crew c where c.member_norm = v_fn and c.via = 'waitlist';
    if p_drop then
      delete from public.lynxr_crew c where c.inviter_norm = v_fn and c.inviter_id is null;
      delete from public.lynxr_waitlist w where w.email = f.email;
      v_d := v_d + 1;
    else
      update public.lynxr_waitlist w set credit = 'stripped' where w.email = f.email;
    end if;
    v_n := v_n + 1;
  end loop;
  -- a title earned with friends that were taken back goes too
  select coalesce(s.title_crew, 3) into v_t from public.lynxr_waitlist_settings s where s.id = 1;
  if v_t > 0 and public.lynxr_wl_crew(v_norm, v_uids[1]) < v_t then
    update public.lynxr_waitlist w set title = null, title_at = null where w.email = r.email;
    update public.lynxr_members m set title = null, title_at = null where m.id = any (coalesce(v_uids, '{}'::uuid[]));
  end if;
  select * into r from public.lynxr_waitlist w where w.email = r.email;
  return jsonb_build_object('stripped', v_n, 'dropped', v_d, 'referrals', r.referrals, 'title', r.title,
    'position', case when r.released_at is null and r.unsubscribed_at is null then public.lynxr_wl_position(r.sort_key) end);
end $$;
revoke all on function public.waitlist_strip(text, text, boolean) from public, anon, authenticated;
grant execute on function public.waitlist_strip(text, text, boolean) to service_role;

-- The optional invite name ("Maya is inviting you to lynxr"). First word only, 1 to 20 characters, no digits, control
-- characters or the punctuation listed (the table's lynxr_wl_name_shape check says the same, so a name cannot get in any
-- other way). An empty name clears it. Answers {ok: true, name?} | {ok: false, reason: 'bad_name' | 'none'}.
create or replace function public.waitlist_set_name(p_token text, p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n text := split_part(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), ' ', 1);
  n   int;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('ok', false, 'reason', 'none');
  end if;
  if v_n <> '' and (char_length(v_n) > 20 or v_n ~ '[[:cntrl:][:digit:]]'
                    or translate(v_n, '<>@/\:.,;!?#$%&*+=~^|"()[]{}_`', '') <> v_n) then
    return jsonb_build_object('ok', false, 'reason', 'bad_name');
  end if;
  update public.lynxr_waitlist w set display_name = nullif(v_n, '')
   where w.view_token = p_token and w.unsubscribed_at is null;
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('ok', false, 'reason', 'none');
  end if;
  return jsonb_strip_nulls(jsonb_build_object('ok', true, 'name', nullif(v_n, '')));
end $$;
revoke all on function public.waitlist_set_name(text, text) from public, anon, authenticated;
grant execute on function public.waitlist_set_name(text, text) to service_role;

-- What a friend's banner may show about a share code: the referrer's display name, nothing else. {} when there is none
-- (no name set, an unknown code, or the referrer left).
create or replace function public.waitlist_ref_name(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select jsonb_build_object('name', w.display_name) from public.lynxr_waitlist w
                    where w.ref_code = upper(btrim(coalesce(p_code, ''))) and w.unsubscribed_at is null
                      and w.display_name is not null limit 1), '{}'::jsonb);
$$;
revoke all on function public.waitlist_ref_name(text) from public, anon, authenticated;
grant execute on function public.waitlist_ref_name(text) to service_role;

-- The one-time switch from "confirm to count" to "join to count", run by section 1i4 (and by the self-test on made-up rows).
--   a. a friend who confirmed under the old rule: their referrer was dealt with then. Record it as decided.
--   b. a never-confirmed entry is in line from when it joined (same sort_key, so the same place).
--   c. the friends among those now credit whoever's link brought them, oldest first, by today's rules.
-- Returns how many friends step c looked at. Re-running it is harmless: every row it touches is then decided.
create or replace function public.lynxr_wl_from_confirm()
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('lynxr_waitlist_order'));
  update public.lynxr_waitlist w set credit = 'moved', credited_at = w.confirmed_at
   where w.referred_by is not null and w.confirmed_at is not null and w.confirm_token is null and w.credit is null;
  update public.lynxr_waitlist w set confirmed_at = w.created_at, confirm_token = null where w.confirmed_at is null;
  for r in select w.email from public.lynxr_waitlist w
            where w.referred_by is not null and w.credit is null and w.unsubscribed_at is null
            order by w.created_at, w.email loop
    perform public.lynxr_wl_credit_friend(r.email);
    n := n + 1;
  end loop;
  update public.lynxr_waitlist w set confirm_token = null where w.confirm_token is not null;
  return n;
end $$;
revoke all on function public.lynxr_wl_from_confirm() from public, anon, authenticated;
grant execute on function public.lynxr_wl_from_confirm() to service_role;

-- ── 1i4. From confirmation to join (once) ────────────────────────────────────────────────────────────────────────────
-- Runs on the first run of this revision and is a no-op on every run after it (from_confirm_at remembers). It is a REAL
-- write, outside the self-test's rollback: it puts never-confirmed entries in line at their original place and credits
-- their referrers.
do $$ begin
  if (select s.from_confirm_at from public.lynxr_waitlist_settings s where s.id = 1) is null then
    perform public.lynxr_wl_from_confirm();
    update public.lynxr_waitlist_settings set from_confirm_at = now() where id = 1;
  end if;
end $$;

-- ── 1j. SELF-TEST. Runs every time this file is run and WRITES NOTHING: the inner block raises LX001 at the end,
-- which rolls back everything it did (including the live rows it quiets and the sign-up switch it flips); the handler
-- turns that into a NOTICE. Any wrong answer raises a real error instead, and the whole file is rolled back — fix
-- before re-running. Probe addresses are all at example.invalid or throwaway.invalid (or a Gmail local part with a
-- hyphen, which Gmail cannot issue), so nothing here can be a real inbox. ─────────────────────────────────────────────
-- NOTE (2026-11-21): the one-time switch of section 1i4 is NOT inside this rollback; section 0 below tests the same function
-- on made-up rows. Positions in sections 3-5 count every entry in line, because everyone is in line from the moment they join.
do $$
declare
  g       public.lynxr_signup_gate%rowtype;
  v       text;
  ja jsonb; jb jsonb; jc jsonb; jd jsonb; je jsonb; jf jsonb; js jsonb; jr jsonb;
  pos_a   int; pos_b int; pos_b2 int; pos_c int; pos_c2 int; ref_b int; ref_d int;
  cnt     int; mx int; dist int;
  k_exp   int;
  jall4   jsonb := '[]'::jsonb;                                  -- every spot answer made in sections 3-5, for 4g
  -- section 0 (the one-time switch) and the guards of section 4
  o1_email text := 'wl-selftest-o1@example.invalid';
  o2_email text := 'wl-selftest-o2@example.invalid';
  o3_email text := 'wl-selftest-o3@example.invalid';
  x4a_email text := 'wl-selftest-x4a@example.invalid';
  x4b_email text := 'wl-selftest-x4b@throwaway.invalid';
  x4c_email text := 'wl-selftest-x4c@example.invalid';
  x4d_email text := 'wl-selftest-x4d@example.invalid';
  a_email text := 'wl-selftest-a@example.invalid';
  b_email text := 'wl-selftest-b@example.invalid';
  c_email text := 'wl-selftest-c@example.invalid';
  d_email text := 'wl-selftest-d@example.invalid';
  e_email text := 'wl-selftest-e@example.invalid';
  roster  text := 'wl-selftest-roster@example.invalid';
  inv     text := 'wl-selftest-inv@example.invalid';
  nobody  text := 'wl-selftest-nobody@example.invalid';
  emails  text[];
  m0      int;
  acct    text;
  -- sections 11-14 (plan beli B2)
  u_id    uuid;  v_id uuid;  accts uuid[];  u_mail text;  v_mail text;
  jg jsonb; jh jsonb; jk jsonb; jl jsonb; jq jsonb; jx1 jsonb; jx2 jsonb; jx3 jsonb; jn jsonb;
  r_tok   text;  r_code text;
  jall    jsonb := '[]'::jsonb;                                  -- every spot answer made in section 13, for 13g
  gcode   text;  vcode text;
  g1_email text := 'wl-selftest-g1@example.invalid';
  gw_email text := 'wl-selftest-gw@example.invalid';
  g3_email text := 'wl-selftest-g3@example.invalid';
  g4_email text := 'wl-selftest-g4@example.invalid';
  r_email  text := 'wl-selftest-r@example.invalid';
  r1_email text := 'wl-selftest-r1@example.invalid';
  r2_email text := 'wl-selftest-r2@example.invalid';
  r3_email text := 'wl-selftest-r3@example.invalid';
  s_email  text := 'wl-selftest-s@example.invalid';
begin
  begin
    -- Quiet every live row (rolled back below) so positions are deterministic, and pin the knobs to their defaults.
    update public.lynxr_waitlist set unsubscribed_at = coalesce(unsubscribed_at, now())
     where email not like '%@example.invalid';
    update public.lynxr_waitlist_settings
       set batch_size = 100, places = 10, max_credits = 20, credit_when = 'join', credit_day = 0,
           no_credit_domains = array['throwaway.invalid']
     where id = 1;

    -- 0. the one-time switch from confirmation to join, on made-up old-shape rows: o1 confirmed two days ago, o2 a friend of
    --    o1 who never confirmed (it still holds a confirm token), o3 a friend of o1 who confirmed under the old rule.
    insert into public.lynxr_waitlist (email, source, confirmed_at, created_at)
      values (o1_email, 'selftest', now() - interval '2 days', now() - interval '2 days');
    insert into public.lynxr_waitlist (email, source, confirmed_at, created_at, confirm_token, referred_by)
      values (o2_email, 'selftest', null, now() - interval '1 day', repeat('e', 32), o1_email);
    insert into public.lynxr_waitlist (email, source, confirmed_at, created_at, referred_by)
      values (o3_email, 'selftest', now() - interval '12 hours', now() - interval '12 hours', o1_email);
    cnt := public.lynxr_wl_from_confirm();
    if not exists (select 1 from public.lynxr_waitlist w where w.email = o2_email and w.confirmed_at = w.created_at
                      and w.confirm_token is null and w.credit = 'moved') then
      raise exception 'waitlist self-test 0a: a never-confirmed friend was not put in line and credited'; end if;
    if (select w.credit from public.lynxr_waitlist w where w.email = o3_email) is distinct from 'moved' then
      raise exception 'waitlist self-test 0b: a friend who had confirmed was not recorded as decided'; end if;
    if (select w.referrals from public.lynxr_waitlist w where w.email = o1_email) is distinct from 1 then
      raise exception 'waitlist self-test 0c: o1 should have exactly one credit (o2), got %',
        (select w.referrals from public.lynxr_waitlist w where w.email = o1_email); end if;
    if exists (select 1 from public.lynxr_waitlist w where w.email like 'wl-selftest-%' and w.confirm_token is not null) then
      raise exception 'waitlist self-test 0d: a confirm token survived the switch'; end if;
    if cnt < 1 then raise exception 'waitlist self-test 0e: the switch looked at % friends (want at least 1)', cnt; end if;
    update public.lynxr_waitlist set unsubscribed_at = now() where email like 'wl-selftest-o%';

    -- 1. norm
    if public.lynxr_wl_norm('J.Doe+x@GMail.com') <> 'jdoe@gmail.com' then
      raise exception 'waitlist self-test 1a: gmail fold gave %', public.lynxr_wl_norm('J.Doe+x@GMail.com'); end if;
    if public.lynxr_wl_norm('a.b+c@googlemail.com') <> 'ab@gmail.com' then
      raise exception 'waitlist self-test 1b: googlemail fold gave %', public.lynxr_wl_norm('a.b+c@googlemail.com'); end if;
    if public.lynxr_wl_norm('a+b@outlook.com') <> 'a@outlook.com' then
      raise exception 'waitlist self-test 1c: outlook fold gave %', public.lynxr_wl_norm('a+b@outlook.com'); end if;
    if public.lynxr_wl_norm('a.b+b@example.com') <> 'a.b+b@example.com' then
      raise exception 'waitlist self-test 1d: an unlisted domain was folded: %', public.lynxr_wl_norm('a.b+b@example.com'); end if;
    if public.lynxr_wl_norm('delivered+x@resend.dev') <> 'delivered+x@resend.dev' then
      raise exception 'waitlist self-test 1e: a test label was folded'; end if;

    -- 2. the gate
    select * into g from public.lynxr_signup_gate where id = 1;
    if not found then raise exception 'waitlist self-test 2: no lynxr_signup_gate row'; end if;
    if (select count(*) from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'lynxr_signup_gate' and not tgisinternal) <> 1 then
      raise exception 'waitlist self-test 2a: the sign-up trigger is not installed once'; end if;
    if exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'lynxr_signup_seats' and not tgisinternal) then
      raise exception 'waitlist self-test 2b: the stray lynxr_signup_seats trigger is still there'; end if;
    if (select count(*) from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'lynxr_after_signup' and not tgisinternal) <> 1 then
      raise exception 'waitlist self-test 2m: the after-sign-up trigger is not installed once'; end if;
    update public.lynxr_signup_gate set require_invite = true where id = 1;
    insert into public.lynxr_roster (email, status) values (roster, 'invited');
    insert into public.lynxr_invites (email, code, note) values (inv, 'ABCDEFGH', 'selftest');
    v := public.lynxr_signup_verdict(nobody, 'email', '');
    if v <> 'no_invite' then raise exception 'waitlist self-test 2c: stranger got %', v; end if;
    v := public.lynxr_signup_verdict(nobody, 'google', null);
    if v <> 'no_invite' then raise exception 'waitlist self-test 2d: a stranger with Google got %', v; end if;
    v := public.lynxr_signup_verdict(roster, 'email', null);
    if v <> 'ok' then raise exception 'waitlist self-test 2e: a roster-invited email got %', v; end if;
    v := public.lynxr_signup_verdict(upper(roster), 'google', null);
    if v <> 'ok' then raise exception 'waitlist self-test 2f: a roster-invited email (Google, shouting) got %', v; end if;
    v := public.lynxr_signup_verdict(inv, 'email', null);
    if v <> 'bad_code' then raise exception 'waitlist self-test 2g: invite, no code got %', v; end if;
    v := public.lynxr_signup_verdict(inv, 'email', 'ZZZZZZZZ');
    if v <> 'bad_code' then raise exception 'waitlist self-test 2h: invite, wrong code got %', v; end if;
    v := public.lynxr_signup_verdict(inv, 'email', 'abcdefgh');
    if v <> 'invite' then raise exception 'waitlist self-test 2i: invite, right code got %', v; end if;
    v := public.lynxr_signup_verdict(inv, 'google', null);
    if v <> 'invite' then raise exception 'waitlist self-test 2j: invite via Google got %', v; end if;
    if coalesce(array_length(g.internal, 1), 0) > 0 then
      v := public.lynxr_signup_verdict(g.internal[1], 'email', null);
      if v <> 'ok' then raise exception 'waitlist self-test 2k: an internal address got %', v; end if;
    end if;
    update public.lynxr_signup_gate set require_invite = false where id = 1;
    v := public.lynxr_signup_verdict(nobody, 'email', null);
    if v <> (case when (select count(*) from auth.users u where lower(u.email) <> all (g.internal)) >= g.seats
                  then 'full' else 'ok' end) then
      raise exception 'waitlist self-test 2l: with require_invite off a stranger got %', v; end if;
    update public.lynxr_signup_gate set require_invite = true where id = 1;

    -- 3. join. Fifteen in-line rows first (the line A joins the back of), then A, B (A's link), C, D (A's link), E (B's link).
    --    Since 2026-11-21 a join puts the person in line at once and a friend's join moves their referrer up at once. Pattern
    --    for every friend join from here on: read the referrer's position p0 with waitlist_spot first, then check that it is
    --    greatest(1, p0 - 10) after the join and that referrals went up by one.
    insert into public.lynxr_waitlist (email, source, confirmed_at)
      select 'wl-selftest-f' || x || '@example.invalid', 'selftest', now() from generate_series(1, 15) x;
    jr := public.waitlist_join('not an email', '', 'selftest', '');
    if jr->>'status' <> 'bad_email' then raise exception 'waitlist self-test 3a: bad email gave %', jr; end if;
    ja := public.waitlist_join(upper(a_email), '', 'Self Test!', 'waitlist-queue-v3');
    if ja->>'status' <> 'new' then raise exception 'waitlist self-test 3b: A gave %', ja; end if;
    if ja->>'kind' <> 'spot' or ja ? 'confirm_token' then
      raise exception 'waitlist self-test 3b2: a new join must answer kind spot and carry no confirm token: %', ja; end if;
    if not exists (select 1 from public.lynxr_waitlist w where w.email = a_email and w.confirmed_at is not null and w.credit is null) then
      raise exception 'waitlist self-test 3b3: A is not in line at once, or already has a credit'; end if;
    if (select source from public.lynxr_waitlist where email = a_email) <> 'selftest' then
      raise exception 'waitlist self-test 3c: source was not cleaned'; end if;
    if (ja->>'position')::int <> 16 then raise exception 'waitlist self-test 3d: A position % (want 16)', ja->>'position'; end if;

    js := public.waitlist_spot(ja->>'view_token', null);   jall4 := jall4 || js;
    pos_a := (js->>'position')::int;
    if pos_a <> 16 then raise exception 'waitlist self-test 3d2: A should be #16 before any friend, got %', js; end if;
    jb := public.waitlist_join(b_email, lower(ja->>'ref_code'), 'selftest', '');
    if jb->>'status' <> 'new' then raise exception 'waitlist self-test 3e: B gave %', jb; end if;
    if (select referred_by from public.lynxr_waitlist where email = b_email) is distinct from a_email then
      raise exception 'waitlist self-test 3f: B was not tied to A''s share code'; end if;
    if (select credit from public.lynxr_waitlist where email = b_email) is distinct from 'moved'
       or not exists (select 1 from public.lynxr_crew c where c.member_norm = public.lynxr_wl_norm(b_email) and c.via = 'waitlist'
                         and c.inviter_norm = public.lynxr_wl_norm(a_email)) then
      raise exception 'waitlist self-test 3f2: B''s join did not count (credit moved + a crew edge)'; end if;
    js := public.waitlist_spot(ja->>'view_token', null);   jall4 := jall4 || js;
    if (js->>'position')::int <> greatest(1, pos_a - 10) or (js->>'referrals')::int <> 1 then
      raise exception 'waitlist self-test 3f3: A should be #% with 1 referral after B joined, got %', greatest(1, pos_a - 10), js; end if;

    jc := public.waitlist_join(c_email, 'nonsense', 'selftest', '');
    if jc->>'status' <> 'new' or (select referred_by from public.lynxr_waitlist where email = c_email) is not null
       or (select credit from public.lynxr_waitlist where email = c_email) is not null then
      raise exception 'waitlist self-test 3g: C gave % / a bad share code was kept', jc; end if;

    pos_a := (js->>'position')::int;
    jd := public.waitlist_join(d_email, ja->>'ref_code', 'selftest', '');                 -- D joins: A (#6) goes to #1, not above
    if jd->>'status' <> 'new' then raise exception 'waitlist self-test 3h: D gave %', jd; end if;
    js := public.waitlist_spot(ja->>'view_token', null);   jall4 := jall4 || js;
    if (js->>'position')::int <> greatest(1, pos_a - 10) or (js->>'position')::int <> 1 or (js->>'referrals')::int <> 2 then
      raise exception 'waitlist self-test 3h2: a referrer at #6 should land at exactly #1 with 2 referrals, got %', js; end if;
    if (select min(w.sort_key) from public.lynxr_waitlist w) <> (select w.sort_key from public.lynxr_waitlist w where w.email = a_email) then
      raise exception 'waitlist self-test 3h3: A is not the first key'; end if;

    js := public.waitlist_spot(jb->>'view_token', null);   jall4 := jall4 || js;
    pos_b := (js->>'position')::int;  ref_b := (js->>'referrals')::int;                   -- B: 17 and 0
    je := public.waitlist_join(e_email, jb->>'ref_code', 'selftest', '');                 -- E joins with B's link: B moves
    if je->>'status' <> 'new' then raise exception 'waitlist self-test 3h4: E gave %', je; end if;
    js := public.waitlist_spot(jb->>'view_token', null);   jall4 := jall4 || js;
    if (js->>'position')::int <> greatest(1, pos_b - 10) or (js->>'referrals')::int <> ref_b + 1 then
      raise exception 'waitlist self-test 3h5: B should be #% with % referrals after E joined, got %', greatest(1, pos_b - 10), ref_b + 1, js; end if;

    jr := public.waitlist_join(a_email, ja->>'ref_code', 'selftest', '');
    if jr->>'status' <> 'exists' or jr->>'kind' <> 'spot' then raise exception 'waitlist self-test 3i: A again gave %', jr; end if;
    if (select referred_by from public.lynxr_waitlist where email = a_email) is not null then
      raise exception 'waitlist self-test 3j: A became their own referral'; end if;
    jr := public.waitlist_join('wl-self.test@gmail.com', '', 'selftest', '');
    if jr->>'status' <> 'new' then raise exception 'waitlist self-test 3k: gmail A gave %', jr; end if;
    jr := public.waitlist_join('wl-selftest@gmail.com', '', 'selftest', '');
    if jr->>'status' <> 'exists' then raise exception 'waitlist self-test 3l: the gmail-dot variant gave %', jr; end if;
    jr := public.waitlist_join(roster, '', 'selftest', '');
    if jr->>'status' <> 'account' then raise exception 'waitlist self-test 3m: a roster address gave %', jr; end if;
    jr := public.waitlist_join(inv, '', 'selftest', '');
    if jr->>'status' <> 'account' then raise exception 'waitlist self-test 3n: an invited address gave %', jr; end if;
    if exists (select 1 from public.lynxr_waitlist where email in (roster, inv)) then
      raise exception 'waitlist self-test 3o: the account route wrote a row'; end if;
    select count(*), count(distinct public.lynxr_wl_position(w.sort_key)), max(public.lynxr_wl_position(w.sort_key))
      into cnt, dist, mx
      from public.lynxr_waitlist w
     where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null;
    if cnt <> 21 or dist <> cnt or mx <> cnt then
      raise exception 'waitlist self-test 3p: positions are not 1..21 exactly once (count %, distinct %, max %)', cnt, dist, mx; end if;

    -- 4. the guards, and who sees what. Each knob is put back right after its check.
    js := public.waitlist_spot(jb->>'view_token', null);   jall4 := jall4 || js;
    pos_b := (js->>'position')::int;  ref_b := (js->>'referrals')::int;                   -- B: 7 and 1
    -- 4a the cap: a friend still counts for the crew, but nobody moves
    update public.lynxr_waitlist_settings set max_credits = 0 where id = 1;
    jf := public.waitlist_join(x4a_email, jb->>'ref_code', 'selftest', '');
    update public.lynxr_waitlist_settings set max_credits = 20 where id = 1;
    js := public.waitlist_spot(jb->>'view_token', null);   jall4 := jall4 || js;
    if jf->>'status' <> 'new' or (select credit from public.lynxr_waitlist where email = x4a_email) is distinct from 'crew'
       or (js->>'position')::int <> pos_b or (js->>'referrals')::int <> ref_b
       or not exists (select 1 from public.lynxr_crew c where c.member_norm = public.lynxr_wl_norm(x4a_email) and c.via = 'waitlist') then
      raise exception 'waitlist self-test 4a: with max_credits = 0 a friend should count as crew and move nobody (credit %, B %)',
        (select credit from public.lynxr_waitlist where email = x4a_email), js; end if;
    -- 4b a disposable domain: recorded, earns nothing
    jg := public.waitlist_join(x4b_email, jb->>'ref_code', 'selftest', '');
    js := public.waitlist_spot(jb->>'view_token', null);   jall4 := jall4 || js;
    if jg->>'status' <> 'new' or (select credit from public.lynxr_waitlist where email = x4b_email) is distinct from 'domain'
       or (js->>'position')::int <> pos_b or (js->>'referrals')::int <> ref_b
       or exists (select 1 from public.lynxr_crew c where c.member_norm = public.lynxr_wl_norm(x4b_email)) then
      raise exception 'waitlist self-test 4b: a disposable-domain friend should earn nothing (credit %, B %)',
        (select credit from public.lynxr_waitlist where email = x4b_email), js; end if;
    -- 4c the per-person daily limit
    update public.lynxr_waitlist_settings set credit_day = 1 where id = 1;
    jh := public.waitlist_join(x4c_email, jb->>'ref_code', 'selftest', '');
    update public.lynxr_waitlist_settings set credit_day = 0 where id = 1;
    js := public.waitlist_spot(jb->>'view_token', null);   jall4 := jall4 || js;
    if jh->>'status' <> 'new' or (select credit from public.lynxr_waitlist where email = x4c_email) is distinct from 'day'
       or (js->>'position')::int <> pos_b or (js->>'referrals')::int <> ref_b
       or exists (select 1 from public.lynxr_crew c where c.member_norm = public.lynxr_wl_norm(x4c_email)) then
      raise exception 'waitlist self-test 4c: past credit_day a friend should earn nothing (credit %, B %)',
        (select credit from public.lynxr_waitlist where email = x4c_email), js; end if;
    -- 4d credit_when = 'open': nothing at join, the move happens the first time the friend opens their link, once
    update public.lynxr_waitlist_settings set credit_when = 'open' where id = 1;
    jk := public.waitlist_join(x4d_email, jb->>'ref_code', 'selftest', '');
    js := public.waitlist_spot(jb->>'view_token', null);   jall4 := jall4 || js;
    if jk->>'status' <> 'new' or (select credit from public.lynxr_waitlist where email = x4d_email) is not null
       or (js->>'position')::int <> pos_b or (js->>'referrals')::int <> ref_b then
      raise exception 'waitlist self-test 4d: under credit_when = open a join must not count yet (B %)', js; end if;
    js := public.waitlist_spot(jk->>'view_token', null);   jall4 := jall4 || js;           -- the friend opens their link
    if (select seen_at from public.lynxr_waitlist where email = x4d_email) is null
       or (select credit from public.lynxr_waitlist where email = x4d_email) is distinct from 'moved' then
      raise exception 'waitlist self-test 4d2: opening the link did not count the friend (credit %)',
        (select credit from public.lynxr_waitlist where email = x4d_email); end if;
    js := public.waitlist_spot(jb->>'view_token', null);   jall4 := jall4 || js;
    if (js->>'position')::int <> greatest(1, pos_b - 10) or (js->>'referrals')::int <> ref_b + 1 then
      raise exception 'waitlist self-test 4d3: B should be #% with % referrals after the friend opened, got %', greatest(1, pos_b - 10), ref_b + 1, js; end if;
    js := public.waitlist_spot(jk->>'view_token', null);   jall4 := jall4 || js;           -- a second load changes nothing
    update public.lynxr_waitlist_settings set credit_when = 'join' where id = 1;
    jr := public.waitlist_spot(jb->>'view_token', null);   jall4 := jall4 || jr;
    if (jr->>'position')::int <> greatest(1, pos_b - 10) or (jr->>'referrals')::int <> ref_b + 1 then
      raise exception 'waitlist self-test 4d4: a second open counted the friend again: %', jr; end if;
    -- 4e seen_at is only ever the first open; 4f the old confirm token is ignored, not an error
    if (select seen_at from public.lynxr_waitlist where email = a_email) is null
       or (select seen_at from public.lynxr_waitlist where email = c_email) is not null then
      raise exception 'waitlist self-test 4e: seen_at should be set for A (opened) and empty for C (never opened)'; end if;
    js := public.waitlist_spot(jc->>'view_token', repeat('0', 32));   jall4 := jall4 || js;
    if js->>'state' <> 'waiting' then raise exception 'waitlist self-test 4f: an ignored confirm token changed the answer: %', js; end if;
    -- 4g no spot answer made in sections 3-5 carries a secret or the retired just_confirmed
    -- (checked at the end of section 5, below)

    -- 5. leaving
    js := public.waitlist_spot(jc->>'view_token', null);   jall4 := jall4 || js;
    pos_c := (js->>'position')::int;                                                      -- C is behind A, B and the fifteen
    if public.waitlist_stop(ja->>'view_token') is not true then raise exception 'waitlist self-test 5a: stop returned false'; end if;
    if public.waitlist_stop(ja->>'view_token') is not false then raise exception 'waitlist self-test 5b: stop was not idempotent'; end if;
    js := public.waitlist_spot(ja->>'view_token', null);   jall4 := jall4 || js;
    if js->>'state' <> 'left' or js->>'position' is not null then raise exception 'waitlist self-test 5c: A after stop: %', js; end if;
    js := public.waitlist_spot(jc->>'view_token', null);   jall4 := jall4 || js;
    pos_c2 := (js->>'position')::int;
    if pos_c2 <> pos_c - 1 then raise exception 'waitlist self-test 5d: C should move up one when A leaves (% -> %)', pos_c, pos_c2; end if;
    -- A rejoins with C's link: in line at the back at once, and C is credited
    jr := public.waitlist_join(a_email, jc->>'ref_code', 'selftest', 'waitlist-queue-v3');
    js := public.waitlist_spot(ja->>'view_token', null);   jall4 := jall4 || js;
    select count(*) into cnt from public.lynxr_waitlist w
     where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null;
    if jr->>'status' <> 'exists' or jr->>'kind' <> 'spot' or js->>'state' <> 'waiting' or (js->>'position')::int <> cnt then
      raise exception 'waitlist self-test 5e: A rejoining should be waiting at the back (#%): % / %', cnt, jr, js; end if;
    if (select credit from public.lynxr_waitlist where email = a_email) is distinct from 'moved' then
      raise exception 'waitlist self-test 5e2: A rejoining with C''s link did not credit C'; end if;
    js := public.waitlist_spot(jc->>'view_token', null);   jall4 := jall4 || js;
    if (js->>'position')::int <> greatest(1, pos_c2 - 10) or (js->>'referrals')::int <> 1 then
      raise exception 'waitlist self-test 5e3: C should be #% with 1 referral after A rejoined, got %', greatest(1, pos_c2 - 10), js; end if;
    -- A leaves and rejoins with D's link: one inbox counts once, so D gets nothing
    if not public.waitlist_stop(ja->>'view_token') then raise exception 'waitlist self-test 5f'; end if;
    ref_d := (select referrals from public.lynxr_waitlist where email = d_email);
    jr := public.waitlist_join(a_email, jd->>'ref_code', 'selftest', '');
    if jr->>'status' <> 'exists' or (select referrals from public.lynxr_waitlist where email = d_email) is distinct from ref_d then
      raise exception 'waitlist self-test 5g: the same inbox counted twice (D % -> %)', ref_d,
        (select referrals from public.lynxr_waitlist where email = d_email); end if;
    if not public.waitlist_stop(ja->>'view_token') then raise exception 'waitlist self-test 5h'; end if;
    -- 4g (the collected answers)
    if jall4::text ~ '"(email|view_token|confirm_token|code|just_confirmed)":' then
      raise exception 'waitlist self-test 4g: a spot answer carried a secret: %', jall4; end if;

    -- 6. mail bookkeeping and the throttle
    jr := public.waitlist_mail_info(jd->>'view_token');
    if jr->>'ok' <> 'true' or jr->>'kind' <> 'spot' or jr->>'code' is not null or jr ? 'confirm_token' then
      raise exception 'waitlist self-test 6a: mail_info for D gave %', jr; end if;
    perform public.waitlist_mark_mailed(array[d_email], 'spot');
    jr := public.waitlist_mail_info(jd->>'view_token');
    if jr->>'ok' <> 'false' or (jr->>'wait_s')::int not between 1 and 900 then
      raise exception 'waitlist self-test 6b: a second mail inside 15 minutes was allowed: %', jr; end if;
    jr := public.waitlist_join(d_email, '', 'selftest', '');
    if jr->>'status' <> 'exists' or (jr->>'may_mail')::boolean is not false then
      raise exception 'waitlist self-test 6c: join did not throttle D''s mail: %', jr; end if;
    perform public.waitlist_mark_mailed(array[d_email], 'pending');
    if (select mail_pending from public.lynxr_waitlist where email = d_email) is not true then
      raise exception 'waitlist self-test 6d: pending was not recorded'; end if;
    perform public.waitlist_mark_mailed(array[d_email], 'spot');
    if (select mail_pending from public.lynxr_waitlist where email = d_email) is not false then
      raise exception 'waitlist self-test 6e: a sent mail did not clear pending'; end if;
    jr := public.waitlist_mail_info(repeat('0', 32));
    if jr->>'ok' <> 'false' then raise exception 'waitlist self-test 6f: an unknown token got mail: %', jr; end if;

    -- 7. release: a dry run writes nothing; a real one releases exactly p_n, in order, with a usable invite each
    select coalesce(max(w.batch), 0) + 1 into k_exp from public.lynxr_waitlist w where w.batch > 0;
    jr := public.waitlist_release(3, true);
    if (jr->>'count')::int <> 3 or (jr->>'batch')::int <> k_exp then raise exception 'waitlist self-test 7a: dry run gave %', jr; end if;
    if exists (select 1 from public.lynxr_waitlist where email like 'wl-selftest-%' and released_at is not null) then
      raise exception 'waitlist self-test 7b: the dry run wrote a released_at'; end if;
    if jr->'rows' is not null then raise exception 'waitlist self-test 7c: the dry run returned codes'; end if;
    jr := public.waitlist_release(3, false);
    if (jr->>'batch')::int <> k_exp or jsonb_array_length(jr->'rows') <> 3 then raise exception 'waitlist self-test 7d: release gave %', jr; end if;
    select array_agg(x->>'email') into emails from jsonb_array_elements(jr->'rows') x;
    if exists (select 1 from jsonb_array_elements(jr->'rows') x where length(x->>'code') <> 8) then
      raise exception 'waitlist self-test 7e: a released row has no usable code: %', jr; end if;
    if (select count(*) from public.lynxr_invites i
         where i.email = any (emails) and i.redeemed_at is null and i.note = 'waitlist batch ' || k_exp) <> 3 then
      raise exception 'waitlist self-test 7f: the invites were not written'; end if;
    if (select count(*) from public.lynxr_waitlist w where w.email = any (emails) and w.released_at is not null and w.batch = k_exp) <> 3 then
      raise exception 'waitlist self-test 7g: the rows were not stamped released'; end if;
    if (select min(w.sort_key) from public.lynxr_waitlist w
         where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null)
       < (select max(w.sort_key) from public.lynxr_waitlist w where w.email = any (emails)) then
      raise exception 'waitlist self-test 7h: someone behind a released row was ahead of it'; end if;
    jr := public.waitlist_release(3, false);
    if jr->>'error' <> 'too_soon' then raise exception 'waitlist self-test 7i: a double press gave %', jr; end if;
    jr := public.waitlist_release(0, true);
    if jr->>'error' <> 'bad_n' then raise exception 'waitlist self-test 7j: n = 0 gave %', jr; end if;
    jr := public.waitlist_unmailed();
    if (select count(*) from jsonb_array_elements(jr->'rows') x where x->>'email' = any (emails)) <> 3 then
      raise exception 'waitlist self-test 7k: unmailed did not list the batch: %', jr; end if;
    perform public.waitlist_mark_mailed(emails, 'release');
    jr := public.waitlist_unmailed();
    if exists (select 1 from jsonb_array_elements(jr->'rows') x where x->>'email' = any (emails)) then
      raise exception 'waitlist self-test 7l: a mailed release is still listed'; end if;
    jr := public.waitlist_join(emails[1], '', 'selftest', '');
    if jr->>'status' <> 'account' then raise exception 'waitlist self-test 7m: a released address gave %', jr; end if;

    -- 8. let one person in
    jr := public.waitlist_let_in('nope');
    if jr->>'status' <> 'bad_email' then raise exception 'waitlist self-test 8a: %', jr; end if;
    jr := public.waitlist_let_in('wl-selftest-let@example.invalid');
    if jr->>'status' <> 'ok' or length(jr->>'code') <> 8 or jr->>'view_token' is not null then
      raise exception 'waitlist self-test 8b: let-in of a stranger gave %', jr; end if;
    js := public.waitlist_let_in('wl-selftest-let@example.invalid');
    if js->>'code' <> jr->>'code' then raise exception 'waitlist self-test 8c: a second let-in changed the code'; end if;
    js := public.waitlist_let_in(c_email);
    if js->>'status' <> 'ok' or js->>'view_token' <> jc->>'view_token'
       or (select batch from public.lynxr_waitlist where email = c_email) <> -1 then
      raise exception 'waitlist self-test 8d: let-in of a waitlister gave %', js; end if;
    select lower(u.email) into acct from auth.users u where u.email is not null limit 1;
    if acct is not null and acct ~ '^[^@[:space:]]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}$' then
      js := public.waitlist_let_in(acct);
      if js->>'status' <> 'has_account' then raise exception 'waitlist self-test 8e: let-in of an account gave %', js; end if;
    end if;

    -- 9. the meter
    v := public.waitlist_take(repeat('a', 32), 'selftest', 2, 5, 3);
    if v <> 'ok' then raise exception 'waitlist self-test 9a: %', v; end if;
    v := public.waitlist_take(repeat('a', 32), 'selftest', 2, 5, 3);
    if v <> 'ok' then raise exception 'waitlist self-test 9b: %', v; end if;
    v := public.waitlist_take(repeat('a', 32), 'selftest', 2, 5, 3);
    if v <> 'ip_hour' then raise exception 'waitlist self-test 9c: expected ip_hour, got %', v; end if;
    v := public.waitlist_take(repeat('b', 32), 'selftest', 2, 5, 3);
    if v <> 'ok' then raise exception 'waitlist self-test 9d: %', v; end if;
    v := public.waitlist_take(repeat('c', 32), 'selftest', 2, 5, 3);
    if v <> 'all_day' then raise exception 'waitlist self-test 9e: expected all_day, got %', v; end if;
    v := public.waitlist_take(repeat('d', 32), 'selftestd', 10, 1, 100);
    if v <> 'ok' then raise exception 'waitlist self-test 9f: %', v; end if;
    v := public.waitlist_take(repeat('d', 32), 'selftestd', 10, 1, 100);
    if v <> 'ip_day' then raise exception 'waitlist self-test 9g: expected ip_day, got %', v; end if;
    v := public.waitlist_take('203.0.113.7', 'selftest', 10, 10, 100);
    if v <> 'bad_ip' then raise exception 'waitlist self-test 9h: a raw IP was accepted: %', v; end if;
    m0 := coalesce((select m.n from public.lynxr_waitlist_meter m where m.bucket = 'mail-all:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD')), 0);
    if public.waitlist_mail_take(3, m0 + 5) <> 3 or public.waitlist_mail_take(4, m0 + 5) <> 2 or public.waitlist_mail_take(1, m0 + 5) <> 0 then
      raise exception 'waitlist self-test 9i: the daily mail cap did not hold'; end if;

    -- 10. who may call what
    if has_function_privilege('anon',          'public.waitlist_join(text,text,text,text)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_join(text,text,text,text)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_spot(text,text)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_spot(text,text)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_release(int,boolean)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_release(int,boolean)', 'execute')
    or has_function_privilege('anon',          'public.lynxr_signup_verdict(text,text,text)', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_signup_verdict(text,text,text)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_let_in(text)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_let_in(text)', 'execute')
    or has_function_privilege('anon',          'public.staff_waitlist_stats()', 'execute')
    or has_function_privilege('anon',          'public.lynxr_wl_credit_friend(text)', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_wl_credit_friend(text)', 'execute')
    or has_function_privilege('anon',          'public.lynxr_wl_uncredit(text)', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_wl_uncredit(text)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_strip(text,text,boolean)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_strip(text,text,boolean)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_set_name(text,text)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_set_name(text,text)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_ref_name(text)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_ref_name(text)', 'execute')
    or has_function_privilege('anon',          'public.lynxr_wl_from_confirm()', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_wl_from_confirm()', 'execute') then
      raise exception 'waitlist self-test 10a: a browser role can call a server-only function'; end if;
    if not has_function_privilege('service_role', 'public.waitlist_join(text,text,text,text)', 'execute')
    or not has_function_privilege('authenticated', 'public.staff_waitlist_stats()', 'execute') then
      raise exception 'waitlist self-test 10b: service_role or staff cannot call what they need'; end if;
    if has_table_privilege('anon', 'public.lynxr_waitlist', 'insert')
    or has_table_privilege('anon', 'public.lynxr_waitlist', 'select')
    or has_table_privilege('authenticated', 'public.lynxr_waitlist', 'insert')
    or has_table_privilege('authenticated', 'public.lynxr_waitlist', 'update')
    or has_table_privilege('authenticated', 'public.lynxr_waitlist', 'delete') then
      raise exception 'waitlist self-test 10c: a browser role can write or read lynxr_waitlist as a whole'; end if;
    if has_column_privilege('authenticated', 'public.lynxr_waitlist', 'view_token', 'select')
    or has_column_privilege('authenticated', 'public.lynxr_waitlist', 'confirm_token', 'select')
    or has_column_privilege('authenticated', 'public.lynxr_waitlist', 'ref_code', 'select')
    or has_column_privilege('anon', 'public.lynxr_waitlist', 'email', 'select') then
      raise exception 'waitlist self-test 10d: a browser role can read a token'; end if;
    if has_table_privilege('anon', 'public.lynxr_waitlist_meter', 'select')
    or has_table_privilege('authenticated', 'public.lynxr_waitlist_meter', 'select')
    or has_table_privilege('anon', 'public.lynxr_waitlist_settings', 'select') then
      raise exception 'waitlist self-test 10e: a browser role can read the meter or the settings'; end if;
    if public.staff_waitlist_stats() is not null then
      raise exception 'waitlist self-test 10f: staff_waitlist_stats answered with no signed-in staff'; end if;

    -- 11. settings and Discord. gift_day is set high so real claims from the last 24 h never trip "busy"; 12j lowers it
    --     on purpose. (Absent-key checks use  x->'key' is not null : a missing key and a stripped null both read SQL null.)
    update public.lynxr_waitlist_settings set gifts = 3, gift_day = 100000, title_crew = 3, discord_url = null where id = 1;
    begin
      update public.lynxr_waitlist_settings set discord_url = 'https://evil.example/x' where id = 1;
      raise exception 'waitlist self-test 11a: a non-Discord URL was accepted';   -- a plain raise is not a check_violation
    exception when check_violation then
      null;
    end;
    begin
      update public.lynxr_waitlist_settings set discord_url = 'https://discord.gg/lynxrtest' where id = 1;
      update public.lynxr_waitlist_settings set discord_url = 'https://discord.com/invite/lynxr-test' where id = 1;
    exception when check_violation then
      raise exception 'waitlist self-test 11b: a Discord invite link was refused';
    end;
    update public.lynxr_waitlist_settings set discord_url = 'https://discord.gg/lynxrtest' where id = 1;
    js := public.waitlist_spot(jd->>'view_token', null);                            -- D, confirmed in section 4
    if js->>'state' <> 'waiting' or js->>'discord' is distinct from 'https://discord.gg/lynxrtest' then
      raise exception 'waitlist self-test 11c: the spot answer should carry the Discord link, got %', js; end if;
    update public.lynxr_waitlist_settings set discord_url = null where id = 1;
    js := public.waitlist_spot(jd->>'view_token', null);
    if js->'discord' is not null then
      raise exception 'waitlist self-test 11d: with no Discord link the key should be absent, got %', js; end if;
    begin
      update public.lynxr_waitlist_settings set credit_when = 'later' where id = 1;
      raise exception 'waitlist self-test 11e: credit_when accepted a word that is neither join nor open';
    exception when check_violation then
      null;
    end;
    begin
      update public.lynxr_waitlist_settings set credit_day = -1 where id = 1;
      raise exception 'waitlist self-test 11f: credit_day accepted a negative number';
    exception when check_violation then
      null;
    end;

    -- 12-13 need two real accounts (to give from, and to be linked to). This project has more than two.
    select array_agg(a.id) into accts from (select au.id from auth.users au order by au.created_at, au.id limit 2) a;
    if coalesce(array_length(accts, 1), 0) < 2 then
      raise notice 'waitlist self-test 12-13 skipped: needs two accounts';
    else
      u_id := accts[1];
      v_id := accts[2];
      select lower(au.email) into u_mail from auth.users au where au.id = u_id;
      select lower(au.email) into v_mail from auth.users au where au.id = v_id;
      update public.lynxr_signup_gate set require_invite = true where id = 1;

      -- 12. gifts. Quiet u's and v's real community state so every count is deterministic on every re-run, including
      -- after launch (all of it is rolled back with the rest of the block).
      delete from public.lynxr_gift_claims where giver_id in (u_id, v_id);
      delete from public.lynxr_crew
       where inviter_id in (u_id, v_id) or member_id in (u_id, v_id)
          or inviter_norm in (public.lynxr_wl_norm(u_mail), public.lynxr_wl_norm(v_mail))
          or member_norm  in (public.lynxr_wl_norm(u_mail), public.lynxr_wl_norm(v_mail));
      update public.lynxr_members set gift_bonus = 0, title = null, title_at = null where id in (u_id, v_id);
      perform set_config('request.jwt.claims', json_build_object('sub', u_id, 'role', 'authenticated')::text, true);   -- become u

      jg := public.my_gifts();
      gcode := jg->>'code';
      if jg->>'on' is distinct from 'true' or coalesce(length(gcode), 0) <> 8
         or (jg->>'total')::int is distinct from 3 or (jg->>'left')::int is distinct from 3
         or (jg->>'joined')::int is distinct from 0 or (jg->>'waiting')::int is distinct from 0 then
        raise exception 'waitlist self-test 12a: my_gifts for a fresh giver gave %', jg; end if;
      if public.my_gifts()->>'code' is distinct from gcode then
        raise exception 'waitlist self-test 12b: a second my_gifts() call changed the code'; end if;
      if public.waitlist_gift_peek(gcode)->>'state' is distinct from 'ok'
         or public.waitlist_gift_peek('ZZZZZZZZ')->>'state' is distinct from 'none' then
        raise exception 'waitlist self-test 12c: peek gave % / %', public.waitlist_gift_peek(gcode), public.waitlist_gift_peek('ZZZZZZZZ'); end if;

      jh := public.waitlist_gift_claim(gcode, g1_email);
      if jh->>'status' is distinct from 'claimed' or coalesce(length(jh->>'code'), 0) <> 8
         or jh->>'email' is distinct from g1_email or (jh->>'may_mail')::boolean is distinct from true
         or not exists (select 1 from public.lynxr_invites i where i.email = g1_email and i.note = 'gift' and i.redeemed_at is null) then
        raise exception 'waitlist self-test 12d: the first claim gave %', jh; end if;
      jh := public.waitlist_gift_claim(gcode, upper(g1_email));
      if jh->>'status' is distinct from 'again'
         or (select count(*) from public.lynxr_gift_claims where giver_id = u_id) <> 1 then
        raise exception 'waitlist self-test 12e: the same address again gave % (want again, one claim)', jh; end if;
      jh := public.waitlist_gift_claim(gcode, roster);                              -- a roster 'invited' address (inserted in section 2)
      if jh->>'status' is distinct from 'account'
         or (select count(*) from public.lynxr_gift_claims where giver_id = u_id) <> 1 then
        raise exception 'waitlist self-test 12f: a roster address gave % (want account, claims unchanged)', jh; end if;

      jk := public.waitlist_join(gw_email, '', 'selftest', '');                     -- a fresh waitlister: in line by joining alone
      js := public.waitlist_spot(jk->>'view_token', null);
      if jk->>'status' is distinct from 'new' or js->>'state' is distinct from 'waiting' then
        raise exception 'waitlist self-test 12g: could not set up the gifted waitlister: % / %', jk, js; end if;
      jh := public.waitlist_gift_claim(gcode, gw_email);
      if jh->>'status' is distinct from 'claimed'
         or not exists (select 1 from public.lynxr_waitlist w where w.email = gw_email and w.released_at is not null and w.batch = -2)
         or public.waitlist_spot(jk->>'view_token', null)->>'state' is distinct from 'released' then
        raise exception 'waitlist self-test 12g: a gifted waitlister gave % / %', jh, public.waitlist_spot(jk->>'view_token', null); end if;

      jh := public.waitlist_gift_claim(gcode, g3_email);
      if jh->>'status' is distinct from 'claimed' then raise exception 'waitlist self-test 12h: the third claim gave %', jh; end if;
      jh := public.waitlist_gift_claim(gcode, g4_email);
      jg := public.my_gifts();
      if jh->>'status' is distinct from 'used_up' or (jg->>'left')::int is distinct from 0 or (jg->>'waiting')::int is distinct from 3 then
        raise exception 'waitlist self-test 12i: a fourth claim gave % / my_gifts %', jh, jg; end if;

      update public.lynxr_waitlist_settings set gift_day = 0 where id = 1;          -- 12j: busy beats used_up, so use a NEW giver
      perform set_config('request.jwt.claims', json_build_object('sub', v_id, 'role', 'authenticated')::text, true);   -- become v
      vcode := public.my_gifts()->>'code';
      perform set_config('request.jwt.claims', json_build_object('sub', u_id, 'role', 'authenticated')::text, true);   -- back to u
      jh := public.waitlist_gift_claim(vcode, g4_email);
      update public.lynxr_waitlist_settings set gift_day = 100000 where id = 1;
      if coalesce(length(vcode), 0) <> 8 or jh->>'status' is distinct from 'busy'
         or exists (select 1 from public.lynxr_gift_claims where email = g4_email) then
        raise exception 'waitlist self-test 12j: with gift_day = 0 a new giver''s claim gave % (want busy, no claim)', jh; end if;

      -- 12k: a claim nobody used lapses after 14 days and the gift goes back
      update public.lynxr_gift_claims set created_at = now() - interval '15 days' where email = gw_email;
      cnt := public.lynxr_gift_prune();
      if cnt < 1 or exists (select 1 from public.lynxr_gift_claims where email = gw_email)
         or exists (select 1 from public.lynxr_invites i where i.email = gw_email)
         or not exists (select 1 from public.lynxr_waitlist w where w.email = gw_email and w.released_at is null and w.batch is null)
         or public.my_gifts()->>'left' is distinct from '1' then
        raise exception 'waitlist self-test 12k: a lapsed gift was not withdrawn (pruned %, my_gifts %)', cnt, public.my_gifts(); end if;

      -- 12l: the friend makes their account: the claim is redeemed and the giver's crew grows
      perform public.lynxr_link_account(v_id, g1_email);
      if not exists (select 1 from public.lynxr_gift_claims k where k.email = g1_email and k.redeemed_at is not null and k.member_id = v_id)
         or not exists (select 1 from public.lynxr_crew c where c.member_norm = public.lynxr_wl_norm(g1_email) and c.via = 'gift'
                          and c.inviter_id = u_id and c.member_id = v_id) then
        raise exception 'waitlist self-test 12l: linking an account did not redeem the claim and write the crew edge'; end if;
      jg := public.my_gifts();
      if (jg->>'joined')::int is distinct from 1 or (jg->>'crew')::int is distinct from 1
         or (jg->>'waiting')::int is distinct from 1 or (jg->>'left')::int is distinct from 1 then
        raise exception 'waitlist self-test 12l: my_gifts after one friend joined gave %', jg; end if;

      -- 12m: "send it again" is throttled after the gift email goes
      perform public.waitlist_gift_mark(g3_email);
      jh := public.waitlist_gift_claim(gcode, g3_email);
      if (select mailed_at from public.lynxr_gift_claims where email = g3_email) is null
         or jh->>'status' is distinct from 'again' or (jh->>'may_mail')::boolean is distinct from false then
        raise exception 'waitlist self-test 12m: a gift mail inside 15 minutes was allowed again: %', jh; end if;

      perform set_config('request.jwt.claims', '', true);                           -- nobody signed in
      if public.my_gifts() is not null then
        raise exception 'waitlist self-test 12n: my_gifts answered with nobody signed in'; end if;

      -- 13. crew and title
      jq := public.waitlist_join(r_email, '', 'selftest', '');
      r_tok := jq->>'view_token';  r_code := jq->>'ref_code';
      js := public.waitlist_spot(r_tok, null);
      if jq->>'status' is distinct from 'new' or js->>'state' is distinct from 'waiting' then
        raise exception 'waitlist self-test 13: could not set up the referrer: % / %', jq, js; end if;
      jx1 := public.waitlist_join(r1_email, r_code, 'selftest', '');
      jx2 := public.waitlist_join(r2_email, r_code, 'selftest', '');
      if jx1->>'status' is distinct from 'new' or jx2->>'status' is distinct from 'new'
         or (select count(*) from public.lynxr_waitlist where referred_by = r_email) <> 2 then
        raise exception 'waitlist self-test 13: the two friends were not tied to the referrer''s link'; end if;
      js := public.waitlist_spot(r_tok, null);                                  jall := jall || js;
      if (js->>'crew')::int is distinct from 2 or (js->>'title_crew')::int is distinct from 3 or js->'title' is not null then
        raise exception 'waitlist self-test 13a: after two friends the referrer should have crew 2, no title: %', js; end if;
      jx3 := public.waitlist_join(r3_email, r_code, 'selftest', '');
      js := public.waitlist_spot(r_tok, null);                                  jall := jall || js;
      if jx3->>'status' is distinct from 'new' or (js->>'crew')::int is distinct from 3 or js->>'title' is distinct from 'founding' then
        raise exception 'waitlist self-test 13b: after three friends the referrer should be a founding creator: %', js; end if;
      if (select title_at from public.lynxr_waitlist where email = r_email) is null then
        raise exception 'waitlist self-test 13c: the title was given without a title_at'; end if;
      js := public.waitlist_spot(jx1->>'view_token', null);                     jall := jall || js;
      if (js->>'crew')::int is distinct from 0 or js->'title' is not null then
        raise exception 'waitlist self-test 13d: a friend with no crew of their own got % ', js; end if;
      -- opening r1's page is what seen_at records, so put it back: 13h strips r1 as a friend who never opened their email
      update public.lynxr_waitlist set seen_at = null where email = r1_email;
      perform public.lynxr_link_account(u_id, r_email);                          -- 13e: the title travels to the account
      if (select title from public.lynxr_members where id = u_id) is distinct from 'founding' then
        raise exception 'waitlist self-test 13e: the waitlist title was not carried to the account'; end if;

      update public.lynxr_waitlist_settings set title_crew = 0 where id = 1;      -- 13f: the owner stopped awarding it
      jq := public.waitlist_join(s_email, '', 'selftest', '');
      js := public.waitlist_spot(jq->>'view_token', null);
      for n_i in 1..3 loop
        jx1 := public.waitlist_join('wl-selftest-s' || n_i || '@example.invalid', jq->>'ref_code', 'selftest', '');
      end loop;
      js := public.waitlist_spot(jq->>'view_token', null);                      jall := jall || js;
      update public.lynxr_waitlist_settings set title_crew = 3 where id = 1;
      if js->'title' is not null or (js->>'title_crew')::int is distinct from 0
         or (select title from public.lynxr_waitlist where email = s_email) is not null then
        raise exception 'waitlist self-test 13f: a title was awarded with title_crew = 0: %', js; end if;

      if jall::text ~ '"(email|view_token|confirm_token|code|just_confirmed)":' then
        raise exception 'waitlist self-test 13g: a spot answer carried a secret: %', jall; end if;

      -- 13h: the staff strip. r's three friends never opened their email: all three credits are taken back and the fakes
      -- are deleted. The title earned with them goes too, on the waitlist row AND on the account it was carried to.
      jl := public.waitlist_strip(r_email, 'unseen', true);
      if (jl->>'stripped')::int is distinct from 3 or (jl->>'dropped')::int is distinct from 3
         or (jl->>'referrals')::int is distinct from 0 or jl->>'title' is not null
         or (select title from public.lynxr_waitlist where email = r_email) is not null
         or (select title from public.lynxr_members where id = u_id) is not null
         or exists (select 1 from public.lynxr_waitlist where email in (r1_email, r2_email, r3_email))
         or exists (select 1 from public.lynxr_crew where member_norm in
                      (public.lynxr_wl_norm(r1_email), public.lynxr_wl_norm(r2_email), public.lynxr_wl_norm(r3_email))) then
        raise exception 'waitlist self-test 13h: waitlist_strip gave % (want 3 stripped, 3 dropped, 0 referrals, no title, no friends left)', jl; end if;
      select count(*), count(distinct public.lynxr_wl_position(w.sort_key)), max(public.lynxr_wl_position(w.sort_key))
        into cnt, dist, mx
        from public.lynxr_waitlist w
       where w.confirmed_at is not null and w.released_at is null and w.unsubscribed_at is null;
      if dist <> cnt or mx <> cnt then
        raise exception 'waitlist self-test 13h2: positions are not 1..% exactly once after a strip (distinct %, max %)', cnt, dist, mx; end if;
      -- 13i: nobody to strip, and a scope that does not exist
      jl := public.waitlist_strip(nobody, 'unseen', false);
      if jl->>'error' is distinct from 'none' then raise exception 'waitlist self-test 13i: stripping a stranger gave %', jl; end if;
      jl := public.waitlist_strip(r_email, 'x', false);
      if jl->>'error' is distinct from 'bad_scope' then raise exception 'waitlist self-test 13i2: a bad scope gave %', jl; end if;

      -- 13j: the invite name
      jn := public.waitlist_set_name(r_tok, '  Maya  Lee ');
      if jn->>'ok' is distinct from 'true' or jn->>'name' is distinct from 'Maya' then
        raise exception 'waitlist self-test 13j: setting a name gave %', jn; end if;
      if public.waitlist_ref_name(lower(r_code)) is distinct from jsonb_build_object('name', 'Maya')
         or public.waitlist_spot(r_tok, null)->>'name' is distinct from 'Maya' then
        raise exception 'waitlist self-test 13j2: the name did not reach ref_name / the spot answer: % / %',
          public.waitlist_ref_name(lower(r_code)), public.waitlist_spot(r_tok, null); end if;
      for v in select t from unnest(array['1000', 'a.com', '<b>', repeat('a', 21)]) t loop
        jn := public.waitlist_set_name(r_tok, v);
        if jn->>'ok' is distinct from 'false' or jn->>'reason' is distinct from 'bad_name' then
          raise exception 'waitlist self-test 13j3: the name % was not refused: %', v, jn; end if;
      end loop;
      if public.waitlist_ref_name(lower(r_code)) is distinct from jsonb_build_object('name', 'Maya') then
        raise exception 'waitlist self-test 13j4: a refused name changed the stored one'; end if;
      jn := public.waitlist_set_name(repeat('0', 32), 'Maya');
      if jn->>'ok' is distinct from 'false' or jn->>'reason' is distinct from 'none' then
        raise exception 'waitlist self-test 13j5: an unknown token gave %', jn; end if;
      begin
        update public.lynxr_waitlist set display_name = '1x' where email = r_email;
        raise exception 'waitlist self-test 13j6: the table accepted a name with a digit';
      exception when check_violation then
        null;
      end;
      jn := public.waitlist_set_name(r_tok, '');
      if jn->>'ok' is distinct from 'true' or public.waitlist_ref_name(lower(r_code)) is distinct from '{}'::jsonb then
        raise exception 'waitlist self-test 13j7: clearing the name gave % / %', jn, public.waitlist_ref_name(lower(r_code)); end if;
      perform public.waitlist_set_name(r_tok, 'Maya');
      perform public.waitlist_stop(r_tok);
      if public.waitlist_ref_name(r_code) is distinct from '{}'::jsonb then
        raise exception 'waitlist self-test 13j8: a name was shown for an entry that left'; end if;
    end if;

    -- 14. who may call what (the community layer)
    if has_function_privilege('anon',          'public.waitlist_gift_claim(text,text)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_gift_claim(text,text)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_gift_peek(text)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_gift_peek(text)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_gift_mark(text)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_gift_mark(text)', 'execute')
    or has_function_privilege('anon',          'public.lynxr_gift_prune()', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_gift_prune()', 'execute')
    or has_function_privilege('anon',          'public.lynxr_link_account(uuid,text)', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_link_account(uuid,text)', 'execute')
    or has_function_privilege('anon',          'public.lynxr_wl_title_check(text,text,uuid)', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_wl_title_check(text,text,uuid)', 'execute')
    or has_function_privilege('anon',          'public.lynxr_wl_crew(text,uuid)', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_wl_crew(text,uuid)', 'execute')
    or has_function_privilege('anon',          'public.lynxr_wl_credit_friend(text)', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_wl_credit_friend(text)', 'execute')
    or has_function_privilege('anon',          'public.lynxr_wl_uncredit(text)', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_wl_uncredit(text)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_strip(text,text,boolean)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_strip(text,text,boolean)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_set_name(text,text)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_set_name(text,text)', 'execute')
    or has_function_privilege('anon',          'public.waitlist_ref_name(text)', 'execute')
    or has_function_privilege('authenticated', 'public.waitlist_ref_name(text)', 'execute')
    or has_function_privilege('anon',          'public.lynxr_wl_from_confirm()', 'execute')
    or has_function_privilege('authenticated', 'public.lynxr_wl_from_confirm()', 'execute') then
      raise exception 'waitlist self-test 14a: a browser role can call a server-only gift function'; end if;
    if not has_function_privilege('authenticated', 'public.my_gifts()', 'execute')
    or has_function_privilege('anon', 'public.my_gifts()', 'execute') then
      raise exception 'waitlist self-test 14b: my_gifts must be callable by signed-in users and nobody else'; end if;
    if has_table_privilege('anon',          'public.lynxr_gift_claims', 'select')
    or has_table_privilege('authenticated', 'public.lynxr_gift_claims', 'select')
    or has_table_privilege('anon',          'public.lynxr_crew', 'select')
    or has_table_privilege('authenticated', 'public.lynxr_crew', 'select') then
      raise exception 'waitlist self-test 14c: a browser role can read the gift claims or the crew graph'; end if;
    if has_table_privilege('anon', 'public.lynxr_members', 'select') then
      raise exception 'waitlist self-test 14d: anon can read lynxr_members'; end if;
    if has_table_privilege('authenticated', 'public.lynxr_members', 'insert')
    or has_table_privilege('authenticated', 'public.lynxr_members', 'update')
    or has_table_privilege('authenticated', 'public.lynxr_members', 'delete') then
      raise exception 'waitlist self-test 14e: a signed-in browser role can write lynxr_members'; end if;

    raise exception 'waitlist_queue self-test passed' using errcode = 'LX001';
  exception when sqlstate 'LX001' then
    raise notice 'waitlist_queue self-test passed — rolled back, nothing written';
  end;
end $$;

notify pgrst, 'reload schema';

-- ── Runbook (after Run) ──────────────────────────────────────────────────────────────────────────────────────────
-- Expect the notice  waitlist_queue self-test passed — rolled back, nothing written
-- (a second notice  "12-13 skipped: needs two accounts"  is fine ONLY on a project with fewer than two accounts).
-- Two non-internal triggers on auth.users should now exist:  lynxr_signup_gate  and  lynxr_after_signup.
-- Sign-up behaves exactly as before until you run the one line in the header (plan step 20).
-- 2026-11-21 revision (no confirmation): the first run also performed the one-time switch (section 1i4). To check it:
--     select count(*) filter (where confirmed_at is null and unsubscribed_at is null) as unconfirmed,    -- expect 0
--            count(*) filter (where credit is not null) as decided from public.lynxr_waitlist;
-- Deploy order is safe either way, recommended: the Edge Function first, then this file, then the front end. The new function
-- works against the old SQL, and this SQL works with the old function (a new row comes back as kind 'spot', so the old
-- function sends its "your spot" email with a working link, never a broken confirm email).
