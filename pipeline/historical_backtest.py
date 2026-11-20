"""Bundled synthetic point-in-time experiment; stdlib only, no live or private inputs.

Contract: docs/historical-backtest/design.md. No production worker/env/model imports.
The prediction boundary consumes history and policy ONLY, before future files are read.
"""

import argparse
import copy
import hashlib
import json
import math
import random
import statistics
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

FIXTURES = Path(__file__).parent / "historical_fixtures"
FEATURES = ("hook", "roles", "delivery", "pacing", "product_entry", "reveal", "cta", "niche", "audience")
STRATEGIES = ("random", "popularity", "normalized", "niche_popularity", "structural_proxy")
GENERIC = {"intro", "body", "outro", "talk"}
PROVENANCE = "Invented Mission 002 fixture; no real creator, platform observation, or model inference."


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def timestamp(value):
    if not isinstance(value, str):
        raise TypeError("timestamp must be an explicit timezone-aware string")
    try:
        result = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("invalid timestamp") from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("naive timestamp is not historical evidence")
    return result.astimezone(UTC)


def synthetic(record):
    if record.get("evidence_type") != "synthetic_fixture" or not record.get("provenance"):
        raise ValueError("only explicitly sourced synthetic fixtures are accepted")


def valid_format(fmt):
    return (isinstance(fmt, dict) and set(fmt) == set(FEATURES)
            and all(isinstance(fmt[k], str) and fmt[k].strip() for k in FEATURES if k != "roles")
            and isinstance(fmt["roles"], list) and 1 <= len(fmt["roles"]) <= 16
            and all(isinstance(role, str) and role.strip() for role in fmt["roles"])
            and fmt["delivery"] in ("spoken", "silent"))


def validate_policy(policy):
    synthetic(policy)
    for field in ("cutoff", "candidate_start", "candidate_end", "outcome_close", "roster_available_at"):
        timestamp(policy[field])
    if not (timestamp(policy["roster_available_at"]) < timestamp(policy["cutoff"])
            <= timestamp(policy["candidate_start"]) < timestamp(policy["candidate_end"])
            < timestamp(policy["outcome_close"])):
        raise ValueError("policy chronology is invalid")
    if not isinstance(policy["complete_candidate_manifest"], bool) or type(policy["seed"]) is not int:
        raise TypeError("invalid census/seed declaration")
    if policy["platform"] != "instagram" or policy["sampling_probability"] != 1:
        raise ValueError("this prototype supports an Instagram census only")
    if policy["age_hours"] != 48 or policy["age_tolerance_hours"] != 0:
        raise ValueError("v1 compares exact 48-hour observations only")
    if policy["min_baseline"] != 3 or not isinstance(policy["k"], int) or isinstance(policy["k"], bool) or policy["k"] < 1:
        raise ValueError("invalid frozen baseline/K policy")
    if not policy["creators"] or len(set(policy["creators"])) != len(policy["creators"]):
        raise ValueError("invalid fixed creator roster")
    if policy["matching"] != {
        "threshold": 0.85, "roles_min": 0.8, "hook": 0.2, "roles": 0.3,
        "delivery": 0.1, "pacing": 0.1, "product_entry": 0.1, "reveal": 0.1, "cta": 0.1,
    }:
        raise ValueError("v1 matching rules must be explicitly frozen")


