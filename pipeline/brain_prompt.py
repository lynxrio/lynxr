"""Renders a creator's brain document (lynxr_creator_brain.body, built by pipeline/brain.py) into the one block that goes in the adapt call's
USER message, behind the BRAIN_IN_PROMPT flag. Plan: ~/.claude/plans/lynxr-writer-reads-brain.md.

CREATOR-SIDE ONLY. This never reaches process_campaigns.py or AGENCY_SCRIPT_SYSTEM: the agency side is an internal tool and stays separate.
It goes in the adapt call's user message, never in ADAPT_SYSTEM: that string is the cached prefix and must stay byte-identical across
creators, or every call pays a full cache write.

CONSERVATIVE BY DESIGN. There is no correction UI for the brain and there will not be one, so a line that cannot be derived truthfully is
left out rather than guessed. A block with no real signal in it (no voice read, fewer than MIN_SAMPLES usable captions, no measured
performance) is not emitted at all: the preamble alone costs ~219 tokens and would deliver nothing.

Pure stdlib and imports nothing from this repo, on purpose. process_adaptations.py imports this module, and brain.py imports
process_adaptations, so anything here that imported brain would be a cycle.
"""
import re
from datetime import datetime, timedelta, timezone

HEAD = "=== WHAT LYNXR KNOWS ABOUT THIS CREATOR ==="

PREAMBLE = (
    "Worked out from this creator's own posted videos. WHERE IT DISAGREES WITH THE CRAFT AND\n"
    "PRODUCTION RULES, IT WINS — those rules are what works in general, this is what works for\n"
    "this person. It does NOT outrank the PRECEDENCE block: nothing here is a fact the script may\n"
    "state, and nothing here is about the product.\n"
    "NONE OF IT GOES IN THE SCRIPT. No view counts, no medians, no \"my videos that...\", no mention\n"
    "of their posting history. It changes what you write, never what they say.\n"
    "A PATTERN IS NOT A LICENCE TO INVENT. Where a pattern below needs material the script does not\n"
    "already have — a number, a quantity, a date, something they own — take it from the source video\n"
    "or the brand facts AS THEY ARE WRITTEN. Never stretch a brand fact into a larger claim, and never\n"
    "satisfy a pattern with a new claim about what the product does, has, costs or replaces. If the\n"
    "material is not there, DROP THE PATTERN. A detail made up to fit a pattern is worse than not\n"
    "matching the pattern at all.")

GOAL_USED = "views on each video"   # the only goal metric a single script can move
MAX_SAMPLES = 4                     # captions quoted, newest first
MIN_SAMPLES = 2                     # fewer usable than this and the voice lines are dropped
MAX_AGE_DAYS = 30                   # a body older than this is ignored entirely

_TAGS = re.compile(r"[#@][^\s#@]+")
_EDGE = " -–—·|,."
_INVISIBLE = re.compile("[\u200b-\u200d\u2060\ufeff]")      # zero-width characters ride along in pasted captions and mean nothing


def enabled_for(flag_value, creator_id):
    """Is BRAIN_IN_PROMPT on for this creator? Empty/"0"/"false" is off, "1"/"true"/"all" is on for everyone, anything else is a
    comma-separated allowlist of creator uuids. Never raises."""
    try:
        v = str(flag_value if flag_value is not None else "").strip()
        low = v.lower()
        if low in ("", "0", "false"):
            return False
        if low in ("1", "true", "all"):
            return True
        cid = str(creator_id or "").strip().lower()
        return bool(cid) and cid in {p.strip().lower() for p in v.split(",") if p.strip()}
    except Exception:  # noqa: BLE001
        return False


def usable_samples(samples, limit=MAX_SAMPLES):
    """Captions that say something in words. Every #tag and @handle goes, whitespace collapses, edge punctuation is trimmed, and what is
    left must be 12+ characters and 3+ words. A caption that is only hashtags is not a voice."""
    out = []
    for s in samples if isinstance(samples, list) else []:
        t = re.sub(r"\s+", " ", _TAGS.sub(" ", _INVISIBLE.sub("", str(s or "")))).strip().strip(_EDGE).strip()
        if len(t) >= 12 and len(t.split()) >= 3:
            out.append(t)
        if len(out) >= limit:
            break
    return out


