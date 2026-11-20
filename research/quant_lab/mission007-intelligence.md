# Mission 007 — offline script intelligence increment

## Contract proposed before implementation

This experiment extends PR #15/#13 with PR #14's ledger engine. It does not change production, shared video/script schemas or the existing synthetic evidence contract. Explicit authorized subclasses reuse the append-only engine; real and synthetic files cannot be mixed. No real export or new creator permission has been supplied at the start of this mission. Contract tests are artificial boundary inputs, not real-outcome results. The real demonstration remains the existing licensed Tvorogov annotations and metadata.

An offline JSON export contract is a normalized handoff, **not a claim that every Meta export has this shape**. An owner must map a permitted original export without inventing clocks, native IDs or counter definitions, preserve the original file and supply its digest plus explicit row references. The importer accepts only a separately supplied, currently granted, scope-limited research permission manifest with evidence-file digest and reviewer attestation. This verifies consistency, not legal validity or platform authenticity. No credentials or private directories are discovered.

Reliable timezone-aware publication/observation/collection clocks and native IDs are required for ledger admission. Rows with genuinely unknown clocks are retained in the private original/import artifact and missingness accounting, but never acquire invented measurement ages or enter point-in-time evaluation. Invalid/conflicting identities, clock sequences and definitions reject the import. Repeated measurements append; reimports reject. A local receipt is not independent preregistration.

Current permission is a separate owner-maintained file outside Git. Every authorized workspace read rechecks it, including historical queries; withdrawal suppresses prior values as well. Append-only storage does not override erasure: an owner must stop the server and securely remove the isolated workspace/raw copies/exports when required. Do not serve original permission evidence or raw source documents. Research data stays outside Git and production.

Minimal annotation vocabulary, local to research: hook mechanism and modality; ordered nonoverlapping narrative-role intervals; spoken/visual/mixed delivery; product entry/reveal seconds; perceived pace; explicit CTA. Every field permits unknown. Each annotation records annotator, creation time, source/post identity, permission reference and evidence modality (licensed annotation review, authorized video review or creator-supplied annotation). A licensed-annotation review must not manufacture timecoded visual observations. It can preserve published hook/pace/CTA judgments with attribution. Browser drafts download locally; explicit CLI admission appends immutable annotation artifacts. No browser write endpoint or media fetch is added.

Rule-based signals will disclose their inputs and eligibility, never label an unobserved video promising. Creator references require four other comparable same-definition, age-aligned posts. Velocity needs two real same-definition measurements with increasing observation clocks. Adoption requires known annotation availability and publication clocks; report sampled creator breadth, not platform adoption. Missing/freshness and sample ranges travel with results. No prediction, causal or alpha claim is permitted from retrospective catalog counts. Chronological baseline scoring remains unavailable until qualifying pre-outcome features and independently frozen recommendations exist.

## Setup and export contract

Dependencies: Python 3.11+ standard library; serialized imports currently use `fcntl` on macOS/Linux. This branch combines the **unmerged** PR #15/#13 catalog and PR #14 ledger; keep all drafts unmerged pending review. Existing port 8766 and its catalog are preserved. No new downloader or service dependency exists.

Use private directories **outside every Git checkout**, with owner-only filesystem access. This is local research software, not a multi-user service. The operating-system owner can read/edit files and bypass gates; manifests, local hashes and local clocks are not independent proof. Original consent evidence and source exports remain with their owner, outside Git. Supply only explicitly authorized files; never provide tokens, passwords or bulk account downloads containing credentials.

The importer takes a normalized JSON object with exactly:

| Field | Required meaning |
| --- | --- |
| `contract_version`, `platform` | Integer 1; `instagram` |
| `source_id`, `extraction_version` | Explicit stable source and mapper IDs; never `syn:` |
| `original_sha256` | SHA-256 of the unchanged permitted file passed as `--original` |
| `source_generated_at` | Actual timezone-aware export-generation clock, or null; never a metric observation substitute |
| `rows` | Nonempty metric observations; multiple metrics or captures remain separate rows |

Each row has exactly: `creator_id` and `post_id` (native numeric IDs as strings, not handles); `shortcode`; `published_at`, `observed_at`, `collected_at` (explicit offset-bearing timestamps or null); `metric`; `counter_kind`; `value`; `missingness`; `post_status`; `source_record_id` (immutable capture identity shared by metrics from the same capture); and `row_reference` (original row/sheet or JSON pointer). All supplied clocks must be ordered, nonfuture and not later than a supplied export-generation clock. Equivalent timestamp offsets are normalized for the ledger. Local extraction/availability/receipt clocks are generated **at import**, never supplied as historical knowledge.

