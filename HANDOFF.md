# Lynxr — session handoff

Read this, then `README.md` for architecture. **Last updated 2026-08-20.**

Lynxr (lynxr.io) is a format-intelligence platform for Lynx Media Group, a
short-form video agency. Static site on GitHub Pages + Supabase + a Python
pipeline. Three surfaces, one stylesheet (`app.css`):

| path | file | who |
|---|---|---|
| `/` | `index.html` + `site.js` | public — marketing page. hero, how it works, our team |
| `/waitlist/` | `waitlist/` + `home.js` | public — the only funnel. every CTA lands here |
| `/faq/` | static + `FAQPage` JSON-LD | public — the SEO/GEO page |
| `/privacy/` `/terms/` `/accessibility/` | static | public — the legal set, linked from every footer |
| `/creatorsonly/` | `creator.js` | creators — paste a link, get a script |
| `/agencyonly/` | `app.js` | staff — database, briefs, clients |

`site.js` carries the shared chrome (floating bar, mobile menu, smooth scroll)
on the **six public pages only** — never the two apps. `img/` holds the founder
headshots. `robots.txt` + `sitemap.xml` cover the public set; **neither names
the two app paths, not even in a comment** — robots.txt is served to anyone, so
naming a path there publishes it.

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
