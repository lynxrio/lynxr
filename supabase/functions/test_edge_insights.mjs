// Tests for the insights-connect Edge Function, run WITHOUT Deno, Supabase, Instagram or TikTok: Node strips the TypeScript types,
// `Deno` and `fetch` are stubbed, and nothing touches the network. Same harness as test_edge_billing.mjs.
//
//   node --experimental-strip-types supabase/functions/test_edge_insights.mjs
//
// This function holds the keys to a creator's own platform account, so every case here is a way it could fail silently: a forged state,
// a replayed state, a token stored in the clear, a key rotation that wipes every connection, a deauthorize callback anyone could forge.
// EVERY uuid, handle, id and token in this file is invented: it is checked into a public repo.
import { createHmac, createCipheriv, randomBytes } from "node:crypto";

const DIR = new URL(".", import.meta.url).pathname;
const KEY_BYTES = Buffer.from("0123456789abcdef0123456789abcdef");           // 32 invented bytes
const ENV = {
  SUPABASE_URL: "https://sb.test",
  // the new name only: proves the fallback works on a project where the deprecated SUPABASE_SERVICE_ROLE_KEY is gone
  SUPABASE_SECRET_KEYS: JSON.stringify({ "sb_secret_x": "service-role-key" }),
  IG_APP_ID: "ig-app-id-test",
  IG_APP_SECRET: "ig-app-secret-test",
  INSIGHTS_TOKEN_KEY: KEY_BYTES.toString("base64"),
  // TT_SCOPES deliberately unset
};
const UID = "11111111-2222-3333-4444-555555555555";
const HANDLE = "example.creator";
const LONG_TOKEN = "LONGLIVED_TOKEN_PLAINTEXT_0001";
const SHORT_TOKEN = "SHORTLIVED_TOKEN_PLAINTEXT_0001";

let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };

// ── an in-memory stand-in for the three tables the function touches ──────────────────────────────
let calls = [];
let ops = [{ key: "insights.platforms", value: { instagram: true, tiktok: false } }];
let profiles = [{ creator_id: UID, platform: "instagram", handle: HANDLE, verified: true },
                { creator_id: UID, platform: "instagram", handle: "unverified.one", verified: false },
                { creator_id: UID, platform: "tiktok", handle: HANDLE, verified: true }];
let states = [];
let tokens = [];
let rpc = [];
let igShort = () => ({ status: 200, body: { data: [{ access_token: SHORT_TOKEN, user_id: "17841400000000001",
  permissions: "instagram_business_basic,instagram_business_manage_insights" }] } });
let igLong = () => ({ status: 200, body: { access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5184000 } });
let igMe = () => ({ status: 200, body: { username: HANDLE, id: "17841400000000001" } });
let igRefresh = () => ({ status: 200, body: { access_token: "REFRESHED_TOKEN_PLAINTEXT_0002", token_type: "bearer", expires_in: 5184000 } });

