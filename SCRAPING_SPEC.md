# Lynxr Database Scraping Specification

Owner's canonical spec (2026-08-01) for what earns a row in `lynxr_videos`.
Full original in the session log; this is the operating version. The pipeline
implements it in `filter_database.py` (gates), `enrich_signals.py` (signals +
tiers), and the tagging passes (taxonomy).

## Core principle — two kinds of value, track both

1. **High-reach formats** — 50K–500K views, repeatedly, from SMALL creators.
   Same format+hook+audio on 2+ creators with similar views = predictable
   reach. Views >> followers proves the FORMAT works, not the audience.
2. **High-conversion formats** — CTAs, desire language, comment Q&A discovery
   ("app name??"), save ratio > 2%. Moderate views with high saves beats big
   views with none.

A brief can then be REACH-focused (max avg views, Tier 1–2 combos) or
CONVERSION-focused (max save ratio + CTA present), per the client's goal.

## Eligibility gates (any ONE qualifies a video)

- **Reach**: 50K–500K views AND creator < 100K followers AND the combo repeats
  across creators. 100K+ views on a <50K-follower account is ALWAYS in, even
  with no CTA — format wins the reach game.
- **Conversion intent**: explicit CTA / desire language / bio-only CTA /
  product name anywhere / save ratio > 2%.
- **Authenticity**: unverified, small-relative-to-views, no ambassador bio.
- **Engagement quality**: saves-heavy, product-discovery comments.
- **Niche fit**: category recognizable, format replicable.

## Reject

- Verified / >200K-follower accounts (audience did the work, not the format);
  100K–200K only survives when views/followers ≥ 3.
- Pure entertainment (comedy/dance, no product angle) under 20K views.
- Meta-CTAs only ("follow me", "like") — unless 100K+ views anyway.
- High views + save ratio < 0.5% on a big account = audience, not format.
- EXCEPTIONS always favor reach: proven big reach on a small account stays.

## Reach confidence tiers (stored per row)

Combo = niche × format × hook. Small creator = < 50K followers.
- **Tier 1**: combo hit 50K+ views on 3+ distinct small creators
- **Tier 2**: 2 distinct small creators
- **Tier 3**: 1 creator (single data point)
- **Unclassified**: combo has never hit 50K
Also stored: `similar_format_count`, `avg_views_of_similar`.
Briefs cite the tier: "Tier 1 — proven on 4 creators averaging 95K views."

## Signals stored per row (beyond the seven tags)

`creator_followers`, `saves`, `shares`, `save_ratio`, `views_to_followers`,
`reach_confidence_tier`, `similar_format_count`, `avg_views_of_similar`.
TikTok carries all of these in the raw scrape (collectCount, authorMeta.fans);
IG/YT carry a subset — blank means unavailable, never zero.

## Platform notes

- TikTok: 9:16, 9–15s sweet spot, hook in <1s, low production wins, saves are
  the strongest UGC signal.
- Reels: 15–30s, slightly more polish, saves/shares matter over comment count.
- Shorts: 15–30s, less trending-audio culture, judge comment quality.

## Phase 2 (needs data not yet collected)

- Comment scraping: Q&A patterns, planted-comment detection, discovery counts.
- CTA-presence rejection gates (needs cta_type on all rows — extra-dims pass).
- Per-niche format vocabularies (Try-On Showcase, Fit Check, …) — a taxonomy
  expansion; migrate deliberately, never rename existing values.
- Audio saturation/age tracking.

