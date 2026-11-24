// waitlist -- the public waitlist's one writer: join, "your spot", send-it-again, leave, gift invites, the invite name,
// and (for staff) release the next batch / let one person in. Plan: ~/.claude/plans/waitlist-referral-queue.md (owner,
// 2026-11-20), the delta ~/.claude/plans/waitlist-beli-referrals.md (gift invites, founding creator title, crew, Discord)
// and ~/.claude/plans/waitlist-no-confirm.md (owner, 2026-11-21: no email confirmation, a welcome email, "Invite a friend").
//
// WHY AN EDGE FUNCTION. The publishable key is in a public repo, so nothing a browser sends can be trusted, and the
// queue's rules (a referral is worth exactly 10 places, counted when the friend JOINS, never above #1) have to live
// where a browser cannot bend them. supabase/waitlist_queue.sql locks lynxr_waitlist to the server: no insert, update,
// delete or token read from any browser role. This function calls the SQL functions with the service role, spends
// the email, and answers a browser ONLY what it may see: never an email address, a confirm token or an invite code
// (those travel by email, to the address that owns them), and a view token only in the one exception below: a
// brand-new entry's own view token, to the browser whose request created it (status new), never for an address that
// already existed (typing someone's address must never hand over their page).
//
// WHAT STANDS BETWEEN AN ANONYMOUS CALLER AND AN EMAIL (in this order)
//   1. Origin   a browser caller must come from ORIGINS (403 otherwise). The one-click unsubscribe POST that mail
//               providers send (?stop=<32 hex>) carries no Origin, so it is the one exception.
//   2. input    an email shape, a share-code shape, a 32-hex token -- nothing else reaches the database.
//   3. meter    waitlist_take(): per visitor (an HMAC of their IP, never the IP) per hour and per UTC day, and
//               everyone together per UTC day.
//   4. throttle the SQL decides whether this address may be mailed now (15 minutes apart, 3 a day).
//   5. cap      waitlist_mail_take(): a global daily ceiling on waitlist email (WL_MAIL_DAY). Resend's free plan is
//               100 emails a day across EVERYTHING on the account, sign-up confirmations and password resets
//               included, so the default (80) leaves room. An email the cap refused is not lost: the row is flagged
//               mail_pending and staff press "Send them".
//
// DEPLOY: Supabase dashboard -> Edge Functions -> Deploy a new function -> Via Editor -> name `waitlist` -> paste this
//         whole file -> Deploy. Then open the function -> Details -> "Enforce JWT verification" OFF (the anonymous
//         caller's key is a publishable key, not a JWT; staff calls are checked in here). After EVERY redeploy,
//         confirm the toggle is still off.
//         Run supabase/waitlist_queue.sql FIRST. Until it has run, every action answers {status:"error"}.
// SECRETS (Edge Functions -> Secrets; they apply immediately, no redeploy):
//   RESEND_API_KEY      a NEW Resend key named lynxr-waitlist, "Sending access", restricted to the verified domain.
//                       Never paste it into chat or the repo. Absent = no mail at all: joins still work and answer
//                       mailed:false.
//   WAITLIST_FROM       REQUIRED together with the key -- the From line, on the VERIFIED Resend domain, e.g.
//                       `lynxr <waitlist@your-verified-domain>`. Decision D16: the owner supplies it. No address is
//                       hard-coded anywhere in this function; without it mail is off exactly as without the key.
//   WAITLIST_REPLY_TO   optional Reply-To address.
//   WAITLIST_MODE       "off" = answer {status:"off"} to everything but the unsubscribe link, touch nothing -
//                       "nomail" = queue works, no email leaves (rows are flagged mail_pending) -
//                       unset or "on" = full
//   WL_IP_HOUR          default 5      joins (and send-it-agains, and gift claims) per visitor per hour
//   WL_IP_DAY           default 20     per visitor per UTC day
//   WL_JOIN_DAY         default 2000   joins per UTC day, everyone together
//   WL_CREDIT_IP_DAY    default 3      credited joins per friend's link per visitor per UTC day; 0 = no join carries a referral
//   (no new secret for gifts: a gift claim reuses the three limits above, and the daily ceiling on gift claims is the
//    SQL setting lynxr_waitlist_settings.gift_day. The Discord link is the SQL setting discord_url, validated here
//    again before it reaches an email or a browser: nothing about it is hard-coded in this file.)
//   WL_MAIL_DAY         default 80     waitlist emails per UTC day (safe on Resend free; set 2000 after Pro)
//   WL_SPOT_HOUR        default 120    "your spot" page loads per visitor per hour
//   WL_RESEND_MS        default 8000   timeout on every Resend call
//   WL_IO_MS            default 8000   timeout on every database call (the tests shorten it)
//   WL_CHUNK_GAP_MS     default 600    pause between 100-email batches (Resend answers 2 requests a second)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS are injected by the platform.
//
// CALL -- anonymous, from the page, a CORS "simple request" (text/plain body, NO custom headers, so no preflight):
//   POST {"action":"join","email":"...","ref":"<share code>","source":"...","consent":"..."}
//        -> {"status":"new","position":N,"ref_code":"...","mailed":bool,"batch_size":100,"places":10,"token":"<32 hex>"}
//             (the welcome email goes to the address; token = the new entry's own view token, only on `new`)
//        -> {"status":"exists","mailed":bool}      already in line (an email with their link is sent when allowed)
//        -> {"status":"account"}                   no waitlist needed: invited, on the roster, or already signed up
//        -> {"status":"bad_email"|"limited"|"off"|"error"}
//   POST {"action":"spot","token":"<32 hex>","confirm":"<32 hex, optional, ignored>"}
//        -> {"state":"waiting"|"released"|"left"|"none", "position":N, "ref_code":"...", "referrals":N,
//           "batch_size":N, "places":N, "crew":N, "title":"founding"?, "title_crew":N, "discord":"<invite link>"?,
//           "name":"Maya"?}        (position only while in line; title, discord and name only when set. This
//           answer is a WHITELIST: any other key the database returns is dropped here. A database not yet re-run
//           may still answer "unconfirmed": the page treats it exactly like "waiting".)
//        -> {"state":"limited"|"off"|"error"}
//   POST {"action":"name","token":"<32 hex>","name":"Maya"}   -> {"ok":true,"name":"Maya"?} | {"ok":false,"reason":"bad_name"?}
//        the optional invite name: first word only, 1 to 20 letters (NAME_RE); an empty name clears it.
//   POST {"action":"ref_peek","code":"<8-char share code>"}   -> {"name":"Maya"} or {} (no name, unknown code, limited,
//        off, error: always {}). What a friend's banner shows; never anything else about the referrer.
//   POST {"action":"gift_peek","code":"<8-char gift code>"}      -> {"state":"ok"|"used_up"|"none"|"off"|"open"}
//        or {"state":"limited"|"error"}.   Never the giver, the code or an email.
//   POST {"action":"gift","code":"<8-char gift code>","email":"..."}
//        -> {"status":"claimed"|"again","mailed":bool}            the friend's invite email goes to THEIR address
//        -> {"status":"account"|"used_up"|"none"|"off"|"open"|"busy"|"bad_email"|"limited"|"error"}
//        Never the code, the email or a token.
//   POST {"action":"resend","token":"<32 hex>"}   -> {"ok":bool,"mailed":bool,"wait_s":N?}    "send it again"
//   POST {"action":"stop","token":"<32 hex>"}     -> {"ok":true}                              leave the waitlist
//   POST ?stop=<32 hex>   (no Origin; RFC 8058 one-click unsubscribe from a mail client)    -> 200 "ok"
// CALL -- staff, Authorization: Bearer <access token> (the agency app sends content-type application/json and NO
//        apikey header; that header once broke the preflight on another function):
//   POST {"action":"release","n":100,"dry":true}  -> {"batch":K,"count":N}                (no mail, writes nothing)
//   POST {"action":"release","n":100}             -> {"batch":K,"released":N,"mailed":M,"unmailed":U}
//                                                    or {"error":"too_soon"|"bad_n"}      (a double press)
//   POST {"action":"retry_release"}               -> {"listed":N,"mailed":M,"unmailed":U}   "Send them"
//   POST {"action":"let_in","email":"..."}          -> {"status":"sent"} | {"status":"mail_failed","in_unmailed":bool}
//                                                    | {"status":"has_account"} | {"status":"bad_email"}
//        in_unmailed false = the person never joined the waitlist, so "Send them" will not find them: press Let in again.
//   401 no/invalid token - 403 not staff - 403 foreign Origin - 405 not POST

