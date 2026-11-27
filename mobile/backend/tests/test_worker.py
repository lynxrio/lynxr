"""Pure worker orchestration tests with injected processors; no real model imports."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mobile_worker import MobileWorker, SourceUnavailable, pipeline_processor


class WorkerTests(unittest.TestCase):
    def run_job(self, process):
        calls = []

        def rpc(name, args):
            calls.append((name, args))
            if name == "mobile_claim_job":
                return {"id": "job", "lease_token": "token"}
            return True

        self.assertTrue(MobileWorker(rpc, process).run_once())
        return calls

    def test_completion_uses_fenced_server_contract(self):
        calls = self.run_job(
            lambda j: {"source": {"script": {"text": "Local injected fixture"}}}
        )
        self.assertEqual(
            [x[0] for x in calls],
            ["mobile_expire_jobs", "mobile_claim_job", "mobile_finish_job"],
        )
        self.assertEqual(calls[-1][1]["p_token"], "token")
        self.assertIsNone(calls[-1][1]["p_error"])

    def test_failure_codes_do_not_include_provider_diagnostics(self):
        def inaccessible(j):
            raise SourceUnavailable("Private internal reason")

        def failed(j):
            raise RuntimeError("Never expose this provider detail")

        for process, code in [
            (inaccessible, "source_unavailable"),
            (failed, "processing_failed"),
            (lambda j: {}, "processing_failed"),
        ]:
            args = self.run_job(process)[-1][1]
            self.assertEqual(args["p_error"], code)
            self.assertNotIn("detail", str(args))

    def test_pipeline_adapter_reuses_functions_without_legacy_graft_or_upload(self):
        steps = []

        def fill(a, *args):
            steps.append("source")
            a["source"] = {"script": {"text": "Fixture"}, "clip": "should-not-export"}
            return True

        def extract(c, a, *args):
            steps.append("format")
            a["format"] = {"name": "Fixture"}
            return True

        def adapt(a, creator, *args):
            steps.append("adapt")
            a["adaptation"] = {"beats": [{"say": "Fixture"}]}

        fake = SimpleNamespace(
            anthropic_client=lambda key: object(),
            fill_source=fill,
            extract_format=extract,
            fill_adaptation=adapt,
            has_usable_result=lambda a: True,
            FetchFailed=SourceUnavailable,
        )
        with patch.dict(sys.modules, {"process_adaptations": fake}):
            process = pipeline_processor(
                "https://approved-stage.invalid", "fixture-service", "fixture-ai"
            )
            result = process(
                {
                    "id": "job",
                    "source_url": "https://instagram.com/reel/fixture/",
                    "brand_id": "brand",
                    "brand_snapshot": {"id": "brand", "name": "Test"},
                }
            )
        self.assertEqual(steps, ["source", "format", "adapt"])
        self.assertEqual(fake.SB_URL, "https://approved-stage.invalid")
        self.assertFalse(fake.REUSE_SOURCES)
        self.assertFalse(fake.FETCH_FALLBACK_APIFY)
        self.assertIsNone(fake.upload_cover())
        self.assertIsNone(fake.upload_clip())
        self.assertNotIn("clip", result["source"])


if __name__ == "__main__":
    unittest.main()
