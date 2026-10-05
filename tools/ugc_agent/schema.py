"""JSON shapes the Claude-driven routine reads and writes, and a tiny validator for them. Standard library only.

ARTICLE is what a candidate file holds, JUDGE is what a reviewer's verdict file holds, REPLENISH is what a batch
of proposed questions holds. Counts and wording rules live in gate.py, not here.
"""

ARTICLE = {"type": "object", "additionalProperties": False,
           "required": ["description", "short_answer", "sections"],
           "properties": {
               "description": {"type": "string"},
               "short_answer": {"type": "string"},
               "sections": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                            "required": ["heading", "blocks"],
                            "properties": {
                                "heading": {"type": "string"},
                                "blocks": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                           "required": ["kind", "text", "items", "table_head", "table_rows",
                                                        "script_caption", "script_beats"],
                                           "properties": {
                                               "kind": {"type": "string", "enum": ["paragraph", "list", "table", "script"]},
                                               "text": {"type": "string"},
                                               "items": {"type": "array", "items": {"type": "string"}},
                                               "table_head": {"type": "array", "items": {"type": "string"}},
                                               "table_rows": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}},
                                               "script_caption": {"type": "string"},
                                               "script_beats": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                                "required": ["part", "say", "do"],
                                                                "properties": {"part": {"type": "string", "enum": ["hook", "setup", "beat 1", "beat 2", "beat 3", "beat 4", "turn", "close"]},
                                                                               "say": {"type": "string"}, "do": {"type": "string"}}}}}}}}}}}}
SCORES = ["answers_first", "useful_specific", "ugc_focus", "originality", "voice"]
JUDGE = {"type": "object", "additionalProperties": False,
         "required": ["verdict", "scores", "blocking_issues", "revision_notes"],
         "properties": {
             "verdict": {"type": "string", "enum": ["pass", "revise"]},
             "scores": {"type": "object", "additionalProperties": False, "required": SCORES,
                        "properties": {k: {"type": "integer", "enum": [1, 2, 3, 4, 5]} for k in SCORES}},
             "blocking_issues": {"type": "array", "items": {"type": "string"}},
             "revision_notes": {"type": "array", "items": {"type": "string"}}}}
REPLENISH = {"type": "object", "additionalProperties": False, "required": ["questions"],
             "properties": {"questions": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                            "required": ["topic", "question", "slug", "target_query", "angle"],
                            "properties": {"topic": {"type": "string"}, "question": {"type": "string"},
                                           "slug": {"type": "string"}, "target_query": {"type": "string"},
                                           "angle": {"type": "string"}}}}}}


def validate(schema, value, path="$"):
    """Problems (list of strings) for value against the small schema subset used above."""
    t = schema.get("type")
    out = []
    if t == "object":
        if not isinstance(value, dict):
            return ["%s: expected an object" % path]
        for k in schema.get("required", []):
            if k not in value:
                out.append("%s: missing %r" % (path, k))
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for k in value:
                if k not in props:
                    out.append("%s: unexpected key %r" % (path, k))
        for k, v in value.items():
            if k in props:
                out += validate(props[k], v, "%s.%s" % (path, k))
    elif t == "array":
        if not isinstance(value, list):
            return ["%s: expected a list" % path]
        for i, v in enumerate(value):
            out += validate(schema["items"], v, "%s[%d]" % (path, i))
    elif t == "string":
        if not isinstance(value, str):
            return ["%s: expected a string" % path]
    elif t == "integer":
        if not isinstance(value, int) or isinstance(value, bool):
            return ["%s: expected an integer" % path]
    if "enum" in schema and value not in schema["enum"]:
        out.append("%s: %r is not one of %s" % (path, value, schema["enum"]))
    return out