const SB_URL = Deno.env.get("SUPABASE_URL")!;
// DUPLICATED from ig-thumb/index.ts (a dashboard-pasted function is one file; there is no shared module to
// import). The legacy name first, then the first value of the new SUPABASE_SECRET_KEYS dictionary.
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

const ORIGINS = ["https://lynxr.io", "http://localhost:8811", "http://127.0.0.1:8811"];
/** The one site an email link may point at: the caller's Origin if it is on the allow-list, lynxr.io otherwise.
    DUPLICATED from billing-checkout/index.ts. */
const siteFor = (origin: string | null) => (ORIGINS.includes(origin ?? "") ? origin! : ORIGINS[0]);

const num = (name: string, dflt: number): number => {
  const raw = Deno.env.get(name);
  const v = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
const int = (name: string, dflt: number) => Math.floor(num(name, dflt));

// DUPLICATED from ig-thumb/index.ts, with the allowed headers and the HMAC label changed.
const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": ORIGINS.includes(origin ?? "") ? origin! : ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});
const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });

/** An address as a rate-limit key: IPv4 as is, IPv6 cut to its /64. "" when it is not an address.
    DUPLICATED from ig-thumb/index.ts. */
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

/** Who is asking. cf-connecting-ip is set by Cloudflare and cannot be forged by a client; x-forwarded-for is the
    fallback, read from the RIGHT. DUPLICATED from ig-thumb/index.ts. */
export function clientIp(h: Headers): { ip: string; src: string } {
  const cf = (h.get("cf-connecting-ip") ?? "").trim();
  if (cf) return { ip: ipKey(cf), src: "cf" };
  const xff = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (xff.length) return { ip: ipKey(xff[xff.length - 1]), src: "xff" };
  return { ip: "", src: "none" };
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 of the day and the address, keyed off the service key: 32 hex, never the address itself. The day is
    part of the input, so a stored hash cannot be linked to the same visitor on another day. */
export async function ipHash(ip: string, day: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode("waitlist-ip|" + SB_SERVICE),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(day + "|" + (ip || "unknown")))).slice(0, 32);
}

