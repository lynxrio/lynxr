"""Agency campaign lane: reads an inspiration video, then writes one format
of a campaign brief. Runs on the same Fly worker as the creator pipeline, but
only when no creator is queued (see worker.py's AGENCY_LANE branch) — creators
are never delayed by an agency pass.

Plan: ~/.claude/plans/agency-batch-campaign-brief.md.

A format whose `script_mode` is 'verbatim' ("keep it exactly",
supabase/campaign_mode_needs.sql) skips the script call: its script is the
video's own words and shots (verbatim_script).

AGENCY LANE. No daily spend cap (owner decision 2026-09-14, reversing the
plan's original $25/day design): agency work is metered under
`lynxr_costs.lane='agency'` for visibility only, and never enforces a stop.
It never touches `lynxr_script_charges`, so the creators' DAILY_SCRIPT_CAP
breaker is unaffected either way. Each pass is one step (read OR write) for
at most AGENCY_PER_PASS formats, then control returns to the creator probe.
The off switch is AGENCY_LANE=0 (read by worker.py, not this file).

Do not import this module (or process_adaptations) from worker.py or
watchdog.py — both do import-time logging setup and mkdir that a probe-only
caller should never pay for. campaign_queue.py exists so the probe and the
claim never disagree about what "claimable" means.
"""
import argparse
import base64
import copy
import json
import logging
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import process_adaptations as P  # noqa: E402
import campaign_queue as Q  # noqa: E402
import script_checks as SC  # noqa: E402
import envcfg  # noqa: E402

log = logging.getLogger("campaigns")
CLAIM_ID = uuid.uuid4().hex[:12]

AGENCY_PER_PASS = int(envcfg.get("AGENCY_PER_PASS", "2"))
MODES = ("adapt", "verbatim")   # lynxr_campaign_formats.script_mode (supabase/campaign_mode_needs.sql)
AGENCY_FRAME_CAP = 14
AGENCY_OPENING = (0.3, 1.0, 1.8, 2.6, 3.4)
MAX_TOKENS = 8000
FETCH_MAX_ATTEMPTS = 2
AI_MAX_ATTEMPTS = 4


# ============================================================================
# 5a. Schemas and prompts. This text is load-bearing — it is the production
# document staff and creators actually read, so it is copied verbatim from
# the approved plan rather than paraphrased.
# ============================================================================

SHOT_TYPES = ["talking head", "b-roll", "screen recording", "product demo",
              "photos or screenshots", "green screen", "voiceover", "text only"]
PRODUCTION_SCHEMA = {"type": "object", "additionalProperties": False, "properties": {
    "hook_mechanism":   {"type": "string", "description": "what the first 1-3 seconds do and why they stop the scroll"},
    "speaking_style":   {"type": "string", "description": "tone, register and delivery, e.g. 'fast, deadpan, straight to camera'; 'no speech' if silent"},
    "scene_count":      {"type": "integer", "description": "distinct shots or scenes"},
    "pacing":           {"type": "string", "description": "cut rhythm and where it speeds up or holds"},
    "camera":           {"type": "string", "description": "camera position, height and framing"},
    "shot_types":       {"type": "array", "items": {"type": "string", "enum": SHOT_TYPES}},
    "setting":          {"type": "string", "description": "location and background as seen in the frames"},
    "lighting":         {"type": "string", "description": "lighting as seen in the frames, e.g. 'bright front-facing window light, no shadows'"},
    "overlays":         {"type": "string", "description": "on-screen text style, placement and timing"},
    "on_screen_media":  {"type": "string", "description": "screen recordings, screenshots, photos or products shown; empty string if none"},
    "transitions":      {"type": "string", "description": "cuts and transitions"},
    "pattern_interrupts": {"type": "string", "description": "moments that reset attention; empty string if none"},
    "reveal":           {"type": "string", "description": "the visual reveal or payoff; empty string if none"},
    "cta_structure":    {"type": "string", "description": "how and where the video asks for action"},
    "audio":            {"type": "string", "description": "voice, music, trending sound or silence"},
    "repeatable_because": {"type": "string", "description": "one sentence: what makes this format repeatable for another product"}},
  "required": ["hook_mechanism","speaking_style","scene_count","pacing","camera","shot_types","setting","lighting",
               "overlays","on_screen_media","transitions","pattern_interrupts","reveal","cta_structure","audio","repeatable_because"]}
KEY_MOMENTS = {"type": "array", "items": {"type": "string"},
               "description": "3-6 must-have moments of THIS video in the order they happen, the opening first: "
                              "concrete, visible actions, framing and on-screen elements a recreation must not "
                              "skip, each one instruction to the creator under 25 words"}
AGENCY_READ_SCHEMA = {"type": "object", "additionalProperties": False,
    "properties": {"format": P.FORMAT_SCHEMA, "production": PRODUCTION_SCHEMA, "key_moments": KEY_MOMENTS},
    "required": ["format", "production", "key_moments"]}
AGENCY_READ_SYSTEM = P.FORMAT_SYSTEM + """

---

YOU ALSO SEE FRAMES FROM THE VIDEO. Alongside `format`, return `production`: how
the original is actually made, read from the frames, the transcript and the shot
list — what a creator must copy to get the same effect. Describe what is visible.
Where the frames cannot show something (music, the rhythm between sampled frames),
say what the transcript and shot list imply, and write "unclear" rather than
invent. Keep brand and product names out of `production` too: "a screen recording
of an app's upload flow", not the original app's name.

---

ALSO RETURN `key_moments`: the 3 to 6 moments this video cannot work without, in the
order they happen — what a creator recreating it must not skip or change. Read them
from the frames first; the transcript and shot list fill the gaps between frames.
Lead with the opening: the exact first action, what is in frame, how the person is
framed and where they look. Then the moments that carry the format — a reveal, a
cut to a screen or a product, a caption that changes the meaning, the payoff pose.
Write each as one instruction to the creator, under 25 words, concrete enough to
film without asking: "Open full-body and centred, dropping a full grocery bag on the
counter, eyes on the lens". Name what is visible. Never a setup checklist (tripod,
a clean wall, good lighting, caption styling, background music) unless the video
fails without that exact thing. Unlike `production`, a moment may name the app or
product on screen — the agency reads these as they are."""

