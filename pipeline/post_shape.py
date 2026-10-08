#!/usr/bin/env python3
"""The shape lane: for each video a creator posted on a profile they verified, download its audio, measure WHEN things are said, and keep
the numbers. The coach (pipeline/coach.py) reads them to say where in the video something happened.

Plan: ~/.claude/plans/lynxr-coach-v1.md (steps 3 and 4, plus the 2026-10-07 "where in the video must be real" amendment). The table and its
rules are supabase/post_shape.sql (owner SQL). The same download-transcribe-measure path as pipeline/post_match.py's lane
(track_posts.match_evaluate), with one difference: that one asks "which script is this?", this one asks "when was what said?".

WHAT IT DOES, IN ORDER (one pass: due -> download -> transcribe -> measure -> write)
    DUE. Tracked posts younger than COACH_SHAPE_DAYS in state `pending`, or `failed` and past their wait and under the cap, or `ok` but
        linked to a script AFTER they were shaped (the beat times were measured against nothing, or a different script). Merged in
        Python from separate reads, never one or= clause (track_posts.match_due's docstring says why).
    MEASURE. features() below, pure. Seconds before anyone speaks, words in the first three seconds, the longest stretch with nobody
        speaking, the length, the second the line with the most numbers and names in it starts (`best_line_at_s`); and when the post is
        linked to one of the creator's own scripts, the second at which each beat of THAT script was said (the payoff beat flagged, when
        the script's format names exactly one), and the stretches where the creator says again what they already said.
    NOT MEASURED, ON PURPOSE: "sentences that serve nothing" (a beat that pays off none of the hook's promise). That is a judgement about
        meaning; a word-overlap stand-in would be an approximation presented as a measurement, and it needs a model call to do honestly.
    WRITE. One lynxr_post_shape row, then the post's state.

NUMBERS ONLY. THE TRANSCRIPT LIVES IN ONE LOCAL AND IS DELETED BEFORE THE FUNCTION RETURNS. features() takes the words as an argument,
counts and times them, and returns numbers; nothing it returns holds a word of the transcript or of the script. A beat is stored as its
index and two second marks, and the app looks the beat up in the creator's own script by that index. test_post_shape.py proves it by
serialising a result and looking for every invented word.

"NOBODY IS SPEAKING" IS NOT "SILENT". Whisper's voice-activity filter (on the Fly worker) drops music and noise as well as quiet, so a
gap between two segments means no SPEECH, not no sound. The column keeps the name `longest_silence_s` for the plan's sake; every sentence
the coach writes about it says "without anyone speaking".

COST $0. yt-dlp audio is free, Whisper runs on the worker, no Apify, no model call. Audio only: no shot or cut detection.

CREATOR-SIDE ONLY. Nothing in this file may be imported by pipeline/process_campaigns.py or reach AGENCY_SCRIPT_SYSTEM.

FLY ONLY. Runs inside track_posts.py's pass. NEVER add it to .github/workflows/adaptations.yml. shape_pass() is handed the RUNNING
track_posts module as `T`; this file does not import track_posts at module level (it runs as __main__, so a second copy would have its own
Apify budget counters; see insights.py). Only main() below, a separate entry point, imports it.

CREATORS FIRST. P.queued_work(key) is asked before every post; a queued script ends the pass at once. Posts are taken max -> pro -> free.

PRIVACY OF THE LOG. Counts only: never a handle, a caption, a URL, a word or a full uuid.

RUN
    ./venv/bin/python pipeline/post_shape.py --dry-run          # reads the database, counts what is due; downloads nothing, writes nothing
    ./venv/bin/python pipeline/post_shape.py --print POST_ID    # the whole path for one stored post, printed; writes NOTHING. One free
                                                                # audio download and one local Whisper pass.
    ./venv/bin/python pipeline/post_shape.py --print POST_ID --words   # also prints the transcript with its times, so the first-word
        # second can be checked against the video by ear. It is the creator's own words: keep it off any public surface.
"""
import argparse
import json
import logging
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import envcfg  # noqa: E402
import post_match as M  # noqa: E402 -- norm_words only; stdlib plus script_checks, no network

log = logging.getLogger("post_shape")

