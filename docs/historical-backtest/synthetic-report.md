# Historical backtest feasibility — synthetic only

No real historical backtest was run. These invented results test mechanics, not Lynxr performance.

Frozen prediction digest: `9d2b5feb2c65e557d352a08e4763e7b7b65db4d257670f53a262fa7e563c2b22`.
Fixture digest: `1be25d61d66f58e7b79176a6f77aef4bb4c28a3061e8c5d958c4924d61e63403`.

Reproduce: `python3 -I pipeline/eval_scripts.py historical`; add `--format json` for the complete audit.

## Coverage

History admitted: 16; rejected: 6.
Candidate manifest admitted: 10; rejected: 3.
Exploratory outcome bands: {"breakout": 1, "outperforming": 1, "typical": 2, "underperforming": 1, "unknown": 5}.
Outcome status: {"missing_baseline": 1, "missing_or_incomparable_outcome": 3, "observed": 5, "zero_baseline": 1}.

## Frozen strategies and conditional observations

| Strategy | Selected K | Matched videos | Normalized outcomes | Unmatched predictions | Conditional precision | Mean ratio |
| --- | --- | --- | --- | --- | --- | --- |
| random | 2 | 3 | 1 | 1 | 1.000 | 4.000 |
| popularity | 2 | 6 | 3 | 0 | 1.000 | 2.067 |
| normalized | 2 | 2 | 1 | 1 | 0.000 | 1.000 |
| niche_popularity | 2 | 6 | 3 | 0 | 1.000 | 2.067 |
| structural_proxy | 2 | 2 | 1 | 1 | 0.000 | 1.000 |

Conditional precision uses only selected formats with normalized outcomes, not all K. Coverage and missingness differ by strategy; there is no causal lift or production-quality claim.

## Rejected historical records

- future-discovered: not_known_at_cutoff
- future-extracted: features_not_known_at_cutoff
- historical-duplicate: duplicate_content
- other-platform: outside_fixed_population
- permission-unknown: permission_unestablished
- unknown-time: missing_or_invalid_timestamp

## Unresolved predictions

- random: unadopted remains no_match_observed (not a failure).
- normalized: unadopted remains no_match_observed (not a failure).
- structural_proxy: unadopted remains no_match_observed (not a failure).

## Interpretation limits

- Synthetic methods demonstration; no historical or causal performance evidence.
- No real corpus accessed; source coverage and permission remain unverified.
- No model or script-generation capability evaluated; structural proxy is an unvalidated heuristic.
- Unknown outcomes and unmatched predictions are not failures.
- Creator bootstrap ignores residual shared-format dependence; no significance claim.
- Schedule B unavailable; all product dependencies remain provisional.

Every fixture has invented-data provenance. See [design](design.md) and [inventory](inventory.md) for timestamp reliability, sampling, metrics, walk-forward validation and prerequisites for real research.