def metadata_reason(record, policy, history):
    synthetic(record)
    if record.get("creator") not in policy["creators"] or record.get("platform") != policy["platform"]:
        return "outside_fixed_population"
    if record.get("sampling_probability") != 1:
        raise ValueError("non-census sampling requires a weighted protocol; no aggregates computed")
    if record.get("permission") != "synthetic_only":
        return "permission_unestablished"
    try:
        pub, discovered, collected, available = (
            timestamp(record.get(k)) for k in ("published_at", "discovered_at", "collected_at", "available_at"))
        if not pub <= discovered <= collected <= available:
            return "metadata_clock_conflict"
        if history:
            features = timestamp(record.get("features_available_at"))
            if pub >= timestamp(policy["cutoff"]) or available >= timestamp(policy["cutoff"]):
                return "not_known_at_cutoff"
            if not collected <= features < timestamp(policy["cutoff"]):
                return "features_not_known_at_cutoff"
        elif not timestamp(policy["candidate_start"]) <= pub < timestamp(policy["candidate_end"]):
            return "outside_publication_window"
        elif available >= timestamp(policy["outcome_close"]):
            return "candidate_manifest_late"
    except (TypeError, ValueError):
        return "missing_or_invalid_timestamp"
    if record.get("feature_version") != policy["feature_version"]:
        return "unfrozen_feature_version"
    if history and (record.get("availability") != "available" or not valid_format(record.get("format"))):
        return "historical_features_unavailable"
    if not record.get("content_hash") or not record.get("near_duplicate_group"):
        return "duplicate_identity_unavailable"
    return None


def metric(record, observations, policy, deadline):
    """Select earliest comparable snapshot, never a latest/largest lifetime count."""
    accepted, rejected = [], []
    for obs in observations:
        synthetic(obs)
        if obs.get("video_id") != record["id"]:
            rejected.append("observation_identity_conflict")
            continue
        reason = None
        try:
            observed, available = timestamp(obs.get("observed_at")), timestamp(obs.get("available_at"))
            if available < observed:
                reason = "observation_clock_conflict"
            elif available >= deadline:
                reason = "metric_not_available_by_deadline"
            elif observed - timestamp(record["published_at"]) != timedelta(hours=policy["age_hours"]):
                reason = "wrong_post_age"
        except (TypeError, ValueError):
            reason = "missing_metric_timestamp"
        views = obs.get("views")
        if reason is None and (not isinstance(views, int) or isinstance(views, bool) or not 0 <= views <= 2**63 - 1):
            reason = "missing_or_invalid_views"
        if reason:
            rejected.append(reason)
        else:
            accepted.append((observed, available, str(obs.get("id", "")), views))
    snapshots = defaultdict(set)
    for observed, available, _, views in accepted:
        snapshots[observed, available].add(views)
    if any(len(values) > 1 for values in snapshots.values()):
        return None, sorted(rejected + ["conflicting_metric_observations"])
    return (min(accepted)[3] if accepted else None), sorted(rejected)


def unique_records(records):
    """Deduplicate by either supplied exact identity or near-duplicate group, not by outcomes."""
    kept, rejected = [], []
    hashes, groups = set(), set()
    for record in sorted(records, key=lambda r: (timestamp(r["published_at"]), r["id"])):
        if record["content_hash"] in hashes or record["near_duplicate_group"] in groups:
            rejected.append({"id": record["id"], "reason": "duplicate_content"})
        else:
            kept.append(record)
        hashes.add(record["content_hash"])
        groups.add(record["near_duplicate_group"])
    return kept, rejected


