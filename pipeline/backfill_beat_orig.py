#!/usr/bin/env python3
"""Give every beat of an existing agency campaign format its `orig`: the stretch of the ORIGINAL video it
recreates. Formats written after this change get it from the script call (process_campaigns.py rule 17);
this fills the 21 written before. Plan: ~/.claude/plans/lynxr-agency-beat-sync.md.

TWO STEPS, SO THE SPEND AND THE WRITE ARE SEPARATE.
  --plan FILE    reads every finished format and asks the model once per beat list that has a beat with no
                 `orig` key (script.beats and edited.beats; a "kept exactly" script.beats needs no call: its
                 own `t` IS the original's time). Writes the answers to FILE. Writes NOTHING to the database.
                 FILE must be outside the repo: it holds real script text.
  --apply FILE   writes those answers, no model call. A format changed since --plan (status, updated_at, or
                 any beat's words) is skipped, never overwritten; the PATCH is also filtered on updated_at.
  --dry-run      with --apply: every check, no PATCH.
script_prev is left alone ("Restore previous version" brings back unlinked beats, which simply show no link).

USAGE (from the repo root)
  ./venv/bin/python pipeline/backfill_beat_orig.py --plan ~/Lynxr-evals/beat-sync/orig-plan.json --only c3a8cedd
  ./venv/bin/python pipeline/backfill_beat_orig.py --plan ~/Lynxr-evals/beat-sync/orig-plan.json --max-usd 2
  ./venv/bin/python pipeline/backfill_beat_orig.py --apply ~/Lynxr-evals/beat-sync/orig-plan.json --dry-run
  ./venv/bin/python pipeline/backfill_beat_orig.py --apply ~/Lynxr-evals/beat-sync/orig-plan.json
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import process_adaptations as P  # noqa: E402
import process_campaigns as C  # noqa: E402
import envcfg  # noqa: E402

TABLE = "/rest/v1/lynxr_campaign_formats"
GUARD_USD = 0.08          # what one call is assumed to cost when deciding whether the next batch fits the cap
ALIGN_SCHEMA = {"type": "object", "additionalProperties": False, "properties": {
    "beats": {"type": "array", "items": {"type": "object", "additionalProperties": False, "properties": {
        "beat": {"type": "integer", "description": "the beat's number as listed, 1 = the first"},
        "orig": {"type": "string", "description": C.ORIG_DESC}},
        "required": ["beat", "orig"]}}},
    "required": ["beats"]}
ALIGN_SYSTEM = ("You match the beats of a short-form video script to the ORIGINAL video it was modelled on. "
                "The script keeps the original's structure but may change its topic, add, split or merge "
                "beats, and staff may have rewritten lines. For every beat return its number and `orig`.\n\n"
                + C.ORIG_RULE + "\n\nReturn exactly one entry per beat, every number from 1 to the last.")


def sig(beats):
    """The words a plan was made against; --apply refuses a list whose words changed since."""
    keep = [[str((b or {}).get(k) or "") for k in ("t", "say", "do", "show")] for b in beats]
    return hashlib.sha1(json.dumps(keep, ensure_ascii=False).encode()).hexdigest()[:16]


def clip_seconds(src):
    """The clip's real length. source.duration is 0 or wrong on 6 of 21 rows (measured 2026-10-05)."""
    clip = (src or {}).get("clip")
    if clip:
        try:
            out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                  clip], capture_output=True, text=True, timeout=60)
            d = float(out.stdout.strip() or 0)
            if d > 0:
                return round(d, 1)
        except Exception:  # noqa: BLE001 — fall back to the stored value
            pass
    return float((src or {}).get("duration") or 0)


