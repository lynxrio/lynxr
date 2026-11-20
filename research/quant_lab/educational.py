"""Import one licensed, genuine annotated-Reels workbook. Never fetch media."""

import io
import json
import re
import sqlite3
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

from .data import SHA256 as BASE_SHA
from .data import canonical, duration_bin, load, original_url, parse_csv, sha

SOURCE_ID = "educational-reels"
DOI = "https://doi.org/10.5281/zenodo.23301344"
WORKBOOK_URL = "https://zenodo.org/api/records/23301344/files/Reels%20analysis.xlsx/content"
WORKBOOK_SHA = "134a35bfd11252c60fa56ff3c7b72faaceb5450d0dfbbf210b7b1bb7c55add16"
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
ANNOTATIONS = {"topic": "H", "source_credibility": "I", "source_provided": "J", "emotional_appeal": "K",
               "hook_type": "L", "introduction": "N", "logical_flow": "O", "clear_ending": "P", "cta": "Q",
               "top_comment_type": "R", "pinned_comment": "S", "comment_bait": "T", "dm_automation": "U",
               "creator_replies": "V", "creator_likes_comments": "W", "auto_reply": "X", "resource_offered": "Y",
               "delivery_style": "Z", "subtitles": "AA", "text_overlays": "AB", "editing_pace": "AC",
               "music": "AD", "visual_examples": "AE", "information_density": "AF", "visual_support": "AG",
               "segmentation": "AH", "absence_of_extraneous_elements": "AI", "education_value": "AL",
               "attention_retention_potential": "AM", "content_execution_quality": "AN"}


def workbook_rows(blob):
    # Fixed, digest-pinned data source. Read cell values only: never run Excel formulas/macros.
    if sha(blob) != WORKBOOK_SHA:
        raise ValueError("annotated workbook digest mismatch")
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        if sum(z.file_size for z in archive.infolist()) > 10_000_000:
            raise ValueError("workbook exceeds uncompressed size limit")
        strings = ["".join(e.itertext()) for e in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("s:si", NS)]
        rows = []
        for row in ET.fromstring(archive.read("xl/worksheets/sheet2.xml")).findall("s:sheetData/s:row", NS):
            cells = {}
            for cell in row.findall("s:c", NS):
                if cell.find("s:f", NS) is not None:
                    raise ValueError("unexpected formula in source observations")
                value = cell.find("s:v", NS)
                if value is not None:
                    cells[re.sub(r"\d", "", cell.attrib["r"])] = strings[int(value.text)] if cell.get("t") == "s" else value.text
            if int(row.attrib["r"]) >= 3 and cells.get("C"):
                rows.append((int(row.attrib["r"]), cells))
        return rows


def compact_counter(value):
    if value is None or not str(value).strip():
        return None
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([KM]?)", str(value).strip(), re.IGNORECASE)
    if not match:
        raise ValueError("unrecognized published counter")
    number = Decimal(match[1]) * {"": 1, "K": 1000, "M": 1000000}[match[2].upper()]
    if number != number.to_integral_value() or number > 2**53 - 1:
        raise ValueError("invalid published counter")
    return int(number)


def excel_date(value):
    number = Decimal(value)
    if number != number.to_integral_value() or not 40000 <= number <= 60000:
        raise ValueError("invalid source calendar date")
    return (datetime(1899, 12, 30) + timedelta(days=int(number))).date()


def displayed_seconds(value):
    if value is None:
        return None
    # Author's report p3: stored hh:mm:ss means mm:ss. 01:39:00 means 99s.
    return round(float(value) * 1440, 6)


