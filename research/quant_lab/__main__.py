"""Run with python3 -m research.quant_lab; no runtime dependencies."""

import argparse
import json
import sqlite3
from pathlib import Path

from .analysis import export_bundle
from .data import SHA256, initialize, load, parse_csv, sha
from .server import create_server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "serve", "report", "verify"))
    parser.add_argument("--data-dir", type=Path, default=Path.home() / "Lynxr-Quant-Lab-Data")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    try:
        if args.command == "init":
            source = initialize(args.data_dir)
            print(json.dumps({"database": str(args.data_dir / "catalog.sqlite"), "audit": source["audit"]}, indent=2))
            return 0
        source, records = load(args.data_dir)
        if args.command == "serve":
            if not 1024 <= args.port <= 65535:
                parser.error("choose a port from 1024 to 65535")
            server = create_server(source, records, args.port)
            print(f"Lynxr Quant Lab — http://127.0.0.1:{args.port} (local evaluation only)", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
            return 0
        report = export_bundle(source, records, {})
        if args.command == "verify":
            blob = (args.data_dir / "brightdata-reels.csv").read_bytes()
            expected, audit = parse_csv(blob)
            checks = (sha(blob) == SHA256, source["sha256"] == SHA256, len(records) == 1000,
                      records == expected, source["audit"] == audit, report["summary"]["n"] == 983,
                      report["summary"]["eligible_creator_baselines"] == 0,
                      sum(r["likes"] is None for r in records) == 60,
                      all(r["metric_observed_at"] is None for r in records),
                      report == export_bundle(source, records, {}))
            if not all(checks):
                raise ValueError("real-data verification failed: database/source/report mismatch")
            print("PASS: real sample digest, 1,000 records / 983 clips, unknown clocks, sentinels and reproducible report")
        else:
            print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    except (OSError, ValueError, sqlite3.Error) as exc:
        parser.exit(1, f"Quant Lab: {exc}. Initialize an isolated data directory first.\n")


if __name__ == "__main__":
    raise SystemExit(main())
