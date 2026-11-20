"""Explicit offline creator-export adapter. No discovery, networking or credentials."""

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from research.observation_ledger.schema import (
    MAX_BYTES,
    Batch,
    MetricDefinition,
    Observation,
    Permission,
    Source,
    ValidationError,
    _object,
    canonical,
    choice,
    digest,
    exact,
    instant,
    metric_value,
    milliseconds,
    text,
)
from research.observation_ledger.store import Ledger, protected_path, recording_time

KIND = "creator_authorized_export"


def identifier(value):
    value = text(value, 200)
    if value.startswith("syn:") or not re.fullmatch(r"[A-Za-z0-9:_./-]+", value):
        raise ValidationError("invalid authorized research identifier")
    return value


class ExportMetric(MetricDefinition):
    identity = staticmethod(identifier)
    semantics_prefix = "SOURCE: "

    @classmethod
    def parse(cls, value):
        metric = super().parse(value)
        if not metric.definition[len(cls.semantics_prefix):].strip():
            raise ValidationError("source counter definition is missing")
        return metric


@dataclass(frozen=True)
class ExportSource(Source):
    method: Literal["creator_authorized_export"]
    identity = staticmethod(identifier)
    methods = ("creator_authorized_export",)


@dataclass(frozen=True)
class ExportPermission(Permission):
    purpose: Literal["authorized_offline_research"]
    identity = staticmethod(identifier)
    purposes = ("authorized_offline_research",)


@dataclass(frozen=True)
class ExportObservation(Observation):
    evidence_type: Literal["creator_authorized_export"]
    platform: Literal["instagram"]
    metric: ExportMetric
    source: ExportSource
    permission: ExportPermission
    identity = staticmethod(identifier)
    evidence = KIND
    metric_type = ExportMetric
    source_type = ExportSource
    permission_type = ExportPermission

    @classmethod
    def parse(cls, value):
        observation = super().parse(value)
        if observation.platform != "instagram" or any(not re.fullmatch(r"[0-9]{1,40}", x)
                for x in (observation.creator_id, observation.post_id)):
            raise ValidationError("authorized Instagram observations require native numeric IDs")
        return observation


class ExportBatch(Batch):
    identity = staticmethod(identifier)
    evidence = KIND
    observation_type = ExportObservation


class ExportLedger(Ledger):
    """Separate evidence file; the synthetic default class still rejects this file."""
    evidence_type = KIND
    batch_type = ExportBatch
    definition_identity = staticmethod(identifier)

    def as_of(self, cutoff, *, permission_path, **options):
        grant = permission(permission_path, "analytics_research")
        if options.get("knowledge", "recorded") != "recorded":
            raise ValidationError("real queries require actual local receipt availability")
        result = super().as_of(cutoff, **options)
        result["rows"] = [r for r in result["rows"] if allowed(grant, r["observation"]["creator_id"])
                          and r["observation"]["permission"]["evidence_ref"] == grant["grant_id"]]
        from collections import Counter
        result["missingness"] = dict(Counter(r["observation"]["missingness"] for r in result["rows"]))
        result["permission_states"] = dict(Counter(r["observation"]["permission"]["status"] for r in result["rows"]))
        return result


def read_json(path):
    with Path(path).open("rb") as f:
        blob = f.read(MAX_BYTES + 1)
    if len(blob) > MAX_BYTES:
        raise ValidationError("research input exceeds size limit")
    return json.loads(blob, object_pairs_hook=_object)


def now():
    return instant(datetime.now(UTC).isoformat(timespec="milliseconds"))


def permission(path, scope=None):
    grant = exact(read_json(protected_path(Path(path))), {"version", "grant_id", "status", "creator_ids", "scopes", "verified_by",
                                    "verified_at", "valid_until", "withdrawn_at", "evidence_ref", "evidence_sha256"})
    if type(grant["version"]) is not int or grant["version"] != 1:
        raise ValidationError("unsupported permission contract")
    identifier(grant["grant_id"])
    identifier(grant["evidence_ref"])
    text(grant["verified_by"])
    if type(grant["evidence_sha256"]) is not str or not re.fullmatch(r"[a-f0-9]{64}", grant["evidence_sha256"]):
        raise ValidationError("permission evidence digest missing")
    if not isinstance(grant["creator_ids"], list) or not grant["creator_ids"]:
        raise ValidationError("explicit permitted creator identities required")
    for creator in grant["creator_ids"]:
        text(creator)
    if (not isinstance(grant["scopes"], list) or not grant["scopes"]
            or any(type(s) is not str or s not in {"analytics_research", "licensed_annotation_review", "video_annotation", "supplied_annotation"}
                   for s in grant["scopes"])):
        raise ValidationError("invalid research permission scope")
    choice(grant["status"], ("granted", "unknown", "denied", "withdrawn"))
    current = now()
    if instant(grant["verified_at"]) > current:
        raise ValidationError("permission verification cannot be future-dated")
    if grant["valid_until"] is not None and instant(grant["valid_until"]) <= current:
        raise ValidationError("research permission expired")
    if grant["withdrawn_at"] is not None:
        instant(grant["withdrawn_at"])
        raise ValidationError("research permission withdrawn; stop use and apply erasure terms")
    if grant["status"] != "granted" or (scope is not None and scope not in grant["scopes"]):
        raise ValidationError("current verified research permission required")
    return grant


