UGC ANSWER AGENT
================

What it does
  Once a day it writes 2-3 articles that each answer one real question UGC creators ask
  (people paid by brands to make short-form videos). Each article is published at
  /blog/<slug>/ and its short answer is added as a Q&A to /faq/<topic>/. sitemap.xml and
  llms.txt are updated, and IndexNow is pinged once the page is live.

How it runs
  .github/workflows/ugc-agent.yml, on GitHub's runner, about 10:17 ET every day. It runs
  agent.py: pick questions, ask Claude for the article as JSON (never HTML), run the
  deterministic gate (gate.py) and a separate judge call, allow one revision, then render
  every page from the JSON (render.py). If at least 2 of 3 pass, commit.sh commits ONLY an
  allowlisted set of paths and pushes to main. Any failure commits nothing and opens or
  updates a GitHub issue labelled ugc-agent.

Pause
  Set the repository variable UGC_AGENT_ENABLED to false (Settings, Secrets and variables,
  Actions, Variables), or disable the workflow in the Actions tab. Manual runs still work.

Withdraw an article
  Actions, "ugc articles", Run workflow, mode withdraw, slugs "a,b". The page becomes a
  noindex stub that points at its topic page and the article leaves the topic page,
  sitemap.xml and llms.txt.

Add questions
  Edit questions.json. Fields: id, theme (a topic slug from config.json), priority (1 first),
  question, slug, target_query, angle. Ids continue the q-numbering. The agent never writes
  questions.json; it appends its own proposals to questions-auto.json (ids a001...) when
  fewer than 15 questions are queued.

Topics and the cap
  Topics live in config.json. Each topic stops at 60 live answers. When every topic is full
  the agent stops and alerts: add a topic to config.json.

Do not edit generated regions
  Never edit between the UGC AGENT markers in faq/index.html, blog/index.html,
  sitemap.xml or llms.txt: they are regenerated daily. Leave tools/ugc_agent/articles/ to
  the agent; withdraw through the workflow instead.

Files
  config.json     topics, model, prices, limits
  questions.json  human-owned seed queue
  questions-auto.json, attempts.json, articles/*.json   agent-owned
  prompts/        the generator, judge and replenisher system prompts
  render.py gate.py llm.py agent.py commit.sh   the program
  test_ugc_agent.py   offline tests: ./venv/bin/python tools/ugc_agent/test_ugc_agent.py

Cost
  Model claude-opus-5-5 at 4 USD in / 20 USD out per million tokens. Measured in the
  2026-10-05 dry run: 0.14-0.18 USD per generate call, 0.03-0.04 per judge call and
  0.11-0.12 per revision, so 0.25-0.38 USD per attempted article. A day of 3 attempts is
  about 1 USD and a month about 30 USD. A run stops generating at UGC_AGENT_MAX_RUN_USD
  (default 4). Secrets: ANTHROPIC_API_KEY only. The agent never reads the database.

Variables (all optional)
  UGC_AGENT_ENABLED (true to run on the schedule), UGC_AGENT_PER_DAY (1-3, default 3),
  UGC_AGENT_MIN_PASS (default 2), UGC_AGENT_MAX_RUN_USD (default 4).
