"""Offline checks for pipeline/post_shape.py, the lane that measures when things are said in a creator's own posted videos. No network, no
Supabase, no download, no Whisper: every I/O helper is replaced. Same check()/FAILS style as pipeline/test_insights.py.

Every caption, word, handle, uuid, script and number below is invented for this test. No real creator, caption or id goes in this file: it
is checked into a public repo.

Run with

    ./venv/bin/python pipeline/test_post_shape.py
"""
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import post_shape as S  # noqa: E402
import track_posts as TP  # noqa: E402  (only for its pure helpers, which the lane borrows from the running module at run time)

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


NOW = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)
C1 = "00000000-0000-4000-8000-000000000001"
KEY = "service-role-key-invented"

# An invented transcript, in the shape transcribe.transcribe() returns. Every distinctive word is made up, so a leak is unmistakable.
SEGS = [[0.4, 2.0, "okay so zorblax finally arrived and quimby loved it"],
        [2.4, 5.0, "the frumble tastes like a wobbly sunrise honestly"],
        [9.0, 12.5, "so buy the zorblax before quimby runs out"]]
T_OK = {"text": " ".join(s[2] for s in SEGS), "hook_spoken": SEGS[0][2] + " " + SEGS[1][2], "has_speech": True, "segments": SEGS}
WORDS = ["zorblax", "quimby", "frumble", "wobbly", "sunrise"]

SCRIPT = {"id": "ad-1", "status": "done", "brandId": "b1", "adaptation": {
    "delivery": "spoken", "hook": "okay so zorblax arrived", "cta": "buy the zorblax before quimby runs out",
    "beats": [{"t": "0-3s", "say": "okay so zorblax finally arrived and quimby loved it", "do": "x", "show": ""},
              {"t": "3-8s", "say": "the frumble tastes like a wobbly sunrise honestly", "do": "x", "show": ""},
              {"t": "8-10s", "say": "plorp", "do": "x", "show": ""},
              {"t": "10-14s", "say": "a whole paragraph about snazzleberry jam nobody ever says", "do": "x", "show": ""}]}}

# ── 1. features ──────────────────────────────────────────────────────────────────────────────────
f = S.features(T_OK, 14.0)
check("features: the four numbers and the silence's second",
      (f["speech_start_s"], f["words_first_3s"], f["longest_silence_s"], f["longest_silence_at_s"], f["duration_s"]), (0.4, 17, 4.0, 5.0, 14.0))
check("features: no script, no beats and no aligned_to", ("beats" in f, "aligned_to" in f), (False, False))
check("features: every key a speech video carries", sorted(f), ["duration_s", "has_speech", "longest_silence_at_s", "longest_silence_s", "segments",
                                                                  "speech_start_s", "words_first_3s"])

f = S.features({"text": "", "hook_spoken": "", "has_speech": False, "segments": []}, 14.0)
check("features: no speech -> exactly has_speech, segments, duration_s", f, {"has_speech": False, "segments": 0, "duration_s": 14.0})
check("features: ... and there is no speech_start_s of zero anywhere", "speech_start_s" in f, False)
f = S.features({"has_speech": True, "segments": [], "hook_spoken": ""}, 9.0)
check("features: has_speech with no segments is treated the same way", sorted(f), ["duration_s", "has_speech", "segments"])

f = S.features({"has_speech": True, "hook_spoken": "just one line here", "segments": [[0.0, 3.0, "just one line here"]]}, 3.0)
check("features: one segment -> speech_start_s present, longest_silence_* absent",
      (f["speech_start_s"], "longest_silence_s" in f, "longest_silence_at_s" in f), (0.0, False, False))
check("features: a speech start of exactly 0 is kept (the creator spoke at once)", f["speech_start_s"], 0.0)

f = S.features(T_OK, None)
check("features: duration None -> duration_s ABSENT, not null", "duration_s" in f, False)
check("features: duration 0 and False are absent too", ("duration_s" in S.features(T_OK, 0), "duration_s" in S.features(T_OK, False)), (False, False))
check("features: junk in, no crash", S.features(None, 5.0), {"has_speech": False, "segments": 0, "duration_s": 5.0})
check("features: a malformed segment is skipped", S.features({"has_speech": True, "hook_spoken": "a b c",
      "segments": [["x", 1, "no"], [1.0, 2.0, "a b c"]]}, 2.0)["speech_start_s"], 1.0)

