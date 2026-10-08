#!/usr/bin/env python3
"""The coach's prose pass: one Haiku call per VIDEO whose measured facts changed, to say those facts in plain words, spoken to the creator.

Plan: ~/.claude/plans/lynxr-coach-v1.md, "Noticed, not planned" (the model pass that rewrites the templated sentences), shipped on the owner's
2026-10-07 amendment ("ship the Haiku prose pass, not templates") on these terms, which are the whole design:

    THE MODEL IS A COPY EDITOR, NOT AN ANALYST. It receives ONLY the measured facts about one video (coach.facts_for: counts, the readings'
    days, the sentence about how the views moved, the verdict against the creator's own usual, the moments in the audio with their second).
    It rewrites them. It never analyses, infers, compares or adds. Today's eval showed that giving a model more context reliably raises
    unbacked claims, so it is given nothing but the facts: no caption, no transcript, no script, no other video, no creator.

    EVERY NUMBER IN THE OUTPUT MUST APPEAR IN THE INPUT, checked in code (coach.prose_ok), along with a list of words that claim something the
    facts do not: an audience, a platform, an algorithm, a cause, a curve, a number spelled out. A rewrite that fails any test is DROPPED and
    the templated sentence (`line`, plus the moments, which the app shows regardless) stands. test_coach_prose.py drives that fallback.

    CACHED PER VIDEO. The note keeps `prose_key`, a fingerprint of the facts the prose was made from. A build whose facts are unchanged reuses
    the prose (and the fact that a rewrite was already tried and refused), so a repeat render costs nothing. Facts change only when a new
    reading lands (about days 1, 3, 7 and 30), so a video costs at most about five calls in its life.

    NO DROP-OFF, RETENTION OR CURVE LANGUAGE. /privacy/ and the live copy must not imply a per-second curve; no platform gives lynxr one.

CREATOR-SIDE ONLY. Nothing here may be imported by pipeline/process_campaigns.py or reach AGENCY_SCRIPT_SYSTEM.

COST. Haiku 4.5, about 250 tokens of system prompt plus about 120 of facts in, about 70 out: about $0.0006 a call at $1/$5 per million. The
measured figure for a real call is printed by `coach.py --print UUID --prose` and recorded per call in lynxr_costs (id8 "coach"). It never
runs while COACH is off, because the coach builds no note then; COACH_PROSE=0 turns this pass off on its own.
"""
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import coach as C  # noqa: E402
import envcfg  # noqa: E402
import process_adaptations as P  # noqa: E402

log = logging.getLogger("coach_prose")

COACH_PROSE = envcfg.get("COACH_PROSE", "1") not in ("0", "", "false", "False")           # the pass; it only runs inside a coach build (COACH=1)
COACH_PROSE_MODEL = envcfg.get("COACH_PROSE_MODEL", "claude-haiku-4-5")
COACH_PROSE_PER_BUILD = int(envcfg.get("COACH_PROSE_PER_BUILD", "3"))                      # calls made for one creator in one build, newest video first

# ~250 tokens: well under P.CACHE_MIN_TOKENS (512), so a cache_control marker would be silently ignored. It is therefore NOT wrapped in
# P.sys_block(). No `output_config.effort` and no `thinking`: Haiku 4.5 rejects the first and is not an adaptive-thinking model.
PROSE_SYSTEM = """You rewrite a short list of MEASURED FACTS about one video a creator posted, as plain sentences spoken to that creator.

You are a copy editor, not an analyst. The facts are the whole of what is known.

Rules:
- Use only the facts. Do not infer, explain, guess, compare, advise or add anything. If something is not in the facts, it is not known.
- Every number you write must be copied exactly as it appears in the facts. Do not round, convert, add up, or write a number as a word
  (write "a week in" as the facts do, never "one-week" or "one week").
- Write multiples as the facts do, for example "1.9× your own usual"; never "1.9 times stronger".
- Keep every moment from the audio, with its second.
- Say "you" and "your". Short sentences, plain words.
- Never mention viewers, an audience, followers, a platform, an app, an algorithm, a trend, watch time, retention, or why anything happened.
- Say a video did well or badly only if a fact says it was stronger or weaker than the creator's usual.
- No lists, no headings, no quotation marks, no emoji. Two or three sentences, under 60 words."""


def prose_content(facts):
    """The user message: the facts, one per line, and nothing else."""
    return "Facts about one video:\n" + str(facts).strip() + "\n\nWrite it up."


def prose_line(aclient, facts, key=None, usage_out=None):
    """(text, tally): one Haiku call over `facts`. `text` is the model's raw answer, or None when the call failed. NEVER RAISES. The answer is
    NOT yet trusted: the caller runs coach.prose_ok on it. `tally` is the usage dict (empty when the call failed), also written to
    lynxr_costs when `key` is given and added to `usage_out` when that is."""
    try:
        msg = aclient.messages.create(
            model=COACH_PROSE_MODEL, max_tokens=200, temperature=0, system=PROSE_SYSTEM,
            messages=[{"role": "user", "content": prose_content(facts)}])
        u = getattr(msg, "usage", None)
        tally = {COACH_PROSE_MODEL: {"in": int(getattr(u, "input_tokens", 0) or 0), "out": int(getattr(u, "output_tokens", 0) or 0),
                                     "write": int(getattr(u, "cache_creation_input_tokens", 0) or 0),
                                     "read": int(getattr(u, "cache_read_input_tokens", 0) or 0), "calls": 1}}
        if usage_out is not None:
            for model, d in tally.items():
                t = usage_out.setdefault(model, {"in": 0, "out": 0, "write": 0, "read": 0, "calls": 0})
                for k, v in d.items():
                    t[k] += v
        if key:
            P.record_cost(key, "coach", True, tally)
        return P.first_text(msg), tally
    except Exception as e:  # noqa: BLE001
        log.info("coach: prose unavailable (%s)", type(e).__name__)        # the type only: never the facts, never the text
        return None, {}


def wanted(note):
    """The post entries that need a rewrite now, newest first, at most COACH_PROSE_PER_BUILD: those with facts and no `prose_key` (a video
    whose facts are unchanged since the last note already carries one, and so costs nothing)."""
    if not isinstance(note, dict):
        return []
    return [e for e in note.get("posts") or [] if e.get("_facts") and not e.get("prose_key")][:COACH_PROSE_PER_BUILD]


def apply(note, get_client, key=None, usage_out=None):
    """Fill `prose` and `prose_key` on the entries that need it. Returns {"prose": kept, "prose_dropped": refused by the check,
    "prose_failed": call failed}. A failed CALL leaves the entry untouched (it is tried again next build); a REFUSED answer sets prose_key
    anyway, because the same facts would be refused again. Never raises, and never blocks the note."""
    stats = {"prose": 0, "prose_dropped": 0, "prose_failed": 0}
    if not COACH_PROSE:
        return stats
    todo = wanted(note)
    if not todo:
        return stats
    client = get_client()
    if client is None:
        log.info("coach: prose unavailable (no client)")
        stats["prose_failed"] = len(todo)
        return stats
    for e in todo:
        text, tally = prose_line(client, e["_facts"], key=key, usage_out=usage_out)
        if text is None:
            stats["prose_failed"] += 1
            continue
        ok, out = C.prose_ok(text, e["_facts"])
        e["prose_key"] = C.facts_key(e["_facts"])
        if ok:
            e["prose"] = out
            stats["prose"] += 1
        else:
            stats["prose_dropped"] += 1
            log.info("coach: prose refused (%s)", re.sub(r"[^a-z -]", "", str(out).lower())[:40])      # why, never what
    return stats
