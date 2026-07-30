#!/usr/bin/env python3
"""Tag videos with Claude via the Message Batches API (50% cost, built for bulk).

Usage:
    python tag_videos.py --input ../data/medceptor_raw.csv --output ../output/medceptor_tagged.csv

Resumable: a state file (<output>.batch_state.json) records the submitted batch ID.
Re-running the script polls the existing batch instead of re-submitting.
"""

import argparse
import csv
import json
import logging
import sys
import time
from pathlib import Path

import anthropic

from taxonomy import SYSTEM_PROMPT, TAG_SCHEMA

MODEL = "claude-opus-5"
CHUNK_SIZE = 10          # videos per batch request
MAX_TOKENS = 8000
POLL_SECONDS = 60

TITLE_COLUMNS = ["Title", "title", "caption", "text", "desc", "description"]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(Path(__file__).parent.parent / "output" / "tagging.log"),
    ],
)
log = logging.getLogger("tagger")


def find_title_column(fieldnames):
    for col in TITLE_COLUMNS:
        if col in fieldnames:
            return col
    raise SystemExit(f"No title column found. Columns: {fieldnames}")


def load_rows(input_path):
    with open(input_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        title_col = find_title_column(reader.fieldnames)
    return rows, title_col, reader.fieldnames


def build_requests(rows, title_col):
    """Chunk rows into batch requests. Returns list of Request dicts."""
    requests = []
    for start in range(0, len(rows), CHUNK_SIZE):
        chunk = rows[start : start + CHUNK_SIZE]
        lines = []
        for i, row in enumerate(chunk):
            title = (row.get(title_col) or "").strip().replace("\n", " ")[:500]
            lines.append(f"[{start + i}] {title or '(no caption)'}")
        requests.append(
            {
                "custom_id": f"chunk-{start}",
                "params": {
                    "model": MODEL,
                    "max_tokens": MAX_TOKENS,
                    "system": [
                        {
                            "type": "text",
                            "text": SYSTEM_PROMPT,
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                    "output_config": {
                        "format": {"type": "json_schema", "schema": TAG_SCHEMA}
                    },
                    "messages": [
                        {
                            "role": "user",
                            "content": (
                                f"Tag all {len(chunk)} videos below. Your `videos` array "
                                f"MUST contain exactly {len(chunk)} objects — one per input "
                                f"line, using that line's bracketed index. Do not skip any, "
                                f"do not stop early, do not merge duplicates.\n\n"
                                + "\n".join(lines)
                            ),
                        }
                    ],
                },
            }
        )
    return requests


def submit_or_resume(client, requests, state_path):
    if state_path.exists():
        state = json.loads(state_path.read_text())
        batch_id = state["batch_id"]
        log.info("Resuming existing batch %s", batch_id)
        return batch_id
    batch = client.messages.batches.create(requests=requests)
    state_path.write_text(json.dumps({"batch_id": batch.id, "n_requests": len(requests)}))
    log.info("Submitted batch %s with %d requests", batch.id, len(requests))
    return batch.id


def wait_for_batch(client, batch_id):
    while True:
        batch = client.messages.batches.retrieve(batch_id)
        counts = batch.request_counts
        log.info(
            "Batch %s: %s (processing=%d succeeded=%d errored=%d)",
            batch_id, batch.processing_status, counts.processing,
            counts.succeeded, counts.errored,
        )
        if batch.processing_status == "ended":
            return batch
        time.sleep(POLL_SECONDS)


def collect_results(client, batch_id, n_rows):
    """Returns dict index -> tag dict."""
    tags = {}
    errored_chunks = 0
    for result in client.messages.batches.results(batch_id):
        if result.result.type != "succeeded":
            log.warning("Request %s: %s", result.custom_id, result.result.type)
            errored_chunks += 1
            continue
        msg = result.result.message
        if msg.stop_reason == "refusal":
            log.warning("Request %s refused by safety classifier", result.custom_id)
            errored_chunks += 1
            continue
        if msg.stop_reason == "max_tokens":
            log.warning("Request %s truncated (max_tokens)", result.custom_id)
        try:
            text = next(b.text for b in msg.content if b.type == "text")
            data = json.loads(text)
            for v in data.get("videos", []):
                idx = v.get("index")
                if isinstance(idx, int) and 0 <= idx < n_rows:
                    tags[idx] = v
        except (StopIteration, json.JSONDecodeError) as e:
            log.warning("Request %s unparseable: %s", result.custom_id, e)
            errored_chunks += 1
    if errored_chunks:
        log.warning("%d chunks errored/refused — those rows get blank tags", errored_chunks)
    return tags


def write_output(rows, fieldnames, tags, output_path):
    tag_cols = ["format_type", "hook_pattern", "niche_category", "target_audience"]
    out_fields = list(fieldnames) + [c for c in tag_cols if c not in fieldnames]
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=out_fields)
        writer.writeheader()
        for i, row in enumerate(rows):
            t = tags.get(i, {})
            for c in tag_cols:
                row[c] = t.get(c, "")
            writer.writerow(row)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    state_path = output_path.with_suffix(output_path.suffix + ".batch_state.json")

    rows, title_col, fieldnames = load_rows(input_path)
    log.info("Loaded %d rows from %s (title column: %s)", len(rows), input_path, title_col)

    client = anthropic.Anthropic()
    requests = build_requests(rows, title_col)
    batch_id = submit_or_resume(client, requests, state_path)
    wait_for_batch(client, batch_id)
    tags = collect_results(client, batch_id, len(rows))
    coverage = len(tags) / len(rows) * 100 if rows else 0
    log.info("Tagged %d/%d rows (%.1f%% coverage)", len(tags), len(rows), coverage)
    if coverage < 95:
        log.error(
            "LOW COVERAGE: %.1f%% of rows tagged. The model returned fewer results "
            "than requested. Delete %s and re-run to retry.",
            coverage, state_path,
        )

    write_output(rows, fieldnames, tags, output_path)
    log.info("Wrote %s", output_path)


if __name__ == "__main__":
    main()
