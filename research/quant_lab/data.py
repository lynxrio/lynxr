"""Pinned public sample -> isolated SQLite. No media or production access."""

import csv
import hashlib
import io
import json
import math
import re
import sqlite3
import urllib.request
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

COMMIT = "06fb48c75b91d4a635f15336aee73c22c012c602"
URL = f"https://raw.githubusercontent.com/luminati-io/Instagram-Reels-dataset-samples/{COMMIT}/Instagram%20-%20Reels.csv"
SHA256 = "fc7ff7f74faf3227c69ea92fce8359170f89675ead62054dbf40fc9abb06f422"
MAX_BYTES = 10_000_000
POLICY = "https://brightdata.com/products/datasets/samples"
SOURCE = "https://github.com/luminati-io/Instagram-Reels-dataset-samples"


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def clock(value):
    try:
        dt = datetime.fromisoformat(value)
        return dt.astimezone(UTC).isoformat() if dt.tzinfo else None
    except (TypeError, ValueError):
        return None


def number(value, integer=False):
    try:
        result = float(value)
        if isinstance(value, bool) or not math.isfinite(result) or result < 0 or result > 2**53 - 1:
            return None
        if integer and not result.is_integer():
            return None
        return int(result) if integer else result
    except (TypeError, ValueError, OverflowError):
        return None


def original_url(value, shortcode):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or parsed.hostname not in ("instagram.com", "www.instagram.com")
            or parsed.netloc not in ("instagram.com", "www.instagram.com")
            or parsed.query or parsed.fragment
            or not re.fullmatch(r"[A-Za-z0-9_-]{5,32}", shortcode)
            or parsed.path.rstrip("/") not in (f"/p/{shortcode}", f"/reel/{shortcode}", f"/tv/{shortcode}")):
        raise ValueError("invalid original Instagram identity/URL")
    return value


def duration_bin(value):
    if value is None:
        return "Unknown duration"
    for limit, name in ((15, "Under 15s"), (30, "15–30s"), (60, "30–60s"), (180, "60–180s")):
        if value < limit:
            return name
    return "180s+"


def caption_cue(text):
    for pattern, label in ((r"\bbefore\b.*\bafter\b", "Before/after wording"),
                           (r"\bhow to\b|\btutorial\b", "How-to wording"),
                           (r"\btry on\b|\btry-on\b", "Try-on wording")):
        if re.search(pattern, text, re.IGNORECASE | re.DOTALL):
            return label
    return "Question wording" if "?" in text[:180] else "No classified cue"


def normalize(raw, line):
    code = raw.get("shortcode", "")
    if not raw.get("post_id") or not raw.get("user_posted"):
        raise ValueError("missing source identity")
    metrics = {k: number(raw.get(k), True) for k in ("views", "likes", "num_comments", "video_play_count")}
    quality = {k: "missing" if not raw.get(k) else "invalid_or_negative_sentinel"
               for k, value in metrics.items() if value is None}
    posted = clock(raw.get("date_posted"))
    if posted is None:
        quality["published_at"] = "missing_or_invalid_clock"
    text = raw.get("description", "")[:10000]
    try:
        tags = json.loads(raw.get("hashtags") or "[]")
    except ValueError:
        tags = []
        quality["hashtags"] = "invalid_list"
    if not isinstance(tags, list):
        tags = []
    tags = [t[:200] for t in tags if isinstance(t, str)][:100]
    length = number(raw.get("length"))
    return {"id": code, "post_id": str(raw["post_id"]), "creator": raw["user_posted"],
            "url": original_url(raw.get("url", ""), code), "published_at": posted,
            "caption": text, "hashtags": tags, **metrics, "duration": length,
            "duration_bin": duration_bin(length), "product_type": raw.get("product_type") or "unknown",
            "caption_cue": caption_cue(text), "cue_evidence": "inferred_caption_regex_v1_not_video_structure",
            "engagement_per_view": (metrics["likes"] + metrics["num_comments"]) / metrics["views"]
            if metrics["views"] and metrics["likes"] is not None and metrics["num_comments"] is not None else None,
            "metric_observed_at": None, "metric_collected_at": None, "availability": "unknown",
            "thumbnail_supplied": bool(raw.get("thumbnail")), "quality": quality, "source_rows": [line],
            "evidence_type": "provider_reported_public_sample_not_independently_verified"}


