"""Typed, strict synthetic-only import contract. No coercion of unknown metrics."""

import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass, fields
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import ClassVar, Literal

Platform = Literal["instagram", "tiktok", "youtube"]
Knowledge = Literal["recorded", "availability_simulation"]
PermissionStatus = Literal["granted", "denied", "unknown", "withdrawn"]
Missingness = Literal["observed", "not_reported", "hidden", "unavailable", "deleted", "collection_failed", "permission_denied"]
PostStatus = Literal["available", "unknown", "private", "unavailable", "deleted"]
MAX_BYTES = 4_000_000


class ValidationError(ValueError):
    """Reject an input or integrity failure without echoing its payload."""


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def exact(value: object, names: set[str]) -> dict:
    if type(value) is not dict or set(value) != names:
        raise ValidationError("missing, extra or invalid schema fields")
    return value


def text(value: object, maximum: int = 500) -> str:
    if type(value) is not str or not value.strip() or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise ValidationError("invalid text field")
    return value


def synthetic_id(value: object) -> str:
    if type(value) is not str or not re.fullmatch(r"syn:[a-z0-9][a-z0-9._-]{0,79}", value):
        raise ValidationError("all identities and evidence references must be synthetic syn: identifiers")
    return value


def choice(value: object, allowed: tuple[str, ...]) -> str:
    if type(value) is not str or value not in allowed:
        raise ValidationError("invalid enum value")
    return value


def integer(value: object) -> int:
    if type(value) is not int or not 0 <= value <= 2**63 - 1:
        raise ValidationError("expected a nonnegative signed-64-bit integer")
    return value


def instant(value: object) -> str:
    try:
        if type(value) is not str:
            raise ValidationError("timestamp must be an explicit timezone-aware string")
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None or dt.utcoffset() is None or dt.microsecond % 1000:
            raise ValidationError("timestamp requires timezone and millisecond-or-coarser precision")
        return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError) as exc:
        raise ValidationError("invalid timestamp") from exc


def milliseconds(start: str, end: str) -> int:
    return (datetime.fromisoformat(end) - datetime.fromisoformat(start)) // timedelta(milliseconds=1)


def version(value: object) -> int:
    if type(value) is not int or value != 1:
        raise ValidationError("unsupported schema version")
    return value


@dataclass(frozen=True)
class MetricDefinition:
    identity: ClassVar = staticmethod(synthetic_id)
    semantics_prefix: ClassVar[str] = "SYNTHETIC: "
    definition_id: str
    name: str
    version: str
    unit: Literal["count", "seconds", "ratio"]
    definition: str

    @classmethod
    def parse(cls, value: object) -> "MetricDefinition":
        v = exact(value, {f.name for f in fields(cls)})
        definition = text(v["definition"])
        if not definition.startswith(cls.semantics_prefix):
            raise ValidationError("metric semantics require the declared evidence prefix")
        return cls(cls.identity(v["definition_id"]), text(v["name"], 80), cls.identity(v["version"]),
                   choice(v["unit"], ("count", "seconds", "ratio")), definition)


@dataclass(frozen=True)
class Source:
    identity: ClassVar = staticmethod(synthetic_id)
    methods: ClassVar = ("invented_fixture",)
    source_id: str
    source_record_id: str
    artifact_id: str
    evidence_ref: str
    method: Literal["invented_fixture"]

    @classmethod
    def parse(cls, value: object) -> "Source":
        v = exact(value, {f.name for f in fields(cls)})
        return cls(*(cls.identity(v[k]) for k in ("source_id", "source_record_id", "artifact_id", "evidence_ref")),
                   choice(v["method"], cls.methods))


@dataclass(frozen=True)
class Permission:
    identity: ClassVar = staticmethod(synthetic_id)
    purposes: ClassVar = ("synthetic_research_only",)
    status: PermissionStatus
    purpose: Literal["synthetic_research_only"]
    evidence_ref: str
    available_at: str

    @classmethod
    def parse(cls, value: object) -> "Permission":
        v = exact(value, {f.name for f in fields(cls)})
        return cls(choice(v["status"], ("granted", "denied", "unknown", "withdrawn")),
                   choice(v["purpose"], cls.purposes), cls.identity(v["evidence_ref"]),
                   instant(v["available_at"]))


