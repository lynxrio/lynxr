"""Synthetic-only deterministic companion to eval_scripts.py; stdlib and script_checks only.

This module never imports the production worker, loads environments, or opens a network.
Fixture thresholds are harness conditions, not product or milestone acceptance criteria.
"""

import argparse
import hashlib
import json
import math
import re
from itertools import pairwise
from pathlib import Path

import script_checks as SC

FIXTURES = Path(__file__).parent / "fixtures" / "script_quality_synthetic.json"
_PROMISE = re.compile(r"\b(?:guarantee(?:d|s)?|clinically proven|cures?|risk[- ]free)\b", re.IGNORECASE)
_RANGE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(?:s\s*)?[-–—]\s*(\d+(?:\.\d+)?)\s*s?\s*$")


def positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def evaluate(case):
    """Return observations without altering a fixture or repairing its script."""
    checks = []

    def record(code, status, detail):
        checks.append({"code": code, "status": status, "detail": detail})

    ad = case.get("adaptation")
    src = case.get("source")
    fmt = case.get("format")
    brand = case.get("brand")
    conditions = case.get("conditions", {})
    if not isinstance(ad, dict):
        record("structure.script", "fail", "adaptation must be an object")
        return result(case, checks, {})
    beats = ad.get("beats")
    valid_beats = isinstance(beats, list) and bool(beats) and all(isinstance(b, dict) for b in beats)
    if not valid_beats:
        record("structure.beats", "fail", "beats must be a nonempty list of objects")
        return result(case, checks, {})
    fields_ok = all(isinstance(ad.get(k), str) for k in ("hook", "cta", "caption"))
    fields_ok &= all(isinstance(b.get(k), str) for b in beats for k in ("t", "say", "do", "show"))
    record("structure.fields", "pass" if fields_ok else "fail", "hook/cta/caption and beat t/say/do/show must be strings")
    delivery_ok = ad.get("delivery") in ("spoken", "silent")
    record("structure.delivery", "pass" if delivery_ok else "fail", "delivery must be spoken or silent")
    if not fields_ok or not delivery_ok:
        return result(case, checks, {"beat_count": len(beats)})

    count = SC.shown_words(ad)
    metrics = {"spoken_words": count, "beat_count": len(beats)}
    max_words = conditions.get("max_spoken_words")
    if ad["delivery"] == "silent":
        record("length.words", "not_evaluable", "silent delivery has no spoken word budget")
    elif positive(max_words):
        record("length.words", "fail" if count > max_words else "pass",
               f"{count} spoken words; synthetic fixture budget {max_words}")
    else:
        record("length.words", "not_evaluable", "no valid explicit spoken-word budget supplied")
    if not ad["hook"].strip():
        record("hook.repetition", "not_evaluable", "no hook text supplied")
    elif ad["delivery"] == "silent":
        record("hook.repetition", "not_evaluable", "shared repetition metric is spoken-only")
    else:
        record("hook.repetition", "fail" if SC.hook_repeated(ad) else "pass",
               "shared script_checks metric: beat 1 contains at least 70% of unique hook tokens; intentional repetition needs human review")

    speech = src.get("script", {}).get("has_speech") if isinstance(src, dict) and isinstance(src.get("script"), dict) else None
    if isinstance(speech, bool):
        record("structure.source_delivery", "pass" if SC.delivery_match(ad, src) else "fail",
               "script delivery and silent say fields compared with explicit source has_speech")
    else:
        record("structure.source_delivery", "not_evaluable", "source has_speech missing or not boolean")
    if isinstance(fmt, dict) and isinstance(fmt.get("beats"), list) and fmt["beats"]:
        valid_format = all(isinstance(b, dict) and isinstance(b.get("role"), str)
                           and bool(b["role"].strip()) and positive(b.get("seconds")) for b in fmt["beats"])
        record("structure.format", "pass" if valid_format else "fail", "format beats need a named role and finite positive seconds")
        if valid_format and len(fmt["beats"]) != len(beats):
            record("structure.alignment", "review", "format and script beat counts differ; split/merged beats may be valid")
    else:
        record("structure.format", "not_evaluable", "format beat skeleton missing")
    record("structure.semantic_roles", "review", "role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed")

    intervals = []
    for index, beat in enumerate(beats):
        match = _RANGE.fullmatch(beat["t"])
        if not match:
            record(f"timing.beat_{index + 1}", "not_evaluable" if not beat["t"].strip() else "fail",
                   "missing range" if not beat["t"].strip() else "invalid range; expected start-end seconds")
            intervals.append(None)
            continue
        start, end = map(float, match.groups())
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            record(f"timing.beat_{index + 1}", "fail", "range must have finite nonnegative start and end > start")
            intervals.append(None)
            continue
        intervals.append((start, end))
        record(f"timing.beat_{index + 1}", "pass", f"{start:g}-{end:g}s")
    for index, (before, after) in enumerate(pairwise(intervals), start=2):
        if before is None or after is None:
            continue
        if after[0] < before[1]:
            record(f"timing.order_{index}", "fail", "beat overlaps or goes backward relative to preceding beat")
        elif after[0] > before[1]:
            record(f"timing.gap_{index}", "review", "gap between beats may be intentional; verify planned continuity")
    duration = src.get("duration") if isinstance(src, dict) else None
    if positive(duration) and all(intervals):
        end = max(interval[1] for interval in intervals)
        metrics["planned_end_seconds"] = end
        record("timing.source_duration", "fail" if end > duration * 1.15 else "pass",
               f"planned end {end:g}s vs source {duration:g}s; existing harness overrun threshold is 1.15x, not measured performance")
    else:
        record("timing.source_duration", "not_evaluable", "source duration or complete valid timing ranges unavailable")
    if isinstance(src, dict) and isinstance(src.get("script"), dict) and isinstance(src["script"].get("text"), str) and isinstance(speech, bool):
        ratio = SC.word_ratio(ad, src)
        metrics["source_word_ratio"] = ratio
        if ratio is None:
            record("length.source_ratio", "not_evaluable", "shared metric requires source speech and at least 15 source words")
        else:
            record("length.source_ratio", "review", f"shared shown/source word ratio {ratio:.3f}; word count does not establish delivery duration")
    else:
        record("length.source_ratio", "not_evaluable", "source transcript conditions unavailable")

    if not isinstance(brand, dict) or not any(isinstance(brand.get(k), str) and brand[k].strip()
                                             for k in ("description", "site", "objective", "niche")):
        record("claims.reference", "not_evaluable", "no substantive brand reference supplied; absence of evidence is not a truth verdict")
    else:
        tokens = SC.unbacked_tokens(ad, brand)
        metrics["unbacked_tokens"] = tokens
        record("claims.token_support", "review" if tokens else "pass",
               "tokens absent from supplied brand text: " + ", ".join(tokens) if tokens else "no mismatch in the shared narrow token scan; not factual verification")
    text_fields = [ad["hook"], ad["cta"], ad["caption"]] + [b[k] for b in beats for k in ("say", "do", "show")]
    promises = sorted({m.group(0).lower() for field in text_fields for m in _PROMISE.finditer(field)})
    if promises:
        record("claims.promise_language", "review", "promise/medical language needs substantiation and context: " + ", ".join(promises))
    record("claims.truth", "review", "product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof")
    return result(case, checks, metrics)


