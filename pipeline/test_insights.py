"""Offline checks for pipeline/insights.py, the lane that reads how long people watch from a creator's own connected Instagram/TikTok
account. No network, no Supabase, no platform: every I/O helper is replaced. Same check()/FAILS style as pipeline/test_track_posts.py.

Every id, handle, uuid, token and number below is invented for this test. No real creator, handle or id goes in this file: it is checked
into a public repo.

Run with

    ./venv/bin/python pipeline/test_insights.py
"""
import ast
import json
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import insights as I  # noqa: E402
import track_posts as TP  # noqa: E402  (only for its pure helpers, which the lane borrows from the running module at run time)

FAILS = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILS.append(name)
    print(f"{'ok  ' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")


NOW = datetime(2026, 10, 7, 12, 0, 0, tzinfo=timezone.utc)
C1, C2, C3 = ("00000000-0000-4000-8000-00000000000%d" % i for i in (1, 2, 3))
KEY = "service-role-key-invented"


def ago(**kw):
    return (NOW - timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%SZ")


def post(i, state="pending", creator=C1, platform="instagram", handle="example.one", days_old=2, at=None, fails=0, dur=None, media=None,
         url=None):
    url = url or (f"https://www.instagram.com/p/CODE{i}/" if platform == "instagram" else f"https://www.tiktok.com/@{handle}/video/73110000000000{i:02d}")
    return {"id": i, "creator_id": creator, "platform": platform, "handle": handle, "url": url, "canonical_url": url,
            "posted_at": ago(days=days_old), "platform_media_id": media, "duration_s": dur, "insights_state": state,
            "insights_at": at, "insights_fails": fails}


class World:
    """A stand-in for the database and the platforms. `T` is what insights.py is handed in place of the running track_posts module."""

    def __init__(self, posts, tokens=None, tiers=None, tokens_status=200, posts_status=200):
        self.posts = posts
        self.tokens = tokens if tokens is not None else sorted({(p["creator_id"], p["platform"], p["handle"]) for p in posts})
        self.tiers = tiers or {}
        self.tokens_status, self.posts_status = tokens_status, posts_status
        self.writes = []                  # (method, path, body)
        self.http = []                    # every platform / function call: (url, method)
        self.disconnected = False         # a Disconnect pressed after the due read
        self.token_answer = (200, {"access_token": "ACCESS_TOKEN_INVENTED", "platform_user_id": "17841400000001"})
        self.media = lambda: (200, {"data": [{"id": "9001", "permalink": f"https://www.instagram.com/reel/CODE{p['id']}/"}
                                             for p in posts if p["platform"] == "instagram"]})
        self.insights = lambda metric: (200, {"data": [
            {"name": "ig_reels_avg_watch_time", "period": "lifetime", "values": [{"value": 4.2}]},
            {"name": "reels_skip_rate", "period": "lifetime", "values": [{"value": 31}]},
            {"name": "reach", "period": "lifetime", "values": [{"value": 1200}]}]})
        self.tt = lambda: (200, {"code": 0, "data": {"videos": []}})
        self.duration = 14
        self.queued = False

    # ── the borrowed track_posts module ──
    def rest(self, key, path, method="GET", body=None, prefer=None):
        if method != "GET":
            self.writes.append((method, path, body, prefer))
            return 204, None
        if "/lynxr_platform_tokens" in path:
            if self.tokens_status != 200:
                return self.tokens_status, None
            if "select=creator_id,platform,handle" in path:
                want = urllib.parse.unquote(path).split("creator_id=eq.")[1].split("&")[0] if "creator_id=eq." in path else None
                return 200, [{"creator_id": c, "platform": p, "handle": h} for c, p, h in self.tokens if want in (None, c)]
            return 200, [] if self.disconnected else [{"handle": "x"}]           # token_active()
        if "/lynxr_posts" in path:
            if self.posts_status != 200:
                return self.posts_status, None
            state = path.split("insights_state=eq.")[1].split("&")[0] if "insights_state=eq." in path else None
            want = urllib.parse.unquote(path).split("creator_id=eq.")[1].split("&")[0] if "creator_id=eq." in path else None
            return 200, [p for p in self.posts if state in (None, p["insights_state"]) and want in (None, p["creator_id"])]
        return 404, None

    def by_tier(self, items, key, cache, creator=lambda r: r.get("creator_id")):
        rank = {"max": 0, "pro": 1, "free": 2}
        return sorted(items, key=lambda r: rank[self.tiers.get(creator(r), "free")])

    def ytdlp_json(self, args, timeout):
        return {"duration": self.duration} if self.duration else None

    def T(self):
        return SimpleNamespace(q=TP.q, iso=TP.iso, parse_ts=TP.parse_ts, age_days=TP.age_days, next_measure_at=TP.next_measure_at,
                               checkpoints=TP.checkpoints, post_url_ok=TP.post_url_ok, rest=self.rest, by_tier=self.by_tier,
                               ytdlp_json=self.ytdlp_json, P=SimpleNamespace(queued_work=lambda key: self.queued))

    # ── the platforms and the Edge Function ──
    def http_json(self, url, method="GET", headers=None, body=None, timeout=30):
        self.http.append((url, method))
        if url.endswith("/token"):
            return self.token_answer
        if "/me/media" in url:
            return self.media()
        if "/insights?" in url:
            return self.insights(urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["metric"][0])
        if url.startswith(I.INSIGHTS_TT_URL):
            return self.tt()
        return 0, None


CONF = ("INSIGHTS_IG_WATCH_UNIT", "INSIGHTS_TT_WATCH_UNIT", "INSIGHTS_IG_SKIP_SCALE", "INSIGHTS_TT_RATE_SCALE", "INSIGHTS_DURATION",
        "INSIGHTS_PER_PASS", "INSIGHTS_FRESH_DAYS", "INSIGHTS_RETRY_H", "INSIGHTS_MAX_FAILS")
SAVED = {n: getattr(I, n) for n in CONF}


def configure(**kw):
    for n, v in SAVED.items():
        setattr(I, n, v)
    for n, v in kw.items():
        setattr(I, n, v)


def run(world, dry=False, **conf):
    configure(**conf)
    real = I.http_json
    I.http_json = world.http_json
    try:
        return I.insights_pass(KEY, NOW, dry=dry, T=world.T())
    finally:
        I.http_json = real
        configure()


def insight_rows(w):
    return [x for x in w.writes if "/lynxr_post_insights" in x[1]]


def post_patches(w):
    return [x for x in w.writes if "/lynxr_posts?id=eq." in x[1]]


UNITS = dict(INSIGHTS_IG_WATCH_UNIT="s", INSIGHTS_IG_SKIP_SCALE="100", INSIGHTS_TT_WATCH_UNIT="s", INSIGHTS_TT_RATE_SCALE="1")

# ── 1. the due set ───────────────────────────────────────────────────────────────────────────────
posts = [post(1, "pending"), post(2, "unsupported"), post(3, "too_old"), post(4, "no_token"), post(5, "pending", days_old=20),
         post(6, "failed", fails=1, at=ago(hours=10)), post(7, "failed", fails=3, at=ago(hours=10)), post(8, "failed", fails=1, at=ago(hours=1)),
         post(9, "pending", at=ago(hours=1))]
w = World(posts)
got = I.due(w.T(), KEY, NOW, {})
check("1. due: only pending (young, past its wait) and failed (under the cap, past its wait)", sorted(p["id"] for p in got), [1, 6])
check("1. due: unsupported, too_old and no_token are never in it", {p["id"] for p in got} & {2, 3, 4}, set())
check("1. due: a pending post older than INSIGHTS_FRESH_DAYS is not", 5 in {p["id"] for p in got}, False)
check("1. due: a pending post deferred an hour ago waits out INSIGHTS_RETRY_H", 9 in {p["id"] for p in got}, False)

w = World([post(11, "ok", days_old=5, at=ago(days=4, hours=1)),        # checkpoint day 3 passed since the last read? read at day 0.9; day 1 and 3 passed
           post(12, "ok", days_old=5, at=ago(hours=2)),               # read two hours ago: next checkpoint (day 7) is in the future
           post(13, "ok", days_old=40, at=ago(days=5)),               # every checkpoint (1,3,7,30) is behind the last read
           post(14, "ok", days_old=2, at=None)])
check("1. due: an ok post is due only when a view checkpoint has passed since its last read (or it was never read)",
      sorted(p["id"] for p in I.due(w.T(), KEY, NOW, {})), [11, 14])
check("1. due: a post on a profile with NO active token is not due",
      I.due(World([post(21), post(22, creator=C2, handle="other.one")], tokens=[(C1, "instagram", "example.one")]).T(), KEY, NOW, {})[0]["id"], 21)

# ── 2. max -> pro -> free ────────────────────────────────────────────────────────────────────────
w = World([post(31, creator=C1, handle="a.one"), post(32, creator=C2, handle="b.one"), post(33, creator=C3, handle="c.one")],
          tiers={C1: "free", C2: "max", C3: "pro"})
check("2. due: ordered max -> pro -> free", [p["creator_id"] for p in I.due(w.T(), KEY, NOW, {})], [C2, C3, C1])

# ── 3 + 4. the two matchers ──────────────────────────────────────────────────────────────────────
api = [{"id": "555", "permalink": "https://www.instagram.com/reel/ABC123/"}, {"id": "556", "permalink": "https://www.instagram.com/reel/ZZZ999/"}]
check("3. the shortcode matcher pairs a stored /p/ABC123/ with the API's /reel/ABC123/",
      I.match_ig(api, "https://www.instagram.com/p/ABC123/"), "555")
check("3. ... and a stored /reel/ link with query noise", I.match_ig(api, "https://www.instagram.com/reel/ABC123/?igsh=xyz"), "555")
check("3. ... a different shortcode matches nothing", I.match_ig(api, "https://www.instagram.com/p/NOPE00/"), None)
check("3. ... a link with no shortcode matches nothing", I.match_ig(api, "https://www.instagram.com/someone/"), None)
check("4. the TikTok matcher pulls the numeric id out of the link",
      I.tt_video_id("https://www.tiktok.com/@h/video/7311000000000000123"), "7311000000000000123")
check("4. ... and None when there is none", I.tt_video_id("https://www.tiktok.com/@h"), None)

# ── 5. the Instagram response parser ─────────────────────────────────────────────────────────────
full = {"data": [{"name": "ig_reels_avg_watch_time", "period": "lifetime", "values": [{"value": 4.2}]},
                 {"name": "reels_skip_rate", "values": [{"value": 31}]}, {"name": "reach", "values": [{"value": 1200}]}]}
check("5. the parser reads data[*].values[0].value by metric name", I.parse_ig_insights(full), {"avg": 4.2, "skip": 31, "reach": 1200})
check("5. a metric that is absent is None, not 0", I.parse_ig_insights({"data": [full["data"][0]]}), {"avg": 4.2, "skip": None, "reach": None})
check("5. an empty answer is all None", I.parse_ig_insights({"data": []}), {"avg": None, "skip": None, "reach": None})
check("5. a value that is not a number is None", I.parse_ig_insights({"data": [{"name": "reach", "values": [{"value": "n/a"}]}]})["reach"], None)
check("5. a negative value is None", I.parse_ig_insights({"data": [{"name": "reach", "values": [{"value": -3}]}]})["reach"], None)
check("5. garbage is all None", I.parse_ig_insights(None), {"avg": None, "skip": None, "reach": None})

# ── 6. the unit guard ────────────────────────────────────────────────────────────────────────────
configure()
check("6. finalize with INSIGHTS_IG_WATCH_UNIT unset: avg_watch_ms is None, and the note says why",
      (I.finalize("instagram", {"avg": 4.2, "skipped": 31, "reach": 1200}, 14)[0]["avg_watch_ms"],
       "unit_unset" in I.finalize("instagram", {"avg": 4.2, "skipped": 31, "reach": 1200}, 14)[2]), (None, True))
check("6. to_ms: 's' converts, 'ms' passes, anything else is None",
      (I.to_ms(4.2, "s"), I.to_ms(4200, "ms"), I.to_ms(4.2, ""), I.to_ms(4.2, "minutes")), (4200, 4200, None, None))
check("6. to_fraction: '100' divides, '1' passes, unset or out of range is None",
      (I.to_fraction(31, "100"), I.to_fraction(0.31, "1"), I.to_fraction(31, ""), I.to_fraction(31, "1")), (0.31, 0.31, None, None))
w = World([post(41)])
out = run(w)                                                          # every unit left unset, as on the first deploy
rows = insight_rows(w)
check("6. unit unset, whole pass: the row carries NO watch time and NO skip rate, only the reach",
      [(r[2]["avg_watch_ms"], r[2]["skipped_3s_rate"], r[2]["reach"]) for r in rows], [(None, None, 1200)])
w = World([post(42)])
w.insights = lambda metric: (200, {"data": [{"name": "ig_reels_avg_watch_time", "values": [{"value": 4.2}]}]})
run(w)
check("6. unit unset and a watch time as the ONLY figure: nothing is stored at all", insight_rows(w), [])
check("6. ... and the post is still marked ok (it is read again at its next checkpoint, once the unit is set)",
      [p[2].get("insights_state") for p in post_patches(w)], ["ok"])
w = World([post(43)])
run(w, **UNITS)
check("6. units set: 4.2 s becomes 4200 ms and 31 (percent) becomes 0.31",
      [(r[2]["avg_watch_ms"], r[2]["skipped_3s_rate"]) for r in insight_rows(w)], [(4200, 0.31)])

# ── 7. the sanity guard ──────────────────────────────────────────────────────────────────────────
configure(INSIGHTS_IG_WATCH_UNIT="s")
check("7. finalize: an average of 60 s on a 14 s video is implausible and stores None",
      I.finalize("instagram", {"avg": 60, "skipped": None, "reach": 10}, 14)[:2], ({"avg_watch_ms": None, "total_watch_ms": None,
       "finished_rate": None, "skipped_3s_rate": None, "reach": None, "sources": None}, "implausible"))
check("7. ... 40 s on a 14 s video is under 3x and passes", I.finalize("instagram", {"avg": 40, "skipped": None, "reach": None}, 14)[1], "ok")
check("7. ... no known length, no guard", I.finalize("instagram", {"avg": 600, "skipped": None, "reach": None}, None)[1], "ok")
configure()
w = World([post(44)])
w.insights = lambda metric: (200, {"data": [{"name": "ig_reels_avg_watch_time", "values": [{"value": 60}]}, {"name": "reach", "values": [{"value": 5}]}]})
run(w, **UNITS)
check("7. whole pass: 60 s on a 14 s video writes NO figure", insight_rows(w), [])
check("7. ... and sets the post to failed with one failure counted",
      [(p[2].get("insights_state"), p[2].get("insights_fails")) for p in post_patches(w)], [("failed", 1)])

# ── 8. a metric request that errors twice ────────────────────────────────────────────────────────
w = World([post(45)])
asked = []
w.insights = lambda metric: (asked.append(metric) or (400, {"error": {"code": 100, "type": "OAuthException", "message": "nope"}}))
run(w, **UNITS)
check("8. the full metric list is refused, then retried ONCE with the average alone",
      asked, ["ig_reels_avg_watch_time,reels_skip_rate,reach", "ig_reels_avg_watch_time"])
check("8. ... then the post is `unsupported`", [p[2].get("insights_state") for p in post_patches(w)], ["unsupported"])
check("8. ... and an unsupported post is never due again",
      I.is_due(post(45, "unsupported", at=ago(days=3)), NOW, TP), False)
w = World([post(46)])
w.insights = lambda metric: (400, {"error": {"code": 190, "type": "OAuthException"}})
run(w, **UNITS)
check("8. an expired-token error (190) is the TOKEN's problem: deferred, never `unsupported`",
      [p[2].get("insights_state") for p in post_patches(w)], [None])
w = World([post(47)])
w.insights = lambda metric: (400, {"error": {"code": 4, "type": "OAuthException"}})
run(w, **UNITS)
check("8. a rate limit (code 4) is transient: deferred, never unsupported, no failure counted",
      [(p[2].get("insights_state"), p[2].get("insights_fails")) for p in post_patches(w)], [(None, None)])

# ── 9. needs_reconnect ───────────────────────────────────────────────────────────────────────────
w = World([post(51), post(52)])
w.token_answer = (409, {"error": "needs_reconnect"})
out = run(w, **UNITS)
check("9. needs_reconnect: no snapshot is written", insight_rows(w), [])
profile_patch = [x for x in w.writes if "/lynxr_posts?creator_id=eq." in x[1]]
check("9. ... every post of that profile goes to no_token, in ONE update", [x[2] for x in profile_patch], [{"insights_state": "no_token"}])
check("9. ... the token was asked for once, and no platform call was made", ([u for u, _ in w.http if u.endswith("/token")].__len__(),
      [u for u, _ in w.http if "graph.instagram.com" in u]), (1, []))
w = World([post(53)])
w.token_answer = (503, {"error": "transient"})
run(w, **UNITS)
check("9. a transient token answer changes nothing about the post's state (only the wait is stamped)",
      [sorted(p[2]) for p in post_patches(w)], [["insights_at"]])
w = World([post(54)])
w.token_answer = (409, {"error": "key_rotated"})
run(w, **UNITS)
check("9. a rotated key changes nothing either, and writes no figure", (insight_rows(w), [sorted(p[2]) for p in post_patches(w)]), ([], [["insights_at"]]))

# ── 10. the snapshot upsert path ─────────────────────────────────────────────────────────────────
w = World([post(61, days_old=3)])
run(w, **UNITS)
(method, path, body, prefer), = insight_rows(w)
check("10. the snapshot is upserted on (post_id, day) with merge-duplicates",
      (method, "?on_conflict=post_id,day" in path, prefer), ("POST", True, "resolution=merge-duplicates,return=minimal"))
check("10. ... the row carries the post, the creator, the platform and day = whole days after posting",
      (body["post_id"], body["creator_id"], body["platform"], body["day"]), (61, C1, "instagram", 3))
check("10. ... and the post then records ok, the media id matched by shortcode, and the length from the free metadata read",
      [(p[2].get("insights_state"), p[2].get("platform_media_id"), p[2].get("duration_s"), p[2].get("insights_fails")) for p in post_patches(w)],
      [("ok", "9001", 14, 0)])
check("10. ... the profile's last_poll_at is stamped", any("/lynxr_platform_tokens?creator_id=eq." in x[1] and "last_poll_at" in (x[2] or {}) for x in w.writes), True)

# ── the rest of the lane's behaviour ─────────────────────────────────────────────────────────────
w = World([post(71), post(72, creator=C2, handle="b.one")])
out = run(w, dry=True)
check("dry run: counts what is due, makes NO platform or function call and NO write",
      (out["insights_due"], w.http, w.writes), (2, [], []))
w = World([post(73)], tokens_status=404)
check("the SQL not applied (tokens table missing): the lane returns {} and does nothing", (run(w), w.writes, w.http), ({}, [], []))
w = World([post(74)], posts_status=400)
check("lynxr_posts.insights_state missing (HTTP 400): the lane returns {} and does nothing", (run(w), w.writes, w.http), ({}, [], []))
w = World([post(75)], tokens=[])
check("nobody connected: due is empty and nothing is polled", (run(w)["insights_due"], w.http), (0, []))
w = World([post(76)])
w.queued = True
run(w, **UNITS)
check("a queued creator script ends the pass before any post is read", (w.http, insight_rows(w)), ([], []))
w = World([post(i) for i in range(80, 90)])
out = run(w, INSIGHTS_PER_PASS=3, **UNITS)
check("INSIGHTS_PER_PASS caps the posts polled", (out["insights_due"], out["insights_polled"]), (10, 3))
w = World([post(91)])
w.disconnected = True
run(w, **UNITS)
check("a Disconnect pressed mid-pass wins: no figure is written back after the delete", insight_rows(w), [])
w = World([post(92)])
w.media = lambda: (200, {"data": [{"id": "1", "permalink": "https://www.instagram.com/reel/SOMEOTHER/"}]})
run(w, **UNITS)
check("a post not in the profile's newest media is a counted failure, never a guess",
      [(p[2].get("insights_fails"), p[2].get("insights_state")) for p in post_patches(w)], [(1, None)])
w = World([post(93, fails=2)])
w.media = lambda: (200, {"data": []})
run(w, **UNITS)
check("... and the third failure sets it failed for good", [p[2].get("insights_state") for p in post_patches(w)], ["failed"])
w = World([post(94, media="777")])
run(w, **UNITS)
check("a post that already has its media id needs no list call", [u for u, _ in w.http if "/me/media" in u], [])
w = World([post(95), post(96)])
run(w, **UNITS)
check("the media list and the token are fetched once per profile per pass, not once per post",
      ([u for u, _ in w.http if "/me/media" in u].__len__(), [u for u, _ in w.http if u.endswith("/token")].__len__()), (1, 1))
w = World([post(97)])
w.insights = lambda metric: (200, {"data": []})
run(w, **UNITS)
check("an empty answer (insight data can lag 48 hours) is `no figure yet`: nothing stored, no failure counted",
      (insight_rows(w), [sorted(p[2]) for p in post_patches(w)]), ([], [["insights_at"]]))

# TikTok, unverified: only that a match is read and a mismatch is a refusal, never a wrong row
vid = lambda i: f"73110000000000{i:02d}"
tt_post = post(98, platform="tiktok", handle="t.one")
w = World([tt_post])
w.tt = lambda: (200, {"code": 0, "data": {"videos": [{"item_id": vid(98), "video_duration": 20, "average_time_watched": 6.5,
                                                       "full_video_watched_rate": 0.12, "reach": 900, "impression_sources": {"for_you": 0.9}}]}})
run(w, **UNITS)
check("tiktok: a match by the numeric id stores watch time, finish rate, reach and the sources verbatim",
      [(r[2]["avg_watch_ms"], r[2]["finished_rate"], r[2]["reach"], r[2]["sources"], r[2]["skipped_3s_rate"]) for r in insight_rows(w)],
      [(6500, 0.12, 900, {"for_you": 0.9}, None)])
w = World([tt_post])
w.tt = lambda: (200, {"code": 40001, "message": "bad", "data": {}})
run(w, **UNITS)
check("tiktok: an envelope whose code is not 0 is refused, nothing stored", insight_rows(w), [])
w = World([tt_post])
w.tt = lambda: (200, {"code": 0, "data": {"videos": [{"item_id": "1", "average_time_watched": 5}]}})
run(w, **UNITS)
check("tiktok: no item with this video's id is a counted failure and stores nothing",
      (insight_rows(w), [p[2].get("insights_fails") for p in post_patches(w)]), ([], [1]))

# ── 11. agency isolation ─────────────────────────────────────────────────────────────────────────
agency = (HERE / "process_campaigns.py").read_text()
check("11. agency isolation: process_campaigns.py neither imports insights nor names its tables",
      ("import insights" in agency, "lynxr_post_insights" in agency or "lynxr_platform_tokens" in agency), (False, False))

# ── 12. no secret in the log ─────────────────────────────────────────────────────────────────────
src = (HERE / "insights.py").read_text()
tree = ast.parse(src)
HOT_NAMES = {"token", "tok", "handle", "url", "caption", "cid", "creator_id", "access", "key", "secret"}
HOT_KEYS = {"handle", "url", "caption", "access_token", "creator_id", "canonical_url", "token_cipher", "platform_user_id"}


def leaks(node):
    """True when a log call passes something sensitive: the three strings the plan names anywhere in it, or (after the format string) a
    variable or a dict key that holds a token, a handle, a URL, a caption, an id or the service key."""
    seg = ast.get_source_segment(src, node)
    if any(s_ in seg for s_ in ("token_cipher", "access_token", "INSIGHTS_TOKEN_KEY")):
        return True
    for arg in node.args[1:]:
        for n in ast.walk(arg):
            if (isinstance(n, ast.Name) and n.id in HOT_NAMES) or (isinstance(n, ast.Constant) and n.value in HOT_KEYS):
                return True
    return False


log_nodes = [n for n in ast.walk(tree)
             if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name) and n.func.value.id == "log"]
bad = [ast.get_source_segment(src, n).split("\n")[0][:60] for n in log_nodes if leaks(n)]
check("12. insights.py has log calls to check", len(log_nodes) > 5, True)
check("12. no log call names a token, a cipher, the key, a handle, a caption, a URL or an id", bad, [])
check("12. insights.py never reads the encryption key or the app secrets", [s for s in ("INSIGHTS_TOKEN_KEY", "IG_APP_SECRET", "TT_CLIENT_SECRET") if
      any(isinstance(n, ast.Constant) and n.value == s for n in ast.walk(tree))], [])

if FAILS:
    print(f"\n{len(FAILS)} FAILED: " + ", ".join(FAILS))
    sys.exit(1)
print("all checks passed")
