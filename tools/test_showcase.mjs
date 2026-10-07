// Offline checks for showcase.js (the landing page's showcase logic). Same check() style as the pipeline tests.
//   node tools/test_showcase.mjs
import { createRequire } from "node:module";
const S = createRequire(import.meta.url)("../showcase.js");

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const good = () => ({
  id: "0123456789ab", platform: "tiktok", handle: "maya.makes", url: "https://www.tiktok.com/@maya.makes/video/7000000000001",
  cover: "showcase/0123456789ab-0123456789abcdef.jpg", posted: "2026-09-20", tag: null, views: 12400, views_on: "2026-10-04",
  points: [[0, 640], [7, 11200]], followers: { from: 1000, from_on: "2026-09-10", to: 1500, to_on: "2026-10-03" },
});
const payload = (entries, typical = { views: 900, n: 40, day: 7 }) => ({ v: 1, typical, entries });
const keeps = (mut) => { const e = good(); mut(e); return S.parsePayload(payload([e])).entries.length; };

// parsePayload drops anything that is not exactly right
check("parse: a valid entry is kept unchanged", S.parsePayload(payload([good()])).entries, [good()]);
check("parse: http url dropped", keeps((e) => { e.url = "http://www.tiktok.com/@maya.makes/video/7000000000001"; }), 0);
check("parse: lookalike host dropped", keeps((e) => { e.url = "https://www.tiktok.com.evil.example/@a/video/123456"; }), 0);
check("parse: uppercase handle dropped", keeps((e) => { e.handle = "Maya"; }), 0);
check("parse: cover path traversal dropped", keeps((e) => { e.cover = "../x.jpg"; }), 0);
check("parse: views 0 dropped", keeps((e) => { e.views = 0; }), 0);
check("parse: views as a string dropped", keeps((e) => { e.views = "12"; }), 0);
check("parse: bad views_on dropped", keeps((e) => { e.views_on = "2026-13-45"; }), 0);
check("parse: unknown tag dropped", keeps((e) => { e.tag = "staff"; }), 0);
check("parse: agency tag kept", keeps((e) => { e.tag = "agency"; }), 1);
check("parse: comp tag kept", keeps((e) => { e.tag = "comp"; }), 1);
check("parse: unknown platform dropped", keeps((e) => { e.platform = "youtube"; }), 0);
check("parse: instagram url on a tiktok entry dropped", keeps((e) => { e.url = "https://www.instagram.com/reel/AbC1234/"; }), 0);
check("parse: bad points are filtered, good ones sorted", S.parsePayload(payload([{ ...good(), points: [[7, 5], ["x", 1], [0, 2], [1.5, 3], [-1, 3]] }])).entries[0].points, [[0, 2], [7, 5]]);
check("parse: followers under 7 days apart become null", S.parsePayload(payload([{ ...good(), followers: { from: 1, from_on: "2026-10-01", to: 9, to_on: "2026-10-05" } }])).entries[0].followers, null);
check("parse: junk input is empty", S.parsePayload(null), { entries: [], typical: null });
check("parse: typical under 30 videos is null", S.parsePayload(payload([good()], { views: 10, n: 29 })).typical, null);
check("parse: typical is kept as views + n", S.parsePayload(payload([good()], { views: 10, n: 30 })).typical, { views: 10, n: 30 });
check("parse: no typical stays null (no default is invented)", S.parsePayload({ entries: [good()] }).typical, null);

// decide
const three = [good(), good(), good()];
check("decide: 2 entries is few", S.decide({ entries: three.slice(0, 2), typical: { views: 1, n: 40 } }), { show: false, why: "few" });
check("decide: 3 with typical is ok", S.decide({ entries: three, typical: { views: 1, n: 40 } }), { show: true, why: "ok" });
check("decide: 3 without typical is no_typical", S.decide({ entries: three, typical: null }), { show: false, why: "no_typical" });

// devMode: only localhost with obtest=1 and a known mode
check("dev: lynxr.io with the params is null", S.devMode("lynxr.io", "?obtest=1&showcase=sample"), null);
check("dev: www.lynxr.io is null", S.devMode("www.lynxr.io", "?obtest=1&showcase=sample"), null);
check("dev: localhost without obtest is null", S.devMode("localhost", "?showcase=sample"), null);
check("dev: localhost obtest sample", S.devMode("localhost", "?obtest=1&showcase=sample"), "sample");
check("dev: 127.0.0.1 obtest few", S.devMode("127.0.0.1", "?obtest=1&showcase=few"), "few");
check("dev: a look-alike host is null", S.devMode("localhost.evil.example", "?obtest=1&showcase=sample"), null);
check("dev: bogus mode is null", S.devMode("localhost", "?obtest=1&showcase=bogus"), null);
check("dev: no showcase param is null", S.devMode("localhost", "?obtest=1"), null);

