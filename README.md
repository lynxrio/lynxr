# Lynxr

Format intelligence for short-form video. Scrapes social video, tags each one
against a locked taxonomy using the Claude API, and merges everything into a
single database that powers the dashboard at [lynxr.io](https://www.lynxr.io).

## Where everything lives

| Path | What it is |
|---|---|
| `index.html` | The site: access-code gate + MVP dashboard |
| `data.json` | Dashboard data (generated — do not edit by hand) |
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
`target_audience`, `data_source`, `source_type`, `scraped_at`

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
$PY pipeline/export_web.py                       # refresh data.json
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

## Deploying

The site is a single static file served by GitHub Pages from `main` at the repo
root, with `CNAME` pointing at `www.lynxr.io`.

```bash
./venv/bin/python pipeline/export_web.py   # refresh data.json
git add -A && git commit -m "Update data" && git push
```

> The access code is checked in browser JavaScript. That keeps casual visitors
> out; it is **not** security, since anyone can read it via view-source. Move the
> check server-side before putting anything sensitive behind it.
