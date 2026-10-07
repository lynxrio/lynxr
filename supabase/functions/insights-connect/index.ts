// insights-connect — lets a creator connect their OWN Instagram (and, once approved, TikTok) account so lynxr can read how long
// people watch their videos, keeps the access token encrypted, and hands the worker a usable token without ever giving it the key.
//
// Plan: ~/.claude/plans/lynxr-social-insights.md. THE PRIVACY POLICY IS THE SPEC: privacy/index.html ("connecting an instagram or
// tiktok account") and data-deletion/index.html ("disconnecting an instagram or tiktok account") are live. We never ask for a platform
// password (the platform asks, and hands us a token); disconnecting deletes the token AND the figures read with it; and a token the
// platform rejects is deleted. All three are kept by ONE database function, public.revoke_insights() (supabase/platform_insights.sql),
// and every route below that has to forget a creator calls it rather than deleting anything itself.
//
// WHY ONE FUNCTION WITH FIVE ROUTES. A dashboard-pasted function is one file with no imports. Splitting it would duplicate
// serviceKey(), the CORS block, the AES helper and the token exchange. Supabase sends everything under
// /functions/v1/insights-connect/... to this file; routeOf() below reads the path after the function name.
//
// DEPLOY: Supabase dashboard → Edge Functions → Deploy a new function → Via Editor → name `insights-connect` → paste this whole
//         file → deploy. Verify JWT: OFF. The platform's redirect arrives with no JWT at all, and this code does its own auth
//         (callerFromToken() for the creator's own calls, the service key for the worker, an HMAC for Meta). After EVERY redeploy,
//         confirm the toggle is still off.
// SECRETS (Edge Functions → Secrets; they apply immediately, no redeploy). Nothing here is a default you can rely on unless marked:
//   IG_APP_ID, IG_APP_SECRET        Meta app → Instagram → Business login settings
//   INSIGHTS_TOKEN_KEY              base64 of 32 random bytes (`openssl rand -base64 32`). Set HERE ONLY: never on Fly, never in .env,
//                                   never in a committed file. A rotated key makes /token answer key_rotated until it is restored.
//   IG_REDIRECT_URI                 optional. Default <SUPABASE_URL>/functions/v1/insights-connect/ig. It must be BYTE-IDENTICAL to the
//                                   string saved in the Meta dashboard (which may add a trailing slash): set it if they differ.
//   INSIGHTS_REFRESH_BEFORE_DAYS    optional, default 10. The worker sends its own value of the same name with every /token call, and that wins.
//   ── TikTok: EVERY STRING BELOW IS UNVERIFIED. The Business API's docs could not be read from any public source (plan, assumption 3).
//      Each is a secret so the owner records the real value from the developer portal; the defaults are guesses and say so.
//   TT_CLIENT_KEY, TT_CLIENT_SECRET   the TikTok app's key and secret.
//   TT_SCOPES                         comma list EXACTLY as the dashboard lists them. NO DEFAULT: while it is empty this function
//                                     refuses to build a TikTok authorize URL and refuses a TikTok callback. A guessed scope never goes live.
//   TT_AUTH_URL      default https://www.tiktok.com/v2/auth/authorize/                                       (UNVERIFIED)
//   TT_TOKEN_URL     default https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/              (UNVERIFIED)
//   TT_REFRESH_URL   default https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/     (UNVERIFIED)
//   TT_REDIRECT_URI  optional, default <SUPABASE_URL>/functions/v1/insights-connect/tt
//   TT_AUTH_ERROR_CODES  comma list of the TikTok response codes that mean "this token is dead for good". NO DEFAULT (unverified): until it
//                        is set a failed TikTok refresh is treated as transient and nothing is deleted.
//   SUPABASE_URL and the service key are injected by the platform; never add them by hand.
//
// ROUTES (path after the function name):
//   POST /            creator's access token as Authorization: Bearer … → { "action":"start", "platform", "handle" } → { "url" }
//   GET  /ig, /ig/    Instagram's redirect URI. Anonymous. Trusts nothing but the single-use state row.
//   GET  /tt, /tt/    TikTok's redirect URI. Same shape. Everything about it is unverified.
//   POST /token       SERVICE ROLE ONLY. The worker's only door to a token. No CORS, and a 404 to anything that fails the bearer check.
//   POST /ig-deauth   Meta's deauthorize callback. Anonymous, HMAC-verified. No CORS.
//
// ENCRYPTION. AES-256-GCM through WebCrypto: 12 random bytes of nonce, ciphertext (with its tag) appended, the lot base64'd into
// token_cipher; key_id = first 8 hex of sha256(raw key). THE KEY NEVER GOES TO FLY: the worker asks /token for a usable token instead of
// decrypting one, so the credential lifecycle (exchange, refresh, revoke) lives in exactly one place and the app secrets never leave
// Supabase. A leaked database backup, or a mis-set RLS policy, yields ciphertext. It does NOT protect against a leaked service-role
// key, which can call /token.
//
// LOGGING. Route names and counts only. Never a token, a cipher, a handle, a URL (a failed fetch's own message can carry one, and the
// Instagram exchange puts the app secret in the query) or a full uuid: creator_id.slice(0, 8) is the house habit.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
// The platform injects the service-role key. `SUPABASE_SERVICE_ROLE_KEY` is the legacy name and is marked deprecated in the dashboard
// in favour of `SUPABASE_SECRET_KEYS`, a JSON dictionary of secret keys — so read the old name first and fall back to the first value
// of the new one. Without this, a project that has dropped the legacy name fails at the first database call with an unauthorised
// error that looks nothing like its cause.
function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const dict = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const first = Object.values(dict).find((v) => typeof v === "string" && v);
    if (first) return first as string;
  } catch { /* fall through to the throw below */ }
  throw new Error("no service role key in the environment");
}
const SB_SERVICE = serviceKey();

