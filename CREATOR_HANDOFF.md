# Lynxr Creator Side — handoff

**For the next Claude Code session.** Start with SESSION 2026-08-13 below — it
is the current state. Everything after it is older context that is still mostly
true; where the two disagree, 08-13 wins.

Then read `output/Lynxr-Spec.html` (current product spec, Google-Docs-friendly).
`HANDOFF.md` and `README.md` cover the agency app, which shares this repo.

Last updated **2026-08-13**.

> **Path change, applies throughout this document.** The creator app moved from
> `creator.html` to `/creatorsonly/` on 2026-08-12. Older sections below still
> say `creator.html`; read that as `/creatorsonly/` everywhere. `creator.html`
> now 404s and there is **no redirect** — see the open items.

---

# SESSION 2026-08-13

## STOP-POINT STATE — read this first

**Nothing is pushed.** The working tree has six modified files and lynxr.io is
running the previous build:

| | |
|---|---|
| live `creator.js` | `?v=20260813u` |
| local `creator.js` | `?v=20260814m` |

Modified, uncommitted: `creator.js`, `app.css`, `creatorsonly/index.html`,
`index.html`, `agencyonly/index.html`, `pipeline/process_adaptations.py`.

**`supabase/invites.sql` has been run** (2026-08-13) and tested end to end
against the live project:

| check | result |
|---|---|
| `rpc/signup_state` | 200 — `{"open": true, "invite_required": false}` |
| `rpc/signup_open` | 404, correctly replaced |
| anon reading invite codes | `[]` with a real row present — no leak |
| anon inserting an invite | 401 |
| signup, invites OFF | succeeds — the renamed trigger does **not** block everyone |
| signup, invites ON, no invite | refused: *"lynxr: no invite for this address"* |
| signup with a matching code | succeeds, `redeemed_at` stamped (single use) |

Left **off**: `seats: 4`, `require_invite: false`, 1 of 4 seats used. Turn on
when working from the waitlist — and note that invites then become the cap and
`seats` is ignored:

```sql
update public.lynxr_signup_gate set require_invite = true where id = 1;
```

Serve locally with the existing launch config (`python -m http.server 8811`
from the repo root) and open `http://localhost:8811/creatorsonly/`.

## What changed this session

### Worker — a link with no brand is now a finished job

`pipeline/process_adaptations.py`. A creator with no company can send a link and
get the video's **own** script back — transcript, shots, tags, extracted format —
with the rewrite skipped. Three edits:

1. `process_one()` returns early before the adaptation stage when `brandId` is
   falsy, instead of failing on "brand not found".
2. The "no beats is a failure" guard now only applies when a brand was actually
   asked for. Without this every brandless entry would be marked `error`.
3. The completion log distinguishes source-only runs, which previously logged as
   `fit=—, 0 beats` and looked like a bug.

**Creator submissions already reach `lynxr_videos` with no change needed** —
`upsert_video()` reads only the stored source, has no brand dependency, and is
called unconditionally. Rows land marked `data_source='Creator'` with no creator
or brand identity, exactly as before.

### Creator app

- **One centred layout for everyone.** The two-step first-run screen was built,
  then removed at the owner's direction. Creators with and without brands now see
  the identical page.
- **Brandless send** wired end to end in the app (`queueAdaptation(item, null)`).
- **Adding a brand asks one question** — the website — and reads it to fill name,
  description and niche. The site reader (`readCompanySite`, `analyzeCompanySite`,
  `asUrl`) is ported from `app.js`, where it has run since launch. "No website"
  escape hatch sets `BRAND_MANUAL` and opens the full editor. Details still edits
  everything afterwards.
- **Copy trimmed app-wide**, 13 replacements. Longest UI string is now 58 chars.
- **Rail reordered ChatGPT-style**: logo → New script → Library → New brand →
  BRANDS → account foot. Library was previously in the account foot.
- **Composer raised** off the bottom edge and made keyboard-aware (below).
- **Deleting your last brand** lands on New script, not the Library.
- **Client names removed from placeholders** — `Medceptor` / NCLEX were showing
  to every outside creator, which leaks a client relationship. Now `lynxr`.
- **Time saved** was built (rail + account page) and then **removed** on request.
  Nothing of it remains; don't rebuild it without asking.

### Keyboard handling — two mechanisms, both needed

- `interactive-widget=resizes-content` on `creatorsonly/index.html`'s viewport
  meta covers Chrome and most Android browsers.
- **iOS Safari ignores that AND does not shrink `dvh` for the keyboard**, so the
  composer would sit behind it. `trackVisibleHeight()` in `creator.js` publishes
  `visualViewport.height` as `--vvh`, and `.newscript` uses
  `min-height: calc(var(--vvh, 100dvh) - 150px)`. Throttled through `rAF` because
  iOS fires `resize` continuously through the keyboard animation.

## VERIFIED vs NOT — be honest about this

**Verified:** JS syntax, Python compile, CSS comment/brace balance, computed
styles and painted screenshots via injected markup, every rail element id
surviving the reorder, the URL-vs-name detection and site-analysis logic in Node,
and live Supabase checks for the seat gate and email confirmation.

