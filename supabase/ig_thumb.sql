-- Lynxr — the Instagram cover lookup behind the sign-up tease: its cache and its spend limits.
-- Dashboard → SQL Editor → New query → paste this whole file → Run. Standalone, idempotent, safe to re-run.
-- Needs public.lynxr_ops (supabase/ops_table.sql — already applied live).
--
-- WHAT USES IT. supabase/functions/ig-thumb, an Edge Function ANY visitor can call (the landing page's
-- composer, signed out, Instagram links only). Every cent it can spend is gated here, in one atomic call:
--   ig_thumb_take()  per visitor (an HMAC of their IP, never the IP) per hour and per UTC day, everyone
--                    together per UTC day, and a DOLLAR ceiling per UTC calendar month for this feature alone,
--                    so Instagram view counts (the Fly worker, same Apify account, $5/month cap) are never starved.
--   lynxr_thumb_cache  shortcode -> the cover's path in the public lynxr-covers bucket ('ok'), or 'none' for a
--                    post that had no cover. A hit costs $0.
--   lynxr_ops 'thumb.ceiling'  written the FIRST time a month's ceiling refuses a lookup; pipeline/watchdog.py
--                    turns it into a digest-only line (never a page — nobody lost a script).
--
-- NOTHING HERE IS READABLE OR WRITABLE BY A BROWSER. RLS on with no policies, grants revoked from anon and
-- authenticated, the function's EXECUTE revoked likewise. The Edge Function uses the service role.
--
-- RETENTION. Rows keyed on a hashed IP expire after 2 hours (per hour) or 2 days (per day); ig_thumb_take()
-- and pipeline/watchdog.py (_prune_thumb_meter, hourly) delete expired rows. privacy/index.html promises two days.

create table if not exists public.lynxr_thumb_cache (
  shortcode   text        primary key check (shortcode ~ '^[A-Za-z0-9_-]{5,64}$'),
  status      text        not null check (status in ('ok', 'none')),
  object_path text,        -- inside lynxr-covers: 'tease/ig/<shortcode>.jpg' or a pipeline cover '<sha20>.jpg'
  created_at  timestamptz not null default now()
);
alter table public.lynxr_thumb_cache enable row level security;
revoke all on table public.lynxr_thumb_cache from anon, authenticated;
grant select, insert, update, delete on table public.lynxr_thumb_cache to service_role;

create table if not exists public.lynxr_thumb_meter (
  bucket     text          primary key,   -- ip-h:<hash>:<YYYY-MM-DDTHH> | ip-d:<hash>:<YYYY-MM-DD> | all-d:<YYYY-MM-DD> | all-m:<YYYY-MM>
  n          integer       not null default 0,
  usd        numeric(10,4) not null default 0,
  expires_at timestamptz   not null
);
create index if not exists lynxr_thumb_meter_expires_idx on public.lynxr_thumb_meter (expires_at);
alter table public.lynxr_thumb_meter enable row level security;
revoke all on table public.lynxr_thumb_meter from anon, authenticated;
grant select, insert, update, delete on table public.lynxr_thumb_meter to service_role;

-- THE CHECK-AND-COUNT. Returns 'ok' (counted, go ahead and spend) or why not: 'month' | 'day' | 'ip_day' |
-- 'ip_hour' | 'bad_ip'. One advisory lock serialises every call, so two visitors can never both see room for
-- the last lookup. Nothing is counted unless everything passes. The month is charged p_cost up front and
-- never refunded: Apify bills a started lookup whether or not it finds a cover.
create or replace function public.ig_thumb_take(
  p_ip text, p_ip_hour int, p_ip_day int, p_day int, p_month_usd numeric, p_cost numeric)
returns text language plpgsql volatile security definer set search_path = ''
as $$
declare
  t    timestamptz := now();
  utc  timestamp   := now() at time zone 'utc';
  k_h  text := 'ip-h:'  || p_ip || ':' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24');
  k_d  text := 'ip-d:'  || p_ip || ':' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  k_g  text := 'all-d:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  k_m  text := 'all-m:' || to_char(now() at time zone 'utc', 'YYYY-MM');
  used numeric;
