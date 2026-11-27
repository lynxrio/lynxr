"""Explicit STUB processor for local UI testing. Never extracts, scrapes or infers."""

import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from local_env import local_status

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from mobile_worker import MobileWorker, SourceUnavailable, transport


def process(job):
    time.sleep(3)  # Makes queued/running UI inspectable; not used in unit tests.
    if "Unavailable" in job["source_url"]:
        raise SourceUnavailable()
    text = "LOCAL TEST OUTPUT — injected processor. This is not an extracted or AI-generated script."
    if job["brand_id"]:
        return {
            "adaptation": {
                "hook": text,
                "beats": [
                    {
                        "say": "Check job status, copy, restart and account isolation.",
                        "do": "Use only disposable test records.",
                    }
                ],
                "cta": "Request a separately authorized real generation test.",
            }
        }
    return {
        "source": {
            "title": "Local pipeline integration test",
            "script": {"text": text},
        },
        "format": {"name": "Injected local fixture"},
    }


if __name__ == "__main__":
    status = local_status()
    if urlparse(status["API_URL"]).hostname not in ("127.0.0.1", "localhost"):
        raise SystemExit("Local only")
    worker = MobileWorker(
        transport(status["API_URL"], status["SERVICE_ROLE_KEY"]), process
    )
    print("Local STUB processor active. No scraping, inference, or real charges.")
    try:
        while True:
            if not worker.run_once():
                time.sleep(1)
    except KeyboardInterrupt:
        pass