/** Every key the worker might legitimately present: the legacy name AND every value of the new dictionary. The worker's key and the
    one serviceKey() picks for outbound calls can be different forms of the same role, and /token must accept either. */
function serviceKeys(): string[] {
  const out: string[] = [];
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) out.push(legacy);
  try {
    const dict = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    for (const v of Object.values(dict)) if (typeof v === "string" && v) out.push(v);
  } catch { /* none */ }
  return out;
}

// The only places a creator's own call may come from, and the only site a redirect ever goes back to. Never echo a caller-supplied URL.
const ORIGINS = ["https://lynxr.io", "http://localhost:8811"];
const SITE = ORIGINS[0];

// Allow-Headers must cover every header a browser caller sends, or the preflight fails and the POST never leaves the page. It once
// listed only authorization + content-type while the app also sent `apikey`, and every live Upgrade click died in the browser
// (billing-checkout, 2026-09-21). apikey and x-client-info are what supabase-js and the app send by habit; allowing them costs nothing.
const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": ORIGINS.includes(origin ?? "") ? origin! : ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });

/** A response with NO CORS headers at all: for the routes a browser has no business reaching. */
const plain = (status: number, body = "") => new Response(body, { status, headers: { "Content-Type": "text/plain" } });

const redirect = (query: string) => new Response(null, { status: 302, headers: { Location: `${SITE}/?insights=${query}` } });

/** What went wrong, WITHOUT the message: a fetch failure's own text can contain the URL, and the Instagram exchange's URL holds the secret. */
const errName = (e: unknown) => (e instanceof Error ? e.name : typeof e);

const env = (k: string, dflt = "") => (Deno.env.get(k) ?? dflt).trim();

const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const IG_SCOPES = "instagram_business_basic,instagram_business_manage_insights";
const IG_NEEDS = "instagram_business_manage_insights";
// Meta's rate-limit codes: the request may simply be retried later, so these are NEVER a reason to delete a token.
const META_TRANSIENT = new Set([4, 17, 32, 613]);

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));