def result(case, checks, metrics):
    return {"id": case["id"], "evidence_type": "synthetic_fixture",
            "provenance": case["provenance"], "metrics": metrics, "checks": checks}


def load_suite():
    raw = FIXTURES.read_bytes()
    suite = json.loads(raw)
    if suite.get("evidence_type") != "synthetic_fixture" or not suite.get("provenance"):
        raise ValueError("suite must explicitly identify synthetic evidence and provenance")
    seen = set()
    for case in suite["cases"]:
        if not case.get("id") or case["id"] in seen or not case.get("provenance"):
            raise ValueError("case IDs must be distinct and provenance required")
        seen.add(case["id"])
        if case.get("evidence_type") != "synthetic_fixture":
            raise ValueError("only synthetic fixtures are accepted")
    return suite, hashlib.sha256(raw).hexdigest()


def build_report():
    suite, digest = load_suite()
    results = [evaluate(case) for case in suite["cases"]]
    mismatches = []
    for case, observed in zip(suite["cases"], results):
        actual = sorted(c["code"] for c in observed["checks"] if c["status"] == "fail")
        if actual != sorted(case["expected_failures"]):
            mismatches.append({"id": case["id"], "expected": case["expected_failures"], "actual": actual})
    return {"suite": suite["id"], "evidence_type": suite["evidence_type"], "provenance": suite["provenance"],
            "fixture_sha256": digest, "scope": "synthetic detector regression, not production quality or milestone acceptance",
            "measurable_failures": sum(c["status"] == "fail" for r in results for c in r["checks"]),
            "human_review_flags": sum(c["status"] == "review" for r in results for c in r["checks"]),
            "not_evaluable": sum(c["status"] == "not_evaluable" for r in results for c in r["checks"]),
            "expectation_mismatches": mismatches, "cases": results}


def markdown(report):
    lines = ["# Synthetic script evaluation", "", report["scope"] + ".", "",
             f"Fixture SHA-256: `{report['fixture_sha256']}`.", "",
             (f"{len(report['cases'])} synthetic cases; {report['measurable_failures']} measurable failures; "
             f"{report['human_review_flags']} human review flags; {report['not_evaluable']} unavailable conditions."), "",
             f"Detector expectation mismatches: {len(report['expectation_mismatches'])}.", "",
             ("Reproduce from the repository root with `python3 -I pipeline/eval_scripts.py synthetic`. "
             "Use `--format json` for per-case metrics, check statuses and provenance. "
             "Run `python3 -I pipeline/test_synthetic_eval.py` to verify the detectors and this report snapshot."), "",
             "Deliberately failing fixtures test detector behavior. These counts are not measured creator-script quality."]
    for status, title in (("fail", "Measurable failures"), ("review", "Human review required"), ("not_evaluable", "Missing or unavailable conditions")):
        lines.extend(["", "## " + title, "", "| Synthetic case | Check | Observation |", "| --- | --- | --- |"])
        for case in report["cases"]:
            for check in case["checks"]:
                if check["status"] == status:
                    detail = check["detail"].replace("|", "\\|").replace("\n", " ")
                    lines.append(f"| {case['id']} | {check['code']} | {detail} |")
    lines.extend(["", "## Provenance and limits", "", report["provenance"], "",
                  ("Every case is synthetic_fixture evidence from the checked-in fixture file, with per-case provenance in JSON output. "
                  "No inference, production data, network, credentials, or production writes are used. "
                  "No production prompt or shared check behavior is changed. "
                  "Private Schedule B and the confidential engineering handoff have not been supplied; "
                  "continue with the provisional dependency map. No missing milestone acceptance criteria are inferred."), ""])
    return "\n".join(lines)


def configure(parser):
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.set_defaults(func=run)
    return parser


def run(args):
    report = build_report()
    print(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) if args.format == "json" else markdown(report), end="\n" if args.format == "json" else "")
    return 1 if report["expectation_mismatches"] else 0


def main(argv=None):
    return run(configure(argparse.ArgumentParser(description=__doc__)).parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
