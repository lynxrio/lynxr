"""Transparent descriptive signals. No model, caption feature, outcome forecast or network."""

import random
import statistics
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path

from .authorized import ExportLedger, allowed, now, permission, read_receipt
from .comparisons import research_report
from .data import sha
from .formats import annotations


def post_context(records):
    return [{"source_id": r["source_id"], "post_id": r["id"], "creator_id": "study:" + r["creator"],
             "duration_s": r["duration"], "url": r["url"]}
            for r in records if r.get("source_id") == "educational-reels"]


def cluster_range(rows):
    """Fixed-seed creator-cluster bootstrap, exploratory stability interval only."""
    groups = defaultdict(list)
    for creator, ratio in rows:
        groups[creator].append(ratio)
    if len(groups) < 5 or len(rows) < 20:
        return {"interval": None, "reason": "needs at least five creator clusters and twenty eligible posts"}
    creators = sorted(groups)
    rng = random.Random(7007)
    draws = sorted(statistics.median(v for c in rng.choices(creators, k=len(creators)) for v in groups[c])
                   for _ in range(500))
    return {"interval": [draws[12], draws[487]], "method": "500 fixed-seed creator-cluster resamples; approximate 95% percentile stability interval",
            "limitations": "Purposive sample, coarse ages and one coder; not population coverage or a causal interval."}


def catalog_signals(source, records):
    report = research_report(source, records)
    real = [r for r in records if r.get("source_id") == "educational-reels"]
    # Existing source-specific comparator supplies eligible same-account leave-one-out references.
    from .comparisons import age_reference
    groups, weeks = defaultdict(list), defaultdict(Counter)
    for r in real:
        labels = sorted({x.strip() for x in r.get("annotations", {}).get("hook_type", "").split(",") if x.strip()})
        for label in labels:
            groups[label].append(r)
            if r.get("published_at"):
                d = datetime.fromisoformat(r["published_at"])
                week = (d - timedelta(days=d.weekday())).date().isoformat()
                weeks[label][week] += 1
    ranked = []
    for label, rows in sorted(groups.items()):
        eligible = []
        for r in rows:
            ref = age_reference(r, records)
            ratio = ref.get("descriptive_ratio")
            if ratio is not None:
                eligible.append((r["creator"], ratio))
        creators = len({r["creator"] for r in rows})
        median = statistics.median(v for _, v in eligible) if eligible else None
        supported = len(eligible) >= 20 and len({c for c, _ in eligible}) >= 5
        ranked.append({"human_hook_label": label, "posts": len(rows), "sampled_creators": creators,
                       "creator_breadth_fraction": creators / report["annotated_creators"],
                       "eligible_reference_posts": len(eligible), "eligible_creator_clusters": len({c for c, _ in eligible}),
                       "median_descriptive_ratio": median, "stability": cluster_range(eligible),
                       "review_priority": "compare examples" if supported else "insufficient breadth",
                       "publication_week_counts": dict(sorted(weeks[label].items())),
                       "observed_adoption_change": None,
                       "adoption_reason": "Publication cohorts at one later coding snapshot, not repeated historical adoption observations"})
    # A review queue ranked on coverage, not a claim about future outcomes.
    ranked.sort(key=lambda r: (r["review_priority"] != "compare examples", -r["sampled_creators"],
                               -r["eligible_reference_posts"], r["human_hook_label"]))
    return {"evidence_type": "licensed_single_coder_real_record_descriptive_analysis", "real_posts": len(real),
            "source": next((s for s in report["sources"] if s.get("source_id") == "educational-reels"), report["sources"]),
            "ranking_rule": "Review supported labels first, then sampled creator breadth, eligible reference count and label; no estimated future success score",
            "review_ranking": ranked, "observed_pacing_comparison": next((g for g in report["structure_comparisons"] if g["field"] == "editing_pace"), None),
            "predictive_alpha": None, "early_velocity": None,
            "missingness": report["missingness"], "freshness": "One source coding date per post; exact observation times unknown; not live counters",
            "limitations": ["Shared labels do not identify creative causes of reach.", "Creator references are contemporaneous, age-banded and source-specific.",
                            "No platform-wide adoption estimate, prospective performance or independent annotation reliability.",
                            "No video downloaded or visual feature inferred from captions."]}


