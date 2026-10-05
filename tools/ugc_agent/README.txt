UGC ANSWER AGENT
================

What it does
  Writes 1-3 articles per run that each answer one real question UGC creators ask (people
  paid by brands to make short-form videos). Each is published at /blog/<slug>/ and its short
  answer is added as a Q&A on /faq/<topic>/. sitemap.xml and llms.txt are updated.

Who writes them
  A scheduled Claude Code CLOUD ROUTINE, on the owner's Claude subscription. There is no API
  key and no paid API call anywhere in this repo. The routine follows ROUTINE.md: it picks
  questions (agent.py next), writes each article itself, runs the code gate (agent.py check),
  gets a review from a separate subagent (prompts/judge.txt), and publishes what passes
  (agent.py publish). Then it renders the pages, runs the site gate and the stamp check,
  commits ONLY an allowlisted set of paths with commit.sh, and pushes to main. If main is
  protected it pushes claude/ugc-<date> and opens a pull request. On failure it commits nothing.

After a push
  The routine's sandbox cannot reach lynxr.io or IndexNow. The GitHub workflow "ugc articles"
  runs on any push to main that changes tools/ugc_agent/articles/**: it waits until the page is
  live on lynxr.io and pings IndexNow. No secrets, no model calls.

Pause
  Disable the routine in Claude Code, or disable the workflow in the Actions tab.

Withdraw an article
  Actions, "ugc articles", Run workflow, slugs "a,b". The page becomes a noindex stub that
  points at its topic page and the article leaves the topic page, sitemap.xml and llms.txt.

Add questions
  Edit questions.json. Fields: id, theme (a topic slug from config.json), priority (1 first),
  question, slug, target_query, angle. Ids continue the q-numbering. The routine never writes
  questions.json; when fewer than 15 questions are queued it proposes more and agent.py
  add-questions appends them to questions-auto.json (ids a001...).

Topics and the cap
  Topics live in config.json. Each topic stops at 60 live answers. When every topic is full
  the queue is empty: add a topic to config.json.

Do not edit generated regions
  Never edit between the UGC AGENT markers in faq/index.html, blog/index.html,
  sitemap.xml or llms.txt: they are regenerated on every run. Leave tools/ugc_agent/articles/
  to the routine; withdraw through the workflow instead.

Files
  ROUTINE.md      the instructions the routine follows on every run
  config.json     topics, per-run count, minimum to publish (1), cap
  questions.json  human-owned seed queue
  questions-auto.json, attempts.json, articles/*.json   written only by agent.py
  prompts/        the writer, reviewer and replenisher prompts
  agent.py gate.py render.py schema.py commit.sh   the toolbox (no model calls)
  test_ugc_agent.py   offline tests: ./venv/bin/python tools/ugc_agent/test_ugc_agent.py

Settings (environment, all optional)
  UGC_AGENT_PER_RUN (questions per run, 1-3, default 3), UGC_AGENT_MIN_PUBLISH (articles needed
  to commit anything, default 1).