/** Who is calling. Asking the auth server beats decoding the JWT here: it honours revocation.
    DUPLICATED from billing-checkout/index.ts (plus a timeout). */
async function callerFromToken(token: string) {
  const res = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${token}` },
    signal: io(),
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id ? { id: u.id as string, email: (u.email ?? "") as string } : null;
}

const io = () => AbortSignal.timeout(int("WL_IO_MS", 8000));
const sbHeaders = () => ({ apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" });

// deno-lint-ignore no-explicit-any
async function rpc(fn: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: sbHeaders(), body: JSON.stringify(args), signal: io(),
  });
  if (!r.ok) throw new Error(`rpc ${fn} ${r.status}`);
  const t = await r.text();                 // a void function answers 204 with no body
  return t ? JSON.parse(t) : null;
}

/** A Discord invite link, and nothing else. The database enforces the same shape (lynxr_wl_discord_shape); it is checked
    again here because this value ends up in an email and in a browser's href. */
const DISCORD_RE = /^https:\/\/(discord\.gg\/[A-Za-z0-9-]{2,32}|discord\.com\/invite\/[A-Za-z0-9-]{2,32})$/;
const GIFT_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;                          // the invite-code alphabet (no I, O, 0, 1)

type Settings = { batch_size: number; places: number; discord: string | null };

/** The numbers the page quotes ("100 at a time", "10 places") and the Discord link, read from the one-row settings
    table. A column that does not exist yet (the SQL has not been re-run) makes the request fail, which falls back to the
    defaults below: no Discord link, the table's own defaults for the rest. */
async function getSettings(): Promise<Settings> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/lynxr_waitlist_settings?id=eq.1&select=batch_size,places,discord_url,title_crew`,
      { headers: sbHeaders(), signal: io() });
    if (r.ok) {
      const row = (await r.json())?.[0];
      if (row && Number.isFinite(row.batch_size) && Number.isFinite(row.places)) {
        return { batch_size: row.batch_size, places: row.places,
          discord: typeof row.discord_url === "string" && DISCORD_RE.test(row.discord_url) ? row.discord_url : null };
      }
    }
  } catch { /* the defaults below are the table's own defaults */ }
  return { batch_size: 100, places: 10, discord: null };
}

// -- input shapes ------------------------------------------------------------------------------------------------
const EMAIL_RE = /^[^@\s]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}$/;   // write_guards.sql's shape
const TOKEN_RE = /^[0-9a-f]{32}$/;
const goodEmail = (s: unknown): s is string => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s.trim());
const clip = (s: unknown, n = 200) => (typeof s === "string" ? s.slice(0, n) : "");
const goodToken = (s: unknown): s is string => typeof s === "string" && TOKEN_RE.test(s);
/** What a browser may be told about a spot. Nothing outside this list leaves the function. */
const SPOT_KEYS = ["state", "position", "ref_code", "referrals", "batch_size", "places", "crew", "title", "title_crew", "discord", "name"];
/** The invite name: first word only, 1 to 20 letters of any script plus ' and \u2019 and - (the page, this function and the
    database all say the same thing). Written with an escape: this file stays pure ASCII because it is pasted by hand. */