`metric` has exactly `definition_id`, `name`, `version`, `unit` (`count`, `seconds`, `ratio`) and `definition` (a substantive explicit string prefixed `SOURCE: `). A definition ID binds source/platform/semantics immutably. Changed semantics need a new definition ID. `counter_kind` is `cumulative_counter`, `interval_value` or `unknown`; velocity is computed only for declared cumulative count metrics, never inferred from a field name. `value` is a nonnegative integer for counts, finite nonnegative number otherwise, or null. Source definitions and nulls are not coerced. Counter decreases are retained, flagged and not repaired.

`missingness`: `observed`, `not_reported`, `hidden`, `unavailable`, `deleted`, `collection_failed`, `permission_denied`. `post_status`: `available`, `unknown`, `private`, `unavailable`, `deleted`. Observed zero is valid. Null requires a reason. Deleted/unavailable markers carry null; latest such state suppresses older usable values in current comparisons. A granted analytics permission does not mean every post or metric is available.

Unknown source clocks retain the **entire original normalized row** in the private import receipt, plus a list of missing clocks. They create no measurement age and enter no ledger query, velocity or normalized outcome. Unknown native identity is rejected: obtain a minimized authorized identity mapping; do not invent IDs. Invalid rows reject the whole batch. An original source file's authenticity, completeness and rights are reviewed by the owner, not proved by matching a hash. No private source file was inspected for this delivery.

The permission JSON has exactly: `version` (1), `grant_id`, `status` (`granted`, `unknown`, `denied`, `withdrawn`), `creator_ids` (explicit authorized IDs), `scopes`, `verified_by`, `verified_at`, `valid_until` (timestamp or null), `withdrawn_at` (timestamp or null), `evidence_ref`, `evidence_sha256`. Allowed scopes: `analytics_research`, `licensed_annotation_review`, `video_annotation`, `supplied_annotation`. The evidence digest must match the explicitly passed evidence file on admission. Reviewer attestation must represent actual scope review. The manifest is **not** an autogenerated creator consent. Expired, withdrawn, unknown or denied permissions block import/read. Current scope narrowing also suppresses prior values. Every configured HTTP request reopens this manifest; no historical cutoff resurrects withdrawn access. Already downloaded browser artifacts cannot be remotely recalled. Apply withdrawal/erasure terms to receipts, ledger, annotations, originals, backups and downloads; stop the server first. Erasure is an explicit owner operation, never an append-only override of rights.

```sh
# Owner supplies all four verified inputs; no sample creator outcome file is bundled.
python3 -m research.quant_lab import-analytics \
  --research-dir /absolute/private/research-workspace \
  --input /absolute/private/normalized-export.json \
  --original /absolute/private/unchanged-authorized-export.csv \
  --permissions /absolute/private/current-permission.json \
  --permission-evidence /absolute/private/reviewed-permission-evidence.txt

# Public licensed-record analysis works without a creator workspace or permissions file.
python3 -m research.quant_lab serve \
  --data-dir /absolute/Lynxr-Quant-Terminal-Data --port 8767
python3 -m research.quant_lab intelligence \
  --data-dir /absolute/Lynxr-Quant-Terminal-Data > /absolute/private/intelligence-report.json

# Optional, explicitly configured creator workspace: add BOTH to serve/intelligence.
# --research-dir /absolute/private/research-workspace --permissions /absolute/private/current-permission.json
```

Do not run `init`/`expand` to process creator exports; those remain the separate public-source download commands. Serving, analysis, import and annotation commands make no external requests.

## Manual annotation workflow and evidence

Open `/intelligence` → select a linked real record → enter reviewer, permission ID and evidence reference → select the evidence actually reviewed → edit the JSON format → download a draft. Defaults are unknown; no caption inference or automatic pseudo-labeling occurs. The taxonomy is displayed beside the editor. A draft is not validated/admitted evidence. Timing is seconds from start, hook needs two boundaries, beats are ordered nonoverlapping intervals; overlap/gaps in creative storytelling can be described in a later reviewed taxonomy rather than forced into this minimal skeleton. Product entry means first identifiable product appearance/mention; reveal means the intended withheld information becomes explicit; uncertain boundaries remain null. Spoken means speech is present; visual means explicitly no speech; mixed means a multimodal presentation and does not, by itself, determine speech presence for script checks. Pace is subjective, not an objective cut rate. CTA none and unknown are distinct. This initial codebook has no demonstrated independent rater reliability.