def parse_workbook(blob):
    result, seen = [], set()
    for line, cells in workbook_rows(blob):
        url = urlsplit(cells["C"])
        code = url.path.rstrip("/").split("/")[-1]
        clean = original_url("https://" + url.netloc + url.path, code)
        if url.scheme != "https" or code in seen:
            raise ValueError("duplicate or invalid annotated Reel identity")
        seen.add(code)
        published, coded = excel_date(cells["F"]), excel_date(cells["A"])
        age = (coded - published).days
        if age < 0:
            raise ValueError("coding date precedes publication")
        views, comments = compact_counter(cells.get("AJ")), compact_counter(cells.get("AK"))
        length, hook = displayed_seconds(cells.get("G")), displayed_seconds(cells.get("M"))
        if length is None or length <= 0 or hook is not None and not 0 <= hook <= length:
            raise ValueError("invalid annotated duration")
        annotations = {name: cells.get(column) for name, column in ANNOTATIONS.items()}
        annotations["hook_duration_seconds"] = hook
        result.append({"id": code, "post_id": None, "creator": cells["D"], "url": clean,
                       "published_at": published.isoformat(), "publication_precision": "calendar_day_timezone_unspecified",
                       "caption": "", "hashtags": [], "views": views, "likes": None, "num_comments": comments,
                       "video_play_count": None, "duration": length, "duration_bin": duration_bin(length),
                       "product_type": "clips", "caption_cue": "No caption supplied", "cue_evidence": "not_available",
                       "engagement_per_view": None, "comments_per_1000_views": comments * 1000 / views if views and comments is not None else None,
                       "metric_observed_at": None, "metric_observed_date": coded.isoformat(),
                       "metric_observation_precision": "calendar_day_timezone_unspecified",
                       "metric_collected_at": None, "age_calendar_days": age, "availability": "unknown",
                       "thumbnail_supplied": False, "source_rows": [line], "source_id": SOURCE_ID,
                       "source_study_id": compact_counter(cells["B"]), "followers": compact_counter(cells.get("E")),
                       "counter_text": {"views": cells.get("AJ"), "comments": cells.get("AK"), "followers": cells.get("E")},
                       "counter_definition": "Author-recorded displayed Instagram views; rounded K/M values expanded; exact platform semantics unverified.",
                       "annotations": annotations, "annotation_evidence": "third_party_single_human_coder_not_independently_reannotated",
                       "source_cells": cells, "quality": {"likes": "not_supplied", "plays": "not_supplied",
                                                              "observation_time": "date_only", "counters": "may_be_rounded"},
                       "evidence_type": "published_human_coded_real_reels_not_independently_verified"})
    if len(result) != 300 or len({r["creator"] for r in result}) != 21:
        raise ValueError("published workbook inventory changed")
    return sorted(result, key=lambda r: r["id"])


def source_receipt(downloaded_at):
    return {"source_id": SOURCE_ID, "name": "Educational Instagram Reels · Tvorogov (2026)",
            "title": "Educational Instagram Reels: Coded Dataset of 300 Reels from 21 Accounts, with Codebook and Technical Report",
            "author": "Grigorii Tvorogov", "version": "1.0", "repository": DOI, "commit": "Zenodo record 23301344 v1.0",
            "download_url": WORKBOOK_URL, "sha256": WORKBOOK_SHA, "downloaded_at": downloaded_at,
            "repository_published_at": "2026-10-11", "publication_time_meaning": "Dataset publication date, not source measurement instant",
            "metric_observed_at": None, "metric_collected_at": None, "coding_date_range": ["2026-09-02", "2026-10-01"],
            "listing_frame": "Feed-discovered saved educational Reels selected accounts; newest-first account sampling; skipped noneducational posts unrecorded.",
            "rights": {"purpose": "licensed_metadata_and_annotations_research", "license": "CC BY 4.0",
                       "policy_url": "https://creativecommons.org/licenses/by/4.0/", "terms_url": DOI,
                       "reviewed_on": "2026-11-20", "redistribution_allowed": True, "media_fetch_allowed": False},
            "attribution": "Grigorii Tvorogov (2026), Educational Instagram Reels, v1.0, doi:10.5281/zenodo.23301344, CC BY 4.0. Changes: source-linked catalog projection, date/counter/duration conversion and descriptive analysis. No endorsement.",
            "transformations": ["Removed URL tracking query", "Excel date serial to calendar date, no timezone invented",
                                "Author-documented hh:mm:ss-as-mm:ss to seconds (report p3)", "Expanded displayed K/M counts; retained original text",
                                "Retained None as feature-absence category, not missing"],
            "limitations": ["Single coder, not fully blinded; no inter-rater reliability", "Purposive accounts and incomplete skipped/deleted-post accounting",
                            "One snapshot per post, variable ages; date precision only", "Rounded counters; no exact measurement clock or native creator ID",
                            "Human retention-potential rating is not observed audience retention", "No video media licensed or fetched"],
            "audit": {"raw_rows": 300, "admitted_rows": 300, "quarantined_rows": 0, "creators": 21}, "schema_version": 2}


