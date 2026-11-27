"""Opt-in server-owned mobile queue runner. No legacy creator-document writes.

The live processor is never constructed in tests. CLI requires an explicit
nonproduction origin, service key in environment and spending authorization.
No .env loading, automatic deployment, production host, or default polling loop.
"""

import argparse
import json
import os
import sys
import threading
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


class MobileWorker:
    def __init__(self, rpc, process):
        self.rpc = rpc
        self.process = process

    def run_once(self):
        self.rpc("mobile_expire_jobs", {})
        job = self.rpc("mobile_claim_job", {})
        if not job:
            return False
        stop = threading.Event()
        stale = threading.Event()
        lease = {"p_id": job["id"], "p_token": job["lease_token"]}

        def heartbeat():
            while not stop.wait(45):
                try:
                    if not self.rpc("mobile_heartbeat", lease):
                        stale.set()
                        return
                except Exception:  # noqa: BLE001 -- injected/provider failures become safe job states.
                    stale.set()
                    return

        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()
        result, error = None, None
        try:
            result = self.process(job)
            if not isinstance(result, dict) or not any(
                result.get(k) for k in ("source", "adaptation")
            ):
                raise ValueError("No usable result")
        except SourceUnavailable:
            error = "source_unavailable"
        except Exception:  # noqa: BLE001 -- injected/provider failures become safe job states.
            # Raw provider errors, source captions, identifiers and keys are not logged.
            error = "processing_failed"
        finally:
            stop.set()
            thread.join()
        if not stale.is_set():
            self.rpc(
                "mobile_finish_job", {**lease, "p_result": result, "p_error": error}
            )
        return True


class SourceUnavailable(Exception):
    pass


def pipeline_processor(origin, service_key, ai_key):
    """Reuse the existing pipeline functions; explicitly disable alternate paid fetch.

    This factory is called only after the CLI's authorization checks. It never
    invokes main/process_group/run_entry/graft_adaptations/upsert_source.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pipeline"))
    import process_adaptations as pa

    pa.SB_URL = origin
    pa.FETCH_FALLBACK_APIFY = False
    pa.REUSE_SOURCES = False
    # This mobile contract persists text/structure only. Do not upload covers or
    # preview clips into any storage bucket as an incidental pipeline side effect.
    pa.upload_cover = lambda *args, **kwargs: None
    pa.upload_clip = lambda *args, **kwargs: None
    client = pa.anthropic_client(ai_key)

    def process(job):
        a = {
            "id": job["id"],
            "sourceUrl": job["source_url"],
            "brandId": job["brand_id"] or None,
        }
        notes, timings = [], {}
        try:
            if not pa.fill_source(a, client, service_key, notes, timings):
                raise RuntimeError("Extraction incomplete")
        except pa.FetchFailed as e:
            raise SourceUnavailable() from e
        if not pa.extract_format(client, a, notes, timings):
            raise RuntimeError("Format extraction incomplete")
        brand = job.get("brand_snapshot")
        creator = {
            **(job.get("creator_snapshot") or {}),
            "brands": [brand] if brand else [],
        }
        pa.fill_adaptation(a, creator, client, notes, timings)
        if not pa.has_usable_result(a):
            raise RuntimeError("Generation incomplete")
        # No raw diagnostics, media URLs, usage metadata or provider errors reach the app.
        source = a.get("source") or {}
        return {
            k: v
            for k, v in {
                "adaptation": a.get("adaptation"),
                "format": a.get("format"),
                "source": {
                    k: source[k]
                    for k in ("title", "script", "shots", "duration")
                    if k in source
                },
            }.items()
            if v
        }

    return process


class RejectRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Worker RPC redirect refused")


def transport(origin, key):
    opener = build_opener(RejectRedirect())

    def rpc(name, args):
        allowed = {
            "mobile_claim_job",
            "mobile_heartbeat",
            "mobile_finish_job",
            "mobile_expire_jobs",
        }
        if name not in allowed:
            raise ValueError("Worker RPC outside contract")
        req = Request(
            origin + "/rest/v1/rpc/" + name,
            method="POST",
            data=json.dumps(args).encode(),
            headers={
                "apikey": key,
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
            },
        )
        with opener.open(req, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    return rpc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--approved-nonproduction-origin", required=True)
    parser.add_argument("--allow-paid-processing", action="store_true")
    args = parser.parse_args()
    origin = args.approved_nonproduction_origin.rstrip("/")
    u = urlparse(origin)
    if (
        u.hostname == "esakjfogplfszievvabi.supabase.co"
        or u.scheme != "https"
        or u.username
        or u.password
        or u.path
        or u.query
        or u.fragment
    ):
        parser.error(
            "An approved HTTPS nonproduction origin is required; production is prohibited."
        )
    if not args.allow_paid_processing:
        parser.error(
            "Paid extraction/generation is disabled without separate operator authorization."
        )
    service_key = os.environ.get("LYNXR_MOBILE_SERVICE_KEY", "")
    ai_key = os.environ.get("LYNXR_MOBILE_AI_KEY", "")
    if not service_key or not ai_key:
        parser.error(
            "Runtime worker credentials are missing; never place them in Expo variables."
        )
    worker = MobileWorker(
        transport(origin, service_key), pipeline_processor(origin, service_key, ai_key)
    )
    worker.run_once()


if __name__ == "__main__":
    main()
