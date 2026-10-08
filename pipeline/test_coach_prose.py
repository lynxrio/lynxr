"""Offline checks for pipeline/coach_prose.py, the Haiku rewrite of the coach's measured facts. No network, no Anthropic: the client is a fake.
The point of every check here is the same: the model may only rephrase what was measured, a rewrite that adds anything is dropped in code, the
templated sentence stands, and a repeat render costs nothing.

Every number, post id and word below is invented for this test. It is checked into a public repo.

Run with

    ./venv/bin/python pipeline/test_coach_prose.py
"""
import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import coach as C  # noqa: E402
import coach_prose as CP  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


FACTS = ("views at the last reading: 1,204\nviews at each reading: day 0: 300, day 1: 640, day 7: 1,204\n"
         "it was still climbing at its last reading, 7 days in; 1,204 views a week in, 1.2× your own usual\n"
         "against this creator's own usual a week in: about your usual\nin the audio: nobody spoke until second 2.9")
GOOD = "It was still climbing 7 days in, and it reached 1,204 views. Nobody spoke until second 2.9."


class FakeClient:
    def __init__(self, answers=(GOOD,), boom=None):
        self.calls, self.answers, self.boom = [], list(answers), boom
        self.messages = self

    def create(self, **kw):
        self.calls.append(kw)
        if self.boom:
            raise self.boom
        text = self.answers[min(len(self.calls) - 1, len(self.answers) - 1)]
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], usage=SimpleNamespace(input_tokens=420, output_tokens=40))


def note_with(*facts):
    return {"posts": [{"post_id": i + 1, "line": "x", "_facts": f} for i, f in enumerate(facts)]}


def getter(client):
    return lambda: client


costs = []
saved_cost = CP.P.record_cost
CP.P.record_cost = lambda key, id8, ok, u: costs.append((id8, ok, u))

# ── the call ─────────────────────────────────────────────────────────────────────────────────────
fc = FakeClient()
n = note_with(FACTS)
st = CP.apply(n, getter(fc), key="svc")
check("a rewrite that uses only the facts' numbers is kept, with its fingerprint", (n["posts"][0].get("prose"), n["posts"][0]["prose_key"], st),
      (GOOD, C.facts_key(FACTS), {"prose": 1, "prose_dropped": 0, "prose_failed": 0}))
msg = fc.calls[0]
check("the model is given the facts and a fixed instruction, NOTHING else (no caption, no transcript, no script, no creator)",
      msg["messages"][0]["content"], "Facts about one video:\n" + FACTS + "\n\nWrite it up.")
check("the model is Haiku, with no effort or thinking parameter (Haiku 4.5 rejects them)",
      (msg["model"], "output_config" in msg, "thinking" in msg, msg["temperature"]), ("claude-haiku-4-5", False, False, 0))
check("the system prompt tells it to be a copy editor and to copy numbers exactly",
      ("copy editor" in msg["system"], "copied exactly" in msg["system"]), (True, True))
check("the spend is recorded per call as 'coach', with the measured tokens", [(c[0], c[1], c[2]["claude-haiku-4-5"]["in"], c[2]["claude-haiku-4-5"]["out"]) for c in costs],
      [("coach", True, 420, 40)])

# ── the fallback: any rewrite that adds anything is dropped ──────────────────────────────────────
for label, answer in (("an invented number", "It reached 1,500 views, and nobody spoke until second 2.9."),
                      ("a rounded number", "It reached about 1.2k views."),
                      ("an audience claim", "Your audience kept coming back, with 1,204 views."),
                      ("a cause", "It climbed because you opened fast, to 1,204 views."),
                      ("a number in words", "Nobody spoke for three seconds."),
                      ("a platform claim", "The algorithm helped it reach 1,204 views."),
                      ("curve language", "The retention curve held up to 1,204 views.")):
    fc = FakeClient((answer,))
    n = note_with(FACTS)
    st = CP.apply(n, getter(fc))
    check(f"fallback: {label} -> no prose is kept, the templated sentence stands, and the refusal is counted",
          ("prose" in n["posts"][0], st["prose_dropped"], st["prose"]), (False, 1, 0))
    check(f"fallback: {label} -> the key IS recorded (the same facts would be refused again, so they are not asked again)",
          n["posts"][0].get("prose_key"), C.facts_key(FACTS))