// sparkPoints: a zero baseline, measured points only
check("spark: one point is null", S.sparkPoints([[3, 10]]), null);
check("spark: [[0,0],[7,100]]", S.sparkPoints([[0, 0], [7, 100]]), "0,32 100,4");
check("spark: all zero views is null", S.sparkPoints([[0, 0], [7, 0]]), null);
check("spark: same day twice is null", S.sparkPoints([[2, 5], [2, 9]]), null);
const sp = S.sparkPoints([[0, 50], [3, 200], [9, 100]]).split(" ").map((p) => +p.split(",")[1]);
check("spark: no y is below 4 or above 32", sp.every((y) => y >= 4 && y <= 32), true);
check("spark: the peak sits at y = 4", Math.min(...sp), 4);

// followersLine
check("followers: no growth is null", S.followersLine({ from: 500, from_on: "2026-09-10", to: 500, to_on: "2026-10-03" }, String, () => "d"), null);
check("followers: a fall is null, never negative", S.followersLine({ from: 500, from_on: "2026-09-10", to: 400, to_on: "2026-10-03" }, String, () => "d"), null);
check("followers: growth of 500", S.followersLine({ from: 1000, from_on: "2026-09-10", to: 1500, to_on: "2026-10-03" }, String, () => "Sep 10"), "+500 followers since Sep 10");

// the small helpers
check("tag: agency", S.tagText("agency"), ["Lynx Media Group", " creator"]);
check("tag: comp", S.tagText("comp"), ["", "free lynxr plan"]);
check("tag: none", S.tagText(null), null);
check("profile: tiktok", S.profileUrl("tiktok", "a.b"), "https://www.tiktok.com/@a.b");
check("profile: instagram", S.profileUrl("instagram", "a.b"), "https://www.instagram.com/a.b/");
check("views: 12400", S.viewsShort(12400), "12k");
check("views: 1.2m", S.viewsShort(1200000), "1.2m");
check("views: 999999 never reads 1000k", S.viewsShort(999999), "1m");
check("date: a UTC day is read as UTC", S.dateShort("2026-10-05", new Date("2026-12-01T12:00:00Z")), "Oct 5");
check("date: today", S.dateShort("2026-10-05", new Date("2026-10-05T23:30:00Z")), "today");
check("date: other year carries the year", S.dateShort("2025-10-05", new Date("2026-12-01T12:00:00Z")), "Oct 5, 2025");
check("date: junk is empty", S.dateShort("nope"), "");

// weekGain / topOfWeek: "top N videos this week" must be true (owner, 2026-10-06)
const T0 = "2026-10-06";
const ent = (id, views_on, points) => ({ id, views_on, points, views: points.length ? points[points.length - 1][1] : 0 });
check("week: posted within the week gained it all", S.weekGain(ent("a", T0, [[0, 0], [3, 900]]), T0), 900);
check("week: interpolated from the measured points", S.weekGain(ent("b", T0, [[0, 0], [10, 1000], [20, 3000]]), T0), 1400);
check("week: no point reaches back a week -> unknown", S.weekGain(ent("c", T0, [[461, 2178334]]), T0), null);
check("week: a measurement older than a week is not this week", S.weekGain(ent("d", "2026-09-20", [[0, 0], [3, 500]]), T0), null);
check("week: a later measurement date is not trusted", S.weekGain(ent("e", "2026-10-09", [[0, 0], [3, 500]]), T0), null);
check("week: never negative", S.weekGain(ent("f", T0, [[0, 0], [5, 900], [12, 800]]), T0), 0);
const pool = [ent("x1", T0, [[0, 0], [3, 100]]), ent("x2", T0, [[0, 0], [2, 5000]]), ent("x3", T0, [[461, 9e6]]),
  ent("x4", T0, [[0, 0], [4, 700]]), ent("x5", T0, [[0, 0], [1, 300]]), ent("x6", T0, [[0, 0], [6, 2000]]), ent("x7", T0, [[0, 0], [1, 0]])];
check("top: biggest weekly gain first, unknown and zero left out, at most 5",
  S.topOfWeek(pool, 5, T0).map((e) => e.id).join(","), "x2,x6,x4,x5,x1");
