#!/usr/bin/env python3
"""Does the hook score of a POSTED opening go with how many views the video got? An analysis for the OWNER. Never shown to a creator.

Plan: ~/.claude/plans/lynxr-loop-v2.md (Part 3, step 22). The scores come from pipeline/post_hook.py (table supabase/post_hook.sql); the views
are lynxr_post_views. WHAT IT ANSWERS: across the tracked posts that have a score and a day-7 reading, do the ones whose opening scored higher
tend to be the ones that beat their own creator's usual? CORRELATION, NOT CAUSE: the score grades the words of the opening only. Views also depend
on the topic, the picture, timing, the platform and luck, and none of that is in it.

THE OUTCOME. For each scored post, y = log2((v + 1) / (m + 1)), where v is its views at day 7 (the earliest reading between day 7 and day 10,
as brain.views_at reads it) and m is the median day-7 views of the SAME creator's OTHER tracked posts on the SAME platform (all of those, scored or
not, and at least MIN_OTHERS of them). So a post is compared with its own creator's library, never with another creator's. Cross-posted
pairs (the same creator, the two platforms, posted within PAIR_H hours, lengths within PAIR_S seconds) are ONE video, so each pair is collapsed to
one row. The interval resamples CREATORS, not posts, because a creator's posts are not independent of each other.

PURE STDLIB, no repo imports at module level: the core below is testable offline and reads no network. Only main() reaches the database.
The report prints counts and coefficients: never a uuid, a handle, a caption, a URL or a word.

RUN
    ./venv/bin/python pipeline/hook_views.py --report          # live (service key), read only; on Fly:
        # fly ssh console -a lynxr-worker -C "python /app/pipeline/hook_views.py --report"
    ./venv/bin/python pipeline/hook_views.py --backup DIR      # from lynxr_post_hook.json, lynxr_posts.json and lynxr_post_views.json in a backup folder
"""
import argparse
import json
import math
import os
import random
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

RUBRIC = "hook-r1"
MIN_POSTS = 30            # fewer rows than this (after pairs collapse) and no coefficient is printed
MIN_CREATORS = 3          # ... or fewer creators than this
MIN_OTHERS = 4            # a post needs this many OTHER day-7 posts of its creator on its platform to have a usual to be compared with
DAY = 7                   # the reading is the earliest snapshot whose day is DAY..DAY + DAY_TOL (mirrors brain.views_at)
DAY_TOL = 3
BOOT = 2000               # bootstrap draws
SEED = 7
PAIR_H = 3.0              # a cross-post is the same creator's other-platform post within this many hours ...
PAIR_S = 1.5              # ... and, when both lengths are known, within this many seconds
PER_CREATOR_MIN = 8       # a per-creator coefficient needs this many rows
RULE_SIDE_MIN = 5         # a rule is compared only when both sides (met it, did not) have this many rows
MIN_BOOT = 100            # an interval from fewer usable draws than this is not printed
RULES = ("H1", "H2", "H3", "H4", "H5", "H6", "H8")

CAVEATS = (
    "A craft score of the opening's words only. Views also depend on the topic, the picture, timing, the platform and luck; none of that is in the score.",
    "Each post is compared only with the same creator's other posts on the same platform. n is small and a few creators dominate; the interval is the honest part.",
    "Timing comes from Whisper segments, not word times.",
    "Correlation, not cause. Not shown to creators.",
)


# ── pure ──────────────────────────────────────────────────────────────────────────────────────────

def _num(v):
    """A non-negative whole number or None (absent is None, never zero). The same rule as brain._num."""
    if v is None or isinstance(v, bool):
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def _float(v):
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _ts(s):
    """An aware datetime from an ISO string, or None."""
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def views7(snaps):
    """The views of a post's EARLIEST snapshot whose `day` is in [DAY, DAY + DAY_TOL] and whose `views` is not null, else None. Mirrors
    brain.views_at: a post first found at day 23 has no day-7 reading, and is left out rather than compared at a different age."""
    best = None
    for s in snaps or []:
        d, v = _num((s or {}).get("day")), _num((s or {}).get("views"))
        if d is None or v is None or not (DAY <= d <= DAY + DAY_TOL):
            continue
        if best is None or d < best[0]:
            best = (d, v)
    return best[1] if best else None


