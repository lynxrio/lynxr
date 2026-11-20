# Mission 002: historical evaluation contract (synthetic proof of concept)

This document proposes an experiment-local contract before implementation. No shared database schema, taxonomy, prompt, generation behavior, or PR #10/#11 branch changes are proposed. The private Operating Agreement and Schedule B are unavailable and provisional; no legal terms or missing acceptance criteria are inferred.

## Decision and time axis

Real January 2025 validation is **not established as feasible from the available evidence**. Implement only an invented-data feasibility prototype. Repository aggregate counts are not an accessible, authorized historical corpus. Do not open private backups or creator records, scrape, call a model, or contact a database.

Specify the ambiguous dates as UTC: the January 4 information set ends at the **exclusive** cutoff 2025-01-05T00:00:00Z. Candidate publication is [January 5 00:00, January 7 00:00). The January 4–6 decision/publication span is 72 hours, not an assertion that every candidate has matured by January 7. Use a primary outcome at exactly 48 hours after each publication: observations fall in [January 7 00:00, January 9 00:00), with analyst availability required before January 10 00:00. The synthetic observation tolerance is zero. A future real protocol must freeze its tolerance and final observation-close date before outcomes are inspected.

At cutoff, admit only Instagram records from a fixed creator roster whose membership was available then, with publication, first discovery, collection, record availability, structural-feature availability, and appropriate metric observations demonstrably preceding cutoff. Later-discovered pre-cutoff videos and 2026 measurements of 2024 posts are not historical inputs. Store metric observation and analyst availability separately. Never substitute file mtime, import time, publication time, or today's follower count for an observation timestamp.

The real research arms would be (A) format adoption/discovery, (B) conditional format-performance association, (C) script-generation fidelity and editing burden. This prototype demonstrates A/B bookkeeping only; C is not evaluated. A present-day model on historically restricted inputs is a retrospective-model study, not a reconstruction of the 2025 system; future knowledge in model weights cannot be undone by filtering prompts. No model is used here.

## Proposed local records

All fixtures and reports must carry evidence_type = synthetic_fixture and explicit invented-data provenance. The command accepts bundled fixtures only, not a private-file or live-data option.

- History: opaque video/creator IDs; platform; published_at; discovered_at; collected_at; available_at; features_available_at; availability/permission status; content_hash and near_duplicate_group; format ID and structural representation; independently timestamped metric observations.
- Candidate manifest: the same metadata for each future-window post in the predetermined roster, without metric fields. Missing/unavailable structural features remain in the manifest. Candidate features are evaluation-side observations, never ranker inputs.
- Outcomes: separate observation records keyed to candidate IDs, with observed_at, available_at, integer views (null is unknown), and provenance. Preserve missing and wrong-age observations; report why they cannot be evaluated.
- Policy: fixed roster and roster_available_at, cutoff, candidate interval, outcome-close date, platform, target niche, feature-version string, minimum baseline size, K, seed, similarity rules and exploratory performance bands.

The synthetic timestamps and prediction digest are reproducibility devices, not proof any prediction was actually made in 2025. Historical provenance would require authentic independent archive manifests and access/rights review. Synthetic permission flags convey no real platform license.

## Frozen ranking and baselines

Freeze history-derived catalog, creator baselines, selection policy and ranked outputs before reading candidate/outcome files. The API boundary accepts only history and policy. Hash that artifact; tests change future records and verify it does not change. Historical transformations use only eligible history; future-format features may be classified under the frozen rules but cannot create catalog entries or tune thresholds.

Count unique historical content groups once, after temporal admission; exclude duplicate future content from independent adoption/performance analysis. The prototype uses fixture-supplied exact hashes and near-duplicate groups, not a validated perceptual duplicate detector.

Historical creator baselines are median 48-hour views of at least three unique, eligible posts on the same platform. For historical engagement-normalized ranking, use each post's ratio to its creator's OTHER historical posts (at least two) to avoid a post normalizing itself. Future outcome ratios use the frozen full historical median. A zero baseline yields an undefined ratio, not infinity; missing and zero views differ. Conflicting counts with identical observation/availability clocks remain unknown rather than choosing a favorable value; otherwise use the earliest available comparable snapshot.

Compare a shared catalog and K across:
1. seeded hash-based random selection;
2. historical format popularity (unique pre-cutoff posts);
3. median historical creator-normalized performance;
4. target-niche-matched popularity;
5. an explicitly exploratory structural/diversity proxy: median normalized performance × min(distinct historical creators, 3) / sqrt(popularity), restricted to target niche.

The fifth arm is a proposed heuristic, **not Lynxr's current or validated model**. It only tests the comparison mechanism. Scores, tie-breaking, feature definitions, seeds and K are fixed before future data. No held-out period is used for tuning in this prototype.

## Format matching specification v1

