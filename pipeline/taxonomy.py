"""Lynxr tagging taxonomy + niche/audience vocabularies.

Base format/hook values come from the canonical Lynx content-tagging taxonomy.
EXTENSION (2026-07-30): after mining the Other buckets (4-miner + synthesis
workflow over the real caption data), one format value and four hook values
were added — each absorbs a proven 40+ row cluster that no existing value
covers. If the Lynx Media Group skill taxonomy is the source of truth for
client work, sync these additions there.

The tagger is FORCED-CHOICE: Other is only for genuinely unintelligible text.
"""

FORMAT_TYPES = [
    "Talking Head",
    "POV",
    "Listicle",
    "Skit",
    "Screen Demo",
    "Reaction / Duet",
    "Story Time",
    "Green Screen",
    "Voiceover B-roll",
    "Meme / Trend Clip",   # ext: emote/lip-sync over trend audio; text carries the message
    "Other",
]

HOOK_PATTERNS = [
    "Curiosity Gap",
    "Bold Claim",
    "Surprising Stat",
    "Relatable Pain",
    "Us vs Them",
    "Question",
    "Warning",
    "Social Proof",
    "Transformation",
    "No Hook",             # ext: no textual device at all (empty/hashtag-only/flat announcement)
    "Direct CTA",          # ext: imperative command is the pull (search/download/go)
    "Audience Call-Out",   # ext: names/addresses the viewer segment; belonging, not command
    "Emotional Share",     # ext: creator's own first-person sentiment
    "Other",
]

# Visual Hook — what is on screen in frame one. From the locked Lynx taxonomy;
# only fillable once we can actually see the frame.
VISUAL_HOOKS = [
    "Face Close-up",
    "Motion / Movement",
    "Text-first",
    "Product On-screen",
    "Pattern Interrupt",
    "Location Reveal",
    "None",
    "Other",
]

# CTA Type — the single call to action. Exactly one per video. From the locked
# taxonomy; taggable from caption + transcript (text evidence).
CTA_TYPES = [
    "Search Product",
    "Link in Bio",
    "Comment Prompt",
    "It's Free",
    "Try It",
    "Soft / Implied",
    "None",
    "Other",
]

# Hook Delivery — HOW the spoken hook is performed. This dimension genuinely
# needs the audio/video: deadpan vs high-energy vs whisper cannot be told from a
# transcript's words or a single still. We only assign a specific value when the
# evidence actually shows it (a shocked face in the cover frame; a clearly
# narrative transcript). Everything else is "Other" — an honest "can't tell from
# what we have", not a guess. Never infer energy from text alone.
HOOK_DELIVERIES = [
    "Deadpan",
    "High Energy",
    "Whisper / Intimate",
    "Shocked Face",
    "Storytelling",
    "Fast-cut",
    "Other",
]

# Length Bucket — derived mechanically from the video's duration in seconds.
# No model involved; edges from the locked taxonomy.
LENGTH_BUCKETS = ["0–10s", "11–20s", "21–34s", "35–59s", "60s+"]


def length_bucket(seconds):
    """Map a duration in seconds to its taxonomy bucket, or '' if unknown."""
    try:
        s = float(seconds)
    except (TypeError, ValueError):
        return ""
    if s <= 0:
        return ""
    if s <= 10:
        return "0–10s"
    if s <= 20:
        return "11–20s"
    if s <= 34:
        return "21–34s"
    if s <= 59:
        return "35–59s"
    return "60s+"

NICHE_CATEGORIES = [
    "Health & Medical",
    "Education & Study",
    "Fitness",
    "Music & Audio",
    "Finance & Fintech",
    "Dating & Relationships",
    "Productivity & Apps",
    "Marketing & Business",
    "Tech & Software",
    "Fashion & Beauty",
    "Lifestyle & Entertainment",
    "Other",
]

TARGET_AUDIENCES = [
    "Students",
    "Healthcare Professionals",
    "Fitness Enthusiasts",
    "Musicians & Creators",
    "Young Professionals",
    "Entrepreneurs & Marketers",
    "Developers & Founders",
    "General Consumers",
    "Other",
]