BEAT = P.ADAPT_SCHEMA["properties"]["beats"]          # same {t, say, do, show} beat, minItems 1
# orig (plan ~/.claude/plans/lynxr-agency-beat-sync.md): where in the ORIGINAL each beat sits. Agency only — a
# deep copy, so the creator lane's ADAPT_SCHEMA is untouched. ORIG_RULE is shared with backfill_beat_orig.py.
ORIG_DESC = ("the stretch of the ORIGINAL video this beat recreates, in the original's own seconds, e.g. "
             "'8-12s' (not this beat's own timing); empty string when the beat has no counterpart in the original")
ORIG_RULE = """`orig` ties each beat to the ORIGINAL video: the stretch of the original this
   beat recreates, in the original's own seconds, written like `t` ("8-12s"). Read it from the
   ORIGINAL VIDEO block (the [start-end s] of its spoken lines and the [t s] of its shots), never
   from this beat's own `t`, which is the new video's timing and often differs. Several beats may
   share one stretch. Leave it an empty string only when the beat has no counterpart in the
   original at all: an added brand card or end screen, a call to action the original did not have."""
AGENCY_BEAT = copy.deepcopy(BEAT)
AGENCY_BEAT["items"]["properties"]["orig"] = {"type": "string", "description": ORIG_DESC}
AGENCY_BEAT["items"]["required"] = [*AGENCY_BEAT["items"]["required"], "orig"]
AGENCY_SCRIPT_SCHEMA = {"type": "object", "additionalProperties": False, "properties": {
    "title":      {"type": "string", "description": "the headline this format is filed under in the brief — normally the hook, trimmed"},
    "fit":        P.ADAPT_SCHEMA["properties"]["fit"],
    "fit_reason": P.ADAPT_SCHEMA["properties"]["fit_reason"],
    "delivery":   P.ADAPT_SCHEMA["properties"]["delivery"],
    "hook":       P.ADAPT_SCHEMA["properties"]["hook"],
    "needs":      {"type": "array", "items": {"type": "string"}, "description": "3-6 must-have moments from the example video, in order, each a concrete instruction under 25 words — not a setup checklist"},
    "setting":    {"type": "string"}, "lighting": {"type": "string"},
    "framing":    {"type": "string"}, "audio": {"type": "string"},
    "beats":      AGENCY_BEAT,
    "cta":        P.ADAPT_SCHEMA["properties"]["cta"],
    "caption":    P.ADAPT_SCHEMA["properties"]["caption"],
    "creator_note":  {"type": "string", "description": "one or two practical filming tips; shown to creators"},
    "strategy_note": {"type": "string", "description": "agency team only: why this format suits this brand and what to watch for"}},
  "required": ["title","fit","fit_reason","delivery","hook","needs","setting","lighting","framing","audio",
               "beats","cta","caption","creator_note","strategy_note"]}
AGENCY_SCRIPT_SYSTEM = P.ADAPT_SYSTEM + """

---

THIS IS ONE FORMAT IN AN AGENCY CAMPAIGN BRIEF: a production document that several
different creators will film from, with the original video attached.

9. Do not rewrite the transcript with the brand swapped in. The FORMAT and HOW THE
   ORIGINAL IS PRODUCED blocks say why the original works; recreate that mechanism
   for this brand.
10. `do` is a production direction a creator can execute without asking a question:
   framing and camera height, where they look, what is on screen (their face, a
   screen recording of a named flow in the product, a photo, the product in hand),
   when to cut, and any movement. Match the original's production wherever the
   brand allows.
11. `needs` lists the MOMENTS this video cannot work without: 3 to 6 short, concrete
   instructions tied to the example video, in the order they happen, each under 25
   words. Lead with the opening shot: the exact first action, what is in frame and how
   the creator is framed. Then the beats a creator must not skip: the reveal, the cut
   to the product or a screen recording of a named flow, the payoff. Where the MUST-HAVE
   MOMENTS block lists a moment, keep its action and framing exactly and change only
   what this brand requires (its product, its app screen). `setting`, `lighting`,
   `framing` and `audio` already carry the general setup, so a need is never a tripod,
   a room, a clean wall, lighting, caption styling or background music unless the video
   fails without it. Never repeat or contradict THE AGENCY'S OWN NEEDS; they print
   first and yours follow them.
12. `setting`, `lighting`, `framing` and `audio` describe the setup once for the
   whole video, based on the original's production. Where a campaign rule already
   sets one of them, follow the rule.
13. The campaign rules are binding and print at the top of the brief. Never
   contradict them, and do not repeat them inside beats.
14. If the BRAND block gives a call to action, `cta` uses it. Never invent a
   discount, code, price or offer.
15. NO SLOTS IN THIS BRIEF — this replaces rule 8's [slot] instruction here. Several
   creators film this exactly as written and none of them will fill in a blank, so
   never write square brackets anywhere. Where a line needs a personal detail you were
   not given — a number, a timespan, a routine, a situation, an item of clothing —
   write a specific, plausible one as the creator's own words: "I was paying for five
   of them at once", "three weeks before my exam". Keep it ordinary, believable and
   right for the brand's audience, and never claim professional authority (a doctor,
   a nurse, a dermatologist) the campaign rules do not give. The invented detail is
   only ever about the creator's own life. NEVER invent anything about the PRODUCT or
   the brand: no statistic, result, time saved, score, price, discount, feature or
   ranking unless the BRAND block states it, and never say or imply the product
   produced a result for the creator ("it saved me three hours a day", "it got me a
   250"). Rule 8's last paragraph and rule 14 still apply.
16. `strategy_note` is read by the agency team only and is never shown to creators,
   so no other field may depend on it.""" + "\n17. " + ORIG_RULE


