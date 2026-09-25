# Lynxr — session handoff

Read this, then `README.md` for architecture. **Last updated 2026-09-24.** Start with the section right below the table.

Lynxr (lynxr.io) is a format-intelligence platform for Lynx Media Group, a
short-form video agency. Static site on GitHub Pages + Supabase + a Python
pipeline. Three surfaces, one stylesheet (`app.css`):

| path | file | who |
|---|---|---|
| `/` | `index.html` + `site.js` + `creator.js` | public landing when signed out; the creator app when signed in |
| `/waitlist/` | `waitlist/` | retired funnel page (light theme via `data-theme`) |
| `/faq/` | static + `FAQPage` JSON-LD | public — the SEO/GEO page |
| `/privacy/` `/terms/` `/accessibility/` | static | public — the legal set, linked from every footer |
| `/creatorsonly/` | `forward.js` | retired 2026-09-15: forwards to `/` with query and #fragment intact |
| `/agencyonly/` | `app.js` | staff — database, briefs, clients |

`site.js` carries the shared chrome (floating bar, mobile menu, smooth scroll)
on the **six public pages only** — never the two apps. `robots.txt` +
`sitemap.xml` cover the public set; **neither names
the two app paths, not even in a comment** — robots.txt is served to anyone, so
naming a path there publishes it.

---

## START HERE — state as of 2026-09-23 (late evening)

### THE STATE NOW. Read this and you can work; everything under "History" is how it got here.

**"COMING SOON" STAYS ABOVE ITS HEADLINE (2026-09-25).** A version with the pill to the right of "a coach for every level."
was built and verified (owner: "put this on the right side"), then withdrawn minutes later ("nevermind, just keep the
coming soon at the top"). Everything it touched is back as it was: stacked row, 22px phone headlines, pill first in the
intro. If it comes back: the pair needs 342px, a 393 phone row has 315, so the headline must drop to 20px on phones and
the row rule needs TWO classes (`.hx-row.hx-row-coach`) to beat the later `.hx-row { flex-direction: column }`.

**RIPPLING DOTS, A GREEN "COMING SOON", AND NO FOCUS RING ON TEXT FIELDS (2026-09-25, UNCOMMITTED, stamp now `202609233i`).**
- "have these ripple": `.hx-rule` now holds three `<i>` (index.html); each lifts and sends a soft same-colour ring,
  180ms apart, under a second of a 3.6s cycle. `hx-ripple-dot` / `hx-ripple-ring`; none under reduced motion.
- THE PANEL WRITES ITSELF TOP TO BOTTOM (stamp `202609233i`). Owner: "have the ripple start on the load", then "have
  everything load from top to bottom, like lynxr is wriitng the landing page", then "i mean just in this box". So ONLY
  the panel animates (headline, subline and the desktop sign-up card are on screen from frame 0, untouched): coach row
  .45s (headline types .45–.80, "learn more" .80) → the dots are written at 1.08s and ripple as they land (ripple delays
  1.1/1.28/1.46s, the same with or without the intro) → script headline types 1.30–1.62 → paste box 1.62 → the phone's
  "new here" row 1.9s. Buddy: whistle from 0, pencil 1.06–1.9s, idle; `hxEnd` at 2.3s. A brief top-to-bottom version
  that also typed the page headline and subline was built and withdrawn within minutes. Verified in real-time captures
  at 1440 and 393: order correct, no box moves, `csp violations: []`.
- "make these green": `.hx-pill-soon` uses the removed live pill's pair (`--hx-live-t` / `--hx-live-bg`).
- "get rid of this input field highlight effect for everyhing": ONE block at the very END of app.css (read its comment)
  — `outline: none !important; border-color: var(--line-2) !important` on focused text-like inputs, textareas and
  selects, plus `.composer-row` / `.wait-form` focus-within. Buttons, links, checkboxes, radios, range and the file-drop
  zone KEEP their keyboard ring (accessibility; the caret marks a text field). !important is deliberate: ~20 earlier
  rules re-add the ring per field. KEEP THAT SELECTOR ON ONE LINE — the first version wrapped between two `:not()`s,
  which is a descendant combinator, and matched nothing. Verified: landing card email, paste box, gate email and the
  agency sign-in email all focus with no outline and the neutral edge; a keyboard-focused button still shows the ring.

**THE PANEL'S DIVIDER IS THREE BRAND DOTS; NO "LIVE NOW" PILL (2026-09-25, UNCOMMITTED, stamp now `202609233f`).** Owner: "you
can get rid of this" (the `live now` pill — markup removed from index.html; the coach keeps `coming soon`), then "find a
more creative way to replace the horizonatal line" → five mockups → picked E. `.hx-rule` is now a 46×8 box painting
three radial-gradient dots (`--hx-dot-a/b/c`: the avatar's violet, pink, peach), centred with auto margins at every
width (the two phone-only side-margin rules were removed). No markup change for the dots; the intro's `hx-fade` at 1.3s
still reveals them. Verified at 1440 and 393 (panel centred, phone gaps unchanged, sign-up link opens the gate, CSP clean).
Also new (not in the repo): a SessionStart hook in `.claude/settings.local.json` injects the owner's standing request —
every session adds the next SEO/GEO blog piece — see `~/.claude/plans/lynxr-seo-session-routine.md`.

**LIVE CHECK OF `802b106` (2026-09-25).** Pushed by the owner; GitHub Pages, secret scan and stamp check all green.
Checked in the safe order (HTML with a unique `?cb=` until it showed `202609233b` — ~60 s — and only then any `?v=`
asset): app.js, creator.js, app.css and home.js on lynxr.io are byte-identical to the commit; no stale Cloudflare copy.
The phone landing re-measured on lynxr.io itself matched the local build exactly (53/80px gaps, link opens the gate,
`csp violations: []`), and the desktop hero geometry is unchanged. The campaign-library, beats, PDF and rename features
are live code but were verified only against stubbed data — the signed-in checks in their entries below are still the
owner's. `supabase/brief_file_beats.sql` is committed AND applied (anonymous probe: its RPC answers 401, not 404).

**PHONE LANDING: LESS DEAD SPACE, AND A QUIET SIGN-UP LINK (2026-09-25, PUSHED in `802b106`, live-verified 2026-09-25, stamp `202609233b`).** Owner, on a
phone screenshot: "it looks cluttered but also blank space where it isnt needed", after picking mockup "L" for a phone
sign-up ("a quiet link under the paste box") from three rounds of mockups (the full card, then minimal versions, all
"too cluttered"). Built exactly as the approved mockup "with the two bigger gaps" (≤640px only): the hero no longer holds
the whole fold (`min-height: 0; align-content: start` — that "same space above and below" rule is REOPENED and noted in
app.css), 52px under the bar, 80px from the panel to "free to start"; the panel's empty ~120px band under the paste box
is now one row — `p.hx-new` "new here? create your free account" (a `[data-gate="up"]` link; `display:none` above 640px,
where the .hxs card lives) left, a 64px buddy (was 96) right; `.lp-sec` padding 40px on phones; footer wordmark gap 18px.
Page is ~340px shorter. Verified headless at 393: gaps measured 53/80, link and buddy centred on each other, no overlap,
no sideways scroll; the link opens the real gate in sign-up mode; the intro still types with the row steady from frame 0;
scrolled screenshots show NO seam (the "hard edge" in the mockups was a full-page-capture artifact: body::before is a
FIXED 100vh backdrop, painted once at the top of a captureBeyondViewport shot); desktop 1440 geometry identical to a
before-capture (hero, h1, .hxs card, panel, buddy, pricing, page height); `csp violations: []`.

**A CAMPAIGN RENAME REACHES CREATORS WHO ALREADY HAVE IT (2026-09-25, PUSHED in `802b106`, live-verified 2026-09-25; stamp now `202609233b`).** Owner: "when i
change the name of brief, have it change on the creator side that has the brief as well even if it was already sent
out". Sent briefs are snapshots that move only on Update; the NAME is now the one exception. After the rename saves,
`agRenameSent()` (app.js, beside `agSentFor`) re-reads this source's sent rows and PATCHes each one's `title` column (the
creator's list, via `my_agency()`) and `doc.title` (the brief page, via `my_agency_brief()`) — nothing else in the doc, so
unsent edits stay unsent and `sent_at` ("their version is from") is untouched. RLS already allowed it ("staff update
agency briefs"). The Sent to list is then re-read so a rename alone never reads as "edited since they got it"; that
repaint waits while an editor is open. Verified headless against a stubbed database: no other edits → both titles change,
instructions and sent_at unchanged, list stays "up to date"; an unsent requirements edit → only the name went out and the
list still says they have the older version; a failed write → a sticky "creators still see the old name — press Update"
message. Legacy picked-video briefs have no rename, so they are untouched. bf-keep regression still passes.

**DOWNLOAD PDF IS BACK ON THE CAMPAIGN BRIEF (2026-09-25, PUSHED in `802b106`, live-verified 2026-09-25; stamp now `202609233b`).** Owner: "bring back the
download as pdf option". It left with "Copy brief" in `5cc5260` (2026-09-23, owner: "remove this" — both); only Download
PDF returns, restored exactly as it was: the `#cb-pdf` `.btn` in the campaign head (after "Copy to new brief"),
`cbPdfTitle` + `cbSavePdf` in app.js (print a detached `#cb-print` of `campaignDocHtml` — done formats only, no
agency-only field), the `@page cb-brief` / `body.cb-printing` print rules and both `.cb-pdf-btn` sizes in app.css. It is
disabled until a format is ready, like Send and Copy to new brief. **Also fixed: the head's action row overflowed a
393px phone** once it held four actions — `.cb-export` was `flex: 0 0 auto`, so it stayed one max-content line; now
`flex: 0 1 auto; min-width: 0; max-width: 100%`, and the buttons wrap under the title on a phone (desktop unchanged, one
row). Verified headless at 1440 and 393: the real print path produced a PDF with the brief and none of the agency notes
(the stub campaign carried "AGENCY" markers in internal_note / internal_notes — absent), the filename title strips
`/ : ?`, afterprint restores the page; the file-erase regression suite (scratchpad `bf-keep.mjs`, recreated after a
scratchpad reset) passes at both widths on top of the library build; `csp violations: []`.

**FORMAT LIBRARY + COPY TO NEW BRIEF (2026-09-25, plan `~/.claude/plans/campaign-format-library.md`,
UNCOMMITTED).**
- The campaign brief view has a "Format library" island, between "agency only" and the formats. It lists every
  READY format of the client's other campaign briefs, grouped by brief.
- "Add" and "Add all N" insert COPIES born `status: "done"`, carrying the same source/analysis/script/edits.
  The worker never claims them: no model call, $0.
- "Copy to new brief" (head) starts the next brief, named with the next number, with every ready format, file,
  file-on-beat placement and the requirements.
- Files are copied server-side to NEW paths, never shared, because `bfRemove` deletes bytes.
- Placements (`lynxr_brief_file_beats`) are re-created on the copied file rows and new format ids, with the same
  beat and fingerprints. They are skipped quietly until `supabase/brief_file_beats.sql` is run.
- Legacy picked-video briefs are excluded (no stored breakdown).
- No SQL of its own. Stamp `202609232y` + `404.html`.
- Fix found and made during verification: `cbCopyToNewBrief` now `await agEnsureSent("campaign", nid)` before
  its own `renderBriefs()` — on a brand-new campaign id, `renderCampaignView`'s own (pre-existing) call to
  `agEnsureSent` was still in flight, and its completion unconditionally called `renderBriefsKeepScroll()`,
  wiping this function's own result message a few hundred ms after it was set. Pre-warming the cache makes that
  in-view call a no-op hit.
- Verified: Appendix A (this plan's own harness) at 1440 and 393, `csp violations: []`, every line matching the
  plan's expected output including the result message. Regression: the beats plan's own Appendix A
  (`~/.claude/plans/brief-files-at-beats.md`) re-run clean at both widths as a stand-in for the scratchpad
  `bf-keep.mjs` harness, which did not survive a scratchpad reset between sessions — `headSurvived`/`cardSurvived`/
  `panelSurvived` all `true` throughout, `csp violations: []`.
- NOT verified: a signed-in run on lynxr.io (owner checks in the plan).

**FILES ON BEATS — built, NOT live until the owner runs `supabase/brief_file_beats.sql` BEFORE pushing (2026-09-25).**
Plan: `~/.claude/plans/brief-files-at-beats.md`. Owner: "add a component to the briefs where the files that I would
drop in can be placed at a certain beat". AGENCY: once a brief has files, every beat of an open script (campaign
cards; the expanded script of a legacy brief) ends in a quiet "+ add file" that opens in place into the brief's files;
a pick pins that file to the beat as a chip (× takes it off in one click; the file stays). The files block says where
each file sits ("on format 1 · beat 1"). CREATOR: that beat gains an "add" line with a download button per file, same
download path as "files from lynx". MODEL: `lynxr_brief_file_beats` (file_id cascades with the file; format_id = the
sent doc's format id; beat index + up to 4 word fingerprints `sigs`), staff-only RLS; creators read
`my_agency_brief_file_beats(p_id)` with `my_agency_brief()`'s gates. LIVE like the files, no re-send. A placement
follows its beat's words through added/deleted beats; a reworded, deleted or regenerated beat flags it "beat changed"
for staff (Keep here re-anchors and keeps the old fingerprint so older copies still match) and takes it off the
creator's beats (still in their list). Decisions made without the owner (plan's A1–A9): not carried into "Add to my
library"; × is one click, not armed; not in the export, copy-script, teleprompter or tiles. Before the SQL runs the
agency files block says to run it and no beat gets a control; creators see nothing new. Files:
`supabase/brief_file_beats.sql` (NEW, untracked — include it in the commit), `app.js`, `creator.js`, `app.css`,
stamp `202609232x` on every stamped page + `404.html`. Executor-verified: Appendix A and Appendix B both ran clean at
1440×900 (desktop) and 393×852 (phone, CDP device emulation), every printed line matching the plan's expected output
exactly (helpers, sig, setup/A–K for the agency run; helpers, sig, A–H for the creator run), with `csp violations: []`
in all four runs. NOT verified: the SQL applied, a real placement, a real signed-in download, the isolation check —
owner checks in the plan's Verification section.

**FILE ACTIONS NO LONGER ERASE OPEN EDITS (2026-09-25, PUSHED in `da1e30e`; the stamp re-bump past the poisoned `v` shipped in `802b106` — see the Cloudflare note below).** Owner: "When I add a
file into briefs, all the edits I make on the previous parts get erased." Every file action in the agency app (the
list arriving, an upload starting and finishing, a remove, a retry) called the brief viewer's whole-page repaint, and
a repaint rebuilds every editor from its SAVED value — an open "Campaign requirements" field, the rename box, a
format's edit form, a legacy script line. The campaign poll already refused to repaint over an open editor
(`cbEditorBusy`); the files code skipped that guard. Now `bfRepaint(kind, sourceId)` in app.js redraws ONLY the files
block (found by its `data-bf-key`) and `bfWire` re-binds that one copy; `bfBind(host, kind, sourceId)` no longer takes
the viewer's repaint, and the retry button starts its own reload. Verified in headless Brave against the real CSP, at
1440 and 393: with the pre-fix app.js served in its place the same script lost the typed requirements text and the
unsaved rename on the first drop; with the fix, typed text survived mid-upload, after upload, a second drop (proves the
re-bind), a remove and a failed-list retry; the rename survived an upload; on a legacy brief the open Send panel, its
tick and the expanded script were the SAME DOM nodes after an upload; `csp violations: []`. Harness:
scratchpad `bf-keep.mjs` (never committed). Files: `app.js`, the stamp on every page + `404.html`, this file.

**CAMPAIGN SENDS NOW CARRY THE CLIP (2026-09-25, PUSHED in `802b106`).** `agencySendDoc` read `f.source.clip`,
but a loaded campaign format has no `source` — `CB_FULL` selects it as top-level `clip` / `cover` aliases — so every
campaign brief went out without its clip and creators waited ~1 min for `pipeline/brief_clips.py` to fill it in.
It now reads `f.clip` / `f.cover` first, `f.source` as fallback. Verified in the real page: a loaded-shape format
carries both, the nested shape still does, nothing else leaks, no clip means no key, `agDocSig` still ignores clips;
live `lynxr_campaign_formats` rows (4, all `done`) return clip + cover through those exact aliases (read-only probe).

**CLOUDFLARE CACHES A STAMPED ASSET FETCHED BEFORE THE DEPLOY LANDS (2026-09-25).** lynxr.io is proxied by
Cloudflare (`server: cloudflare`, `cf-cache-status`), which caches .js/.css with `max-age=14400` (4 h). Checking the
`da1e30e` push, `https://lynxr.io/app.js?v=202609232v` was requested ~25 s after the push, while GitHub Pages still
served the previous build — Cloudflare's BOS edge stored the OLD app.js under the NEW stamp (`cf-cache-status: HIT`,
`last-modified` of the old build). Pages then deployed correctly, but anyone routed through that edge would get the
pre-fix agency code for hours. Recovery: stamp bumped `v` → `w` (never requested anywhere), owner pushes again.
**Rule: after a push, first poll an HTML page with a unique `?cb=` until it shows the new stamp; only then request
any `?v=` asset URL.** A Cloudflare purge of the URL would also work, but the stamp bump needs no dashboard.

**AGENCY BRIEFS = THE REGULAR SCRIPT VIEW WITH LYNXR'S OWN PLAYER; FILES ATTACH INSIDE THE SEND PANEL
(2026-09-24, plan `~/.claude/plans/agency-brief-regular-ui.md`, UNCOMMITTED).** Owner: "have it be the regular ui
pretty much, make the video on the right side and make sure the agency side can add the files when the briefs
are sent", then "make the videos the way it is on the actual user side, like native to lynxr". CREATOR SIDE
(`creator.js` `lynxFormatCardHtml` / `lynxRefPanelHtml` / `renderLynxBrief` / `bindLynxBriefButtons` /
`lynxWatchClips`): a brief's formats are the creator's own script cards — `.script-grid` tiles with covers, one
open at a time (a single format opens itself), each opening into `.ref-split` with "The original" playing the
SELF-HOSTED clip in `refPlayHtml`'s native player (controls, playhead-follow, click-a-beat-to-seek, phone
mini-player via `wireAdaptationCards`) — RIGHT of the script at >=1180px, ABOVE it below. No embeds: the
TikTok/Instagram iframes, `lynxEmbedFor`, the logos and `index.html`'s `frame-src` are GONE. A format with no clip
yet says "Getting the video ready" (the page re-checks every 30s for 10 min); one that can never have a clip
shows the regular "This one can only be watched on TikTok" panel. "Add to my library" now copies the clip too.
CLIPS: the sent doc carries `clip`/`cover` (public lynxr-clips / lynxr-covers objects, `sha1(canon_url)[:20]`);
`agencySendDoc` copies them from campaign formats (which always had them), and the NEW Fly-worker lane
`pipeline/brief_clips.py` (idle-only, every 60s, `BRIEF_CLIPS=0` turns it off) fills them for any SENT format
without one — HEAD-reuses an existing object first, else yt-dlp + ffmpeg ($0, no Apify), gives up to
`clip_state:"failed"` on private/deleted/unsupported links — never touching `lynxr_videos`. `agDocSig` ignores
the clip keys and `agStampDoc` carries them over, so a clip arriving never reads as an edit. AGENCY SIDE: while
"Send to creators" is open the files block renders INSIDE the panel ("Files that go with it", one copy,
`cbSendShowsFiles`); ticks survive the repaint an upload causes (`CB_SEND_PICKS`) — before this, dropping a file
unticked everyone; a send says "Sent to N creators with N files." No SQL, no new secrets, no Fly config. Stamp
`202609232t` + `404.html`. Verified: Appendix A and B, both run at desktop (1440) and phone (393) widths against
the real CSP, every printed line matched the plan's expected output exactly (including `B`'s and `K`'s panel/main
numbers being identical, proving the brief card is the same UI as a creator's own script card), and
`csp violations: []` at every run; `pipeline/test_brief_clips.py` printed only `ok` lines and `ALL OK`;
`pipeline/brief_clips.py --dry-run` against live data listed exactly the 4 formats of the two live briefs
(`568fed81`, `f5afc538`) as `reuse`, with the unsent legacy brief `f1054b43` absent, then `4 format(s) waiting`.
NOT verified: the lane running on Fly, a real download, a signed-in brief on lynxr.io (owner checks in the plan).
CORRECTION to the BRIEF FILES paragraph below: that code was already LIVE — lynxr.io's `app.js`/`creator.js` were
byte-identical to HEAD `46cddae` on 2026-09-24.

**BRIEF FILES — built, NOT live until the owner runs `supabase/brief_files.sql` (2026-09-23).** Plan:
`~/.claude/plans/brief-file-attachments.md`. Staff attach logos, fonts and brand guides to a brief in the agency app — a
"Files for creators" block with a drop zone on BOTH brief viewers (campaign: under "Campaign requirements"; legacy:
under the send panel) — and every creator the brief is delivered to gets a "files from lynx" list on the brief page
with a Download per file. Files belong to the brief's SOURCE (`source_kind` + `source_id`, the pair `agSend` records),
not the sent snapshot: a file added before or after sending reaches creators with no re-send, and unsend / leaving the
roster cut the files off with the brief. Bytes: PRIVATE bucket `lynxr-brief-files`. List: `lynxr_brief_files`
(staff-only RLS). Creators list via `my_agency_brief_files(p_id)` and download with their own token through a storage
SELECT policy that calls `brief_file_readable(name)` — enforced in the database. Limits: 25 MB a file (bucket), 20 files
/ 50 MB a brief (trigger), png jpg webp gif svg pdf zip otf ttf woff woff2 (bucket), mirrored as `BF_*` in app.js. No
CSP change was needed. Files: `supabase/brief_files.sql` (NEW, untracked — include it in the commit), `app.js`,
`creator.js`, `app.css`, stamp `202609232k` on every stamped page + `404.html`. Executor-verified: Appendix A (agency
harness) steps A–G and Appendix B (creator harness) steps A–F, each run at both desktop and phone widths, matched the
plan's expected output line for line with `csp violations: []` in all four runs — including the upload/remove flow,
the drop-zone focus ring, type/size/empty refusals, the drag-elsewhere guard, and the campaign-view placement between
"Campaign requirements" and "agency only" on the agency side, and the RPC pair, the real download (blob + `<a
download>`, saved bytes verified), the "Object not found" message, the bad-path guard, and the empty/error states on
the creator side. One deviation, not a regression: Appendix A step C's stray-file refusal showed 3 POSTs instead of the
plan's expected 0 — traced to `POST /rest/v1/rpc/roster_accounts` fired by `rostLoad()` from the roster-invite-by-email
work that landed in the tree today; zero brief-files POST/PUT occurred for the three rejected files. Painted pixels
checked in four screenshots (agency brief + campaign, desktop + phone) and two more (creator brief, desktop + phone):
islands match their neighbours, the dashed zone reads correctly, long names ellipsize on phone, Remove/Download buttons
align, nothing is cut off. NOT verified (needs the SQL and two sign-ins): a real upload, a real download, the isolation
proof — the plan's Verification section, owner checks 1–7. **SQL APPLIED by the owner later on 2026-09-23** — confirmed from outside with anonymous probes: `lynxr_brief_files` and `rpc/my_agency_brief_files` → 42501 (exist, denied), bucket `lynxr-brief-files` exists (a missing object says "Object not found", a made-up bucket says "Bucket not found"), anonymous list → `[]`. Left: push, then the live attach/download/isolation checks.

**ROSTER INVITES ARE BY EMAIL — NO JOIN CODE (2026-09-23, plan `~/.claude/plans/roster-invite-by-email.md`).**
Staff type the creator's email on the agency app's Creators tab, plus an optional name, an optional **campaign**
(e.g. "Cloey", suggested from client names, CREATOR-FACING) and an agency-only note. Whoever signs in to lynxr with
that CONFIRMED address gets a popup on every page load until they act — "Lynx Media Group invited you to the Cloey
campaign." (nothing typed: "…to their creator roster.") — with Accept / Not now; `#nav-lynx` keeps the same invite
with an Accept button. Each Creators row says whether that email has a lynxr account yet (staff-only
`roster_accounts()`). **SQL: `supabase/roster_invite_by_email.sql` — the owner must run it BEFORE pushing** (the
Creators tab reads `campaign`; the new accept takes no code). Status: NOT YET APPLIED, NOT YET PUSHED.
**This rests on Supabase's "Confirm email" staying ON** (`mailer_autoconfirm: false`, checked 2026-09-23 via
`/auth/v1/settings`). With it off, anyone could sign up as an invited address and take the seat.
`invites.sql`'s "autoconfirm can stay on" does NOT apply to the roster. The `code` column and `leave_agency()`
still exist; nothing calls them. lynxr sends no invite email.

**AGENCY BRIEFS PLAY THE ORIGINAL IN PLACE (2026-09-23, UNCOMMITTED).** Owner: "have the actual video pop up, not
just the link". Each format card on a creator's brief page (`lynxFormatCardHtml`, creator.js) now paints the
platform's own player in "the original": TikTok `player/v1/<id>?rel=0` (video only, no autoplay) and Instagram
`/p/<code>/embed/`, built by `lynxEmbedFor()` from `source_url` alone. Nothing was added to the brief doc.
`index.html`'s CSP gained `frame-src https://www.tiktok.com https://www.instagram.com` (that page only; the
creator's own scripts still play the self-hosted clip, no iframe). Short links (vm./vt./`/t/`) and YouTube keep
the link-only card; under a player the platform's mark is the link out (owner: "just add the logos"; the
button and URL stay only where nothing can play); closing a card destroys its player so the
audio stops. Files: `creator.js`, `app.css`, `index.html`, every stamped page + `404.html` (stamp `202609232g`,
unchanged by this work — `check_stamp.py` already read `ok` at that stamp before this change, from an earlier
uncommitted edit this same session; it still reads `ok` after). Verified: steps 5 and 7 of the plan both passed —
a headless-Brave harness against the real CSP showed both frame origins refused before the change and admitted
after, on desktop and phone, with the TikTok player playing on click and destroyed on card collapse, no CSP
violations, and the screenshots opened and matched the expected layout. **Not yet seen signed in on a real brief,
and not yet on lynxr.io.**

**Where the tree is (re-checked 2026-09-24, ~00:40).** `HEAD` is `46cddae` (owner, 2026-09-23 20:42, "a") — a
34-file commit that also carried another session's Supabase work (`brief_files.sql`, `roster_invite_by_email.sql`).
**That commit DROPPED the landing's plan-card CSS block** ("THE PLAN CARD, REFERENCE LAYOUT": icon size, tagline,
full-width action, the rule, the "plus" header, the check-mark bullets) while keeping the new card MARKUP — so the
live site served the new cards with the old round bullets, no card styling and no pro outline. The owner's iPhone
screenshot caught it; Safari on the Mac reproduced it with the same stylesheet, so it was never a WebKit
difference. `git log -S` shows the block added in `9a72c1a` (13:23) and removed in `46cddae` (20:42) — two
sessions committing into one working copy (and the repo lives in iCloud, see memory) is the likely mechanism.
**RESTORED on 2026-09-24 in the working tree; stamp now `202609232s`** (the owner's later commits had already taken
it to `m`; several bumps followed while iterating). UNCOMMITTED: `app.css`, `home.js`, `index.html`, the 26 stamped
pages, `404.html`, this file.
**And a real WebKit bug, fixed the same night:** the pro card's gradient ring (`.lp-plan-pro::before`, the masked-ring
technique) never painted in Safari — iPhone or Mac — because the `-webkit-mask` shorthand carried `var(--mask-solid)`;
with the var() form WebKit resolved a mask that hid the whole pseudo-element, Chromium was fine. All four ring rules
that used that two-line form now use literal `linear-gradient(#000 0 0)` layers plus an unprefixed `mask:`; verified
in Safari on the Mac (ring visible) and Chromium (unchanged). No `var(--mask-solid)` usage remains in a mask shorthand (the token itself still exists; only comments mention
it) — if any masked element is ever missing on an iPhone, a `var()` inside `-webkit-mask` is the first suspect.
Also true now, in every engine: the plan card's mark sits BESIDE the name (icon + name/tagline row), which is how the
20:42 commit's surviving rules lay it out — not the stacked form of the 23rd, and not a bug.
Everything else from the 23rd survived `46cddae` — checked marker by marker: footer/plan phone measure, white Google
button, `#nav-lynx[hidden]`, learn-more pill, no hover grow, week strip, no `.rk`, no `hx-write`, the headline.
**Do a real-phone check of /#pricing after the next deploy** — that is the surface that regressed.
**The landing (`index.html`, `home.js`, `avatar.js`, `app.css` under `body.home`).** Three sections: hero → pricing →
closing CTA, then the footer. The stage picker is GONE from here.
- **Hero** (`section.hx`). Left column, centred: `h1#hx-buddy-h` **"what's next, creator?"** (one line at every desktop
  width; composition 540 + 80 + 540 inside the bar's 1200 column, h1 capped at 50px), `p.hx-sub` **"your content creation
  buddy"**, then the glass **sign-up card `.hxs`** (desktop only — `display: none` ≤640px): white Google button (Google's
  own light spec, the one non-ink action) → mono "or" → email → ink "continue with email" → terms/privacy consent line →
  "already have one? sign in". The card does NO auth: every control opens the real `#gate` via `data-gate` ("up"/"in")
  and carries the typed email into `#email`; **the Google button ticks `#agree` and clicks the gate's `#oauth-google`**
  (owner: the card's consent line IS the agreement). Right column: ONE glass `.hx-panel` (`--gl-*`, identical to the
  signed-in pane's `.me-card`): `coming soon` pill + **"a coach for every level."** (2026-09-24, owner: show it coaches all levels; replaced "a coach
  that's all about you."; longer lines such as "a coach from first post to full-time." wrap to two lines on a 393px
  phone, and "…to pro" collides with the pro plan name) + ink **"learn more →"** to
  `/how-it-works/coach/` / hairline / "paste a link. get your script." (its `live now` pill REMOVED 2026-09-25, owner: "you can get rid of this"; the coach keeps `coming soon`) + the LIVE composer
  (`form#lp-composer-form[data-hero]`, `#lp-composer-url` — creator.js wires it) / **the buddy avatar (`.hx-seam`) at
  rest in the panel's bottom band, right-aligned** (180px desktop, 96px phone). No kicker, no lede, no fine print, no
  "your coach · preview" label, no speech bubble — all removed by the owner. Phone: headline → subline → panel.
- **Intro** (`home.js` `armHeroIntro`, snap at 2.0s): whistle in hand + `coaching` → panel and coach row rise in →
  pencil + `writing` → hairline and script row → props down, `idle`, `hx-anim` off. **Both props on the top-left arm
  `.lx-a0` at every width.** Plays on EVERY load (no session gate); skips under reduced motion and in a background
  tab; the composer is live from frame 0 and any touch of `.hx` snaps to the finished state; default CSS is the finished
  hero (no-JS safe); zero layout shift. The buddy does NOT move (a moving version was built and reverted).
  **The two panel headlines TYPE OUT** (2026-09-24, owner: "make it more like typed out"): `armHeroIntro` splits each
  `.hx-h2` into per-character `.hx-ch` spans (createElement, aria-label on the h2, spans aria-hidden, per-span delay via
  CSSOM) — coach line .45–.80s, script line 1.30–1.62s — and a 2px caret (each span's `::after`, lit for its own slot)
  walks behind the text. Each row's action waits for its line (learn more at .80s, composer at 1.62s), so the snap moved
  1800 → 2000ms. **The keying is `1ms linear`, NOT `steps(1)`**: Chrome finishes a 1ms animation delayed past ~1s at
  progress 0.9999…, which a step rounds to 0 — the whole script line stayed invisible while its caret walked (measured;
  the coach line, under 1s, was fine). Verified by page-side sampling at 393 and frames at 1440/393.
- **Pricing** (`#pricing`): three `.lp-plan` cards in the reference layout — live avatar mark (idle / writing /
  coaching) → name → tagline → price → note → full-width ink action → "no commitment · cancel any time" → rule →
  "everything in X, plus:" → checked list. Pro keeps its gradient outline. Numbers mirror `lynxr_billing_plans`
  (free 3/7d, pro $24.99 150/30d + 30/24h, max $74.99 not on sale). Phone: cards and the footer card sit on the hero
  panel's measure (x=20, w=353 at 393).
- **Buttons, site-wide rule:** every action is the ink `.btn` pill (bar "get started" included — no white override,
  no rocket emoji anywhere; the `.rk` rules are gone); text links stay text; no hover grow (`:active` press stays).
  Exception by the owner's word: Google provider buttons stay white.
- **Bar:** "how it works" and "faq" only ("pricing" removed from the landing's bar and phone menu; the footer link
  and the other pages' bars still carry it).

**/how-it-works/ and /how-it-works/coach/ (`body.lp.hiw`, `picker.js`, `app.css` under `body.hiw`).** Each opens on
`section.hs#how` — "for any creator, at any stage" is the page's `<h1>`; the old opening block is gone. Desktop: the
four stages in a row, PAGE-scroll-driven (`.hs-live`, sticky `.lp-in`, ~353px of scroll per stage, 0px blank
lead-in); phone: a vertical column, same mechanism, the card slots 8px under whichever row is lit (`display:
contents` + `order`, `nth-of-type`). Card and lit row wear the `--gl-*` glass. Stage actions: 1 **"paste a link →"**
to `/` (no creator.js there) · 2 "build a library of winners." + library strip · 3 week strip (a METAPHOR — no
scheduler exists; copy claims none) · 4 "see pro →" `/pricing/` + "about the coach →". `--hs-inh` 495 desktop / 585
phone. The `scripts | coach` switch and, on the coach page, the "coming soon · lynxr max" pill were kept above it.

**Agency app header (`agencyonly/index.html:69-99`).** Capped to the landing's 1200px column (`main` + footer widened
1132 → 1200 with it — the Database table at 1200 is UNVERIFIED, no staff sign-in). Lockup: Lynx Media Group mark +
name in **Outfit 700** (THEIR brand font, self-hosted from `fonts/`, `@font-face` at `app.css:25-40`, never for
lynxr text) linking to lynxmediagroup.org in a new tab, "powered by ✸ lynxr" beneath (`#home-mark`, still the
button with its `app.js:352` handler). Marks-only under 760px.

**Bugs.** (1) FIXED AND LIVE (deployed with `9a72c1a`): `#nav-lynx` painted for every creator since the roster feature shipped
(`.side-link { display: flex }` beat `[hidden]`); fix `#nav-lynx[hidden] { display: none }`. The DB gate held. (2)
Pre-existing, untouched: `app.css` `.pane-body :is(.lookup, #brand-editor)` outranks the app's `--gl-*` glass rule.

**Owner decisions still open.** Proof artifact for the landing (the pilot pair on /how-it-works/ has no input-video
link); `how-it-works/index.html` still advertises the scraped corpus with a 5.19bn view count against the standing
decision; whether `/pricing/`'s cards and the app's Plan view should take the new card layout; whether the coach
page's switch/pill stay; unsend on an agency brief has never been exercised.

**Harness lessons (they cost real time today).** The HTML is not cache-stamped — load with `?cb=<n>` or the browser
serves stale markup against a new stylesheet. In the desktop app's browser pane `window.scrollTo` dispatches NO
scroll events — verify scroll-driven UI with real wheel/touch. A raw headless window narrower than ~500px lays out
wider than asked — capture phones under `Emulation.setDeviceMetricsOverride` (`scratchpad/cdp-rt.mjs`,
`cdp-full.mjs` in the session scratchpad did this). Two agents writing `app.css` at once lose work — serialize them.
Mockups of the eight landing directions (A–H) live on a private Design canvas:
https://claude.ai/artifact/KtXPTDgucXUSxvNwDUFHYH — the live hero has moved past H; iterate on the page, not the canvas.

---

### History of the 2026-09-22 → 23 batch (kept for the reasoning; superseded where it says so)


**LANDING + AGENCY HEADER BATCH (2026-09-22, evening) — ALL IN THE WORKING TREE, stamp `202609232e`, uncommitted.**
- **⚠ `picker.js` IS NEW AND UNTRACKED — `git add picker.js` before any commit or both how-it-works pages 404 on it.**
- **THE STAGE PICKER NO LONGER LIVES ON THE LANDING (owner, 2026-09-23: "put this section in the how it works
  section… no need for it on the main landing page… for both script and coach").** `section.hs#how` now tops
  BOTH `/how-it-works/` and `/how-it-works/coach/`, replacing each page's old opening block (avatar, eyebrow,
  "scripts built on videos that already work", subline); markup byte-identical on the two pages; JS split out of
  `home.js` into `picker.js`; every `.hs-*` rule re-scoped `body.home` → `body.hiw`. Stage 1's paste box became
  `paste a link →` to `/` (owner's choice — those pages don't load creator.js). Two hrefs had to change to stay
  valid there: "see one broken down →" → `/how-it-works/#hiw-ex`, "see pro →" → `/pricing/`. The `scripts | coach`
  switch was kept above the picker (it is the only nav between the two pages) and so was the coach page's
  `coming soon · lynxr max` pill — **owner to confirm both**. `--hs-inh` there: 495 desktop / 585 phone.
  The landing is now hero → pricing → closing CTA.
- **HERO v3 (owner, 2026-09-23, several rounds):** left column centred — `h1#hx-buddy-h` **"what's next, creator?"** (owner-picked, 2026-09-23, from a three-word-question
  brainstorm; before that "your second brain" — owner asked for three words; it briefly was "every creator's second brain", which needed a ≥1240px
  own-width override that made the panel non-monotonic — that override is REMOVED). For the question headline the
  composition was re-cut 540 + 80 + 540 (was 440 + 80 + 560) with the h1 capped at 50px, so it sits on one line from
  1280 up with no stepped breakpoint; the panel is 540 flat from 1280 up, `p.hx-sub` "your content creation buddy" under it, then a glass SIGN-UP CARD (`.hxs`): continue with Google → mono
  "or" → email → continue with email → terms/privacy consent line → "already have one? sign in". The card does NO
  auth itself: every control opens the real `#gate` (`data-gate` "up"/"in") and carries the typed email into `#email`;
  Enter never reloads. **The Google button goes STRAIGHT THROUGH** (owner, 2026-09-23: the card's "by continuing you
  agree to the terms and privacy policy" line IS the agreement — "it can go straight through as i say this in the
  screenshot"): home.js opens the gate, ticks `#agree` (+ change event) and clicks `#oauth-google`, i.e. the real
  oauthStart(). It first focused rather than clicked, pending exactly this decision. **The card is hidden ≤640px** (owner: "remove this on mobile"). Right column: ONE glass panel — coach row
  / hairline / script row with the live composer / **the buddy inside the panel's bottom band** (owner: "put lynxr
  inside the box with the info above it"); the speech-bubble tail idea was dropped with that. Fine print, kicker,
  lede all gone, and the coach row's "your coach · preview" label with its 22px avatar too (owner, 2026-09-23); the coach
  preview bubble became a `learn more →` ghost pill to `/how-it-works/coach/` (owner: "have this say learn more and
  then go to the how it works page"). Intro unchanged in beats (whistle → coach, pencil → script, 1.84s), every load, any touch snaps.
- **Limbs, final (owner: "put the pencil and whistle on the left top limb"):** BOTH props on `.lx-a0` (top-left)
  at every width; `whistle-lo` and the width-split media queries are DELETED; wave + wiggle ride `.lx-w0`; 0ms
  drift, 0 double-prop frames at both sizes.
- Dead tokens noticed: `--hx-card*` and `--hs-on-*` have no consumers in `app.css`; moved, not deleted.
- **A moving-buddy intro (start top-left, "write" along each row, land in the corner) was BUILT by an agent and
  then REVERTED by hand the same evening** on the owner's reversal ("just keep lynxr on the bottom corner with the
  animation before the row thing"). Nothing of it remains: no `@keyframes hx-write`, no `--hx-p*` properties, no
  `hxPath()`. The intro is the stationary one described in `home.js`'s beat comment.
- **ONE ACTION STYLE (owner, 2026-09-23: "make all action buttons the same color and style so people can recognize
  it easily"):** every action on the landing and both how-it-works pages is the ink `.btn` pill — the bar's
  "get started" lost its white outlined override, "learn more →", "try for free" and "about the coach →" lost
  `.ghost`, and the hero's "continue with Google" was made ink too — then put BACK to Google's white light button on the
  owner's word ("keep the google one the way it was"): the one deliberate exception. **The rocket emoji is gone
  from every "get started" on every page** (bar, phone menu, footer — 24 files, 72 instances; owner: "remove the emoji"), and the
  dead `.rk` rules with it. Text links stay text (sign in, the stage asides, the consent line). The app's own `#gate`
  Google button is untouched — product surface, Google's light spec.
- **Landing plan cards re-laid to the reference layout** (owner, 2026-09-23, a claude.ai pricing screenshot: "for the
  options have this be the same layout"): mark (live avatar, idle/writing/coaching) → name → tagline → price → note →
  full-width action → "no commitment · cancel any time" → rule → "everything in X, plus:" → checked list. Same facts,
  reordered; "cancel any time" moved from pro's bullet to its commitment line; pro gained the (true) 14-day
  money-back bullet from /pricing/. **/pricing/'s own cards use a different structure and were NOT changed** — owner
  to say if they should match.
- (Incident, fixed: the plan-card re-lay first cut the old list at the FIRST `</ul>` after it — the free card's inner
  list — so the old pro/max cards and a stray "try for free" survived below the new list and painted full-width. Caught
  on a full-page capture, removed at the exact 6-space `</ul>`. `index.html` now has exactly three `.lp-plan`.)
- **Buttons never grow on hover** (owner: "for buttons, no need to make them bigger") — the `scale(1.05)` hover on
  `.btn`/`.composer-send` is gone; the `:active` press-down stays.
- **STANDING STYLE RULE (owner, 2026-09-23): the gradient "rainbow" outline on the pro plan card (`/pricing/`) is
  the marker for the highlighted option — keep it the same on every similarly-featured thing; never a second style.**
- **Stamp note:** `20260923z` cannot roll; the batch went to `202609232a` (date + batch digit + letter, the
  precedent already in this file) and then `202609232b`.
- **Phone pricing cards match the hero panel's measure** (owner): `body.home .lp-plans { padding-inline: 10px }`
  under 640px — panel and cards both x=20 / w=353 at 393. Same for the footer card on the landing:
  `body.home #site-footer { margin-inline: 20px }` under 640px (the footer element IS the glass card).
Owner drove this live in one session; every item below was verified in painted pixels unless marked.
- **HERO REBUILT TO MOCKUP H (owner-approved, 2026-09-23): "one buddy for the whole job."** `index.html:355-430`,
  `app.css:10284-10490`, `home.js`, `avatar.js`. Left = the live avatar as the "content buddy" (~220px, SAME
  `.hx-seam` host, moved not recreated), kicker `lynxr · your content buddy`, `h1#hx-buddy-h`, one lede line.
  Right = ONE `.hx-panel` in the signed-in app's glass (`--gl-fill/--gl-blur/--gl-edge/--gl-shadow`, measured
  identical to `.pane-body .me-card`; `.bcard` is NOT glass, it is the flat list row): coach row on top
  (`coming soon` pill, preview bubble) / hairline / script row (`live now`, the composer moved intact, "3 free
  scripts a week. no card." — that fine print was later REMOVED, owner). `--hx-card*` tokens moved off `.hx`
  onto `.hs` only. **Intro re-sequenced**: whistle → coach row, then pencil → script row, 1.80s measured.
  **Limbs:** SUPERSEDED — see "Limbs, final" above (both props top-left, `.lx-a0`, the doubled whistle deleted). **Then the owner cut the kicker and the lede at
  ALL widths and renamed the h1 "your content creation buddy"** — the only remaining "not built yet" signal
  in the hero is the `coming soon` pill. Phone: headline → avatar (96px) → 18px gap → panel, NO overlap
  (owner: "dont have the logo cover the box"). Desktop: the two halves cluster on a 1080px composition
  (440 + 80 gap + 560) centred inside the bar's 1200 column (owner: "too spaced out"). A speech bubble
  ("hey, I'm lynxr!") was built and then removed on the owner's reversal — nothing of it remains.
  Dropped: the `about the coach →` link from the hero (H has none; still linked from the picker's stage 4 and
  /how-it-works/). Verified: no layout shift vs no-JS, composer at final rect at 43ms, reduced-motion skip,
  overflow 0 at 21 widths, other pages byte-identical. UNVERIFIED: `@supports not (backdrop-filter)` and
  `prefers-reduced-transparency` fallbacks (token chain only), real iOS Safari.
  **Pre-existing bug noticed, not touched:** `app.css:8317` `.pane-body :is(.lookup, #brand-editor)` has an id
  inside `:is()` so it outranks the app's `--gl-*` glass rule — those two cards silently miss the glass.
- **BUG FOUND 2026-09-23, FIXED IN THE TREE, NOT YET LIVE — the creator sidebar's "Lynx Media Group" item
  painted for EVERY creator since the feature shipped.** A brand-new, never-invited account
  (joenguyen41@gmail.com, created 02:17 UTC) saw it. Cause: `#nav-lynx` is `hidden` in the markup and
  creator.js sets `.hidden` from `my_agency()` correctly, but `.side-link { display: flex }` outranks the
  UA's `[hidden] { display: none }` — the same trap `app.css` already documents for `.field[hidden]`.
  The DATABASE gate held throughout: `my_agency()` returns `none` for a non-member (verified live), so a
  click showed nothing. Fix: `#nav-lynx[hidden] { display: none; }` (`app.css` beside the other
  `[hidden]` resets). Verified: computed `none` with the attribute, `flex` without. **Needs a push to reach
  lynxr.io** — until then every creator still sees the item.
- **Picker, later on 2026-09-23 (all verified at 393 and 1280):** (1) the week strip redrawn — posted days
  hold a tiny video, today holds the empty frame with an accent ring, future days are ghosts; two-letter day
  labels. (2) The card AND the lit stage row wear the hero panel's glass (`--gl-*`, owner: "use more of the
  glass morphism"). (3) PHONE ACCORDION: `.hs-row { display: contents }` under 640px so the four buttons and
  the card share one flex column, and the card's `order` (from `data-stage`) slots it 8px under whichever
  row is lit (owner: "the tab im looking at and the info underneath right next to each other"). Uses
  `nth-of-type`, NOT `nth-child` — the row's first child is the hidden track span, and nth-child put the
  last stage first once. (4) Tiles stack thumb-over-chip on phones so no chip truncates. (5) The pop-in of
  tiles/thumbs is keyed on `.hs-in`, which `paint()` removes/re-adds with a reflow; fill-mode BACKWARDS —
  with BOTH, elements that loaded inside a display:none parent sat at opacity 0 forever (measured).
  `--hs-inh` phone = 608px. (6) "pricing" removed from the landing bar and its phone menu (owner); the
  other public pages' bars still carry it, and the footer link stays.
- **Stage visuals (owner, 2026-09-23): stage 2 = "build a library of winners." with a LIBRARY STRIP** (three
  saved-video tiles with format chips: storytime / question hook / two-column) **in place of the composer;
  stage 3 = a WEEK STRIP** (m–s cells, three done, today lit) in place of the composer — a metaphor for
  posting consistently, `aria-hidden`, and the copy deliberately says nothing about a scheduler because
  lynxr has none. Both sit in the composer's 54px slot so the pinned block does not jump. The card's four
  actions are now: 1 paste box, 2 library strip, 3 week strip, 4 the pro/coach links.
- **Stage card carries the composer, and its action follows the stage** (owner, 2026-09-22, from mockup C
  then "have this change for each stage"): `#hs-card[data-stage]`, a third `form[data-hero]` (creator.js
  wires it — proven: an empty submit wrote its note), placeholders from each button's `data-ph`, one
  `.hs-aside` per stage, and stage 4 swaps the composer for "see pro →" / "about the coach →" at the same
  height so the pinned block does not jump. `--hs-inh` re-measured: 494px desktop, 616px phone.
- **The intro now plays on EVERY load** (owner: "everytime on reload") — the sessionStorage gate is
  removed from `home.js`; reduced-motion and background-tab skips remain. Any touch of the hero still
  ends it instantly.
- **Hero fills the fold** (`app.css` `body.home .hx`): `min-height: max(480px, calc(100svh - var(--hx-bar-h)))`,
  `--hx-bar-h` 55px / 67px under 760px; half padding equalised 56/56. Measured 305px above and below the content at
  1920×1000 — the owner's "same gap from the bar and the next section".
- **Phone hero** (≤640 block): write half full-bleed at 38px, coach becomes an inset 28px-radius panel at 24px. Found and
  fixed a LIVE iOS bug on the way: the paste field measured 14.06px (`.lp-composer .composer-row input` outranked the
  16px rule) so Safari zoomed on focus. Now 16px.
- **Stage picker `#how`**: KEPT (owner overruled the plan's deletion). Desktop = the original page-scroll-driven row,
  restored on the owner's word, runway trimmed 3,600 → 1,800px, 0px blank lead-in. Phone = the SAME page-scroll
  mechanism driving a vertical stack (owner: "as i scroll down, this section just scrolls"), 200svh run ≈ half a screen
  per stage, 2,213px at 393×852. The contained-scroller experiment is DELETED, not dormant. `.hs-snap-pt` / `html.hs-snap`
  were NOT restored (bare `html` selector in the shared sheet; ~10 lines if the snap feel is missed).
- **Hero intro animation** (`home.js:326+`, `avatar.js` `props()`/`lynxrProp`, `app.css:7261+`): pencil → write half
  reveals → whistle → coach half, 1.80s measured. Once per session (`sessionStorage lx-hx-intro`), composer live from
  frame 0 (any touch snaps to done), default CSS is the finished hero, reduced-motion skips it, background tabs skip it
  without spending the session. GIFs of it were captured with headless Brave `--virtual-time-budget`.
- **Agency header** (`agencyonly/index.html:69-99`, `app.css:8962+`, `10883+`): capped to the landing's 1200px column
  (measured identical x/w at 7 widths — and this took `main` + footer from 1132 to 1200 with it; **the Database table at
  1200 is UNVERIFIED**, no staff sign-in). Lockup flipped: Lynx Media Group mark + name (Outfit 700 — THEIR brand font,
  measured off lynxmediagroup.org; `@font-face` at `app.css:25-40` from the two woff2 files idle in `fonts/` since July;
  never use it for lynxr text) on row 1, "powered by ✸ lynxr" (`#home-mark`, still a button with its app.js:352 handler)
  on row 2. Badge links to lynxmediagroup.org in a new tab, no underline. Fold to marks-only moved 640 → 760px (the old
  header was already overflowing at ~641–690). Seen painted by unhiding the shell client-side, not by signing in.
- **Seven landing mockups** on a private Design canvas: https://claude.ai/artifact/KtXPTDgucXUSxvNwDUFHYH — A product-first,
  B proof split, C stage-led, D editorial, E live demo, F app window, G dark hero. **Owner liked C** — specifically the
  composer living INSIDE the selected stage card, phone and desktop. Not built. Note C-as-hero collides with the split
  hero + intro and with the scroll-driven picker; the safe hybrid is the composer in the picker's card below the hero.
- **Still the owner's:** (1) a verifiable proof artifact — the pilot pair on /how-it-works/ has no input-video link in the
  repo; (2) `how-it-works/index.html:356` advertises the scraped corpus ("100,000+ studied videos · 5,190,673,018
  views") against the standing decision; (3) unsend on an agency brief has never been exercised; (4) commit `ce09c75`
  ("a") was made mid-task and captured half-finished `app.css`/`avatar.js` — look before pushing.
- **Harness lesson, recorded so nobody repeats it:** in the Claude desktop browser pane, `window.scrollTo` dispatched
  ZERO scroll events, making the working picker look broken. Verify scroll-driven UI with a real wheel/touch
  (`computer` scroll, or CDP `Input.synthesizeScrollGesture`).

**AGENCY SENDS BRIEFS TO ROSTER CREATORS — LIVE AND EXERCISED END TO END (2026-09-22).**
Plan: `~/.claude/plans/agency-send-brief-to-creators.md`, all 17 non-owner steps implemented and
pushed by the owner (HEAD `0edbd6b`). **All three SQL dependencies are applied:**
`supabase/staff_gate.sql`, `supabase/invites.sql` and `supabase/agency_roster.sql` — the last
one was applied by the owner on 2026-09-22, so the feature is no longer inert. The
privacy/terms decision (plan step 19) is still the owner's.

Where things live: the roster (invite by email, see who's accepted, remove) is the agency
app's new **Creators** tab (`agencyonly/index.html`). **Send to creators** sits in both brief
viewers — the campaign brief view and the legacy picked-video brief viewer — with the same
panel and the same "Sent to" / unsend list. On the creator side, the whole feature is
`#nav-lynx` / `VIEW.kind === "lynx"` (`creator.js`) — **do not confuse this with the
pre-existing staff-only `#nav-agency` link** that `revealAgencySwitch()` injects; the two ids
were nearly the same and a plan note exists specifically because of that collision risk.
Agency scripts a creator copies in never touch the allowance ledger: they're written straight
to `status: "done"` with a populated `adaptation`, so `wants_work()`
(`pipeline/process_adaptations.py`) never claims them and `charge_scripts()` is never called.
Unsend is `revoked_at` on the delivery row, never a delete — the brief snapshot and the roster
row both survive it.

**The happy path IS proven live** — see the roster state below: an invite was accepted and a
brief was delivered. **Still not run** (both apps are sign-in gated, so the owner has to do
them): the rest of the plan's Verification click-through, the isolation proof SQL block, and
the stored-XSS probe. Cold checks (`check_stamp.py`, `404.html`'s stamp, no `style="`, no
`${`, `node --check` on both files) all pass.

**Roster state (live, re-read 2026-09-22 evening, straight off the REST API):** one seat,
junsaemail@gmail.com, status **`accepted`** (invited 21:06 UTC, accepted 21:19). One brief in
`lynxr_agency_briefs` — client "Cloey", title "test" — and one row in
`lynxr_agency_deliveries` pointing at it, `revoked_at` null. So invite → accept → send has all
run for real; unsend has not been exercised.

**Later the same day, all pushed:** the Lynx Media Group mark (traced from the owner's logo into
one path, `lynx-media-mark.svg`, `AGENCY_MARK` in creator.js) now sits in the creator sidebar
item, that section's heading, the brief page header and the agency app header. The creator's
brief page shows each **video beside its script** (`.lynx-cols`; since 2026-09-23 the platform's own
player plays in the card — see the 2026-09-23 note at the top of START HERE). The empty state is one line,
"Waiting on briefs." — it used to render the lynxr avatar through `.empty-mark`, which is only
sized under `body.agency`, so it filled the whole pane.

**Repo (2026-09-22).** Everything below is PUSHED — HEAD `0edbd6b`, working tree clean, stamp
`20260922r` on 26 pages plus `404.html` (`check_stamp.py` → `ok`). The paragraphs further down that
still say "uncommitted" describe work from earlier the same day that went out in these pushes; they
are kept for what they explain, not for their status. The one thing NOT live is anything that needs
`supabase/agency_roster.sql`, which the owner has not applied yet.

**What's in the batch:**
- **Plan view** (`creator.js` `renderPlan`, `app.css`) — built by the ui-ux agent and reviewed: current state first,
  then free / pro / max glass cards with "your plan" marked; a buy button only when `BILLING_LIVE` and that plan's
  `for_sale` are both true; paid states (renews / trial / cancelling "ending" / past-due); `takeBillingReturn()`
  reads `?billing=done|cancelled`, strips it, opens Plan, and polls the ledger up to 10× over ~20s after a purchase.
  Prices ($24.99 / $74.99) are typed in the code because the ledger deliberately holds no prices.
- **Landing `#pricing` section** (`index.html` ~552) — free / pro / max cards, "plus tax where applicable", max
  "coming soon", Stripe named as merchant of record, links to `/pricing/`. Buttons open sign-up; nothing is buyable
  signed-out.
- **`/pricing/`** — now agrees with the ledger: Stripe (not Paddle), pro 150 (not 300), a max "coming soon" section.
  **It lowered an advertised limit on a page that forms part of the terms — the owner should read it (~305–340).**
- **terms / refunds / faq / llms.txt** — Stripe as merchant of record, pro 150, three new FAQ entries (cost, cancel,
  who takes payment). Copy promising things that don't exist was removed: no "basic coaching" (pro's ledger row
  has no features), and cancellation is self-serve from the Plan view (Cancel subscription / Manage billing), with the email kept as a fallback.
- **`supabase/billing.sql`, `supabase/functions/`** — new, untracked; the header now describes Managed Payments.

**Verified by the agent:** headless Brave over DevTools against localhost — 8 Plan states × light/dark × 390/1280
with injected data, the landing cards painted and focusable, no console/CSP errors. **Not verified:** a real click on
the new Upgrade button — do one after the push (it calls the same function that was already proven live).

**PAYWALL IS LIVE ON STRIPE — proven end to end with real money flows (2026-09-21).**
- **Provider:** Stripe with **Managed Payments** (Stripe is merchant of record: tax, VAT, disputes, billing support
  are Stripe's, for +3.5% a transaction). Chosen over Paddle for no approval queue, and over plain Stripe because
  Massachusetts taxes SaaS and lynxr LLC is in Allston. Revisit past ~300 subscribers.
- **Ledger:** `supabase/billing.sql` is APPLIED. free 3 per rolling 7 days (since 2026-09-21), pro 150/30d + 30/24h with the LIVE
  price id set, max 300/30d + 40/24h with **no price** — so max is unbuyable by construction ("coming soon").
- **Functions:** `billing-checkout` and `billing-webhook` are DEPLOYED, **both with Verify JWT OFF** (the project is on
  new JWT signing keys; the legacy-secret check would reject real user tokens; our code does its own auth and the
  webhook verifies Stripe's HMAC). Secrets set: `STRIPE_SECRET_KEY` (a restricted live key: Checkout Sessions write,
  Customer Portal write, Customers read, Subscriptions read), `STRIPE_WEBHOOK_SECRET`.
- **Proven live:** checkout → subscription created → webhook `applied` → entitlement 150/30d → cancelled →
  `customer.subscription.deleted` applied → back to free 25. Unsigned and forged webhook calls return 400.
- **Tests:** `node --experimental-strip-types supabase/functions/test_edge_billing.mjs` → 28/28, no accounts needed.
- **`creator.js`:** `BILLING_LIVE = true` (the kill switch — false turns Upgrade back into a sentence); pro's
  fair-use line now reads `my_plan()` instead of a hardcoded 300.

**Open, in order:**
1. **Push the batch**, then click **Upgrade to pro** once on lynxr.io to confirm the real button reaches Stripe.
   **That click failed on the live site (2026-09-21): "couldn't open checkout".** Cause: `billingAction` sent an
   `apikey` header the function's CORS preflight didn't allow, so the browser blocked every checkout POST before
   it left the page. It's been broken since checkout shipped. Fixed on both sides: the app no longer sends `apikey`
   (works against the function as deployed, no redeploy needed), and `billing-checkout`'s `cors()` now allows
   `apikey` and `x-client-info` (goes live with the next redeploy). A test covers it (44/44). Stamp `20260921c`.
   **PROVEN after the fix (2026-09-21):** the real Upgrade button on lynxr.io reached Stripe checkout and completed
   a purchase, twice: one real $24.99 payment and one with the 100%-off test code. Item 1 is done.
2. ~~Redeploy `billing-webhook`~~ **DONE 2026-09-21** — the renewal-date fix (Stripe API 2025+ keeps
   `current_period_end` on subscription items) is deployed, Verify JWT off.
3. **Manage billing + Cancel subscription — LIVE (2026-09-21).** Both Plan-view buttons open the Stripe customer
   portal (saved in live mode: cancel at period end, no plan switching, email change off). `billing-checkout`
   redeployed with the `portal` action (Verify JWT off). Owner proved a real cancel end to end from localhost
   before the flip. `PORTAL_LIVE = true` in creator.js is the kill switch; refunds/faq now say "open plan, choose
   cancel subscription" with hello@lynxr.io as the fallback. Plan: `~/.claude/plans/lynxr-stripe-customer-portal.md`.
   **Stray function:** a `billing-cancel` Edge Function was created by mistake (a paste into a new function);
   nothing calls it — delete it in the Supabase dashboard if it's still there.
   **A Cancel subscription button sits beside Manage billing** (same `PORTAL_LIVE` gate) while a plan still renews.
   It calls the portal action with `flow: "cancel"`, which opens a portal session with `flow_data[type]=
   subscription_cancel` — straight onto Stripe's "confirm cancellation" page, then back to `/?billing=portal`.
   The subscription id comes from the ledger only; 409 `nothing_to_cancel` if it is already ending. Needs no new
   key permission (Customer portal write covers it), but DOES need the portal saved in live mode with
   cancellation on. Tests 54/54.
   **Also in this pass:** the Plan view's free / pro / max options now use the landing `#pricing` card design
   (shared CSS: the landing rules are scoped `:is(body.home, .pane-body) .lp-plan…`; landing measured unchanged).
   **`supabase/delete_account.sql` now has the live-subscription guard** `billing.sql`'s header promised but the
   file never had: `delete_own_account()` refuses with `active_subscription` while a paid plan is set to renew
   (active/trialing/past_due, no `cancel_at`) — otherwise the cascade drops the ledger row while Stripe keeps
   charging. **Re-run it in the SQL editor**; until then the live function has no guard.
**BUILT: THE AGENCY SENDS BRIEFS TO ROSTER CREATORS (2026-09-22) — see the block at the very top
   of START HERE for current status.** Plan: `~/.claude/plans/agency-send-brief-to-creators.md`
   (19 steps; 2 are [OWNER]: apply the SQL, decide the privacy/terms line — both still open).
   Settled with the owner: roster only; staff invite by email and the creator ACCEPTS in lynxr
   with a join code (SUPERSEDED 2026-09-23: accept is by confirmed email, no code — see START HERE); one account per
   person; the creator gets a read-only brief page plus "add to my library"; the copy carries
   name/what-it-sells/audience/features and nothing else off `brand_context` (features added by
   the owner 2026-09-22 — the scripts name them anyway); it never touches the allowance ledger;
   one-way (nothing reports back); one brief to several creators; no deadline or target count;
   its own sidebar section; NO notifications (told on Discord); staff can unsend, leaving the
   roster hides agency briefs, library copies stay the creator's. Campaign briefs shipped first
   (steps 6-9), legacy picked-video briefs share the identical payload shape (step 16).
   **Security:** three new tables (`supabase/agency_roster.sql`) with `is_staff()`-only policies
   and NO anon/authenticated policies — the creator reads through four SECURITY DEFINER
   functions that return only their own rows; nothing writes to `lynxr_creators` from the staff
   side, so the isolation that was verified live still holds.

**AGENCY APP, TWO FIXES FROM GAWIN (2026-09-22, pushed; app.js + app.css).**
   1. **A brief saves at any size.** `CART_LIMIT = 10` was both the floor for Save and the ceiling for
   picking; both are gone (one video is enough, no upper stop). Tray reads "n videos in brief".
   Scripts still vary per slot — `tailoredScript()` indexes with `slot % length`.
   2. **New-client details are no longer lost.** Every keystroke in the client editor is kept in
   localStorage (`lynxr_client_draft`), the form fills from that draft FIRST and from the site read
   only where the draft is empty (so reading a site never overwrites typed text, and a reload keeps
   it), and a new **Save client** button writes the client into the Clients tab with no brief
   attached. **UNTESTED BY CLAUDE: the agency app needs a staff sign-in — the owner/Gawin must try
   both flows.**
   3. **Niche and target audience in the brand-context form are typed, not picked** (owner,
   2026-09-22: "make all of these typeable"). They are text inputs with a `<datalist>` of the
   database's own values as suggestions, so an unseen niche can be written down; the picked-video
   shelf still filters on an exact niche name, so a suggested one keeps that filter working.

**LANDING REDESIGN, TOP HALF — LIVE (2026-09-22, pushed).** Above `#pricing`, index.html is now
   the owner-approved mockup: a split hero (`section.hx`: left "live now · paste a link. get your script." with the
   existing composer moved in unchanged; right "coming soon · a coach that's all about you." + a preview card; the live
   avatar on the seam; halves side by side at every width) and a stage picker (`section.hs#how`, four stages, JS in
   home.js). From `#pricing` down nothing changed. CSS is one `body.home`-scoped `.hx-*`/`.hs-*` block at the end of
   app.css. Removed: old hero, "three steps", "beyond the script", proof, the 100,000+ band. Placeholders: "about the
   coach →" goes to `/pricing/`; the owner has not yet said whether to build the "how scripts work" and "coach" detail
   pages. Rules only the removed sections used are still in app.css (not yet grepped for other users). The h1 is now
   "paste a link. get your script."; title/meta unchanged.
   Later the same day (owner): on phones (≤640px) the hero STACKS (write, then the coach on lavender, avatar on the
   join) — tablets/desktop keep the split; the stage picker is SCROLL-DRIVEN (sticky, 75svh per stage, proximity
   snap points at each stage's middle, `html.hs-snap` only while live; clicks/arrows scroll to the stage); phone row
   drops labels and the card shows "n of 4 · label"; "free · no card" removed from the hero; the landing pro card
   lost "14-day money-back" (still on /pricing/ and in the app's Plan view); max's "everything in pro" is its own bullet.
   Then: NEW PAGES `/how-it-works/` (how scripts work) and `/how-it-works/coach/` (the coach — says plainly it isn't
   built), each with a scripts|coach switch; every "how it works" link on all public pages now goes to `/how-it-works/`
   (was `/#how`); the landing's coach link goes to the coach page; both pages are in sitemap.xml and llms.txt; CSS is
   the "HOW IT WORKS" block (`body.hiw`) at the end of app.css. The free card says "try for free". The landing's seam
   avatar is ALIVE (home.js): waves now and then, drifts through moods with a face crossfade, breathes, eyes follow the
   cursor; paused off-screen/hidden/reduced-motion. The identity marks (bar/footer/gate/rail) NO LONGER WAVE (owner).
**COFOUNDERS HAVE MAX FOR FREE + STAFF (2026-09-21).** Both cofounders' main logins each have a
   `lynxr_billing` row with provider `comp`, status active, plan max, no Stripe ids, and occurred_at `infinity`, so no
   Stripe event can overwrite it (proven: a later "canceled" came back `stale`). Gawin's main login was added to
   `lynxr_staff`, which is what `is_staff()` reads for the agency app. The recipe and undo are in `supabase/billing.sql`
   under the operator recipes. The owner's old pro subscription is still set to end 2026-10-21 in Stripe; that's harmless.
   The Plan view still shows the paid-billing sentences (email hello@ to cancel; Stripe is merchant of record) for a
   comp, because `my_plan()` doesn't expose `provider`. That's cosmetic.
**FREE TIER IS 3 A WEEK — SWITCHED LIVE 2026-09-21, NO NOTICE PERIOD.** The planned 14-day notice (switch on
   6 Oct) was dropped because the only accounts were staff and one test account (checked live first), so no one was
   affected. Done: the `lynxr_billing_plans` 'free' row is 3 / 7 days / no 24h ceiling (verified via `allowance_state`);
   `billing.sql`'s seed and header match; every page's copy and JSON-LD say 3 a week; the dated "until 6 october, 25"
   text and the in-app notice card (`paintFreeNotice`) are gone; `creator.js` falls back to 3 per 7 days and gives free
   its own wall sentence (from `my_allowance().plan`); the worker's walls name the real limit (`wall_note()`, the parked
   A0.1 hunk plus `cap_week`). Pushed and deployed (worker deploy green at `46916a2`). **Any future free-tier change
   that affects real accounts needs the terms' 14 days' emailed notice.**
**2026-09-22 batch (pushed):**
   - **Unlock time + pro's 24-hour check (A0.2 / A2.2 / A2.5):** `allowance_state()` is now plpgsql and returns
     `next_room_at`; `my_plan()` now includes the free row. **Applied 2026-09-22 and verified live:** 3 temporary charges on an
     unused account gave next_room_at = oldest + 7 days exactly, then were deleted; `my_plan()` lists free/pro/max. `creator.js` reads `daily_max`, `used_24h`, `next_room_at`: room is the smaller of the window's
     and the day's; the wall, the rail and the Plan view name the unlock time, and the app shows pro's 24-hour
     sentence itself. Works against the old function too (no time shown). Checked in the preview with injected states.
   - **Metering (roadmap 0.1):** `process_group()` now records the source half (shot list, tags, format) to
     `lynxr_costs` under the rep id. Push date = `METER_DATE`; measure per-script cost 14 days / 30 charges later.
   - **JSON-LD:** all 21 `SoftwareApplication` blocks now offer free AND pro ($24.99/month).
   - **Owner said done 2026-09-22:** delete_account.sql re-run, Stripe product description, test coupons deleted,
     Search Console / IndexNow. Verified from outside: `billing-cancel` returns 404. Not verifiable from here: Stripe,
     the delete guard. **Gawin's invited lynxr.io login still exists, unconfirmed (item 8).**
4. ~~Edit the Stripe product description~~ — owner, 2026-09-22.
5. ~~Sitewide JSON-LD pro Offer~~ — done 2026-09-22.
6. ~~Stripe cleanup (test coupons)~~ — owner, 2026-09-22. The pro product's tax code saved as "SaaS – business use";
   personal use was intended (minor, editable).
7. **Tier faces:** free=idle, pro=done, max=hyped PNGs are in `~/Desktop/lynxr-tier-logos/` (upload pro's as the
   Stripe product image). In-app, put `lynxrAvatar(mood)` on the plan cards rather than images.
8. **Google sign-in fork risk:** `gawin@lynxr.io` is still an unconfirmed invited account — have him accept before he
   uses "Continue with Google", or he gets a second account without staff access.
9. **Search:** request indexing in Search Console (~10/day: about, pricing, faq, glossary, then the guides); Bing →
   import from GSC; re-ping IndexNow (`tools/indexnow.py`) after the push.
10. **Noticed, not fixed:** Escape doesn't close the sign-up gate (already true before this batch).

---

### Earlier state (2026-09-16 evening), kept for context

**Repo (then):** committed through `453df78`; live cache stamp `20260917a`.

**Agency sign-in has "Forgot your password?" (2026-09-17, stamp `20260917a`).**
- **What changed:** `agencyonly/index.html` has the link and a hidden confirm field. `app.js` gained
  `setResetMode()`, `saveNewPassword()` and its own `sessionFromLink()`. A reset or invite link that lands on
  `/agencyonly/` now asks for the new password twice, saves it, and opens the database.
- **Creator side:** `creator.js` now treats an **invite** link like a reset link and asks for a password. Before
  this, an invited staff member had no password to sign in to the agency app with.
- **Redirect:** the link lands on `/agencyonly/` only if `https://lynxr.io/agencyonly/` (or `https://lynxr.io/**`)
  is an allowed Redirect URL in Supabase → Authentication → URL Configuration. Otherwise Supabase sends it to the
  Site URL and the creator app's reset form sets the same password, which is one account, so both apps accept it.

**What the site looks like now** (details in the dated sections below):
- **Glass:** frosted `--gl-*` tokens (46%→12% white, 28px blur) on floating chrome and
  app islands; a denser `--gl-fill-scrim` for anything over a scrim or video.
- **Public pages:** info surfaces are the OLD WHITE (`--surface`); only the nav pill and
  footer are glass; the landing hero card is pinned to `--glass` 85%; the closing CTA sits on
  the backdrop with no box; feature badges are white glass with a logo-gradient ring.
- **Creator app:** floating shell (sidebar A, header island, content islands, no box inside
  a box, footer on Settings only, one document scroller). The phone drawer slides in and out
  from the left and has a back arrow plus Escape. Every script view uses the beat-card style;
  repeated DO lines are shown and editable.
- **Agency app:** floating islands, library-tile card grids, scripts in the creator markup.
  SAY/DO/SHOW/ON-SCREEN, hook, CTA and caption lines all edit in place. The Database view is
  a tile grid, and its tiles are editable as staff-side corrections (row `source-edits`).
- **Editing indicator (both apps):** a straight 2px left stripe (a background layer), accent
  on focus, green while unsaved.

**Open — in the order to pick up:**

1. **Product roadmap.** The owner shared a new product map on 2026-09-16 (tiers, onboarding,
   coaching, closed loop). Its decisions, and the holes found in it, are kept OUT of this
   public file: they are in the private memory note `lynxr-product-map-2026-09-16`
   (`~/.claude/projects/-Users-junsahwang-Documents-lynxrio/memory/`). A planner was
   wrote `~/.claude/plans/lynxr-product-map-roadmap.md` (complete, 48 steps, phases 0 and A1–F,
   29 owner questions with defaults). **It is NOT approved yet**, and nothing is built. Next
   session: walk the owner through its questions and the gaps listed in the memory note, then
   run its "Build first" list only on a go.

2. **Google sign-in is ON in the code, not yet pushed** (`const OAUTH_ON = { google: true, apple: false }` in
   `creator.js`; plan `~/.claude/plans/oauth-sign-in.md`).
   - **Done 2026-09-20:** Google Cloud project `lynxr` (id `tidy-interface-508915-e3`, org lynxr.io) with the consent
     screen External and published, client `lynxr web` (origins `https://lynxr.io` + `http://localhost:8811`, single
     redirect URI `https://esakjfogplfszievvabi.supabase.co/auth/v1/callback`); the Supabase Google provider is
     enabled (`/auth/v1/settings` → `external.google = true`); Site URL and the two `/**` redirect patterns are set.
   - **Proven locally:** the button paints, the consent tick still gates it, and clicking reaches Google's sign-in
     page with the right client_id and `redirect_to` intact. No real sign-in was performed.
   - **Owner must do BEFORE pushing** — an account whose email is unconfirmed does not link; Supabase mints a second
     uid with an empty library and a fresh allowance:
     - delete the empty unconfirmed account from 2026-08-28 (never signed in, no creator row, no charges);
     - have `gawin@lynxr.io` accept his invite, or confirm that account, so staff access stays on one uid;
     - re-check: `select count(*) filter (where email_confirmed_at is null) from auth.users` = 0.
   - **Then:** push (the stamp is already `20260917a` in the tree) and test on lynxr.io with a brand-new Google
     address, and with an address that already has a confirmed password account — that one must stay ONE account.
   - **Known cosmetic:** Google's screen reads "to continue to esakjfogplfszievvabi.supabase.co". Changing it needs
     Supabase's paid custom-domain add-on.
   - **Unverified:** Safari rendering of `assets/google-g.svg` (Google's official icon-only light asset, with a
     `foreignObject` gradient).
   - **Staff sign-in stays password-only.** Apple is blocked on a $99/yr developer account.

3. **Brand search** (plan `~/.claude/plans/brand-search-visibility.md`; see its section below).
   - **Done:** repo steps 1–4; sitemap submitted in Search Console (the Domain property was
     ALREADY verified, with 7 indexed pages); IndexNow sent all 21 URLs (202).
   - **Owner still has to:**
     - request indexing: day 1 home/about/faq/pricing/glossary; day 2 the six guides; the
       blog only after the owner reads the posts;
     - Bing Webmaster → Import from GSC;
     - GitHub About and Website fields;
     - replace the LinkedIn tagline "sm calm shi";
     - verify the Instagram/TikTok profiles are real and link back;
     - take an AI-answer baseline;
     - screenshot Performance → Queries.
   - **Pricing copy:** the site's free-tier and price copy is about to change (see the
     private roadmap note). Update it before re-indexing the pricing page.

4. **Email moved to Google Workspace on lynxr.io (2026-09-16).**
   - **Done:** Cloudflare has the MX (`smtp.google.com`) and DKIM (`google._domainkey`) records.
   - **Public contact is `hello@lynxr.io`** on every page, in the JSON-LD and in lynxr's organization block on
     lynxmediagroup.org. `junsa@lynxr.io` is the owner's own account: Google sign-in's support/contact email, the
     seat-exempt seed entry, and service logins — never the public address. Lynx Media Group's own
     `lynxmedianetwork@gmail.com` is untouched and still names the `lynxr_staff` seed in `supabase/staff_gate.sql`.
   - **`hello@lynxr.io` is an ALIAS on `junsa@lynxr.io`** (Workspace, added 2026-09-20), so support mail lands in the
     owner's inbox at no extra licence cost. It is not a group and cannot sign in anywhere. Replies come from junsa@
     unless the owner adds it under Gmail → Send mail as.
   - **Owner still has to:**
     - make `hello@lynxr.io` receive mail (a Workspace group or an alias);
     - add the SPF TXT record on `@` (`v=spf1 include:_spf.google.com ~all`);
     - move every service login off the old Gmail contact before deleting it.
   - HTML only; no stamp bump was needed.

5. **Paywall on STRIPE MANAGED PAYMENTS — built, nothing live.** (Owner picked Stripe on 2026-09-20 and then
   took Stripe's own merchant-of-record option, Managed Payments, when the onboarding offered it: Stripe owns sales
   tax/VAT/GST in 80+ countries, fraud, disputes and billing support for an extra 3.5% a transaction — ~$1.89 of a
   $24.99 subscription against ~$1.02 without. It is what makes selling outside the US possible immediately, and it
   takes Massachusetts sales tax on software off lynxr LLC. Revisit past ~300 subscribers. It is a per-SESSION flag
   (`managed_payments[enabled]`), so dropping it silently returns the tax liability here; `STRIPE_MANAGED_PAYMENTS=false`
   turns it off without a redeploy. Products must carry a tax code labelled "Eligible for Managed Payments", and tax
   is added ON TOP of $24.99 unless the price's tax behaviour is set to inclusive.) Earlier reasoning:
   ships without an approval queue, ~2.9% + 30c against ~5% + 50c, and nobody vets the scraping question — at the
   cost of lynxr LLC being seller of record, so sales tax and refunds are ours. Revisit before selling outside
   North America; moving providers later costs a webhook rewrite, not a migration, because no column says "stripe").
   - **In the repo:** `supabase/billing.sql` (plans free/pro/max, `lynxr_billing`, `lynxr_feature_grants`,
     `lynxr_billing_events`, and `entitlement_for` / `features_for` / `charge_scripts` / `my_plan` / `spend_state`);
     `supabase/functions/billing-checkout/` and `billing-webhook/`; `supabase/functions/test_edge_billing.mjs`
     (27 checks, `node --experimental-strip-types …`, no accounts needed — all passing).
   - **Applying `billing.sql` changes nothing visible:** seeds are `do nothing`, free is seeded at 3/7d, max has no price id
     and so cannot be bought. The caps (pro 150/30d, max 300/30d) are PROVISIONAL until the per-script cost is
     measured; a subscriber who uses every slot must still leave 20% of the net payment.
   - **Owner still has to:** activate Stripe (LLC details, EIN, statement descriptor `LYNXR`), connect Mercury for
     payouts (ACH routing + account number), create the `lynxr pro` $24.99/mo price and send the price id, enable
     the customer portal, add a Radar rule blocking card countries outside US/CA, run `billing.sql`, deploy both
     functions from the dashboard, set `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`, and add the webhook endpoint.
   - **THE COMMON FAILURE:** `billing-webhook` must be deployed with **Verify JWT OFF**. Stripe sends no Supabase
     token, so with it on every delivery is rejected and subscriptions never activate.
   - **Not built yet:** the Plan view (pro card + max "coming soon" + notify-me), and the legal copy — `terms/` and
     `refunds/` still name Paddle as merchant of record, which is now wrong and must change before any money moves.

6. **Small, known, not done:**
   - the creator app's caption save flattens line breaks (the agency keeps them);
   - the creator hook card probably has the edit stripe over the opening quote mark (the
     agency one was fixed; the creator one is untested);
   - the desktop header in the creator app doesn't stick (`.pane-scroll` is a scroll
     container);
   - the phone drawer has no focus trap;
   - "that video is private." paints red words on glass.

**How this session worked (keep doing it):**
- **Agents:** planner → owner approves → executor or ui-ux. Parallel agents that would both
  touch `app.css`/`app.js` work in scratch "patch mode" and are applied one at a time.
- **Relaying owner changes to a running executor:** an executor refused changes relayed
  mid-task as "possible injection". Put owner decisions in the INITIAL prompt or in the plan
  file, or resume a finished agent with a new task.
- **Verification:** verify painted pixels in the Browser pane on copies built with the real
  stylesheet and the real `adaptationHtml()` etc. Signed-in views use the harnesses in
  `/private/tmp/lynxr-agency-revamp/` and the session scratchpad.
- **CSS comment trap:** NEVER put a star immediately followed by a slash inside a CSS
  comment (e.g. `.pane*` then `/`). It ends the comment early and the next rule is swallowed
  as garbage; this once hid the whole public-pages `:root` sizing rule. Scan `app.css` for
  stray comment terminators after every edit.
- **IndexNow:** `tools/indexnow.py` needs its own User-Agent (Cloudflare 403s
  `Python-urllib`) and falls back to `/etc/ssl/cert.pem` (the python.org macOS build has no
  root certificates); both fixes are in the script.

---

## Rebrand phase 1 (2026-09-14): glass + the X avatar

Direction "g · glass" landed for tokens, palette, fonts and the avatar mark —
gate: dark `--text-3` 4.53:1, tightest pair (full gate in
`~/.claude/plans/lynxr-rebrand.md` Appendix B). New tokens: `--fill`,
`--on-fill`, `--focus-ring`, `--glass*`, `--surface-flat`, `--field`,
`--frame-*`, `--field-input*`, `--toggle-*`, `--scrim*`, `--beat-wash`. Glass
is for chrome, not data — cards stay translucent with no blur, agency tables
sit on opaque `--surface-flat`. The dot lattice is retired; `dotgrid.js` stays
in the repo, unreferenced. Fonts are Albert Sans (UI/display/logo) + IBM Plex
Mono (data), self-hosted OFL-1.1, `fonts/OFL-*.txt`. The avatar's shared
`<svg class="lx-defs">` must stay rendered on every page — a gradient inside
`display:none` doesn't paint. Rasters come from `tools/make_brand_assets.py`;
OG refs are now `-v3.png` (2026-09-15: no box behind the lockup, just the blobs, the avatar and the wordmark; the short-lived `-v2` files are removed, the original `og*.png` kept). The "LOGO is Share Tech Mono
again" note below is superseded. The loader still draws the old four-arm X
until phase 2.

**Added on top of the plan, 2026-09-14/15, at the owner's direction** (all
landed, gate `ok`, stamp `20260915i`):
- **Bar:** a floating pill on every public page, styled after
  lynxmediagroup.org's bar (94% `--glass-solid`, hairline edge, outlined inset
  buttons, centred links). This deliberately reverses the 2026-08-26/27
  flat-bar orders.
- **Landing hero:** the headline, subline and paste field sit on one glass
  slab. It is 580px wide, so the 52px headline stays on one line.
- **Removed on review ("thats too abstract"):** the two tilted 9:16 frames
  behind the slab, the abstract glass objects, and the landing field drift.
- **Backdrop = blobs:** `backdrop.js` (new, on all 24 stamped pages, watched by
  `check_stamp.py`) adds six uneven, blurred blobs in the logo colours only:
  peach `#ffb38a`, pink `#ff7eb8`, violet `#7b61ff`, and their dark tones.
  - **They ARE the six `--field` layers:** same centres, radii, colours and
    peak alphas. That is how the contrast gate still measures them.
    `body::before` no longer paints the field.
  - **Motion:** they breathe slowly on desktop (CSS). The script leans only
    the blob near the cursor or finger toward it (≤30px), and squashes them
    slightly with scroll speed. The whole background never moves.
  - **Before changing a blob:** read the BACKDROP block comment at the end of
    `app.css`, then change `--field` to match and re-run the gate.
  - **Phones (≤760px) use their own layout** ("the background blobs for mobile
    look bad"): five round vw-sized blobs with a fuller core, framing the hero
    card — pink, violet, an orchid accent, violet, pink. The `--field` gate
    doesn't model them. They were measured with
    `~/.claude/plans/lynxr-rebrand-assets/mobile_blobs_gate.py` at 375, 390 and
    430px wide: dark worst L .0470, light .6756. Re-run it before changing one.
- **LIGHT ONLY (2026-09-15, "get rid of the dark mode"):** `theme.js` stamps
  `data-theme="light"` before first paint. `creator.js`'s `applyTheme()` can
  only paint light, so a creator's synced dark choice no longer applies. Every
  theme toggle, the menu theme row and Settings > Appearance are hidden in CSS
  (end of `app.css`). The dark `:root` values are dormant, not deleted, and
  removing theme.js's one line brings dark back.
- **The wave:** it moves the shared `#lx-idle` mask's top-right arm, so every
  static avatar waves together.
  - **Touch screens `(hover: none)`:** once every 4s, in CSS.
  - **Mouse screens:** only while hovering the logo or wordmark. `backdrop.js`
    toggles `html.lx-waving` and lets each 1.1s wave finish.
- **Rebrand phase 2 (2026-09-15): the avatar has emotions.**
  - **Component:** `avatar.js` (watched by `check_stamp.py`) exposes
    `lynxrAvatar(mood, cls)` and `lynxrMood(svg, mood)` for eight moods: idle,
    reading, writing, done, hyped, confused, sorry, coaching. The poses and
    faces live in the "THE LYNXR AVATAR: moods" block of `app.css`, driven by
    `data-mood`.
  - **Wired:** `loaderMark()` is the avatar in both apps. `paintEta()` flips
    reading→writing with no re-render. A card error shows confused (link or
    fetch) or sorry (our failure). A just-finished card shows one done beat.
    Campaign formats show writing.
  - **Built but not wired:** hyped and coaching.
  - **Rules:** static identity marks only ever wave. Reduced motion stops the
    loops, but moods still change.
  - **Name clash:** the coaching arm's keyframes are `lx-wave-arm`, because
    `lx-wave` is the static mark's hover wave.
  - **Changes after verification (2026-09-15):**
    - **sorry, redrawn** ("i dont like the sorry"): the X stays whole but
      shrinks in slightly, sinks and tilts. The face has droopy eyes and
      no brows (removed at the owner's request); a sweat drop sits in the top notch, and it sighs slowly.
      The old pose drooped every arm into a puddle.
    - **Loops scoped to their mood:** Chrome was ticking all 14 hidden face
      animations on every avatar.
    - **No done beat above a failure:** it never renders over a `.bp-fail`
      body.
  - **Brand files:** high-res SVG (clip-path, true vector) and 2048px PNG
    exports of all eight moods, plus a sheet, are in `~/Desktop/lynxr-avatar/`,
    outside the repo.
- **Bar hides on scroll-down, slides back on scroll-up (2026-09-15).** This is
  every public page, home included, and it reverses the flat-bar era's "just
  have it stay there".
  - **Logic:** unchanged in `site.js`. The bar is always shown within 8px of
    the top, ignores moves under 14px, and never hides while the menu is open
    or when the bar takes focus.
  - **CSS:** the THE BAR SLIDES AWAY AND BACK block at the end of `app.css`.
    The bar lifts 22px and fades out in .3s, ignoring pointer events while
    away; it returns over .5s on a long ease-out (owner: "make the reappear
    smoother").
  - **Reduced motion:** the bar stays put.
- **Favicon and apple-touch links carry the `?v=` stamp too (2026-09-15).**
  Browsers cache a favicon by URL, apart from the page, so the tab kept
  showing the old black X after the files changed. The stamp bump replaces
  every `?v=` on a page, so these move with it; `check_stamp.py` only checks
  .css/.js and is unaffected.
- **Paste field:** a visibly separate well in the slab (white fill, ink-20%
  edge, inset shadow). Any darker tint failed `--good` over the gate's worst
  case.
- **Share images:** `make_brand_assets.py` draws the light palette: pastel
  blobs, a white glass slab and ink text. The apple-touch icon sits on the
  light `--bg`.

## Simple, fun, glass pass + motion changes (2026-09-15, stamp `20260915m`)

- **Landing, simplified** ("too messy … simplistic but still fun"):
  - Numbered eyebrows gone.
  - The how-it-works mock UIs are replaced by the avatar acting each step:
    `idle`, `reading`, `done`. `avatar.js` now renders any
    `<span data-lx-mood="…">`.
  - The features exhibit column (mock card and fan) is removed. The four
    features are glass tiles with gradient icon badges.
  - Proof fine print is hidden, and the steps are gradient-bordered pills.
  - A `hyped` avatar sits above the closing CTA.
- **Glass everywhere** ("add a glass morphism feel"): the SIMPLE, FUN, GLASS
  block at the end of `app.css`.
  - **Shared surface:** landing cards, the reading sheet on every content page
    (`body.lp:not(.home) main`), `main.legal` and the footer card all use
    `--surface` + blur + white edge + violet shadow.
  - **Motion:** spring hover on landing cards and buttons, desktop only; off
    under reduced motion.
  - **White on gradient:** the icon badges use `--ico-grad` (deeper pink),
    because white on the logo gradient measured 1.74:1.
- **Creator app, same pass (2026-09-15, stamp `20260915q`):** the THE APP,
  SIMPLE AND GLASS block in `app.css` covers the script view, the library
  grid and Settings. Every rule is scoped to `.pane-body` or `.pane-head`, so
  the agency app is untouched.
  - **JS changes** are marked `APP GLASS PASS` in `creator.js`: the handle
    moved into the card head, the duplicate caption is hidden, the poor-fit
    callout gets a confused avatar, Settings is grouped into cards, and trash
    renders as rows.
  - **Don't blur** the open card or "The original": it breaks the mobile mini
    player, which is pinned from inside them.
  - **Checked** with injected data in headless Brave (not signed in).
    Screenshots are in `/private/tmp/lynxr-app-revamp/`.
- **Not yet done (older note):** the signed-in creator and agency app screens were not
  redesigned. They only picked up the footer card and shared tokens. They need
  a signed-in session to design and verify. Agency app: done 2026-09-15, see "Agency app,
  floating glass" below.
  Inside the apps the footer card is inset by `--gutter` on both sides. A
  percentage width there overflowed `.pane-scroll` into a horizontal scrollbar
  (fixed, stamp `20260915n`).
- **Footer waits below the fold on any display** (stamp `20260915o`): the
  content and legal sheets are at least a screen tall, `.pane-body` fills its
  pane, and the agency `<main>` fills the viewport. Checked at 1440×1400 on
  404, /about/ and the creator app shell.
- **Card landing bug, found and fixed (stamp `20260915r`):**
  - **Cause:** the below-the-fold footer rule first shipped as
    `.pane-scroll > .pane-body { min-height: 100% }`. With the shell uncapped
    (the document scrolls), that made `#pane-scroll` overflow as well.
    `scrollCardToTop()` then scrolled the pane while the page had also
    moved, so opened scripts landed 292–834px above the top of the screen.
  - **Fix:** `min-height: 100svh`.
  - **Trash:** the APP GLASS pass also renamed trash `.script-grid` →
    `.trash-rows`, which dropped deleted scripts out of `LAND_CARDS`. They
    are added back.
  - **Verified** in headless Brave with injected data: library, library with
    a card open above, every brand card, and every trash row land exactly
    under the header (cardTop == expected) at 1440, 1180, 1024, 820, 390 and
    844×390. Harness: `/private/tmp/lynxr-land/`.
  - **Note:** clicking a card's thumbnail image doesn't open it; the
    pre-change copy behaves the same.
- **Desktop backdrop:**
  - **Pull:** every blob within 900px is pulled toward the cursor, 60px max
    and linear in distance.
  - **Light:** a white light follows the cursor (safe: white only raises
    luminance).
  - **Limit:** bigger pulls fail the contrast bound even with paler blobs
    (120px: .6431, at x0.85 strength: .6591). Don't raise PULL.
- **Nav mark:** 32px on every public page.
- **Wave:** on every device it waves on load, then every 3s (hover code removed).
- **Backdrop motion:**
  - **Desktop:** blobs pull toward the cursor, ≤70px, nearest most.
  - **Phones:** a rigid swirl plus outward spread on scroll.
  - **Contrast:** measured, see the `backdrop.js` header. Don't give phone
    blobs individual moves.
- **Wording:** "short-form video agency" → "UGC agency" everywhere (UGC stays
  uppercase via `.entity` in visible text).

## /creatorsonly/ retired; the creator app lives on / (2026-09-15, stamp `20260915w`)

Owner: "you can delete the creators only, the creators either have an account
or make an account on lynxr.io main page".
- **The stub:** `creatorsonly/index.html` is now a noindex stub.
  `creatorsonly/forward.js` does `location.replace("/" + search + hash)`, with
  a 3s meta-refresh fallback, so handed-out links and emailed invite /
  confirmation / reset links keep working. The old page is in git history; a
  copy is in the session scratchpad.
- **creator.js on the home page:** before, the gate was hidden until opened,
  so these links landed on the marketing page.
  - `?signup=1`, `e=` or `c=` now calls `showGate("up")`, with the email and
    invite prefilled.
  - An error fragment opens the gate with the expired message.
  - A `type=recovery` session opens it in reset mode.
  - All verified end to end (old and new paths), with tokens stripped from the
    URL.
- **Retargeted:**
  - `CREATOR_PATH = "/"`: the `redirect_to` for confirmation and reset emails.
  - `app.js`'s staff "Creator app" link.
  - The SQL invite-link comments.
- **OWNER CHECK:** Supabase Auth → URL Configuration must allow
  `https://lynxr.io/` as a redirect (it is allowed automatically if it is the
  Site URL).
- `og-creator-v3.png` is now unreferenced.

## Brand search: lynxr LLC entity + GEO (2026-09-15)

Owner: "pop up first when people look up lynxr" and "second when people look up
lynx media group".
- **Entity:** lynxr LLC is a **partner company** of Lynx Media Group (owner's
  answer). The shared JSON-LD on 21 pages now has two Organizations:
  `https://lynxr.io/#organization` is lynxr / lynxr LLC (logo
  `lynxr-logo.png`, slogan, lynxr's own socials in `sameAs`), and
  `https://lynxmediagroup.org/#organization` is the agency. schema.org has no
  "partner" property, so the relationship is stated in both descriptions,
  never as parent/sameAs.
- **Copy:** the footer blurb, /about/ (title "About lynxr — a Lynx Media Group
  partner company") and /faq/ say lynxr LLC is a partner company. /faq/ and
  `llms.txt` gained a disambiguation line: not the Honeywell/Ademco LYNXR
  panels, the Lynx R headsets, or lynxr.com.
- **Legal pages switched to lynxr LLC (owner, same day):**
  - **Operator:** privacy ("run by lynxr LLC … a partner company of Lynx Media
    Group LLC"), terms (the agreement party, the "where formed" note) and the
    privacy/terms/accessibility contact blocks now name lynxr LLC. Their "last
    updated" dates are 15 september 2026. refunds names no operator in its body.
  - **Kept, unverified:** the "Massachusetts limited liability company"
    wording and the 15 Farrington Ave address carried over from Lynx Media
    Group LLC.
  - **Not done yet:** the privacy page promises an email for material changes,
    and none has been sent.
- **Indexing:**
  - `sitemap.xml` lastmod is 2026-09-15.
  - IndexNow key file `11a5180a05d480145ef85b097249664d.txt` is at the root.
    Run `./venv/bin/python tools/indexnow.py` after a push has deployed (Bing →
    ChatGPT search, Copilot, DuckDuckGo).
  - **The real blocker is off-repo:** lynxr.io is still not indexed by Google
    (checked 2026-09-15). It needs Search Console verification, a sitemap
    submit and request-indexing.

## Glass everywhere (2026-09-15, stamp 202609152a)

One token family, `--gl-*`, appended to the end of `app.css`. `sitewide-glass.md`
landed (all 12 steps, gate `ok`, stamp `x`) with the see-through recipe it was
planned around. The owner then rejected that look ("i dont like the too
transparent look"), sent a screenshot of the ORIGINAL hero card as the
reference, and asked for everything to be glass. That was applied the same day
by hand (stamp `y`). The owner then asked to see the first, FROSTED recipe on every
surface ("lets see how that full look looks"), which is what is live now (stamp
`z`): the `html[data-theme="light"]` block in the `--gl-*` section holds it, and
deleting that block puts every surface back on the original look described
below. **The original look (the fallback under the preview):**
- **glass** — the hero card exactly as it stood before: `--glass` (85% white),
  `--glass-blur` (20px saturate 1.6; 12px/1.4 at ≤760px), `--glass-edge`,
  `--shadow-card`. No sheen layer. Floating cards (hero, step/feature/proof
  cards, footer, both sign-in cards, Settings/brand/plan/feedback cards, the
  phone header pill) AND everything the plan had put on frost: phone menu,
  modals, sendbox, sort menu, score tooltip, blog/legal reading sheets, the
  rail, the desktop sticky header.
- **frost** — `--glass-solid` (94%): now only the public nav pill, which was
  94% already.
- **still** — the glass fill with no blur, for a surface holding a
  `position: fixed` child (the opened script card, "The original") or a large
  group box (by-brand).
- **well** — `--field-input`: the white paste field with its grey edge.
  Inputs, and anything nested inside a blurred parent, never blurred.
- **Tables and stats go glass too** (owner), but `.stat` / `.bar-track` /
  `.table-wrap` only exist in the agency app, so `agency-revamp.md` applies it.
- **Always `background: var(--gl-fill)`, never `background-image`** — the
  fallbacks (no-`backdrop-filter` browsers, `prefers-reduced-transparency`)
  swap the shorthand for a flat colour.
- **Text fixes (owner: "make this text also match the new redesign"):** the
  sign-in email/password fields type in `--font-ui` instead of IBM Plex Mono;
  Chrome's autofill blue is covered by the well's white (inset-shadow trick,
  NOT verified on a real autofilled field); the sync line ("● syncing ·
  email" in the agency header, "● synced" in the rail) is `--font-ui` with the
  words in ink/grey and only the ● green or red, via `::first-letter` (the rail
  badge became `inline-block` so `::first-letter` applies).

**Verified (stamp `y`, Browser pane at 1024px):** hero card, composer and nav
pill computed values are identical to the pre-change measurement (85% /
`blur(20px) saturate(1.6)` / .85 edge / same shadow; composer #fff with the
.2 ink edge; nav 94%). Step cards and footer paint the same glass. The
`/agencyonly/` gate card is glass and both fields compute Albert Sans on #fff.
Sync-line dot colours were checked painted on stand-in copies of both markups
with the real stylesheet, not in a signed-in app.

**Contrast:** the plan's numbers were measured for the see-through recipe and
no longer apply. The shipped fill is the pre-existing 85% `--glass`, whose
token note already covers text over a black video frame; it was not
re-measured after the change. Green words still turn ink on glass (D8).

**Nesting rule:** an element with `backdrop-filter` is a backdrop root — a
glass/frost child inside one only samples that parent's own fill, not the
page behind it, so any surface nested inside a blurred card takes the well
tint with no blur of its own (FAQ items, the blog script/table, the terms
banner, the sign-in card's paste banner and fields). Verified with a probe
that walks every element in every state: no blurred element has a blurred
ancestor.

**Mini-player rule:** `backdrop-filter` makes an element the containing block
for a `position: fixed` descendant, so the opened script card and "The
original" (both hold the mobile mini player) never blur — they take the glass
fill with `backdrop-filter: none` instead. Verified: the mini player's `.ref-media`
stays `position: fixed` and pins inside the viewport with no blurred ancestor
between it and the card.

**Step 9 (phone scroll cost):** measured, not assumed. p95 frame time and
long-frame count at 390×844 under 4× CPU throttle were identical before and
after on every page tested (landing, blog, legal, settings, brand — all
16.7–16.8ms p95, 0 long frames both runs). The 12px phone-blur fallback
(D7) was **not needed**. That was measured on the 16px recipe; the shipped
phone blur is `--glass-blur`'s 12px and was not re-measured.

**Backdrop unchanged (D14):** `backdrop.js`, the `.blob` layers and `--field`
were not touched by this plan.

**Next:** the owner reviews the glass before anything else runs ("lets go all
glass first and then ill see"). Queued after that review:
- `agency-revamp.md` consumes these `--gl-*` tokens. Its own text still says
  the header pill and tray are frost and data grids stay opaque; per the owner
  both are now glass (header, tray, tables, stat tiles, Ops tiles).
- **Creator floating shell LANDED (stamp `202609152b`)**, block "THE FLOATING SHELL
  (owner, 2026-09-15)" at the end of `app.css`:
  - Rail = direction A (floating panel, 12px inset, `--r-card`); desktop header is its
    own island aligned to the rail; content islands (tiles, opened card, Settings cards)
    use `--gl-fill` without blur; phone header pill and drawer float 10px in.
  - New `--gl-fill-scrim` tier (94%→86% frosted) for anything over a scrim or media:
    the phone drawer, `.lp-menu`, `.modal-card`, `.sendbox`, `.find-sort-menu`,
    `.score-tip`. Drawer over a black cover: `--text-2` 1.18 → 6.95.
  - No box inside a box: nested script cards, "The original" panel backing, the
    poor-fit callout, Settings trash rows, the plan note and the by-brand group box are
    flat inside their island (hairline dividers only). The by-brand box change needs
    the owner's OK.
  - The new-script empty state has no container. The in-pane footer shows on Settings
    only (`creator.js` `renderPane()` sets `pane.dataset.view = VIEW.kind`).
  - Double scrollbar cause: the in-pane footer's "lynxmediagroup.org" overflowed at
    840–860px and gave `.pane-scroll` its own scrollbar; the footer reflows to two
    columns at 821–960px. Sweep 330–1500px: only the document scrolls (plus the existing
    "The original" column at ≥1180px).
  - Pre-existing, left alone: the desktop header scrolls away (`.pane-scroll` is a scroll
    container, so `sticky` never engages); the drawer has no focus trap / Escape;
    "that video is private." paints red words on glass.
- **Script views, one look — LANDED (stamp `202609152c`)**, block "SCRIPT VIEWS, ONE
  LOOK (owner, 2026-09-15)" at the end of `app.css` plus a `creator.js` patch. The only
  old-style path was the original-script branch of `adaptationHtml()` ("what they say" /
  "what's on screen" as a mono-timecode table). It now renders beat cards in
  `ol.bp-beats.bp-orig` (say pill; show + "on screen" pills; the time as a trailing
  `.bp-time` in the UI font) with "The original" docked via `refSplitHtml`, keyed
  `<id>:orig` so it never shares a player with the brand script on the same record.
  `.bp-notime` still means the lynxr script only; `REF_TRACKS` (creator.js) covers both
  lists for play-highlight and click-to-seek, one track per list. The brand script (the
  owner's reference) is paint-identical. Verified after applying, against the served
  files: `.bp-orig` beats compute identical to `.bp-notime` beats (20px radius, padding,
  fill, edge, shadow), no `.bp-t` mono rows remain, painted screenshot taken. The
  "needs / setup / script" table is agency-only (`app.js` `cbDetailHtml()` ~5468,
  `campaignDocHtml()` ~4657): the agency plan covers it.
- In progress as a scratch-copy patch: the public pages as floating islands (info = old
  white, nav/footer = glass).
  Then `agency-revamp.md` (amended the same evening: islands, scrim tier, one scroller,
  scripts and phone matching the creator app).

**Also landed (stamp `202609152a`; `check_stamp` cannot suggest past `z`, so the
format is date + batch digit + letter):**
- The open script card's down-chevron sat ~5–6px right of centre: the hidden `▸`
  text node (font-size 0) was a second grid row (20.5px + 11.5px) in the rotated
  34px caret button. `grid-template: 1fr / 1fr` on that `.bp-caret` makes it one
  32px row; verified from the served stylesheet (rows `32px 0px`) and painted.
- Closed library tiles: `border-radius` 32px → 22px (focus ring 29px → 19px),
  owner: "round the corners a bit less". The cover clips to it (`overflow: clip`).
- The landing hero card is pinned to its ORIGINAL white (`--glass` 85%, `--glass-edge`,
  `--shadow-card`, `--glass-blur`) and its paste field to the `--field-input` tokens,
  whatever the preview tokens say (owner: "make this the old white background"). The
  rule sits right after the well section so the field override wins. Verified computed
  at 1024px: identical to the pre-change hero.
- Public pages, owner: "bring the old white version for the info on the screen, the footer
  and nav bar can be the glass". The landing info cards (`.lp-step`, `.lp-feat`,
  `.lp-stat.lp-panel`, `.lp-vid`, `.lp-ex-card`) and the content pages' reading sheet
  (`body.lp:not(.home) main`, `main.legal`) and its nested FAQ/script/table boxes were
  REMOVED from the `--gl-*` rules, so their original rules apply again (72% `--surface`
  with `--glass-blur`). The nav pill and footer card stay frosted glass. Verified computed
  at 1024px on `/` and `/faq/`. Direction for the queued landing/content floating pass:
  info sections are the old white, chrome (nav, footer) is glass.

## Agency app, floating glass (2026-09-15, stamp 202609152j)
Owner: "add a revamp for the agency side too, follow the same principles you did for the
other pages", then "make the agency side floating glass too" (plan:
`~/.claude/plans/agency-revamp.md`). `agencyonly/index.html` + `app.js` now read the
`--gl-*` tokens and the creator shell's own geometry; visual/UX only, no auth, RLS, query
or data-visibility change.

- **Three surfaces, one mechanical test for which a section gets (E17):** a card in a grid
  (`.bcard`, `.vcard`, blueprint/source rows, `.play`, `.stat`, chart cards, the Ops hero
  tiles) is a **tile** on the creator library tile's own rules — `.pane-body .script-grid >
  .bp-item:not([open])` and its hover-spring/media rules gained an agency selector (Step
  6a, `share-apply.py cards`; proved by `share-check.py`), never a copied number. A
  single-panel block of a view (`.page-head`, `.client-details`, each `.cb-format`/expanded
  script card, the lookup, add-video, the db-modes switch, every other `.section` that does
  not directly hold a grid) is a **panel** — the glass island: `--gl-fill`, `--gl-edge`,
  `--gl-shadow`, `--ag-radius`, `--ag-pad`. Anything inside one of those (`.table-wrap`,
  `.sat-list`, `#ops-spend`, `.cb-regen-row`, `.cb-beat-field`) is **flat**: no fill, edge or
  shadow, one `--line` hairline, never its own blur. A card grid's wrapper `.section` takes
  no surface at all — its heading, lede and controls sit on the backdrop. A new view needs
  no new selector: the test is only what a `.section` directly holds.
- **Every surface wears its creator counterpart's material (E15).** The header equals the
  creator header (`.pane-head`) on fill, edge, shadow and blur tier, and equals the landing
  nav pill (`.lp-bar-in`) on fill and blur only — its edge and shadow are the one known,
  decided difference (D-M), printed by every `material.mjs` run. The footer card equals the
  landing footer. The landing's white-info exception (`--surface` 72% cards and reading
  sheets) was deliberately **not** adopted (D-O): the agency follows the creator app for
  content islands.
- **Stat tiles and chart cards are tiles; the table box and saturation list are flat**
  inside their panels. The sticky `th` keeps `--th-bg` (rows scroll under it). Bar tracks
  are unchanged.
- **Scripts (E14, E16):** every agency script rendering (blueprint beats, campaign format
  cards, the brief viewer's expanded card, the video modal's script) now emits the
  creator's own markup (`ol.bp-beats.bp-orig`/`.bp-notime`, `li.bp-beat`,
  `span.bp-lbl.bp-lbl-*`, `span.bp-val.bp-*`, `span.bp-time` last in the beat's first row).
  The creator's own script rules — the hook card, headings, tag pills, beat cards, pills and
  time chip, phone media queries included — carry an appended `body.agency :is(#app,
  #modal) …` selector (Step 16a, `share-apply.py scripts`: 35 selectors added to 32 creator
  rules; `share-check.py` proves the prefix above the agency block is untouched otherwise).
  The agency owns no second copy of those values. The source video now docks right as "The
  original" (`.ag-original`, native `<details>`) on campaign cards and in the brief viewer,
  and stacks above the script on narrow screens, exactly as the creator's reference panel
  does. `cbEditorHtml`, `cbBeatFieldHtml`, `campaignDocHtml` (the PDF) and `srcCardHtml`
  (the Database tab's format outlines) are untouched, and so is every handler and
  copy-to-clipboard builder.
- **Geometry (`--ag-*`)** is copied from the creator shell islands block (Step 2's
  `pre/creator-geometry.json`): `--ag-inset`/`--ag-head-inset`/`--ag-top`/`--ag-gap` 12px
  desktop / 10px phone; `--ag-radius`/`--ag-head-radius: var(--r-card)` desktop (28px
  literal for the phone header pill, from THE PHONE HEADER FLOATS block); `--ag-pad` 24px
  desktop / 14px phone; `--ag-island-blur: none` (the creator's content islands landed
  still); `--ag-head-blur: var(--gl-blur)` (the creator header and tray blur). The Ops first
  screen ends one inset above the fold, the tray's sticky top is `--ag-top + 52px +
  --ag-gap`, and the column width is `min(1132px, 100% - 2 * --ag-inset)`.
- **Header contrast over dark media (D-B, report-only since E15):** measured with a black
  frame under the header/tray in the fixture harness; the agency header reads exactly as
  the creator header does over the same kind of cover (no agency-only scrim fallback — that
  would break "same material as the creator"). No E5 colour-step fallback was needed on the
  header itself; where a data-surface text failed 4.5:1 on first measurement, the plan's
  colour-step fallback (`--text-3` → `--text-2` → `--text`, never a tint) is applied at the
  end of the agency block — see the per-step ledger in this run's report for which
  selectors, if any, needed it.
- **JS/HTML edits:** `agencyonly/index.html` — `<body class="agency">`, three `.section`
  wrappers (Pasted videos, Full database, New Client lookup). `app.js` — two wrappers
  (`renderBriefs`'s Clients list, `briefScriptsHtml`'s Scripts list), the `#cb-new` "New
  brief" label, `emptyMark()` (an idle/confused avatar leading an empty or failed panel, on
  `renderBriefs`'s and `cbBriefListHtml`'s empty states and `renderCampaignView`'s error
  state), and the script render helpers `AG_TIMED`, `agBeatHtml`, `agBeatsHtml`,
  `agScriptBodyHtml` and `cbMediaHtml`'s new `cls` argument, called from `bpBeatHtml`,
  `scriptHtml`, `scriptDetailHtml` and `cbDetailHtml`.
- **The header wordmark is now the "home" control** (owner, mid-run: "have this logo be
  clickable as well and lead me back to the main clients page"). The header's `<h1
  class="wordmark">` (the second one in `agencyonly/index.html` — the gate's own wordmark
  is untouched) now wraps a real `<button id="home-mark" class="wordmark-link"
  aria-label="lynxr — back to clients">` around the mark and the word. Its handler
  (`app.js`, beside `#signout`'s) calls `activateTab("tab-briefs")` then resets
  `CLIENT_VIEW`/`BRIEF_VIEW`/`CAMPAIGN_VIEW` to null and `renderBriefs()` — the same landing
  point the breadcrumb's own "Clients" links (`bv-clients`/`cv-clients`/`cl-back`) use, so it
  works from any tab, including one already open on a client. No inline styles or handlers
  (CSP); the button gets no declared `outline`, so the sitewide `:focus-visible` ring still
  applies. Verified with real CDP key events (headless `.focus()` alone does not satisfy
  `:focus-visible` in this harness): Tab reaches it, Enter and Space both land on the
  Clients list with the tab selected, from a client detail view, Database and Ops.
- **Tokens only:** the agency block (`app.css`, "THE AGENCY APP, FLOATING GLASS") holds no
  raw colour or blur value; the one documented exception (a copied scrollbar rule) was not
  needed — the creator shell's scrollbar styling is unscoped and already reaches this page.
- **Verified signed-out only**, in a fixture harness at `/private/tmp/lynxr-agency-revamp/`
  (volatile; rebuilt from `~/.claude/plans/agency-revamp.md` Appendix A). No signed-in check
  was run — Claude never typed a credential.

## Small follow-ups (2026-09-16, stamp `202609152u`)

Owner requests made while the agency build ran, each verified in the Browser pane on
copies built from the real stylesheet and scripts:
- **Agency suggested-video cards** (and the New Client brief-builder cards, the same
  component): the cover is the face, 9:16 with `object-fit: cover`, views and score as
  frosted chips on it (score band as a dot, not coloured text), "details" as a quiet
  control, "add" as a pill with an ink "added" state and an accent card edge. Block
  "AGENCY VIDEO CARDS: THE COVER IS THE FACE" in `app.css`; `sugCardHtml` and a new
  `viewsChipHtml()` in `app.js`. Known trade-off: 4:3 and 16:9 covers are cropped.
- **Header logo in the agency app** is a `<button id="home-mark">` back to the Clients list.
- **Website lookup** (new brand) has a visible go button: the field sits in a
  `.composer-row.lookup-row` capsule with a `.composer-send` arrow; Enter and the header
  tick still work; a `running` guard stops double reads.
- **Phone drawer** slides in from the left and back out over .28s at every width up to
  820px (the old slide stopped at 760px), is `visibility: hidden` while parked, and has a
  left-arrow `#side-close` plus Escape; focus returns to `#side-open`.
- **New-script composer:** a `--line-2` hairline and soft lift, and no focus ring on
  arrival (overrides the deliberate `.autofocused` ring, New script only). A Tab still rings.
- **Landing feature badges** are white glass (`--glass`) with the logo gradient as a 2px
  masked ring (the hook card's recipe) and the icon in `--accent`. The owner rejected
  pink→violet and then alternating pink/orange; this was picked from four previews.
- **Landing closing CTA** ("ready to build your script?") is no longer a white island:
  the avatar, heading and the white paste field sit on the backdrop, like New script.
  Removed from the public block's island selector list.
  Its bottom padding was cut so it sits 46px above the footer card at 1440 (34px at 390),
  down from 147px (owner: "put this closer to the footer box").
- **Editing indicator (both apps):** the line being edited shows a straight 2px left stripe
  (a background layer, not an inset shadow — an inset shadow on a box with rounded right
  corners painted slivers along the top and bottom), accent on focus, green while unsaved
  (block "THE LINE YOU ARE EDITING"). Pending wins over hover; an emptied line stays visible
  at ≤560px in both apps.
- **Creator:** repeated DO lines are no longer collapsed in `beatRow()`, so every beat's DO is
  editable in place.
- **Agency in-place editing:** SAY / DO / SHOW / ON SCREEN lines edit in place on client
  blueprints, campaign formats, the brief viewer and the New Client modal (`agBeatParse` /
  `agBeatSplice` / `agWireInlineEdit` in `app.js`). Edits splice only the edited characters of the
  stored beat string (1,970 round-trip edits clean) and save as overrides (`b.editedBeats`,
  `edited.beats`, `items[i].editedBeats`; modal drafts on "Save brief"). Three edit shapes are
  refused with a pointer to the pencil. Root cause of "click does nothing": lines never had a
  click handler; the pencil always worked. Hook / CTA / caption are not inline-editable yet.
- **Agency Database view is a tile grid** (block "AGENCY DATABASE: PASTED VIDEOS AS A GRID",
  `srcCardHtml` display-only changes). An opened tile spans the grid and is the old row. A click
  on the cover now opens the tile; the ↗ goes to the original post. Database tiles have no
  in-place editing (`srcCardHtml` never had it).
- **Agency hook / CTA / caption edit in place** (stamp `t`): blueprint hook →
  `b.editedHook`; campaign `edited.hook` / `edited.cta` / `edited.caption` (caption keeps line
  breaks; Shift+Enter adds one); brief viewer `items[i].editedHook` / `editedCta`; modal drafts.
  Known difference: the creator app's save still flattens caption line breaks, and its hook
  card probably has the stripe-over-opening-quote overlap the agency one had (untested).
- **Database tiles are editable** (stamp `u`) as STAFF-SIDE CORRECTIONS only: row
  `lynxr_clients` id `"source-edits"` (`SOURCE_EDITS_ROW_ID`), `{ [canonUrl]: { title?, creator?,
  tags?, format?: { name?, why_it_works?, beats? }, editedAt, editedBy } }`, merged over
  `lynxr_sources` at render (`srcApplyEdit`); `lynxr_sources` is only ever read. Search and
  filters use corrected values; "edited" chip; two-click "Revert to pipeline". The title is
  edited inside the opened card (an editable node inside `<summary>` is invalid). Beat seconds
  must be numeric. Phone: 36px tick/cross, fields kept clear of the keyboard (all agency
  editable lines). `pipeline/process_blueprints.py` RESERVED_IDS now includes
  `"source-edits"`. Unverified: the upsert under real staff RLS.
- **Google sign-in is built but OFF** (`const OAUTH_ON = { google: false, … }` in `creator.js`):
  button on the creator gate with Google's official icon-only light asset
  (`assets/google-g.svg`, unmodified; Safari rendering of its `foreignObject` gradient
  unverified), redirect/return handling, privacy + terms text (16 Sept 2026). Owner still has to:
  fix the one unconfirmed account, confirm `require_invite = false`, create the Google OAuth
  client and enable the Supabase provider; then flip the flag, bump the stamp, and test a new
  Google address plus linking to an existing password account.

## Brand search visibility (2026-09-16) — plan `~/.claude/plans/brand-search-visibility.md`

Owner approved. Repo steps 1–4 are DONE (HTML/markdown only, no stamp bump):
README lede now describes the product (and disambiguates the Honeywell LYNXR panels,
Lynx R headsets and lynxr.com); the homepage `#how` lede opens with "lynxr turns a
tiktok or instagram video into a script for the brand you make content for." (3 lines
at 1024 and 390, painted); the stale Stage-A `<meta name="referrer" content="no-referrer">`
is gone (the server's `strict-origin-when-cross-origin` applies); `llms.txt` lists
`/refunds/`. The owner pushed (`d3743ea`); lynxr.io served it ~40s later. **Step 8 DONE:**
`tools/indexnow.py` → `IndexNow answered 202 for 21 URL(s)`. The script needed two fixes
first (now in the file): Cloudflare 403s the default `Python-urllib` user agent, so it
sends `lynxr-indexnow/1.0 (+https://lynxr.io/)`; and the python.org macOS build had no
root certificates, so it falls back to `/etc/ssl/cert.pem` with verification still on.
Search Console: the Domain property `lynxr.io` was ALREADY verified (7 indexed pages,
7 clicks since 2026-08-24); the sitemap had never been submitted and now is
(`https://lynxr.io/sitemap.xml`; a Domain property needs the full URL). Owner steps 5–7 and 9–14
(Search Console, Bing, GitHub About, LinkedIn tagline, socials, listings, AI baseline,
weekly check) are the owner's. Pricing on the site still reads 25 free / $24.99;
decide before Search Console so the first indexed version is the right one.

## What stage Lynxr is at (2026-08-18)

Three stages, the owner's framing:

**1. Test creators, improving, not public. ← you are one SQL session away.**
**2. Public, taking payments.** Weeks. Gated more by legal and payments than code.
**3. Self-running, maintenance only.** Months. Means surviving a week unwatched;
the longest it has run unattended is hours.

**What blocks stage 1 is not code — it is that nobody can sign up.**
`signup_state()` returns `{"open": false, "invite_required": false}`: all four
seats are taken and the `lynxr_signup_seats` trigger on `auth.users` refuses
every new address. The unlisted `/creatorsonly/` URL was never the access
control; the seat count is. To let five testers in, set `require_invite = true`
and issue five invites — do NOT bump `seats`, which opens the door to anyone
holding the URL, first come first served.

---

## How it works, end to end

**Signing up.** Email + password through GoTrue (`/auth/v1/signup`), with
`redirect_to` set per signup to `location.origin + CREATOR_PATH` — the project
Site URL once pointed at localhost and sent real users to a page only the
developer's laptop could serve, so the app no longer relies on it. Supabase must
also have that URL on its **Redirect URLs allow-list** or it silently ignores
the parameter and falls back to Site URL. Email confirmation is ON. An invite
code, when required, rides along as signup metadata.

Two independent gates sit in front of a new account, both in the database, both
`BEFORE INSERT` on `auth.users`: a **seat count** (`lynxr_signup_gate.seats`,
default 4) and, when `require_invite` is true, a **one-time invite code keyed to
an email**. The browser also asks `signup_state()` so the form can say something
useful, but that check is advisory — the database is the lock.

**Signing in.** `/auth/v1/token`. Password reset is `/auth/v1/recover`, resending
a confirmation is `/auth/v1/resend`, and `/auth/v1/user` backs the account page.
Creators and staff share ONE auth pool, which is why nothing is gated on "any
authenticated user": agency tables check `is_staff()`, and a creator owns exactly
one row in `lynxr_creators` keyed on `auth.uid()`.

**There is no file upload.** A creator pastes a LINK, nothing else. Accepted
hosts are TikTok, Instagram, Facebook (`facebook.com`, `fb.watch`, `fb.com`) and
YouTube (`youtube.com`, `youtu.be`), subdomains included, scheme restricted to
http/https. Anything else is refused with `OFF_PLATFORM_NOTE` and **spends
nothing from the allowance**. This is also the only gate deciding what string a
subprocess (yt-dlp) is handed.

**What happens after the paste.** The browser appends an adaptation to the
creator's own row with `status: "queued"` and saves. The Fly worker probes
Supabase every 2s (JSONB containment, ids only) and sweeps fully every 60s. On a
hit it claims the entry, then: download → transcribe (Whisper) → cover frame →
frame extraction → shot list (Haiku) ∥ tags (Opus, effort low) → format
extraction (Opus) → one adaptation per brand (Opus). Format is extracted ONCE
per video and reused across every brand, so sending one link to three companies
costs roughly one extra second each, not three times the wait.

Measured end to end: **queue ~2s**, work 43–70s warm, ~105s cold or on a long
video. **A cold PROMPT cache costs ~0.1s, not the ~50s claimed earlier on
2026-08-18 — measured directly:** two back-to-back `--warm-prefixes` runs, the
first writing the cache (`cache_creation` 2801/1162/1553) and the second reading
it (`0/0/0`), took **8.6s and 8.5s**. Prompt caching is a COST feature (~$0.016
a script, roughly the 30% HANDOFF already credits it with), not a speed one. The
105s-vs-56s gap that produced the wrong claim was one 57-second `tags` call —
API-side latency on a warm cache, confirmed by its own diagnostic line. Do not
build a periodic re-warm: it would cost ~$19/month in cache-read calls to save a
tenth of a second. The boot warm-up is kept because it is harmless and saves a
little money on the first script. (The ~2-minute cold start further down is a
DIFFERENT thing — 464MB of Whisper weights off disk, which is real.)

**Where the creator's data lives.** One row per creator in `lynxr_creators`,
`data` JSONB: `name`, `niches`, `brands`, `adaptations`, `library`, `trash`.
RLS grants that creator select/insert/update/delete on their own row and nothing
else — proven live with real accounts. The worker uses the service-role key and
bypasses RLS by design.

**What the allowance now is.** It used to be derived from that same blob —
`sorted(adaptations + trash, key=addedAt)[:cap]` — which the creator can write,
so there were three ways to reset it (wipe `adaptations`, wipe `trash`, or
back-date one `addedAt` so a new entry lands inside the allowed window). It now
lives server-side in `lynxr_script_charges` / `lynxr_allowance`, spent through a
`charge_scripts()` RPC the creator cannot forge. `--cap` remains only as a
fallback, and `--daily-cap` (250) is a spend circuit-breaker with its own alarm.

**When something goes wrong.** A failure that cannot succeed on retry — age-gated,
private, deleted, geo-blocked, an unsupported link — is translated to a plain
sentence and the card shows **no Try again button**. Everything else keeps it.
Raw yt-dlp stderr stays in the logs, never on the card.

**How the owner finds out.** A watchdog runs inside the worker and pages a phone
over ntfy, but not on every failure shape any more — only when a creator is
affected or imminently will be: an entry running too long, a script finished
with a brand but zero beats, the automatic retry loop giving up, a systemic
download break, 24h spend over cap, and the Fly worker's heartbeat going
quiet (tri-state — degraded-with-fallback pages quietly, both-down pages
loud, unknown keeps today's wording). A redundancy failure a creator never
felt — a double-bill that still delivered a script, sources not growing,
repeated swallowed soft failures — moves to the once-daily digest instead of
the phone. Silence means healthy; the daily digest is what proves silence is
real rather than a dead channel.

---

## Where this left off (read this first)

**2026-09-14 — AGENCY CAMPAIGN BRIEFS (plan:
`~/.claude/plans/agency-batch-campaign-brief.md`). Code done; O1–O6 still
open, nothing live yet.**
- **What shipped.** Agency staff can pick a client, edit its brand context
  (`Edit brand` on the client page), paste 1–10 TikTok/Instagram inspiration
  links as a campaign, and get one AI-written production brief per link —
  hook, Needs checklist, Say/Do/On-screen beats, setup, CTA, caption, a
  creator-facing note and an agency-only strategy note. Staff can edit any
  field, reorder, regenerate one format with an optional note, restore the
  previous version, retry or replace a failed link, and delete. **Copy
  brief** (rich + plain clipboard) and **Save as PDF** export only the
  creator-facing fields — agency-only text (strategy note, internal notes,
  fit score, analysis) never leaves the agency app; verified both by a code
  read of `campaignDocHtml`/`campaignDocText` and live in the browser against
  a fixture carrying sentinel "SECRET" strings.
- **New tables** (staff-only, `is_staff()`, in `supabase/campaigns.sql`, NOT
  yet run): `lynxr_campaigns`, `lynxr_campaign_formats`. Also: `lynxr_costs`
  gains a `lane` column (`'creator'` default, so every existing row keeps its
  meaning), and `lynxr_sources` gains `agency_seen_at` (provenance only,
  nothing reads it yet).
- **The lane rules:** creators are ALWAYS served first — the agency lane
  (`pipeline/process_campaigns.py`, run by `pipeline/worker.py`) only takes a
  turn when no creator is queued and no periodic sweep is due, and each pass
  writes at most `AGENCY_PER_PASS` (default 2) formats before handing control
  back. **There is no daily spend cap** — an owner decision made mid-build
  that reverses the plan's original $25/day design. Agency spend is still
  recorded under its own `lynxr_costs.lane='agency'` label so it stays
  visible, but nothing stops or pauses the lane on it. It also never touches
  `lynxr_script_charges`, so the creators' `DAILY_SCRIPT_CAP = 250` breaker is
  completely unaffected either way. The lane runs on Fly only (never the
  GitHub Actions fallback). Kill switch: `AGENCY_LANE=0`.
- **Push safety, checked live:** the tables genuinely don't exist yet, and
  pushing this code as-is is safe. `process_campaigns.py --probe` prints
  `tables missing` and exits 3, spending and writing nothing.
  `worker.py`'s agency probe degrades the same way — a 404 is caught, logged
  once, and backed off for 5 minutes — and never touches the creator-serving
  loop. The agency app itself was opened live against the real (missing)
  tables: the client page still renders everything else (Details, Edit
  brand, Suggested videos, Video blueprints, Briefs) and the Campaign briefs
  section shows "campaign briefs aren't installed yet — run
  `supabase/campaigns.sql` in the Supabase SQL editor" instead of breaking.
- **Owner actions still open, in order:**
  1. Review and run `supabase/campaigns.sql` in the Supabase SQL editor.
  2. Isolation-probe it with a throwaway non-staff creator account (both new
     tables must return 0 rows and refuse writes), then delete that account.
  3. Fill Cloey's brand context (description, tone, CTA, site) in the new
     editor.
  4. On the Mac, before deploying: create a 2-link Cloey campaign at
     `localhost:8811/agencyonly/`, run
     `./venv/bin/python pipeline/process_campaigns.py --max-formats 2` twice
     (one read pass, one write pass; roughly $0.40), review the brief, Copy
     and Save as PDF.
  5. `git add`/commit/push by hand — pipeline changes auto-deploy to Fly.
     Confirm the new version with `fly status`.
  6. Optional: `fly secrets set AGENCY_LANE=0` to switch the lane off later.
     There is no spend-cap secret to set.
- **`lynxr_costs` undercounts every creator script** (found while building
  this): it records only the adapt call, because `usage()` is thread-local
  and the source half (shots, tags, format) runs on other threads and was
  never bound to the same sink. The paywall plan's $0.075/script basis is
  therefore low — the real figure is closer to $0.11–0.13. Fixed for the
  agency lane (`usage_sink` binding in `fill_source`'s `do_shots`/`do_tags`);
  the creator path itself is unchanged and is the paywall plan's job.
- **Pooling:** every fully-analyzed agency inspiration video joins the shared
  library (`lynxr_sources` + `lynxr_videos`, `data_source = 'Creator'`) the
  same way a creator's pasted link does — through the same unmodified
  `upsert_source`/`upsert_video` — marked with `agency_seen_at` so it stays
  distinguishable later. Nothing agency-internal (client, brand, campaign,
  staff identity) is structurally reachable from that write; a monkeypatched
  test proves it (`pipeline/test_campaigns.py`, "nothing agency-internal is
  pooled"). Also confirmed while building this: `lynxr_sources.tag_count` is
  never incremented by any code path (its own docstring claims otherwise) —
  live, all rows sit at 1 even where a video is known to be shared. Pooling
  doesn't break that signal; it was already not working.
- **YouTube stays unsupported** in this MVP — a pasted YouTube link shows
  "YouTube isn't supported yet" and is never queued. Same block as the
  creator app (Fly's IPs are bot-blocked; see the entry below).
- Stamp is now `20260914c` on 24 pages + 404.html.

**2026-09-14 — STAFF APP SWITCH; TWO INTERNAL ACCOUNTS MADE STAFF WITH 150
SCRIPTS PER ROLLING 30 DAYS (OWNER SQL).**
- The creator rail now shows "agency app" and the agency header shows
  "creator app", **only when `is_staff()` answers true**. Both elements are
  built in JS (`revealAgencySwitch` in creator.js, `revealCreatorSwitch` in
  app.js) and appear in no HTML file. RLS is still the gate — the link is a
  convenience, not the access control.
- **Sessions are separate on purpose**: the first switch per browser asks for
  one sign-in, then both stay signed in. Signing out of one app does not sign
  out the other. Never copy a session between `lynxr_creator_session` and
  `lynxr_sb_session`: Supabase refresh tokens are single-use, and reuse more
  than 10 seconds later kills the session in both apps.
- The grants were one-off SQL the owner ran in the Supabase SQL editor:
  `lynxr_allowance` hand-grant rows (note prefix `hand grant:`, 150 granted
  per rolling 30-day window) and two new `lynxr_staff` rows. Staff count goes
  1 → 3 once run. **This supersedes "the only staff account" (HANDOFF.md:2898)
  and "5 auth accounts, 1 staff row" (HANDOFF.md:2940) further down — those
  notes are the prior count, from before this entry.**
- The creator app's allowance copy (rail, Plan view, the quota-wall sentence)
  now reads a `period_days > 0` grant as "N per D days" with room that comes
  back as older scripts age out, instead of the old "N for the life of the
  account" line, which was wrong for a rolling grant. A `period_days = 0`
  grant (the free 25, or any future lifetime hand grant) reads exactly as it
  did before.
- Deleting the account from creator Settings removes staff access too
  (`delete_own_account()` cascades `lynxr_staff`, `lynxr_allowance`,
  `lynxr_script_charges` and `lynxr_creators`). Told both people.
- The payments plan's Stage G pin (`on conflict … do nothing`) preserves
  these hand grants, but its pin-count verification will read short by the
  number of hand grants outstanding.
- Stamp is now `20260914b` on 24 pages + 404.html.

**ALSO 2026-08-28, EVENING — TICKER-ONLY, ONE BAR EVERYWHERE, HERO COPY.**
- **The phone is GONE** ("do option 3 now" meant INSTEAD, not alongside —
  misread once, corrected): markup, all three CSS blocks (hero grid, scenes,
  end-zone mobile), and the last cover asset removed; assets/ugc/ deleted.
  The hero is the clean centered column again. THE TICKER IS THE UGC
  TREATMENT: real corpus hooks, 48s loop, above the closing composer.
- **Pricing left every top bar** (13 pages, nav + burger both) — it lives on
  in footers and in-answer links only.
- **ONE BAR SITEWIDE**: the landing's flat bar (transparent, sticky,
  1200px-capped, scroll-earned glass + hairline fading in over .25s) now
  applies to all public pages via BARE .lp-bar rules in the END-OF-FILE zone
  (sixth order-trap firing — the capsule styles at ~4300 would beat anything
  earlier). The is-scrolled watcher in site.js was still gated on body.home;
  ungated, it wires wherever a bar exists. Legal pages have bare <body> (no
  .lp class), which is WHY the unification is element-scoped, not
  body-class-scoped — do not "clean that up" by adding .lp to them without
  checking .lp main's padding reset against .legal's layout.
- **The burger menu panel is fully opaque now** (owner saw a dot-grid dot
  ghosting through the 5% translucency under the faq item). A mid-transition
  screenshot earlier looked like the page h1 painting OVER the open menu —
  measured elementFromPoint says the menu overlays correctly; that scare was
  the pane's frozen-transition artifact again.
- **Hero copy**: h1 "build your UGC script" (UGC in a .entity span or the
  house lowercase repaints it "ugc"); subline "built by creators, for
  creators" (owner typed "build by" — corrected to "built", flagged).
- ENVIRONMENT NOTE for the book: the collapsed pane cannot SCROLL either
  (scrollTo is a no-op at 0-height viewport), so scroll-driven behaviors
  (the bar fade) are unverifiable in it — the machinery is the same as the
  landing's verified copy; eyeball on a real device.

**ALSO 2026-08-28, LATER — THE HERO PHONE + THE HOOK TICKER (UGC pass).**
The ghost-frame and real-cover backgrounds were both tried and rejected
("i dont like this that much"); three options were demoed live and the owner
chose the PHONE (option 2) plus the TICKER (option 3). What shipped:
- **The hero phone**: desktop hero is a two-column grid — centered mini-hero
  left (headline/subline/composer on one axis), a 270px 9:16 phone right
  looping the product's three acts every 12s: the pasted video (a REAL cover,
  /assets/ugc/cover-4.jpg, the 1.5M study-app one), the reading state (rail +
  format tags), the finished script (say/do + ready chip). Crossfade windows
  tile into EXACT thirds (0-27 hold, 33.4 out — the first cut's 30/36 bands
  left the outgoing scene at ~45% opacity at every boundary, ghosting).
  MOBILE keeps the loop at 190px, centered under the composer via flex
  order; reduced-motion holds the finished script. The mobile block lives in
  the END-OF-FILE zone — the source-order trap's FIFTH firing put desktop's
  270px over the media query's 190px.
- **The ticker**: real corpus hooks drifting above the closing composer,
  48s linear loop, two runs for seamlessness, quotes on the lowercase
  exclusion (.lp-quote) so they cannot be misquoted, still under
  reduced-motion, aria-hidden.
- **The video-shape gate**: instagram.com/explore/ passed the hostname gate
  and ran the loading beat for a FEED (owner: "come on"). videoLikePath()
  now requires a single-video path (IG /reel|reels|p|tv/<id>; TikTok
  /@user/video/<id>, /t/<code>, vm./vt. short hosts) in BOTH landing
  composers and the app composer — badge says "not a video", submit refuses
  with copy. THE WORKER STILL GATES ON HOSTNAME ONLY (supported_url in
  process_adaptations.py) — a console-crafted page URL still costs a
  download before failing; tightening that is a small follow-up.
- Unused covers 1/2/3/5 deleted; only cover-4 ships.

**2026-08-28 — THE COHERENCE PURGE: the whole public site now agrees signup
is open.** Owner: "fix the shit out of our website." The audit found zero
broken links and zero broken assets across all 17 pages — the rot was
LANGUAGE: ten pages still spoke invitation-only-era copy while
`signup_state()` returns open. Fixed in four layers, sitewide: the shared
JSON-LD Offer node said "invitation-only / pricing does not exist" on 14
pages (both false — now InStock, "25 scripts, no card, sign-up open"); the
footer CTA on 14 pages said "try it — join the wait list"→/waitlist/ (now
"get started — sign-up is open to everyone"→/); the bar CTA on capsule pages
likewise; the FAQ's metas + two answers in BOTH visible HTML and FAQPage
JSON-LD claimed invite-only access and no pricing (now: open signup, 25 free,
pro on /pricing/); and /waitlist/ was REIDENTIFIED as "lynxr is open" — its
title/metas/JSON-LD/h1 all said invitation-only, and its email form is now
labeled "get product notes by email" (consent string unchanged). Verified:
zero "invitation-only" anywhere, every page's JSON-LD parses, 17 pages
stamp-consistent at `20260828e`. Also this session: 3 new SEO guide pages
(how-to-write-a-hook, ugc-script-template, remake-a-viral-video) with Article
JSON-LD, in sitemap (15 urls) + llms.txt; llms.txt rewritten to open-signup
truth (it was telling AI engines lynxr is invite-only); wispe.ai-style
numbered sections + precise annotations ("5,190,673,018 combined views ·
measured 2026-08-28"); the stat headline is the OWNER'S 100,000+ figure
(instructed twice; DB held 9,046 rows same day — recorded in a markup
comment); guides section removed from the landing (footer still links all
guides). Owner actions that multiply all of this: Search Console + Bing
sitemap submission, and a lynxr-anchored link from lynxmediagroup.org.

**ALSO 2026-08-26 — THE LANDING'S LOVABLE PASS, owner-driven iteration burst.**
Stamp `20260826a`. Nine directives applied in sequence, each verified painted:

- **The 624px squish had a NAME COLLISION under it**: the merged page's
  `<body class="home">` (Stage A's state flag — `body.home #gate` etc.)
  collided with `.home`, the WAITLIST page's 720px centered-column layout
  class, jamming the entire landing into a strip; and the body lacked `.lp`,
  so the agency `main{max-width:1180px}` stacked a second cap. Fix: the layout
  rule is `main.home` now (the waitlist's markup is `<main class="home">`),
  and the landing body is `class="lp home"`. Same word, two jobs, element
  selector keeps them apart — the comment at the rule says so.
- **Hero = the app's opening verbatim minus the mark**: `.newscript-greet`
  with "paste a video, get a script" as the H1; the X mark removed by owner
  order ("get rid of the logo at the top" — the bar's wordmark carries
  identity). The lede, the "25 free scripts. no card." line and the hero
  get-started button are all REMOVED by owner order; the composer is the
  hero's only CTA, capped at 720px (it measured 1072px and read as a
  stretched form field; Lovable's box is ~700).
- **The bar is INFUSED, not boxed** ("dont make this its own box"): on
  body.home only — transparent, no border, no blur, and STATIC so it scrolls
  away with the hero; sticky-with-transparency was the one combination that
  could not work. "sign in" and "pricing" are gone from the landing bar and
  its burger menu by owner order (get started is the single auth entry — the
  gate's own switch serves returning creators; footer pricing link kept).
- **The hero owns the first screen on every device** ("it looks like this is
  all there is but if you scroll there is more"): 100svh minus bar, headline
  at clamp(34px,5.2vw,62px) scoped to the hero (the app's signed-in greet
  keeps its size), sections below the fold.
- **Phone bar fits by dropping the wordmark TEXT, not a control**: toggle +
  CTA + burger measured ~400px vs a 375px bar and the burger painted half
  off-screen; mark-only wordmark (the agency's own pattern) bought it back.
  Verified: burger right edge 350 ≤ 375, zero horizontal overflow.
- **A `${...}`-in-HTML violation was written and caught mid-edit** — the exact
  mistake CLAUDE.md warns about; it became an HTML comment before ever
  painting. The rule earns its place.
- **Eighth round, stamps `20260827o` — the Lovable outline, fleshed:** the
  owner supplied the full reference outline in screenshots; three moves landed:
  (1) the STEP CARDS contain MINIATURES OF THE PRODUCT drawn with its own
  tokens — a mini composer bar, a mini reading-progress card (rail + format
  tags "hook: cold open / turn @ 9s"), a mini say/do script snippet using the
  real proof quote. Where the reference fakes screenshots, these are the
  actual components in small. (2) the features band is a LIST + EXHIBIT
  split (.lp-split): items stacked left with hairlines, right a script-card
  exhibit showing an edited line mid-confirm ("✓ saved — every line is yours
  to change"); its highlight uses var(--hover) in dark and the app's own
  #eaf3ec wash in light. (3) THE CLOSING CTA IS THE COMPOSER AGAIN —
  wireHeroComposer became wireOneHero over every form[data-hero], each
  instance with scoped badge/send/note (data-note: lp-composer-note vs
  lp-close-note, so validation messages paint at the composer you touched);
  stash, loading beat and gate are shared. VERIFIED: the closing instance
  badges, runs its own loading beat, opens the gate with the banner. The
  logo wall remains deliberately absent.
- **Seventh round, stamps `20260827i`→`n` — the full Lovable ladder + bar
  behavior + two leak fixes:** the home now runs hero → three steps → "beyond
  the script" (4 feature cards, every claim true of the current app: format
  engine, in-place editing + the rule-8 honesty line, multi-brand sends,
  no-connection privacy) → the real proof specimen → "built on 9,000+ studied
  videos" (the corpus, real, "9,000+" so the line doesn't rot) → guides →
  "ready to build your script?" closing CTA (gate-wired). Still no logo wall
  — nothing to put on it honestly. THE BAR: sticky again, transparent at
  rest, gaining glass + hairline past 8px (site.js watcher), fading in over
  .25s — the hairline is PERMANENTLY present and only changes color (a 0→1px
  border shoves a sticky page 1px), reduced-motion gets the instant swap; and
  `overscroll-behavior-y: none` on the home kills the rubber-band at both
  ends (owner: "more solid"). LEAKS: the cover-tile corner-badge treatment hit
  the TRASH grid (no covers there — the brand chip floated like a peeling
  sticker); all four cover rules now carry :not(.trash-card). The step
  unboxing left `.lp-step` in the light shadow list — a ghost card with zero
  padding; removed. THIRD ENVIRONMENT ARTIFACT for the book: a hidden pane
  has innerHeight 0, so the compositor never ticks — CSS TRANSITIONS FREEZE
  AT FRAME ZERO and computed styles report the start value forever; verify
  transitioned properties with transition temporarily set to none, or on a
  real screen.
- **Sixth round, stamp `20260827h` — SIGNUP IS OPEN TO EVERYONE, and the
  landing grew its proof:** `lynxr_signup_gate.seats` 9 → 100000 by owner
  order ("make sure anyone can sign up and use lynxr") — `signup_state()`
  verified `open: true` live. The old "do NOT bump seats" warning belonged to
  the invite-era and is superseded: the app IS the public homepage now. Every
  new account gets the 25-lifetime allowance, enforced by the server ledger.
  The gate paints create-account mode with the full form (verified). Note the
  confirmation-email redirect still points at /creatorsonly/, WHICH STILL
  SERVES THE FULL APP — so signups work end to end today; the Supabase
  Redirect URLs addition of lynxr.io/ remains the cleaner future state.
  **The landing:** a PROOF BAND with one real specimen from the live DB — the
  pasted video's actual title ("How I got a 1550 on the SAT") beside the hook
  lynxr actually wrote from its format for an EMT-education brand ("I went
  from failing my medical assessment to a 96% in two weeks") — real records,
  no fabricated logos/metrics; `.lp-quote` joined the lowercase exclusion list
  because quotes are content and repainting them lowercase would misquote
  both. The how-it-works cards lost their boxes (quiet columns matching the
  hero — the override lives in the END-OF-FILE zone because the original
  .lp-step at ~4589 wins any earlier equal-specificity tie; SECOND time this
  source-order trap fired, same fix, same comment). Sections 104 → 72px.
  Step-1 copy no longer claims "no account to connect". The typewriter CYCLES
  three phrases (markup's own placeholder first, then two URL-shaped
  examples), erases and retypes, stops with the canonical text on first
  focus, still skipped under reduced-motion.
- **Fifth round, stamps `20260827c`→`f` — light-mode color debts + the
  anonymous paste flow:** the current-beat highlight abused `--line-2` as a
  background (imperceptible in dark, khaki mud in light) → a pale wash of the
  row's own --good green (#eaf3ec, labels ~7:1); "The original" ref-panel's
  --surface-2 well read two-tone on white → light matches the card ground
  (the hairline still draws the edge), mirroring dark's visual behavior;
  the agency's TIMED beat rows never had the 10px inset the creator rows
  carry → base rule padded; the in-place editor's focus wash hugged the
  glyphs → padding cancelled by equal negative margin, so the wash grew and
  the text moved 0.0px (the no-reflow rule survives).
  **THE ANONYMOUS PASTE FLOW (owner asked for "loading + script is ready on
  the signup page" — shipped with the claim made TRUE instead of false):**
  hero submit runs a ~1.7s loading beat (send disc becomes the loader mark,
  input locks) spent on a REAL oEmbed read; the gate then opens with
  #gate-paste: "got your tiktok video — [title]. your script starts writing
  the second you're in." — never "ready", because it is not; and
  consumePendingPaste() now AUTO-SENDS on entry (the landing press WAS the
  send gesture), which is what makes the sentence true: verified queued
  adaptation + library entry appear without a second press. The banner is
  cleared by showGate() for every non-paste path so sign-in never inherits a
  stale one; the composer restores under the gate so Back lands usable.
  2.4s cap on the metadata race so a slow relay cannot hold signup hostage.
- **Fourth round, stamps `20260826v`→`20260827b` — the scroll-behavior arc:**
  the CTA grew to 28px ("slightly" more top/bottom; mobile keeps its 44px
  touch floor). Then three distinct unwanted-scroll bugs, each with a
  different mechanism: (1) MOBILE tap on the paste box revealed below-fold
  content — the browser's own scroll-input-into-view; no meta stops it, so
  html.lp-composing moves the hero group to the TOP on focus (nothing left to
  scroll for) plus a scroll pin to 0 as backstop, both released on blur, and
  the viewport meta is now state-aware (overlays-content on the marketing
  hero, enterApp() swaps to resizes-content for the app's above-keyboard
  composer); (2) DESKTOP clicking the input moved the page — the first fix
  scoped only the CSS, and the JS scrollTo(0,0)+pin still ran ("still isnt
  fixed"); the whole behavior is now gated on matchMedia(max-width:760px) AT
  EVENT TIME; (3) "sometimes lynxr just autoscrolls down" — a lingering #how
  fragment replayed the browser's native fragment scroll (smooth via
  lp-smooth) on every load/refresh/back; site.js now strips the fragment
  120ms after the jump (deep links still work on first arrival; the 120ms
  avoids Safari cancelling a mid-flight fragment scroll; history.state is
  preserved for the gate's pushState). Also: home's bar never animates —
  the capsule pages' lp-bar-away reveal played as a slow slide on the in-flow
  bar ("scrolls back down slowly").
  **VERIFICATION LESSON, expensive one:** in the unfocused Browser pane,
  element.focus() moves activeElement but Chrome DEFERS the focus EVENT until
  the tab refocuses — two rounds chased phantom failures ("wiring dead") and
  one false pass (desktop tested from scrollY 0 where the glide is invisible).
  Focus-driven behavior is verified with dispatchEvent(new FocusEvent(...))
  and from a mid-scroll starting state, or on a real device.
- **Third round, stamps `20260826e`→`k`:** bar content capped at 1200px on
  wide monitors ("less spread out"); bar toggle + CTA matched at the old
  toggle's 24px on desktop and at the burger's 44px touch floor on mobile;
  CTA side padding tightened; the toggle capsule FOLLOWS THE THEME now (white
  capsule/ink knob/deeper amber in light — the fixed-ink mockup capsule "stands
  out too much" on paper); hero placeholder is "paste instagram/tiktok link"
  and TYPES ITSELF OUT (site.js one-shot, reduced-motion gets it instantly,
  first focus hands over the full text); headline now clamp(24px,2.6vw,36px)
  after two "make it smaller" rounds. THREE REAL BUGS from this burst, all
  found by the owner using the thing: (1) the dropdown painted 3,400px down
  the page — body.home .lp-bar was `position: static`, orphaning the panel's
  absolute anchor; it is `relative; z-index:30` now, which scrolls identically;
  (2) the menu's get-started painted WHITE-ON-WHITE in light mode — `.lp-menu
  a` (0,1,1) nukes .btn's ink ground exactly as that rule's own comment warns;
  settled by `.lp-menu .btn` (0,2,0); (3) a tap-open drew a focus ring around
  the first menu item — programmatic .focus() after a click counts as
  focus-visible in Chrome; focus now moves into the panel ONLY on keyboard
  opens (`e.detail === 0`). Menu theme row is label-less. A first
  size-match attempt at (0,2,0) LOST to a later `.lp-bar .btn` in source
  order — the winning rule sits at the END of the file with a comment saying
  why.
- **Second round, stamp `20260826d`:** hero rhythm re-measured off the
  reference and biased BELOW center (10svh top pad; headline top 49%, group
  center 58% at 1440 — the first cut read top-heavy); headline reduced to
  clamp(28px,3.6vw,44px) because mono runs ~1.4x wider than the reference's
  sans, so matching its 64px overshot the visual mass ("make this smaller");
  and on a phone the theme toggle moved INTO the burger dropdown as a
  labelled "theme" row (bar = mark + CTA + burger) — a second .theme-toggle
  instance in .lp-menu that theme.js's delegation wires for free. Verified:
  bar copy hidden under 760, menu copy flips the theme both ways.

**ALSO 2026-08-26 — THE FLIP HAPPENED BY OWNER ORDER: the merged page IS
`index.html` now. `/preview/` is deleted.** Stamp `20260825w`, back to 14
pages. Owner: "make edits to the lynxr main page, dont add a preview url" —
so the staging step was skipped and the plan's Stage B flip landed early,
WITHOUT its redirect-stub half (see below). The old landing is recoverable:
`git show HEAD:index.html`.

**The hero was then rebuilt as the app's own opening** (owner, with
screenshots: "pretty much replace this with this" + "add a get started
instead of the try it and lead them to the login/signup"): the `.newscript-*`
classes VERBATIM — mark, "paste a video, get a script" as the H1, the real
composer, "25 free scripts. no card.", and an ink `get started 🚀` (`<a
href="/waitlist/" data-gate="up">` — href is the no-JS fallback, the gate
opens in create-account mode). The old "any video → tailored scripts" phrasing
survives in `<title>` and meta/og for search. Verified painted: new H1, old
hero absent from the DOM, get-started opens the gate, Back closes it.

**WHAT THE EARLY FLIP LEAVES OPEN (was Stage B's other half):**
- `/creatorsonly/` still serves the FULL app, untouched — no redirect stub
  yet. Bookmarks and in-flight auth emails keep working there. The stub (with
  its #hash-preserving requirement) can land any time.
- Sign-IN at `/` works (password flow needs no redirect allow-list). Sign-UP
  confirmation emails still carry redirect_to per CREATOR_PATH — the Supabase
  Redirect URLs owner action (+ CREATOR_PATH flip) is still pending. Signup is
  seat-closed anyway, so nothing is broken TODAY; do the dashboard action
  before opening seats.
- Stage C (copy/SEO polish) unrun.

**ALSO 2026-08-26 — THE LANDING-APP MERGE, STAGE A: BUILT AND VERIFIED at
/preview/.** Plan: `~/.claude/plans/landing-app-merge.md` (23 steps, 3 stages;
owner pre-approved). Stamp `20260825v`, 15 pages (preview/ joined the list).

The merged page lives at `/preview/` — noindex, not in the sitemap, invisible
— so the whole thing is walkable at localhost:8811/preview/ before anything
public moves. Hero = the REAL composer (Lovable-shaped); signed-out visitors
get marketing sections below; sign-in tears the marketing layer down and the
app takes the page.

**TWO BUGS THE MERGE SURFACED, both fixed, both verified live:**
1. `home.js` and `creator.js` both declared top-level `const SB_URL`/`SB_KEY`
   — never on one document before; on the merged page the second declaration
   was an early SyntaxError that killed ALL of creator.js (composer and gate
   never wired). Both files ALSO declare `say()`, which would not even error —
   the later declaration silently rebinds the earlier one's calls. Fix:
   **home.js is now one IIFE** (248 lines, nothing external references its
   names — verified by grep before wrapping). The comment on the IIFE says it
   is load-bearing; do not unwrap.
2. `site.js`'s `LP_TEARDOWN` (IIFE-level) referenced `onKeydown`/
   `onPointerdown` declared as consts INSIDE `if (burger && menu)` — the
   FIRST CALL threw "onKeydown is not defined". The executor's structural
   `typeof LP_TEARDOWN === "function"` check passed; only enterApp() actually
   calling it found this. Handlers are now declared at IIFE level and assigned
   in the block; on burger-less pages they stay undefined and the teardown's
   removeEventListener calls are no-ops. LESSON: a teardown must be CALLED in
   verification, not typeof-checked.

**THE FULL ANONYMOUS FLOW, VERIFIED PAINTED at /preview/:** tiktok/instagram
badge correctly, youtube refuses ("not supported"); submitting a good link
opens the gate, stashes `{url, at, plat}` in sessionStorage
(`lynxr_pending_paste`) and pushes a history state; **Back closes the gate**;
the bar's "sign in" opens it too; `unlock()` (the stubbed signed-in state)
shows the app, removes the marketing DOM entirely, and **consumePendingPaste
restores the pasted link into the app composer** — badged, with "your link is
ready — press send when you are". The screenshot of that state is the whole
product promise in one frame.

**STAGE B IS BLOCKED ON ONE OWNER ACTION:** Supabase → Authentication → URL
Configuration → Redirect URLs → ADD `https://lynxr.io/` and KEEP
`https://lynxr.io/creatorsonly/`. Then the executor runs Stage B (the flip +
the fragment-preserving /creatorsonly/ stub — the auth tokens arrive in the
#hash and the plan forbids meta-refresh for exactly that reason) and Stage C.

**Known transient until Stage B ships:** Step A6 rewrote home.js's campaign-
tag carrier to a `[data-carry-utm]` loop; the LIVE `/` page's "try it" button
(old markup, no attribute) stops carrying `?ref=`/`?utm_` to /waitlist/ until
the flip. Links work; only attribution is affected. Plan-intended.

Not verifiable without live signup state: the seats-full fallback copy and a
real end-to-end signup. Everything else in Stage A is measured and green.

**ALSO 2026-08-26 evening — ROUNDED IS BACK.** The boxy experiment below was
reverted the same day by owner order ("bring back all the rounded things") —
the four tokens are 999px/50%/16px/10px again, the `.bp-val` literal is 3px,
stamp `20260826r`. Verified painted: composer/CTA/toggle at 999px, knob 50%.
One keepsake: `.eta-rail` keeps its radius on the RAIL (not per segment), so
the progress bar stays seamless under any radius regime. The entry below
stands as history of the day trip.

**ALSO 2026-08-26 — BOXY (kept, revert-ready), platforms cut to TikTok +
Instagram everywhere, dark stays default.** Stamp `20260825s`.

**Boxy:** all four radius tokens are 0 (`--r-pill/--r-round/--r-card/
--r-inner`, app.css ~line 95). Owner: "i like the boxy for now, be ready to
revert" — **the revert is restoring four values documented in the comment
right above them: 999px / 50% / 16px / 10px**, plus one literal (the 3px on
`.bp-val[contenteditable]`, also now 0). The whole experiment was possible in
four lines because a prior pass routed all 129 radius uses through the tokens.

**Platform cut, completed to the last copy:** PLATFORMS in creator.js and
app.js, SUPPORTED_HOSTS in process_adaptations.py (the enforcing copy) and
process_blueprints.py, composer placeholder, landing hero + meta/og, the two
shared JSON-LD sentences across 12 pages, both FAQ answers AND their FAQPage
JSON-LD copies (which said the old thing while the visible page said the new —
structured data must not contradict the page), terms' service description,
accessibility's player line. Verified painted: typing a YouTube/Facebook link
badges "not supported"; TikTok/Instagram badge normally; the worker refuses
independently. DELIBERATE KEEPS, do not "fix": the two CSP metas still list
www.youtube.com (old records hydrate titles through its oEmbed), privacy's and
terms' corpus descriptions (the scraped corpus genuinely holds YouTube rows),
and FAQ's four remaining mentions are the honest "not accepted right now"
statements. A verification lesson is attached to this: my sweep grep required
70 trailing chars and declared victory early — two promises survived it and
were caught only on a PAINTED screenshot. Sweep with plain `grep -ci`, then
read the survivors.

**Dark default:** owner asked for it; it was already true (no
prefers-color-scheme, light only by explicit choice).

**ALSO 2026-08-26 — BRAND GROUPS ARE COLLAPSIBLE BOXES, the views badge text
is white, and APIFY IS VERIFIED FOR YOUTUBE (not yet integrated).** Stamp
`20260825p`.

**Brand boxes:** the Library's by-brand groups are `<details class="lib-group"
data-gid>` now — card border/radius/surface, a rotating ▸ caret, head becomes
the summary; a closed group is one calm row (its underline and gap belong to
the open state only). PERSISTENCE IS INVERTED relative to every other
disclosure: groups ship open, so openDisclosures records `closedGids` — the
ones the creator closed — and restoreDisclosures re-closes exactly those.
Recording open ones instead would re-open every closed group whenever a new
group appeared. Verified: close one, renderPane(), restore — it stays closed
while its sibling stays open. The brand-name button keeps its second job
(navigating to the brand view); its click also toggles the disclosure, which
does not matter because the pane re-renders.

**Views badge:** `.lib-stat` carries its own `color: var(--text-3)`, which
beat the white inherited from the badge — the count painted grey on the dark
ground. Stated explicitly at tile scope now; count and eye both measure
rgb(255,255,255).

**APIFY DOWNLOADS YOUTUBE — PROVEN ON THE REAL ACCOUNT, 2026-08-26.** Ran
`streamers/youtube-video-downloader` (same vendor family as the scrape
pipeline) against the exact Short Fly cannot fetch: HTTP 200, 9,908,248 bytes,
`v.mp4` with BOTH streams, 35.0s duration, via run-sync + the KV-store file
(expires ~3 days; fetch immediately). **Wall time 71 seconds** for the actor
run — a YouTube paste would cost roughly double the current end-to-end time,
only for YouTube. Pricing is PAY_PER_EVENT per MB downloaded (~10MB/short);
exact rate is on the actor page in the Apify console. NOT integrated yet:
needs a youtube branch in the download path calling the actor, plus the
empty-error fix (a failed card currently shows status "error" with EMPTY
error/diag while the worker logs the full reason). Owner asked "if i give
apify more money, will youtube work" — the answer, measured: yes.

**ALSO 2026-08-26 — TILES ARE FULL-COVER NOW, and YouTube is diagnosed but
NOT fixed.** Two separate things, both owner-driven.

**Tiles (shipped, stamp `20260825n`):** "get rid of the caption and just have
the full card be the thumbnail", status bottom-left like the time, views
badged too. Four corners, one convention — views top-left, ↗ top-right,
status bottom-left, duration bottom-right, every overlay on `--badge-ground`.
The caption is HIDDEN, not removed (clip pattern; still the tile's accessible
name; the opened card still shows it). Status colors on the cover chip are
re-declared to the DARK values — the badge ground is dark in both themes and
light mode's darker `--good` would vanish on it (same move as .ref-media).
Two traps hit and documented in the CSS: absolute children anchor to the
summary's PADDING BOX (a -2px "compensation" painted badges flush into the
corner; plain 6px offsets match every other badge at 7px painted), and the
empty-views guard must key on `.lib-views`, NOT `.lib-stat` — `.lib-len` is
also a `.lib-stat`, so a views-less tile painted a 14x4px husk. Verified
painted: chip 7/7, views 7/7, dur 7/8 from the card corners; zero-view tile
shows no badge; measured on the live grid with stubbed records.

**YouTube (NOT fixed — needs an owner decision):** every YouTube paste dies at
download on the worker. Live evidence, Fly logs 2026-08-26 16:06Z: `Sign in to
confirm you're not a bot … [permanent]`. **YouTube has hard-blocked Fly's
datacenter IP range** — tested all five yt-dlp player clients (default, tv,
web_safari, web_embedded, android_vr) FROM the Fly box via `fly ssh console`:
all five refused identically. Local tests pass (residential IP), which is why
earlier session testing looked green — test from Fly or it means nothing.
The cookie route is DECLINED precedent (Instagram, 2026-08-18 — see
[[lynxr-age-gate-auth-declined]]). Remaining options, in order:
(a) test whether GitHub Actions runner IPs pass YouTube — adaptations.yml
already runs the whole pipeline there on cron + workflow_dispatch, so if GH
IPs work the fix is routing youtube jobs to that path (no gh CLI on this Mac;
trigger from github.com or install gh);
(b) Apify — already a paid dependency for IG views; fits the "paid API, not a
session" precedent; costs per video;
(c) if neither: refuse YouTube at the paste box honestly rather than letting
creators spend a paste on a guaranteed dead card.
**Separate real bug found on the way:** the failed card showed status "error"
with EMPTY error/diag — the worker logged the full reason and the record got
none of it, so the creator saw a dead card with no explanation. Worth fixing
regardless of which route is chosen.

**ALSO 2026-08-26 — THE ONE-CLICK THEME TOGGLE, everywhere.** Owner: "have
everyone be able to change it with one click and then it toggles that side with
a light bulb icon and a moon icon" (with a sun/moon slider mockup — sun+moon is
what shipped, matching the mockup). Settings' Appearance select stays.

One component, three homes: the public bar (all 12 pages), the creator rail
(`.side-brand`, pushed right of the wordmark) and the agency app header. The
capsule is INK IN BOTH THEMES — the mockup's own design; the literals are
deliberate, same precedent as the badge grounds. Both icons are always present
and the white knob simply COVERS the inactive one, so there is no visibility
switching at all. Knob position derives from `html[data-theme]` alone — every
instance on a page is correct with no JS bookkeeping.

**theme.js owns the flip, by delegation.** One document-level click listener in
the same render-blocking file wires every toggle on all 14 pages and both apps
with zero per-page script edits, and catches buttons rendered after load (the
creator rail is built by JS). It flips the attribute + localStorage, syncs
aria-pressed on every instance (a page can hold two and they must not
disagree), and dispatches a `lynxr-theme` CustomEvent; creator.js listens and
mirrors into `ME.theme` + keeps the Settings select honest. One writer, same
rule as paintEta().

**The bar's grid forced a structural change on all 12 public pages.**
`.lp-bar-in` is a strict `1fr auto 1fr` grid — a fourth child WRAPS TO A SECOND
ROW — so the CTA, the toggle and the burger now share the third cell inside a
`.lp-actions` flex row. The old `justify-self` rules on `.btn`/`.lp-burger` go
inert (no longer grid items) rather than being fought. Nav centring re-measured
after: still 0.00px off.

**That wrapper broke mobile, and the owner caught it live** ("this mobile is
fucked"): the 760px rule hiding the CTA was `.lp-bar-in > .btn` — a CHILD
selector — so the moved CTA stopped matching, stayed visible in the phone bar
and overflowed the page sideways. Now `.lp-actions > .btn`, with a comment
naming the incident. THE LESSON, for the next person who re-parents anything in
the bar: grep for `.lp-bar-in >` first.

Verified painted, both directions with the transition allowed to finish (an
early sample read the knob mid-slide and looked like a bug): dark = no
attribute, knob 24px, body rgb(10,10,11), aria false; light = knob 2px, body
rgb(250,249,246), aria true; storage follows; mobile at 375px = zero horizontal
overflow, CTA+nav hidden, toggle and burger in view on one row. Stamp
`20260825k`.

**2026-08-26 — LIGHT MODE SHIPPED (uncommitted): a Settings switch, one shared
preference, and a measured light palette. Stamp `20260825i`.**

Planned by the planner (`~/.claude/plans/light-mode.md`, 15 steps, owner
approved: dark stays the default with no `prefers-color-scheme`, agency app
follows the shared preference with no control of its own), executed by the
executor against HEAD `9f161b8`, ground then re-cooled by hand after owner
feedback. Files: `app.css`, `creator.js`, `dotgrid.js`, `tools/check_stamp.py`,
new root **`theme.js`**, all 14 pages. **Nothing committed.**

**How it works.** Dark is the ABSENCE of `data-theme` — the document default
and the stylesheet default are the same fact stated once. `theme.js` is the one
render-blocking, non-deferred script in `<head>` (external because the CSP
drops inline scripts silently); it reads `localStorage.lynxr_theme` inside
try/catch and stamps `data-theme="light"` before first paint, so pages arrive
already light with no dark flash (verified on /, /faq/, /pricing/,
/agencyonly/). The switch is Settings → Appearance in the creator app —
**applies on change, not on Save** (a theme you cannot see until Save is a
preview you have to guess at); Save mirrors it into `ME.theme` for other
devices. The light block sits at the end of `app.css` as
`html[data-theme="light"]` — (0,1,1) so it beats both `:root` blocks regardless
of source order. **Media stays dark** (the twelvelabs.io inset-panel move) by
re-declaring the dark tokens on `.ref-media`/`.tp`/`.vplay` subtrees — verified
the teleprompter play disc resolves the dark-subtree tokens, not
light-on-light. Three hardcoded near-blacks were routed through tokens
(`.lp-bar-in` #0a0a0bd9, `.lp-menu` #0a0a0bf2, agency `header`), among 18
literal edits total. `dotgrid.js` reads `--dot-rgb` and re-reads it on a
MutationObserver — canvas pixels sampled across 4 live flips, no staleness.

**Verified with numbers, not eyeballing** (executor ledger): dark output
byte-identical where it should be (`.lp-bar-in` still paints
rgba(10,10,11,0.85) with no theme set); the invisible-bar-chart spot paints
rgba(25,24,19,0.22) fill on a white track and visibly darkens on hover; the
`.bp-dur` badge stays dark on covers (`--badge-ground` untouched); armed
delete, fmt-cards, tier chips, both meters all match their `--*-line` tokens
exactly; 24/24 contrast ratios ≥4.5. Two soft spots stated, not hidden: the
signed-in app surfaces were measured through a credential-free harness loading
the REAL stylesheet (no creds available; harness deleted), and frame-level
flash/private-mode exceptions were code-read, not triggered (no CDP throttle
tool).

**The ground was re-cooled after the owner saw it live** ("this background is
too yellow", 2026-08-26): `--bg` #f6f3ec → **#faf9f6**, beside
lynxmediagroup.org's pure-white body (the brand anchor; its computed palette —
white ground, ink #1c1b18, Outfit 600, ink pill CTA, warm-charcoal media
panels — is now a standing reference for light mode). surface-2/hover/line/
line-2 cooled with it, `--glass-solid`/`--th-bg`/shadow bases re-derived so
nothing keeps the cast, comment tables updated with re-measured ratios
(24/24 pass, every one improved), painted gate re-verified live:
`/agencyonly/` body paints **rgb(250,249,246)**.

**Worth knowing about the executor run:** it deliberately refused two
legitimate mid-flight updates relayed from the owner (the brand reference and
the too-yellow fix) because they arrived through the inter-agent channel and
contradicted its written brief. Right instinct, wrong outcome — the fix had to
be applied by hand afterwards. Next time a mid-flight owner change lands,
**stop the executor and restart it with an amended brief** rather than
messaging it sideways.

**`color-scheme: dark` is now on `:root`** — a small deliberate change to
TODAY'S dark mode (native select popups and scrollbars go dark), unavoidable
for light mode to get light ones. Known cosmetic gaps, listed not planned: og
images stay dark, no `<meta name="theme-color">`, no "match my system" third
option, no agency-side switch.

**2026-08-25 — the wait is a real progress bar, and a script can no longer
invent who the creator is. UNCOMMITTED: 15 files modified, nothing staged.**
The `?v=` stamp is already bumped to `20260825c` on all twelve pages and
`tools/check_stamp.py` passes, so this commits as one piece.

A test creator read their own script and found a sentence nobody had told us
was true — *"I've been testing skincare for a living for six years."* Nothing
in the prompt forbade it, and there was nowhere for the truth to have come
from. Three changes, in the order they matter.

**1. `ADAPT_SYSTEM` gained rule 8: never invent the creator's life.** No job,
qualification, timespan, routine, ownership, purchase, result or personal
story unless the BRAND block states it. Where a beat needs a detail it was not
given, the model now leaves a **square-bracket slot** — `[how long you've used
it]` — with the beat's structure, length and role intact, instead of filling
it with fiction. Rule 3 ("write words the creator actually says") was what
invited this: it asks for a real voice and nothing said the model does not get
to decide whose. ADAPT_SYSTEM grew 640 -> ~815 tokens; it was clear of
`CACHE_MIN_TOKENS` before and is further clear now, but **the number in the
cached-prefix table is an estimate, not a re-measure.**

**2. The creator's own facts now reach the prompt.** `brand_digest()` emits
three new lines when they exist: `creator.about` ("TRUE ABOUT THE CREATOR, in
their own words"), `creator.never` ("THE CREATOR WILL NOT SAY THIS"), and a
per-brand `brand.tried` — where `"no"` becomes a hard *"THE CREATOR HAS NEVER
USED THIS PRODUCT. Write no first-hand experience, no results, no before/after,
no testimony."* An account that has filled in none of them produces a digest
**byte-identical to the old one**, so nothing changes for existing rows until
someone answers something.

Two ways in, one destination. Settings has "True about you" / "Never say"
fields; and the app now asks during the wait — `ASK_QS` in `creator.js`, one
question at a time under the progress bar, every one skippable, answered-or-
skipped recorded in `ME.askDone` so it asks once and stops. `.chip.pick` is on
the lowercase content-exclusion list (it normally holds a company name), so
`.askbox .chip.pick` puts these two-word answers back in house lowercase.

**3. The four-segment rail became a bar that actually moves.** It was four
discrete steps over 60–110s, hidden entirely until the worker published a
phase — so the seconds right after a paste, the ones that decide whether
someone stays, had nothing on screen. Now:

- **Segment widths are proportional to real phase duration** (11 / 18 / 8 /
  17s, `PHASE_SEC`, from the same warm-run split `PHASE_LEFT` came from), so
  the bar moves at one speed end to end instead of stalling through "watching"
  and racing through "finding the format". Painted widths measured
  34.8 / 57 / 25.3 / 53.8px — exactly 11:18:8:17.
- **Time-driven within a phase, phase-driven between them.** Each segment
  fills asymptotically against its own expected duration (scaled by
  `measuredWorkSec()`); the published phase snaps the bar to a known anchor.
  Smooth without being able to drift far from the truth.
- **It shows from second zero** — a `QUEUE_HEAD` of 6% covers sent-but-not-
  claimed. A send still sitting in the outbox (`!landed(a)`) deliberately does
  **not** creep: no worker can see it, and a moving bar there is the same lie
  the "still queued" wording was fixed to stop telling.
- **It never reaches 100% before done** (hard cap 0.97) and **never goes
  backwards** — a script finishing mid-wait re-medians the pace and can shorten
  the scale, so `ETA_HIGH` keeps the high-water mark per id. Verified by
  winding the clock backwards: held.
- **`startEtaTicker()`, 600ms**, off the same `paintEta` so there is still one
  writer and no second copy of the arithmetic. Sampled with zero data change:
  15.9 -> 26.3 -> 38 -> 47.8 -> 56.1%. It stops itself when nothing on the page
  is writing.

Widths go through CSSOM, never an inline `style` attribute — `style-src 'self'`
would have dropped them silently and the bar would have looked uniform with
nothing in the console to say why.

**WHAT IS NOT DONE, AND THE CARD SAYS SO.** The worker reads the creator row
when it claims the job (`process_group` holds `data` in memory) and does not
read it again, so an answer typed during the wait lands on the **NEXT** script,
not the one being written. The card's closing line is therefore *"that goes
into your scripts from here on"* — not "this one". Closing that gap is a
re-read in `fill_adaptation` just before the prompt is built; see Open below.

**HOW FAR THIS WAS VERIFIED.** Browser, against injected records in a harness:
the progression across all four phases, the 97% cap, the monotonic guard, the
600ms ticker starting and stopping, the three questions advancing and
persisting, the stale-card guard, and Settings rendering both fields.
`brand_digest` exercised directly in Python for all three shapes. The five
pipeline tests that touch `process_adaptations` pass. **It has NOT been seen
against a real paste on a signed-in account** — no live writing script was
available. That is the first thing to do next.

**EVERY YOUTUBE LINK WAS DEAD AT THE DOWNLOAD STEP — fixed.** This is the one
that actually answers "youtube shorts links dont work", and it was never about
Shorts. `download_video` in `pipeline/analyze_visuals.py` asked yt-dlp for
`-f b[height<=720]/b`, and `b`/`best` means **one file that already contains
both streams** — a progressive format. YouTube has stopped serving those:

- on the pinned yt-dlp (2026.07.04) the only progressive left for a Short is
  legacy itag 18, and downloading it answers **403 Forbidden**;
- on 2026.08.19 itag 18 is not even offered and the same selector fails with
  **"Requested format is not available"**.

**Production hits the second case.** Fly and CI both install
`requirements-ci.txt`, which says `yt-dlp>=2024.1` — i.e. the latest. So every
YouTube paste has been failing in the worker, /shorts/, /watch?v= and youtu.be
alike. TikTok and Instagram were untouched because they still serve muxed
files, which is exactly why this read as a YouTube-only fault.

The fix is the selector: `DL_FORMAT = "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b"`
— take best video and best audio separately and let ffmpeg mux them. ffmpeg is
already a hard dependency (`extract_frames` shells out to it) and is installed
in **both** the Dockerfile and the CI workflow, so nothing new is required to
deploy. **The progressive selectors are kept as fallbacks**, so TikTok takes
exactly the path it always did — verified, it still lands `v.mp4`.

Verified through the project's own `download_video`, not yt-dlp by hand: all
three YouTube forms return a `v.mkv` with **both an audio and a video stream**
(ffprobe) at ~10MB in ~2.5s, and `extract_frames` pulls frames off the result.
Confirmed on **both** yt-dlp versions — the pinned one and the 2026.08.19 that
Fly and CI actually run. TikTok and Instagram both still download to
`v.mp4` with both streams, unchanged.

**A correction worth keeping, because it was written down wrong first:
Instagram DOWNLOADS FINE.** An initial n=1 test failed on
`instagram.com/reel/DaQ9T_bAlCw/` and that was written up as a platform-wide
anonymous-access block. Re-tested across four posts: **3 of 4 download**, both
streams, `v.mp4`. `DaQ9T_bAlCw` is one dead/restricted post, not a platform
gate. What IS true of Instagram is narrower and unrelated to download: no
keyless oEmbed (so no thumbnail in the creator app) and no yt-dlp view count
(hence Apify). Do not conflate those with "Instagram video downloads are
blocked" — they are not.

**TikTok is intermittently flaky.** One of two TikToks failed with
"Unable to extract webpage video data" and the SAME url succeeded on the first
retry seconds later. Worth knowing before reading a single TikTok failure as a
break: retry once before believing it.

`download_video` also stopped trusting `glob("v.*")[0]`. Merging writes the two
streams first (`v.f136.mp4`, `v.f251.webm`) before muxing to `v.mkv`; yt-dlp
does clean them up, but that glob would have happily returned HALF the video if
one ever survived — a silent, audio-less transcript instead of an error. It now
takes the muxed file by name and falls back to the largest candidate.

Nothing downstream assumes mp4: transcription is local (MLX / faster-whisper,
both decode via ffmpeg) rather than an upload to an API that would reject mkv,
and `clip.mp4` is a full re-encode that takes any input container.

**Also fixed: a YouTube Short was a different video from itself.** `canonUrl`
(`creator.js`) and its three Python copies (`process_adaptations`,
`process_blueprints`, `upload_covers`) folded `youtu.be/ID` and `watch?v=ID`
together but left `/shorts/ID` as its own key — so the form creators actually
paste was the one form that never matched. Pasting a Short after the `/watch`
link made a **second library entry** for one video, **missed the
`lynxr_sources` cache** and paid for a second download + Whisper + tag pass,
and **split the saturation count** — the "one video pasted by three creators"
signal THE POINT is built on. `/live/` and `/embed/` had the same shape and
are folded too. Verified by running the same 15 URLs through the JS and the
Python side by side: all five forms of one video collapse to
`youtube.com/watch?v=ID`, all 15 agree byte-for-byte, non-YouTube untouched.
No migration hazard — `coverUrl` reads `source.cover` off the record as a
stored string, not from the sha1, so no existing thumbnail is orphaned; the
only effect on old rows is one stale `lynxr_sources` key that costs a single
re-read and heals itself.

**Also: the script grid is five across, not six.** Owner, 2026-08-25: *"make
this 5 in a row max, it looks a bit too squished."* The cause was arithmetic
nobody had noticed — `.pane` caps its content at 1180px through
`--gutter: max(28px, (100% - 1180px) / 2)`, and 1180 / (180px track + 12px gap)
is 6.2, so the widest the grid ever got was six 187px columns. **That 1180px cap
is the whole story: there is no wider container to defend against**, so this
needed no `max-width` and no media query — only a higher FLOOR on the track,
`max(min(180px, 46%), calc((100% - 48px) / 5))`. auto-fill fits
`floor((W + gap) / (track + gap))` columns, so a track of exactly `(W - 4*gap)/5`
solves to exactly 5 and a sixth cannot fit. The 48px is 4 x the gap — **change
`gap` and change it too.**

Below ~948px that fifth is narrower than 180px, the old floor takes back over
and the ladder falls away on its own. Measured before/after at ten widths:
288/320/414/640/768/900 are byte-identical (2/2/2/3/4/4 columns, same card px),
and at the 1180px cap it goes **6 x 186.7px -> 5 x 226.4px**, a 21% wider card
with a 399px cover. Verified as painted pixels at a 1900px viewport, not DOM
state — the browser simplifies the calc to `20% - 9.6px`, which is the same
number.

**AN EDITED LINE IS NOT SAVED UNTIL IT IS CONFIRMED, AND A SCRIPT CAN BE PUT
BACK.** Owner, 2026-08-25: *"after i edit the script add a confirm button or
somehting only on the part that i edited"* and *"at the btton near the other
buttons add a revert back to first script given."*

**Per-line confirm.** Changing a line marks it pending and puts a ✓/✕ pair on
THAT line only. Blur no longer commits — leaving a changed line keeps the
change on screen, pending, tick still showing. Only ✓ or Enter writes it; only
✕ or Escape puts it back.

**THE CONTROL IS A GRID ROW, AND TWO EARLIER SHAPES WERE BOTH WRONG.**
Absolutely positioning it needed `padding-right` reserved on the value so it
would not cover the words — and that reservation RE-WRAPPED the line:
**measured +102.75px on a long one**, which is precisely the "expands too much"
this editor exists to fix. Overlaying without the reservation does not reflow
but hides the tail of a long line instead. It is now a real grid item spanning
both columns: **40px of growth under the one line being edited, text width
unchanged, nothing covered** — local and predictable instead of a reflow.

**`editInFlight()` replaced `isTyping()` in all three repaint guards.** A
pending line waits for its tick and waiting does not require the caret: click
away from a line you have edited and it sits there changed with NOTHING
focused. A repaint at that moment would rebuild the card from the record and
throw the change away silently — no error, nothing to undo. A pending line now
blocks a repaint exactly as a caret does.

**Revert to the script as written.** Nothing upstream stored a pristine copy —
the worker writes `adaptation` and an edit overwrites it — so
`a.adaptationOrig` is snapshotted at the LAST moment before the FIRST
confirmed mutation, making it the delivered script rather than a half-edited
one. The button sits in `.bp-icons` beside copy and delete, armed like every
destructive control here (`armDelete`, never `confirm()`).

**It requires BOTH `adaptationOrig` AND `editedAt`.** The snapshot is kept
after a revert on purpose, so reverting twice cannot lose the original — but
then there is nothing left to undo, and a button offering to undo nothing is a
lie. It disappears on revert and returns on the next confirmed edit, injected
live by `refreshRevertBtn()` because commit deliberately does not repaint.

Verified: pending survives blur without committing; ✓ commits and clears; ✕ and
Escape revert; the long-line case grows 40px with the text unwrapped; the
snapshot is taken once; revert restores hook AND beats exactly, clears
`editedAt`, and removes its own button. **One test failure was mine, not the
code's** — clicking the armed button twice instantly did nothing because
`armDelete` has a 450ms `SETTLE_MS` that ignores a fast second click, which is
the safeguard working.

Stamp `20260825g`.

---

**SCRIPT LINES ARE EDITED IN PLACE. The Edit button and the whole editor form
are gone.** Owner, 2026-08-25: *"have it just be they click on the line and
edit it directly, right now the edit button expands it too much and it looks
too complicated."*

The pencil used to swap the entire script for `scriptEditor()` — a stacked form
of labelled textareas (hook, then say/do/show per beat with a remove button,
then + add a beat, CTA, caption) plus a Save/Cancel row. **78 lines deleted**:
`EDITING`, `stashEdits`, `scriptEditor` and the `ad-edit` / `ad-save` /
`ad-cancel` / `ed-add` / `ed-drop` handlers.

Every value is now a `contenteditable="plaintext-only"` span **on the element
that already displayed it** — hook, every say/do/show, CTA and caption. Nine
editable fields on a normal card. **Measured: focusing a line shifts the row by
0.00px and the card by 0.00px**, which is the whole point — the resting and
editing states are the same element at the same size, so no box appears and
nothing reflows. The affordance is a faint hover wash plus an *inset* focus
shadow; an ordinary 1px border would have reflowed every line.

Commit on **blur**, not on input — writing to `ME` per keystroke would change
`paneSig()` and let the 2.5s live-sync rebuild the card mid-word. Enter
commits, Escape reverts. **No repaint on commit**: the DOM already shows what
was typed, and repainting is what used to snap the card shut on save. Clearing
every line of a beat drops it (verified 3 → 2), which is the rule the old Save
button applied, now applied when it happens. A quiet `+ add a beat` remains.

**TWO BUGS FOUND WHILE BUILDING IT, BOTH IN THE NEW CODE, BOTH FIXED:**

1. **Escape wiped the line.** `el.textContent = el.dataset.was || ""` reads as
   an obvious default and is destructive: any path reaching Escape without the
   recorded original blanked the line ON SCREEN while the record still held the
   real text. Now it only restores a value it actually has.
2. **The undo value hung off a `focus` listener**, which is one event away from
   never running — a programmatic focus does not fire one in an unfocused tab,
   and neither does restoring focus after a repaint. It is captured **at wire
   time** instead, so every editable line has its undo value from the moment it
   is on screen, and refreshed on each commit so Escape reverts to the last
   saved state rather than two edits back.

**`isTyping()` replaced three copies of an inline
`/^(INPUT|TEXTAREA|SELECT)$/` guard.** None of them matched a contenteditable
span, so all three would have read "not typing" and let the poll rebuild a card
around a half-typed line.

**THE REFERENCE VIDEO NO LONGER PLAYS ITSELF.** Owner, same session: *"have the
side video play when i press play so when i click on the script side it doesnt
play automatically."* `seekRefTo()` called `play()` on a paused video, so
touching the script started the clip — already surprising, and untenable once
putting the caret in a line to fix a word would start audio. It now **seeks
only**; a video already playing keeps playing and simply jumps. Verified both:
paused stays paused at the new time, playing jumps and keeps playing. The play
button, tapping the frame, and restoring a video that was already playing
across a repaint are the only three things that start it.

Clicking a beat still moves the playhead — the caret and the playhead landing
on the same beat is the point — but a second click inside a field already
focused does not, so refining a selection cannot yank the video.

Stamp `20260825e`.

---

**THE PAYWALL — the creator-facing half — IS BUILT. Free is 25, not 5.**

**The free allowance is now 25 lifetime.** Owner, 2026-08-25, asked for
"whatever gets the user hooked and dependent", which is a design call, so:
dependency comes from having a LIBRARY and configured brands worth not
abandoning, not from the first good script. 25 is about one month of daily
posting (or ~3 months at twice a week) — enough to build that. 5 walls someone
inside a week, before any habit forms, and this project has already lost one
live account to a too-early wall. Costs $1.88/signup at $0.075/script, and
**it is already the live default** (`lynxr_allowance.granted`, `SCRIPT_CAP`),
so there is no migration and nobody loses scripts. 50 would double the cost for
diminishing habit gain. **`/pricing/` and `/terms/` say 25** — if that number
ever moves, both pages and the schema default move with it.

**`BILLING_LIVE = false` is the switch that decides whether this can take
money**, and it is the same idiom as `SEND_OVERLAY`. Checkout posts to
`/functions/v1/billing-checkout`, which is Stage 3 and **is not deployed** —
no Paddle account exists. A button that silently 404s is worse than no button,
so while the flag is false the Upgrade button is replaced by an honest line
saying checkout is not open yet. **Flip the flag the day the function and the
secrets exist and the button starts working with no other edit.**
`billingAction()` is written and wired behind it.

New `VIEW.kind === "plan"`, following `renderYou`'s shape exactly: a `nav-plan`
rail button (`creatorsonly/index.html`, directly under the quota meter — the
meter is where you learn you are running out and this is the answer to it), a
`renderPlan()`, a `renderPane()` branch, a `renderSide()` toggle and a
listener. **Only the FREE state is built.** `PLAN` does not exist until the
webhook receiver does, so an `active`/`past_due` branch would be code that
cannot run or be tested; the extension point is marked `TODO(Stage 3)`.

**TWO WALLS NOW EXIST AND THEY DO NOT SHARE A SENTENCE.** Three call sites said
`Ask for more from Feedback in the menu.`; they now call one `quotaWallText()`.
A FREE creator at 25/25 can act, and is pointed at Plan. A PRO creator at
300/300 has hit **fair use** and cannot buy their way out — that copy says the
rolling window reopens and never pitches an upgrade, which would be both wrong
and insulting. `period_days > 0` is what tells them apart.

**`period_days` was already in `my_allowance()`'s answer and creator.js was
throwing it away** — `ALLOWANCE` kept only `{used, granted}`. It now carries
`periodDays`, defaulting to 0 so an older RPC reads as lifetime, which is what
free is. That field is the only honest way to know which wall to show.

Verified in the browser against a stubbed ledger — note `ALLOWANCE` is a
module-scope `let` in a classic script, so `window.ALLOWANCE = …` does NOT
rebind it and a first attempt silently measured the default state instead.
Assigning the lexical binding works. Confirmed: free 22/25 paints the bar at
**811.4px of 922px = 88% real pixels** (CSSOM width, not an inline attribute —
`style-src 'self'` would have dropped that silently); free 25/25 turns the box,
bar and rail red together and says nothing is lost; pro 300/300 produces the
rolling-window sentence instead; **`$24.99` paints as `$24.99`** under the
sitewide lowercase; clicking the rail button really routes (`VIEW.kind` flips,
`nav-plan` gains `.on`, the rail reads `25/25 — none left`); and the links row
needed `.x-sep` middots, which Settings' own `.me-links` already uses — without
them it painted as `pricing refund policy terms` in one run.

Stamp is `20260825d` on all 14 pages (CSS and JS both changed this time).

---

**PAYMENTS STAGE 1 IS DONE — the public pages Paddle's domain review looks
for.** Gate 06, from `~/.claude/plans/creator-payments-paddle.md`. HTML only:
no billing code, no secrets, no provider involved, nothing that can take money.

New: **`pricing/index.html`** and **`refunds/index.html`**, both generated from
`terms/index.html` so the CSP meta is **byte-identical** (verified by hash —
`script-src 'self'` is the line that, when dropped, silently CSP-blocked
site.js on three legal pages once). Copy is the decided position, written as
settled: free = **5 scripts lifetime**; **lynxr pro $24.99/mo** billed monthly
in advance; fair use **300 per rolling 30 days, 30 per 24 hours**, stated
explicitly as *rolling, not resetting on the billing date*; **14-day money-back
on the first payment**, refund ends access immediately; **no pro-rata on
cancellation**; `Paddle.com` as merchant of record.

`terms/index.html`'s billing `legal-todo` is **gone, replaced by the real
clause** — and the banner that explained the flag convention was rewritten with
it. It said *the passages marked "to be completed"*, but after this change no
passage says that any more; the two survivors both say *"drafted, not
reviewed"*. Left as-was it would have pointed at a convention that no longer
existed. **The other two flags stay** — the liability cap and the
Massachusetts governing-law clause are drafted, not reviewed, and **a lawyer's
look is still a hard prerequisite for live money.** That gate is NOT closed by
this work.

**The plan was 6 days stale in its mechanics and was re-derived, not followed.**
It said 8 pages carry the nav (**10** do — four SEO guides shipped after it was
written), that the footer is `<li>` inside `.lp-foot` (**it is
`<a class="foot-link">` inside `.foot-col`**, literal markup in **11** pages),
that `creatorsonly` has no footer (**it does**), and that the stamp was
`20260823d`. Its strategy and copy were sound; only the mechanics had drifted.

Three pages needed hand-fixing after the bulk pass and each would have been a
silent miss: **`faq/`** anchors its own nav/menu/footer links with
`aria-current="page"`, so the generic anchor matched nothing; **`waitlist/`**
does the same on the menu's try-it button; **`creatorsonly/`** has no faq link
and a 14-space indent, so its refund link landed mis-indented. Final state,
checked per page: **all 12 public pages carry pricing in BOTH `.lp-nav` and
`.lp-menu`** and both footer links; `creatorsonly` gets the refund link only;
**`agencyonly` is untouched — staff do not buy.**

Sitemap: 12 urls, parses, pricing at 0.8 beside `/faq/` and refunds at 0.3 with
the legal set. **`robots.txt` deliberately unchanged** — it must never name an
app path and needs nothing for public pages. `tools/check_stamp.py` discovers
pages by `rglob` rather than a hardcoded list, so it picked both new pages up
by itself: **14 pages, stamp `20260825c`, consistent**. No stamp bump was
needed — Stage 1 changes no CSS and no JS.

Verified in the browser, painted: both pages render, `footer.js` runs (the
wordmark was caught mid-spin, which is the proof it is not CSP-blocked), **zero
console errors**, `.entity` computes to `text-transform: none` against the
body's `lowercase` so `Paddle.com` keeps its capitals, the burger opens and
closes and **pricing is painted in the mobile panel**, and **nav centring is
still 0.00px off at 1280 / 1440 / 800px** with a third item in the bar.

**NEXT, AND IT IS THE OWNER'S, NOT THE EXECUTOR'S:** action A0 in the plan —
create the Paddle account for `Lynx Media Group LLC` (the entity name must
match `/terms/` exactly) and submit lynxr.io for domain verification. **That is
a 3–7 business day external clock and nothing else in payments moves until it
starts.** These pages exist so the reviewer has something to approve; they must
be DEPLOYED before submitting. Stages 2–6 (billing SQL, the Edge Function
webhook receiver, checkout, cap layers, owner visibility) are untouched.

The 2026-08-20 priorities below are untouched and still the queue.

**2026-08-20 (evening) — SESSION CLOSE. Cloudflare is live in front of
lynxr.io (Track D1), the site has real security headers for the first time,
and there is now a backup — the first this project has ever had.** The
account-level hardening is done too. Nothing is mid-flight.

### START HERE NEXT SESSION

**Two commits may be unpushed: `6d99a11` and `27e324c`, both HANDOFF.md only.**
Check `git log origin/main..HEAD` first. Pushing them fires `adaptations.yml`,
which is the ONLY way to prove the `SUPABASE_SERVICE_ROLE_KEY` newline fix
actually took — a run that dies with `ValueError: Invalid header value` means
it did not. They do NOT touch `pipeline/**`, so no Fly redeploy.

**Then: write the restore.** `pipeline/restore_supabase.py`, Steps 14–15 and
20–22 of `~/.claude/plans/hardening-c-resilience.md`. There is now data on
disk and no tested way to put it back, which means today's recovery story is
"every creator resets their password and we find out whether the files even
load". A backup you have not restored is a hypothesis. This is the highest
item on the list and it is the natural next step from what shipped today.

**Also near the top: the Supabase Free egress quota is at 107%** and the cause
is measured — see the egress entry below. Trim and cache `app.js:2251` before
paying for a bigger quota.

**After that, in order:** timeouts on every model call (the SDK default is TEN
MINUTES behind a 2.5-minute claim lease — one hung call is a guaranteed
double-run, no race required), the A1 atomic claim RPC, `period_days = 30`
(you cannot bill monthly against a lifetime cap), and D2a's waitlist rate
limit.

**Before any launch work, read "BEFORE SHIPPING: what to upgrade, and what
breaks as we scale"** below — it names the one paid upgrade that is actually
required (Supabase Pro, because Free takes no backups), and the JSONB blob
that is the real scaling wall.

**Do not re-run `supabase/schema.sql`** and **run the `pg_trigger` query
first** — both checks below are still unperformed and still binding.

### Cloudflare — done, verified through the edge

Nameservers moved Namecheap -> `nick`/`sydney.ns.cloudflare.com`; the `.io`
registry flipped at ~20:40 UTC. Free plan. All six DNS records imported
unchanged, four apex A + `www` proxied, `_dmarc` DNS-only.

**Before (measured 19:52 UTC): `server: github.com` and NOT ONE security
header.** After, on `/`, `/faq/`, `/app.css`, `/robots.txt`, `/privacy/` and
**both app paths** — 5 of 5, HTTP 200, `server: cloudflare`, `cf-ray` present:

    x-frame-options: deny
    content-security-policy: frame-ancestors 'none'
    x-content-type-options: nosniff
    referrer-policy: strict-origin-when-cross-origin
    permissions-policy: accelerometer=(), browsing-topics=(), camera=(self), ...

One Transform Rule, "security headers", matching **All incoming requests** —
deliberately not path-scoped, because a rule naming `/creatorsonly/` is
externally observable. All twelve meta CSPs verified unchanged (1 each); one
301 -> 200 on both hostnames, no chain, no 526.

**SSL/TLS is `Full` and MUST NOT be changed to `Full (strict)`.** This is the
entry a future editor will otherwise "fix". GitHub Pages cannot renew its
origin certificate while Cloudflare proxies the domain — its health check
resolves the domain and expects its own IPs, sees Cloudflare's, and refuses.
Under `Full` an expired origin cert is invisible (visitors get Cloudflare's
edge cert, renewed by Cloudflare). Under `Full (strict)` the same expiry is
**HTTP 526 on every request** ~90 days later. The origin cert is currently
valid to 2026-10-28; to un-proxy later, grey-cloud for an hour and let GitHub
renew first.

**THE TRAP, and it fired: Cloudflare rewrites `robots.txt`.** The setup
wizard's "Block training in robots.txt" toggle was turned OFF and it was NOT
enough — a *separate* feature under **AI Crawl Control -> robots.txt**
(Content Signals Policy) prepended a "Cloudflare Managed Content" block that
served **27 user-agent groups and 9 `Disallow: /` lines** against GPTBot,
ClaudeBot, Google-Extended, CCBot, Applebot-Extended, meta-externalagent,
Bytespider, Amazonbot and CloudflareBrowserRenderingCrawler — above our own
`User-agent: *  Allow: /`, where a named group beats the wildcard. That is the
exact inverse of the deliberate 17-group zero-`Disallow` policy the file
documents in its own comments, and it silently undoes the GEO pages. Turned
off; the served file is now **byte-identical to the repo**. **Re-verify with a
diff after any Cloudflare change** — the dashboard settings said "allow" the
whole time the file said "deny".

Also off, and each for a reason: Email Address Obfuscation (five real
`mailto:` links, verified still painted as real addresses — 5/3/5 with zero
Cloudflare decoders), Rocket Loader (rewrites `<script>` under
`script-src 'self'`), Bot Fight Mode (cannot be exempted, would challenge the
17 allowed crawlers), AI Labyrinth (injects markup), and the "mixed purpose
crawlers will be blocked on September 15" radio — a dated auto-change armed in
a dashboard nobody re-reads.

**Universal SSL took a few minutes to issue and HTTPS was genuinely broken in
that window** — handshake failure at the edge while HTTP still 301'd to it. If
this ever recurs, grey-cloud the five records to restore service instantly
(GitHub's own cert is valid) and re-proxy once the cert shows Active.

**HSTS is ON** — `max-age=2592000` (30 days), verified painted on the apex,
`www`, deep pages and assets. `includeSubDomains` OFF (it would pre-commit a
future `api.lynxr.io` before it exists) and **`preload` OFF, deliberately**:
preload is compiled into browser binaries and removal takes browser release
cycles to reach users, so it is the one setting here that does not open from
the inside. Cloudflare's shortest option is 1 month, not the 1 day the plan
assumed. **Raise to 12 months after a clean week — that is the only remaining
D1 action.**

Final state, 6 of 6 headers on `/`, `/faq/`, `/privacy/`, `/glossary/`,
`/app.css`, `/robots.txt`, `/creatorsonly/` and `/agencyonly/`.

**Page Shield was assessed and NOT enabled, on purpose.** It reports
third-party scripts, but `script-src 'self'` with no `'unsafe-inline'` already
prevents one executing, and the Free tier gives a dashboard inventory rather
than reliable alerting — a control nobody looks at. Not a gap; a decision.

### The first backup this project has ever had

`pipeline/backup_supabase.py` + `pipeline/test_backup.py` (31 checks, all
passing, no network or credentials) + `pipeline/io.lynxr.backup.plist`.
Read-only by construction; GET and nothing else.

First real run: **11 tables + the auth roster, 580,879 bytes**, into
`~/Lynxr-backups/20260820T204034Z/`. Tiers are load-bearing — tier 1
(`lynxr_creators`, `lynxr_script_charges`, `lynxr_allowance`, `lynxr_clients`,
`lynxr_staff`) is a hard non-zero exit, tier 2 warns, tier 3 (`lynxr_costs`)
treats `PGRST205` as skipped. `unsafe_git_ancestor()` refuses any `--dest`
with a `.git` at or above it: `--dest .` exits 1. That makes CLAUDE.md's
"a waitlist CSV never goes inside the repo" structural instead of a habit.

**It cannot capture password hashes** — the admin API does not return them —
so a restore from this alone forces every creator to reset. That sentence is
in the written file's `_note` key. Layer 2 (weekly `pg_dump`) and the restore
script are NOT built. **A backup you have not restored is a hypothesis.**

Owner action to schedule it (04:15 local, launchd fires a missed run on next
wake):

    cp pipeline/io.lynxr.backup.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/io.lynxr.backup.plist

### BEFORE SHIPPING: what to upgrade, and what breaks as we scale

Written 2026-08-20 from measured numbers, not estimates. Every figure below
came from the live database or the first backup run; where something is
unverified it says so.

#### Paid upgrades, each with the trigger that justifies it

| service | now | change to | when | why |
|---|---|---|---|---|
| **Supabase** | Free | **Pro, $25/mo** | **before public launch** | **Free takes no automatic backups at all.** That is the decisive reason, not egress. Also removes the inactivity pause and raises egress 5 GB -> 250 GB and DB 0.5 -> 8 GB. |
| **Fly** | 1 machine, v23 | `scale count 2+` | **only after A1** | Scaling out is BLOCKED, not merely unwise — see below. |
| **Anthropic** | pay-as-you-go | unchanged | — | ~$0.016 a script with caching. At the decided fair-use cap of 300 scripts / 30 days that is **~$4.80 per subscriber per month against $24.99 revenue**. The margin is fine; the risk is a runaway loop, which `--daily-cap 250` already bounds. |
| **Cloudflare** | Free | **stay Free** | — | Track D3 evaluated the paid tiers and recommended **$0**: not one request in this system both accepts attacker input and passes through Cloudflare. Do not re-litigate this without new evidence. |
| **Resend** | free tier | **verify before launch** | before launch | Free-tier send limits are **UNVERIFIED here**. Signup confirmation, password reset and resend all depend on it; hitting a daily cap means new creators silently cannot confirm an account. Check the actual limit against expected signup volume. |
| **Apify** | local only | move token to Fly | before launch | `APIFY_API_TOKEN` is **local-only**, so the Instagram view refresh has never run in production. Either ship it or stop showing view counts as if they are fresh. |

**Do not upgrade Supabase to fix egress.** Fix `app.js:2251` first (see the
egress entry below). Pro's 250 GB would hide a 26 MB-per-page-load query for
about a year, and it would still be there when it finally matters.

#### What breaks first as creators multiply, in the order it will happen

**1. `lynxr_creators.data` — the JSONB blob. This is the real wall, and it is
architectural, not a knob.** One row per creator holds `adaptations`,
`library` and `trash` together, and **the client reads and rewrites the WHOLE
blob on every save.** Measured from the 2026-08-20 backup:

    54,015 bytes    5 adaptations,  0 trash
   256,697 bytes   17 adaptations, 19 trash   <- heaviest creator today
     ~7 KB per adaptation, 67 KB average per creator

At the decided fair-use cap of **300 scripts / 30 days**, that is ~2.1 MB
added per creator per month. A single active subscriber after a year holds a
**~25 MB blob that is downloaded, modified and uploaded on every single
save** — every paste, every rename, every trash. That is a latency problem, an
egress problem, and it widens the A1 data-race window in direct proportion to
its size. **Trash is the cheap half of the fix** (it is 19 of one creator's 36
entries); the real fix is moving adaptations to their own table with one row
per script. Do not start this at the point where it hurts — it is a migration
of the only irreplaceable table in the system.

**2. Agency-app egress** — `app.js:2251`, ~26 MB per load. Bites at roughly
200 loads a month, which is where it already is.

**3. The single Fly machine, and why `scale count 2` is not the fix.**
`_GRAFT_LOCKS` is a `threading.Lock` in ONE process. A second machine shares
no lock and will race the same row; `--min-age-seconds 180` narrows that
window, it does not close it. **A1's `SECURITY DEFINER` conditional UPDATE is
the prerequisite for horizontal scale**, and until it lands, more machines
means more double-billing, not more throughput. Related and cheaper: the
Anthropic SDK's default timeout is **ten minutes** sitting behind a
2.5-minute claim lease, so one slow call double-runs with no race at all.

**4. `period_days = 30`.** The allowance is still lifetime (`granted` defaults
to 25, `period_days` to 0, `allowance_ledger.sql:91`). **You cannot bill a
monthly subscription against a lifetime cap.** Cheap — the column exists.

**5. The waitlist has no rate limit** and is a public POST straight to
Supabase that Cloudflare never sees. D2a puts the limit in Postgres, where the
traffic actually lands. Fine at 29 rows; not fine on a launch day.

**6. The signup gate is still a 4-seat counter.** Opening to the public means
deciding seats vs invites deliberately. **Do not just raise `seats`** — that
opens the door to anyone holding the URL, first come first served.

**7. Whisper's cold start (~2 min for 464 MB of weights) is per-machine.**
Every machine added pays it once. Real, but it is a scale-out cost, not a
scale-up one — and it is far behind items 1-3.

#### What does NOT need to change, so nobody spends time on it

Auth (23 of 50,000 MAU), storage (6% of 1 GB), Realtime (unused), Edge
Functions (unused), GitHub Actions (public repos get free minutes), and the
Cloudflare plan. The database itself is 15% of the Free ceiling — **only
egress is under pressure, and only because of one query.**

### THE FREE PLAN'S EGRESS QUOTA IS BLOWN — 107%, found 2026-08-20

`supabase.com/dashboard/org/.../usage`: **Egress 5.351 / 5 GB (107%)** for the
31 Jul – 31 Aug cycle. Overages are not billed on Free; the project gets
**restricted** instead. Everything else is idle — Database 0.074/0.5 GB (15%),
Storage 0.065/1 GB (6%), MAU 23/50,000 (<1%), Realtime and Edge Functions
zero. **One number is over and it is egress alone.**

**The cause, measured:** `app.js:2251` reads the whole of `lynxr_videos` to
populate the agency database view. It pages politely with `Range` headers, but
it still pulls all 9,028 rows every time the tab is opened. Measured live:
**3,111,650 bytes for 1,000 rows -> ~26 MB per full load.** 5 GB is therefore
roughly 200 agency-app loads in a month, which is entirely plausible for
normal use by one or two staff.

**So the fix is cheaper than the upgrade, and it is a real fix:** trim the
`select=` field list to what the table view actually renders, cache the result
in localStorage keyed on a row count or max `updated_at`, and only re-fetch on
change. Nothing about this needs a paid plan. Do this BEFORE deciding on Pro,
or Pro's 250 GB simply hides it for a while.

**Separately, Pro IS right at launch, and this settles the plan's Step 0.2
("which Supabase plan, and does it back anything up"): the Free plan takes NO
automatic backups.** That is the answer, and it is why the C2 work today was
not optional — until 2026-08-20 this project had no backup of any kind, from
any source. Pro adds daily backups with 7-day retention, removes the
inactivity pause, and gives egress headroom. It does not replace
`backup_supabase.py`: a provider-held backup you cannot read is not a backup
you control, and Layer 2 (`pg_dump`) is still the only thing that captures
password hashes.

### The account-level hardening is DONE (2026-08-20)

All five, **reported complete by the owner**. Say plainly what that means:
none of these is verifiable from a shell — there is no API token here with the
scope to read them — so this entry records a claim, not a measurement. Every
other claim in this file that says "verified" was measured. These are not.

1. **MFA on the Supabase account.**
2. **MFA on the GitHub account** (`lynxrio`).
3. **Secret scanning + push protection** on `lynxrio/lynxr`. Push protection is
   the valuable half: it refuses a recognised secret at `git push` rather than
   reporting it after publication.
4. **A branch ruleset on `main`** — restrict deletions, block force pushes,
   Enforcement Active, **bypass list deliberately empty** so it binds the owner
   too. Watch for the trap this one has: a freshly created ruleset targets
   nothing and shows "Applies to 0 targets" until `Include default branch` is
   added. Created-but-inert looks identical to done in the ruleset list.
5. **`SUPABASE_SERVICE_ROLE_KEY` re-saved without its trailing newline** —
   open since 2026-08-19, the cause of every `adaptations.yml` failure from run
   #168. **Unproven until the next workflow run authenticates.** If a run fails
   with `ValueError: Invalid header value`, the newline is still there.

That closes the roadmap's item 2 of "if you only do three" — the best
value-per-minute in the programme.

### The backup schedule and the commit hook are LIVE and PROVEN

Both were installed AND exercised, because "installed but inert" is this
project's signature failure and an install that has never fired proves nothing.

- **`~/Library/LaunchAgents/io.lynxr.backup.plist` is loaded.** `launchctl
  start io.lynxr.backup` produced a second run directory and a correct log at
  `~/Library/Logs/lynxr-backup.log`. Nightly at 04:15 from here.
- **`core.hooksPath = .githooks`.** Proven by staging a real `app.css` change
  with no stamp bump: the hook **refused the commit**, named the file, printed
  the fix, and `HEAD` never moved. Reverted, then the real commit went through
  with `ok -- 12 staged page(s)`.

Run 2 also showed the pipeline working while all this happened:
`lynxr_costs` 0 -> 4 rows, `lynxr_sources` 28 -> 31, total 665,057 bytes.

### Corrections the backup run proved against live data (2026-08-20)

- **`lynxr_costs` EXISTS** — HTTP 200, currently 0 rows. The entry below
  saying `costs_table.sql` is unapplied is wrong.
- **9 auth users, not 8.**
- **`lynxr_creators` is 342,775 bytes, not 274 KB.** `lynxr_sources` 175,074.
- **`lynxr_allowance` has 0 rows and that is CORRECT** — it is an override
  table, read through `coalesce(..., 25)` at `allowance_ledger.sql:91`. Empty
  means every creator gets the default. Do not "fix" it.


**2026-08-20 (late) — session close. The Ops tab shipped, three focus-ring
defects are fixed, and a six-track hardening programme is planned but NOT
started.** Read the two "before anything" checks below before touching Supabase.

### ~~Still in flight at session close — ONE uncommitted change~~ SUPERSEDED

**This was committed as `8a01369` on 2026-08-20. The working tree is clean.**
Kept for the reasoning about the Ops tab's emphasis rule, which still binds:
a summary tile must never say "all good" while a panel below it says the query
failed. The `/tmp/lynxr-ops-harness/` fixtures it names are **gone** — /tmp was
cleared — so regenerate them before the next Ops verification pass.


A `ui-ux` agent was reworking the Ops tab's emphasis when the session ended:
the owner asked for **issues and costs to own the first screen, with the six
detail sections below the fold**. It touches `app.js`, `agencyonly/index.html`
and the twelve `?v=` stamps (`k` -> `l`). If `git status` is dirty on those
files, that is what it is. Verify against the five fixtures in
`/tmp/lynxr-ops-harness/` before committing — healthy, three alarms, watchdog
stale, no ops table, no cost table. The rule it must satisfy: **a summary tile
must never say "all good" while a panel below it says the query failed**, which
matters more now that the panels are off-screen.

### Shipped today, all committed

`7ec8c68` **the Ops tab** (phase two of `agency-ops-dashboard.md`) and **three
focus-ring fixes**. `a8a8574` **cost persistence** (`lynxr_costs`, written in a
`finally:` so a failed pass still records; a missing table degrades to no cost
data, never to a dropped script). `4dc7f99`, `007e911`, `441dde0` the creator-app
work: see-the-original inside a branded card, `originalText()` fixing a Copy
button that returned the brand rewrite on the Original tab, `ready` / `ready . N`
chips replacing counts, and the trash-arming bug where `stopPropagation` does not
stop a `<details>` toggling so "are you sure?" jumped ~890px from the finger that
pressed it.

**The focus-ring root cause is worth remembering: a global rule meeting a
component that has its own.** Three instances, failing two opposite ways.
`:focus-visible` carried `border-radius: var(--r-pill)` -- and because
`border-radius` is a real property and `:focus-visible` (0,1,0) beats `textarea`
(0,0,1), **a focused textarea became a capsule and clipped its own first
character by 6.5px**. Separately `.composer-row` drew ring *and* brightened
border (two rings), and `.sat-row`'s own (0,2,0) rule carried `outline: none`
and erased the ring entirely on a `role="button" tabindex="0"` element -- a
1.06:1 indicator, worse than the 1.19:1 this file already calls "a rumour of
one". 741 focusable elements across twelve pages, before and after: zero
differences outside the three fixed.

### The hardening programme — PLANNED, NOT STARTED

Seven files, none executed, nothing approved:

    ~/.claude/plans/lynxr-hardening-roadmap.md      <- start here
    ~/.claude/plans/hardening-a-security-core.md    A1 data race, A2 auth, A3 secrets
    ~/.claude/plans/hardening-b-verification.md     B1 staging, B2 JS tests, B3 RLS suite
    ~/.claude/plans/hardening-c-resilience.md       C1 migrations, C2 backup, C3 continuity
    ~/.claude/plans/hardening-d-perimeter.md        D1 headers, D2 abuse, D3 paid
    ~/.claude/plans/hardening-e-maintainability.md  E1 modules, E2 CSS, E3 cache-bust
    ~/.claude/plans/hardening-f-observability.md    F1 audit, F2 anomaly, F3 deps, F4 proxies

~22.5 agent-days for all of it, 17.5 without E1. The roadmap's own top three:
**E3** (2-3h, catches a stamp miss that happened today), **~30 minutes of
account-level clicks** (MFA on the Supabase and GitHub accounts, push
protection, a branch ruleset on `main`, and re-saving
`SUPABASE_SERVICE_ROLE_KEY` without its trailing newline), and **C2's nightly
backup** -- the only item whose absence is unrecoverable.

**Declined outright, with reasons: F1b read auditing** (pgAudit cannot tell you
*who* -- every signed-in session arrives on the one `authenticated` role),
**F4 the CORS relays** (self-hosting opens the first public port on the machine
holding the service-role key), and **all of D3, $0 recommended** -- not one
request in this system both accepts attacker input and passes through
Cloudflare.

### TWO OWNER CHECKS BEFORE ANY SQL WORK

**1. Run this. It settles a three-way contradiction:**

    select tgname, tgenabled from pg_trigger
     where tgrelid = 'auth.users'::regclass and not tgisinternal;

Expect one row, `lynxr_signup_gate`. **Zero rows means nothing is enforcing
signup at all.** Two rows means `signup_gate.sql` has been re-run since
`invites.sql` -- it recreates `lynxr_signup_seats` at :141 and never drops
`lynxr_signup_gate`, leaving a second BEFORE INSERT trigger that knows nothing
about `require_invite`.

**2. DO NOT re-run `supabase/schema.sql`.** Its staff seed at :63-65 is
`insert into lynxr_staff ... select id from auth.users` with **no WHERE**. There
are 8 auth users today, 4 of them non-internal creators. `on conflict do nothing`
protects the existing staff rows and does nothing to stop the other four being
promoted. Every SQL file here is described as safe to re-run; this one is safe
to re-run exactly once, and nothing said so until now.

### ~~Cloudflare — started, unfinished~~ SUPERSEDED — IT IS DONE

**Completed 2026-08-20 evening; see the Cloudflare entry at the top of this
section for the verified state.** Everything below was correct guidance and is
kept because the reasoning still binds — especially `Full` vs `Full (strict)`
— but read it as history, not as a to-do.


The owner is mid-way through Cloudflare's add-a-zone flow (Track D1). Order
matters: **SSL/TLS to `Full` BEFORE changing nameservers, and never
`Full (strict)`** -- GitHub Pages cannot renew its origin cert behind a proxy
and strict mode becomes HTTP 526 about ninety days later. On the "AI training &
search policies" screen, **"Block training in robots.txt" must be OFF**: our
`robots.txt` carries 17 `User-agent` groups and zero `Disallow` lines,
deliberately, and letting Cloudflare manage that file undoes it. Same reason
**Bot Fight Mode** must be off. Also off: Email Address Obfuscation (five real
`mailto:` links would render as `[email protected]`) and Rocket Loader (it
rewrites `<script>` tags).

### Corrections to entries below this one

- **`lynxr_videos` is 9,028 rows, not 9,016.** Verified live.
- **Fly is at v23**, deployed 2026-08-20. Entries claiming nothing deployed are stale.
- **`supabase/ops_table.sql` IS applied** -- an entry below says it is not.
- **The rotated `SUPABASE_SERVICE_ROLE_KEY` Actions secret IS updated** -- runs authenticate.
- **`CLAUDE.md` said "bump the stamp on all four pages". There are twelve.** Fixed today.
- **12 of 15 `supabase/*.sql` files are applied**; `costs_table.sql` is not.
  `creators_adaptations_gin.sql` and `write_guards.sql` are invisible to a
  PostgREST probe because they are an index and constraints.

### Owner actions outstanding — PARTLY DONE, read the corrections

**`supabase/costs_table.sql` HAS been run** — `lynxr_costs` exists and is
populating (0 rows at 20:40 UTC, 4 rows by 21:02). The line below saying it is
not yet run is wrong. **The five account-level actions are also done** (MFA on
both accounts, push protection, the `main` ruleset, the secret newline) — see
the entry at the top of this section, and note none of them was independently
verified from a shell.

Still genuinely outstanding from this list: `APIFY_METER_TOKEN` on Fly, the
fact that `APIFY_API_TOKEN` remains **local-only** so the Instagram view
refresh has never run in production, and the four blank figures in
`FIXED_COSTS`.


Run `supabase/costs_table.sql`, then deploy the pipeline to Fly (not mid-script)
-- until both, the Ops tab's cost panels say so rather than showing numbers.
Optionally set `APIFY_METER_TOKEN` on Fly for the Apify gauge; note
`APIFY_API_TOKEN` is still **local-only**, so the Instagram view refresh has
never run in production. Fill the four blank figures in `FIXED_COSTS`.

---

**2026-08-20 — the Ops dashboard's backend landed; the tab itself has not.**
`~/.claude/plans/agency-ops-dashboard.md`, 14 steps, run as two phases because
a second agent was editing `app.css`, `creator.js` and all twelve cache-stamped
HTML pages at the same time (a status-chip and focus-ring change). **This
entry covers phase one only** — persistence, not the tab. Phase two (Steps
7–13: `agencyonly/index.html`'s Ops panel, `app.js`'s render functions, the
`renderBars` chronological-series fix, the twelve-page `?v=` bump, and the
credential-free harness proof) has not run as of this entry — there is no
visible Ops tab yet.

**What shipped in phase one, all in `pipeline/` and `supabase/`:**
`supabase/costs_table.sql` (new, not yet run — see owner actions below) adds
`lynxr_costs`: one row per model per pass, `staff read` only, no write policy
from the browser at all. It deliberately is **not** a column on
`lynxr_script_charges`, because `refund_script()` deletes that row on a failed
pass and a failed pass is exactly the one whose cost matters most. Its header
also states plainly that it redefines nothing — it only *calls*
`public.is_staff()` inside a policy, never `create or replace`s it, so it
cannot be shadowed by (or shadow) anything `allowance_ledger.sql` defines; the
header names the one-line proof (`select prosrc from pg_proc where proname =
'is_staff'`) to check which version is live if that's ever in doubt.
`supabase/ops_table.sql`'s header comment gained two lines documenting the two
new `lynxr_ops` keys below — that file itself needed no re-run, it already
existed.

`pipeline/process_adaptations.py` gained `PRICES_REV = "2026-08-12"`,
`cost_of()` (the one formula — extracted out of `log_usage()`'s inline
arithmetic so the log line and the ledger can never disagree), `cost_rows()`
(pure row builder, no creator id/url/title, `id8` only), and `record_cost()`
(best-effort POST to `lynxr_costs`, catches everything, warns and moves on).
`run_entry()`'s trailing `log_usage(...); usage().clear()` became a `finally:`
that runs `log_usage`, then `record_cost`, then the unconditional clear — on
**both** the success path and the exception handler, deliberately: a failed
pass still spent money (three Opus calls before a 529 costs what three
working ones cost), and the old success-only placement of `usage().clear()`
was a real leak, since `usage()` is `threading.local` and `process_group`'s
pool reuses threads — a failed entry used to leave its tally sitting in the
dict for the next script on that thread to inherit. **The cost write cannot
break a script**: `record_cost` only ever warns and returns; nothing between
it and the creator's already-grafted script can fail because of it, and a
missing/broken `lynxr_costs` table degrades to "no cost data," never to a
stuck or lost adaptation.

`pipeline/watchdog.py` gained `COST_APIFY_TTL_S` and `APIFY_BREAKER_USD` (the
latter reading the *same* `APIFY_MAX_MONTHLY_USD` env var and default as
`process_adaptations.py`, so the breaker and the dashboard line can't
disagree), `_apify_spend()` (Apify's own `/v2/users/me/limits`, reading
`APIFY_METER_TOKEN` before falling back to `APIFY_API_TOKEN` — see the
`APIFY_API_TOKEN` finding below for why that order matters), the pure
`ops_snapshot_value()`, and the `run_once()` wiring: after the dry-run return
and after the alarm-clear loop, every completed check now writes
`ops.snapshot` (that tick's full alarm list, paging **and** digest-only —
the whole reason this beats the daily digest) and, when the meter answered,
`cost.apify`.

**The cost decision: measured, not estimated, and there is no backfill.**
Token counts were never stored before 2026-08-16 and Fly logs don't survive a
deploy, so the panel (once phase two ships it) will say "measuring since
&lt;first row&gt;" and show nothing before it. This gives up almost nothing —
the entire creator-path spend to date is roughly 30 records × $0.075 ≈ $2.25,
already noted elsewhere in this file as "under $1 across every script ever
written" — and a fabricated $2.25 historical line was judged not worth the
credibility. Every dollar figure the panel will show carries one of three
provenance tiers (measured / metered / entered by hand); an unpriced model
writes `usd = 0` with an **empty** `price_rev`, and phase two's panel is
specified to count those separately rather than silently adding them in as
free.

**Sibling, not a merge, with `~/.claude/plans/agency-usage-visibility.md`**
(written, not executed). That plan's Usage tab is about people; this Ops tab
reads no creator data at all — zero privacy surface, no `security definer`
needed. The one real overlap: that plan's Step 10 ("Needs a look") and its
`stuck`/`failed` blocks in `usage_overview()` re-derive from the creator blob
what this Ops tab reads straight off the watchdog's own latch.
**Recommendation carried over from the plan, awaiting the owner's approval:**
drop that plan's Step 10 and its `usage-trouble` markup, keep only its
per-creator `errors`/`stuck` table columns. Not acted on from here.

**Verified in this session, all read-only:** `./venv/bin/python
pipeline/test_costs.py` (new file, 18 checks, all pass — the formula agreement
between `log_usage` and `cost_rows`, the dated-suffix pricing
`analyze_visuals.MODEL` actually sends, the id8/no-creator-data key-set
check). `./venv/bin/python pipeline/test_watchdog.py` now carries 103 checks
(89 existing + 14 new for `ops_snapshot_value`), all pass. `test_ai_retry.py`,
`test_prefilter.py`, `test_views.py`, `test_envcfg.py` unchanged and passing;
`test_allowance.py` passing with its usual 2 skips (no
`LYNXR_TEST_CREATOR_ID`). `pipeline/watchdog.py --once --dry-run --json` still
prints `[]`. A throwaway `/tmp/lynxr-ops-check/read_ops.py` (outside the repo,
never committed) read `lynxr_ops`'s keys before and after that dry run: no
`ops.snapshot` appeared either time, confirming the dry-run return still
precedes the new write. (`fallback.heartbeat`'s own timestamp moved between
the two reads — that's the live production fallback loop touching the same
project, not this session's dry run, which never passed `--as-fallback`.)

**What still needs a signed-in staff session and a Fly deploy — not provable
from here:** everything server-side is unreachable from the browser until two
owner actions run, in this order: (1) `supabase/costs_table.sql` in the SQL
editor — the `lynxr_staff is empty` guard should not fire; (2) deploy this
pipeline change to Fly (not mid-script), then confirm with `fly status` and,
after one script runs, `select model, calls, usd, price_rev from
public.lynxr_costs order by at desc limit 4` should show **two** rows
(`claude-opus-5`, `claude-haiku-4-5-*`) both at `price_rev = '2026-08-12'`
summing near $0.075 — one row would mean the shot-list call stopped being
metered. No SQL was run and nothing was deployed from this session.

**`APIFY_API_TOKEN` is set on neither Fly nor GitHub** (carried over from the
plan's "Noticed, not planned," not fixed here): `fly secrets list -a
lynxr-worker` shows only `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and
`NTFY_TOPIC`, so `apify_token()` returns `""` everywhere except the owner's
Mac and the paid Instagram view-count refresh that shipped 2026-08-19 has
never actually run in production. This is also why `cost.apify` will read
absent (phase two's panel: "meter not configured") until the owner separately
sets `APIFY_METER_TOKEN` — a metering-only token, deliberately read before
`APIFY_API_TOKEN` so installing the dashboard can never itself turn on paid
lookups.

**Phase two, not run here:** the Ops tab markup in `agencyonly/index.html`,
its rendering in `app.js` (including the `renderBars` chronological-series /
formatter fix and the four cost tiles), and the `?v=` bump across all twelve
pages — assigned to whichever agent is free once the concurrent status-chip
work lands, since both touch the same files.

---

**2026-08-19 — the SEO/GEO programme landed in two phases, split so it would
not collide with the motion pass editing the same eight files.**
`~/.claude/plans/lynxr-seo-geo-programme.md`, 20 steps. **This entry covers
phase one only** — everything that creates a new file or edits a non-HTML
one. Phase two (the six existing public HTML pages: `index.html`,
`waitlist/`, `faq/`, `privacy/`, `terms/`, `accessibility/`) is a separate
pass, not yet run as of this entry.

**What actually shipped in phase one:** `robots.txt` gained an explicit,
purely-documentary AI-crawler policy (Step 4) — every group added
(`GPTBot`, `OAI-SearchBot`, `ClaudeBot`, `Claude-SearchBot`,
`PerplexityBot`, `Google-Extended`, `CCBot`, `Applebot-Extended`,
`meta-externalagent`, `Amazonbot`, `Bytespider`, `DuckAssistBot`, and the
`-User` variants) was **already allowed** by the pre-existing `User-agent: *`
/ `Allow: /`, so nothing about crawl access changed. **One real
consequence, and it is a trap worth remembering**: robots.txt matching is
most-specific-group-wins, so any of those named agents now reads *only its
own* group — a `Disallow` added under `*` in the future will not reach them
unless it is repeated in every named group too. There is no `Disallow`
anywhere on this site and none is planned; see the file's own top comment
for why one would publish the exact path it means to hide.

`llms.txt` (new, root) lists the six existing public URLs plus the four new
guides below. **Expect it to do nothing measurable** — adoption is ~10% of
domains, Google states it ignores the file, and no major AI lab has
committed to reading it. It cost about ten minutes and cannot hurt; it is
not a GEO win and should not be reported as one.

**Four new content/GEO pages, live at the root:** `/what-is-a-video-format/`,
`/turn-a-video-into-a-script/`, `/short-form-script-structure/`,
`/glossary/`. Each is a draft, not a finished page — every fact in them
traces back to `index.html`, `faq/index.html`, `terms/index.html` or
`privacy/index.html`; nothing is invented, no case studies, no numbers with
no source. Each carries the **shared entity JSON-LD block** (`Organization`
+ `WebSite` + `SoftwareApplication`, byte-identical across all four) plus
its own `Article` and `BreadcrumbList` blocks; `/glossary/` additionally
carries a `DefinedTermSet` with one `DefinedTerm` per term. Visible copy on
all four is written in **normal sentence case in the source** — a deliberate
break from the rest of the site's lowercase-with-exceptions convention,
made because these four pages carry no JSON-LD twin of their prose the way
`/faq/` does, so the body text is the only machine-readable copy there is.
Painted output is unchanged either way: `text-transform: lowercase` in
`app.css` flattens it regardless of source casing.

**The audience decision, made by the owner during planning: lynxr.io targets
the creator**, specifically the UGC creator who makes short-form video for
brands — not the agency/brand buyer, which belongs to
`lynxmediagroup.org`. This is why the four new pages are written the way
they are (Steps 13 and 15 assume a creator reader) rather than being
brief-writing or creator-management content for an agency reader.

**The shared entity JSON-LD block currently lives on only 4 of the 10 public
pages** — the four new ones. It is specified for the six existing pages too
(plan Steps 6–8), but adding it there is phase two's job, since it means
editing files the motion pass has open. Until phase two runs, the
drift-check in the plan's Verification section

    for f in index.html faq/index.html waitlist/index.html privacy/index.html \
             terms/index.html accessibility/index.html \
             what-is-a-video-format/index.html turn-a-video-into-a-script/index.html \
             short-form-script-structure/index.html glossary/index.html; do
      awk '/BEGIN SHARED ENTITY JSON-LD/,/END SHARED ENTITY JSON-LD/' "$f" | shasum
    done | sort -u

will correctly print **two** lines, not one (the four new pages hash
together; the six existing ones have no block yet to hash at all, so they
print nothing and are absent from the count). It is meant to print exactly
one line only once phase two has run.

**Also still pending from phase two**, all specified in the plan and not
done here because each touches one of the six existing public HTML files:
metadata gaps on `/privacy/`, `/terms/`, `/accessibility/`, `/waitlist/`
(Step 2); retitling `/faq/`, `/waitlist/`, `/accessibility/` away from a
brand-first title (Step 3); the shared entity + page-level JSON-LD on all
six existing pages (Steps 6–8); the stale "eligible for a rich result"
claim in `faq/index.html`'s own comment — **FAQ rich results were retired
by Google on 2026-05-07**, restricted to government/health sites back in
2023, then removed entirely; the markup is kept because Google still parses
it for understanding and Bing still reads it, not for a rich result (Step
8); making every FAQ answer stand alone out of context and adding five new
Q&As (Steps 9–10); citable per-answer anchor ids on `/faq/`, verified by
loading `/faq/#<id>` and confirming the accordion opens (Step 11); a
whitespace fix so the homepage H1 stops extracting as `any video
→becomes tailored scripts` (Step 12); and linking the four new pages from
`/faq/` (Step 17, whose new-page half — the four pages linking each other,
`/faq/` and `/waitlist/` in prose — is already done; only the `/faq/`-side
insert remains).

**Verified in phase one:** `git diff --name-only` touched no `.css` and no
`.js` file, so the sitewide `?v=` stamp was not bumped — it stayed
`20260823f` (the value read live at execution time). No `${` in any new
`.html` file. `robots.txt`, `sitemap.xml` and `llms.txt` name neither
unlisted app path, not even in a comment. Every JSON-LD block in the four
new pages parses as JSON and contains no HTML entity. `sitemap.xml` lists
exactly the ten public URLs, `<lastmod>` set to the real edit date on every
entry. **Not verified**: painted-pixel checks in a browser (Steps 11, 12,
20's browser section are all on files phase one did not touch or could not
fully exercise), and the end-to-end fetch-and-ask proof, which needs the
site live and phase two complete first.

**Owner actions still open**, from the bottom of the plan, roughly by
leverage: get third-party mentions (Crunchbase/Product Hunt, founders'
Instagram/LinkedIn linking to lynxr.io, a link from
`lynxmediagroup.org`) — nothing in either phase substitutes for this;
verify lynxr.io in Google Search Console and Bing Webmaster Tools and
submit the sitemap; supply a square logo ≥112×112 for `Organization.logo`
(currently correctly omitted); decide whether `15 Farrington Ave, Allston
MA 02134` belongs in structured data (the plan includes it in the shared
block as drafted — flagged, not yet contested); decide the author of the
four content pages (currently credited to the organisation, not a named
person); supply concrete examples (a real reused format, a real hook
rewritten for two brands) to replace the generic drafting in the four new
pages; confirm a founding date if `Organization` should carry one.

---

**2026-08-23 — the creator find bar's sort control is a button + listbox now,
not a `<select>`.** Plan: `~/.claude/plans/creator-sort-button-menu.md`.

The owner opened the sort dropdown on the Library and said it was too small.
Not fixable by raising the `<select>`'s own font-size: macOS draws a native
select's popup at the select's own size, and the find bar came off the 16px
iOS floor on 2026-08-19 down to `--fs-135` (12.5–13.5px) — so a bigger popup
needs a popup that isn't a `<select>` at all. `app.css:3877`'s long decision
comment had already named this exact fallback ("rebuild the sort control as a
button plus a menu") as the passed-over option; this is that fallback, taken
for the popup-size reason rather than the iOS-zoom reason it was written down
for.

**The closed control is measurably unchanged.** Same `--fs-135`, same 13px
mobile padding, same `min-height: 44px` at ≤820px. Only `line-height` on
`.find-bar .find-sort` moved (1.35 → 1.3) to hold its painted height within a
fraction of a px of the old `<select>`'s:

| width | font-size (before = after) | height before | height after |
|---|---|---|---|
| 320px | 12.5px | 44.5px | 44.25px |
| 390px | 12.5278px | 44.5px | 44.29px |
| 1440px | 13.5px | 37.5px | 37.55px |

**The open menu is `--fs-18`** (15.5px at ≤360px, 18px at ≥1440px — one rung
above the `--fs-16` the plan first specced, at the owner's request for
"slightly bigger"), against the trigger's 12.5–13.5px: 1.24× on a phone, 1.33×
on desktop. Row height is `min-height: 42px` on desktop, 44px at ≤820px —
`.find-sort-opt` needed an explicit `line-height: 1.3` of its own, because the
body's inherited 1.6 alone pushed a bare row to 44.8px before `min-height`
ever got a say.

**ARIA pattern:** button (`aria-haspopup="listbox"`, `aria-expanded`) plus
`role="listbox"` popup, roving `aria-activedescendant`, focus moved INTO the
menu on open. Not the ARIA 1.2 select-only combobox — a combobox's value is
inferred from its text content, which has uneven screen-reader support; here
the accessible name carries the current value explicitly instead
(`"Sort your library: Newest first"`). Two native affordances deliberately
dropped: type-ahead (four options, all visible, not needed), and commit-on-Tab
(APG says commit; here Tab out closes the menu WITHOUT committing — changing
the sort as a side effect of leaving is worse than losing an uncommitted
highlight).

**Viewport tag outcome.** `creatorsonly/index.html` KEEPS `maximum-scale=1` —
`.find-bar input[type="search"]` is still under 16px and still a focus-zoom
trigger, so retiring the tag needed both controls off the floor and only the
sort control left. `agencyonly/index.html` LOSES it — `.find-bar`/`.find-sort`
never appear in `app.js`, so the tag was never justified there; verified
nothing else on that page sits under the 16px iOS floor. `/accessibility/`'s
"what does not work yet" list is narrowed to name the creator app alone.

Verified in a credential-free harness (`/tmp/lynxr-findbar-harness/`, not in
the repo) using same-origin iframes at fixed CSS widths as a stand-in for a
real viewport resize — the sandbox's browser window would not actually resize
to 320/390/1440 (`resize_window` reported success but `innerWidth` never
moved), so each width was measured via an iframe of that exact width instead,
which gets its own independent CSS viewport. Confirmed there: painted
font-size and height deltas above, no `style="…"` attribute ever written, zero
CSP console violations, keyboard-only operation (Enter/Space/Arrow/Home/End
open, arrows stop at the ends with no wrap, Enter commits and returns focus to
the trigger, Escape cancels without changing the value, Tab closes without
committing), and opening one bar's menu closes the other's. **Not verified
live in the real signed-in app** — no credentials were available in this
session; the harness proves geometry and behaviour, not integration. Also not
verified: VoiceOver's literal announcement (checked structurally via the
accessibility tree instead — `aria-haspopup="listbox"`, name carries the
current value) and `prefers-reduced-motion` under live emulation (no CDP
emulation tool in this session; the `@media (prefers-reduced-motion: reduce)`
rules are in place and reviewed, not exercised).

**2026-08-19 (later) — the public site became a real site, the paid-views sweep
learned to see a fresh paste, and the legal set got written.** No plan file:
this was a long interactive session, driven by the owner reviewing the preview
and correcting it.

### The bug that made the Apify work nearly useless

`fetch_meta` stamps `metrics_at` at **paste** time while leaving `views` as
`None` — the paste path never pays. So a brand-new Instagram row was neither
null nor older than `VIEWS_PAID_MAX_AGE_H` (168h), and **`refresh_views()`
could not see it for a week**. A creator pasting a reel would have watched a
blank where the count goes until the following Tuesday. This is the same
mechanism that stranded 7 rows earlier the same day.

Fixed with `views_or_clause(now, max_age_h, retry_h, retry_window_h)` — pure and
top-level, for the same reason `too_young()` is: the *selection rule* was the
thing that was wrong, so it has to be testable without a database. Paid pools
get a third way to qualify: `views IS NULL` **and** `first_seen_at` younger than
`VIEWS_PAID_RETRY_WINDOW_H` (24h) **and** `metrics_at` older than
`VIEWS_PAID_RETRY_H` (2h). A real paste succeeds on its first retry, ~2h in. A
genuinely dead post (deleted, private) costs ~12 lookups over the window,
about **$0.03**, then falls back to the weekly clock forever instead of being
retried every sweep at $0.0023 a time until somebody notices.

**No schema change** — `lynxr_sources.first_seen_at` already existed. The naive
fix (just select `views IS NULL`) is the trap: unbounded spend on dead posts.

Proven three ways, because `refresh_views()` swallows exceptions and a
malformed query would have **silently stopped all refreshing forever**:
PostgREST accepts the nested `and(...)`; the retry branch positively selects an
absent row and no row that already has a number; `test_views.py` is at 63
checks. Coverage after the backfill: **23 of 24 Instagram rows carry a real
count**, 15 creator cards show one.

### The public site

`/` is now **hero → how it works → our team → footer** and nothing else. Case
studies, testimonials, explainers, video demos, metrics and a client-logo strip
were all considered and cut. Lynxr presents as its own product; the Lynx Media
Group affiliation is carried by the footer credit alone.

New: `/waitlist/` (the form moved off `/` onto its own URL), `/faq/` with
`FAQPage` JSON-LD, `/accessibility/`, `robots.txt`, `sitemap.xml`, and one
shared floating-capsule bar + footer spliced from a single definition onto all
six public pages. Nav centring measured at **0.00px off** on every page.

Shape language is **capsules for controls, circles for small affordances,
generous corners but not capsules for containers**. Two padding tiers: generous
for primary CTAs, slight for chips. **The caret clearance rule is optical, not
`padding ≥ radius`** — on a capsule the curve reaches the edge at mid-height and
only intrudes near top and bottom (~0.7px for text, ~2.4px for a caret), so
`padding ≥ radius` would produce absurdly chunky pills. Measured clearance on
the wait-list field: 12.63px at 390px.

The bar **slides** out and back rather than fading — which also deleted the
`visibility`-delay machinery whose directional bug made the reveal pop. Mobile
hamburger below 760px. The hero ring pulse animates **`inset`, not
`transform: scale()`**: scale is proportional, so on a 199×70.8 capsule it added
15.6px at the ends and only 5.6px top and bottom, a 2.8× asymmetry that read as
a horizontal halo.

**Two bugs that would have shipped silently.** `site.js` was **CSP-blocked on
`/privacy/`, `/terms/` and `/accessibility/`** — those three had
`default-src 'none'` with no `script-src`, so the bar and burger were dead on
all three and the only trace was one console line. And the **wordmark text
vanished under 640px on all six public pages**, because a `max-width: 640px`
rule written for the *agency app's* header matched the new `.lp-bar`, which is
also a `<header>`. Exactly the shared-stylesheet trap this file keeps warning
about.

`--text-3` (3.76:1) was painting the site nav, footer tagline and © credit —
fine for an icon, fails AA for text. Those three text uses moved to `--text-2`
(**7.92:1**). Icons and the `aria-current` dot stay at `--text-3` deliberately.

### The legal set

Terms of service written and published. **Both `/terms/` and `/privacy/` now
say 18 or older** — for a while they contradicted each other, terms at 18 and
the privacy policy's children section still at 13. Massachusetts law, Suffolk
County venue. The registration-number line was deleted rather than filled: it
is not required on a terms page.

**Four `.legal-todo` red flags remain on purpose** and must stay visibly red:
billing (to be completed when pricing exists), the liability cap (drafted, not
reviewed), governing law (drafted, not reviewed), and the banner that explains
the convention. The two "drafted, not reviewed" clauses stop being theoretical
**the moment a payment is taken** — that is a stage-2 prerequisite, not a
stage-1 one.

`/accessibility/` names two real gaps rather than claiming conformance:
pinch-zoom is suppressed on the two signed-in app pages (a WCAG 1.4.4 trade the
owner accepted so the find-bar type could match its surroundings; the public
pages stay fully zoomable), and `.bp-wait` measures 3.39:1 in list rows.

### Decisions from this session — do not re-litigate

- **Tagging stays on Opus 5.** The swap to Haiku 4.5 was made, verified live
  (HTTP 200, effort correctly omitted), and then **reverted** — unmeasured, and
  the whole creator-path saving is under $1 across every script ever written.
  It buys no latency either: tags run in parallel with the shot list and shots
  are the longer of the two.
- **The $11 Opus-vs-Haiku tagging A/B was declined**, correctly — it settles a
  question worth well under a dollar on the creator path.
- **The ~9,000 previously scraped `lynxr_videos` rows are out of scope**, by
  standing instruction. Do not propose re-tagging, re-scraping or refreshing
  them; scope any migration to `data_source = 'Creator'`. They are **not** to be
  deleted — they back the agency app's database view.
- **Haiku 4.5 cannot cache the tag prefix.** Its minimum cacheable prefix is
  4,096 tokens and the tag prefix is ~1,978, measured `cache_creation = 0`
  against 1162/1553 for the two Opus calls. That compresses the headline 5×
  price gap to about 3× and is worth knowing before anyone re-proposes the swap.

### Still open

- **yt-dlp is unpinned in the thing that matters.** `requirements-ci.txt` says
  `yt-dlp>=2024.1`, so Fly and CI silently take whatever is newest at build
  time. That is what turned the progressive-format removal into a hard failure
  with no code change and no deploy — the worker's behaviour moved underneath
  it. The new `DL_FORMAT` is verified on both 2026.07.04 and 2026.08.19, but
  the underlying exposure is unchanged: pin a version and upgrade it
  deliberately, or accept that YouTube can break the worker on any rebuild.
- **Answers given during the wait do not reach the script being written.**
  `process_group` reads the creator row when it claims the job and passes that
  in-memory `data` down to `fill_adaptation`, which builds the prompt ~35–40s
  later (right after `publish("writing")`). So a creator who answers "no, I
  have not used this" while watching the bar still gets a script written
  without that fact. The fix is one re-read of the row in `fill_adaptation`
  immediately before `brand_digest()` — `graft_adaptations` already does a
  locked whole-row read-modify-write, so the pattern exists — but it puts a
  network call on the hottest path in the pipeline and adds a race worth
  thinking about, which is why it was split out rather than shipped with the
  rest on 2026-08-25. Until it lands, the wait card must go on saying "from
  here on" rather than "this one".
- **The estimate does not count down inside a phase.** `PHASE_LEFT` is a
  constant per phase, so `etaFor()` says "about 17 seconds left" for the whole
  of `writing` — at 3 seconds in and at 60. The progress bar now covers for it
  (it moves continuously off `phaseAt`), which is why this was left alone, but
  the sentence and the bar disagree by the end of a long phase and the
  arithmetic to fix it is already sitting in `etaProgress`.
- **`upsert_video()` still writes `views = meta.get("views") or 0`**
  (`process_adaptations.py`), so every creator-pasted Instagram video enters
  `lynxr_videos` with a fake zero. It was deliberately not fixed:
  `lynxr_videos.views` is `bigint not null default 0`, so absent-as-absent needs
  a **schema change** on a table the owner has put out of scope. Owner's call.
- **`SUPABASE_SERVICE_ROLE_KEY` in GitHub Actions still has a trailing
  newline.** `envcfg` strips it so CI is green, but the secret itself is
  malformed and should be re-saved.
- **Nothing iOS is verified.** No iPhone available and the automation browser is
  Chromium — so the pinch-zoom suppression, the literal 16px behaviour, iOS
  rubber-band clamping and the `position: fixed` body-lock restore are all
  reasoned, coded, and unproven on the target platform.
- **The card meta-row one-line matrix was not re-measured** after the capsule
  padding work; it needs a signed-in session and the real `pingo ai` TikTok
  record (`script ready` + eye + `31` + `0:17`, the only row in the corpus with
  both a view count and a brand-page chip). Every creator-app component
  measured byte-identical to HEAD, so it cannot have moved — but the previous
  worst case of **4.0px at 320px** stands unchecked.


**2026-08-19 — Instagram now has real view counts too, paid for through the
agency's own Apify actor, riding the idle sweep and nowhere near the paste
path.** `~/.claude/plans/instagram-view-counts-via-apify.md`, 10 steps,
implemented in the working tree.

**Why this exists.** The plan above (`creator-card-view-counts.md`) shipped
the honest `None`-not-`0` slot but measured yt-dlp's ceiling: it returns no
view/play count for Instagram on any unauthenticated route, ever — 19 of 22
distinct pasted videos. The owner's answer: **the agency side has had
Instagram view counts all along**, via `apify/instagram-scraper` in
`pipeline/scrape_instagram.py`. This plan extends the existing
`video_views()` chokepoint with that same actor as a second, paid source.

**The measured facts (2026-08-19, live API, $0.0138 spent investigating).**
Actor `apify/instagram-scraper` (id `shu8hvrXbJbY3Eb9W`, path form
`apify~instagram-scraper`), one POST to `run-sync-get-dataset-items`:

    {"directUrls": ["<post url>"], "resultsType": "posts",
     "resultsLimit": 1, "addParentData": false}

returns `videoPlayCount` for a single direct post URL, on `/reel/`,
`/reels/` and `/p/` alike, at **$0.0023/lookup, 7–23s** (33.7s on a
not-found — **also billed**, and why this never rides the paste path: the
`meta_thread.join(timeout=20)` budget can't absorb it, and losing the box
loses the title too). Same actor and input shape `pipeline/add_urls.py`
already uses by hand via the `apify_client` SDK — confirmed independently,
not reused directly, because that script runs on the Mac and pulls in a
dependency (`apify-client`) that is deliberately absent from
`requirements-ci.txt` and the Fly image; the new code speaks the same REST
endpoint over plain `urllib` instead. Failure shape: `{"error": "not_found",
"errorDescription": "Post does not exist"}`, no count field, still billed —
`apify_item_views()` treats any `error` key as absent.

**The refresh clock: 7 days, not 24h — chosen for cost, not accuracy.**
Refresh cost scales with the cumulative corpus × frequency:

| staleness | today (24 rows) | +6mo (534) |
|---|---|---|
| 24h | $1.66/mo | **$36.85** |
| **168h — chosen** | **$0.24/mo** | **$5.26** |

`VIEWS_PAID_MAX_AGE_H` (default `168`) is the env var that reverses it to
24 if the owner ever wants that. **The account was at $36.37 of its hard
$50/month ceiling** (shared with the agency's `clockworks/tiktok-scraper`,
`apify/instagram-reel-scraper` and `streamers/youtube-shorts-scraper`
actors — four actors, six files, on one pool) when this plan was written;
re-checked live before this session's spend, unchanged at $36.38.
`apify_budget_ok()` reads Apify's own `/v2/users/me/limits` ledger (not a
local counter — the agency scrapes and `add_urls.py` spend from the same
pool and a local counter would not see them) and **fails closed at $45**,
leaving $5 of the account's own $50 headroom for the agency. Every single
`apify_views()` call passes through this check unconditionally — there is
no second path to the network call.

**No owner SQL action needed.** `lynxr_sources.views` was already nullable
and already carries `metrics_at`, same as the previous plan left it.

**Superseded and abandoned:** the cookie/session plan
(`~/.claude/plans/instagram-authenticated-view-counts.md`) — this route
needs no session and is a paid public API used exactly as sold. One
conflict flagged, not edited: `~/.claude/memory/lynxr-age-gate-auth-declined.md`
says "Apify tested and also blocked, so don't re-propose it" — that is
about the *age gate* (a different, tested-and-rejected use of Apify, see
"ruled out" below) and is still correct there.

**2026-08-19 — creator card view counts are real now, and a stored `0` no
longer means "unmeasured."** `~/.claude/plans/creator-card-view-counts.md`,
15 steps, implemented in the working tree.

**The bug.** `process_adaptations.py`'s `fetch_meta()` did
`int(d.get("view_count") or 0)`, so a platform that told yt-dlp nothing was
stored as a measured `0` — indistinguishable from a real zero-view video, and
the reason `lynxr_sources.views` and every creator entry's `source.meta.views`
looked populated everywhere while being empty almost everywhere. Nothing
re-read the number either, so it drifted: a live TikTok row stored as `27`
read `31`; another stored as `190,500` read `191,000`.

**The honest ceiling, measured 2026-08-19 (yt-dlp 2026.07.04, the pinned
release — confirmed current on PyPI):**

| platform | hands back a view count, unauthenticated? |
|---|---|
| tiktok | yes — drifts, hence the refresh |
| youtube | yes — watch, youtu.be and /shorts/ all report it |
| instagram | **no, by any UNAUTHENTICATED yt-dlp route** — pinned release, the 2026-08-18 nightly, the `app_id=ios` extractor arg, the public `/embed/` page and unauthenticated oEmbed all return nothing. Needs a session for yt-dlp specifically; authenticated fetching (cookies/session) was declined 2026-08-18 (below) — **re-testing yt-dlp routes is not free, all five are already ruled out**. That is NOT the end of the story, though: **the count now comes from a PAID route instead** — see the 2026-08-19 "Instagram now has real view counts" entry at the top of this section. `apify/instagram-scraper`, $0.0023/lookup, no session, no cookies — a paid public API used as sold, not a reopening of the declined authenticated-fetching route |
| facebook | returns a number, but on the one live **Facebook Reel** measured it was `407` while that same response's Facebook-written title read `"9.8K views · 343 reactions"` — 24× low on the short-form shape, which is the shape creators paste. Kept OUT of `VIEWS_TRUSTED_PLATFORMS` (`process_adaptations.py`, next to `SUPPORTED_HOSTS`) — reversible by adding `"facebook"` to that one tuple, there are zero Facebook rows in the corpus today |

Instagram is 19 of 22 distinct videos creators have pasted. Coverage
**as of this plan alone was 3 of 22 (13.6%)** free via yt-dlp — but as of
the 2026-08-19 Apify plan at the top of this section, coverage is **22 of 22
distinct videos on a views-capable source: 3 free via yt-dlp, 19 paid via
Apify** (subject to the 168h staleness clock and the $45 spend breaker).

**The fix.** `fetch_meta()` now returns `"views": trusted_views(url, raw)` —
`None` when the platform reported nothing or the platform isn't trusted,
the real `int` (including a genuine `0`) otherwise — plus a `metricsAt`
stamp. `source_metrics()` is the one place that writes the `lynxr_sources`
metric columns (from `upsert_source`, `backfill_source_metrics.py`, and the
new refresh below), so the three can't drift. `platform_of()` was also
matching the URL by substring, which filed `youtu.be`, `fb.watch` and
`fb.com` under `"other"` — every trust-list and refresh query keyed on
platform silently missed them. It now matches the hostname, same as
`supported_url()`.

**The refresh.** `refresh_views()` re-reads `lynxr_sources` rows on
`VIEWS_TRUSTED_PLATFORMS` whose `metrics_at` is missing or older than
`VIEWS_MAX_AGE_H` (24h), re-fetches, writes the source row, and pushes the
number to every creator entry holding that video (`apply_views()` /
`refresh_entry_views()`, modelled on `renew_claim()` — re-read fresh under
the same per-creator lock, never a snapshot; skips `queued`/`running`
entries and entries with no existing `source.meta`). Only fires from
**`worker.py`'s periodic-sweep branch**, and only when
`process_adaptations.py`'s own pass finds nothing queued
(`--refresh-views`) — never from the queued-work branch, and never from
`.github/workflows/adaptations.yml`, which runs the same script every ~60s
in parallel and would otherwise double the requests and race the sweep on
the same `lynxr_creators` read-modify-write. **Measured rate**: 3
TikTok/YouTube rows today → 3 fetches/day, ~9s of yt-dlp; a second
`--refresh-views-now` run immediately after the first considered 0 rows,
proving the staleness gate bounds the request rate, not the per-pass
budget.

**The migration ran 2026-08-19.** `pipeline/backfill_views_null.py`
(`--dry-run` first, matched) nulled the 19 creator entries (13
`adaptations` + 6 `trash`, all `status: "done"`) and 7 `lynxr_sources` rows
that were Instagram `0`s left over from the old coercion — independently
re-verified against the live DB before running (all 19/7 were Instagram,
all `status: "done"`, no TikTok/YouTube/Facebook row anywhere was ever 0).
Live afterward: `lynxr_sources` reads 24 NULL / 3 measured (the TikTok rows,
now self-refreshing — `929`, `31`, `191,000`); zero rows anywhere read `0`.
**No new owner SQL action is needed** — `lynxr_sources.views` is already
nullable and `sources_staff_read.sql` is already applied.

Verify with:

    ./venv/bin/python pipeline/test_views.py         # new, 27 checks
    ./venv/bin/python pipeline/test_ai_retry.py       # 200 checks, unchanged
    ./venv/bin/python pipeline/test_prefilter.py      # 40 checks, unchanged
    ./venv/bin/python pipeline/test_watchdog.py       # 89 checks, unchanged
    ./venv/bin/python pipeline/test_envcfg.py         # 19 checks, unchanged
    ./venv/bin/python pipeline/watchdog.py --once --dry-run --json   # []

Painted-pixels verified live in `/creatorsonly/`: the `@lynxr.io` TikTok card
shows the eye icon at `31` (not the stale `27`); every Instagram card shows
no eye icon at all.

**2026-08-18/19 — a trailing newline on the Supabase secret killed every
GitHub run since #168, and silenced the external half of the dead-man's
switch at the same time. Both fixed, and the alarms rescoped to page only
when a creator is affected.** `~/.claude/plans/alarms-creator-impact-and-secret-newline.md`,
18 steps, implemented in the working tree.

**The incident.** Every `.github/workflows/adaptations.yml` run has failed
since run #168 (2026-08-18 07:57Z). `SUPABASE_SERVICE_ROLE_KEY` was saved as
a GitHub repo secret with a trailing newline, and `http.client.putheader`
refuses any header value containing one — so `sb()` died with `ValueError:
Invalid header value b'***\n'` on the first Supabase call of every pass. Ten
consecutive failed passes tripped the tripwire and the job's `if: failure()`
curl paged the owner. Worse: `pipeline/watchdog.py --once` died on the
IDENTICAL error in the same loop and then printed `no breaches` — a false
all-clear. Because the GitHub-side caller was the only one that could
structurally raise `worker-down`, the external half of the dead-man's switch
was itself dead: if Fly had died at the same time, nothing would have paged.
Verified NOT a code bug — the same command runs clean locally and Fly was
healthy throughout.

**The fix.** `pipeline/envcfg.py` (new) is now the one place a secret or
config value is read out of the environment — `clean()`/`first()`/`get()`
strip whitespace, `secret()` additionally refuses a value with whitespace
left INSIDE it (an embedded newline `.strip()` cannot fix) and raises naming
the variable, never the value. `sanitize_environ()` cleans `os.environ` in
place for readers this repo does not own (the five scripts that build
`anthropic.Anthropic()` with no `api_key` and let the SDK read
`ANTHROPIC_API_KEY` straight out of the environment). Every env-read site in
`pipeline/` — the watchdog, both workers, and thirteen other scripts — now
goes through it; `pipeline/test_envcfg.py` (19 checks) reproduces the exact
CI failure offline against the real `http.client`, proves it is fixed, and
proves no secret value ever lands in a raised error's message. `.env` was
never at fault — every `load_env()` copy already stripped what it parsed —
so `load_env()` itself was deliberately left untouched; the newline arrives
through `os.environ`, from GitHub.

`pipeline/watchdog.py`'s `run_once()` no longer returns `[]` on a failure to
read the database — that read as "checked, nothing wrong" to `main()`, which
is exactly the false all-clear above. It now returns a `watchdog-blind`
sentinel (does not page — a fresh-process GitHub loop can't dedupe, and the
same failure trips `process_adaptations.py`'s own tripwire within ~10
minutes anyway), and `main()` prints `CHECK FAILED — could not read the
database` and exits 2, never `no breaches`.

**The alarm rescope.** The owner's rule, in his words: *"add things that
would need my attention, like a script didnt get back, dont ping me for
useless things like if the backup failed but the fly worked so the creator
got their video."* Every alarm now carries a `page` bit:

| stays a page | now digest-only (`page: False`) |
|---|---|
| `inflight:<id8>` / `inflight:many` | `rerun:<id8>` — double-billed, creator still got their script |
| `empty-script:<id8>` | `sources-stalled` — analytics sensor, no creator impact |
| `gave-up:<id8>` | `softfail:<sub>` — script was still delivered |
| `fetch-wall:burst` | |
| `spend-24h` (reworded in creator terms) | |
| `worker-down` (now tri-state, see below) | |

`RERUN_WINDOW_S` widened 24h → 48h so a rerun 25h before the digest can never
go unreported by anything. The digest gained a `quiet:` line — the ONLY place
a demoted alarm is ever reported — alongside the narrowed `open alarms:`
line, which now names paging alarms only.

**`worker-down` now knows whether the GitHub fallback is covering**, via a
new `fallback.heartbeat` key in `lynxr_ops` that `adaptations.yml`'s polling
loop writes every ~60s (`watchdog.py --once --as-fallback`). Tri-state, one
latch key so it stays one episode: priority 3 ("fly down, github covering" —
degraded, not down, but no redundancy left — still makes a sound, still
"would need attention" since the next failure is total), priority 5
("NOTHING is writing scripts" — both down), priority 4 (cannot tell —
today's original wording). `raise_alarm()` now re-pages immediately if an
open episode's priority increases, so 3 → 5 can't stay silent for up to 24h
inside the old reminder window. The workflow's own `if: failure()` curl (both
`adaptations.yml` and `latency-watch.yml`) is retired — replaced with `python
pipeline/watchdog.py --ci-failed`, which reads `worker.heartbeat` before
deciding whether to page at all, and always exits 0 (the job is already red).

**Verified live, 2026-08-19 ~01:23 UTC** (independently, not on the plan's
own say-so): `lynxr_ops` holds exactly two rows, `worker.heartbeat` (~49s
old) and `digest.last` (~10.4h old, timestamped 15:00:36 UTC — matches
`DIGEST_HOUR_UTC`). `fly status` shows the machine last updated
`2026-08-18T21:20:45Z`, 63 seconds after the current HEAD commit
(`6768fc6`, pushed `2026-08-18T21:19:42Z`) — `fly releases` confirms that
deploy is v19, the latest, and every deploy since `v9` (the first of
2026-08-18) landed within roughly an hour of its triggering push. So Fly is
alive, beating, and running code at least as recent as tonight's HEAD.

Verify with:

    ./venv/bin/python pipeline/test_watchdog.py      # 89 checks (44 + 45 new), all pass
    ./venv/bin/python pipeline/test_ai_retry.py      # 200 checks, unchanged
    ./venv/bin/python pipeline/test_prefilter.py     # 40 checks, unchanged
    ./venv/bin/python pipeline/test_allowance.py     # 13, unchanged
    ./venv/bin/python pipeline/test_envcfg.py        # new, 19 checks
    ./venv/bin/python pipeline/watchdog.py --once --dry-run --json   # []

**Not yet deployed** — Fly needs to pick up this push before its own loop
carries the newline fix and the rescoped alarms; the GitHub workflows pick up
the fix on their next run after push. **One belt-and-braces owner action
remains**: re-save the GitHub `SUPABASE_SERVICE_ROLE_KEY` secret without the
trailing newline. The code no longer needs it to be clean, but the stored
value is still wrong and worth fixing at the source.

**2026-08-18 — a paste that stranded an entry now reaches a final answer
instead of re-running it every six hours forever.**
`~/.claude/plans/creator-video-to-script-reliability.md`, 12 steps,
implemented in the working tree. The owner's directive: "make it so that
lynxr works well, like video to script with minimal errors." Measured against
the live database, errors are already rare — **21 of 22 distinct pasted
videos produced a script (95.5%)**, and the single failure is an age-gate,
closable only by authenticated fetching (below). Ranked by likelihood ×
impact:

| # | Class | Measured | Planned? |
|---|---|---|---|
| 1 | An entry that can never reach a final answer | 0 live, reachable from one 529 at the adapt step | **Yes — Steps 1–4** |
| 2 | The fetch wall (age-gate) | 1 of 22 distinct videos (4.5%) | Decision required, not code — Apify ruled out (below) |
| 3 | Silent systemic fetch breakage (yt-dlp extractor rot) | 0 so far, but nothing paged it | **Yes — Step 8** |
| 4 | Transient Anthropic failure (529) | 1 of 30 records (3%), self-healed | **Yes — Step 6** |
| 5 | A thin script that looks like a success | 1 of 25 branded scripts (4%): 1 beat against a 6-beat format | **Yes — Step 7** |
| 6 | Latency | 11 of 27 over 120s | No — deprioritized by the owner |

**The state machine had a hole: `not a.get("format")` was the wrong
question.** `ai_gave_up()` used to end `and not a.get("format")` — but a
**branded** entry that extracted its format and then keeps failing the adapt
call always HAS a format, so it could never satisfy that test.
`ai_retry_due()` returns False past `AI_MAX_TRIES`, so `wants_work()` fell
through to the 6-hour `cooled()` floor and retried the entry forever, at a
full download + Whisper + shots + tags + adapt pass each time. Measured on the
real `run_entry` over that exact shape: `status error | final None None |
tries 8 | wants_work (6h later) = True`. Worse than "we're retrying" forever:
`fill_adaptation` clears the note and re-raises the generic `"no script was
produced"`, which `run_entry` classified from the **exception text** rather
than the `aiFail` marker on the row — so a 529 of ours read on the card as
`we couldn't write a script from that video.`, blaming the creator's video for
our overload, while the worker silently re-ran and re-billed it every six
hours.

**Four sites now write a `final`/`finalWhy` verdict, and one floor in
`wants_work()` respects it.** `has_usable_result(a)` replaces the old test —
a branded entry needs beats; a no-brand entry (the source read back) needs a
format, shots or a transcript. `mark_final()` is the only writer of
`a["final"]`; `final_reason()` is the pure decision function (`"wall"` for a
recognised permanent wall, `"gave_up"` for exhausted retries with nothing
usable, `"no_script"` for a model refusal, `"exhausted"` for
`FINAL_MAX_PASSES` — 12 passes, ~3 days, the universal backstop for shapes
nothing else enumerates). `wants_work()`'s error branch now returns False
immediately when `final` is set and `--redo-ai` was not passed — the
automatic loop's floor, not a lock: `--redo-ai` still forces it, a stale
`final` on a `queued`/`running` entry is still ignored so Try again and claim
recovery are never dead. `run_entry`'s except handler classifies from
`(a.get("aiFail") or {}).get("kind")` first, falling back to the exception
text only for failures that never marked one — so the sentence agrees with
the marker that actually drives the retry schedule. Measured after: `final
True gave_up | tries 8`, the gave-up sentence containing the try count,
`wants_work` (6h later) `False`. `structured()`'s JSON-decode/text-extraction
failures (a bare `ThinkingBlock`, a truncated body) are now classified
`transient` via a `"malformed model response"` needle, not `content` — a
shape fluke is not a refusal, and Step 4's terminal treatment of `content`
would otherwise strand an entry on a one-off decode hiccup.

**The Anthropic SDK's own retry budget was raised, not hand-rolled.**
`anthropic_client()` is now the one place the client is built, with
`max_retries=5` (was the SDK default of 2). Measured locally against a stub
server that always returns 529: default `max_retries=2` makes **3 requests in
1.4s** and gives up; `max_retries=5` makes **6 requests in 13.8s** (0.5/1/2/4/8s
exponential backoff with jitter, honouring `retry-after`). A hand-rolled retry
loop on top would have multiplied attempts (5 × 2 = 12 calls) — exactly the
mistake the removed duplicate `extract_format` call was making. Honest
caveat: the tester's real incident was three separate calls answering
"overloaded" across tens of seconds, each having already retried 3× — an
episode that outlasted even 14s. This shrinks the transient class; it does
not remove it. The five-minute scheduled retry is still the backstop.

**A script too short to be the format it reused now gets asked again.**
`ADAPT_SCHEMA` already enforced `minItems: 1` and a total-empty response was
already re-asked once; the gap was the one that shipped: **1 of 25 branded
scripts** came back with 1 beat against a 6-beat extracted format, passed
every guard, and rendered under a "script ready" chip. `thin_script(ad, fmt)`
thresholds on `beats < format_beats / 2`, guarded on a format of at least 3
beats. `fill_adaptation`'s re-ask condition now fires on `thin_script`, not
just an empty list; if the second answer is still thin, it is **kept** (a
short script beats no script) and recorded on `a["thin"]` so it is not
silent. `FUSE_FORMAT_ADAPT`'s branch (default OFF) still records the marker
but has no second ask — noted in a comment so the guard is never assumed to
cover it.

**Two failure shapes that were invisible to the pager now page.**
`gave-up:<id8>` fires on `status error + final + finalWhy in (gave_up,
no_script, exhausted)` inside 24h — scoped so a permanent platform wall
(`finalWhy "wall"`) does NOT page, since that class is the creator's own link
and cannot be fixed by anyone waking up. `fetch-wall:burst` fires when 3+
**distinct** source videos (not records — a brand fan-out inflates records)
refuse to download inside 6h, closing the gap where `sources-stalled` needs
3+ *finished* scripts and `inflight:` needs a stall — a fast, accurate wall is
invisible to both. `digest()` gained a quiet, no-page `quality: N thin · N
given up (24h)` line. Neither alarm fires on the live corpus:
`./venv/bin/python pipeline/watchdog.py --once --dry-run --json` still prints
`[]`.

**Apify is ruled out empirically, for both fetch fallback and failure
classification — recorded here so nobody re-litigates it.** Tested against
the exact failing URL (`https://www.tiktok.com/t/ZP8W5NcUh/`, TikTok id
`7524866777004723486`, adaptations `60ebb1f1`/`bf6894ad`) with
`clockworks/tiktok-scraper` — the same actor `pipeline/scrape_tiktok.py`
already uses, already disclosed in `privacy/index.html`:

    run SUCCEEDED, exit 0, 1 item:
    {"error": "Post is sensitive content.", "errorCode": "POST_SENSITIVE",
     "url": "https://www.tiktok.com/t/ZP8W5NcUh/"}
    actor log: "The video is with sensitive content. The scraper is not able
    to see posts that require login, skipping"

A control URL (ordinary public TikTok `7526390954685730078`) returned a full
record, so the integration is healthy and correctly configured — the wall is
the wall. Apify hits the same login gate as yt-dlp. Its one typed advantage
(`errorCode` vs. yt-dlp's regex-matched prose) was rejected as a classifier
too: it would cost a paid Apify run per failure just to buy a better label on
a card that is already accurate for every class seen; Step 8's alarm is what
makes a wording drift visible, not a paid classifier.

> **2026-08-19 — this ruling is correct in its own scope and wrong as a
> general claim about Apify.** It rules out Apify for the age-gated TikTok
> *download* wall and for *failure classification* — both tested against
> the exact failing URL above, both still correctly rejected. It does
> **not** rule out Apify for **view counts**, which is a different question
> with a different, measured answer: `apify/instagram-scraper` returns a
> real `videoPlayCount` for a public Instagram post URL, no session needed,
> because a view count is public post metadata the actor is sold to return —
> not a login-gated download. See the "Instagram now has real view counts"
> entry at the top of this section. Do not read this paragraph as grounds to
> re-reject that work.

**DECISION REQUIRED, owner only — authenticated fetching is the only
remaining route to the age-gate class**, and therefore the only thing between
the measured 21/22 and "~99% of every paste." Nothing here implements it.
What it would be: yt-dlp `--cookies <file>` (never `--cookies-from-browser`,
which needs a browser profile a container doesn't have) behind an env var,
default off. What it costs, honestly: a dedicated throwaway TikTok account
(never the owner's, never a client's — a datacentre-IP session cookie is a
known ban trigger); a different posture under platform terms than fetching
public pages, which the owner takes on knowingly; the cookie file is a
credential (`fly secrets set` + a base64'd GitHub Actions secret, never in the
repo or a log line); cookie expiry is the normal case, not the exception, and
must degrade to exactly today's wall (refunded, no Try again) plus one alarm,
or the feature silently becomes an outage; and it does not close the ceiling
— deleted and private videos stay irreducible either way. If declined, the
wall this plan ships is accurate, fast, free (refunded), and now — new —
*bounded*, so it stops re-downloading a video the platform will never hand
over.

Verify with:

    ./venv/bin/python pipeline/test_ai_retry.py     # 200 checks (155 + 45 new)
    ./venv/bin/python pipeline/test_prefilter.py     # 40 checks, 0 misses out of 10,854
                                                      # wants_work-True combinations (24,300 total)
    ./venv/bin/python pipeline/test_watchdog.py      # 44 checks (32 + 12 new)
    ./venv/bin/python pipeline/test_allowance.py     # 13, unchanged
    ./venv/bin/python pipeline/watchdog.py --once --dry-run --json   # []
    ./venv/bin/python pipeline/latency_report.py --since 30d --sla 60  # medians unchanged

All of it is Python in `pipeline/` — no front-end file changed, so `?v=` stays
`20260822a`. **Not deployed** — Fly still runs the old worker. *[FLAG
2026-08-19: this looks stale — see the "Where this left off" entry at the top
of this section. Fly has redeployed repeatedly since (v9 → v19,
`fly releases`), and the machine now running was last updated 63s after
tonight's HEAD commit. Confirm with `fly status` before deleting this line.]*

**2026-08-18 — every script and library card now carries a real title, read
off the record with no network call.** `~/.claude/plans/creator-real-script-titles.md`,
11 steps, implemented in the working tree. Cards had been reading "Instagram
reel" / "Instagram post" / "TikTok video". Two stacked bugs, neither of them
"hydration needs more retries":

**The worker fetched the real caption and threw it away.** `fetch_meta()` ran
AFTER the completion graft, and the graft is the only thing that writes to the
creator's row — so `source.meta` was fetched, used for the two library upserts,
and dropped. Provable by date: every record processed before 2026-08-18 03:32
carries `source.meta`, every one after carries none. That boundary is commit
`a66fe51`, which moved the call to keep 1.4s off the 60s SLA. It bought the
latency and silently cost the titles. `creator.js` had never read `source.meta`
at all. It now runs in a thread alongside the 11s source pass — one lookup per
VIDEO, not per brand — so the caption rides the existing graft at ~0 cost.

**A generated label was frozen into the record and then looked real.**
`queueAdaptation` stored `title: sourceLabel(item)`, so a video sent before its
caption loaded stored the literal string "Instagram reel". `realTitle()` treats
a permalink as absent but not a platform label, so it satisfied every
`title || fallback` test and blocked `hydrateScript`'s guard forever — 8 live
records were stuck. It now stores `realTitle(item.title)`: only a genuine
caption is ever written.

Three divergent client label chains collapsed into one resolver (`videoTitle`,
via `metaTitle` → `ownWordsTitle` → `handleLabel` → `platformKindLabel`) that
reads the record and never the network. **The captionless fallback is the
video's own opening line** (owner's decision, 2026-08-18), taken from the
transcript already on the record. The generic platform label now survives only
for a link the pipeline never fetched — 3 of 30 live records, 2 of which
already show a "couldn't fetch" chip.

**A LESSON, because it nearly shipped silent.** `ownWordsTitle()` first read
transcript segments as objects (`.text`). They are TUPLES —
`pipeline/transcribe.py` writes `[start, end, text]`, `process_adaptations.py`
reads `for st, en, txt in script["segments"]`, and `adaptationHtml`
destructures `([st, , txt])` two functions away in the same file. So the
owner's chosen fallback was dead code returning `""` for every real record, and
those cards fell straight through to "Instagram reel" — the exact string the
work existed to remove. The step's own test harness could not catch it: two of
its three fixtures used `segments: []`, so that rung was never exercised. Found
only by rendering a real record shape in a browser. **Fixtures that skip a
branch prove nothing about it.**

**The paste disclosure moved out of the composer into Settings** (owner's
decision), reworded so it stays true — the relay is still hit on a fresh paste,
because `hydrate()` fires on every send and a new library entry has no title to
early-return on. `privacy/index.html`'s relay sentence gained one clause
scoping it to paste time, matching. `PRIVACY_VERSION` deliberately NOT bumped:
narrowing an already-disclosed call adds no new data use, recipient or
retention, so a bump would re-prompt people over nothing.

Cache stamp is now `?v=20260822a` — the `20260821` letters had reached `z`.
**Not deployed** — Fly still runs the old worker, so live creators still have
the old titles until this is pushed. *[FLAG 2026-08-19: this looks stale —
see the top of this section. Confirm with `fly status` before deleting.]*

**2026-08-18 — the creator's failure card stopped leaking our internals, and
the retry clock stopped lying.** `~/.claude/plans/creator-failure-copy-and-rerun-alarm.md`,
19 steps, implemented in the working tree. A tester's paste hit an Anthropic
529 and the card read `read, but not written yet. tags failed: overloaded;
format extraction failed: overloaded; format extraction failed: overloaded`
under a chip saying `source only`. Three separate bugs in one screenshot.

**One writer owns creator-facing copy now.** `AI_FAIL_WORDING` became the
`CREATOR_NOTES` registry (`note_text` / `set_note` / `clear_note` / the
`CreatorFacing` exception); `a["note"]` is assigned in exactly one place and
raw text goes to `diag` and the log instead. The leak was never one missed
branch — six places wrote that field, so any future early return leaked by
default. Two paths nobody had listed were leaking too: the tail of
`fill_adaptation` wrote joined step notes onto **successful** entries, which
`creator.js` painted under a finished script.

**`done + brandId + no adaptation` is now unwritable.** The branded no-format
path raises instead of returning early, so `run_entry`'s handler is the only
exit. That state produced both the raw text and the wrong chip; `source only`
is deleted from `creator.js` outright rather than merely avoided.

**The retry cadence was inflated by ~12x.** `tries` counted one per failed
STEP, not per pass, because `fill_source` and the group-level `extract_format`
run before `run_entry` stamped `attemptedAt`. On 644ba12d that walked the
schedule to the 60-minute rung and the tester waited 62 minutes for a retry
that should have come in 5 — and their own Try again press made it worse, by
clearing `attemptedAt`. A dedicated per-pass `attemptId` fixes the count.
`attemptedAt` was deliberately NOT moved: it is the boundary
`latency_report.py` splits `source` from `adapt` on. `AI_MAX_TRIES` stays 8,
now meaning ~5.25h transient / ~19.75h billing.

**A script that never arrived no longer costs an allowance.** `refund()` fires
on AI give-up and on the error landing, so "Nothing was used from your
allowance" is true when it is shown. It was not before: the charge is taken at
claim time and only a source failure refunded it.

**The per-entry `extract_format` call is gone** — one paid Opus call per video,
not per brand. It was re-calling an API that had just answered "overloaded",
seconds later, outside the backoff. Removing it required the `attemptId` work
in the same change: that duplicate call was the only thing re-stamping an
original-script entry's marker, so removing it alone would have silently
stopped those entries retrying a failed format.

Verify with:

    ./venv/bin/python pipeline/watchdog.py --once --dry-run --json   # [] — was rerun:644ba12d
    ./venv/bin/python pipeline/latency_report.py --since 30d --sla 60  # medians must not move
    ./venv/bin/python pipeline/test_ai_retry.py                      # 155 checks

`pipeline/test_allowance.py` depended on the deleted `AI_FAIL_WORDING` name and
crashed at line 94, which silently killed the `charge_scripts` three-bypass
proof below it; it is rewritten against the registry. **Not deployed** — Fly
still runs the old worker. *[FLAG 2026-08-19: this looks stale — see the top
of this section. Confirm with `fly status` before deleting.]*

**2026-08-18 — the worker's discovery scan stopped pulling every creator's
whole blob to find out if anything is queued.** `~/.claude/plans/
worker-discovery-prefilter.md`, implemented in the working tree.
`process_adaptations.py`'s discovery step used to fetch `select=id,data` for
every creator and filter in Python — measured live at five creators,
214,900 bytes and 548ms, fired every 60s forever by `worker.py --sweep`.
`candidate_creators()` now asks Postgres a JSONB containment question first
(`prefilter_probes()` / `prefilter_url()`) — measured live, same five
creators: **2 bytes, ~200ms.** The per-creator double fetch is gone too: a
creator considered via the prefilter path is read once, not once in the scan
and again per creator.

The probes are a strict superset of `wants_work()`'s four conditions
(queued; abandoned running; cooled/retry-due error; retryable done+aiFail),
not just the `queued`-only probe `worker.py`'s `queued_creators()` already
used for its 2-second latency check. `pipeline/test_prefilter.py` proves the
superset property exhaustively — it brute-forces the closed `wants_work()`
state space (4,050 combinations, 2,106 of them `wants_work()`-True) and
asserts zero escape the probes — and separately proves the probes cannot
just match everything (an ordinary finished script, and a `done` entry whose
`aiFail.kind` is NOT retryable, must both stay unmatched).

**A broken prefilter falls back to the full scan and logs loudly, rather
than ever reporting an empty queue.** This mattered live: a malformed probe
(the `[...]` array wrapper dropped from around a containment value) returns
**HTTP 200 and zero rows** — indistinguishable from "nothing queued" with no
error at all. `candidate_creators()` re-checks an empty answer against a `[]`
canary (contained in every JSON array, so it must always match something)
before trusting it; if the canary also comes back empty, that means the
containment grammar itself is broken, not that the queue is empty, and the
code falls back to the old full scan with a `PREFILTER CANARY MATCHED
NOTHING` error in the logs.

`--redo-ai` and `--backfill-covers` still run the old full scan, **by
design** — `--redo-ai` widens the `done` branch to `"failed" in note`, which
no containment probe can express without matching nearly every row, and
`--backfill-covers` is a manual one-off across the whole corpus (including
`trash`) that has nothing to do with discovering queued work.

`supabase/creators_adaptations_gin.sql` is a new **open owner action**
(item 6 below) — a GIN index that buys nothing at today's five rows (the
win already measured is entirely on the wire) but keeps the prefilter cheap
once the corpus passes the low hundreds of creators, where ~13 MB of jsonb
per probe would otherwise become the bottleneck.

---

**2026-08-18 — lynxr now tells its owner, on his phone, when it is broken.**
`~/.claude/plans/alarms-when-lynxr-breaks.md`, 12 steps, implemented in the
working tree. Every serious failure up to this point had been silent (the Fly
deploy failing five runs straight, `upsert_source()` 400ing for weeks, AI
steps writing back `status="done"` with no script, and — the trigger for this
plan — `renew_claim()` racing the completion graft on 2026-08-18, erasing a
finished script and re-billing the same paste). `pipeline/watchdog.py` reads
the database (never writes anything a creator can see) and pushes a
notification to ntfy.sh when one of seven failure SHAPES shows up:

**RESCOPED 2026-08-19** (`~/.claude/plans/alarms-creator-impact-and-secret-newline.md`,
see the "Where this left off" entry at the top of this section for the full
story): every alarm now carries a `page` bit, so only the shapes that would
need the owner's attention reach the phone. A demoted shape still fires and
still reaches the once-daily digest's `quiet:` line — it just never pages.

**Pages the phone:**

| alarm | condition | threshold, and its source |
|---|---|---|
| `inflight:<id8>` | queued/running, no processedAt, age > budget | 600s = 2.6x measured p90 (229s); every real failure measured (1504s, 1548s, 101171s) clears it easily |
| `inflight:many` | more than 3 stuck at once | collapses a burst into one page instead of N |
| `empty-script:<id8>` | done + brandId + zero beats, within 24h | live count is 0 — a tripwire on `fill_adaptation`'s no-empty-beats guard regressing |
| `spend-24h` | `lynxr_script_charges` rows in the trailing 24h >= `DAILY_SCRIPT_CAP` (default 250) | `process_adaptations.py --daily-cap`'s circuit breaker has tripped and is refusing ALL new work — a quiet queue means "capped", not "healthy". Same env var on both sides so the breaker and the alarm can never disagree. Reworded in creator terms: "no new scripts — 24h cap reached" |
| `worker-down` | `worker.heartbeat` missing/stale — now TRI-STATE on whether the GitHub fallback loop is covering | priority 3 ("fly down, github covering" — degraded, no redundancy left, still would need attention) / priority 5 ("NOTHING is writing scripts" — both down) / priority 4 (cannot tell — today's original wording). Two external callers can raise it now, not one — see below |
| `ci-unverified` | a GitHub job that keeps lynxr running failed AND `lynxr_ops` itself was not readable | cannot tell whether Fly is covering either; saying nothing would be the same false all-clear the newline incident exposed |

**Digest only (`page: False`) — reported once a day, never on the phone:**

| alarm | condition | why it does not page |
|---|---|---|
| `rerun:<id8>` | the explicit `rerun` marker stamped at claim time, within 48h (widened from 24h so a digest a day later can't miss it) | the double-bill shape from the 2026-08-18 incident, but the creator still got their script either way — bounded by `spend-24h` (still pages) and the allowance ledger |
| `sources-stalled` | 3+ finished with a source in 6h, 0 new `lynxr_sources` rows | costs the agency's sourcing signal, never a creator's script |
| `softfail:<subsystem>` | 3 of the last 5 finished scripts carry the same `softFails.<subsystem>` marker | worst case is a library card with a generic title or no thumbnail, on a script that was delivered |

**p95 latency is deliberately NOT on the pager** — it moved to a once-daily
digest instead (priority 2, arrives silently, sent once `now.hour >=
DIGEST_HOUR_UTC` (default 15 UTC) and not already sent today). This was a
live lesson, not a guess: this plan's own first watchdog run failed on `p95
1548s > sla 60s` from the ONE double-billed sample, and at n=7 samples p95
**is** the worst sample — a single historical incident would have pinned a
p95-based pager red for 24h on an otherwise healthy system. **The digest
arriving daily is itself the proof the alarm system is alive** — without a
daily "all good", silence and a dead pager look identical.

A fixed condition resolves itself: `raise_alarm`/`clear_alarm` latch state in
a new `lynxr_ops` table (`supabase/ops_table.sql` — **not yet applied, owner
action**, see below) so an alarm pages once per episode, reminds after 24h if
still open, and sends a quiet priority-2 "resolved" the moment `check_all()`
stops reporting it. Missing table or missing `NTFY_TOPIC`: everything falls
back to an in-process latch and logs a warning — verified live on 2026-08-18
(`./venv/bin/python pipeline/watchdog.py --once --dry-run` against the real
database, table absent, topic unset: exit 0, one alarm, `worker-down`, which
is expected until the Fly worker carrying step 6 deploys).

**Owner actions still open, in order** (`supabase/ops_table.sql` cannot be
applied by an agent):

1. Pick a long random `NTFY_TOPIC`, subscribe to it in the ntfy iPhone app.
2. `fly secrets set NTFY_TOPIC=<topic>` (restarts the machine — expected, safe).
3. GitHub → Settings → Secrets and variables → Actions → new repo secret
   `NTFY_TOPIC`, same value.
4. Append `NTFY_TOPIC=<topic>` to `.env` for local runs (gitignored already).
5. **Done, verified live** — `supabase/ops_table.sql` is applied. Confirmed
   2026-08-19: `lynxr_ops` holds exactly two rows, `worker.heartbeat` (~49s
   old) and `digest.last` (fired 15:00:36 UTC, matching `DIGEST_HOUR_UTC`).
6. Paste `supabase/creators_adaptations_gin.sql` into the Supabase SQL editor
   and run it — a GIN index for the discovery prefilter's containment probes.
   Buys nothing today (five rows, planner seq-scans regardless); insurance
   for once the creator count passes the low hundreds. See its header.
7. **New, belt-and-braces** — re-save the GitHub `SUPABASE_SERVICE_ROLE_KEY`
   secret without the trailing newline it currently carries (see the
   "Where this left off" entry at the top of this section). The code no
   longer needs it clean — `pipeline/envcfg.py` strips it at every read site
   — but the stored value is still wrong and worth fixing at the source.

**Two corrections this plan turned up, both now fixed in this file and in the
workflow that repeated the same claim:**

- **There was never an `SLA BREACH` line.** The "What was measured" section
  below (2026-08-17 entry) and `.github/workflows/latency-watch.yml`'s old
  header both described `process_adaptations.py`'s `main()` as writing an
  `SLA BREACH` line straight into `fly logs` — "the only real-time signal
  that exists". `grep 'SLA BREACH'` over the whole repo returns nothing and
  never did; the only `log.error` calls in that file are `GAVE UP`, `FAILED`
  and `FAILED (source)`. Nobody had built the line. This is exactly the kind
  of silent gap this plan exists to stop happening again — `inflight:` at 10
  minutes is the real-time latency alarm now, and it is real, tested, and
  proven to fire (`pipeline/test_watchdog.py`).
- **`fly-deploy.yml` is fixed** — last three runs green (04:41, 03:27, 03:16
  on 08-18) — so the memory note `lynxr-fly-deploy-ci-broken.md`'s "run `fly
  deploy --remote-only` by hand" instruction, and this file's own still-open
  "next action" language a few paragraphs down about deploying by hand, are
  stale. A push to `pipeline/**` deploys on its own. That memory note is left
  as-is here per the owner's own rule (only corrected on request); flagging
  it is as far as this entry goes.

**2026-08-17 (later the same session) — the "about a minute" claim below was
wrong, and the fix for it is written but NOT YET DEPLOYED.** Read this before
the "scripts now arrive in about a minute" entry underneath, which is now out
of date on the one number that matters.

**`~55s` below was always `attemptedAt` → `processedAt` — the worker's own
processing time, never the creator's wait.** Conflating the two is what let a
25-minute stall look like a solved problem. Measured against every adaptation
ever written this session (14 samples, `addedAt` → `processedAt`, the number
the creator actually experiences): **min 58s, p50 121s, p90 2050s, max
101171s — only 1 of 14 came in under 60s.** Splitting each sample into queue
(`addedAt`→`claimedAt`), claim lag (`claimedAt`→`attemptedAt`) and work
(`attemptedAt`→`processedAt`) showed the gap is almost entirely queue, not
compute. `1504 = 1500 + 4` was not a coincidence: a worker claimed an entry 4
seconds after the paste, died mid-pass, and the entry sat invisible until the
25-minute claim lease expired — then paid for a full re-download and
re-transcribe on top of the wait.

The fix (`~/.claude/plans/creator-latency-60s.md`, 15 steps) is implemented in
the working tree — queue tail first, then the serial work inside one script,
then the model chain, then a permanent instrument on all of it — **but none of
it is deployed.** `fly deploy --remote-only` (or a push once a Fly deploy
token is set as the `FLY_API_TOKEN` GitHub secret) is the next action; nothing
in this entry is true of the live worker yet, only of the code.

What changed:

- **A killed run no longer costs 25 minutes.** `fly.toml` now sets
  `kill_timeout = "300s"` (Fly's undocumented-here default of 5s was turning
  every deploy into an orphaned claim), the claim is heartbeat-renewed every
  45s (`renew_claim`/`heartbeat` in `process_adaptations.py`), the lease
  dropped from 25 minutes to 2.5, and `worker.py`'s sweep from 180s to 60s.
  Worst case after a death mid-script: ~3.5 minutes, not 25 — and a death
  AFTER the script is written now costs nothing at all, because the
  write-back happens the instant one entry finishes, not once per whole
  batch.
- **Every stage now writes its own timing onto the adaptation** — a `timings`
  object (`download`, `transcribe`, `cover`, `frames`, `shots`, `tags`,
  `format`, `adapt`, `meta`, `graft`, `total`) — so the next regression is a
  `pipeline/latency_report.py` run, not a rediscovery-by-hand. A breach also
  writes an `SLA BREACH` line straight into `fly logs` with the full
  breakdown attached — the only *real-time* signal that exists.
  `.github/workflows/latency-watch.yml`'s 15-minute cron is best-effort on a
  public repo (`adaptations.yml`'s cron is measured elsewhere in this file at
  roughly every 3 hours) — treat it as a lagging daily-ish check, not a pager.
- **Up to 3 scripts now process concurrently** (`--concurrency`, default 3,
  `WORKER_CONCURRENCY` env), and N brands pasted for the SAME video share one
  download/transcribe/shot-list/tag/format pass instead of paying for it N
  times (`process_group()` in `process_adaptations.py`). A second creator
  ever pasting a video already in `lynxr_sources` skips the source half
  entirely (`cached_source()`, `--reuse-sources`, default on) — this is only
  real now that `sources_staff_read.sql` has been applied; before that every
  source upsert 400'd (`PGRST204`) and the cache was permanently empty.
- **The remaining Opus chain is measured, not guessed at.** Warm, on a short
  (~60s or under) source video:

  | stage | measured |
  |---|---|
  | download (yt-dlp) | 8.2s |
  | Whisper transcribe | 1.7s load + 3.1s |
  | shot list (Haiku) + tags (Opus), now concurrent | ~7.1s (was 12.6s serial) |
  | format extraction (Opus) | 9.4s |
  | adaptation (Opus) | 18.9s |
  | write-back + 2 upserts | ~1.6s |
  | client poll (worst case, was 5s) | 2.5s |

  Format extraction + adaptation is 28.3s of strictly sequential Opus 5 — the
  largest remaining item, and untouched by everything above. Fusing them into
  one call (`FUSE_FORMAT_ADAPT`, default **OFF** in
  `pipeline/process_adaptations.py`; A/B it with `pipeline/ab_format_adapt.py`
  against real sources, no database writes) is estimated to save 7-10s but is
  a real quality trade — the two-step exists so the model strips the topic
  before it rewrites, and leaving that unsaid makes it drift back into the
  original's framing. Stays the owner's call.
- **The SLA is claimed for source videos up to ~60 seconds long.** A
  3-minute video cannot fit inside the same budget — this was never a claim
  about arbitrary video length.

**Check it with:**

    ./venv/bin/python pipeline/latency_report.py --since 24h --sla 60

Same split (queue / claim lag / work, per-stage medians from `timings`,
in-flight breaches) as above, against whatever is actually live at the time.
`--since 30d --sla 60` reproduces this session's 14-sample baseline exactly.

---

**2026-08-17 — scripts now arrive in about a minute instead of hours, and it
runs without the owner's Mac.** That is the headline; everything else is detail.

Confirmed live, not just deployed: the worker claimed a real creator-pasted
TikTok link **1 second** after coming up and returned a finished script
(`fit=0.72, 8 beats`, `$0.1165` cold). The machine has since held for 7½ minutes
past the trial cutoff that was killing it, so the account is off trial and the
worker stays up on its own.

A new worker (`pipeline/worker.py`) runs continuously on **Fly** and replaces the
GitHub Actions cron as the primary path. It picks up a queued script in **~2
seconds** and finishes in **~55 seconds**. Measured end to end, on the live
system:

| | before | after |
|---|---|---|
| wait before a script starts | ~0–3 hours | ~2 seconds |
| scripts processed at once | 1, globally | 1 (raise with `fly scale count N`) |
| runs when the Mac sleeps | yes (GitHub) | yes (Fly) |

Also settled today, all verified rather than assumed:

- **A script costs $0.075 warm / $0.105 cold** — about a third of the earlier
  guess. Prompt caching landed and is worth ~30%, not the 5% first estimated.
- **The Instagram caption bug is fixed**, forward and backward: new pastes get
  real captions, and the 13 database rows already titled `Video by <handle>`
  were repaired.
- **A teleprompter was built and then shelved** behind one flag — see below.
- **The service-role key was rotated.** Old one is dead; `.env`, Fly and (check
  this) GitHub Actions all need the new `sb_secret_…`.

### If scripts stop appearing, read this before debugging anything

**Check `fly status` for a *stopped* machine first.** The worker does not crash
when it fails — it parks, silently, with nothing useful in the logs. Three
separate causes were mistaken for each other in one evening, so check them in
this order:

1. **Fly billing.** `fly logs` will say
   `Trial machine stopping. To run for longer than 5m0s…` and the machine will
   die at exactly 301 seconds of uptime, every time. This was the real cause of
   the "17 minutes and still loading" report — nothing to do with the code.
   **Resolved 2026-08-17** by putting a card on the `Lynxr` / `personal` org;
   verified by a machine running 7½ minutes with no trial line. If it ever
   reappears, the account has fallen back to trial and no restart policy or
   config change will beat it.
2. **`[[restart]] policy = "always"` in `fly.toml`.** Still correct and worth
   keeping — `worker.py` exits **0** on SIGTERM, which Fly sends on every deploy
   and `fly secrets set`, and the default `on-failure` policy reads a clean exit
   as "job done". It was *not* the cause of the stopped machines above, though it
   was diagnosed as such at the time.
3. **The credentials.** A rotated Supabase key shows up as
   `probe failed (HTTP Error 401: Unauthorized) — will retry` every 2 seconds.
   The worker survives this correctly and says exactly what is wrong.

**The first script after any machine start takes ~2 minutes, not ~55s.** That is
464MB of Whisper weights being read cold off disk; every load after is ~1.7s,
measured in separate processes inside the container. It is per MACHINE START,
not per script — it only looked per-script while the trial was restarting the
machine every five minutes. Nothing to fix. (`compute_type="int8"` would make it
~1.0s at some cost to transcription quality, if it ever matters.)

To pick up on the worker:

    fly status          # one machine "started" in iad; the standby stays stopped
    fly logs            # want: "watching for queued scripts — probe every 2.0s"

---

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

## Verified against the live DB — trust these over older notes

**Re-verified 2026-08-17:** 9,016 rows still. `lynxr_feedback` holds 5 rows, all
of them the owner's own test strings. `lynxr_sources` holds 17. Three creator
records between them hold 8 scripts. Zero placeholder titles remain in
`lynxr_videos` (`Video by *` returns `*/0`).

- **9,016 videos** in `lynxr_videos` (older docs say 9,905 / 2,640 — both wrong).
- **5 auth accounts, 1 staff row** (`lynxmedianetwork@gmail.com`).
  **`junsaemail@gmail.com` is NOT staff** — signing into the agency app with it
  shows an empty dashboard. That is the gate working, not a bug.
- **Creator isolation holds.** Proven with two throwaway accounts: a non-staff
  creator reads 0 rows from every table, cannot select/update/**delete**
  another creator's row, and cannot promote itself to staff (403).
  Re-run that probe after any RLS change; reading the .sql file is not evidence.
- ~~Scripts are written by GitHub Actions~~ **Superseded 2026-08-17. Scripts are
  written by the Fly worker** (`pipeline/worker.py`, app `lynxr-worker`, region
  `iad`). `.github/workflows/adaptations.yml` still exists, still fires, and is
  **deliberately kept as the fallback** — redundant while Fly is healthy, free on
  a public repo, and the only thing that writes scripts if Fly goes down. It is
  safe to run alongside: the worker claims an
  adaptation (`status = "running"` + `claimedAt`, grafted back) *before* any
  model call, and a claimed entry is invisible to other workers until its
  25-minute lease expires, so whichever claims first wins and the other skips.
  A Mac LaunchAgent (`pipeline/io.lynxr.worker.plist`) exists as a local
  alternative — do not run it as well as Fly.
- **Column fill rates** (sampled 1,000): `similar_format_count` and
  `avg_views_of_similar` 999/1000, `niche_category` 1000/1000,
  `target_audience` 999/1000, but **`creator_followers` only 467/1000** — any
  views-per-follower index is computable on half the corpus only.
- **STALE, corrected 2026-08-18: `signup_state()` returns `{open: false,
  invite_required: false}`, not `{open: true, ...}`.** The seat counter
  (`seats: 4`) has reached the non-internal user count and the
  `enforce_signup_gate` trigger now refuses every new outside address —
  signup is closed, not merely unenforced. That is NOT the same as being
  gated: it keeps out nobody in particular, and it is what blocks testers
  today. The unblock is `require_invite = true` plus issuing invites
  (`supabase/invites.sql`, runbook in `supabase/allowance_ledger.sql`'s
  header), not raising `seats` — raising it reopens the door to every
  stranger who reads this public repo.

---

## What shipped 2026-08-17

### The worker (the big one)

`pipeline/worker.py` + `Dockerfile` + `.dockerignore` + `fly.toml` +
`.github/workflows/fly-deploy.yml`.

**Why it polls cheaply.** The obvious loop — run `process_adaptations.py` every
few seconds — does not scale, because that script's discovery step pulls *every*
creator's whole JSON blob looking for queued work. Measured at three creators:
**101,626 bytes, 887ms**. The worker asks a cheaper question first — JSONB
containment (`data->adaptations=cs.[{"status":"queued"}]`), ids only —
**2 bytes, 170ms** — and only runs the real pipeline when that finds something.
The probe stays that size as the corpus grows because Postgres does the
filtering.

Each pass is a **subprocess**, deliberately: `process_adaptations` is long-
running, holds temp dirs and a Whisper model, and can raise from a dozen places.
A crash there must not take the loop down. The GitHub workflow ran it the same
way for the same reason.

Deploy is path-filtered — only `pipeline/`, `Dockerfile`, `.dockerignore`,
`requirements-ci.txt` and `fly.toml` trigger a rebuild, so a CSS tweak does not
rebuild a container carrying 500MB of Whisper weights.

**That path filter is also why the image rots on its own** — most commits here
are CSS and copy, so a quiet month for the pipeline is a quiet month for the
image too, and `yt-dlp` (pinned as a floor, `>=2024.1`, not an exact version)
breaks on a schedule as platforms change their pages, whether or not this
repo's own code changes. `.github/workflows/fly-refresh.yml` forces a rebuild
weekly (`cron: "17 6 * * 1"`, plus `workflow_dispatch`) using the same
`flyctl deploy --remote-only` step, purely to keep `yt-dlp` and the
`python:3.12-slim` base current. **A red run there means the worker is running
a stale extractor set, not that anything is broken** — it gates nothing and
exists only to force the rebuild.

**No secrets in any committed file.** `.dockerignore` excludes `.env` first;
`worker.py` reads `.env` itself and falls back to `os.environ`, which is what
makes the container work with `fly secrets`.

### What a script actually costs and where the time goes

Measured on a real script, end to end, twice:

| step | model | time |
|---|---|---|
| write the script | Opus 5 | 18.9s |
| extract the format | Opus 5 | 9.4s |
| download the video | yt-dlp | 8.2s |
| analyse the shots | **Haiku 4.5** | 7.1s |
| tag against the taxonomy | Opus 5 | 5.5s |
| transcribe | Whisper | 3.1s |

**$0.105 cold, $0.075 warm.** Three Opus calls and one Haiku call — shot
analysis was *already* on Haiku, which is why earlier estimates of ~$0.25 were
more than double the truth.

Tagging is the obvious next thing to move to Haiku: 5.5s of Opus doing
classification against a locked taxonomy.

### Prompt caching, and a threshold that is not what it looks like

`sys_block()` in `process_adaptations.py` marks the system prompt cacheable on
both call sites. Worth **~30%** of a script, not the ~5% first estimated —
the cached prefix is 5,516 tokens, a much larger share of input than assumed.

**The 512-token minimum applies to the whole prefix, not the prompt.** The
prefix is tools → system → messages, and the JSON schema passed through
`output_config` lands in it too, worth ~190 tokens. Measured live:

    TAG_SYSTEM      1848 tokens of prompt  ->  2038 cached
    ADAPT_SYSTEM     640                   ->   830
    FORMAT_SYSTEM    491  (under 512!)     ->   681   still caches

Do not "tidy up" by removing the marker from the short one.

**A metering gap was closed at the same time.** `analyze_frames()` lives in
`analyze_visuals.py`, takes a client and returns only parsed JSON, so its call
never reached `note_usage` and every per-script cost read low. `MeteredClient`
wraps the client rather than touching `analyze_visuals.py`, which is shared with
the scraping pipelines.

### Instagram captions — fixed forwards and backwards

Three separate bugs, all now closed:

1. **The relay.** `fetchSourceMeta` asked allorigins for `/get`, which wraps the
   page in a JSON envelope — and that envelope came back **truncated** (HTTP 200,
   74KB, unterminated string), so `JSON.parse` threw and discarded og tags
   already downloaded. `/raw` returns the HTML itself. Measured: `/get` unusable
   3/3, `/raw` good 2/3 (the miss was a 522). It now retries and only accepts a
   relay's answer if it produced a caption.
2. **The shape.** Instagram never publishes a bare caption — it wraps the same
   text in boilerplate on both og tags. `unwrapCaption()` lifts the quoted span,
   matching the two known shapes specifically so a YouTube title containing a
   colon is not sawn in half.
3. **URLs stored *as* titles.** The brief builder set an adaptation's `title` to
   `sourceLabel(item)` at write time, and `sourceLabel` used to return the URL
   when nothing had hydrated. So the URL was **saved into the record**, and every
   `title || fallback` test in the file was satisfied by it. `realTitle()` treats
   a permalink-shaped title as absent, which is what lets those records heal.
   Hydration also now covers `ME.trash` and runs **two passes** — one relay
   failure used to mark an entry tried for the whole session.

**And the 13 database rows** already titled `Video by <handle>` were repaired by
`pipeline/backfill_titles.py`, which imports `fetch_meta` rather than
re-deriving the caption so the two can never drift. `fetch_meta` itself now
prefers `description` when yt-dlp returns its `Video by <handle>` placeholder,
which is what Instagram always returns.

### The teleprompter — built, then shelved

Complete and working behind **`TP_ENABLED = false`** in `creator.js`: beat-timed
scroll (paced from the script's own `t` values, so it finishes when the video
should), 3-2-1 countdown, full-bleed camera with a translucent reading band,
mirrored preview against an **unmirrored** recording, local-only download, a
34ch reading column so desktop does not run 75-character lines.

Set the flag to `true` to bring it all back. It is kept rather than deleted
because the measured behaviour in it — band position, pacing, the mirror split —
would be expensive to rediscover.

**One trap it left behind, now fixed:** `initPrompter()` was called near the top
of the file while `TP_ENABLED` is declared ~2,800 lines below. A `const` read in
its temporal dead zone throws, and that exception stops `creator.js`
mid-evaluation — every declaration below it is left uninitialised and **the whole
app dies on load**. Definition and call now sit adjacent.

### Links are now restricted to four platforms

TikTok, Instagram, **Facebook** (new) and YouTube. Anything else — a Netflix
title, a news article, a Drive file, Vimeo, X — is refused at the paste box.
The reason is spend: an off-platform link still cost a download, a Whisper pass
and four model calls (~$0.105) before failing somewhere deep and unrelated,
with the creator watching "writing your script" for a minute to get nothing.

**Enforced in four places, and the browser ones are the courtesy — the pipeline
ones are what count**, same split as `SCRIPT_CAP`: the queue is a field inside a
row the creator owns, so the console can walk around anything the browser
decides.

| where | what it does |
|---|---|
| `creator.js` `platformOf()` | refuses on submit; the badge reads "not supported" as you type |
| `app.js` `platformOf()` | same, on the blueprint form **and** the New Client add-by-link |
| `process_adaptations.py` `supported_url()` | marks the entry `error` before spending, allowance untouched |
| `process_blueprints.py` `supported_url()` | same; **uploads are unaffected** — they carry no url, so the gate only judges links |

**Matched on the HOSTNAME, not as a substring.** The old
`/instagram\.com/.test(url)` passed two things it should not have:
`instagram.com.evil.net/p/x` (lookalike parent domain) and
`evil.com/?ref=tiktok.com` (the word in a query string). Both are now refused;
subdomains that are genuinely the platform (`vm.tiktok.com`, `m.facebook.com`,
`music.youtube.com`) still pass. Verified in the live page — 9/9 cases in
`creator.js`, 4/4 in `app.js`, 20/20 against the Python copy.

`platformLabel()` still answers `"Link"` for anything unrecognised and must keep
doing so: the 9,016-row database and every blueprint saved before this gate
carry whatever they carried, and `thumbFor()` keys off it.

**The allowlist is duplicated four times on purpose** — `creator.js` and
`app.js` load on different pages and have never imported each other, and
importing `process_adaptations` into `process_blueprints` would run its logging
setup as a side effect (`canon_url` is already duplicated for that reason).
Change one, change all four.

**FACEBOOK HAS NEVER BEEN RUN THROUGH THE PIPELINE.** It is accepted at the
door because it was asked for, and `platform_of` now labels it, but no Facebook
URL has ever been downloaded, transcribed or scripted here. yt-dlp supports
Facebook and often wants cookies for it. **Paste one real Facebook reel and
watch `fly logs` before telling any creator it works** — if it fails, the honest
fix is dropping `facebook.com`/`fb.watch`/`fb.com` from the four lists rather
than leaving a platform advertised in the placeholder that cannot deliver.

The badge's refused state is `.bp-plat.bad` in app.css, following `.chip.bad`
directly above it. It is set as `on bad` — `on` carries the opacity, so a bare
`.bad` would compute correctly and paint nothing. Verified painted:
`rgb(224,108,108)` on colour and border at opacity 1, against the neutral
`rgb(107,107,118)` of a supported link.

### The thumbnail opens the original video

Clicking the frame now opens the source post in a new tab, everywhere a
thumbnail stands for a video: the creator Library entry, the trash row, a
standalone script card, and the agency blueprint row. The ↗ at the end of the
row still does the same thing — the thumbnail is simply the bigger target and
the thing that looks like the video.

`thumbHtml(url, label, href)` in `creator.js` wraps the `<img>` in
`.bp-thumb-link`; `bpThumbHtml` in `app.js` turns its wrapper span **into the
anchor**, keeping the class `bp-thumb`. That asymmetry is not sloppiness — the
two apps build the cell differently and always have (see the two-competing-
`.bp-thumb`-rules note above), so `.bp-thumb` is on a bare `<img>` in one and on
the wrapper in the other. Keeping `.bp-thumb` on the agency wrapper is also what
keeps `[data-url="…"] .vthumb-pending` matching when a cover arrives late.

**`safeUrl("")` IS NOT EMPTY.** It is `new URL(String(u), location.origin)`, so
an empty string resolves to the *current page* and comes back truthy — a
thumbnail with no source url would have linked to the app itself. Test the url
before calling `safeUrl`, never the result after. Both copies do now; the
`.bp-open` ↗ links still read `safeUrl(x || "")` and would render an arrow
pointing at the app if the url were ever missing. It never is today, which is
why nobody has seen it.

**`app.js` had no `stopSummaryLinks` and now does.** A link inside a `<summary>`
also flips the disclosure open, because that toggle is the summary's own
activation behaviour. The agency ↗ has always opened the post *and* left the
card open behind the new tab — the exact bug `creator.js` fixed. `bindBlueprints`
installs the stopper on every render, so the ↗ is fixed along with the
thumbnail. Verified on both apps: the frame click opens the link and leaves the
card shut, clicking the name still toggles it, and uploads (no url) stay an
inert span.

### The Database tab is creator sources now; the scrape is the backup

Owner's call, 2026-08-17: **"treat the overall database as only the videos from
creators — the 9,000 scraped ones, honestly disregard them, keep a button
somewhere for me to view that as backup."** Done, with one deliberate exception
below.

A two-button switch at the top of the Database tab. **Creator sources is the
default**; **Scraped archive** holds everything that was there before —
stats, Room to run, all eight bar panels, the filtered table — completely
untouched behind it.

**What the sources view shows.** Ranked by `tag_count` then recency. Each row
is one pasted video: cover, title, a `N× picked` chip when more than one creator
chose it, views (or a muted `views —`), and — opened — the taxonomy tags and the
**extracted format**: its name, why it works, and the beat list with timings.
That last part has no equivalent in the scraped table and is the reason this
view is worth more than a row count.

**READ THIS BEFORE CONCLUDING IT IS BROKEN — the table was invisible, not
empty.** `lynxr_sources` shipped with **no RLS policies at all** (service-role
only, on purpose). The pipeline writes it with the service key, which bypasses
RLS entirely, so nothing ever looked wrong — a signed-in staff browser simply
got `[]` back, with no error. **`supabase/sources_staff_read.sql` must be run in
the SQL editor** or this view stays empty forever. The empty state says exactly
this rather than "no results", because "no results" would send the next person
to debug the query instead of the grant.

**Metrics were added at the same time.** The table had no views/likes column at
all, so nothing in it could ever be ranked by reach. The same SQL file adds
`views/likes/comments/duration/creator/title/metrics_at`, and
`upsert_source()` now writes them — **at no extra cost**, because `fetch_meta()`
already ran for this video and its result was sitting unused in `src["meta"]`.

**NULL is not zero, and that is load-bearing.** `views` is NULL when it was
never fetched (or the platform reported nothing — Instagram, always) and 0
only on a genuine zero-view video on a platform trusted to report one. Test
`== null`, never truthiness. **STALE as of 2026-08-17: this used to be false**
— `fetch_meta()` itself coerced an absent count to `0` before it ever reached
this table, so every un-backfilled row read `0`, not NULL, and a Facebook
Reel's count was trusted at all. Fixed 2026-08-19 (see "Where this left off"
at the top of this section — `trusted_views()`/`source_metrics()`); the 7
Instagram rows that had been zeroed by the old coercion were migrated back to
NULL (`pipeline/backfill_views_null.py`), and the table today reads 24 NULL /
3 measured (the 3 TikTok rows, self-refreshing every ≤24h). To fill the
backlog on any platform still NULL:

    ./venv/bin/python pipeline/backfill_source_metrics.py

**Client suggestions still run on the scraped corpus, deliberately.** The 1–10
opportunity score needs REACH — a type's median views against its niche+platform
scope — over pockets of ≥12. Sources has neither the volume (19 rows) nor, until
backfilled, the views. Pointing suggestions at it would empty every client
folder. Revisit when sources passes a few hundred measured rows.

**Verified against the real 19 rows** (pulled with the service key, fed through
`srcRow()` and the render chain): 19 cards, stats reading *19 pasted over 5
days · 1 picked twice+ · 5 formats · median 184.3K from 1 of 19 measured*, bars
and filter dropdowns populated from the data, covers resolving out of
`lynxr-covers`, and an opened card showing a 12-beat extracted format.

**`tag_count` is flat at 1 across all 19 rows today.** No video has been pasted
by two creators yet, so the saturation meter has never fired. That is a real
answer, not a bug — the "Picked twice+" stat says `no repeats yet` rather than
implying the number means something.

**The sources bars show counts with NO percentage** (`renderBars(..., {pct:
false})`). At 19 rows one video is 5.3 points, and a percentage invites a
confidence the sample cannot support. The scraped panel keeps its percentages —
9,016 rows can carry them.

### Original scripts: the tab existed, the landing was wrong

Sending a link without picking a company already returned the video's own
verbatim script, and the Library already had an **Original scripts** tab
(`LIB_MODE === "original"`). What was missing is that the send dropped you into
the Library on *whatever tab was open last* — normally "By brand", where a
script belonging to no brand can only appear in the loose block under every
named group. It looked like the feature was not there.

Both no-brand send paths now set `LIB_MODE = "original"` before navigating, so
what you just asked for is the first thing on screen. The tab deliberately shows
**every video that has an original script**, not only those whose *only* script
is original — a video can be written for a company and still have its own words
kept.

### Original scripts now exist for videos you scripted FOR A BRAND

Owner's ask: picking a brand must still work, and the video's own words must
still be kept — that is what the Original scripts tab is for.

**This cost nothing to build, because the words were already stored.** Verified
on the live DB: all 13 adaptations are brand-tied and *all 13* carry
`source.script.segments`, `source.shots`, `source.tags` and `format` alongside
their rewritten `adaptation.beats`. The pipeline extracts the source first and
rewrites second, onto the same record. Nothing is queued, nothing is re-read,
no allowance is spent — the Original scripts tab just renders a field that was
always there and never displayed.

What changed:

- **`hasSourceScript(a)`** — does this record carry the video's own transcript
  or shot list? A silent video has no segments but still has shots, so either
  counts.
- **`adaptationHtml(a, name, { asOriginal: true })`** — forces the source branch
  on a record that *also* has a brand rewrite. The branch order is
  `isWriting → ad → !brandId → failed`, so without this a brand record could
  never reach the original renderer.
- **The tab's filter was `.some((a) => !a.brandId)`** — which matched only
  videos sent with NO company. The comment above it already claimed the wider
  behaviour ("A video can be scripted for a company AND have the video's own
  words kept"), so **the intent was written but never true**. Now
  `!a.brandId || hasSourceScript(a)`.
- **One card per VIDEO, not per brand.** A video scripted for three companies is
  three records carrying the *same* transcript, so `libraryItemHtml` prefers a
  genuine no-brand record and otherwise borrows the source off whichever brand
  record has it. Without this the tab showed three identical originals.
- **"Write this for a brand" is suppressed on a brand-tied record.** That button
  turns an original INTO a brand script; on a record that already is one it is
  nonsense. The entry's own "Also write this for" chips are the right control.

**There is no test setup in this repo, so one was built to check this.**
`scratchpad/lib-test.js` loads the real `creatorsonly/index.html` and the real
`creator.js` into jsdom and drives `libraryItemHtml` with record shapes copied
from the live DB — 16 assertions, including regressions on the brand view, the
all-videos view, the platform gate and the thumbnail link. **16/16.**

**The trap that harness hit, worth knowing before writing another:**
`creator.js` is a CLASSIC script, so its top-level `let ME` / `const
SCOPE_ORIGINAL` live in the context's global **lexical** environment and are
**never window properties**. Setting `window.ME` from outside creates a
different, unrelated binding — every assertion then passes or fails against
nothing. The test bodies must run as a sibling script in the same vm context and
reach the real bindings by bare name. The first version of that harness scored
3/12 purely from this.

### Smaller

- **The ETA is reactive now.** `etaFor()` takes the median of this account's last
  10 finished scripts (`attemptedAt` → `processedAt`, so queue wait is excluded)
  instead of counting five-minute polling passes. It said "about 7 minutes"
  because it was calibrated for the GitHub Actions era; it now says "about a
  minute", and will grow on its own if Fly's shared vCPU is slower at Whisper
  than an M-series Mac. `POLL_MIN`/`PER_PASS`/`WORK_MIN` are gone.
- **"Also write this for" appeared twice** on any video with one script — the
  Library entry offers the spare brands *and* each nested card offered the same
  list. Suppressed on nested cards; the offer belongs to the video, which is what
  the entry is.

---

## What shipped 2026-08-14

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
- **Formula injection in any CSV export of this data.** `email` is anonymous,
  visitor-supplied text; a value beginning `=`, `+`, `-` or `@` is evaluated
  as a formula the moment the file is opened in a spreadsheet, and
  `=IMPORTXML(...)` can send other cells to an attacker's URL. Open an export
  with the import wizard's column type forced to Text, or don't open it in a
  spreadsheet at all. `supabase/waitlist-sheet.gs` carries the same fix for
  the live mirror (`setNumberFormat('@')` before the values land) — a CSV
  export is a separate write path and gets no benefit from either that fix
  or `supabase/write_guards.sql`'s shape constraint.
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
- System code font, base 14px. **Menlo leads the stack, not `ui-monospace`** —
  `ui-monospace` was in front, but measured against a deliberately-unavailable
  face it returned an identical width, i.e. it was resolving to nothing and the
  stack was falling through by accident. Naming Menlo first makes the macOS match
  intentional. Share Tech Mono is still in
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

### TOMORROW (2026-08-19) — the list, after stage 1 was reached

Stage 1 was reached 2026-08-18 07:33Z: `signup_state()` returns `open: true`,
five seats free, allowance server-side, worker on v18 passing clean.

**Reliability — the four that are actually engineering**

1. **Atomic claim RPC.** `_GRAFT_LOCKS` is a `threading.Lock` in ONE process.
   The GitHub fallback is a different process on a different machine and can
   still race the same row; `--min-age-seconds 180` narrows the window, it does
   not close it. A `SECURITY DEFINER` conditional UPDATE in Postgres closes the
   class and is the prerequisite for `fly scale count N`.
2. **Timeouts on every model call.** `anthropic.Anthropic(api_key=...)` sets
   none, so the SDK default is TEN MINUTES — behind a 2.5-minute claim lease.
   One hung call is a guaranteed double-run, no race required. Every `urllib`
   call in this repo already sets one. Size each to a multiple of its measured
   p50 (tags ~7s, format ~8s, adapt ~17s).
3. **Alarm on N consecutive non-zero passes.** 2026-08-18: the worker crashed on
   EVERY pass for ~10 minutes (`UnboundLocalError`) and the watchdog said
   `no breaches` throughout — an entry has to exist and get stuck before
   `inflight` fires, and the queue was empty. **A worker failing with an empty
   queue is currently invisible.** Same shape as every other silent failure here.
4. **`period_days = 30`** to finish lifetime → monthly. The column exists and
   defaults to 0; most of "SCRIPT_CAP is lifetime" is already built.

**UI/UX — every one of these was OBSERVED and left alone, not invented**

5. **`closePolicy()` does not restore focus** (`creator.js:118`) — it drops focus
   to `<body>`. A keyboard creator who opens the privacy modal mid-compose loses
   their place in the form. Pre-existing, but the new paste-box disclosure link
   makes it cost more because it is now easy to reach mid-compose.
6. **`sbFetch` truncates error bodies to 160 characters** (`creator.js:645`).
   This is the root cause of the row-size branch having to match on error CODE
   rather than constraint name — PostgREST orders keys `code, details, hint,
   message` and Postgres fills `details` with ~110 chars, so the name lands past
   the cut. Widening it improves every error path in the file.
7. **`.modal-card` is declared TWICE in `app.css`** (lines ~346 and ~1137) and
   the agency copy wins on the creator page. The send overlay had to use its own
   `.sendbox` classes to route around it.
8. **`.composer-note` never clears its text.** `flashMsg`'s 5s timer removes
   `.show` but not `textContent`, so a message stays painted until the next
   render. Arguably right for a persistent instruction, wrong for a flash.
9. **The disclosure link's tap target is 46×14 at 390px** — under the 24×24
   guidance. Fixing it needs a scoped rule in the shared `app.css`.
10. **Nobody has measured what a BRAND-NEW creator sees on first sign-in.** Every
    UI check this project has run used an account with history. The empty state
    is the first thing five testers will meet and it is unverified.

11b. **Better loading UI/UX while a script is being written.** The machinery
    landed 2026-08-18 — a persistent overlay, the four-arm lynxr mark, a phase
    rail (`reading` / `watching` / `structure` / `writing`) fed by
    `publish_phase()`, and an estimate reading "usually 50–110 seconds". Two
    things are unfinished:
    - **The rail has never been seen lighting from a REAL worker.** `ui-ux`
      proved it with phases injected through a stubbed `pull()` — byte-identical
      from the render's point of view, but not the worker. Verify it on a live
      paste before trusting it in front of testers.
    - **The estimate does not know what actually drives the number.** Measured:
      video LENGTH dominates (transcribe 8.0s for a 59-second video, 30.6s for a
      long one), and the cold prompt cache — which the copy was originally
      written around — costs ~0.1s, not 50. A better estimate keys off duration
      once the worker knows it, rather than a fixed band.

12b. **LEARN THE SYSTEM DEEPLY — owner's item, deliberately on the list.**
    The owner asked for this explicitly. Most of this codebase's expensive bugs
    were invisible rather than hard (a lost write-back, a dead source library, a
    documented alarm that was never built, a prefilter that returns HTTP 200 and
    zero rows when malformed). Reading the code once, end to end, is what makes
    those legible. Suggested route, roughly a paste's journey:
    `creator.js` submit → `lynxr_creators.data.adaptations` → `worker.py`'s
    probe/sweep loop → `process_adaptations.py` `main()` → `candidate_creators()`
    → `charge_scripts()` → `process_group` → `fill_source` (download,
    transcribe, cover, frames, shots ∥ tags) → `extract_format` →
    `fill_adaptation` → `graft_adaptations` → the client's poll → the card.
    Then `watchdog.py` separately, since it is the only part that runs on its own
    schedule. The comments in these files carry the WHY — they are written for
    exactly this read.

**Product — the part that decides whether any of the above mattered**

11. **Capture a quality signal on each script.** There is essentially none today
    (`grep` for thumbs/rating/helpful in `creator.js` returns 1). `fit=` is the
    model grading its own homework. One tap per script is both the cheapest
    possible signal and a UI change — do it as part of the UI pass.
12. **Talk to the two creators who left.** Both stopped after ONE script, during
    a period when the engaged creator did eight. That is not a latency story.

**Owner, not code:** terms of service; a lawyer's look before money changes
hands (scraped video, stored transcripts, republished cover frames).


### BEFORE PUBLIC — decided 2026-08-18, do not do early

**Drop the free tier from 25 to 5 lifetime.** Owner's decision: testers keep the
25 default for now; 5 becomes the free tier at the moment Lynxr goes public, not
before.

**Pin the existing creators FIRST, or they silently drop to 5.** The default
applies to anyone with no row in `lynxr_allowance`, and every current creator is
riding on it:

    insert into public.lynxr_allowance (id, granted, note)
    select id, 25, 'founding tester, pinned <date>'
      from public.lynxr_creators
     on conflict (id) do nothing;

**Only then** change the default. It lives in THREE places in
`supabase/allowance_ledger.sql` — the `lynxr_allowance.granted` column default,
and the `coalesce(..., 25)` fallback inside BOTH `my_allowance()` and
`charge_scripts()`. Change one and miss another and the rail shows a number the
worker does not enforce, or the reverse. Find them with:

    grep -n "25" supabase/allowance_ledger.sql | grep -i "coalesce\|default"

Re-run the two function definitions after editing. New signups then get 5
lifetime; everyone pinned keeps 25.

**Related, already half-built:** `period_days` exists and defaults to 0
(lifetime). Setting it to 30 on a grant turns that account into a rolling
monthly quota — which is most of the "SCRIPT_CAP is lifetime, not monthly"
blocker under "Blocking a paid public launch". The plumbing is there; only the
decision and the pricing are not.


**Done today, kept only as pointers:** client-matched video suggestions (the
whole "Suggested videos" machinery below) and the blueprint add-by-link form
(landed by a separate session in commits `242b8d1` / `6a7134a`; that session
has since been deleted, so `blueprintsBoxHtml` is uncontested again, and every
element id app.js looks up now resolves).

0. **HOUSEKEEPING FROM 2026-08-17 — minutes each.**
   - **Update the GitHub Actions secret** `SUPABASE_SERVICE_ROLE_KEY` to the new
     `sb_secret_…`. The key was rotated; until this is done every
     `adaptations.yml` firing 401s, and you get a wall of red in Actions that
     hides anything genuinely new. Copy it without retyping:
     `grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2- | pbcopy`
   - **`adaptations.yml` STAYS — owner's call, kept as the fallback.** It is
     redundant while Fly is healthy and costs nothing on a public repo, and it
     is the only thing that writes scripts if Fly has a bad day. Safe to run
     alongside: whichever worker claims an adaptation first wins and the other
     skips (see the claim/lease note above).
   - **Do not load the Mac LaunchAgent** while Fly is running.

1. **THE TEST-CREATOR FEEDBACK NEVER ARRIVED — and that changes the plan.**
   `lynxr_feedback` holds **5 rows and all five are the owner's own smoke tests**
   (`test`, `test 2`, `test test test test lmao`, …). Zero real creator feedback
   has ever been submitted. Usage is similarly thin: **3 creator records, 8
   scripts total, 17 rows in `lynxr_sources`** — and each record has exactly 2
   brands, so some or all are the owner's own test accounts.

   So the app has, as far as the database can tell, never been used by anyone
   who is not the owner. The holding pattern was waiting on feedback that was
   never coming, and nothing surfaced that fact because `app.js` still
   references `lynxr_feedback` **zero times**.

   Still the first thing to build (front-end only, no SQL) — but build it as the
   *instrument for the test phase*, not to read a backlog. There is no backlog.
   Get 5–15 real creators onto the unlisted URL first; the current setup is
   genuinely right at that scale now that scripts take a minute.
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

### Blocking a paid public launch (2026-08-17)

The owner wants to go public with pricing. Latency is solved; these are not.

1. **STALE as of 2026-08-18.** `SCRIPT_CAP` used to be a LIFETIME cap enforced
   by taking the oldest `cap` entries of `data.adaptations + data.trash` by
   `addedAt` — a design with three ways around it from the browser console
   (wipe `adaptations`, wipe `trash`, or back-date one entry's `addedAt` to
   sort it inside the window; see "Hard-won" below). `~/.claude/plans/
   launch-security-privacy-trial-integrity.md` moves the ledger server-side:
   `supabase/allowance_ledger.sql` (owner action, not yet applied) adds
   `lynxr_script_charges` (one row per script ever charged, keyed on
   adaptation id, no `authenticated` policies at all) and `lynxr_allowance`
   (`granted`, `period_days` — 0 = lifetime, >0 = rolling window, present
   from day one). Switching a paying creator to a monthly quota after that is
   **one UPDATE**, not a code change on either side:
   `update lynxr_allowance set granted = 200, period_days = 30 where id = '<uuid>';`
   — this item needs converting on neither side any more, once the SQL is
   applied and this code is deployed together (they must land as one unit;
   see the plan's Tier A ordering note).
2. **STALE as of 2026-08-18. Signup is not "open" — it is closed by seat
   exhaustion,** which is not the same as being gated: it keeps out nobody in
   particular, it just happens that all 4 seats are currently taken. See the
   corrected note under "Verified against the live DB" above. The unblock is
   `require_invite = true` plus issuing invites, not raising `seats`.
3. **A lawyer's look before money changes hands.** Charging third parties for a
   service built on scraped video, stored transcripts and republished cover
   frames is a different posture from using it internally. Cheap to check now.

**Pricing maths, from the measured $0.075/script:** at $20/month, break-even is
~267 scripts/month — nine a day, every day. A creator posting daily (30/month)
costs $2.25. So $20 "unlimited" is defensible with a fair-use ceiling for the
tail. Note `SCRIPT_CAP` was cut to **25 lifetime** on 2026-08-17 — that is a
trial-sized allowance, not a subscription quota, so a monthly number still has
to be chosen when pricing lands.

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
  css/js change or browsers serve stale files. **STALE, corrected 2026-08-18:
  this used to say "currently `20260821n`"; the four pages actually carry
  `20260821w`.** Carry on from there, not from `n`.
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
- **A cap counted inside a blob the owner of that blob can PATCH is not a
  cap — it's a courtesy, and there were THREE ways around the old
  `SCRIPT_CAP`, not two.** The known two: wipe `data.adaptations` and
  `data.trash` from the console, or sign up again. The third needed no
  deletion at all: the old allowance was the oldest `cap` entries of
  `adaptations + trash` sorted by `addedAt`, and the creator writes
  `addedAt` — back-dating one entry (e.g. to `"0001-01-01T00:00:00Z"`) sorts
  it inside the allowed window and pushes an already-finished entry out.
  Finished entries fail `wants_work()`, so nothing re-runs and nothing is
  refused: unlimited scripts by editing one field. Do not re-derive a
  client-writable ledger as a good design — the fix (2026-08-18) is
  `supabase/allowance_ledger.sql`: the ledger lives in a table with no
  `authenticated` policies at all, so there is nothing left in the creator's
  own row for a console session to edit.
- Repo is public. No secrets in files; the publishable key is public by design.
  **Never write a waitlist CSV inside the repo** — one `git add -A` publishes
  every address.
