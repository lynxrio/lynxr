#!/usr/bin/env python3
"""Attach the SCRAPING_SPEC signal columns to every master row.

From the raw TikTok scrape parts (free, already on disk):
  creator_followers, saves (collectCount), shares, and the derived
  save_ratio (saves/views) and views_to_followers.

Computed across the whole database:
  reach_confidence_tier / similar_format_count / avg_views_of_similar —
  combo = niche × format × hook; a combo earns Tier 1 when 3+ DISTINCT small
  creators (<50K followers) hit 50K+ views with it, Tier 2 with 2, Tier 3
  with 1, else Unclassified. This is the spec's "format repeatability" made
  a stored, queryable fact.

Blank means unavailable (IG/YT carry no saves/followers), never zero.
Run AFTER any pass that rewrites master, BEFORE export_supabase.py.
"""

import csv
import glob
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.parent
MASTER = ROOT / "output" / "master_video_database.csv"

NEW = ["creator_followers", "saves", "shares", "save_ratio", "views_to_followers",
       "reach_confidence_tier", "similar_format_count", "avg_views_of_similar"]

SMALL_CREATOR = 50_000
REACH_VIEWS = 50_000


def raw_stats():
    stats = {}
    for f in glob.glob(str(ROOT / "data" / "*_parts*" / "*.json")):
        try:
            items = json.loads(Path(f).read_text())
        except Exception:
            continue
        for it in items:
            vid = str(it.get("id") or "")
            if not vid:
                continue
            am = it.get("authorMeta") or {}
            stats[vid] = {
                "followers": am.get("fans"),
                "saves": it.get("collectCount"),
                "shares": it.get("shareCount"),
            }
    return stats


def main():
    rows = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))
    stats = raw_stats()

    filled = 0
    for r in rows:
        s = stats.get(str(r["video_id"]))
        if not s:
            continue
        views = int(float(r.get("views") or 0))
        fol = s["followers"]
        if fol is not None:
            r["creator_followers"] = str(fol)
            if fol > 0 and views:
                r["views_to_followers"] = f"{views / fol:.1f}"
        if s["saves"] is not None:
            r["saves"] = str(s["saves"])
            if views:
                r["save_ratio"] = f"{s['saves'] / views:.4f}"
        if s["shares"] is not None:
            r["shares"] = str(s["shares"])
        filled += 1

    # Repeatability tiers over the whole database.
    combos = defaultdict(list)
    for r in rows:
        key = (r.get("niche_category"), r.get("format_type"), r.get("hook_pattern"))
        if all(key):
            combos[key].append(r)
    for key, members in combos.items():
        views = [int(float(m.get("views") or 0)) for m in members]
        avg = int(sum(views) / len(views)) if views else 0
        # distinct small creators whose video in this combo hit reach
        qualified = set()
        for m in members:
            fol = m.get("creator_followers")
            v = int(float(m.get("views") or 0))
            if v >= REACH_VIEWS and fol and int(fol) < SMALL_CREATOR:
                qualified.add(m.get("creator"))
        tier = ("Tier 1" if len(qualified) >= 3 else
                "Tier 2" if len(qualified) == 2 else
                "Tier 3" if len(qualified) == 1 else "Unclassified")
        for m in members:
            m["reach_confidence_tier"] = tier
            m["similar_format_count"] = str(len(members))
            m["avg_views_of_similar"] = str(avg)

    for r in rows:
        for c in NEW:
            r.setdefault(c, "")
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from merge_data import MASTER_FIELDS
    fields = MASTER_FIELDS + [c for c in NEW if c not in MASTER_FIELDS]
    with open(MASTER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    from collections import Counter
    tiers = Counter(r["reach_confidence_tier"] or "(untagged combo)" for r in rows)
    print(f"{len(rows)} rows; raw signals on {filled}; tiers: {dict(tiers)}")


if __name__ == "__main__":
    main()