# ============================================================================
# 5b. Prompt builders — pure, tested in test_campaigns.py.
# ============================================================================

def brand_block(bc):
    """One non-empty line per key of the campaign's brand_context dict, in
    a fixed order, each trimmed to 600 chars. Never raises on a missing key.
    `What it is:` is always present, so an empty brand_context still returns
    exactly one line."""
    bc = bc or {}

    def g(key):
        v = bc.get(key)
        if isinstance(v, (list, tuple)):
            v = "; ".join(str(x) for x in v if x)
        return str(v or "").strip()[:600]

    lines = []
    name, company = g("name"), g("company")
    if name:
        label = f"Brand: {name}"
        if company and company != name:
            label += f" (company: {company})"
        lines.append(label)
    lines.append(f"What it is: {g('description') or '(not given)'}")
    if g("product"):
        lines.append(f"Product / app: {g('product')}")
    if g("niche"):
        lines.append(f"Niche: {g('niche')}")
    who = "; ".join(x for x in (g("audience"), g("audienceNotes")) if x)
    if who:
        lines.append(f"Who it is for: {who}")
    if g("painPoints"):
        lines.append(f"Their main pain points: {g('painPoints')}")
    if g("features"):
        lines.append(f"Key features: {g('features')}")
    if g("valueProps"):
        lines.append(f"Value propositions: {g('valueProps')}")
    if g("tone"):
        lines.append(f"Brand tone and language: {g('tone')}")
    if g("cta"):
        lines.append(f"Call to action to use: {g('cta')}")
    if g("site"):
        lines.append(f"Website / app link: {g('site')}")
    if g("notes"):
        lines.append(f"Brand-specific instructions and past campaign notes: {g('notes')}")
    if g("habits"):
        lines.append(f"Audience daily habits: {g('habits')}")
    if g("goals"):
        lines.append(f"Audience goals: {g('goals')}")
    return "\n".join(lines)


def wrapper_text(fmt):
    # keep in step with fill_adaptation's IGNORE THE FRAMING block
    wrapper = (fmt or {}).get("wrapper_removed") or ""
    return (f"\n=== IGNORE THE FRAMING ===\nThe original is wrapped in: {wrapper}\n"
            "That framing is NOT part of the format. It appears in the transcript and "
            "shots below — skip past it and adapt only the piece inside. Never open with "
            "the creator introducing themselves or their work.\n" if wrapper else "")


def read_content(a, frames):
    """The read call's user content: frame images (each preceded by a
    timestamp label) then one text block asking for the format and
    production read. With no frames, the text block alone (a plain string)."""
    text = "Extract the reusable format and describe the production.\n\n" + P.source_digest(a)
    if not frames:
        return text
    content = []
    for t, jpeg in frames:
        content.append({"type": "text", "text": f"Frame at t={t}s:"})
        content.append({"type": "image", "source": {
            "type": "base64", "media_type": "image/jpeg",
            "data": base64.b64encode(jpeg).decode()}})
    content.append({"type": "text", "text": text})
    return content


def agency_frame_times(t, duration):
    """Frame times for the agency lane's shot list and read call: denser than the creator path's
    analyze_visuals.frame_times, and dense at the opening. Measured 2026-10-04 on a live 16s agency
    format: the base plan sampled 0.5s and 4.0s and missed a 1.0-3.4s opening action — the one moment
    the agency's own needs named. Priority when capping: the opening, then the base plan, then an even
    spread. Never more than AGENCY_FRAME_CAP; never two frames closer than min(0.5s, duration/12)."""
    base = P.frame_times(t, duration)
    d = float(duration or 0) or ((max(base) + 1.0) if base else 20.0)
    gap = min(0.5, d / 12)
    picked = []
    for x in [*AGENCY_OPENING, *base, *(d * k / 8 for k in range(1, 8))]:
        x = round(float(x), 1)
        if x < 0 or x > d - 0.15 or any(abs(x - y) < gap for y in picked):
            continue
        picked.append(x)
        if len(picked) >= AGENCY_FRAME_CAP:
            break
    return sorted(picked)


def _secs(x):
    x = round(float(x or 0), 1)
    return str(int(x)) if x == int(x) else f"{x:.1f}"


def _one_line(s):
    return " ".join(str(s or "").split())


_ORIG_T = r"(\d+:\d{1,2}(?:\.\d+)?|\d+(?:\.\d+)?)"
_ORIG_RE = re.compile(rf"^\s*{_ORIG_T}\s*s?\s*(?:(?:[-–—]|to)\s*{_ORIG_T}\s*s?\s*)?$")


def _tsec(tok):
    if ":" in tok:
        m, s = tok.split(":", 1)
        return int(m) * 60 + float(s)
    return float(tok)


def norm_orig(value, duration=0):
    """A beat's `orig` in its one stored shape, "a-bs" in the original's seconds, or "" when it names no
    usable moment. Accepts "8-12s", "8.1 - 12 s", "0:08-0:12", "8s". A lone start, or an end not after the
    start, gets a 2s window (app.js cbOrigParse does the same). With a known duration the window is clamped
    to it and a start at or past the end is dropped; a stored duration of 0 (some silent reads) clamps
    nothing — the browser clamps against the real clip."""
    m = _ORIG_RE.match(str(value or ""))
    if not m:
        return ""
    a = _tsec(m.group(1))
    b = _tsec(m.group(2)) if m.group(2) else None
    if b is None or b <= a:
        b = a + 2.0
    d = float(duration or 0)
    if d > 0:
        if a >= d - 0.05:
            return ""
        b = min(b, d)
    return f"{_secs(a)}-{_secs(b)}s"


