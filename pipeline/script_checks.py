"""Pure, offline checks on one adaptation. No network, no import of
process_adaptations, stdlib only — this module has to be importable by
eval_scripts.py (which blocks every live write at import time) and by
process_adaptations.py itself (Step 9's tidy() call) without either one
pulling in the other's side effects.

Every function here takes plain dicts (an adaptation, a source, a format, a
brand) and returns a plain value. Nothing here talks to Supabase, the
Anthropic API, or the filesystem.
"""

import json
import re

# ---------------------------------------------------------------- ported
# Verbatim from ~/.claude/plans/script-accuracy.md step 7 (lines ~287-330),
# except _FACT gains a case-insensitive "link in bio" alternative (E4/E5:
# "OncourseAI is linked" and "link in bio" show up as unbacked product
# claims that the original regex would have missed).
_WORD = re.compile(r"[\w']+")


def _words(s):
    return [w.lower() for w in _WORD.findall(str(s or "").replace("’", "'"))]


def _strip_leading(text, words_):
    """`text` minus a leading run of exactly `words_` (case/punctuation-insensitive), else None.
    U+2019 -> ' keeps the string length, so match offsets index the original."""
    t = str(text or "").replace("’", "'")
    ms, n = list(_WORD.finditer(t)), len(words_)
    if not n or len(ms) < n or [m.group(0).lower() for m in ms[:n]] != words_:
        return None
    return str(text)[ms[n - 1].end():].lstrip(" \t\n,.;:!?…—–-\"“”")


def _strip_trailing(text, words_):
    t = str(text or "").replace("’", "'")
    ms, n = list(_WORD.finditer(t)), len(words_)
    if not n or len(ms) < n or [m.group(0).lower() for m in ms[-n:]] != words_:
        return None
    return str(text)[:ms[-n].start()].rstrip(" \t\n,;:—–-\"“”")


_DIRECTION = re.compile(
    r"^\s*\(|^\s*(?:payoff|hook|cta|intro|outro|say|do|show|beat \d+|scene \d+)\s*:"
    r"|\((?:none|pause|beat|cut|b-?roll|on[- ]?screen|v\.?o\.?|voice ?over|laughs?|sighs?|whispers?"
    r"|to camera|no cta)\b[^)]*\)", re.I)

_FACT = re.compile(
    r"\b[a-z0-9-]+\.(?:com|app|ai|io|co|net|org|gg|me|tv)\b|(?<![\w.])@[a-z0-9_.]{3,}"
    r"|\$\s?\d|\b\d+(?:\.\d+)?\s?%|\bfree\b|\b(?:discount|promo|coupon)\b"
    r"|\blink in bio\b", re.I)

_HASHTAG = re.compile(r"#\w+")


# ---------------------------------------------------------------- new (Step 2)
def words(s):
    """Same tokenisation as `_words` above, exposed under the plain name the
    rest of this module (and eval_scripts.py) uses."""
    return re.findall(r"[a-z0-9']+", str(s or "").lower().replace("’", "'"))


def shown_words(ad):
    """Total words the viewer HEARS: hook + every beat's say + cta. 0 for a
    silent script — nothing here is spoken, so it cannot run long or short
    against the source's spoken word count."""
    ad = ad or {}
    if ad.get("delivery") != "spoken":
        return 0
    n = len(words(ad.get("hook"))) + len(words(ad.get("cta")))
    for b in (ad.get("beats") or []):
        n += len(words(b.get("say")))
    return n


def say_words(ad):
    """Sum of every beat's `say`, regardless of delivery (a silent script's
    say fields should all be empty, and this is one of the ways that gets
    checked)."""
    ad = ad or {}
    return sum(len(words(b.get("say"))) for b in (ad.get("beats") or []))


def hook_repeated(ad):
    """Spoken only. True when beat 1's `say` restates ≥70% of the hook's own
    words — the card draws Hook, then the beats, so a repeat is heard twice."""
    ad = ad or {}
    if ad.get("delivery") != "spoken":
        return False
    beats = ad.get("beats") or []
    if not beats:
        return False
    h = set(words(ad.get("hook")))
    if not h:
        return False
    b1 = set(words(beats[0].get("say")))
    return (len(h & b1) / len(h)) >= 0.7


