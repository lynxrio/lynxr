// ig-thumb — the cover image of ONE public Instagram post, for the blurred tease behind the sign-up
// (index.html #gate-tease; creator.js wireOneHero → fetchIgThumb).
//
// WHY THIS EXISTS. Instagram has no sign-in-free thumbnail. TikTok's comes from its public oEmbed in the
// browser; Instagram's only reliable source is the paid Apify actor the Fly worker already uses for view
// counts (pipeline/process_adaptations.py apify_views(): apify~instagram-scraper, directUrls, one result).
// An anonymous visitor can call this, and the Apify token must never reach a browser, so every cent is
// gated HERE, in this order:
//   1. input   an instagram.com /p/ /reel/ /reels/ /tv/ link, reduced to its shortcode — nothing else
//   2. cache   lynxr_thumb_cache, then the covers the pipeline already published under
//              lynxr-covers/<sha1(canon url)[:20]>.jpg — a hit costs $0
//   3. limits  ig_thumb_take() (supabase/ig_thumb.sql): per visitor (HMAC of the IP) per hour and per day,
//              everyone per day, and a MONTHLY dollar ceiling for this feature alone
//   4. ledger  Apify's own numbers: refuse unless the account keeps IG_THUMB_HEADROOM_USD unspent and two
//              concurrent-run slots free — Instagram view counts come first
//   5. time    every outbound call has a timeout
// Any refusal or failure answers 200 {"thumb": null}: the tease keeps its gradient and the browser logs
// nothing. Only a foreign Origin (403) or a wrong method (405) is an error status.
//
// THE IMAGE IS COPIED, NOT LINKED. Instagram's cover URLs are signed and expire in ~4–5 days (the `oe`
// parameter; an expired one answers 403, measured 2026-09-25) and come from two CDN families
// (*.cdninstagram.com, *.fbcdn.net). A copy in the public lynxr-covers bucket is durable, so the cache
// works; it needs no CSP change (index.html img-src already allows the Supabase origin); and the
// visitor's browser never contacts Meta.
//
// DEPLOY: Supabase dashboard → Edge Functions → Deploy a new function → Via Editor → name `ig-thumb` →
//         paste this whole file → Deploy. Then open the function → Details → "Enforce JWT verification"
//         OFF (the caller is anonymous; the site's key is a publishable key, not a JWT). After EVERY
//         redeploy, confirm the toggle is still off.
// SECRETS (Edge Functions → Secrets; they apply immediately, no redeploy):
//   APIFY_API_TOKEN        required for NEW lookups; absent = cache-only. Use a DEDICATED Apify token, not
//                          Fly's, so revoking it can never stop view counts.
//   IG_THUMB_MODE          "off" = answer null to everything, touch nothing · "cache" = never call Apify ·
//                          unset or "on" = full
//   IG_THUMB_IP_HOUR       default 4     paid lookups per visitor per hour
//   IG_THUMB_IP_DAY        default 8     paid lookups per visitor per UTC day
//   IG_THUMB_DAY           default 40    paid lookups per UTC day, everyone together
//   IG_THUMB_MONTH_USD     default 1.50  this feature's ceiling per UTC calendar month
//   IG_THUMB_HEADROOM_USD  default 2.00  refuse while Apify's account has less than this left
//   IG_THUMB_APIFY_MS / IG_THUMB_IO_MS / IG_THUMB_HEAD_MS   timeouts (30000 / 8000 / 3000); the tests shorten them
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS are injected by the platform.
//
// CALL (from the page, a CORS "simple request" — text/plain, no custom headers, so no preflight):
//   POST {"url": "https://www.instagram.com/reel/<code>/"}
//   → 200 {"thumb": "https://…/storage/v1/object/public/lynxr-covers/…jpg" | null, "why": "…"}
//   why: hit | cover | fresh | none | limited | ledger | cache_only | off | bad_url | error

