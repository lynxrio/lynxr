"""Claude calls and cost accounting. The only module that imports `anthropic`.

Every call asks for one JSON object (output_config.format = json_schema), never HTML.
Counts and wording rules are enforced by gate.py, not by the schema.
"""
import json
import os
import pathlib
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent

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
_SCORES = ["answers_first", "useful_specific", "ugc_focus", "originality", "voice"]
JUDGE = {"type": "object", "additionalProperties": False,
         "required": ["verdict", "scores", "blocking_issues", "revision_notes"],
         "properties": {
             "verdict": {"type": "string", "enum": ["pass", "revise"]},
             "scores": {"type": "object", "additionalProperties": False, "required": _SCORES,
                        "properties": {k: {"type": "integer", "enum": [1, 2, 3, 4, 5]} for k in _SCORES}},
             "blocking_issues": {"type": "array", "items": {"type": "string"}},
             "revision_notes": {"type": "array", "items": {"type": "string"}}}}
REPLENISH = {"type": "object", "additionalProperties": False, "required": ["questions"],
             "properties": {"questions": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                            "required": ["topic", "question", "slug", "target_query", "angle"],
                            "properties": {"topic": {"type": "string"}, "question": {"type": "string"},
                                           "slug": {"type": "string"}, "target_query": {"type": "string"},
                                           "angle": {"type": "string"}}}}}}
SMOKE = {"type": "object", "additionalProperties": False, "required": ["ok"],
         "properties": {"ok": {"type": "boolean"}}}

BETA = "server-side-fallback-2026-07-01"


class BudgetExceeded(Exception):
    pass


class LLMError(Exception):
    pass


def cost_usd(usage, prices):
    """usage: dict with input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens."""
    g = lambda k: (usage.get(k) or 0)
    return (g("input_tokens") * prices["input"] + g("cache_creation_input_tokens") * prices["cache_write"]
            + g("cache_read_input_tokens") * prices["cache_read"] + g("output_tokens") * prices["output"]) / 1e6


class LLM:
    def __init__(self, cfg, root=None):
        self.cfg = cfg
        self.root = pathlib.Path(root) if root else HERE.parent.parent
        self.model = cfg["model"]
        self.effort = os.environ.get("UGC_AGENT_EFFORT") or cfg.get("effort_default", "high")
        self.max_run = float(os.environ.get("UGC_AGENT_MAX_RUN_USD") or cfg.get("max_run_usd_default", 4.0))
        self.prices = cfg["price_per_mtok"]
        self.total = 0.0
        self.notes = []
        self.use_fallbacks = True
        self._client = None

    @property
    def client(self):
        if self._client is None:
            import anthropic
            self._client = anthropic.Anthropic()
        return self._client

    def prompt(self, name):
        return (HERE / "prompts" / name).read_text(encoding="utf-8")

    def generator_system(self):
        text = self.prompt("system.txt")
        ref = self.root / "tools/ugc_agent/articles/ugc-script-for-skincare.json"
        if ref.is_file():
            a = json.loads(ref.read_text(encoding="utf-8"))
            sample = {k: a[k] for k in ("description", "short_answer", "sections")}
            text += ("\nREFERENCE ANSWER (voice and depth only; reuse none of its sentences, hooks or examples):\n"
                     + json.dumps(sample, ensure_ascii=False, indent=2) + "\n")
        return text

    def _call(self, system, user_text, schema, label="call"):
        if self.total >= self.max_run:
            raise BudgetExceeded("run spend $%.2f has reached the cap $%.2f" % (self.total, self.max_run))
        import anthropic
        base = dict(model=self.model, max_tokens=16000,
                    system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                    messages=[{"role": "user", "content": user_text}])

        def build(fallbacks):
            body = {"output_config": {"effort": self.effort, "format": {"type": "json_schema", "schema": schema}}}
            kw = dict(base)
            if fallbacks:
                body["fallbacks"] = "default"
                kw["extra_headers"] = {"anthropic-beta": BETA}
            kw["extra_body"] = body
            return kw

        started = time.time()
        try:
            resp = self.client.messages.create(**build(self.use_fallbacks))
        except anthropic.BadRequestError as e:
            msg = str(e).lower()
            if self.use_fallbacks and ("fallbacks" in msg or "anthropic-beta" in msg or "beta" in msg):
                self.use_fallbacks = False
                self.notes.append("fallbacks unsupported")
                resp = self.client.messages.create(**build(False))
            else:
                raise LLMError("API 400: %s" % str(e)[:300])
        except anthropic.APIError as e:
            raise LLMError("API error: %s" % str(e)[:300])
        usage = {k: getattr(resp.usage, k, 0) or 0 for k in
                 ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")}
        usd = cost_usd(usage, self.prices)
        self.total += usd
        info = {"model": resp.model, "stop_reason": resp.stop_reason, "usage": usage, "cost": usd}
        print("llm %s: $%.4f in %ds, stop=%s, model=%s, run total $%.4f"
              % (label, usd, time.time() - started, resp.stop_reason, resp.model, self.total), file=sys.stderr, flush=True)
        if resp.stop_reason != "end_turn":
            raise LLMError("stop_reason %s (cost $%.4f)" % (resp.stop_reason, usd))
        block = next((b for b in resp.content if getattr(b, "type", None) == "text"), None)
        if block is None:
            raise LLMError("no text block in the response")
        try:
            return json.loads(block.text), info
        except ValueError as e:
            raise LLMError("response was not JSON: %s" % e)

    def generate(self, payload):
        return self._call(self.generator_system(), json.dumps(payload, ensure_ascii=False, indent=2), ARTICLE, "generate")

    def revise(self, payload, previous, problems):
        p = dict(payload)
        p["revision"] = {"previous": previous, "problems": problems}
        return self._call(self.generator_system(), json.dumps(p, ensure_ascii=False, indent=2), ARTICLE, "revise")

    def judge(self, context):
        return self._call(self.prompt("judge.txt"), json.dumps(context, ensure_ascii=False, indent=2), JUDGE, "judge")

    def replenish(self, context):
        return self._call(self.prompt("replenish.txt"), json.dumps(context, ensure_ascii=False, indent=2), REPLENISH, "replenish")

    def smoke(self):
        return self._call("You are a connectivity test. Reply with the JSON object requested.", 'Return {"ok": true}.', SMOKE, "smoke")
