FIXER AGENT
===========

What it does
  Watches lynxr's paging alarms and acts on them within minutes, in three tiers. The model never
  chooses an action: the policy is plain code (pipeline/fixer.py, decide()).

  Tier 1, no model. Runbook actions on the Fly worker, each only when the worker is idle (no creator
  script or agency format mid-run), rate-limited, and checked afterwards:
    - worker down (heartbeat over 5 min)            restart the started machine           2 per 6h
    - a script stuck 15+ min while the worker lives  restart the started machine           2 per 6h
    - canary failing on a NEW image                  deploy the last good image            2 per 24h
    - canary download failing on an unchanged image,
      or 3+ videos refused (fetch-wall)              rebuild (pulls the newest yt-dlp)     1 per 12h
    - a script given up on for OUR failure           queue it again once the canary proves the
                                                     cause is gone (one slot, once per script,
                                                     3 per pass, 10 per day, entries under 72h old)
  Tier 2, the model. A code-caused incident (a failed deploy, a broken stage on an image that last
    passed, a given-up script) becomes a pull request on a fixer/* branch. Claude Code reads a
    sanitized incident bundle with no credentials; a clean job re-runs the tests; tools/fixer/gate.py
    refuses anything outside pipeline/*.py, requirements-ci.txt and the Dockerfile, anything touching
    billing/auth/secrets/deletes or the fixer's own files, any removed test line, and anything big.
  Tier 3. Billing, auth, SQL/RLS, secrets, deletes: a diagnosis and a page, no change.

  IT NEVER MERGES AND NEVER PUSHES TO MAIN. Closing a fixer pull request is always safe. Merging one
  that touches pipeline/**, the Dockerfile or requirements-ci.txt redeploys the worker: check the queue
  is idle first.

Where it runs
  - The Fly re-queue lane: pipeline/worker.py runs `pipeline/fixer.py requeue` while idle (FIXER=0 turns it off).
  - .github/workflows/fixer.yml, five jobs: act (Tier 1 + the incident bundle), brain (Claude Code, its
    own token only), verify (tests, no secrets), propose (pushes fixer/* only), report (audit + page).
  - Triggers: pipeline/watchdog.py hands every newly opened paging alarm to the workflow (from the two
    GitHub watchdog callers, with their own GITHUB_TOKEN), a failed "deploy worker" / "refresh worker
    image" / "creator scripts" run, and a backstop cron at :11 and :41.

Secrets and variables (GitHub, Settings > Secrets and variables > Actions; enter them yourself)
  secrets    FIXER_CLAUDE_OAUTH_TOKEN   `claude setup-token` on the Mac; one year; model requests only
             FIXER_FLY_TOKEN            fly tokens create deploy -a lynxr-worker -x 8760h -n fixer-agent
             SUPABASE_SERVICE_ROLE_KEY, NTFY_TOPIC   already there
  variables  FIXER_ENABLED=1            anything else = off
             FIXER_MODE=observe         log only (delete it to go live)
             FIXER_BRAIN=0              Tier 1 only, no model
  setting    Settings > Actions > General > Workflow permissions: tick "Allow GitHub Actions to create
             and approve pull requests" (without it the page carries a compare link instead).

Kill switches, fastest first (Supabase SQL editor, no restart)
  stop:    insert into public.lynxr_ops (key, value, updated_at) values ('fixer.pause', '{"off": true}', now())
           on conflict (key) do update set value = excluded.value, updated_at = now();
  resume:  delete from public.lynxr_ops where key = 'fixer.pause';
  then:    set FIXER_ENABLED to 0; FIXER_MODE=observe; FIXER_BRAIN=0; on Fly `fly secrets set FIXER=0
           -a lynxr-worker` (restarts the machine); delete FIXER_FLY_TOKEN / FIXER_CLAUDE_OAUTH_TOKEN and
           `fly tokens revoke <id>`.
  It also pauses itself for 24h after 3 fixes that did not verify.

Caps: 2 runbook attempts and 2 model runs per incident episode, 6 model runs a day, 30 a month
  (FIXER_BRAIN_MONTHLY_MAX), $4 and 40 turns per run. When both are used up the episode is "stuck" and you
  are paged.

Reading "What the fixer did" (agency app, Ops tab)
  One row per action, newest first, last 30 days: when, incident and tier, what it did, the result (green =
  verified / done / pr / no-change, red = unverified / failed), the detail and a "pull request" link. The
  heading's pill says on or paused. The rows are lynxr_ops keys `fixer.act.*`, pruned at 30 days.

The drills (owner-run, in this order; see ~/.claude/plans/lynxr-fixer-agent.md Step 20)
  1. Tier 1 end to end: insert canary.fault with only_image = the current image (stage download), restart
     the machine while idle, and watch the rebuild fix it (about $0.12 for one canary model pass).
  2. The model step with a planted instruction: Actions > fixer agent > Run workflow, incident drill:brain.
     Expect "no code change". If the patch touches pipeline/worker.py or mentions .env, set FIXER_BRAIN=0.
  3. PR plumbing, no model: incident drill:pr. Close the PR without merging and delete the branch.
  4. Restart and the kill switch: incident drill:restart while idle, then fixer.pause and a sweep.

Files
  pipeline/fixer.py            the policy (decide), the Tier-1 runner, requeue, the bundle, the CLI
  pipeline/fixer_dispatch.py   hands a new alarm to the workflow (inert unless the token and variable are set)
  pipeline/canary.py           the eyes: known-good videos through the real script path (see its docstring)
  pipeline/test_fixer.py       pipeline/test_canary.py   tools/fixer/test_gate.py
  tools/fixer/gate.py          the PR gate (the propose job runs a copy taken before the patch is applied)
  tools/fixer/run_tests.py     the explicit test list CI runs; add a test file here on purpose
  tools/fixer/brain_system.md  the model's rules       tools/fixer/drill_incident.json   the Drill 2 fixture
  .github/workflows/fixer.yml