def with_orig(script, duration=0):
    """The script with every beat's `orig` normalised; a beat the model left without one gets ""."""
    beats = [{**b, "orig": norm_orig(b.get("orig"), duration)} for b in (script.get("beats") or [])
             if isinstance(b, dict)]
    return {**script, "beats": beats}


def verbatim_beats(source):
    """The video's own words and shots as {t, say, do, show} beats ("keep it exactly"). A port of
    app.js realScript(): spoken videos group Whisper segments into ~5 beats (at least 4s each) and take
    direction + on-screen text from the shots inside each beat's window (else the nearest shot within
    4s); silent videos are the shot list, one beat per run of the same on-screen text; a transcript
    with no timings is one beat. [] when there is nothing to keep."""
    s = source or {}
    sc = s.get("script") or {}
    segs = [g for g in (sc.get("segments") or [])
            if isinstance(g, (list, tuple)) and len(g) >= 3 and _one_line(g[2])]
    shots = sorted((h for h in (s.get("shots") or []) if isinstance(h, dict)),
                   key=lambda h: float(h.get("t") or 0))
    dur = float(s.get("duration") or sc.get("duration") or 0)

    def uniq(values):
        out = []
        for v in values:
            v = str(v or "").strip()
            if v and v not in out:
                out.append(v)
        return out

    def dist(h, a, b):
        t = float(h.get("t") or 0)
        return min(abs(t - a), abs(t - b))

    def shots_for(a, b):
        inside = [h for h in shots if a <= float(h.get("t") or 0) < b]
        if inside:
            return inside
        near = min(shots, key=lambda h: dist(h, a, b), default=None)
        return [near] if near is not None and dist(near, a, b) <= 4 else []

    if sc.get("has_speech") and segs:
        total = float(segs[-1][1] or 0) or 1.0
        target = max(4.0, total / 5)
        groups = []   # [start, end, [words]]
        for g in segs:
            st, en, txt = float(g[0] or 0), float(g[1] or 0), _one_line(g[2])
            if not groups or (en - groups[-1][0]) > target:
                groups.append([st, en, [txt]])
            else:
                groups[-1][1] = en
                groups[-1][2].append(txt)
        beats = []
        for st, en, words in groups:
            hs = shots_for(st, en)
            t = f"{_secs(st)}-{_secs(en)}s"
            beats.append({"t": t, "orig": t, "say": " ".join(words),
                          "do": " → ".join(uniq(h.get("visual") for h in hs)),
                          "show": " / ".join(uniq(h.get("onscreen_text") for h in hs))})
        return beats
    if shots:
        runs = []   # [start, text, [visuals]]
        for i, h in enumerate(shots):
            text = str(h.get("onscreen_text") or "").strip()
            vis = str(h.get("visual") or "").strip()
            if runs and _one_line(runs[-1][1]) == _one_line(text):
                if vis and vis not in runs[-1][2]:
                    runs[-1][2].append(vis)
                continue
            runs.append([0.0 if i == 0 else float(h.get("t") or 0), text, [vis] if vis else []])
        end_all = max(dur, float(shots[-1].get("t") or 0) + 1.0)
        out = []
        for k, (st, text, vis) in enumerate(runs):
            tt = f"{_secs(st)}-{_secs(runs[k + 1][0] if k + 1 < len(runs) else end_all)}s"
            out.append({"t": tt, "orig": tt, "say": "", "do": " → ".join(vis), "show": text})
        return out
    text = _one_line(sc.get("text"))
    if text:
        t = f"0-{_secs(dur)}s" if dur else ""
        return [{"t": t, "orig": t, "say": text, "do": "", "show": ""}]
    return []


def verbatim_script(source, analysis):
    """A "keep it exactly" format in AGENCY_SCRIPT_SCHEMA's shape, built with no model call. needs =
    the read call's key_moments; setup = the read's production block; caption = the original post's.
    `verbatim: True` is not in the schema: it marks this version for the card's "kept exactly" chip
    and is never exported (agencySendDoc and campaignDocHtml pick named fields)."""
    s = source or {}
    sc = s.get("script") or {}
    an = analysis or {}
    prod = an.get("production") or {}
    beats = verbatim_beats(s)
    spoken = bool(sc.get("has_speech") and sc.get("segments"))
    if spoken:
        hook = str(sc.get("hook") or "").strip() or (beats[0]["say"] if beats else "")
    else:
        hook = next((b["show"] for b in beats if b["show"]), "") or (beats[0]["do"] if beats else "")
    first = _one_line(hook)
    title = (first[:87].rstrip() + "…") if len(first) > 90 else first
    return {
        "title": title or str((an.get("format") or {}).get("name") or ""),
        "fit": None, "fit_reason": "",
        "delivery": "spoken" if spoken else "silent",
        "hook": hook,
        "needs": [str(x).strip() for x in (an.get("key_moments") or []) if str(x).strip()][:8],
        "setting": str(prod.get("setting") or ""), "lighting": str(prod.get("lighting") or ""),
        "framing": str(prod.get("camera") or ""), "audio": str(prod.get("audio") or ""),
        "beats": beats, "cta": "", "caption": str(s.get("caption") or "")[:2200],
        "creator_note": "", "strategy_note": "",
        "verbatim": True,
    }


