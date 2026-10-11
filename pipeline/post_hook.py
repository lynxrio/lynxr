#!/usr/bin/env python3
"""The posted-opening step of the shape lane: grade how a video a creator POSTED opens against lynxr's own hook rules, with one model call,
and keep a score and a few verdict words. A CRAFT SCORE, NOT A VIEW PREDICTION: pipeline/hook_views.py checks it against views for the
owner, and nothing shows it to a creator.

Plan: ~/.claude/plans/lynxr-loop-v2.md (Part 3), reusing the design of ~/.claude/plans/lynxr-hook-scorer-2.md (part E). The table and its
rules are supabase/post_hook.sql (owner SQL). The pure scoring (the prompt, the schema, the numbers it keeps) is pipeline/hook_score.py's
run_post(); this file is only the glue: the flags, the model client, the spend record, the table write.

FLY ONLY, A STEP OF post_shape.py's LANE. post_shape._measure downloads the audio and transcribes it (Whisper, free, on the worker) and hands
the segments to score() below. NEVER add this to .github/workflows/adaptations.yml. This file imports neither track_posts nor
process_adaptations at module level: it uses the `T` it is handed (`T.P` is process_adaptations), exactly as post_shape does.

THE TRANSCRIPT IS HANDED IN WHILE IT EXISTS AND IS NEVER STORED. score() receives the segments, sends them to the model once, and returns
hook_score.post_fields(): numbers and verdict words. The model's reasons, the promise it wrote and the line it quoted are dropped in
post_fields() and appear in no row, no log line and no print.

CREATOR-SIDE ONLY. Nothing in this file may be imported by pipeline/process_campaigns.py or reach AGENCY_SCRIPT_SYSTEM.

PRIVACY GATE. /privacy/ must say that what is said in a video's opening goes to the model provider BEFORE HOOK_POST=1, and the creators with a
verified profile must have been told. HOOK_POST defaults to 0. HOOK_POST_EXCLUDE (comma creator uuids, a Fly secret) leaves a creator out.

WHAT IT COSTS. One Sonnet call per post, about $0.02, never retried automatically (a failed call is recorded and the post is set `failed`).

FLAGS (all read through envcfg)
    HOOK_POST          default 0         the whole step. Off: no call, no read, no write.
    HOOK_POST_SCOPE    default linked    `linked` = only posts linked to one of the creator's own scripts; `all` = every tracked post.
    HOOK_POST_EXCLUDE  default (none)    creator uuids to leave out, comma separated, compared lowercased.
    HOOK_POST_MODEL    default claude-sonnet-5-5       HOOK_POST_EFFORT  default low       HOOK_POST_TIMEOUT_S  default 30

RUN
    ./venv/bin/python pipeline/post_hook.py --print POST_ID     # PAID: one model call (about $0.02). Prints the row; writes NOTHING.
"""
import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import envcfg  # noqa: E402
import hook_score  # noqa: E402

log = logging.getLogger("post_hook")

HOOK_POST = envcfg.get("HOOK_POST", "0") not in ("0", "", "false", "False")
HOOK_POST_SCOPE = envcfg.get("HOOK_POST_SCOPE", "linked")                 # linked | all
HOOK_POST_EXCLUDE = envcfg.get("HOOK_POST_EXCLUDE", "")                   # creator uuids, comma separated
HOOK_POST_MODEL = envcfg.get("HOOK_POST_MODEL", "claude-sonnet-5-5")
HOOK_POST_EFFORT = envcfg.get("HOOK_POST_EFFORT", "low")
HOOK_POST_TIMEOUT_S = envcfg.get("HOOK_POST_TIMEOUT_S", "30")

TABLE = "/rest/v1/lynxr_post_hook"
RECORD_COST = True              # --print turns this off: it writes nothing, the ledger included

_CLIENT = {}


def excluded(post):
    """True when the post's creator is named in HOOK_POST_EXCLUDE (a uuid per entry, any case)."""
    out = {x.strip().lower() for x in str(HOOK_POST_EXCLUDE or "").split(",") if x.strip()}
    return str((post or {}).get("creator_id") or "").lower() in out


def in_scope(post):
    """Whether this post is to be scored at all: the flag is on, the creator has not opted out, and the scope reaches it."""
    return bool(HOOK_POST and not excluded(post)
                and (str(HOOK_POST_SCOPE).strip().lower() == "all" or bool((post or {}).get("adaptation_id"))))


def enabled(post, row):
    """in_scope, and the video has speech to grade. `row` is post_shape.features()'s dict."""
    try:
        segs = int((row or {}).get("segments") or 0)
    except (TypeError, ValueError):
        segs = 0
    return bool(in_scope(post) and (row or {}).get("has_speech") and segs >= 1)


def _client(T):
    """The Anthropic client, built lazily and once, or None without a usable key (the same six lines as brain._client_getter)."""
    if "c" not in _CLIENT:
        _CLIENT["c"] = None
        try:
            env = T.P.load_env(T.P.ROOT / ".env")
            api_key = envcfg.secret("ANTHROPIC_API_KEY", env.get("ANTHROPIC_API_KEY"), os.environ.get("ANTHROPIC_API_KEY"))
            _CLIENT["c"] = T.P.anthropic_client(api_key) if api_key else None
        except Exception as e:  # noqa: BLE001
            log.info("hook-post: no model client (%s)", type(e).__name__)
    return _CLIENT["c"]


