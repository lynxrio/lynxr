"""Offline checks for pipeline/brief_clips.py. Same check()/FAILS style as pipeline/test_campaigns.py.
Pure functions only: no Supabase, no download.

Run with

    ./venv/bin/python pipeline/test_brief_clips.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import brief_clips as B  # noqa: E402

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


GOOD = B.P.SB_URL + "/storage/v1/object/public/lynxr-clips/5a4fe3fac7d27c450061.mp4"

# The object names the creator paste path and the campaign lane already use (read off live rows 2026-09-24).
check("name: IG reels link", B.object_name("https://www.instagram.com/reels/DcXAYVbhLW7/"), "5a4fe3fac7d27c450061")
check("name: query ignored", B.object_name("https://www.tiktok.com/@santan.med/video/7633603224787881247?q=studyin"), "8d4bbd48e98e39f9f6be")

f = {"id": "a", "source_url": "https://www.tiktok.com/@x/video/7600000000000000001"}
check("needs: bare format", B.needs_clip(f), True)
check("needs: has our clip", B.needs_clip({**f, "clip": GOOD}), False)
check("needs: a foreign clip is no clip", B.needs_clip({**f, "clip": "https://evil.example/x.mp4"}), True)
check("needs: gave up", B.needs_clip({**f, "clip_state": "failed"}), False)
check("needs: no link", B.needs_clip({"id": "a", "source_url": ""}), False)
check("needs: no id", B.needs_clip({"source_url": f["source_url"]}), False)

rows = [
    {"id": "live", "doc": {"formats": [f, {**f, "id": "b", "clip": GOOD}]}, "lynxr_agency_deliveries": [{"revoked_at": None}]},
    {"id": "gone", "doc": {"formats": [f]}, "lynxr_agency_deliveries": [{"revoked_at": "2026-09-23T18:42:22Z"}]},
    {"id": "never", "doc": {"formats": [f]}, "lynxr_agency_deliveries": []},
]
check("pending: live briefs, clipless formats only", B.pending(rows), [("live", "a", f["source_url"])])

ok = B.apply({**f, "clip_tries": 2, "clip_state": "x", "cover": "keep"}, {"clip": GOOD, "cover": "new"})
check("apply ok: clip set", ok.get("clip"), GOOD)
check("apply ok: an existing cover is kept", ok.get("cover"), "keep")
check("apply ok: fetch state cleared", ("clip_state" in ok, "clip_tries" in ok), (False, False))
check("apply ok: cover filled when none", B.apply(f, {"clip": GOOD, "cover": "c"}).get("cover"), "c")
r1 = B.apply(f, {"fail": "fetch_generic", "retryable": True})
check("apply retryable: counted, not given up", (r1.get("clip_tries"), r1.get("clip_state")), (1, None))
check("apply permanent: given up at once", B.apply(f, {"fail": "fetch_private", "retryable": False}).get("clip_state"), "failed")
check("apply retryable at the last try: given up",
      B.apply({**f, "clip_tries": B.MAX_TRIES - 1}, {"fail": "clip", "retryable": True}).get("clip_state"), "failed")
check("apply leaves its input alone", "clip_tries" in f, False)

print()
print("ALL OK" if not FAILS else f"{len(FAILS)} FAILED")
sys.exit(1 if FAILS else 0)