blob = json.dumps(S.features(T_OK, 14.0, SCRIPT))
check("NO WORDS LEAK: the serialised result contains none of the invented transcript or script words",
      [w for w in WORDS + ["snazzleberry", "plorp", "okay", "buy"] if w in blob.lower()], [])

# ── 2. script units and alignment ────────────────────────────────────────────────────────────────
check("planned_start: '3-8s' -> 3.0, junk -> None", (S.planned_start("3-8s"), S.planned_start("0-3s"), S.planned_start("soon"), S.planned_start(None)),
      (3.0, 0.0, None, None))
units = S.script_units(SCRIPT)
check("script_units: four beats and the call to action", [(u["kind"], u["i"]) for u in units], [("beat", 1), ("beat", 2), ("beat", 3), ("beat", 4), ("cta", None)])
check("script_units: a silent script has nothing to line up", S.script_units({"adaptation": {"delivery": "silent", "beats": [{"say": "a b c d"}]}}), [])
check("script_units: no adaptation, no units", (S.script_units(None), S.script_units({}), S.script_units({"adaptation": None})), ([], [], []))

b = S.align([s for s in SEGS], units)
by = {(r.get("i"), r["kind"]): r for r in b}
check("align: beat 1 is found where it was said", (by[(1, "beat")]["start_s"], by[(1, "beat")]["end_s"], by[(1, "beat")]["planned_s"]), (0.4, 2.0, 0.0))
check("align: beat 2 is found, with the planned second from the script", (by[(2, "beat")]["start_s"], by[(2, "beat")]["planned_s"]), (2.4, 3.0))
check("align: a one-word beat is skipped (nothing to locate it by), not reported missing", (3, "beat") in by, False)
check("align: a beat the audio does not contain is reported as not found, with no times", by[(4, "beat")], {"i": 4, "of": 4, "kind": "beat", "found": False})
check("align: the call to action is located and carries no beat index", (by[(None, "cta")]["start_s"], "i" in by[(None, "cta")]), (9.0, False))
check("align: every found unit's numbers are plain numbers and index fields",
      sorted({k for r in b for k in r}), ["end_s", "found", "i", "kind", "of", "planned_s", "start_s"])

# Time order: a beat said only BEFORE the one that precedes it is "not found", never given a wrong time.
swapped = [[0.5, 3.0, "the frumble tastes like a wobbly sunrise honestly"], [4.0, 7.0, "okay so zorblax finally arrived and quimby loved it"]]
r = {x.get("i"): x for x in S.align(swapped, S.script_units(SCRIPT)[:2])}
check("align: a reordered script finds the first line late and loses the second (time order, safe direction)",
      (r[1]["start_s"], r[2].get("found")), (4.0, False))

# The EARLIEST window wins: a line restated later must not move the beat.
restate = [[1.0, 3.0, "okay so zorblax finally arrived and quimby loved it"], [20.0, 23.0, "okay so zorblax finally arrived and quimby loved it"]]
r = S.align(restate, S.script_units(SCRIPT)[:1])
check("align: a line said twice is located at its first saying", r[0]["start_s"], 1.0)
check("align: a window must start on a segment that carries a word of the beat",
      S.align([[0.0, 1.0, "mumble mumble mumble"], [5.0, 8.0, "okay so zorblax finally arrived and quimby loved it"]], S.script_units(SCRIPT)[:1])[0]["start_s"], 5.0)
check("align: under half the beat's words heard -> not found",
      S.align([[0.0, 2.0, "zorblax arrived"]], S.script_units(SCRIPT)[:1])[0].get("found"), False)
check("align: no transcript segments, every long unit is not found", [x.get("found") for x in S.align([], units)], [False, False, False, False])

f = S.features(T_OK, 14.0, SCRIPT)
check("features with a script: aligned_to names it and beats is a list", (f["aligned_to"], isinstance(f["beats"], list)), ("ad-1", True))
f = S.features(T_OK, 14.0, {"id": "ad-2", "adaptation": {"delivery": "silent", "beats": []}})
check("features with a silent script: aligned_to set, beats omitted (nothing to align)", (f["aligned_to"], "beats" in f), ("ad-2", False))
f = S.features({"has_speech": False, "segments": []}, 10.0, SCRIPT)
check("features: a video with no speech has no beats and no aligned_to", (sorted(f)), ["duration_s", "has_speech", "segments"])

