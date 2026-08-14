# Lynxr

Format-intelligence platform for Lynx Media Group (a short-form video agency).
A static site on GitHub Pages backed by a Python data pipeline.

**→ Read `HANDOFF.md` first.** It holds the current state of work in progress,
what is blocked and on what, and the exact commands to continue. `README.md`
covers architecture, the pipeline, and the security model.

## Orientation

Three separate front-ends share one stylesheet. Know which one you are in —
`app.css` is global, so a change made for one page lands on all three.

| Path | What it is |
|---|---|
| `index.html` / `home.js` | **Public landing page.** One job: take an email for the wait list. Neither app is linked from it. |
| `creatorsonly/` + `creator.js` | **Creator app.** Paste a video link → get a script for a brand. Unlisted URL, handed out by hand. |
| `agencyonly/` + `app.js` | **Agency app.** Staff only: database, brief builder, client folders. |
| `privacy/` | The privacy policy. Linked from all three; the creator app fetches it into a modal. |
| `app.css` | **Every page.** One file. |
| `pipeline/` | Scrape → tag → merge → upsert to Supabase, plus transcription and multimodal retagging |
| `.github/workflows/adaptations.yml` | **Writes creator scripts on GitHub's runners** — not on anyone's Mac |
| `supabase/*.sql` | Tables, RLS, and the one-off migrations. `schema.sql` is the whole thing; the others are standalone pieces |
| `output/` `data/` `.env` | Master CSV, raw scrapes, secrets *(all gitignored)* |

Sign-in is **email + password** via Supabase Auth (project
`esakjfogplfszievvabi`). The publishable key is public by design — this repo is
public — and is safe only because row-level security grants access to
signed-in users and nothing to anonymous ones. The video database (**9,016
rows**, verified 2026-08-19) lives in `lynxr_videos`: signed-in staff read it,
only the pipeline (service-role key) writes it. The old encrypted `data.enc`
blob is retired.

**Creators and staff share one auth pool**, so "any authenticated user" would
expose everything. Agency tables are gated on `is_staff()`; a creator owns
exactly one row in `lynxr_creators`, keyed on `auth.uid()`. This is enforced in
the database, not the interface — verified live, see HANDOFF.md.

## Rules that matter

- **Never commit** `data.json`, `output/`, `.env`, or any secret value —
  including seeds in `supabase/schema.sql`; the repo is public. Plaintext
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
- Clients sync through Supabase (`lynxr_clients`), cached in browser
  localStorage; briefs live inside those client records, not the repo.
- **Bump the `?v=YYYYMMDDx` stamp on every css/js change**, on all four pages,
  or browsers serve stale files. The HTML documents are not stamped, so markup
  changes need a hard reload.
- **Lowercase is the house style, and it lives in CSS** (`body, button, select
  { text-transform: lowercase }` plus a content exclusion list near the end of
  app.css). Do NOT lowercase source strings: `text-transform` changes only what
  is drawn, so copy-to-clipboard still yields the creator's real casing. Wrap
  the registered company name in `.entity` to opt it back out.
- **Never put `${...}` in a plain `.html` file.** It is JS template syntax and
  renders as literal text on the page.
- **A waitlist CSV never goes inside the repo.** One `git add -A` would publish
  every address. Export to `~/Desktop` or outside the project.

## Working style

Verify with real data or in the browser rather than assuming — several bugs
here looked correct in code and only surfaced when measured. Say plainly when
something is broken, blocked, or worse than hoped. Keep the UI professional and
information-dense; motion stays minimal and functional.