def ranks(xs):
    """Average ranks (1-based), ties sharing the mean of the ranks they occupy."""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    out = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            out[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return out


def spearman(xs, ys):
    """Spearman's rho, or None when there are fewer than 3 pairs or either side has no variance."""
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    rx, ry = ranks(xs), ranks(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    sxx = sum((a - mx) ** 2 for a in rx)
    syy = sum((b - my) ** 2 for b in ry)
    if sxx == 0 or syy == 0:
        return None
    return sum((a - mx) * (b - my) for a, b in zip(rx, ry)) / math.sqrt(sxx * syy)


def _tracked(p):
    """A tracked post. A row with no `origin` key came from the live read, which already filters to tracked; a row that says `pasted` is not."""
    return isinstance(p, dict) and p.get("origin", "tracked") == "tracked"


def build_rows(posts, snaps_by_post, hooks):
    """One row per scored post that can be compared: [{"post_id", "creator", "platform", "posted", "duration", "x", "y", "verdicts"}], plus the
    counts {"scored", "day7", "baseline"} (how many scored posts, how many of them have a day-7 reading, how many have a usual to compare with).

    A post is scored when its hook row has a score and no error. The usual `m` is the median day-7 views of the same creator's OTHER tracked
    posts on the same platform, counting ALL of them (scored or not); a post with fewer than MIN_OTHERS others is left out."""
    by_id = {p["id"]: p for p in (posts or []) if _tracked(p) and p.get("id") is not None}
    v7 = {pid: views7((snaps_by_post or {}).get(pid)) for pid in by_id}
    # the library each post is compared with: (creator, platform) -> [(post id, day-7 views)]
    library = {}
    for pid, p in by_id.items():
        if v7[pid] is not None:
            library.setdefault((p.get("creator_id"), p.get("platform")), []).append((pid, v7[pid]))
    counts = {"scored": 0, "day7": 0, "baseline": 0}
    rows = []
    for h in sorted((h for h in (hooks or []) if isinstance(h, dict)), key=lambda h: str(h.get("post_id"))):
        p = by_id.get(h.get("post_id"))
        score = _num(h.get("score"))
        if p is None or h.get("error") or score is None:
            continue
        counts["scored"] += 1
        v = v7.get(h["post_id"])
        if v is None:
            continue
        counts["day7"] += 1
        others = [ov for opid, ov in library.get((p.get("creator_id"), p.get("platform")), []) if opid != h["post_id"]]
        if len(others) < MIN_OTHERS:
            continue
        counts["baseline"] += 1
        m = statistics.median(others)
        rows.append({"post_id": h["post_id"], "creator": p.get("creator_id"), "platform": p.get("platform"), "posted": _ts(p.get("posted_at")),
                     "duration": _float(p.get("duration_s")), "x": float(score), "y": math.log2((v + 1) / (m + 1)),
                     "verdicts": h.get("verdicts") if isinstance(h.get("verdicts"), dict) else {}})
    return rows, counts


def collapse_pairs(rows):
    """Cross-posts are one video: the same creator, different platforms, `posted_at` within PAIR_H hours and, when both lengths are known,
    within PAIR_S seconds, become ONE row with the mean x and the mean y (the verdicts of the lower post id). Each row pairs at most once, with
    the nearest in time. Returns (rows, number of pairs collapsed)."""
    rows = sorted(rows, key=lambda r: (str(r["creator"]), r["posted"] or datetime.min.replace(tzinfo=timezone.utc), str(r["post_id"])))
    used, out, pairs = set(), [], 0
    for i, r in enumerate(rows):
        if i in used:
            continue
        best = None
        for j in range(i + 1, len(rows)):
            c = rows[j]
            if j in used or c["creator"] != r["creator"]:
                continue
            if c["platform"] == r["platform"] or r["posted"] is None or c["posted"] is None:
                continue
            gap = abs((c["posted"] - r["posted"]).total_seconds()) / 3600.0
            if gap > PAIR_H:
                continue
            if r["duration"] is not None and c["duration"] is not None and abs(r["duration"] - c["duration"]) > PAIR_S:
                continue
            if best is None or gap < best[0]:
                best = (gap, j)
        if best is None:
            out.append(r)
            continue
        used.add(best[1])
        c = rows[best[1]]
        first = r if str(r["post_id"]) <= str(c["post_id"]) else c
        out.append({**first, "x": (r["x"] + c["x"]) / 2, "y": (r["y"] + c["y"]) / 2})
        pairs += 1
    return out, pairs


def _rho(rows):
    return spearman([r["x"] for r in rows], [r["y"] for r in rows])


def _pct(sorted_xs, q):
    """The q-th (0..1) percentile of a sorted list, interpolated."""
    k = (len(sorted_xs) - 1) * q
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    return sorted_xs[lo] + (sorted_xs[hi] - sorted_xs[lo]) * (k - lo)


def _by_creator(rows):
    out = {}
    for r in rows:
        out.setdefault(r["creator"], []).append(r)
    return out


def boot_ci(rows, draws=BOOT, seed=SEED):
    """The 2.5th and 97.5th percentiles of rho when CREATORS are resampled with replacement, or None when too few draws have a defined rho.
    Deterministic for a given seed."""
    groups = _by_creator(rows)
    keys = sorted(groups, key=str)
    if len(keys) < 2:
        return None
    rng = random.Random(seed)
    vals = []
    for _ in range(draws):
        sample = []
        for _k in keys:
            sample += groups[keys[rng.randrange(len(keys))]]
        r = _rho(sample)
        if r is not None:
            vals.append(r)
    if len(vals) < MIN_BOOT:
        return None
    vals.sort()
    return _pct(vals, 0.025), _pct(vals, 0.975)


def loco(rows):
    """(min, max) of rho when each creator in turn is left out, or None."""
    groups = _by_creator(rows)
    vals = []
    for k in groups:
        r = _rho([x for g, rs in groups.items() if g != k for x in rs])
        if r is not None:
            vals.append(r)
    return (min(vals), max(vals)) if vals else None


def by_rule(rows):
    """For each rule, the rows that met it ("pass") against those that only partly met it or failed, with the median 2**y (how many times the
    creator's usual) on each side. Only when both sides have at least RULE_SIDE_MIN rows. {rule: {"pass_n", "pass_med", "other_n", "other_med"}}."""
    out = {}
    for rule in RULES:
        met = [2 ** r["y"] for r in rows if (r["verdicts"] or {}).get(rule) == "pass"]
        miss = [2 ** r["y"] for r in rows if (r["verdicts"] or {}).get(rule) in ("partial", "fail")]
        if len(met) >= RULE_SIDE_MIN and len(miss) >= RULE_SIDE_MIN:
            out[rule] = {"pass_n": len(met), "pass_med": statistics.median(met), "other_n": len(miss), "other_med": statistics.median(miss)}
    return out


def analyse(posts, snaps, hooks):
    """The whole analysis as a dict. `snaps` is a flat list of lynxr_post_views rows."""
    snaps_by_post = {}
    for s in snaps or []:
        if isinstance(s, dict) and s.get("post_id") is not None:
            snaps_by_post.setdefault(s["post_id"], []).append(s)
    rows, counts = build_rows(posts, snaps_by_post, hooks)
    rows, pairs = collapse_pairs(rows)
    groups = _by_creator(rows)
    rep = {**counts, "pairs": pairs, "n": len(rows), "creators": len(groups), "enough": len(rows) >= MIN_POSTS and len(groups) >= MIN_CREATORS}
    if not rep["enough"]:
        return rep
    rep["rho"] = _rho(rows)
    rep["ci"] = boot_ci(rows)
    rep["loco"] = loco(rows)
    big = sorted(((len(rs), k) for k, rs in groups.items() if len(rs) >= PER_CREATOR_MIN), key=lambda t: (-t[0], str(t[1])))
    rep["per_creator"] = [(chr(65 + i) if i < 26 else "?", n, _rho(groups[k])) for i, (n, k) in enumerate(big)]
    rep["rules"] = by_rule(rows)
    ci = rep["ci"]
    rep["clear"] = bool(ci and (ci[0] > 0 or ci[1] < 0))
    return rep


def _f(x):
    return "n/a" if x is None else f"{x:+.2f}"


def render(rep):
    """The report as text. Counts and coefficients only."""
    out = [f"hook score vs views (posted openings, rubric {RUBRIC}). OWNER ONLY, not shown to creators.",
           f"outcome: log2((views at day {DAY}-{DAY + DAY_TOL} + 1) / (the same creator's usual on the same platform + 1)); the usual is the median of their other "
           f"posts' day-{DAY} views (at least {MIN_OTHERS} others)",
           f"scored {rep['scored']} · with a day-{DAY} reading {rep['day7']} · with a baseline {rep['baseline']} · pairs collapsed {rep['pairs']} · "
           f"creators {rep['creators']}"]
    if not rep["enough"]:
        out.append(f"not enough to say yet: {rep['n']} posts from {rep['creators']} creators (needs {MIN_POSTS} from {MIN_CREATORS})")
    else:
        ci, lo = rep["ci"], rep["loco"]
        out.append(f"spearman rho {_f(rep['rho'])} · 95% interval " + (f"[{_f(ci[0])}, {_f(ci[1])}]" if ci else "[n/a]")
                   + f" (creator bootstrap, {BOOT} draws) · leave-one-creator-out " + (f"[{_f(lo[0])}, {_f(lo[1])}]" if lo else "[n/a]"))
        if rep["per_creator"]:
            out.append("per creator (" + f"at least {PER_CREATOR_MIN} posts): " + " · ".join(f"{lab} n {n} rho {_f(r)}" for lab, n, r in rep["per_creator"]))
        if rep["rules"]:
            out.append(f"by rule (median views as a multiple of the creator's usual; met vs partly or not; at least {RULE_SIDE_MIN} on each side):")
            for rule, d in rep["rules"].items():
                out.append(f"  {rule}: met {d['pass_med']:.2f}x (n {d['pass_n']}) · not met {d['other_med']:.2f}x (n {d['other_n']})")
        else:
            out.append(f"by rule: no rule has {RULE_SIDE_MIN} rows on each side yet")
        out.append("the hook score went with views in these creators' own libraries" if rep["clear"]
                   else "no clear relationship at this sample size (the interval includes zero)")
    out.append("")
    out.extend(CAVEATS)
    return "\n".join(out)


# ── by hand ───────────────────────────────────────────────────────────────────────────────────────

def _page_all(T, key, path):
    """Every row of a read, 1000 at a time, or None when a page fails."""
    out, off = [], 0
    while True:
        st, rows = T.rest(key, f"{path}&limit=1000&offset={off}")
        if st != 200 or not isinstance(rows, list):
            return None
        out += rows
        if len(rows) < 1000:
            return out
        off += 1000


def _live(key, T):
    hooks = _page_all(T, key, "/rest/v1/lynxr_post_hook?select=post_id,creator_id,score,verdicts,error&order=post_id.asc")
    posts = _page_all(T, key, "/rest/v1/lynxr_posts?origin=eq.tracked&select=id,creator_id,platform,posted_at,duration_s&order=id.asc")
    if posts is None:                        # duration_s is platform_insights.sql's column: without it, pairs match on time alone
        posts = _page_all(T, key, "/rest/v1/lynxr_posts?origin=eq.tracked&select=id,creator_id,platform,posted_at&order=id.asc")
    snaps = _page_all(T, key, "/rest/v1/lynxr_post_views?select=post_id,day,views&order=post_id.asc,day.asc")
    return posts, snaps, hooks


def _backup(folder):
    out = []
    for name in ("lynxr_post_hook.json", "lynxr_posts.json", "lynxr_post_views.json"):
        f = Path(folder).expanduser() / name
        if not f.exists():
            sys.exit(f"{f}: missing (a backup made before supabase/post_hook.sql has no lynxr_post_hook.json)")
        data = json.loads(f.read_text())
        out.append(data if isinstance(data, list) else [])
    return out[1], out[2], out[0]


def main():
    ap = argparse.ArgumentParser(description="Does the hook score of a posted opening go with views? Owner only (plan lynxr-loop-v2.md, Part 3).")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--report", action="store_true", help="read the live tables (service key, read only) and print the analysis")
    g.add_argument("--backup", metavar="DIR", help="read lynxr_post_hook.json, lynxr_posts.json and lynxr_post_views.json from a backup folder")
    args = ap.parse_args()
    if args.backup:
        posts, snaps, hooks = _backup(args.backup)
    else:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import envcfg
        import track_posts as T                  # here and only here: the module at the top reads nothing from the repo
        envcfg.sanitize_environ()
        env = T.P.load_env(T.P.ROOT / ".env")
        try:
            key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
        except ValueError as e:
            sys.exit(str(e))
        if not key:
            sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
        posts, snaps, hooks = _live(key, T)
        for name, got in (("lynxr_post_hook (is supabase/post_hook.sql applied?)", hooks), ("lynxr_posts", posts), ("lynxr_post_views", snaps)):
            if got is None:
                sys.exit(f"could not read {name}")
    print(render(analyse(posts, snaps, hooks)))


if __name__ == "__main__":
    main()