**NOT verified, and each is a real risk:**

1. **No signed-in end-to-end walkthrough.** Everything visual was checked with
   markup injected into the page, not by driving the real app with an account.
2. **The site read has never succeeded end to end.** The CORS relays
   (allorigins, codetabs) are unreachable from the preview sandbox. The parsing
   is proven; the fetch is not.
3. **The brandless worker path has never run.** The code is written and compiles;
   no queued brandless entry has been processed.
4. **Keyboard behaviour is untestable here** — no on-screen keyboard in the
   preview pane, so `--vvh` always equals full height.

**Before pushing, walk this on localhost with a real account:** send a link with
no brand → does it queue and land in the Library? → "Add a brand" → paste a real
website → do the fields fill? → open Details → delete the brand → do you land on
New script?

## Open items

1. **The CTA on a finished brandless script** — "turn this into a UGC script for
   a brand" — is **not built**. The card does not yet render a brandless entry as
   "the original script", and there is no button on it. This is the last piece of
   the flow the owner described.
   **Design decision still open:** the entry already holds the transcript, shots
   and format. Re-queuing from scratch is simple but re-downloads, re-transcribes
   and re-pays for tags and format (~$0.13, 60–75s). Reusing the stored source
   needs a worker change but makes the rewrite ~$0.05 and fast. **Recommend the
   reuse** — it is the difference between the CTA feeling instant and feeling
   like starting over.
2. **Invites are installed but switched off** — see the table at the top. The
   remaining work is a product decision, not a technical one: when to flip
   `require_invite`, and issuing the first wave. `supabase/invites.sql`'s footer
   carries the waitlist→invite queries for working a list at scale.
   **Push `creator.js` before flipping it** — the local build is what knows to
   show the invite-code field when the database asks for one.
3. **`creator.html` 404s with no redirect.** Anyone who bookmarked the old path
   is stranded.
4. **Three overlapping spec files** in `output/`: `Lynxr-Spec.html` (current,
   Docs-friendly), `Lynxr-Product-Spec.html` (styled, superseded) and
   `LYNXR_SPEC_v2.md` (annotated working doc). Delete the two you won't maintain.
5. **The agency blueprints worker still runs on the founder's Mac** via launchd.
   Explicitly on hold — do not migrate it without asking.

## Gotchas found the hard way this session

- **`autoGrow()` forces an empty textarea back to one row on purpose**, so any
  placeholder longer than ~55 characters is clipped. Shorten the placeholder;
  don't fight the function.
- **Never shadow the global `go()`** — a local `const go = document.getElementById(…)`
  turns every `go({kind:…})` in that scope into a button click.
- **Valid view kinds are only** `new`, `you`, `feedback`, `brand`, `library`.
  Anything else falls through to the Library.
- **A stray `*/` inside a CSS comment silently kills the rest of the stylesheet.**
  After any CSS edit, check `/*` and `*/` counts match — this bit once already.
- **Trash entries keep their full record**, `status: 'done'` included. Relevant to
  any counting: `scriptsUsed()` deliberately counts adaptations + trash because
  that is what the money cap charges for.
- **GoTrue passes a trigger's `raise exception` text straight through** as
  `message` with a 500 — not the generic "Database error saving new user" the
  docs imply. Both shapes are matched in `signupError()`.

---

# OLDER CONTEXT (pre-2026-08-13)

*Still broadly accurate. Where it conflicts with the session above, the session
above is right. Remember `creator.html` → `/creatorsonly/`.*

---

## Feedback: two destinations, one of them authoritative

The rail has its own **Feedback** tab (beside You & settings, Sign out and the
sync badge). A creator picks "Something is broken" / "Something could be better",
writes a line, and it goes to:

1. **`lynxr_feedback` in Supabase — the record.** RLS: a creator may insert
   their own and read nobody's, including their own. Staff read via `is_staff()`.
2. **A Google Sheet — a convenience mirror.** Via an Apps Script web app
   (`supabase/feedback-sheet.gs`, deployed 2026-08-11, URL wired into
   `FEEDBACK_SHEET_URL` in creator.js).
   Sheet: `1wCd0fQ84F0I39qyHEwZmKcagSnGpwHUuXEqwsPLOmhE`

**Trust Supabase if they disagree.** The mirror is fire-and-forget: Apps Script
answers a POST with a 302 the browser will not let us read, so the send is
`mode: "no-cors"` and cannot be confirmed client-side. That is exactly why the
message the creator sees reflects the *Supabase* write, not the sheet's.

Why Apps Script and not the Sheets API: the site is static and public, so any
Google credential shipped in `creator.js` would be readable by anyone. Apps
Script runs on Google's servers as the owner, so the page only needs a URL.
The cost is that the endpoint is open — the sheet is append-only and
technically spammable by anyone who finds the URL.

`creator.html`'s CSP now allows `script.google.com` and
`script.googleusercontent.com` (it redirects to the latter).

**If you redeploy the Apps Script as a new version, the `/exec` URL changes.**
Update `FEEDBACK_SHEET_URL`, or feedback keeps reaching Supabase while the sheet
silently stops filling.

