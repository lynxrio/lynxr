"""Append-only synthetic SQLite ledger with verified point-in-time read snapshots."""

import json
import os
import sqlite3
from collections import Counter
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from .schema import (
    Batch,
    Knowledge,
    Observation,
    ValidationError,
    canonical,
    digest,
    instant,
    integer,
    synthetic_id,
)

APPLICATION_ID = 0x4C594C45
TABLES = ("metadata", "artifacts", "definitions", "posts", "captures", "observations")
# BEFORE INSERT guards also stop SQLite OR REPLACE, whose implicit deletes do
# not reliably fire DELETE triggers when recursive_triggers is disabled.
UNIQUE_KEYS = {
    "metadata": (("key",),),
    "artifacts": (("artifact_id",), ("payload_sha256",)),
    "definitions": (("definition_id",),),
    "posts": (("platform", "post_id"),),
    "captures": (("source_id", "source_record_id"),),
    "observations": (("sequence",), ("observation_id",),
                     ("platform", "post_id", "definition_id", "source_id", "observed_at", "collected_at"),
                     ("source_id", "source_record_id", "definition_id")),
}
ZERO = "0" * 64
DDL = """
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO metadata VALUES ('schema_version', '1'), ('evidence_type', 'synthetic_fixture');
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY, payload_sha256 TEXT NOT NULL UNIQUE,
  raw_payload TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TABLE definitions (definition_id TEXT PRIMARY KEY, binding TEXT NOT NULL);
CREATE TABLE posts (platform TEXT, post_id TEXT, binding TEXT NOT NULL, PRIMARY KEY(platform, post_id));
CREATE TABLE captures (source_id TEXT, source_record_id TEXT, binding TEXT NOT NULL,
  PRIMARY KEY(source_id, source_record_id));
CREATE TABLE observations (
  sequence INTEGER PRIMARY KEY, observation_id TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  platform TEXT NOT NULL, post_id TEXT NOT NULL,
  definition_id TEXT NOT NULL REFERENCES definitions(definition_id),
  source_id TEXT NOT NULL, source_record_id TEXT NOT NULL,
  observed_at TEXT NOT NULL, collected_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL, payload TEXT NOT NULL,
  previous_hash TEXT NOT NULL, entry_hash TEXT NOT NULL,
  UNIQUE(platform, post_id, definition_id, source_id, observed_at, collected_at),
  UNIQUE(source_id, source_record_id, definition_id)
);
"""


def recording_time() -> str:
    # Operational local receipt, not a trusted timestamp or user-supplied source clock.
    return instant(datetime.now(UTC).isoformat(timespec="milliseconds"))


