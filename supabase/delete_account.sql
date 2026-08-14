-- ---------------------------------------------------------------------------
-- DELETE YOUR OWN ACCOUNT (2026-08-17)
-- Dashboard -> SQL Editor -> New query -> paste -> Run. Safe to re-run.
-- ---------------------------------------------------------------------------
-- The privacy policy promises deletion within 30 days. This makes it immediate
-- and self-serve, which is better for the creator and removes a manual job.
--
-- WHY A FUNCTION AND NOT AN API CALL. Deleting a row from auth.users needs the
-- service-role key. The browser only ever holds the publishable key — this repo
-- is public, so anything the page ships is readable by everyone — and a page
-- that could reach the admin API would let ANY visitor delete ANY account.
--
-- security definer runs the body as the function's owner (postgres), which can
-- write to auth.users, while `auth.uid()` pins it to whoever is calling. So a
-- signed-in creator can delete exactly one account: their own. There is no
-- parameter, deliberately — an id argument is the whole vulnerability.
--
-- WHAT GOES WITH IT. Nothing here deletes application data by hand, because the
-- foreign keys already say what should happen:
--     lynxr_creators.id  references auth.users(id) ON DELETE CASCADE
--         -> their brands, library, scripts and trash go with the account.
--     lynxr_staff.id     references auth.users(id) ON DELETE CASCADE
--     lynxr_feedback.creator_id references auth.users(id) ON DELETE SET NULL
--         -> feedback text survives, detached from the person who sent it.
--            That is intended: the note stays useful, the link to them does not.
--
-- NOT deleted: lynxr_sources. That table is keyed by canonical video URL and
-- holds facts about publicly posted videos — no creator id, no personal data —
-- and it is shared across everyone. The privacy policy is written to match:
-- it promises "your companies, your saved links, your scripts", all of which
-- live in lynxr_creators. Keep the two in step if you change either.

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
-- Pinned so a caller-controlled search_path cannot shadow `auth` with their own
-- schema and point the delete somewhere else.
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  delete from auth.users where id = uid;
end
$$;

-- anon must never reach this. Only a signed-in caller, and even then it can
-- only ever act on their own row.
revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;

comment on function public.delete_own_account() is
  'Deletes the CALLING user''s auth.users row; application data follows via ON
   DELETE CASCADE. Takes no arguments on purpose — auth.uid() is the only
   subject it will ever act on.';
