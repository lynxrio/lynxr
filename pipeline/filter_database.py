#!/usr/bin/env python3
"""Enforce the database's content policy: English-only, organic UGC.

Drops three classes of rows, each on positive evidence only:
  non-english   — Whisper says the spoken language isn't English; or, for rows
                  without speech, the caption + on-screen text is heavily
                  non-ASCII (CJK/Cyrillic/Arabic/etc). Hashtag-only captions
                  are language-neutral and KEPT.
  influencer    — TikTok author is platform-verified or has > MAX_FANS
                  followers (organic UGC lives well below that). Medceptor
                  rows (your own UGC program) and IG/YT rows (hand-curated
                  UGC roster) are exempt from the fan check.
  ai-slop       — caption hashtags/phrases that mark AI-GENERATED content
                  (#aiugc, #sora, #veo3, "ai influencer", …). Videos ABOUT
                  AI tools are fine; synthetic content is not.

Usage:
    python filter_database.py --dry-run    # counts + samples, no changes
    python filter_database.py              # snapshot, rewrite master,
                                           # delete dropped rows from Supabase
"""

import argparse
import csv
import glob
import json
import os
import re
import shutil
import sys
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).parent.parent
MASTER = ROOT / "output" / "master_video_database.csv"
TRANSCRIPTS = ROOT / "output" / "transcripts.jsonl"

MAX_FANS = 200_000

AI_SLOP = re.compile(
    r"#ai(ugc|video|girl|model|influencer|art|generated|actress|avatar)\b"
    r"|#(sora|veo3?|heygen|synthesia|midjourney|kling|pika)\b"
    r"|\bai[- ](ugc|influencer|avatar|actress|generated video)\b",
    re.I)

# Positive non-English signal: a large share of letters outside basic latin.
NON_LATIN = re.compile(r"[Ѐ-ӿ֐-ۿऀ-෿฀-๿"
                       r"ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]")

# Latin-script languages hide from the script check — catch them by stopwords.
EN_WORDS = {"the", "and", "you", "your", "for", "this", "that", "with", "how",
            "what", "when", "are", "is", "was", "have", "not", "but", "they",
            "get", "make", "just", "like", "can", "will", "all", "out", "about"}
FOREIGN_WORDS = {"que", "por", "para", "con", "los", "las", "una", "este",
                 "esta", "pero", "como", "más", "está", "não", "você", "uma",
                 "mais", "dos", "les", "des", "pour", "avec", "dans", "vous",
                 "pas", "sur", "und", "der", "die", "das", "ist", "mit", "für",
                 "nicht", "ein", "auf", "che", "del", "più", "sono", "yang",
                 "untuk", "dengan", "ini", "itu", "ang", "mga", "hindi", "aku",
                 "kamu", "gak", "apo", "ako", "naman", "lang", "din"}


def transcript_langs():
    langs = {}
    if not TRANSCRIPTS.exists():
        return langs
    for line in TRANSCRIPTS.read_text().splitlines():
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("error"):
            continue
        # last entry per id wins (matches attach_transcripts)
        langs[str(d["video_id"])] = (d.get("language") or "", bool(d.get("has_speech")))
    return langs


def author_stats():
    """video_id -> (fans, verified) from the raw TikTok scrape parts."""
    stats = {}
    for f in glob.glob(str(ROOT / "data" / "*_parts*" / "*.json")):
        try:
            items = json.loads(Path(f).read_text())
        except Exception:
            continue
        for it in items:
            vid = str(it.get("id") or "")
            am = it.get("authorMeta") or {}
            if vid:
                stats[vid] = (am.get("fans") or 0, bool(am.get("verified")))
    return stats


def non_english_text(*texts):
    joined = " ".join(t for t in texts if t)
    # strip hashtags/handles/urls — they're language-neutral
    joined = re.sub(r"#\w+|@\w+|https?://\S+", " ", joined)
    letters = re.findall(r"[^\W\d_]", joined)
    if len(letters) < 12:
        return False                     # too little text to judge — keep
    non_latin = len(NON_LATIN.findall(joined))
    if non_latin / len(letters) > 0.3:
        return True
    # Latin-script foreign language: stopword vote, needs a clear majority.
    words = re.findall(r"[^\W\d_]+", joined.lower())
    en = sum(1 for w in words if w in EN_WORDS)
    foreign = sum(1 for w in words if w in FOREIGN_WORDS)
    return foreign >= 2 and foreign > en


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = list(csv.DictReader(open(MASTER, newline="", encoding="utf-8")))
    langs = transcript_langs()
    authors = author_stats()

    keep, dropped = [], []
    reasons = {"non-english": 0, "influencer": 0, "ai-slop": 0}
    samples = {k: [] for k in reasons}

    for r in rows:
        vid = str(r["video_id"])
        reason = None

        lang, has_speech = langs.get(vid, ("", False))
        if has_speech and lang and lang != "en":
            reason = "non-english"
        elif not has_speech and non_english_text(r.get("title", ""), r.get("onscreen_text", "")):
            reason = "non-english"

        if not reason and r["platform"] == "tiktok" and r.get("data_source") == "Scraped":
            fans, verified = authors.get(vid, (0, False))
            if verified or fans > MAX_FANS:
                reason = "influencer"

        if not reason and AI_SLOP.search(r.get("title", "") or ""):
            reason = "ai-slop"

        if reason:
            reasons[reason] += 1
            if len(samples[reason]) < 5:
                samples[reason].append(f'{r["creator"]}: {(r.get("title") or "")[:70]}')
            dropped.append(r)
        else:
            keep.append(r)

    print(f"{len(rows)} rows -> keep {len(keep)}, drop {len(dropped)}: {reasons}")
    for k, ex in samples.items():
        for e in ex:
            print(f"  [{k}] {e}")

    if args.dry_run:
        return

    snap = MASTER.with_name(f"master_before_filter_{date.today().isoformat()}.csv")
    if not snap.exists():
        shutil.copy(MASTER, snap)
        print(f"snapshot -> {snap.name}")

    with open(MASTER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(keep)
    print(f"master rewritten: {len(keep)} rows")

    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        sys.exit("Set SUPABASE_SERVICE_ROLE_KEY to also delete from Supabase.")
    base = "https://esakjfogplfszievvabi.supabase.co/rest/v1/lynxr_videos"
    ids = [str(r["video_id"]) for r in dropped]
    for i in range(0, len(ids), 100):
        chunk = ",".join(f'"{v}"' for v in ids[i:i + 100])
        req = urllib.request.Request(
            f"{base}?video_id=in.({chunk})", method="DELETE",
            headers={"apikey": key, "Authorization": f"Bearer {key}"})
        import certifi, ssl
        urllib.request.urlopen(req, context=ssl.create_default_context(cafile=certifi.where()))
    print(f"deleted {len(ids)} rows from Supabase")


if __name__ == "__main__":
    main()
