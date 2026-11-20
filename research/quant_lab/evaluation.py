"""Offline bridges to existing evaluation concepts, without importing service-bearing runners."""

from pipeline import script_checks
from research.observation_ledger.schema import instant

from .formats import annotations


def script_review_input(annotation):
    """Project only explicit observations into existing format/source check fields.

    This is a partial review input, not a source transcript, generated script or
    a declaration that a new product adaptation should copy the source exactly.
    PR #10's synthetic wrapper is deliberately not called: it stamps synthetic evidence.
    """
    raw = annotation["annotation"]
    f = raw["format"]
    delivery = f["delivery"]
    return {"evidence_type": raw["evidence_type"], "provenance": {"annotation_sha256": annotation["annotation_sha256"],
            "source_id": raw["source_id"], "post_id": raw["post_id"], "evidence_reference": raw["evidence_reference"]},
            "source": {"duration": raw["duration_s"], "script": {"has_speech": True if delivery == "spoken" else False if delivery == "visual" else None}},
            "format": {"beats": [{"role": b["role"], "seconds": b["end_s"] - b["start_s"]} for b in f["beats"]]
                       if f["beats"] else None},
            "limits": "No transcript, brand facts or paired Lynxr script supplied. Semantic fidelity and usefulness require human review."}


def script_diagnostics(adaptation, annotation):
    """Reuse the pure checks underlying PR #10; no inference or live generation."""
    if (not isinstance(adaptation, dict) or adaptation.get("delivery") not in ("spoken", "silent")
            or not all(isinstance(adaptation.get(k), str) for k in ("hook", "cta", "caption"))
            or not isinstance(adaptation.get("beats"), list)
            or not all(isinstance(b, dict) and all(isinstance(b.get(k), str) for k in ("t", "say", "do", "show")) for b in adaptation["beats"])):
        raise ValueError("expected the existing explicit adaptation shape")
    return {"review_input": script_review_input(annotation),
            "deterministic_diagnostics": {"spoken_words": script_checks.shown_words(adaptation),
                                          "hook_repeated": script_checks.hook_repeated(adaptation)},
            "human_review": ["Timing/role fidelity, product truth, source-to-script preservation and filmability remain unscored."],
            "performance_claim": None}


def chronological_annotation_inputs(root, permission_path, cutoff):
    """Freeze only genuinely recorded, currently permitted annotations before cutoff.

    PR #12 still requires synthetic inputs. Never feed these through its synthetic
    guard by changing evidence labels. These neutral feature inputs can be reviewed
    for a future real-data scorer once independent prediction receipts exist.
    """
    cutoff = instant(cutoff)
    selected = [a for a in annotations(root, permission_path)
                if instant(a["recorded_at"]) < cutoff and instant(a["annotation"]["created_at"]) < cutoff]
    return {"cutoff_exclusive": cutoff, "features": selected,
            "evaluation_status": "not_evaluable", "scored_recommendations": 0,
            "reason": "No independently timestamped frozen recommendations or qualifying future-outcome join supplied; no historical score computed."}
