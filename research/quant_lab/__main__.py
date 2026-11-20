"""Run with python3 -m research.quant_lab; no runtime dependencies."""

import argparse
import json
import sqlite3
from pathlib import Path

from .analysis import export_bundle
from .comparisons import research_report
from .data import SHA256, initialize, load, parse_csv, sha
from .educational import WORKBOOK_SHA, expand, parse_workbook
from .server import create_server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "expand", "serve", "report", "verify", "research", "verify-expanded", "import-analytics", "annotate", "intelligence"))
    parser.add_argument("--data-dir", type=Path, default=Path.home() / "Lynxr-Quant-Lab-Data")
    parser.add_argument("--base-data-dir", type=Path)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--research-dir", type=Path)
    parser.add_argument("--permissions", type=Path)
    parser.add_argument("--permission-evidence", type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--original", type=Path)
    parser.add_argument("--cutoff", help="Exclusive real-workspace availability cutoff; actual local recording required")
    args = parser.parse_args()
    try:
        if args.command in ("import-analytics", "annotate"):
            if not all((args.research_dir, args.permissions, args.permission_evidence, args.input)):
                parser.error("import/annotation requires --research-dir --permissions --permission-evidence --input")
            if args.command == "import-analytics":
                from .authorized import import_export
                if args.original is None:
                    parser.error("import-analytics requires the --original permitted export")
                print(json.dumps(import_export(args.research_dir, args.input, args.original,
                                               args.permissions, args.permission_evidence), indent=2))
            else:
                from .formats import import_annotation
                from .intelligence import annotation_posts
                _source, records = load(args.data_dir)
                posts = annotation_posts(records, args.research_dir, args.permissions)
                print(json.dumps(import_annotation(args.research_dir, args.input, args.permissions,
                                                   args.permission_evidence, posts), indent=2))
            return 0
        if args.command == "init":
            source = initialize(args.data_dir)
            print(json.dumps({"database": str(args.data_dir / "catalog.sqlite"), "audit": source["audit"]}, indent=2))
            return 0
        if args.command == "expand":
            if args.base_data_dir is None:
                parser.error("expand requires --base-data-dir with the existing verified real catalog")
            print(json.dumps(expand(args.data_dir, args.base_data_dir), indent=2))
            return 0
        source, records = load(args.data_dir)
        if args.command == "intelligence":
            from .intelligence import report
            print(json.dumps(report(source, records, args.research_dir, args.permissions, args.cutoff), ensure_ascii=False, indent=2))
            return 0
        if args.command in ("research", "verify-expanded"):
            report = research_report(source, records)
            if args.command == "research":
                print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
                return 0
            blob = (args.data_dir / "sources" / "educational-reels.xlsx").read_bytes()
            expected = parse_workbook(blob)
            actual = [r for r in records if r.get("source_id") == "educational-reels"]
            primary = [r for r in records if r.get("source_id") == "brightdata-reels"]
            original_blob = (args.data_dir / "sources" / "brightdata-reels.csv").read_bytes()
            original_rows, _audit = parse_csv(original_blob)
            original_projection = [{**r, "source_id": "brightdata-reels", "publication_precision": "timestamp_utc"} for r in original_rows]
            if (sha(original_blob) != SHA256 or primary != original_projection or sha(blob) != WORKBOOK_SHA or expected != actual or len(primary) != 1000
                    or report["real_reels_total"] != 1283 or len(report["example_pairs"]) != 3
                    or report != research_report(source, records)):
                raise ValueError("expanded real-data verification failed")
            print("PASS: 300 genuine annotated Reels / 21 accounts + 983 original Reels, six inspectable examples, reproducible source-separated research")
            return 0
        if args.command == "serve":
            if not 1024 <= args.port <= 65535:
                parser.error("choose a port from 1024 to 65535")
            if bool(args.research_dir) != bool(args.permissions):
                parser.error("--research-dir and --permissions must be supplied together")
            server = create_server(source, records, args.port, args.research_dir, args.permissions)
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
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
        parser.exit(1, "Quant Lab: input, permission or data validation failed; no private payload is logged. Initialize an isolated catalog for catalog commands.\n")


if __name__ == "__main__":
    raise SystemExit(main())
