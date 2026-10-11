"""Offline checks for pipeline/brief_match.py, the pure glue that decides which agency brief a tracked post was made for. No network,
no Supabase, no model. Same check()/FAILS style as pipeline/test_post_match.py, whose scorer it reuses unmodified.

Every brand, script line, caption, brief and id below is invented for this test. No real brand, script, handle or caption from the
repo's data goes in this file: it is checked into a public repo.

Run with

    ./venv/bin/python pipeline/test_brief_match.py
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import brief_match as BM  # noqa: E402
import post_match as M  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


POSTED = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)
CFG = M.Cfg()
RANK_CFG = CFG._replace(per_script=10 ** 6)        # what the wiring uses for the brief lane: no link cap
BCFG = BM.Cfg()


def when(days_before):
    return (POSTED - timedelta(days=days_before)).isoformat().replace("+00:00", "Z")


def bid(n):
    return f"00000000-0000-4000-8000-00000000000{n}"


# One invented script, about an invented bottle.
HOOK = "your water bottle is lying about how cold it stays"
BEATS = ["i filled the quenchwell bottle with ice and left it in my hot car all afternoon",
         "six hours later the ice was still there and the water was freezing cold",
         "the lid seals tight so nothing leaks inside my gym bag either",
         "it fits my cup holder and it cleans in the dishwasher with no effort"]
CTA = "grab a quenchwell bottle before summer ends"
FULL = " ".join([HOOK] + BEATS + [CTA])
UNRELATED = ("welcome back everybody today i am going to tell you a long story about my week at the beach with my family and friends "
             "we ate far too much ice cream and then we all fell asleep in the sun")


def fmt(fid, delivery="spoken", hook="", beats=(), cta="", caption="", **junk):
    f = {"id": fid, "delivery": delivery, "hook": hook, "cta": cta, "caption": caption,
         "beats": [{"say": s} for s in beats]}
    f.update(junk)
    return f


def silent(fid, caption=""):
    return fmt(fid, "silent", "", ["", ""], "", caption)


def brief(n, client, group, days_before, formats, **junk):
    b = {"brief_id": bid(n), "client_name": client, "group": group, "sent_at": when(days_before), "formats": formats}
    b.update(junk)
    return b


def lanes(corpus, transcript, caption="", own=(), own_brands=(), has_speech=True, cfg=BCFG):
    """Both lanes over the same words, then the brief decision: what the wiring does for one post."""
    own, own_brands = list(own), list(own_brands)
    scored, decision, best = M.rank(own, own_brands, transcript, caption, has_speech, POSTED, CFG, {})
    ads, brands, meta = BM.corpus_entries(corpus)
    bscored, bdecision, bbest = M.rank(ads, brands, transcript, caption, has_speech, POSTED, RANK_CFG, {})
    res = BM.decide(scored, decision, best, {a["id"]: a for a in own}, bscored, bdecision, bbest, meta, cfg)
    return res, (scored, decision, best), (bscored, bdecision, bbest)


def own_script(aid, hook, beats, cta, from_agency=None, caption="", delivery="spoken"):
    e = {"id": aid, "status": "done", "brandId": "b1", "addedAt": when(3),
         "adaptation": {"delivery": delivery, "hook": hook, "cta": cta, "caption": caption,
                        "beats": [{"t": "0-3s", "say": s, "do": "", "show": ""} for s in beats]}}
    if from_agency:
        e["fromAgency"] = from_agency
    return e


OWN_BRANDS = [{"id": "b1", "name": "Quenchwell"}]

# ---- 1. corpus_entries ---------------------------------------------------------------------------
CORPUS1 = [brief(1, "Quenchwell", "campaign:c-1", 3,
                 [fmt("f-1", hook=HOOK, beats=BEATS, cta=CTA, caption="the only bottle i trust", note="private", setting="kitchen",
                      clip="clip.mp4", source_url="https://example.invalid/x"),
                  silent("f-2", "cold all day")],
                 note="agency note", source_url="https://example.invalid/b")]
ads, brands, meta = BM.corpus_entries(CORPUS1)
check("corpus: one entry per delivered format", len(ads), 2)
check("corpus: the id prefix and brandId", (ads[0]["id"].startswith(f"brief:{bid(1)}:"), ads[0]["brandId"]), (True, f"brief:{bid(1)}"))
check("corpus: addedAt is the delivery's sent_at", {a["addedAt"] for a in ads}, {when(3)})
check("corpus: a silent format is KEPT", sorted(a["adaptation"]["delivery"] for a in ads), ["silent", "spoken"])
check("corpus: beats carry `say` only", {tuple(b) for a in ads for b in a["adaptation"]["beats"]}, {("say",)})
check("corpus: one brand per brief, named for the client", brands, [{"id": f"brief:{bid(1)}", "name": "Quenchwell"}])
check("corpus: meta holds the ids, the group and a short format key",
      sorted((m["brief_id"], m["format_id"], m["group"], len(m["fkey"])) for m in meta.values()),
      [(bid(1), "f-1", "campaign:c-1", 12), (bid(1), "f-2", "campaign:c-1", 12)])
dumped = json.dumps(ads)
check("corpus: no note, setting, clip or source_url key reaches the scorer", [k for k in ("note", "setting", "clip", "source_url") if f'"{k}"' in dumped], [])
check("corpus: junk never raises", BM.corpus_entries([None, 5, {"brief_id": "nope"}, {"brief_id": bid(2), "formats": [None, {"id": ""}, 7]}]),
      ([], [{"id": f"brief:{bid(2)}", "name": ""}], {}))
check("corpus: not a list is empty", BM.corpus_entries(None), ([], [], {}))
check("corpus: a delivery sent twice is one brief", len(BM.corpus_entries(CORPUS1 + CORPUS1)[0]), 2)
check("fkey: stable and short", (BM.fkey("f-1") == BM.fkey("f-1"), len(BM.fkey("https://example.invalid/legacy"))), (True, 12))

# ---- 2. path script ------------------------------------------------------------------------------
copy = own_script("s-1", HOOK, BEATS, CTA, from_agency={"briefId": bid(1), "formatId": "f-1"})
res, (sc, dec, best), _ = lanes(CORPUS1, FULL, "new bottle from quenchwell", [copy], OWN_BRANDS)
check("path script: the script lane auto-links a library copy that carries fromAgency", dec, "auto")
check("path script: brief, format and script ids come from the copy", (res["path"], res["brief_id"], res["format_id"], res["adaptation_id"]),
      ("script", bid(1), "f-1", "s-1"))
check("path script: the score is the script score", res["score"], sc[0][1])
mine = own_script("s-2", HOOK, BEATS, CTA)
res, (sc, dec, best), _ = lanes(CORPUS1, FULL, "new bottle from quenchwell", [mine], OWN_BRANDS)
check("own script: it auto-links on its own", dec, "auto")
check("own script: an own script that wins makes no brief claim", (res["path"], res["brief_id"], res["adaptation_id"]), (None, None, None))

# ---- 3. path format ------------------------------------------------------------------------------
res, _, (bsc, bdec, bbest) = lanes(CORPUS1, FULL, "new bottle from quenchwell")
check("path format: the brief lane auto-links a delivered format read verbatim", bdec, "auto")
check("path format: the format and brief ids", (res["path"], res["brief_id"], res["format_id"], res["adaptation_id"]), ("format", bid(1), "f-1", None))
check("path format: the score is the brief lane's best", res["score"], bsc[0][1])

# ---- 4. path brief, three ways -------------------------------------------------------------------
SILENT2 = [silent("f-1", "cold all day no matter what"), silent("f-2", "something else entirely")]
res, _, (bsc, bdec, _) = lanes([brief(1, "Quenchwell", "campaign:c-1", 3, [silent("f-1"), silent("f-2")])], UNRELATED, "new bottle from quenchwell today")
check("path brief, client named in the caption: the two silent formats tie and cannot auto", (bdec, bsc[0][1] == bsc[1][1]), ("borderline", True))
check("path brief, client named in the caption: linked at brief level, format not known", (res["path"], res["brief_id"], res["format_id"]), ("brief", bid(1), None))
check("path brief, client named in the caption: the evidence is logged", (res["info"]["qualifying"], res["info"]["caption"], res["info"]["words"]), (1, True, False))

res, _, _ = lanes([brief(1, "Zorbly", "campaign:c-1", 3, SILENT2)], UNRELATED, "cold all day no matter the weather")
check("path brief, the suggested caption reused (Jaccard >= 0.25), the client unnamed: linked, format not known",
      (res["path"], res["brief_id"], res["format_id"], res["info"]["caption"]), ("brief", bid(1), None, True))

half = " ".join([HOOK] + BEATS[:2])
TWINS = [fmt("f-1", hook=HOOK, beats=BEATS, cta=CTA), fmt("f-2", hook=HOOK, beats=BEATS[:3] + ["it keeps my coffee hot for hours as well"], cta="get one today")]
res, _, (bsc, bdec, _) = lanes([brief(1, "Zorbly", "campaign:c-1", 3, TWINS)], half, "my week")
check("path brief, spoken containment: both formats read well and neither can auto", (bdec, all(r[2]["containment"] >= 0.45 for r in bsc)), ("borderline", True))
check("path brief, spoken containment: linked at brief level, the two close formats leave format_id None",
      (res["path"], res["brief_id"], res["format_id"], res["info"]["words"]), ("brief", bid(1), None, True))

# ---- 5. refused, one check each ------------------------------------------------------------------
res, _, _ = lanes([brief(1, "Quenchwell", "campaign:c-1", 25, [silent("f-1"), silent("f-2")])], UNRELATED, "new bottle from quenchwell today")
check("refused: delivered more than 21 days before the post", (res["path"], res["info"]["qualifying"]), (None, 0))

two = [brief(1, "Quenchwell", "campaign:c-1", 3, [silent("f-1")]), brief(2, "Zorbly", "campaign:c-2", 3, [silent("f-1")])]
res, _, _ = lanes(two, UNRELATED, "quenchwell and zorbly together")
check("refused: two campaign groups both have evidence", (res["path"], res["info"]["groups"], res["info"]["qualifying"]), (None, 2, 2))

blocker = own_script("s-3", HOOK, BEATS, CTA)
res, (sc, dec, _), (bsc, _, _) = lanes([brief(1, "Quenchwell", "campaign:c-1", 3, [silent("f-1"), silent("f-2")])], half, "new bottle from quenchwell today", [blocker], OWN_BRANDS)
check("refused: the own script reads well enough to be the answer (set up: not auto, scores at or above the brief's)",
      (dec, sc[0][1] >= max(BCFG.own_block, bsc[0][1])), ("borderline", True))
check("refused: the own-script block says so", (res["path"], res["info"]["own_block"]), (None, True))

res, _, _ = lanes([brief(1, "Zorbly", "campaign:c-1", 3, [silent("f-1", "alpha beta gamma"), silent("f-2", "delta epsilon")])], UNRELATED, "my week at the beach")
check("refused: no evidence at all", (res["path"], res["info"]["qualifying"], res["info"]["caption"], res["info"]["words"]), (None, 0, False, False))

# ---- 6. two briefs of ONE campaign group ---------------------------------------------------------
one = [brief(1, "Quenchwell", "campaign:c-1", 5, [silent("f-1", "cold all day")]),
       brief(2, "Quenchwell", "campaign:c-1", 2, [silent("f-1", "cold all day no matter what")])]
res, _, (bsc, _, _) = lanes(one, UNRELATED, "cold all day no matter the weather quenchwell")
check("one group: two sends of one campaign are one group, so it qualifies", (res["info"]["groups"], res["info"]["qualifying"]), (1, 1))
check("one group: the higher-scoring brief is linked", (res["path"], res["brief_id"]), ("brief", bid(2)))
tied = [brief(1, "Quenchwell", "campaign:c-1", 5, [silent("f-1", "cold all day")]),
        brief(2, "Quenchwell", "campaign:c-1", 2, [silent("f-1", "cold all day")])]
res, _, _ = lanes(tied, UNRELATED, "cold all day quenchwell")
check("one group: an exact tie goes to the later delivery", res["brief_id"], bid(2))

# ---- 7. format_id at brief level -----------------------------------------------------------------
LEAD = [fmt("f-1", hook=HOOK, beats=BEATS, cta=CTA),
        fmt("f-2", hook="three clothes i keep re-wearing", beats=["every sunday i photograph what i wore", "then i tag it by colour"], cta="try it")]
lead_said = " ".join([HOOK] + BEATS[:3]) + " and that is the whole thing"
res, _, (bsc, bdec, _) = lanes([brief(1, "Zorbly", "campaign:c-1", 3, LEAD)], lead_said, "my week")
top, nxt = bsc[0], bsc[1]
check("format at brief level: set up as not auto, the top format leads by 0.20+ with containment 0.65+",
      (bdec, round(top[1] - nxt[1], 3) >= BCFG.fmt_margin, top[2]["containment"] >= BCFG.fmt_contain), ("borderline", True, True))
check("format at brief level: format_id is set", (res["path"], res["format_id"]), ("brief", "f-1"))

# ---- 8. determinism ------------------------------------------------------------------------------
a1 = lanes([brief(1, "Quenchwell", "campaign:c-1", 3, [silent("f-1"), silent("f-2")])], UNRELATED, "new bottle from quenchwell today")[0]
a2 = lanes([brief(1, "Quenchwell", "campaign:c-1", 3, [silent("f-1"), silent("f-2")])], UNRELATED, "new bottle from quenchwell today")[0]
check("determinism: two runs, identical output", json.dumps(a1, sort_keys=True), json.dumps(a2, sort_keys=True))
check("info: numbers, booleans and short ids only (no caption or word)", [k for k in ("quenchwell", "bottle") if k in json.dumps(a1["info"]).lower()], [])

# ---- 9. isolation --------------------------------------------------------------------------------
for name in ("brain.py", "coach.py", "brain_prompt.py", "coach_prose.py", "post_shape.py", "process_campaigns.py"):
    src = (HERE / name).read_text()
    check(f"isolation: {name} names neither the table nor the module", ("lynxr_post_briefs" in src, "brief_match" in src), (False, False))

if FAILS:
    print(f"\n{len(FAILS)} FAILED: " + ", ".join(FAILS))
    sys.exit(1)
print("all checks passed")
