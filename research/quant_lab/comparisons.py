"""Empirical comparisons of real source records, with explicit comparison populations."""

import statistics
from collections import defaultdict

from pipeline.hook_views import MIN_OTHERS

from .data import canonical, sha

AGE_BANDS = ((2, "0–2 days"), (7, "3–7 days"), (30, "8–30 days"), (90, "31–90 days"), (float("inf"), "91+ days"))


def age_band(record):
    age = record.get("age_calendar_days")
    return next(label for limit, label in AGE_BANDS if age <= limit) if age is not None else None


def median(rows, key):
    values = [r[key] for r in rows if r.get(key) is not None]
    return statistics.median(values) if values else None


def age_reference(record, records):
    band = age_band(record)
    others = [r for r in records if r["id"] != record["id"] and r.get("source_id") == record.get("source_id")
              and r["creator"] == record["creator"] and r["product_type"] == "clips" and band is not None
              and age_band(r) == band and r["views"] is not None]
    center = median(others, "views")
    enough = len(others) >= MIN_OTHERS and center is not None and center > 0 and record["views"] is not None
    return {"method": "same_source_same_handle_same_calendar_age_band_leave_one_out_median_v1",
            "age_band": band, "other_posts": len(others), "required_other_posts": MIN_OTHERS,
            "other_post_ids": sorted(r["id"] for r in others), "other_median_views": center if enough else None,
            "descriptive_ratio": record["views"] / center if enough else None,
            "historical_baseline_eligible": False,
            "limitation": "Descriptive sample reference only. Coarse ages, rounded counts and mutable handles; contemporaneous outcomes, not a prior baseline or predictive accuracy."}


def source_for(source, record):
    return next((s for s in source.get("sources", []) if s["source_id"] == record.get("source_id")), source)


def research_report(source, records):
    annotated = [r for r in records if r.get("source_id") == "educational-reels"]
    sources = source.get("sources", [source])
    references = {r["id"]: age_reference(r, annotated) for r in annotated}
    by_creator, by_band = defaultdict(list), defaultdict(list)
    for row in annotated:
        by_creator[row["creator"]].append(row)
        by_band[(row["creator"], age_band(row))].append(row)
    creators = []
    for name, rows in sorted(by_creator.items(), key=lambda p: (-len(p[1]), p[0])):
        ordered = sorted(rows, key=lambda r: (r["views"] is None, r["views"] or 0, r["id"]))
        creators.append({"creator": name, "n": len(rows), "median_views": median(rows, "views"),
                         "lowest_id": ordered[0]["id"], "highest_id": ordered[-1]["id"],
                         "min_views": ordered[0]["views"], "max_views": ordered[-1]["views"],
                         "reference_available_n": sum(references[r["id"]]["descriptive_ratio"] is not None for r in rows),
                         "age_days_min": min(r["age_calendar_days"] for r in rows),
                         "age_days_max": max(r["age_calendar_days"] for r in rows)})
    # Largest comparable groups, not the largest discovered view ratios. No claim of representativeness.
    groups = sorted(((key, rows) for key, rows in by_band.items() if len(rows) >= MIN_OTHERS + 1),
                    key=lambda p: (-len(p[1]), p[0]))
    chosen, pairs = set(), []
    for (creator, band), rows in groups:
        if creator in chosen:
            continue
        ordered = sorted((r for r in rows if r["views"] is not None), key=lambda r: (r["views"], r["id"]))
        if len(ordered) < 2:
            continue
        pairs.append({"creator": creator, "age_band": band, "comparable_sample_n": len(rows),
                      "lower": {"record": ordered[0], "reference": references[ordered[0]["id"]]},
                      "higher": {"record": ordered[-1], "reference": references[ordered[-1]["id"]]}})
        chosen.add(creator)
        if len(pairs) == 3:
            break
    structures = []
    for field in ("hook_type", "editing_pace", "cta", "delivery_style", "subtitles"):
        groups = defaultdict(list)
        for row in annotated:
            value = row["annotations"].get(field)
            # Hooks are multi-label; a row may appear in several groups.
            labels = [v.strip() for v in value.split(",")] if field == "hook_type" and value else [value]
            for label in labels:
                groups[label or "Missing annotation"].append(row)
        varying = sum(len({tuple(sorted(v.strip() for v in (r["annotations"].get(field) or "Missing annotation").split(","))) for r in rows}) > 1
                      for rows in by_creator.values())
        values = []
        for label, rows in sorted(groups.items()):
            ratios = [references[r["id"]]["descriptive_ratio"] for r in rows if references[r["id"]]["descriptive_ratio"] is not None]
            values.append({"label": label, "n": len(rows), "creators": len({r["creator"] for r in rows}),
                           "median_views": median(rows, "views"), "reference_n": len(ratios),
                           "median_descriptive_ratio": statistics.median(ratios) if ratios else None})
        structures.append({"field": field, "within_creator_variation_n": varying, "groups": values})
    low_count = sum(r["views"] is not None and r["views"] < 1000 for r in annotated)
    result = {"analysis_version": "quant-lab-real-terminal-v1", "sources": sources,
              "real_reels_total": sum(r["product_type"] == "clips" for r in records),
              "annotated_reels": len(annotated), "annotated_creators": len(by_creator),
              "descriptive_reference_n": sum(r["descriptive_ratio"] is not None for r in references.values()),
              "historical_prediction_eligible_n": 0, "creator_comparisons": creators, "example_pairs": pairs,
              "example_selection": "Three largest same-account calendar-age-band groups with at least five posts; one group per account. Inspect min/max observed views. Extremes selected for inspection, not hypothesis testing.",
              "structure_comparisons": structures,
              "missingness": {"annotated_unknown_likes": sum(r["likes"] is None for r in annotated),
                              "annotated_unknown_live_status": sum(r["availability"] == "unknown" for r in annotated),
                              "annotated_zero_comments": sum(r["num_comments"] == 0 for r in annotated),
                              "annotated_below_1000_observed_views": low_count,
                              "unrecorded_skipped_or_deleted_posts": None},
              "limitations": ["Source-specific descriptive comparisons; never pool the two view definitions",
                              "Low absolute counts do not establish creator-relative failure; incomplete sampling frame",
                              "Reference ratios use other contemporaneous observations in broad age bands, not pre-cutoff baseline outcomes",
                              "Single-coder annotations, not our video viewing; no causal or predictive claims",
                              "Hook labels overlap; unequal creator weighting and topic/age confounding remain"],
              "structure_coverage": {"hook_type": "Published human annotation", "narrative_beats": "Only introduction/logical-flow/ending judgments; no ordered beat transcript",
                                     "pacing": "Human Slow/Medium/Fast category, not cuts/second", "reveal_timing": "Not supplied",
                                     "product_integration": "Not supplied; educational sample excludes some promotional content",
                                     "cta": "Published human category", "editing": "Human subtitles/overlays/music/delivery categories"},
              "prospective_first_observation": "Obtain one creator's scoped research consent and a creator-supplied analytics screenshot/export now; save actual receipt and metric-definition evidence privately. Freeze the panel/protocol before future posts, record publication time and all listing attempts, and measure at 48h ±60min. An existing approved timestamped private receipt must precede future outcomes. No collector or credentials connected."}
    result["result_sha256"] = sha(canonical(result).encode())
    return result