COACH_SHAPE = envcfg.get("COACH_SHAPE", "1") not in ("0", "", "false", "False")          # the lane; ON, because it only writes numbers
COACH_SHAPE_PER_PASS = int(envcfg.get("COACH_SHAPE_PER_PASS", "2"))                      # posts attempted per pass
COACH_SHAPE_BUDGET_S = float(envcfg.get("COACH_SHAPE_BUDGET_S", "240"))                  # no new attempt starts past this many seconds in the lane
COACH_SHAPE_MAX_SEC = float(envcfg.get("COACH_SHAPE_MAX_SEC", "300"))                    # a downloaded file longer than this is skipped, not transcribed
COACH_SHAPE_RETRY_H = float(envcfg.get("COACH_SHAPE_RETRY_H", "12"))                     # a failed post waits this long before another try
COACH_SHAPE_MAX_FAILS = int(envcfg.get("COACH_SHAPE_MAX_FAILS", "3"))                    # then it stays failed for good
COACH_SHAPE_DAYS = float(envcfg.get("COACH_SHAPE_DAYS", "60"))                           # a post older than this is never shaped

POSTS = "/rest/v1/lynxr_posts"
SHAPES = "/rest/v1/lynxr_post_shape"
POST_FIELDS = "id,creator_id,platform,url,posted_at,shape_fails,adaptation_id"

MAX_BEATS = 24            # the table's check constraint
MAX_REPEATS = 12          # ... and this one
MIN_UNIT_WORDS = 3        # a script beat with fewer content words than this cannot be located by its words (a one-word punchline, a visual beat)
MIN_COVER = 0.5           # at least half of a beat's content words must be heard, in time order, for the beat to count as said
COVER_SLACK = 0.05        # among windows this close to the best coverage, the EARLIEST wins (a later restatement must not move a beat)
MAX_SPAN = 3              # a beat is looked for in a run of at most this many consecutive transcript segments
REPEAT_MIN_WORDS = 4      # a segment needs this many content words before it can be "said again"
REPEAT_SHARED = 3         # ... and the two stretches must share at least this many
REPEAT_JACCARD = 0.6      # ... and at least this share of the words in their union
BEST_LINE_MIN = 2         # a line needs at least this many specifics (numbers, names) before it is called the most specific one
PAYOFF_ROLE = re.compile(r"payoff|pay-off|reveal|punchline|punch line|twist|climax", re.I)    # the words a FORMAT beat's role uses for "where it pays off"
NUMBER_WORDS = frozenset("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen "
                         "nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion first second third".split())


# ── pure ──────────────────────────────────────────────────────────────────────────────────────────

def _seg_ok(s):
    """A transcript segment is [start, end, text] with real numbers and end >= start."""
    if not isinstance(s, (list, tuple)) or len(s) < 3:
        return False
    try:
        a, b = float(s[0]), float(s[1])
    except (TypeError, ValueError):
        return False
    return a >= 0 and b >= a


def planned_start(t):
    """The first number of a script beat's timing ("0-3s" -> 0.0, "3-8s" -> 3.0), or None when it has none."""
    m = re.match(r"\s*(\d+(?:\.\d+)?)", str(t or ""))
    return float(m.group(1)) if m else None


def payoff_index(script, n_beats):
    """The 1-based number of the script beat that is the PAYOFF, or None. The role of a beat lives on the FORMAT the script was adapted from
    (entry["format"]["beats"][k]["role"]), not on the script's own beats, so the two lists must line up one for one: when they have different
    lengths no beat can honestly be called the payoff and None is returned. Exactly one format beat must name a payoff in its role
    (PAYOFF_ROLE); none or several is ambiguous, and an ambiguous payoff is not measured. Only the NUMBER of the beat is used: the role's
    words are never stored."""
    fmt = (script or {}).get("format") if isinstance(script, dict) else None
    roles = [str((b or {}).get("role") or "") for b in ((fmt or {}).get("beats") or []) if isinstance(b, dict)] if isinstance(fmt, dict) else []
    if not roles or len(roles) != n_beats:
        return None
    hit = [k for k, r in enumerate(roles, 1) if PAYOFF_ROLE.search(r)]
    return hit[0] if len(hit) == 1 else None


