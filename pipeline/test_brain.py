"""Offline checks for pipeline/brain.py, the lane that derives one document per creator from their own tracked posts. No network, no
Supabase, no model call: the voice call is driven through a fake client, and the lane through a fake `track_posts` module. Same
check()/FAILS style as pipeline/test_post_match.py.

Every caption, brand, handle, uuid and number below is invented for this test. No real creator, caption or id goes in this file: it is
checked into a public repo.

Run with

    ./venv/bin/python pipeline/test_brain.py
"""
import json
import os
import subprocess
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import brain as B  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


NOW = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)      # a Wednesday


def when(days_ago, hour=12):
    return (NOW - timedelta(days=days_ago)).replace(hour=hour)


def post(i, platform="tiktok", days_ago=20, caption="a plain caption", views=None, origin="tracked"):
    return {"id": i, "origin": origin, "platform": platform, "caption": caption,
            "posted_at": B.iso(when(days_ago)) if days_ago is not None else None, "views": views}


def day7(i, views, day=7):
    return {"post_id": i, "day": day, "views": views}


def corpus(n_tt=0, n_ig=0, start=1, views=1000):
    """n_tt TikTok and n_ig Instagram tracked posts, each with a day-7 snapshot of `views`."""
    posts, snaps, i = [], {}, start
    for platform, n in (("tiktok", n_tt), ("instagram", n_ig)):
        for k in range(n):
            posts.append(post(i, platform, days_ago=20 + k, caption=f"caption {platform} {k}"))
            snaps[i] = [day7(i, views)]
            i += 1
    return posts, snaps


def build(me=None, posts=(), snaps=None, profiles=(), followers=(), previous=None):
    return B.build(me or {}, list(posts), snaps or {}, list(profiles), list(followers), NOW, previous)


def keys_of(o, out=None):
    """Every dict key anywhere in `o`."""
    out = set() if out is None else out
    if isinstance(o, dict):
        for k, v in o.items():
            out.add(k)
            keys_of(v, out)
    elif isinstance(o, list):
        for v in o:
            keys_of(v, out)
    return out


# ── 1. views_at ──────────────────────────────────────────────────────────────────────────────────
check("views_at: a day-7 snapshot counts", B.views_at([{"day": 7, "views": 700}]), 700)
check("views_at: day 10 counts", B.views_at([{"day": 10, "views": 800}]), 800)
check("views_at: day 11 does not", B.views_at([{"day": 11, "views": 800}]), None)
check("views_at: day 5 does not", B.views_at([{"day": 5, "views": 500}]), None)
check("views_at: the earliest inside the window wins over a later one",
      B.views_at([{"day": 9, "views": 900}, {"day": 7, "views": 700}, {"day": 10, "views": 1000}]), 700)
check("views_at: a null views is skipped for the next snapshot",
      B.views_at([{"day": 7, "views": None}, {"day": 8, "views": 810}]), 810)
check("views_at: a backfilled day-23 snapshot is not a day-7 number", B.views_at([{"day": 0, "views": 5}, {"day": 23, "views": 9000}]), None)
check("views_at: nothing at all", B.views_at([]), None)

# ── 2. median_of ─────────────────────────────────────────────────────────────────────────────────
check("median_of: odd", B.median_of([5, 1, 9]), 5)
check("median_of: even is the mean of the middle two", B.median_of([1, 2, 3, 10]), 3)
check("median_of: even rounds to the nearest whole number (half up)", B.median_of([3, 4]), 4)
check("median_of: one value", B.median_of([42]), 42)

# ── 3. state ─────────────────────────────────────────────────────────────────────────────────────
body, need = build()
check("state: no posts and no onboarding -> empty", body["state"], "empty")
check("state: empty has no about_you, voice, or where_you_post",
      [k for k in ("about_you", "how_you_sound", "where_you_post", "what_works_for_you") if k in body], [])
check("state: empty still says what it does not know", len(body["not_known"]), 2)
check("state: working_on is always empty in v1", body["working_on"], [])
check("state: no voice call wanted for nobody", need, None)

body, _ = build(me={"priority": "perform", "goal": {"metric": "perform", "target": 10000}})
check("state: no posts but a goal -> learning", body["state"], "learning")
check("state: ... with about_you", body["about_you"]["goal"], {"metric": "views on each video", "target": 10000})

