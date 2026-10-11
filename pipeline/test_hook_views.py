"""Offline checks for pipeline/hook_views.py, the owner-only analysis of whether a posted opening's hook score goes with views. Stdlib only, no
network, no Supabase. Every creator, handle, caption, url and number below is invented for this test. It is checked into a public repo.

Run with

    ./venv/bin/python pipeline/test_hook_views.py
"""
import json
import math
import random
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import hook_views as V  # noqa: E402
import brain  # noqa: E402  (only to compare views7 with the reading the brain uses)

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


def near(name, got, want, tol=1e-9):
    ok = got is not None and abs(got - want) <= tol
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


T0 = datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)
SENT = "snazzlewump"


def cid(c):
    return f"00000000-0000-4000-8000-{c:012d}"


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


class World:
    """An invented set of posts, day-7 snapshots and hook rows."""

    def __init__(self):
        self.posts, self.snaps, self.hooks, self.n = [], [], [], 0

    def add(self, creator, views, score=None, platform="tiktok", at=None, duration=None, day=7, error=None, origin="tracked", verdicts=None):
        self.n += 1
        pid = self.n
        self.posts.append({"id": pid, "creator_id": cid(creator), "platform": platform, "origin": origin, "duration_s": duration,
                           "posted_at": iso(at or (T0 + timedelta(days=pid, hours=creator))), "handle": SENT, "caption": SENT + " caption",
                           "url": f"https://www.tiktok.com/@{SENT}/video/{pid}"})
        if views is not None:
            self.snaps.append({"post_id": pid, "day": day, "views": views})
        if score is not None or error:
            self.hooks.append({"post_id": pid, "creator_id": cid(creator), "score": score, "error": error,
                               "verdicts": verdicts if verdicts is not None else {k: ("pass" if (score or 0) >= 60 else "partial") for k in V.RULES}})
        return pid

    def run(self):
        return V.analyse(self.posts, self.snaps, self.hooks)

    def rows(self):
        by = {}
        for s in self.snaps:
            by.setdefault(s["post_id"], []).append(s)
        return V.build_rows(self.posts, by, self.hooks)


def library(strong, creators=4, per=10, seed=3):
    """creators x per posts, all scored, all with a day-7 reading. strong: views rise with the score; else they are unrelated to it."""
    w = World()
    rng = random.Random(seed)
    for c in range(1, creators + 1):
        for i in range(per):
            x = 30 + (i * 7 + c * 11) % 66
            noise = rng.uniform(0.8, 1.25) if strong else 1.0
            views = round(1000 * 2 ** ((x - 60) / 25) * noise) if strong else round(1000 * 2 ** rng.uniform(-2, 2))
            w.add(c, views, score=x)
    return w


# ── 1. spearman ──────────────────────────────────────────────────────────────────────────────────
near("spearman: a rising pair of vectors is +1", V.spearman([1, 2, 3, 4, 5], [10, 20, 35, 80, 90]), 1.0)
near("spearman: a reversed one is -1", V.spearman([1, 2, 3, 4, 5], [90, 80, 35, 20, 10]), -1.0)
near("spearman: ties take average ranks (hand-worked: 4.5 / sqrt(22.5))", V.spearman([1, 1, 2, 3], [1, 2, 3, 4]), 4.5 / math.sqrt(22.5))
check("spearman: two pairs is None", V.spearman([1, 2], [1, 2]), None)
check("spearman: no variance on a side is None", V.spearman([1, 1, 1, 1], [1, 2, 3, 4]), None)
check("ranks: ties share the mean rank", V.ranks([5, 1, 5, 9]), [2.5, 1.0, 2.5, 4.0])

# ── 2. views7 is the brain's reading ─────────────────────────────────────────────────────────────
fixtures = [
    [],
    [{"day": 7, "views": 100}],
    [{"day": 5, "views": 80}, {"day": 11, "views": 400}],                                  # nothing in 7..10
    [{"day": 10, "views": 300}],                                                           # the upper edge counts
    [{"day": 9, "views": 250}, {"day": 7, "views": 100}, {"day": 8, "views": 120}],        # the earliest in range wins
    [{"day": 7, "views": None}, {"day": 8, "views": 150}],                                 # a null reading is skipped
]
check("views7 equals brain.views_at on 6 snapshot fixtures", [V.views7(f) for f in fixtures], [brain.views_at(f) for f in fixtures])
check("views7: the values themselves", [V.views7(f) for f in fixtures], [None, 100, None, 300, 100, 150])