## LAUNCH CHECKLIST — before 50–100 creators (2026-08-11)

### Blocks launch. Each is a certainty at this scale, not a risk.

- [ ] **Push everything.** lynxr.io is running an old build: no new homepage, no
      `/agencyonly/`, no feedback form, and none of today's fixes.
- [ ] **Email confirmation.** `mailer_autoconfirm: false` with no custom SMTP.
      Supabase's built-in mailer is a few messages an hour and is not a delivery
      service — most of 50–100 signups never get their link and you never hear
      from them. Either turn OFF *Confirm email*, or wire real SMTP.
- [ ] **Supabase Site URL** is still `localhost`. Any confirmation email that
      does send points at a laptop. Set it to `https://lynxr.io` and add
      `https://lynxr.io/**` to Redirect URLs.
- [ ] **Run the staff gate** (`supabase/schema.sql`). Until then every creator
      can read AND DELETE `lynxr_clients` and read all 9,003 `lynxr_videos`
      rows. Unlisting `/agencyonly/` does nothing about this.
- [ ] **Run the feedback table** — same file. Without it the in-app form fails
      (it says so plainly rather than pretending to send).
- [ ] **Set the two GitHub secrets and confirm the workflow runs.** Without CI
      the worker only runs when you run it by hand, so scripts never arrive.

### Needed for the feedback loop to be worth anything

- [ ] **Measure cost per script.** The worker now logs tokens per model per
      script. Read it on the next few runs and multiply out: 100 creators × 5
      videos = 500 scripts, four model calls each, three on Opus.
- [ ] **Cap submissions per creator.** Nothing stops one person queueing 500
      links. There is no rate limit anywhere.
- [ ] **Tune the prompts on real output first.** They have had exactly one live
      run, which immediately exposed a crash and a broken tracking code. Run 5
      creators, read every script, then open to 50.
- [ ] **Fix Instagram Reels** (yt-dlp needs cookies). Reels will be a large
      share of what creators paste, and today many fail.

### Will hurt but survivable

- [ ] Throughput: ~75s per script, serial, 15-min cron, 30-min timeout ≈ 24
      scripts per run.
- [ ] No onboarding — a new creator lands on an empty app and must work out that
      a brand comes first.
- [ ] No way to see who signed up but never sent a link.
- [ ] Rotate the service-role key if the current `sb_secret_…` predates
      2026-07-31.

---

## The three-step plan (owner's framing — do not skip ahead)

| Step | Scope | State |
|---|---|---|
| **1** | **Creator side: sign up, build a library of videos worth remaking, turn one into a script — and the source joins our database** | **Built, untested against the live API** |
| 2 | Tag every video in our database | Not started |
| 3 | Conversions / downloads per video | Not started — but *capture* is already wired, see below |

Step 1 is what this document covers. **Do not build step 2 or 3 unless the
owner asks.** The one thing already done for step 3 is *capture*: every
adaptation is issued a tracking code at creation, because attribution can never
be applied retroactively (spec R3). The analysis waits.

---

## What exists right now

### New files

| File | What it is |
|---|---|
| `creator.html` | The creator app. Separate page from the agency app on purpose. |
| `creator.js` | All creator logic — sign in / sign up, brands, the library, paste-link, render scripts. Standalone; imports nothing from `app.js`. |
| `pipeline/process_adaptations.py` | The worker: source → transcript → shots → tags → format → brand-adapted script. |
| `output/LYNXR_SPEC_v2.md` | The corrected spec. Source of truth for behaviour. |
| `output/LYNXR_SPEC_v2.html` | Same doc, styled for pasting into Google Docs. |

### Changed files

- `supabase/schema.sql` — appended two tables: `lynxr_creators`, `lynxr_sources`.
  No structural change for the library; it lives in the existing `data` jsonb,
  documented in the comment above the table.
- `app.css` — appended `.gate-switch` / `.linkish` (sign-in ⇄ sign-up) and the
  `.lib-*` block. **Shared with the agency app**, so `index.html`'s stylesheet
  stamp was bumped alongside `creator.html`'s. One rule is a *fix*, not an
  addition: under 560px the beat grid drops the time column, and the empty
  spacer span on DO/SHOW rows was pushing their value into the 42px label
  column — "Straight to camera, no intro" wrapped one word per line. Now
  `.bp-beat > span:empty { display: none }` inside that media query.
  **This bug was in the agency app's blueprints too** (`bpBeatHtml` emits the
  same markup); the fix lands on both.
- `pipeline/process_adaptations.py` — the write-back now re-pulls and grafts on
  only the adaptations that pass touched, instead of PATCHing the blob it read
  minutes earlier. Without that, saving to the library while a script was being
  written would silently roll those saves back.

- `app.js` — `loadFailureReason()`. Now that agency tables are staff-only, a
  creator signing in at `index.html` gets every row filtered by RLS, which looks
  exactly like "the pipeline never ran". The failure path asks `is_staff()` and
  says *"That's a creator account — sign in at /creator.html instead."* On a
  database without the migration the RPC 404s and the original wording stands,
  so this is safe to ship ahead of the SQL.
