"""Lynx Media Group locked tagging taxonomy + niche/audience vocabularies.

format_type and hook_pattern come from the canonical Lynx content-tagging
taxonomy (content-tagging-taxonomy skill). Do not add values here without
adding them to the skill first — tag drift breaks week-over-week comparability.
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
        "videos": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "format_type": {"type": "string", "enum": FORMAT_TYPES},
                    "hook_pattern": {"type": "string", "enum": HOOK_PATTERNS},
                    "niche_category": {"type": "string", "enum": NICHE_CATEGORIES},
                    "target_audience": {"type": "string", "enum": TARGET_AUDIENCES},
                },
                "required": [
                    "index",
                    "format_type",
                    "hook_pattern",
                    "niche_category",
                    "target_audience",
                ],
                "additionalProperties": False,
            },
        }
    },
    "required": ["videos"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = f"""You are a content tagger for Lynxr, a short-form video format intelligence platform. \
You tag social videos (TikTok/Instagram/YouTube/Facebook) using a LOCKED taxonomy. \
You only see each video's title/caption text (including hashtags), not the video itself, \
so tag from textual evidence only.

Tag every video with exactly one value per dimension:

format_type — the structural shape of the video: {", ".join(FORMAT_TYPES)}.
Only pick a specific format when the text clearly signals it (e.g. "POV:" prefix -> POV; \
"3 things" / numbered tips -> Listicle; "storytime" -> Story Time). \
If the text gives no structural signal, use "Other".

hook_pattern — the psychological angle of the opening: {", ".join(HOOK_PATTERNS)}.
Curiosity Gap = withholds payoff ("nobody tells you..."); Bold Claim = contrarian/absolute statement; \
Surprising Stat = a scroll-stopping number; Relatable Pain = names a frustration; \
Us vs Them = insider/outsider or comparison framing; Question = direct question to viewer; \
Warning = "stop doing X" / mistake framing; Social Proof = "everyone's switching..."; \
Transformation = before/after. Use "Other" when no angle is evident from the text.

niche_category — the content vertical: {", ".join(NICHE_CATEGORIES)}.

target_audience — who the video is for: {", ".join(TARGET_AUDIENCES)}.

Rules:
- One value per dimension, pick the dominant one.
- Never invent values outside the lists.
- Prefer "Other" over guessing when textual evidence is weak (this feeds a scoreboard; \
a wrong confident tag is worse than "Other").
- Use hashtags as evidence (e.g. #nursingschool -> Health & Medical / Students).
- Return one result object per input video, with the matching index."""
