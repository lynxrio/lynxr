# Lynxr — session handoff

Read this, then `README.md` for architecture. Last updated 2026-07-31.

I'm building **Lynxr** (lynxr.io), a format-intelligence platform for my
short-form video agency, Lynx Media Group. Static site on GitHub Pages plus a
Python pipeline. Database is **2,640 tagged videos** (1,188 Medceptor UGC +
1,452 scraped TikTok), served from Supabase table `lynxr_videos` behind RLS
(the old encrypted `data.enc` blob is retired).

Site tabs: **Database** (stats, split bars, filterable table), **New Client**
(paste a client site → detect niche/features → shop a shelf → pick 10 → save a
brief), **Clients** (folders with campaign health, month graph, numbered briefs,
per-brief post tracking with predicted-vs-actual charts, and a learning loop
where tracked performance shapes the next brief).

---

## 1. IN PROGRESS — video database moved into Supabase (verify this first)

The whole database now lives in Supabase: auth, client sync, AND the 2,640
video rows (table `lynxr_videos`). `app.js` no longer fetches/decrypts
`data.enc` — after sign-in it pages the rows out of PostgREST (1,000/page)
and hands the same array to `renderApp()`. Why: the old bundle passphrase had
been committed in plaintext (schema.sql + this file), making the encryption
decorative; RLS replaces it outright.

- Project: `esakjfogplfszievvabi` · API `https://esakjfogplfszievvabi.supabase.co`
- Publishable key is in `app.js` and is **public by design** — the repo is
  public. Safe only because RLS grants access to `authenticated` and nothing to
  `anon`. See `supabase/schema.sql`.
- `lynxr_videos`: SELECT for `authenticated` only, **no write policies** —
  writes go through `pipeline/export_supabase.py` with the service-role key
  (`SUPABASE_SERVICE_ROLE_KEY` in `.env`, never committed).
- First load SQL is generated at `output/load_videos.sql` (gitignored, holds
  the plaintext DB — run in dashboard SQL editor, never commit).

**Remaining steps, in order:**
1. Owner signs into supabase.com in Chrome → run all of `supabase/schema.sql`
   in the SQL editor. It creates `lynxr_videos` AND drops the retired
   `lynxr_secrets` table (which still holds the leaked passphrase). Then run
   `output/load_videos.sql`; verify `select count(*) from lynxr_videos;` = 2640
   and `select count(*) from lynxr_secrets;` errors (table gone).
2. Owner signs into the site (preview) → verify: rows load, badge `● shared`,
   stats/bars/table paint correctly.
3. **BLOCKED until the git-history purge (see below): do not push yet.** The
   working-tree commit removes `data.enc` and the plaintext passphrase, but a
   normal push leaves BOTH in public history — the whole DB stays decryptable.
   Purge first: `git filter-repo --path data.enc --invert-paths` plus a
   replace-text pass stripping `lmaotsfiya` from `schema.sql` history, then
   `git push --force`. Treat the July 2026 snapshot as already public
   regardless (forks/caches may retain it); never reuse `lmaotsfiya`.
4. Owner adds `SUPABASE_SERVICE_ROLE_KEY` to `.env` so future pipeline runs
   can upsert without the dashboard.

## 2. IN PROGRESS — multimodal retagging (blocked on credits)

Tags were originally caption-only. A blind 6-judge audit measured **format
81.7%, hook 78.6%, niche 88.1%, audience 92.9%**. Captions cannot reveal the
spoken hook or the visual, so we added audio and vision.

- `pipeline/transcribe.py` — yt-dlp + mlx-whisper, local and free. **~1,254 of
  2,634 done; it was running in background and is now stopped. Just re-run it,
  it resumes.** ~2.7s/video.
- `pipeline/fetch_covers.py` — DONE, 1,743 opening frames in `data/covers/`.
- `pipeline/clean_transcripts.py` — quality filter, run after transcription.
- `pipeline/retag_with_audio.py` — the multimodal retag (audio + opening frame
  + caption + music metadata). **BLOCKED: Anthropic credits ran out** — confirmed
  2026-07-31 with a live 3-request test that returned HTTP 400 "credit balance
  is too low" (not a malformed request — the shape is valid). Budget ~$10–15.

### Extra taxonomy dimensions (`pipeline/tag_extra_dims.py`, added 2026-07-31)

Adds the five dimensions the caption-only pass never produced. Columns exist on
`lynxr_videos` (schema.sql + a live ALTER) and in the master CSV.
- **length_bucket, audio_trend — DONE and live.** Mechanical (video duration +
  TikTok music metadata), no API. Populated on ~1,510/2,640 (bounded by
  duration/music coverage, grows as transcription finishes). Re-run
  `tag_extra_dims.py --mechanical-only` after more transcription.
- **cta_type, visual_hook, hook_delivery — built, BLOCKED on the same credits.**
  One multimodal request per video (caption + transcript + cover frame), forced-
  choice against the locked vocab in `taxonomy.py`. `hook_delivery` is
  intentionally conservative: energy needs real audio/video, so it only fires on
  a visible shocked face or a narrative transcript, else "Other" (= not
  determinable). Run `tag_extra_dims.py` (no flag) once credits exist.

**Sequence to finish (needs credits):**

