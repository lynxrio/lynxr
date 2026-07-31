#!/usr/bin/env python3
"""Eliminate Other/blank tags from the master database.

Implements the mining workflow's plan, cheapest evidence first:
  1. Snapshot the master (it must not move under us).
  2. MECHANICAL pass (free, watch-equivalent evidence):
     a. Caption canonicalization — cross-platform reposts share a normalized
        caption; confident tags transfer to Other/blank duplicates, and
        conflicting duplicate groups resolve to the majority confident value.
     b. Students fix — exam-prep captions systematically mislabeled
        Healthcare Professionals become Students.
  3. LLM pass — every row still carrying Other/blank in any dimension goes
     through the forced-choice tagger (Batches API + live retry), with source
     context and creator-modal format hints so hashtag-only captions resolve.
     Only the deficient dimensions are overwritten.
  4. Rewrite master + data_summary.txt, print before/after Other counts.

Run: ./venv/bin/python pipeline/retag_others.py   (needs ANTHROPIC_API_KEY)
"""

import csv
import json
import logging
import re
import shutil
import sys
import time
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import anthropic

sys.path.insert(0, str(Path(__file__).parent))
from taxonomy import SYSTEM_PROMPT, TAG_SCHEMA
from merge_data import MASTER_FIELDS, summarize, to_int

ROOT = Path(__file__).parent.parent
MASTER = ROOT / "output" / "master_video_database.csv"
DIMS = ["format_type", "hook_pattern", "niche_category", "target_audience"]
MODEL = "claude-opus-5"

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout),
              logging.FileHandler(ROOT / "output" / "retag.log")],
)
log = logging.getLogger("retag")

STUDENT_RE = re.compile(
    r"nremt|nclex|emt ?school|emtschool|emt ?student|nursing ?school|studytok|study ?tip",
    re.I,
)


def norm_caption(t):
    t = re.sub(r"[#@]\S+", " ", str(t or ""))
    t = re.sub(r"[^\w\s']", " ", t.lower())
    return re.sub(r"\s+", " ", t).strip()


def deficient(r, dim):
    v = (r.get(dim) or "").strip()
    return v == "" or v == "Other"


def mechanical_pass(rows):
    transferred = canonicalized = students_fixed = 0

    # a. caption groups
    groups = defaultdict(list)
    for i, r in enumerate(rows):
        k = norm_caption(r["title"])
        if len(k) >= 4:
            groups[k].append(i)

    for idxs in groups.values():
        if len(idxs) < 2:
            continue
        for dim in DIMS:
            confident = Counter(
                rows[i][dim] for i in idxs if not deficient(rows[i], dim))
            if not confident:
                continue
            winner, _ = confident.most_common(1)[0]
            for i in idxs:
                if deficient(rows[i], dim):
                    rows[i][dim] = winner
                    transferred += 1
                elif rows[i][dim] != winner and len(confident) > 1:
                    rows[i][dim] = winner
                    canonicalized += 1

    # b. Students fix
    for r in rows:
        if r["target_audience"] == "Healthcare Professionals" and STUDENT_RE.search(r["title"] or ""):
            r["target_audience"] = "Students"
            students_fixed += 1

    log.info("mechanical: %d tags transferred, %d conflicts canonicalized, %d Students fixed",
             transferred, canonicalized, students_fixed)


def creator_modal_formats(rows):
    by_creator = defaultdict(Counter)
    for r in rows:
        if not deficient(r, "format_type"):
            by_creator[r["creator"]][r["format_type"]] += 1
    modal = {}
    for creator, counts in by_creator.items():
        val, n = counts.most_common(1)[0]
        if n >= 3 and n / sum(counts.values()) >= 0.5:
            modal[creator] = val
    return modal


def user_content(r, modal):
    title = (r["title"] or "").strip().replace("\n", " ")[:1000]
    ctx = [f"Platform: {r['platform']}",
           "Source: Medceptor campaign" if r["data_source"] == "Medceptor" else "Source: organic scrape"]
    if r["creator"] in modal:
        ctx.append(f"Creator-modal format (from their other tagged videos): {modal[r['creator']]}")
    return "Tag this video.\n\n" + "\n".join(ctx) + "\n\nCaption: " + (title or "(no caption)")