def workspace_snapshot(root, permission_path, cutoff=None, age_ms=172800000, tolerance_ms=3600000):
    grant = permission(permission_path, "analytics_research")
    cutoff = cutoff or now()
    from research.observation_ledger.schema import instant
    cutoff = instant(cutoff)
    ledger = ExportLedger(Path(root) / "observations.sqlite")
    with closing(ledger.connect()) as db:
        db.execute("BEGIN")
        all_rows = ledger._verify(db)
    permitted = [x for x in all_rows if allowed(grant, x["observation"]["creator_id"])
                 and x["observation"]["permission"]["evidence_ref"] == grant["grant_id"]]
    rows = []
    for x in permitted:
        r = x["observation"]
        if all(t < cutoff for t in [x["recorded_at"], r["permission"]["available_at"],
                                   *[r[k] for k in ("published_at", "observed_at", "collected_at", "extracted_at", "available_at")]]):
            rows.append(x)
    receipts = [read_receipt(p) for p in sorted((Path(root) / "imports").glob("*.json"))]
    counter_kinds = {r["metric"]["definition_id"]: r["counter_kind"] for receipt in receipts
                     if receipt["grant_id"] == grant["grant_id"] for r in receipt["contract"]["rows"]
                     if allowed(grant, r["creator_id"])}
    definitions = defaultdict(list)
    for x in rows:
        definitions[x["observation"]["metric"]["definition_id"]].append(x)
    analyses = []
    for definition, items in sorted(definitions.items()):
        by_post = defaultdict(list)
        for x in items:
            by_post[x["observation"]["post_id"]].append(x)
        outcomes, velocities = [], []
        for post, observations in sorted(by_post.items()):
            ordered = sorted(observations, key=lambda x: (x["observation"]["observed_at"], x["observation"]["collected_at"], x["recorded_at"]))
            # Latest state suppresses withdrawn/deleted/unavailable values rather than reviving an older reading.
            latest = ordered[-1]["observation"]
            if latest["value"] is None:
                continue
            valid = [x["observation"] for x in ordered if x["observation"]["value"] is not None]
            age_matched = [r for r in valid if abs(r["measurement_age_ms"] - age_ms) <= tolerance_ms]
            if age_matched:
                chosen = min(age_matched, key=lambda r: (abs(r["measurement_age_ms"] - age_ms), r["observed_at"], r["observation_id"]))
                outcomes.append(chosen)
            if (len(valid) >= 2 and counter_kinds.get(definition) == "cumulative_counter"
                    and latest["metric"]["unit"] == "count"):
                distinct = {r["observed_at"]: r for r in valid}
                if len(distinct) < 2:
                    continue
                a, b = list(distinct.values())[-2:]
                elapsed = (datetime.fromisoformat(b["observed_at"]) - datetime.fromisoformat(a["observed_at"])).total_seconds()
                if elapsed > 0 and b["measurement_age_ms"] <= 172800000:
                    velocities.append({"post_id": post, "value_per_hour": (b["value"] - a["value"]) * 3600 / elapsed,
                                       "start_observed_at": a["observed_at"], "end_observed_at": b["observed_at"],
                                       "counter_decreased": b["value"] < a["value"], "interpretation": "observed counter difference, not causal growth or a prediction"})
        normalized = []
        for target in outcomes:
            peers = [r["value"] for r in outcomes if r["creator_id"] == target["creator_id"] and r["post_id"] != target["post_id"]]
            median = statistics.median(peers) if len(peers) >= 4 else None
            normalized.append({"post_id": target["post_id"], "creator_id": target["creator_id"], "value": target["value"],
                               "measurement_age_ms": target["measurement_age_ms"], "reference_n": len(peers),
                               "ratio": target["value"] / median if median else None,
                               "reason": "contemporaneous same-creator/definition/age reference; not a prior prediction baseline" if median else "insufficient peers or zero median"})
        analyses.append({"metric": items[0]["observation"]["metric"], "counter_kind": counter_kinds.get(definition), "observations": len(items), "posts": len(by_post),
                         "creator_normalized": normalized, "early_velocity": velocities,
                         "uncertainty": "Small selected owner-authorized sample; no population or predictive interval inferred",
                         "observed_at_range": [min(x["observation"]["observed_at"] for x in items), max(x["observation"]["observed_at"] for x in items)],
                         "actual_measurement_age_range_ms": [min(x["observation"]["measurement_age_ms"] for x in items), max(x["observation"]["measurement_age_ms"] for x in items)],
                         "latest_observation_lag_ms": int((datetime.fromisoformat(cutoff) - max(datetime.fromisoformat(x["observation"]["observed_at"]) for x in items)).total_seconds() * 1000),
                         "source_ids": sorted({x["observation"]["source"]["source_id"] for x in items}),
                         "original_evidence_refs": sorted({x["observation"]["source"]["evidence_ref"] for x in items}),
                         "ledger_artifact_sha256": sorted({x["artifact_sha256"] for x in items})})
    pending = []
    for path in sorted((Path(root) / "imports").glob("*.json")):
        r = read_receipt(path)
        if r["grant_id"] == grant["grant_id"] and r["received_at"] < cutoff:
            permitted_captures = {x["source_record_id"] for x in r["contract"]["rows"] if allowed(grant, x["creator_id"])}
            pending.extend(p for p in r["pending_temporal_observations"] if p["source_record_id"] in permitted_captures)
    return {"evidence_type": "creator_authorized_export", "cutoff_exclusive": cutoff, "current_permission_required": True,
            "observations": len(rows), "post_count": len({x["observation"]["post_id"] for x in rows}),
            "pending_unknown_clock_rows": len(pending),
            "pending_value_missingness": dict(Counter(x["value_missingness"] for x in pending)),
            "pending_clock_missingness": dict(Counter(k for x in pending for k in x["missing_clocks"])),
            "definitions": analyses,
            "missingness": dict(Counter(x["observation"]["missingness"] for x in rows)),
            "target_age_ms": age_ms, "age_tolerance_ms": tolerance_ms,
            "recommendation_baseline_evaluation": {"status": "not_evaluable", "reason": "No independently frozen pre-outcome recommendations/outcomes supplied; PR #12 remains synthetic-only"}}