def protected_path(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if any((p / ".git").exists() for p in resolved.parents):
        raise ValidationError("ledger files must live outside Git checkouts")
    return resolved


def entry_digest(sequence: int, payload: dict, recorded_at: str, artifact_id: str, artifact_hash: str, previous: str) -> str:
    return digest({"sequence": sequence, "observation": payload, "recorded_at": recorded_at,
                   "artifact_id": artifact_id, "artifact_sha256": artifact_hash, "previous_hash": previous})


def binding(db: sqlite3.Connection, table: str, keys: dict, value: object) -> None:
    # All table/key names below originate in this module, never in an imported field.
    where = " AND ".join(k + "=?" for k in keys)
    row = db.execute(f"SELECT binding FROM {table} WHERE {where}", tuple(keys.values())).fetchone()
    payload = canonical(value)
    if row is None:
        columns = ",".join((*keys, "binding"))
        placeholders = ",".join("?" for _ in range(len(keys) + 1))
        db.execute(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", (*keys.values(), payload))
    elif row[0] != payload:
        raise ValidationError("immutable identity, capture or counter definition conflict")


def identities(observation: Observation) -> tuple:
    r = observation
    return (("definitions", {"definition_id": r.metric.definition_id},
             {"platform": r.platform, "source_id": r.source.source_id, **r.to_dict()["metric"]}),
            ("posts", {"platform": r.platform, "post_id": r.post_id},
             {"creator_id": r.creator_id, "published_at": r.published_at}),
            ("captures", {"source_id": r.source.source_id, "source_record_id": r.source.source_record_id},
             {"platform": r.platform, "post_id": r.post_id, "observed_at": r.observed_at, "collected_at": r.collected_at}))


class Ledger:
    def __init__(self, path: Path):
        self.path = protected_path(Path(path))

    @classmethod
    def create(cls, path: Path) -> "Ledger":
        ledger = cls(path)
        ledger.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(ledger.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        with closing(sqlite3.connect(ledger.path)) as db:
            db.execute(f"PRAGMA application_id={APPLICATION_ID}")
            db.executescript(DDL)
            for table in TABLES:
                for action in ("UPDATE", "DELETE"):
                    db.execute(f"CREATE TRIGGER no_{action.lower()}_{table} BEFORE {action} ON {table} "
                               "BEGIN SELECT RAISE(ABORT, 'append-only synthetic ledger'); END")
                duplicate = " OR ".join("(" + " AND ".join(f"{key}=NEW.{key}" for key in keys) + ")"
                                        for keys in UNIQUE_KEYS[table])
                db.execute(f"CREATE TRIGGER no_replace_{table} BEFORE INSERT ON {table} "
                           f"WHEN EXISTS (SELECT 1 FROM {table} WHERE {duplicate}) "
                           "BEGIN SELECT RAISE(ABORT, 'append-only duplicate'); END")
            db.commit()
        return ledger

    def connect(self, write: bool = False) -> sqlite3.Connection:
        db = sqlite3.connect(self.path.as_uri() + ("?mode=rw" if write else "?mode=ro"), uri=True, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        if db.execute("PRAGMA application_id").fetchone()[0] != APPLICATION_ID:
            db.close()
            raise ValidationError("not a synthetic observation ledger")
        return db

    def _verify(self, db: sqlite3.Connection) -> list[dict]:
        if dict(db.execute("SELECT key,value FROM metadata")) != {"schema_version": "1", "evidence_type": "synthetic_fixture"}:
            raise ValidationError("invalid ledger metadata")
        expected_triggers = {f"no_{action}_{table}" for table in TABLES for action in ("update", "delete")}
        expected_triggers |= {f"no_replace_{table}" for table in TABLES}
        triggers = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
        if not expected_triggers <= triggers:
            raise ValidationError("append-only protections are missing")
        artifacts, observations = {}, {}
        for artifact in db.execute("SELECT * FROM artifacts"):
            original = json.loads(artifact["raw_payload"])
            batch = Batch.parse({"schema_version": 1, "evidence_type": "synthetic_fixture", "artifact_id": artifact["artifact_id"],
                                 "payload_sha256": artifact["payload_sha256"], "observations": original})
            if len({r.observation_id for r in batch.observations}) != len(batch.observations):
                raise ValidationError("duplicate artifact observation identity")
            artifacts[batch.artifact_id] = artifact
            for r in batch.observations:
                observations[batch.artifact_id, r.observation_id] = r
        previous, result, present = ZERO, [], set()
        for sequence, row in enumerate(db.execute("SELECT * FROM observations ORDER BY sequence"), 1):
            key = (row["artifact_id"], row["observation_id"])
            original = observations.get(key)
            payload = json.loads(row["payload"])
            if original is None or payload != original.to_dict():
                raise ValidationError("stored observation differs from its original artifact")
            if (row["platform"], row["post_id"], row["definition_id"], row["source_id"], row["source_record_id"], row["observed_at"], row["collected_at"]) != (
                    original.platform, original.post_id, original.metric.definition_id, original.source.source_id,
                    original.source.source_record_id, original.observed_at, original.collected_at):
                raise ValidationError("stored identity columns conflict with observation")
            artifact = artifacts[row["artifact_id"]]
            expected = entry_digest(sequence, payload, row["recorded_at"], row["artifact_id"], artifact["payload_sha256"], previous)
            if row["sequence"] != sequence or row["previous_hash"] != previous or row["entry_hash"] != expected:
                raise ValidationError("ledger sequence/hash integrity failure")
            if row["recorded_at"] != artifact["recorded_at"] or instant(row["recorded_at"]) < original.available_at:
                raise ValidationError("invalid local recording clock")
            for table, keys, value in identities(original):
                where = " AND ".join(k + "=?" for k in keys)
                stored = db.execute(f"SELECT binding FROM {table} WHERE {where}", tuple(keys.values())).fetchone()
                if stored is None or stored[0] != canonical(value):
                    raise ValidationError("ledger registry integrity failure")
            previous = expected
            present.add(key)
            result.append({"sequence": sequence, "observation": payload, "recorded_at": row["recorded_at"],
                           "artifact_id": row["artifact_id"], "artifact_sha256": artifact["payload_sha256"], "entry_hash": expected})
        if present != set(observations):
            raise ValidationError("artifact and ledger observation sets differ")
        return result

    def append(self, batch: Batch) -> int:
        validated = Batch.parse({"schema_version": 1, "evidence_type": "synthetic_fixture", "artifact_id": batch.artifact_id,
                                "payload_sha256": batch.payload_sha256, "observations": json.loads(batch.raw_payload_json)})
        if validated != batch:
            raise ValidationError("typed import differs from original artifact")
        with closing(self.connect(write=True)) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                old = self._verify(db)
                now = recording_time()
                if (old and now < old[-1]["recorded_at"]) or any(r.available_at > now for r in batch.observations):
                    raise ValidationError("local clock moved backwards or source is not yet available")
                db.execute("INSERT INTO artifacts VALUES (?,?,?,?)", (batch.artifact_id, batch.payload_sha256, batch.raw_payload_json, now))
                previous = old[-1]["entry_hash"] if old else ZERO
                for sequence, r in enumerate(batch.observations, len(old) + 1):
                    for table, keys, value in identities(r):
                        binding(db, table, keys, value)
                    entry_hash = entry_digest(sequence, r.to_dict(), now, batch.artifact_id, batch.payload_sha256, previous)
                    db.execute("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                               (sequence, r.observation_id, batch.artifact_id, r.platform, r.post_id, r.metric.definition_id,
                                r.source.source_id, r.source.source_record_id, r.observed_at, r.collected_at,
                                now, canonical(r.to_dict()), previous, entry_hash))
                    previous = entry_hash
                db.commit()
            except sqlite3.IntegrityError as exc:
                db.rollback()
                raise ValidationError("duplicate artifact, observation or snapshot; whole import rolled back") from exc
            except Exception:
                db.rollback()
                raise
        return len(batch.observations)

    def verify(self) -> dict:
        with closing(self.connect()) as db:
            db.execute("BEGIN")
            rows = self._verify(db)
            return {"evidence_type": "synthetic_fixture", "schema_version": 1, "observations": len(rows),
                    "head_hash": rows[-1]["entry_hash"] if rows else ZERO}

    def as_of(self, cutoff: str, *, definition_id: str, knowledge: Knowledge = "recorded",
              latest: bool = False, age_ms: int | None = None) -> dict:
        cutoff, definition_id = instant(cutoff), synthetic_id(definition_id)
        if knowledge not in ("recorded", "availability_simulation") or type(latest) is not bool:
            raise ValidationError("invalid query mode")
        if age_ms is not None:
            integer(age_ms)
        with closing(self.connect()) as db:
            db.execute("BEGIN")
            rows = self._verify(db)
            if db.execute("SELECT 1 FROM definitions WHERE definition_id=?", (definition_id,)).fetchone() is None:
                raise ValidationError("unknown counter definition; choose an explicit registered definition")
        selected = []
        for row in rows:
            r = row["observation"]
            clocks = [r[k] for k in ("published_at", "observed_at", "collected_at", "extracted_at", "available_at")]
            clocks.append(r["permission"]["available_at"])
            if knowledge == "recorded":
                clocks.append(row["recorded_at"])
            if (r["metric"]["definition_id"] == definition_id and all(t < cutoff for t in clocks)
                    and (age_ms is None or r["measurement_age_ms"] == age_ms)):
                selected.append(row)
        selected.sort(key=lambda row: tuple(row["observation"][k] for k in ("observed_at", "collected_at", "available_at", "observation_id")))
        if latest:
            by_post = {(row["observation"]["platform"], row["observation"]["post_id"]): row for row in selected}
            selected = sorted(by_post.values(), key=lambda row: tuple(row["observation"][k] for k in ("observed_at", "collected_at", "available_at", "observation_id")))
        return {"evidence_type": "synthetic_fixture", "cutoff_exclusive": cutoff, "definition_id": definition_id,
                "knowledge": knowledge, "latest_per_post": latest, "measurement_age_ms": age_ms,
                "rows": selected, "missingness": dict(sorted(Counter(r["observation"]["missingness"] for r in selected).items())),
                "permission_states": dict(sorted(Counter(r["observation"]["permission"]["status"] for r in selected).items()))}