```sh
python3 -m research.quant_lab annotate \
  --data-dir /absolute/Lynxr-Quant-Terminal-Data \
  --research-dir /absolute/private/research-workspace \
  --input /absolute/private/lynxr-annotation-draft.json \
  --permissions /absolute/private/current-permission.json \
  --permission-evidence /absolute/private/reviewed-permission-evidence.txt
```

The referenced source/post/creator must already exist in the licensed catalog or authorized workspace. Published-study identities use `study:<handle>` and study shortcodes, **not invented native IDs**. These cannot enter the native-identity analytics ledger. Licensed-annotation review is allowed only for the separately attributed educational source; source global categories cannot become new audio/visual/timing claims. Such drafts may review hook/pace/CTA categories, leaving beats, delivery, modalities, reveal and product entry unknown. Licensed footage/video review and creator-supplied timecoded annotations require their own scope. No media is fetched, embedded or downloaded. Revisions append separately with annotator/creation/local-recording times and hashes; exact reimport rejects. No rater is silently replaced, and conflicts remain separate artifacts. There is no adjudicated consensus or schema-to-video accuracy claim.

## Signals and evaluation boundaries

The licensed-source review queue uses this frozen transparent rule: labels with ≥20 comparable posts and ≥5 creator clusters first, then creator breadth, eligible reference count and lexical label. These are operational **inspection** thresholds, not accepted milestone criteria or success thresholds. They select where evidence is broad enough to inspect; they do not recommend a hook as causally effective or likely to go viral. Same-account reference ratios reuse the existing four-other-post, source-separated coarse-age method. Report post counts, clusters, definition/provenance, missingness and exact-clock unavailability. Five-hundred fixed-seed creator-cluster resamples supply exploratory percentile **stability ranges**, not population-confidence guarantees in this purposive sample. Constant creator traits, topics, age bands, selection and one-coder judgments remain confounded.

Publication-week label counts describe the retained posts at a later annotation snapshot. They are **not changes in observed platform adoption**: there are no complete repeated listing snapshots or annotation-availability histories. The report explicitly returns adoption-change and early-velocity fields unavailable for this source. Sampling breadth means sampled creators, never all Instagram creators.

Authorized exports, when supplied, produce definition-separated outcomes near a declared 48h target (±1h), one nearest-window measurement/post, at least four other same-creator/definition/window peers, actual ages, null/zero accounting and observation ranges. These are contemporaneous descriptive references, not pre-cutoff baseline predictions. Early velocity needs two real increasing source observation clocks, a declared cumulative count definition and an end age ≤48h; preserve negative differences as possible counter corrections. No interpolation or invented fixed-age counts. Sparse peers/zero medians stay unavailable. Until supplied, the interface explicitly reports **no creator export connected**.

`evaluation.py` reuses the pure `pipeline.script_checks` primitives underlying PR #10 and exports partial format/source review inputs from explicit annotation fields. It does not run `eval_scripts.py` or PR #10's synthetic wrapper (which hardcodes synthetic evidence), and it never converts absent transcripts/brand facts into scoreable inputs. No paired real generated script was supplied; no real script-quality score is claimed. `chronological_annotation_inputs` admits only annotations created AND locally recorded before an exclusive cutoff and checks current rights. PR #12's scorer remains synthetic-only and is not bypassed or relabeled. No frozen recommendation receipt/future-outcome join exists, so baseline-comparison status is explicitly **not evaluable**, rather than a retrospective accuracy number. A future real scorer must separately review the contract, independent timestamping and strictly prior creator references before comparing predeclared frequency/recency strategies. Nothing touches live generation.

## Measured delivery and verification

The delivered local interface is `http://127.0.0.1:8767/intelligence`, served from this isolated branch using the existing authorized public-source catalog. PR #15's port 8766 and its original files remain untouched. The reproducible public-data analysis covers **300 actual annotated posts / 21 accounts**. For example, the source's Visual hook label covers **203 posts / 19 accounts**; **160 posts** have an eligible descriptive reference. Its median ratio is **0.987×**, with a fixed-seed exploratory creator-cluster stability range **0.936–1.026×**. This does not establish that a visual hook causes reach or predicts new outcomes. Rare labels return no stability interval. Exact observation clocks, early velocity and historical adoption changes remain unavailable for this source.

