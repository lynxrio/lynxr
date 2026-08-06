# Lynxr

Format intelligence for short-form video. Scrapes social video, tags each one
against a locked taxonomy using the Claude API, and merges everything into a
single database that powers the dashboard at [lynxr.io](https://www.lynxr.io).

## Where everything lives

| Path | What it is |
|---|---|
| `index.html` / `app.css` / `app.js` | The site: login gate + dashboard (split out so the CSP can forbid inline script) |
| `supabase/schema.sql` | Tables + RLS policies, including `lynxr_videos` (the database) |
| `pipeline/` | All the Python that produces the data |
| `data/` | Raw scrapes and normalized CSVs *(gitignored)* |
| `output/` | **The database, summary, and logs** *(gitignored)* |
| `.env` | API keys *(gitignored — never commit)* |
| `venv/` | Local Python environment *(gitignored)* |

### The database

| File | Contents |
|---|---|
| `output/master_video_database.csv` | **The whole database** — every video, every tag, ready for PostgreSQL |
| `output/data_summary.txt` | Totals by source, niche, format, hook, audience |
| `output/medceptor_tagged.csv` | Medceptor videos + tags |
| `output/tiktok_tagged.csv` | Scraped TikTok videos + tags |
| `output/tagging.log` | Full tagging run log, including any failures |

You can also browse the whole database in the dashboard — the **Full database**
section is searchable, filterable, and sortable.

## Master database columns

`video_id`, `creator`, `platform`, `title`, `views`, `likes`, `comments`,
`engagement_rate`, `format_type`, `hook_pattern`, `niche_category`,
`target_audience`, `data_source`, `source_type`, `scraped_at`, `url`

## Running the pipeline

Put your keys in `.env` at the repo root:

```
ANTHROPIC_API_KEY=sk-ant-...
APIFY_API_TOKEN=apify_api_...
```

Then:

```bash
./pipeline/run_pipeline.sh
```

Every step is resumable. Scrapes cache per hashtag in `data/*_parts/`, and
tagging records its batch ID so a re-run polls the existing batch instead of
paying twice. To force a step to re-run, delete its output file (and any
matching `*.batch_state.json`).

### Individual steps

```bash
PY=./venv/bin/python
$PY pipeline/scrape_tiktok.py                    # scrape TikTok by hashtag
$PY pipeline/process_scraped.py tiktok           # raw JSON -> normalized CSV
$PY pipeline/tag_videos.py --input data/tiktok_normalized.csv \
                           --output output/tiktok_tagged.csv
$PY pipeline/merge_data.py                       # build master database
$PY pipeline/export_supabase.py                  # upsert -> Supabase lynxr_videos
```

## Tagging

`pipeline/taxonomy.py` holds the locked vocabularies. `format_type` and
`hook_pattern` come from the Lynx content-tagging taxonomy — **do not add
values here without updating that taxonomy first**, or week-over-week
comparisons stop being meaningful.

Tagging runs one video per Claude Batches API request. An earlier design that
batched many videos per request silently under-delivered (the model returned a
valid one-element array and stopped), so `tag_videos.py` now verifies coverage
and logs a loud error below 95%.

Tags are inferred from caption text only, not the video itself. The tagger is
instructed to prefer `Other` over guessing, so expect a substantial `Other`
bucket on `format_type` — that is honest, not broken.

## Platform coverage

Three scrapers feed one schema; all tag identically.

- **TikTok** — hashtag-based (`scrape_tiktok.py`). Hashtags are UGC-focused
  (`ugc`, `ugccreator`, `tiktokmademebuyit`, `productreview`, …) so the database
  fills with authentic creator content, not brand/news posts.
- **Instagram Reels** — creator-based (`scrape_instagram.py`,
  `apify/instagram-reel-scraper`). Instagram hashtag pages are unreliable, so
  list creator handles in `HANDLES`. Reels only; no free share count.
- **YouTube Shorts** — creator-based (`scrape_youtube.py`,
  `streamers/youtube-shorts-scraper`). List channels in `CHANNELS`. Also returns
  subtitles/transcript + duration.

All three verified live 2026-07-31 against the Cloey creators; Instagram and
YouTube view counts matched Sideshift's numbers.

## Known gaps

- **TikTok volume is capped.** The actor returns roughly 10–25 results per
  hashtag on the current Apify plan, regardless of the requested count.
- **Both credit gates still apply:** Apify budget for scraping, Anthropic
  credits for the (accuracy-critical) multimodal tagging.

## Client brief

Paste a client's site (or skip the URL and fill in the details by hand — some
sites block automated readers). The page reads the site through a public CORS
reader (allorigins, codetabs fallback), detects niche / features / audience
from the actual content, and builds a **video shelf**: real examples from the
database, playable in-page via each platform's official embed, ranked by the
source-normalised index and diversified across formats.

Check off the videos you want — each pick generates a script tailored to the
client (brand, features, audience woven into format-specific beats). At 10
picks, **Export for Google Docs** downloads a .docx (built in pure JS, no
libraries) with all 10 scripts plus reference links and stats; drag it into
Google Drive and open with Docs. "Copy scripts" gives the same as plain text.

Embeds: TikTok and YouTube play reliably; Instagram and Facebook sometimes
refuse to embed without login — those cards keep an "open ↗" fallback link.

## Security model

The database lives in **Supabase Postgres behind row-level security** (table
`lynxr_videos`), not in the repo. Sign-in is email + password via Supabase
Auth; RLS grants `select` to the `authenticated` role and nothing to `anon`,
and **no write policies exist**, so a browser session can read but never
modify the video rows. Writes happen only through the pipeline
(`pipeline/export_supabase.py`) using the service-role key, which stays in the
gitignored `.env`. The publishable key in `app.js` is public by design — it
grants anonymous visitors nothing. A strict Content-Security-Policy blocks all
external loads and native form posts, so an injected value can't phone home.

What this protects against: the repo and the site contain **no database
plaintext and no secrets** — an anonymous visitor (or repo reader) gets only
UI code. What it does **not** protect against:

- **A shared login.** Accounts are per-person in Supabase Auth; revoke or
  reset a user there if someone leaves.
- **Historical exposure.** The old `data.enc` scheme shipped ciphertext in the
  repo and its passphrase later leaked into public git history, so treat the
  July 2026 snapshot of the database as public. Post-migration data never
  ships as a file, so the exposure does not grow.
- **Truly sensitive data.** For per-row access, audit logging, or short-lived
  grants you would want real server logic, not a static page — the current
  model is "any signed-in founder sees everything," which is the intent.

> ⚠️ **Never commit `data.json`, `output/`, `.env`, or any secret value**
> (including seeds in `supabase/schema.sql` — the repo is public). Plaintext
> was committed early in this project and had to be purged from git history.
> If a secret ever lands in a commit, purging history alone isn't enough —
> rotate it too, because git history on a public repo is world-readable.

## Deploying

The site is served by GitHub Pages from `main` at the repo root (`index.html`,
`app.css`, `app.js`), with `CNAME` pointing at the apex `lynxr.io`. Data
updates don't touch the repo at all:

```bash
./venv/bin/python pipeline/export_supabase.py   # upsert master CSV -> Supabase
```

Site changes deploy with a normal push:

```bash
git add -A && git commit -m "Update site" && git push
```

