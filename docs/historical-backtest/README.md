# Mission 002: bounded historical backtest feasibility

**Decision: implement the synthetic feasibility prototype only.** The repository describes roughly 9,000 videos, but no authorized record-level evidence establishes a January 2025 information set. Current engagement counts cannot answer the historical question. This work demonstrates temporal isolation, structural matching and evaluation accounting; it does not measure Lynxr's predictive or script-generation performance.

## Deliverables

| Requested deliverable | Evidence |
| --- | --- |
| 1. Historical feasibility | [Inventory and decision](inventory.md) |
| 2. Dataset inventory / timestamp coverage | [Source contracts, coverage and reliability classes](inventory.md) — code-level evidence, no private records inspected |
| 3. January 4–6 experiment | [Decision and time axis](design.md#decision-and-time-axis) — exclusive Jan 5 UTC cutoff, Jan 5–6 publication, exact 48h outcomes |
| 4. Unsuccessful-video discovery | [Bias / unsuccessful-video feasibility](inventory.md#bias-and-unsuccessful-video-feasibility), [sampling protocol](design.md#sampling-and-walk-forward-protocol) |
| 5. Leakage / selection-bias audit | Audit below; [source-specific risks](inventory.md); [walk-forward controls](design.md#sampling-and-walk-forward-protocol) |
| 6. Format similarity | [Frozen structural matching specification](design.md#format-matching-specification-v1) |
| 7. Baselines and metrics | [Five ranking arms](design.md#frozen-ranking-and-baselines), [denominators / uncertainty](design.md#evaluation-definitions-and-uncertainty) |
| 8. Offline prototype / tests | [Module](../../pipeline/historical_backtest.py), [regressions](../../pipeline/test_historical_backtest.py), [invented fixtures](../../pipeline/historical_fixtures/) |
| 9. Interpretation / uncertainty | [Synthetic report](synthetic-report.md), [historical reliability](inventory.md#historical-reliability-classes) |
| 10. Next engineering experiment | [Metadata-first archive gate and product implications](design.md#next-experiment-and-product-implications) |

## Run without credentials or services

Python 3.11+; the prototype uses only the standard library. From repository root:

```sh
python3 -I pipeline/eval_scripts.py historical
python3 -I pipeline/eval_scripts.py historical --format json
python3 -I pipeline/test_historical_backtest.py
```

The historical subcommand exits before production-module imports, environment loading or the legacy evaluation output-directory creation. It reads only four bundled, explicitly invented JSON fixture files. It has no database, platform, private-file, model or script-generation input option. The direct module CLI is equivalent. Other legacy evaluation subcommands retain their existing behavior and are outside this experiment.

The prediction digest covers the frozen history-derived artifact; a separate fixture digest covers all inputs. Late/rejected history is audited outside the prediction digest, so appending unavailable information cannot alter the committed prediction. The checked-in Markdown report must reproduce byte-for-byte; JSON includes per-candidate observations, exclusion reasons, match scores, coverage denominators, rankings and uncertainty availability.

## Temporal and selection audit

| Threat | Guard / remaining uncertainty |
| --- | --- |
| Future metric or future-discovered input | Distinct publication, discovery, collection, record/feature availability and measurement clocks; all history inputs must precede cutoff. Tests append late observations/records and preserve rankings and digest. Authentic real timestamps remain unverified. |
| Candidate/outcome leakage | `freeze(history, policy)` has no future argument; the CLI loads future files only after freezing. Tests mutate future outcomes/features without changing rankings. A digest proves reproducibility, not a prediction actually made in 2025. |
| Different post ages / lifetime counts | Compute age from timestamps; exact 48h, zero tolerance. Reject wrong-age, late, null, negative and malformed measurements. Existing production day labels cannot substitute. |
| Creator baseline contamination | Unique same-platform pre-cutoff posts, minimum three; leave-other-post normalization for historical ranking. Future posts never enter baselines; zero/insufficient baseline remains unknown. |
| Duplicate adoption | Supplied exact hashes / near-duplicate groups exclude repeated history and copied future content. Identity overlap is rejected. Automatic perceptual duplicate detection remains unvalidated. |
| Generic semantic overlap | Frozen structural gates, beat-order LCS and non-generic anchors; no embeddings or engagement in matching. Invented labels do not validate real annotator agreement or threshold precision/recall. |
| Winner search / absent failures | Cutoff-defined roster and complete fixture listing. Underperforming, typical, outperforming, breakout, private/missing and unmatched cases retained. Real listing completeness and outcome-dependent deletion remain unverified. Non-unit sampling probabilities stop aggregation. |
| False certainty | Conditional precision denominator and missingness explicit; ordinary precision left undefined. Observed-frame recall only with declared complete manifest. Creator resampling suppresses intervals for insufficient clusters; shared-format dependence and tiny samples prevent significance claims. |
| Future-trained representations / model selection | Fixed invented version, no learned transform or model. Real work needs authenticated feature histories, rolling disjoint windows, duplicate embargo, creator-held-out sensitivity and a final chronological holdout. Modern model weights cannot reproduce a historical system. |

## Verification evidence

Local verification on 2026-11-20:

- 28 deterministic tests pass via the standalone runner on Python 3.11/3.14 and targeted pytest on Python 3.12. They cover the guards above, conflicting simultaneous observations, unresolved predictions, census/permission boundaries, frozen-artifact tampering, reproducibility and bootstrap behavior.
- The historical CLI also passes a subprocess tripwire with an empty temporary home: forbidden production/provider imports, environment reads, network connections, directory creation and non-fixture data reads raise immediately. No runtime output files or chargeable calls are made.
- Existing `tools/fixer/run_tests.py` offline suite passes **31/31 test scripts**, including the added backtest test. Existing tests require their normal Python dependencies and local ffmpeg/ffprobe; those are not prototype dependencies.
- Focused Ruff checks on both new Python files pass. Repository-wide Ruff reports **928 findings in existing files** under the host's inherited configuration; unrelated lint cleanup is excluded. Broad pytest collection is not the repository's supported gate (legacy scripts execute at import); the explicit offline runner and targeted pytest were used.
- The report snapshot and repeated JSON generation are deterministic. No real corpus, production services or paid inference was exercised.
- Site cache-stamp validation passes (127 pages); no website files are changed.

These checks do not validate platform permissions, real-data quality, annotation reliability, historical predictive accuracy or script usefulness. No production prompt, generation behavior, Supabase schema/RLS, website, mobile app, PR #10 branch or PR #11 branch is changed.

## Next decision

Request a separately authorized, de-identified metadata manifest with original clocks, listing denominators, snapshots, field semantics and rights provenance. First determine whether authentic 2025 observations exist and whether unsuccessful/deleted posts are represented. Do not request creator payloads or credentials to perform that initial gate. If the archive fails it, propose a separately approved prospective fixed-panel study using real age-matched observations; keep the January question unanswered.

Script-generation fidelity, brand adaptation and editing burden need a separate blinded experiment. Milestone 1 / Milestone 2 dependencies are provisional: the private draft Schedule B was not supplied, and no missing acceptance criteria or legal/financial terms are inferred. The PR is for review of an offline research scaffold, not approval of a production predictor.