def allowed(grant, creator_id):
    return creator_id in grant["creator_ids"]


def verify_evidence(grant, evidence_path):
    import hashlib
    with Path(evidence_path).open("rb") as f:
        blob = f.read(MAX_BYTES + 1)
    if len(blob) > MAX_BYTES or hashlib.sha256(blob).hexdigest() != grant["evidence_sha256"]:
        raise ValidationError("permission evidence does not match reviewed manifest")


def private_write(path, payload):
    path = protected_path(Path(path))
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    import os
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(canonical(payload) + "\n")


@dataclass(frozen=True)
class PreparedExport:
    batch: ExportBatch | None
    receipt: dict


def prepare_export(contract, original_blob, grant, received_at):
    """Unknown clocks stay in receipt accounting, never in a temporal ledger row."""
    import hashlib
    v = exact(contract, {"contract_version", "platform", "source_id", "original_sha256", "source_generated_at",
                         "extraction_version", "rows"})
    if type(v["contract_version"]) is not int or v["contract_version"] != 1 or v["platform"] != "instagram":
        raise ValidationError("expected Instagram export contract v1")
    if hashlib.sha256(original_blob).hexdigest() != v["original_sha256"]:
        raise ValidationError("original export digest mismatch")
    received_at = instant(received_at)
    if v["source_generated_at"] is not None and instant(v["source_generated_at"]) > received_at:
        raise ValidationError("export generation cannot follow receipt")
    source_id, extraction = identifier(v["source_id"]), identifier(v["extraction_version"])
    if not isinstance(v["rows"], list) or not 1 <= len(v["rows"]) <= 10000:
        raise ValidationError("expected 1..10000 export rows")
    artifact_id = "export:" + digest(v)
    rows, pending, snapshots = [], [], set()
    posts, codes, captures, definitions = {}, {}, {}, {}
    for raw in v["rows"]:
        r = exact(raw, {"creator_id", "post_id", "shortcode", "published_at", "observed_at", "collected_at",
                        "metric", "counter_kind", "value", "missingness", "post_status", "source_record_id", "row_reference"})
        if any(type(r[k]) is not str or not re.fullmatch(r"[0-9]{1,40}", r[k]) for k in ("creator_id", "post_id")):
            raise ValidationError("native numeric Instagram creator/post IDs required")
        if not allowed(grant, r["creator_id"]):
            raise ValidationError("creator outside verified permission scope")
        if type(r["shortcode"]) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{5,32}", r["shortcode"]):
            raise ValidationError("invalid source shortcode")
        text(r["row_reference"])
        capture = identifier(r["source_record_id"])
        metric = ExportMetric.parse(r["metric"])
        choice(r["counter_kind"], ("cumulative_counter", "interval_value", "unknown"))
        for registry, key, binding in (
                (posts, r["post_id"], (r["creator_id"], r["shortcode"], instant(r["published_at"]) if r["published_at"] is not None else None)),
                (codes, r["shortcode"], r["post_id"]),
                (captures, capture, (r["post_id"], r["observed_at"], r["collected_at"])),
                (definitions, metric.definition_id, (r["metric"], r["counter_kind"]))):
            if key in registry and registry[key] != binding:
                raise ValidationError("conflicting export identity, capture or metric definition")
            registry[key] = binding

        # Validate null/value/status even when clocks are missing; no invalid numeric row can hide in staging.
        known = {k: instant(r[k]) for k in ("published_at", "observed_at", "collected_at") if r[k] is not None}
        ordered = [known[k] for k in ("published_at", "observed_at", "collected_at") if k in known]
        if (ordered != sorted(ordered) or any(t > received_at for t in ordered)
                or (v["source_generated_at"] is not None and any(t > instant(v["source_generated_at"]) for t in ordered))):
            raise ValidationError("invalid source clock sequence")
        identity = (r["post_id"], metric.definition_id, capture)
        if identity in snapshots:
            raise ValidationError("duplicate source capture/metric")
        snapshots.add(identity)
        missing = [k for k in ("published_at", "observed_at", "collected_at") if r[k] is None]
        permitted = ExportPermission.parse({"status": "denied" if r["missingness"] == "permission_denied" else "granted", "purpose": "authorized_offline_research",
                                            "evidence_ref": grant["grant_id"], "available_at": grant["verified_at"]})
        metric_value(r, metric, permitted)
        if missing:
            pending.append({"source_record_id": capture, "row_reference": r["row_reference"], "missing_clocks": missing,
                            "metric_definition": metric.definition_id, "value_missingness": r["missingness"]})
            continue
        payload = {"schema_version": 1, "evidence_type": KIND, "observation_id": "observation:" + digest([source_id, identity]),
                   "platform": "instagram", "creator_id": r["creator_id"], "post_id": r["post_id"],
                   **known,
                   "extracted_at": received_at, "available_at": received_at, "measurement_age_ms": 0,
                   "metric": r["metric"], "value": r["value"],
                   "missingness": r["missingness"], "post_status": r["post_status"],
                   "source": {"source_id": source_id, "source_record_id": capture, "artifact_id": artifact_id,
                              "evidence_ref": "original:" + v["original_sha256"], "method": KIND},
                   "permission": {"status": permitted.status, "purpose": "authorized_offline_research",
                                  "evidence_ref": grant["grant_id"], "available_at": instant(grant["verified_at"])},
                   "extraction_version": extraction, "analysis_version": "quant-intelligence-v1"}
        payload["measurement_age_ms"] = milliseconds(payload["published_at"], payload["observed_at"])
        parsed = ExportObservation.parse(payload)
        rows.append(parsed.to_dict())
    batch = ExportBatch.parse({"schema_version": 1, "evidence_type": KIND, "artifact_id": artifact_id,
                               "payload_sha256": digest(rows), "observations": rows}) if rows else None
    receipt = {"evidence_type": KIND, "contract": contract, "artifact_id": artifact_id,
               "original_sha256": v["original_sha256"], "received_at": received_at, "grant_id": grant["grant_id"],
               "permission_snapshot": grant, "ledger_observations": len(rows), "pending_temporal_observations": pending,
               "permission_attestation": "Owner-reviewed manifest; not independent proof of consent or source authenticity"}
    return PreparedExport(batch, receipt)