def script_units(script):
    """The parts of a script a transcript can be lined up against, in order: [{"i", "of", "kind", "words", "planned_s"}]. `script` is one
    adaptation ENTRY (the thing with an `id` and an `adaptation`), as lynxr_creators.data stores it. A silent script has nothing spoken, so
    it has no units. The closing call to action is the last unit and carries no `i`."""
    ad = (script or {}).get("adaptation") if isinstance(script, dict) else None
    if not isinstance(ad, dict) or ad.get("delivery") == "silent":
        return []
    beats = [b for b in (ad.get("beats") or []) if isinstance(b, dict)][:MAX_BEATS]
    pay = payoff_index(script, len(beats))
    units = [{"i": n, "of": len(beats), "kind": "beat", "words": M.norm_words(b.get("say")), "planned_s": planned_start(b.get("t")),
              "payoff": n == pay} for n, b in enumerate(beats, 1)]
    cta = M.norm_words(ad.get("cta"))
    if cta:
        units.append({"i": None, "of": len(beats), "kind": "cta", "words": cta, "planned_s": None})
    return units


def align(segs, units):
    """Where each script unit was said: one dict per unit that has at least MIN_UNIT_WORDS content words, in script order.

    A found unit is {"i", "of", "kind", "start_s", "end_s", "planned_s"}; one the audio does not contain is {"i", "of", "kind", "found":
    False}. Numbers and indexes only. Units are looked for in TIME ORDER (a unit is searched only after the one before it): a creator who
    reorders their script gets "not found" for the moved line rather than a wrong time, which is the safe direction.

    A unit matches a run of up to MAX_SPAN consecutive segments when at least MIN_COVER of its content words are heard in the run and at
    least two are, and the run starts AND ends on a segment that carries one of them (so the start second is a second where a word of the
    beat was actually said). Among runs within COVER_SLACK of the best coverage, the earliest and then the shortest wins."""
    sets = [set(M.norm_words(s[2])) for s in segs]
    out, cursor = [], 0
    for u in units:
        uw = set(u["words"])
        if len(uw) < MIN_UNIT_WORDS:
            continue
        cands = []
        for a in range(cursor, len(segs)):
            if not (uw & sets[a]):
                continue
            have = set()
            for b in range(a, min(a + MAX_SPAN, len(segs))):
                have |= sets[b]
                if not (uw & sets[b]):
                    continue
                got = len(uw & have)
                if got >= 2 and got / len(uw) >= MIN_COVER:
                    cands.append((got / len(uw), a, b))
        row = {"i": u["i"], "of": u["of"], "kind": u["kind"]} if u["kind"] == "beat" else {"of": u["of"], "kind": u["kind"]}
        if u.get("payoff"):
            row["payoff"] = True
        if cands:
            top = max(c[0] for c in cands)
            _, a, b = min((c for c in cands if c[0] >= top - COVER_SLACK), key=lambda c: (c[1], c[2] - c[1]))
            row["start_s"], row["end_s"] = round(float(segs[a][0]), 1), round(float(segs[b][1]), 1)
            if u["planned_s"] is not None:
                row["planned_s"] = round(u["planned_s"], 1)
            cursor = b + 1
        else:
            row["found"] = False
        out.append(row)
    return out


def repeats(segs):
    """Stretches of speech that say again what an earlier stretch said: [{"at_s", "of_s"}] (the second the repeat starts, the second of the
    earlier one it repeats), at most MAX_REPEATS. A segment counts when it has at least REPEAT_MIN_WORDS content words and shares at least
    REPEAT_SHARED of them with an earlier one, covering REPEAT_JACCARD of the two together. Content words only (fillers and function words
    are gone), so it finds a line said twice, not a topic returned to. Two second marks per repeat, never a word."""
    sets = [set(M.norm_words(s[2])) for s in segs]
    out = []
    for j in range(1, len(segs)):
        if len(sets[j]) < REPEAT_MIN_WORDS:
            continue
        for i in range(j):
            if len(sets[i]) < REPEAT_MIN_WORDS:
                continue
            shared = len(sets[i] & sets[j])
            if shared >= REPEAT_SHARED and shared / len(sets[i] | sets[j]) >= REPEAT_JACCARD:
                out.append({"at_s": round(float(segs[j][0]), 1), "of_s": round(float(segs[i][0]), 1)})
                break
        if len(out) >= MAX_REPEATS:
            break
    return out