def freeze(history, policy):
    """No candidate/outcome argument exists at this boundary."""
    validate_policy(policy)
    policy = copy.deepcopy(policy)
    admitted, rejected = [], []
    if len({r["id"] for r in history}) != len(history):
        raise ValueError("duplicate history record IDs")
    for record in history:
        reason = metadata_reason(record, policy, True)
        if reason:
            rejected.append({"id": record["id"], "reason": reason})
        else:
            admitted.append(copy.deepcopy(record))
    admitted, duplicates = unique_records(admitted)
    rejected += duplicates
    views, metric_rejections = {}, []
    for record in admitted:
        value, reasons = metric(record, record.get("observations", []), policy, timestamp(policy["cutoff"]))
        if value is not None:
            views[record["id"]] = value
        if reasons or value is None:
            metric_rejections.append({"id": record["id"], "reasons": reasons or ["no_observation"],
                                      "usable_snapshot": value is not None})
    by_creator = defaultdict(list)
    for record in admitted:
        if record["id"] in views:
            by_creator[record["creator"]].append((record["id"], views[record["id"]]))
    baselines = {creator: statistics.median(v for _, v in by_creator[creator])
                 if len(by_creator[creator]) >= policy["min_baseline"] else None for creator in policy["creators"]}
    catalog = {}
    for record in admitted:
        fid = record["format_id"]
        entry = catalog.setdefault(fid, {"format": record["format"], "post_count": 0, "creators": [], "ratios": []})
        if entry["format"] != record["format"]:
            raise ValueError("one format ID cannot carry conflicting frozen definitions")
        entry["post_count"] += 1
        entry["creators"].append(record["creator"])
        other = [v for rid, v in by_creator[record["creator"]] if rid != record["id"]]
        if record["id"] in views and len(other) >= policy["min_baseline"] - 1 and statistics.median(other) > 0:
            entry["ratios"].append(views[record["id"]] / statistics.median(other))
    if len({digest(v["format"]) for v in catalog.values()}) != len(catalog):
        raise ValueError("duplicate structural catalog definitions")
    for entry in catalog.values():
        entry["creators"] = sorted(set(entry["creators"]))
        entry["normalized_score"] = statistics.median(entry["ratios"]) if entry["ratios"] else None
        entry.pop("ratios")
    scores = {s: {} for s in STRATEGIES}
    for fid, entry in sorted(catalog.items()):
        scores["random"][fid] = int(digest([policy["seed"], fid])[:12], 16)
        scores["popularity"][fid] = entry["post_count"]
        normalized = entry["normalized_score"]
        if normalized is not None:
            scores["normalized"][fid] = normalized
        if entry["format"]["niche"] == policy["target_niche"]:
            scores["niche_popularity"][fid] = entry["post_count"]
            if normalized is not None:
                scores["structural_proxy"][fid] = normalized * min(len(entry["creators"]), 3) / math.sqrt(entry["post_count"])
    rankings = {s: [{"format_id": fid, "score": value} for fid, value in
                    sorted(scores[s].items(), key=lambda item: (-item[1], item[0]))[:policy["k"]]]
                for s in STRATEGIES}
    artifact = {"evidence_type": "synthetic_fixture", "provenance": PROVENANCE,
                "mode": "synthetic_feasibility_only", "policy": policy, "catalog": catalog, "baselines": baselines,
                "rankings": rankings, "history_ids": sorted(r["id"] for r in admitted),
                "history_content": sorted({r["content_hash"] for r in admitted}),
                "history_groups": sorted({r["near_duplicate_group"] for r in admitted})}
    return {"frozen": artifact, "prediction_sha256": digest(artifact),
            "history_audit": {"admitted": len(admitted), "rejected": sorted(rejected, key=lambda r: r["id"]),
                              "metrics": metric_rejections}}


def lcs_ratio(left, right):
    row = [0] * (len(right) + 1)
    for a in left:
        previous = row
        row = [0]
        for j, b in enumerate(right, 1):
            row.append(previous[j - 1] + 1 if a == b else max(previous[j], row[-1]))
    return 2 * row[-1] / (len(left) + len(right))


def similarity(left, right, rules):
    if not valid_format(left) or not valid_format(right):
        return {"kind": "insufficient_features", "score": None}
    roles = lcs_ratio(left["roles"], right["roles"])
    score = sum(rules[k] * (roles if k == "roles" else float(left[k] == right[k]))
                for k in ("hook", "roles", "delivery", "pacing", "product_entry", "reveal", "cta"))
    anchors = all(len(fmt["roles"]) >= 3 and len({role.casefold() for role in fmt["roles"]} - GENERIC) >= 2 for fmt in (left, right))
    gates = anchors and all(left[k] == right[k] for k in ("hook", "delivery", "niche", "audience"))
    kind = "same_format" if gates and roles >= rules["roles_min"] and score >= rules["threshold"] else (
        "genre_only" if left["niche"] == right["niche"] else "no_match")
    return {"kind": kind, "score": round(score, 6)}


