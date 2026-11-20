"""Deterministic temporal-leakage regressions on invented records only."""

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import historical_backtest as H


class HistoricalBacktestTests(unittest.TestCase):
    def setUp(self):
        self.policy, self.history, self.candidates, self.outcomes = (
            json.loads((H.FIXTURES / (name + ".json")).read_text())
            for name in ("policy", "history", "candidates", "outcomes"))
        self.prediction = H.freeze(self.history, self.policy)

    def report(self):
        return H.evaluate(self.prediction, self.candidates, self.outcomes)

    def test_cutoff_feasibility_and_all_exploratory_bands(self):
        report = self.report()
        self.assertEqual(report["baselines"], {"fixture-a": 150.0, "fixture-b": 900.0, "fixture-c": 50.0,
                                              "fixture-d": None, "fixture-zero": 0})
        self.assertEqual(set(report["candidate_audit"]["bands"]),
                         {"underperforming", "typical", "outperforming", "breakout", "unknown"})
        self.assertEqual(report["evidence_type"], "synthetic_fixture")
        self.assertEqual(report["mode"], "synthetic_feasibility_only")

    def test_future_metrics_cannot_change_frozen_predictions(self):
        before = copy.deepcopy(self.prediction)
        for observation in self.outcomes:
            observation["views"] = 9_000_000
        report = self.report()
        self.assertEqual(report["prediction_sha256"], before["prediction_sha256"])
        self.assertEqual(report["rankings"], before["frozen"]["rankings"])
        self.assertEqual(self.prediction, before)

    def test_candidate_features_cannot_change_frozen_predictions(self):
        for record in self.candidates:
            record["format"] = copy.deepcopy(self.history[0]["format"])
            record["views"] = 999999999  # Unused future-metric smuggling has no ranker input path.
        self.assertEqual(self.report()["rankings"], self.prediction["frozen"]["rankings"])

    def test_appending_late_history_does_not_change_prediction_digest(self):
        late = copy.deepcopy(self.history[0])
        late["id"] = "late-added-id"
        late["available_at"] = "2026-01-01T00:00:00Z"
        changed = H.freeze(self.history + [late], self.policy)
        self.assertEqual(changed["prediction_sha256"], self.prediction["prediction_sha256"])
        self.assertIn("late-added-id", {r["id"] for r in changed["history_audit"]["rejected"]})

    def test_late_measurement_is_not_a_historical_count(self):
        record = self.history[0]
        record["observations"].append({**copy.deepcopy(record["observations"][0]),
                                       "available_at": "2026-01-01T00:00:00Z", "views": 99999999})
        self.assertEqual(H.freeze(self.history, self.policy)["prediction_sha256"],
                         self.prediction["prediction_sha256"])
        observed, reasons = H.metric(record, [record["observations"][-1]], self.policy,
                                     H.timestamp(self.policy["cutoff"]))
        self.assertIsNone(observed)
        self.assertIn("metric_not_available_by_deadline", reasons)

    def test_publication_is_not_discovery_or_feature_availability(self):
        reasons = {r["id"]: r["reason"] for r in self.prediction["history_audit"]["rejected"]}
        self.assertEqual(reasons["future-discovered"], "not_known_at_cutoff")
        self.assertEqual(reasons["future-extracted"], "features_not_known_at_cutoff")
        self.assertEqual(reasons["unknown-time"], "missing_or_invalid_timestamp")

    def test_exclusive_cutoff_and_naive_clock_rejection(self):
        for field in ("available_at", "features_available_at"):
            record = copy.deepcopy(self.history[0])
            record[field] = self.policy["cutoff"]
            self.assertIsNotNone(H.metadata_reason(record, self.policy, True))
        with self.assertRaises(ValueError):
            H.timestamp("2025-01-04T12:00:00")
        self.assertEqual(H.timestamp("2025-01-04T19:00:00-05:00"), H.timestamp(self.policy["cutoff"]))

    def test_age_is_computed_from_timestamps_not_claimed_day(self):
        candidate = self.candidates[0]
        observation = copy.deepcopy(self.outcomes[0])
        observation["observed_at"] = "2025-01-06T00:00:00Z"  # 24h rather than 48h.
        observation["day"] = 2
        value, reasons = H.metric(candidate, [observation], self.policy, H.timestamp(self.policy["outcome_close"]))
        self.assertIsNone(value)
        self.assertIn("wrong_post_age", reasons)

    def test_wrong_identity_future_age_missing_and_invalid_counts_rejected(self):
        record, source = self.candidates[0], self.outcomes[0]
        for change in ({"video_id": "another-post"}, {"views": None}, {"views": True},
                       {"views": -1}, {"views": 1.5}, {"views": 10**400},
                       {"observed_at": None}, {"available_at": "2025-01-01T00:00:00Z"}):
            obs = {**copy.deepcopy(source), **change}
            value, reasons = H.metric(record, [obs], self.policy, H.timestamp(self.policy["outcome_close"]))
            self.assertIsNone(value)
            self.assertTrue(reasons)

    def test_earliest_available_snapshot_wins_not_highest_count(self):
        record, early = self.candidates[0], self.outcomes[0]
        later = {**copy.deepcopy(early), "available_at": "2025-01-08T00:00:00Z", "views": 99999}
        value, _ = H.metric(record, [later, early], self.policy, H.timestamp(self.policy["outcome_close"]))
        self.assertEqual(value, early["views"])

    def test_conflicting_simultaneous_measurements_remain_unknown(self):
        early = self.outcomes[0]
        conflict = {**copy.deepcopy(early), "id": "conflicting-observation", "views": 99999}
        value, reasons = H.metric(self.candidates[0], [early, conflict], self.policy,
                                  H.timestamp(self.policy["outcome_close"]))
        self.assertIsNone(value)
        self.assertIn("conflicting_metric_observations", reasons)

    def test_baselines_never_use_future_videos_or_self_normalization(self):
        self.assertEqual(self.prediction["frozen"]["baselines"]["fixture-a"], 150)
        scores = self.prediction["frozen"]["catalog"]
        self.assertEqual(scores["unadopted"]["normalized_score"], 5)
        self.assertNotIn("future-breakout", self.prediction["frozen"]["history_ids"])

    def test_zero_baseline_and_missing_outcomes_are_not_zero_performance(self):
        rows = {r["id"]: r for r in self.report()["candidates"]}
        self.assertEqual(rows["future-zero-baseline"]["outcome_status"], "zero_baseline")
        self.assertIsNone(rows["future-zero-baseline"]["ratio"])
        self.assertEqual(rows["future-no-baseline"]["outcome_status"], "missing_baseline")
        self.assertIsNone(rows["future-unknown"]["ratio"])
        self.assertIsNone(rows["future-lifetime-only"]["views"])

    def test_format_matching_is_structural_and_needs_complete_features(self):
        fmt = self.history[0]["format"]
        rules = self.policy["matching"]
        self.assertEqual(H.similarity(fmt, fmt, rules)["kind"], "same_format")
        wrong = {**copy.deepcopy(fmt), "delivery": "silent"}
        self.assertNotEqual(H.similarity(fmt, wrong, rules)["kind"], "same_format")
        reordered = {**copy.deepcopy(fmt), "roles": list(reversed(fmt["roles"]))}
        self.assertNotEqual(H.similarity(fmt, reordered, rules)["kind"], "same_format")
        missing = copy.deepcopy(fmt)
        del missing["reveal"]
        self.assertEqual(H.similarity(fmt, missing, rules)["kind"], "insufficient_features")

    def test_generic_talking_heads_are_not_reusable_format_matches(self):
        fmt = {**self.history[0]["format"], "roles": ["Intro", "Body", "Outro"]}
        self.assertEqual(H.similarity(fmt, fmt, self.policy["matching"])["kind"], "genre_only")

    def test_future_feature_clock_conflicts_preserve_unknown_matches(self):
        for clock in (None, "2024-01-01T00:00:00Z", self.policy["outcome_close"]):
            self.candidates[0]["features_available_at"] = clock
            row = next(r for r in self.report()["candidates"] if r["id"] == self.candidates[0]["id"])
            self.assertEqual(row["matching_status"], "features_unavailable")
            self.assertEqual(row["ratio"], 0.2)

    def test_history_candidate_identity_overlap_is_rejected(self):
        old_id = self.candidates[0]["id"]
        self.candidates[0]["id"] = self.history[0]["id"]
        for observation in self.outcomes:
            if observation["video_id"] == old_id:
                observation["video_id"] = self.history[0]["id"]
        self.assertIn({"id": self.history[0]["id"], "reason": "history_candidate_id_overlap"},
                      self.report()["candidate_audit"]["rejected"])

    def test_duplicates_never_supply_independent_future_adoption(self):
        report = self.report()
        rejected = {r["id"]: r["reason"] for r in report["candidate_audit"]["rejected"]}
        self.assertEqual(rejected["future-source-copy"], "duplicate_of_history")
        self.assertEqual(rejected["future-duplicate"], "duplicate_content")
        self.assertEqual(len(report["candidates"]), 10)

    def test_unmatched_predictions_and_missing_matches_remain_unresolved(self):
        report = self.report()
        predictions = [p for s in report["strategies"].values() for p in s["predictions"]]
        self.assertTrue(any(p["status"] == "no_match_observed" for p in predictions))
        self.assertTrue(all(s["ordinary_precision_at_k"] is None for s in report["strategies"].values()))
        self.assertEqual(next(r for r in report["candidates"] if r["id"] == "future-private")["matching_status"],
                         "features_unavailable")

    def test_population_platform_permissions_and_weights_fail_closed(self):
        wrong = copy.deepcopy(self.policy)
        wrong["roster_available_at"] = wrong["candidate_start"]
        with self.assertRaises(ValueError):
            H.freeze(self.history, wrong)
        wrong = copy.deepcopy(self.policy)
        wrong["sampling_probability"] = 0.5
        with self.assertRaises(ValueError):
            H.freeze(self.history, wrong)
        self.candidates[0]["sampling_probability"] = 0.5
        with self.assertRaises(ValueError):
            self.report()

    def test_no_recall_for_an_incomplete_universe(self):
        policy = {**self.policy, "complete_candidate_manifest": False}
        report = H.evaluate(H.freeze(self.history, policy), self.candidates, self.outcomes)
        self.assertTrue(all(s["recall_among_observed_outperformers"] is None for s in report["strategies"].values()))

    def test_band_edges_are_exploratory_and_nonoverlapping(self):
        self.assertEqual([H.band(x) for x in (0, 0.499, 0.5, 1.5, 1.5001, 3, 3.0001)],
                         ["underperforming", "underperforming", "typical", "typical",
                          "outperforming", "outperforming", "breakout"])

    def test_bootstrap_samples_creators_and_handles_too_few_clusters(self):
        report = self.report()
        a = report["strategies"]["popularity"]["log_lift_interval_vs_random"]
        self.assertEqual(a, self.report()["strategies"]["popularity"]["log_lift_interval_vs_random"])
        self.assertIn("usable_draws", a)
        self.assertIsNone(H.difference_interval(report["candidates"][:1], set(), set(), 17)["interval"])
        self.assertIsNone(a["interval"])

    def test_paired_creator_bootstrap_on_supported_synthetic_clusters(self):
        rows = [{"creator": f"synthetic-{i}", "matches": [strategy], "ratio": 1,
                 "log_relative": (i / 10 if strategy == "left" else 0)}
                for i in range(6) for strategy in ("left", "right")]
        result = H.difference_interval(rows, {"left"}, {"right"}, 17)
        self.assertEqual(result, H.difference_interval(rows, {"left"}, {"right"}, 17))
        self.assertEqual(result["usable_draws"], 400)
        self.assertLessEqual(result["interval"][0], 0.25)
        self.assertGreaterEqual(result["interval"][1], 0.25)

    def test_artifact_mutation_and_duplicate_manifest_ids_rejected(self):
        self.prediction["frozen"]["baselines"]["fixture-a"] = 1
        with self.assertRaises(ValueError):
            self.report()
        with self.assertRaises(ValueError):
            H.evaluate(H.freeze(self.history, self.policy), self.candidates * 2, self.outcomes)

    def test_non_synthetic_records_and_unfrozen_feature_versions_rejected(self):
        self.history[0]["evidence_type"] = "measured"
        with self.assertRaises(ValueError):
            H.freeze(self.history, self.policy)
        self.history[0]["evidence_type"] = "synthetic_fixture"
        self.history[0]["feature_version"] = "future-transformation"
        prediction = H.freeze(self.history, self.policy)
        self.assertIn({"id": self.history[0]["id"], "reason": "unfrozen_feature_version"},
                      prediction["history_audit"]["rejected"])

    def test_report_snapshot_and_repeatability(self):
        report = H.bundled_report()
        saved = Path(__file__).parent.parent / "docs/historical-backtest/synthetic-report.md"
        self.assertEqual(saved.read_text(), H.markdown(report))
        self.assertEqual(report, H.bundled_report())

    def test_cli_isolated_from_credentials_network_worker_and_private_files(self):
        script = Path(__file__).parent / "eval_scripts.py"
        guard = '''import builtins, os, pathlib, runpy, socket, sys
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name.split('.')[0] in {'process_adaptations','envcfg','anthropic','apify_client','track_posts','brain_prompt','hook_score'}:
        raise AssertionError('forbidden import')
    return original_import(name, *args, **kwargs)
builtins.__import__ = guarded_import
def blocked(*args, **kwargs):
    raise AssertionError('forbidden environment/network/directory action')
socket.socket.connect = blocked
socket.create_connection = blocked
os.getenv = blocked
pathlib.Path.mkdir = blocked
original_read = pathlib.Path.read_text
def fixture_only(path, *args, **kwargs):
    if path.parent.name != 'historical_fixtures' or path.name not in {'policy.json','history.json','candidates.json','outcomes.json'}:
        raise AssertionError('unexpected file read')
    return original_read(path, *args, **kwargs)
pathlib.Path.read_text = fixture_only
sys.argv = [sys.argv[1], 'historical', '--format', 'json']
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as directory:
            run = subprocess.run([sys.executable, "-I", "-c", guard, str(script.resolve())],
                                 cwd=directory, env={"HOME": directory, "PATH": os.defpath},
                                 capture_output=True, text=True, check=False, timeout=15)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(run.stdout), H.bundled_report())
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