TAG_SCHEMA = {
    "type": "object",
    "properties": {
        "format_type": {"type": "string", "enum": FORMAT_TYPES},
        "hook_pattern": {"type": "string", "enum": HOOK_PATTERNS},
        "niche_category": {"type": "string", "enum": NICHE_CATEGORIES},
        "target_audience": {"type": "string", "enum": TARGET_AUDIENCES},
    },
    "required": ["format_type", "hook_pattern", "niche_category", "target_audience"],
    "additionalProperties": False,
}

# Extra-dimension tagger (cta_type, visual_hook, hook_delivery, onscreen_text).
# WITH an opening frame attached — visual_hook is answerable.
TAG_SCHEMA_EXTRA_VISION = {
    "type": "object",
    "properties": {
        "cta_type": {"type": "string", "enum": CTA_TYPES},
        "visual_hook": {"type": "string", "enum": VISUAL_HOOKS},
        "onscreen_text": {"type": "string",
                          "description": "Text visible in the opening frame, verbatim; empty if none."},
        "hook_delivery": {"type": "string", "enum": HOOK_DELIVERIES},
    },
    "required": ["cta_type", "visual_hook", "onscreen_text", "hook_delivery"],
    "additionalProperties": False,
}

# No opening frame — visual_hook can't be judged, so it's not requested (the row
# is left blank downstream). cta_type and hook_delivery still come from text.
TAG_SCHEMA_EXTRA = {
    "type": "object",
    "properties": {
        "cta_type": {"type": "string", "enum": CTA_TYPES},
        "hook_delivery": {"type": "string", "enum": HOOK_DELIVERIES},
    },
    "required": ["cta_type", "hook_delivery"],
    "additionalProperties": False,
}

SYSTEM_EXTRA = f"""You tag short-form videos for Lynxr against a LOCKED taxonomy. \
You are adding THREE dimensions to already-tagged rows; do not re-judge format or hook. \
You get the caption, and when available the spoken hook + full transcript and the \
opening frame. Commit to one value per dimension.

cta_type — the single call to action, if any: {", ".join(CTA_TYPES)}.
- "search/look up/find X" (search the app/product by name) -> Search Product.
- "link in bio", "in my bio", "check the link" -> Link in Bio.
- "comment X", "drop a Y below", "let me know" -> Comment Prompt.
- explicit "it's FREE", "free to use", "no cost" as the pull -> It's Free.
- "try it", "give it a go", "you should use this" -> Try It.
- no explicit ask, but the video clearly nudges toward the product without an \
  imperative -> Soft / Implied.
- genuinely no call to action -> None. Other only for a real CTA that fits nothing above.

hook_delivery — HOW the opening is performed. This needs real audio/video evidence, \
which you mostly DO NOT have (a transcript is words, not tone; a cover is one still). \
Be strict and honest:
- Assign "Shocked Face" ONLY if the attached frame visibly shows a shocked/exaggerated expression.
- Assign "Storytelling" ONLY if the transcript is a clear first-person narrative recount \
  ("so yesterday I...", "let me tell you what happened").
- "Deadpan", "High Energy", "Whisper / Intimate", "Fast-cut" require hearing or seeing \
  the delivery, which you cannot from text + one frame — do NOT guess these from wording \
  or punctuation. If the evidence does not clearly show one of the two cases above, answer \
  "Other". "Other" here means "not determinable from the available evidence", and that is \
  the correct, expected answer for most rows. Never infer energy from an exclamation mark \
  or an emoji.

visual_hook (only when an opening frame is attached) — what is on screen in frame one: \
{", ".join(VISUAL_HOOKS)}. A face filling the frame -> Face Close-up; text burned over the \
video before anything else reads -> Text-first; the product or an app UI visible -> \
Product On-screen; an unexpected object/action -> Pattern Interrupt; a place shown off -> \
Location Reveal; motion as the opener -> Motion / Movement; a plain, static, unremarkable \
opener -> None.
onscreen_text (only with a frame) — transcribe text burned into the frame, verbatim; empty if none."""

