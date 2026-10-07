"""Offline checks for pipeline/post_match.py, the pure scorer that decides whether a tracked post came from one of a creator's
lynxr scripts. No network, no Supabase. Same check()/FAILS style as pipeline/test_script_checks.py.

Every brand, script line and transcript below is invented for this test. No real brand, script, handle or caption from the repo's
data goes in this file: it is checked into a public repo.

Run with

    ./venv/bin/python pipeline/test_post_match.py
"""
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import post_match as M  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


POSTED = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)
CFG = M.Cfg()


def when(days_before):
    return (POSTED - timedelta(days=days_before)).isoformat().replace("+00:00", "Z")


def entry(aid, brand_id="b1", days_before=3, hook="", beats=(), cta="", caption="", delivery="spoken", status="done"):
    return {"id": aid, "status": status, "brandId": brand_id, "addedAt": when(days_before),
            "adaptation": {"delivery": delivery, "hook": hook, "cta": cta, "caption": caption,
                           "beats": [{"t": "0-3s", "say": s, "do": "", "show": ""} for s in beats]}}


def run(adaptations, brands, transcript, caption="", has_speech=True, counts=None):
    scored, decision, best = M.rank(adaptations, brands, transcript, caption, has_speech, POSTED, CFG, counts)
    return scored, decision, best


# One invented script, about an invented bottle.
HOOK = "your water bottle is lying about how cold it stays"
BEATS = ["i filled the quenchwell bottle with ice and left it in my hot car all afternoon",
         "six hours later the ice was still there and the water was freezing cold",
         "the lid seals tight so nothing leaks inside my gym bag either",
         "it fits my cup holder and it cleans in the dishwasher with no effort"]
CTA = "grab a quenchwell bottle before summer ends"
BRANDS = [{"id": "b1", "name": "Quenchwell"}, {"id": "bx", "name": "Zorbly"}]
SCRIPT = entry("s-aaaaaaaa-1", "b1", 3, HOOK, BEATS, CTA, caption="the only bottle i trust in my hot car")
FULL = " ".join([HOOK] + BEATS + [CTA])

# ---- the small pure pieces ----------------------------------------------------------------------
check("norm_words: stopwords, one-letter tokens and apostrophes go; order kept",
      M.norm_words("Honestly I can't believe it's THAT cold, a really good bottle"), ["honestly", "believe", "cold", "good", "bottle"])
check("norm_words: curly apostrophe folds", M.norm_words("widget’s"), M.norm_words("widget's"))
check("norm_words: None is empty", M.norm_words(None), [])
check("shingles: fewer words than n is empty", M.shingles(["a", "b"], 3), set())
check("shingles: n-word tuples", M.shingles(["a", "b", "c", "d"], 2), {("a", "b"), ("b", "c"), ("c", "d")})
w, hw, silent = M.script_words(SCRIPT)
check("script_words: hook words are the head of the spoken words", w[:len(hw)], hw)
check("script_words: spoken delivery is not silent", silent, False)
check("script_words: silent delivery is flagged", M.script_words(entry("x", hook="go now", delivery="silent"))[2], True)

# ---- 1. a faithful read: ~15% filler inserted, a few words dropped, brand named aloud -> auto -----
said1 = ("um " + HOOK + " so like "
         "i filled the quenchwell bottle with ice you know and left it in my hot car all afternoon "
         "six hours later the ice was still there and the water was freezing cold honestly "
         "the lid seals tight so nothing leaks inside my gym bag "
         "it fits my cup holder and it cleans in the dishwasher "
         "grab a quenchwell bottle before summer ends")
sc, dec, best = run([SCRIPT], BRANDS, said1)
check("case 1: a faithful read that names the brand is auto", (dec, best), ("auto", SCRIPT["id"]))
check("case 1: its score clears the bar", sc[0][1] >= CFG.auto_min, True)