posts, snaps = corpus(n_tt=4)
body, _ = build(posts=posts, snaps=snaps)
check("state: 4 comparable posts -> learning", body["state"], "learning")
check("state: ... and what_works_for_you is ABSENT, not empty", "what_works_for_you" in body, False)
check("state: ... and not_known carries both sentences", body["not_known"], [B.NOT_KNOWN_VIDEOS, B.NOT_KNOWN_WORKS])
posts, snaps = corpus(n_tt=5)
body, _ = build(posts=posts, snaps=snaps)
check("state: 5 comparable posts -> ready", body["state"], "ready")
check("state: ready drops the second not_known sentence", body["not_known"], [B.NOT_KNOWN_VIDEOS])
check("state: top-level key order", list(body), ["v", "state", "built_at", "how_you_sound", "where_you_post", "what_works_for_you",
                                                  "not_known", "working_on"])
check("state: built_at is the clock it was handed", body["built_at"], "2026-10-07T12:00:00Z")
check("state: what_you_post is not built", "what_you_post" in keys_of(body), False)

# ── 4. cross-platform gate ───────────────────────────────────────────────────────────────────────
posts, snaps = corpus(n_tt=4, n_ig=4)
body, _ = build(posts=posts, snaps=snaps)
check("gate: 4 TikTok + 4 Instagram -> learning, no median", (body["state"], "what_works_for_you" in body), ("learning", False))
posts, snaps = corpus(n_tt=5, n_ig=4, views=1000)
for p in posts:
    if p["platform"] == "instagram":
        snaps[p["id"]] = [day7(p["id"], 9)]                        # a tiny Instagram account next to a big TikTok one
body, _ = build(posts=posts, snaps=snaps)
w = body["what_works_for_you"]
check("gate: 5 TikTok + 4 Instagram -> ready on tiktok", (body["state"], w["platform"]), ("ready", "tiktok"))
check("gate: ... counting only the 5 TikTok posts", (w["posts_counted"], w["your_median_views"]), (5, 1000))
check("gate: ... and both platforms still show in where_you_post", [x["platform"] for x in body["where_you_post"]], ["tiktok", "instagram"])
check("gate: where_you_post counts add up to the tracked posts", sum(x["posts"] for x in body["where_you_post"]), len(posts))

posts, snaps = corpus(n_tt=5, views=1000)
posts.append(post(99, "tiktok", days_ago=6))                       # too young to have a day-7 count
posts.append(post(98, "tiktok", days_ago=40, origin="pasted"))      # not a tracked post
posts.append(post(97, "tiktok", days_ago=400))                     # older than the window
snaps[98], snaps[97] = [day7(98, 5000)], [day7(97, 5000)]
body, _ = build(posts=posts, snaps=snaps)
check("comparable: young, pasted and out-of-window posts are not counted", body["what_works_for_you"]["posts_counted"], 5)
check("comparable: a post with no origin is not assumed tracked",
      B.comparable([{"id": 1, "platform": "tiktok", "posted_at": B.iso(when(20))}], {1: [day7(1, 10)]}, NOW), [])

# ── 5. grouped ───────────────────────────────────────────────────────────────────────────────────
MON = when(3)           # 2026-10-04 is a Sunday, so use a weekday: 2026-10-05 is Monday


def r(views, caption, dt=None):
    return {"post_id": 0, "platform": "tiktok", "caption": caption, "posted_at": dt or datetime(2026, 9, 28, 12, tzinfo=timezone.utc),
            "views": views}


def split(n_in, v_in, n_out, v_out):
    rows = [r(v_in, "top 5 tips and a long enough caption to avoid the short group ...........................") for _ in range(n_in)]
    rows += [r(v_out, "a long enough caption to avoid the short group, with no digits in it at all, honestly") for _ in range(n_out)]
    return rows


def group_lines(rows):
    med = B.median_of([x["views"] for x in rows])
    beats, short = B.grouped(rows, med)
    return beats, short


