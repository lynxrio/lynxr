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