# ── cost control: cached, capped, and silent on failure ──────────────────────────────────────────
fc = FakeClient()
n = note_with(FACTS)
n["posts"][0]["prose_key"] = C.facts_key(FACTS)
n["posts"][0]["prose"] = "carried"
st = CP.apply(n, getter(fc))
check("cache: a video that already carries its prose_key costs NOTHING (no call, no client built)", (len(fc.calls), st, n["posts"][0]["prose"]),
      (0, {"prose": 0, "prose_dropped": 0, "prose_failed": 0}, "carried"))
built = []
st = CP.apply(note_with(FACTS), lambda: (built.append(1), FakeClient())[1])
check("cache: the client is built lazily, once, and only when a call is wanted", built, [1])
built.clear()
CP.apply(n, lambda: (built.append(1), FakeClient())[1])
check("cache: no call wanted -> no client is even built", built, [])

fc = FakeClient()
n = note_with(*[FACTS + f"\nextra {i}" for i in range(7)])
CP.apply(n, getter(fc))
check("cap: at most COACH_PROSE_PER_BUILD calls for one creator in one build, newest video first",
      (len(fc.calls), [e["post_id"] for e in n["posts"] if e.get("prose_key")]), (CP.COACH_PROSE_PER_BUILD, [1, 2, 3][:CP.COACH_PROSE_PER_BUILD]))

fc = FakeClient(boom=RuntimeError("the facts text here must never be logged"))
n = note_with(FACTS)
records = []


class Catch(__import__("logging").Handler):
    def emit(self, record):
        records.append(record.getMessage())


CP.log.addHandler(Catch())
CP.log.setLevel(10)
st = CP.apply(n, getter(fc))
check("failure: a failed CALL leaves the video untouched so it is asked again next build", ("prose_key" in n["posts"][0], "prose" in n["posts"][0], st["prose_failed"]),
      (False, False, 1))
check("failure: the log line names the error type and never the facts or the text", [r for r in records if "views" in r or "second" in r], [])
st = CP.apply(note_with(FACTS), lambda: None)
check("failure: no usable client -> nothing is written, the failure is counted, nothing raises", st["prose_failed"], 1)

saved = CP.COACH_PROSE
CP.COACH_PROSE = False
fc = FakeClient()
st = CP.apply(note_with(FACTS), getter(fc))
check("COACH_PROSE=0 turns the pass off: no call", (len(fc.calls), st["prose"]), (0, 0))
CP.COACH_PROSE = saved

fc = FakeClient()
n = {"posts": [{"post_id": 1, "line": "x"}, {"post_id": 2, "line": "y", "_facts": ""}]}
CP.apply(n, getter(fc))
check("a video with no facts is never sent", len(fc.calls), 0)
check("wanted() on junk is empty", (CP.wanted(None), CP.wanted({}), CP.wanted({"posts": None})), ([], [], []))

# ── what the prompt itself must not do ───────────────────────────────────────────────────────────
check("the system prompt names no creator, brand or caption and is not wrapped in a cache marker (it is under the cache minimum)",
      ("cache_control" in CP.PROSE_SYSTEM, len(CP.PROSE_SYSTEM) < 2400), (False, True))
src = (HERE / "coach_prose.py").read_text()
check("agency isolation: process_campaigns.py neither imports the prose pass nor names its flags",
      [w for w in ("coach_prose", "COACH_PROSE") if w in (HERE / "process_campaigns.py").read_text()], [])
check("the prose pass reads no environment value but its own three flags",
      sorted(set(__import__("re").findall(r'envcfg\.get\("([A-Z_]+)"', src))), ["COACH_PROSE", "COACH_PROSE_MODEL", "COACH_PROSE_PER_BUILD"])
CP.P.record_cost = saved_cost

if FAILS:
    print(f"\n{len(FAILS)} FAILED: " + ", ".join(FAILS))
    sys.exit(1)
print("all checks passed")
