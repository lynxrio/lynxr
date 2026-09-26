// Tests for the ig-thumb Edge Function, run WITHOUT Deno, Supabase, Apify or Instagram: Node strips the
// TypeScript types, `Deno` and `fetch` are stubbed, and nothing touches the network or spends a cent.
//
//   node --experimental-strip-types supabase/functions/test_edge_ig_thumb.mjs
//
// The cases that matter are the money ones: an anonymous page can call this, and the only things between
// a script kiddie and the Apify cap are the input check, the cache, the limits and the ledger — each one is
// proven here to stop the paid call, not just to return null.
const DIR = new URL(".", import.meta.url).pathname;   // this file lives beside the functions
const ENV = {
  SUPABASE_URL: "https://sb.test",
  SUPABASE_SECRET_KEYS: JSON.stringify({ sb_secret_x: "service-role-key" }),
  APIFY_API_TOKEN: "apify-secret-token",
  IG_THUMB_APIFY_MS: "300",
};
let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
// AbortSignal.timeout's timer is unref'd in Node: without something holding the loop open, the slow-Apify
// case below would end the process instead of timing out.
const keepAlive = setInterval(() => {}, 1000);

const calls = [];
let cacheRows = {};
let existing = new Set();
let takeVerdict = "ok";
let takeBodies = [];
let ledger, ledgerStatus, apify, image, uploads;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || "GET";
  calls.push({ u, method, headers: init.headers || {}, body: init.body });
  if (u.startsWith("https://sb.test/rest/v1/lynxr_thumb_cache?shortcode=eq.")) {
    const sc = u.match(/eq\.([^&]+)/)[1];
    return new Response(JSON.stringify(cacheRows[sc] ? [cacheRows[sc]] : []), { status: 200 });
  }
  if (u.startsWith("https://sb.test/rest/v1/lynxr_thumb_cache?on_conflict")) {
    const b = JSON.parse(init.body); cacheRows[b.shortcode] = b; return new Response("", { status: 201 });
  }
  if (u.startsWith("https://sb.test/storage/v1/object/public/lynxr-covers/") && method === "HEAD") {
    return new Response(null, { status: existing.has(u.split("/").pop()) ? 200 : 400 });
  }
  if (u === "https://sb.test/rest/v1/rpc/ig_thumb_take") {
    takeBodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(takeVerdict), { status: 200 });
  }
  if (u === "https://api.apify.com/v2/users/me/limits") return new Response(JSON.stringify(ledger), { status: ledgerStatus });
  if (u.startsWith("https://api.apify.com/v2/acts/")) return await apify(init);
  if (u.startsWith("https://sb.test/storage/v1/object/lynxr-covers/")) {
    uploads.push({ u, headers: init.headers, n: init.body.length }); return new Response("{}", { status: 200 });
  }
  if (/cdninstagram\.com|fbcdn\.net/.test(u)) return image(init);
  throw new Error("unexpected fetch " + u);
};

const reset = () => {
  calls.length = 0; cacheRows = {}; existing = new Set(); takeVerdict = "ok"; takeBodies = []; uploads = [];
  ledgerStatus = 200;
  ledger = { data: { current: { monthlyUsageUsd: 0.13, activeActorJobCount: 0 }, limits: { maxMonthlyUsageUsd: 5, maxConcurrentActorJobs: 5 } } };
  apify = () => new Response(JSON.stringify([{ shortCode: "x", displayUrl: "https://scontent-mxp2-1.cdninstagram.com/v/a.jpg?oe=1" }]), { status: 200 });
  image = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, ...new Array(2000).fill(1)]), { status: 200, headers: { "content-type": "image/jpeg" } });
  delete ENV.IG_THUMB_MODE; ENV.APIFY_API_TOKEN = "apify-secret-token";
};
reset();

const FN = await import(`${DIR}/ig-thumb/index.ts`);