# Used by the vision pass, which can also see the opening frame.
TAG_SCHEMA_VISION = {
    "type": "object",
    "properties": {
        "format_type": {"type": "string", "enum": FORMAT_TYPES},
        "hook_pattern": {"type": "string", "enum": HOOK_PATTERNS},
        "niche_category": {"type": "string", "enum": NICHE_CATEGORIES},
        "target_audience": {"type": "string", "enum": TARGET_AUDIENCES},
        "visual_hook": {"type": "string", "enum": VISUAL_HOOKS},
        "onscreen_text": {"type": "string",
                          "description": "Text visible in the frame, verbatim; empty if none."},
    },
    "required": ["format_type", "hook_pattern", "niche_category",
                 "target_audience", "visual_hook", "onscreen_text"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = f"""You are a content tagger for Lynxr, a short-form video format intelligence platform. \
You see each video's caption text (with hashtags) plus source context, not the video itself. \
You MUST commit to the single most plausible value for every dimension. "Other" is reserved for \
genuinely unintelligible text — never for "unsure". When torn, classify by the caption's first clause.

format_type — the structural shape of the video: {", ".join(FORMAT_TYPES)}.
Routing rules (derived from ground-truth data):
- First-person app endorsement voice ("it's called X and it's FREE", "thank me later", \
"search/visit X", "leaking/ungatekeeping the method", "helping my fellow students", "incredible resource") -> Talking Head.
- Caption describes the app/screen itself ("you can download X from the App Store", feature \
walk-throughs, third-person app description) -> Screen Demo. Tiebreak: endorsement voice -> Talking Head; \
product-centred description -> Screen Demo.
- Enumerated/top-N phrasing ("my top five", "YOU NEED THESE", "5 items every EMT should have") -> Listicle; \
a single spoken method/explanation -> Talking Head.
- Personal outcome reveal ("Passed my NREMT in 70 questions", "it rlly worked") -> Story Time.
- Relatable one-liner or meme-template caption with no pitch and no instruction -> Meme / Trend Clip \
(requires positive meme evidence — never the dump bucket).
- "POV:" prefix -> POV. Acted scene/characters -> Skit. Stitch/reply-to-video phrasing -> Reaction / Duet.
- Hashtag-only/empty captions: use the source context line — Medceptor campaign -> Talking Head, \
organic scrape -> Screen Demo — unless a creator-modal format is given, which wins.

hook_pattern — the psychological device of the caption's opening: {", ".join(HOOK_PATTERNS)}.
Decision ORDER (first match wins, on hashtag/mention/emoji-stripped text):
1. No real text left (or under ~3 chars) -> No Hook.
2. Imperative action verb aimed at the viewer anywhere (search/download/visit/use/try/follow/comment/tag/go/get/save) -> Direct CTA \
(a command outranks an audience address).
3. Names/addresses a viewer segment or offers help/luck/solidarity without a command \
("for my X", "i gotchu", "hope this helps", "ATTN", "good luck") -> Audience Call-Out.
4. First-person creator sentiment (miss/proud/thank you/sad/love) -> Emotional Share — unless framed \
as a struggle the audience shares, which is Relatable Pain (creator-centric = Emotional Share; audience-shared = Relatable Pain).
5. Genuine question to the audience -> Question.
6. Withheld payoff -> Curiosity Gap. Superlative/contrarian assertion -> Bold Claim. Scroll-stopping \
number -> Surprising Stat. "stop doing X" -> Warning. "everyone's switching" -> Social Proof. \
Before/after -> Transformation. Insider/outsider contrast -> Us vs Them.
7. Flat announcement with no device -> No Hook. Low-context in-joke with no shared referent -> No Hook. \
No Hook is a positive claim that no device exists — never a fallback for unsure.
Foreign-language captions: translate mentally, then apply the same order.

niche_category — the content vertical: {", ".join(NICHE_CATEGORIES)}. \
Tie-break: medical-certification exam prep (NREMT/NCLEX/EMT school/nursing school) -> Health & Medical, not Education & Study.

target_audience — who the video is for: {", ".join(TARGET_AUDIENCES)}. \
Rule: any exam-prep/test-prep/school content (NREMT, EMT school, nursing school, NCLEX, studytok) -> Students, \
NOT Healthcare Professionals. Healthcare Professionals is for practicing-clinician content only.

Return one object with all four fields."""