def band(ratio):
    if ratio < 0.5:
        return "underperforming"
    if ratio <= 1.5:
        return "typical"
    if ratio <= 3:
        return "outperforming"
    return "breakout"


def balanced(rows, field, creators=None):
    groups = defaultdict(list)
    for row in rows:
        if row.get(field) is not None:
            groups[row["creator"]].append(row[field])
    if creators is None:
        creators = sorted(groups)
    means = [statistics.mean(groups[c]) for c in creators if c in groups]
    return statistics.mean(means) if means else None


def difference_interval(rows, left_ids, right_ids, seed, draws=400):
    creators = sorted({r["creator"] for r in rows if r.get("ratio") is not None})
    if len(creators) < 3:
        return {"interval": None, "usable_draws": 0, "reason": "fewer_than_three_creator_clusters"}
    rng, differences = random.Random(seed), []
    left, right = ([r for r in rows if set(r["matches"]) & ids] for ids in (left_ids, right_ids))
    if any(len({r["creator"] for r in arm if r.get("log_relative") is not None}) < 3 for arm in (left, right)):
        return {"interval": None, "usable_draws": 0, "reason": "fewer_than_three_creator_clusters_in_a_strategy"}
    for _ in range(draws):
        sample = rng.choices(creators, k=len(creators))
        a, b = balanced(left, "log_relative", sample), balanced(right, "log_relative", sample)
        if a is not None and b is not None:
            differences.append(a - b)
    differences.sort()
    interval = [differences[int((len(differences) - 1) * q)] for q in (0.025, 0.975)] if len(differences) >= 100 else None
    return {"interval": interval, "usable_draws": len(differences),
            "reason": "synthetic_creator_cluster_percentiles_not_significance"}