- `creator.js` — `initDotGrid()` ported verbatim from `app.js`, so the creator
  side gets the same pointer-reactive lattice instead of only the static CSS
  one. Verified by sampling canvas pixels: alpha 15 at rest, 71 under the
  pointer, identical to the agency app.
- `creator.js` — `accountLoadError()`. Signing in with a correct password but a
  missing `lynxr_creators` table used to report **"Could not sign in — check
  your connection"**, because the sign-in and the account load shared one catch.
  That is a trap: it reads as a bad password, which sends you to "Create one",
  which asks for an email confirmation that never arrives, and you never learn
  the schema was simply never applied. It now names the real cause — *"Signed in
  — but the creator tables don't exist yet. Run supabase/schema.sql."*

### Untouched on purpose

`index.html` (beyond the stamps). Note `app.css` and now the dot-grid code are
shared in spirit between both pages — if you restyle or retune one, check both.

---

## Structure — a rail and a pane (rebuilt 2026-08-11, owner's call)

The creator app is a sidebar app, not a tabbed page. Brands sit in the rail the
way conversations do in a chat app; picking one fills the pane with its scripts
and pins a composer at the foot to send the next link.

```
┌──────────────┬────────────────────────────────────┐
│ lynxr.       │  Medceptor  [MEDC7K2Q] [1 writing] │
│ + New brand  │  Education · signups · 2 scripts   │
│ ▤ Library  4 │  ── SCRIPTS 2                      │
│              │  ▸ 3 things I wish I knew …        │
│ BRANDS       │  ▸ Why nobody passes …             │
│ Medceptor  2 │                                    │
│ GymShift   2 │                                    │
│ Brewhaus     │  ┌──────────────────────────────┐  │
│ ──────────── │  │ Paste a link…            [↑] │  │
│ ● synced     │  └──────────────────────────────┘  │
│ You · Signout│                                    │
└──────────────┴────────────────────────────────────┘
```

**The theme is unchanged and that is deliberate** — same palette, same Share
Tech Mono, same pointer-reactive dot grid, and the pane reuses the agency's own
`bcard-title` / `chip` / `bp-item` / `client-editor` vocabulary straight out of
the shared `app.css`. Only the furniture moved.

**Library is account-wide, and holds each video exactly once.** A video belongs
to the creator, not to a brand: send the same link for three brands and it stays
one row there, listing all three scripts, each clickable through to the brand it
was written for. An earlier build kept a copy per brand; `normalizeMe()` merges
those on load, repoints their scripts, and drops the now-meaningless `brandId`
from library entries.

**Deleting a brand takes its scripts but not the videos** — those were the
creator's before any brand existed and outlive it.

## Scripts run on GitHub, not on your Mac (owner's ask, 2026-08-11)

`.github/workflows/adaptations.yml` runs `process_adaptations.py` on an
`ubuntu-latest` runner every 15 minutes, plus a **Run workflow** button for
impatience. Public repos get unlimited free standard-runner minutes, so the only
cost is the Anthropic spend the worker was always going to make.

**Two secrets must be set before it can work** — Settings → Secrets and
variables → Actions:

| secret | why |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | reads and writes every creator's row; bypasses RLS by design |
| `ANTHROPIC_API_KEY` | format extraction + adaptation |

Fork pull requests never receive secrets, so a drive-by PR cannot read them.

**Rotate the service-role key first.** It was pasted into a chat on 2026-07-31
and has been treated as leaked ever since. Putting a known-leaked key into CI
just spreads it — issue a new one in the Supabase dashboard, put that in the
GitHub secret, and update `.env`.

### What had to change to run off-Mac

- **Whisper.** `mlx-whisper` is Apple-Silicon only. `transcribe()` now tries MLX
  and falls back to `faster-whisper` on CPU, returning the identical dict, so
  neither the worker nor anything downstream can tell which ran. `_size_of()`
  maps `mlx-community/whisper-small-mlx` ⇄ `small`, and `WHISPER_MODEL` (set to
  `small` in the workflow) overrides the default. Verified the Mac still takes
  the MLX path.
- **yt-dlp path.** `yt_dlp_bin()` prefers `./venv/bin/yt-dlp` and falls back to
  PATH; CI pip-installs it and has no venv.
- **`output/` is gitignored**, so it does not exist in a fresh checkout and the
  logging `FileHandler` raised at import. Every pipeline module now mkdirs it.
- `requirements-ci.txt` pins the Linux deps. The Mac keeps using `./venv` with
  `mlx-whisper`; the two never have to agree.

`concurrency: creator-scripts` stops two runs racing on the same queued
adaptation — that would pay for it twice and fight over the write-back. A failed
run uploads `output/adaptations.log` as an artifact for 7 days.

**Caveats worth knowing:** GitHub's cron floor is 5 minutes but scheduled runs
on public repos are best-effort and get queued under load, so treat 15 minutes
as "usually". Scheduled workflows are also **disabled automatically after 60
days of repo inactivity** — a commit resets that.

## One pooled database — the consent toggle is gone (owner's ask, 2026-08-11)