NUM = "captions with a number in them"
beats, short = group_lines(split(3, 2000, 6, 1000))
check("grouped: a group of 3 is never emitted", ([b["what"] for b in beats], [s["what"] for s in short]), ([], []))
beats, short = group_lines(split(4, 2000, 5, 1000))
check("grouped: 4 in / 5 out at ratio 2.0 -> beats_your_median", [(b["what"], b["posts"], b["times_median"]) for b in beats], [(NUM, 4, 2.0)])
beats, short = group_lines(split(4, 1200, 5, 1000))
check("grouped: the same split at ratio 1.2 is emitted nowhere", ([b["what"] for b in beats], [s["what"] for s in short]), ([], []))
beats, short = group_lines(split(4, 400, 5, 1000))
check("grouped: ratio 0.4 -> falls_short", [(s["what"], s["times_median"]) for s in short], [(NUM, 0.4)])
check("grouped: a group needs 4 OUTSIDE it as well", group_lines(split(5, 2000, 3, 1000)), ([], []))
check("grouped: the weekend group says what it measured",
      [b["what"] for b in group_lines([r(3000, "a" * 70, datetime(2026, 10, 3, 12, tzinfo=timezone.utc)) for _ in range(4)]
                                      + [r(1000, "b" * 70) for _ in range(5)])[0]], ["videos you posted at the weekend"])
check("grouped: every label says what was measured, none claims to describe the video",
      [lab for lab, _ in B.GROUPS],
      ["captions with a number in them", "captions that ask a question", "captions under 60 characters",
       "videos you posted at the weekend"])
check("grouped: a median of zero says nothing", B.grouped(split(4, 0, 5, 0), 0), ([], []))

rows = [r(10000, "big one"), r(5000, "second"), r(4000, "third"), r(1000, "mid"), r(900, "mid2"), r(100, "tiny", )]
best, quiet = B.standouts(rows, 1000)
check("standouts: the two best, highest first", [(b["caption"], b["views"], b["times_median"]) for b in best],
      [("big one", 10000, 10.0), ("second", 5000, 5.0)])
check("standouts: the one quietest", [(q["caption"], q["views"], q["times_median"], q["posted"]) for q in quiet],
      [("tiny", 100, 0.1, "2026-09-28")])
check("standouts: a post near the median is neither", B.standouts([r(1000, "x"), r(1100, "y")], 1000), ([], []))
check("standouts: an empty caption still yields an item", B.standouts([r(5000, "")], 1000)[0][0]["caption"], "")
check("standouts: a caption is cut to 160", len(B.standouts([r(5000, "z" * 500)], 1000)[0][0]["caption"]), 160)

# ── 6. samples_of ────────────────────────────────────────────────────────────────────────────────
ps = [post(1, days_ago=30, caption="oldest one"), post(2, days_ago=3, caption="  newest one  "), post(3, days_ago=5, caption=""),
      post(4, days_ago=6, caption="   "), post(5, days_ago=9, caption="oldest one"), post(6, days_ago=2, caption="x" * 500),
      post(7, days_ago=1, caption="from a pasted row", origin="pasted"), post(8, days_ago=None, caption="no date")]
check("samples_of: newest first, stripped, empties and duplicates and pasted rows dropped, no-date last",
      [s[:12] for s in B.samples_of(ps)], ["x" * 12, "newest one", "oldest one", "no date"])
check("samples_of: trimmed to BRAIN_SAMPLE_CHARS", len(B.samples_of(ps)[0]), B.BRAIN_SAMPLE_CHARS)
many = [post(i, days_ago=i, caption=f"c{i}") for i in range(1, 30)]
check("samples_of: capped at BRAIN_SAMPLES", len(B.samples_of(many)), B.BRAIN_SAMPLES)
check("samples_of: across both platforms",
      sorted(B.samples_of([post(1, "tiktok", 2, "tt"), post(2, "instagram", 3, "ig")])), ["ig", "tt"])

# ── 7 & 8. the voice gate and the cache ──────────────────────────────────────────────────────────
five = [post(i, days_ago=i, caption=f"caption number {i}") for i in range(1, 6)]
four = five[:4]
body, need = build(posts=four)
check("voice gate: 4 captions -> no call wanted", need, None)
check("voice gate: ... and no read_as in the body", "read_as" in body["how_you_sound"], False)
body, need = build(posts=five)
samples = B.samples_of(five)
check("voice gate: 5 captions, no previous -> the call is wanted for those samples", need, samples)
check("voice gate: ... and the body carries no line yet", "read_as" in body["how_you_sound"], False)

