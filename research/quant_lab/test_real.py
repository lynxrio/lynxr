"""Opt-in offline tests on actual published records, not an artificial catalog.

Tvorogov (2026), doi:10.5281/zenodo.23301344, CC BY 4.0.
Run: python3 -m research.quant_lab.test_real --data-dir <expanded directory>
"""

import argparse
import http.client
import json
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from .analysis import creator_reference, export_bundle, filter_records
from .comparisons import age_band, age_reference, research_report
from .data import SHA256, canonical, load, parse_csv, sha
from .educational import ANNOTATIONS, WORKBOOK_SHA, compact_counter, parse_workbook
from .server import create_server

DATA_DIRECTORY = None


class RealTerminalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if DATA_DIRECTORY is None:
            raise unittest.SkipTest("opt-in: supply --data-dir with the genuine downloaded sources")
        cls.directory = Path(DATA_DIRECTORY)
        cls.source, cls.records = load(cls.directory)
        cls.annotated = [r for r in cls.records if r.get("source_id") == "educational-reels"]
        cls.report = research_report(cls.source, cls.records)
        cls.by_study_id = {r["source_study_id"]: r for r in cls.annotated}

    def test_actual_workbook_digest_and_all_recomputed_rows(self):
        blob = (self.directory / "sources" / "educational-reels.xlsx").read_bytes()
        self.assertEqual(sha(blob), WORKBOOK_SHA)
        self.assertEqual(parse_workbook(blob), self.annotated)
        with self.assertRaises(ValueError):
            parse_workbook(blob + b"changed")

    def test_real_inventory_and_source_separation(self):
        self.assertEqual(len(self.records), 1300)
        self.assertEqual(len({r["id"] for r in self.records}), 1300)
        self.assertEqual(len(filter_records(self.records, {})), 983)
        self.assertEqual(len(filter_records(self.records, {"source": ["educational-reels"]})), 300)
        self.assertEqual(len({r["creator"] for r in self.annotated}), 21)
        with self.assertRaises(ValueError):
            filter_records(self.records, {"source": ["all"]})

    def test_original_real_catalog_is_preserved_exactly(self):
        blob = (self.directory / "sources" / "brightdata-reels.csv").read_bytes()
        self.assertEqual(sha(blob), SHA256)
        original, _audit = parse_csv(blob)
        primary = [r for r in self.records if r.get("source_id") == "brightdata-reels"]
        self.assertEqual(primary, [{**r, "source_id": "brightdata-reels", "publication_precision": "timestamp_utc"} for r in original])

    def test_source_license_attribution_and_no_media_grant(self):
        source = next(s for s in self.source["sources"] if s["source_id"] == "educational-reels")
        self.assertEqual(source["rights"]["license"], "CC BY 4.0")
        self.assertIn("Grigorii Tvorogov", source["attribution"])
        self.assertIn("Changes:", source["attribution"])
        self.assertFalse(source["rights"]["media_fetch_allowed"])
        self.assertNotEqual(source["downloaded_at"], source["repository_published_at"])

    def test_day_precision_never_becomes_exact_observation_clock(self):
        first = self.by_study_id[1]
        self.assertEqual(first["published_at"], "2026-08-01")
        self.assertEqual(first["metric_observed_date"], "2026-09-02")
        self.assertEqual(first["age_calendar_days"], 32)
        self.assertIsNone(first["metric_observed_at"])
        self.assertIsNone(first["metric_collected_at"])
        self.assertIn("timezone_unspecified", first["publication_precision"])
        self.assertEqual(self.report["historical_prediction_eligible_n"], 0)

    def test_author_documented_time_and_counter_conversions(self):
        first = self.by_study_id[1]
        self.assertEqual(first["duration"], 99)
        self.assertEqual(first["annotations"]["hook_duration_seconds"], 7)
        self.assertEqual(self.by_study_id[123]["annotations"]["hook_duration_seconds"], 50)
        self.assertEqual(self.by_study_id[245]["views"], 4800000)
        self.assertEqual(self.by_study_id[245]["counter_text"]["views"], "4.8M")
        self.assertEqual(compact_counter("0"), 0)
        self.assertIsNone(compact_counter(None))

    def test_corrected_workbook_rows_and_source_identity(self):
        self.assertNotEqual(self.by_study_id[103]["id"], self.by_study_id[104]["id"])
        for study_id in (276, 277, 278):
            self.assertEqual(self.by_study_id[study_id]["annotations"]["hook_type"], "None")
        self.assertTrue(all(r["post_id"] is None for r in self.annotated))
        self.assertTrue(all("?" not in r["url"] for r in self.annotated))
        self.assertTrue(all(r["source_rows"][0] == r["source_study_id"] + 2 for r in self.annotated))

    def test_nulls_absence_categories_and_low_counts_retained(self):
        self.assertEqual(sum(r["annotations"]["cta"] == "None" for r in self.annotated), 219)
        self.assertEqual(sum(r["num_comments"] == 0 for r in self.annotated), 18)
        self.assertEqual(sum(r["views"] < 1000 for r in self.annotated), 10)
        self.assertTrue(all(r["likes"] is None and r["video_play_count"] is None for r in self.annotated))
        self.assertTrue(all(r["availability"] == "unknown" for r in self.annotated))
        self.assertIsNone(self.report["missingness"]["unrecorded_skipped_or_deleted_posts"])

    def test_human_annotations_remain_distinct_from_caption_signals(self):
        for row in self.annotated:
            self.assertFalse(row["caption"])
            self.assertEqual(row["cue_evidence"], "not_available")
            self.assertIn("single_human_coder", row["annotation_evidence"])
            for name, column in ANNOTATIONS.items():
                self.assertEqual(row["annotations"][name], row["source_cells"].get(column))
        self.assertEqual(self.report["structure_coverage"]["reveal_timing"], "Not supplied")

    def test_age_references_exclude_target_and_cross_source_rows(self):
        available = 0
        by_id = {r["id"]: r for r in self.records}
        for row in self.annotated:
            ref = age_reference(row, self.records)
            self.assertNotIn(row["id"], ref["other_post_ids"])
            self.assertFalse(ref["historical_baseline_eligible"])
            for identity in ref["other_post_ids"]:
                peer = by_id[identity]
                self.assertEqual(peer["creator"], row["creator"])
                self.assertEqual(peer["source_id"], row["source_id"])
                self.assertEqual(age_band(peer), age_band(row))
            if ref["descriptive_ratio"] is not None:
                available += 1
                self.assertGreaterEqual(ref["other_posts"], 4)
                self.assertAlmostEqual(ref["descriptive_ratio"], row["views"] / ref["other_median_views"])
            else:
                self.assertIsNone(ref["other_median_views"])
            self.assertFalse(creator_reference(row, self.records)["eligible_baseline"])
        self.assertEqual(available, 230)

    def test_six_examples_are_distinct_actual_rows_with_comparable_peers(self):
        examples = self.report["example_pairs"]
        self.assertEqual(len(examples), 3)
        identities = []
        for pair in examples:
            low, high = pair["lower"]["record"], pair["higher"]["record"]
            self.assertLess(low["views"], high["views"])
            self.assertEqual(low["creator"], high["creator"])
            self.assertEqual(age_band(low), age_band(high))
            self.assertIn(low, self.annotated)
            self.assertIn(high, self.annotated)
            identities.extend((low["id"], high["id"]))
        self.assertEqual(len(set(identities)), 6)

    def test_pacing_comparison_shows_account_context(self):
        pace = next(g for g in self.report["structure_comparisons"] if g["field"] == "editing_pace")
        groups = {r["label"]: r for r in pace["groups"]}
        self.assertEqual(pace["within_creator_variation_n"], 8)
        self.assertEqual(groups["Fast"]["n"], 44)
        self.assertEqual(groups["Slow"]["n"], 219)
        self.assertEqual(groups["Fast"]["median_views"], 831500)
        self.assertEqual(groups["Slow"]["median_views"], 31800)
        self.assertAlmostEqual(groups["Fast"]["median_descriptive_ratio"], 1.0106382978723403)
        self.assertAlmostEqual(groups["Slow"]["median_descriptive_ratio"], 0.9833748823450317)

    def test_real_annotation_filters_dates_and_low_sort(self):
        visual = filter_records(self.records, {"source": ["educational-reels"], "hook": ["Visual"]})
        self.assertEqual(len(visual), 203)
        fast = filter_records(self.records, {"source": ["educational-reels"], "pace": ["Fast"]})
        self.assertEqual(len(fast), 44)
        low = filter_records(self.records, {"source": ["educational-reels"], "direction": ["asc"]})
        self.assertEqual(low[0]["views"], 321)
        dated = filter_records(self.records, {"source": ["educational-reels"], "start": ["2026-09-01"], "end": ["2026-09-30"]})
        self.assertTrue(dated)
        self.assertTrue(all("2026-09-01" <= r["published_at"] <= "2026-09-30" for r in dated))

    def test_real_export_determinism_and_no_cross_source_pool(self):
        self.assertEqual(self.report, research_report(self.source, list(reversed(self.records))))
        report = dict(self.report)
        signature = report.pop("result_sha256")
        self.assertEqual(signature, sha(canonical(report).encode()))
        export = export_bundle(self.source, self.records, {"source": ["educational-reels"]})
        self.assertEqual(len(export["records"]), 300)
        self.assertEqual(export["source"]["source_id"], "educational-reels")
        self.assertEqual(export["source"]["rights"]["license"], "CC BY 4.0")
        self.assertEqual(export["schema_version"], 2)
        self.assertTrue(all(r["source_id"] == "educational-reels" for r in export["records"]))

    def test_http_real_research_detail_and_download_with_no_external_fetch(self):
        before = sha((self.directory / "catalog.sqlite").read_bytes())
        server = create_server(self.source, self.records, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def get(path, method="GET", headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            result = response.status, response.read(), dict(response.getheaders())
            connection.close()
            return result
        try:
            with patch("urllib.request.urlopen", side_effect=AssertionError("outbound source access forbidden")):
                status, body, headers = get("/api/research")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), self.report)
                self.assertIn("frame-src 'none'", headers["Content-Security-Policy"])
                self.assertIn("img-src 'none'", headers["Content-Security-Policy"])
                self.assertEqual(body, get("/api/research.json")[1])
                self.assertIn("attachment", get("/api/research.json")[2]["Content-Disposition"])
                overview = json.loads(get("/api/overview")[1])
                self.assertEqual(overview["all_records"]["n"], 1000)
                for pair in self.report["example_pairs"]:
                    for side in ("lower", "higher"):
                        row = pair[side]["record"]
                        detail = json.loads(get("/api/record/" + row["id"])[1])
                        self.assertEqual(detail["record"], row)
                        self.assertEqual(detail["source"]["rights"]["license"], "CC BY 4.0")
                self.assertEqual(get("/api/research?file=/secret")[0], 400)
                self.assertEqual(get("/api/research", "POST")[0], 405)
                self.assertEqual(get("/api/research", headers={"Host": "evil.invalid"})[0], 403)
                self.assertEqual(get("/api/research", headers={"Origin": "https://evil.invalid"})[0], 403)
                self.assertEqual(get("/api/catalog?source=all")[0], 400)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(before, sha((self.directory / "catalog.sqlite").read_bytes()))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    DATA_DIRECTORY = parser.parse_args().data_dir
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RealTerminalTests))
    raise SystemExit(not result.wasSuccessful())