def ask_text(src, dur, analysis, beats):
    fmt = (analysis or {}).get("format") or {}
    skel = "\n".join(f"  {k + 1}. {b.get('role', '')} (~{b.get('seconds', '?')}s)"
                     for k, b in enumerate(fmt.get("beats") or []))
    rows = []
    for k, b in enumerate(beats):
        parts = [f"{lab}: {C._one_line(b.get(key))}" for lab, key in (("SAY", "say"), ("DO", "do"), ("ON SCREEN", "show"))
                 if C._one_line(b.get(key))]
        rows.append(f"{k + 1}. [{b.get('t') or 'no time'}] " + " | ".join(parts))
    return ("=== ORIGINAL VIDEO ===\n" + P.source_digest({"source": {**(src or {}), "duration": dur}})
            + (f"\n\n=== ITS FORMAT, IN ORDER ===\n{skel}" if skel else "")
            + "\n\n=== THE SCRIPT'S BEATS (each [time] is the NEW video's plan, not the original's) ===\n"
            + "\n".join(rows))


def usd(u):
    return sum(P.cost_of(m, d) or 0 for m, d in (u or {}).items())


def align(aclient, src, dur, analysis, beats):
    """([orig, …] one per beat, normalised, or None, usage). One retry when the answer misses a beat — the
    batched-answer failure this repo has seen before (CLAUDE.md, "Tag one video per API request")."""
    P._USAGE_LOCAL.d = {}
    ask = ask_text(src, dur, analysis, beats)
    for _ in range(2):
        out = P.structured(aclient, ALIGN_SYSTEM, ALIGN_SCHEMA, ask, max_tokens=4000)
        got = {}
        for x in (out.get("beats") or []):
            if isinstance(x, dict) and isinstance(x.get("beat"), int):
                got[x["beat"]] = x.get("orig")
        if set(got) == set(range(1, len(beats) + 1)):
            return [C.norm_orig(got[k + 1], dur) for k in range(len(beats))], P.usage()
        ask += (f"\n\n=== IMPORTANT ===\nYour last answer covered {len(got)} of {len(beats)} beats. "
                "Return one entry for EVERY beat, 1 to the last.")
    return None, P.usage()


def outside_repo(path):
    p = Path(path).expanduser().resolve()
    if P.ROOT.resolve() in p.parents:
        sys.exit(f"refusing: {p} is inside the repo (it would hold real script text)")
    return p


def plan(key, api_key, out_path, only, max_usd):
    out = outside_repo(out_path)
    rows = P.sb(key, f"{TABLE}?select=id,status,updated_at,source,analysis,script,edited"
                     "&status=eq.done&order=created_at.asc") or []
    if only:
        rows = [r for r in rows if any(r["id"].startswith(x) for x in only)]
    jobs = []
    for r in rows:
        for col in ("script", "edited"):
            beats = [b for b in ((r.get(col) or {}).get("beats") or []) if isinstance(b, dict)]
            if beats and any("orig" not in b for b in beats):
                jobs.append((r, col, beats))
    durs = {r["id"]: clip_seconds(r.get("source")) for r in {j[0]["id"]: j[0] for j in jobs}.values()}
    aclient = P.anthropic_client(api_key) if api_key else None

    def run(job):
        r, col, beats = job
        dur = durs[r["id"]]
        if col == "script" and (r.get("script") or {}).get("verbatim"):
            return [C.norm_orig(b.get("t"), dur) for b in beats], {}
        if not aclient:
            return None, {}
        try:
            return align(aclient, r.get("source"), dur, r.get("analysis"), beats)
        except Exception as e:  # noqa: BLE001 — one list failing never stops the rest
            print(f"  {r['id'][:8]} {col}: model call failed: {str(e)[:120]}")
            return None, P.usage()

    spent, entries, left = 0.0, [], list(jobs)
    with ThreadPoolExecutor(max_workers=4) as pool:
        while left:
            batch = left[:4]
            if spent + GUARD_USD * len(batch) > max_usd:
                print(f"stopped at the ${max_usd:.2f} cap with {len(left)} list(s) not planned")
                break
            left = left[4:]
            for (r, col, beats), (origs, u) in zip(batch, pool.map(run, batch)):
                spent += usd(u)
                entries.append({"id": r["id"], "col": col, "updated_at": r["updated_at"], "sig": sig(beats),
                                "dur": durs[r["id"]], "orig": origs})
                print(f"\n{r['id'][:8]} {col}  clip {durs[r['id']]}s  {len(beats)} beats"
                      + ("" if origs else "  -> SKIPPED (no complete answer)"))
                for k, b in enumerate(beats):
                    words = C._one_line(b.get("show") or b.get("say") or b.get("do"))[:60]
                    o = origs[k] if origs else "?"
                    print(f"  {k + 1:>2}  {str(b.get('t') or ''):<12} -> {o or '(none)':<12} {words}")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"made": datetime.now(timezone.utc).isoformat(), "spent_usd": round(spent, 4),
                               "entries": entries}, ensure_ascii=False, indent=1))
    ok = sum(1 for e in entries if e["orig"])
    print(f"\nplanned {ok} list(s), {len(entries) - ok} skipped, {len(left)} over the cap; "
          f"spent ${spent:.3f}; wrote {out}")