The per-brand "Is this a Lynx client?" selector has been removed from the brand
editor, new brands no longer carry a `consent` field, and `upsert_source()` no
longer takes one. **Every source a creator sends now joins the shared library
and `lynxr_videos`**, which is the point: one database of what creators actually
think is worth remaking.

`lynxr_sources.consent` stays in the table, pinned to `'full'`, so existing rows
and the upsert body stay valid without a migration.

What makes pooling safe is unchanged and worth not breaking: **no brand or
creator identity is written to either shared table**. The row describes a public
video someone found — never who sent it, or which company they were shopping it
for. That stays in the creator's own RLS-protected row.

## URLs (owner's ask, 2026-08-11)

| URL | What | Linked from |
|---|---|---|
| `lynxr.io/` | Public homepage. One CTA: creators make an account. | — |
| `lynxr.io/creator.html` | The creator app. `?signup=1` opens the create form. | the homepage |
| `lynxr.io/agencyonly/` | The agency app. | **nothing** |

`agencyonly/index.html` is a directory so the URL has no `.html`. Its asset
paths are root-absolute (`/app.css`, `/app.js`) because relative ones would
resolve a level down and 404. It carries `noindex, nofollow`.

**Nothing on the public side links to it** — not the homepage, not the creator
gate, not `home.js`, not `creator.js`. Verified: zero references in all four.
The agency gate still links *back* to `/creator.html`, which leaks nothing.

### What "unlisted" actually buys you

Not much on its own, and it is important not to mistake it for security:

- The repo is **public**, so `agencyonly/` is listed at
  github.com/lynxrio/lynxr for anyone who looks.
- `noindex` asks search engines not to list it. It is a request, not a control.

So the URL keeps the agency app out of a creator's way. **The actual lock is the
`lynxr_staff` gate in `supabase/schema.sql`, which has still not been run.**
Until it is, any signed-in account — including every self-serve creator — can
read and delete `lynxr_clients` and read all 9,003 rows of `lynxr_videos`,
whatever URL the page lives at.

If you want the agency app genuinely undiscoverable, unlisting is the wrong
tool: host it from a private repo on Netlify/Vercel, or put it behind Cloudflare
Access. Say the word and I'll set that up.

### Inviting someone to the agency side

Signup is open to everyone, but signing up only ever creates a *creator*
account. Agency access is granted by you, one row at a time:

1. They sign up normally at `lynxr.io`.
2. You add them to staff in the Supabase SQL editor:
   ```sql
   insert into public.lynxr_staff (id, email)
   select id, email from auth.users where email = 'them@example.com'
   on conflict (id) do nothing;
   ```
3. You send them `lynxr.io/agencyonly/`.

`lynxr_staff` has **no insert policy for `authenticated`** — membership can only
be granted from the dashboard, so nobody can promote themselves.

## Sending a link: pick the companies (owner's ask, 2026-08-11)

The composer carries a "Write it for" chip row. The brand you are standing in is
pre-ticked, so the common case needs no clicks; tick others to fan the same link
out. One send produces **one Library entry and one script per ticked company**,
each with its own tracking code. Companies that already have a script from that
video are skipped and named, rather than silently dropped. The picker resets to
the current brand whenever you move between brands, and hides itself entirely
when there is only one company to choose from.

## How long a script takes

Measured on this Mac, 2026-08-11, for a 22-second source:

| stage | time | cost |
|---|---|---|
| metadata (`yt-dlp --dump-single-json`) | 0.9s | free |
| download (`yt-dlp`) | 3.9s | free |
| Whisper `whisper-small-mlx` | 2.2s | free |
| frames (ffmpeg, 4–6 jpegs) | 0.1s | free |
| **local subtotal** | **~7s** | |
| shot list — haiku-4.5, 6 images | not measured | API |
| tags — opus-5, 1 image | not measured | API |
| format extraction — opus-5 | not measured | API |
| adaptation — opus-5 | not measured | API |

The four model calls could not be timed because the Anthropic balance has been
empty all along. Three of them are Opus; expect the model stages to dominate, so
budget **roughly 1–2 minutes of actual work per video**.

**The queue is the real wait, and right now it is unbounded.**
`process_adaptations.py` is not scheduled — `launchctl list` shows only
`io.lynxr.blueprints`. A creator's script therefore sits at `status: "queued"`
until someone runs the worker by hand. Adding a launchd agent modelled on the
blueprints one (every 3 min) would put the end-to-end wall clock at **under 5
minutes**: up to 3 minutes queued plus 1–2 minutes of work.

## Silent videos get a shot-by-shot recreation (owner's ask, 2026-08-11)

Plenty of sources carry no spoken words. The old prompt told the model to
"write words the creator says out loud", so a silent format came back with an
invented voiceover bolted on — which destroys the thing that made it work, since
a silent format is *read, not heard* and survives being watched on mute.

`ADAPT_SCHEMA` now carries `delivery: "spoken" | "silent"`, and the prompt states
which one it is outright rather than leaving it inferred from an absent
transcript (a missing section reads as "nothing to see"). For a silent source
the worker is told: leave every `say` empty, give one beat per shot or text
change, and put a literal caption in `show` on **every** beat — that text is the
script.