def _import_export(root, contract_path, original_path, permission_path, evidence_path):
    root = protected_path(Path(root) / "observations.sqlite").parent
    grant = permission(permission_path, "analytics_research")
    verify_evidence(grant, evidence_path)
    with Path(original_path).open("rb") as f:
        original = f.read(MAX_BYTES + 1)
    if len(original) > MAX_BYTES:
        raise ValidationError("original export exceeds size limit")
    prepared = prepare_export(read_json(contract_path), original, grant, recording_time())
    receipt_path = root / "imports" / (prepared.receipt["artifact_id"].split(":")[1] + ".json")
    if receipt_path.exists():
        raise ValidationError("export already imported")
    # Include pending rows in identity/definition/duplicate guards across imports.
    prior = [read_receipt(p) for p in sorted((root / "imports").glob("*.json"))]
    for old in prior:
        c = old["contract"]
        for a in c["rows"]:
            for b in prepared.receipt["contract"]["rows"]:
                if a["post_id"] == b["post_id"] and (
                        a["creator_id"] != b["creator_id"] or a["shortcode"] != b["shortcode"]
                        or (a["published_at"] is not None and b["published_at"] is not None
                            and instant(a["published_at"]) != instant(b["published_at"]))):
                    raise ValidationError("post identity conflicts with an earlier import")
                if a["shortcode"] == b["shortcode"] and a["post_id"] != b["post_id"]:
                    raise ValidationError("shortcode conflicts with native identity")
                if a["metric"]["definition_id"] == b["metric"]["definition_id"] and (
                        a["metric"] != b["metric"] or a["counter_kind"] != b["counter_kind"] or c["source_id"] != prepared.receipt["contract"]["source_id"]):
                    raise ValidationError("counter definition conflicts with an earlier import")
                if c["source_id"] == prepared.receipt["contract"]["source_id"] and a["source_record_id"] == b["source_record_id"]:
                    if (a["post_id"], a["observed_at"], a["collected_at"]) != (b["post_id"], b["observed_at"], b["collected_at"]):
                        raise ValidationError("capture identity conflicts with an earlier import")
                    if a["metric"]["definition_id"] == b["metric"]["definition_id"]:
                        raise ValidationError("duplicate capture/definition, including pending rows")
    ledger_path = root / "observations.sqlite"
    ledger = ExportLedger(ledger_path) if ledger_path.exists() else ExportLedger.create(ledger_path)
    # Immutable receipt is written first: a failed ledger transaction is explicitly marked non-admitted on read.
    private_write(receipt_path, prepared.receipt)
    try:
        if prepared.batch:
            ledger.append(prepared.batch)
    except Exception:
        receipt_path.unlink()  # Roll back only the new receipt exclusively created by this call.
        raise
    return {"artifact_id": prepared.receipt["artifact_id"], "ledger_observations": len(prepared.batch.observations) if prepared.batch else 0,
            "pending_temporal_observations": len(prepared.receipt["pending_temporal_observations"])}


def read_receipt(path):
    try:
        receipt = read_json(path)
        if (receipt["artifact_id"] != "export:" + digest(receipt["contract"])
                or Path(path).stem != digest(receipt["contract"])
                or receipt["original_sha256"] != receipt["contract"]["original_sha256"]):
            raise ValidationError("private import receipt integrity failure")
        return receipt
    except (KeyError, TypeError) as exc:
        raise ValidationError("invalid private import receipt") from exc


def import_export(root, contract_path, original_path, permission_path, evidence_path):
    # Serialize cross-artifact identity checks and receipt/ledger admission on macOS/Linux.
    import fcntl
    import os
    root = protected_path(Path(root) / "observations.sqlite").parent
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(root / "import.lock", os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _import_export(root, contract_path, original_path, permission_path, evidence_path)
