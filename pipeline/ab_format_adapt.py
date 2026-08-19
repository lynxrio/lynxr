#!/usr/bin/env python3
"""A/B: the two-step format+adapt path vs the fused one (Step 13).

WHY THIS EXISTS
----------------
creator-latency-60s.md's honest verdict: after Steps 1-11 land, 28.3s of
strictly sequential Opus 5 remains — format extraction (9.4s) then adaptation
(18.9s). Fusing them into one call removes a round trip and a re-read of the
format's own output, worth an estimated 7-10s. It is also a real quality
change: the two-step exists so the model strips the topic BEFORE it rewrites,
and HANDOFF records that leaving the wrapper unsaid makes the model drift back
into the original's framing.

So `FUSE_FORMAT_ADAPT` stays OFF by default in process_adaptations.py, and
this script is how the owner judges the trade without spending anything for
real: it runs BOTH paths against the same real source videos, times each, and
prints both scripts side by side. It does not flip the flag, and it does not
change the default — that stays the owner's call after reading the output.

NO DATABASE WRITES. Nothing here touches lynxr_creators, lynxr_sources or
lynxr_videos — it builds a throwaway adaptation dict in memory and calls the
same fill_source / extract_format / fill_adaptation functions
process_adaptations.py's worker loop uses, just without ever grafting or
upserting the result anywhere.

It DOES spend real API cost on the shared prep (download, transcribe, shot
list, tags) — same as any real script, and the same either way this compares.
Only the format+adaptation half runs twice, once per arm, which is the actual
point of comparison.

Usage:
    python ab_format_adapt.py                      # 3 real sources from lynxr_sources
    python ab_format_adapt.py URL1 URL2 URL3        # or name your own
"""

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import process_adaptations as P  # noqa: E402
import envcfg  # noqa: E402 — the one place a secret or config value is read; see its docstring.

# Force a fresh extraction every time. Left on, a --reuse-sources cache hit
# would skip real work for a URL already in lynxr_sources — fine for a real
# script, but it would silently make this harness time a cache lookup instead
# of the thing it exists to compare.
P.REUSE_SOURCES = False

# A generic placeholder — this script measures the SHAPE of the trade (time,
# and whether the writing itself reads as good), not a real client
# deliverable, so a synthetic brand is deliberate rather than a stand-in for a
# missing lookup.
PLACEHOLDER_BRAND = {
    "id": "ab-harness",
    "name": "Aurora Home",
    "description": "a direct-to-consumer home fragrance brand",
    "objective": "drive first-time purchases from short-form video",
    "niche": "home & lifestyle",
    "site": "",
}
PLACEHOLDER_CREATOR = {"name": "A/B harness", "niches": [], "brands": [PLACEHOLDER_BRAND]}


def default_urls(key, n=3):
    """Three real sources already in the library, so the harness runs on real
    footage without anyone having to go find links by hand."""
    rows = P.sb(key, "/rest/v1/lynxr_sources?select=canonical_url,url"
                     f"&order=last_seen_at.desc&limit={n}")
    urls = [r.get("url") or r.get("canonical_url") for r in (rows or [])]
    if not urls:
        sys.exit("no rows in lynxr_sources to default to — pass URLs explicitly")
    return urls


def load_source(aclient, key, url):
    """Download/transcribe/shots/tags once, fresh. Shared by both arms below —
    the comparison is only about what happens AFTER this."""
    a = {"sourceUrl": url, "brandId": PLACEHOLDER_BRAND["id"], "timings": {}}
    notes = []
    P.fill_source(a, aclient, key, notes, a["timings"])
    return a


def _copy_source_only(a):
    """A fresh entry carrying only the source half — deep-copied via
    json round-trip so the two arms below cannot accidentally share state."""
    a2 = json.loads(json.dumps({k: v for k, v in a.items() if k != "timings"}))
    a2["timings"] = {}
    return a2


def run_two_step(aclient, a):
    a2 = _copy_source_only(a)
    notes = []
    t0 = time.monotonic()
    P.extract_format(aclient, a2, notes, a2["timings"])
    P.fill_adaptation(a2, PLACEHOLDER_CREATOR, aclient, notes, a2["timings"], fuse=False)
    return a2, time.monotonic() - t0


def run_fused(aclient, a):
    a3 = _copy_source_only(a)
    notes = []
    t0 = time.monotonic()
    P.fill_adaptation(a3, PLACEHOLDER_CREATOR, aclient, notes, a3["timings"], fuse=True)
    return a3, time.monotonic() - t0


def show(label, entry, secs):
    print(f"\n--- {label} ({secs:.1f}s) ---")
    fmt = entry.get("format") or {}
    ad = entry.get("adaptation") or {}
    wrapper = fmt.get("wrapper_removed") or "(none)"
    print(f"format: {fmt.get('name', '(none)')!r}   wrapper_removed: {wrapper!r}")
    print(f"fit={ad.get('fit', '—')}   {ad.get('fit_reason', '')}")
    print(f"hook: {ad.get('hook', '(none)')}")
    for b in (ad.get("beats") or [])[:8]:
        say = b.get("say") or ""
        show_txt = b.get("show") or ""
        line = f"  [{b.get('t', '?')}] do: {(b.get('do') or '')[:70]}"
        if say:
            line += f" | say: {say[:60]}"
        if show_txt:
            line += f" | show: {show_txt[:60]}"
        print(line)
    print(f"cta: {ad.get('cta', '(none)')}")
    if entry.get("note"):
        print(f"note: {entry['note']}")


def main():
    env = P.load_env(P.ROOT / ".env")
    key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY",
                        env.get("SUPABASE_SERVICE_ROLE_KEY"),
                        os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    api_key = envcfg.secret("ANTHROPIC_API_KEY",
                            env.get("ANTHROPIC_API_KEY"),
                            os.environ.get("ANTHROPIC_API_KEY"))
    if not key or not api_key:
        sys.exit("need SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY (.env or environment)")
    import anthropic
    aclient = anthropic.Anthropic(api_key=api_key)

    urls = sys.argv[1:] or default_urls(key)
    print(f"A/B: two-step format+adapt vs FUSE_FORMAT_ADAPT, on {len(urls)} source(s). "
          "No database writes.")

    two_step_times, fused_times = [], []
    for url in urls:
        print(f"\n=== {url} ===")
        base = load_source(aclient, key, url)
        if not (base.get("source") or {}).get("script"):
            print("  (no usable source — skipped)")
            continue

        two, t_two = run_two_step(aclient, base)
        show("TWO-STEP (current default)", two, t_two)
        two_step_times.append(t_two)

        fused, t_fused = run_fused(aclient, base)
        show("FUSED (FUSE_FORMAT_ADAPT)", fused, t_fused)
        fused_times.append(t_fused)

        print(f"\n  saved: {t_two - t_fused:+.1f}s on this source")

    if two_step_times and fused_times:
        avg_two = sum(two_step_times) / len(two_step_times)
        avg_fused = sum(fused_times) / len(fused_times)
        print(f"\n=== SUMMARY over {len(two_step_times)} source(s) ===")
        print(f"  two-step avg: {avg_two:.1f}s")
        print(f"  fused avg:    {avg_fused:.1f}s")
        print(f"  saved avg:    {avg_two - avg_fused:+.1f}s")
        print("\nRead both scripts above before deciding — the number is only half of it. "
              "FUSE_FORMAT_ADAPT is NOT enabled by this script; that stays the owner's call.")


if __name__ == "__main__":
    main()