The app renders that as a recreation rather than a broken script:

| | spoken | silent |
|---|---|---|
| heading | "Your script" | "Shot by shot" |
| hook label | Hook | Opening card |
| beat rows | SAY leads, DO/SHOW dimmed | DO + SHOW on every beat, undimmed |
| repeated shot | collapsed, so the words read clean | never collapsed — it would drop the beat |
| CTA | "CTA" (spoken) | "Final card" (on screen) |
| tracking code | "Say your code … out loud" | "Put your code … on the final card" |

`delivery` is trusted when present and inferred from empty `say` fields when
not, so scripts written before the field existed still render correctly.

**Also fixed here:** `upsert_video()` unwrapped `src["shots"]` as if it were
`{"shots": [...]}`, but `process_one` stores the plain list. That raised
AttributeError inside `main()`'s try block, which would have flipped a
successfully written script to `status="error"` — on every adaptation that had a
shot list, i.e. most of them. Caught before the first live run.

## The flow, end to end

Sending a link is one gesture: it becomes a script for the brand you are in,
and the video files itself in the Library at the same time.

```
creator.html  ──► pick a brand in the rail
                          │
                          ▼
                  paste a link in the composer at the foot of the pane
                  → one library entry (deduped account-wide by canonical url)
                  → one adaptation for THIS brand, no picker needed
                  written onto their own lynxr_creators row
                  (status: "queued", tracking code issued here,
                   libraryId pointing back at the video)
                  title + author fill in after, from oEmbed / og: tags
                          │
                          ▼
pipeline/process_adaptations.py   (owner's machine, service-role key)
   download (yt-dlp) → Whisper transcript → frames → shot list → taxonomy tags
   → FORMAT extraction (structure, topic stripped)
   → ADAPTATION (that structure rewritten for the creator's brand)
                          │
            ┌─────────────┼──────────────┬─────────────────────┐
            ▼             ▼              ▼                     ▼
  creator's row:   lynxr_sources:   lynxr_videos:       (nothing about the
  status "done"    shared library   the MAIN database,   brand is written
  (hook / SAY /    row, keyed by    data_source =        anywhere public)
   DO / SHOW /     canonical url    'Creator'
   CTA / caption)
```

### Creator submissions join the main database (owner's call, 2026-08-11)

`upsert_video()` writes every processed source into `lynxr_videos` next to the
9,003 scraped rows, so one creator's find becomes searchable Lynx-wide. Metrics
are real: `fetch_meta()` pulls view/like/comment counts and the platform's own
id from `yt-dlp --dump-single-json` — free, no API, no scrape — so these are not
zero-metric rows. Verified end to end against the live database on 2026-08-11
(wrote a row, read every column back, deleted it, count back to 9,003).

Two deliberate choices:

- **`data_source = 'Creator'`.** The column already carried provenance
  (`'Scraped'`, or a client name). Every creator row is marked so anything that
  must not mix the two can filter on it.
- **No brand or creator identity is written.** The source is a public video the
  creator merely found; which brand they were shopping it for stays in their own
  row (spec §1.1). That is also why this runs regardless of the brand's consent
  flag — nothing in the row is theirs.

**Open decision, flagged not solved:** creator submissions bypass the quality
gates in `filter_database.py` (SCRAPING_SPEC.md — the <100K-follower rule and
the rest). One creator pasting a 100M-view celebrity post puts a huge outlier
into the corpus, and nothing currently filters aggregates on `data_source`, so
it would move the medians that shelf ranking and `planRange` depend on. The
marker makes the fix a one-line filter; decide whether the stats should exclude
`data_source = 'Creator'`, or gate submissions through the same rules.

---

## Before this can run — two manual steps

**1. Apply the schema — it has never been run.** Confirmed live 2026-08-11:
`lynxr_creators` and `lynxr_sources` return `PGRST205 Could not find the table`.
That, not any login restriction, is why nobody can sign into the creator app
yet. Run the whole of `supabase/schema.sql` in the Supabase dashboard SQL
editor — it now carries the staff gate at the top as well as the two creator
tables at the bottom.

There is **no email allowlist anywhere in either app**, so no "exception" is
needed for any address: every Supabase account can sign into `creator.html` the
moment those tables exist. The two apps store their sessions under different
localStorage keys (`lynxr_sb_session` vs `lynxr_creator_session`), so one
account can be signed into both sides at once — but they must be signed in
*separately*. Copying a session between the keys does not work: Supabase rotates
refresh tokens, so whichever app refreshes second invalidates the other's copy.

**2. Creators sign themselves up.** The gate has a "Create one" switch that
posts to `/auth/v1/signup`. Whether they land straight in the app or get told to
confirm their email depends on **Authentication → Providers → Email → Confirm
email** in the Supabase dashboard — the page handles both. Their
`lynxr_creators` row is created by their first save, so nothing is needed by
hand. Making a user in the dashboard still works if you want to seed one.

Then run the worker:

```bash
cd ~/Documents/lynxrio && set -a && source .env && set +a && ./venv/bin/python pipeline/process_adaptations.py
```

