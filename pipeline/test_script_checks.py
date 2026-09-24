"""Checks on pipeline/script_checks.py — pure functions only, no network, no
Supabase, no import of process_adaptations (script_checks.py has none
either). Every string here is invented for this test; no real brand, script
line, handle or caption from the repo's data ever goes in a file (see
CLAUDE.md's "no eval output, fixture, brand row, script text, handle or
caption" rule — this file is checked into the repo, so it obeys it too).

Run with

    ./venv/bin/python pipeline/test_script_checks.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import script_checks as S  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    FAILS.append(name) if not ok else None
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


def beat(say="", show="", t="0-3s", do=""):
    return {"t": t, "say": say, "do": do, "show": show}


# ---- words / shown_words / say_words ---------------------------------------
check("words: lowercases and strips punctuation",
      S.words("Widget's Best DEAL, ever!"), ["widget's", "best", "deal", "ever"])
check("words: curly apostrophe normalised the same as straight",
      S.words("widget’s"), S.words("widget's"))

_spoken_ad = {
    "delivery": "spoken", "hook": "try this trick today",
    "cta": "go grab one now",
    "beats": [beat(say="here is the plan for you"), beat(say="that is the whole idea")],
}
check("shown_words: hook + every say + cta, spoken",
      S.shown_words(_spoken_ad), len(S.words("try this trick today"))
      + len(S.words("here is the plan for you")) + len(S.words("that is the whole idea"))
      + len(S.words("go grab one now")))
check("shown_words: 0 for a silent script",
      S.shown_words({**_spoken_ad, "delivery": "silent"}), 0)
check("say_words: sums every beat's say regardless of delivery",
      S.say_words(_spoken_ad),
      len(S.words("here is the plan for you")) + len(S.words("that is the whole idea")))

# ---- hook_repeated / cta_repeated -------------------------------------------
check("hook_repeated: beat 1 restates the whole hook -> True",
      S.hook_repeated({"delivery": "spoken", "hook": "try this trick today",
                        "beats": [beat(say="try this trick today, seriously")]}), True)
check("hook_repeated: beat 1 is unrelated -> False",
      S.hook_repeated({"delivery": "spoken", "hook": "try this trick today",
                        "beats": [beat(say="a totally different opening line")]}), False)
check("hook_repeated: silent delivery never counts",
      S.hook_repeated({"delivery": "silent", "hook": "try this trick today",
                        "beats": [beat(show="try this trick today")]}), False)
check("hook_repeated: empty hook -> False",
      S.hook_repeated({"delivery": "spoken", "hook": "", "beats": [beat(say="anything")]}), False)
check("cta_repeated: last beat restates the whole cta -> True",
      S.cta_repeated({"delivery": "spoken", "cta": "go grab one now",
                       "beats": [beat(say="first"), beat(say="so go grab one now")]}), True)
check("cta_repeated: last beat is unrelated -> False",
      S.cta_repeated({"delivery": "spoken", "cta": "go grab one now",
                       "beats": [beat(say="first"), beat(say="something else entirely")]}), False)

# ---- word_ratio / say_ratio --------------------------------------------------
_src_15w = {"script": {"has_speech": True,
                       "text": "one two three four five six seven eight nine ten "
                               "eleven twelve thirteen fourteen fifteen"}}
_src_short = {"script": {"has_speech": True, "text": "only a few words here"}}
_src_silent = {"script": {"has_speech": False, "text": "one two three four five six seven "
                                                       "eight nine ten eleven twelve thirteen "
                                                       "fourteen fifteen"}}
check("word_ratio: None when source has <15 words",
      S.word_ratio(_spoken_ad, _src_short), None)
check("word_ratio: None when source has no speech",
      S.word_ratio(_spoken_ad, _src_silent), None)
check("word_ratio: shown_words over the source's word count",
      S.word_ratio(_spoken_ad, _src_15w), S.shown_words(_spoken_ad) / 15)
check("say_ratio: say_words over the source's word count",
      S.say_ratio(_spoken_ad, _src_15w), S.say_words(_spoken_ad) / 15)

# ---- runs_past ---------------------------------------------------------------
check("runs_past: last beat's end time well past 1.15x duration -> True",
      S.runs_past({"beats": [beat(t="0-3s"), beat(t="20-40s")]}, {"duration": 30}), True)
check("runs_past: comfortably inside 1.15x duration -> False",
      S.runs_past({"beats": [beat(t="0-3s"), beat(t="20-32s")]}, {"duration": 30}), False)
check("runs_past: no duration on the source -> False",
      S.runs_past({"beats": [beat(t="20-99s")]}, {"duration": 0}), False)
check("runs_past: no beats -> False", S.runs_past({"beats": []}, {"duration": 30}), False)

# ---- slots --------------------------------------------------------------------
check("slots: counts bracketed slots across every field",
      S.slots({"hook": "[your own hook]", "cta": "go now", "caption": "post it [handle]",
               "beats": [beat(say="[what you use it for]", show="[on-screen slot]")]}), 4)
check("slots: a short bracket run under 3 chars does not count",
      S.slots({"hook": "[ab]", "cta": "", "caption": "", "beats": []}), 0)

# ---- unbacked_tokens ----------------------------------------------------------
_thin_brand = {"name": "Aurora Home", "description": "", "site": "", "objective": "", "niche": ""}
_full_brand = {"name": "Aurora Home", "description": "aurorahome.com is 20% off this week, "
               "free shipping, @aurorahome, link in bio",
               "site": "aurorahome.com", "objective": "", "niche": ""}
_claimy_ad = {"hook": "it's free", "cta": "aurorahome.com, 20% off, @aurorahome",
              "caption": "", "beats": [beat(say="link in bio")]}
check("unbacked_tokens: every fact is unbacked against a thin brand",
      sorted(S.unbacked_tokens(_claimy_ad, _thin_brand)),
      sorted(["free", "aurorahome.com", "20%", "@aurorahome", "link in bio"]))
check("unbacked_tokens: nothing unbacked once the brand states the same facts",
      S.unbacked_tokens(_claimy_ad, _full_brand), [])
check("unbacked_tokens: deduplicates repeats of the same token",
      S.unbacked_tokens({"hook": "50% off", "cta": "50% off today", "caption": "",
                         "beats": []}, _thin_brand), ["50%"])

# ---- cta_problem ---------------------------------------------------------------
check("cta_problem: empty cta -> 'empty'", S.cta_problem({"cta": ""}), "empty")
check("cta_problem: whitespace-only cta -> 'empty'", S.cta_problem({"cta": "   "}), "empty")
check("cta_problem: a direction in parens -> 'direction'",
      S.cta_problem({"cta": "(cut to product shot) grab one today"}), "direction")
check("cta_problem: a clean line -> None", S.cta_problem({"cta": "grab one today"}), None)

# ---- escaped --------------------------------------------------------------------
check("escaped: a literal backslash-u sequence in a field -> True",
      S.escaped({"hook": "go check it out \\u2014 today"}), True)
check("escaped: a literal backslash-n-e-hex sequence -> True",
      S.escaped({"cta": "grab one \\ne28093 now"}), True)
check("escaped: a normal script with a real em dash -> False",
      S.escaped({"hook": "go check it out — today"}), False)

# ---- caption_reuses_source_tags --------------------------------------------------
check("caption_reuses_source_tags: shared hashtag against source.caption",
      S.caption_reuses_source_tags({"caption": "new video #trendyclip #brandname"},
                                   {"caption": "original post #trendyclip #other"}),
      ["#trendyclip"])
check("caption_reuses_source_tags: falls back to source.meta.title",
      S.caption_reuses_source_tags({"caption": "#foryou new thing"},
                                   {"meta": {"title": "old caption #foryou here"}}),
      ["#foryou"])
check("caption_reuses_source_tags: no overlap -> []",
      S.caption_reuses_source_tags({"caption": "#brandnew"}, {"caption": "#unrelated"}), [])

# ---- product_entry / product_entry_match -----------------------------------------
check("product_entry: named in the first third -> 'early'",
      S.product_entry({"delivery": "spoken",
                       "beats": [beat(say="aurora home changes everything"),
                                 beat(say="second beat"), beat(say="third beat")]},
                      "Aurora Home"),
      "early")
check("product_entry: named in the last third -> 'late'",
      S.product_entry({"delivery": "spoken",
                       "beats": [beat(say="first beat"), beat(say="second beat"),
                                 beat(say="third beat"), beat(say="aurora home wraps it up")]},
                      "Aurora Home"),
      "late")
check("product_entry: never named -> 'none'",
      S.product_entry({"delivery": "spoken", "beats": [beat(say="nothing about it")]},
                      "Aurora Home"),
      "none")
check("product_entry: silent delivery reads `show`, not `say`",
      S.product_entry({"delivery": "silent",
                       "beats": [beat(show="aurora home right here")]}, "Aurora Home"),
      "early")
check("check(): product_entry_match true when it agrees with the format",
      S.check({"delivery": "spoken", "hook": "h", "cta": "c", "caption": "cap",
               "beats": [beat(say="aurora home is here")]},
              {"script": {"has_speech": True, "text": "short"}},
              {"product_entry": "early"}, {"name": "Aurora Home"})["product_entry_match"],
      True)

# ---- delivery_match ---------------------------------------------------------------
check("delivery_match: silent source, silent script with no say -> True",
      S.delivery_match({"delivery": "silent", "beats": [beat(say="")]},
                       {"script": {"has_speech": False}}), True)
check("delivery_match: silent source but a say line leaked in -> False",
      S.delivery_match({"delivery": "silent", "beats": [beat(say="oops, said something")]},
                       {"script": {"has_speech": False}}), False)
check("delivery_match: spoken source, spoken script -> True",
      S.delivery_match({"delivery": "spoken", "beats": []}, {"script": {"has_speech": True}}),
      True)
check("delivery_match: spoken source, silent script -> False",
      S.delivery_match({"delivery": "silent", "beats": []}, {"script": {"has_speech": True}}),
      False)

# ---- lowercase_lines ----------------------------------------------------------------
check("lowercase_lines: an all-lowercase hook of enough letters is flagged",
      S.lowercase_lines({"hook": "this line has no capitals anywhere at all",
                         "cta": "", "caption": "", "beats": []}),
      ["this line has no capitals anywhere at all"])
check("lowercase_lines: a normally-cased line is not flagged",
      S.lowercase_lines({"hook": "This Line Has Capitals In It Here",
                         "cta": "", "caption": "", "beats": []}), [])
check("lowercase_lines: an all-lowercase line under 12 letters is not flagged",
      S.lowercase_lines({"hook": "hi there", "cta": "", "caption": "", "beats": []}), [])
check("lowercase_lines: an uppercase @handle is stripped before the check, so the "
      "otherwise-lowercase rest of the line still flags",
      S.lowercase_lines({"hook": "check out @BrandName for the whole story",
                         "cta": "", "caption": "", "beats": []}),
      ["check out @BrandName for the whole story"])

# ---- check() returns everything -----------------------------------------------------
_full_check = S.check(_spoken_ad, _src_15w, {"product_entry": "none"}, _thin_brand)
for _k in ("hook_repeated", "cta_repeated", "word_ratio", "say_ratio", "runs_past", "slots",
           "unbacked_tokens", "cta_problem", "escaped", "caption_reuses_source_tags",
           "product_entry", "product_entry_match", "delivery_match", "lowercase_lines"):
    check(f"check(): {_k} is present", _k in _full_check, True)

# ---- tidy() ---------------------------------------------------------------------------
# 1. Exact repeat: beat 1's say IS the hook, verbatim -> stripped clean.
_ad1 = {"delivery": "spoken", "hook": "try this trick today", "cta": "grab one now",
        "beats": [beat(say="try this trick today"), beat(say="and that's it")]}
_new1, _fixed1 = S.tidy(_ad1)
check("tidy(): exact hook repeat -> fixed list names it", _fixed1, ["hook_repeated"])
check("tidy(): exact hook repeat -> beat 1's say emptied out",
      _new1["beats"][0]["say"], "")
check("tidy(): does not mutate the original", _ad1["beats"][0]["say"], "try this trick today")

# 2. Leading run: beat 1's say starts with the hook then continues.
_ad2 = {"delivery": "spoken", "hook": "try this trick today", "cta": "grab one now",
        "beats": [beat(say="try this trick today, it changed everything for me"),
                 beat(say="closing line")]}
_new2, _fixed2 = S.tidy(_ad2)
check("tidy(): leading run -> fixed list names it", _fixed2, ["hook_repeated"])
check("tidy(): leading run -> only the run itself is stripped",
      _new2["beats"][0]["say"], "it changed everything for me")

# 3. CTA trailing run, symmetric case.
_ad2b = {"delivery": "spoken", "hook": "open line", "cta": "grab one now",
         "beats": [beat(say="first beat"),
                  beat(say="so here is why you should grab one now")]}
_new2b, _fixed2b = S.tidy(_ad2b)
check("tidy(): cta trailing run -> fixed list names it", _fixed2b, ["cta_repeated"])
check("tidy(): cta trailing run -> only the run itself is stripped",
      _new2b["beats"][-1]["say"], "so here is why you should")

# 4. Partial overlap: hook_repeated trips on set-overlap, but the say does
#    not literally START with the hook's words in order -> left untouched.
_ad3 = {"delivery": "spoken", "hook": "today try this amazing trick right now",
        "cta": "grab one now",
        "beats": [beat(say="right now, try this amazing trick, seriously today"),
                 beat(say="closing line")]}
check("tidy(): partial overlap still counts as hook_repeated (set overlap >= 0.7)",
      S.hook_repeated(_ad3), True)
_new3, _fixed3 = S.tidy(_ad3)
check("tidy(): partial overlap -> nothing fixed (no clean leading run to strip)",
      _fixed3, [])
check("tidy(): partial overlap -> beat 1's say left exactly as it was",
      _new3["beats"][0]["say"], _ad3["beats"][0]["say"])

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("all checks passed")
