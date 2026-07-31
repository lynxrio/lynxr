# Lynxr

Format-intelligence platform for Lynx Media Group (a short-form video agency).
A static site on GitHub Pages backed by a Python data pipeline.

**→ Read `HANDOFF.md` first.** It holds the current state of work in progress,
what is blocked and on what, and the exact commands to continue. `README.md`
covers architecture, the pipeline, and the security model.

## Orientation

| Path | What it is |
|---|---|
| `index.html` / `app.css` / `app.js` | The site — access gate, database browser, brief builder, client folders |
| `data.enc` | The database, encrypted (generated — never edit by hand) |
| `pipeline/` | Scrape → tag → merge → encrypt, plus transcription and multimodal retagging |
| `supabase/schema.sql` | Shared-workspace tables and RLS policies (already applied) |
| `output/` | Master CSV, summaries, logs *(gitignored)* |
| `data/` | Raw scrapes, cover frames *(gitignored)* |
| `.env` | `ANTHROPIC_API_KEY`, `APIFY_API_TOKEN` *(gitignored)* |

Sign-in is **email + password** via Supabase Auth (project
`esakjfogplfszievvabi`). The publishable key in `app.js` is public by design —
this repo is public — and is safe only because row-level security grants access
to signed-in users and nothing to anonymous ones. The `data.enc` passphrase
lives server-side in `lynxr_secrets`, so there is one login rather than a login
plus a typed code. The database is 2,640 videos.

## Rules that matter

- **Never commit** `data.json`, `output/`, `.env`, or the access code. Plaintext
  was committed early in this project and had to be purged from git history.
- **Use `./venv/bin/python -m pip`**, not `./venv/bin/pip` — the shebang is
  stale after a folder rename.
- **Strict CSP**: `style-src 'self'` with no `'unsafe-inline'`. Inline
  `style="..."` attributes are silently discarded; set styles via CSSOM
  (`el.style.x = y`). This once shipped invisible bar charts, so verify
  **painted pixels**, not DOM state.
- **No `confirm()`** — browsers suppress repeat dialogs and it returns false
  instantly. Destructive actions use a two-click armed button.
- **Tag one video per API request.** A batched design once asked for an array
  of N results; the model returned a valid 1-element array and stopped,
  silently tagging ~45% of rows. Coverage is now verified and errors below 95%.
- Briefs and clients live in **browser localStorage**, not the repo.

## Working style

Verify with real data or in the browser rather than assuming — several bugs
here looked correct in code and only surfaced when measured. Say plainly when
something is broken, blocked, or worse than hoped. Keep the UI professional and
information-dense; motion stays minimal and functional.
