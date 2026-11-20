"""Offline boundary tests. Artificial contract inputs are never research results."""

import copy
import hashlib
import json
import socket
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from research.observation_ledger.schema import ValidationError
from research.observation_ledger.store import Ledger

from .authorized import ExportLedger, import_export, now, prepare_export
from .formats import draft, import_annotation, validate_annotation
from .intelligence import report, workspace_snapshot
from .server import create_server


class IntelligenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lynxr-contract-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.evidence = self.root / "permission.txt"
        self.evidence.write_bytes(b"ARTIFICIAL TEST CONSENT, NOT A REAL CREATOR PERMISSION")
        self.original = self.root / "original.json"
        self.original.write_bytes(b"ARTIFICIAL TEST EXPORT, NOT A REAL OBSERVATION")
        self.permission = self.root / "permission.json"
        self.grant = {"version": 1, "grant_id": "permission:test", "status": "granted", "creator_ids": ["100"],
                      "scopes": ["analytics_research", "video_annotation"], "verified_by": "test-only-reviewer",
                      "verified_at": "2026-01-01T00:00:00Z", "valid_until": None, "withdrawn_at": None,
                      "evidence_ref": "evidence:test", "evidence_sha256": hashlib.sha256(self.evidence.read_bytes()).hexdigest()}
        self.write_grant()
        self.row = {"creator_id": "100", "post_id": "200", "shortcode": "TEST_200", "published_at": "2026-02-01T00:00:00Z",
                    "observed_at": "2026-02-03T00:00:00Z", "collected_at": "2026-02-03T00:10:00Z",
                    "metric": {"definition_id": "test:views-v1", "name": "views", "version": "test:v1", "unit": "count",
                               "definition": "SOURCE: artificial test cumulative views definition"},
                    "counter_kind": "cumulative_counter", "value": 100, "missingness": "observed", "post_status": "available", "source_record_id": "test:capture1",
                    "row_reference": "artificial test row 1"}
        self.contract = {"contract_version": 1, "platform": "instagram", "source_id": "test:source",
                         "original_sha256": hashlib.sha256(self.original.read_bytes()).hexdigest(),
                         "source_generated_at": "2026-02-10T00:00:00Z", "extraction_version": "test:mapper-v1", "rows": [self.row]}
        self.input = self.root / "contract.json"

    def write_grant(self):
        self.permission.write_text(json.dumps(self.grant))

    def ingest(self, contract=None):
        self.input.write_text(json.dumps(contract or self.contract))
        return import_export(self.workspace, self.input, self.original, self.permission, self.evidence)

    def snapshot(self, **kw):
        return workspace_snapshot(self.workspace, self.permission, **({"cutoff": "2030-01-01T00:00:00Z"} | kw))

    def repeated(self):
        later = copy.deepcopy(self.contract)
        later["rows"][0].update(observed_at="2026-02-04T00:00:00Z", collected_at="2026-02-04T00:10:00Z",
                                value=150, source_record_id="test:capture2")
        return later

    def test_import_and_actual_receipt_point_in_time(self):
        result = self.ingest()
        self.assertEqual(result["ledger_observations"], 1)
        self.assertEqual(self.snapshot()["observations"], 1)
        self.assertEqual(self.snapshot(cutoff="2026-02-11T00:00:00Z")["observations"], 0)
        with ExportLedger(self.workspace / "observations.sqlite").connect() as db:
            r = json.loads(db.execute("SELECT payload FROM observations").fetchone()[0])
        self.assertEqual(r["measurement_age_ms"], 172800000)
        self.assertEqual(r["creator_id"], "100")
        self.assertEqual(r["post_id"], "200")
        self.assertEqual(r["observed_at"], "2026-02-03T00:00:00.000Z")
        self.assertEqual(r["evidence_type"], "creator_authorized_export")

    def test_repeated_counts_append_and_duplicate_rejects(self):
        self.ingest()
        self.ingest(self.repeated())
        self.assertEqual(self.snapshot()["observations"], 2)
        with self.assertRaises(ValueError):
            self.ingest(self.repeated())
        self.assertEqual(self.snapshot()["observations"], 2)

    def test_unknown_clocks_preserved_without_invention(self):
        self.row["observed_at"] = None
        self.ingest()
        result = self.snapshot()
        self.assertEqual(result["pending_unknown_clock_rows"], 1)
        self.assertEqual(result["observations"], 0)
        receipt = json.loads(next((self.workspace / "imports").glob("*.json")).read_text())
        self.assertIsNone(receipt["contract"]["rows"][0]["observed_at"])
        self.assertNotIn("measurement_age_ms", receipt["contract"]["rows"][0])
        with self.assertRaises(ValueError):
            self.ingest()

    def test_permission_scope_evidence_and_withdrawal(self):
        self.grant["creator_ids"] = ["101"]
        self.write_grant()
        with self.assertRaises(ValueError):
            self.ingest()
        self.grant["creator_ids"] = ["100"]
        self.write_grant()
        self.evidence.write_bytes(b"mismatch")
        with self.assertRaises(ValueError):
            self.ingest()
        self.evidence.write_bytes(b"ARTIFICIAL TEST CONSENT, NOT A REAL CREATOR PERMISSION")
        self.ingest()
        self.grant.update(status="withdrawn", withdrawn_at=now())
        self.write_grant()
        with self.assertRaises(ValueError):
            self.snapshot()
        with self.assertRaises(ValueError):
            ExportLedger(self.workspace / "observations.sqlite").as_of(now(), definition_id="test:views-v1",
                                                                        permission_path=self.permission)

    def test_narrowed_current_scope_suppresses_old_values(self):
        self.ingest()
        self.grant["creator_ids"] = ["101"]
        self.write_grant()
        self.assertEqual(self.snapshot()["observations"], 0)

    def test_invalid_clocks_values_missing_provenance_rejected(self):
        for key, bad in [("observed_at", "2026-01-01T00:00:00Z"), ("collected_at", "2026-02-02T00:00:00Z"),
                         ("published_at", "2026-02-01"), ("value", -1), ("value", True),
                         ("row_reference", ""), ("creator_id", "handle.only")]:
            c = copy.deepcopy(self.contract)
            c["rows"][0][key] = bad
            with self.subTest(key=key, bad=bad), self.assertRaises(ValueError):
                prepare_export(c, self.original.read_bytes(), self.grant, now())
        self.row["observed_at"] = None
        self.row["value"] = -1
        with self.assertRaises(ValueError):
            self.ingest()

    def test_definition_and_native_identity_conflicts_rollback(self):
        self.ingest()
        for key, bad in [("creator_id", "101"), ("shortcode", "OTHER200"), ("published_at", "2026-02-01T01:00:00Z")]:
            c = self.repeated()
            c["rows"][0][key] = bad
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.ingest(c)
        changed = self.repeated()
        changed["rows"][0]["metric"]["definition"] = "SOURCE: different counter meaning"
        with self.assertRaises(ValueError):
            self.ingest(changed)
        changed["rows"][0]["metric"]["definition_id"] = "test:views-v2"
        changed["rows"][0]["metric"]["version"] = "test:v2"
        self.ingest(changed)
        self.assertEqual(len(self.snapshot()["definitions"]), 2)

    def test_null_zero_deleted_and_unavailable_accounting(self):
        self.row["value"] = 0
        self.ingest()
        deleted = self.repeated()
        deleted["rows"][0].update(value=None, missingness="deleted", post_status="deleted")
        self.ingest(deleted)
        result = self.snapshot()
        self.assertEqual(result["missingness"], {"observed": 1, "deleted": 1})
        self.assertEqual(result["definitions"][0]["creator_normalized"], [])
        self.assertEqual(result["definitions"][0]["early_velocity"], [])

    def test_separate_evidence_files_and_no_simulated_availability(self):
        self.ingest()
        with self.assertRaises(ValidationError):
            Ledger(self.workspace / "observations.sqlite").verify()
        with self.assertRaises(ValueError):
            ExportLedger(self.workspace / "observations.sqlite").as_of(now(), definition_id="test:views-v1",
                    permission_path=self.permission, knowledge="availability_simulation")

    def annotation(self):
        a = draft("test:source", "200")
        a.update(creator_id="100", annotator="test reviewer", created_at=now(), evidence_type="authorized_video_review",
                 evidence_reference="artificial-only test annotation", grant_id=self.grant["grant_id"], duration_s=20)
        a["format"].update(delivery="spoken", pacing="slow", beats=[{"role":"hook", "start_s":0,"end_s":3,"modality":"spoken"}])
        return a

    def test_annotation_append_unknown_and_temporal_order(self):
        a = self.annotation()
        posts = [{"source_id":"test:source", "post_id":"200", "creator_id":"100", "duration_s":20}]
        path = self.root / "annotation.json"
        path.write_text(json.dumps(a))
        import_annotation(self.workspace, path, self.permission, self.evidence, posts)
        self.assertIsNone(a["format"]["reveal_s"])
        with self.assertRaises(FileExistsError):
            import_annotation(self.workspace, path, self.permission, self.evidence, posts)
        a["format"]["beats"].append({"role":"setup","start_s":2,"end_s":5,"modality":"spoken"})
        with self.assertRaises(ValueError):
            validate_annotation(a, self.grant, posts)

    def test_licensed_global_labels_cannot_become_visual_timing(self):
        a = self.annotation()
        a.update(source_id="educational-reels", evidence_type="licensed_annotation_review")
        self.grant["scopes"].append("licensed_annotation_review")
        posts = [{"source_id":"educational-reels","post_id":"200","creator_id":"100"}]
        with self.assertRaises(ValueError):
            validate_annotation(a, self.grant, posts)
        a["format"].update(beats=None, delivery=None)
        validate_annotation(a, self.grant, posts)
        a["format"]["reveal_s"] = 4
        with self.assertRaises(ValueError):
            validate_annotation(a, self.grant, posts)

    def test_age_aligned_peer_reference_velocity_and_incompatible_counter(self):
        c = copy.deepcopy(self.contract)
        c["rows"] = []
        for i in range(5):
            r = copy.deepcopy(self.row)
            r.update(post_id=str(200+i), shortcode="TEST_"+str(200+i), source_record_id="test:peer"+str(i), value=(i+1)*100)
            c["rows"].append(r)
        early = copy.deepcopy(c["rows"][0])
        early.update(source_record_id="test:early", observed_at="2026-02-02T00:00:00Z", collected_at="2026-02-02T00:10:00Z", value=50)
        c["rows"].append(early)
        self.ingest(c)
        result = self.snapshot()["definitions"][0]
        self.assertEqual(len(result["creator_normalized"]), 5)
        self.assertTrue(all(x["reference_n"] == 4 for x in result["creator_normalized"]))
        target = next(x for x in result["creator_normalized"] if x["post_id"] == "200")
        self.assertAlmostEqual(target["ratio"],100/350)
        self.assertAlmostEqual(result["early_velocity"][0]["value_per_hour"],50/24)
        later = self.repeated()
        later["rows"][0]["metric"]["definition_id"] = "test:interval-v1"
        later["rows"][0]["counter_kind"] = "interval_value"
        later["rows"][0].update(observed_at="2026-02-03T00:00:00Z",collected_at="2026-02-03T00:10:00Z",source_record_id="test:interval2")
        earlier = copy.deepcopy(later["rows"][0])
        earlier.update(observed_at="2026-02-02T00:00:00Z",collected_at="2026-02-02T00:10:00Z",source_record_id="test:interval1",value=30)
        later["rows"].append(earlier)
        self.ingest(later)
        self.assertEqual(next(x for x in self.snapshot()["definitions"] if x["counter_kind"] == "interval_value")["early_velocity"], [])

    def test_current_permission_is_reloaded_on_each_http_request(self):
        self.ingest()
        server = create_server({"sources": []}, [], 0, self.workspace, self.permission)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = "http://127.0.0.1:" + str(server.server_port) + "/api/intelligence"
        with patch("research.quant_lab.intelligence.now", return_value="2030-01-01T00:00:00.000Z"):
            with urllib.request.urlopen(url) as response:
                self.assertEqual(json.load(response)["authorized_exports"]["observations"], 1)
            self.grant.update(status="withdrawn", withdrawn_at=now())
            self.write_grant()
            with urllib.request.urlopen(url) as response:
                blocked = json.load(response)["authorized_exports"]
            self.assertEqual(blocked["status"], "blocked")
            self.assertNotIn("definitions", blocked)

    def test_script_bridge_and_late_annotation_exclusion(self):
        from .evaluation import chronological_annotation_inputs, script_diagnostics
        a = self.annotation()
        posts = [{"source_id":"test:source", "post_id":"200", "creator_id":"100", "duration_s":20}]
        path = self.root / "annotation.json"
        path.write_text(json.dumps(a))
        import_annotation(self.workspace, path, self.permission, self.evidence, posts)
        prior = chronological_annotation_inputs(self.workspace, self.permission, "2026-02-01T00:00:00Z")
        self.assertEqual(prior["features"], [])
        current = chronological_annotation_inputs(self.workspace, self.permission, "2030-01-01T00:00:00Z")
        self.assertEqual(len(current["features"]), 1)
        diagnostic = script_diagnostics({"delivery":"spoken","hook":"A test hook","cta":"","caption":"",
                 "beats":[{"t":"0-3","say":"A test hook","do":"","show":""}]}, current["features"][0])
        self.assertTrue(diagnostic["deterministic_diagnostics"]["hook_repeated"])
        self.assertEqual(current["scored_recommendations"], 0)
        self.assertIsNone(diagnostic["performance_claim"])

    def test_source_digest_duplicate_keys_and_no_network(self):
        from .authorized import read_json
        self.input.write_text('{"x":1,"x":2}')
        with self.assertRaises(ValueError):
            read_json(self.input)
        self.original.write_bytes(b"wrong artifact")
        with self.assertRaises(ValueError):
            self.ingest()
        self.original.write_bytes(b"ARTIFICIAL TEST EXPORT, NOT A REAL OBSERVATION")
        with patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")):
            self.ingest()
            self.assertEqual(self.snapshot()["observations"], 1)