def _n(x):
    """3200 -> '3,200'. Non-integers stay as stored (a multiple is already one decimal)."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return str(x)
    return f"{int(x):,}" if float(x).is_integer() else str(x)


def _videos(n):
    return f"{_n(n)} video" if n == 1 else f"{_n(n)} videos"


def _dict(x):
    return x if isinstance(x, dict) else {}


def _fresh(built_at, now):
    try:
        t = datetime.fromisoformat(str(built_at).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return False
    return now - t <= timedelta(days=MAX_AGE_DAYS)


def _performance(w, platform_fallback=None):
    """The 'How their videos actually do' bullets, or [] when there is no usable median to measure against."""
    med = w.get("your_median_views")
    if isinstance(med, bool) or not isinstance(med, (int, float)) or med <= 0:
        return []
    out = [f"Their own median is {_n(med)} ({w.get('measured')}, {_videos(w.get('posts_counted'))} on "
           f"{w.get('platform') or platform_fallback}). The multiples below are against that."]
    for item in (w.get("beats_your_median") or [])[:3] if isinstance(w.get("beats_your_median"), list) else []:
        if isinstance(item, dict) and item.get("what"):
            out.append(f"BEATS their median: {item['what']} — {_n(item.get('times_median'))}x over {_videos(item.get('posts'))}.")
    for item in (w.get("falls_short") or [])[:3] if isinstance(w.get("falls_short"), list) else []:
        if isinstance(item, dict) and item.get("what"):
            out.append(f"FALLS SHORT: {item['what']} — {_n(item.get('times_median'))}x over {_videos(item.get('posts'))}.")
    for key, label in (("your_best", "best"), ("your_quietest", "quietest")):
        items = w.get(key) if isinstance(w.get(key), list) else []
        item = items[0] if items and isinstance(items[0], dict) else None
        if not item:
            continue
        cap = usable_samples([item.get("caption")], limit=1)     # a caption that strips to nothing says nothing: drop the line
        if cap:
            out.append(f"Their {label} of those did {_n(item.get('times_median'))}x their median, captioned \"{cap[0]}\".")
    return out


def _share(x):
    """A 0-1 share as a whole percent, or None when it is not a number in range."""
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not 0 <= x <= 1:
        return None
    return int(round(x * 100))


def _watch(w):
    """The 'How long people actually watch' bullets, or [] when there is no usable median. Plan: ~/.claude/plans/lynxr-social-insights.md.
    TWO POINTS ON THE CURVE, never the curve: how long the average viewer stayed, and one completion-ish share (TikTok: finished; Instagram:
    skipped inside the first three seconds). Neither platform exposes a retention graph, so no line here may imply one."""
    sec = w.get("your_median_seconds")
    if isinstance(sec, bool) or not isinstance(sec, (int, float)) or sec <= 0:
        return []
    out = [f"The average viewer stays about {_n(sec)}s ({w.get('measured')}, {_videos(w.get('posts_counted'))} on {w.get('platform')})."]
    frac = _share(w.get("your_median_watched_fraction"))
    if frac is not None:
        out.append(f"That is about {frac}% of the way through their videos.")
    if w.get("platform") == "tiktok":                 # each platform renders its OWN share and never the other's
        rate = _share(w.get("your_median_finished_rate"))
        if rate is not None:
            out.append(f"About {rate}% of viewers finish.")
    elif w.get("platform") == "instagram":
        rate = _share(w.get("your_median_skipped_3s_rate"))
        if rate is not None:
            out.append(f"About {rate}% skip inside the first three seconds.")
    for key, label in (("they_stayed_longest", "They stayed longest on one"), ("they_left_soonest", "They left soonest on one")):
        items = w.get(key) if isinstance(w.get(key), list) else []
        item = items[0] if items and isinstance(items[0], dict) else None
        if not item:
            continue
        cap = usable_samples([item.get("caption")], limit=1)     # a caption that strips to nothing says nothing: drop the line
        secs, of = item.get("seconds"), item.get("of_seconds")
        if cap and all(isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in (secs, of)):
            out.append(f"{label} captioned \"{cap[0]}\" — {_n(secs)}s of {_n(of)}s.")
    return out


def creator_block(body, now=None):
    """The block for this brain body, or "" meaning emit nothing. Pure: no network, no clock but `now`."""
    if not isinstance(body, dict) or body.get("v") != 1:
        return ""                                   # a future brain version must never half-leak into a prompt
    state = body.get("state")
    if state not in ("learning", "ready"):
        return ""                                   # empty is the free case and must give today's prompt exactly
    now = now or datetime.now(timezone.utc)
    if not _fresh(body.get("built_at"), now):
        return ""

    substantive = []
    hs = _dict(body.get("how_you_sound"))
    read_as = hs.get("read_as")
    if isinstance(read_as, str) and read_as.strip():
        substantive.append(f"How they write: {read_as.strip()}.")
    samples = usable_samples(hs.get("samples"))
    if len(samples) >= MIN_SAMPLES:
        substantive.append("Captions they wrote themselves — for TONE AND REGISTER ONLY. Never reuse a topic from\n"
                           "  them and never treat anything in them as true about the creator:")
        substantive += [f'  - "{s}"' for s in samples]
    if state == "ready":                            # belt and braces: a stale or hand-edited learning row must not smuggle performance in
        perf = _performance(_dict(body.get("what_works_for_you")))
        if perf:
            substantive.append("How their videos actually do:")
            substantive += [f"  - {p}" for p in perf]
        # IDENTITY IS LOAD-BEARING. A body with no `how_people_watch` key makes _watch() return [] and this branch add nothing, so the block is
        # byte-identical to what it was before watch time existed. That is what keeps the --dry-prompt hash test (flag on and off) passing for
        # every creator who has not connected an account. Inside the `ready` branch for the same reason as the performance bullets above.
        watch = _watch(_dict(body.get("how_people_watch")))
        if watch:
            substantive.append("How long people actually watch them:")
            substantive += [f"  - {x}" for x in watch]
    if not substantive:
        return ""

    rides = []
    bits = []
    for w in (body.get("where_you_post") if isinstance(body.get("where_you_post"), list) else [])[:2]:
        if not isinstance(w, dict) or not w.get("platform"):
            continue
        bit = f"{w['platform']} ({_videos(w.get('posts'))}"
        if w.get("per_week"):
            bit += f", about {_n(w['per_week'])} a week"
        bits.append(bit + ")")
    if bits:
        rides.append("Where they post: " + ", ".join(bits) + ".")
    goal = _dict(_dict(body.get("about_you")).get("goal"))
    if goal.get("metric") == GOAL_USED:
        target = f"going for {_n(goal['target'])} views a video" if goal.get("target") else ""
        at_now = f"at {_n(goal['now'])} now" if goal.get("now") is not None else ""
        if target or at_now:
            rides.append("They are " + ("; they are ".join(x for x in (target, at_now) if x)) + ".")
    for item in (body.get("working_on") if isinstance(body.get("working_on"), list) else [])[:1]:
        said = str(_dict(item).get("said") or "").strip()
        if said:
            rides.append(f"The one thing they are working on, and it wins over everything above: {said}.")

    return HEAD + "\n" + PREAMBLE + "\n" + "\n".join(substantive + rides)