KEY = B.voice_key(samples)


def prev(read_at_days, key=KEY, line="short and blunt, no emoji"):
    return {"how_you_sound": {"from": "your captions", "samples": ["old"], "read_as": line,
                              "read_as_at": B.iso(NOW - timedelta(days=read_at_days)), "read_as_key": key}}


body, need = build(posts=five, previous=prev(30))
check("voice cache: the same fingerprint, however old -> carried, no call",
      (need, body["how_you_sound"]["read_as"], body["how_you_sound"]["read_as_key"]), (None, "short and blunt, no emoji", KEY))
body, need = build(posts=five, previous=prev(2, key="stale"))
check("voice cache: a changed fingerprint 2 days old -> carried verbatim, no call",
      (need, body["how_you_sound"]["read_as"], body["how_you_sound"]["read_as_key"]), (None, "short and blunt, no emoji", "stale"))
body, need = build(posts=five, previous=prev(8, key="stale"))
check("voice cache: a changed fingerprint 8 days old -> the call is wanted ...", need, samples)
check("voice cache: ... and the old line stays in the body until it is replaced", body["how_you_sound"]["read_as"], "short and blunt, no emoji")
body, need = build(posts=four, previous=prev(1))
check("voice cache: a creator who lost captions below 5 loses the line", ("read_as" in body["how_you_sound"], need), (False, None))
check("voice cache: a line with no previous timestamp is treated as old",
      build(posts=five, previous={"how_you_sound": {"read_as": "x", "read_as_key": "stale"}})[1], samples)

# ── 9. the voice call, through a fake client ─────────────────────────────────────────────────────


class FakeClient:
    def __init__(self, answer="Short, blunt, no emoji.", boom=None):
        self.calls, self.answer, self.boom = [], answer, boom
        self.messages = self

    def create(self, **kw):
        self.calls.append(kw)
        if self.boom:
            raise self.boom
        return SimpleNamespace(content=[SimpleNamespace(type="thinking", thinking="..."), SimpleNamespace(type="text", text=self.answer)],
                               usage=SimpleNamespace(input_tokens=700, output_tokens=12))


def with_voice(on, fn):
    saved = B.BRAIN_VOICE
    B.BRAIN_VOICE = on
    try:
        return fn()
    finally:
        B.BRAIN_VOICE = saved


base, need = build(posts=five, previous=prev(8, key="stale"))
plain = json.dumps(base, sort_keys=False)
broken = FakeClient(boom=RuntimeError("the caption text here must never be logged"))
got = json.loads(plain)
ok = with_voice(True, lambda: B.apply_voice(got, need, lambda: broken, now=NOW))
check("voice failure: apply_voice says it failed", ok, False)
check("voice failure: the previous read_as is untouched and the rest of the body is byte-identical", json.dumps(got), plain)
check("voice failure: the model WAS asked (it failed, it was not skipped)", len(broken.calls), 1)

fine = FakeClient()
got = json.loads(plain)
usage = {}
ok = with_voice(True, lambda: B.apply_voice(got, need, lambda: fine, usage_out=usage, now=NOW))
hs = got["how_you_sound"]
check("voice call: success sets all three fields", (ok, hs["read_as"], hs["read_as_at"], hs["read_as_key"]),
      (True, "Short, blunt, no emoji", "2026-10-07T12:00:00Z", KEY))
check("voice call: the stored line keeps the model's casing (house style lives in CSS)", hs["read_as"][0], "S")
kw = fine.calls[0]
check("voice call: Haiku, 100 tokens, a plain-string system prompt, no effort, no thinking",
      (kw["model"], kw["max_tokens"], kw["system"] == B.VOICE_SYSTEM, "output_config" in kw, "thinking" in kw),
      ("claude-haiku-4-5", 100, True, False, False))
check("voice call: the user message is the numbered captions",
      kw["messages"][0]["content"].startswith("Here are up to 8 of one creator's own captions, newest first.\n\n1. \""), True)
