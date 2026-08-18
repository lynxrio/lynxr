# Lynxr — session handoff

Read this, then `README.md` for architecture. **Last updated 2026-08-18.**

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
video. A cold prompt cache after any deploy adds ~50s to the next script only.

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
over ntfy on failure shapes, not on latency: worker heartbeat missing, an entry
running too long, a script finished with a brand but zero beats, the same entry
attempted twice, sources not growing, repeated swallowed failures, and 24h spend
over cap. Silence means healthy.

---

## Where this left off (read this first)

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

| alarm | condition | threshold, and its source |
|---|---|---|
| `inflight:<id8>` | queued/running, no processedAt, age > budget | 600s = 2.6x measured p90 (229s); every real failure measured (1504s, 1548s, 101171s) clears it easily |
| `inflight:many` | more than 3 stuck at once | collapses a burst into one page instead of N |
| `empty-script:<id8>` | done + brandId + zero beats, within 24h | live count is 0 — a tripwire on `fill_adaptation`'s no-empty-beats guard regressing |
| `rerun:<id8>` | done, attempts >= 2, no aiFail | the exact double-bill shape from the 2026-08-18 incident |
| `sources-stalled` | 3+ finished with a source in 6h, 0 new `lynxr_sources` rows | the weeks-long `upsert_source()` 400, now caught in hours instead of weeks |
| `softfail:<subsystem>` | 3 of the last 5 finished scripts carry the same `softFails.<subsystem>` marker | makes a persistent failure loud, keeps one blip quiet |
| `worker-down` | `worker.heartbeat` missing or older than 5min | tolerates 5 missed 60s heartbeats — more than `kill_timeout="300s"` plus a cold boot. Structurally can only ever be raised by the GitHub fallback loop (`adaptations.yml`), never by Fly itself, because the Fly-side caller refreshes its own heartbeat immediately before checking |
| `spend-24h` | `lynxr_script_charges` rows in the trailing 24h >= `DAILY_SCRIPT_CAP` (default 250) | `process_adaptations.py --daily-cap`'s circuit breaker has tripped and is refusing ALL new work — a quiet queue means "capped", not "healthy". Same env var on both sides so the breaker and the alarm can never disagree |

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
5. Paste `supabase/ops_table.sql` into the Supabase SQL editor and run it.
6. Paste `supabase/creators_adaptations_gin.sql` into the Supabase SQL editor
   and run it — a GIN index for the discovery prefilter's containment probes.
   Buys nothing today (five rows, planner seq-scans regardless); insurance
   for once the creator count passes the low hundreds. See its header.

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
never fetched and 0 when the video genuinely has none. Folding them together
buries every un-backfilled row at the bottom of a views sort and reads as "these
all flopped". Test `== null`, never truthiness. The 19 existing rows are all
NULL until you run:

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
