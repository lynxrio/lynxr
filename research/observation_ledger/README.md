# Mission 005: offline synthetic observation ledger

An independent standard-library Python 3.11+ module. No dashboard, network client, Supabase import, public sample, credentials, model or real-data adapter. This contract is experiment-local and does not modify shared schemas. All identifiers and evidence references must use a `syn:` namespace; every import and row must declare `synthetic_fixture`. These declarations prevent accidental imports, not deliberate relabeling of real data.

## Contract and temporal semantics

Typed frozen dataclasses are the schema; JSON import rejects missing/extra fields and duplicate object keys. Source times have timezone offsets and millisecond-or-coarser precision, normalized to fixed-width UTC. Reject unsupported finer precision rather than round a measurement. Measurement age is an exact nonnegative integer **milliseconds**, computed from observation minus publication.

| Record fields | Meaning / validation |
| --- | --- |
| `schema_version`, `evidence_type`, `observation_id` | Version 1, synthetic only, immutable unique observation identity |
| `platform`, `creator_id`, `post_id`, `published_at` | Platform + native-style synthetic post binds one immutable creator and publication time; handles/URLs are not identifiers |
| `observed_at`, `collected_at`, `extracted_at`, `available_at`, `measurement_age_ms` | Publication ≤ metric observation ≤ source collection ≤ extraction ≤ analyst availability; all required even for a failed measurement attempt |
| `metric` | Immutable definition ID, name, version, unit and explicit synthetic definition; count is an integer, seconds/ratio finite nonnegative numbers; no silent coercion |
| `value`, `missingness`, `post_status` | Null requires an explicit missing reason; zero is observed. Deleted/private/unavailable records carry null, never synthetic failure values |
| `source` | Synthetic source ID, original capture/row ID, artifact ID, evidence reference and invented-fixture method; missing provenance rejects the batch |
| `permission` | Synthetic-only purpose, granted/denied/unknown/withdrawn status, evidence reference and availability time. A denied/unknown/withdrawn permission can preserve a null marker, never a usable value |
| `extraction_version`, `analysis_version` | Explicit versions; extraction and permission knowledge must precede row availability |
| Ledger metadata | Sequence, actual local recording time, original canonical artifact digest, previous-entry hash and entry hash; import cannot supply its recording time |

An envelope contains version/evidence declaration, artifact ID, SHA-256 of the **canonical observations array** and that array. The digest is verified; original canonical payload and normalized typed rows are both preserved. It is a content-integrity check, not proof of authentic external provenance. The adapter design is in [adapter.md](adapter.md).

Definition IDs are global immutable bindings to platform, source, name, version, unit and semantics. A change requires a new ID. Every query selects one definition explicitly. Do not infer an equivalence between versions or select whichever later counter is most favorable.

## Append-only storage

SQLite is a local synthetic research store, not another production database. Creation is exclusive and refuses an existing path or any directory under Git. Import uses one `BEGIN IMMEDIATE` transaction; any error rolls back the artifact, identities, definitions and every observation. No upsert/replace/update API exists. Update/delete triggers protect every ledger table. Before-insert duplicate guards also reject SQL `OR REPLACE`, including with SQLite recursive delete triggers disabled. Re-importing an artifact, observation ID, source capture/definition or identical post/source/definition/observation/collection snapshot is an error, even if given a new import ID. Later measurements remain separate rows, including lower or unchanged counts.

A post cannot change creator or publication timestamp. Source capture IDs cannot be reassigned to another post or capture clock. Corrections and ambiguous aliases must be reviewed outside v1; this module will not rewrite them. Sequential hashes and original-artifact/row checks detect accidental changes. SQLite owners can remove triggers and rewrite/recompute the whole file: this is **not** WORM storage, an independent timestamp, a signature or a protection against a malicious administrator.

## Point-in-time reads

Cutoffs are **exclusive**. Default `recorded` queries require source availability AND local recording time before cutoff; all publication/measurement/collection/extraction/permission clocks are also checked. A row unavailable at cutoff cannot become eligible because its post was published earlier. Reads verify ledger integrity inside one SQLite read snapshot and sort by source clocks and ID, not import order.

