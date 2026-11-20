# Synthetic script evaluation

synthetic detector regression, not production quality or milestone acceptance.

Fixture SHA-256: `bb7010519f9ea1e19adc92ced71d1ccf87f361a9c25554e66402f4c57eeb8956`.

16 synthetic cases; 10 measurable failures; 43 human review flags; 15 unavailable conditions.

Detector expectation mismatches: 0.

Reproduce from the repository root with `python3 -I pipeline/eval_scripts.py synthetic`. Use `--format json` for per-case metrics, check statuses and provenance. Run `python3 -I pipeline/test_synthetic_eval.py` to verify the detectors and this report snapshot.

Deliberately failing fixtures test detector behavior. These counts are not measured creator-script quality.

## Measurable failures

| Synthetic case | Check | Observation |
| --- | --- | --- |
| word-budget-exceeded | length.words | 27 spoken words; synthetic fixture budget 10 |
| hook-repeated | hook.repetition | shared script_checks metric: beat 1 contains at least 70% of unique hook tokens; intentional repetition needs human review |
| overlapping-and-overlong | timing.order_2 | beat overlaps or goes backward relative to preceding beat |
| overlapping-and-overlong | timing.source_duration | planned end 13s vs source 10s; existing harness overrun threshold is 1.15x, not measured performance |
| reversed-timing | timing.beat_1 | range must have finite nonnegative start and end > start |
| format-malformed | structure.format | format beats need a named role and finite positive seconds |
| silent-with-speech-conflict | structure.source_delivery | script delivery and silent say fields compared with explicit source has_speech |
| invalid-delivery | structure.delivery | delivery must be spoken or silent |
| malformed-beats | structure.beats | beats must be a nonempty list of objects |
| invalid-time-syntax | timing.beat_1 | invalid range; expected start-end seconds |

## Human review required

| Synthetic case | Check | Observation |
| --- | --- | --- |
| clean-spoken | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| clean-spoken | length.source_ratio | shared shown/source word ratio 1.350; word count does not establish delivery duration |
| clean-spoken | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| word-budget-exceeded | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| word-budget-exceeded | length.source_ratio | shared shown/source word ratio 1.350; word count does not establish delivery duration |
| word-budget-exceeded | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| hook-repeated | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| hook-repeated | length.source_ratio | shared shown/source word ratio 1.200; word count does not establish delivery duration |
| hook-repeated | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| overlapping-and-overlong | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| overlapping-and-overlong | length.source_ratio | shared shown/source word ratio 1.350; word count does not establish delivery duration |
| overlapping-and-overlong | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| reversed-timing | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| reversed-timing | length.source_ratio | shared shown/source word ratio 1.350; word count does not establish delivery duration |
| reversed-timing | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| missing-conditions | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| missing-conditions | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| format-malformed | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| format-malformed | length.source_ratio | shared shown/source word ratio 1.350; word count does not establish delivery duration |
| format-malformed | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| split-beat-needs-review | structure.alignment | format and script beat counts differ; split/merged beats may be valid |
| split-beat-needs-review | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| split-beat-needs-review | length.source_ratio | shared shown/source word ratio 1.350; word count does not establish delivery duration |
| split-beat-needs-review | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| obvious-claim-mismatches | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| obvious-claim-mismatches | length.source_ratio | shared shown/source word ratio 1.600; word count does not establish delivery duration |
| obvious-claim-mismatches | claims.token_support | tokens absent from supplied brand text: example.com, 50%, free |
| obvious-claim-mismatches | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| silent-with-speech-conflict | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| silent-with-speech-conflict | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| invalid-time-syntax | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| invalid-time-syntax | length.source_ratio | shared shown/source word ratio 1.350; word count does not establish delivery duration |
| invalid-time-syntax | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| timing-gap | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| timing-gap | timing.gap_2 | gap between beats may be intentional; verify planned continuity |
| timing-gap | length.source_ratio | shared shown/source word ratio 1.350; word count does not establish delivery duration |
| timing-gap | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| silent-clean | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| silent-clean | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |
| qualitative-promises | structure.semantic_roles | role/order fidelity, pacing, voice and suitability require human reading; no semantic score computed |
| qualitative-promises | length.source_ratio | shared shown/source word ratio 1.400; word count does not establish delivery duration |
| qualitative-promises | claims.promise_language | promise/medical language needs substantiation and context: clinically proven, cure, guaranteed |
| qualitative-promises | claims.truth | product/creator claims, implied promises and reference truth require human evidence review; token presence is not proof |

## Missing or unavailable conditions

| Synthetic case | Check | Observation |
| --- | --- | --- |
| reversed-timing | timing.source_duration | source duration or complete valid timing ranges unavailable |
| missing-conditions | length.words | no valid explicit spoken-word budget supplied |
| missing-conditions | structure.source_delivery | source has_speech missing or not boolean |
| missing-conditions | structure.format | format beat skeleton missing |
| missing-conditions | timing.beat_1 | missing range |
| missing-conditions | timing.source_duration | source duration or complete valid timing ranges unavailable |
| missing-conditions | length.source_ratio | source transcript conditions unavailable |
| missing-conditions | claims.reference | no substantive brand reference supplied; absence of evidence is not a truth verdict |
| silent-with-speech-conflict | length.words | silent delivery has no spoken word budget |
| silent-with-speech-conflict | hook.repetition | shared repetition metric is spoken-only |
| silent-with-speech-conflict | length.source_ratio | shared metric requires source speech and at least 15 source words |
| invalid-time-syntax | timing.source_duration | source duration or complete valid timing ranges unavailable |
| silent-clean | length.words | silent delivery has no spoken word budget |
| silent-clean | hook.repetition | shared repetition metric is spoken-only |
| silent-clean | length.source_ratio | shared metric requires source speech and at least 15 source words |

## Provenance and limits

All fixtures are deliberately invented and versioned in pipeline/fixtures/script_quality_synthetic.json. Existing script_checks.py supplies word counting, lexical hook overlap, delivery matching and narrow claim-token matching. Synthetic conditions are test budgets, not Schedule B acceptance criteria.

Every case is synthetic_fixture evidence from the checked-in fixture file, with per-case provenance in JSON output. No inference, production data, network, credentials, or production writes are used. No production prompt or shared check behavior is changed. Private Schedule B and the confidential engineering handoff have not been supplied; continue with the provisional dependency map. No missing milestone acceptance criteria are inferred.
