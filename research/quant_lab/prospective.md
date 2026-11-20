# From sample exploration to frozen prospective predictions

This is a proposed protocol, not a deployed collector or milestone acceptance specification. The current sample supports descriptive evaluation only. Do not continue the January 2025 reconstruction or relabel its missing clocks.

## Media and format analysis

The sample contains captions, hashtags, duration, source content type and media links. It does **not** provide licensed shot annotations, beat sequences, transcripts, opening-hook structure, pacing, reveal timing or product-entry annotations. Duration bins and caption cues in Quant Lab do not establish those properties.

Already authorized metadata can support the current caption-only/mechanical features. No media in this sample has an established grant for local copying, frame extraction, transcription, training or redistribution. That is the specific blocker to automated multimodal work; no video/audio/thumbnail file has been downloaded into the lab.

Next bounded multimodal experiment, after explicit rights verification:

1. Obtain five creator-owned/licensed clips or separately licensed annotations, with exact scope for local viewing, derivative frames/transcripts, research processing, retention and any onward model transfer. Permission for a source link or metadata is insufficient for all these uses. Keep an asset/permission ledger; do not put assets in the public repo.
2. Freeze a structural annotation schema before seeing outcomes: hook category, ordered beat roles, delivery, pacing, product entry, reveal and CTA timing, niche/audience, plus unknown/conflicting judgments. Use two annotators blinded to counters; report agreement and disagreements rather than assume a valid similarity threshold.
3. Benchmark local ffmpeg frame sampling/scene changes, optional OCR and speech recognition on those five clips. Check tool/model-weight licenses and explicitly authorize any weight downloads. CPU may suffice for a small pilot; measure elapsed time, memory and disk before deciding whether a local GPU is needed. No cloud compute or paid inference is authorized by this plan.
4. Reuse isolated extraction logic where appropriate, but do not run the existing whole pipeline: `pipeline/analyze_visuals.py` downloads video and calls a paid vision model; `pipeline/retag_with_audio.py` calls a paid model; `pipeline/transcribe.py` downloads audio and may fetch local model weights. These modules were reviewed as source only. No keys or workers were used.
5. If a paid multimodal provider is later proposed, obtain an explicit budget, allowed data destination, retention policy and processing permission before any call. Store inferred annotations separately from provider metrics, with asset digest, model/version, extraction time and input availability. A later feature is not evidence of what was available at a historical cutoff.

## A concrete prospective pilot

Use one platform and a fixed, consenting creator panel selected before test outcomes. An operational pilot could start with five creators; it is not a statistically powered accuracy study. Record native creator/video IDs privately, rather than relying on mutable handles. Predefine listing coverage and retain lawful missing/deleted/unavailable entries; honor withdrawal/erasure requirements with allowed non-identifying attrition accounting.

**Access route:** first-party creator analytics exports or a separately reviewed official API integration. Meta's [Insights overview](https://developers.facebook.com/docs/insights/overview/) requires app registration and user-granted permissions; advanced access can require business verification. Verify current account eligibility, scopes, metric definitions, version and limits before implementation. An existing production connection or key is not research permission. No scraping/proxy fallback, paid Bright Data account or private creator access is proposed under the sample download.

**Lead-in:** collect a proposed four-week baseline census, extending or reporting sparsity according to a rule frozen before test outcomes. Target at least five prior age-comparable posts per creator, consistent with the existing four-OTHER-post baseline minimum. A creator who posts less remains a sparse-baseline case; do not drop creators based on later success or completeness. Record both original measurement time and availability time, run ID and failed/hidden counter reasons.

**Measurement rule:** propose 48h ±60 minutes after publication, chosen for scheduling feasibility, identical for baseline and test posts. Freeze the tolerance and earliest-valid-snapshot rule before collecting outcomes. Store actual age in seconds and counter semantics; do not use floored day or replace a missed reading with a lifetime count. This tolerance is a proposal; PR #12's scaffold currently enforces exact 48h and would need a reviewed adapter/change for real observations. Likes, plays and views remain distinct; optional metrics must not silently change the primary outcome.

**Freeze at T:** before any candidate in [T,T+48h) publishes, write an immutable private prediction receipt containing roster, cutoff, eligible input/source hashes, baseline definition, feature/annotation versions, format catalog, matching rules, K, seed, baseline/random selections, exploratory recommendations and exclusions. An independently timestamped receipt in an existing approved access-controlled system is needed; a local hash alone does not prove precedence. No new paid timestamping service is required. Do not train a model on this test window.

**Follow-up:** census all panel posts in the window and measure them at the frozen age. The latest posts mature around T+96h. Freeze a close/grace deadline; record delayed/missing outcomes and non-posting creators explicitly. A recommendation without observed adoption stays unresolved. Annotate matching before seeing engagement where possible, using the frozen rules and supplied-duplicate identities.

**Analysis:** baseline each future post against only eligible same-creator, same-platform observations available before T. Report views/baseline and smoothed log-relative views, explicit missing denominators, under/typical/outperforming/breakout exploratory bands and simple strategy comparisons. No absolute-view failure labels. Retain unknown/zero baselines. Use creator-aware uncertainty only with enough independent clusters; shared formats require sensitivity or multiway treatment. No causal lift claim without a separately designed intervention.

**Validation:** use disjoint publication windows, keep duplicate content out of independent evaluation, freeze choices before a final chronological holdout and add creator-held-out sensitivity. Size a later accuracy experiment from actual pilot variance/attrition and a specified estimand, not from this public sample's quartile differences.

## Mission 006 next action

The ledger prototype in PR #14 is sufficient; do not build more synthetic infrastructure as a prerequisite. Mission 006 now imports a CC BY 4.0 human-coded dataset with 300 actual Reels and repeated accounts. Its licensed annotations support structural exploration without copying video. Exact observation times and research-scoped creator analytics access remain unavailable.

The next operational action is one creator-authorized current analytics reading, preserved with actual source/receipt times and source definitions, followed by a frozen listing rule and scheduled 48h ±60min future readings for every eligible post. This can start manually without credentials or an API connector. No reading has been collected from a consenting private creator in this mission because no such scoped export or permission was supplied. The detailed sequence and access dependencies are in [Mission 006](mission006.md#first-prospective-measurements). Do not replace this action with another feasibility-only project or interpret public-sample rankings as forecasting accuracy.