/** Constant-time equality over bytes: an equal-length check, then an XOR loop that never exits early. Never `===` on a secret. */
function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ── PostgREST as the service role ─────────────────────────────────────────────────────────────────

/** (status, data) and never a throw on an HTTP error: callers decide what a 404 or a 409 means. */
async function sb(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}) {
  const headers: Record<string, string> = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.prefer) headers["Prefer"] = init.prefer;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* an empty body is normal for return=minimal */ }
  return { status: res.status, data: data as any };
}

/** Who is calling. Asking the auth server beats decoding the JWT here: it honours revocation, and there is no signing key to get wrong. */
async function callerFromToken(token: string) {
  const res = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id ? { id: u.id as string, email: (u.email ?? "") as string } : null;
}

const q = (v: string) => encodeURIComponent(v);
const profileWhere = (cid: string, platform: string, handle: string) =>
  `creator_id=eq.${q(cid)}&platform=eq.${q(platform)}&handle=eq.${q(handle)}`;

// ── encryption ────────────────────────────────────────────────────────────────────────────────────

/** The key as raw bytes, or null when INSIGHTS_TOKEN_KEY is missing or is not exactly 32 bytes of base64. */
function rawKey(): Uint8Array | null {
  const v = env("INSIGHTS_TOKEN_KEY");
  if (!v) return null;
  try {
    const k = unb64(v);
    return k.length === 32 ? k : null;
  } catch { return null; }
}
const keyId = async (raw: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", raw)).slice(0, 8);
const aesKey = (raw: Uint8Array, use: "encrypt" | "decrypt") =>
  crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [use]);

async function encrypt(plain: string, raw: Uint8Array): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await aesKey(raw, "encrypt"), enc.encode(plain)));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return b64(out);
}

async function decrypt(cipher: string, raw: Uint8Array): Promise<string> {
  const all = unb64(cipher);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await aesKey(raw, "decrypt"), all.slice(12));
  return new TextDecoder().decode(pt);
}

// ── the platforms ─────────────────────────────────────────────────────────────────────────────────

const igRedirectUri = () => env("IG_REDIRECT_URI") || `${SB_URL}/functions/v1/insights-connect/ig`;
const ttRedirectUri = () => env("TT_REDIRECT_URI") || `${SB_URL}/functions/v1/insights-connect/tt`;

// UNVERIFIED defaults (see the header): the owner records the real values from the TikTok developer portal and sets the secrets.
const ttAuthUrl = () => env("TT_AUTH_URL", "https://www.tiktok.com/v2/auth/authorize/");
const ttTokenUrl = () => env("TT_TOKEN_URL", "https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/");
const ttRefreshUrl = () => env("TT_REFRESH_URL", "https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/");
const ttScopes = () => env("TT_SCOPES");   // NO DEFAULT, on purpose
const ttConfigured = () => !!(ttScopes() && env("TT_CLIENT_KEY") && env("TT_CLIENT_SECRET"));
const ttAuthErrors = () => new Set(env("TT_AUTH_ERROR_CODES").split(",").map((s) => s.trim()).filter(Boolean));

/** Which platforms are offered right now: lynxr_ops key 'insights.platforms'. Anything unreadable is "not offered". */
async function offered(platform: string): Promise<boolean> {
  const { status, data } = await sb(`lynxr_ops?key=eq.insights.platforms&select=value`);
  if (status !== 200 || !Array.isArray(data)) return false;
  return data[0]?.value?.[platform] === true;
}

/** Classify an Instagram Graph error body. "permanent": the token is dead for good. "transient": try again later, change nothing. */
function metaFailure(status: number, body: any): "permanent" | "transient" {
  const code = Number(body?.error?.code);
  if (status >= 500 || META_TRANSIENT.has(code)) return "transient";
  if (code === 190 || body?.error?.type === "OAuthException") return "permanent";
  return "transient";
}

// ── (a) POST / — start a connect ──────────────────────────────────────────────────────────────────

