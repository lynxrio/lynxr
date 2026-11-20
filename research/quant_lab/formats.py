"""Manual research annotations, explicitly scoped to their licensed evidence modality."""

from pathlib import Path

from research.observation_ledger.schema import choice, digest, exact, instant, text
from research.observation_ledger.store import protected_path

from .authorized import (
    allowed,
    now,
    permission,
    private_write,
    read_json,
    verify_evidence,
)

TAXONOMY = {
    "version": "manual-format-v1",
    "hook_mechanisms": ["question", "problem", "story", "fact", "surprise", "joke", "visual", "other", "none"],
    "modalities": ["spoken", "on_screen_text", "visual", "mixed", "none"],
    "beat_roles": ["hook", "setup", "problem", "demonstration", "explanation", "payoff", "reveal", "cta", "other"],
    "delivery": ["spoken", "visual", "mixed", "none"],
    "pacing": ["slow", "medium", "fast"],
    "cta": ["comment", "follow", "save", "share", "link", "try", "purchase", "other", "none"],
    "unknown": "JSON null means not known; the string none means explicitly observed absence, not a blank.",
}
SCOPES = {"licensed_annotation_review": "licensed_annotation_review", "authorized_video_review": "video_annotation",
          "creator_supplied_annotation": "supplied_annotation"}


def draft(source_id, post_id):
    return {"taxonomy_version": TAXONOMY["version"], "source_id": source_id, "post_id": post_id,
            "creator_id": None, "annotator": None, "created_at": None, "evidence_type": None,
            "evidence_reference": None, "grant_id": None, "duration_s": None,
            "format": {"hook": {"mechanisms": None, "modalities": None, "start_s": None, "end_s": None},
                       "beats": None, "delivery": None, "product_entry_s": None, "reveal_s": None,
                       "pacing": None, "cta": {"kind": None, "modality": None, "at_s": None}}}


def second(value, duration):
    if value is None:
        return None
    if type(value) not in (int, float) or not 0 <= value <= 86400 or (duration is not None and value > duration):
        raise ValueError("invalid time or annotation outside video duration")
    return value


def maybe_choice(value, vocabulary):
    return None if value is None else choice(value, tuple(vocabulary))


def label_set(value, vocabulary):
    if value is None:
        return None
    if (not isinstance(value, list) or not value or any(type(x) is not str for x in value) or len(set(value)) != len(value)
            or any(x not in vocabulary for x in value) or ("none" in value and len(value) > 1)):
        raise ValueError("invalid multi-label annotation; unknown must be null")
    return value


def validate_annotation(raw, grant, posts):
    exact(raw, set(draft("source", "post")))
    if raw["taxonomy_version"] != TAXONOMY["version"] or raw["grant_id"] != grant["grant_id"]:
        raise ValueError("annotation taxonomy or permission mismatch")
    evidence = choice(raw["evidence_type"], tuple(SCOPES))
    if SCOPES[evidence] not in grant["scopes"] or not allowed(grant, raw["creator_id"]):
        raise ValueError("annotation evidence/creator not permitted")
    post = next((p for p in posts if p["source_id"] == raw["source_id"] and p["post_id"] == raw["post_id"]), None)
    if post is None or post["creator_id"] != raw["creator_id"]:
        raise ValueError("annotation identity must match an existing permitted source record")
    if evidence == "licensed_annotation_review" and post["source_id"] != "educational-reels":
        raise ValueError("this source does not have the reviewed annotation license")
    text(raw["annotator"], 200)
    text(raw["evidence_reference"], 500)
    if instant(raw["created_at"]) > now() or instant(raw["created_at"]) < instant(grant["verified_at"]):
        raise ValueError("annotation time must follow permission review and not be in the future")
    duration = second(raw["duration_s"], None)
    if post.get("duration_s") is not None and duration is not None and duration != post["duration_s"]:
        raise ValueError("annotation duration conflicts with linked source")
    f = exact(raw["format"], {"hook", "beats", "delivery", "product_entry_s", "reveal_s", "pacing", "cta"})
    h = exact(f["hook"], {"mechanisms", "modalities", "start_s", "end_s"})
    label_set(h["mechanisms"], TAXONOMY["hook_mechanisms"])
    label_set(h["modalities"], TAXONOMY["modalities"])
    start, end = second(h["start_s"], duration), second(h["end_s"], duration)
    if (start is None) != (end is None) or (start is not None and start >= end):
        raise ValueError("hook needs both ordered boundaries or neither")
    beats = f["beats"]
    if beats is not None:
        if not isinstance(beats, list) or not 1 <= len(beats) <= 100:
            raise ValueError("beats must be null or a nonempty ordered list")
        previous = 0
        for beat in beats:
            exact(beat, {"role", "start_s", "end_s", "modality"})
            choice(beat["role"], tuple(TAXONOMY["beat_roles"]))
            maybe_choice(beat["modality"], TAXONOMY["modalities"])
            a, b = second(beat["start_s"], duration), second(beat["end_s"], duration)
            if a is None or b is None or a < previous or a >= b:
                raise ValueError("beat intervals must be known, ordered and nonoverlapping")
            previous = b
    maybe_choice(f["delivery"], TAXONOMY["delivery"])
    maybe_choice(f["pacing"], TAXONOMY["pacing"])
    second(f["product_entry_s"], duration)
    second(f["reveal_s"], duration)
    cta = exact(f["cta"], {"kind", "modality", "at_s"})
    maybe_choice(cta["kind"], TAXONOMY["cta"])
    maybe_choice(cta["modality"], TAXONOMY["modalities"])
    second(cta["at_s"], duration)
    if evidence == "licensed_annotation_review" and (
            beats is not None or start is not None or f["delivery"] is not None
            or f["product_entry_s"] is not None or f["reveal_s"] is not None
            or cta["at_s"] is not None or cta["modality"] is not None or h["modalities"] is not None):
        raise ValueError("published global labels do not authorize new visual/timecoded claims")
    return raw


def import_annotation(root, input_path, permission_path, evidence_path, posts):
    grant = permission(permission_path)
    verify_evidence(grant, evidence_path)
    raw = validate_annotation(read_json(input_path), grant, posts)
    artifact = {"annotation": raw, "recorded_at": now(), "annotation_sha256": digest(raw)}
    private_write(protected_path(Path(root) / "annotations" / (digest(raw) + ".json")), artifact)
    return {"annotation_sha256": digest(raw), "source_id": raw["source_id"], "post_id": raw["post_id"]}


def annotations(root, permission_path):
    grant = permission(permission_path)
    result = []
    for path in sorted((Path(root) / "annotations").glob("*.json")):
        artifact = read_json(path)
        a = artifact["annotation"]
        if artifact["annotation_sha256"] != digest(a) or path.stem != digest(a):
            raise ValueError("annotation artifact digest mismatch")
        if (a["grant_id"] == grant["grant_id"] and allowed(grant, a["creator_id"])
                and SCOPES.get(a["evidence_type"]) in grant["scopes"]):
            result.append(artifact)
    return result
