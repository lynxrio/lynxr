#!/usr/bin/env python3
"""The pure scorer behind the automatic link between a tracked post and the lynxr script it came from.

Plan: ~/.claude/plans/lynxr-adaptation-id.md (step 1 of ~/.claude/plans/lynxr-one-brain-v1.md). The feature set, the weights and
the thresholds are the ones reviewed in the 2026-09-21 grill (~/.claude/plans/lynxr-post-detection.md, steps 7 and 8); they move
only on reviewed data from lynxr_match_log (supabase/post_match.sql), never on a hunch.

PRECISION OVER RECALL. A wrong link is uncorrectable and poisons the brain: it teaches the coach that a script produced a post it
did not produce, nothing downstream can detect that, and nobody will ever correct it. A missed link teaches nothing and costs
nothing. So `decide()` links only when every guard agrees, and everything doubtful is `borderline` (logged for staff, never
written). The target is fewer than 5 wrong links per 100 auto-links.

NO TRANSCRIPT IS EVER STORED. This module takes the words of a post as an argument, scores them in memory and returns numbers.
It has no network, no filesystem write and no logging. The caller (pipeline/track_posts.py) keeps the transcript in one local
variable inside one TemporaryDirectory block and records only scores and script ids.

NO-BRAND ENTRIES ARE EXCLUDED IN v1 (owner decision, 2026-10-07). An "original script" entry carries no brand, and its spoken text
is the SOURCE video's own transcript. A creator who reposts, stitches or duets that source video would score ~1.0 against it and
be linked to a script they never used, and no threshold removes that. Branded entries carry words lynxr itself wrote, which is
the evidence the brain actually wants. This costs recall; it is recoverable later. candidates() is the single place that rule
lives.

Stdlib plus script_checks only: no process_adaptations import, so the tests and eval_scripts.py can import this file safely.

RUN (offline, writes nothing)
    ./venv/bin/python pipeline/post_match.py --score-file FILE.json
    FILE.json = {"transcript": str, "caption": str, "has_speech": bool, "posted_at": iso, "adaptations": [...], "brands": [...]}
    Prints one row per candidate (rank, id8, score, contain, recall, hook, brand, caption, days) and then the decision. Keep
    FILE.json outside the repo: it holds real script text.
"""
import re
from collections import namedtuple
from datetime import datetime, timedelta, timezone

import script_checks as SC

STOP = frozenset("""a about after all also am an and any are as at be because been before but
by can cant come could did didnt do dont even for from get go going got had has have he her
here hey him his how i if im in into is it its just know let like look make me more most my no
not now of off oh ok on once one only or other our out over really right said say see she
should so some than that the their them then there these they thing think this those through
to too up us very was way we well were what when where which while who why will with would
yeah yes you your youre""".split())

Cfg = namedtuple(
    "Cfg", ["auto_min", "margin", "contain_min", "contain_strong", "auto_days", "log_min", "per_script", "window_days"],
    defaults=[0.70, 0.25, 0.45, 0.60, 30, 0.25, 4, 45])


# ── text ──────────────────────────────────────────────────────────────────────────────────────────

def norm_words(text):
    """The content words of `text`, in order: lowercased, apostrophes dropped, one-letter tokens and STOP words gone."""
    out = []
    for w in SC.words(text):
        w = w.replace("'", "")
        if len(w) >= 2 and w not in STOP:
            out.append(w)
    return out


def shingles(words, n):
    """The set of n-word tuples in `words`. Empty when there are fewer than n words."""
    if n < 1 or len(words) < n:
        return set()
    return {tuple(words[i:i + n]) for i in range(len(words) - n + 1)}