Flags: `--no-ai` (transcript only, no API spend) · `--redo-ai` (retry entries
whose AI step failed, e.g. after a credit top-up) · `--cooldown-hours N`.

**Not yet on a schedule.** The blueprints worker runs every 3 min via the
launchd agent `io.lynxr.blueprints`; the adaptation worker has no equivalent
agent. Either add one modelled on
`~/Library/LaunchAgents/io.lynxr.blueprints.plist`, or fold this script into
that agent's command.

---

## The staff gate — apply this BEFORE anyone else signs up

Self-serve signup turned a latent risk into a live one. `lynxr_clients` granted
**every `authenticated` user** full read/write/delete, and `lynxr_videos` was
readable by any signed-in user. That was fine while accounts could only be made
by hand in the dashboard — the only two were the owner and the cofounder. With
`creator.html` open to signups, any stranger could create an account and, using
the public publishable key straight from this repo, read *and delete* every
client record, every brief, and the whole 9,000-row video database.

Verified live on 2026-08-11 with a signed-in session: `lynxr_clients` → 200
READABLE, `lynxr_videos` → 200 READABLE.

`supabase/schema.sql` now opens with a **staff gate**: a `lynxr_staff` table, an
`is_staff()` SECURITY DEFINER check, and agency policies rewritten from
`using (true)` to `using (public.is_staff())` — `lynxr_clients`, `lynxr_videos`,
and the `lynxr-blueprints` storage bucket. The seed promotes everyone who
already holds an account (i.e. you and your cofounder) and nobody after, and a
`raise exception` guard refuses to apply staff-only policies to an empty staff
table so the dashboard can't lock you out.

**Order matters: run this before handing `creator.html` to a single creator.**
Anyone holding an account at seed time becomes staff.

## Security model — read before touching the schema

This is the part most likely to be broken by accident.

`lynxr_clients` (agency) has a deliberate **"any signed-in user sees
everything"** policy. That is correct for a two-person agency and **completely
wrong** once outside creators have logins in the same Supabase project.

So:

- **`lynxr_creators`** is keyed on `auth.uid()` with owner-only policies. A
  creator can only ever read or write their own row — enforced by Postgres, not
  by the UI.
- **`lynxr_sources`** has **no `authenticated` policies at all**. Service-role
  only. Creators and agency staff share one auth pool, so any authenticated
  policy would hand the entire library to every creator (spec §1.1, §20).
- `creator.js` never queries `lynxr_clients` or `lynxr_videos`.

**If the agency dashboard needs to read `lynxr_sources`, add a roles table and
gate on it. Do not relax the policy to `authenticated`.**

---

## Deliberate decisions (don't "fix" these without asking)

**No randomized control arm on the creator side.** Spec §6.3 mandates
system-assigned control slots — that is an *agency-campaign* mechanic where Lynx
owns the brief. A self-serve creator came for a script; withholding one on 30%
of their posts would be a hostile product. Creator lift uses the §11 fallback:
their own non-Lynxr posts. The control arm belongs on the agency side.

**Tracking code, not a router slug.** Each adaptation gets a speakable code like
`MEDC7K2Q` (no I/O/0/1 — misheard and mistyped). This is the one attribution
path that works today with zero infrastructure: the creator says it, the brand
reports redemptions, and that conversion is exactly attributed. The
`go.lynxr.io` router from the spec does not exist yet.

**Adaptation can refuse.** Fit below 0.45 still returns a script but leads with a
warning that the format doesn't suit the product (spec §6.1). Forcing bad
pairings poisons a format's performance record — the format gets blamed for what
was really a bad match.

**Format vs family.** `format_type × hook_pattern` from the locked taxonomy is
the FAMILY (coarse, stable). The extracted `format` object is the finer
structure inside it. Spec §4.1. **Format *clustering* — deciding two sources are
the same format — is not implemented.** Each source currently gets its own
extracted format with no grouping. That is fine for step 1 and becomes essential
in step 2.

---

## Known gaps (honest list)

1. **Never run against the live API.** The Anthropic balance has been empty all
   session, so format extraction and adaptation have **never actually
   executed**. Schemas and prompts are well-formed and the code compiles, but
   the first paid run is the real test. Expect prompt tuning.
2. **Email confirmation is ON with no SMTP configured — signup is effectively
   broken for real creators.** Checked live 2026-08-11:
   `/auth/v1/settings` → `mailer_autoconfirm: false`, `disable_signup: false`.
   Supabase's built-in mailer is a testing convenience — a few messages an hour,
   and it is not a delivery service — so a genuine creator signing up may never
   receive the link. **Fix before launch: either turn off Authentication →
   Sign In / Providers → Email → "Confirm email" (signup then returns a session
   and `creator.js` drops them straight into the app — that path is already
   built and tested), or configure custom SMTP.**

   Related: the "check your email" message used to be shown for *both* a new
   address and an address that already had an account, because Supabase
   deliberately answers the second case with a decoy user so the endpoint can't
   be used to enumerate accounts. Re-using an existing address therefore sent
   you off to wait for a link that is never sent. The message now names both
   cases without disclosing which one applies.

