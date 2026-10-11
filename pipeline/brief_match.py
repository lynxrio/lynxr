#!/usr/bin/env python3
"""The pure glue behind the brief-level link between a tracked post and the agency brief it was made for.

Plan: ~/.claude/plans/lynxr-loop-v2.md (Part 2). Builds on pipeline/post_match.py, which is reused UNMODIFIED: the brief lane is
a second `post_match.rank` over the SAME in-memory words (one download, one Whisper pass per post), scored against every format of
every brief DELIVERED to the creator, whether or not they pressed "Add to my library", each anchored at the delivery's `sent_at`.
The script lane (the creator's own scripts, library copies included) is untouched and alone writes `lynxr_posts.adaptation_id`
and `match_state`; its decisions are byte-identical whether the brief lane is on or off. Two lanes rather than one pooled list,
because a library copy and its delivered format would tie and cannibalise each other's margin.

CREATOR-SIDE BOUNDARY. This module is never imported by `process_campaigns.py`, and never read by `brain.py`, `coach.py` or
`brain_prompt.py`. A brief-level link names no script to align beats against, and the owner wants agency feedback internal: the
link lives in `lynxr_post_briefs` (supabase/brief_match.sql), staff-read only. `adaptation_id` keeps meaning "the creator's own
script".

NO TRANSCRIPT EVER LEAVES THE CALLER. This module takes the scored rows as arguments and returns ids, numbers, booleans and short
id prefixes. It has no network, no filesystem write and no logging.

THE PATH RULES. `decide()` returns the first that matches:
  path `script`: the script lane auto-linked a library copy that carries `fromAgency`.
  path `format`: the brief lane auto-linked a delivered format on the unchanged guards.
  path `brief`: a brief/campaign-level decision when formats tie. Exactly one campaign group (`source_kind:source_id`, so two
    sends of one campaign are one group) has evidence. Evidence means the client named in the caption, OR the brief's own
    suggested caption reused (Jaccard >= 0.25), OR spoken-word containment >= 0.45, within 0-21 days of delivery. Nothing else
    qualifies, and the creator's own non-agency script does not match as well or better.
  Format at brief level: `format_id` is set only when the top format leads the next format in the same brief by >= 0.20 with
    containment >= 0.65. Otherwise it is "format not known".
Silent formats are KEPT in the corpus: post_match caps them, so they can never auto-link, but their caption match counts as
evidence. An own (non-agency) script that wins the script lane makes no brief claim.

`info` carries what the match log keeps of the brief half: group counts, the best score, the least days since delivery, whether
spoken words and whether the caption gave evidence (over every group, whatever its days), whether an own script blocked it, and the
top five rows as {brief id prefix, format key, score}.
"""
import hashlib
import re
from collections import namedtuple

import post_match as M

Cfg = namedtuple("Cfg", ["days", "caption_min", "contain_min", "fmt_margin", "fmt_contain", "own_block"],
                 defaults=[21.0, 0.25, 0.45, 0.20, 0.65, 0.25])

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def fkey(format_id):
    """A short stable form of a format id (a legacy brief's format id is its source URL): what is logged and used in pseudo ids."""
    return hashlib.sha1(str(format_id).encode()).hexdigest()[:12]


def corpus_entries(corpus):
    """(ads, brands, meta) for a `brief_corpus_for()` result: `ads` in post_match's adaptation shape, one per delivered format;
    `brands` one {id, name} per brief; `meta` maps each candidate id to {brief_id, format_id, fkey, group, sent_at}. Never raises."""
    ads, brands, meta, seen = [], [], {}, set()
    for b in corpus if isinstance(corpus, list) else []:
        try:
            if not isinstance(b, dict):
                continue
            bid = str(b.get("brief_id") or "")
            if not UUID_RE.match(bid) or bid in seen:
                continue
            seen.add(bid)
            brands.append({"id": f"brief:{bid}", "name": str(b.get("client_name") or "")})
            for f in b.get("formats") or []:
                if not isinstance(f, dict) or not f.get("id"):
                    continue
                cid = f"brief:{bid}:{fkey(f['id'])}"
                ads.append({"id": cid, "status": "done", "brandId": f"brief:{bid}", "addedAt": b.get("sent_at"),
                            "adaptation": {"delivery": f.get("delivery") or "", "hook": f.get("hook") or "", "cta": f.get("cta") or "",
                                           "caption": f.get("caption") or "",
                                           "beats": [{"say": str((x or {}).get("say") or "")} for x in f.get("beats") or []
                                                     if isinstance(x, dict)]}})
                meta[cid] = {"brief_id": bid, "format_id": str(f["id"])[:2048], "fkey": fkey(f["id"]),
                             "group": str(b.get("group") or f"brief:{bid}"), "sent_at": b.get("sent_at")}
        except Exception:  # noqa: BLE001 - one malformed brief never costs the rest
            continue
    return ads, brands, meta