def cta_repeated(ad):
    """Same idea as hook_repeated, against the CTA and the LAST beat's say."""
    ad = ad or {}
    if ad.get("delivery") != "spoken":
        return False
    beats = ad.get("beats") or []
    if not beats:
        return False
    h = set(words(ad.get("cta")))
    if not h:
        return False
    bl = set(words(beats[-1].get("say")))
    return (len(h & bl) / len(h)) >= 0.7


def word_ratio(ad, src):
    """shown_words / the source's own spoken word count. None unless the
    source has speech and at least 15 words — below that a ratio is noise,
    not a signal."""
    src = src or {}
    script = src.get("script") or {}
    if not script.get("has_speech"):
        return None
    src_words = words(script.get("text"))
    if len(src_words) < 15:
        return None
    return shown_words(ad) / len(src_words)


def say_ratio(ad, src):
    """Same gate as word_ratio, but only the beats' `say` — i.e. with the
    hook and cta lines excluded, since those are read once each regardless
    of length."""
    src = src or {}
    script = src.get("script") or {}
    if not script.get("has_speech"):
        return None
    src_words = words(script.get("text"))
    if len(src_words) < 15:
        return None
    return say_words(ad) / len(src_words)


_NUM = re.compile(r"[\d.]+")


def runs_past(ad, src):
    """True when the last beat's own timing claims to run past 1.15x the
    source's real duration."""
    ad, src = ad or {}, src or {}
    beats = ad.get("beats") or []
    dur = src.get("duration")
    if not beats or not dur or dur <= 0:
        return False
    nums = _NUM.findall(str(beats[-1].get("t") or ""))
    if not nums:
        return False
    return float(nums[-1]) > 1.15 * dur


_SLOT = re.compile(r"\[[^\]]{3,80}\]")


def slots(ad):
    """Count of [bracketed slots] across hook, cta, caption and every beat's
    say/show."""
    ad = ad or {}
    beats = ad.get("beats") or []
    text = " ".join(
        [str(ad.get("hook") or ""), str(ad.get("cta") or ""), str(ad.get("caption") or "")]
        + [str(b.get("say") or "") for b in beats]
        + [str(b.get("show") or "") for b in beats]
    )
    return len(_SLOT.findall(text))


def unbacked_tokens(ad, brand):
    """_FACT matches (a site, an @handle, a price, a percent, "free",
    "discount"/"promo"/"coupon", "link in bio") across hook/cta/caption/every
    say and show, whose lowercase text does not appear anywhere in the
    brand's own lowercased name+description+site+objective+niche. Returns the
    list of distinct tokens found — callers that must not persist real script
    text (eval_scripts.py's `audit`) record only `len(...)`, never this list."""
    ad, brand = ad or {}, brand or {}
    blob = " ".join(str(brand.get(k) or "")
                    for k in ("name", "description", "site", "objective", "niche")).lower()
    beats = ad.get("beats") or []
    fields = ([ad.get("hook"), ad.get("cta"), ad.get("caption")]
              + [b.get("say") for b in beats]
              + [b.get("show") for b in beats])
    out, seen = [], set()
    for f in fields:
        for m in _FACT.finditer(str(f or "")):
            tok = m.group(0).lower()
            if tok in seen or tok in blob:
                continue
            seen.add(tok)
            out.append(tok)
    return out


def cta_problem(ad):
    """"empty" / "direction" / None."""
    ad = ad or {}
    cta = str(ad.get("cta") or "").strip()
    if not cta:
        return "empty"
    if _DIRECTION.search(cta):
        return "direction"
    return None


# A literal "\uXXXX" or "\neXXXXX" (5 hex chars) surviving INTO the model's
# text, seen live 2026-09-14 (script-accuracy.md's audit): an en dash came
# back as a newline plus its UTF-8 bytes in hex. json.dumps(..., ensure_ascii=
# False) doubles a literal backslash that is already IN the string (JSON
# itself must escape a backslash as \\), so the doubled form is what a scan
# of the dumped text is looking for.
_ESCAPED_LITERAL = re.compile(r"\\\\u[0-9a-fA-F]{4}|\\\\ne[0-9a-f]{5}")


def escaped(ad):
    dumped = json.dumps(ad or {}, ensure_ascii=False)
    return bool(_ESCAPED_LITERAL.search(dumped))


def caption_reuses_source_tags(ad, src):
    """Hashtags the adaptation's caption shares with the source's own caption
    (or, absent that, its meta title) — the original video's hashtags leaking
    into a different brand's post."""
    ad, src = ad or {}, src or {}
    src_text = src.get("caption") or (src.get("meta") or {}).get("title") or ""
    src_tags = {t.lower() for t in _HASHTAG.findall(str(src_text))}
    ad_tags = {t.lower() for t in _HASHTAG.findall(str(ad.get("caption") or ""))}
    return sorted(src_tags & ad_tags)


