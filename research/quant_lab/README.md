# Lynxr Quant Lab

Independent, loopback-only research catalog. Python 3.11+, standard library, SQLite and browser JavaScript. No Supabase, production-service imports, model calls, account signup or paid services. Data lives outside Git. This is an internal sample-evaluation proof of concept. It reuses the pure `pipeline.hook_views.MIN_OTHERS` constant without calling that module's production readers.

## Source and rights decision

The [Bright Data Reels sample](https://github.com/luminati-io/Instagram-Reels-dataset-samples) has no LICENSE/SPDX grant. Public GitHub visibility is not an open-data license. The provider's [sample-use policy](https://brightdata.com/products/datasets/samples) explicitly offers testing, exploration and proof-of-concept use, including integration/model testing. That is the basis for this limited local evaluation, reviewed 2026-11-20; it is not a perpetual or unrestricted license. The [service agreement](https://brightdata.com/license) also restricts competitive redistribution and preserves third-party rights. No account or paid-service agreement is signed by this tool.

Do not commit or redistribute the sample, captions, record exports, screenshots containing records, or media. Local exports remain evaluation artifacts. Production/commercial deployment, dataset redistribution and any broader use need a separate rights review. Thumbnail/video/audio rights are unestablished: the app makes **zero media requests**, embeds no player and offers original Instagram links only. This blocks visual previews and automated multimodal analysis, not metadata exploration. Provider policy URLs and review date travel with every export; recheck them before a new use.

## Local contract (before implementation)

- One commit-pinned CSV, size-bounded and SHA-256 verified; no general URL fetcher. Actual downloaded records, not README counts, determine inventory. Keep raw bytes and a provenance receipt outside the repository.
- SQLite holds a minimized projection: native IDs/shortcode, creator, original URL, publication time, counters, duration, product type, limited caption/hashtags and explicit null/quality flags. No comment text, profile images or media URLs are needed by the interface. Original counters survive in the private raw file; negative sentinels become unknown, never zero.
- Distinguish provider observation/collection time (unavailable), Git publication bound, local download time and local ingestion time. Never backdate a counter. Live/deleted/private status is unknown unless actually supplied; opening a source does not silently update the research snapshot.
- Default catalog is `product_type=clips`; retain other product types in the source inventory and allow explicit browsing. Do not silently discard unsuccessful or unavailable records. The supplied sample's listing frame, inclusion probabilities and deletion coverage are unknown.
- Creator baselines require same-platform, same-age, pre-cutoff observations and enough OTHER posts, following the existing `pipeline/hook_views.py` minimum. Unknown ages block normalized performance. A sample median can be displayed as a descriptive reference, clearly separate from an eligible baseline.
- Duration buckets are mechanical metadata. Caption cues are explicitly inferred text features, not video structure, hook quality or multimodal annotations. Group medians/quartiles are descriptive sample associations, not predictions or causal effects.
- Server reads the local SQLite database, binds only 127.0.0.1, rejects foreign Host/Origin and offers GET-only catalog/detail/export routes. No remote fetch, database write or file-path endpoint. Dynamic text uses textContent, URLs are allowlisted and CSV exports neutralize spreadsheet formulas. Standalone assets use no-store; website CSS/assets/cache stamps are untouched.

## Run

```sh
python3 -m research.quant_lab init --data-dir "$HOME/Lynxr-Quant-Lab-Data"
python3 -m research.quant_lab serve --data-dir "$HOME/Lynxr-Quant-Lab-Data" --port 8765
```

Open `http://127.0.0.1:8765`. Initialization downloads only the pinned public CSV (no credentials); serving and analysis require no external network. Repeated initialization verifies the existing file rather than refreshing Instagram. Use the data-dir chosen at initialization in all commands. A local database is mandatory; there is no synthetic/demo fallback.

```sh
python3 -m research.quant_lab report --data-dir "$HOME/Lynxr-Quant-Lab-Data"
python3 -m unittest research.quant_lab.test_lab
python3 -m research.quant_lab verify --data-dir "$HOME/Lynxr-Quant-Lab-Data"
```

`verify` is the opt-in real-data regression: it checks the downloaded digest, actual inventory and reproducible analysis without network. Default tests use explicitly artificial unit records, never as catalog content. See `findings.md` for measured inventory, comparisons, verification and limitations, and `prospective.md` for the proposed next experiment.