const SB_URL = Deno.env.get("SUPABASE_URL")!;
// DUPLICATED from billing-checkout/index.ts (a dashboard-pasted function is one file; there is no shared
// module to import). The legacy name first, then the first value of the new SUPABASE_SECRET_KEYS dictionary.
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

const ORIGINS = ["https://lynxr.io", "http://localhost:8811"];
const BUCKET = "lynxr-covers";
const PUBLIC = `${SB_URL}/storage/v1/object/public/${BUCKET}/`;
const APIFY_ACTOR = "apify~instagram-scraper";   // actor id shu8hvrXbJbY3Eb9W — the view-count actor
const APIFY_PRICE_USD = 0.0027;   // its one charged event, "result" (pay-per-event), read off a live run 2026-09-25
const APIFY_RUN_TIMEOUT_S = 25;   // the actor's own run limit; live runs measured 5.1–15.7s, median 7.6s
const MAX_IMAGE_BYTES = 600_000;  // live covers measured 60–284 KB
const NONE_TTL_MS = 7 * 24 * 3600 * 1000;   // a post with no cover is asked again after a week, not every paste

const num = (name: string, dflt: number): number => {
  const raw = Deno.env.get(name);
  const v = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": ORIGINS.includes(origin ?? "") ? origin! : ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});
const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
const noThumb = (why: string, origin: string | null, status = 200) => json({ thumb: null, why }, status, origin);

/** The shortcode of ONE Instagram post, or "" for anything else. Mirrors creator.js videoLikePath():
    instagram.com or a subdomain, then /p/, /reel/, /reels/ or /tv/ and the code. No userinfo, no port. */
export function shortcodeOf(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 500) return "";
  let u: URL;
  try { u = new URL(raw.includes("://") ? raw : "https://" + raw); } catch { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  if (u.username || u.password || u.port) return "";
  const host = u.hostname.toLowerCase();
  if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return "";
  const m = u.pathname.match(/^\/(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,64})(?:\/|$)/);
  return m ? m[1] : "";
}

/** An address as a rate-limit key: IPv4 as is, IPv6 cut to its /64 (one phone or household holds a
    whole /64 and could otherwise rotate through it). "" when it is not an address. */
export function ipKey(ip: string): string {
  const s = String(ip || "").trim().toLowerCase().split("%")[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (!s.includes(":")) return "";
  const parts = s.split("::");
  if (parts.length > 2) return "";
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return "";
  const groups = [...head, ...new Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return "";
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

/** Who is asking. cf-connecting-ip is set by Cloudflare, which fronts Supabase, and a client cannot forge
    it; x-forwarded-for is the fallback, read from the RIGHT because a client-supplied value is prepended.
    `src` is logged (never the address) so the owner can see which one the platform actually sends. */
export function clientIp(h: Headers): { ip: string; src: string } {
  const cf = (h.get("cf-connecting-ip") ?? "").trim();
  if (cf) return { ip: ipKey(cf), src: "cf" };
  const xff = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (xff.length) return { ip: ipKey(xff[xff.length - 1]), src: "xff" };
  return { ip: "", src: "none" };
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 of the day and the address, keyed off the service key: 32 hex, never the address itself.
    The day is part of the input, so a stored hash cannot be linked to the same visitor on another day. */
export async function ipHash(ip: string, day: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode("ig-thumb-ip|" + SB_SERVICE),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(day + "|" + (ip || "unknown")))).slice(0, 32);
}

/** The pipeline's cover name for a canonical URL — sha1(canon_url(url))[:20], as upload_cover() and
    upload_covers.py write it. */
export async function coverName(canon: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(canon))).slice(0, 20);
}

/** Only Meta's own image CDNs are ever fetched — an Apify item is outside data, and this stops it
    pointing the function at anything else (an internal address, a huge file host). */
export function metaCdn(u: string): boolean {
  try {
    const x = new URL(u);
    const h = x.hostname.toLowerCase();
    return x.protocol === "https:" && !x.port && (h.endsWith(".cdninstagram.com") || h.endsWith(".fbcdn.net"));
  } catch { return false; }
}

