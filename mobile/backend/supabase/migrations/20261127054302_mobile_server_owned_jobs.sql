-- REVIEW ONLY. Not applied to production. Requires existing creator, staff, allowance and billing contracts.
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
  perform pg_advisory_xact_lock(hashtextextended(p_creator::text, 901));
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

create schema if not exists lynxr_mobile_private;
revoke all on schema lynxr_mobile_private from public, anon, authenticated;
create table lynxr_mobile_private.settings (id boolean primary key default true check(id), enabled boolean not null default false);
insert into lynxr_mobile_private.settings values(true,false);

create table public.lynxr_mobile_brands (
 id uuid primary key, creator_id uuid not null references auth.users(id) on delete cascade,
 name text not null check(length(name) between 1 and 120), description text not null check(length(description) between 1 and 4000),
 created_at timestamptz not null default now()
);
create table public.lynxr_mobile_deletions (
 creator_id uuid primary key references auth.users(id) on delete cascade,
 requested_at timestamptz not null default now()
);
create table public.lynxr_mobile_jobs (
 id uuid primary key, creator_id uuid not null references auth.users(id) on delete cascade,
 source_url text not null, brand_id text not null default '', brand_snapshot jsonb, creator_snapshot jsonb not null default '{}'::jsonb,
 consented_at timestamptz not null default now(), consent_version text not null default 'mobile-rights-ai-v1',
 status text not null default 'queued' check(status in ('queued','running','done','error')),
 result jsonb, error_code text, attempt int not null default 0,
 lease_token uuid, lease_until timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(creator_id,source_url,brand_id)
);
create table public.lynxr_mobile_requests (
 id uuid primary key, creator_id uuid not null references auth.users(id) on delete cascade,
 source_url text not null, brand_id text not null,
 job_id uuid not null references public.lynxr_mobile_jobs(id) on delete cascade
);
alter table public.lynxr_mobile_requests enable row level security;
revoke all on public.lynxr_mobile_requests from anon,authenticated;
create index lynxr_mobile_jobs_queue on public.lynxr_mobile_jobs(created_at) where status='queued';
create table public.lynxr_mobile_reports (
 id uuid primary key default gen_random_uuid(), creator_id uuid not null references auth.users(id) on delete cascade,
 job_id uuid not null references public.lynxr_mobile_jobs(id) on delete cascade,
 reason text not null check(length(reason) between 1 and 2000), created_at timestamptz not null default now()
);
-- Expose no client table writes. RPC ownership checks remain necessary even with RLS.
alter table public.lynxr_mobile_brands enable row level security;
alter table public.lynxr_mobile_deletions enable row level security;
alter table public.lynxr_mobile_jobs enable row level security;
alter table public.lynxr_mobile_reports enable row level security;
revoke all on public.lynxr_mobile_brands, public.lynxr_mobile_deletions, public.lynxr_mobile_jobs, public.lynxr_mobile_reports from anon, authenticated;

create function lynxr_mobile_private.owner() returns uuid language plpgsql stable security definer set search_path='' as $$
declare u uuid := auth.uid();
begin
 if u is null or not exists(select 1 from auth.users where id=u and not coalesce(is_anonymous,false))
 or exists(select 1 from public.lynxr_staff where id=u) then raise exception 'creator_required'; end if;
 return u;
end $$;
revoke all on function lynxr_mobile_private.owner() from public,anon,authenticated;

create function lynxr_mobile_private.writable(u uuid) returns void language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce((select enabled from lynxr_mobile_private.settings where id),false) then raise exception 'mobile_unavailable'; end if;
 if exists(select 1 from public.lynxr_mobile_deletions where creator_id=u) then raise exception 'deletion_pending'; end if;
 -- Initial release exposes only the free service. No purchased entitlement unlock.
 if coalesce((select plan_code from public.entitlement_for(u)),'free') <> 'free' then raise exception 'free_release_only'; end if;
end $$;
revoke all on function lynxr_mobile_private.writable(uuid) from public,anon,authenticated;

create function lynxr_mobile_private.canonical(raw text) returns text language plpgsql immutable set search_path='' as $$
declare m text[]; clean text := split_part(split_part(btrim(raw),'?',1),'#',1);
begin
 if length(raw)>2048 then raise exception 'unsupported_url'; end if;
 m := regexp_match(clean,'^https://(?:www\.)?instagram\.com/(?:reel|reels|p)/([A-Za-z0-9_-]+)/?$');
 if m is not null then return 'https://www.instagram.com/reel/'||m[1]||'/'; end if;
 m := regexp_match(clean,'^https://(?:www\.)?tiktok\.com/(@[A-Za-z0-9._-]+)/video/([0-9]+)/?$');
 if m is not null then return 'https://www.tiktok.com/'||m[1]||'/video/'||m[2]; end if;
 m := regexp_match(clean,'^https://(vm|vt)\.tiktok\.com/([A-Za-z0-9]+)/?$');
 if m is not null then return 'https://'||m[1]||'.tiktok.com/'||m[2]||'/'; end if;
 raise exception 'unsupported_url';
