-- Lynxr — scan state: whether lynxr can currently read the videos on a VERIFIED profile, in a form the creator can see.
-- Plan: ~/.claude/plans/tracking-always-works.md (2026-10-31; owner: "make it so that the tracking always work").
--
-- Dashboard → SQL Editor → New query → paste → Run. Safe to re-run. Run AFTER supabase/profiles.sql, and BEFORE pushing the
-- code that reads these columns. Without this file the pipeline and the creator app carry on exactly as before (both ask
-- whether the column exists first); they just cannot store or show private / gone.
-- **No real email, uuid or handle in this file — the repo is public.**
--
-- WHY NOT `status`. `status` is the VERIFICATION state. The scan lane only runs on verified profiles, and writing scan health
-- into `status` once told correctly verified creators their platform "didn't answer" (pipeline/track_posts.py scan_profile,
-- creator.js profStatus). Scan health has its own columns:
--   scan_state     null      not scanned since this column existed
--                  ok        the last scan read the profile (new videos or none: a quiet account is ok)
--                  private   the platform says the account is private: lynxr cannot see its videos. Re-checked on its own
--                            (TikTok every 6h, free; Instagram daily, one result that is also that day's follower count)
--                            and back to ok the first time it is public again.
--                  gone      the username does not exist on the platform any more (renamed or deleted), seen on two looks
--                            in a row. Re-checked the same way.
--                  failing   lynxr could not read it and the platform did not say why: lynxr's problem or the platform's,
--                            never the creator's. Retried.
--   scan_state_at  when scan_state last CHANGED (not every scan).
--
-- WRITER: the pipeline only (service role, pipeline/track_posts.py on the Fly worker).
-- RLS: unchanged, nothing to add. lynxr_profiles grants SELECT on the whole table to `authenticated` (so new columns are
-- readable), limited by the existing "creator reads own profiles" (auth.uid() = creator_id) and "staff read profiles"
-- (is_staff()) policies, and grants no INSERT / UPDATE / DELETE except to the service role. The self-test checks that.

do $$ begin
  if to_regclass('public.lynxr_profiles') is null then
    raise exception 'public.lynxr_profiles missing — run supabase/profiles.sql first';
  end if;
end $$;

alter table public.lynxr_profiles add column if not exists scan_state    text;
alter table public.lynxr_profiles add column if not exists scan_state_at timestamptz;
alter table public.lynxr_profiles drop constraint if exists lynxr_profiles_scan_state_check;
alter table public.lynxr_profiles add constraint lynxr_profiles_scan_state_check
  check (scan_state is null or scan_state in ('ok','private','gone','failing'));

comment on column public.lynxr_profiles.scan_state is
  'Whether lynxr can read this verified profile''s videos: ok | private | gone | failing (null = not known yet). Written by pipeline/track_posts.py only; never the verification state (that is status).';
comment on column public.lynxr_profiles.scan_state_at is 'When scan_state last changed.';

-- ── SELF-TEST. Reads the catalog only; writes nothing. A wrong answer raises and the whole file rolls back.
do $$ begin
  if not has_column_privilege('authenticated', 'public.lynxr_profiles', 'scan_state', 'SELECT') then
    raise exception 'self-test: a signed-in creator cannot read scan_state (expected: the table-wide select grant)';
  end if;
  if has_column_privilege('authenticated', 'public.lynxr_profiles', 'scan_state', 'UPDATE')
     or has_column_privilege('authenticated', 'public.lynxr_profiles', 'scan_state_at', 'UPDATE') then
    raise exception 'self-test: a signed-in creator could write scan state — re-run supabase/profiles.sql (it revokes writes)';
  end if;
  if has_column_privilege('anon', 'public.lynxr_profiles', 'scan_state', 'SELECT') then
    raise exception 'self-test: the anonymous role can read scan_state — re-run supabase/profiles.sql (it revokes anon)';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lynxr_profiles_scan_state_check') then
    raise exception 'self-test: lynxr_profiles_scan_state_check is missing';
  end if;
  raise notice 'profile_scan_state.sql self-test passed';
end $$;

notify pgrst, 'reload schema';

-- Check after it:
--   select platform, scan_state, count(*) from public.lynxr_profiles where verified_at is not null group by 1, 2 order by 1, 2;