async function start(req: Request, origin: string | null) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthenticated" }, 401, origin);
  const caller = await callerFromToken(token);
  if (!caller) return json({ error: "unauthenticated" }, 401, origin);

  const body = await req.json().catch(() => ({}));
  if (String(body?.action ?? "") !== "start") return json({ error: "unknown_action" }, 400, origin);
  const platform = String(body.platform ?? "");
  const handle = String(body.handle ?? "");
  // Allow-lists, before any query: nothing a caller sends reaches the database unvalidated.
  if (platform !== "instagram" && platform !== "tiktok") return json({ error: "unknown_platform" }, 400, origin);
  if (!HANDLE_RE.test(handle)) return json({ error: "bad_handle" }, 400, origin);

  // The browser also hides the button when this is false; this is the gate, not the path.
  if (!(await offered(platform))) return json({ error: "not_offered" }, 409, origin);

  // A verified profile only: connecting an unverified handle would let someone attach a token to a username they have not proved is theirs.
  const prof = await sb(`lynxr_profiles?${profileWhere(caller.id, platform, handle)}&verified_at=not.is.null&select=handle`);
  if (prof.status !== 200 || !Array.isArray(prof.data) || prof.data.length === 0) return json({ error: "not_verified" }, 409, origin);

  // Refuse BEFORE the state is written and before anything is built, so a half-configured platform can never be started.
  if (platform === "instagram" && !env("IG_APP_ID")) { console.error("start: IG_APP_ID unset"); return json({ error: "not_configured" }, 409, origin); }
  if (platform === "tiktok" && !ttConfigured()) { console.error("start: tiktok not configured"); return json({ error: "not_configured" }, 409, origin); }

  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  // The table cleans itself: this creator's expired rows go before the new one is written.
  await sb(`lynxr_oauth_states?creator_id=eq.${q(caller.id)}&expires_at=lt.${q(new Date(now).toISOString())}`, { method: "DELETE" });
  const ins = await sb("lynxr_oauth_states", {
    method: "POST", prefer: "return=minimal",
    body: { state, creator_id: caller.id, platform, handle, expires_at: new Date(now + 10 * 60_000).toISOString() },
  });
  if (ins.status < 200 || ins.status >= 300) {
    console.error("start: state insert failed", ins.status);   // 404 here means supabase/platform_insights.sql was never run
    return json({ error: "not_ready" }, 503, origin);
  }

  let url: string;
  if (platform === "instagram") {
    const p = new URLSearchParams({
      client_id: env("IG_APP_ID"), redirect_uri: igRedirectUri(), response_type: "code", scope: IG_SCOPES, state,
    });
    url = `https://www.instagram.com/oauth/authorize?${p}`;
  } else {
    // UNVERIFIED parameter names (plan, assumption 3). Built only when TT_SCOPES, the key and the secret are all set.
    const p = new URLSearchParams({
      client_key: env("TT_CLIENT_KEY"), scope: ttScopes(), response_type: "code", redirect_uri: ttRedirectUri(), state,
    });
    url = `${ttAuthUrl()}?${p}`;
  }
  console.log("start", platform, caller.id.slice(0, 8));
  return json({ url }, 200, origin);
}

// ── (b)/(c) the redirect URIs ─────────────────────────────────────────────────────────────────────

/** Look the state up AND delete it in the same request: single use is what makes the callback CSRF-safe. null = unknown, used, or malformed. */
async function takeState(state: string, platform: string) {
  if (!STATE_RE.test(state)) return null;
  const r = await sb(`lynxr_oauth_states?state=eq.${q(state)}`, { method: "DELETE", prefer: "return=representation" });
  const row = r.status === 200 && Array.isArray(r.data) ? r.data[0] : null;
  if (!row || row.platform !== platform) return null;
  if (!(Date.parse(row.expires_at) > Date.now())) return null;
  return row as { creator_id: string; platform: string; handle: string };
}