end $$;
revoke all on function lynxr_mobile_private.canonical(text) from public,anon,authenticated;

create function public.mobile_snapshot() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u uuid := lynxr_mobile_private.owner();
begin
 return jsonb_build_object('enabled',(select enabled from lynxr_mobile_private.settings where id),
 'deletionPending',exists(select 1 from public.lynxr_mobile_deletions where creator_id=u),
 'allowance',public.allowance_state(u),
 'brands',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'description',description)) from public.lynxr_mobile_brands where creator_id=u),'[]'::jsonb),
 'jobs',coalesce((select jsonb_agg(jsonb_build_object('id',id::text,'mobile',true,'sourceUrl',source_url,'brandId',nullif(brand_id,''),'brandName',brand_snapshot->>'name','status',status,'addedAt',created_at,'noteKind','mobile','note',error_code,'retryable',status='error') || coalesce(result,'{}'::jsonb) order by created_at desc) from public.lynxr_mobile_jobs where creator_id=u),'[]'::jsonb));
end $$;

create function public.mobile_create_brand(p_id uuid,p_name text,p_description text) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid := lynxr_mobile_private.owner(); b public.lynxr_mobile_brands;
begin
 perform lynxr_mobile_private.writable(u);
 insert into public.lynxr_mobile_brands(id,creator_id,name,description) values(p_id,u,btrim(p_name),btrim(p_description)) on conflict(id) do nothing;
 select * into b from public.lynxr_mobile_brands where id=p_id;
 if b.creator_id<>u or b.name<>btrim(p_name) or b.description<>btrim(p_description) then raise exception 'idempotency_conflict'; end if;
 return p_id;
end $$;

create function public.mobile_submit_job(p_id uuid,p_url text,p_brand text,p_consent boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid := lynxr_mobile_private.owner(); url text := lynxr_mobile_private.canonical(p_url);
 b jsonb; j public.lynxr_mobile_jobs; r public.lynxr_mobile_requests; charged text;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,901));
 perform lynxr_mobile_private.writable(u);
 if p_consent is distinct from true then raise exception 'consent_required'; end if;
 p_brand := coalesce(p_brand,'');
 select * into r from public.lynxr_mobile_requests where id=p_id;
 if found then
  if r.creator_id<>u or r.source_url<>url or r.brand_id<>p_brand then raise exception 'idempotency_conflict'; end if;
  return r.job_id;
 end if;
 select * into j from public.lynxr_mobile_jobs where creator_id=u and source_url=url and brand_id=p_brand;
 if found then
  insert into public.lynxr_mobile_requests values(p_id,u,url,p_brand,j.id);
  return j.id;
 end if;
 if p_brand<>'' then
  select jsonb_build_object('id',id::text,'name',name,'description',description) into b from public.lynxr_mobile_brands where creator_id=u and id::text=p_brand;
  if b is null then select x into b from public.lynxr_creators c cross join lateral jsonb_array_elements(case when jsonb_typeof(c.data->'brands')='array' then c.data->'brands' else '[]'::jsonb end) x where c.id=u and x->>'id'=p_brand limit 1; end if;
  if b is null then raise exception 'brand_not_found'; end if;
 end if;
 select x into charged from public.charge_scripts(u,array['mobile:'||p_id::text]) x;
 if charged is null then raise exception 'allowance_exhausted'; end if;
 insert into public.lynxr_mobile_jobs(id,creator_id,source_url,brand_id,brand_snapshot,creator_snapshot)
 values(p_id,u,url,p_brand,b,coalesce((select jsonb_strip_nulls(jsonb_build_object('name',data->'name','niches',data->'niches','about',data->'about','never',data->'never')) from public.lynxr_creators where id=u),'{}'::jsonb));
 insert into public.lynxr_mobile_requests values(p_id,u,url,p_brand,p_id);
 return p_id;
end $$;