const results = [];
const check = (n, c, x = "") => results.push(`${c ? "ok  " : "FAIL"} ${n}${x ? " — " + x : ""}`);
const REEL = "https://www.instagram.com/reel/Da3y7RdMYvC/";
const post = (url, origin = "https://lynxr.io", headers = {}) =>
  handler(new Request("https://fn.test/", {
    method: "POST",
    headers: { ...(origin ? { origin } : {}), "content-type": "text/plain;charset=UTF-8", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: JSON.stringify({ url }),
  }));
const apifyCalls = () => calls.filter((c) => c.u.startsWith("https://api.apify.com/v2/acts/"));
let r, b;

// ---------------------------------------------------------------- input validation
check("reel", FN.shortcodeOf("https://www.instagram.com/reel/DLloAbC123x/") === "DLloAbC123x");
check("reels + tracking query", FN.shortcodeOf("https://instagram.com/reels/DLloAbC123x/?igsh=abc") === "DLloAbC123x");
check("p, no scheme", FN.shortcodeOf("instagram.com/p/Da3y7RdMYvC") === "Da3y7RdMYvC");
check("tv on m.", FN.shortcodeOf("https://m.instagram.com/tv/Da3y7RdMYvC") === "Da3y7RdMYvC");
check("profile refused", FN.shortcodeOf("https://www.instagram.com/someone/") === "");
check("explore refused", FN.shortcodeOf("https://www.instagram.com/explore/") === "");
check("lookalike host refused", FN.shortcodeOf("https://instagram.com.evil.net/p/Da3y7RdMYvC") === "");
check("link smuggled in a query refused", FN.shortcodeOf("https://evil.com/?u=instagram.com/p/Da3y7RdMYvC") === "");
check("tiktok refused", FN.shortcodeOf("https://www.tiktok.com/@a/video/123") === "");
check("userinfo refused", FN.shortcodeOf("https://x@instagram.com/p/Da3y7RdMYvC") === "");
check("port refused", FN.shortcodeOf("https://instagram.com:8443/p/Da3y7RdMYvC") === "");
check("javascript: refused", FN.shortcodeOf("javascript:alert(1)//instagram.com/p/Da3y7RdMYvC") === "");
check("too-short code refused", FN.shortcodeOf("https://instagram.com/p/abc") === "");
check("non-string refused", FN.shortcodeOf({}) === "" && FN.shortcodeOf(null) === "");
check("encoded path junk refused", FN.shortcodeOf("https://instagram.com/p/Da3y7%2F..%2F") === "");
check("pipeline cover name matches upload_covers.py", (await FN.coverName("instagram.com/p/Da3y7RdMYvC")) === "4ec0914516df020a0567");
check("only Meta CDNs are fetchable", FN.metaCdn("https://scontent-mxp2-1.cdninstagram.com/v/a.jpg") && FN.metaCdn("https://instagram.fpoa48-1.fna.fbcdn.net/v/a.jpg")
  && !FN.metaCdn("http://scontent.cdninstagram.com/a.jpg") && !FN.metaCdn("https://cdninstagram.com.evil.net/a.jpg") && !FN.metaCdn("https://169.254.169.254/"));

// ---------------------------------------------------------------- visitor key
check("ipv4 kept", FN.ipKey("203.0.113.7") === "203.0.113.7");
check("ipv6 cut to /64", FN.ipKey("2001:db8:1:2::1") === "2001:db8:1:2::/64" && FN.ipKey("2001:db8:1:2:aaaa::1") === FN.ipKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
check("different /64 differs", FN.ipKey("2001:db8:1:3::1") !== FN.ipKey("2001:db8:1:2::1"));
check("v4-mapped v6 is v4", FN.ipKey("::ffff:203.0.113.7") === "203.0.113.7");
check("garbage is empty", FN.ipKey("not-an-ip") === "" && FN.ipKey("1::2::3") === "");
check("cf-connecting-ip wins", FN.clientIp(new Headers({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "1.1.1.1, 198.51.100.2" })).ip === "198.51.100.1");
check("x-forwarded-for read from the right", FN.clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.2" })).ip === "198.51.100.2");
const h1 = await FN.ipHash("203.0.113.7", "2026-09-25"), h2 = await FN.ipHash("203.0.113.8", "2026-09-25"), h3 = await FN.ipHash("203.0.113.7", "2026-09-26");
check("hash differs per address and per day, 32 hex, no raw address", h1 !== h2 && h1 !== h3 && /^[0-9a-f]{32}$/.test(h1) && !h1.includes("203"));

// ---------------------------------------------------------------- the gates in front of the money
reset();
r = await handler(new Request("https://fn.test/", { method: "OPTIONS", headers: { origin: "http://localhost:8811" } }));
check("preflight 204 + CORS for the local preview", r.status === 204 && r.headers.get("access-control-allow-origin") === "http://localhost:8811");
reset(); r = await post(REEL, "https://evil.example");
check("foreign Origin -> 403, nothing fetched", r.status === 403 && calls.length === 0);
reset(); r = await post(REEL, "");
check("no Origin (curl) -> 403, nothing fetched", r.status === 403 && calls.length === 0);
reset(); ENV.IG_THUMB_MODE = "off"; r = await post(REEL); b = await r.json();
check("IG_THUMB_MODE=off -> null, nothing fetched", r.status === 200 && b.thumb === null && b.why === "off" && calls.length === 0);
reset(); r = await post("https://www.tiktok.com/@a/video/1"); b = await r.json();
check("bad url -> 200 null (quiet in the console), nothing fetched", r.status === 200 && b.thumb === null && b.why === "bad_url" && calls.length === 0);
reset(); r = await handler(new Request("https://fn.test/", { method: "POST", headers: { origin: "https://lynxr.io" }, body: "not json" })); b = await r.json();
check("garbage body -> 200 bad_url", r.status === 200 && b.why === "bad_url" && calls.length === 0);

// ---------------------------------------------------------------- $0 paths
reset(); cacheRows.Da3y7RdMYvC = { shortcode: "Da3y7RdMYvC", status: "ok", object_path: "tease/ig/Da3y7RdMYvC.jpg", created_at: new Date().toISOString() };
r = await post(REEL); b = await r.json();
check("cache hit -> bucket url, no Apify, no limit spent",
  b.thumb === "https://sb.test/storage/v1/object/public/lynxr-covers/tease/ig/Da3y7RdMYvC.jpg" && b.why === "hit" && apifyCalls().length === 0 && takeBodies.length === 0);
reset(); existing.add("4ec0914516df020a0567.jpg"); r = await post(REEL); b = await r.json();
check("pipeline's own cover -> free, and remembered",
  b.thumb === "https://sb.test/storage/v1/object/public/lynxr-covers/4ec0914516df020a0567.jpg" && b.why === "cover"
  && apifyCalls().length === 0 && takeBodies.length === 0 && cacheRows.Da3y7RdMYvC?.object_path === "4ec0914516df020a0567.jpg");
reset(); cacheRows.Da3y7RdMYvC = { status: "none", object_path: null, created_at: new Date(Date.now() - 3600e3).toISOString() };
r = await post(REEL); b = await r.json();
check("no-cover remembered for a week -> no Apify", b.thumb === null && b.why === "none" && apifyCalls().length === 0);
reset(); cacheRows.Da3y7RdMYvC = { status: "none", object_path: null, created_at: new Date(Date.now() - 8 * 86400e3).toISOString() };
r = await post(REEL); b = await r.json();
check("no-cover older than a week -> asked again", apifyCalls().length === 1 && b.why === "fresh");
reset(); ENV.IG_THUMB_MODE = "cache"; r = await post(REEL); b = await r.json();
check("IG_THUMB_MODE=cache -> no Apify, no limit spent", b.why === "cache_only" && apifyCalls().length === 0 && takeBodies.length === 0);
reset(); delete ENV.APIFY_API_TOKEN; r = await post(REEL); b = await r.json();
check("no token -> cache only", b.why === "cache_only" && apifyCalls().length === 0);

// ---------------------------------------------------------------- limits and ledger stop the paid call
for (const v of ["ip_hour", "ip_day", "day", "month", "db", "bad_ip"]) {
  reset(); takeVerdict = v; r = await post(REEL); b = await r.json();
  check(`limit '${v}' -> 200 null, no Apify`, r.status === 200 && b.thumb === null && b.why === "limited" && apifyCalls().length === 0);
}
reset(); await post(REEL);
check("limit check gets a hashed visitor + the default limits, never the address",
  takeBodies.length === 1 && /^[0-9a-f]{32}$/.test(takeBodies[0].p_ip) && takeBodies[0].p_ip_hour === 4 && takeBodies[0].p_ip_day === 8
  && takeBodies[0].p_day === 40 && takeBodies[0].p_month_usd === 1.5 && takeBodies[0].p_cost === 0.0027 && !JSON.stringify(takeBodies[0]).includes("203.0.113.7"));
reset(); ENV.IG_THUMB_IP_HOUR = "1"; ENV.IG_THUMB_MONTH_USD = "0.5"; await post(REEL); delete ENV.IG_THUMB_IP_HOUR; delete ENV.IG_THUMB_MONTH_USD;
check("limits come from the secrets", takeBodies[0].p_ip_hour === 1 && takeBodies[0].p_month_usd === 0.5);
reset(); ledger.data.current.monthlyUsageUsd = 3.01; r = await post(REEL); b = await r.json();
check("account has < $2 left -> no Apify (view counts first)", b.why === "ledger" && apifyCalls().length === 0);
reset(); ledger.data.current.activeActorJobCount = 3; r = await post(REEL); b = await r.json();
check("3 of 5 run slots busy -> no Apify", b.why === "ledger" && apifyCalls().length === 0);
reset(); ledgerStatus = 500; r = await post(REEL); b = await r.json();
check("ledger unreadable -> fails closed", b.why === "ledger" && apifyCalls().length === 0);

// ---------------------------------------------------------------- the paid path
reset(); r = await post("https://www.instagram.com/reel/Da3y7RdMYvC/?igsh=zz"); b = await r.json();
const ac = apifyCalls()[0];
check("fresh -> our bucket's url", b.thumb === "https://sb.test/storage/v1/object/public/lynxr-covers/tease/ig/Da3y7RdMYvC.jpg" && b.why === "fresh");
check("Apify gets the canonical /p/ url, one item, a charge cap and a run timeout",
  JSON.parse(ac.body).directUrls[0] === "https://www.instagram.com/p/Da3y7RdMYvC/" && ac.u.includes("maxItems=1") && ac.u.includes("maxTotalChargeUsd=0.01") && ac.u.includes("timeout=25"));
check("token only in the Authorization header", !ac.u.includes("apify-secret-token") && ac.headers.Authorization === "Bearer apify-secret-token");
check("cover uploaded once, upsert, jpeg, under tease/ig/",
  uploads.length === 1 && uploads[0].u === "https://sb.test/storage/v1/object/lynxr-covers/tease/ig/Da3y7RdMYvC.jpg" && uploads[0].headers["x-upsert"] === "true" && uploads[0].headers["Content-Type"] === "image/jpeg");
check("remembered as ok", cacheRows.Da3y7RdMYvC?.status === "ok" && cacheRows.Da3y7RdMYvC?.object_path === "tease/ig/Da3y7RdMYvC.jpg");
check("response carries no token and no Meta url", !JSON.stringify(b).includes("apify-secret-token") && !JSON.stringify(b).includes("cdninstagram"));

// ---------------------------------------------------------------- failures stay quiet and uncached
reset(); apify = (init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("timed out", "TimeoutError"))));
let t0 = Date.now(); r = await post(REEL); b = await r.json();
check("a hung Apify call times out, null, not cached", b.why === "error" && Date.now() - t0 < 2000 && !cacheRows.Da3y7RdMYvC, `${Date.now() - t0}ms`);
reset(); apify = () => new Response(JSON.stringify([{ error: "not_found", errorDescription: "Post does not exist" }]), { status: 200 });
r = await post(REEL); b = await r.json();
check("not_found -> none, remembered", b.why === "none" && cacheRows.Da3y7RdMYvC?.status === "none");
reset(); apify = () => new Response("[]", { status: 200 }); r = await post(REEL); b = await r.json();
check("empty dataset -> transient, not cached", b.why === "error" && !cacheRows.Da3y7RdMYvC);
reset(); apify = () => new Response(JSON.stringify([{ displayUrl: "http://169.254.169.254/latest/meta-data" }]), { status: 200 });
r = await post(REEL); b = await r.json();
check("a non-Meta displayUrl is never fetched", b.why === "none" && !calls.some((c) => c.u.includes("169.254")));
reset(); apify = () => new Response("{}", { status: 402 }); r = await post(REEL); b = await r.json();
check("Apify refusal (402) -> null, not cached", b.why === "error" && !cacheRows.Da3y7RdMYvC);
reset(); image = () => new Response(new Uint8Array(700_000).fill(0xff), { status: 200, headers: { "content-type": "image/jpeg" } });
r = await post(REEL); b = await r.json();
check("oversized image -> no upload", b.why === "error" && uploads.length === 0);
reset(); image = () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
r = await post(REEL); b = await r.json();
check("not a jpeg -> no upload", b.why === "error" && uploads.length === 0);

clearInterval(keepAlive);
console.log(results.join("\n"));
const failed = results.filter((x) => x.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