def product_entry(ad, brand_name):
    """Where the product actually shows up: the index of the first beat
    whose say (show, if silent) contains the brand name's first 3+-letter
    word, bucketed the same way the format's own `product_entry` is
    (early/mid/late), or "none" if it never appears."""
    ad = ad or {}
    beats = ad.get("beats") or []
    n = len(beats)
    if not n:
        return "none"
    silent = ad.get("delivery") != "spoken"
    name_words = [w for w in words(brand_name) if len(w) >= 3]
    if not name_words:
        return "none"
    target = name_words[0]
    for i, b in enumerate(beats):
        field = b.get("show") if silent else b.get("say")
        if target in words(field):
            if i < n / 3:
                return "early"
            if i < 2 * n / 3:
                return "mid"
            return "late"
    return "none"


def delivery_match(ad, src):
    """A no-speech source must get a silent script with every `say` empty;
    a spoken source must get delivery="spoken"."""
    ad, src = ad or {}, src or {}
    has_speech = (src.get("script") or {}).get("has_speech")
    beats = ad.get("beats") or []
    if not has_speech:
        return ad.get("delivery") == "silent" and all(
            not str(b.get("say") or "").strip() for b in beats)
    return ad.get("delivery") == "spoken"


_HANDLE_TAG_URL = re.compile(
    r"#\w+|@\w+|https?://\S+|\b[a-z0-9-]+\.(?:com|app|ai|io|co|net|org|gg|me|tv)\S*", re.I)


def lowercase_lines(ad):
    """hook/cta/caption/say strings of at least 12 letters that come back
    with NO uppercase letter at all once #tags, @handles and URLs are
    stripped out — the house lowercase CSS only changes what is DRAWN, so a
    script that is all-lowercase in the data itself means the model typed it
    that way, and copy-to-clipboard will carry it verbatim."""
    ad = ad or {}
    fields = [ad.get("hook"), ad.get("cta"), ad.get("caption")] + \
        [b.get("say") for b in (ad.get("beats") or [])]
    out = []
    for f in fields:
        s = str(f or "")
        if sum(1 for c in s if c.isalpha()) < 12:
            continue
        stripped = _HANDLE_TAG_URL.sub("", s)
        if stripped.strip() and not any(c.isupper() for c in stripped):
            out.append(s)
    return out


def check(ad, src, fmt, brand):
    """Everything above, in one dict. Pure — never mutates its arguments."""
    ad, src, fmt, brand = ad or {}, src or {}, fmt or {}, brand or {}
    pe = product_entry(ad, brand.get("name"))
    return {
        "hook_repeated": hook_repeated(ad),
        "cta_repeated": cta_repeated(ad),
        "word_ratio": word_ratio(ad, src),
        "say_ratio": say_ratio(ad, src),
        "runs_past": runs_past(ad, src),
        "slots": slots(ad),
        "unbacked_tokens": unbacked_tokens(ad, brand),
        "cta_problem": cta_problem(ad),
        "escaped": escaped(ad),
        "caption_reuses_source_tags": caption_reuses_source_tags(ad, src),
        "product_entry": pe,
        "product_entry_match": pe == fmt.get("product_entry"),
        "delivery_match": delivery_match(ad, src),
        "lowercase_lines": lowercase_lines(ad),
    }


def tidy(ad):
    """(new_ad, fixed) on a json round-trip copy of `ad` — never mutates the
    input. Strips a hook that beat 1's say starts with, and a cta that the
    last beat's say ends with; a partial (set-overlap but not a literal
    leading/trailing run) overlap is left alone, since there is nothing safe
    to cut."""
    new_ad = json.loads(json.dumps(ad or {}))
    fixed = []
    beats = new_ad.get("beats") or []
    if hook_repeated(new_ad) and beats:
        stripped = _strip_leading(beats[0].get("say"), words(new_ad.get("hook")))
        if stripped is not None:
            beats[0]["say"] = stripped
            fixed.append("hook_repeated")
    if cta_repeated(new_ad) and beats:
        stripped = _strip_trailing(beats[-1].get("say"), words(new_ad.get("cta")))
        if stripped is not None:
            beats[-1]["say"] = stripped
            fixed.append("cta_repeated")
    return new_ad, fixed