3. **TikTok's oEmbed is refusing us.** `https://www.tiktok.com/oembed` answered
   400 with no `Access-Control-Allow-Origin` header on every request tried
   2026-08-11, browser UA or not — so library entries fall through to scraping
   og: tags via the allorigins/codetabs relays. `app.js` calls the same endpoint
   for its paste-a-link tagging, so this is not new and not creator-specific.
   It may simply be this network: worth re-checking from the deployed origin
   before concluding TikTok has closed the endpoint. Nothing breaks either way
   — an un-hydrated card is titled `@handle on TikTok` instead of the caption.
4. **No worker schedule** — see above.
5. **No format clustering** (step 2 work).
6. **`lynxr_sources` has no reader.** Rows accumulate; nothing displays them
   yet. That is intentional for step 1.
7. **Instagram downloads are flaky.** yt-dlp often needs cookies for Reels. The
   entry will show `couldn't fetch` with a Try again button. TikTok and YouTube
   are reliable.
8. **Whisper is `small`.** `transcribe.py` notes large-v3 as a free local
   upgrade — meaningfully better, especially non-English. Slower per video.
9. **No creator-side performance tracking.** Post URL attach, snapshots, and
   lift (spec §8–12) are not built. That is step 3.

---

## Verification already done

- `node --check creator.js` passes; `creator.html` parses with no unclosed tags;
  every `getElementById` target in the JS exists in the HTML.
- `process_adaptations.py` compiles; imports resolve across
  `transcribe` / `analyze_visuals` / `retag_with_audio` / `taxonomy`.
- URL canonicalisation in Python matches the JS byte-for-byte across TikTok
  share params, trailing slashes, `youtu.be`, and `m.youtube.com`.
- The page was driven in-browser with synthetic data: the three states render
  correctly (`script ready` / `writing your script` / `poor fit`), beats split
  into SAY / DO / SHOW rows, the CTA, tracking code and poor-fit warning all
  display.

### Company folders + library + signup, verified in-browser 2026-08-11

Driven against `python -m http.server` at desktop and 375px, checking painted
pixels and not just DOM state:

- Both gate modes paint — the confirm-password field, button and helper text all
  swap, and switching back clears the second field.
- Folder list shows per-company counts and a status chip (`1 script being
  written` / `1 video couldn't be fetched` / `empty`). Open → crumbs, page head,
  four stat cards, collapsible details, Library, Scripts.
- **Per-company isolation**: the same TikTok URL saved under two companies makes
  two entries with the same `canon` and different ids; each company's library,
  scripts and stats count only its own.
- "Write the script" needs no picker — the folder already says which company.
  It issues a fresh tracking code, sets `libraryId`, and the card chip moves
  `not scripted yet` → `writing your script` → `script ready`. A second attempt
  is refused as a duplicate.
- **Stats and both section counts repaint on every change** — this was a real
  bug mid-build: queuing a script left the header showing `1/2` over a list of
  three. Now `refreshCompany()` owns the stat cards, both pills, the search
  box's visibility threshold, and both lists.
- Renaming a company patches the breadcrumb and page title live **without
  stealing focus** from the field being typed in.
- Add → lands inside the new folder with details open and the name focused.
  Delete → two-click armed, and it takes that company's library and scripts with
  it (verified: zero orphans left behind).
- A real YouTube link hydrated to "Rick Astley — Never Gonna Give You Up…" with
  the author, and that title propagated into the script row.
- Search filters within one folder and resets when you open another.
- The worker's merge is covered by assertions (library saves survive a run,
  processed results still land, mid-run deletes stay deleted).
- The agency app was loaded afterwards on the shared stylesheet: signed-in
  dashboard, all bar charts painting, no regressions.

**Not verified:** anything requiring the live API or a real Supabase creator
row — including the signup round-trip itself, which has only been exercised
against the two response shapes, not against Supabase.

---

## Rules for this repo (inherited — they matter)

- **The owner does all git.** Never run `git add`, `commit`, or `push`; the
  allowlist blocks them. Finish the code, say what changed, stop.
- **The repo is public.** No secrets in files. `output/` is gitignored, which is
  why the spec lives there.
- **Strict CSP** (`style-src 'self'`, no `unsafe-inline`). Inline `style="..."`
  attributes are silently discarded — style via classes. Verify painted pixels,
  not DOM state.
- **Bump `?v=` on every css/js change** or browsers serve stale files. Currently
  `?v=20260807f`.
- Use `./venv/bin/python -m pip`, never `./venv/bin/pip`.

---

## Suggested next moves, in order

1. **Top up Anthropic credits and run the worker on one real link.** Everything
   downstream is guesswork until the format-extraction and adaptation prompts
   have produced real output. This is the highest-information action available.
2. Tune the two prompts in `process_adaptations.py` (`FORMAT_SYSTEM`,
   `ADAPT_SYSTEM`) against that output.
3. Add the launchd agent so scripts arrive without a manual run.
4. Decide the **email-confirmation** setting in Supabase and sign up once for
   real to confirm the round-trip — the gate handles either setting, but only
   one of them has been chosen.
5. Only then ask the owner whether to start step 2.