begin
  -- Only a 32-hex HMAC is ever stored; a raw address is refused rather than written.
  if p_ip is null or p_ip !~ '^[0-9a-f]{32}$' then return 'bad_ip'; end if;
  perform pg_advisory_xact_lock(hashtext('lynxr.ig_thumb_take'));
  delete from public.lynxr_thumb_meter where expires_at < t;

  used := coalesce((select m.usd from public.lynxr_thumb_meter m where m.bucket = k_m), 0);
  if used + p_cost > p_month_usd then
    insert into public.lynxr_ops as o (key, value, updated_at)
    values ('thumb.ceiling',
            jsonb_build_object('month', to_char(utc, 'YYYY-MM'), 'usd', used, 'cap', p_month_usd), t)
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
      where o.value->>'month' is distinct from excluded.value->>'month';
    return 'month';
  end if;
  if coalesce((select m.n from public.lynxr_thumb_meter m where m.bucket = k_g), 0) >= p_day     then return 'day';     end if;
  if coalesce((select m.n from public.lynxr_thumb_meter m where m.bucket = k_d), 0) >= p_ip_day  then return 'ip_day';  end if;
  if coalesce((select m.n from public.lynxr_thumb_meter m where m.bucket = k_h), 0) >= p_ip_hour then return 'ip_hour'; end if;

  insert into public.lynxr_thumb_meter as m (bucket, n, usd, expires_at) values
    (k_h, 1, 0,      t + interval '2 hours'),
    (k_d, 1, 0,      t + interval '2 days'),
    (k_g, 1, 0,      t + interval '2 days'),
    (k_m, 1, p_cost, t + interval '62 days')
  on conflict (bucket) do update set n = m.n + 1, usd = m.usd + excluded.usd;
  return 'ok';
end $$;
revoke all on function public.ig_thumb_take(text, int, int, int, numeric, numeric) from public, anon, authenticated;
grant execute on function public.ig_thumb_take(text, int, int, int, numeric, numeric) to service_role;

-- ── SELF-TEST. Runs every time this file is run and WRITES NOTHING: the inner block raises LX001 at the end,
-- which rolls back everything it did, and the handler turns that into a NOTICE. Any wrong answer raises a
-- real error instead, and then the whole file (tables included) is rolled back — fix before re-running.
-- Limits are set RELATIVE to what is already counted today / this month, so live traffic cannot skew it.
do $$
declare
  utc timestamp := now() at time zone 'utc';
  m0  numeric := coalesce((select usd from public.lynxr_thumb_meter where bucket = 'all-m:' || to_char(now() at time zone 'utc', 'YYYY-MM')), 0);
  d0  int     := coalesce((select n   from public.lynxr_thumb_meter where bucket = 'all-d:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD')), 0);
  a   text := repeat('a', 32);
  b   text := repeat('b', 32);
  c   text := repeat('c', 32);
  d   text := repeat('d', 32);
  v   text;
begin
  begin
    -- room for exactly three $0.0027 lookups this month, four today, two per visitor per hour, three per day
    v := public.ig_thumb_take(a, 2, 3, d0 + 4, m0 + 0.0081, 0.0027); if v <> 'ok'      then raise exception 'a1 expected ok, got %', v; end if;
    v := public.ig_thumb_take(a, 2, 3, d0 + 4, m0 + 0.0081, 0.0027); if v <> 'ok'      then raise exception 'a2 expected ok, got %', v; end if;
    v := public.ig_thumb_take(a, 2, 3, d0 + 4, m0 + 0.0081, 0.0027); if v <> 'ip_hour' then raise exception 'a3 expected ip_hour, got %', v; end if;
    v := public.ig_thumb_take(b, 2, 3, d0 + 4, m0 + 0.0081, 0.0027); if v <> 'ok'      then raise exception 'b1 expected ok, got %', v; end if;
    v := public.ig_thumb_take(c, 2, 3, d0 + 4, m0 + 0.0081, 0.0027); if v <> 'month'   then raise exception 'c1 expected month, got %', v; end if;
    if (select o.value->>'month' from public.lynxr_ops o where o.key = 'thumb.ceiling') is distinct from to_char(utc, 'YYYY-MM') then
      raise exception 'thumb.ceiling note was not written for this month';
    end if;
    v := public.ig_thumb_take(c, 2, 3, d0 + 3, m0 + 1, 0.0027);      if v <> 'day'     then raise exception 'c2 expected day, got %', v; end if;
    v := public.ig_thumb_take(d, 10, 1, d0 + 100, m0 + 1, 0.0027);   if v <> 'ok'      then raise exception 'd1 expected ok, got %', v; end if;
    v := public.ig_thumb_take(d, 10, 1, d0 + 100, m0 + 1, 0.0027);   if v <> 'ip_day'  then raise exception 'd2 expected ip_day, got %', v; end if;
    v := public.ig_thumb_take('203.0.113.7', 10, 10, d0 + 100, m0 + 1, 0.0027); if v <> 'bad_ip' then raise exception 'a raw IP was accepted: %', v; end if;
    raise exception 'ig_thumb self-test passed' using errcode = 'LX001';
  exception when sqlstate 'LX001' then
    raise notice 'ig_thumb self-test passed (10 checks) — rolled back, nothing written';
  end;
end $$;

-- ── Check it (after Run) ─────────────────────────────────────────────────────────────────────────────────
--   select * from public.lynxr_thumb_cache order by created_at desc limit 20;
--   select * from public.lynxr_thumb_meter order by bucket;
--   select * from public.lynxr_ops where key = 'thumb.ceiling';
