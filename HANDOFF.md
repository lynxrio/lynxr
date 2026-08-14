# Lynxr — session handoff

Read this, then `README.md` for architecture. **Last updated 2026-08-14.**

Lynxr (lynxr.io) is a format-intelligence platform for Lynx Media Group, a
short-form video agency. Static site on GitHub Pages + Supabase + a Python
pipeline. Three surfaces, one stylesheet (`app.css`):

| path | file | who |
|---|---|---|
| `/` | `index.html` + `home.js` | public — wait list capture only |
| `/creatorsonly/` | `creator.js` | creators — paste a link, get a script |
| `/agencyonly/` | `app.js` | staff — database, briefs, clients |
| `/privacy/` | static | the privacy policy, linked from all three |

---

## Where this left off (read this first)

The whole of 2026-08-14 went into the **agency app**, at the owner's direction,
while they waited on feedback from test creators. Two things happened:

1. **It was cut back to three jobs** — format saturation, per-video suggestions
   per client, and briefs. ~1,340 lines of app.js and ~250 of app.css went with
   the performance-tracking half. See "cut back to three jobs" below.
2. **Suggestions became the centre of the app.** A client folder now opens on a
   ranked grid of videos to copy, each carrying a **1–10 opportunity score**,
   and ticking them plus `+` files a brief in place.
3. **8,250 cover frames were published** to the public `lynxr-covers` bucket by
   the new `pipeline/upload_covers.py`, which finally gives Instagram rows a
   thumbnail. They had been sitting in gitignored `data/covers/` for months.

**The creator app was touched late in the day too**, all in its trash view:
an open-original ↗, a delete-permanently button, a restore icon, a mobile
dropdown for the meta line, and spacing. Everything else there is untouched,
and the shared stylesheet was re-verified against it on every change.

To pick up: `python -m http.server` via `.claude/launch.json` ("lynxr", port
8811), then `/agencyonly/`. Sign in as `lynxmedianetwork@gmail.com` — that is
the only staff account, so any other login shows an empty dashboard.

**Three facts that will save you an hour each.**
- The HTML documents are NOT cache-stamped, so after a css/js change the
  browser keeps serving the old `?v=` — a hard reload, or swapping the
  stylesheet href in the console, is the only way to see your own work.
- The venv's Python has **no CA bundle**: any `urllib` call to Supabase needs
  `ssl.create_default_context(cafile=certifi.where())` or it dies with
  CERTIFICATE_VERIFY_FAILED.
- **app.css's `@media (max-width: 640px)` block sits ~700 lines ABOVE many of
  the rules it overrides**, so an unscoped mobile override silently loses on
  equal specificity. Source order decides, not the media query. This cost three
  separate silent failures in one session — see the CSS ORDER TRAP note.

---

## THE POINT (owner, 2026-08-19)

Creators get scripts from videos they already believe will perform. Those
pasted videos flow into `lynxr_sources`, which is how Lynx sees formats
**before** other UGC agencies saturate them. The creator app is a tool for
creators AND a sourcing sensor for the agency — that second half is the moat.

Consequence worth holding onto: `lynxr_videos` (9,016 scraped rows) is
**lagging** — it contains videos that already performed, which is why
competitors can find them too. `lynxr_sources` is **leading**. Its `tag_count`
is the saturation meter: one video pasted by three creators in a week is a
format spreading in real time.

**`lynxr_sources` has 15 rows and NOTHING reads it — 0 references in app.js.**
The sensor records; no dial exists. Highest-leverage unbuilt thing in the repo.

---

## Verified against the live DB this session — trust these over older notes

- **9,016 videos** in `lynxr_videos` (older docs say 9,905 / 2,640 — both wrong).
- **5 auth accounts, 1 staff row** (`lynxmedianetwork@gmail.com`).
  **`junsaemail@gmail.com` is NOT staff** — signing into the agency app with it
  shows an empty dashboard. That is the gate working, not a bug.
