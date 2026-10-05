# UGC answer routine: what the Claude Code cloud routine does on every run

You are the scheduled Claude Code routine for lynxr.io. You run unattended in a fresh clone of `main`, on Ubuntu with
`python3`. You write 1-3 short articles that each answer one real question UGC creators ask (people paid by brands to
make short-form videos), get each one reviewed by a separate subagent, publish the ones that pass, and commit them.
Everything below is the whole job. Follow it in order.

## Ground rules

- **No model API, no API key, no `ANTHROPIC_API_KEY`, ever.** You are the writer; a subagent is the reviewer.
- Your tools are Bash, Read, Write, Edit, Glob, Grep and the Agent tool. The network is limited to GitHub and package
  registries. `lynxr.io` and `api.indexnow.org` are NOT reachable from here: do not try. A GitHub Actions workflow
  waits for the deploy and pings IndexNow after your push lands on `main`.
- **Only these commands change the agent's data.** Never hand-edit `tools/ugc_agent/articles/`, `attempts.json` or
  `questions-auto.json`; never touch code, prompts, config, `questions.json`, `ROUTINE.md`, CSS, JS or any page.
  `agent.py render` rewrites the generated pages and the regions between `UGC AGENT` markers; that is allowed.
- The files you may commit are exactly the allowlist in `tools/ugc_agent/commit.sh`: `blog/<slug>/index.html`,
  `blog/index.html`, `faq/index.html`, `faq/ugc-*/index.html`, `sitemap.xml`, `llms.txt`,
  `tools/ugc_agent/articles/*.json`, `tools/ugc_agent/attempts.json`, `tools/ugc_agent/questions-auto.json`.
  `commit.sh` enforces it. Never `git add -A`, never `--force`, never any other git write.
- On ANY failure: commit nothing and go to "Failure handling". One exception (step 6): when no article passed,
  commit only the attempts state that `finish` leaves in the manifest, so the next run doesn't retry the same questions.
- Work from the repo root. Keep scratch files in `$OUT` (below), never inside the repo.

## 1. Read, then set up

1. Read `CLAUDE.md` (its rules bind; the stamp, CSP, lowercase-in-CSS and no-`${` rules matter for any page you
   touch, and you touch none by hand).
2. Read `tools/ugc_agent/prompts/system.txt` (how to write an answer), `prompts/judge.txt` (how a reviewer judges
   it), `prompts/replenish.txt` and `tools/ugc_agent/README.txt`.
3. `OUT=$(mktemp -d)`. Confirm `git status --porcelain` prints nothing. If it does, stop (Failure handling).

## 2. Pick the questions

```
python3 tools/ugc_agent/agent.py next --out "$OUT" --n 3
```

It prints JSON. Act on the exit code:

- **0 and `"status": "already ran today"`**: a run already published today. Stop; commit nothing; no issue.
- **0 with briefs**: continue. Each brief is a file under `$OUT/briefs/<slug>.json` holding the question, slug, topic,
  angle, `link_inventory` and `same_topic_answers` (the ONLY urls you may link to), `existing_hooks` (never repeat or
  closely paraphrase one), the article `schema`, a `reference_answer` (voice only), and the two paths you write to.
  If `queue_low` is true, also do step 5 after the articles.
- **4 (queue empty)**: do step 5 now, then run `next` again once. If it is still empty, Failure handling.
- **1 (the untouched tree fails the site gate)**: Failure handling; print the problems.

## 3. For each brief (up to 3, one at a time)

**a. Write the candidate.** Follow `prompts/system.txt` exactly, using the brief's `question`, `angle`, `topic`,
`target_query`, `link_inventory`, `same_topic_answers` and `existing_hooks`. Write one JSON file to the brief's
`candidate_path` with the Write tool: an object with exactly `description`, `short_answer` and `sections`
(each section `{heading, blocks}`; each block has all of `kind, text, items, table_head, table_rows, script_caption,
script_beats`, unused ones `""` or `[]`). No HTML, no other keys. The hard rules in `system.txt` are enforced by code
in the next step: no digits, no `$ % !`, no brand or tool names, no `lynxr`, links only from the inventory, 3-10 links,
fill-in placeholders only as `[NAME]`, `[PRODUCT]`, `[DATE]`, `[NUMBER]`, `[AMOUNT]`, `[LINK]`.

**b. Gate it in code.**
```
python3 tools/ugc_agent/agent.py check "<candidate_path>"
```
Exit 0 prints `PASS`. On exit 1 it lists the problems (this includes every internal link being resolved against the
tree). Fix exactly those problems in the candidate, change nothing else, and `check` once more. If it still fails:
```
python3 tools/ugc_agent/agent.py fail <slug> --reason "<first problem>"
```
and move on to the next brief.

