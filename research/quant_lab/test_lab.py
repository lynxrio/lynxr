"""Artificial unit fixtures only. Real-data verification is a separate opt-in CLI."""

import copy
import csv
import http.client
import io
import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from .analysis import creator_reference, export_bundle, filter_records, summarize
from .data import (
    canonical,
    clock,
    load,
    normalize,
    number,
    original_url,
    parse_csv,
    sha,
)
from .server import create_server, csv_export


def raw(code="fixture0001", **kwargs):
    return {"post_id": code, "shortcode": code, "url": f"https://www.instagram.com/reel/{code}/",
            "user_posted": "invented_creator", "views": "100", "likes": "10", "num_comments": "2",
            "video_play_count": "200", "length": "14", "date_posted": "2025-01-01T00:00:00Z",
            "product_type": "clips", "description": "Invented tutorial caption: how to test", "hashtags": '[]', **kwargs}


class LabTests(unittest.TestCase):
    def setUp(self):
        self.records = [normalize(raw(), 2), normalize(raw("fixture0002", views="10", likes="-1"), 3),
                        normalize(raw("fixture0003", product_type="feed", views="0"), 4),
                        normalize(raw("fixture0004", views="1000", user_posted="invented_other"), 5)]
        self.source = {"evidence_type": "artificial_unit_fixture", "sha256": "unit-only"}

    def test_negative_sentinels_are_unknown_not_zero(self):
        r = self.records[1]
        self.assertIsNone(r["likes"])
        self.assertIsNone(r["engagement_per_view"])
        self.assertIn("likes", r["quality"])

    def test_numeric_edges(self):
        for value in (None, "", "nan", "inf", "-1", True, 2**55, "words"):
            self.assertIsNone(number(value, True))
        self.assertEqual(number("0", True), 0)
        self.assertIsNone(number("1.5", True))

    def test_publication_is_not_observation_or_download(self):
        self.assertIsNotNone(self.records[0]["published_at"])
        self.assertIsNone(self.records[0]["metric_observed_at"])
        self.assertEqual(summarize(self.records)["historical_eligible_observations"], 0)
        self.assertIsNone(clock("2025-01-01"))

    def test_url_identity_and_host_allowlist(self):
        for url in ("javascript:alert(1)", "https://www.instagram.com.evil.test/reel/fixture0001/",
                    "https://user@www.instagram.com/reel/fixture0001/", "http://www.instagram.com/reel/fixture0001/",
                    "https://www.instagram.com/reel/anotherid/", "https://www.instagram.com:443/reel/fixture0001/"):
            with self.assertRaises(ValueError):
                original_url(url, "fixture0001")
        self.assertEqual(original_url(self.records[0]["url"].rstrip("/"), "fixture0001"), self.records[0]["url"].rstrip("/"))

    def test_missing_age_blocks_baselines_even_with_many_posts(self):
        reference = creator_reference(self.records[0], self.records * 5)
        self.assertFalse(reference["eligible_baseline"])
        self.assertTrue(reference["minimum_count_met"])
        self.assertIsNone(reference["normalized_outcome"])

    def test_zero_count_is_retained_but_not_a_relative_failure(self):
        self.assertEqual(self.records[2]["views"], 0)
        self.assertEqual(len(filter_records(self.records, {"type": ["all"]})), 4)
        self.assertEqual(summarize(self.records)["availability"], {"unknown": 4})

    def test_default_catalog_reels_only_with_other_rows_preserved(self):
        self.assertEqual(len(filter_records(self.records, {})), 3)
        self.assertEqual(len(self.records), 4)

    def test_search_creator_and_date_filters(self):
        self.assertEqual(len(filter_records(self.records, {"creator": ["@invented_other"]})), 1)
        self.assertEqual(len(filter_records(self.records, {"q": ["TUTORIAL"]})), 3)
        self.assertEqual(len(filter_records(self.records, {"start": ["2025-01-02"]})), 0)
        self.assertEqual(len(filter_records(self.records, {"end": ["2025-01-01"]})), 3)

    def test_unsupported_and_conflicting_filters_rejected(self):
        for q in ({"sort": ["arbitrary_sql"]}, {"q": ["a", "b"]}, {"file": ["/etc/passwd"]},
                  {"start": ["2025-01-02"], "end": ["2025-01-01"]}, {"start": ["not-date"]}):
            with self.assertRaises(ValueError):
                filter_records(self.records, q)

    def test_sort_unknown_last_in_both_directions(self):
        for direction in ("asc", "desc"):
            rows = filter_records(self.records, {"sort": ["likes"], "direction": [direction]})
            self.assertIsNone(rows[-1]["likes"])

    def test_caption_cue_is_labeled_inferred_not_structure(self):
        self.assertEqual(self.records[0]["caption_cue"], "How-to wording")
        self.assertIn("not_video_structure", self.records[0]["cue_evidence"])

    def test_views_and_plays_never_coalesced(self):
        self.assertEqual(self.records[0]["views"], 100)
        self.assertEqual(self.records[0]["video_play_count"], 200)

    def test_no_media_urls_or_comment_bodies_in_projection(self):
        r = normalize(raw(video_url="https://example.invalid/movie", top_comments="private text", thumbnail="image"), 2)
        self.assertTrue(r["thumbnail_supplied"])
        self.assertNotIn("video_url", r)
        self.assertNotIn("top_comments", r)

    def test_export_is_deterministic_and_has_provenance(self):
        a = export_bundle(self.source, self.records, {})
        self.assertEqual(a, export_bundle(self.source, list(reversed(self.records)), {}))
        self.assertEqual(a["source"], self.source)
        digest = a.pop("result_sha256")
        self.assertEqual(digest, sha(canonical(a).encode()))

    def test_export_keeps_all_filtered_rows_not_one_page(self):
        a = export_bundle(self.source, self.records, {"page": ["9"]})
        self.assertEqual(len(a["records"]), 3)
        self.assertNotIn("page", a["filters"])

    def test_csv_spreadsheet_formula_neutralization(self):
        row = copy.deepcopy(self.records[0])
        row["creator"] = "  =1+1"
        exported = list(csv.DictReader(io.StringIO(csv_export([row]).decode("utf-8-sig"))))
        self.assertEqual(exported[0]["creator"], "'  =1+1")
        self.assertEqual(exported[0]["metric_observed_at"], "")

    def test_duplicate_source_rows_quarantined_not_double_counted(self):
        rows = [raw(), raw()]
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
        records, audit = parse_csv(stream.getvalue().encode())
        self.assertEqual(records, [])
        self.assertEqual(audit["raw_rows"], 2)
        self.assertEqual(audit["quarantined_rows"], 2)

    def test_storage_reads_sqlite_without_creating_missing_database(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(sqlite3.OperationalError):
                load(directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_cli_missing_database_gives_initialization_guidance(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, "-m", "research.quant_lab", "report", "--data-dir", directory],
                                    capture_output=True, text=True, check=False, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertIn("Initialize", result.stderr)
            self.assertNotIn("Traceback", result.stderr)

    def test_ingestion_refuses_git_checkout(self):
        from .data import initialize
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / ".git").mkdir()
            with self.assertRaisesRegex(ValueError, "outside"):
                initialize(Path(directory) / "data")

    def test_http_boundaries_and_export_roundtrip_without_external_access(self):
        server = create_server(self.source, self.records, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def get(path, method="GET", headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            result = response.status, response.read(), dict(response.getheaders())
            connection.close()
            return result
        try:
            with patch("urllib.request.urlopen", side_effect=AssertionError("external fetch forbidden")):
                status, body, headers = get("/api/catalog")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)["total"], 3)
                self.assertIn("img-src 'none'", headers["Content-Security-Policy"])
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(get("/api/export.json")[1], get("/api/export.json")[1])
                self.assertEqual(get("/api/record/fixture0001")[0], 200)
                self.assertEqual(get("/api/catalog", "POST")[0], 405)
                self.assertEqual(get("/api/catalog?sort=bad")[0], 400)
                self.assertEqual(get("/api/catalog?%20path=/secret")[0], 400)
                self.assertEqual(get("/../data.csv")[0], 404)
                self.assertEqual(get("/api/catalog", headers={"Host": "evil.invalid"})[0], 403)
                self.assertEqual(get("/api/catalog", headers={"Origin": "https://evil.invalid"})[0], 403)
                self.assertEqual(get("/api/catalog", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