- **Creator isolation holds.** Proven with two throwaway accounts: a non-staff
  creator reads 0 rows from every table, cannot select/update/**delete**
  another creator's row, and cannot promote itself to staff (403).
  Re-run that probe after any RLS change; reading the .sql file is not evidence.
- **Scripts are written by GitHub Actions** (`.github/workflows/adaptations.yml`),
  **not** the owner's Mac. Public repo = free runners. Cron says every 15 min
  but real firings measured ~3h apart, so each run polls for ~5h45m and the
  concurrency group hands over run-to-run. Any push to main restarts the chain.
  (`io.lynxr.blueprints` launchd on the Mac is legacy/backup.)
- **Column fill rates** (sampled 1,000): `similar_format_count` and
  `avg_views_of_similar` 999/1000, `niche_category` 1000/1000,
  `target_audience` 999/1000, but **`creator_followers` only 467/1000** — any
  views-per-follower index is computable on half the corpus only.
- `signup_state()` returns `{open: true, invite_required: false}`. The seat
  table exists (`seats: 4`) but is not enforcing. **Owner's call: fine — the
  URL is unlisted and handed to trusted creators.**

---

## What shipped this session

**Wait list / public page**
- `source` is real now: `?ref=` → `?utm_source=` → referrer hostname →
  `landing`. Sanitised to `[a-z0-9._:-]`, 40 chars.
- **Consent is versioned.** `CONSENT` in home.js is `launch-and-updates-v2`.
  Rows carrying `launch-notify-v1` (or blank) agreed to a launch email ONLY —
  do not send them product updates, and do not retro-fit v2 onto them.
- **Unsubscribe.** `lynxr_waitlist.unsubscribed_at` (NULL = subscribed).
  **Every export must filter `&unsubscribed_at=is.null`** — the unfiltered URL
  still returns everyone. Tested end-to-end: marking one address dropped it
  from the export, then restored.
- Privacy policy at `/privacy/` — thorough, names every sub-processor, and
  discloses that staff can see pasted video links.

**Creator app**
- Signup requires an explicit ticked consent box; acceptance recorded as
  `ME.privacyAccepted = {version, at}` with `PRIVACY_VERSION = "2026-08-17"`.
- Privacy policy opens in a **modal that fetches `/privacy/`** rather than a
  second copy — edit the page, the modal follows. Falls back to a normal link.
- **Delete account** is self-serve and immediate (`supabase/delete_account.sql`,
  a SECURITY DEFINER function taking no arguments so it can only ever act on
  `auth.uid()`). Verified: HTTP 204, creator row 1 → 0, auth user gone.
- Manual script editing; Library renders scripts **inline** instead of linking
  out; one script per video per brand.

**Agency app**
- **Clients is the landing tab**, Database moved last (owner: the trend charts
  are a CHECK on lynxr's formats vs self-sourced, not the front page).
- **"Room to run"** — per-FORMAT saturation vs median reach, on the Database
  tab. Measured: POV is 1.2% of the corpus at 115,600 median views; Talking
  Head is 31.5% at 8,016.
- Blueprints: copy/edit/delete icon row matching the creator app, and manual
  editing stored as `b.editedBeats` — an OVERRIDE, never written over the
  transcript, so "Try again" and Revert both still work. Copy prefers it.

**Site-wide**
- **Lowercase house style, done entirely in CSS** (`body, button, select` +
  a content exclusion list). Deliberately NOT a source rewrite: `text-transform`
  changes what is drawn, so "copy script" still copies the creator's real
  casing. `.entity` opts the registered company name back out.
- **Thumbnails were enlarged (2026-08-14), and every thumbnail is now
  `object-fit: contain`.** Blueprint rows 34×44 → **40×56**, the New Client
  shelf `minmax(250px)` → **290px**, the brief viewer's player column 320 →
  **360px**, the expanded script card 280 → **320px**.
  Three things learned doing it:
  - **Two competing `.bp-thumb` rules existed** — one assuming a bare `<img>`,
    one the `<span>` wrapper `bpThumbHtml` actually renders. The wrapper
    survived.
  - **Do not give `.bp-thumb` a 9:16 `aspect-ratio`.** A box wide enough to be
    useful is then 82px tall, which took the blueprint row from 66px to 104px —
    one line of text marooned beside a tower. It is sized by ROW HEIGHT
    (40×56, row back to 78px); `contain` is what protects the shape instead.
  - **`cover` was cropping YouTube badly.** ytimg only publishes a 4:3
    letterboxed `hqdefault`, and `fetch_covers.py` sourced ours from it, so
    every YouTube cover in `lynxr-covers` is 4:3 too (360×270) — swapping one
    for the other gains nothing and that experiment was reverted. Under
    `cover` a 4:3 image in a 9:16 frame was cropped to a middle strip; under
    `contain` it letterboxes whole. Verified painted ratio == natural ratio on
    every loaded thumbnail.
- System code font (`ui-monospace`), base 14px. Share Tech Mono is still in
  `fonts/`; put it back at the front of `--mono` to revert.
- **The LOGO is Share Tech Mono again (2026-08-14), and only the logo.** It
  lives in its own `--logo` variable used by `.wordmark`, `.foot-wordmark` and
  `.legal-back` — that last one IS the wordmark on the privacy page, it just
  isn't marked up with `.wordmark`. All four pages, every instance, verified
  live. Everything else stays on the system font. Do NOT fold `--logo` back
  into `--mono` — that is the site-wide revert. The face ships a single 400 weight,
  so the wordmark's old `font-weight: 600` and `letter-spacing: -0.03em` were
  dropped (synthesised bold, and negative tracking cramps a monospace face).
  Verified painted, not just declared: "lynxr." measures 68.05px in Share Tech
  Mono vs 75.86px in the fallback stack.

---

## The agency app was cut back to three jobs (2026-08-14)

Owner's call: **"get rid of anything that isn't related to seeing which formats
are saturated or not and adding them to a brief… focus on finding videos that
will work well for specific clients based on their niche and target
demographic. The tracking we can do later."**

So the agency app now does exactly three things: **format saturation**
(Database tab), **per-video suggestions per client**, and **briefs**.

**The .docx export is gone too (2026-08-14, owner's call).** Both buttons and
the entire hand-rolled exporter — `zipStore`, `crc32`, the OOXML part builders
— went with them, ~100 lines that nothing could reach any more. Briefs are
still copyable as text (`copyScripts`).

**Removed — ~1,240 lines of app.js and ~250 of app.css.** Performance tracking
in full: post check-ins, predicted-vs-actual charts, campaign/brief health
cards, the held-out model validation, the warm-up calibration bands, the
"what works for this client" trends card, and the client learning loop that
boosted formats off tracked posts. The New Client form lost its three campaign-
plan fields (videos/month, success target, calibration role).

**Nothing was deleted from anyone's data.** `client.posts` is still in every
stored client record, untouched — the app just stops reading it. Re-enabling
later is a UI job, and the old code is in git history before this commit.

### Suggested videos — how the score actually works

> **Read this with "The card shows a 1–10 opportunity score" below.** What is
> described here — the per-video "edge" against its own pocket — is no longer
> what the card displays. It is now only the TIEBREAKER that orders videos
> sharing the same 1–10. Both are live; this is the finer of the two.

Per VIDEO, not per format, because a format's aggregate hides its own winners:
Talking Head has the worst median reach in the corpus and still supplies the
most individual overperformers.

The obvious score is `views / avg_views_of_similar` — the column the pipeline
already ships. **Do not use it raw.** Measured on the master CSV it has two
defects:

1. Its group key is `(niche, format, hook)` with **no platform**, so it scores
   a YouTube Short against viral TikToks. Median score by platform: tiktok
   0.204, instagram 0.110, **youtube 0.012** — a 17× handicap that put 0
   YouTube videos in the top 200.
2. It is a **mean**, so one 10M-view clip makes every other member of its
   pocket look like a failure. Corpus median score was 0.128.

`buildPockets()` rebuilds the denominator: same grouping **plus platform**, a
**median**, over measured rows only (`views > 0` — the same zero-views trap
`renderShelf` documents), pockets of ≥12. Corpus median goes to 1.00 with
50.5% of videos above their pocket, which is what "beat the typical video like
you" should mean. 440 pockets cover 7,874 of 9,003 rows; anything thinner is
simply not scored.

**Ranking is banded, not top-N.** A raw descending sort returns a viral
highlight reel — 21M-view meme clips from pockets of 6 — which is useless as a
brief because nobody can copy a lottery win. So: keep only videos that beat
their pocket, **cut the top 3%**, cap 2 per format×hook, then tilt by the
client's target demographic (`avatarBoost`: audience tag + avatar keywords).
Same lesson `buildShelf` already encodes for formats.

Ticking suggestions seeds the next brief's cart — `SUGGEST_PICKS` →
`startNextWeekBrief` → `SEEDED_KEYS`, and `renderShelf` **pins seeded rows to
the front of the shelf** so the tray count never counts a video with no card.

### Layout rules the suggestion cards learned

- **The grid is fixed at 3 columns**, not `auto-fill`. On a wide monitor
  auto-fill produced six-plus columns of vertical video and the section
  swallowed the page. 2 columns under 900px, 1 under 560px.
- **The frame is `aspect-ratio: 9/16` — the VIDEO's own ratio — with
  `overflow: hidden`.** Three things were tried and two were wrong: a bare
  `max-height` let a 1080×1920 cover win the sizing race and paint over the
  score and buttons below it; a flat 400px height stopped that but clipped the
  player, cutting the video off partway down. 9/16 is the video itself. The
  platform frames' full ratios (TikTok is 9/19.8) budget for the embed's
  header, caption and music rows on top of the video — ~800px at these card
  widths — so only that surrounding chrome now falls outside the frame.
- **The ratio applies whether or not the card is playing**, so hitting play
  never resizes the card or reflows the grid under the cursor. Measured at
  1900px wide: frame 366×651, card 766px, identical before and after play.
- **Thumbnails are `object-fit: contain`, not `cover`.** Covers are not all
  9:16 — every YouTube one is 4:3, because ytimg publishes only a letterboxed
  `hqdefault` and `fetch_covers.py` sourced ours from it. Under `cover` those
  were cropped to a middle strip; under `contain` they letterbox whole.
  Verified painted ratio == natural ratio on every loaded thumbnail.
- Detail-panel labels are sized in `ch`, not px. At 62px "engagement"
  overflowed its own column and collided with its value.

### `armDelete` ate its own icons (fixed 2026-08-14)

The agency copy restored a button with `btn.textContent = label`, so the first
arm-then-disarm **replaced the trash `<svg>` with the word "Delete"** — the
blueprint delete buttons had permanently degraded to text. `creator.js` had
already solved this; app.js now matches it: capture `btn.innerHTML` as the
face, restore that, and ignore a second click inside 450ms so an ordinary
double-click can't delete outright. Client and brief rows now use the same
`ghost danger icon-only` trash button (`TRASH_SVG`).

### Covers are hosted now — Instagram finally has thumbnails

`fetch_covers.py` had been caching an opening frame per video into
`data/covers/` for months (**10,392 files, 1.7 GB, gitignored**) purely to tag
Visual Hook. No browser could ever reach them, so the agency app fell back to
per-platform tricks and Instagram got nothing at all.

**`pipeline/upload_covers.py` publishes them.** 8,250 uploaded, 10 failed.
Resampled to 360 px (~22 KB each, 181 MB total against Supabase's 1 GB —
the originals would have been 1.3 GB). The key is deliberately the SAME one
`process_adaptations.py` uses for creator covers, so both pipelines share one
bucket and never collide:

    lynxr-covers/<sha1(canon_url(url))[:20]>.jpg      (public bucket)

`canon_url` in Python is byte-identical to `canonUrl()` in app.js, so the
browser derives the key itself — nothing extra is stored on a row.
`fillHostedCovers()` probes the URL with an `Image` before swapping it in, so a
row whose cover was never uploaded keeps whatever thumbnail it already had.

Coverage is honest, not total: **989/1,335 Instagram (74%)**, 6,299/6,692
TikTok, 972/976 YouTube. 743 database rows have no cached cover at all, so
those still render the placeholder. Verified live: an Instagram-only pool
renders 4 of 6 cards from `lynxr-covers`, the rest placeholder.

Two gotchas that cost time:
- **The venv has no system CA bundle.** A bare `ssl.create_default_context()`
  fails every request with CERTIFICATE_VERIFY_FAILED; use `certifi.where()`
  like the rest of the pipeline does.
- **`img-src` had to gain the Supabase origin** on the agency page. The creator
  page already had it — that is how creator covers have always worked.

### Suggestions now filter to organic UGC you could actually remake

The shelf was surfacing 11–23M-view runway reposts and meme aggregators. They
top every performance sort and are worthless as a brief: no script to tweak, no
creator to imitate. Three gates, all measured on the master CSV:

- **Format.** `Meme / Trend Clip` (1,724 rows) is the repost bucket and
  `Reaction / Duet` is commentary on someone else's video. Neither is a thing
  you write a script for. `SCRIPTABLE_FORMATS` holds the rest.
- **Creator size.** `creator_followers` fills 70% of rows — median 8,157,
  p90 74,100, max 3.2M. Over 500K is a media brand, not a UGC creator. Rows
  with unknown followers are KEPT; dropping the blind 30% costs more than it buys.
- **View ceiling.** Each niche's own p95, because Health & Medical tops out
  near 280K while Fashion & Beauty runs to 3.5M — one global number would gut
  the first and let the second through.

### The card shows a 1–10 opportunity score, and it leads the ranking

`"43.3× its pocket"` was accurate and unreadable. Each card now shows **N/10**
on the VIDEO TYPE — format × hook, scoped to niche × platform — answering the
question a brief actually asks: *should we make this kind of video?*
**1 = crowded and weak, don't bother. 10 = rare and strong, go now.**

Two axes, both measured inside the same niche+platform scope (a TikTok median
against a YouTube one is meaningless):

- **ROOM** — the type's share of that scope. Measured p10/p90 across all 192
  types with ≥12 members: **1.8% → 29.3%**.
- **REACH** — the type's median views ÷ the scope's median type. p10/p90:
  **0.26× → 3.04×** (with a 250× tail).

Both log-scaled — both distributions are heavily skewed — then averaged and
mapped onto 1–10. `SHARE_LO/HI` and `REACH_LO/HI` are those measured bounds, so
the scale is calibrated to this corpus rather than invented. The result is a
clean curve: 1×1, 4×2, 17×3, 29×4, 38×5, 32×6, 16×7, 12×8, 12×9, 14×10. The
worst type in the corpus is *Meme × No Hook* on TikTok in Lifestyle — 46% of its
scope at 0.13× the reach. The best are 1–2% shares pulling 3–8×.

**The score sorts the list, first, descending.** As a multiplicative tilt it did
nothing: `edge` spans orders of magnitude and swamped a 0.55–1.5 factor, so the
top six came back 5,5,6,6,7,6 while 10/10 types sat unseen further down. Now
`tier` sorts and the per-video edge only orders videos sharing a score.
Verified monotonic in every niche — Fashion opens on two 10s, Education on
twelve. Unscored types (too few peers) rank as a 5 rather than being buried.

The chip is colour-banded — 7+ green, 5–6 amber, under 5 red. Hovering it shows
a one-line tooltip with a pointer arrow: *"10 = hardly anyone makes it and it
performs. 1 = everyone makes it and it flops."* Deliberately one line — the
score, both axes and the per-video multiple all live in the card's Details
panel, so the hover only has to say which way the scale runs.

Three placement constraints, all learned the hard way:
- **The tooltip is parented to `<body>` and `position: fixed`.** `.vcard` is
  `overflow: hidden`, so anything rendered inside a card is clipped by it.
- **It clamps on both axes and picks the side with more room.** "Prefer above,
  else below" was not enough: the first version was a ~314px panel, and a chip
  low in the viewport put the whole thing off the bottom of the screen.
- **The arrow's `left` is set from the CHIP's centre, not the panel's.** The two
  stop agreeing the moment the panel is clamped against a viewport edge.
Verified on both placements, at the top and bottom of a 900px viewport: fits
on screen, arrow centred on the chip and flush to the panel edge.

Measured on the live corpus (8,809 rows, Fashion & Beauty): 358 rows dropped by
the gates, and the top picks went from a 23.8M-view runway clip to Listicles and
Talking Heads from creators with 2.9K–189K followers.

The grid shows **6, then loads 3 at a time** (`SUGGEST_PAGE` / `SUGGEST_STEP`),
scoring 30 deep so there is somewhere to load from.

**Load more APPENDS; it does not re-render.** Two reasons, both measured:
re-rendering the section threw away already-decoded thumbnails and any open
detail panel, and — worse — the browser's **scroll anchoring** kept the visible
content still by scrolling the page ~800px underneath, so the button stayed
pinned at the identical spot on screen and nothing looked like it had loaded.
`overflow-anchor: none` on `.suggest-grid` / `.sug-more-row` disables that, and
appending lets the new row push the button below the fold where it belongs.
Verified: scrollY held at 1375, button moved 469 → 1530 (fold at 900), open
detail panel survived, and the chain runs 6 → 30 before the control removes
itself. `sugCardHtml()` / `sugMoreRowHtml()` / `bindSugCard()` exist so the
initial render and the append share one definition.

The Briefs CTA reads **"2 picks → brief 1"** (singular "1 pick"), reverting to
the bare `+` at zero.

### Briefs are created on the client page now — no New Client detour

`startNextWeekBrief()` used to seed a cart and jump to the **New Client** tab,
which then showed a site-lookup form, a second parallel video shelf and a
"0/10 in brief" tray. As the answer to "+" on a client that already exists and
whose videos you had just ticked, that was nonsense. It now builds the brief
in place from `SUGGEST_PICKS`, files it, clears the picks, and opens it — the
tab never changes.

With **nothing ticked**, `+` does not create an empty brief or navigate: it
scrolls to Suggestions and shows a transient red `sugHint()` that shakes once
on arrival and stays 7s.

Two bugs that cost real time there, both worth not repeating:
- **The hint was built as a `max-height: 0 → 4em` collapse and never painted a
  pixel.** With its class applied, `max-height` and `opacity` still computed to
  `0`, even though `color` and `animation` from the *same rule* took effect.
  It is now shown/hidden with the `hidden` attribute — an attribute toggle
  cannot fail that way. Same lesson as the invisible bar charts: verify painted
  height, never DOM state.
- **The auto-hide timer closed over the element.** Any re-render of the client
  page swaps that node out, so the timer fired against a detached element and
  the visible hint never left. It re-queries `.sug-hint` at fire time instead. Verified end to end —
3 picks in, brief filed with exactly those 3 items in order, ctx carried,
new brief opened, and on returning to the folder those videos have dropped out
of Suggestions (they are `briefed` now) and the CTA is back to a bare `+`.

That deleted the whole seeded-cart mechanism: **`SEEDED_KEYS` and
`LEARN_CLIENT` are gone**, along with `renderShelf`'s pinning of seeded rows.
**The New Client tab still exists** and is untouched — it is the only way to
onboard a brand-new client from a website. Only the brief flow stopped routing
through it.

### Client and brief cards are click-anywhere

Both lists lost their "Open" button — the card is a big obvious target and the
button was redundant beside it. `openOnCard()` wires click plus Enter/Space,
the card carries `role="button" tabindex="0"`, and `.bcard.opens` supplies the
`cursor: pointer` that is now the only affordance. The trash button inside a
card still wins: `armDelete` already calls `stopPropagation()`, and
`openOnCard` additionally ignores any click that lands on a
`button, a, input, label, select, textarea`. Verified: card opens on click and
on Enter, trash arms without navigating.

### The creator trash row gained two controls

Each row in the creator app's trash now carries an **open-original ↗** link and
a **delete-permanently** trash button beside Restore, grouped in
`.trash-actions`. The permanent delete splices `ME.trash` **and nothing else** —
it deliberately does not touch `lynxr_sources`, because that row describes a
public video, is keyed by canonical URL and is shared by every creator, so one
person emptying their bin must not remove it for anybody else. Same rule
`delete_account.sql` already follows. Two-click armed like every other
destructive control; verified it arms, then purges only the clicked entry.

The row's two text lines were spaced out (`.bp-hint` margin 2px → 6px,
line-height 1.65, row padding 10px → 14px) — at 2px they read as one dense
block.

**On a phone the row collapses to one line — 156px → 86px.** Four attempts got
there, and the dead ends are worth not repeating:

1. Actions on their own full-width row. Still 138px, and it wasted a whole line.
2. `.trash-main { flex: 1 1 100% }` to widen the text — **wrong**: at basis 100%
   the text claimed its own line and shoved the thumbnail onto a line above it,
   three stacked rows for one entry. Basis **0** keeps it beside the thumbnail.
3. Icons instead of the word "Restore" (`.trash-restore-txt` hidden, an `.ico`
   shown) so all three controls fit on the thumbnail's line. 91px.
4. The permalink still wrapped to three lines in 182px, taller than the 56px
   thumbnail beside it, because `overflow-wrap: anywhere` broke it mid-token.
   One line with `text-overflow: ellipsis` instead. **86px.**

The meta line hides behind the title with a caret (`.trash-row.open`, toggled by
clicking `.trash-main`); `.trash-hook` stays hidden on mobile in both states.
On desktop nothing changes: full URL, the word "Restore", meta always visible,
caret hidden, `.open` inert.

Three more fixes in the same pass:
- **The armed delete overflowed its own button.** `armDelete` swaps the trash
  icon for "Are you sure?", and the mobile `34x34` icon-only rule crushed that
  into three wrapped lines spilling out of the card. `.icon-only.armed` now
  frees width AND height (the base `.ghost.icon-only.armed` frees width only).
- **Restore got a proper icon** — a bin with an arrow lifting out of it, rather
  than the generic undo curl, which reads as "revert an edit".
- **`select { max-width: 200px }` is global**, for the Database tab's filter
  row, and it left the one `<select>` in the account form visibly narrower than
  every `<input>` stacked above it. `.ce-field input, .ce-field select` now set
  `max-width: none; width: 100%`. Verified the Database filters keep their
  200px cap and nothing in the New Client grid overflows its column.
- **The agency tab title was just "lynxr"** while its own `og:title` already
  said "lynxr — agency". Now `<title>lynxr — agency</title>`, matching
  "lynxr — creators". Remember the HTML documents are NOT cache-stamped, so
  this one needs a hard reload to show.

**Known trade:** the mobile title truncates to `instagram.com/p…`, so the
shortcode that distinguishes one entry from another is cut. The thumbnail, the
↗ and the dropdown all still identify it. If that proves annoying, render the
tail instead of the head for the mobile title rather than reaching for a
`direction: rtl` truncation trick, which reorders trailing punctuation.

**CSS ORDER TRAP — this bit me three times in one session.** The
`@media (max-width: 640px)` block sits EARLIER in app.css than several base
rules (`.trash-main`, `.trash-actions`, `.trash-caret`, all defined ~700 lines
below it). An unscoped override inside the media query therefore LOSES to the
base rule on equal specificity and silently does nothing — the media query is
not the tie-breaker, source order is. Scope mobile overrides under a parent
(`.trash-row .trash-actions`) when the base rule lives further down the file.

### The client header has a Details button

Top-right of `.page-head`, toggling `clientDetailsHtml()`: company, niche,
audience, brand, features, brief and blueprint counts, date added, plus the
avatar blocks. It replaces the old `avatarBoxHtml()` — the avatar was the only
field visible on this page, while the niche and audience that actually drive
the suggestion ranking were invisible unless you opened a brief.

### Section headers and the mobile pass (2026-08-14)

`.sec-head` is the shared "title on the left, action pinned right" row, used by
Video blueprints and Briefs. Two things worth knowing:

- **It carries `margin-bottom: 20px`, and the blueprints box is exempt.** That
  box already spaced itself to 20px via `.bp-msg` (8) + `.bp-list` (12).
  `.sec-head` is a FLEX container, so its margin does **not** collapse with the
  next sibling's — adding one there stacked to 32px instead of overlapping.
  Hence `.blueprints-box .sec-head { margin-bottom: 0 }`.
- **The Briefs action is two different elements.** Bare `+` (`.lib-plus`) with
  nothing ticked, and a labelled `.btn.sec-cta` ("Build brief 2 with 3 picked")
  once suggestions are picked. `refreshNextBriefBtn()` swaps the whole node
  rather than relabelling, because writing `textContent` onto the icon button
  would eat its svg — the same trap `armDelete` had.

**Mobile is fixed at 375px**, inside the existing `@media (max-width: 640px)`.
The page scrolled sideways because `header nav` is `overflow-x: auto` but a flex
item will not shrink below its content without `flex: 1 1 auto; min-width: 0` —
so three tabs pushed Sign out 43px off-screen. Also: `.sec-cta` drops to its own
full-width row (it does not fit beside a title on a phone), `.sug-drow` stacks
its label above its value (a 12ch label column plus a value does not fit), and
`.bcard` / `.crumbs` / `.bp-item > summary` wrap instead of overflowing.
Verified 0 overflowing elements and no horizontal scroll on all three pages.

### Blueprint thumbnails — three sources, one remaining gap

Blueprint rows carry cover art in a fixed **48×62** box (fixed so a missing
cover leaves the row exactly as tall as one that has it). Three sources are
tried, in effect:

1. **YouTube** — derived straight from the URL (`i.ytimg.com`).
2. **TikTok** — oEmbed (`*.tiktokcdn.com`). Note this fails from `localhost`
   with a CORS error; it works on the real origin.
3. **`lynxr-covers`** — `fillHostedCovers()` runs on blueprint rows too, so an
   **Instagram** blueprint does resolve *if that same video was ever turned into
   a creator script*, because `process_adaptations.py` published its frame under
   the same `canonUrl` key.

**The gap:** a pasted Instagram video that has never been through the creator
pipeline still shows the placeholder. Instagram publishes no keyless thumbnail
and `*.cdninstagram.com` is not in `img-src`. The fix is
`process_blueprints.py` saving a frame — it already downloads the media with
yt-dlp to transcribe it — and uploading it under the same key. Confirmed today
that it stores no cover of any kind.

## Speed (2026-08-14) — measured, not guessed

- **Cold load was 11 sequential Supabase round-trips**: a throwaway probe
  request plus 10 sequential pages of 1,000 rows. Now **2**: the first request
  probes, fetches page 1, AND asks `Prefer: count=exact` for the row total, and
  every remaining page is fetched concurrently. `Promise.all` preserves order,
  so the rows arrive in exactly the old sequence. Both fallbacks still work
  (no count header → sequential walk; missing signal columns → retry on the
  base field list) — all three paths verified against a stub.
- **Payload is 1.21 MB gzipped / 7.2 MB raw.** Half of the gzipped bytes is
  the `title` column alone (640 KB) and it is needed everywhere, so there is no
  big cut left. Dropped `views_to_followers` — fetched but read by nothing, 29 KB.
- **Client-side compute is not the problem**: at 9,016 rows, `buildPockets`
  6ms, `formatSaturation` 3ms, `buildPlays` 38ms, `clientSuggestions` 1.7ms.
- **Static assets are not the problem either**: 87 KB gzipped for the agency
  page, 90 KB creator, 37 KB landing.
- **Hosting is not the bottleneck — do not move off GitHub Pages for speed.**
  Pages serves the small static half from a CDN with gzip. The 1.21 MB comes
  from Supabase, so what matters is the Supabase project's region relative to
  whoever is loading it, not the static host.
- Still on the table, but each changes behaviour so none were done: caching the
  corpus in IndexedDB with revalidation (instant repeat loads, at the cost of
  showing stale rows briefly), or a server-side summary endpoint so the
  Database tab does not need all 9,016 rows client-side.

## Open — in the order I'd do them

**Done today, kept only as pointers:** client-matched video suggestions (the
whole "Suggested videos" machinery below) and the blueprint add-by-link form
(landed by a separate session in commits `242b8d1` / `6a7134a`; that session
has since been deleted, so `blueprintsBoxHtml` is uncontested again, and every
element id app.js looks up now resolves).

1. **Read the test-creator feedback — nothing in the agency app shows it.**
   Creators write to `lynxr_feedback` (`creator.js`) and the staff select
   policy already exists (`staff_gate.sql`), but `app.js` references the table
   **zero times**, so whatever they send is only visible in the Supabase
   dashboard. Front-end only, no SQL. This is first because the owner is
   waiting on exactly that feedback.
2. **Surface `lynxr_sources`** in the agency app, ranked by `tag_count` and
   recency — still the highest-leverage unbuilt thing, see THE POINT above.
   **Needs SQL first**: the table has no `authenticated` policies at all
   (service-role only, on purpose), so an `is_staff()` select policy has to go
   in via the Supabase SQL editor before any UI can read it.
3. **Blueprint covers for pasted Instagram videos.** Have
   `process_blueprints.py` keep a frame — it already downloads the media with
   yt-dlp to transcribe it — and upload it to `lynxr-covers` under
   `sha1(canon_url(url))[:20]`, the key both other pipelines already use.
   Everything downstream then works with no front-end change. See "Blueprint
   thumbnails" above for why the other three sources cannot cover this case.
4. **Backfill the 743 database rows with no cached cover**, and retry the 10
   that failed upload. `fetch_covers.py` then `upload_covers.py --limit N`.
   Current coverage: 989/1,335 Instagram, 6,299/6,692 TikTok, 972/976 YouTube.
5. Rest of the agency feedback: client fields (website, logo, description),
   a 4×4 video grid, briefs tagged by week, swap-a-video-in-a-brief (needs the
   grid), editable briefs (blueprints are done; briefs themselves are not).
6. **Send the launch email.** Draft at `~/Desktop/lynxr-launch-email.md`.
   Blocked on: linking the word "unsubscribe" to `{{{RESEND_UNSUBSCRIBE_URL}}}`
   (three braces, in the URL field) and verifying `send.lynxr.io` DNS.
   Resend's composer is a VISUAL editor — pasted markdown stays literal.

### Two open questions for the owner

- **The New Client tab survived, deliberately.** The brief flow no longer
  routes through it (that was the "nonsensical page"), but it is still the only
  way to onboard a brand-new client from a website. If client creation moves
  onto the Clients tab, the whole tab — site lookup, its own video shelf, the
  10-video cart, `renderBrief`/`renderShelf`/`buildShelf`/`buildPlays` — can go.
  That is a big deletion; ask before doing it.
- **Suggestion cards are ~766px tall** because the frame is the video's own
  9:16 and the same height whether or not it is playing, so hitting play never
  reflows the grid. The owner asked for both "not cut off" and "no jump"; this
  is the trade that satisfies both. A shorter card means the player clips or
  the grid moves.

---

## Hard-won, do not rediscover

- **`creatorsonly/index.html` was destroyed and rebuilt from scratch on
  2026-08-18.** A backup copy collided on basename with `agencyonly/index.html`
  and overwrote it. The rebuild is verified — all **34 static element IDs**
  `creator.js` needs resolve — but if something obscure is missing from that
  page, this is why. Never back up two same-named files into one folder.
- **Cache stamps.** Every page carries `?v=YYYYMMDDx` on css/js. Bump on EVERY
  css/js change or browsers serve stale files. **Currently `20260820i`** — note
  it rolled past `z` on the 19th into the next day's letters, so carry on from
  `20260820j`.
  The HTML documents themselves are NOT stamped, so markup changes — including
  `<title>` — need a hard reload; bumping `?v=` does nothing for them. This
  costs an hour if you forget it: your own CSS edits appear not to apply.
- **Strict CSP, `style-src 'self'`.** No inline `style=""` — set via CSSOM.
  This once shipped invisible bar charts; verify painted pixels.
- **Never put `${...}` in a plain .html file.** It is JS template syntax and
  renders literally. Cost me three separate slips this session.
- **Flex basis, twice, opposite ways.** `flex: 1 1 0` squeezed "original
  scripts" onto two lines (zero basis ignores the text); `flex: 0 0 auto` then
  left dead space. `flex: 1 1 auto` + `nowrap` is the answer.
- **`.note` caps at `max-width: 70ch`.** Fine for prose, wrong for a footer
  rail — it silently stops a `space-between` row mid-page.
- **Re-render loses `<details>` open state.** Both apps have a `keepOpen`
  helper. In the Library a script card is nested inside its video entry, so
  reopening the card alone leaves it inside a collapsed parent — reopen both.
- **No `confirm()`** — browsers suppress repeats and it returns false instantly.
  Destructive actions use the two-click armed button (`armDelete`).
- **Tag one video per API request.** A batched design once returned a valid
  1-element array and silently tagged ~45% of rows.
- Repo is public. No secrets in files; the publishable key is public by design.
  **Never write a waitlist CSV inside the repo** — one `git add -A` publishes
  every address.
