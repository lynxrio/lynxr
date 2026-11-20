"""Offline contract, integrity and leakage tests using invented observations only."""

import copy
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest.mock import patch

from .__main__ import FIXTURE, example
from .schema import Batch, Observation, ValidationError, digest, instant, read_batch
from .store import TABLES, Ledger


def batch(rows, artifact="syn:test-artifact"):
    rows = copy.deepcopy(rows)
    for row in rows:
        row["source"]["artifact_id"] = artifact
    return Batch.parse({"schema_version": 1, "evidence_type": "synthetic_fixture", "artifact_id": artifact,
                        "payload_sha256": digest(rows), "observations": rows})


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="lynxr-ledger-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.ledger = Ledger.create(self.root / "observations.sqlite")
        self.rows = json.loads(FIXTURE.read_text())["observations"]

    def row(self, index=0):
        return copy.deepcopy(self.rows[index])

    def load(self):
        return self.ledger.append(read_batch(FIXTURE))

    def query(self, cutoff="2025-01-19T00:00:00Z", **options):
        return self.ledger.as_of(cutoff, definition_id="syn:views-v1", knowledge="availability_simulation", **options)

    def fresh(self, name):
        row = self.row()
        row["observation_id"] = "syn:" + name
        row["post_id"] = "syn:post-" + name
        row["source"]["source_record_id"] = "syn:capture-" + name
        return row

    def test_typed_frozen_and_unknown_fields(self):
        row = Observation.parse(self.row())
        with self.assertRaises(FrozenInstanceError):
            row.value = 99
        for key in ("private_creator_data", "recorded_at"):
            raw = self.row()
            raw[key] = "unexpected"
            with self.assertRaises(ValidationError):
                Observation.parse(raw)

    def test_strict_numeric_and_null_contract(self):
        for number in (True, -1, 1.5, "100", 2**63, float("nan"), float("inf")):
            with self.subTest(number=number), self.assertRaises(ValidationError):
                raw = self.row()
                raw["value"] = number
                Observation.parse(raw)
        for number in (float("nan"), float("inf"), 10**400, True):
            raw = self.row()
            raw["metric"]["unit"] = "ratio"
            raw["value"] = number
            with self.assertRaises(ValidationError):
                Observation.parse(raw)
        raw = self.row()
        raw["metric"]["unit"] = "seconds"
        raw["value"] = 17
        self.assertIs(type(Observation.parse(raw).value), int)
        raw["value"] = 1.5
        self.assertEqual(Observation.parse(raw).value, 1.5)
        raw = self.row()
        raw["value"] = None
        with self.assertRaises(ValidationError):
            Observation.parse(raw)
        raw["missingness"] = "not_reported"
        self.assertIsNone(Observation.parse(raw).value)
        raw["value"], raw["missingness"] = 0, "observed"
        self.assertEqual(Observation.parse(raw).value, 0)

    def test_temporal_sequences_and_exact_age(self):
        mutations = {"published_at": "2025-01-03T00:00:00Z", "observed_at": "2025-01-03T00:00:00Z",
                     "collected_at": "2025-01-01T00:00:00Z", "extracted_at": "2025-01-01T00:00:00Z",
                     "available_at": "2025-01-01T00:00:00Z", "measurement_age_ms": 1}
        for key, value in mutations.items():
            raw = self.row()
            raw[key] = value
            with self.subTest(key=key), self.assertRaises(ValidationError):
                Observation.parse(raw)
        raw = self.row()
        raw["permission"]["available_at"] = "2025-02-01T00:00:00Z"
        with self.assertRaises(ValidationError):
            Observation.parse(raw)

    def test_timezone_normalization_and_precision(self):
        self.assertEqual(instant("2025-01-01T19:00:00-05:00"), "2025-01-02T00:00:00.000Z")
        for value in ("2025-01-01", "2025-01-01T00:00:00", "2025-01-01T00:00:00.000001Z", None):
            with self.assertRaises(ValidationError):
                instant(value)

    def test_missing_provenance_and_real_data_rejected(self):
        for section, key in (("source", "evidence_ref"), ("permission", "evidence_ref"), ("metric", "definition")):
            raw = self.row()
            del raw[section][key]
            with self.assertRaises(ValidationError):
                batch([raw])
        for key, value in (("creator_id", "real-account"), ("evidence_type", "measured")):
            raw = self.row()
            raw[key] = value
            with self.assertRaises(ValidationError):
                batch([raw])
        raw = self.row()
        raw["source"]["method"] = "api"
        with self.assertRaises(ValidationError):
            batch([raw])

    def test_artifact_digest_and_source_binding(self):
        envelope = json.loads(FIXTURE.read_text())
        envelope["payload_sha256"] = "0" * 64
        with self.assertRaises(ValidationError):
            Batch.parse(envelope)
        envelope = json.loads(FIXTURE.read_text())
        envelope["artifact_id"] = "syn:other"
        with self.assertRaises(ValidationError):
            Batch.parse(envelope)

    def test_duplicate_json_keys_and_size_limit(self):
        path = self.root / "fixture.json"
        path.write_text('{"schema_version":1,"schema_version":1}')
        with self.assertRaises(ValidationError):
            read_batch(path)
        path.write_bytes(b" " * 4_000_001)
        with self.assertRaises(ValidationError):
            read_batch(path)

    def test_duplicate_artifact_is_error_not_overwrite(self):
        self.load()
        before = self.ledger.verify()
        with self.assertRaises(ValidationError):
            self.load()
        self.assertEqual(before, self.ledger.verify())

    def test_duplicate_observation_and_snapshot_rollback(self):
        self.ledger.append(batch([self.row()]))
        for mutation in ("same-id", "new-id", "same-capture"):
            row = self.row()
            if mutation != "same-id":
                row["observation_id"] = "syn:new-observation"
            if mutation == "new-id":
                row["source"]["source_record_id"] = "syn:new-capture"
            with self.subTest(mutation=mutation), self.assertRaises(ValidationError):
                self.ledger.append(batch([row], "syn:new-artifact"))
        self.assertEqual(self.ledger.verify()["observations"], 1)

    def test_duplicate_inside_batch_rolls_back_empty_ledger(self):
        with self.assertRaises(ValidationError):
            self.ledger.append(batch([self.row(), self.row()]))
        self.assertEqual(self.ledger.verify()["observations"], 0)

    def test_identity_and_definition_conflicts(self):
        self.ledger.append(batch([self.row()]))
        variants = []
        raw = self.row(1)
        raw["creator_id"] = "syn:other-creator"
        variants.append(raw)
        raw = self.row(1)
        raw["published_at"] = "2024-12-30T00:00:00Z"
        raw["measurement_age_ms"] += 86400000
        variants.append(raw)
        raw = self.fresh("changed-semantics")
        raw["metric"]["definition"] += " Changed."
        variants.append(raw)
        raw = self.fresh("reassigned-capture")
        raw["source"]["source_record_id"] = self.row()["source"]["source_record_id"]
        variants.append(raw)
        before = self.ledger.verify()
        for row in variants:
            with self.assertRaises(ValidationError):
                self.ledger.append(batch([row], "syn:conflict"))
        self.assertEqual(before, self.ledger.verify())

    def test_entire_import_and_registries_roll_back(self):
        self.ledger.append(batch([self.row()]))
        before = self.ledger.verify()
        good = self.fresh("good")
        good["metric"]["definition_id"] = "syn:new-definition"
        bad = self.row(1)
        bad["creator_id"] = "syn:wrong-creator"
        with self.assertRaises(ValidationError):
            self.ledger.append(batch([good, bad], "syn:failed-batch"))
        self.assertEqual(before, self.ledger.verify())
        with sqlite3.connect(self.ledger.path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM definitions").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM posts").fetchone()[0], 1)

    def test_repeated_unchanged_and_lower_counts_preserved(self):
        rows = [self.row(), self.row(1)]
        rows[1]["value"] = 100
        third = copy.deepcopy(rows[1])
        third["observation_id"] = third["source"]["source_record_id"] = "syn:lower"
        for key in ("observed_at", "collected_at", "extracted_at", "available_at"):
            third[key] = "2025-01-05T01:00:00Z"
        third["measurement_age_ms"] = 435600000
        third["value"] = 80
        self.ledger.append(batch([*rows, third]))
        self.assertEqual([r["observation"]["value"] for r in self.query()["rows"]], [100, 100, 80])
        self.assertEqual(self.query(latest=True)["rows"][0]["observation"]["value"], 80)

    def test_walk_forward_default_receipt_gate(self):
        self.load()
        for day, count in ((5, 1), (12, 4), (19, 5)):
            cutoff = f"2025-01-{day:02}T00:00:00Z"
            self.assertEqual(len(self.query(cutoff, age_ms=172800000)["rows"]), count)
            self.assertEqual(self.ledger.as_of(cutoff, definition_id="syn:views-v1")["rows"], [])

    def test_late_import_cannot_rewrite_recorded_information_set(self):
        with patch("research.observation_ledger.store.recording_time", return_value="2025-01-02T02:00:00.000Z"):
            self.ledger.append(batch([self.row()]))
        cutoff = "2025-01-05T00:00:00Z"
        before = self.ledger.as_of(cutoff, definition_id="syn:views-v1")
        late = self.row(2)
        late["available_at"] = late["extracted_at"] = "2025-01-04T02:00:00Z"
        with patch("research.observation_ledger.store.recording_time", return_value="2025-01-11T00:00:00.000Z"):
            self.ledger.append(batch([late], "syn:late-import"))
        self.assertEqual(before, self.ledger.as_of(cutoff, definition_id="syn:views-v1"))
        self.assertEqual(len(self.query(cutoff)["rows"]), 2)

    def test_exclusive_cutoff_and_latest_filter_before_selection(self):
        self.load()
        self.assertEqual(self.query("2025-01-02T01:00:00Z")["rows"], [])
        self.assertEqual(len(self.query("2025-01-02T01:00:00.001Z")["rows"]), 1)
        early = self.query("2025-01-05T00:00:00Z", latest=True)["rows"]
        self.assertEqual([r["observation"]["observation_id"] for r in early], ["syn:a-96"])
        aged = self.query("2025-01-05T00:00:00Z", latest=True, age_ms=172800000)["rows"]
        self.assertEqual([r["observation"]["observation_id"] for r in aged], ["syn:a-48"])

    def test_future_deletion_does_not_change_earlier_simulated_result(self):
        self.ledger.append(batch([self.row(), self.row(1)]))
        before = self.query("2025-01-05T00:00:00Z", latest=True)
        self.ledger.append(batch([self.row(5)], "syn:deletion"))
        self.assertEqual(before, self.query("2025-01-05T00:00:00Z", latest=True))
        latest = self.query(latest=True)["rows"][0]["observation"]
        self.assertEqual((latest["post_status"], latest["value"]), ("deleted", None))

    def test_missingness_permission_and_deleted_accounting(self):
        self.load()
        rows = self.query()["rows"]
        missing = {r["observation"]["missingness"]: r["observation"]["value"] for r in rows}
        for reason in ("unavailable", "deleted", "permission_denied"):
            self.assertIsNone(missing[reason])
        self.assertEqual(self.query()["permission_states"], {"denied": 1, "granted": 6})
        for status in ("denied", "unknown", "withdrawn"):
            raw = self.row()
            raw["permission"]["status"] = status
            with self.assertRaises(ValidationError):
                Observation.parse(raw)
        raw = self.row(5)
        raw["permission"]["status"] = "withdrawn"
        self.assertIsNone(Observation.parse(raw).value)

    def test_counter_definition_changes_never_pool(self):
        self.load()
        self.assertEqual(len(self.query()["rows"]), 7)
        result = self.ledger.as_of("2025-01-19T00:00:00Z", definition_id="syn:views-v2", knowledge="availability_simulation")
        self.assertEqual(len(result["rows"]), 2)
        self.assertEqual(self.ledger.as_of("2025-01-12T00:00:00Z", definition_id="syn:views-v2", knowledge="availability_simulation")["rows"], [])
        with self.assertRaises(ValidationError):
            self.ledger.as_of("2025-01-19T00:00:00Z", definition_id="syn:unknown")

    def test_append_only_triggers_all_tables(self):
        self.load()
        with sqlite3.connect(self.ledger.path) as db:
            for table in TABLES:
                for statement in (f"DELETE FROM {table}", f"UPDATE {table} SET rowid=rowid"):
                    with self.subTest(statement=statement), self.assertRaises(sqlite3.IntegrityError):
                        db.execute(statement)
        self.assertEqual(self.ledger.verify()["observations"], 9)

    def test_sql_replace_cannot_bypass_delete_triggers(self):
        self.load()
        before = self.ledger.verify()
        with sqlite3.connect(self.ledger.path) as db:
            # SQLite's usual default; replacement must still reject atomically.
            db.execute("PRAGMA recursive_triggers=OFF")
            for table in TABLES:
                with self.subTest(table=table), self.assertRaises(sqlite3.IntegrityError):
                    db.execute(f"INSERT OR REPLACE INTO {table} SELECT * FROM {table} LIMIT 1")
        self.assertEqual(before, self.ledger.verify())

    def test_exclusive_creation_and_no_implicit_creation(self):
        before = self.ledger.path.read_bytes()
        with self.assertRaises(FileExistsError):
            Ledger.create(self.ledger.path)
        self.assertEqual(before, self.ledger.path.read_bytes())
        missing = self.root / "missing.sqlite"
        with self.assertRaises(sqlite3.OperationalError):
            Ledger(missing).verify()
        self.assertFalse(missing.exists())
        wrong = self.root / "wrong.sqlite"
        sqlite3.connect(wrong).close()
        with self.assertRaises(ValidationError):
            Ledger(wrong).verify()
        checkout = self.root / "checkout"
        (checkout / ".git").mkdir(parents=True)
        with self.assertRaises(ValidationError):
            Ledger.create(checkout / "ledger.sqlite")

    def test_integrity_check_detects_corruption(self):
        self.load()
        with sqlite3.connect(self.ledger.path) as db:
            db.execute("DROP TRIGGER no_update_observations")
            db.execute("UPDATE observations SET entry_hash=? WHERE sequence=1", ("f" * 64,))
            db.execute("CREATE TRIGGER no_update_observations BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT, 'append-only'); END")
        with self.assertRaises(ValidationError):
            self.ledger.verify()
        with self.assertRaises(ValidationError):
            self.query()

    def test_clock_regression_and_not_yet_available(self):
        with patch("research.observation_ledger.store.recording_time", return_value="2025-01-01T00:00:00.000Z"), self.assertRaises(ValidationError):
            self.ledger.append(batch([self.row()]))
        self.ledger.append(batch([self.row()]))
        with patch("research.observation_ledger.store.recording_time", return_value="2025-01-03T00:00:00.000Z"), self.assertRaises(ValidationError):
            self.ledger.append(batch([self.fresh("clock-regression")], "syn:clock-regression"))
        self.assertEqual(self.ledger.verify()["observations"], 1)

    def test_concurrent_appends_serialize_without_lost_observations(self):
        imports = [batch([self.fresh(f"parallel-{i}")], f"syn:parallel-{i}") for i in range(4)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(list(pool.map(self.ledger.append, imports)), [1, 1, 1, 1])
        self.assertEqual(self.ledger.verify()["observations"], 4)
        self.assertEqual(sorted(r["sequence"] for r in self.query()["rows"]), [1, 2, 3, 4])

    def test_deterministic_sort_independent_of_import_order(self):
        other = Ledger.create(self.root / "other.sqlite")
        for index in (2, 0, 3):
            self.ledger.append(batch([self.row(index)], f"syn:order-{index}"))
        for index in (3, 0, 2):
            other.append(batch([self.row(index)], f"syn:order-{index}"))
        first = [r["observation"] for r in self.query()["rows"]]
        second = [r["observation"] for r in other.as_of("2025-01-19T00:00:00Z", definition_id="syn:views-v1", knowledge="availability_simulation")["rows"]]
        self.assertEqual(first, second)
        self.assertEqual(self.query(), self.query())

    def test_example_is_reproducible_and_synthetic(self):
        expected = json.loads((FIXTURE.parent.parent / "example-output.json").read_text())
        self.assertEqual(example(), expected)
        self.assertEqual(example(), expected)
        self.assertEqual(expected["evidence_type"], "synthetic_fixture")
        self.assertEqual([len(w["observations"]) for w in expected["walk_forward"]], [1, 4, 5])

    def test_example_subprocess_blocks_network_credentials_and_production_imports(self):
        root = Path(__file__).resolve().parents[2]
        # -I ignores Python path/env injection; only this explicit source root is added.
        guard = f'''
import builtins, json, os, runpy, socket, sys, tempfile
sys.path.insert(0, {str(root)!r})
tempfile.tempdir = {str(self.root)!r}
def blocked(*args, **kwargs):
    raise AssertionError("prohibited environment or network access")
os.getenv = blocked
socket.create_connection = blocked
socket.socket.connect = blocked
original_import = builtins.__import__
def checked_import(name, *args, **kwargs):
    if name.split(".")[0] in ("pipeline", "envcfg", "supabase", "anthropic", "requests", "httpx") or "quant_lab" in name:
        raise AssertionError("prohibited production/provider import")
    return original_import(name, *args, **kwargs)
builtins.__import__ = checked_import
sys.argv = ["observation-ledger", "example"]
runpy.run_module("research.observation_ledger", run_name="__main__")
'''
        result = subprocess.run([sys.executable, "-I", "-B", "-c", guard], env={"PATH": os.defpath},
                                cwd=self.root, capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), example())
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["observations.sqlite"])


if __name__ == "__main__":
    unittest.main()
