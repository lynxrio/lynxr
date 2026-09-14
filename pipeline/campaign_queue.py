"""Shared claimable-row filter for the agency campaign lane.

Side-effect-free, like envcfg.py: no logging config, no I/O at import. Both
worker.py (which must never import process_adaptations) and
process_campaigns.py import this module, so the probe (worker.py) and the
claim (process_campaigns.py) can never disagree about what counts as
claimable.
"""
import urllib.parse
from datetime import timedelta, timezone

TABLE = "lynxr_campaign_formats"
LEASE_MINUTES = 3.0
PAUSED_EXIT = 3  # process_campaigns exit code: paused (budget/meter/tables missing); worker backs off


def stamp(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def claimable_logic(now, lease_minutes=LEASE_MINUTES):
    cut, at = stamp(now - timedelta(minutes=lease_minutes)), stamp(now)
    return (f'(or(status.eq.queued,and(status.eq.running,claimed_at.lt."{cut}")),'
            f'or(retry_at.is.null,retry_at.lte."{at}"))')


def claimable_query(now, lease_minutes=LEASE_MINUTES):
    # parens and commas stay literal (PostgREST syntax); quotes/colons are percent-encoded.
    return "and=" + urllib.parse.quote(claimable_logic(now, lease_minutes), safe="(),")


def probe_path(now, limit=1, select="id"):
    return (f"/rest/v1/{TABLE}?select={select}&{claimable_query(now)}"
            f"&order=created_at.asc,position.asc&limit={int(limit)}")


def claim_patch_path(fid, now):
    return f"/rest/v1/{TABLE}?id=eq.{fid}&{claimable_query(now)}"