def expand(directory, base_directory):
    directory, base_directory = Path(directory).expanduser().resolve(), Path(base_directory).expanduser().resolve()
    if directory == base_directory or any((p / ".git").exists() for p in (directory, *directory.parents)):
        raise ValueError("expanded research data must be outside Git and separate from the base data directory")
    base_source, base_records = load(base_directory)
    raw = (base_directory / "brightdata-reels.csv").read_bytes()
    expected, _audit = parse_csv(raw)
    if sha(raw) != BASE_SHA or expected != base_records or base_source["sha256"] != BASE_SHA:
        raise ValueError("original catalog differs from pinned real source")
    folder = directory / "sources"
    folder.mkdir(parents=True, exist_ok=True)
    base_copy = folder / "brightdata-reels.csv"
    if base_copy.exists() and sha(base_copy.read_bytes()) != BASE_SHA:
        raise ValueError("cached original-source digest mismatch")
    if not base_copy.exists():
        base_copy.write_bytes(raw)
    path, receipt_path = folder / "educational-reels.xlsx", folder / "educational-receipt.json"
    downloaded_now = None
    if not path.exists():
        with urllib.request.urlopen(WORKBOOK_URL, timeout=40) as response:
            blob = response.read(500_001)
        if sha(blob) != WORKBOOK_SHA:
            raise ValueError("download digest mismatch")
        path.write_bytes(blob)
        downloaded_now = datetime.now(UTC).isoformat()
    blob = path.read_bytes()
    new_records = parse_workbook(blob)
    if receipt_path.exists():
        secondary = json.loads(receipt_path.read_text())
        if secondary["sha256"] != WORKBOOK_SHA:
            raise ValueError("source receipt mismatch")
    else:
        # Preserve the earlier authorized research download receipt if present.
        downloads = json.loads((folder / "downloads.json").read_text()) if (folder / "downloads.json").exists() else []
        receipt = next((r for r in downloads if r["file"] == path.name and r["sha256"] == WORKBOOK_SHA), None)
        secondary = source_receipt(receipt["downloaded_at"] if receipt else downloaded_now)
        secondary["download_clock_meaning"] = "Actual download receipt" if receipt or downloaded_now else "Earlier download time unavailable; ingestion time recorded separately"
    secondary["ingested_at"] = datetime.now(UTC).isoformat()
    receipt_path.write_text(canonical(secondary) + "\n")
    primary = {**base_source, "source_id": "brightdata-reels"}
    combined = {**primary, "schema_version": 2, "sources": [primary, secondary]}
    old = [{**r, "source_id": "brightdata-reels", "publication_precision": "timestamp_utc"} for r in base_records]
    if {r["id"] for r in old} & {r["id"] for r in new_records}:
        raise ValueError("cross-source duplicate needs explicit observation handling, not overwrite")
    temporary = directory / "catalog.build.sqlite"
    with sqlite3.connect(temporary) as db:
        db.executescript("DROP TABLE IF EXISTS source; DROP TABLE IF EXISTS records; CREATE TABLE source (payload TEXT NOT NULL); CREATE TABLE records (id TEXT PRIMARY KEY, payload TEXT NOT NULL);")
        db.execute("INSERT INTO source VALUES (?)", (canonical(combined),))
        db.executemany("INSERT INTO records VALUES (?,?)", [(r["id"], canonical(r)) for r in [*old, *new_records]])
    temporary.replace(directory / "catalog.sqlite")
    return {"real_reels": sum(r["product_type"] == "clips" for r in old) + len(new_records),
            "annotated_reels": len(new_records), "annotated_creator_sizes": dict(sorted(Counter(r["creator"] for r in new_records).items())),
            "source_sha256": WORKBOOK_SHA}