One actual browser draft was downloaded and admitted through the CLI for source shortcode `DbllerKIv2t` (study Video ID 3): published Question/Visual hook, Slow pace, CTA None. The reviewer is explicitly recorded as an **attributed source-label review, not independent video annotation**. Beat timing, delivery, modalities, reveal and product entry remain null. The permission manifest is licensed-annotation-only, backed by the existing public Zenodo CC BY 4.0 metadata; it grants no creator analytics or video-processing scope. The UI subsequently displayed one permitted annotation artifact and **no creator analytics export connected**. The artifact, permission manifest, report and screenshots are outside Git. This is workflow evidence, not new visual ground truth or a real creator-outcome import.

No separately verified creator analytics export arrived for this delivery. The adapter was tested against explicitly artificial boundary inputs following the documented contract; **zero genuine creator analytics exports or private outcomes were processed**. The public dataset was not inserted into the native-ID observation ledger. The next real-outcome action is the owner's supply of a minimized, scoped creator export, unchanged original file and reviewed permission evidence. A current reading is not retroactively available in January 2025.

Checks on Python 3.12:

- New suite: **17 pass** (15 offline contract/evaluation tests + two opt-in checks on the actual licensed dataset/HTTP interface). No network allowed during local import/analysis tests; HTTP checks use loopback only. Checks include identity/definition conflicts, duplicates/repeated counts, clocks/late arrival, null/zero/deleted data, current scope/withdrawal, source digests, annotation modality/timing, age-window peer counts, cumulative-only velocity and partial script-check projection. Artificial boundary inputs are never presented as research results.
- Combined default research regression: **64 pass, two real-data checks intentionally skipped**, plus 44 subtest checks; opt-in real checks above run separately. Existing expanded-catalog real-data suite: **15 pass**. All **28 original ledger tests** and **21 original catalog tests** remain in the combined regression.
- Existing explicit repository offline gate: **32/32 scripts pass**, using cached ffmpeg/ffprobe on PATH for existing media-limit/canary tests. No video from the dataset is processed. The gate now includes the new default contract tests through its existing Quant Lab wrapper.
- Focused Ruff and JavaScript syntax pass; web cache-stamp check passes across 127 pages. Full-repository Ruff still reports **928 existing findings**; no unrelated cleanup performed. Website/agency/branding CSS and production services are untouched.
- Browser → local API → real catalog → displayed coverage/ranges verified. Source selection, blank-by-default format editor, download → CLI admission → newly visible artifact count passed; browser warning/error logs were empty. Browser writer requests remain unavailable. Screenshots demonstrate the actual interface with no copied video frames.

For reruns:

```sh
python3 -m research.quant_lab.test_intelligence --real-data-dir /absolute/Lynxr-Quant-Terminal-Data
python3 -m unittest research.quant_lab.test_lab research.observation_ledger.test_ledger
python3 -m research.quant_lab.test_real --data-dir /absolute/Lynxr-Quant-Terminal-Data
python3 tools/fixer/run_tests.py
```

With a real workspace, save its emitted exclusive cutoff and pass `--cutoff <same-offset-aware-instant>` to `intelligence` to reproduce its recorded information set. A source row imported later remains excluded even if its observation is older. Current rights can still suppress a formerly permitted result; reproducibility does not defeat withdrawal. Source counters/ages are preserved in the ledger; observation ranges, age ranges, latest-observation lag, definitions, source/evidence references and artifact digests travel with private workspace analyses. Pending rows report both missing source clocks and value-missingness reasons. Permission-denied measurement attempts may retain null markers under a currently granted research permission; denied source access is never converted to zero or bypassed.

Known limits: this is an initial normalized-contract adapter, not a universal Meta CSV mapper or proof of authenticity. Permission decisions rely on owner review. No export-specific mapping, native alias resolution, correction/adjudication workflow, independently blinded annotations, media rights, complete creator sampling ledger or frozen prospective recommendations were supplied. Local files are owner-controlled rather than WORM, independently timestamped or encrypted by this app. Browser artifacts need owner erasure handling. No production predictor, live script-generation change, production/private data access, paid service, merge or deployment was used.