const io = () => AbortSignal.timeout(num("IG_THUMB_IO_MS", 8000));
const sbHeaders = () => ({ apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` });

async function cacheGet(sc: string): Promise<{ status: string; object_path: string | null; created_at: string } | null> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/lynxr_thumb_cache?shortcode=eq.${sc}&select=status,object_path,created_at`,
      { headers: sbHeaders(), signal: io() });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch { return null; }
}

/** created_at is written explicitly: `default now()` does not re-apply on a merge-duplicates upsert. */
async function cachePut(sc: string, status: "ok" | "none", objectPath: string | null): Promise<void> {
  try {
    await fetch(`${SB_URL}/rest/v1/lynxr_thumb_cache?on_conflict=shortcode`, {
      method: "POST",
      headers: { ...sbHeaders(), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ shortcode: sc, status, object_path: objectPath, created_at: new Date().toISOString() }),
      signal: io(),
    });
  } catch { /* the answer still goes out; the next paste of this video just looks it up again */ }
}

/** A cover the pipeline already published for this post, under any of the four URL shapes. Free. */
async function existingCover(sc: string): Promise<string> {
  const names = await Promise.all(["reel", "p", "reels", "tv"].map((f) => coverName(`instagram.com/${f}/${sc}`)));
  const found = await Promise.all(names.map(async (n) => {
    try {
      const r = await fetch(`${PUBLIC}${n}.jpg`, { method: "HEAD", signal: AbortSignal.timeout(num("IG_THUMB_HEAD_MS", 3000)) });
      return r.status === 200 ? `${n}.jpg` : "";   // a missing object answers 400
    } catch { return ""; }
  }));
  return found.find(Boolean) ?? "";
}

async function take(ipH: string): Promise<string> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/ig_thumb_take`, {
      method: "POST",
      headers: { ...sbHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        p_ip: ipH,
        p_ip_hour: Math.floor(num("IG_THUMB_IP_HOUR", 4)),
        p_ip_day: Math.floor(num("IG_THUMB_IP_DAY", 8)),
        p_day: Math.floor(num("IG_THUMB_DAY", 40)),
        p_month_usd: num("IG_THUMB_MONTH_USD", 1.5),
        p_cost: APIFY_PRICE_USD,
      }),
      signal: io(),
    });
    if (!r.ok) return "db";   // e.g. supabase/ig_thumb.sql not applied yet: fail closed
    const v = await r.json();
    return typeof v === "string" ? v : "db";
  } catch { return "db"; }
}

/** FAILS CLOSED, like process_adaptations.apify_budget_ok(): no reading, no spend. */
async function ledgerOk(token: string): Promise<boolean> {
  try {
    const r = await fetch("https://api.apify.com/v2/users/me/limits",
      { headers: { Authorization: `Bearer ${token}` }, signal: io() });
    if (!r.ok) return false;
    const d = (await r.json())?.data ?? {};
    const spent = Number(d.current?.monthlyUsageUsd);
    const cap = Number(d.limits?.maxMonthlyUsageUsd);
    const jobs = Number(d.current?.activeActorJobCount ?? 0);
    const maxJobs = Number(d.limits?.maxConcurrentActorJobs ?? 5);
    if (![spent, cap, jobs, maxJobs].every(Number.isFinite)) return false;
    if (cap - spent < num("IG_THUMB_HEADROOM_USD", 2)) return false;
    if (jobs >= maxJobs - 2) return false;   // leave two run slots for the worker's view counts
    return true;
  } catch { return false; }
}

/** { url } for a usable cover, "none" when Apify answered (and billed) without one — remembered for a
    week — or null for a transient failure (timeout, refusal, empty dataset), which is not cached. */
async function apifyCover(token: string, sc: string): Promise<{ url: string } | "none" | null> {
  const q = new URLSearchParams({ timeout: String(APIFY_RUN_TIMEOUT_S), maxItems: "1", maxTotalChargeUsd: "0.01", format: "json" });
  let items: unknown;
  try {
    const r = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?${q}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // The CANONICAL post URL built from the validated shortcode — never the caller's string.
      body: JSON.stringify({ directUrls: [`https://www.instagram.com/p/${sc}/`], resultsType: "posts", resultsLimit: 1, addParentData: false }),
      signal: AbortSignal.timeout(num("IG_THUMB_APIFY_MS", 30000)),
    });
    if (!r.ok) { console.error("apify refused", r.status); return null; }
    items = await r.json();
  } catch (e) { console.error("apify failed", String((e as Error)?.name ?? e).slice(0, 60)); return null; }
  if (!Array.isArray(items) || items.length === 0) return null;
  for (const it of items as Record<string, unknown>[]) {
    if (!it || typeof it !== "object" || it.error) continue;   // {"error":"not_found"} is billed, not a cover
    const u = String(it.displayUrl ?? "");
    if (metaCdn(u)) return { url: u };
  }
  return "none";
}