create function public.mobile_retry_job(p_id uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid := lynxr_mobile_private.owner(); j public.lynxr_mobile_jobs; charged text;
begin
 perform pg_advisory_xact_lock(hashtextextended(u::text,901));
 perform lynxr_mobile_private.writable(u);
 select * into j from public.lynxr_mobile_jobs where id=p_id and creator_id=u for update;
 if not found then raise exception 'job_not_found'; end if;
 if j.status<>'error' then return j.id; end if;
 if j.attempt>=3 then raise exception 'retry_limit'; end if;
 select x into charged from public.charge_scripts(u,array['mobile:'||p_id::text]) x;
 if charged is null then raise exception 'allowance_exhausted'; end if;
 update public.lynxr_mobile_jobs set status='queued',error_code=null,lease_token=null,lease_until=null,updated_at=now() where id=p_id;
 return p_id;
end $$;

create function public.mobile_request_deletion() returns timestamptz language plpgsql security definer set search_path='' as $$
declare u uuid := lynxr_mobile_private.owner(); t timestamptz;
begin
 insert into public.lynxr_mobile_deletions(creator_id) values(u) on conflict do nothing;
 select requested_at into t from public.lynxr_mobile_deletions where creator_id=u;
 return t;
end $$;
create function public.mobile_report_script(p_id uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare u uuid := lynxr_mobile_private.owner();
begin
 if not exists(select 1 from public.lynxr_mobile_jobs where id=p_id and creator_id=u) then raise exception 'job_not_found'; end if;
 insert into public.lynxr_mobile_reports(creator_id,job_id,reason) values(u,p_id,p_reason);
end $$;

-- Worker-only RPCs. Leases fence stale completions. Expiry never auto-repeats inference.
create function public.mobile_claim_job() returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.lynxr_mobile_jobs;
begin
 if not coalesce((select enabled from lynxr_mobile_private.settings where id),false) then return null; end if;
 select * into j from public.lynxr_mobile_jobs where status='queued'
 and not exists(select 1 from public.lynxr_mobile_deletions where creator_id=lynxr_mobile_jobs.creator_id)
 order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 update public.lynxr_mobile_jobs set status='running',attempt=attempt+1,lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',updated_at=now() where id=j.id returning * into j;
 return to_jsonb(j);
end $$;
create function public.mobile_heartbeat(p_id uuid,p_token uuid) returns boolean language sql security definer set search_path='' as $$
 with changed as(update public.lynxr_mobile_jobs set lease_until=now()+interval '5 minutes',updated_at=now() where id=p_id and status='running' and lease_token=p_token and lease_until>now() returning 1) select exists(select 1 from changed);
$$;
create function public.mobile_finish_job(p_id uuid,p_token uuid,p_result jsonb,p_error text) returns boolean language plpgsql security definer set search_path='' as $$
declare j public.lynxr_mobile_jobs;
begin
 select * into j from public.lynxr_mobile_jobs where id=p_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_token or j.lease_until<=now() then return false; end if;
 if p_error is null and (p_result is null or jsonb_typeof(p_result)<>'object' or not (p_result ? 'adaptation' or p_result ? 'source')) then raise exception 'invalid_result'; end if;
 if p_error is not null and p_error not in ('source_unavailable','processing_failed','interrupted') then raise exception 'invalid_error'; end if;
 update public.lynxr_mobile_jobs set status=case when p_error is null then 'done' else 'error' end,
 result=case when p_error is null then p_result - array['id','mobile','status','brandId','brandName','sourceUrl','addedAt','retryable','note','noteKind'] else null end,
 error_code=p_error,lease_token=null,lease_until=null,updated_at=now() where id=p_id;
 if p_error is not null then perform public.refund_script('mobile:'||p_id::text); end if;
 return true;
end $$;
create function public.mobile_expire_jobs() returns integer language plpgsql security definer set search_path='' as $$
declare j public.lynxr_mobile_jobs; n integer:=0;
begin
 for j in select * from public.lynxr_mobile_jobs where status='running' and lease_until<=now() for update skip locked loop
  update public.lynxr_mobile_jobs set status='error',error_code='interrupted',lease_token=null,lease_until=null,updated_at=now() where id=j.id;
  perform public.refund_script('mobile:'||j.id::text); n:=n+1;
 end loop;
 return n;
end $$;

revoke all on function public.mobile_snapshot(),public.mobile_create_brand(uuid,text,text),public.mobile_submit_job(uuid,text,text,boolean),public.mobile_retry_job(uuid),public.mobile_request_deletion(),public.mobile_report_script(uuid,text) from public,anon;
grant execute on function public.mobile_snapshot(),public.mobile_create_brand(uuid,text,text),public.mobile_submit_job(uuid,text,text,boolean),public.mobile_retry_job(uuid),public.mobile_request_deletion(),public.mobile_report_script(uuid,text) to authenticated;
revoke all on function public.mobile_claim_job(),public.mobile_heartbeat(uuid,uuid),public.mobile_finish_job(uuid,uuid,jsonb,text),public.mobile_expire_jobs() from public,anon,authenticated;
grant execute on function public.mobile_claim_job(),public.mobile_heartbeat(uuid,uuid),public.mobile_finish_job(uuid,uuid,jsonb,text),public.mobile_expire_jobs() to service_role;