Explicit `availability_simulation` mode ignores only local recording time. It reconstructs an **invented source-information set**, not evidence the system recorded a prediction in 2025. The bundled walk-forward example uses this label prominently; default recorded queries at those past dates return no rows. Recording times are local wall-clock receipts, not independent proof of commit availability; real prospective experiments still need a frozen, independently timestamped prediction receipt.

`latest` selects the latest observed/captured row **after** temporal filtering, separately per post and the selected definition. Default queries return all qualifying repeated observations. A later deletion/withdrawal marker can become the latest state without erasing earlier rows; it cannot change an earlier cutoff result. Optional exact-age filtering is in milliseconds. Null/missing/denied rows remain visible in accounting and are never zero-filled or assigned success/failure.

## Run (synthetic only)

```sh
python3 -m research.observation_ledger example
python3 -m research.observation_ledger create --ledger "$HOME/Lynxr-Ledger-Synthetic/observations.sqlite"
python3 -m research.observation_ledger import --ledger "$HOME/Lynxr-Ledger-Synthetic/observations.sqlite" --input research/observation_ledger/fixtures/walk_forward.json
python3 -m research.observation_ledger query --ledger "$HOME/Lynxr-Ledger-Synthetic/observations.sqlite" --definition syn:views-v1 --cutoff 2025-01-12T00:00:00Z --knowledge availability_simulation --age-ms 172800000
python3 -m research.observation_ledger verify --ledger "$HOME/Lynxr-Ledger-Synthetic/observations.sqlite"
python3 -m unittest research.observation_ledger.test_ledger
```

No network or dependency installation is needed. The example creates a temporary ledger, imports only bundled invented observations and prints deterministic source-as-of summaries for January 5/12/19. Its source digest and checked-in output are reproducible; actual local recording receipts are deliberately excluded from that simulated report. No accuracy, causal effect, real historical observation or prediction model is evaluated.

Permissions are recorded historical observations, not perpetual legal authorization. A future real adapter needs a separate current-access/withdrawal/erasure policy; append-only synthetic storage cannot override deletion requirements. Real data is intentionally rejected, and connecting an adapter requires separate review and authorization.

## Verification and limits

The checked-in [example-output.json](example-output.json) contains nine invented observations, not a real-data evaluation. At the January 5/12/19 exclusive cutoffs, the `views-v1` 48-hour source-availability simulation returns 1/4/5 rows respectively; default recorded mode returns zero at every one of those past cutoffs. These include missing/denied rows, not just usable outcomes. The incompatible `views-v2` counter is queried separately. This demonstrates an expanding information set; it trains no model and scores no predictions.

Verification on Python 3.12:

- `uv run --offline --no-project --python 3.12 --with pytest pytest -q research/observation_ledger/test_ledger.py`: 28 tests, covering leakage/late arrival, exclusive cutoffs, exact measurement ages, determinism, identity/definition conflicts, null/deleted/unavailable/denied observations, duplicate captures, transaction rollback, concurrent writers, corruption and SQL replacement rejection.
- The example runs in an isolated subprocess with an empty credential environment, network connections blocked and production/provider/Quant Lab imports rejected. No production or sample data is needed. This is a regression check, not an operating-system network sandbox.
- Focused Ruff check of the new module and test wrapper passes. Repository-wide Ruff reports 928 pre-existing findings, including two in the existing runner; these are outside this increment.
- The repository's explicit offline runner passes 31/31 scripts (30 existing plus the new ledger wrapper). Cached test dependencies and local ffmpeg/ffprobe are required by existing pipeline tests, not by the ledger. The web cache-stamp check passes; no web assets change.

Reads and appends verify the entire file, so this is intended for small offline experiments, not large-scale analytics. There is no connected export adapter, correction/identity-remapping workflow, signed timestamp, prediction-freeze registry, outcome join or automated permission revocation system. Unknown counter IDs reject rather than choosing an implicit definition. Current erasure policy, authorized source evidence and independently timestamped frozen predictions remain prerequisites for real prospective experiments. The module does not validate an export's truth merely because its declared schema passes.