check("voice call: the spend is measured", usage, {"claude-haiku-4-5": {"in": 700, "out": 12, "write": 0, "read": 0, "calls": 1}})
check("voice call: the fake spend prices at Haiku rates", round(B.P.cost_of("claude-haiku-4-5", usage["claude-haiku-4-5"]), 6), 0.00076)
nothing = FakeClient(answer="not enough to tell")
got = json.loads(plain)
check("voice call: 'not enough to tell' keeps the previous line",
      (with_voice(True, lambda: B.apply_voice(got, need, lambda: nothing, now=NOW)), json.dumps(got)), (False, plain))
check("voice call: no client (no key) leaves the body alone",
      (with_voice(True, lambda: B.apply_voice(json.loads(plain), need, lambda: None, now=NOW)),), (False,))

# THE GATE THAT MATTERS: while BRAIN_VOICE is off nothing reaches the model.
off = FakeClient()
got = json.loads(plain)
check("flag off: apply_voice does nothing", (with_voice(False, lambda: B.apply_voice(got, need, lambda: off, now=NOW)), json.dumps(got)), (False, plain))
check("flag off: voice_line itself refuses", with_voice(False, lambda: B.voice_line(off, samples)), None)
check("flag off: the model was never called", len(off.calls), 0)
fresh = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, %r); import brain; print(brain.BRAIN_VOICE)" % str(Path(__file__).resolve().parent)],
                       env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}, capture_output=True, text=True, cwd="/")
check("flag off: BRAIN_VOICE is off in a clean environment", fresh.stdout.strip().splitlines()[-1:], ["False"])

# ── 10. clean_voice ──────────────────────────────────────────────────────────────────────────────
check("clean_voice: 'not enough to tell' -> None", B.clean_voice("not enough to tell"), None)
check("clean_voice: 'Not enough to tell.' -> None", B.clean_voice("Not enough to tell."), None)
check("clean_voice: a quoted answer is unquoted", B.clean_voice('"short, blunt, no emoji"'), "short, blunt, no emoji")
check("clean_voice: curly quotes too", B.clean_voice("“long and chatty”"), "long and chatty")
check("clean_voice: whitespace collapses and one trailing full stop goes", B.clean_voice("  short,\n blunt   and dry. "), "short, blunt and dry")
long200 = ("word " * 40).strip()[:200]
cut = B.clean_voice(long200)
check("clean_voice: a 200-char answer is cut at a space to at most 90", (len(cut) <= 90, cut.endswith(" "), long200.startswith(cut)), (True, False, True))
check("clean_voice: an empty answer -> None", B.clean_voice("   "), None)
check("clean_voice: None -> None", B.clean_voice(None), None)
check("clean_voice: an answer longer than 200 raw characters is discarded", B.clean_voice("x " * 101), None)
check("clean_voice: a short answer is untouched", B.clean_voice("blunt"), "blunt")

# ── 11. the body never carries what the posts table does not hold ────────────────────────────────
posts, snaps = corpus(n_tt=6, n_ig=2)
body, _ = build(me={"niches": ["a", "b"], "brands": [{"name": "Acme"}], "about": "mine", "never": "x", "priority": "grow"},
                posts=posts, snaps=snaps, profiles=[{"platform": "tiktok", "handle": "someone"}],
                followers=[{"platform": "tiktok", "handle": "someone", "day": "2026-10-06", "followers": 1500}])
bad = sorted(k for k in keys_of(body) if "transcript" in k.lower() or "adaptation" in k.lower())
check("body: no transcript key and no adaptation key anywhere", bad, [])

# ── 12. agency isolation ─────────────────────────────────────────────────────────────────────────
agency = (Path(__file__).resolve().parent / "process_campaigns.py").read_text()
check("agency isolation: process_campaigns.py neither imports the brain nor names its table",
      ("import brain" in agency, "lynxr_creator_brain" in agency), (False, False))