def llm_pass(rows):
    todo = [i for i, r in enumerate(rows) if any(deficient(r, d) for d in DIMS)]
    log.info("LLM pass: %d rows need at least one dimension", len(todo))
    if not todo:
        return

    modal = creator_modal_formats(rows)
    client = anthropic.Anthropic()
    state_path = ROOT / "output" / "retag.batch_state.json"

    if state_path.exists():
        batch_id = json.loads(state_path.read_text())["batch_id"]
        log.info("Resuming batch %s", batch_id)
    else:
        requests = [
            {"custom_id": f"r-{i}",
             "params": {
                 "model": MODEL, "max_tokens": 2000,
                 "system": [{"type": "text", "text": SYSTEM_PROMPT,
                             "cache_control": {"type": "ephemeral"}}],
                 "output_config": {"format": {"type": "json_schema", "schema": TAG_SCHEMA}},
                 "messages": [{"role": "user", "content": user_content(rows[i], modal)}],
             }}
            for i in todo
        ]
        batch = client.messages.batches.create(requests=requests)
        state_path.write_text(json.dumps({"batch_id": batch.id, "n": len(requests)}))
        batch_id = batch.id
        log.info("Submitted batch %s (%d requests)", batch_id, len(requests))

    while True:
        b = client.messages.batches.retrieve(batch_id)
        c = b.request_counts
        log.info("batch %s: processing=%d succeeded=%d errored=%d",
                 b.processing_status, c.processing, c.succeeded, c.errored)
        if b.processing_status == "ended":
            break
        time.sleep(30)

    applied, failed = 0, []
    for result in client.messages.batches.results(batch_id):
        i = int(result.custom_id.split("-", 1)[1])
        data = None
        if result.result.type == "succeeded":
            msg = result.result.message
            if msg.stop_reason != "refusal":
                text = next((b_.text for b_ in msg.content if b_.type == "text"), None)
                try:
                    data = json.loads(text) if text else None
                except json.JSONDecodeError:
                    data = None
        if not data:
            failed.append(i)
            continue
        for dim in DIMS:
            if deficient(rows[i], dim):
                rows[i][dim] = data[dim]
        applied += 1

    # live retries for stragglers
    for i in failed:
        for attempt in range(3):
            try:
                m = client.messages.create(
                    model=MODEL, max_tokens=2000,
                    system=[{"type": "text", "text": SYSTEM_PROMPT,
                             "cache_control": {"type": "ephemeral"}}],
                    output_config={"format": {"type": "json_schema", "schema": TAG_SCHEMA}},
                    messages=[{"role": "user", "content": user_content(rows[i], modal)}],
                )
                if m.stop_reason != "refusal":
                    data = json.loads(next(b_.text for b_ in m.content if b_.type == "text"))
                    for dim in DIMS:
                        if deficient(rows[i], dim):
                            rows[i][dim] = data[dim]
                    applied += 1
                break
            except Exception:
                if attempt < 2:
                    time.sleep(2 * (attempt + 1))
    log.info("LLM pass applied to %d/%d rows (%d unrecovered)",
             applied, len(todo), len(todo) - applied)


def other_counts(rows):
    return {d: sum(1 for r in rows if deficient(r, d)) for d in DIMS}


def main():
    snap = MASTER.with_name(f"master_snapshot_{date.today().isoformat()}.csv")
    if not snap.exists():
        shutil.copy(MASTER, snap)
        log.info("snapshot -> %s", snap.name)

    rows = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))
    log.info("loaded %d rows; Other/blank before: %s", len(rows), other_counts(rows))

    mechanical_pass(rows)
    log.info("after mechanical: %s", other_counts(rows))
    llm_pass(rows)
    after = other_counts(rows)
    log.info("after LLM: %s", after)

    with open(MASTER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=MASTER_FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    for r in rows:
        r["views"] = to_int(r["views"])
        r.setdefault("_url", r.get("url", ""))
    (ROOT / "output" / "data_summary.txt").write_text(summarize(rows, 0) + "\n")
    log.info("master rewritten (%d rows); DONE", len(rows))


if __name__ == "__main__":
    main()
