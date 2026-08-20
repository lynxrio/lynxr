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
signed-in users and nothing to anonymous ones. The video database (**9,028
rows**, verified 2026-08-20) lives in `lynxr_videos`: signed-in staff read it,
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
- **Bump the `?v=YYYYMMDDx` stamp on every css/js change**, on all twelve
  cache-stamped pages — `index.html`, `waitlist/`, `faq/`, `terms/`,
  `privacy/`, `accessibility/`, `creatorsonly/`, `agencyonly/`,
  `what-is-a-video-format/`, `turn-a-video-into-a-script/`,
  `short-form-script-structure/`, `glossary/` — or browsers serve stale files.
  The HTML documents are not stamped, so markup changes need a hard reload.
- **Lowercase is the house style, and it lives in CSS** (`body, button, select
  { text-transform: lowercase }` plus a content exclusion list near the end of
  app.css). Do NOT lowercase source strings: `text-transform` changes only what
  is drawn, so copy-to-clipboard still yields the creator's real casing. Wrap
  the registered company name in `.entity` to opt it back out.
- **Never put `${...}` in a plain `.html` file.** It is JS template syntax and
  renders as literal text on the page.
- **A waitlist CSV never goes inside the repo.** One `git add -A` would publish
  every address. Export to `~/Desktop` or outside the project.

## Two agents: plan on Opus, execute on Sonnet

Non-trivial work is split across two subagents defined in `~/.claude/agents/`
(user-level, so they exist in every project, not just this one):

| Agent | Model | Does |
|---|---|---|
| `planner` | opus, xhigh effort | Reads the code, designs the change, writes a numbered plan to `~/.claude/plans/<slug>.md`. Touches no project file. |
| `executor` | sonnet, high effort | Reads that plan file, makes the edits, verifies each step, reports per step. Does not redesign or commit. |

**Start every session with the planner.** This is the default posture, not
something to be asked for each time. Begin substantive work by launching the
`planner` subagent rather than reading and editing files yourself — doing your
own reconnaissance first duplicates its job and burns context. Then relay the
plan, wait for a go-ahead, and hand the path to `executor`.

**Skip the pair for work that does not earn it**: questions and explanations,
reading or summarizing code, a typo, a rename, a one-line fix, a `?v=` bump, or
anything the owner asked you to just do. If you are unsure which route you are
taking, say so in one line and proceed rather than stopping to ask.

**The plan file is the handoff, and it lives outside the repo** — same reason
the waitlist CSV does. `~/.claude/plans/` cannot be caught by a `git add -A`.

**The owner approves the plan between the two.** The planner returns a path and
a summary; a subagent's report is not shown to them, so relay it. That gets
confirmed before the executor is launched. A wrong plan is cheap to fix, wrong
edits across four cache-stamped pages are not.

The executor is told to read this file and obey it — the plan will not restate
the `?v=` stamp rule, the CSP rule, or the `./venv/bin/python -m pip` rule, but
they still bind. If a plan step conflicts with this file, this file wins and
the executor stops rather than following it.

**Local preview opens itself.** A `SessionStart` hook in
`.claude/settings.local.json` serves the repo at **http://localhost:8811/** on
every new session and opens it in the default browser, so changes are visible
without starting anything by hand. Same port as the existing
`.claude/launch.json` config; logs go to `/tmp/lynxr-preview-8811.log`.

- It checks the port before starting and **never spawns a second server**, so
  additional sessions reuse the one already running.
- It **waits for the port to bind before calling `open`** — without that poll
  the browser races the interpreter and lands on connection-refused. Cold start
  measures ~0.4s.
- The browser tab opens on *every* session, including ones that reused an
  existing server. Two sessions in this project means two tabs.

Note the HTML is not cache-stamped, so a markup change still needs a hard
reload — and TikTok oEmbed does not work from `localhost`.

## Working style

Verify with real data or in the browser rather than assuming — several bugs
here looked correct in code and only surfaced when measured. Say plainly when
something is broken, blocked, or worse than hoped. Keep the UI professional and
information-dense; motion stays minimal and functional.