def _result(path=None, brief_id=None, format_id=None, adaptation_id=None, score=None, info=None):
    return {"path": path, "brief_id": brief_id, "format_id": format_id, "adaptation_id": adaptation_id, "score": score,
            "info": info if info is not None else {}}


def decide(script_scored, script_decision, script_best, ads_by_id, brief_scored, brief_decision, brief_best, meta, cfg=Cfg()):
    """The brief half of one match decision. The arguments are post_match.rank outputs ((id, score, features) lists, best first,
    the decision word and the best id) for the two lanes, the creator's `ads_by_id` and the corpus `meta`. See the module docstring."""
    ads_by_id = ads_by_id or {}
    meta = meta or {}
    # 1. The script lane auto-linked a library copy of a delivered format: that carries its own brief id.
    if script_decision == "auto" and script_best:
        won = ads_by_id.get(script_best) or {}
        fa = won.get("fromAgency")
        bid = str(fa.get("briefId") or "") if isinstance(fa, dict) else ""
        if UUID_RE.match(bid):
            top = next((s for i, s, _ in script_scored if i == script_best), script_scored[0][1] if script_scored else None)
            fid = fa.get("formatId")
            return _result("script", bid, str(fid)[:2048] if fid else None, script_best, top)
        return _result(info={"own_block": True})   # an own script won: make no brief claim
    rows = [(c, s, f) for c, s, f in (brief_scored or []) if c in meta]
    # 2. The brief lane auto-linked one delivered format on post_match's unchanged guards.
    if brief_decision == "auto" and brief_best in meta and rows:
        m = meta[brief_best]
        return _result("format", m["brief_id"], m["format_id"], None, rows[0][1], _info(rows, meta, cfg, {}, 0, False))
    # 3. Brief/campaign level.
    groups = {}
    for r in rows:
        groups.setdefault(meta[r[0]]["group"], []).append(r)
    ev = {}
    for g, rs in groups.items():
        days = min(f["days"] for _, _, f in rs)
        words = any(f["speech"] and not f["silent"] and f["containment"] >= cfg.contain_min for _, _, f in rs)
        caption = any(f.get("brand_in_caption") or f["caption"] >= cfg.caption_min for _, _, f in rs)
        ev[g] = {"ok": 0 <= days <= cfg.days and (words or caption), "words": words, "caption": caption}
    qualifying = [g for g in groups if ev[g]["ok"]]
    info = _info(rows, meta, cfg, ev, len(qualifying), False)
    if len(qualifying) != 1:
        return _result(info=info)
    grows = groups[qualifying[0]]
    own = [s for i, s, _ in (script_scored or []) if not (ads_by_id.get(i) or {}).get("fromAgency")]
    if own and max(own) >= max(cfg.own_block, max(s for _, s, _ in grows)):
        info["own_block"] = True
        return _result(info=info)
    best_by = {}
    for c, s, f in grows:
        bid = meta[c]["brief_id"]
        if bid not in best_by or s > best_by[bid]:
            best_by[bid] = s

    def sent(bid):
        t = next((M.parse_ts(meta[c]["sent_at"]) for c, _, _ in grows if meta[c]["brief_id"] == bid), None)
        return t.timestamp() if t is not None else float("-inf")
    chosen = max(best_by, key=lambda bid: (best_by[bid], sent(bid)))      # highest score; the later delivery breaks a tie
    brows = sorted((r for r in grows if meta[r[0]]["brief_id"] == chosen), key=lambda r: r[1], reverse=True)
    top_c, top_s, top_f = brows[0]
    second = brows[1][1] if len(brows) > 1 else 0.0
    fid = None
    if top_f["speech"] and not top_f["silent"] and top_f["containment"] >= cfg.fmt_contain and top_s - second >= cfg.fmt_margin:
        fid = meta[top_c]["format_id"]
    return _result("brief", chosen, fid, None, top_s, info)


def _info(rows, meta, cfg, ev, qualifying, own_block):
    """Numbers, booleans and short ids only."""
    return {"groups": len({meta[c]["group"] for c, _, _ in rows}), "qualifying": qualifying,
            "best": rows[0][1] if rows else 0.0,
            "days": min((f["days"] for _, _, f in rows), default=None),
            "words": any(e["words"] for e in ev.values()), "caption": any(e["caption"] for e in ev.values()),
            "own_block": own_block,
            "top": [{"b": meta[c]["brief_id"][:8], "f": meta[c]["fkey"], "s": s} for c, s, _ in rows[:5]]}
