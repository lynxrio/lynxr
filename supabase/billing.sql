-- Lynxr billing ledger — a payment provider drives a subscription status; the
-- entitlement it grants is resolved live, in the database, on every charge.
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- RUN ORDER
-- ---------------------------------------------------------------------------
-- 1. supabase/allowance_ledger.sql   (already applied live)
-- 2. supabase/billing.sql            (this file)
-- 3. re-run supabase/delete_account.sql  (adds the live-subscription guard)
--
-- APPLYING THIS FILE CHANGES NOBODY'S ALLOWANCE. The seeds are `do nothing`,
-- so a live row is never overwritten, and the free row is seeded with the live
-- free tier (3 per rolling 7 days since 2026-09-21). Nothing bills, nothing walls, nothing
-- new is visible until a checkout exists and a webhook writes a row.
--
-- ---------------------------------------------------------------------------
-- THIS FILE SUPERSEDES my_allowance() AND charge_scripts()
-- ---------------------------------------------------------------------------
-- allowance_ledger.sql defined both. This file redefines them on top, so that
-- a paid subscription's fair-use numbers come from ONE place —
-- lynxr_billing_plans — instead of being copied onto the account on every
-- webhook. DO NOT re-run allowance_ledger.sql after this file: it would put
-- the old, subscription-blind versions back, and every subscriber would
-- silently drop to the free allowance.
--
-- ---------------------------------------------------------------------------
-- PROVIDER-NEUTRAL ON PURPOSE (2026-09-20)
-- ---------------------------------------------------------------------------
-- The owner chose Stripe over Paddle (no approval queue, and nobody vets the
-- business model), then took Stripe's own merchant-of-record option, Managed
-- Payments, when onboarding offered it: STRIPE is the seller of record, so
-- sales tax, VAT, disputes and refunds are Stripe's, for an extra 3.5% a
-- transaction. It is a per-session flag in billing-checkout, not an account
-- setting. Revisit past ~300 subscribers. Moving providers later should cost a
-- webhook rewrite and NOT a schema migration, so no column here says "stripe":
-- ids are `provider_*`, and `lynxr_billing.provider` records which system
-- issued them.
--
-- ---------------------------------------------------------------------------
-- WHERE EVERY NUMBER LIVES — ONE ENFORCING PLACE EACH
-- ---------------------------------------------------------------------------
--   free tier (3 per rolling 7d)   -> lynxr_billing_plans, code='free'
--   pro fair-use cap / window / 24h ceiling -> same table, code='pro'
--   max ditto                      -> same table, code='max'
--   who has which feature          -> lynxr_billing_plans.features, plus
--                                     lynxr_feature_grants for one-off grants
--   the PRICE of a plan            -> the provider's dashboard, never here
--   which provider price maps to which plan -> provider_price_id, set by the
--                                     owner in the SQL editor (one-liners at
--                                     the foot of this file)
--
-- THE CAPS ARE PROVISIONAL. pro 150 / 30 days and max 300 / 30 days are the
-- planned numbers, not measured ones: the real cost per script is still being
-- metered. A subscriber who uses every slot must leave at least 20% of the net
-- payment, so these come down if the measured cost lands above ~$0.12 a
-- script. Changing them is one UPDATE and takes effect on the next charge.
--
-- ---------------------------------------------------------------------------
-- (a) TABLES
-- ---------------------------------------------------------------------------

create table if not exists public.lynxr_billing_plans (
  code              text primary key check (code in ('free', 'pro', 'max')),
  provider_price_id text unique,                 -- null for free, and until the owner sets it
  granted           int  not null check (granted >= 0),
  period_days       int  not null default 0 check (period_days >= 0),  -- 0 = lifetime
  daily_max         int  not null default 0 check (daily_max >= 0),    -- 0 = no 24h ceiling
  features          text[] not null default '{}',
  label             text not null default '',
  updated_at        timestamptz not null default now()
);
-- Seeded ONCE. `do nothing`, never `do update`: re-running this file must not
-- stomp a number the owner changed by hand afterwards.
--
-- free = 3 per rolling 7 days, no 24-hour ceiling. The row was 25 lifetime
-- when this file was first applied live; it was moved on 2026-09-21, when the
-- only accounts were staff and a test account, so there was nobody for the
-- terms' 14-day notice to reach. The live move was this one UPDATE:
--
--   update public.lynxr_billing_plans
--      set granted = 3, period_days = 7, daily_max = 0, updated_at = now()
--    where code = 'free';
--
-- Check: select code, granted, period_days, daily_max from public.lynxr_billing_plans;
-- Any later change to the free tier that affects real accounts needs the
-- terms' 14 days' emailed notice first.
--
-- max is seeded but has no price id and is NOT for sale: its two features do
-- not exist yet. The Plan view says "coming soon" and offers no checkout.
insert into public.lynxr_billing_plans (code, provider_price_id, granted, period_days, daily_max, features, label)
values ('free', null,   3,  7,  0, '{}',                                  'free'),
       ('pro',  null, 150, 30, 30, '{}',                                  'lynxr pro'),
       ('max',  null, 300, 30, 40, '{post_tracking,advanced_coaching}',   'lynxr max')
