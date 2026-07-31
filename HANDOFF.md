# Lynxr — session handoff

Paste everything below into a new Claude Code session started in
`~/Documents/lynxrio`.

---

I'm building **Lynxr** (lynxr.io), a format-intelligence platform for my
short-form video agency, Lynx Media Group. Everything lives in
`~/Documents/lynxrio`. Read `README.md` first — it documents the architecture,
the pipeline, and the security model.

**Access code for the site: `lmaotsfiya`** (needed to unlock the local preview).

## What exists

A static site on GitHub Pages (`index.html`, `app.css`, `app.js`, `data.enc`)
plus a Python pipeline in `pipeline/`. The database is **2,640 tagged videos**
(1,188 Medceptor UGC + 1,452 scraped TikTok), encrypted at rest as `data.enc`
(AES-256-GCM, PBKDF2 8M iterations, key derived from the access code — no
plaintext and no password ships in the page).

The site has three tabs: **Database** (stats, split bars, filterable table),
**New Client** (paste a client site → auto-detect niche/features → shop a shelf
of matching videos → pick 10 → save a brief), and **Clients** (client folders
with campaign health, a month graph, numbered briefs, per-brief post tracking
with predicted-vs-actual charts, and a learning loop where a client's tracked
performance shapes their next brief).

## What is running / half-finished — START HERE

I'm mid-way through a **multimodal retagging project** to fix tag accuracy.
Tags were originally inferred from caption text only; a blind 6-judge audit
measured **format 81.7%, hook 78.6%, niche 88.1%, audience 92.9%**. Captions
can't reveal the spoken hook or the visual, so we added audio and vision.

State right now:

1. **`pipeline/transcribe.py`** — downloads audio (yt-dlp) and transcribes
   locally (mlx-whisper on Apple Silicon; free, no API key). **It was running
   in the background and is probably interrupted — just re-run it.** It's
   resumable: `./venv/bin/python pipeline/transcribe.py`. About 628 of 2,634
   done, ~2.7s/video. Results append to `output/transcripts.jsonl`.
2. **`pipeline/fetch_covers.py`** — DONE. 1,743 opening frames cached in
   `data/covers/` (from `videoMeta.coverUrl` already in the scrapes).
3. **`pipeline/clean_transcripts.py`** — quality filter. Run after
   transcription.
4. **`pipeline/retag_with_audio.py`** — the multimodal retag. **BLOCKED on
   Anthropic credits** (ran out mid-test). Budget ~$10–15 for all 2,640.

**The sequence to finish it:**

```bash
cd ~/Documents/lynxrio
./venv/bin/python pipeline/transcribe.py          # resume; then re-run once more to sweep retries
./venv/bin/python pipeline/clean_transcripts.py
./venv/bin/python pipeline/retag_with_audio.py    # needs credits
./venv/bin/python pipeline/export_web.py --access-code lmaotsfiya
git add -A && git commit -m "Multimodal retag" && git push
```

Then **re-run the blind accuracy audit** and compare against the baseline above
so the gain is measured, not assumed.

## Hard-won context — please don't rediscover these

- **`.env`** holds `ANTHROPIC_API_KEY` and `APIFY_API_TOKEN` (gitignored). The
  venv's `pip` shebang is stale after a folder rename — use
  `./venv/bin/python -m pip`.
- **Never commit `data.json`, `output/`, or the access code.** Plaintext was
  committed early and had to be purged from git history.
- **The tagger must be one request per video.** An earlier batched design asked
  for an array of N results and the model returned a valid 1-element array and
  stopped — silently tagging ~45% of rows. `tag_videos.py` now verifies
  coverage and errors loudly below 95%.
- **~40% of videos have no speech** (music + on-screen text). Whisper
  hallucinates on those — it loops "I'm sorry" or emits "Thanks for watching!".
  Both `transcribe.py` and `clean_transcripts.py` detect this. "No speech" is a
  useful answer, not a gap: it points at Meme / Trend Clip, and the cover frame
  usually carries the real hook.
- **Don't try to detect song lyrics with heuristics.** I built one and measured
  it wrong in both directions — it rejected a maths problem read aloud and an
  app list (real speech) while keeping actual lyrics. The tagger judges it from
  the full transcript instead.
- **Licensed music does NOT mean no speech.** Creators talk over trending
  sounds constantly — that's normal UGC practice. TikTok's
  `musicMeta.musicOriginal` is passed as *context*, never a verdict.
- **Strict CSP:** `style-src 'self'` with no `'unsafe-inline'`, so inline
  `style="..."` attributes are silently discarded. Set styles via CSSOM
  (`el.style.x = y`). This once shipped invisible bar charts. Verify **painted
  pixels**, not DOM state.
- **Don't use `confirm()`** — browsers suppress repeat dialogs and it returns
  false instantly, which broke every delete button. Deletes use a two-click
  armed state.
- Briefs/clients live in **browser localStorage**, not the repo — they're
  per-device.

## Known gaps / next up

- **Apify monthly limit exceeded** ($5.89/$5.00). Raising it unblocks the
  remaining ~9K of a 10K scrape (`pipeline/scrape_tiktok_batch2.py`, resumable,
  caches per hashtag).
- **Instagram scraping yields zero videos** — `apify/instagram-hashtag-scraper`
  returns only photos/carousels. Needs a Reels-specific actor.
- Cover images are TikTok's chosen thumbnail, usually an early frame but not
  guaranteed frame one. True first frames would need video downloads.
- The month graph on the client page scopes to the current calendar month.

## How I like to work

Verify things in the browser or with real data rather than assuming they work —
several bugs here looked fine in code and only showed up when measured. Tell me
plainly when something is broken, blocked, or when a number is worse than
hoped. Keep the UI professional and information-dense; I pushed back once on it
feeling over-animated and "like a game", so motion should stay minimal and
functional.