def apply(key, in_path, dry):
    data = json.loads(Path(in_path).expanduser().read_text())
    by_id = {}
    for e in data.get("entries") or []:
        if e.get("orig"):
            by_id.setdefault(e["id"], []).append(e)
    done = skipped = 0
    for fid, es in by_id.items():
        rows = P.sb(key, f"{TABLE}?select=id,status,updated_at,script,edited&id=eq.{fid}") or []
        r = rows[0] if rows else None
        why = ("gone" if not r else "not done now" if r["status"] != "done"
               else "changed since --plan" if r["updated_at"] != es[0]["updated_at"] else "")
        body = {}
        for e in ([] if why else es):
            cur = r.get(e["col"]) or {}
            beats = cur.get("beats") or []
            if sig(beats) != e["sig"] or len(beats) != len(e["orig"]):
                why = f"{e['col']} beats changed since --plan"
                break
            body[e["col"]] = {**cur, "beats": [{**b, "orig": o} for b, o in zip(beats, e["orig"])]}
        if why or not body:
            skipped += 1
            print(f"{fid[:8]}  skipped: {why or 'nothing to write'}")
            continue
        if dry:
            done += 1
            print(f"{fid[:8]}  would write {', '.join(body)}")
            continue
        res = C.sbx(key, f"{TABLE}?id=eq.{fid}&updated_at=eq.{urllib.parse.quote(r['updated_at'], safe='')}",
                    method="PATCH", body=body, prefer="return=representation")
        if res:
            done += 1
            print(f"{fid[:8]}  wrote {', '.join(body)}")
        else:
            skipped += 1
            print(f"{fid[:8]}  skipped: changed during --apply")
    print(f"\n{'would apply' if dry else 'applied'} {done}, skipped {skipped}")


def main():
    envcfg.sanitize_environ()
    ap = argparse.ArgumentParser(description="Backfill each campaign beat's `orig`.")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan", metavar="FILE", help="ask the model, write answers to FILE (no DB write)")
    mode.add_argument("--apply", metavar="FILE", help="write FILE's answers to the database (no model call)")
    ap.add_argument("--only", default="", help="comma-separated format id prefixes, e.g. c3a8cedd")
    ap.add_argument("--max-usd", type=float, default=2.0)
    ap.add_argument("--dry-run", action="store_true", help="with --apply: check everything, write nothing")
    args = ap.parse_args()
    env = P.load_env(P.ROOT / ".env")
    try:
        key = envcfg.secret("SUPABASE_SERVICE_ROLE_KEY", env.get("SUPABASE_SERVICE_ROLE_KEY"),
                            os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
        api_key = envcfg.secret("ANTHROPIC_API_KEY", env.get("ANTHROPIC_API_KEY"),
                                os.environ.get("ANTHROPIC_API_KEY"))
    except ValueError as e:
        sys.exit(str(e))
    if not key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY not set in .env")
    if args.plan:
        if not api_key:
            sys.exit("ANTHROPIC_API_KEY not set in .env")
        plan(key, api_key, args.plan, [x.strip() for x in args.only.split(",") if x.strip()], args.max_usd)
    else:
        apply(key, args.apply, args.dry_run)


if __name__ == "__main__":
    main()
