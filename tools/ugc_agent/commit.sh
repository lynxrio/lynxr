#!/usr/bin/env bash
# Commit and push ONLY the agent's own files. Usage: commit.sh <manifest> <commit-subject-file>
# Used by the Claude Code cloud routine (ROUTINE.md) and by the workflow's withdraw mode. Never `git add -A`, never --force.
set -euo pipefail

manifest="$1"
subject="$2"

if [ ! -s "$manifest" ]; then
  echo "nothing to commit"
  exit 0
fi

# 1. Every manifest line must be an allowlisted path; an article page needs its article JSON.
allow='^(blog/[a-z0-9-]+/index\.html|blog/index\.html|faq/index\.html|faq/ugc-[a-z-]+/index\.html|sitemap\.xml|llms\.txt|tools/ugc_agent/(articles/[a-z0-9-]+\.json|attempts\.json|questions-auto\.json))$'
page='^blog/([a-z0-9-]+)/index\.html$'
while IFS= read -r p || [ -n "$p" ]; do
  [ -z "$p" ] && continue
  if ! [[ "$p" =~ $allow ]]; then
    echo "::error::path is not on the allowlist: $p"
    exit 1
  fi
  if [[ "$p" =~ $page ]]; then
    slug="${BASH_REMATCH[1]}"
    if [ ! -f "tools/ugc_agent/articles/$slug.json" ]; then
      echo "::error::$p has no tools/ugc_agent/articles/$slug.json"
      exit 1
    fi
  fi
done < "$manifest"

# 2. Commit identity.
git config user.name "lynxr ugc agent"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# 3. Stage exactly the manifest, then prove nothing else changed.
git add --pathspec-from-file="$manifest"
if [ -n "$(git diff --name-only)" ] || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "::error::the tree has changes outside the manifest:"
  git diff --name-only
  git ls-files --others --exclude-standard
  exit 1
fi
git commit -F "$subject"

# 4. Push to main, rebasing over anything that landed meanwhile (up to three tries). A protected main refuses the
#    push outright: when UGC_FALLBACK_BRANCH is set, push the same commit to that branch instead and record it in
#    pushed-branch.txt so the caller can open a pull request. Exit 0 either way; exit 1 when nothing was pushed.
outdir="$(dirname "$manifest")"
refused=0
for attempt in 1 2 3; do
  if out=$(git push origin HEAD:main 2>&1); then
    echo "$out"
    git rev-parse HEAD > "$outdir/pushed.txt"
    exit 0
  fi
  echo "$out"
  if echo "$out" | grep -qiE 'protected branch|GH006|GH013|rule violation|not allowed|declined'; then
    refused=1
    break
  fi
  echo "push attempt $attempt failed; rebasing"
  if ! git pull --rebase origin main; then
    git rebase --abort || true
    echo "::error::rebase conflict while pulling main"
    exit 1
  fi
  python3 tools/check_stamp.py || exit 1
done
if [ -n "${UGC_FALLBACK_BRANCH:-}" ]; then
  echo "main refused the push (or kept failing); pushing the same commit to $UGC_FALLBACK_BRANCH"
  if git push origin "HEAD:refs/heads/$UGC_FALLBACK_BRANCH"; then
    git rev-parse HEAD > "$outdir/pushed.txt"
    echo "$UGC_FALLBACK_BRANCH" > "$outdir/pushed-branch.txt"
    exit 0
  fi
fi
echo "::error::could not push (main refused: $refused)"
exit 1