# ---- 2. same body, brand never said, hook not heard in the opening -> not auto (no corroboration) ---
said2 = ("welcome back everybody today i am going to tell you a long story about my week at the beach with my family and friends "
         "i filled the bottle with ice and left it in my hot car all afternoon "
         "six hours later the ice was still there and the water was freezing cold "
         "the lid seals tight so nothing leaks inside my gym bag "
         "it fits my cup holder and it cleans in the dishwasher with no effort")
sc, dec, best = run([SCRIPT], BRANDS, said2)
check("case 2: no brand, no hook in the opening -> never auto", dec != "auto", True)
check("case 2: it is borderline, not dropped", dec, "borderline")
check("case 2: hook and brand both zero", (sc[0][2]["hook"], sc[0][2]["brand"]), (0, 0))

# ---- 3. a paraphrase sharing ~30% of content words -> borderline --------------------------------
# Two lines kept close to the script, the rest reworded: ~30% of the script's content words survive. (Reworded
# throughout, with no line kept, it scores under the 0.25 log floor and is `none`: checked below.)
said3 = ("that tumbler kept my drinks chilly while parked in the sun for ages "
         "six hours later the ice was still there and the water was freezing cold "
         "the lid seals tight so nothing leaks inside my gym bag "
         "and it slides into the car cup holder easily")
sc, dec, best = run([SCRIPT], BRANDS, said3)
check("case 3: a paraphrase that keeps some lines is borderline", dec, "borderline")
check("case 3: ... and its recall is near a third", 0.25 <= sc[0][2]["recall"] <= 0.55, True)
said3b = ("that tumbler kept my drinks chilly while parked in the sun for ages and the ice barely melted "
          "no spills in my backpack and it slides into the car cup holder easily")
check("case 3: reworded throughout, nothing links (none)", run([SCRIPT], BRANDS, said3b)[1], "none")

# ---- 4. an unrelated transcript -> none ---------------------------------------------------------
said4 = "today we are baking sourdough with a long cold ferment and a very hot dutch oven for the crispiest crust"
sc, dec, best = run([SCRIPT], BRANDS, said4)
check("case 4: unrelated speech is none", (dec, best), ("none", None))

# ---- 5. two scripts for two brands from one source ----------------------------------------------
TEMPLATE = {"hook": "{B} bottle keeps drinks ice cold",
            "beats": ["i left my {B} bottle in the hot car all afternoon",
                      "{B} still had ice six hours later",
                      "the {B} lid seals tight in my gym bag",
                      "my {B} cleans in the dishwasher easily"],
            "cta": "grab a {B} bottle today"}


def branded(aid, brand_id, name):
    return entry(aid, brand_id, 3, TEMPLATE["hook"].format(B=name), [b.format(B=name) for b in TEMPLATE["beats"]],
                 TEMPLATE["cta"].format(B=name))


SX, SY = branded("s-xxxxxxxx-x", "bx", "zorbly"), branded("s-yyyyyyyy-y", "b1", "quenchwell")
reads_y = " ".join([TEMPLATE["hook"]] + TEMPLATE["beats"] + [TEMPLATE["cta"]]).format(B="quenchwell")
sc, dec, best = run([SX, SY], BRANDS, reads_y)
check("case 5: the transcript reads Y and names Y -> auto, and it is Y", (dec, best), ("auto", SY["id"]))
unnamed = " ".join([TEMPLATE["hook"]] + TEMPLATE["beats"] + [TEMPLATE["cta"]]).replace("{B} ", "")
sc, dec, best = run([SX, SY], BRANDS, unnamed)
check("case 5: with both brand names stripped the lead is under the margin", sc[0][1] - sc[1][1] < CFG.margin, True)
check("case 5: with both brand names stripped it is borderline, never a guess", dec, "borderline")