const param = (u, name) => decodeURIComponent((u.match(new RegExp(`[?&]${name}=eq\\.([^&]*)`)) || [])[1] ?? "");
const res = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || "GET";
  calls.push({ u, method, body: init.body ? String(init.body) : null });
  if (u.includes("/auth/v1/user")) {
    const tok = (init.headers?.Authorization || "").replace("Bearer ", "");
    return tok === "good-token" ? res(200, { id: UID, email: "c@example.com" }) : res(401, {});
  }
  if (u.includes("/rest/v1/lynxr_ops")) return res(200, ops);
  if (u.includes("/rest/v1/lynxr_profiles")) {
    const hit = profiles.filter((p) => p.creator_id === param(u, "creator_id") && p.platform === param(u, "platform") &&
      p.handle === param(u, "handle") && p.verified);
    return res(200, hit.map((p) => ({ handle: p.handle })));
  }
  if (u.includes("/rest/v1/lynxr_oauth_states")) {
    if (method === "POST") { states.push(JSON.parse(init.body)); return res(201); }
    if (method === "DELETE" && u.includes("state=eq.")) {
      const s = param(u, "state");
      const gone = states.filter((x) => x.state === s);
      states = states.filter((x) => x.state !== s);
      return res(200, gone);
    }
    if (method === "DELETE") return res(200, []);                              // the creator's expired-rows sweep
  }
  if (u.includes("/rest/v1/lynxr_platform_tokens")) {
    if (method === "POST") {                                                    // upsert, merge-duplicates
      const row = JSON.parse(init.body);
      const i = tokens.findIndex((t) => t.creator_id === row.creator_id && t.platform === row.platform && t.handle === row.handle);
      if (i >= 0) tokens[i] = { ...tokens[i], ...row }; else tokens.push(row);
      return res(201);
    }
    if (method === "PATCH") {
      const patch = JSON.parse(init.body);
      for (const t of tokens.filter((x) => x.creator_id === param(u, "creator_id") && x.handle === param(u, "handle"))) Object.assign(t, patch);
      return res(204);
    }
    if (u.includes("platform_user_id=eq.")) {
      const id = param(u, "platform_user_id");
      return res(200, tokens.filter((t) => t.platform === "instagram" && t.platform_user_id === id).map((t) => ({ creator_id: t.creator_id, handle: t.handle })));
    }
    return res(200, tokens.filter((t) => t.creator_id === param(u, "creator_id") && t.platform === param(u, "platform") && t.handle === param(u, "handle")));
  }
  if (u.includes("/rest/v1/lynxr_posts")) return res(204);
  if (u.includes("/rest/v1/rpc/revoke_insights")) {
    const b = JSON.parse(init.body);
    rpc.push(b);
    tokens = tokens.filter((t) => !(t.creator_id === b.p_creator && t.platform === b.p_platform && t.handle === b.p_handle));
    return res(200, 1);
  }
  if (u.startsWith("https://api.instagram.com/oauth/access_token")) { const r = igShort(); return res(r.status, r.body); }
  if (u.startsWith("https://graph.instagram.com/access_token")) { const r = igLong(); return res(r.status, r.body); }
  if (u.startsWith("https://graph.instagram.com/v25.0/me")) { const r = igMe(); return res(r.status, r.body); }
  if (u.startsWith("https://graph.instagram.com/refresh_access_token")) { const r = igRefresh(); return res(r.status, r.body); }
  throw new Error("unexpected fetch " + u.split("?")[0]);
};

// Everything the function logs, so a leak shows up as a failed case rather than in production.
const logged = [];
for (const k of ["log", "warn", "error"]) console[k] = (...a) => logged.push(a.map(String).join(" "));

const results = [];
const check = (name, cond, extra = "") => results.push(`${cond ? "ok  " : "FAIL"} ${name}${!cond && extra ? " — " + extra : ""}`);

await import(`${DIR}/insights-connect/index.ts`);
const fn = handler;

