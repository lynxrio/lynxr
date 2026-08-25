-- lynxr-clips: a self-hosted 480p proxy of each source video, so the creator
-- app can play the original beside its script instead of embedding the
-- platform's own player. See ~/.claude/plans/creator-self-hosted-clip-and-
-- follow.md for the full design; this file is the reproducible half of it.
--
-- THIS BUCKET IS PUBLIC. Anyone who has the object URL can fetch the video
-- with no sign-in at all — same posture as `lynxr-covers` today. Row-level
-- security on `lynxr_creators` / `lynxr_sources` protects the URL (which
-- creator can see which row), not the bytes: a public Storage bucket serves
-- the object to anyone, authenticated or not. The object key is
-- `sha1(canonical_url)[:20]` — unguessable in practice, not access-controlled
-- in principle. This was the owner's explicit call (Decision 2, option (a) in
-- the plan above), taken knowing the alternative (a private bucket + signed
-- URLs minted per play) closes that gap at the cost of a cache-cold play on
-- every view.
--
-- Free-plan per-file limit is 50MB unless raised in the dashboard (schema.sql
-- already notes this for lynxr-blueprints). The largest clip measured while
-- planning this feature was 5.1MB — a 10x margin.
--
-- WRAPPED DEFENSIVELY ON PURPOSE, same reason as schema.sql:234-259.
-- storage.buckets/storage.objects are owned by the storage extension, and the
-- SQL editor's role may not own them; an unguarded failure here would roll
-- back this whole statement. `lynxr-covers` itself has no SQL in this repo at
-- all — it was made by hand in the dashboard. This file exists so the new
-- bucket is reproducible instead of a second dashboard-only artifact.
do $$
begin
  insert into storage.buckets (id, name, public)
    values ('lynxr-clips', 'lynxr-clips', true)
    on conflict (id) do nothing;
exception when others then
  raise notice 'lynxr-clips bucket not created (%). Create it by hand: Storage -> New bucket -> lynxr-clips, Public.', sqlerrm;
end $$;

-- Carries the clip through the cross-paste source cache (lynxr_sources), the
-- same way `script`/`shots`/`tags` already do, so a second creator pasting a
-- video someone else already clipped gets the player instead of a bare
-- fallback. Nullable: an older row genuinely has no clip.
alter table public.lynxr_sources add column if not exists clip text;
