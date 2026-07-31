#!/usr/bin/env python3
"""Tag videos with Claude via the Message Batches API (50% cost, built for bulk).

One request per video. An earlier design batched N videos per request and asked
for an array back — the model would return a valid 1-element array and stop,
silently under-tagging (structured outputs has no minItems). Per-video requests
make coverage verifiable: every custom_id either has a tag object or failed.

Failed/refused requests are automatically retried once via the live API before
writing output. Coverage below 95% is a loud error.

Usage:
    python tag_videos.py --input ../data/x_normalized.csv --output ../output/x_tagged.csv

Resumable: <output>.batch_state.json records the batch ID; re-running polls it
instead of re-submitting. Delete the state file to force a fresh batch.
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
MAX_TOKENS = 2000
POLL_SECONDS = 30

TITLE_COLUMNS = ["Title", "title", "caption", "text", "desc", "description"]
TAG_COLS = ["format_type", "hook_pattern", "niche_category", "target_audience"]

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


def user_content(row, title_col):
    title = (row.get(title_col) or "").strip().replace("\n", " ")[:1000]
    return "Tag this video.\n\nCaption: " + (title or "(no caption)")


def build_requests(rows, title_col):
    return [
        {
            "custom_id": f"v-{i}",
            "params": {
                "model": MODEL,
                "max_tokens": MAX_TOKENS,
                "system": [
                    {"type": "text", "text": SYSTEM_PROMPT,
                     "cache_control": {"type": "ephemeral"}}
                ],
                "output_config": {"format": {"type": "json_schema", "schema": TAG_SCHEMA}},
                "messages": [{"role": "user", "content": user_content(row, title_col)}],
            },
        }
        for i, row in enumerate(rows)
    ]


def submit_or_resume(client, requests, state_path):
    if state_path.exists():
        batch_id = json.loads(state_path.read_text())["batch_id"]
        log.info("Resuming existing batch %s", batch_id)
        return batch_id
    batch = client.messages.batches.create(requests=requests)
    state_path.write_text(json.dumps({"batch_id": batch.id, "n_requests": len(requests)}))
    log.info("Submitted batch %s with %d requests", batch.id, len(requests))
    return batch.id


def wait_for_batch(client, batch_id):
    while True:
        batch = client.messages.batches.retrieve(batch_id)
        c = batch.request_counts
        log.info("Batch %s: %s (processing=%d succeeded=%d errored=%d)",
                 batch_id, batch.processing_status, c.processing, c.succeeded, c.errored)
        if batch.processing_status == "ended":
            return batch
        time.sleep(POLL_SECONDS)


def parse_message(msg):
    if msg.stop_reason == "refusal":
        return None
    text = next((b.text for b in msg.content if b.type == "text"), None)
    return json.loads(text) if text else None


def collect_results(client, batch_id, n_rows):
    tags, failed = {}, []
    for result in client.messages.batches.results(batch_id):
        idx = int(result.custom_id.split("-", 1)[1])
        if not (0 <= idx < n_rows):
            continue
        if result.result.type != "succeeded":
            failed.append(idx)
            continue
        try:
            data = parse_message(result.result.message)
            if data:
                tags[idx] = data
            else:
                failed.append(idx)
        except (ValueError, json.JSONDecodeError):
            failed.append(idx)
    return tags, failed


def retry_live(client, rows, title_col, indices, tags):
    """Second chance for batch failures via the live API."""
    fixed = 0
    for i in indices:
        for attempt in range(3):
            try:
                m = client.messages.create(
                    model=MODEL, max_tokens=MAX_TOKENS,
                    system=[{"type": "text", "text": SYSTEM_PROMPT,
                             "cache_control": {"type": "ephemeral"}}],
                    output_config={"format": {"type": "json_schema", "schema": TAG_SCHEMA}},
                    messages=[{"role": "user", "content": user_content(rows[i], title_col)}],
                )
                data = parse_message(m)
                if data:
                    tags[i] = data
                    fixed += 1
                break
            except Exception:
                if attempt < 2:
                    time.sleep(2 * (attempt + 1))
    return fixed


def write_output(rows, fieldnames, tags, output_path):
    out_fields = list(fieldnames) + [c for c in TAG_COLS if c not in fieldnames]
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=out_fields)
        writer.writeheader()
        for i, row in enumerate(rows):
            t = tags.get(i, {})
            for c in TAG_COLS:
                row[c] = t.get(c, "")
            writer.writerow(row)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    input_path, output_path = Path(args.input), Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    state_path = output_path.with_suffix(output_path.suffix + ".batch_state.json")

    rows, title_col, fieldnames = load_rows(input_path)
    log.info("Loaded %d rows from %s (title column: %s)", len(rows), input_path, title_col)

    client = anthropic.Anthropic()
    batch_id = submit_or_resume(client, build_requests(rows, title_col), state_path)
    wait_for_batch(client, batch_id)
    tags, failed = collect_results(client, batch_id, len(rows))
    if failed:
        log.warning("%d requests failed in batch — retrying live", len(failed))
        fixed = retry_live(client, rows, title_col, failed, tags)
        log.info("Live retry recovered %d/%d", fixed, len(failed))

    coverage = len(tags) / len(rows) * 100 if rows else 0
    log.info("Tagged %d/%d rows (%.1f%% coverage)", len(tags), len(rows), coverage)
    if coverage < 95:
        log.error("LOW COVERAGE (%.1f%%). Delete %s and re-run to retry the batch.",
                  coverage, state_path)

    write_output(rows, fieldnames, tags, output_path)
    log.info("Wrote %s", output_path)


if __name__ == "__main__":
    main()