# ── 3. repeats: the creator says again what they already said ────────────────────────────────────
rs = [[0.5, 3.0, "the setup is that zorblax runs out every friday"], [4.0, 7.0, "something else entirely about wobbly noodles today"],
      [8.0, 11.0, "so the setup is zorblax runs out every friday"]]
check("repeats: a line said again is reported as two second marks", S.repeats(rs), [{"at_s": 8.0, "of_s": 0.5}])
check("repeats: nothing repeated -> []", S.repeats(SEGS), [])
check("repeats: a short segment (under four content words) never counts",
      S.repeats([[0, 1, "zorblax quimby"], [2, 3, "zorblax quimby"]]), [])
check("repeats: a topic returned to with different words is not a repeat",
      S.repeats([[0, 3, "zorblax arrived friday morning excited"], [5, 8, "zorblax quimby frumble sunrise tasting"]]), [])
check("repeats: the result holds numbers only", sorted({k for r in S.repeats(rs) for k in r}), ["at_s", "of_s"])
check("features: repeats appear when there are some, and are absent when there are none",
      ("repeats" in S.features({"has_speech": True, "hook_spoken": "a b", "segments": rs}, 12.0), "repeats" in S.features(T_OK, 14.0)), (True, False))


# ── 4. the lane, through a fake track_posts ──────────────────────────────────────────────────────
class FakeT:
    """Just enough of track_posts for shape_pass. Records every call so a test can say what was and was not written."""

    def __init__(self, pending=(), failed=(), linked=(), have=(), status=200, queued=False, audio=None, transcript=T_OK, scripts=(SCRIPT,),
                 dur=14.0, post_ok=True, write_status=201):
        self.calls, self.pending, self.failed, self.linked, self.have = [], list(pending), list(failed), list(linked), list(have)
        self.status, self.audio, self.transcript, self.write_status = status, audio, transcript, write_status
        self.fetches = 0
        self.q, self.iso = TP.q, TP.iso
        self.post_url_ok = lambda url, platform: post_ok
        self.scripts = list(scripts)

        def fetch_audio(url, dest):
            self.fetches += 1
            return (None, "err") if self.audio is None else (self.audio, None)
        self.P = SimpleNamespace(fetch_audio=fetch_audio, media_duration=lambda p: dur, transcribe=lambda path, model: self.transcript,
                                 WHISPER_MODEL="small", queued_work=lambda key: queued)

    def by_tier(self, items, key, cache, creator=lambda r: r.get("creator_id")):
        return items

    def rest(self, key, path, method="GET", body=None, prefer=None):
        self.calls.append((method, path, body))
        if method != "GET":
            return (self.write_status if path.startswith("/rest/v1/lynxr_post_shape") else 200), None
        if self.status != 200 and path.startswith("/rest/v1/lynxr_posts?"):
            return self.status, None
        if path.startswith("/rest/v1/lynxr_posts?shape_state=eq.pending"):
            return 200, self.pending
        if path.startswith("/rest/v1/lynxr_posts?shape_state=eq.failed"):
            return 200, self.failed
        if path.startswith("/rest/v1/lynxr_posts?shape_state=eq.ok"):
            return 200, self.linked
        if path.startswith("/rest/v1/lynxr_post_shape?"):
            return 200, self.have
        if path.startswith("/rest/v1/lynxr_creators?id=eq."):
            return 200, [{"data": {"adaptations": self.scripts}}]
        return 200, []

    def writes(self):
        return [(m, p, b) for m, p, b in self.calls if m != "GET"]


def post(i, aid=None, fails=0):
    return {"id": i, "creator_id": C1, "platform": "tiktok", "url": f"https://www.tiktok.com/@demo/video/{i}", "posted_at": "2026-10-05T10:00:00Z",
            "shape_fails": fails, "adaptation_id": aid}


records = []


class Catch(logging.Handler):
    def emit(self, record):
        records.append(record.getMessage())


S.log.addHandler(Catch())
S.log.setLevel(logging.INFO)

t = FakeT(status=404)
records.clear()
check("shape_due: a missing column (404) is [] and exactly one log line", (S.shape_due(t, KEY, NOW), len(records), "post_shape.sql" in records[0]), ([], 1, True))
t = FakeT(status=400)
check("shape_due: a 400 (an unknown column) is the same", S.shape_due(t, KEY, NOW), [])