def report(source, records, root=None, permission_path=None, cutoff=None):
    if cutoff is not None:
        from research.observation_ledger.schema import instant
        cutoff = instant(cutoff)
    result = {"version": "quant-intelligence-v1", "catalog": catalog_signals(source, records),
              "authorized_exports": {"status": "not_connected", "reason": "No separately verified creator export configured; no real creator outcome import claimed"}}
    if root is not None and permission_path is not None:
        try:
            if (Path(root) / "observations.sqlite").exists():
                result["authorized_exports"] = workspace_snapshot(root, permission_path, cutoff=cutoff)
        except (ValueError, OSError):
            result["authorized_exports"] = {"status": "blocked", "reason": "Workspace missing or current permission invalid; no private values returned"}
        try:
            result["manual_annotations"] = annotations(root, permission_path)
            if cutoff is not None:
                from research.observation_ledger.schema import instant
                result["manual_annotations"] = [a for a in result["manual_annotations"] if instant(a["recorded_at"]) < instant(cutoff)]
        except (ValueError, OSError):
            result["manual_annotations"] = []
    if cutoff is not None:
        result["annotation_cutoff_exclusive"] = cutoff
    result["result_sha256"] = sha(__import__("json").dumps(result, sort_keys=True, ensure_ascii=False, allow_nan=False).encode())
    return result


def annotation_posts(records, root=None, permission_path=None):
    posts = post_context(records)
    if root is None or permission_path is None:
        return posts
    try:
        grant = permission(permission_path)
    except (ValueError, OSError):
        return posts
    for path in sorted((Path(root) / "imports").glob("*.json")):
        receipt = read_receipt(path)
        if receipt["grant_id"] != grant["grant_id"] or "analytics_research" not in grant["scopes"]:
            continue
        for r in receipt["contract"]["rows"]:
            if allowed(grant, r["creator_id"]):
                posts.append({"source_id": receipt["contract"]["source_id"], "post_id": r["post_id"],
                              "creator_id": r["creator_id"], "duration_s": None,
                              "url": "https://www.instagram.com/reel/" + r["shortcode"] + "/"})
    return list({(p["source_id"], p["post_id"]): p for p in posts}.values())