/** Write the token row, then reset that profile's lane so a reconnect re-tries every post. */
async function storeToken(row: { creator_id: string; platform: string; handle: string }, fields: Record<string, unknown>) {
  const up = await sb("lynxr_platform_tokens?on_conflict=creator_id,platform,handle", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      creator_id: row.creator_id, platform: row.platform, handle: row.handle,
      connected_at: new Date().toISOString(), status: "active", poll_fails: 0, ...fields,
    },
  });
  if (up.status < 200 || up.status >= 300) return false;   // a profile removed mid-connect fails the foreign key: nothing is stored
  await sb(`lynxr_posts?${profileWhere(row.creator_id, row.platform, row.handle)}`, {
    method: "PATCH", prefer: "return=minimal", body: { insights_state: "pending", insights_fails: 0 },
  });
  return true;
}

async function igCallback(url: URL) {
  const params = url.searchParams;
  const state = params.get("state") ?? "";
  // The documented cancel case: the creator pressed Cancel at Instagram. Consume the state if it came back, then go home quietly.
  if (params.get("error") === "access_denied") {
    if (STATE_RE.test(state)) await sb(`lynxr_oauth_states?state=eq.${q(state)}`, { method: "DELETE", prefer: "return=minimal" });
    return redirect("cancelled");
  }
  // Meta appends `#_` to the code and says it is not part of the code.
  const code = (params.get("code") ?? "").replace(/#_$/, "");
  if (!code || !state) return redirect("failed");
  const st = await takeState(state, "instagram");
  if (!st) return redirect("failed");        // unknown, already used, expired, or not an Instagram state: no outbound call was made
  const secret = env("IG_APP_SECRET");
  const key = rawKey();
  if (!env("IG_APP_ID") || !secret || !key) { console.error("ig callback: secrets not set"); return redirect("failed"); }

  // 1. code → short-lived token. redirect_uri must be byte-identical to the one in the authorize URL or Meta rejects it.
  const short = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("IG_APP_ID"), client_secret: secret, grant_type: "authorization_code",
      redirect_uri: igRedirectUri(), code,
    }),
  });
  const sj = await short.json().catch(() => null);
  const first = sj?.data?.[0] ?? sj;           // the documented shape is {"data":[{…}]}: an ARRAY inside data
  if (!short.ok || !first?.access_token || !first?.user_id) { console.error("ig callback: code exchange failed", short.status); return redirect("failed"); }
  const perms = Array.isArray(first.permissions) ? first.permissions.join(",") : String(first.permissions ?? "");
  // A creator who unticked the insights permission would otherwise be polled forever for nothing.
  if (!perms.split(/[,\s]+/).includes(IG_NEEDS)) { console.warn("ig callback: insights permission not granted"); return redirect("no_scope"); }

  // 2. short → long-lived (about 60 days). Only the long-lived token is ever stored.
  const longRes = await fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({
    grant_type: "ig_exchange_token", client_secret: secret, access_token: String(first.access_token),
  })}`);
  const lj = await longRes.json().catch(() => null);
  if (!longRes.ok || !lj?.access_token) { console.error("ig callback: long-lived exchange failed", longRes.status); return redirect("failed"); }

  // 3. Is this the account the creator verified? A token for some OTHER account attached to this handle would poll nothing useful.
  //    Fail closed only on a PROVEN mismatch; if the platform does not say, proceed (the shortcode match cannot join a stranger's media).
  try {
    const me = await fetch(`https://graph.instagram.com/v25.0/me?${new URLSearchParams({ fields: "username", access_token: lj.access_token })}`);
    const who = me.ok ? String((await me.json())?.username ?? "").toLowerCase() : "";
    if (who && who !== st.handle) { console.warn("ig callback: account does not match the verified profile"); return redirect("failed"); }
    if (!who) console.warn("ig callback: username not returned; proceeding");
  } catch (e) { console.warn("ig callback: username check skipped", errName(e)); }

  const ok = await storeToken(st, {
    platform_user_id: String(first.user_id).slice(0, 64),
    token_cipher: await encrypt(String(lj.access_token), key), refresh_cipher: null, key_id: await keyId(key),
    scopes: perms.slice(0, 500),
    expires_at: new Date(Date.now() + Number(lj.expires_in || 60 * 86400) * 1000).toISOString(),
    refreshed_at: null,
  });
  if (!ok) { console.error("ig callback: token row not stored"); return redirect("failed"); }
  console.log("connected instagram", st.creator_id.slice(0, 8));
  return redirect("connected&platform=instagram");
}