def specifics(text):
    """How many specifics a line carries: each number (a digit, or a number word) and each name (a capitalised word that is not the first of its
    sentence and is not "I"). A count, nothing else: the line itself is never kept. It is the plan's "line carrying the numbers and names" measure,
    chosen because it needs no other video and no model: rarity against the creator's OTHER posts would need their words kept, which this
    pipeline does not do."""
    n, start = 0, True
    for tok in str(text or "").split():
        word = re.sub(r"^[^\w]+|[^\w']+$", "", tok)
        if word:
            if re.search(r"\d", word) or word.lower() in NUMBER_WORDS:
                n += 1
            elif not start and word[0].isupper() and word != "I" and not word.startswith("I'") and len(word) > 1:
                n += 1
        start = tok[-1:] in ".!?"
    return n


def best_line(segs):
    """The second the line with the most specifics STARTS (rounded to 0.1), or None when no line has BEST_LINE_MIN of them. Ties go to the
    earliest line, so a creator is never marked later than they were. Never a word of the line."""
    best = None
    for s in segs:
        n = specifics(s[2])
        if n >= BEST_LINE_MIN and (best is None or n > best[0]):
            best = (n, float(s[0]))
    return round(best[1], 1) if best else None


def features(t, duration_s, script=None):
    """The numbers measured from one transcribed video: {has_speech, segments, [duration_s], [speech_start_s], [words_first_3s],
    [longest_silence_s, longest_silence_at_s], [best_line_at_s], [aligned_to, beats], [repeats]}. PURE: no network, no clock.

    A key whose input is missing is OMITTED, never nulled (brain.py's standing rule): a music-only video has no speech shape, and a
    `speech_start_s: 0` there would be a lie the whole separation maths would believe.

    `t` is transcribe.transcribe()'s dict. `script` is the adaptation entry the post is linked to, or None."""
    t = t if isinstance(t, dict) else {}
    segs = [s for s in (t.get("segments") or []) if _seg_ok(s)]
    row = {"has_speech": bool(t.get("has_speech")), "segments": len(segs)}
    if isinstance(duration_s, (int, float)) and not isinstance(duration_s, bool) and duration_s > 0:
        row["duration_s"] = round(float(duration_s), 1)
    if not row["has_speech"] or not segs:
        return row
    row["speech_start_s"] = round(float(segs[0][0]), 1)
    # `hook_spoken` is exactly the segments that START under transcribe.HOOK_SECONDS, so there is nothing to re-derive: count its words and
    # let the string go in the same expression.
    row["words_first_3s"] = len(str(t.get("hook_spoken") or "").split())
    line_at = best_line(segs)
    if line_at is not None:
        row["best_line_at_s"] = line_at
    if len(segs) > 1:
        gap, at = max(((float(segs[i + 1][0]) - float(segs[i][1]), float(segs[i][1])) for i in range(len(segs) - 1)), key=lambda g: g[0])
        row["longest_silence_s"], row["longest_silence_at_s"] = round(max(gap, 0.0), 1), round(at, 1)
    if script is not None:
        if script.get("id"):
            row["aligned_to"] = str(script["id"])[:100]
        beats = align(segs, script_units(script))
        if beats:
            row["beats"] = beats
    rep = repeats(segs)
    if rep:
        row["repeats"] = rep
    return row


# ── due set ───────────────────────────────────────────────────────────────────────────────────────