const NAME_RE = /^\p{L}[\p{L}\p{M}'\u2019-]{0,19}$/u;
const cleanName = (s: unknown) => (typeof s === "string" ? s.trim().split(/\s+/)[0] ?? "" : "").slice(0, 40);
const goodName = (s: unknown): s is string => typeof s === "string" && s.length <= 20 && NAME_RE.test(s);
const GIFT_PEEK_STATES = ["ok", "used_up", "none", "off", "open"];
/** Gift answers that are the status and nothing else (no mail follows them). */
const GIFT_PLAIN_STATUSES = ["account", "used_up", "none", "off", "open", "busy", "bad_email"];

// -- mail --------------------------------------------------------------------------------------------------------
type MailKind = "welcome" | "spot" | "release" | "gift";
/** Extras every kind may carry. `discord` is the settings' invite link (null = no Discord line at all). */
type MailExtra = { discord?: string | null };
type MailData = {
  email: string;
  view_token?: string | null;
  confirm_token?: string | null;
  ref_code?: string | null;
  position?: number | null;
  code?: string | null;
};
type Msg = { from: string; to: string[]; subject: string; html: string; text: string; reply_to?: string; headers?: Record<string, string> };

const INK = "#14122b", PAPER = "#f7f6fb", MUTED = "#5c5a73", RULE = "#dcd9ea";   // never pure black or white
const DISCORD_LINE = "come say hi on the lynxr discord:";                       // C59: added to every kind when a link is set
/** Every value that reaches the HTML goes through this. */
export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const mailMode = () => (Deno.env.get("WAITLIST_MODE") ?? "on").trim().toLowerCase();
const mailCfg = () => ({
  key: (Deno.env.get("RESEND_API_KEY") ?? "").trim(),
  from: (Deno.env.get("WAITLIST_FROM") ?? "").trim(),
  replyTo: (Deno.env.get("WAITLIST_REPLY_TO") ?? "").trim(),
});
/** Mail can go only with a key AND a From address, and only when the mode allows it. */
const canMail = () => { const c = mailCfg(); return !!(c.key && c.from) && mailMode() === "on"; };

/** The message for one kind. `site` is siteFor(origin); `batch` the batch size the page quotes. Exported for the tests.
    The `gift` kind is a one-off the recipient asked for (they claimed it on the site): no view token, so no
    List-Unsubscribe headers and no "leave the waitlist" link, and no share link. */
export function buildMail(kind: MailKind, d: MailData, site: string, batch = 100, extra: MailExtra = {}): { subject: string; html: string; text: string; headers: Record<string, string> } {
  const discord = typeof extra.discord === "string" && DISCORD_RE.test(extra.discord) ? extra.discord : "";
  const view = kind !== "gift" && d.view_token && TOKEN_RE.test(d.view_token) ? d.view_token : "";
  const headers: Record<string, string> = view ? {
    "List-Unsubscribe": `<${SB_URL}/functions/v1/waitlist?stop=${view}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  } : {};
  const shareUrl = d.ref_code ? `${site}/join/?c=${encodeURIComponent(d.ref_code)}` : "";
  const leaveUrl = view ? `${site}/?spot=${view}&stop=1` : "";
  // An old database that still asks for confirmation hands over a confirm token; opening the link then confirms. Never visible text.
  const confirmTail = typeof d.confirm_token === "string" && TOKEN_RE.test(d.confirm_token) ? `&confirm=${d.confirm_token}` : "";
  const queueUrl = view ? `${site}/?spot=${view}${confirmTail}` : `${site}/`;
  const pos = d.position != null && Number.isFinite(Number(d.position)) ? "#" + Number(d.position).toLocaleString("en-US") : "";

  let subject = "", hello = "", big = "", small = "", lead = "", button = "", href = "", sub = "", after = "", fine = "";
  if (kind === "welcome") {
    subject = "hey, lynxr here! you're on the waitlist";
    small = "lynxr"; hello = "hey, lynxr here!";
    lead = "i'm so glad you're on the waitlist. i can't wait to help you make your next video.";
    big = pos; sub = "your place in line";
    button = "see my place in line";
    href = queueUrl;
    after = "want in sooner? every friend who joins with your link moves you up 10 places:";
    fine = "you got this because this address joined the lynxr waitlist on lynxr.io. wasn't you? leave the waitlist below and you won't hear from us again.";
  } else if (kind === "spot") {
    subject = "your place in line for lynxr";
    small = "lynxr"; big = pos; sub = "your place in line";
    lead = "here's your link again. it's the same page every time, so keep this email handy.";
    button = "see my place in line";
    href = queueUrl;
    after = "want in sooner? every friend who joins with your link moves you up 10 places:";
    fine = "you got this because this address is on the lynxr waitlist.";
  } else if (kind === "gift") {
    subject = "a friend gave you a lynxr invite";
    small = "lynxr"; big = "you're invited"; sub = "";
    lead = `a friend gave you one of their invites, so you can skip the waitlist. create your account with ${d.email} and lynxr is yours: 3 free scripts a week.`;
    button = "create your account";
    href = `${site}/?signup=1&e=${encodeURIComponent(d.email)}&c=${encodeURIComponent(d.code ?? "")}`;
    after = "prefer google? choose continue with google with this same address. your invite is held for 14 days.";
    fine = "you got this because someone claimed a lynxr invite with this address on lynxr.io. if it wasn't you, ignore this email.";
  } else {
    subject = "you're in: create your lynxr account";
    small = "the lynxr waitlist"; big = "you're in"; sub = "";
    lead = `your batch is open. create your account with ${d.email} and lynxr is yours: 3 free scripts a week.`;
    button = "create your account";
    href = `${site}/?signup=1&e=${encodeURIComponent(d.email)}&c=${encodeURIComponent(d.code ?? "")}`;
    after = "prefer google? choose continue with google with this same address.";
    fine = view ? "you got this because you joined the lynxr waitlist." : "you got this because a lynxr team member invited you.";
  }

  // The welcome email reads: lynxr, hello, the lead, the number. Every other kind keeps its order: the number, then the lead.
  const leadFirst = kind === "welcome";
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:${PAPER};"><div style="max-width:480px;margin:0 auto;padding:32px 20px;${font}color:${INK};">` +
    `<p style="margin:0 0 4px;font-size:13px;color:${MUTED};">${esc(small)}</p>` +
    (hello ? `<p style="margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:700;">${esc(hello)}</p>` : "") +
    (leadFirst && lead ? `<p style="margin:0 0 24px;font-size:16px;line-height:1.5;">${esc(lead)}</p>` : "") +
    (big ? `<p style="margin:0;font-size:64px;line-height:1;font-weight:700;letter-spacing:-0.04em;">${esc(big)}</p>` : "") +
    (sub ? `<p style="margin:6px 0 0;font-size:13px;color:${MUTED};">${esc(sub)}</p>` : "") +
    (!leadFirst && lead ? `<p style="margin:24px 0 0;font-size:16px;line-height:1.5;">${esc(lead)}</p>` : "") +
    `<p style="margin:24px 0;"><a href="${esc(href)}" style="display:inline-block;background:${INK};color:${PAPER};text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:12px;">${esc(button)}</a></p>` +
    (after ? `<p style="margin:0;font-size:14px;line-height:1.5;color:${MUTED};">${esc(after)}</p>` : "") +
    ((kind === "welcome" || kind === "spot") && shareUrl ? `<p style="margin:6px 0 0;font-size:14px;word-break:break-all;"><a href="${esc(shareUrl)}" style="color:${INK};">${esc(shareUrl)}</a></p>` : "") +
    (discord ? `<p style="margin:18px 0 0;font-size:14px;line-height:1.5;color:${MUTED};">${esc(DISCORD_LINE)} <a href="${esc(discord)}" style="color:${INK};">${esc(discord)}</a></p>` : "") +
    `<hr style="border:0;border-top:1px solid ${RULE};margin:28px 0 16px;">` +
    `<p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED};">${esc(fine)}</p>` +
    `<p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:${MUTED};">lynxr LLC` +
    (leaveUrl ? ` &middot; <a href="${esc(leaveUrl)}" style="color:${MUTED};">leave the waitlist</a>` : "") + `</p>` +
    `</div></body></html>`;
  const number = big && sub ? `${big}\n${sub}` : big;
  const text = [
    small, hello, ...(leadFirst ? [lead, number] : [number, lead]), `${button}: ${href}`, after,
    kind === "welcome" || kind === "spot" ? shareUrl : "", discord ? `${DISCORD_LINE}\n${discord}` : "", "", fine, leaveUrl ? `lynxr LLC \u00b7 leave the waitlist: ${leaveUrl}` : "lynxr LLC",
  ].filter((x) => x !== undefined && x !== null).join("\n\n").replace(/\n{3,}/g, "\n\n");
  return { subject, html, text, headers };
}

function toMsg(kind: MailKind, d: MailData, site: string, batch: number, extra: MailExtra = {}): Msg {
  const c = mailCfg();
  const m = buildMail(kind, d, site, batch, extra);
  return { from: c.from, to: [d.email], subject: m.subject, html: m.html, text: m.text, headers: m.headers,
    ...(c.replyTo ? { reply_to: c.replyTo } : {}) };
}

const resendMs = () => AbortSignal.timeout(int("WL_RESEND_MS", 8000));
async function resendOne(msg: Msg): Promise<boolean> {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${mailCfg().key}`, "Content-Type": "application/json" },
      body: JSON.stringify(msg), signal: resendMs(),
    });
    if (!r.ok) console.error("waitlist resend refused", r.status);
    return r.ok;
  } catch (e) { console.error("waitlist resend failed", String((e as Error)?.name ?? e).slice(0, 60)); return false; }
}
async function resendBatch(msgs: Msg[], idem: string): Promise<boolean> {
  try {
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${mailCfg().key}`, "Content-Type": "application/json", "Idempotency-Key": idem },
      body: JSON.stringify(msgs), signal: resendMs(),
    });
    if (!r.ok) console.error("waitlist resend batch refused", r.status);
    return r.ok;
  } catch (e) { console.error("waitlist resend batch failed", String((e as Error)?.name ?? e).slice(0, 60)); return false; }
}