/** TikTok's redirect. EVERYTHING here is unverified (plan, assumption 3): it is written so that one wrong guess shows up as a logged
    refusal and a redirect to ?insights=failed, never as a silently wrong row. TikTok's envelope is {"data":{…},"code":0,"message":"ok"}:
    `code === 0` is checked, not just the HTTP status. */
async function ttCallback(url: URL) {
  const params = url.searchParams;
  const state = params.get("state") ?? "";
  if (params.get("error")) {
    if (STATE_RE.test(state)) await sb(`lynxr_oauth_states?state=eq.${q(state)}`, { method: "DELETE", prefer: "return=minimal" });
    return redirect("cancelled");
  }
  const code = params.get("code") ?? "";
  if (!code || !state) return redirect("failed");
  const st = await takeState(state, "tiktok");
  if (!st) return redirect("failed");
  const key = rawKey();
  if (!ttConfigured() || !key) { console.error("tt callback: not configured"); return redirect("failed"); }   // no scopes, no exchange

  const res = await fetch(ttTokenUrl(), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: env("TT_CLIENT_KEY"), client_secret: env("TT_CLIENT_SECRET"), code, grant_type: "authorization_code",
      redirect_uri: ttRedirectUri(),
    }),
  });
  const j = await res.json().catch(() => null);
  const d = j?.data;
  if (!res.ok || j?.code !== 0 || !d?.access_token) { console.error("tt callback: token exchange refused", res.status, j?.code ?? ""); return redirect("failed"); }
  // The Business API uses the open id as the business_id on every query.
  const openId = String(d.open_id ?? d.business_id ?? "").slice(0, 64);
  if (!openId) { console.error("tt callback: no open id in the response"); return redirect("failed"); }
  const ok = await storeToken(st, {
    platform_user_id: openId,
    token_cipher: await encrypt(String(d.access_token), key),
    refresh_cipher: d.refresh_token ? await encrypt(String(d.refresh_token), key) : null,
    key_id: await keyId(key), scopes: String(d.scope ?? ttScopes()).slice(0, 500),
    expires_at: d.expires_in ? new Date(Date.now() + Number(d.expires_in) * 1000).toISOString() : null, refreshed_at: null,
  });
  if (!ok) { console.error("tt callback: token row not stored"); return redirect("failed"); }
  console.log("connected tiktok", st.creator_id.slice(0, 8));
  return redirect("connected&platform=tiktok");
}

// ── (d) POST /token — the worker's only door ──────────────────────────────────────────────────────