def shape_due(T, key, now):
    """The tracked posts to shape now, newest first: `pending` ones, then `failed` ones past their wait and under the cap, then `ok` ones
    whose script link is newer than their numbers. Separate reads merged here. A 400 or a 404 means supabase/post_shape.sql is not
    applied: one INFO line and []."""
    horizon = T.q(T.iso(now - timedelta(days=COACH_SHAPE_DAYS)))
    tail = (f"&origin=eq.tracked&posted_at=gt.{horizon}&select={POST_FIELDS}&order=posted_at.desc.nullslast"
            f"&limit={COACH_SHAPE_PER_PASS * 4}")
    reads = (f"{POSTS}?shape_state=eq.pending{tail}",
             f"{POSTS}?shape_state=eq.failed&shape_fails=lt.{COACH_SHAPE_MAX_FAILS}"
             f"&shape_at=lt.{T.q(T.iso(now - timedelta(hours=COACH_SHAPE_RETRY_H)))}{tail}")
    out, seen = [], set()
    for path in reads:
        status, rows = T.rest(key, path)
        if status in (400, 404):
            log.info("shape: lynxr_posts.shape_state missing — is supabase/post_shape.sql applied?")
            return []
        if status != 200 or not isinstance(rows, list):
            return out
        for r in rows:
            if isinstance(r, dict) and r.get("id") is not None and r["id"] not in seen:
                seen.add(r["id"])
                out.append(r)
    # A post shaped before it was linked to a script has no beat times. The shape row says which script its beats were measured
    # against; a different answer means it is due again. shape_at is the retry wait, exactly as for a failure.
    status, linked = T.rest(key, f"{POSTS}?shape_state=eq.ok&adaptation_id=not.is.null&shape_at=lt.{T.q(T.iso(now - timedelta(hours=COACH_SHAPE_RETRY_H)))}{tail}")
    if status == 200 and isinstance(linked, list) and linked:
        ids = ",".join(str(r["id"]) for r in linked if isinstance(r, dict) and isinstance(r.get("id"), int))
        status, have = T.rest(key, f"{SHAPES}?post_id=in.({ids})&select=post_id,aligned_to") if ids else (0, None)
        if status == 200 and isinstance(have, list):
            aligned = {h.get("post_id"): h.get("aligned_to") for h in have if isinstance(h, dict)}
            for r in linked:
                if (isinstance(r, dict) and r.get("id") not in seen and aligned.get(r["id"]) != r.get("adaptation_id")):
                    seen.add(r["id"])
                    out.append({**r, "_realign": True})
    return out


def script_of(T, key, post, blobs):
    """(script entry or None, readable). The adaptation entry the post is linked to, from the creator's own data, cached for the pass.
    readable is False when the database could not be read (a transient error: nothing should be concluded from it)."""
    aid = post.get("adaptation_id")
    if not aid:
        return None, True
    cid = post.get("creator_id")
    if cid not in blobs:
        st, rows = T.rest(key, f"/rest/v1/lynxr_creators?id=eq.{T.q(cid)}&select=data")
        if st != 200 or not isinstance(rows, list):
            return None, False
        data = (rows[0].get("data") if rows and isinstance(rows[0], dict) else None) or {}
        blobs[cid] = {a.get("id"): a for a in (data.get("adaptations") or []) if isinstance(a, dict) and a.get("id")}
    return blobs[cid].get(aid), True


def measure(T, key, post, blobs):
    """The read / download / transcribe / measure path for one post. Writes nothing. Returns {"kind": ...} where kind is one of unreadable
    (the database failed: record nothing), skipped, fetch_failed, too_long, or measured (with `row` and, for --print, `segments`). The
    transcript lives in this function's locals and is gone when it returns, unless keep_words is asked for by --print."""
    return _measure(T, key, post, blobs, keep_words=False)


# Signals whose meaning depends on the WHOLE timeline. Dropped when the downloaded audio is longer than the video,
# because then they describe the sound, not the post.
TIMELINE_SIGNALS = ("speech_start_s", "longest_silence_s", "longest_silence_at_s", "best_line_at_s")


def reported_duration(T, url):
    """How long the PLATFORM says the video is, or None. yt-dlp knows this from the metadata and does not need the file.

    WHY NOT JUST MEASURE THE FILE. On TikTok `-f bestaudio` frequently returns the full original SOUND rather than the
    post's own audio, so the file is the length of the song. Measured 2026-10-08 on two real posts: TikTok reported
    26s and 24s, the downloaded audio ran 176.4s and 100.8s, and the same videos cross-posted to Instagram measured
    26.5s and 24.6s. Duration feeds the coach's only working advice ("keep it to about 14 seconds"), so taking it from
    the file meant comparing a creator's videos against the length of whatever music they used."""
    try:
        r = T.P.subprocess.run(
            [T.P.yt_dlp_bin(), "-q", "--no-warnings", "--no-cache-dir", "--skip-download",
             "--socket-timeout", "20", "--print", "%(duration)s", url],
            capture_output=True, text=True, timeout=60)
        v = float((r.stdout or "").strip().splitlines()[0])
        return v if v > 0 else None
    except Exception:  # noqa: BLE001 — metadata is a nicety; the file length is the fallback
        return None