# ── 3. the baseline is the creator's OTHER posts ─────────────────────────────────────────────────
w = World()
for v in (100, 200, 300, 400, 500):
    w.add(1, v, score=70)
rows, counts = w.rows()
ys = {r["post_id"]: r["y"] for r in rows}
near("baseline: the post itself is left out (views 100, others median 350)", ys[1], math.log2(101 / 351))
near("baseline: views 500, others median 250", ys[5], math.log2(501 / 251))
check("baseline: counts", counts, {"scored": 5, "day7": 5, "baseline": 5})

w = World()
for v in (100, 200, 300, 400):
    w.add(1, v, score=70)
rows, counts = w.rows()
check("MIN_OTHERS: a creator with only 3 others per post is left out", (rows, counts["baseline"], counts["day7"]), ([], 0, 4))

w = World()
w.add(1, 100, score=70)
for v in (200, 300, 400, 500):
    w.add(1, v)                                                            # unscored posts still make the library
rows, counts = w.rows()
near("baseline: UNSCORED posts count in the library", rows[0]["y"], math.log2(101 / 351))

w = World()
w.add(1, 100, score=70)
for v in (200, 300, 400):
    w.add(1, v)
w.add(1, 9000, platform="instagram")
rows, _ = w.rows()
check("baseline: another platform's post is not in the library, so 3 others is too few", rows, [])

w = World()
w.add(1, 100, score=70)
for v in (200, 300, 400, 500):
    w.add(1, v)
w.add(1, 100000, origin="pasted")
w.add(2, 5000)
rows, _ = w.rows()
near("baseline: a pasted post and another creator's post are not in the library", rows[0]["y"], math.log2(101 / 351))

w = World()
for i, v in enumerate((100, 200, 300, 400, 500, 600)):
    w.add(1, v, score=(70 if i == 0 else None), error=("bad_verdict" if i == 1 else None))
w.add(1, 700, score=60, error="TimeoutError")
w.add(1, 800, score=None, error=None)
rows, counts = w.rows()
check("only a hook row with a score and no error is scored", counts["scored"], 1)

w = World()
for i, v in enumerate((100, 200, 300, 400, 500)):
    w.add(1, v, score=70, day=(7 if i < 4 else 20))
rows, counts = w.rows()
check("a post with no day-7 reading (first read at day 20) is not scored against one", (counts["scored"], counts["day7"]), (5, 4))

# ── 4. pairs ─────────────────────────────────────────────────────────────────────────────────────
def pair_world(gap_h=1.0, d_tt=20.0, d_ig=20.5, plat_ig="instagram", creator_ig=1):
    w = World()
    for v in (100, 200, 300, 400):
        w.add(1, v, platform="tiktok")                                      # four others each, on both platforms
        w.add(1, v, platform="instagram")
    a = w.add(1, 1000, score=80, platform="tiktok", at=T0 + timedelta(days=40), duration=d_tt)
    b = w.add(creator_ig, 500, score=60, platform=plat_ig, at=T0 + timedelta(days=40, hours=gap_h), duration=d_ig)
    return w, a, b


def collapse(w):
    rows, _ = w.rows()
    return V.collapse_pairs(rows)


out, n = collapse(pair_world()[0])
check("pairs: one video on two platforms inside 3h and 1.5s is ONE row", (len(out), n), (1, 1))
near("pairs: with the mean x", out[0]["x"], 70.0)
near("pairs: and the mean y", out[0]["y"], (math.log2(1001 / 251) + math.log2(501 / 251)) / 2)
out, n = collapse(pair_world(gap_h=5.0)[0])
check("pairs: 5 hours apart is two videos", (len(out), n), (2, 0))
out, n = collapse(pair_world(d_ig=23.0)[0])
check("pairs: lengths 3 seconds apart are two videos", (len(out), n), (2, 0))
out, n = collapse(pair_world(d_tt=None, d_ig=None)[0])
check("pairs: unknown lengths pair on time alone", (len(out), n), (1, 1))
out, n = collapse(pair_world(plat_ig="tiktok")[0])
check("pairs: the same platform is never a pair", (len(out), n), (2, 0))
out, n = collapse(pair_world(creator_ig=2)[0])
check("pairs: another creator is never a pair", n, 0)