t = FakeT(pending=[post(1)], failed=[post(2, fails=1)])
due = S.shape_due(t, KEY, NOW)
check("shape_due: pending first, then failed", [p["id"] for p in due], [1, 2])
reads = [p for m, p, b in t.calls]
failed_read = [p for p in reads if "shape_state=eq.failed" in p][0]
check("shape_due: the failed read carries the retry wait and the try cap (a failed post inside its wait is the database's to exclude)",
      ("shape_fails=lt.3" in failed_read, "shape_at=lt.2026-10-07T00%3A00%3A00Z" in failed_read), (True, True))
check("shape_due: every read is limited to tracked posts inside the age window",
      all("origin=eq.tracked" in p and "posted_at=gt.2026-08-08T12%3A00%3A00Z" in p for p in reads if p.startswith("/rest/v1/lynxr_posts?")), True)
check("shape_due: a post seen in two reads is listed once", [p["id"] for p in S.shape_due(FakeT(pending=[post(1)], failed=[post(1)]), KEY, NOW)], [1])

t = FakeT(linked=[post(5, aid="ad-1"), post(6, aid="ad-1"), post(7, aid="ad-9")],
          have=[{"post_id": 5, "aligned_to": "ad-1"}, {"post_id": 6, "aligned_to": None}, {"post_id": 7, "aligned_to": "ad-9"}])
due = S.shape_due(t, KEY, NOW)
check("shape_due: an ok post linked to a script AFTER it was shaped is due again; one already measured against its script is not",
      [(p["id"], p.get("_realign")) for p in due], [(6, True)])

# shape_one: a failed download writes failed + fails=1 and no row
t = FakeT(audio=None)
st = {"shape_due": 0, "shaped": 0, "shape_failed": 0, "shape_skipped": 0}
S.shape_one(t, KEY, post(1), NOW, st, {})
w = t.writes()
check("shape_one: a failed download PATCHes failed with shape_fails=1", [(m, b) for m, p, b in w if "lynxr_posts" in p][0][1]["shape_state"], "failed")
check("shape_one: ... and counts the failure", st["shape_failed"], 1)
check("shape_one: ... and the try count went up by one", [b for m, p, b in w if "lynxr_posts" in p][0]["shape_fails"], 1)
check("shape_one: ... and NO lynxr_post_shape row was written", [p for m, p, b in w if "lynxr_post_shape" in p], [])
t = FakeT(audio=None)
S.shape_one(t, KEY, post(1, fails=2), NOW, dict(st), {})
check("shape_one: the third failure counts three", [b for m, p, b in t.writes()][0]["shape_fails"], 3)

# shape_one: success writes one row, numbers only, and the post's state
t = FakeT(audio=Path("/dev/null"))
st = {"shape_due": 0, "shaped": 0, "shape_failed": 0, "shape_skipped": 0}
S.shape_one(t, KEY, post(1, aid="ad-1"), NOW, st, {})
w = t.writes()
row = [b for m, p, b in w if p.startswith("/rest/v1/lynxr_post_shape")][0]
check("shape_one: one shape row is written, upserted on post_id", [p for m, p, b in w if "lynxr_post_shape" in p], ["/rest/v1/lynxr_post_shape?on_conflict=post_id"])
check("shape_one: the row carries ids, the model and the numbers", (row["post_id"], row["creator_id"], row["whisper"], row["speech_start_s"], row["aligned_to"]),
      (1, C1, "small", 0.4, "ad-1"))
check("shape_one: THE WRITTEN ROW HOLDS NONE OF THE WORDS", [x for x in WORDS + ["snazzleberry"] if x in json.dumps(row).lower()], [])
check("shape_one: the post is marked ok with its tries reset", [b for m, p, b in w if "lynxr_posts" in p][0]["shape_state"], "ok")
check("shape_one: shaped is counted", st["shaped"], 1)
check("shape_one: the script came from the creator's own data (one read of lynxr_creators)", len([p for m, p, b in t.calls if "lynxr_creators" in p]), 1)

t = FakeT(audio=Path("/dev/null"), scripts=())
S.shape_one(t, KEY, post(1, aid="ad-gone"), NOW, dict(st), {})
row = [b for m, p, b in t.writes() if p.startswith("/rest/v1/lynxr_post_shape")][0]
check("shape_one: a linked script that is gone leaves no beats but still records what it was measured against", ("beats" in row, row.get("aligned_to")), (False, "ad-gone"))