def _measure(T, key, post, blobs, keep_words):
    script, readable = script_of(T, key, post, blobs)
    if not readable:
        return {"kind": "unreadable"}
    if not T.post_url_ok(post.get("url"), post.get("platform")):
        return {"kind": "skipped"}
    with tempfile.TemporaryDirectory() as td:
        media, _err = T.P.fetch_audio(post["url"], Path(td))     # no Apify fallback, by rule: a post yt-dlp cannot get is failed
        if not media:
            return {"kind": "fetch_failed"}
        file_dur = T.P.media_duration(media)
        said = reported_duration(T, post["url"])
        dur = said or file_dur
        if dur and dur > COACH_SHAPE_MAX_SEC:
            return {"kind": "too_long"}
        # The audio is longer than the video: it is the sound, not the post. Keep the honest duration, drop every
        # reading whose seconds would refer to a timeline the viewer never saw.
        overran = bool(said and file_dur and file_dur > max(said * 1.5, said + 5))
        t = T.P.transcribe(str(media), T.P.WHISPER_MODEL)
        row = features(t, dur, script)
        if overran:
            for k in TIMELINE_SIGNALS:
                row.pop(k, None)
            # No flag column for this, and inventing one would 400 the write. The ABSENCE of the timeline readings
            # is the record: the coach only ever speaks from readings that are present.
            log.info("shape: post %s audio ran %.0fs for a %.0fs video — timeline signals dropped",
                     post.get("id"), file_dur, said)
        if post.get("adaptation_id") and "aligned_to" not in row:
            row["aligned_to"] = str(post["adaptation_id"])[:100]   # looked up and measured against: do not shape it again for the same link
        out = {"kind": "measured", "row": row, "script": script is not None}
        if keep_words:
            out["segments"] = t.get("segments") or []
        del t
    return out


def shape_one(T, key, post, now, stats, blobs):
    """Shape one stored post and record the outcome. Never raises."""
    where = f"{POSTS}?id=eq.{T.q(post.get('id'))}"
    now_iso = T.iso(now)
    realign = bool(post.get("_realign"))

    def state(s):
        return {"shape_state": s, "shape_at": now_iso, "shape_fails": int(post.get("shape_fails") or 0) + 1}

    def fail(s="failed"):
        # A post that is already shaped is never demoted by a failed second look: only the wait is stamped.
        T.rest(key, where, method="PATCH", body={"shape_at": now_iso} if realign else state(s), prefer="return=minimal")

    try:
        r = measure(T, key, post, blobs)
        kind = r["kind"]
        if kind == "unreadable":
            return
        if kind == "fetch_failed":
            fail()
            stats["shape_failed"] += 1
            return
        if kind in ("skipped", "too_long"):
            fail("skipped" if kind == "skipped" else "too_long")
            stats["shape_skipped"] += 1
            return
        row = {**r["row"], "post_id": post["id"], "creator_id": post["creator_id"], "whisper": str(T.P.WHISPER_MODEL)[:80],
               "built_at": now_iso}
        st, _ = T.rest(key, f"{SHAPES}?on_conflict=post_id", method="POST", body=row,
                       prefer="resolution=merge-duplicates,return=minimal")
        if st not in (200, 201, 204):
            fail()
            stats["shape_failed"] += 1
            return
        T.rest(key, where, method="PATCH", body={"shape_state": "ok", "shape_at": now_iso, "shape_fails": 0}, prefer="return=minimal")
        stats["shaped"] += 1
    except Exception as e:  # noqa: BLE001 -- a broken lane must never stop the rest of the pass
        log.warning("shape: one post failed (%s)", type(e).__name__)
        stats["shape_failed"] += 1
        try:
            fail()
        except Exception:  # noqa: BLE001
            pass