# ── goal_now, about_you, where_you_post ──────────────────────────────────────────────────────────
gp = [post(i, days_ago=10 + i) for i in range(1, 8)]
gs = {i: [{"post_id": i, "day": 7, "views": i * 100}] for i in range(1, 8)}
gs[1] = [{"post_id": 1, "day": 23, "views": 9000}]                                   # backfilled: day-7 number does not exist, but day >= 7 counts here
check("goal_now perform: mean of the latest 5 with a day>=7 count, NO upper bound (as creator.js does)",
      B.goal_now("perform", gp, gs, [], {}, NOW), (9000 + 200 + 300 + 400 + 500) // 5)
check("goal_now perform: no day-7 count anywhere -> None",
      B.goal_now("perform", [post(1)], {1: [{"post_id": 1, "day": 1, "views": 50}]}, [], {}, NOW), None)
check("goal_now perform and views_at deliberately disagree on a backfilled post", B.views_at(gs[1]), None)
check("goal_now grow: the most recent count per profile, summed",
      B.goal_now("grow", [], {}, [{"platform": "tiktok", "handle": "a", "day": "2026-10-01", "followers": 10},
                                  {"platform": "tiktok", "handle": "a", "day": "2026-10-06", "followers": 15},
                                  {"platform": "instagram", "handle": "b", "day": "2026-10-05", "followers": 7}], {}, NOW), 22)
check("goal_now grow: nothing -> None", B.goal_now("grow", [], {}, [], {}, NOW), None)
check("goal_now deals: only this UTC calendar month",
      B.goal_now("deals", [], {}, [], {"deals": [{"at": "2026-10-02T09:00:00Z"}, {"at": "2026-09-30T23:59:00Z"}, {"at": "2026-10-06T00:00:00Z"}]}, NOW), 2)
check("goal_now deals: none logged is a real 0", B.goal_now("deals", [], {}, [], {"deals": []}, NOW), 0)
check("goal_now rate: the creator's own number", B.goal_now("rate", [], {}, [], {"rate": {"usd": 250}}, NOW), 250)
check("goal_now rate: unset -> None", B.goal_now("rate", [], {}, [], {"rate": None}, NOW), None)
check("goal_now: an unknown metric -> None", B.goal_now("engagement", [], {}, [], {}, NOW), None)

check("about_you: nothing -> None", B.about_you({}, None), None)
check("about_you: blank strings are nothing", B.about_you({"niches": ["  "], "about": "   ", "never": ""}, None), None)
a = B.about_you({"niches": ["med school", "study tips", "gadgets", "cooking"], "brands": [{"name": "Acme"}, {"name": "Acme"}, {"name": ""}, {"name": "Zed"}],
                 "about": " " + "w" * 500, "never": "swear", "priority": "perform", "goal": {"metric": "perform", "target": 10000}}, 3200)
check("about_you: niche is the first three", a["niche"], "med school, study tips, gadgets")
check("about_you: brands deduped, blanks dropped", a["brands_you_write_for"], ["Acme", "Zed"])
check("about_you: goal with its target and now", a["goal"], {"metric": "views on each video", "target": 10000, "now": 3200})
check("about_you: free text cut to 400", (len(a["your_own_words"]), a["never_say"]), (400, "swear"))
check("about_you: key order", list(a), ["niche", "goal", "brands_you_write_for", "your_own_words", "never_say"])
check("about_you: no creators_you_named, ever", "creators_you_named" in a, False)
check("about_you: priority wins over the goal's own metric, and a target for another metric is not borrowed",
      B.about_you({"priority": "rate", "goal": {"metric": "perform", "target": 9}}, None)["goal"], {"metric": "dollars a video"})
check("about_you: an older build's metric is mapped", B.about_you({"goal": {"metric": "followers", "target": 1000}}, None)["goal"],
      {"metric": "followers", "target": 1000})
check("about_you: more than 8 brands are cut to 8", len(B.about_you({"brands": [{"name": f"b{i}"} for i in range(12)]}, None)["brands_you_write_for"]), 8)

w = B.where_you_post([post(i, days_ago=i * 6, platform="tiktok") for i in range(1, 6)] + [post(9, "instagram", 5)], NOW)
check("where_you_post: most posts first, with first/last dates", [(x["platform"], x["posts"], x["first_at"], x["last_at"]) for x in w],
      [("tiktok", 5, "2026-09-07", "2026-10-01"), ("instagram", 1, "2026-10-02", "2026-10-02")])
check("where_you_post: per_week only with a 14-day span and 4 posts", [x["per_week"] for x in w], [round(5 / (24 / 7), 1), None])
check("where_you_post: 4 posts in 10 days is too short a span to call a cadence",
      B.where_you_post([post(i, days_ago=i * 3) for i in range(1, 5)], NOW)[0]["per_week"], None)
check("where_you_post: a post with no date or outside the window is not counted",
      B.where_you_post([post(1, days_ago=None), post(2, days_ago=400)], NOW), [])

# lead_platform
check("lead_platform: most comparable posts wins", B.lead_platform([{"platform": "instagram", "views": 1}] * 3 + [{"platform": "tiktok", "views": 1}] * 2), "instagram")
check("lead_platform: a tie goes to the larger total views",
      B.lead_platform([{"platform": "instagram", "views": 1}, {"platform": "tiktok", "views": 5}]), "tiktok")
check("lead_platform: a full tie goes alphabetically",
      B.lead_platform([{"platform": "tiktok", "views": 5}, {"platform": "instagram", "views": 5}]), "instagram")
check("lead_platform: nothing -> None", B.lead_platform([]), None)

# why_table: every excluded post carries a reason
wp = [post(1, days_ago=20), post(2, days_ago=3), post(3, days_ago=40), post(4, days_ago=400)]
ws = {1: [day7(1, 7600, 7)], 2: [{"post_id": 2, "day": 0, "views": 5}, {"post_id": 2, "day": 1, "views": 6}],
      3: [{"post_id": 3, "day": 23, "views": 900}], 4: []}
lines = B.why_table(wp, ws, NOW)
check("why: a counted post says yes with its day-7 views", any("7,600" in x and x.rstrip().endswith("yes") for x in lines), True)
check("why: a young post says no snapshot at day 7-10 yet", any("no: no snapshot at day 7-10 yet" in x for x in lines), True)
check("why: a backfilled post says so", any("first snapshot at day 23 (backfilled)" in x for x in lines), True)
check("why: an old post says it is out of the window", any("older than 180 days" in x for x in lines), True)
check("why: the summary line", lines[-1], "comparable: 1 on tiktok → lead tiktok, state learning")

# ── the lane, through a fake track_posts ─────────────────────────────────────────────────────────
C1, C2 = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"


class FakeT:
    """Just enough of track_posts for brain_pass. Records every call so a test can say what was and was not written."""

    def __init__(self, creators=(C1, C2), brains=(), brain_status=200, posts_status=200, queued=False):
        self.calls, self.creators, self.brains = [], list(creators), list(brains)
        self.brain_status, self.posts_status = brain_status, posts_status
        self.P = SimpleNamespace(queued_work=lambda key: queued)
        self.q = lambda v: urllib.parse.quote(str(v), safe="")

    def by_tier(self, items, key, cache, creator=lambda r: r.get("creator_id")):
        return items

    def rest(self, key, path, method="GET", body=None, prefer=None):
        self.calls.append((method, path, body))
        if method == "POST":
            return 201, None
        if path.startswith("/rest/v1/lynxr_creators?select=id"):
            return 200, [{"id": c} for c in self.creators]
        if path.startswith("/rest/v1/lynxr_creator_brain?select=creator_id"):
            return self.brain_status, (self.brains if self.brain_status == 200 else None)
        if path.startswith("/rest/v1/lynxr_creator_brain?creator_id"):
            return 200, []
        if path.startswith("/rest/v1/lynxr_creators?id=eq."):
            return 200, [{"data": {"niches": ["demo"]}}]
        if path.startswith("/rest/v1/lynxr_posts?"):
            if self.posts_status != 200:
                return self.posts_status, None
            return 200, [post(i, days_ago=20 + i, caption=f"invented caption {i}") for i in range(1, 7)]
        if path.startswith("/rest/v1/lynxr_post_views?"):
            return 200, [day7(i, 1000 + i) for i in range(1, 7)]
        return 200, []

    def writes(self):
        return [(m, p) for m, p, _ in self.calls if m != "GET"]


class Boom(Exception):
    pass


def lane(t, voice=False, dry=False, client=None):
    """brain_pass with .env hidden, the client factory replaced and the cost write captured."""
    saved = (B.P.load_env, B.P.anthropic_client, B.P.record_cost, B.BRAIN_VOICE, B.os.environ.get("ANTHROPIC_API_KEY"))
    costs, made = [], []
    B.P.load_env = lambda path: {}
    B.P.anthropic_client = lambda api_key, base_url=None: (made.append(1), client)[1]
    B.P.record_cost = lambda key, id8, ok, u: costs.append((id8, ok, u))
    B.BRAIN_VOICE = voice
    B.os.environ["ANTHROPIC_API_KEY"] = "invented-test-key"
    try:
        out = B.brain_pass("svc-key", NOW, dry=dry, T=t)
    finally:
        B.P.load_env, B.P.anthropic_client, B.P.record_cost, B.BRAIN_VOICE = saved[:4]
        if saved[4] is None:
            B.os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            B.os.environ["ANTHROPIC_API_KEY"] = saved[4]
    return out, costs, made


t = FakeT()
out, costs, made = lane(t, dry=True)
check("lane dry: counts the due creators", out, {"brain_due": 2, "built": 0, "voiced": 0, "voice_failed": 0, "brain_failed": 0})
check("lane dry: reads no creator's data and writes nothing", [p for _, p, _ in t.calls if "creator_id=eq" in p or "id=eq" in p] + t.writes(), [])
check("lane dry: no client was built", made, [])

t = FakeT(brain_status=404)
check("lane: a missing table is one log line and {} (not an error)", lane(t)[0], {})
check("lane: ... and nothing was written", t.writes(), [])
check("lane: off or no module -> {}", (B.brain_pass("k", NOW, T=None), ), ({},))

t = FakeT()
out, costs, made = lane(t, voice=False)
check("lane, voice OFF: both creators built", (out["brain_due"], out["built"], out["voiced"], out["voice_failed"], out["brain_failed"]), (2, 2, 0, 0, 0))
check("lane, voice OFF: no Anthropic client was even built", made, [])
check("lane, voice OFF: no cost row", costs, [])
check("lane: the ONLY writes are upserts into lynxr_creator_brain",
      sorted(set((m, p.split("?")[0]) for m, p in t.writes())), [("POST", "/rest/v1/lynxr_creator_brain")])
stored = [b for m, p, b in t.calls if m == "POST"]
check("lane: the stored body has captions but no voice line while the flag is off",
      ("read_as" in stored[0]["body"]["how_you_sound"], len(stored[0]["body"]["how_you_sound"]["samples"])), (False, 6))
check("lane: the row carries the creator id and a built_at", (stored[0]["creator_id"], stored[0]["built_at"]), (C1, "2026-10-07T12:00:00Z"))

t = FakeT()
fc = FakeClient(answer="short, plain, no emoji")
out, costs, made = lane(t, voice=True, client=fc)
check("lane, voice ON: one client built once for two creators, two calls", (len(made), len(fc.calls), out["voiced"], out["voice_failed"]), (1, 2, 2, 0))
check("lane, voice ON: the spend is recorded per call as 'brain'", [(c[0], c[1]) for c in costs], [("brain", True), ("brain", True)])
check("lane, voice ON: the line is stored", [b["body"]["how_you_sound"]["read_as"] for _, _, b in [c for c in t.calls if c[0] == "POST"]],
      ["short, plain, no emoji"] * 2)

t = FakeT()
out, costs, made = lane(t, voice=True, client=FakeClient(boom=Boom("x")))
check("lane, voice failing: the document is still written, the failure counted",
      (out["built"], out["voiced"], out["voice_failed"], out["brain_failed"]), (2, 0, 2, 0))

t = FakeT(posts_status=500)
out, _, _ = lane(t)
check("lane: a creator whose posts could not be read is skipped, never overwritten with a thinner brain",
      (out["built"], out["brain_failed"], t.writes()), (0, 2, []))

t = FakeT(queued=True)
out, _, _ = lane(t)
check("lane: a queued script ends the pass before any creator is read", (out["built"], t.writes()), (0, []))

t = FakeT(brains=[{"creator_id": C1, "built_at": "2026-10-07T11:00:00Z"}, {"creator_id": C2, "built_at": "2026-10-05T11:00:00Z"}])
out, _, _ = lane(t)
check("lane: a brain built an hour ago is not due; one built two days ago is", (out["brain_due"], out["built"]), (1, 1))
check("lane: ... and only that creator was rebuilt", [b["creator_id"] for m, p, b in t.calls if m == "POST"], [C2])

if FAILS:
    print(f"\n{len(FAILS)} FAILED: " + ", ".join(FAILS))
    sys.exit(1)
print("all checks passed")
