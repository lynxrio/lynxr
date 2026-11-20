"""Descriptive sample statistics; no predictive or causal model."""

import statistics
from collections import Counter, defaultdict
from datetime import date

from pipeline.hook_views import MIN_OTHERS

from .comparisons import age_reference
from .data import canonical, sha

SORTS = {"views", "video_play_count", "likes", "num_comments", "engagement_per_view", "published_at", "duration"}
ALLOWED_FILTERS = {"q", "creator", "start", "end", "type", "cue", "sort", "direction", "page", "source", "hook", "pace"}


def median(rows, field):
    values = [r[field] for r in rows if r.get(field) is not None]
    return statistics.median(values) if values else None


def filter_records(records, query):
    if set(query) - ALLOWED_FILTERS or any(len(v) != 1 for v in query.values()):
        raise ValueError("unknown or repeated filter")
    args = {k: v[0] for k, v in query.items()}
    sort = args.get("sort", "views")
    direction = args.get("direction", "desc")
    if sort not in SORTS or direction not in ("asc", "desc"):
        raise ValueError("unsupported ordering")
    for name in ("start", "end"):
        if args.get(name):
            date.fromisoformat(args[name])
    if args.get("start") and args.get("end") and args["start"] > args["end"]:
        raise ValueError("start date is after end date")
    if len(args.get("q", "")) > 300 or len(args.get("creator", "")) > 100:
        raise ValueError("query too long")
    source_id = args.get("source", "brightdata-reels")
    if source_id not in ("brightdata-reels", "educational-reels"):
        raise ValueError("choose one source; incompatible counters cannot be pooled")
    out = []
    for r in records:
        if r.get("source_id", "brightdata-reels") != source_id:
            continue
        if args.get("hook") and args["hook"] not in [v.strip() for v in (r.get("annotations", {}).get("hook_type") or "").split(",")]:
            continue
        if args.get("pace") and r.get("annotations", {}).get("editing_pace") != args["pace"]:
            continue
        if args.get("type", "clips") != "all" and r["product_type"] != args.get("type", "clips"):
            continue
        if args.get("creator", "").casefold().lstrip("@") not in r["creator"].casefold():
            continue
        if args.get("q", "").casefold() not in (r["creator"] + " " + r["caption"] + " " + " ".join(r["hashtags"])).casefold():
            continue
        if args.get("cue") and r["caption_cue"] != args["cue"]:
            continue
        day = (r["published_at"] or "")[:10]
        if (args.get("start") and (not day or day < args["start"])) or (args.get("end") and (not day or day > args["end"])):
            continue
        out.append(r)
    known = sorted((r for r in out if r[sort] is not None), key=lambda r: r["id"])
    known.sort(key=lambda r: r[sort], reverse=direction == "desc")
    return known + sorted((r for r in out if r[sort] is None), key=lambda r: r["id"])


def creator_reference(record, records):
    peers = [r for r in records if r["creator"] == record["creator"] and r["product_type"] == "clips" and r.get("source_id") == record.get("source_id")]
    return {"age_band_reference": age_reference(record, records), "sample_posts": len(peers), "sample_median_views": median(peers, "views"),
            "eligible_baseline": False, "normalized_outcome": None, "required_other_posts": MIN_OTHERS,
            "reason": "No pre-cutoff, exact-age baseline established; source clocks/ages have source-specific uncertainty and creator handles are not verified stable IDs.",
            "minimum_count_met": len(peers) >= MIN_OTHERS + 1,
            "interpretation": "Selected-sample median only; includes this post, mixed ages, not a historical baseline."}


def summarize(records):
    ordered = sorted((r for r in records if r["views"] is not None), key=lambda r: (r["views"], r["id"]))
    size = len(ordered) // 4
    def cohort(label, rows):
        return {"label": label, "n": len(rows), "median_views": median(rows, "views"),
                "median_duration": median(rows, "duration"), "median_engagement_per_view": median(rows, "engagement_per_view"),
                "engagement_measured_n": sum(r["engagement_per_view"] is not None for r in rows)}
    duration, cues = defaultdict(list), defaultdict(list)
    for r in records:
        duration[r["duration_bin"]].append(r)
        cues[r["caption_cue"]].append(r)
    views_histogram = []
    for lower, upper, label in ((0, 100, "<100"), (100, 1000, "100–1K"), (1000, 10000, "1K–10K"),
                                (10000, 100000, "10K–100K"), (100000, 1000000, "100K–1M"),
                                (1000000, float("inf"), "1M+")):
        views_histogram.append({"label": label, "n": sum(lower <= r["views"] < upper for r in ordered)})
    return {"n": len(records), "creators": len({r["creator"] for r in records}),
            "median_views": median(records, "views"), "median_plays": median(records, "video_play_count"),
            "unknown_likes": sum(r["likes"] is None for r in records),
            "unknown_plays": sum(r["video_play_count"] is None for r in records),
            "eligible_creator_baselines": 0, "historical_eligible_observations": 0,
            "availability": dict(Counter(r["availability"] for r in records)),
            "creator_sample_sizes": dict(Counter(Counter(r["creator"] for r in records).values())),
            "observed_view_quartiles": [cohort("Lower observed-view quarter", ordered[:size]),
                                        cohort("Upper observed-view quarter", ordered[-size:] if size else [])],
            "duration_cohorts": [cohort(k, v) for k, v in sorted(duration.items())],
            "caption_cue_cohorts": [cohort(k, v) for k, v in sorted(cues.items())],
            "histogram": views_histogram,
            "interpretation": "Descriptive selected-sample counts at unknown post ages. Quartiles are not relative success/failure; no out-of-sample prediction or causal effect."}


def export_bundle(source, records, query):
    selected = filter_records(records, query)
    filters = {k: v[0] for k, v in sorted(query.items()) if k != "page"}
    selected_source = next((s for s in source.get("sources", []) if s["source_id"] == filters.get("source", "brightdata-reels")), source)
    result = {"schema_version": 2 if "sources" in source else 1, "analysis_version": "quant-lab-descriptive-v2", "source": selected_source,
              "filters": {"source": "brightdata-reels", "type": "clips", "sort": "views", "direction": "desc", **filters},
              "summary": summarize(selected), "records": selected}
    result["result_sha256"] = sha(canonical(result).encode())
    return result