def shape_pass(key, now, dry=False, T=None):
    """One pass of the lane. `T` is the RUNNING track_posts module (see the docstring). Returns the counts, or {} when the lane is off or has
    no module to borrow."""
    if not COACH_SHAPE or T is None:
        return {}
    stats = {"shape_due": 0, "shaped": 0, "shape_failed": 0, "shape_skipped": 0}
    due = shape_due(T, key, now)
    stats["shape_due"] = len(due)
    if dry:
        return stats                                           # before any download
    blobs, started, cache = {}, time.monotonic(), {}
    for post in T.by_tier(due, key, cache)[:COACH_SHAPE_PER_PASS]:
        if T.P.queued_work(key) or time.monotonic() - started >= COACH_SHAPE_BUDGET_S:
            break
        shape_one(T, key, post, now, stats, blobs)
    log.info("shape: due %d · shaped %d · failed %d · skipped %d", stats["shape_due"], stats["shaped"], stats["shape_failed"],
             stats["shape_skipped"])
    return stats


# ── by hand ───────────────────────────────────────────────────────────────────────────────────────

def print_post(T, key, post_id, words=False):
    """The whole path for ONE stored post, printed. Reads the database, never writes it. Returns the exit code."""
    # Not POST_FIELDS: shape_fails only exists once supabase/post_shape.sql is applied, and this read-only path must work before that.
    st, rows = T.rest(key, f"{POSTS}?id=eq.{T.q(post_id)}&select=id,creator_id,platform,url,posted_at,adaptation_id")
    if st != 200 or not isinstance(rows, list) or not rows:
        print(f"no such post (HTTP {st}), or lynxr_posts is not readable")
        return 2
    post = rows[0]
    r = _measure(T, key, post, {}, keep_words=words)
    kind = r["kind"]
    if kind != "measured":
        print({"unreadable": "the creator's scripts could not be read",
               "skipped": "the post link is not a plain https link on its own platform",
               "fetch_failed": "the audio could not be fetched",
               "too_long": f"longer than {COACH_SHAPE_MAX_SEC:.0f}s: skipped, not transcribed"}[kind])
        return 1
    row = r["row"]
    print(json.dumps(row, indent=2))
    print(f"(linked script: {'found' if r['script'] else 'none' if not post.get('adaptation_id') else 'NOT FOUND in the creator data'}; nothing was written)")
    if words:
        print("# warning: the lines below are the creator's own words. Keep them off any public surface.")
        for s in r.get("segments") or []:
            print(f"  {float(s[0]):6.1f} - {float(s[1]):6.1f}  {s[2]}")
    return 0


def main():
    envcfg.sanitize_environ()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="read-only: count what is due; downloads nothing and writes nothing")
    ap.add_argument("--print", dest="post_id", type=int, metavar="POST_ID",
                    help="the whole shape path for one stored post (lynxr_posts.id): prints the numbers. Reads the database, NEVER writes it. "
                         "One free audio download and one local Whisper pass")
    ap.add_argument("--words", action="store_true", help="with --print: also print the transcript with its times (the creator's own words)")
    ap.add_argument("--run", action="store_true",
                    help="one real pass now (writes lynxr_post_shape and post state). COACH_SHAPE_PER_PASS=10 in the environment raises the batch")
    args = ap.parse_args()
    if not (args.dry_run or args.post_id is not None or args.run):
        ap.error("give --dry-run, --print POST_ID or --run")
    import track_posts as T                      # here and only here: see the docstring
    env = T.P.load_env(T.P.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"),
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
    if args.post_id is not None:
        sys.exit(print_post(T, key, args.post_id, words=args.words))
    stats = shape_pass(key, datetime.now(timezone.utc), dry=args.dry_run, T=T)
    if not stats:
        print("the lane is off (COACH_SHAPE=0)")
        sys.exit(1)
    print(f"shape_due {stats['shape_due']}" + ("" if args.dry_run else
          f" · shaped {stats['shaped']} · failed {stats['shape_failed']} · skipped {stats['shape_skipped']}"))


if __name__ == "__main__":
    main()