const markMailed = async (emails: string[], kind: string) => {
  try { await rpc("waitlist_mark_mailed", { p_emails: emails, p_kind: kind }); } catch { /* bookkeeping only */ }
};

/** One transactional email: cap, send, record. false (and the row flagged pending) when any step says no. */
async function mailOne(kind: MailKind, d: MailData, site: string, batch: number, extra: MailExtra = {}): Promise<boolean> {
  if (!canMail()) { await markMailed([d.email], "pending"); return false; }
  let allowed = 0;
  try { allowed = Number(await rpc("waitlist_mail_take", { p_n: 1, p_cap: int("WL_MAIL_DAY", 80) })) || 0; } catch { allowed = 0; }
  if (allowed < 1) { await markMailed([d.email], "pending"); return false; }
  if (!(await resendOne(toMsg(kind, d, site, batch, extra)))) { await markMailed([d.email], "pending"); return false; }
  await markMailed([d.email], kind === "release" ? "release" : "spot");   // the welcome email and "your place" are both 'spot' (an old database ignores any other word)
  return true;
}

/** The gift email, to the friend who claimed an invite. Same cap and Resend call as every other waitlist mail, but NO
    "pending" mark when it does not go: the claimant presses "send it again" (the SQL throttles that per claim). Only a
    mail that was really sent is recorded (waitlist_gift_mark), so the next "again" is throttled from that moment. */
