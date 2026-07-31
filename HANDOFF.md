# Lynxr — session handoff

Read this, then `README.md` for architecture. Last updated 2026-07-31.

I'm building **Lynxr** (lynxr.io), a format-intelligence platform for my
short-form video agency, Lynx Media Group. Static site on GitHub Pages plus a
Python pipeline. Database is **2,640 tagged videos** (1,188 Medceptor UGC +
1,452 scraped TikTok), shipped encrypted as `data.enc`.

Site tabs: **Database** (stats, split bars, filterable table), **New Client**
(paste a client site → detect niche/features → shop a shelf → pick 10 → save a
brief), **Clients** (folders with campaign health, month graph, numbered briefs,
per-brief post tracking with predicted-vs-actual charts, and a learning loop
where tracked performance shapes the next brief).

---

## 1. IN PROGRESS — Supabase shared workspace (verify this first)

Two founders share one workspace; localStorage was per-browser so clients saved
on one machine were invisible on the other. Just wired to Supabase.

- Project: `esakjfogplfszievvabi` · API `https://esakjfogplfszievvabi.supabase.co`
- Publishable key is in `app.js` and is **public by design** — the repo is
  public. Safe only because RLS grants access to `authenticated` and nothing to
  `anon`. See `supabase/schema.sql`.
- Schema **has been applied**. Verified: anonymous writes rejected (401 RLS
  violation), anonymous reads of the passphrase return nothing.
- Login is now **email + password** (Supabase Auth), replacing the typed access
  code. The `data.enc` passphrase lives in the signed-in-only `lynxr_secrets`
  table, so there is one login, not two.
- Header badge shows `● shared` or `● local only — not syncing`.

**NOT YET VERIFIED — do this first:** the owner had not completed a live login
when the session ended. Serve the site (`./venv/bin/python -m http.server 8811`
from the repo root), have him sign in, then confirm: session is real, badge
reads `● shared`, a client saved in one browser appears in another, and
`lynxr_clients` fills. If login fails, likely causes are the user not being
auto-confirmed in Supabase, or `lynxr_secrets` missing the `bundle_passphrase`
row (the schema seeds it as `lmaotsfiya`).

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
  + caption + music metadata). **BLOCKED: Anthropic credits ran out.** Budget
  ~$10–15 for all 2,640.

**Sequence to finish:**

```bash
cd ~/Documents/lynxrio
./venv/bin/python pipeline/transcribe.py         # resume; run twice to sweep retries
./venv/bin/python pipeline/clean_transcripts.py
./venv/bin/python pipeline/retag_with_audio.py   # needs credits
./venv/bin/python pipeline/export_web.py --access-code lmaotsfiya
git add -A && git commit -m "Multimodal retag" && git push
```

Then **re-run the blind accuracy audit** and compare to the baseline above, so
the gain is measured rather than assumed.

## Hard-won context — please don't rediscover these

- `.env` holds `ANTHROPIC_API_KEY` and `APIFY_API_TOKEN` (gitignored). Use
  `./venv/bin/python -m pip` — the venv's `pip` shebang is stale after a rename.
- **Never commit** `data.json`, `output/`, or the access code. Plaintext was
  committed early and had to be purged from git history.
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

- **Apify limit exceeded** ($5.89/$5.00) — blocks the remaining ~9K of a 10K
  scrape (`pipeline/scrape_tiktok_batch2.py`, resumable, caches per hashtag).
- **Instagram scraping yields zero videos** — the hashtag scraper returns only
  photos/carousels. Needs a Reels-specific actor.
- Cover images are TikTok's chosen thumbnail, usually early but not guaranteed
  frame one. True first frames need video downloads.
- Once Supabase is proven, the natural next steps are moving the video database
  server-side (so the page stops downloading a 1.7MB blob) and retiring
  `data.enc` entirely.

## How I like to work

Verify with real data or in the browser rather than assuming — several bugs here
looked correct in code and only surfaced when measured. Tell me plainly when
something is broken, blocked, or worse than hoped; I would rather hear it than
find it later. Keep the UI professional and information-dense — I pushed back
once on it feeling over-animated and "like a game", so motion stays minimal and
functional.
