"""Offline synthetic ledger CLI. No network, credentials or production modules."""

import argparse
import json
import sqlite3
import tempfile
from pathlib import Path

from .schema import read_batch
from .store import Ledger

FIXTURE = Path(__file__).parent / "fixtures" / "walk_forward.json"


def example() -> dict:
    batch = read_batch(FIXTURE)
    with tempfile.TemporaryDirectory(prefix="lynxr-synthetic-ledger-") as directory:
        ledger = Ledger.create(Path(directory) / "example.sqlite")
        ledger.append(batch)
        windows = []
        for cutoff in ("2025-01-05T00:00:00Z", "2025-01-12T00:00:00Z", "2025-01-19T00:00:00Z"):
            result = ledger.as_of(cutoff, definition_id="syn:views-v1", knowledge="availability_simulation", age_ms=172800000)
            windows.append({"cutoff_exclusive": result["cutoff_exclusive"], "definition_id": result["definition_id"],
                            "missingness": result["missingness"], "permission_states": result["permission_states"],
                            "observations": [{k: row["observation"][k] for k in
                                              ("observation_id", "post_id", "observed_at", "available_at", "value", "missingness")}
                                             for row in result["rows"]],
                            "recorded_mode_rows_at_this_past_cutoff": len(ledger.as_of(cutoff, definition_id="syn:views-v1")["rows"])})
        changed = ledger.as_of("2025-01-19T00:00:00Z", definition_id="syn:views-v2", knowledge="availability_simulation", age_ms=172800000)
        return {"evidence_type": "synthetic_fixture", "mode": "availability_simulation_not_contemporaneous_history",
                "fixture_payload_sha256": batch.payload_sha256, "imported_observations": ledger.verify()["observations"],
                "measurement_age_ms": 172800000, "walk_forward": windows,
                "separate_v2_observation_ids": [r["observation"]["observation_id"] for r in changed["rows"]],
                "interpretation": "Invented data validates temporal queries only; no real observations, predictions or performance evaluated."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("create", "import", "query", "verify", "example"))
    parser.add_argument("--ledger", type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--definition")
    parser.add_argument("--cutoff")
    parser.add_argument("--knowledge", choices=("recorded", "availability_simulation"), default="recorded")
    parser.add_argument("--latest", action="store_true")
    parser.add_argument("--age-ms", type=int)
    args = parser.parse_args()
    try:
        if args.command == "example":
            result = example()
        else:
            if args.ledger is None:
                parser.error("--ledger is required outside the temporary example")
            if args.command == "create":
                result = Ledger.create(args.ledger).verify()
            else:
                ledger = Ledger(args.ledger)
                if args.command == "verify":
                    result = ledger.verify()
                elif args.command == "import":
                    if args.input is None:
                        parser.error("--input must name an explicit synthetic fixture")
                    result = {"evidence_type": "synthetic_fixture", "appended": ledger.append(read_batch(args.input)), **ledger.verify()}
                else:
                    if args.cutoff is None or args.definition is None:
                        parser.error("--cutoff and --definition are required")
                    result = ledger.as_of(args.cutoff, definition_id=args.definition, knowledge=args.knowledge,
                                          latest=args.latest, age_ms=args.age_ms)
        print(json.dumps(result, sort_keys=True, ensure_ascii=False, allow_nan=False, indent=2))
        return 0
    except (OSError, ValueError, sqlite3.Error):
        parser.exit(1, "Synthetic ledger operation rejected; check the schema, temporal constraints, identities and ledger path.\n")


if __name__ == "__main__":
    raise SystemExit(main())