def metric_value(v, metric, permission):
    missing = choice(v["missingness"], ("observed", "not_reported", "hidden", "unavailable", "deleted", "collection_failed", "permission_denied"))
    status = choice(v["post_status"], ("available", "unknown", "private", "unavailable", "deleted"))
    number = v["value"]
    if number is None:
        if missing == "observed":
            raise ValidationError("null metric requires explicit missingness")
    else:
        if metric.unit == "count":
            number = integer(number)
        elif type(number) not in (int, float) or not 0 <= number <= 1e100 or not math.isfinite(number):
            raise ValidationError("invalid numeric metric")
        if missing != "observed" or permission.status != "granted" or status not in ("available", "unknown"):
            raise ValidationError("a usable value conflicts with missingness, permission or post status")
    if status == "deleted" and missing != "deleted":
        raise ValidationError("deleted post requires a null deletion marker")
    if status in ("private", "unavailable") and missing != "unavailable":
        raise ValidationError("unavailable post requires a null unavailable marker")
    if missing == "deleted" and status != "deleted":
        raise ValidationError("deletion missingness conflicts with post status")
    if missing == "permission_denied" and permission.status == "granted":
        raise ValidationError("permission missingness conflicts with granted permission")
    return number, missing, status


@dataclass(frozen=True)
class Observation:
    identity: ClassVar = staticmethod(synthetic_id)
    evidence: ClassVar = "synthetic_fixture"
    metric_type: ClassVar = MetricDefinition
    source_type: ClassVar = Source
    permission_type: ClassVar = Permission
    schema_version: Literal[1]
    evidence_type: Literal["synthetic_fixture"]
    observation_id: str
    platform: Platform
    creator_id: str
    post_id: str
    published_at: str
    observed_at: str
    collected_at: str
    extracted_at: str
    available_at: str
    measurement_age_ms: int
    metric: MetricDefinition
    value: int | float | None
    missingness: Missingness
    post_status: PostStatus
    source: Source
    permission: Permission
    extraction_version: str
    analysis_version: str

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def parse(cls, value: object) -> "Observation":
        v = exact(value, {f.name for f in fields(cls)})
        times = {k: instant(v[k]) for k in ("published_at", "observed_at", "collected_at", "extracted_at", "available_at")}
        if not times["published_at"] <= times["observed_at"] <= times["collected_at"] <= times["extracted_at"] <= times["available_at"]:
            raise ValidationError("invalid publication/observation/collection/extraction/availability sequence")
        age = integer(v["measurement_age_ms"])
        if age != milliseconds(times["published_at"], times["observed_at"]):
            raise ValidationError("measurement age conflicts with source clocks")
        metric, source, permission = cls.metric_type.parse(v["metric"]), cls.source_type.parse(v["source"]), cls.permission_type.parse(v["permission"])
        if permission.available_at > times["available_at"]:
            raise ValidationError("permission was not known at row availability")
        number, missing, status = metric_value(v, metric, permission)
        return cls(version(v["schema_version"]), choice(v["evidence_type"], (cls.evidence,)),
                   cls.identity(v["observation_id"]), choice(v["platform"], ("instagram", "tiktok", "youtube")),
                   cls.identity(v["creator_id"]), cls.identity(v["post_id"]), **times,
                   measurement_age_ms=age, metric=metric, value=number, missingness=missing, post_status=status,
                   source=source, permission=permission, extraction_version=cls.identity(v["extraction_version"]),
                   analysis_version=cls.identity(v["analysis_version"]))


@dataclass(frozen=True)
class Batch:
    identity: ClassVar = staticmethod(synthetic_id)
    evidence: ClassVar = "synthetic_fixture"
    observation_type: ClassVar = Observation
    artifact_id: str
    payload_sha256: str
    raw_payload_json: str
    observations: tuple[Observation, ...]

    @classmethod
    def parse(cls, value: object) -> "Batch":
        v = exact(value, {"schema_version", "evidence_type", "artifact_id", "payload_sha256", "observations"})
        version(v["schema_version"])
        choice(v["evidence_type"], (cls.evidence,))
        aid = cls.identity(v["artifact_id"])
        raw = v["observations"]
        if type(raw) is not list or not 1 <= len(raw) <= 10000:
            raise ValidationError("expected 1..10000 observations")
        try:
            payload = canonical(raw)
        except (TypeError, ValueError) as exc:
            raise ValidationError("non-JSON or nonfinite payload") from exc
        if digest(raw) != v["payload_sha256"]:
            raise ValidationError("artifact payload digest mismatch")
        rows = tuple(cls.observation_type.parse(r) for r in raw)
        if any(r.source.artifact_id != aid for r in rows):
            raise ValidationError("source provenance points to another artifact")
        return cls(aid, digest(raw), payload, rows)


def _object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError("duplicate JSON object key")
        result[key] = value
    return result


def read_batch(path: Path) -> Batch:
    with path.open("rb") as stream:
        blob = stream.read(MAX_BYTES + 1)
    if len(blob) > MAX_BYTES:
        raise ValidationError("fixture exceeds input size limit")
    return Batch.parse(json.loads(blob, object_pairs_hook=_object))