/** Copy the cover into lynxr-covers/tease/ig/<shortcode>.jpg and return that path, or "" on any problem. */
async function copyToBucket(src: string, sc: string): Promise<string> {
  try {
    const r = await fetch(src, { signal: io(), redirect: "error" });
    if (!r.ok) return "";
    const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "image/jpeg") return "";
    if (Number(r.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return "";
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length < 500 || buf.length > MAX_IMAGE_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) return "";
    const path = `tease/ig/${sc}.jpg`;
    const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: { ...sbHeaders(), "Content-Type": "image/jpeg", "x-upsert": "true", "cache-control": "max-age=2592000" },
      body: buf,
      signal: io(),
    });
    return up.ok ? path : "";
  } catch { return ""; }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return noThumb("method", origin, 405);
  if (!ORIGINS.includes(origin ?? "")) return noThumb("origin", origin, 403);
  const mode = (Deno.env.get("IG_THUMB_MODE") ?? "on").trim().toLowerCase();
  if (mode === "off") return noThumb("off", origin);
  try {
    let body: { url?: unknown } = {};
    try { body = JSON.parse(await req.text()); } catch { /* not JSON: shortcodeOf refuses it below */ }
    const sc = shortcodeOf(body?.url);
    if (!sc) return noThumb("bad_url", origin);

    const row = await cacheGet(sc);
    if (row?.status === "ok" && row.object_path) return json({ thumb: PUBLIC + row.object_path, why: "hit" }, 200, origin);
    if (row?.status === "none" && Date.now() - Date.parse(row.created_at) < NONE_TTL_MS) return noThumb("none", origin);

    const have = await existingCover(sc);
    if (have) {
      await cachePut(sc, "ok", have);
      return json({ thumb: PUBLIC + have, why: "cover" }, 200, origin);
    }

    const token = (Deno.env.get("APIFY_API_TOKEN") ?? "").trim();
    if (mode === "cache" || !token) return noThumb("cache_only", origin);
    const { ip, src } = clientIp(req.headers);
    const verdict = await take(await ipHash(ip, new Date().toISOString().slice(0, 10)));
    if (verdict !== "ok") { console.log("ig-thumb limited", verdict, "ip-src", src); return noThumb("limited", origin); }
    if (!(await ledgerOk(token))) { console.log("ig-thumb ledger refused"); return noThumb("ledger", origin); }
    const got = await apifyCover(token, sc);
    console.log("ig-thumb apify", got === null ? "failed" : got === "none" ? "no-cover" : "ok", "ip-src", src);
    if (got === null) return noThumb("error", origin);
    if (got === "none") { await cachePut(sc, "none", null); return noThumb("none", origin); }
    const path = await copyToBucket(got.url, sc);
    if (!path) return noThumb("error", origin);
    await cachePut(sc, "ok", path);
    return json({ thumb: PUBLIC + path, why: "fresh" }, 200, origin);
  } catch (e) {
    console.error("ig-thumb error", String(e).slice(0, 120));
    return noThumb("error", origin);
  }
});
