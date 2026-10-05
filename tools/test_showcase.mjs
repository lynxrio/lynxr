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

console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
process.exit(failed ? 1 : 0);