t = FakeT(audio=Path("/dev/null"), write_status=500)
st2 = dict(st, shaped=0, shape_failed=0)
S.shape_one(t, KEY, post(1), NOW, st2, {})
check("shape_one: a rejected write is a failure, and the post is NOT marked ok", (st2["shape_failed"], [b["shape_state"] for m, p, b in t.writes() if "lynxr_posts" in p]), (1, ["failed"]))

t = FakeT(audio=Path("/dev/null"), dur=900.0)
st3 = dict(st, shaped=0, shape_skipped=0)
S.shape_one(t, KEY, post(1), NOW, st3, {})
check("shape_one: a file past COACH_SHAPE_MAX_SEC is too_long and is never transcribed", (st3["shape_skipped"], [b["shape_state"] for m, p, b in t.writes()]), (1, ["too_long"]))

t = FakeT(post_ok=False)
S.shape_one(t, KEY, post(1), NOW, dict(st), {})
check("shape_one: a link that is not a plain https link is skipped without a download", (t.fetches, [b["shape_state"] for m, p, b in t.writes()]), (0, ["skipped"]))

t = FakeT(audio=None)
S.shape_one(t, KEY, {**post(1, aid="ad-1"), "_realign": True}, NOW, dict(st), {})
check("shape_one: a failed second look never demotes an ok post (only the wait is stamped)", [b for m, p, b in t.writes()], [{"shape_at": "2026-10-07T12:00:00Z"}])


class Boom(FakeT):
    def rest(self, key, path, method="GET", body=None, prefer=None):
        if path.startswith("/rest/v1/lynxr_creators"):
            raise RuntimeError("boom")
        return super().rest(key, path, method, body, prefer)


t = Boom(audio=Path("/dev/null"))
S.shape_one(t, KEY, post(1, aid="ad-1"), NOW, dict(st), {})
check("shape_one: an exception never escapes, and the post is marked failed", [b["shape_state"] for m, p, b in t.writes()], ["failed"])

# shape_pass
saved = S.COACH_SHAPE
S.COACH_SHAPE = False
check("shape_pass: COACH_SHAPE=0 -> {}", S.shape_pass(KEY, NOW, T=FakeT(pending=[post(1)])), {})
S.COACH_SHAPE = saved
check("shape_pass: no module to borrow -> {}", S.shape_pass(KEY, NOW, T=None), {})
t = FakeT(pending=[post(1), post(2)], audio=Path("/dev/null"))
out = S.shape_pass(KEY, NOW, dry=True, T=t)
check("shape_pass: dry counts what is due and makes no download and no write", (out["shape_due"], t.fetches, t.writes()), (2, 0, []))
t = FakeT(pending=[post(1), post(2)], audio=Path("/dev/null"), queued=True)
out = S.shape_pass(KEY, NOW, T=t)
check("shape_pass: a queued script ends the pass before the first download", (out["shaped"], t.fetches, t.writes()), (0, 0, []))
t = FakeT(pending=[post(1), post(2), post(3)], audio=Path("/dev/null"))
out = S.shape_pass(KEY, NOW, T=t)
check("shape_pass: at most COACH_SHAPE_PER_PASS posts are attempted", (out["shaped"], t.fetches), (S.COACH_SHAPE_PER_PASS, S.COACH_SHAPE_PER_PASS))
t = FakeT(status=404)
check("shape_pass: the SQL not applied is a quiet zero", S.shape_pass(KEY, NOW, T=t)["shape_due"], 0)

# ── 5. the boundaries ────────────────────────────────────────────────────────────────────────────
src = (HERE / "post_shape.py").read_text()
check("the module imports no model client and spends nothing",
      [w for w in ("anthropic", "apify_run", "ig_details", "record_cost") if w in src.split('"""', 2)[2]], [])
check("the module never imports track_posts at module level", [l for l in src.splitlines() if l.startswith("import track_posts")], [])
agency = (HERE / "process_campaigns.py").read_text()
check("agency isolation: process_campaigns.py neither imports the shape lane nor names its table",
      [w for w in ("post_shape", "lynxr_post_shape", "coach") if w in agency], [])

if FAILS:
    print(f"\n{len(FAILS)} FAILED: " + ", ".join(FAILS))
    sys.exit(1)
print("all checks passed")