def parse_csv(blob):
    reader = csv.DictReader(io.StringIO(blob.decode("utf-8-sig"), newline=""))
    required = {"url", "post_id", "shortcode", "user_posted", "views", "date_posted", "product_type"}
    if not required <= set(reader.fieldnames or []):
        raise ValueError("source CSV schema changed")
    records, quarantine, seen_posts, conflicted = {}, [], {}, set()
    count = 0
    for line, raw in enumerate(reader, 2):
        count += 1
        try:
            record = normalize(raw, line)
            code, pid = record["id"], record["post_id"]
            if code in records or pid in seen_posts:
                conflicted.add(code)
                if pid in seen_posts:
                    conflicted.add(seen_posts[pid])
                raise ValueError("duplicate_or_conflicting_source_identity")
            records[code] = record
            seen_posts[pid] = code
        except ValueError as exc:
            quarantine.append({"row": line, "reason": str(exc)})
    for code in sorted(conflicted):
        if code in records:
            quarantine.append({"row": records[code]["source_rows"][0], "reason": "duplicate_identity_group_quarantined"})
            del records[code]
    result = sorted(records.values(), key=lambda r: r["id"])
    return result, {"raw_rows": count, "admitted_rows": len(result), "quarantined_rows": len(quarantine),
                    "quarantine": quarantine, "product_types": dict(Counter(r["product_type"] for r in result)),
                    "quality": dict(Counter(f"{k}:{v}" for r in result for k, v in r["quality"].items()))}


def initialize(directory):
    directory = Path(directory).expanduser().resolve()
    if any((p / ".git").exists() for p in (directory, *directory.parents)):
        raise ValueError("research data must live outside every Git checkout")
    directory.mkdir(parents=True, exist_ok=True)
    raw_path, receipt = directory / "brightdata-reels.csv", directory / "source-receipt.json"
    if not raw_path.exists() or not receipt.exists():
        with urllib.request.urlopen(URL, timeout=45) as response:
            blob = response.read(MAX_BYTES + 1)
        if len(blob) > MAX_BYTES or sha(blob) != SHA256:
            raise ValueError("sample size/digest mismatch; nothing ingested")
        raw_path.write_bytes(blob)
        downloaded_at = datetime.now(UTC).isoformat()
    else:
        blob = raw_path.read_bytes()
        downloaded_at = json.loads(receipt.read_text())["downloaded_at"]
    if len(blob) > MAX_BYTES or sha(blob) != SHA256:
        raise ValueError("cached sample digest mismatch")
    records, audit = parse_csv(blob)
    source = {"name": "Bright Data public Instagram sample", "repository": SOURCE, "commit": COMMIT,
              "download_url": URL, "sha256": SHA256, "bytes": len(blob), "downloaded_at": downloaded_at,
              "repository_published_at": "2026-01-15T13:11:07+00:00",
              "publication_time_meaning": "Git commit date; not collection or metric observation time",
              "ingested_at": datetime.now(UTC).isoformat(), "metric_observed_at": None,
              "metric_collected_at": None, "listing_frame": "unknown_provider_selected_sample",
              "rights": {"purpose": "local_evaluation_only", "policy_url": POLICY,
                         "terms_url": "https://brightdata.com/license", "reviewed_on": "2026-11-20",
                         "repository_license": None, "redistribution_allowed": False, "media_fetch_allowed": False},
              "audit": audit, "schema_version": 1}
    receipt.write_text(canonical(source) + "\n")
    temporary = directory / "catalog.build.sqlite"
    with sqlite3.connect(temporary) as db:
        db.executescript("DROP TABLE IF EXISTS source; DROP TABLE IF EXISTS records; "
                         "CREATE TABLE source (payload TEXT NOT NULL); "
                         "CREATE TABLE records (id TEXT PRIMARY KEY, payload TEXT NOT NULL);")
        db.execute("INSERT INTO source VALUES (?)", (canonical(source),))
        db.executemany("INSERT INTO records VALUES (?,?)", [(r["id"], canonical(r)) for r in records])
    temporary.replace(directory / "catalog.sqlite")
    return source


def load(directory):
    path = (Path(directory).expanduser().resolve() / "catalog.sqlite").as_uri()
    with sqlite3.connect(path + "?mode=ro", uri=True) as db:
        source = json.loads(db.execute("SELECT payload FROM source").fetchone()[0])
        records = [json.loads(r[0]) for r in db.execute("SELECT payload FROM records ORDER BY id")]
    return source, records