on conflict (code) do nothing;

create table if not exists public.lynxr_billing (
  creator_id               uuid primary key references auth.users(id) on delete cascade,
  provider                 text not null default 'stripe',
  provider_customer_id     text unique,
  provider_subscription_id text,
  status                   text not null default 'none'
                           check (status in ('none','active','trialing','past_due','paused',
                                             'canceled','refunded','incomplete','unpaid')),
  plan_code                text references public.lynxr_billing_plans(code),
  current_period_end       timestamptz,
  cancel_at                timestamptz,   -- scheduled cancellation, still entitled until then
  granted_override         int check (granted_override >= 0),   -- a fair-use raise for ONE subscriber
  daily_max_override       int check (daily_max_override >= 0),
  occurred_at              timestamptz,   -- newest provider state applied: the out-of-order guard
  updated_at               timestamptz not null default now()
);
create index if not exists lynxr_billing_status_idx on public.lynxr_billing (status);

-- Entitlement is a feature flag, not only a count: a beta tester can hold a
-- feature without a subscription, and a subscriber keeps their plan's features
-- without a row here.
create table if not exists public.lynxr_feature_grants (
  creator_id uuid not null references auth.users(id) on delete cascade,
  feature    text not null,
  note       text not null default '',
  granted_at timestamptz not null default now(),
  primary key (creator_id, feature)
);

create table if not exists public.lynxr_billing_events (
  event_id    text primary key,           -- the provider's event id: the idempotency guard
  event_type  text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  creator_id  uuid,                       -- NO foreign key: an event for a deleted account must still record
  outcome     text not null default '',   -- applied | stale | duplicate | no_creator | unknown_price | no_such_user | ignored
  summary     jsonb not null default '{}'::jsonb   -- ids, status, price id ONLY. Never the raw payload: it carries email, name and address.
);
create index if not exists lynxr_billing_events_recv_idx on public.lynxr_billing_events (received_at desc);

alter table public.lynxr_billing_plans   enable row level security;
alter table public.lynxr_billing         enable row level security;
alter table public.lynxr_billing_events  enable row level security;
alter table public.lynxr_feature_grants  enable row level security;
-- NO anon/authenticated policies on any of the four, on purpose — the same
-- pattern as lynxr_script_charges and lynxr_allowance. Everything a creator
-- may see comes back through my_plan() / my_allowance(), which expose only the
-- numbers that are safe to hand them. A browser must never be able to read
-- another account's subscription state, or its own provider ids.

-- ---------------------------------------------------------------------------
-- (b) lynxr_allowance.granted loses its column default
-- ---------------------------------------------------------------------------
-- The column default (25) was a SECOND, silently different free-tier number
-- living beside lynxr_billing_plans.free.granted. Every insert into
-- lynxr_allowance must now name `granted` explicitly — the one-liners in
-- allowance_ledger.sql (pins, hand grants) already do. The table is empty in
-- production, so this changes no existing row.
alter table public.lynxr_allowance alter column granted drop default;