# ---- 6. silent scripts and no-speech posts never auto, even with a perfect caption --------------
CAPTION = "the only bottle i trust in my hot car quenchwell"
silent_script = entry("s-silent-1", "b1", 3, HOOK, BEATS, CTA, caption=CAPTION, delivery="silent")
sc, dec, best = run([silent_script], BRANDS, FULL, caption=CAPTION)
check("case 6: a silent script is never auto", dec != "auto", True)
check("case 6: a silent script is capped at 0.5", sc[0][1] <= 0.5, True)
spoken_cap = entry("s-spoken-1", "b1", 3, HOOK, BEATS, CTA, caption=CAPTION)
sc, dec, best = run([spoken_cap], BRANDS, "", caption=CAPTION, has_speech=False)
check("case 6: a post with no speech is never auto", dec != "auto", True)
check("case 6: a post with no speech is capped at 0.5", sc[0][1] <= 0.5, True)

# ---- 7. a script 31-45 days old is a candidate and never auto -----------------------------------
for age in (31, 40, 45):
    old = entry("s-old", "b1", age, HOOK, BEATS, CTA)
    check(f"case 7: a script {age} days old is still a candidate", [a["id"] for a in M.candidates([old], {}, POSTED, 45)], ["s-old"])
    sc, dec, best = run([old], BRANDS, FULL)
    check(f"case 7: ... but a perfect read of it is never auto ({age} days)", dec != "auto", True)
good = {"containment": 0.9, "recall": 0.9, "hook": 1, "brand": 1, "caption": 0.5, "days": 35.0, "silent": False, "speech": True}
check("case 7: decide() refuses on age alone, whatever the score", M.decide([("x", 0.95, good)], CFG)[0], "borderline")
check("case 7: the same features at 30 days are auto", M.decide([("x", 0.95, {**good, "days": 30.0})], CFG)[0], "auto")
check("case 7: a script written after the post is never auto", M.decide([("x", 0.95, {**good, "days": -1.0})], CFG)[0], "borderline")

