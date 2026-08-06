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

## CURRENT PRIORITY: finish the FASHION vertical (owner's AI-stylist app)

Fashion & Beauty: 1,291 rows merged + filtered + caption-tagged (100%).
Transcription (large model) + cover fetch were running overnight 08-02.
All three credit-gated scripts now take --niche "Fashion & Beauty".

**On the next Anthropic top-up (~$20 covers fashion; ~$60-75 finishes ALL),
run fashion-first, sequentially:**
```bash
cd ~/Documents/lynxrio && set -a && source .env && set +a
./venv/bin/python pipeline/analyze_visuals.py --niche "Fashion & Beauty" --workers 3
./venv/bin/python pipeline/retag_with_audio.py --niche "Fashion & Beauty"
./venv/bin/python pipeline/tag_extra_dims.py --niche "Fashion & Beauty"
./venv/bin/python pipeline/enrich_signals.py
./venv/bin/python pipeline/attach_transcripts.py
./venv/bin/python pipeline/export_supabase.py
```
Then the same three without --niche for the rest of the database
(retag remainder ~3,380 rows, visuals ~2,600, extra dims ~5,800).
Retag/extra-dims are id-keyed + chunk-submitted now (network-safe, resume-safe,
never re-bill: retag skips tag_source=audio, extra-dims skips cta_type set).

**Owner ALTER still pending** (signal columns; export includes them and will
400 until this runs in the dashboard SQL editor):
```sql
alter table public.lynxr_videos
  add column if not exists creator_followers    text not null default '',
  add column if not exists saves                text not null default '',
  add column if not exists shares               text not null default '',
  add column if not exists save_ratio           text not null default '',
  add column if not exists views_to_followers   text not null default '',
  add column if not exists reach_confidence_tier text not null default '',
  add column if not exists similar_format_count text not null default '',
  add column if not exists avg_views_of_similar text not null default '';
```
(The site tolerates the missing columns via fetch fallback; export does not.)

SCRAPING_SPEC.md is the owner's canonical content policy — enrich_signals.py
(signals + repeatability tiers) and filter_database.py (gates incl. the
<100K-followers rule) implement it. Tiers show as chips on shelf cards.

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

- **Campaign estimate calibration (owner, 2026-08-03): 3M views / 10 creators
  / month = SUCCESS** (≈300K per creator-month, ≈15K/video avg). Three-layer
  model in app.js: per-post bar = client's own platform medians; day-to-day
  expectation = `planRange` — MEDIAN of the client's trailing-14-day posts
  (posts ≥3 days old, check-ins as of the queried date only — no look-ahead),
  band = mid ×0.8 / ×1.5, cold band {350/530/800} for the first 10 days,
  warmed floor {1000/1250/1500}; business reference = success pace line
  (`ctx.successViews30d`, entered per client — 3M ÷ that client's creators).
  Both plan fields are set in the client editor (`ce-vpm` / `ce-success`);
  `findOrCreateClient` MERGES ctx so brief saves can't wipe them. Never judge
  a single post against the success bar.
- **Train/test calibration (owner, 2026-08-03): Cloey = training, next
  campaign = testing.** `ctx.calibrationRole` (client editor). Training
  campaigns feed `trainedBand()` (20/50/80th percentile of mature ≥7-day
  posts, owner constants until ≥20 posts). Testing campaigns are held out:
  `planRange` refuses to self-calibrate from their own numbers, and the
  client page shows a "Model test — held out" card (in-band %, bias).
- **One-team sync**: every signed-in account is one workspace. Devices push
  only clients whose content changed (fingerprint + `updatedAt`), merge is
  last-write-wins, deletions propagate via the shared `deleted-clients`
  tombstone row, and the site re-pulls on tab focus + a 90s heartbeat.
- **Client video blueprints get the FULL database treatment**: client page →
  paste a posted link (LINK-ONLY — the browser file-upload path was removed
  2026-08-06; the pipeline fetches media itself via yt-dlp) → queued entry on
  the client record
  → `pipeline/process_blueprints.py` runs the same passes as the database:
  Whisper verbatim script + segments (local, free), frames at beat starts →
  shot list (analyze_visuals fns), locked-taxonomy tags from audio + opening
  frame (retag_with_audio SYSTEM, opus). Shots+tags need ANTHROPIC_API_KEY
  (pennies each; `--no-ai` skips). The site renders finished entries through
  realScript via bpAsRow — identical blueprint UI to database rows. No
  Supabase setup needed: the `lynxr-blueprints` storage section in
  supabase/schema.sql is now unused by the site (the worker still reads
  `path` entries so any legacy upload still processes).
- **Blueprints run THEMSELVES**: launchd agent `io.lynxr.blueprints`
  (~/Library/LaunchAgents/io.lynxr.blueprints.plist) runs the worker every
  3 min in the background — no Claude, no terminal. Site + DB + queue are
  hosted (GitHub Pages / Supabase), so the only constraint is the Mac being
  awake; queued items wait harmlessly until it is. The plist carries
  PATH=/opt/homebrew/bin (launchd has no Homebrew PATH; ffmpeg broke without
  it). Retry policy: error entries auto-retry, partial-AI entries retry via
  --redo-ai, both on a 6h cooldown (`--cooldown-hours`). Log:
  output/blueprints_daemon.log. Manage:
  `launchctl bootout/bootstrap gui/$UID ~/Library/LaunchAgents/io.lynxr.blueprints.plist`.

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