-- ---------------------------------------------------------------------------
-- (c) entitlement_for — the one function every number is resolved through
-- ---------------------------------------------------------------------------
-- Precedence: a live paid subscription > a lynxr_allowance row (hand grant or
-- pin) > the free plan row. No free row at all -> the caller's coalesce(…, 0)
-- fails closed, which refuses a script rather than handing out an unlimited
-- one.
--
-- `past_due` still counts as entitled on purpose: the card failed, the
-- provider is retrying, and taking the product away on day one of a failed
-- renewal is how you turn a card problem into a cancellation.
create or replace function public.entitlement_for(p_creator uuid)
returns table (granted int, period_days int, daily_max int, plan_code text)
language sql stable security definer set search_path = ''
as $$
  select granted, period_days, daily_max, plan_code from (
    select 1 as rk, coalesce(b.granted_override, p.granted) as granted, p.period_days,
           coalesce(b.daily_max_override, p.daily_max) as daily_max, p.code as plan_code
      from public.lynxr_billing b join public.lynxr_billing_plans p on p.code = b.plan_code
     where b.creator_id = p_creator and b.status in ('active','trialing','past_due')
    union all
    select 2, l.granted, l.period_days, coalesce(f.daily_max, 0), 'free'
      from public.lynxr_allowance l left join public.lynxr_billing_plans f on f.code = 'free'
     where l.id = p_creator
    union all
    select 3, f.granted, f.period_days, f.daily_max, 'free'
      from public.lynxr_billing_plans f where f.code = 'free'
  ) s order by rk limit 1;