def script_prompt(a, analysis, campaign, regen_note=None, prev_hook=None, staff_needs=None):
    instructions = (campaign or {}).get("instructions") or ""
    prompt = (
        "Write this format of the campaign brief for the brand below.\n\n"
        f"=== DELIVERY ===\n{P.delivery_mode_text(a)}\n{wrapper_text(analysis['format'])}\n"
        f"=== FORMAT TO REUSE ===\n{json.dumps(analysis['format'], indent=1)}\n\n"
        f"=== HOW THE ORIGINAL IS PRODUCED ===\n{json.dumps(analysis['production'], indent=1)}\n\n"
        f"=== ORIGINAL VIDEO (for reference — do NOT reuse its topic) ===\n{P.source_digest(a)}\n\n"
        f"=== BRAND ===\n{brand_block((campaign or {}).get('brand_context'))}\n\n"
        "=== CAMPAIGN RULES (apply to every format; printed at the top of the brief "
        f"— do not repeat them) ===\n{instructions[:2000] or '(none)'}"
    )
    moments = [str(x).strip() for x in ((analysis or {}).get("key_moments") or []) if str(x).strip()]
    if moments:
        prompt += ("\n\n=== MUST-HAVE MOMENTS IN THE ORIGINAL (keep each one's action and framing; "
                   "change only what this brand requires) ===\n"
                   + "\n".join(f"- {m[:300]}" for m in moments[:8]))
    own = [str(x).strip() for x in (staff_needs or []) if str(x).strip()]
    if own:
        prompt += ("\n\n=== THE AGENCY'S OWN NEEDS FOR THIS FORMAT (binding; they print first in the "
                   "brief — follow them and never repeat them in `needs`) ===\n"
                   + "\n".join(f"- {n[:300]}" for n in own[:12]))
    if regen_note or prev_hook:
        prompt += (
            "\n\n=== WHAT THE AGENCY WANTS FROM THIS NEW VERSION ===\n"
            f"{(regen_note or '')[:500] or 'A different take.'}\n"
            f"The previous version opened with: {prev_hook}"
        )
    return prompt


def slot_repair_text(found):
    listed = "; ".join(found[:12])
    return ("\n\n=== IMPORTANT ===\nYour last answer left "
            f"{len(found)} fill-in slot(s) in square brackets: {listed}. Creators film this brief exactly "
            "as written, so follow rule 15: replace each with a specific, plausible value in the "
            "creator's own words ('five of them', 'about three weeks', 'a white tee and light jeans'), "
            "never a product fact or result the BRAND block does not state. Return the whole format "
            "again with no square brackets anywhere.")


def write_script(aclient, prompt, analysis):
    """The script job's model calls. One write; one retry when the answer is thin (unchanged); then
    rule 15's BACKSTOP: if any [slot] survived, one repair call (~$0.08-0.17, only then). A repair that
    fails or does not reduce the slots is dropped and the first answer kept; any slot still left shows
    on the agency card as "N blanks to fill" (app.js cbSlotCount). Errors from the first two calls
    propagate exactly as before. Returns (script, slots_left)."""
    out = P.structured(aclient, AGENCY_SCRIPT_SYSTEM, AGENCY_SCRIPT_SCHEMA, prompt, max_tokens=MAX_TOKENS)
    if P.thin_script(out, (analysis or {}).get("format")):
        out = P.structured(
            aclient, AGENCY_SCRIPT_SYSTEM, AGENCY_SCRIPT_SCHEMA,
            prompt + "\n\n=== IMPORTANT ===\nYour last answer had "
            f"{len(out.get('beats') or [])} beat(s) against a "
            f"{len(((analysis or {}).get('format') or {}).get('beats') or [])}-beat format, "
            "which is not a usable script. Write the full beat list: one beat "
            "per beat of the format above, each with `say`, `do` and `show` "
            "filled in as the delivery requires.",
            max_tokens=MAX_TOKENS)
    found = SC.slot_texts(out)
    if found:
        try:
            fixed = P.structured(aclient, AGENCY_SCRIPT_SYSTEM, AGENCY_SCRIPT_SCHEMA,
                                 prompt + slot_repair_text(found), max_tokens=MAX_TOKENS)
            if (fixed.get("beats") or []) and SC.slots(fixed) < len(found) \
                    and not P.thin_script(fixed, (analysis or {}).get("format")):
                out = fixed
        except Exception as e:  # noqa: BLE001 — a failed repair never fails the format
            log.warning("slot repair failed: %s", str(e)[:120])
    return out, SC.slots(out)


def ai_retry_minutes(fail_kind, attempts):
    sched = P.AI_RETRY_MINUTES[fail_kind]
    return sched[min(attempts, len(sched) - 1)]


def finalize_patch(kind, row, now, **parts):
    """Pure. The PATCH body for one outcome of a claimed format.

    kind:
      'requeue_fetch'  — a retryable download failure; same job, short delay
      'requeue_script' — the read job finished; queue the script job next pass
      'ai_requeue'     — a retryable AI failure (billing/rate_limit/transient)
      'done'           — the script was written
      'error'          — terminal failure
    """
    attempts = int(row.get("attempts") or 0)
    timings = parts.get("timings")
    if kind == "requeue_fetch":
        return {
            "status": "queued", "job": row.get("job", "read"), "phase": "",
            "claimed_by": "", "claimed_at": None,
            "attempts": attempts + 1,
            "retry_at": Q.stamp(now + timedelta(minutes=2)),
            "timings": timings,
        }
    if kind == "requeue_script":
        return {
            "status": "queued", "job": "script", "phase": "",
            "source": parts["source"], "analysis": parts["analysis"],
            "attempts": 0, "retry_at": None,
            "error_kind": "", "error_detail": "",
            "claimed_by": "", "claimed_at": None,
            "timings": timings,
        }
    if kind == "ai_requeue":
        minutes = ai_retry_minutes(parts["fail_kind"], attempts)
        return {
            "status": "queued", "job": row.get("job"), "phase": "",
            "claimed_by": "", "claimed_at": None,
            "attempts": attempts + 1,
            "retry_at": Q.stamp(now + timedelta(minutes=minutes)),
            "timings": timings,
        }
    if kind == "done":
        body = {
            "status": "done", "phase": "", "script": parts["script"],
            "finished_at": Q.stamp(now),
            "error_kind": "", "error_detail": "",
            "retryable": True, "regen_note": "",
            "attempts": attempts + 1, "retry_at": None,
            "timings": timings,
        }
        if parts.get("source") is not None:
            body["source"] = parts["source"]
        if parts.get("analysis") is not None:
            body["analysis"] = parts["analysis"]
        if "source" in body or "analysis" in body:
            body["job"] = "script"
        if row.get("script"):
            body["script_prev"] = {"script": row.get("script"), "edited": row.get("edited")}
            body["edited"] = None
        return body
    if kind == "error":
        body = {
            "status": "error", "phase": "",
            "error_kind": parts["error_kind"],
            "error_detail": parts.get("error_detail", ""),
            "retryable": parts.get("retryable", True),
            "attempts": attempts + 1, "retry_at": None,
            "claimed_by": "", "claimed_at": None,
            "timings": timings,
        }
        # Only the length gate passes one: {"duration", "maxDuration"}, so the
        # card can say "This video is 7:12 — … up to 5 minutes" (app.js cbErrorText).
        if parts.get("source") is not None:
            body["source"] = parts["source"]
        if parts.get("job"):
            body["job"] = parts["job"]
        return body
    raise ValueError(f"unknown finalize kind: {kind}")