function isService(req: Request): boolean {
  const presented = enc.encode((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  let match = false;
  for (const k of serviceKeys()) if (safeEqual(presented, enc.encode(k))) match = true;   // no early exit between candidates
  return match;
}

async function revoke(cid: string, platform: string, handle: string) {
  return await sb("rpc/revoke_insights", { method: "POST", body: { p_creator: cid, p_platform: platform, p_handle: handle } });
}

async function tokenRoute(req: Request) {
  // Anything that fails the bearer check is a plain 404 with no CORS headers at all: a browser cannot discover this route exists.
  if (req.method !== "POST" || !isService(req)) return plain(404, "not found");
  const body = await req.json().catch(() => ({}));
  const cid = String(body?.creator_id ?? ""), platform = String(body?.platform ?? ""), handle = String(body?.handle ?? "");
  if (!UUID_RE.test(cid) || (platform !== "instagram" && platform !== "tiktok") || !HANDLE_RE.test(handle)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const reply = (b: unknown, status: number) => Response.json(b, { status });   // JSON, deliberately without CORS

  const got = await sb(`lynxr_platform_tokens?${profileWhere(cid, platform, handle)}&select=*`);
  if (got.status !== 200 || !Array.isArray(got.data)) return reply({ error: "transient" }, 503);
  const row = got.data[0];
  if (!row) return reply({ error: "no_token" }, 404);
  if (row.status === "needs_reconnect") return reply({ error: "needs_reconnect" }, 409);

  const key = rawKey();
  if (!key) { console.error("token: INSIGHTS_TOKEN_KEY missing or not 32 bytes"); return reply({ error: "no_key" }, 500); }
  // A mis-set secret must be fixable by fixing the secret, not by making every creator reconnect: the row is NOT deleted.
  if (row.key_id !== await keyId(key)) { console.error("token: key_id mismatch (INSIGHTS_TOKEN_KEY changed?)"); return reply({ error: "key_rotated" }, 409); }
  let access: string;
  let refreshTok: string | null = null;
  try {
    access = await decrypt(row.token_cipher, key);
    if (row.refresh_cipher) refreshTok = await decrypt(row.refresh_cipher, key);
  } catch { console.error("token: could not decrypt a stored token"); return reply({ error: "key_rotated" }, 409); }

  let expiresAt: string | null = row.expires_at ?? null;
  // The worker passes its own INSIGHTS_REFRESH_BEFORE_DAYS in the body (service role only, so it is trusted, but still bounded).
  const asked = Number(body?.refresh_before_days);
  const days = (asked >= 1 && asked <= 50 ? asked : Number(env("INSIGHTS_REFRESH_BEFORE_DAYS", "10"))) || 10;
  const soon = expiresAt !== null && Date.parse(expiresAt) - Date.now() < days * 86400_000;
  // Instagram refuses a refresh for a token under 24 hours old, and that refusal is an OAuthException we would read as "dead".
  const ageMs = Date.now() - Date.parse(row.refreshed_at ?? row.connected_at ?? 0);
  if (soon && !(platform === "instagram" && ageMs < 86400_000)) {
    let result: { token: string; refresh?: string | null; expires: string | null } | "permanent" | "transient";
    try {
      result = platform === "instagram" ? await refreshInstagram(access) : await refreshTikTok(refreshTok);
    } catch (e) { console.warn("token: refresh call failed", errName(e)); result = "transient"; }
    if (result === "permanent") {
      // The privacy policy's "lynxr's next request fails and we delete the dead token": kept here, by the one function that deletes.
      await revoke(cid, platform, handle);
      console.log("token: dead token removed", platform, cid.slice(0, 8));
      return reply({ error: "needs_reconnect" }, 409);
    }
    if (result === "transient") return reply({ error: "transient" }, 503);
    access = result.token;
    expiresAt = result.expires;
    const patch: Record<string, unknown> = {
      token_cipher: await encrypt(result.token, key), key_id: await keyId(key), expires_at: result.expires,
      refreshed_at: new Date().toISOString(),
    };
    if (result.refresh) patch.refresh_cipher = await encrypt(result.refresh, key);
    await sb(`lynxr_platform_tokens?${profileWhere(cid, platform, handle)}`, { method: "PATCH", prefer: "return=minimal", body: patch });
    console.log("token: refreshed", platform, cid.slice(0, 8));
  }
  return reply({ access_token: access, platform_user_id: row.platform_user_id, expires_at: expiresAt }, 200);
}

async function refreshInstagram(access: string) {
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: access })}`);
  const j = await r.json().catch(() => null);
  if (r.ok && j?.access_token) {
    return { token: String(j.access_token), expires: new Date(Date.now() + Number(j.expires_in || 60 * 86400) * 1000).toISOString() };
  }
  return metaFailure(r.status, j);
}

/** UNVERIFIED (plan, assumption 3). Only the response codes listed in TT_AUTH_ERROR_CODES are ever read as "dead for good". */
async function refreshTikTok(refresh: string | null) {
  if (!refresh) return "transient" as const;
  const r = await fetch(ttRefreshUrl(), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: env("TT_CLIENT_KEY"), client_secret: env("TT_CLIENT_SECRET"), grant_type: "refresh_token", refresh_token: refresh,
    }),
  });
  const j = await r.json().catch(() => null);
  if (r.ok && j?.code === 0 && j?.data?.access_token) {
    const d = j.data;
    return {
      token: String(d.access_token), refresh: d.refresh_token ? String(d.refresh_token) : null,
      expires: d.expires_in ? new Date(Date.now() + Number(d.expires_in) * 1000).toISOString() : null,
    };
  }
  if (r.status < 500 && ttAuthErrors().has(String(j?.code))) return "permanent" as const;
  return "transient" as const;
}

// ── (e) POST /ig-deauth — Meta's deauthorize callback ─────────────────────────────────────────────

async function igDeauth(req: Request) {
  if (req.method !== "POST") return plain(405);
  const secret = env("IG_APP_SECRET");
  let signed = "";
  try { signed = String((await req.formData()).get("signed_request") ?? ""); } catch { /* falls to the bad-signature path */ }
  // Meta sends <signature>.<payload>: the FIRST part is the signature. Anything wrong is a 200 with an empty body, never a 4xx that
  // tells a prober it guessed the format.
  const [sigPart, payloadPart] = signed.split(".");
  let valid = false;
  let payload: any = null;
  try {
    if (secret && sigPart && payloadPart) {
      const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const want = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(payloadPart)));
      valid = safeEqual(want, unb64url(sigPart));
      if (valid) payload = JSON.parse(new TextDecoder().decode(unb64url(payloadPart)));
    }
  } catch { valid = false; }
  if (!valid || !payload) { console.warn("ig-deauth: signature did not verify"); return new Response("", { status: 200 }); }

  // The payload's user_id is the Instagram-scoped id, which is exactly what platform_user_id holds.
  const uid = String(payload.user_id ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) return Response.json({}, { status: 200 });
  const rows = await sb(`lynxr_platform_tokens?platform=eq.instagram&platform_user_id=eq.${q(uid)}&select=creator_id,handle`);
  let n = 0;
  for (const r of rows.status === 200 && Array.isArray(rows.data) ? rows.data : []) {
    await revoke(r.creator_id, "instagram", r.handle);
    n++;
  }
  console.log("ig-deauth: revoked", n);
  return Response.json({}, { status: 200 });
}

// ── routing ───────────────────────────────────────────────────────────────────────────────────────

/** The path after the function name, with no trailing slash ("/" for the bare function). Supabase may or may not keep the function name
    in the pathname, so both /insights-connect/ig and /ig route the same. */
function routeOf(href: string): string {
  const p = new URL(href).pathname.replace(/\/+$/, "");
  const i = p.lastIndexOf("/insights-connect");
  const rest = i >= 0 ? p.slice(i + "/insights-connect".length) : p;
  return rest === "" ? "/" : rest;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const route = routeOf(req.url);
  try {
    if (route === "/token") return await tokenRoute(req);
    if (route === "/ig-deauth") return await igDeauth(req);
    if (route === "/ig") return req.method === "GET" ? await igCallback(new URL(req.url)) : plain(405);
    if (route === "/tt") return req.method === "GET" ? await ttCallback(new URL(req.url)) : plain(405);
    if (route === "/") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      if (req.method !== "POST") return json({ error: "method" }, 405, origin);
      return await start(req, origin);
    }
    return plain(404, "not found");
  } catch (e) {
    console.error("insights error", route, errName(e));
    // A redirect route must still land the browser somewhere sensible; every other route answers a bare 500.
    if (route === "/ig" || route === "/tt") return redirect("failed");
    return route === "/" ? json({ error: "server" }, 500, origin) : plain(500);
  }
});