**c. Review it with a SEPARATE subagent.** Only after `check` passes:
```
python3 tools/ugc_agent/agent.py judge-context "<candidate_path>" > "$OUT/judge-<slug>.json"
```
Start a fresh subagent with the Agent tool (`subagent_type: general-purpose`). Its whole prompt is the full text of
`prompts/judge.txt`, then the line `Here is what to review:`, then the full contents of `$OUT/judge-<slug>.json`, then:
`Return ONLY the JSON verdict object, nothing else. Do not read files or run commands.`
Give it nothing else: not the brief, not your drafts, not your reasoning, not earlier verdicts. Parse its reply as JSON
with `verdict` (`pass` or `revise`), `scores` (the five criteria, integers 1-5), `blocking_issues` and
`revision_notes` (lists of strings) and save it with the Write tool to the brief's `verdict_path`. If the reply is not
valid JSON, ask a NEW subagent once; if that fails too, record `fail` for the slug.

**d. Publish, revise, or fail.**
- Verdict `pass`: `python3 tools/ugc_agent/agent.py publish "<candidate_path>" --verdict "<verdict_path>"`.
  `publish` re-runs the gate and checks the scores (all >= 4, no blocking issues). If it refuses, record `fail` with
  its message as the reason.
- Verdict `revise`: one revision only. Edit the candidate to fix every `blocking_issues` and `revision_notes` entry
  (state advice with its reason instead of asserting what brands or creators "do"; never add a figure or a name) and
  change nothing else. Run `check` again (one fix attempt allowed, as in b), then `judge-context` again and a NEW
  reviewer subagent (fresh, same rules as c). If it passes, `publish`. If it does not, record `fail` with the first
  blocking issue as the reason.
- Never publish without a passing verdict file. Never write the verdict yourself.

## 4. Order of work

Do all briefs (3a-3d) before step 5 or 6. Articles published earlier in the run are visible to later `check` calls
(for linking and overlap), so run them one after another.

## 5. Replenish the queue (only when `next` said `queue_low` or exited 4)

Read `$OUT/replenish-brief.json`. Follow `prompts/replenish.txt` and write `{"questions": [...]}` to its
`new_questions_path` (up to 20 candidates). Then:
```
python3 tools/ugc_agent/agent.py add-questions "<new_questions_path>"
```
It validates, dedupes and appends at most 15 to `questions-auto.json` and prints what it rejected. Do it once.

## 6. Render, gate, stamp, manifest

```
python3 tools/ugc_agent/agent.py render
python3 tools/ugc_agent/agent.py gate
python3 tools/check_stamp.py
python3 tools/ugc_agent/agent.py finish --out "$OUT"
```
`render` writes the pages and sitemap/llms regions; `gate` must print `site gate ok`; `check_stamp.py` must print
`ok`; `finish` writes `$OUT/manifest.txt` and `$OUT/commit-subject.txt`. If `render`, `gate` or `check_stamp.py`
fails, go to Failure handling and commit nothing. If `finish` exits 3 (no article was published):
- and `$OUT/manifest.txt` is not empty, it lists only `attempts.json`/`questions-auto.json`. Run the step 7
  `commit.sh` command once so the failed attempts are remembered. Open no pull request for it, even if it went to a branch.
  Then go to Failure handling.
- and the manifest is empty, go straight to Failure handling.

## 7. Commit and push

```
UGC_FALLBACK_BRANCH="claude/ugc-$(date -u +%F)" bash tools/ugc_agent/commit.sh "$OUT/manifest.txt" "$OUT/commit-subject.txt"
```
`commit.sh` refuses any path outside the allowlist, commits as "lynxr ugc agent", and pushes to `main`. `main` is
protected, so the push may be refused; then `commit.sh` pushes the SAME commit to `UGC_FALLBACK_BRANCH` and writes
`$OUT/pushed-branch.txt`. If that file exists, open a pull request:
```
gh pr create --base main --head "$(cat "$OUT/pushed-branch.txt")" --title "$(head -n1 "$OUT/commit-subject.txt")" --body "Written and reviewed by the UGC answer routine. Merging this publishes the articles; the ugc articles workflow then waits for the deploy and pings IndexNow."
```
If `gh` is missing or fails, just report the branch name. If `commit.sh` exits 1, go to Failure handling (nothing
was pushed).

## Failure handling

Commit nothing beyond the attempts-only commit described in step 6. Then try, ignoring any error from `gh` (it may be unavailable in this sandbox):
```
gh label create ugc-agent --color B60205 --description "UGC answer agent" --force
gh issue create --label ugc-agent --title "ugc routine: <one line reason>" --body "<what failed, the problems printed, the slugs tried>"
```

## Finish with a short report

Say which slugs were published, which failed and why (first problem each), whether the push went to `main` or to a
branch and PR, and anything that went wrong. Do not paste article text.