def evaluate(prediction, candidates, outcomes):
    if digest(prediction["frozen"]) != prediction["prediction_sha256"]:
        raise ValueError("frozen artifact was modified")
    frozen = prediction["frozen"]
    policy = frozen["policy"]
    observations = defaultdict(list)
    for outcome in outcomes:
        synthetic(outcome)
        observations[outcome["video_id"]].append(outcome)
    if len({c["id"] for c in candidates}) != len(candidates):
        raise ValueError("duplicate candidate IDs")
    if set(observations) - {c["id"] for c in candidates}:
        raise ValueError("outcome has no candidate manifest entry")
    admitted, rejected = [], []
    for candidate in candidates:
        reason = metadata_reason(candidate, policy, False)
        if reason:
            rejected.append({"id": candidate["id"], "reason": reason})
        elif candidate["id"] in frozen["history_ids"]:
            rejected.append({"id": candidate["id"], "reason": "history_candidate_id_overlap"})
        elif (candidate["content_hash"] in frozen["history_content"]
              or candidate["near_duplicate_group"] in frozen["history_groups"]):
            rejected.append({"id": candidate["id"], "reason": "duplicate_of_history"})
        else:
            admitted.append(candidate)
    admitted, duplicates = unique_records(admitted)
    rejected += duplicates
    rows = []
    for candidate in admitted:
        feature_ready = (candidate.get("availability") == "available"
                         and valid_format(candidate.get("format")))
        if feature_ready:
            try:
                feature_ready = (timestamp(candidate["collected_at"])
                                 <= timestamp(candidate.get("features_available_at"))
                                 < timestamp(policy["outcome_close"]))
            except (TypeError, ValueError):
                feature_ready = False
        comparisons = {fid: similarity(entry["format"], candidate.get("format") if feature_ready else None, policy["matching"])
                       for fid, entry in sorted(frozen["catalog"].items())}
        matches = [fid for fid, match in comparisons.items() if match["kind"] == "same_format"]
        value, reasons = metric(candidate, observations[candidate["id"]], policy, timestamp(policy["outcome_close"]))
        baseline = frozen["baselines"][candidate["creator"]]
        ratio = value / baseline if value is not None and baseline is not None and baseline > 0 else None
        status = ("missing_or_incomparable_outcome" if value is None else
                  "missing_baseline" if baseline is None else "zero_baseline" if baseline == 0 else "observed")
        rows.append({"id": candidate["id"], "creator": candidate["creator"], "matches": matches,
                     "matching_status": "same_format" if matches else "no_match_observed" if feature_ready else "features_unavailable",
                     "comparisons": comparisons, "views": value, "baseline": baseline, "ratio": ratio,
                     "log_relative": math.log((value + 1) / (baseline + 1)) if ratio is not None else None,
                     "band": band(ratio) if ratio is not None else None,
                     "outcome_status": status, "metric_rejections": reasons})
    summaries = {}
    all_outperformers = {r["id"] for r in rows if r["ratio"] is not None and r["ratio"] > 1.5}
    random_ids = {p["format_id"] for p in frozen["rankings"]["random"]}
    for name, ranked in frozen["rankings"].items():
        ids = {p["format_id"] for p in ranked}
        selected = [r for r in rows if set(r["matches"]) & ids]
        usable = [r for r in selected if r["ratio"] is not None]
        predictions = [{"format_id": fid,
                        "status": "match_observed" if any(fid in r["matches"] for r in rows) else "no_match_observed",
                        "candidate_ids": [r["id"] for r in rows if fid in r["matches"]]} for fid in sorted(ids)]
        evaluated_formats = {fid for fid in ids if any(fid in r["matches"] for r in usable)}
        winning_formats = {fid for fid in ids if any(fid in r["matches"] and r["ratio"] > 1.5 for r in usable)}
        selected_outperformers = {r["id"] for r in usable if r["ratio"] > 1.5}
        summaries[name] = {
            "predictions": predictions, "selected_k": len(ids), "matched_videos": len(selected),
            "normalized_outcomes": len(usable), "unresolved_outcomes": len(selected) - len(usable),
            "adoption_at_k": sum(p["status"] == "match_observed" for p in predictions) / len(ids) if ids else None,
            "observed_precision_at_k": len(winning_formats) / len(evaluated_formats) if evaluated_formats else None,
            "evaluated_format_denominator": len(evaluated_formats), "ordinary_precision_at_k": None,
            "recall_among_observed_outperformers": len(selected_outperformers) / len(all_outperformers)
            if policy["complete_candidate_manifest"] and all_outperformers else None,
            "creator_balanced_mean_ratio": balanced(usable, "ratio"),
            "creator_balanced_mean_log_relative": balanced(usable, "log_relative"),
            "log_lift_interval_vs_random": difference_interval(rows, ids, random_ids, policy["seed"]),
        }
    random_mean = summaries["random"]["creator_balanced_mean_log_relative"]
    for summary in summaries.values():
        value = summary["creator_balanced_mean_log_relative"]
        summary["conditional_log_lift_vs_random"] = value - random_mean if value is not None and random_mean is not None else None
    return {"evidence_type": "synthetic_fixture", "provenance": PROVENANCE, "mode": "synthetic_feasibility_only",
            "prediction_sha256": prediction["prediction_sha256"], "policy": policy,
            "history_audit": copy.deepcopy(prediction["history_audit"]),
            "baselines": frozen["baselines"], "rankings": frozen["rankings"],
            "candidate_audit": {"admitted": len(rows), "rejected": sorted(rejected, key=lambda r: r["id"]),
                                "bands": dict(sorted(Counter(r["band"] or "unknown" for r in rows).items())),
                                "outcomes": dict(sorted(Counter(r["outcome_status"] for r in rows).items())),
                                "matching_coverage": sum(bool(r["matches"]) for r in rows) / len(rows) if rows else None},
            "candidates": rows, "strategies": summaries,
            "limitations": ["Synthetic methods demonstration; no historical or causal performance evidence.",
                            "No real corpus accessed; source coverage and permission remain unverified.",
                            "No model or script-generation capability evaluated; structural proxy is an unvalidated heuristic.",
                            "Unknown outcomes and unmatched predictions are not failures.",
                            "Creator bootstrap ignores residual shared-format dependence; no significance claim.",
                            "Schedule B unavailable; all product dependencies remain provisional."]}