async function mailGift(r: { email: string; code?: string | null }, site: string, st: Settings): Promise<boolean> {
  if (!canMail()) return false;
  let allowed = 0;
  try { allowed = Number(await rpc("waitlist_mail_take", { p_n: 1, p_cap: int("WL_MAIL_DAY", 80) })) || 0; } catch { allowed = 0; }
  if (allowed < 1) return false;
  if (!(await resendOne(toMsg("gift", { email: r.email, code: r.code }, site, st.batch_size, { discord: st.discord })))) return false;
  try { await rpc("waitlist_gift_mark", { p_email: r.email }); } catch { /* bookkeeping only */ }
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Release emails in chunks of at most 100 (Resend's batch limit), each under the daily cap. Only the emails of a
    chunk Resend accepted are marked mailed; the rest stay unmailed for "Send them". */
async function sendReleaseRows(rows: { email: string; view_token?: string | null; code?: string | null }[], site: string, label: string, extra: MailExtra = {}): Promise<number> {
  if (!rows.length || !canMail()) return 0;
  let mailed = 0;
  for (let i = 0, chunk = 0; i < rows.length; i += 100, chunk++) {
    const part = rows.slice(i, i + 100);
    let allowed = 0;
    try { allowed = Number(await rpc("waitlist_mail_take", { p_n: part.length, p_cap: int("WL_MAIL_DAY", 80) })) || 0; } catch { allowed = 0; }
    if (allowed < 1) break;                                   // the cap is spent for today
    const send = part.slice(0, allowed);
    if (chunk > 0) await sleep(int("WL_CHUNK_GAP_MS", 600));
    const ok = await resendBatch(send.map((d) => toMsg("release", d, site, 100, extra)), `${label}-${chunk}`);
    if (ok) { await markMailed(send.map((d) => d.email), "release"); mailed += send.length; }
    if (allowed < part.length) break;
  }
  return mailed;
}

// -- the handler -------------------------------------------------------------------------------------------------
async function visitorKey(req: Request): Promise<{ hash: string; src: string }> {
  const { ip, src } = clientIp(req.headers);
  return { hash: await ipHash(ip, new Date().toISOString().slice(0, 10)), src };
}

async function staffOnly(req: Request): Promise<{ ok: true } | { ok: false; status: number }> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, status: 401 };
  const caller = await callerFromToken(token);
  if (!caller || !/^[0-9a-f-]{36}$/i.test(caller.id)) return { ok: false, status: 401 };
  const r = await fetch(`${SB_URL}/rest/v1/lynxr_staff?id=eq.${caller.id}&select=id`, { headers: sbHeaders(), signal: io() });
  if (!r.ok) return { ok: false, status: 403 };
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? { ok: true } : { ok: false, status: 403 };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ status: "error", error: "method" }, 405, origin);

  // RFC 8058 one-click unsubscribe: mail providers POST here with no Origin, whatever mode we are in (leaving is
  // never refused). The token is a 128-bit secret from the email itself.
  const stopTok = new URL(req.url).searchParams.get("stop");
  if (stopTok !== null && goodToken(stopTok)) {
    try {
      await rpc("waitlist_stop", { p_token: stopTok });
      return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
    } catch (e) {
      console.error("waitlist stop failed", String(e).slice(0, 80));
      return new Response("error", { status: 502, headers: { "Content-Type": "text/plain" } });
    }
  }

  if (!ORIGINS.includes(origin ?? "")) return json({ status: "forbidden" }, 403, origin);

  let body: Record<string, unknown> = {};
  try { const b = JSON.parse(await req.text()); if (b && typeof b === "object") body = b; } catch { /* no action: refused below */ }
  const action = String(body.action ?? "");
  const site = siteFor(origin);
  const STAFF = ["release", "retry_release", "let_in"];

  if (mailMode() === "off") {
    return json(action === "spot" || action === "gift_peek" ? { state: "off" } : STAFF.includes(action) ? { error: "off" }
      : action === "name" ? { ok: false } : action === "ref_peek" ? {} : { status: "off" }, 200, origin);
  }

  try {
    // -- staff --
    if (STAFF.includes(action)) {
      const who = await staffOnly(req);
      if (!who.ok) return json({ error: who.status === 401 ? "unauthenticated" : "not_staff" }, who.status, origin);

      if (action === "release") {
        const st = await getSettings();
        const asked = Math.floor(Number(body.n));
        const n = Number.isFinite(asked) && asked >= 1 ? Math.min(asked, 1000) : st.batch_size;
        const dry = body.dry === true;
        const r = await rpc("waitlist_release", { p_n: n, p_dry: dry });
        if (r?.error) return json({ error: r.error }, 200, origin);
        if (dry) return json({ batch: r.batch, count: r.count }, 200, origin);
        const rows = Array.isArray(r.rows) ? r.rows : [];
        const mailed = await sendReleaseRows(rows, site, `release-${r.batch}`, { discord: st.discord });
        console.log("waitlist release batch", r.batch, "released", rows.length, "mailed", mailed);
        return json({ batch: r.batch, released: rows.length, mailed, unmailed: rows.length - mailed }, 200, origin);
      }
      if (action === "retry_release") {
        const r = await rpc("waitlist_unmailed", {});
        const rows = Array.isArray(r?.rows) ? r.rows : [];
        const st = await getSettings();
        const mailed = await sendReleaseRows(rows, site, `retry-${new Date().toISOString().slice(0, 13)}`, { discord: st.discord });
        console.log("waitlist retry listed", rows.length, "mailed", mailed);
        return json({ listed: rows.length, mailed, unmailed: rows.length - mailed }, 200, origin);
      }
      // let_in
      if (!goodEmail(body.email)) return json({ status: "bad_email" }, 200, origin);
      const r = await rpc("waitlist_let_in", { p_email: (body.email as string).trim() });
      if (r?.status === "has_account" || r?.status === "bad_email") return json({ status: r.status }, 200, origin);
      if (r?.status !== "ok") return json({ status: "error" }, 200, origin);
      const st = await getSettings();
      const sent = await mailOne("release", { email: r.email, view_token: r.view_token, code: r.code }, site, 100, { discord: st.discord });
      return json(sent ? { status: "sent" } : { status: "mail_failed", in_unmailed: !!r.view_token }, 200, origin);
    }

    // -- anonymous --
    if (action === "join") {
      if (!goodEmail(body.email)) return json({ status: "bad_email" }, 200, origin);
      const { ip, src } = clientIp(req.headers);
      const day = new Date().toISOString().slice(0, 10);              // the same two values visitorKey() uses
      const hash = await ipHash(ip, day);
      const take = await rpc("waitlist_take", { p_ip: hash, p_kind: "join", p_hour: int("WL_IP_HOUR", 5), p_day: int("WL_IP_DAY", 20), p_all: int("WL_JOIN_DAY", 2000) });
      if (take !== "ok") { console.log("waitlist limited", String(take), "ip-src", src); return json({ status: "limited" }, 200, origin); }
      // A friend's join counts for their referrer at once, so a second meter caps how many joins one visitor can push through
      // one friend's link a day. Past it the join still works; it just carries no referral. Keyed on a hash of ip + code.
      let ref = clip(body.ref, 16).toUpperCase();
      if (!GIFT_CODE_RE.test(ref)) ref = "";
      const credLim = int("WL_CREDIT_IP_DAY", 3);
      if (ref && credLim <= 0) ref = "";
      else if (ref) {
        const ct = await rpc("waitlist_take", { p_ip: await ipHash(`${ip}|ref:${ref}`, day), p_kind: "credit", p_hour: credLim, p_day: credLim, p_all: 1000000 });
        if (ct !== "ok") { console.log("waitlist credit limited", String(ct), "ip-src", src); ref = ""; }
      }
      const r = await rpc("waitlist_join", {
        p_email: (body.email as string).trim(), p_ref: ref,
        p_source: clip(body.source, 60), p_consent: clip(body.consent, 60),
      });
      if (r?.status === "account") return json({ status: "account" }, 200, origin);
      if (r?.status === "bad_email") return json({ status: "bad_email" }, 200, origin);
      if (r?.status !== "new" && r?.status !== "exists") return json({ status: "error" }, 200, origin);
      const st = await getSettings();
      let mailed = false;
      if (r.may_mail === true) {
        // A brand-new entry gets the welcome email; an address that was already in line gets its place again.
        const kind: MailKind = r.kind === "release" ? "release" : r.status === "new" ? "welcome" : "spot";
        mailed = await mailOne(kind, r, site, st.batch_size, { discord: st.discord });
      }
      console.log("waitlist join", r.status, "mailed", mailed);
      if (r.status === "new") {
        // The one place a view token leaves this function: a brand-new entry's own, to the browser whose request created it.
        // Never for `exists`: typing someone's address must not hand over their page.
        const own = typeof r.view_token === "string" && TOKEN_RE.test(r.view_token) ? { token: r.view_token } : {};
        return json({ status: "new", position: r.position, ref_code: r.ref_code, mailed, batch_size: st.batch_size, places: st.places, ...own }, 200, origin);
      }
      return json({ status: "exists", mailed }, 200, origin);
    }

    if (action === "spot") {
      if (!goodToken(body.token)) return json({ state: "none" }, 200, origin);
      const { hash } = await visitorKey(req);
      const h = int("WL_SPOT_HOUR", 120);
      const take = await rpc("waitlist_take", { p_ip: hash, p_kind: "spot", p_hour: h, p_day: h * 5, p_all: 20000 });
      if (take !== "ok") return json({ state: "limited" }, 200, origin);
      const confirm = goodToken(body.confirm) ? body.confirm : null;
      const r = await rpc("waitlist_spot", { p_token: body.token, p_confirm: confirm });
      if (!r || typeof r !== "object") return json({ state: "error" }, 200, origin);
      // A whitelist, not a pass-through: whatever else the database returns (an email, a token) stops here.
      const out: Record<string, unknown> = {};
      for (const k of SPOT_KEYS) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
      if ("discord" in out && !(typeof out.discord === "string" && DISCORD_RE.test(out.discord))) delete out.discord;
      if ("name" in out && !goodName(out.name)) delete out.name;
      if (typeof out.state !== "string") return json({ state: "error" }, 200, origin);
      return json(out, 200, origin);
    }

    if (action === "gift_peek") {
      const code = clip(body.code, 16).toUpperCase();
      if (!GIFT_CODE_RE.test(code)) return json({ state: "none" }, 200, origin);
      const { hash } = await visitorKey(req);
      const h = int("WL_SPOT_HOUR", 120);
      const take = await rpc("waitlist_take", { p_ip: hash, p_kind: "spot", p_hour: h, p_day: h * 5, p_all: 20000 });
      if (take !== "ok") return json({ state: "limited" }, 200, origin);
      const r = await rpc("waitlist_gift_peek", { p_code: code });
      const state = r && typeof r === "object" ? r.state : "";
      // Only the state: never the giver, the code or anything else the database may add later.
      return json({ state: GIFT_PEEK_STATES.includes(state) ? state : "error" }, 200, origin);
    }

    if (action === "gift") {
      if (!goodEmail(body.email)) return json({ status: "bad_email" }, 200, origin);
      const code = clip(body.code, 16).toUpperCase();
      if (!GIFT_CODE_RE.test(code)) return json({ status: "none" }, 200, origin);
      const { hash, src } = await visitorKey(req);
      const take = await rpc("waitlist_take", { p_ip: hash, p_kind: "gift", p_hour: int("WL_IP_HOUR", 5), p_day: int("WL_IP_DAY", 20), p_all: int("WL_JOIN_DAY", 2000) });
      if (take !== "ok") { console.log("waitlist gift limited", String(take), "ip-src", src); return json({ status: "limited" }, 200, origin); }
      const r = await rpc("waitlist_gift_claim", { p_code: code, p_email: (body.email as string).trim() });
      const status = r && typeof r === "object" && typeof r.status === "string" ? r.status : "";
      if (GIFT_PLAIN_STATUSES.includes(status)) return json({ status }, 200, origin);
      if ((status !== "claimed" && status !== "again") || typeof r.email !== "string") return json({ status: "error" }, 200, origin);
      const mailed = r.may_mail === true ? await mailGift(r, site, await getSettings()) : false;
      console.log("waitlist gift", status, "mailed", mailed);
      return json({ status, mailed }, 200, origin);
    }

    if (action === "name") {
      if (!goodToken(body.token)) return json({ ok: false }, 200, origin);
      const name = cleanName(body.name);
      if (name && !goodName(name)) return json({ ok: false, reason: "bad_name" }, 200, origin);
      const { hash } = await visitorKey(req);
      const h = int("WL_SPOT_HOUR", 120);
      const take = await rpc("waitlist_take", { p_ip: hash, p_kind: "spot", p_hour: h, p_day: h * 5, p_all: 20000 });
      if (take !== "ok") return json({ ok: false }, 200, origin);
      const r = await rpc("waitlist_set_name", { p_token: body.token, p_name: name });
      if (r && typeof r === "object" && r.ok === true) return json(goodName(r.name) ? { ok: true, name: r.name } : { ok: true }, 200, origin);
      return json(r && typeof r === "object" && r.reason === "bad_name" ? { ok: false, reason: "bad_name" } : { ok: false }, 200, origin);
    }

    if (action === "ref_peek") {
      const code = clip(body.code, 16).toUpperCase();
      if (!GIFT_CODE_RE.test(code)) return json({}, 200, origin);
      const { hash } = await visitorKey(req);
      const h = int("WL_SPOT_HOUR", 120);
      const take = await rpc("waitlist_take", { p_ip: hash, p_kind: "spot", p_hour: h, p_day: h * 5, p_all: 20000 });
      if (take !== "ok") return json({}, 200, origin);
      const r = await rpc("waitlist_ref_name", { p_code: code });
      // Only the display name, and only if it passes the same shape check: never anything else about the referrer.
      return json(r && typeof r === "object" && goodName(r.name) ? { name: r.name } : {}, 200, origin);
    }

    if (action === "resend") {
      if (!goodToken(body.token)) return json({ ok: false, mailed: false }, 200, origin);
      const { hash } = await visitorKey(req);
      const take = await rpc("waitlist_take", { p_ip: hash, p_kind: "resend", p_hour: int("WL_IP_HOUR", 5), p_day: int("WL_IP_DAY", 20), p_all: int("WL_JOIN_DAY", 2000) });
      if (take !== "ok") return json({ ok: false, mailed: false, wait_s: 600 }, 200, origin);
      const info = await rpc("waitlist_mail_info", { p_token: body.token });
      if (!info?.ok) return json({ ok: false, mailed: false, wait_s: Number(info?.wait_s) || 0 }, 200, origin);
      const st = await getSettings();
      const kind: MailKind = info.kind === "release" ? "release" : "spot";
      const mailed = await mailOne(kind, info, site, st.batch_size, { discord: st.discord });
      return json({ ok: true, mailed }, 200, origin);
    }

    if (action === "stop") {
      if (!goodToken(body.token)) return json({ ok: false }, 200, origin);
      const { hash } = await visitorKey(req);
      const h = int("WL_SPOT_HOUR", 120);
      const take = await rpc("waitlist_take", { p_ip: hash, p_kind: "spot", p_hour: h, p_day: h * 5, p_all: 20000 });
      if (take !== "ok") return json({ ok: false }, 200, origin);
      await rpc("waitlist_stop", { p_token: body.token });
      return json({ ok: true }, 200, origin);
    }

    return json({ status: "error", error: "unknown_action" }, 400, origin);
  } catch (e) {
    // Includes "supabase/waitlist_queue.sql not run yet": the RPC answers 404 and the page shows its generic line.
    console.error("waitlist error", String(e).slice(0, 120));
    if (STAFF.includes(action)) return json({ error: "server" }, 500, origin);
    return json(action === "spot" || action === "gift_peek" ? { state: "error" } : action === "resend" ? { ok: false, mailed: false }
      : action === "stop" || action === "name" ? { ok: false } : action === "ref_peek" ? {} : { status: "error" }, 200, origin);
  }
});
