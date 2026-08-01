# Lynxr — session handoff

Read this, then `README.md` for architecture. Last updated 2026-08-01.

I'm building **Lynxr** (lynxr.io), a format-intelligence platform for my
short-form video agency, Lynx Media Group. Static site on GitHub Pages plus a
Python pipeline. Database: **9,905 videos** (TikTok 7,617 / Instagram 1,314 /
YouTube 974 — Facebook removed entirely) in Supabase `lynxr_videos` behind RLS.
The site is signed-in-only (email+password Supabase auth), reads everything
from Supabase, and now renders **recreation blueprints**: each video's verbatim
script on real timestamps with per-beat visual cues.

## Where things stand (verified)

- **Blueprints: 92% of the database has one** — 6,837 verbatim spoken scripts
  (6,540 with real Whisper segment timestamps), 7,131 visual shot lists
  (framing + on-screen text per frame, `pipeline/analyze_visuals.py`).
  All attached to `output/master_video_database.csv` via
  `pipeline/attach_transcripts.py`.
- **Tailored scripts are the video's exact words** (`realScript()` in app.js):
  segments → timed beats, nearest shot per beat, silent videos get shot-by-shot
  plans, honest "pattern template" label when no evidence exists. Shelf ranking
  is trend-first: format×hook combos with ≥4 videos ranked by MEDIAN index,
  top outlier excluded — no more one-lucky-upload suggestions.
- **Tags**: all rows tagged; only 2,411 are audio-verified accurate
  (`tag_source=audio`). The rest are caption-only until retag pass 2 (below).
- **UI**: whole site in Share Tech Mono ("digital clock" font, self-hosted,
  with Outfit fallback), agency-style footer with scroll-scrubbed split-flap
  wordmark, trend bars with hover states, responsive header, count-up numbers.
  Assets are version-stamped (`?v=YYYYMMDDx`) — bump on every css/js change or
  browsers serve stale files.
- **Client sync fixed**: two real bugs — empty-body JSON parse made every save
  look failed, and the 1-hour token expiry 401'd all writes. sbFetch now
  refreshes+retries; badge says "syncing" and self-heals.

## THE THREE GATES to finish everything

1. **Anthropic credits (~$60–100 total)** — ran out 2026-08-01 midday:
   - finish visual shot lists: 2,610 remain (~$15–25) — rerun
     `analyze_visuals.py`, it skips done rows and retries credit-failures
   - retag pass 2, the accuracy pass for ~7K caption-tagged rows (~$25–40):
     `retag_with_audio.py` (skips tag_source=audio rows — do NOT use --all)
   - extra dims for the new rows (~$20–30): tag_extra_dims has NO batch
     resume — if it fails mid-run, recover via its batch_state like on 07-31.
2. **Owner runs one ALTER in the Supabase SQL editor** (then export works):
   `alter table public.lynxr_videos add column if not exists transcript_segments text not null default '';`
   `alter table public.lynxr_videos add column if not exists visual_cues text not null default '';`
   (hook_spoken + transcript columns were already added 2026-07-31.)
3. ~~Transcription~~ **DONE 2026-08-01**: 6,952 verbatim scripts (70%),
   6,925 with real timestamps, 6,989 usable spoken hooks, cleaned and attached
   to master. Blueprints now 93%. Only gates 1 and 2 remain.

## Resume sequence (after credits + ALTER)

```bash
cd ~/Documents/lynxrio && set -a && source .env && set +a
./venv/bin/python pipeline/transcribe.py                  # finish if stopped
./venv/bin/python pipeline/transcribe.py --redo-nosegments
./venv/bin/python pipeline/clean_transcripts.py           # NOTE: check hook_usable
./venv/bin/python pipeline/analyze_visuals.py             # finish shot lists
./venv/bin/python pipeline/retag_with_audio.py            # accuracy pass 2
./venv/bin/python pipeline/tag_extra_dims.py              # cta/visual/delivery
./venv/bin/python pipeline/attach_transcripts.py          # fold into master
./venv/bin/python pipeline/export_supabase.py             # push everything live
```
Then re-run a blind accuracy audit (baseline: format 81.7 / hook 78.6 /
niche 88.1 / audience 92.9 caption-only) so the gain is measured, not assumed.

## Hard-won context — don't rediscover

- **Every master-rewriting script trims to `MASTER_FIELDS`** (merge_data.py).
  Any new column MUST be added there or the next rewrite silently drops it
  (this destroyed the extra-dims once; recovered from the batch state).
- **merge_data.py is a full REBUILD from tagged CSVs** — running it discards
  retag/extra-dims/transcripts. Append new rows the way this session did
  (load_scraped + dedupe + rewrite with full fields) or re-attach after.
- attach_transcripts: LAST line per video_id in transcripts.jsonl wins
  (re-transcribed entries with segments replace old ones).
- Structured outputs need `"additionalProperties": false` on every object.
- `data/*_parts*/` + `data/covers/` feed retag/tag_extra (duration, music,
  frames) — don't delete until the FULL pipeline has run and been verified.
- The preview pane caches file:// assets brutally — bump the `?v=` stamp.
- Never `git push` from the agent shell (no credentials) — user pushes from
  VS Code. Repo is public: no secrets in files, publishable key is by design.
- UGC creator roster in scrape_instagram/scrape_youtube HANDLES/CHANNELS was
  mined from TikTok UGC hashtags (unverified 1K–150K-follower accounts);
  user can swap in their Sideshift roster anytime.
- Old TODOs that still stand: rotate the Supabase service_role key (leaked in
  chat 07-31), purge data.enc + `lmaotsfiya` from git history, delete
  `data/covers/` (~300MB) once the full pipeline is verified.

## How I like to work

Verify with real data or in the browser rather than assuming — the sync-badge
bug "looked like" an auth issue but was an empty-body JSON parse; the script
accuracy "looked" fine until measured. Tell me plainly when something is
broken, blocked, or worse than hoped. Keep the UI professional and
information-dense; motion minimal and functional (the split-flap footer is the
agreed ceiling).