Reusable-format matching requires every structural field to be present. Gates: same niche, audience and delivery; at least three beat roles; at least two distinct non-generic role anchors beyond intro/body/outro/talk; identical hook category; ordered beat-role similarity at least 0.8. Sequence similarity is 2 × LCS / combined sequence lengths. Future features must be available after collection and before outcome close; missing or conflicting clocks leave matching unknown.

Weighted similarity: hook 0.20, ordered roles 0.30, delivery 0.10, pacing 0.10, product-entry bin 0.10, reveal bin 0.10, CTA-placement bin 0.10. A reusable-format match requires score ≥0.85 and all gates. Categories and early/mid/late bins are experiment-local, not taxonomy changes. No embeddings or engagement appear in matching.

Classification order:
- known exact/near-duplicate content: exclude from independent adoption analysis;
- same reusable format under the rules above;
- broad genre/topical similarity only;
- insufficient features / no structural match.

A generic talking-head label or shared niche is insufficient even with superficially matching fields. Frozen predictions with no future match are retained as no_match_observed, not scored as failures. This does not imply a missing format was never adopted outside the observed frame.

## Evaluation definitions and uncertainty

Performance bands are exploratory and mutually exclusive: underperforming r<0.5; typical 0.5≤r≤1.5; outperforming 1.5<r≤3; breakout r>3. Binary outperformance includes breakout. Report raw ratio r = views / historical median and smoothed log relative views ln((views+1)/(median+1)) separately.

For each strategy, count each selected future video once even when multiple predictions match. Report matching and valid-outcome denominators, missing/invalid-age/zero-baseline reasons, and unmatched predictions:
- discovery adoption@K: selected formats with an observed future match / selected formats (a coverage observation);
- observed precision@K: selected formats with ≥1 observed outperforming match / selected formats with ≥1 valid normalized outcome. This conditional denominator excludes unmatched and wholly unmeasured predictions; it is NOT ordinary precision over all K.
- observed-frame recall: selected matched outperforming videos / all normalized outperforming videos, only if a defensible complete eligible manifest exists;
- creator-balanced mean ratio/log ratio over observed selected matches, plus paired creator-cluster bootstrap intervals for differences in mean log performance versus random selection.

The bootstrap resamples creators as clusters with a fixed seed, retaining their posts and paired strategy membership. With fewer than three observed creators in the frame or in either compared strategy, do not print an interval. Report usable bootstrap draws. The bundled comparison has insufficient clusters per strategy, so its intervals are unavailable; a separate invented six-creator regression exercises resampling. Shared formats still correlate across creators, and synthetic tiny samples cannot support significance; real work needs format-aware sensitivity/multiway clustering, disjoint chronological periods and enough independent clusters. This single-platform prototype does not pool platforms. These estimates are conditional associations with different matching/measurement coverage, not causal effects or proof of virality. No-match and missing outcomes are not imputed as zero.

## Sampling and walk-forward protocol

Before looking at outcomes, define a fixed creator panel selected using only cutoff-available metadata, or a complete archived listing frame with versioned eligibility. Census all eligible January 5–6 posts, including low/typical/outperforming/breakout and missing outcomes; do not choose winners via search or current feeds. Preserve removed/private/deleted post identifiers when lawfully documented, availability reasons, incomplete listings and uncaptured posts. Follower-normalized metrics need actual cutoff follower snapshots; they are optional and not reconstructed.

If a separate diagnostic set oversamples underperformers, keep inclusion probabilities, original frame, stratum and weights. Do not compute population lift/recall from it as a census. This prototype supports only census fixtures and rejects a non-unit sampling probability rather than silently using biased aggregates. Deleted low performers can be missing not at random; show attrition sensitivity/bounds rather than claim recovery.

Repeat disjoint publication windows after exclusive cutoffs January 5, 12 and 19 (the ends of January 4, 11 and 18). Rebuild all features/baselines/catalogs from then-available observations only. Use earlier periods for design, freeze choices, and reserve a final chronological block; embargo duplicate content across all splits. Keep creator-held-out sensitivity separate from within-creator baseline tests. Repeatedly optimizing one test period, overlapping outcome windows, modern pretrained models and inferred discovery times all threaten validity. The current single-window synthetic CLI does not implement or validate a rolling real-data study.

## Next experiment and product implications

First request a permission-reviewed, de-identified **metadata-only** archive manifest (no credentials or creator payloads) with authentic publication/discovery/collection/observation/availability times, metric definitions and source/rights provenance. Audit timestamp and population coverage before requesting any historical data access. If no authentic 2025 snapshots exist, report the January question unanswerable from these sources and propose a separately authorized prospective creator-panel study instead of fabricated history.

Milestone 1: pair format fidelity and craft checks with blinded editing-burden measurement; historical structure similarity alone cannot establish generated-script utility.
Milestone 2: creator-specific age-matched baselines, niche ranking and emerging/saturated-format studies become possible only with prospective coverage and archived outcomes; validate lift against simple baselines before recommendations. No production integration or milestone acceptance is proposed.