def script_words(a):
    """(content words of the spoken text, content words of the hook, silent?) for one adaptation entry. The spoken text is the
    hook, every beat's `say` in order, then the cta."""
    ad = a.get("adaptation") or {}
    silent = ad.get("delivery") == "silent"
    parts = [ad.get("hook") or ""] + [str((b or {}).get("say") or "") for b in (ad.get("beats") or [])] + [ad.get("cta") or ""]
    return norm_words(" ".join(str(p) for p in parts)), norm_words(ad.get("hook")), silent


def parse_ts(s):
    """An aware datetime from an ISO string (a trailing Z and fractional seconds are fine), or None."""
    if not s:
        return None
    try:
        t = str(s).strip().replace("Z", "+00:00")
        m = re.match(r"^(.*T\d\d:\d\d:\d\d)\.(\d+)(.*)$", t)
        if m:
            t = f"{m.group(1)}.{m.group(2)[:6].ljust(6, '0')}{m.group(3)}"
        d = datetime.fromisoformat(t)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _run_in(words, run):
    """True when `run` (a non-empty list of words) appears contiguously in `words`."""
    n = len(run)
    return bool(n) and any(words[i:i + n] == run for i in range(len(words) - n + 1))


# ── candidates ────────────────────────────────────────────────────────────────────────────────────

def candidates(adaptations, attached_counts, posted_at, window_days, per_script=4, cap=30):
    """The entries worth scoring against a post made at `posted_at`, newest `addedAt` first, at most `cap`.

    An entry qualifies when ALL hold: it is finished (status done); it has a brand (no-brand entries are excluded in v1, see the
    module docstring); it has beats; its addedAt falls in [posted_at - window_days, posted_at + 1 hour]; and fewer than
    `per_script` posts are already linked to it (`attached_counts` maps adaptation id -> posts linked)."""
    lo = posted_at - timedelta(days=window_days)
    hi = posted_at + timedelta(hours=1)
    out = []
    for a in adaptations or []:
        if not isinstance(a, dict) or a.get("status") != "done" or not a.get("brandId") or not a.get("id"):
            continue
        if not (a.get("adaptation") or {}).get("beats"):
            continue
        added = parse_ts(a.get("addedAt"))
        if added is None or not (lo <= added <= hi):
            continue
        if (attached_counts or {}).get(a["id"], 0) >= per_script:
            continue
        out.append((added, a))
    out.sort(key=lambda p: p[0], reverse=True)
    return [a for _, a in out[:cap]]


# ── features and score ────────────────────────────────────────────────────────────────────────────

def features(post_words, has_speech, caption_words, cand, brand_name, posted_at):
    """The numbers one candidate script is judged on, against one post. `post_words` and `caption_words` are norm_words() lists."""
    words, hook_words, silent = script_words(cand)
    n = 3 if len(words) >= 8 else 2
    sh = shingles(words, n)
    # Content-word shingles survive loose filming: fillers and function words are gone before shingling, so a creator who
    # ad-libs around the script's content words still scores, and a dropped or re-ordered line only costs the shingles it held.
    containment = len(sh & shingles(post_words, n)) / len(sh) if sh else 0.0
    uniq = set(words)
    recall = len(uniq & set(post_words)) / len(uniq) if uniq else 0.0
    hs = shingles(hook_words, 2)
    head = shingles(post_words[:max(1, int(0.4 * len(post_words)))], 2)
    hook = 1 if hs and len(hs & head) >= 0.5 * len(hs) else 0
    bw = norm_words(brand_name)
    brand = 1 if len(" ".join(bw)) >= 3 and (_run_in(post_words, bw) or _run_in(caption_words, bw)) else 0
    cap_set = set(norm_words((cand.get("adaptation") or {}).get("caption")))
    cw = set(caption_words)
    caption = len(cap_set & cw) / len(cap_set | cw) if (cap_set | cw) else 0.0
    added = parse_ts(cand.get("addedAt"))
    days = float((posted_at - added).days) if added is not None and posted_at is not None else 9999.0
    return {"containment": round(containment, 3), "recall": round(recall, 3), "hook": hook, "brand": brand,
            "caption": round(caption, 3), "days": days, "silent": bool(silent), "speech": bool(has_speech)}