def script_score(T, key, post):
    """(final_score, H1 verdict) of the creator's own script this post is linked to, from lynxr_hook_scores, or (None, None). Read only."""
    aid = post.get("adaptation_id")
    if not aid:
        return None, None
    try:
        st, rows = T.rest(key, "/rest/v1/lynxr_hook_scores?creator_id=eq." + T.q(post.get("creator_id")) + "&adaptation_id=eq." + T.q(aid)
                          + "&final_score=not.is.null&order=created_at.desc&limit=1&select=final_score,versions,chosen")
        if st != 200 or not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
            return None, None
        r = rows[0]
        score = r.get("final_score")
        score = score if isinstance(score, int) and not isinstance(score, bool) else None
        vers, chosen = r.get("versions"), r.get("chosen")
        h1 = None
        if isinstance(vers, list) and isinstance(chosen, int) and not isinstance(chosen, bool) and 0 <= chosen < len(vers) and isinstance(vers[chosen], dict):
            v = ((vers[chosen].get("verdicts") or {}).get("H1") or {}).get("v")
            h1 = v if v in ("pass", "partial", "fail") else None
        return score, h1
    except Exception:  # noqa: BLE001 -- a context column is never worth a failed score
        return None, None


def score(T, key, post, segs):
    """Grade one posted video's opening. Returns the lynxr_post_hook row, or None ONLY when there is no model client (the post then stays
    `pending`). On a failed call the row carries `error` and no score. Records the spend. Never logs a word."""
    c = _client(T)
    if c is None:
        return None
    try:
        timeout = float(HOOK_POST_TIMEOUT_S)
    except (TypeError, ValueError):
        timeout = 30.0
    client = c.with_options(timeout=timeout, max_retries=0)

    def call(kind, system, schema, content):
        return T.P.hook_call(client, HOOK_POST_MODEL, HOOK_POST_EFFORT, system, schema, content)

    fields, usage = hook_score.run_post(call, segs, HOOK_POST_MODEL)
    try:
        usd = round(sum(T.P.cost_of(m, d) or 0 for m, d in usage.items()), 6)
    except Exception:  # noqa: BLE001
        usd = None
    if RECORD_COST:
        T.P.record_cost(key, "hookpost", fields.get("error") is None, usage)
    ss, sh1 = script_score(T, key, post)
    row = {**fields, "post_id": post["id"], "creator_id": post["creator_id"], "adaptation_id": post.get("adaptation_id"),
           "script_score": ss, "script_h1": sh1, "usd": usd, "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    log.info("hook-post: post %s score %s reason_at %s $%.4f", post.get("id"), row.get("score"), row.get("reason_at_s"), usd or 0)
    return row


def write(T, key, row):
    """Upsert one lynxr_post_hook row. True on a 2xx. Never raises."""
    try:
        st, _ = T.rest(key, TABLE + "?on_conflict=post_id", method="POST", body=row, prefer="resolution=merge-duplicates,return=minimal")
        if st in (400, 404):
            log.info("hook-post: lynxr_post_hook missing — is supabase/post_hook.sql applied?")
        return 200 <= int(st) < 300
    except Exception as e:  # noqa: BLE001
        log.warning("hook-post: write failed (%s)", type(e).__name__)
        return False


def main():
    envcfg.sanitize_environ()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description="The posted-opening scorer (plan lynxr-loop-v2.md, Part 3).")
    ap.add_argument("--print", dest="post_id", type=int, metavar="POST_ID", required=True,
                    help="PAID: spends money, one model call (about $0.02). Downloads and transcribes one stored post, grades its opening, and "
                         "prints the row (no words). Writes NOTHING: no table row, no post state, no spend record. HOOK_POST need not be set; "
                         "a creator named in HOOK_POST_EXCLUDE is still left out")
    args = ap.parse_args()
    import track_posts as T                      # here and only here: see the docstring
    import post_hook as PH                       # the copy post_shape imports; this file runs as __main__, so flags are set on THAT one
    import post_shape as S
    PH.HOOK_POST, PH.HOOK_POST_SCOPE, PH.RECORD_COST = True, "all", False
    env = T.P.load_env(T.P.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
    st, rows = T.rest(key, f"{S.POSTS}?id=eq.{T.q(args.post_id)}&select=id,creator_id,platform,url,posted_at,adaptation_id")
    if st != 200 or not isinstance(rows, list) or not rows:
        print(f"no such post (HTTP {st}), or lynxr_posts is not readable")
        sys.exit(2)
    post = rows[0]
    if PH.excluded(post):
        print("this post's creator is named in HOOK_POST_EXCLUDE: nothing sent, nothing scored")
        sys.exit(1)
    r = S._measure(T, key, post, {}, keep_words=False, hook_ok=True)
    if r["kind"] != "measured":
        print(f"not measured: {r['kind']}")
        sys.exit(1)
    hook = r.get("hook")
    if hook is None:
        print("no opening was graded (no speech, the audio was longer than the video, or no model key)")
        sys.exit(1)
    print(json.dumps(hook, indent=2, default=str))
    print(f"measured ${hook.get('usd') or 0:.4f}  (nothing was written)")


if __name__ == "__main__":
    main()