# ── 5. not enough ────────────────────────────────────────────────────────────────────────────────
w = library(True, creators=2, per=8)
rep = w.run()
text = V.render(rep)
check("not enough: 16 posts from 2 creators says so, with the thresholds", "not enough to say yet: 16 posts from 2 creators (needs 30 from 3)" in text, True)
check("not enough: no coefficient is printed", ("spearman" in text, "95% interval" in text), (False, False))
check("not enough: the caveats are still printed", all(c in text for c in V.CAVEATS), True)
check("not enough: a header that says owner only", text.splitlines()[0], "hook score vs views (posted openings, rubric hook-r1). OWNER ONLY, not shown to creators.")
rep = library(True, creators=2, per=20).run()
check("not enough: 40 posts from only 2 creators is still not enough", rep["enough"], False)
rep = library(True, creators=3, per=8).run()
check("not enough: 24 posts from 3 creators is not enough either", rep["enough"], False)

# ── 6. enough, and the interpretation line flips with the interval ───────────────────────────────
strong = library(True).run()
text = V.render(strong)
check("enough: a strong relationship has a positive rho and an interval above zero", (strong["enough"], strong["rho"] > 0.5, strong["ci"][0] > 0, strong["clear"]),
      (True, True, True, True))
check("enough: the interpretation says the score went with views", "the hook score went with views in these creators' own libraries" in text, True)
check("enough: the coefficient line names both intervals", ("spearman rho +" in text, "95% interval [" in text, "creator bootstrap, 2000 draws" in text, "leave-one-creator-out [" in text),
      (True, True, True, True))
nul = library(False, seed=5).run()
text = V.render(nul)
check("enough: unrelated data has an interval that includes zero", (nul["ci"][0] <= 0 <= nul["ci"][1], nul["clear"]), (True, False))
check("enough: the interpretation says no clear relationship", "no clear relationship at this sample size (the interval includes zero)" in text, True)
check("enough: only one interpretation line is printed", sum(("went with views" in l or "no clear relationship" in l) for l in text.splitlines()), 1)

# ── 7. the bootstrap is deterministic, and honest about being unable ─────────────────────────────
rows, _ = library(True).rows()
check("boot_ci: the same seed gives the same interval", V.boot_ci(rows, 500, 7), V.boot_ci(rows, 500, 7))
check("boot_ci: a different seed may differ but stays ordered", (lambda c: c[0] <= c[1])(V.boot_ci(rows, 500, 99)), True)
check("boot_ci: one creator cannot be resampled", V.boot_ci([r for r in rows if r["creator"] == cid(1)]), None)
lo, hi = V.loco(rows)
check("loco: the leave-one-out range holds the full-sample rho", lo <= V.spearman([r["x"] for r in rows], [r["y"] for r in rows]) <= hi, True)
manual = [V.spearman([r["x"] for r in rows if r["creator"] != cid(c)], [r["y"] for r in rows if r["creator"] != cid(c)]) for c in (1, 2, 3, 4)]
check("loco: equals a hand recomputation leaving each creator out", (lo, hi), (min(manual), max(manual)))

# ── 8. per creator and per rule ──────────────────────────────────────────────────────────────────
w = library(True, creators=4, per=10)
for i in range(3):
    w.add(5, 1000 * (i + 1), score=50 + i)        # a creator too small to have a library: no rows
rep = w.run()
check("per creator: only creators with 8 or more rows (the small one has none), labelled A, B, ... by descending n", [(lab, n) for lab, n, r in rep["per_creator"]], [("A", 10), ("B", 10), ("C", 10), ("D", 10)])
# one creator with 8 rows, others with 10: the 10s come first
w = World()
for c, per in ((1, 8), (2, 12), (3, 10), (4, 10)):
    for i in range(per):
        w.add(c, round(1000 * 2 ** ((30 + (i * 7 + c) % 66 - 60) / 25)), score=30 + (i * 7 + c) % 66)
rep = w.run()
check("per creator: ordered by n descending (12, 10, 10, 8)", [n for lab, n, r in rep["per_creator"]], [12, 10, 10, 8])