check("top: fewer than k is fine", S.topOfWeek(pool.slice(0, 2), 5, T0).map((e) => e.id).join(","), "x2,x1");

// a clip is accepted only in the cover's own form
const clipBase = { id: "a1", platform: "tiktok", handle: "sam", url: "https://www.tiktok.com/@sam/video/1234567890",
  cover: "showcase/0123456789ab-0123456789abcdef.jpg", views: 10, views_on: "2026-10-05", points: [], tag: null };
check("clip: a stored mp4 passes", S.parsePayload({ entries: [{ ...clipBase, clip: "showcase/0123456789ab-0123456789abcdef.mp4" }] }).entries[0].clip,
  "showcase/0123456789ab-0123456789abcdef.mp4");
check("clip: anything else is dropped (not the entry)", S.parsePayload({ entries: [{ ...clipBase, clip: "https://evil.example/x.mp4" }] }).entries[0].clip, undefined);

// cleanFounder: the cofounder's own videos, from this repo only (owner, 2026-10-06)
const fj = (entries, extra = {}) => ({ v: 1, as_of: "2026-10-06", platform: "instagram", handle: "collegewithgawin", entries, ...extra });
const fe = (id, views, x = {}) => ({ id, views, posted: "2026-03-03", url: `https://www.instagram.com/reel/${id}/`, cover: `/assets/showcase/${id}.jpg`, clip: `/assets/showcase/${id}.mp4`, ...x });
const F1 = S.cleanFounder(fj([fe("AAAAA1", 10), fe("BBBBB2", 30), fe("CCCCC3", 20)]));
check("founder: most viewed first, labelled as the cofounder's", F1.entries.map((e) => `${e.id}:${e.tag}:${e.kind}`).join(","), "BBBBB2:founder:founder,CCCCC3:founder:founder,AAAAA1:founder:founder");
check("founder: media only from /assets/showcase/", S.cleanFounder(fj([fe("AAAAA1", 10, { cover: "https://evil.example/a.jpg" })])).entries.length, 0);
check("founder: a bad clip is dropped, not the video", S.cleanFounder(fj([fe("AAAAA1", 10, { clip: "/elsewhere/a.mp4" })])).entries[0].clipSrc, undefined);
check("founder: at most five", S.cleanFounder(fj([1, 2, 3, 4, 5, 6, 7].map((k) => fe(`VIDEO${k}`, k)))).entries.length, 5);
check("founder: wrong platform -> nothing", S.cleanFounder(fj([fe("AAAAA1", 10)], { platform: "tiktok" })).entries.length, 0);
check("founder: tag reads as the cofounder", S.tagText("founder"), ["", "lynxr cofounder"]);
// an entry may carry its own platform, handle and as_of (owner, 2026-10-07: his YouTube Short and second Instagram)
const yt = { id: "oYroN6KecJo", views: 50, posted: "2026-04-04", url: "https://www.youtube.com/shorts/oYroN6KecJo", platform: "youtube", handle: "gawintheory", as_of: "2026-10-07", cover: "/assets/showcase/oYroN6KecJo.jpg" };
const F2 = S.cleanFounder(fj([fe("AAAAA1", 10), yt, fe("BBBBB2", 30, { handle: "gawstudyingtoday" })]));
check("founder: per-entry platform/handle/as_of", F2.entries.map((e) => `${e.platform}:${e.handle}:${e.views_on}`).join(","),
  "youtube:gawintheory:2026-10-07,instagram:gawstudyingtoday:2026-10-06,instagram:collegewithgawin:2026-10-06");
check("founder: a youtube entry needs a shorts link", S.cleanFounder(fj([{ ...yt, url: "https://www.youtube.com/watch?v=oYroN6KecJo" }])).entries.length, 0);
check("founder: an instagram link under youtube is dropped", S.cleanFounder(fj([{ ...yt, url: "https://www.instagram.com/reel/AAAAA1/" }])).entries.length, 0);
check("founder: a bad per-entry handle is dropped", S.cleanFounder(fj([fe("AAAAA1", 10, { handle: "Not Valid" })])).entries.length, 0);
check("founder: tiktok is not a founder platform", S.cleanFounder(fj([fe("AAAAA1", 10, { platform: "tiktok" })])).entries.length, 0);
check("profile: youtube", S.profileUrl("youtube", "gawintheory"), "https://www.youtube.com/@gawintheory");

console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
process.exit(failed ? 1 : 0);