$$;
revoke all on function public.entitlement_for(uuid) from public, anon, authenticated;
grant execute on function public.entitlement_for(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- (d) features_for — the plan's features, plus any one-off grants
-- ---------------------------------------------------------------------------
create or replace function public.features_for(p_creator uuid)
returns text[] language sql stable security definer set search_path = ''
as $$
  select coalesce(array(
    select distinct f from (
      select unnest(p.features) as f
        from public.lynxr_billing b
        join public.lynxr_billing_plans p on p.code = b.plan_code
       where b.creator_id = p_creator and b.status in ('active','trialing','past_due')
      union
      select g.feature from public.lynxr_feature_grants g where g.creator_id = p_creator
    ) s order by f
  ), '{}');
$$;
revoke all on function public.features_for(uuid) from public, anon, authenticated;
grant execute on function public.features_for(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- (e) allowance_state — used + the entitlement + features, fail closed
-- ---------------------------------------------------------------------------
create or replace function public.allowance_state(p_creator uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'used', (
      select count(*) from public.lynxr_script_charges c
       where c.creator_id = p_creator
         and (coalesce(e.period_days, 0) = 0
              or c.charged_at > now() - make_interval(days => coalesce(e.period_days, 0)))),
    'used_24h', (
      select count(*) from public.lynxr_script_charges c
       where c.creator_id = p_creator
         and c.charged_at > now() - interval '24 hours'),
    'granted', coalesce(e.granted, 0),
    'period_days', coalesce(e.period_days, 0),
    'daily_max', coalesce(e.daily_max, 0),
    'plan', coalesce(e.plan_code, 'free'),
    'features', to_jsonb(public.features_for(p_creator)))
  from (select 1) x
  left join lateral public.entitlement_for(p_creator) e on true;
$$;
revoke all on function public.allowance_state(uuid) from public, anon, authenticated;
grant execute on function public.allowance_state(uuid) to service_role;
-- The worker calls this on the refusal path, so the wall it prints names the
-- creator's real numbers rather than the free tier's.

-- ---------------------------------------------------------------------------
-- (f) my_allowance() superseded — same shape, resolved through entitlement_for
-- ---------------------------------------------------------------------------
create or replace function public.my_allowance()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select public.allowance_state(auth.uid());
$$;
revoke all on function public.my_allowance() from public, anon;
grant execute on function public.my_allowance() to authenticated;
-- The old keys used/granted/period_days are all still present, so today's
-- creator.js keeps working unchanged; used_24h/daily_max/plan/features are new.

-- ---------------------------------------------------------------------------
-- (g) charge_scripts() superseded — same FIFO body, entitlement-aware, + 24h ceiling
-- ---------------------------------------------------------------------------
create or replace function public.charge_scripts(p_creator uuid, p_ids text[])
returns setof text language plpgsql volatile security definer set search_path = ''
as $$
declare
  g   int;
  pd  int;
  spent int;
  dmax int;
  spent_24h int;
begin
  select coalesce(e.granted, 0), coalesce(e.period_days, 0), coalesce(e.daily_max, 0)
    into g, pd, dmax
    from (select 1) x left join lateral public.entitlement_for(p_creator) e on true;
  select count(*) into spent from public.lynxr_script_charges c
   where c.creator_id = p_creator
     and (pd = 0 or c.charged_at > now() - make_interval(days => pd));
  select count(*) into spent_24h from public.lynxr_script_charges c
   where c.creator_id = p_creator and c.charged_at > now() - interval '24 hours';

  return query
  with want as (
    select id, ord from unnest(p_ids) with ordinality as t(id, ord)
  ),
  already as (
    select w.id from want w
      join public.lynxr_script_charges c on c.adaptation_id = w.id
     where c.creator_id = p_creator
  ),
  fresh as (
    select w.id from want w
     where w.id not in (select id from already)
     order by w.ord
     -- least() ignores NULLs, so dmax = 0 (no 24h ceiling) is exactly the
     -- rolling-window-only behaviour this superseded.
     limit least(greatest(g - spent, 0),
                 case when dmax <= 0 then null else greatest(dmax - spent_24h, 0) end)
  ),
  ins as (
    insert into public.lynxr_script_charges (adaptation_id, creator_id)
    select id, p_creator from fresh
    on conflict (adaptation_id) do nothing
    returning adaptation_id
  )
  select id from already union all select adaptation_id from ins;
end $$;
revoke all on function public.charge_scripts(uuid, text[]) from public, anon, authenticated;
grant execute on function public.charge_scripts(uuid, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- (h) upsert_billing — writes lynxr_billing ONLY. Never lynxr_allowance.
-- ---------------------------------------------------------------------------
create or replace function public.upsert_billing(
  p_creator uuid, p_status text, p_plan_code text, p_customer text,
  p_subscription text, p_period_end timestamptz, p_cancel_at timestamptz,
  p_occurred_at timestamptz
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  existing_occurred timestamptz;
begin
  if p_creator is null then
    return jsonb_build_object('applied', false, 'why', 'no_creator');
  end if;

  if not exists (select 1 from auth.users where id = p_creator) then
    -- MUST NEVER raise here: a raise becomes a 500 to the webhook caller, and
    -- the provider then retries a failing delivery for hours or days against
    -- an account that no longer exists.
    return jsonb_build_object('applied', false, 'why', 'no_such_user');
  end if;

  select occurred_at into existing_occurred
    from public.lynxr_billing where creator_id = p_creator for update;

  -- Webhooks arrive out of order often enough to matter: a "canceled" that
  -- overtakes the "active" that followed it would take the product away from
  -- someone who is paying.
  if existing_occurred is not null and p_occurred_at is not null
     and existing_occurred > p_occurred_at then
    return jsonb_build_object('applied', false, 'why', 'stale');
  end if;

  insert into public.lynxr_billing (
    creator_id, provider_customer_id, provider_subscription_id, status, plan_code,
    current_period_end, cancel_at, occurred_at, updated_at
  ) values (
    p_creator, p_customer, p_subscription, p_status, p_plan_code,
    p_period_end, p_cancel_at, p_occurred_at, now()
  )
  on conflict (creator_id) do update set
    status                   = excluded.status,
    plan_code                = coalesce(excluded.plan_code, public.lynxr_billing.plan_code),
    provider_customer_id     = coalesce(excluded.provider_customer_id, public.lynxr_billing.provider_customer_id),
    provider_subscription_id = coalesce(excluded.provider_subscription_id, public.lynxr_billing.provider_subscription_id),
    current_period_end       = excluded.current_period_end,
    cancel_at                = excluded.cancel_at,
    occurred_at              = excluded.occurred_at,
    updated_at               = now();

  return jsonb_build_object('applied', true, 'status', p_status, 'plan', p_plan_code);
end $$;
revoke all on function public.upsert_billing(uuid, text, text, text, text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.upsert_billing(uuid, text, text, text, text, timestamptz, timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- (i) ingest_billing_event — records the event AND applies it, one transaction
-- ---------------------------------------------------------------------------
-- A webhook that inserted the event row first and applied the status second
-- would drop a legitimate provider retry as a duplicate whenever the first
-- attempt failed between those two steps. One function, one transaction:
-- either both happen or neither does, so a retry after a real failure
-- reprocesses cleanly instead of being swallowed.
create or replace function public.ingest_billing_event(
  p_event_id text, p_event_type text, p_occurred_at timestamptz,
  p_creator uuid, p_customer text, p_subscription text, p_status text,
  p_price_id text, p_period_end timestamptz, p_cancel_at timestamptz,
  p_summary jsonb
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  n int;
  resolved_creator uuid;
  resolved_plan text;
  r jsonb;
begin
  insert into public.lynxr_billing_events (event_id, event_type, occurred_at, summary)
  values (p_event_id, p_event_type, p_occurred_at, coalesce(p_summary, '{}'::jsonb))
  on conflict (event_id) do nothing;
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('duplicate', true);
  end if;

  -- Resolve the creator: the id the checkout carried (Stripe: the session's
  -- client_reference_id / metadata), if that account still exists; else
  -- whichever billing row already knows this provider customer.
  if p_creator is not null and exists (select 1 from auth.users where id = p_creator) then
    resolved_creator := p_creator;
  elsif p_customer is not null then
    select creator_id into resolved_creator
      from public.lynxr_billing where provider_customer_id = p_customer;
  end if;

  -- Resolve the plan from the provider price id, when this event carries one.
  if p_price_id is not null then
    select code into resolved_plan
      from public.lynxr_billing_plans where provider_price_id = p_price_id;
    if resolved_plan is null then
      -- Someone bought a price this database has never heard of. Record it and
      -- refuse: guessing a plan here is how a $24.99 payment silently grants
      -- the $74.99 entitlement.
      update public.lynxr_billing_events
         set outcome = 'unknown_price', creator_id = resolved_creator
       where event_id = p_event_id;
      return jsonb_build_object('applied', false, 'why', 'unknown_price');
    end if;
  end if;

  if p_status is null then
    -- An event with nothing to apply to a status (a completed payment, say),
    -- but a first-seen customer id is worth recording against the creator.
    if resolved_creator is not null and p_customer is not null then
      update public.lynxr_billing
         set provider_customer_id = coalesce(provider_customer_id, p_customer)
       where creator_id = resolved_creator;
    end if;
    update public.lynxr_billing_events
       set outcome = 'ignored', creator_id = resolved_creator
     where event_id = p_event_id;
    return jsonb_build_object('applied', false, 'why', 'ignored');
  end if;

  r := public.upsert_billing(resolved_creator, p_status, resolved_plan, p_customer,
                              p_subscription, p_period_end, p_cancel_at, p_occurred_at);
  update public.lynxr_billing_events
     set outcome = coalesce(r->>'why', 'applied'), creator_id = resolved_creator
   where event_id = p_event_id;
  return r;
end $$;
revoke all on function public.ingest_billing_event(text, text, timestamptz, uuid, text, text, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_billing_event(text, text, timestamptz, uuid, text, text, text, text, timestamptz, timestamptz, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (j) my_plan — what the creator app's Plan view renders
-- ---------------------------------------------------------------------------
-- No provider ids, no price ids, no amounts — none of those need to reach the
-- browser. The caps are public marketing facts (they are on /pricing/), so the
-- Plan view renders them from here instead of hand-typed JS copy that drifts
-- from the row. `for_sale` is what makes the max card say "coming soon": a
-- plan with no price id cannot be bought, and the app must not offer it.
create or replace function public.my_plan()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'status', coalesce(b.status, 'none'),
    'plan_code', b.plan_code,
    'current_period_end', b.current_period_end,
    'cancel_at', b.cancel_at,
    'has_customer', b.provider_customer_id is not null,
    'features', to_jsonb(public.features_for(auth.uid())),
    'plans', (
      select jsonb_object_agg(p.code, jsonb_build_object(
               'granted', p.granted, 'period_days', p.period_days,
               'daily_max', p.daily_max, 'label', p.label,
               'features', to_jsonb(p.features),
               'for_sale', p.provider_price_id is not null))
        from public.lynxr_billing_plans p where p.code <> 'free'))
  from (select 1) x
  left join public.lynxr_billing b on b.creator_id = auth.uid();
$$;
revoke all on function public.my_plan() from public, anon;
grant execute on function public.my_plan() to authenticated;

-- ---------------------------------------------------------------------------
-- (k) spend_state — service-role only, feeds the watchdog's spend tripwires
-- ---------------------------------------------------------------------------
-- Ids are 8 characters and there are no emails anywhere in this output — the
-- watchdog's ntfy topic is a bearer secret and its alarm bodies must never
-- carry anything that identifies a person.
create or replace function public.spend_state(p_overuse_min int default 0)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'active_paid', (select count(*) from public.lynxr_billing where status in ('active','trialing','past_due')),
    'past_due', (select count(*) from public.lynxr_billing where status = 'past_due'),
    'cancel_scheduled', (select count(*) from public.lynxr_billing
                          where status in ('active','trialing','past_due') and cancel_at is not null),
    'by_plan', (select coalesce(jsonb_object_agg(plan_code, n), '{}'::jsonb)
                  from (select plan_code, count(*) as n from public.lynxr_billing
                         where status in ('active','trialing','past_due') group by plan_code) t),
    'plans', (select jsonb_object_agg(p.code, jsonb_build_object(
                       'granted', p.granted, 'period_days', p.period_days, 'daily_max', p.daily_max))
                from public.lynxr_billing_plans p),
    'unmatched_events_24h', (
      select count(*) from public.lynxr_billing_events
       where received_at > now() - interval '24 hours'
         and outcome in ('no_creator', 'unknown_price')),
    'overuse_30d', case when p_overuse_min > 0 then (
      select coalesce(jsonb_agg(jsonb_build_object('id8', left(o.creator_id::text, 8), 'used_30d', o.used_30d)), '[]'::jsonb)
      from (
        select creator_id, count(*) as used_30d
          from public.lynxr_script_charges
         where charged_at > now() - interval '30 days'
         group by creator_id
        having count(*) >= p_overuse_min
      ) o
    ) else '[]'::jsonb end);
$$;
revoke all on function public.spend_state(int) from public, anon, authenticated;
grant execute on function public.spend_state(int) to service_role;

-- ---------------------------------------------------------------------------
-- (l) grants recap + schema reload
-- ---------------------------------------------------------------------------
-- authenticated: my_allowance(), my_plan()
-- service_role only: entitlement_for, features_for, allowance_state,
--                    charge_scripts, upsert_billing, ingest_billing_event,
--                    spend_state
-- (each already granted at its own definition above; this section is the recap
-- the header promises, not a second set of grants)
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- (m) OPERATIONAL ONE-LINERS
-- ---------------------------------------------------------------------------
--
-- Point a plan at its provider price (type the id only here, in the SQL
-- editor — never into a file; this repo is public). Setting it is also what
-- turns "coming soon" into a buyable plan in the app:
--
--   update public.lynxr_billing_plans set provider_price_id = '<price id>',
--     updated_at = now() where code = 'pro';
--
-- Change a fair-use cap (takes effect on the subscriber's NEXT charge):
--
--   update public.lynxr_billing_plans set granted = 150, updated_at = now()
--    where code = 'pro';
--
-- Raise ONE subscriber's cap:
--
--   update public.lynxr_billing set granted_override = 200
--    where creator_id = '<uuid>';
--
-- Give a beta tester a feature with no subscription:
--
--   insert into public.lynxr_feature_grants (creator_id, feature, note)
--   values ('<uuid>', 'post_tracking', 'beta tester')
--   on conflict (creator_id, feature) do nothing;
--
-- Give an account a plan for free (the cofounders have max this way, since
-- 2026-09-21). provider 'comp' says no provider issued it; occurred_at
-- 'infinity' makes every provider event for that account arrive "stale", so a
-- leftover Stripe subscription ending (or renewing) can never overwrite it.
-- The ids are cleared so the app shows no Manage billing / Cancel buttons that
-- would point at a subscription that is not the source of this plan:
--
--   insert into public.lynxr_billing (creator_id, provider, status, plan_code, occurred_at)
--   values ('<uuid>', 'comp', 'active', 'max', 'infinity')
--   on conflict (creator_id) do update set provider = 'comp', status = 'active',
--     plan_code = 'max', provider_customer_id = null, provider_subscription_id = null,
--     current_period_end = null, cancel_at = null, occurred_at = 'infinity', updated_at = now();
--
-- Undo (back to free; the account can then buy through checkout as normal):
--
--   delete from public.lynxr_billing where creator_id = '<uuid>' and provider = 'comp';
--
-- Who is paying (comps show provider = 'comp' — they are counted as active by
-- spend_state()'s active_paid, so subtract them when reading revenue):
--
--   select creator_id, provider, plan_code, status, cancel_at, current_period_end
--     from public.lynxr_billing where status in ('active','trialing','past_due');
--
-- Recent events:
--
--   select event_type, outcome, received_at
--     from public.lynxr_billing_events order by received_at desc limit 20;
--
-- Prove a zero-change apply (run BEFORE and AFTER; the two must match):
--
--   select id, (public.allowance_state(id)->>'granted') as granted,
--              (public.allowance_state(id)->>'plan') as plan
--     from public.lynxr_creators order by id;