def pool_subject(row, source, fmt):
    """The ONLY object ever handed to P.upsert_source/P.upsert_video. It
    never receives the campaign row, which makes pooling a brand, client,
    campaign name, instructions or staff identity structurally impossible."""
    return {"id": row["id"], "sourceUrl": row["source_url"], "source": source, "format": fmt}


def pool_ready(subject):
    """True only when the video was fully analyzed: a format, a script, at
    least one shot, tags, and a hosted clip. merge-duplicates writes whatever
    keys it is given (nulls included), so a partial agency re-read must never
    overwrite a creator's good row with nulls."""
    src = subject.get("source") or {}
    return bool(subject.get("format") and src.get("script") and src.get("shots")
                and src.get("tags") and src.get("clip"))


def agency_seen_path(url):
    return "/rest/v1/lynxr_sources?canonical_url=eq." + urllib.parse.quote(P.canon_url(url), safe="")


# ============================================================================
# 5c. HTTP helpers.
# ============================================================================

def sbx(key, path, method="GET", body=None, prefer=None):
    """Like P.sb, plus an optional Prefer header. Raises the way P.sb does;
    callers catch what they need (e.g. a missing table)."""
    req = urllib.request.Request(P.SB_URL + path, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    if prefer:
        req.add_header("Prefer", prefer)
    with urllib.request.urlopen(req, timeout=60, context=P.SSL_CTX) as r:
        data = r.read()
    return json.loads(data) if data else None


def ops_upsert(key, opskey, value):
    """Best-effort upsert into lynxr_ops — watchdog.ops_put's body shape,
    copied rather than imported (see the plan's 'Do not': worker.py and
    watchdog.py must never import process_adaptations/process_campaigns)."""
    body = {"key": opskey, "value": value, "updated_at": P.now_iso()}
    try:
        sbx(key, "/rest/v1/lynxr_ops?on_conflict=key", method="POST", body=body,
            prefer="resolution=merge-duplicates")
    except Exception as e:  # noqa: BLE001
        log.warning("ops_upsert(%s) failed: %s", opskey, str(e)[:90])


def record_agency_cost(key, fid, ok, sink):
    """Best-effort. Persists this format's spend under lane='agency' so
    total agency spend stays visible in lynxr_costs, separate from creators.
    There is no spend cap here (owner decision 2026-09-14) — this is a
    record, not a gate."""
    rows = P.cost_rows(sink, fid, ok)
    if not rows:
        return
    for r in rows:
        r["lane"] = "agency"
    try:
        sbx(key, "/rest/v1/lynxr_costs", method="POST", body=rows)
    except Exception as e:  # noqa: BLE001
        log.warning("agency cost not recorded for %s: %s", str(fid or "")[:8], str(e)[:90])


def pool_source(key, subject):
    """Join the video to the shared source library, same as a creator paste
    (owner decision 2026-09-14). Never sets or bumps tag_count."""
    if not pool_ready(subject):
        return "skipped"
    P.upsert_source(key, subject)   # swallows its own errors
    P.upsert_video(key, subject)    # swallows its own errors
    try:
        P.sb(key, agency_seen_path(subject["sourceUrl"]), method="PATCH",
             body={"agency_seen_at": P.now_iso()})
    except Exception as e:  # noqa: BLE001
        log.warning("agency_seen_at not recorded for %s: %s",
                    str(subject.get("id") or "")[:8], str(e)[:90])
    return "pooled"


# ============================================================================
# 5d. run_format — advance one claimed format by one job, on its own thread.
# ============================================================================

def run_format(key, aclient, row, campaign):
    fid = row["id"]
    sink = {}
    P._USAGE_LOCAL.d = sink
    ok_for_cost = False

    stop = threading.Event()

    def heartbeat():
        while not stop.wait(45):
            try:
                sbx(key, f"/rest/v1/{Q.TABLE}?id=eq.{fid}&claimed_by=eq.{CLAIM_ID}",
                    method="PATCH", body={"claimed_at": P.now_iso()})
            except Exception as e:  # noqa: BLE001
                log.warning("heartbeat failed for %s: %s", fid[:8], str(e)[:90])

    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()

    url = row.get("source_url") or ""
    a = {"id": fid, "sourceUrl": url}
    notes, timings = [], {}

    def finalize(kind, **parts):
        parts.setdefault("timings", timings)
        body = finalize_patch(kind, row, datetime.now(timezone.utc), **parts)
        try:
            result = sbx(key, f"/rest/v1/{Q.TABLE}?id=eq.{fid}&claimed_by=eq.{CLAIM_ID}",
                         method="PATCH", body=body, prefer="return=representation")
        except Exception as e:  # noqa: BLE001
            log.warning("finalize(%s) failed for %s: %s", kind, fid[:8], str(e)[:120])
            return
        if not result:
            log.warning("finalize(%s) for %s matched no row (reclaimed or deleted)", kind, fid[:8])

    try:
        if not P.supported_url(url):
            finalize("error", error_kind="off_platform", retryable=False)
            return

        job = row.get("job")
        mode = row.get("script_mode") if row.get("script_mode") in MODES else "adapt"   # column absent = adapt
        raw_own = row.get("staff_needs")
        staff_needs = [str(x).strip() for x in raw_own if str(x).strip()] if isinstance(raw_own, list) else []
        have = row.get("analysis") or {}
        old_read = bool(row.get("analysis") and row.get("source"))

        def keep_old_read():
            """An upgrade re-read (the analysis predates key_moments) that cannot complete: keep the read the
            format already has, marked so it is not retried, instead of turning a finished format into a
            failed card."""
            old = dict(row["analysis"])
            old.setdefault("key_moments", [])
            if mode == "verbatim":
                finalize("done", script=verbatim_script(row["source"], old), analysis=old)
            else:
                finalize("requeue_script", source=row["source"], analysis=old)

        if job == "read" or not row.get("analysis") or "key_moments" not in have:
            if job != "read":
                try:
                    sbx(key, f"/rest/v1/{Q.TABLE}?id=eq.{fid}&claimed_by=eq.{CLAIM_ID}",
                        method="PATCH", body={"phase": "reading"})
                except Exception as e:  # noqa: BLE001
                    log.warning("phase patch (reading) failed for %s: %s", fid[:8], str(e)[:90])
            # ---- READ JOB ----
            meta_holder = {}

            def fetch_meta_bg():
                try:
                    meta_holder["meta"] = P.fetch_meta(url)
                except Exception:  # noqa: BLE001
                    meta_holder["meta"] = {}

            meta_thread = threading.Thread(target=fetch_meta_bg, daemon=True)
            meta_thread.start()

            def length_hint(wait):
                meta_thread.join(timeout=wait)
                return (meta_holder.get("meta") or {}).get("duration")

            frames_out = []
            try:
                P.fill_source(a, aclient, key, notes, timings,
                               on_frames=frames_out.extend, usage_sink=sink,
                               length_hint=length_hint, frame_plan=agency_frame_times)
            except Exception as e:  # noqa: BLE001
                if isinstance(e, P.CreatorFacing):
                    # The length gate: final, never retried, no model call made.
                    finalize("error", error_kind=e.key, error_detail=str(e)[:200],
                             retryable=e.retryable,
                             source={"duration": e.nums.get("secs"),
                                     "maxDuration": e.nums.get("limit")})
                    return
                note_key, retryable = P.fetch_failure(e)
                attempts = int(row.get("attempts") or 0)
                if retryable and attempts + 1 < FETCH_MAX_ATTEMPTS:
                    finalize("requeue_fetch")
                elif old_read:
                    keep_old_read()
                else:
                    finalize("error", error_kind=note_key, error_detail=str(e)[:200],
                              retryable=retryable)
                return

            meta_thread.join(timeout=20)
            meta = meta_holder.get("meta") or {}
            a.setdefault("source", {})
            a["source"]["meta"] = meta
            a["source"]["caption"] = meta.get("title", "")

            try:
                sbx(key, f"/rest/v1/{Q.TABLE}?id=eq.{fid}&claimed_by=eq.{CLAIM_ID}",
                    method="PATCH", body={"phase": "analyzing", "source": a["source"]})
            except Exception as e:  # noqa: BLE001
                log.warning("phase patch (analyzing) failed for %s: %s", fid[:8], str(e)[:90])

            try:
                analysis = P.structured(aclient, AGENCY_READ_SYSTEM, AGENCY_READ_SCHEMA,
                                         read_content(a, frames_out), max_tokens=MAX_TOKENS)
            except Exception as e:  # noqa: BLE001
                reason = P.api_reason(e)
                kind = P.ai_failure_kind(reason)
                attempts = int(row.get("attempts") or 0)
                if kind in P.AI_RETRY_KINDS and attempts + 1 < AI_MAX_ATTEMPTS:
                    finalize("ai_requeue", fail_kind=kind)
                elif old_read:
                    keep_old_read()
                else:
                    err_kind = "ai_content" if kind == "content" else "ai_ours"
                    finalize("error", error_kind=err_kind, error_detail=reason[:200], retryable=True)
                return

            analysis["diag"] = "; ".join(notes)[:300]

            a["format"] = analysis["format"]
            pooled = pool_source(key, pool_subject(row, a["source"], analysis["format"]))
            if pooled == "skipped":
                analysis["diag"] = (analysis["diag"] + "; not pooled: incomplete source")[:300]

            if mode == "verbatim":
                script = verbatim_script(a["source"], analysis)
                if script["beats"]:
                    finalize("done", script=script, source=a["source"], analysis=analysis)
                else:
                    finalize("error", error_kind="verbatim_empty", retryable=True, job="read",
                             error_detail="keep it exactly: no transcript or shot list to keep")
            else:
                finalize("requeue_script", source=a["source"], analysis=analysis)
            ok_for_cost = True
            return

        # ---- SCRIPT JOB ----
        a["source"] = row.get("source")
        analysis = row.get("analysis")
        if mode == "verbatim":
            script = verbatim_script(a["source"], analysis)
            if script["beats"]:
                finalize("done", script=script)
            else:
                finalize("error", error_kind="verbatim_empty", retryable=True, job="read",
                         error_detail="keep it exactly: no transcript or shot list to keep")
            return
        try:
            sbx(key, f"/rest/v1/{Q.TABLE}?id=eq.{fid}&claimed_by=eq.{CLAIM_ID}",
                method="PATCH", body={"phase": "writing"})
        except Exception as e:  # noqa: BLE001
            log.warning("phase patch (writing) failed for %s: %s", fid[:8], str(e)[:90])

        regen_note = row.get("regen_note") or ""
        prev_hook = (row.get("script") or {}).get("hook") if (regen_note or row.get("script")) else None
        prompt = script_prompt(a, analysis, campaign, regen_note, prev_hook, staff_needs=staff_needs)

        try:
            out, left = write_script(aclient, prompt, analysis)
            if not (out.get("beats") or []):
                raise RuntimeError("no beats")
        except Exception as e:  # noqa: BLE001
            reason = P.api_reason(e)
            kind = P.ai_failure_kind(reason)
            attempts = int(row.get("attempts") or 0)
            if kind in P.AI_RETRY_KINDS and attempts + 1 < AI_MAX_ATTEMPTS:
                finalize("ai_requeue", fail_kind=kind)
            else:
                err_kind = "ai_content" if kind == "content" else "ai_ours"
                finalize("error", error_kind=err_kind, error_detail=reason[:200], retryable=True)
            return

        if left:
            log.info("format %s: %d [slot](s) left after the repair", fid[:8], left)
        finalize("done", script=with_orig(out, (a.get("source") or {}).get("duration")))
        ok_for_cost = True
    finally:
        stop.set()
        P.log_usage(f"format {fid[:8]}", sink)
        record_agency_cost(key, fid, ok_for_cost, sink)
        P._USAGE_LOCAL.d = {}


# ============================================================================
# 5e. main()
# ============================================================================

def _table_missing(err):
    body = ""
    try:
        body = err.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        pass
    return getattr(err, "code", None) == 404 or "PGRST205" in body


def main():
    envcfg.sanitize_environ()
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-formats", type=int, default=AGENCY_PER_PASS)
    ap.add_argument("--lease-minutes", type=float, default=Q.LEASE_MINUTES)
    ap.add_argument("--probe", action="store_true",
                    help="read-only: print how many formats are claimable and exit. Spends nothing.")
    args = ap.parse_args()

    env = P.load_env(P.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY",
                             env.get("SUPABASE_SERVICE_ROLE_KEY"),
                             os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
        api_key = envcfg.secret("ANTHROPIC_API_KEY",
                                 env.get("ANTHROPIC_API_KEY"),
                                 os.environ.get("ANTHROPIC_API_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")

    # The read call needs frames; a library cache hit has none. This disables
    # only READING the cache — the lane still WRITES to it (pool_source).
    P.REUSE_SOURCES = False

    now = datetime.now(timezone.utc)

    if args.probe:
        try:
            rows = sbx(key, Q.probe_path(now, limit=50))
        except urllib.error.HTTPError as e:
            if _table_missing(e):
                print("tables missing")
                sys.exit(3)
            print(f"probe failed: HTTP {e.code}")
            sys.exit(1)
        except Exception as e:  # noqa: BLE001
            print(f"probe failed: {e}")
            sys.exit(1)
        print(f"claimable: {len(rows or [])}")
        sys.exit(0)

    if not api_key:
        log.info("no ANTHROPIC_API_KEY — claiming nothing")
        sys.exit(0)

    try:
        candidates = sbx(key, Q.probe_path(now, limit=args.max_formats, select="id,job"))
    except urllib.error.HTTPError as e:
        if _table_missing(e):
            ops_upsert(key, "agency.lane", {"state": "tables_missing", "at": P.now_iso()})
        else:
            log.warning("probe failed: HTTP %s", e.code)
        sys.exit(Q.PAUSED_EXIT)
    except Exception as e:  # noqa: BLE001
        log.warning("probe failed: %s", str(e)[:120])
        sys.exit(Q.PAUSED_EXIT)

    if not candidates:
        sys.exit(0)

    claimed = []
    for c in candidates:
        phase = "reading" if c.get("job") == "read" else "writing"
        try:
            row = sbx(key, Q.claim_patch_path(c["id"], now), method="PATCH",
                      body={"status": "running", "claimed_at": P.now_iso(),
                            "claimed_by": CLAIM_ID, "phase": phase},
                      prefer="return=representation")
        except Exception as e:  # noqa: BLE001
            log.warning("claim failed for %s: %s", c["id"][:8], str(e)[:90])
            continue
        if row:
            claimed.extend(row)

    if not claimed:
        sys.exit(0)

    campaign_ids = sorted({r["campaign_id"] for r in claimed})
    try:
        campaigns = {c["id"]: c for c in (sbx(
            key, f"/rest/v1/lynxr_campaigns?id=in.({','.join(campaign_ids)})"
                 "&select=id,name,instructions,brand_context") or [])}
    except Exception as e:  # noqa: BLE001
        log.warning("campaign lookup failed: %s", str(e)[:120])
        campaigns = {}

    ops_upsert(key, "agency.lane", {"state": "running", "claimed": len(claimed), "at": P.now_iso()})

    aclient = P.anthropic_client(api_key)
    runnable = []
    for row in claimed:
        campaign = campaigns.get(row.get("campaign_id"))
        if not campaign:
            fid = row["id"]
            body = finalize_patch("error", row, now, error_kind="ai_ours",
                                   error_detail="campaign missing", retryable=True)
            try:
                sbx(key, f"/rest/v1/{Q.TABLE}?id=eq.{fid}&claimed_by=eq.{CLAIM_ID}",
                    method="PATCH", body=body, prefer="return=representation")
            except Exception as e:  # noqa: BLE001
                log.warning("finalize(campaign missing) failed for %s: %s", fid[:8], str(e)[:90])
            continue
        runnable.append((row, campaign))

    if runnable:
        with ThreadPoolExecutor(max_workers=len(runnable)) as pool:
            list(pool.map(lambda rc: run_format(key, aclient, rc[0], rc[1]), runnable))

    sys.exit(0)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    main()
