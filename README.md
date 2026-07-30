# Lynxr

Format intelligence for short-form video. Scrapes social video, tags each one
against a locked taxonomy using the Claude API, and merges everything into a
single database that powers the dashboard at [lynxr.io](https://www.lynxr.io).

## Where everything lives

| Path | What it is |
|---|---|
| `index.html` / `app.css` / `app.js` | The site: access-code gate + dashboard (split out so the CSP can forbid inline script) |
| `data.enc` | Encrypted database the site decrypts in-browser (generated) |
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
$PY pipeline/export_web.py --access-code CODE    # encrypt -> data.enc
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

## Known gaps

- **Instagram returns no videos.** `apify/instagram-hashtag-scraper` returns
  photos and carousels only. Getting Reels requires a different actor.
- **TikTok volume is capped.** The actor returns roughly 10–25 results per
  hashtag on the current Apify plan, regardless of the requested count.

## Security model

The database is **encrypted at rest in the repo**. `data.enc` is AES-256-GCM
ciphertext; the key is derived from the access code with PBKDF2-SHA256 (8,000,000
iterations, per-bundle random salt). The page ships **no password and no
plaintext** — the visitor types the code, the browser derives the key and
decrypts in memory, and a wrong code simply fails GCM authentication (that
failure *is* the access check). A strict Content-Security-Policy blocks all
external loads and native form posts, so an injected value can't phone home.

What this protects against: anyone downloading `data.enc` (or the whole repo)
learns nothing without the code. What it does **not** protect against:

- **A shared code.** Anyone you give the code to can pass it on. It's one shared
  secret, not per-user login.
- **Offline brute force of the code.** The ciphertext is public, so the access
  code is the only thing protecting it and can be attacked offline at the
  attacker's own pace. PBKDF2 runs at 8,000,000 iterations (13x the OWASP floor,
  ~1.8s per guess in a browser) to make that expensive, but iteration count
  cannot rescue a guessable code.
- **Never reuse or near-reuse a code that has leaked.** `lmoatsfiya` was
  committed to this repo's public history early on. Crackers automatically apply
  transposition and substitution rules to known-leaked passwords, so any close
  variant of it is effectively pre-guessed. If confidentiality of this data ever
  starts to matter, rotate to an unrelated high-entropy code.
- **Truly sensitive data.** For anything that needs per-user access, audit
  logging, or revocation, a static site is the wrong tool — that needs a server.

### Rotating the access code

The code is never stored anywhere in the repo, so rotating it = re-encrypt and
redeploy:

```bash
./venv/bin/python pipeline/export_web.py --access-code NEW-CODE
git add data.enc && git commit -m "Rotate access code" && git push
```

Everyone using the old code must be given the new one.

> ⚠️ **Never commit `data.json`, `output/`, or the access code.** The plaintext
> database and an inline password were committed early in this project and had to
> be purged from git history. `.gitignore` now blocks them; keep it that way. If
> plaintext ever lands in a commit, purging history alone isn't enough — rotate
> the code too, because git history on a public repo is world-readable.

## Deploying

The site is served by GitHub Pages from `main` at the repo root (`index.html`,
`app.css`, `app.js`, `data.enc`), with `CNAME` pointing at the apex `lynxr.io`.

```bash
./venv/bin/python pipeline/export_web.py --access-code CODE  # refresh data.enc
git add -A && git commit -m "Update data" && git push
```