```bash
cd ~/Documents/lynxrio
./venv/bin/python pipeline/transcribe.py         # resume; run twice to sweep retries
./venv/bin/python pipeline/clean_transcripts.py
./venv/bin/python pipeline/retag_with_audio.py   # re-tag format/hook/niche/audience
./venv/bin/python pipeline/tag_extra_dims.py     # cta/visual/hook-delivery (+ refresh mechanical)
./venv/bin/python pipeline/export_supabase.py    # upsert all tags -> lynxr_videos
```

Then **re-run the blind accuracy audit** and compare to the baseline above, so
the gain is measured rather than assumed.

## Hard-won context — please don't rediscover these

- `.env` holds `ANTHROPIC_API_KEY`, `APIFY_API_TOKEN`, and (once added)
  `SUPABASE_SERVICE_ROLE_KEY` (gitignored). Use `./venv/bin/python -m pip` —
  the venv's `pip` shebang is stale after a rename.
- **Never commit** `data.json`, `output/`, or any secret value — including
  seeds in `supabase/schema.sql`; the repo is public. Plaintext was committed
  early and had to be purged from git history, and the old bundle passphrase
  leaked the same way (which is why data.enc was retired for RLS).
- **Tag one video per API request.** A batched design asked for an array of N
  and the model returned a valid 1-element array and stopped — silently tagging
  ~45% of rows. Coverage is verified now and errors below 95%.
- **~40% of videos have no speech** (music + on-screen text). Whisper
  hallucinates on those, looping "I'm sorry" or emitting "Thanks for watching!".
  Detected in both transcribe and clean steps. "No speech" is a useful answer,
  not a gap — the cover frame usually carries the hook.
- **Don't detect lyrics with heuristics.** Built one, measured it wrong both
  ways (rejected a maths problem read aloud and an app list; kept real lyrics).
  The tagger judges from the full transcript instead.
- **Licensed music does NOT mean no speech** — creators talk over trending
  sounds constantly. `musicMeta.musicOriginal` is context, never a verdict.
- **TikTok h265 downloads often have no audio track** despite advertising aac,
  which caused a ~6% transcription failure rate. The selector prefers h264;
  failures dropped to ~1%.
- **Strict CSP**: `style-src 'self'`, no `'unsafe-inline'` — inline
  `style="..."` is silently discarded. Set styles via CSSOM. This shipped
  invisible bar charts once. Verify **painted pixels**, not DOM state.
- **No `confirm()`** — suppressed by browsers, returns false instantly, broke
  every delete button. Deletes use a two-click armed state.

## Known gaps / next up

- **Cross-platform scraping is now TikTok + Instagram + YouTube.** All three
  land in the same 12-column schema and tag identically. TikTok = hashtag-based
  (`scrape_tiktok.py`, hashtags retargeted to UGC-focused 2026-07-31); Instagram
  and YouTube = creator-based (`scrape_instagram.py` / `scrape_youtube.py`, seeded
  with the Cloey creator handles — edit `HANDLES` / `CHANNELS`). Downstream
  (transcribe, covers, retag, merge, export) is platform-agnostic, so accurate
  multimodal tagging flows across all three once Anthropic credits exist.
- **YouTube Shorts — WORKING, verified 2026-07-31** (`scrape_youtube.py`,
  `streamers/youtube-shorts-scraper`). Live pull of the 3 Cloey creators: 21
  shorts → 21 normalized rows, 0 skipped; view counts matched Sideshift exactly
  (4747/2658/2285). Bonus: the actor also returns `subtitles`/`text` (transcript)
  and `duration`, so YouTube rows carry spoken content + length for free.
- **Apify** had a monthly hard limit that was hit earlier; the owner raised it
  2026-07-31 and all three scrapers now run (IG + YT verified live). The ~9K
  remainder of the 10K TikTok batch (`scrape_tiktok_batch2.py`) can resume.
- **Instagram Reels — WORKING, verified end-to-end 2026-07-31.**
  `scrape_instagram.py` now uses `apify/instagram-reel-scraper` (the old
  `apify/instagram-hashtag-scraper` returned photos/carousels only — 0 videos).
  Live natgeo pull: 24 Reels → `process_scraped.py instagram` → 24 normalized
  rows, 0 skipped, full 12-col schema (placeholder data was cleared afterward,
  DB untouched). `normalize_instagram()` reads its fields unchanged; hardened for
  the `likesCount == -1` hidden-likes sentinel. It is **creator-based, not
  hashtag-based** — Instagram hashtag pages are unreliable, so this actor takes
  handles/profile URLs. Put the creators you want in the `HANDLES` list (bare
  usernames), e.g. your Sideshift roster, then run the pipeline. Transcript and
  share-count are paid add-ons (`INCLUDE_TRANSCRIPT` / `INCLUDE_SHARES`, off).
- Cover images are TikTok's chosen thumbnail, usually early but not guaranteed
  frame one. True first frames need video downloads.
- Transcripts (`output/transcripts.jsonl`) and cover frames (`data/covers/`)
  exist only on this Mac; once transcription finishes they could join Supabase
  as a second table + Storage bucket, keyed on `(platform, video_id)`.
- Sideshift daily snapshots (see `output/sideshift_cloey_*`) could feed the
  Clients tab's predicted-vs-actual tracking automatically.

## How I like to work

Verify with real data or in the browser rather than assuming — several bugs here
looked correct in code and only surfaced when measured. Tell me plainly when
something is broken, blocked, or worse than hoped; I would rather hear it than
find it later. Keep the UI professional and information-dense — I pushed back
once on it feeling over-animated and "like a game", so motion stays minimal and
functional.