rows, _ = library(True).rows()
rules = V.by_rule(rows)
check("by_rule: a rule with 5+ rows on each side is reported", sorted(rules), sorted(V.RULES))
check("by_rule: met-the-rule posts sit above the others on this fixture", all(d["pass_med"] > d["other_med"] for d in rules.values()), True)
thin = [dict(r, verdicts={"H1": "pass" if i < 3 else "partial"}) for i, r in enumerate(rows)]
check("by_rule: fewer than 5 on a side drops the rule", V.by_rule(thin), {})
na = [dict(r, verdicts={"H1": "n/a"}) for r in rows]
check("by_rule: n/a belongs to neither side", V.by_rule(na), {})
check("by_rule: H7, H9 and H10 are not compared (H7 is n/a on a posted video; the other two are conditional)", V.RULES, ("H1", "H2", "H3", "H4", "H5", "H6", "H8"))

# ── 9. counts ────────────────────────────────────────────────────────────────────────────────────
w, a, b = pair_world()
rep = w.run()
check("analyse: counts scored, day-7, baseline and pairs", (rep["scored"], rep["day7"], rep["baseline"], rep["pairs"], rep["n"]), (2, 2, 2, 1, 1))

# ── 10. privacy of the output ────────────────────────────────────────────────────────────────────
UUID = re.compile(r"[0-9a-f]{8}-")
for name, world in (("enough", library(True)), ("not enough", library(True, creators=2, per=5))):
    text = V.render(world.run())
    check(f"render ({name}): no uuid-shaped string", UUID.search(text), None)
    check(f"render ({name}): no handle, caption or url", [w for w in (SENT, "tiktok.com", "http", "@") if w in text], [])

# ── 11. the command line, offline, from a backup folder ──────────────────────────────────────────
world = library(True)
with tempfile.TemporaryDirectory() as d:
    (Path(d) / "lynxr_posts.json").write_text(json.dumps(world.posts))
    (Path(d) / "lynxr_post_views.json").write_text(json.dumps(world.snaps))
    r = subprocess.run([sys.executable, str(HERE / "hook_views.py"), "--backup", d], capture_output=True, text=True, cwd=str(HERE.parent))
    check("--backup: a folder without lynxr_post_hook.json says which file is missing", (r.returncode != 0, "lynxr_post_hook.json" in (r.stderr + r.stdout)), (True, True))
    (Path(d) / "lynxr_post_hook.json").write_text(json.dumps(world.hooks))
    r = subprocess.run([sys.executable, str(HERE / "hook_views.py"), "--backup", d], capture_output=True, text=True, cwd=str(HERE.parent))
    check("--backup: a complete folder prints the report", (r.returncode, r.stdout.startswith("hook score vs views"), "spearman rho +" in r.stdout), (0, True, True))
    check("--backup: the printed report holds no uuid, handle or url", (UUID.search(r.stdout), SENT in r.stdout), (None, False))
r = subprocess.run([sys.executable, str(HERE / "hook_views.py"), "--help"], capture_output=True, text=True, cwd=str(HERE.parent))
check("--help prints and exits 0", (r.returncode, "--report" in r.stdout and "--backup" in r.stdout), (0, True))
r = subprocess.run([sys.executable, str(HERE / "hook_views.py")], capture_output=True, text=True, cwd=str(HERE.parent))
check("no flag is an error, not a live read", r.returncode != 0, True)

# ── 12. the boundary ─────────────────────────────────────────────────────────────────────────────
src = (HERE / "hook_views.py").read_text()
STDLIB = {"argparse", "json", "math", "os", "random", "statistics", "sys", "datetime", "pathlib"}
top = [l for l in src.splitlines() if re.match(r"(import|from) ", l)]
mods = {re.match(r"(?:import|from) (\w+)", l).group(1) for l in top}
check("the module imports nothing from the repo at top level", sorted(mods - STDLIB), [])
check("the module reaches the database only inside main", "import track_posts" in src.split("def main")[0], False)
agency = (HERE / "process_campaigns.py").read_text()
check("agency isolation: process_campaigns.py does not name this module", "hook_views" in agency, False)
for f in ("brain.py", "coach.py", "brain_prompt.py", "process_adaptations.py"):
    check(f"creator surfaces never read the analysis: {f}", "hook_views" in (HERE / f).read_text(), False)

if FAILS:
    print(f"\n{len(FAILS)} FAILED: " + ", ".join(FAILS))
    sys.exit(1)
print("\nALL OK")
