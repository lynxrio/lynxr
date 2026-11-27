# Mission 004: real-data inventory and exploratory findings

Measured locally on 2026-11-20 from the pinned public CSV, not from synthetic fixtures. Provider-reported records were not independently verified as a complete or representative population. One original link was opened successfully on Instagram; the page exposed a Reel player, creator and matching publication date, plus a signup prompt. Playback and the remaining URLs were not verified. No login or restriction bypass was attempted, and no current-page counters were ingested.

## Inventory and provenance

Source: [Bright Data's Reels sample](https://github.com/luminati-io/Instagram-Reels-dataset-samples), commit `06fb48c75b91d4a635f15336aee73c22c012c602`. CSV SHA-256: `fc7ff7f74faf3227c69ea92fce8359170f89675ead62054dbf40fc9abb06f422`, 6,774,555 bytes. The README advertises 6,850 records; the actual file contains **1,000**, all ingested with zero quarantined rows.

| Field / subset | Observed coverage |
| --- | --- |
| `product_type=clips` | 983 records, default Reel catalog |
| Other product types | 12 feed + 5 IGTV, retained and explicitly filterable |
| Unique native post IDs / shortcodes / source URLs | 1,000 each; no source duplicates |
| Creators | 987 across all records; 971 in the Reel subset |
| Reel creator sample sizes | 961 with one post, 9 with two, 1 with four |
| Publication timestamps | 1,000 supplied; source-wide range 2016-12-26 through 2025-12-04 |
| Views / comments | 1,000 valid nonnegative counters each; views and plays are separate fields |
| Likes | 940 nonnegative values; 60 `-1` sentinels retained as unknown with a quality flag |
| Plays | 983 supplied; 17 missing, all on non-`clips` source rows |
| Duration | 1,000 finite nonnegative values; long durations retained without inventing a platform limit |
| Followers / following / posts_count | Entirely absent; no follower normalization possible |
| Original collection / metric observation / discovery clocks | Not supplied |
| Media URLs | Source supplies video/thumbnail references; no media is fetched or served by the lab |
| Live, private or deleted status | Unknown for every source row; no deletion/listing ledger |
| Eligible age-matched creator baselines | 0 |
| Qualifying historical observations | 0 |

The Git commit date is reported as January 15, 2026, 13:11:07 UTC. It is repository metadata, not an authenticated measurement clock or proof of a prediction made earlier. The local receipt records actual download and ingestion timestamps separately; neither refreshes or dates the source counters. Full row-level source lineage and unknown fields travel in JSON exports. The raw file, SQLite database, receipts, full exports and UI screenshots remain outside Git.

Rights scope is in [README](README.md#source-and-rights-decision). No open-data license was found in the repository. The provider's sample policy supports a local evaluation proof of concept; unrestricted reuse, redistribution and media rights are not established. This PR distributes application code and aggregate findings, not the dataset, captions, record screenshots or media.

## Descriptive comparisons on the 983 Reel-labeled rows

Median source `views` is **2,265**; median `video_play_count` is **9,604**. Do not combine them or interpret either as a known 48-hour outcome. The provider does not establish the precise semantics, observation ages or simultaneous collection of these fields in this sample.

| Observed-view stratum | N | Median views | Median duration | Median (likes + comments) / views | Ratio known N |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lower quarter | 245 | 150 | 27.833s | 16.67% | 225 |
| Upper quarter | 245 | 51,237 | 35.4s | 7.16% | 240 |

Quartiles are sorted by views and ID, taking `floor(N/4)` at each end. The view difference is true by construction, not a predictive finding. The interaction ratio shares its denominator with the grouping variable, so mathematical coupling is another reason not to infer that stronger reach reduces engagement. Different post ages, topics, accounts and selection also confound the comparison. These are lower/higher observed counts, **not underperformance/outperformance relative to a creator**.

| Duration bin (lower inclusive except “under”) | N | Median observed views |
| --- | ---: | ---: |
| Under 15s | 229 | 1,644 |
| 15–30s | 250 | 2,062.5 |
| 30–60s | 272 | 2,580 |
| 60–180s | 199 | 3,496 |
| 180s+ | 33 | 2,473 |

No optimal duration or causal effect follows. Caption-only heuristics classify 6 how-to wordings, 99 question wordings and 878 records without a classified cue. No before/after or try-on wording was detected under the frozen English regex rules. This is sparse, language-biased inferred text evidence, not a visual or narrative format annotation. Provider `product_type` and mechanical duration bins are separately labeled.

No predictive model, out-of-sample accuracy, creator-relative failure rate or causal effect is reported. The app exposes sample medians as references but withholds normalized outcomes: observation ages are unknown, creator IDs are handles, and no Reel creator even reaches the existing `hook_views.MIN_OTHERS=4` other-post minimum. More posts alone would not cure missing clocks. Missing/private/deleted outcomes stay unknown, not zero. The sample frame, selection weights and missing unsuccessful posts cannot be reconstructed.

## Reproducible outputs and verification

JSON exports include the full source receipt, applied filters, analysis version, all matching records (not just the current page), summary and canonical result digest. Repeating an export against the same ingested source and filters produces identical bytes. Page number is excluded from the research definition. CSV is a flat convenience projection: retain the companion JSON for provenance, filters and method. Both are local evaluation artifacts, not redistribution packages. Source CSV bytes and database projection are compared again by the opt-in `verify` command.

Verification performed:

- 21 automated unit/integration tests pass on Python 3.12/3.14. Artificial fixtures are confined to tests and never populate the catalog. Coverage includes sentinels, zero denominators, URL identities, baseline refusal, dates/search/sort, duplicate quarantine, deterministic exports, CSV formula safety and HTTP Host/Origin/method/path boundaries. The HTTP test blocks outbound URL fetches while exercising loopback requests.
- Real-data `verify` passes: source digest, all 1,000 recomputed projections, 983 Reel subset, 60 unknown likes, unknown clocks and deterministic analysis. No network is required by this check.
- Existing explicit offline runner: 31/31 test scripts pass, including the new Quant Lab entry point. Main does not yet include the separate draft PR #12 tests; this branch does not alter that PR.
- Focused Ruff passes; JavaScript syntax check passes. Repository-wide Ruff retains 928 existing findings under the host configuration; unrelated cleanup is excluded. Cache-stamp check passes across 127 existing website pages; no site assets are changed.
- Browser verification passed: creator filtering (four real records), inclusive January date filters (two), ascending sort, two-record comparison, detail and sample-reference inspection, actual JSON download (four records), empty search, pagination and provenance/cohort views. No browser console errors were observed.
- Desktop layout was inspected at 1440×1000 and the viewport restored. The narrow 319px layout has no document-wide horizontal overflow; its wide table scrolls within its container. Real-record screenshots are local artifacts, not committed or uploaded.

No media playback, automated multimodal analysis, production access or paid inference was tested. Automated prospective collection is not implemented. See [prospective plan](prospective.md) for the next engineering gates.