def score(f):
    """0..1. The weighted sum, damped for an old script; capped at 0.5 when the script is silent or the post has no speech,
    so a caption alone can never reach the auto bar."""
    if f["silent"] or not f["speech"]:
        s = min(0.5, 0.6 * f["caption"] + 0.3 * f["brand"] + 0.1)
    else:
        s = 0.55 * f["containment"] + 0.20 * f["recall"] + 0.10 * f["hook"] + 0.10 * f["brand"] + 0.05 * f["caption"]
        s *= 1.0 if f["days"] <= 14 else 0.9 if f["days"] <= 30 else 0.75
    return round(min(1.0, max(0.0, s)), 3)


def decide(scored, cfg):
    """`scored` = [(adaptation_id, score, features)] sorted descending. ("auto", id) only when EVERY guard holds for the best
    entry; else ("borderline", id) when it scored at least cfg.log_min; else ("none", None)."""
    if not scored:
        return "none", None
    best_id, best, f = scored[0]
    second = scored[1][1] if len(scored) > 1 else 0.0
    if (f["speech"] and not f["silent"]
            and 0 <= f["days"] <= cfg.auto_days
            and f["containment"] >= cfg.contain_min
            and best >= cfg.auto_min
            and best - second >= cfg.margin
            and (f["brand"] or f["hook"] or f["containment"] >= cfg.contain_strong)):
        return "auto", best_id
    if best >= cfg.log_min:
        return "borderline", best_id
    return "none", None


def rank(adaptations, brands, transcript, caption, has_speech, posted_at, cfg=Cfg(), attached_counts=None):
    """Score every candidate and decide. `brands` is the creator's brand list ({id, name}). Returns (scored, decision, best_id)."""
    names = {b.get("id"): b.get("name") for b in (brands or []) if isinstance(b, dict)}
    post_words, caption_words = norm_words(transcript), norm_words(caption)
    scored = []
    for c in candidates(adaptations, attached_counts or {}, posted_at, cfg.window_days, cfg.per_script):
        f = features(post_words, has_speech, caption_words, c, names.get(c.get("brandId")) or "", posted_at)
        scored.append((c["id"], score(f), f))
    scored.sort(key=lambda r: r[1], reverse=True)
    decision, best_id = decide(scored, cfg)
    return scored, decision, best_id


# ── by hand ───────────────────────────────────────────────────────────────────────────────────────

def main():
    import argparse
    import json
    import sys
    ap = argparse.ArgumentParser(description="Offline: score one transcript against a creator's scripts. Writes nothing.")
    ap.add_argument("--score-file", required=True, metavar="FILE.json",
                    help='{"transcript", "caption", "has_speech", "posted_at", "adaptations": [...], "brands": [...]}; keep it outside the repo')
    args = ap.parse_args()
    with open(args.score_file) as fh:
        d = json.load(fh)
    posted = parse_ts(d.get("posted_at"))
    if posted is None:
        sys.exit("posted_at must be an ISO timestamp")
    scored, decision, best_id = rank(d.get("adaptations"), d.get("brands"), d.get("transcript"), d.get("caption"),
                                     bool(d.get("has_speech", True)), posted)
    print("rank  id8       score  contain  recall  hook  brand  caption  days")
    for i, (aid, s, f) in enumerate(scored, 1):
        print(f"{i:<5} {str(aid)[:8]:<9} {s:<6.3f} {f['containment']:<8.3f} {f['recall']:<7.3f} {f['hook']:<5} {f['brand']:<6} "
              f"{f['caption']:<8.3f} {f['days']:.0f}")
    if not scored:
        print("(no candidate script: none is finished, branded, in the window and under its link cap)")
    print(f"decision: {decision}" + (f"  {str(best_id)[:8]}" if best_id else ""))


if __name__ == "__main__":
    main()