# ---- 8. candidates() exclusions -----------------------------------------------------------------
future = entry("s-future", "b1", 0, HOOK, BEATS, CTA)
future["addedAt"] = (POSTED + timedelta(hours=2)).isoformat().replace("+00:00", "Z")
just_after = entry("s-just-after", "b1", 0, HOOK, BEATS, CTA)
just_after["addedAt"] = (POSTED + timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
too_old = entry("s-46", "b1", 46, HOOK, BEATS, CTA)
full_up = entry("s-full", "b1", 3, HOOK, BEATS, CTA)
no_brand = entry("s-nobrand", None, 3, HOOK, BEATS, CTA)
empty_brand = entry("s-emptybrand", "", 3, HOOK, BEATS, CTA)
no_beats = entry("s-nobeats", "b1", 3, HOOK, [], CTA)
queued = entry("s-queued", "b1", 3, HOOK, BEATS, CTA, status="queued")
bad_date = entry("s-baddate", "b1", 3, HOOK, BEATS, CTA)
bad_date["addedAt"] = "not a date"
ok_one = entry("s-ok", "b1", 3, HOOK, BEATS, CTA)
got = M.candidates([future, just_after, too_old, full_up, no_brand, empty_brand, no_beats, queued, bad_date, ok_one],
                   {"s-full": 4}, POSTED, 45)
check("case 8: written after posted_at + 1h, 46 days old, 4 links already, no brand, no beats, not done, bad date: all out",
      [a["id"] for a in got], ["s-just-after", "s-ok"])
check("case 8: a script with 3 links is still a candidate",
      [a["id"] for a in M.candidates([full_up], {"s-full": 3}, POSTED, 45)], ["s-full"])
many = [entry(f"s-{i}", "b1", 1 + (i % 40), HOOK, BEATS, CTA) for i in range(50)]
capped = M.candidates(many, {}, POSTED, 45)
check("case 8: capped at 30", len(capped), 30)
check("case 8: newest addedAt first", [M.parse_ts(a["addedAt"]) for a in capped] == sorted([M.parse_ts(a["addedAt"]) for a in capped], reverse=True), True)

# ---- the decision guards, one at a time ---------------------------------------------------------
base = {"containment": 0.7, "recall": 0.8, "hook": 1, "brand": 1, "caption": 0.2, "days": 5.0, "silent": False, "speech": True}
check("decide: nothing scored is none", M.decide([], CFG), ("none", None))
check("decide: all guards met is auto", M.decide([("a", 0.80, base)], CFG), ("auto", "a"))
check("decide: a close runner-up blocks auto", M.decide([("a", 0.80, base), ("b", 0.60, base)], CFG)[0], "borderline")
check("decide: a runner-up exactly one margin behind does not block", M.decide([("a", 0.80, base), ("b", 0.55, base)], CFG)[0], "auto")
check("decide: containment under the floor blocks auto", M.decide([("a", 0.80, {**base, "containment": 0.40})], CFG)[0], "borderline")
check("decide: no brand, no hook, containment under strong blocks auto",
      M.decide([("a", 0.80, {**base, "brand": 0, "hook": 0, "containment": 0.55})], CFG)[0], "borderline")
check("decide: no brand, no hook, but strong containment is auto",
      M.decide([("a", 0.80, {**base, "brand": 0, "hook": 0, "containment": 0.65})], CFG)[0], "auto")
check("decide: score under the bar is borderline", M.decide([("a", 0.60, base)], CFG)[0], "borderline")
check("decide: score under the log floor is none", M.decide([("a", 0.20, base)], CFG), ("none", None))
check("decide: silent blocks auto", M.decide([("a", 0.80, {**base, "silent": True})], CFG)[0], "borderline")
check("decide: no speech blocks auto", M.decide([("a", 0.80, {**base, "speech": False})], CFG)[0], "borderline")

# ---- 9. score() stays in [0, 1] over seeded random features -------------------------------------
rng = random.Random(20261007)
bad = 0
for _ in range(200):
    f = {"containment": rng.random(), "recall": rng.random(), "hook": rng.choice((0, 1)), "brand": rng.choice((0, 1)),
         "caption": rng.random(), "days": rng.uniform(-5, 90), "silent": rng.random() < 0.2, "speech": rng.random() < 0.8}
    s = M.score(f)
    if not 0.0 <= s <= 1.0:
        bad += 1
check("case 9: 200 random feature dicts, every score in [0, 1]", bad, 0)
check("score: the maximum is exactly 1.0",
      M.score({"containment": 1, "recall": 1, "hook": 1, "brand": 1, "caption": 1, "days": 0.0, "silent": False, "speech": True}), 1.0)
check("score: a script over 30 days old is damped to 0.75",
      M.score({"containment": 1, "recall": 1, "hook": 1, "brand": 1, "caption": 1, "days": 40.0, "silent": False, "speech": True}), 0.75)
check("score: a perfect caption and brand with no speech stays at 0.5",
      M.score({"containment": 1, "recall": 1, "hook": 1, "brand": 1, "caption": 1, "days": 0.0, "silent": False, "speech": False}), 0.5)

# ---- the brand and hook features ----------------------------------------------------------------
f = M.features(M.norm_words(said1), True, [], SCRIPT, "Quenchwell", POSTED)
check("features: the brand said aloud counts", f["brand"], 1)
f = M.features(M.norm_words(said2), True, M.norm_words("a post about my bottle quenchwell"), SCRIPT, "Quenchwell", POSTED)
check("features: the brand in the caption counts too", f["brand"], 1)
f = M.features(M.norm_words(said4), True, [], SCRIPT, "Quenchwell", POSTED)
check("features: an unrelated transcript has no brand and no hook", (f["brand"], f["hook"]), (0, 0))
check("features: whole days from addedAt to posted_at", M.features([], True, [], SCRIPT, "", POSTED)["days"], 3.0)
check("features: a script with fewer than 8 content words uses 2-shingles",
      M.features(M.norm_words("quick tip bottle cold"), True, [],
                 entry("t", "b1", 1, "quick tip", ["bottle cold"], ""), "", POSTED)["containment"], 1.0)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