def bundled_report():
    # Freeze BEFORE reading any future data, using only explicit local synthetic files.
    policy = json.loads((FIXTURES / "policy.json").read_text())
    history = json.loads((FIXTURES / "history.json").read_text())
    prediction = freeze(history, policy)
    candidates = json.loads((FIXTURES / "candidates.json").read_text())
    outcomes = json.loads((FIXTURES / "outcomes.json").read_text())
    report = evaluate(prediction, candidates, outcomes)
    report["fixture_sha256"] = digest({"policy": policy, "history": history, "candidates": candidates, "outcomes": outcomes})
    return report


def markdown(report):
    lines = ["# Historical backtest feasibility — synthetic only", "",
             "No real historical backtest was run. These invented results test mechanics, not Lynxr performance.", "",
             f"Frozen prediction digest: `{report['prediction_sha256']}`.",
             f"Fixture digest: `{report['fixture_sha256']}`.", "",
             "Reproduce: `python3 -I pipeline/eval_scripts.py historical`; add `--format json` for the complete audit.",
             "", "## Coverage", "",
             f"History admitted: {report['history_audit']['admitted']}; rejected: {len(report['history_audit']['rejected'])}.",
             f"Candidate manifest admitted: {report['candidate_audit']['admitted']}; rejected: {len(report['candidate_audit']['rejected'])}.",
             f"Exploratory outcome bands: {json.dumps(report['candidate_audit']['bands'], sort_keys=True)}.",
             f"Outcome status: {json.dumps(report['candidate_audit']['outcomes'], sort_keys=True)}.",
             "", "## Frozen strategies and conditional observations", "",
             "| Strategy | Selected K | Matched videos | Normalized outcomes | Unmatched predictions | Conditional precision | Mean ratio |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    def show(value):
        return "unavailable" if value is None else f"{value:.3f}"
    for name, summary in report["strategies"].items():
        missing = sum(p["status"] == "no_match_observed" for p in summary["predictions"])
        lines.append(f"| {name} | {summary['selected_k']} | {summary['matched_videos']} | {summary['normalized_outcomes']} | "
                     f"{missing} | {show(summary['observed_precision_at_k'])} | {show(summary['creator_balanced_mean_ratio'])} |")
    lines += ["", ("Conditional precision uses only selected formats with normalized outcomes, not all K. "
              "Coverage and missingness differ by strategy; there is no causal lift or production-quality claim."),
              "", "## Rejected historical records", ""]
    lines += [f"- {r['id']}: {r['reason']}" for r in report["history_audit"]["rejected"]]
    lines += ["", "## Unresolved predictions", ""]
    lines += [f"- {name}: {p['format_id']} remains no_match_observed (not a failure)."
              for name, summary in report["strategies"].items() for p in summary["predictions"] if p["status"] == "no_match_observed"]
    lines += ["", "## Interpretation limits", ""] + ["- " + text for text in report["limitations"]]
    lines += ["", ("Every fixture has invented-data provenance. See [design](design.md) and [inventory](inventory.md) "
              "for timestamp reliability, sampling, metrics, walk-forward validation and prerequisites for real research."), ""]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    args = parser.parse_args(argv)
    report = bundled_report()
    print(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) if args.format == "json" else markdown(report),
          end="\n" if args.format == "json" else "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