class RealIntelligenceTests(unittest.TestCase):
    """Opt-in: actual already downloaded licensed observations, no source fetch."""
    data_dir = None

    @classmethod
    def setUpClass(cls):
        if cls.data_dir is None:
            raise unittest.SkipTest("use --real-data-dir for licensed real-data checks")
        from .data import load
        cls.source, cls.records = load(cls.data_dir)

    def test_real_report_determinism_coverage_and_no_prediction_claim(self):
        with patch.object(socket.socket, "connect", side_effect=AssertionError("no external calls")):
            a = report(self.source, self.records)
            b = report(self.source, self.records)
        self.assertEqual(a,b)
        c = a["catalog"]
        self.assertEqual(c["real_posts"],300)
        visual = next(r for r in c["review_ranking"] if r["human_hook_label"] == "Visual")
        self.assertEqual((visual["posts"],visual["sampled_creators"],visual["eligible_reference_posts"]),(203,19,160))
        self.assertIsNone(c["predictive_alpha"])
        self.assertIsNone(c["early_velocity"])
        self.assertIsNone(visual["observed_adoption_change"])
        self.assertEqual(c["missingness"]["annotated_below_1000_observed_views"],10)
        self.assertEqual(a["authorized_exports"]["status"],"not_connected")

    def test_real_http_routes_drafts_and_read_only_browser(self):
        server = create_server(self.source,self.records,0)
        worker = threading.Thread(target=server.serve_forever,daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = "http://127.0.0.1:"+str(server.server_port)
        for path in ("/intelligence","/intelligence.js","/api/intelligence","/api/intelligence.json","/api/annotation-context"):
            with urllib.request.urlopen(base+path) as response:
                self.assertEqual(response.status,200)
        with urllib.request.urlopen(base+"/api/annotation-context") as response:
            ctx=json.load(response)
        self.assertEqual(len(ctx["posts"]),300)
        self.assertTrue(all(p["url"].startswith("https://www.instagram.com/reel/") for p in ctx["posts"]))
        self.assertIsNone(ctx["template"]["format"]["beats"])
        for req in (urllib.request.Request(base+"/api/intelligence",method="POST",data=b"{}"),
                    urllib.request.Request(base+"/api/intelligence",headers={"Origin":"https://evil.example"}),
                    urllib.request.Request(base+"/api/annotation-context",headers={"Host":"evil.example"})):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req)
            self.assertIn(cm.exception.code,(403,405))


if __name__ == "__main__":
    import argparse
    parser=argparse.ArgumentParser()
    parser.add_argument("--real-data-dir",type=Path)
    args=parser.parse_args()
    RealIntelligenceTests.data_dir=args.real_data_dir
    unittest.main(argv=["test_intelligence"],verbosity=2)
