"""Offline checks for pipeline/brain_prompt.py, the renderer that turns a creator's brain document into the one block in the adapt call's
user message. No network, no Supabase, no model call. Same check()/FAILS style as pipeline/test_brain.py.

Every caption, uuid and number below is invented for this test. No real creator, caption or id goes in this file: it is checked into a
public repo.

Run with

    ./venv/bin/python pipeline/test_brain_prompt.py
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import brain_prompt as BP  # noqa: E402
import process_adaptations as P  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


NOW = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)


def iso(days_ago):
    return (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


SAMPLES = ["i cannot believe this actually worked lmao", "ok but why did nobody tell me this sooner",
           "three weeks of this and i am never going back", "bro the second one broke me"]


def works(**over):
    w = {"platform": "tiktok", "measured": "views 7 days after posting", "your_median_views": 3200, "posts_counted": 34,
         "beats_your_median": [{"what": "captions with a number in them", "posts": 9, "times_median": 2.4}],
         "falls_short": [{"what": "captions that ask a question", "posts": 6, "times_median": 0.4}],
         "your_best": [{"caption": "three weeks of this and i am never going back", "times_median": 2.4}],
         "your_quietest": [{"caption": "has anyone else tried the new one yet", "times_median": 0.1}]}
    w.update(over)
    return w


def body(state="ready", age=3, **over):
    b = {"v": 1, "state": state, "built_at": iso(age),
         "about_you": {"goal": {"metric": "views on each video", "target": 10000, "now": 3200}},
         "how_you_sound": {"samples": list(SAMPLES)},
         "where_you_post": [{"platform": "tiktok", "posts": 34, "per_week": 4.2}],
         "what_works_for_you": works(), "working_on": []}
    b.update(over)
    return b


def block(b):
    return BP.creator_block(b, now=NOW)


# ── 1. nothing to say ────────────────────────────────────────────────────────────────────────────
check("{} -> empty", block({}), "")
check("None -> empty", block(None), "")
check("v 2 -> empty (a future brain never half-leaks)", block(body(v=2)), "")
check("state empty -> empty", block(body(state="empty")), "")
check("state missing -> empty", block({k: v for k, v in body().items() if k != "state"}), "")

# ── 2/3. performance only for ready ──────────────────────────────────────────────────────────────
sneaky = block(body(state="learning"))
check("learning with a hand-planted what_works_for_you: no median line", "Their own median is" in sneaky, False)
check("learning with a hand-planted what_works_for_you: no BEATS line", "BEATS their median" in sneaky, False)
check("learning with a hand-planted what_works_for_you: no FALLS SHORT line", "FALLS SHORT" in sneaky, False)
check("learning with real captions still gets a block", "Captions they wrote themselves" in sneaky, True)
ready = block(body())
check("ready: median line, with its measured qualifier",
      "Their own median is 3,200 (views 7 days after posting, 34 videos on tiktok)." in ready, True)
check("ready: a BEATS line", "BEATS their median: captions with a number in them — 2.4x over 9 videos." in ready, True)
check("ready: a FALLS SHORT line", "FALLS SHORT: captions that ask a question — 0.4x over 6 videos." in ready, True)
check("ready: best and quietest", ("Their best of those did 2.4x" in ready, "Their quietest of those did 0.1x" in ready), (True, True))
check("ready: where they post, with cadence", "Where they post: tiktok (34 videos, about 4.2 a week)." in ready, True)
check("ready: the goal line", "They are going for 10,000 views a video; they are at 3,200 now." in ready, True)
check("block starts with the head and carries the preamble",
      (ready.startswith(BP.HEAD + "\n" + BP.PREAMBLE + "\n"), "\n" not in ready[-1:]), (True, True))

# ── 4. a goal alone is not a signal ──────────────────────────────────────────────────────────────
goal_only = {"v": 1, "state": "learning", "built_at": iso(1),
             "about_you": {"goal": {"metric": "views on each video", "target": 10000, "now": 50}},
             "where_you_post": [{"platform": "tiktok", "posts": 1, "per_week": None}]}
check("goal + where_you_post only -> empty", block(goal_only), "")
check("working_on alone is not a signal either", block({**goal_only, "working_on": [{"said": "shorter hooks"}]}), "")

# ── 5. other goal metrics are dropped ────────────────────────────────────────────────────────────
deals = block(body(about_you={"goal": {"metric": "brand deals a month", "target": 5, "now": 1}}))
check("brand-deals goal: block still exists but never mentions deals or the target", ("deal" in deals.lower(), "They are going for" in deals), (False, False))

# ── 6. captions ──────────────────────────────────────────────────────────────────────────────────
tags = ["#fyp #viral", "@someone @else", "#a #b #c #d", "  #parati  "]
check("all-hashtag samples -> no captions section", "Captions they wrote themselves" in block(body(how_you_sound={"samples": tags})), False)
check("one usable sample is below MIN_SAMPLES -> still none",
      "Captions they wrote themselves" in block(body(how_you_sound={"samples": tags + [SAMPLES[0]]})), False)
two = block(body(how_you_sound={"samples": tags + SAMPLES[:2]}))
check("two usable samples -> present, and only those two",
      ("Captions they wrote themselves" in two, f'  - "{SAMPLES[0]}"' in two, f'  - "{SAMPLES[1]}"' in two, "#fyp" in two),
      (True, True, True, False))
check("usable_samples strips tags and handles, keeps the words",
      BP.usable_samples(["so this is a real one #fyp @friend", "#only #tags here", "too short"]), ["so this is a real one"])
check("usable_samples caps at the limit", len(BP.usable_samples(SAMPLES * 3)), BP.MAX_SAMPLES)
check("usable_samples drops zero-width characters", BP.usable_samples(["​" + SAMPLES[0]]), [SAMPLES[0]])
check("read_as alone is substantive", "How they write: loud and jokey." in block(body(
    state="learning", how_you_sound={"read_as": "loud and jokey", "samples": []})), True)

# ── 7. a best post whose caption is only tags says nothing ───────────────────────────────────────
tagged = block(body(what_works_for_you=works(your_best=[{"caption": "#capcut #fyp", "times_median": 2.0}],
                                             your_quietest=[{"caption": "@someone #tag", "times_median": 0.1}])))
check("best/quietest whose captions strip to nothing -> both lines dropped",
      ("Their best of those" in tagged, "Their quietest of those" in tagged), (False, False))
check("... but the median line survives", "Their own median is 3,200" in tagged, True)

# ── 8. staleness ─────────────────────────────────────────────────────────────────────────────────
check("built 40 days ago -> empty", block(body(age=40)), "")
check("built 3 days ago -> non-empty", block(body(age=3)) != "", True)
check("an unparseable built_at -> empty", block(body(built_at="not a date")), "")
check("a missing built_at -> empty", block({k: v for k, v in body().items() if k != "built_at"}), "")

# ── 9. never leaks ───────────────────────────────────────────────────────────────────────────────
leaky = block(body(about_you={"niche": "NICHE-MARKER", "your_own_words": "OWNWORDS-MARKER", "never_say": "NEVERSAY-MARKER",
                              "brands_you_write_for": ["BRANDS-MARKER"], "goal": {"metric": "views on each video"}},
                   not_known=["NOTKNOWN-MARKER"], brands_you_write_for=["BRANDS-MARKER"], niche="NICHE-MARKER",
                   your_own_words="OWNWORDS-MARKER", never_say="NEVERSAY-MARKER",
                   how_you_sound={"samples": list(SAMPLES), "read_as_key": "KEY-MARKER", "read_as_at": "AT-MARKER"}))
check("block is non-empty for the leak test", leaky != "", True)
check("none of niche / own words / never / brands / not_known / read_as_key appear",
      [m for m in ("NICHE-MARKER", "OWNWORDS-MARKER", "NEVERSAY-MARKER", "BRANDS-MARKER", "NOTKNOWN-MARKER", "KEY-MARKER", "AT-MARKER") if m in leaky], [])
check("the block never instructs a language", "language" in ready.lower() or "translate" in ready.lower() or "english" in ready.lower(), False)

# ── pluralisation ────────────────────────────────────────────────────────────────────────────────
one = block(body(where_you_post=[{"platform": "tiktok", "posts": 1, "per_week": None}]))
check("1 video, not 1 videos, and no cadence clause", "Where they post: tiktok (1 video)." in one, True)
check("per_week clause only when present", "about" in one.split("Where they post:")[1], False)
check("at most two platforms", "Where they post: tiktok (3 videos), instagram (2 videos)." in block(body(where_you_post=[
    {"platform": "tiktok", "posts": 3}, {"platform": "instagram", "posts": 2}, {"platform": "youtube", "posts": 9}])), True)
check("no target -> only the now clause", "They are at 77 now." in block(body(about_you={"goal": {"metric": "views on each video", "now": 77}})), True)
check("target only -> no now clause", "They are going for 500 views a video." in block(body(about_you={"goal": {"metric": "views on each video", "target": 500}})), True)
check("working_on 'said' rides along when there is a real signal",
      "The one thing they are working on, and it wins over everything above: shorter hooks." in block(body(working_on=[{"said": "shorter hooks"}])), True)
check("no median -> no performance section at all", "How their videos actually do" in block(body(what_works_for_you=works(your_median_views=None))), False)

# ── 10. enabled_for ──────────────────────────────────────────────────────────────────────────────
A, B_, C = "aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002", "cccccccc-0000-4000-8000-000000000003"
check("enabled_for: off values", [BP.enabled_for(v, A) for v in ("", "0", "false", "False", None)], [False] * 5)
check("enabled_for: on values", [BP.enabled_for(v, A) for v in ("1", "true", "True", "all")], [True] * 4)
lst = f"{A},{B_.upper()}"
check("enabled_for: a two-uuid list matches both, case-insensitively, and rejects a third",
      (BP.enabled_for(lst, A), BP.enabled_for(lst, B_), BP.enabled_for(lst, C)), (True, True, False))
check("enabled_for: a stray trailing newline still matches", BP.enabled_for(A + "\n", A), True)
check("enabled_for: spaces around the commas are fine", BP.enabled_for(f" {A} , {B_} ", B_), True)
check("enabled_for: an allowlist never matches an empty creator id", BP.enabled_for(A, ""), False)
check("enabled_for: never raises", BP.enabled_for(object(), A), False)

# ── 11. agency isolation ─────────────────────────────────────────────────────────────────────────
for fname in ("process_campaigns.py", "process_blueprints.py"):
    src = (HERE / fname).read_text()
    check(f"agency isolation: {fname} names none of brain_prompt / lynxr_creator_brain / BRAIN_IN_PROMPT",
          tuple(w in src for w in ("brain_prompt", "lynxr_creator_brain", "BRAIN_IN_PROMPT")), (False, False, False))

# ── 12. one assembly site, and the cached prefix stays creator-free ──────────────────────────────
pa = (HERE / "process_adaptations.py").read_text()


def fn_src(name):
    start = pa.index(f"\ndef {name}(")
    end = pa.find("\ndef ", start + 1)
    return pa[start:end if end != -1 else len(pa)]


# The fused path (FUSE_FORMAT_ADAPT, default off, deliberately untouched) has its own BRAND line, so the whole file has two. What
# matters is that fill_adaptation, the one caller that matters, builds none of it: adapt_prompt() is the only builder it uses.
check("the BRAND section is built in adapt_prompt() and in the untouched fused path, nowhere else",
      (pa.count('f"=== BRAND ===\\n'), fn_src("adapt_prompt").count('f"=== BRAND ===\\n'),
       fn_src("fused_format_and_adapt").count('f"=== BRAND ===\\n'), fn_src("fill_adaptation").count("=== BRAND ===")), (2, 1, 1, 0))
check("fill_adaptation builds its prompt through adapt_prompt()", "prompt = adapt_prompt(a, brand, creator, brain)" in fn_src("fill_adaptation"), True)
adapt_system = pa.split('ADAPT_SYSTEM = """', 1)[1].split('"""', 1)[0]
check("ADAPT_SYSTEM's text never mentions the brain block", "WHAT LYNXR KNOWS" in adapt_system, False)
check("the fused path never reads the brain", "brain" in fn_src("fused_format_and_adapt").lower(), False)

# ── 13. brain_for: the per-pass reader ───────────────────────────────────────────────────────────
class FakeSb:
    def __init__(self, rows=None, boom=False):
        self.calls, self.rows, self.boom = [], rows, boom

    def __call__(self, key, path, *a, **k):
        self.calls.append(path)
        if self.boom:
            raise OSError("down")
        return self.rows


def with_sb(fake, flag, fn):
    saved = (P.sb, P.BRAIN_IN_PROMPT, dict(P._BRAIN_CACHE))
    P.sb, P.BRAIN_IN_PROMPT = fake, flag
    P._BRAIN_CACHE.clear()
    try:
        return fn()
    finally:
        P.sb, P.BRAIN_IN_PROMPT = saved[0], saved[1]
        P._BRAIN_CACHE.clear()
        P._BRAIN_CACHE.update(saved[2])


off = FakeSb(rows=[{"body": {"v": 1}}])
check("brain_for: flag off -> None and ZERO REST calls", (with_sb(off, "0", lambda: P.brain_for("k", A)), off.calls), (None, []))
other = FakeSb(rows=[{"body": {"v": 1}}])
check("brain_for: an allowlist that does not name the creator -> None and zero REST calls",
      (with_sb(other, B_, lambda: P.brain_for("k", A)), other.calls), (None, []))
on = FakeSb(rows=[{"body": {"v": 1, "state": "ready"}}])
got = with_sb(on, A, lambda: (P.brain_for("k", A), P.brain_for("k", A)))
check("brain_for: flag on -> the body, and ONE read for two asks (the second brand of a video)",
      (got, len(on.calls)), (({"v": 1, "state": "ready"}, {"v": 1, "state": "ready"}), 1))
check("brain_for: the read is filtered to this creator", on.calls[0].startswith(f"/rest/v1/lynxr_creator_brain?creator_id=eq.{A}&"), True)
none = FakeSb(rows=[])
check("brain_for: no row -> None", with_sb(none, "1", lambda: P.brain_for("k", A)), None)
notdict = FakeSb(rows=[{"body": "text"}])
check("brain_for: a body that is not a dict -> None", with_sb(notdict, "1", lambda: P.brain_for("k", A)), None)
down = FakeSb(boom=True)
got = with_sb(down, "1", lambda: (P.brain_for("k", A), P.brain_for("k", A)))
check("brain_for: an HTTP error never raises, returns None, and is not retried within the pass", (got, len(down.calls)), ((None, None), 1))

if FAILS:
    print(f"\n{len(FAILS)} FAILED: " + ", ".join(FAILS))
    sys.exit(1)
print("all checks passed")
