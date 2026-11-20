# Future authorized creator-analytics export adapter — design only

No connector, export parser, access to files outside the invented fixture, credential configuration, real-data flag or production integration is implemented. This schema is local to this research module. A real-data schema and adapter require a separate reviewed increment and explicit authorization; do not relabel exports as `synthetic_fixture` or strip real identities into the `syn:` namespace.

## Admission gates

1. Verify creator ownership/authority, platform/export terms, permitted purposes, retention and deletion obligations. Record consent scope, export provenance, evidence references and the time that authorization became available. Current access must be checked independently of historical permission observations. Unknown/denied authorization admits no usable metrics.
2. Read only an explicitly supplied authorized export into a separate quarantine location outside Git. No account discovery, scraping, API connection or media download. Limit size, reject duplicate columns/keys and formula execution; never load credentials or serialize secrets. Store source manifest and content hashes, access controls and retention deadlines. Decide whether the export itself may legally be retained.
3. Inventory fields before mapping: platform-native creator and post IDs; publication clock and timezone; exact metric observation clock; collection/export clock; metric definitions and effective versions; deleted/private/unreported rows; extraction version and actual analyst availability. An export generated today does not prove a metric was observed at publication or at a January 2025 cutoff. A range aggregate cannot be silently converted into a point observation. Missing observation times block point-in-time eligibility rather than being inferred from file mtime or publication.
4. Resolve identity aliases, time precision, timezone, source capture IDs and metric-definition changes in an explicit mapping manifest. Refuse ambiguous rows. Quarantine conflicts; do not overwrite old values. A new metric definition gets a new ID and separate comparisons until equivalence is independently justified. If a repeated export contains the same captures, report duplicate candidates for review before import, never silently replace them.
5. Produce a dry-run validation report: field completeness, permission status, temporal failures, duplicate/conflicting identities, counter-definition cohorts, source selection/coverage, unavailable/deleted/missing observations and exclusions with reasons. Keep the sampling denominator, including unsuccessful and unobserved posts; no view threshold filter. Review and authorize the exact artifact before a future append transaction. The existing v1 importer continues to reject it.

## Proposed mapping, not an operational contract

| Export evidence | Proposed ledger meaning | Missing/ambiguous handling |
| --- | --- | --- |
| Native IDs, not handle/URL alone | Platform-qualified creator/post identity | Quarantine unresolved aliases; retain conflict count |
| Post publication timestamp + zone | `published_at` | No invented timestamp; exclude from age-matched query |
| Documented measurement/snapshot timestamp | `observed_at` | No point-in-time metric eligibility without evidence |
| Source capture/export receipt + digest | `collected_at`, source/capture/artifact provenance | An export receipt cannot stand in for measurement time |
| Reproducible extraction + actual research receipt | `extracted_at`, `available_at`, local `recorded_at` | Never backdate availability to publication |
| Counter name, value, unit, documented semantics/version | Explicit immutable metric definition, nullable value | Separate versions, unknown semantics ineligible for pooling |
| Explicit availability state or failed attempt | Missingness and post-status observation | Preserve null; never impute zero or performance class |
| Authority, purpose, scope, evidence and knowledge time | Historical permission observation | Independent current authorization and erasure gate still required |

## Prospective experiment boundary

Use a fixed, consented creator panel with a documented enrollment/sampling denominator. Before enrollment, specify prediction target, horizon, age tolerance, metric definition, missingness/deletion policy and walk-forward split. At each cutoff, freeze the eligible input observation IDs, ledger head digest, query parameters, extraction/analysis versions and prediction artifact. Obtain an independent timestamp/immutable receipt before outcomes mature; a local clock alone is insufficient. Collect all eligible posts and attempts at scheduled horizons, preserve null/deletion markers and late arrivals, then join outcomes only after freezing predictions. Separate descriptive comparisons from out-of-sample prediction and causal claims. No predictive model is included here.

For real data, storage design must reconcile append-only auditability with withdrawal/erasure requirements (for example, a legally reviewed removable encrypted payload plus nonidentifying audit evidence). Do not assume retaining identifiable historical rows forever is permissible. Define revocation, access controls, retention, backup and deletion procedures before connecting a real adapter. This synthetic ledger is not that authorization or compliance system.