const BASE = "https://fn.test/functions/v1/insights-connect";
const post = (path, body, token = "good-token") =>
  fn(new Request(BASE + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, origin: "https://lynxr.io", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
const get = (path) => fn(new Request(BASE + path, { method: "GET" }));
const reset = () => { calls = []; states = []; tokens = []; rpc = []; logged.length = 0; };
const startIg = async () => {
  const r = await post("", { action: "start", platform: "instagram", handle: HANDLE });
  const j = await r.json();
  return { r, url: j.url, state: j.url ? new URL(j.url).searchParams.get("state") : null };
};
const loc = (r) => r.headers.get("location");

// ── 13. the preflight ────────────────────────────────────────────────────────────────────────────
let r = await fn(new Request(BASE, { method: "OPTIONS", headers: { origin: "https://lynxr.io" } }));
{
  const allowed = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/\s*,\s*/);
  check("preflight 204, and it allows every header a browser caller sends (apikey included)",
    r.status === 204 && ["authorization", "apikey", "content-type", "x-client-info"].every((h) => allowed.includes(h)));
}
r = await fn(new Request("https://fn.test/", { method: "OPTIONS", headers: { origin: "https://lynxr.io" } }));
check("the same preflight works when the platform strips the function name from the path", r.status === 204);

// ── 1. who may start, and whether the platform is offered ────────────────────────────────────────
reset();
r = await post("", { action: "start", platform: "instagram", handle: HANDLE }, "bad-token");
check("1. a bad bearer -> 401", r.status === 401);
r = await fn(new Request(BASE, { method: "POST", body: "{}" }));
check("1. no bearer at all -> 401", r.status === 401);
ops = [{ key: "insights.platforms", value: { instagram: false, tiktok: false } }];
r = await post("", { action: "start", platform: "instagram", handle: HANDLE });
check("1. a good bearer but the platform switched off -> 409 not_offered", r.status === 409 && (await r.json()).error === "not_offered");
ops = [];
r = await post("", { action: "start", platform: "instagram", handle: HANDLE });
check("1. no 'insights.platforms' row at all counts as off", r.status === 409 && (await r.json()).error === "not_offered");
ops = [{ key: "insights.platforms", value: { instagram: true, tiktok: false } }];
r = await post("", { action: "start", platform: "facebook", handle: HANDLE });
check("platform is an allow-list: anything else -> 400", r.status === 400);
r = await post("", { action: "start", platform: "instagram", handle: "Bad Handle; drop" });
check("a handle that is not a handle -> 400 before any query", r.status === 400);

// ── 2. an unverified profile can never be connected ──────────────────────────────────────────────
reset();
r = await post("", { action: "start", platform: "instagram", handle: "unverified.one" });
check("2. a profile the caller has not verified -> 409 not_verified", r.status === 409 && (await r.json()).error === "not_verified");
r = await post("", { action: "start", platform: "instagram", handle: "someone.else" });
check("2. a profile the caller does not have at all -> 409 not_verified", r.status === 409 && (await r.json()).error === "not_verified");
check("2. ... and no state row was written for either", states.length === 0);

// ── 3. TikTok is refused while TT_SCOPES is unset ────────────────────────────────────────────────
reset();
ops = [{ key: "insights.platforms", value: { instagram: true, tiktok: true } }];
r = await post("", { action: "start", platform: "tiktok", handle: HANDLE });
check("3. TikTok with TT_SCOPES unset -> 409 not_configured", r.status === 409 && (await r.json()).error === "not_configured");
check("3. ... and nothing was sent to tiktok.com, and no state was written",
  !calls.some((c) => c.u.includes("tiktok.com")) && states.length === 0);
ENV.TT_CLIENT_KEY = "tt-key-test"; ENV.TT_CLIENT_SECRET = "tt-secret-test";
r = await post("", { action: "start", platform: "tiktok", handle: HANDLE });
check("3. a key and secret without scopes is still refused", r.status === 409 && (await r.json()).error === "not_configured");
// a callback must refuse too, or a state minted before the scope list was removed could still exchange a code
states.push({ state: "t".repeat(43), creator_id: UID, platform: "tiktok", handle: HANDLE, expires_at: new Date(Date.now() + 60000).toISOString() });
calls.length = 0;
r = await get("/tt?code=abc&state=" + "t".repeat(43));
check("3. the TikTok callback exchanges nothing while TT_SCOPES is unset",
  loc(r) === "https://lynxr.io/?insights=failed" && !calls.some((c) => c.u.includes("tiktok.com") || c.u.includes("business-api")));
delete ENV.TT_CLIENT_KEY; delete ENV.TT_CLIENT_SECRET;
ops = [{ key: "insights.platforms", value: { instagram: true, tiktok: false } }];

// ── the authorize URL itself ─────────────────────────────────────────────────────────────────────
reset();
{
  const { r: rr, url, state } = await startIg();
  const p = new URL(url).searchParams;
  check("start: the Instagram authorize URL carries the app id, the exact redirect URI, both scopes and a state",
    rr.status === 200 && url.startsWith("https://www.instagram.com/oauth/authorize?") && p.get("client_id") === "ig-app-id-test" &&
    p.get("redirect_uri") === "https://sb.test/functions/v1/insights-connect/ig" && p.get("response_type") === "code" &&
    p.get("scope") === "instagram_business_basic,instagram_business_manage_insights" && state.length >= 32);
  check("start: the state row is stored with a ten-minute expiry and the caller's id",
    states.length === 1 && states[0].creator_id === UID && states[0].handle === HANDLE &&
    Math.abs(Date.parse(states[0].expires_at) - Date.now() - 600000) < 5000);
  check("start: the response carries the CORS headers for the page's origin", rr.headers.get("access-control-allow-origin") === "https://lynxr.io");
}

// ── 4. an unknown state ──────────────────────────────────────────────────────────────────────────
reset();
r = await get("/ig?code=abc&state=" + "z".repeat(43));
check("4. GET /ig with an unknown state -> 302 to /?insights=failed", r.status === 302 && loc(r) === "https://lynxr.io/?insights=failed");
check("4. ... and api.instagram.com was never called", !calls.some((c) => c.u.includes("api.instagram.com")));
calls.length = 0;
r = await get("/ig?code=abc&state=short");
check("4. a malformed state is refused without even a database read", loc(r) === "https://lynxr.io/?insights=failed" &&
  !calls.some((c) => c.u.includes("lynxr_oauth_states")));
r = await get("/ig?error=access_denied&state=" + "z".repeat(43));
check("the documented cancel case -> /?insights=cancelled", loc(r) === "https://lynxr.io/?insights=cancelled");

// ── 5. single use ────────────────────────────────────────────────────────────────────────────────
reset();
{
  const { state } = await startIg();
  const first = await get(`/ig?code=thecode%23_&state=${state}`);
  const second = await get(`/ig?code=thecode&state=${state}`);
  check("5. the first use of a state connects", loc(first) === "https://lynxr.io/?insights=connected&platform=instagram");
  check("5. the SECOND use of the same state is a 302 failure (single-use)", loc(second) === "https://lynxr.io/?insights=failed");
  const ex = calls.filter((c) => c.u.startsWith("https://api.instagram.com/oauth/access_token"));
  check("5. ... and the second never reached Instagram's code exchange", ex.length === 1);
  const form = new URLSearchParams(ex[0].body);
  check("the code exchange sends the code WITHOUT Meta's trailing #_, and the identical redirect_uri",
    form.get("code") === "thecode" && form.get("redirect_uri") === "https://sb.test/functions/v1/insights-connect/ig" &&
    form.get("grant_type") === "authorization_code");
}
reset();
{
  const { state } = await startIg();
  states[0].expires_at = new Date(Date.now() - 1000).toISOString();
  r = await get(`/ig?code=c&state=${state}`);
  check("an EXPIRED state fails even though it exists", loc(r) === "https://lynxr.io/?insights=failed" &&
    !calls.some((c) => c.u.includes("api.instagram.com")));
}

// ── 6. a creator who unticked the insights permission ────────────────────────────────────────────
reset();
{
  const { state } = await startIg();
  igShort = () => ({ status: 200, body: { data: [{ access_token: SHORT_TOKEN, user_id: "17841400000000001", permissions: "instagram_business_basic" }] } });
  r = await get(`/ig?code=c&state=${state}`);
  check("6. permissions without manage_insights -> 302 no_scope and NO token row", loc(r) === "https://lynxr.io/?insights=no_scope" && tokens.length === 0);
  igShort = () => ({ status: 200, body: { data: [{ access_token: SHORT_TOKEN, user_id: "17841400000000001",
    permissions: "instagram_business_basic,instagram_business_manage_insights" }] } });
}

// ── a token for some OTHER account ───────────────────────────────────────────────────────────────
reset();
{
  const { state } = await startIg();
  igMe = () => ({ status: 200, body: { username: "somebody.else" } });
  r = await get(`/ig?code=c&state=${state}`);
  check("a connect that lands on a DIFFERENT instagram account than the verified one stores nothing", loc(r) === "https://lynxr.io/?insights=failed" && tokens.length === 0);
  igMe = () => ({ status: 200, body: { username: HANDLE } });
}

// ── 7 + 8. the happy path, and the round trip through /token ─────────────────────────────────────
reset();
let seeded;
{
  const { state } = await startIg();
  r = await get(`/ig/?code=c&state=${state}`);                // note the trailing slash: both forms route
  check("7. happy path -> 302 connected", loc(r) === "https://lynxr.io/?insights=connected&platform=instagram");
  const up = calls.find((c) => c.u.includes("lynxr_platform_tokens") && c.method === "POST");
  const row = JSON.parse(up.body);
  seeded = row;
  check("7. the upsert merges on (creator_id, platform, handle)", up.u.includes("on_conflict=creator_id,platform,handle") && String(up.body).length > 0);
  check("7. token_cipher is NOT the plaintext token, and a key_id rides with it",
    row.token_cipher && row.token_cipher !== LONG_TOKEN && !row.token_cipher.includes(LONG_TOKEN) && /^[0-9a-f]{8}$/.test(row.key_id));
  check("7. the row carries the user id, scopes, an expiry about 60 days out and status active",
    row.platform_user_id === "17841400000000001" && row.scopes.includes("instagram_business_manage_insights") &&
    row.status === "active" && Math.abs(Date.parse(row.expires_at) - Date.now() - 5184000_000) < 5000 && row.refresh_cipher === null);
  const dbCalls = calls.filter((c) => c.u.startsWith("https://sb.test"));
  check("7. neither plaintext token ever went to the database", !dbCalls.some((c) => (c.body ?? "").includes(LONG_TOKEN) || (c.body ?? "").includes(SHORT_TOKEN)));
  check("7. the SHORT-lived token is never stored at all (only the long-lived one is exchanged and kept)",
    !tokens.some((t) => JSON.stringify(t).includes(SHORT_TOKEN)));
  const out = logged.join("\n");
  check("7. nothing logged contains a token, the secret, the key, or the creator's full uuid or handle",
    ![LONG_TOKEN, SHORT_TOKEN, ENV.IG_APP_SECRET, ENV.INSIGHTS_TOKEN_KEY, UID, HANDLE, row.token_cipher].some((s) => out.includes(s)), out.slice(0, 200));
  check("7. the lane is reset so a reconnect re-tries every post",
    calls.some((c) => c.u.includes("/rest/v1/lynxr_posts") && c.method === "PATCH" && c.body.includes('"insights_state":"pending"')));
  // independent check of the stored format with Node's own crypto: 12-byte nonce, then ciphertext, then a 16-byte tag
  const raw = Buffer.from(row.token_cipher, "base64");
  const d = (await import("node:crypto")).createDecipheriv("aes-256-gcm", KEY_BYTES, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString();
  check("8. the stored cipher is AES-256-GCM with the nonce prepended (decrypted independently with node:crypto)", plain === LONG_TOKEN);
}

const tokenPost = (body, bearer = "service-role-key") =>
  fn(new Request(BASE + "/token", {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }));
const ids = { creator_id: UID, platform: "instagram", handle: HANDLE };

r = await tokenPost(ids);
{
  const j = await r.json();
  check("8. round trip: /token returns the original plaintext token, the user id and the expiry",
    r.status === 200 && j.access_token === LONG_TOKEN && j.platform_user_id === "17841400000000001" && !!j.expires_at);
  check("8. ... and /token carries no CORS header even on success", !r.headers.get("access-control-allow-origin"));
}

// ── 9. /token is invisible to anyone without the service key ─────────────────────────────────────
r = await tokenPost(ids, "not-the-service-key");
check("9. /token with a wrong bearer -> 404 and no CORS header", r.status === 404 && ![...r.headers.keys()].some((h) => h.startsWith("access-control-")));
r = await fn(new Request(BASE + "/token", { method: "POST", body: JSON.stringify(ids) }));
check("9. /token with no bearer at all -> 404", r.status === 404);
r = await fn(new Request(BASE + "/token", { method: "POST", headers: { authorization: "Bearer good-token" }, body: JSON.stringify(ids) }));
check("9. a creator's own access token is not the service key -> 404", r.status === 404);
r = await tokenPost(ids, "service-role-key");
check("9. the service key given in the platform's new-style dictionary is accepted", r.status === 200);
r = await fn(new Request(BASE + "/token", { method: "OPTIONS", headers: { origin: "https://lynxr.io" } }));
check("9. an OPTIONS preflight on /token is a 404 with no CORS, so a browser cannot even probe it", r.status === 404 && !r.headers.get("access-control-allow-origin"));
r = await tokenPost({ creator_id: "not-a-uuid", platform: "instagram", handle: HANDLE });
check("/token validates its body before any query", r.status === 400);
r = await tokenPost({ ...ids, handle: "never.connected" });
check("/token with no row -> 404 no_token", r.status === 404 && (await r.json()).error === "no_token");

// ── 10. a rotated key must not delete anything ───────────────────────────────────────────────────
tokens = [{ ...seeded, key_id: "deadbeef" }];
logged.length = 0;
r = await tokenPost(ids);
check("10. a stored key_id that differs -> 409 key_rotated", r.status === 409 && (await r.json()).error === "key_rotated");
check("10. ... the row is STILL THERE afterwards, and nothing was revoked", tokens.length === 1 && rpc.length === 0);
check("10. ... and it logged exactly one console.error line", logged.filter((l) => l.includes("key_id mismatch")).length === 1);

// ── 11. a dead token is deleted by the one function that deletes ─────────────────────────────────
const soon = () => ({ ...seeded, connected_at: new Date(Date.now() - 50 * 86400_000).toISOString(),
  expires_at: new Date(Date.now() + 2 * 86400_000).toISOString() });
tokens = [soon()]; rpc = []; calls.length = 0;
igRefresh = () => ({ status: 400, body: { error: { type: "OAuthException", code: 190, message: "Error validating access token" } } });
r = await tokenPost(ids);
check("11. a refresh that returns OAuthException 190 -> rpc/revoke_insights ONCE, and 409 needs_reconnect",
  r.status === 409 && (await r.json()).error === "needs_reconnect" && rpc.length === 1 &&
  rpc[0].p_creator === UID && rpc[0].p_platform === "instagram" && rpc[0].p_handle === HANDLE);
check("11. ... the token row is gone", tokens.length === 0);

tokens = [soon()]; rpc = [];
igRefresh = () => ({ status: 400, body: { error: { type: "OAuthException", code: 4, message: "rate limit" } } });
r = await tokenPost(ids);
check("a RATE LIMIT (an OAuthException, code 4) is transient: 503, nothing revoked, row kept",
  r.status === 503 && (await r.json()).error === "transient" && rpc.length === 0 && tokens.length === 1);
igRefresh = () => ({ status: 503, body: {} });
r = await tokenPost(ids);
check("an HTTP 5xx on the refresh is transient too", r.status === 503 && rpc.length === 0 && tokens.length === 1);

igRefresh = () => ({ status: 200, body: { access_token: "REFRESHED_TOKEN_PLAINTEXT_0002", token_type: "bearer", expires_in: 5184000 } });
r = await tokenPost(ids);
{
  const j = await r.json();
  check("a token inside the refresh window is refreshed first, and the NEW token is returned", r.status === 200 && j.access_token === "REFRESHED_TOKEN_PLAINTEXT_0002");
  check("... the row is re-encrypted with a later expiry and a refreshed_at, never the plaintext",
    tokens[0].token_cipher !== seeded.token_cipher && !tokens[0].token_cipher.includes("REFRESHED") && !!tokens[0].refreshed_at &&
    Date.parse(tokens[0].expires_at) > Date.now() + 50 * 86400_000);
}
tokens = [{ ...soon(), connected_at: new Date().toISOString() }];
calls.length = 0;
r = await tokenPost(ids);
check("a token connected under 24 hours ago is not refreshed (Instagram refuses it, and that refusal looks like death)",
  r.status === 200 && !calls.some((c) => c.u.includes("refresh_access_token")));

tokens = [{ ...seeded, connected_at: new Date(Date.now() - 50 * 86400_000).toISOString(), expires_at: new Date(Date.now() + 20 * 86400_000).toISOString() }];
calls.length = 0;
r = await tokenPost(ids);
check("a token 20 days from expiry is NOT refreshed under the default 10-day window", r.status === 200 && !calls.some((c) => c.u.includes("refresh_access_token")));
calls.length = 0;
r = await tokenPost({ ...ids, refresh_before_days: 30 });
check("... but IS refreshed when the worker's own INSIGHTS_REFRESH_BEFORE_DAYS says 30", r.status === 200 && calls.some((c) => c.u.includes("refresh_access_token")));

// ── 12. Meta's deauthorize callback ──────────────────────────────────────────────────────────────
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const signed = (payloadObj, secret = ENV.IG_APP_SECRET) => {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${sig}.${payload}`;                                      // Meta sends <signature>.<payload>
};
const deauth = (signedRequest) =>
  fn(new Request(BASE + "/ig-deauth", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ signed_request: signedRequest }),
  }));
tokens = [{ ...seeded }]; rpc = []; logged.length = 0;
r = await deauth(signed({ user_id: "17841400000000001" }, "the-wrong-secret"));
check("12. a bad HMAC -> 200 with an empty body (never a 4xx that confirms the format)", r.status === 200 && (await r.text()) === "");
check("12. ... and revoke_insights was NOT called, and the row survives", rpc.length === 0 && tokens.length === 1);
check("12. ... with one console.warn", logged.filter((l) => l.includes("signature did not verify")).length === 1);
r = await deauth("garbage");
check("12. a body that is not even shaped like a signed request -> 200, nothing revoked", r.status === 200 && rpc.length === 0);
r = await deauth(signed({ user_id: "17841400000000001" }));
check("12. a good HMAC -> 200, revoke_insights called ONCE with the right creator", r.status === 200 && rpc.length === 1 &&
  rpc[0].p_creator === UID && rpc[0].p_platform === "instagram" && rpc[0].p_handle === HANDLE);
check("12. ... the deauth route carries no CORS header", !r.headers.get("access-control-allow-origin"));
tokens = [{ ...seeded }]; rpc = [];
r = await deauth(signed({ user_id: "99999999999" }));
check("12. a valid signature for an account lynxr has no token for revokes nothing", r.status === 200 && rpc.length === 0);

// ── 14. nothing else routes ──────────────────────────────────────────────────────────────────────
r = await get("/nonsense");
check("an unknown route -> 404", r.status === 404);
r = await fn(new Request(BASE, { method: "GET" }));
check("GET on the bare function is refused", r.status === 405);

process.stdout.write(results.join("\n") + "\n");   // console.log is captured above, so print directly
const failed = results.filter((x) => x.startsWith("FAIL")).length;
process.stdout.write(failed ? `\n${failed} FAILED\n` : `\nall ${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
