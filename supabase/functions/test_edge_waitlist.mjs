// Tests for the waitlist Edge Function, run WITHOUT Deno, Supabase or Resend: Node strips the TypeScript types,
// `Deno` and `fetch` are stubbed, and nothing touches the network or sends an email.
//
//   node --experimental-strip-types supabase/functions/test_edge_waitlist.mjs
//
// What matters here: an anonymous page can call this and it can spend email. Each gate (Origin, input shape, the
// per-visitor meter, the daily mail cap, the off switch, the missing key) is proven to stop the SEND, not just to
// return a different word; and nothing a browser is answered carries an email address, a confirm token or an invite
// code. The one token it may carry is a brand-new entry's own view token (status new, never exists). Since 2026-11-21
// there is no email confirmation: a new entry gets a welcome email, a friend's join carries its referral through a
// second per-link meter, and two small actions (name, ref_peek) serve the invite name.
import { readFileSync } from "node:fs";

const DIR = new URL(".", import.meta.url).pathname;   // this file lives beside the functions
const VIEW = "a1".repeat(16), CONF = "b2".repeat(16), STOPTOK = "c3".repeat(16);
const STAFF_ID = "11111111-1111-1111-1111-111111111111", OTHER_ID = "22222222-2222-2222-2222-222222222222";
const ENV = {};
let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
const keepAlive = setInterval(() => {}, 1000);

const calls = [];          // every fetch
let rpcReply, resendStatus, batchStatus, settingsRow;

const rpcCalls = () => calls.filter((c) => c.u.includes("/rest/v1/rpc/")).map((c) => ({ fn: c.u.split("/rpc/")[1], args: JSON.parse(c.body || "{}") }));
const rpcOf = (fn) => rpcCalls().filter((c) => c.fn === fn);
const resendSingles = () => calls.filter((c) => c.u === "https://api.resend.com/emails");
const resendBatches = () => calls.filter((c) => c.u === "https://api.resend.com/emails/batch");
const resendAny = () => calls.filter((c) => c.u.includes("resend.com"));

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ u, method: init.method || "GET", headers: init.headers || {}, body: init.body });
  if (u.startsWith("https://sb.test/rest/v1/rpc/")) {
    const fn = u.split("/rpc/")[1];
    const args = JSON.parse(init.body || "{}");
    const r = typeof rpcReply[fn] === "function" ? rpcReply[fn](args) : rpcReply[fn];
    if (r === undefined) return new Response(null, { status: 204 });
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { status: 200 });
  }
  if (u.startsWith("https://sb.test/rest/v1/lynxr_waitlist_settings")) return new Response(JSON.stringify([settingsRow]), { status: 200 });
  if (u === "https://sb.test/auth/v1/user") {
    const t = (init.headers?.Authorization || "").replace("Bearer ", "");
    if (t === "staff-token") return new Response(JSON.stringify({ id: STAFF_ID, email: "staff@example.invalid" }), { status: 200 });
    if (t === "plain-token") return new Response(JSON.stringify({ id: OTHER_ID, email: "plain@example.invalid" }), { status: 200 });
    return new Response("{}", { status: 401 });
  }
  if (u.startsWith("https://sb.test/rest/v1/lynxr_staff?id=eq.")) {
    return new Response(JSON.stringify(u.includes(STAFF_ID) ? [{ id: STAFF_ID }] : []), { status: 200 });
  }
  if (u === "https://api.resend.com/emails") return new Response(JSON.stringify({ id: "x" }), { status: resendStatus });
  if (u === "https://api.resend.com/emails/batch") return new Response(JSON.stringify({ data: [] }), { status: batchStatus });
  throw new Error("unexpected fetch " + u);
};

// What the database answers for a brand-new entry since the no-confirmation SQL: kind 'spot', no confirm token.
const NEW = { status: "new", email: "wl-test@example.invalid", kind: "spot", view_token: VIEW,
  ref_code: "ABCDEFGH", position: 42, may_mail: true };
// What a database that has NOT been re-run still answers (the new function must keep working against it).
const OLD_NEW = { ...NEW, kind: "confirm", confirm_token: CONF };
const reset = () => {
  calls.length = 0; resendStatus = 200; batchStatus = 200;
  settingsRow = { batch_size: 100, places: 10, discord_url: null, title_crew: 3 };
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, {
    SUPABASE_URL: "https://sb.test", SUPABASE_SECRET_KEYS: JSON.stringify({ sb_secret_x: "service-role-key" }),
    RESEND_API_KEY: "re_test_key", WAITLIST_FROM: "lynxr <wl@example.invalid>", WL_CHUNK_GAP_MS: "0",
  });
  rpcReply = {
    waitlist_take: "ok",
    waitlist_join: { ...NEW },
    waitlist_mail_take: (a) => a.p_n,
    waitlist_mark_mailed: undefined,
    waitlist_stop: true,
    waitlist_spot: { state: "waiting", position: 7, ref_code: "ABCDEFGH", referrals: 0, just_confirmed: false, batch_size: 100, places: 10 },
    waitlist_mail_info: { ok: true, email: "wl-test@example.invalid", kind: "spot", view_token: VIEW, ref_code: "ABCDEFGH", position: 9, code: null },
    waitlist_release: { batch: 3, count: 50 },
    waitlist_unmailed: { rows: [] },
    waitlist_let_in: { status: "ok", email: "let@example.invalid", code: "QRSTUVWX", view_token: null },
    waitlist_gift_peek: { state: "ok" },
    waitlist_gift_claim: { status: "claimed", email: "g@example.invalid", code: "QRSTUVWX", may_mail: true },
    waitlist_gift_mark: undefined,
    waitlist_set_name: { ok: true, name: "Maya" },
    waitlist_ref_name: { name: "Maya" },
  };
};
reset();

const FN = await import(`${DIR}/waitlist/index.ts`);
const results = [];
const check = (n, c, x = "") => results.push(`${c ? "ok  " : "FAIL"} ${n}${x ? " — " + x : ""}`);

const post = (body, { origin = "https://lynxr.io", auth = "", url = "https://fn.test/", ip = "203.0.113.7", raw = null } = {}) =>
  handler(new Request(url, {
    method: "POST",
    headers: { ...(origin ? { origin } : {}), "content-type": "text/plain;charset=UTF-8", "cf-connecting-ip": ip, ...(auth ? { authorization: "Bearer " + auth } : {}) },
    body: raw ?? JSON.stringify(body),
  }));
const rows = (n, tag = "r") => Array.from({ length: n }, (_, i) => ({ email: `${tag}${i}@example.invalid`, view_token: VIEW, code: "QRSTUVWX" }));
const keys = (o) => Object.keys(o).sort().join(",");
let r, b;

// ---------------------------------------------------------------- the door
reset();
r = await handler(new Request("https://fn.test/", { method: "OPTIONS", headers: { origin: "http://localhost:8811" } }));
check("1a preflight 204 + CORS for the local preview", r.status === 204 && r.headers.get("access-control-allow-origin") === "http://localhost:8811"
  && /authorization/.test(r.headers.get("access-control-allow-headers")) && !/apikey/.test(r.headers.get("access-control-allow-headers")));
reset(); r = await handler(new Request("https://fn.test/", { method: "GET", headers: { origin: "https://lynxr.io" } }));
check("1b GET -> 405, nothing fetched", r.status === 405 && calls.length === 0);
reset(); r = await post({ action: "join", email: "a@example.invalid" }, { origin: "https://evil.example" });
check("1c foreign Origin -> 403, nothing fetched", r.status === 403 && calls.length === 0);
reset(); r = await post({ action: "join", email: "a@example.invalid" }, { origin: "" });
check("1d no Origin (curl) on join -> 403, nothing fetched", r.status === 403 && calls.length === 0);
reset(); r = await post(null, { raw: "not json" }); b = await r.json();
check("1e garbage body -> 400, nothing fetched", r.status === 400 && b.status === "error" && calls.length === 0);

// ---------------------------------------------------------------- join
reset(); r = await post({ action: "join", email: "not an email" }); b = await r.json();
check("2a bad email -> bad_email, no RPC, no mail", r.status === 200 && b.status === "bad_email" && calls.length === 0);
reset(); r = await post({ action: "join", email: "a b@example.invalid" }); b = await r.json();
check("2b space in the address -> bad_email", b.status === "bad_email" && calls.length === 0);

for (const v of ["ip_hour", "ip_day", "all_day", "bad_ip"]) {
  reset(); rpcReply.waitlist_take = v; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
  check(`3 meter '${v}' -> limited, no join RPC, no Resend`, b.status === "limited" && rpcOf("waitlist_join").length === 0 && resendAny().length === 0);
}
reset(); await post({ action: "join", email: "a@example.invalid" });
const tk = rpcOf("waitlist_take")[0]?.args;
check("3b the meter gets a hashed visitor + the default limits, never the address",
  tk && /^[0-9a-f]{32}$/.test(tk.p_ip) && tk.p_kind === "join" && tk.p_hour === 5 && tk.p_day === 20 && tk.p_all === 2000 && !JSON.stringify(calls).includes("203.0.113.7"));
reset(); ENV.WL_IP_HOUR = "1"; ENV.WL_JOIN_DAY = "9"; await post({ action: "join", email: "a@example.invalid" });
check("3c limits come from the secrets", rpcOf("waitlist_take")[0].args.p_hour === 1 && rpcOf("waitlist_take")[0].args.p_all === 9);

reset(); r = await post({ action: "join", email: " Wl-Test@Example.invalid ", ref: "abcdefgh", source: "ref:tiktok.com", consent: "waitlist-queue-v3" }); b = await r.json();
const sent = resendSingles();
const msg = sent[0] && JSON.parse(sent[0].body);
check("4a new -> exactly one /emails call, to that address, from WAITLIST_FROM",
  sent.length === 1 && resendBatches().length === 0 && msg.to[0] === "wl-test@example.invalid" && msg.from === "lynxr <wl@example.invalid>");
check("4b the mail carries the one-click List-Unsubscribe headers, pointed at the function",
  msg.headers["List-Unsubscribe"] === `<https://sb.test/functions/v1/waitlist?stop=${VIEW}>` && msg.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
check("4c the welcome mail: subject, hello, lead, position, link to the place in line (no confirm), share link, leave link",
  msg.subject === "hey, lynxr here! you're on the waitlist" && msg.html.includes("hey, lynxr here!")
  && msg.text.includes("i'm so glad you're on the waitlist. i can't wait to help you make your next video.") && msg.html.includes("#42")
  && msg.html.includes(`href="https://lynxr.io/?spot=${VIEW}"`) && !msg.html.includes("confirm=") && !msg.text.includes("confirm=")
  && msg.html.includes("https://lynxr.io/join/?c=ABCDEFGH") && msg.html.includes(`https://lynxr.io/?spot=${VIEW}&amp;stop=1`) && msg.html.includes("lynxr LLC"));
check("4d the browser's answer has exactly the allowed keys, and the new entry's own token",
  r.status === 200 && keys(b) === "batch_size,mailed,places,position,ref_code,status,token" && b.status === "new" && b.position === 42 && b.ref_code === "ABCDEFGH"
  && b.mailed === true && b.batch_size === 100 && b.places === 10 && b.token === VIEW);
check("4e ...and no confirm token, invite code or email address anywhere in it",
  !JSON.stringify(b).includes(CONF) && !JSON.stringify(b).includes("wl-test") && !JSON.stringify(b).includes("@"));
const jn = rpcOf("waitlist_join")[0].args;
check("4f the join RPC gets the trimmed address, a clean share code, source and consent tag",
  jn.p_email === "Wl-Test@Example.invalid" && jn.p_ref === "ABCDEFGH" && jn.p_source === "ref:tiktok.com" && jn.p_consent === "waitlist-queue-v3");
check("4g sent mail is recorded as sent (spot), after a one-email cap check",
  rpcOf("waitlist_mail_take")[0].args.p_n === 1 && rpcOf("waitlist_mail_take")[0].args.p_cap === 80
  && rpcOf("waitlist_mark_mailed")[0].args.p_kind === "spot" && rpcOf("waitlist_mark_mailed")[0].args.p_emails[0] === "wl-test@example.invalid");
reset(); await post({ action: "join", email: "a@example.invalid", ref: "not a code" });
check("4h a malformed share code never reaches the database", rpcOf("waitlist_join")[0].args.p_ref === "");

reset(); rpcReply.waitlist_mail_take = 0; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("5 daily mail cap spent -> mailed:false, no Resend, row flagged pending",
  b.status === "new" && b.mailed === false && resendAny().length === 0
  && rpcOf("waitlist_mark_mailed").length === 1 && rpcOf("waitlist_mark_mailed")[0].args.p_kind === "pending");
reset(); resendStatus = 500; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("5b Resend refuses -> the join still works, mailed:false, flagged pending",
  b.status === "new" && b.mailed === false && rpcOf("waitlist_mark_mailed")[0].args.p_kind === "pending");
reset(); rpcReply.waitlist_join = { ...NEW, may_mail: false }; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("5c the SQL throttle says no -> no cap spent, no Resend", b.mailed === false && rpcOf("waitlist_mail_take").length === 0 && resendAny().length === 0);

reset(); rpcReply.waitlist_join = { ...NEW, status: "exists", kind: "spot" }; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
const m6 = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
check("6a exists -> answer is exactly status + mailed", keys(b) === "mailed,status" && b.status === "exists" && b.mailed === true);
check("6b someone already in line is sent their place again, not a welcome",
  m6 && m6.subject === "your place in line for lynxr" && m6.html.includes(`?spot=${VIEW}`) && !m6.html.includes("confirm=") && !m6.html.includes("hey, lynxr here!"));
check("6c ...and it is recorded as spot", rpcOf("waitlist_mark_mailed")[0].args.p_kind === "spot");

reset(); rpcReply.waitlist_join = { status: "account" }; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("7 account -> {status:'account'}, no cap, no Resend", JSON.stringify(b) === '{"status":"account"}' && rpcOf("waitlist_mail_take").length === 0 && resendAny().length === 0);
reset(); rpcReply.waitlist_join = { status: "boom" }; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("7b an unexpected answer -> {status:'error'}", b.status === "error" && resendAny().length === 0);
reset(); rpcReply.waitlist_join = new Response("{}", { status: 404 }); r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("7c SQL not installed (RPC 404) -> {status:'error'}, 200, no Resend", r.status === 200 && b.status === "error" && resendAny().length === 0);

// ---------------------------------------------------------------- spot / resend / stop
reset(); r = await post({ action: "spot", token: VIEW, confirm: CONF }); b = await r.json();
check("8a spot with confirm passes both tokens to the RPC, after a meter check",
  rpcOf("waitlist_spot")[0].args.p_token === VIEW && rpcOf("waitlist_spot")[0].args.p_confirm === CONF && rpcOf("waitlist_take")[0].args.p_kind === "spot");
check("8b spot answers the RPC's object as is", b.state === "waiting" && b.position === 7 && !JSON.stringify(b).includes("@"));
reset(); await post({ action: "spot", token: VIEW }); check("8c spot without confirm sends null", rpcOf("waitlist_spot")[0].args.p_confirm === null);
reset(); r = await post({ action: "spot", token: "short" }); b = await r.json();
check("8d a malformed token -> {state:'none'}, no RPC", b.state === "none" && calls.length === 0);
reset(); rpcReply.waitlist_take = "ip_hour"; r = await post({ action: "spot", token: VIEW }); b = await r.json();
check("8e spot over the meter -> limited, no spot RPC", b.state === "limited" && rpcOf("waitlist_spot").length === 0);

reset(); r = await post({ action: "resend", token: VIEW }); b = await r.json();
check("8f resend -> one mail, recorded as spot; answer {ok, mailed}", resendSingles().length === 1 && keys(b) === "mailed,ok" && b.ok && b.mailed && rpcOf("waitlist_mark_mailed")[0].args.p_kind === "spot");
reset(); rpcReply.waitlist_mail_info = { ok: false, wait_s: 840 }; r = await post({ action: "resend", token: VIEW }); b = await r.json();
check("8g resend inside the throttle -> {ok:false, wait_s}, no cap spent, no Resend", b.ok === false && b.wait_s === 840 && resendAny().length === 0 && rpcOf("waitlist_mail_take").length === 0);

reset(); r = await post({ action: "stop", token: VIEW }); b = await r.json();
check("8h stop -> {ok:true}, waitlist_stop called with the token", b.ok === true && rpcOf("waitlist_stop")[0].args.p_token === VIEW);

reset(); r = await post("List-Unsubscribe=One-Click", { origin: "", url: `https://fn.test/?stop=${STOPTOK}`, raw: "List-Unsubscribe=One-Click" });
check("9a ?stop= POST with no Origin and the one-click body -> 200 ok, waitlist_stop called",
  r.status === 200 && (await r.text()) === "ok" && rpcOf("waitlist_stop").length === 1 && rpcOf("waitlist_stop")[0].args.p_token === STOPTOK);
reset(); ENV.WAITLIST_MODE = "off"; r = await post("x", { origin: "", url: `https://fn.test/?stop=${STOPTOK}`, raw: "List-Unsubscribe=One-Click" });
check("9b ...and leaving still works while the waitlist is off", r.status === 200 && rpcOf("waitlist_stop").length === 1);
reset(); r = await post({ action: "join", email: "a@example.invalid" }, { origin: "", url: `https://fn.test/?stop=${STOPTOK}` });
check("9c ?stop= is only a leave: it never joins or mails", rpcOf("waitlist_join").length === 0 && resendAny().length === 0);
reset(); r = await post({ action: "join", email: "a@example.invalid" }, { origin: "", url: "https://fn.test/?stop=nothex" });
check("9d a malformed ?stop= gets no special treatment (no Origin -> 403)", r.status === 403 && calls.length === 0);

// ---------------------------------------------------------------- staff
reset(); r = await post({ action: "release", n: 100 }); b = await r.json();
check("10a release with no Authorization -> 401, no release RPC", r.status === 401 && rpcOf("waitlist_release").length === 0);
reset(); r = await post({ action: "release", n: 100 }, { auth: "bogus" });
check("10b release with a token the auth server refuses -> 401", r.status === 401 && rpcOf("waitlist_release").length === 0);
reset(); r = await post({ action: "release", n: 100 }, { auth: "plain-token" });
check("10c release by a signed-in non-staff -> 403, no release RPC, no mail", r.status === 403 && rpcOf("waitlist_release").length === 0 && resendAny().length === 0);
reset(); r = await post({ action: "let_in", email: "x@example.invalid" }, { auth: "plain-token" });
check("10d let_in by non-staff -> 403", r.status === 403 && rpcOf("waitlist_let_in").length === 0);
reset(); r = await post({ action: "release", n: 3, dry: true }, { auth: "staff-token" }); b = await r.json();
check("10e staff + dry -> {batch, count}, no mail, nothing marked",
  r.status === 200 && JSON.stringify(b) === '{"batch":3,"count":50}' && rpcOf("waitlist_release")[0].args.p_dry === true && rpcOf("waitlist_release")[0].args.p_n === 3
  && resendAny().length === 0 && rpcOf("waitlist_mark_mailed").length === 0 && rpcOf("waitlist_mail_take").length === 0);

reset(); rpcReply.waitlist_release = { batch: 7, rows: rows(250) };
r = await post({ action: "release", n: 250 }, { auth: "staff-token" }); b = await r.json();
const bs = resendBatches(), bsBody = bs.map((c) => JSON.parse(c.body));
check("10f staff release of 250 -> three batch calls of 100, 100, 50, no single sends",
  bs.length === 3 && bsBody.map((x) => x.length).join() === "100,100,50" && resendSingles().length === 0);
check("10g each batch has an Idempotency-Key naming the batch and chunk", bs.map((c) => c.headers["Idempotency-Key"]).join() === "release-7-0,release-7-1,release-7-2");
check("10h every release mail has the list-unsubscribe header and the create-account link",
  bsBody[0][0].headers["List-Unsubscribe"].includes("?stop=") && bsBody[0][0].html.includes("?signup=1&amp;e=r0%40example.invalid&amp;c=QRSTUVWX") && bsBody[0][0].subject === "you're in: create your lynxr account");
check("10i the cap is asked per chunk and mark_mailed gets only what was sent",
  rpcOf("waitlist_mail_take").map((c) => c.args.p_n).join() === "100,100,50" && rpcOf("waitlist_mark_mailed").map((c) => c.args.p_emails.length).join() === "100,100,50"
  && rpcOf("waitlist_mark_mailed").every((c) => c.args.p_kind === "release"));
check("10j answer {batch, released, mailed, unmailed}", JSON.stringify(b) === '{"batch":7,"released":250,"mailed":250,"unmailed":0}');

reset(); rpcReply.waitlist_release = { batch: 7, rows: rows(250) }; let left = 120;
rpcReply.waitlist_mail_take = (a) => { const n = Math.min(a.p_n, left); left -= n; return n; };
r = await post({ action: "release", n: 250 }, { auth: "staff-token" }); b = await r.json();
check("10k the daily cap runs out mid-release -> only 120 sent, the rest stay unmailed, no further chunk is tried",
  resendBatches().length === 2 && JSON.parse(resendBatches()[1].body).length === 20 && b.mailed === 120 && b.unmailed === 130 && b.released === 250);

reset(); rpcReply.waitlist_release = { batch: 8, rows: rows(5) }; batchStatus = 500;
r = await post({ action: "release", n: 5 }, { auth: "staff-token" }); b = await r.json();
check("11 Resend 500 on the batch -> mailed:0, mark_mailed never called, all five unmailed",
  b.mailed === 0 && b.unmailed === 5 && b.released === 5 && rpcOf("waitlist_mark_mailed").length === 0);
reset(); rpcReply.waitlist_release = { batch: 8, rows: rows(5) }; delete ENV.RESEND_API_KEY;
r = await post({ action: "release", n: 5 }, { auth: "staff-token" }); b = await r.json();
check("11b no Resend key -> released but nothing sent, nothing marked", b.released === 5 && b.mailed === 0 && resendAny().length === 0 && rpcOf("waitlist_mark_mailed").length === 0);
reset(); rpcReply.waitlist_release = { error: "too_soon" }; r = await post({ action: "release", n: 100 }, { auth: "staff-token" }); b = await r.json();
check("11c a double press -> {error:'too_soon'}, no mail", JSON.stringify(b) === '{"error":"too_soon"}' && resendAny().length === 0);
reset(); rpcReply.waitlist_release = { batch: 9, count: 100 }; await post({ action: "release", dry: true }, { auth: "staff-token" });
check("11d no n -> the settings' batch size", rpcOf("waitlist_release")[0].args.p_n === 100);

reset(); rpcReply.waitlist_unmailed = { rows: rows(3, "u") };
r = await post({ action: "retry_release" }, { auth: "staff-token" }); b = await r.json();
check("11e retry_release resends the unmailed under a retry- key, one batch",
  resendBatches().length === 1 && /^retry-\d{4}-\d{2}-\d{2}T\d{2}-0$/.test(resendBatches()[0].headers["Idempotency-Key"]) && b.listed === 3 && b.mailed === 3 && b.unmailed === 0);

// ---------------------------------------------------------------- off, nomail, no key
reset(); ENV.WAITLIST_MODE = "off"; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("12a WAITLIST_MODE=off -> {status:'off'}, nothing fetched", b.status === "off" && calls.length === 0);
reset(); ENV.WAITLIST_MODE = "off"; r = await post({ action: "spot", token: VIEW }); b = await r.json();
check("12b ...spot says state off", b.state === "off" && calls.length === 0);
reset(); ENV.WAITLIST_MODE = "off"; r = await post({ action: "release" }, { auth: "staff-token" }); b = await r.json();
check("12c ...and staff actions are off too", b.error === "off" && calls.length === 0);
reset(); ENV.WAITLIST_MODE = "nomail"; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("12d WAITLIST_MODE=nomail -> the join works, no mail, flagged pending, no cap spent",
  b.status === "new" && b.mailed === false && resendAny().length === 0 && rpcOf("waitlist_mail_take").length === 0 && rpcOf("waitlist_mark_mailed")[0].args.p_kind === "pending");

reset(); delete ENV.RESEND_API_KEY; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("13a no RESEND_API_KEY -> the join works, mailed:false, no fetch to resend.com", b.status === "new" && b.mailed === false && resendAny().length === 0);
reset(); delete ENV.WAITLIST_FROM; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("13b a key but no WAITLIST_FROM -> no mail (D16: no address is hard-coded)", b.status === "new" && b.mailed === false && resendAny().length === 0);
const src = readFileSync(`${DIR}/waitlist/index.ts`, "utf8");
check("13c no email address is hard-coded in the function", !/[A-Za-z0-9._-]+@(?!your)[A-Za-z0-9-]+\.[a-z]{2,}/.test(src));
reset(); ENV.WAITLIST_REPLY_TO = "help@example.invalid"; await post({ action: "join", email: "a@example.invalid" });
check("13d WAITLIST_REPLY_TO becomes reply_to", JSON.parse(resendSingles()[0].body).reply_to === "help@example.invalid");

// ---------------------------------------------------------------- let_in
reset(); rpcReply.waitlist_let_in = { status: "has_account" }; r = await post({ action: "let_in", email: "x@example.invalid" }, { auth: "staff-token" }); b = await r.json();
check("14a let_in on an existing account -> has_account, sends nothing", b.status === "has_account" && resendAny().length === 0);
reset(); r = await post({ action: "let_in", email: "nope" }, { auth: "staff-token" }); b = await r.json();
check("14b let_in with a bad address -> bad_email, no RPC", b.status === "bad_email" && rpcOf("waitlist_let_in").length === 0);
reset(); r = await post({ action: "let_in", email: "let@example.invalid" }, { auth: "staff-token" }); b = await r.json();
const lm = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
check("14c let_in -> one release mail, 'sent'", b.status === "sent" && resendSingles().length === 1 && lm.to[0] === "let@example.invalid" && lm.html.includes("c=QRSTUVWX"));
check("14d a let-in who never joined gets no waitlist unsubscribe link and the right footer",
  !("List-Unsubscribe" in lm.headers) && !lm.html.includes("leave the waitlist") && lm.html.includes("a lynxr team member invited you"));
reset(); resendStatus = 500; r = await post({ action: "let_in", email: "let@example.invalid" }, { auth: "staff-token" }); b = await r.json();
check("14e Resend fails -> mail_failed, in_unmailed:false for a stranger", b.status === "mail_failed" && b.in_unmailed === false && rpcOf("waitlist_mark_mailed")[0].args.p_kind === "pending");
reset(); rpcReply.waitlist_let_in = { status: "ok", email: "let@example.invalid", code: "QRSTUVWX", view_token: VIEW }; resendStatus = 500;
r = await post({ action: "let_in", email: "let@example.invalid" }, { auth: "staff-token" }); b = await r.json();
check("14f ...in_unmailed:true for someone who was on the waitlist", b.status === "mail_failed" && b.in_unmailed === true);

// ---------------------------------------------------------------- the mail itself
const hostile = FN.buildMail("release", { email: 'x"><script>alert(1)</script>@example.invalid', view_token: VIEW, code: "A<B", position: null }, "https://lynxr.io", 100);
check("15a every value is HTML-escaped", !hostile.html.includes("<script>") && hostile.html.includes("&lt;script&gt;") && !hostile.html.includes('x"><'));
const allMail = ["welcome", "spot", "release", "gift"].map((k) => FN.buildMail(k, { email: "a@example.invalid", view_token: VIEW, confirm_token: CONF, ref_code: "ABCDEFGH", position: 1234, code: "QRSTUVWX" }, "https://lynxr.io", 100));
check("15b no pure black or white in any of the four mails", allMail.every((m) => !/#(000|fff)(?![0-9a-f])/i.test(m.html) && !/#(000000|ffffff)/i.test(m.html)));
check("15c positions are formatted, tokens are only ever in links", allMail[0].html.includes("#1,234") && allMail.every((m) => !m.html.includes('src=')));
check("15d the entity name is spelled lynxr LLC in all four mails", allMail.every((m) => m.html.includes("lynxr LLC") && m.text.includes("lynxr LLC")));
check("15e local previews link to localhost, never lynxr.io", FN.buildMail("spot", { email: "a@example.invalid", view_token: VIEW, ref_code: "ABCDEFGH", position: 3 }, "http://localhost:8811").html.includes("http://localhost:8811/?spot="));

// ---------------------------------------------------------------- visitor key (duplicated from ig-thumb; guard against drift)
check("16a ipv4 kept, ipv6 cut to /64, garbage empty", FN.ipKey("203.0.113.7") === "203.0.113.7" && FN.ipKey("2001:db8:1:2::1") === "2001:db8:1:2::/64" && FN.ipKey("nope") === "");
check("16b cf-connecting-ip wins; x-forwarded-for read from the right",
  FN.clientIp(new Headers({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "1.1.1.1" })).ip === "198.51.100.1"
  && FN.clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.2" })).ip === "198.51.100.2");
const h1 = await FN.ipHash("203.0.113.7", "2026-11-20"), h2 = await FN.ipHash("203.0.113.8", "2026-11-20"), h3 = await FN.ipHash("203.0.113.7", "2026-11-21");
check("16c hash differs per address and day, 32 hex, no raw address", h1 !== h2 && h1 !== h3 && /^[0-9a-f]{32}$/.test(h1) && !h1.includes("203"));

// ---------------------------------------------------------------- gift invites (plan beli B3/B4)
// The friend's address is typed on the landing page by a stranger; a gift claim can spend an email. Each gate is shown
// to stop the SEND, and the browser's answer carries the status and nothing else: never the code, the address or a token.
reset(); r = await post({ action: "gift_peek", code: "bad" }); b = await r.json();
check("17a gift_peek with a malformed code -> {state:'none'}, nothing fetched", JSON.stringify(b) === '{"state":"none"}' && calls.length === 0);
reset(); r = await post({ action: "gift_peek", code: "abcdefgh" }); b = await r.json();
check("17b peek ok -> metered under the spot budget, code upper-cased, answer exactly {state:'ok'}",
  JSON.stringify(b) === '{"state":"ok"}' && rpcOf("waitlist_take")[0].args.p_kind === "spot" && rpcOf("waitlist_take")[0].args.p_hour === 120
  && rpcOf("waitlist_gift_peek")[0].args.p_code === "ABCDEFGH" && resendAny().length === 0);
reset(); rpcReply.waitlist_gift_peek = { state: "ok", giver: "x", email: "giver@example.invalid" }; r = await post({ action: "gift_peek", code: "ABCDEFGH" }); b = await r.json();
check("17b' a peek RPC that adds keys still answers exactly {state:'ok'}", JSON.stringify(b) === '{"state":"ok"}');
reset(); rpcReply.waitlist_gift_peek = { state: "weird" }; r = await post({ action: "gift_peek", code: "ABCDEFGH" }); b = await r.json();
check("17b'' an unknown peek state -> {state:'error'}", JSON.stringify(b) === '{"state":"error"}');
reset(); rpcReply.waitlist_take = "ip_hour"; r = await post({ action: "gift_peek", code: "ABCDEFGH" }); b = await r.json();
check("17b''' peek over the spot meter -> {state:'limited'}, no peek RPC", b.state === "limited" && rpcOf("waitlist_gift_peek").length === 0);

reset(); r = await post({ action: "gift", code: "ABCDEFGH", email: "not an email" }); b = await r.json();
check("17c gift with a bad email -> bad_email, nothing fetched", JSON.stringify(b) === '{"status":"bad_email"}' && calls.length === 0);
reset(); r = await post({ action: "gift", code: "nope", email: "g@example.invalid" }); b = await r.json();
check("17c' gift with a malformed code -> none, nothing fetched", JSON.stringify(b) === '{"status":"none"}' && calls.length === 0);
reset(); rpcReply.waitlist_take = "ip_hour"; r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
check("17d meter ip_hour -> limited, no claim RPC, no Resend", JSON.stringify(b) === '{"status":"limited"}' && rpcOf("waitlist_gift_claim").length === 0 && resendAny().length === 0);

reset(); r = await post({ action: "gift", code: "abcdefgh", email: " G@Example.invalid " }); b = await r.json();
const gm = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
check("17e claimed -> exactly one /emails call, to the claimed address, from WAITLIST_FROM",
  resendSingles().length === 1 && resendBatches().length === 0 && gm.to[0] === "g@example.invalid" && gm.from === "lynxr <wl@example.invalid>");
check("17e' the claim RPC gets the upper-cased code and the trimmed address; the meter kind is 'gift' with the join limits",
  rpcOf("waitlist_gift_claim")[0].args.p_code === "ABCDEFGH" && rpcOf("waitlist_gift_claim")[0].args.p_email === "G@Example.invalid"
  && rpcOf("waitlist_take")[0].args.p_kind === "gift" && rpcOf("waitlist_take")[0].args.p_hour === 5 && rpcOf("waitlist_take")[0].args.p_day === 20 && rpcOf("waitlist_take")[0].args.p_all === 2000);
check("17e'' the gift mail: subject, create-account link with the code, 14-day line",
  gm.subject === "a friend gave you a lynxr invite" && gm.html.includes("?signup=1&amp;e=g%40example.invalid&amp;c=QRSTUVWX") && gm.html.includes("held for 14 days")
  && gm.text.includes("?signup=1&e=g%40example.invalid&c=QRSTUVWX") && gm.html.includes("lynxr LLC"));
check("17e''' no unsubscribe header, no leave link, no share link in the gift mail",
  !("List-Unsubscribe" in gm.headers) && !("List-Unsubscribe-Post" in gm.headers) && !gm.html.includes("leave the waitlist") && !gm.text.includes("leave the waitlist")
  && !gm.html.includes("?join=") && !gm.html.includes("?spot="));
check("17e'''' the send is recorded (waitlist_gift_mark) for that address, after one cap check; nothing else is marked",
  rpcOf("waitlist_gift_mark").length === 1 && rpcOf("waitlist_gift_mark")[0].args.p_email === "g@example.invalid"
  && rpcOf("waitlist_mail_take")[0].args.p_n === 1 && rpcOf("waitlist_mark_mailed").length === 0);
check("17e5 the browser's answer is exactly mailed + status, with no address and no code",
  keys(b) === "mailed,status" && b.status === "claimed" && b.mailed === true && !JSON.stringify(b).includes("@") && !JSON.stringify(b).includes("QRSTUVWX"));

reset(); rpcReply.waitlist_gift_claim = { status: "again", email: "g@example.invalid", code: "QRSTUVWX", may_mail: false }; r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
check("17f again with may_mail:false -> {status:'again', mailed:false}, no cap spent, no Resend, nothing marked",
  JSON.stringify(b) === '{"status":"again","mailed":false}' && rpcOf("waitlist_mail_take").length === 0 && resendAny().length === 0 && rpcOf("waitlist_gift_mark").length === 0);
reset(); rpcReply.waitlist_gift_claim = { status: "again", email: "g@example.invalid", code: "QRSTUVWX", may_mail: true }; r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
check("17f' again with may_mail:true is mailed again, once", b.status === "again" && b.mailed === true && resendSingles().length === 1);

for (const st of ["account", "used_up", "none", "off", "open", "busy"]) {
  reset(); rpcReply.waitlist_gift_claim = { status: st, email: "leak@example.invalid", code: "QRSTUVWX", may_mail: true }; r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
  check(`17g '${st}' -> {status} only, no Resend, no cap spent`, JSON.stringify(b) === JSON.stringify({ status: st }) && resendAny().length === 0 && rpcOf("waitlist_mail_take").length === 0);
}
reset(); rpcReply.waitlist_gift_claim = { status: "boom" }; r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
check("17g' an unexpected claim answer -> {status:'error'}, no Resend", JSON.stringify(b) === '{"status":"error"}' && resendAny().length === 0);
reset(); rpcReply.waitlist_gift_claim = new Response("{}", { status: 404 }); r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
check("17g'' SQL not installed (RPC 404) -> {status:'error'}, 200, no Resend", r.status === 200 && JSON.stringify(b) === '{"status":"error"}' && resendAny().length === 0);
reset(); rpcReply.waitlist_gift_peek = new Response("{}", { status: 404 }); r = await post({ action: "gift_peek", code: "ABCDEFGH" }); b = await r.json();
check("17g''' SQL not installed on peek -> {state:'error'}", r.status === 200 && JSON.stringify(b) === '{"state":"error"}');

reset(); rpcReply.waitlist_mail_take = 0; r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
check("17h mail cap spent -> claimed, mailed:false, no Resend, nothing marked, no pending flag",
  b.status === "claimed" && b.mailed === false && resendAny().length === 0 && rpcOf("waitlist_gift_mark").length === 0 && rpcOf("waitlist_mark_mailed").length === 0);
reset(); resendStatus = 500; r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
check("17i Resend 500 -> claimed, mailed:false, waitlist_gift_mark not called", b.status === "claimed" && b.mailed === false && rpcOf("waitlist_gift_mark").length === 0);
reset(); delete ENV.RESEND_API_KEY; r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
check("17i' no Resend key -> claimed, mailed:false, no fetch to resend.com, no cap spent", b.mailed === false && resendAny().length === 0 && rpcOf("waitlist_mail_take").length === 0);
reset(); ENV.WAITLIST_MODE = "nomail"; r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
check("17i'' WAITLIST_MODE=nomail -> claimed, mailed:false, no Resend", b.status === "claimed" && b.mailed === false && resendAny().length === 0);

reset(); ENV.WAITLIST_MODE = "off"; r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }); b = await r.json();
const offGift = JSON.stringify(b), offGiftCalls = calls.length;
reset(); ENV.WAITLIST_MODE = "off"; r = await post({ action: "gift_peek", code: "ABCDEFGH" }); b = await r.json();
check("17j WAITLIST_MODE=off -> gift {status:'off'}, peek {state:'off'}, nothing fetched",
  offGift === '{"status":"off"}' && offGiftCalls === 0 && JSON.stringify(b) === '{"state":"off"}' && calls.length === 0);
reset(); r = await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" }, { origin: "https://evil.example" });
check("17k a foreign Origin cannot claim a gift", r.status === 403 && calls.length === 0);

// ---------------------------------------------------------------- the Discord line (settings' discord_url)
const hasDiscord = (m) => /discord/i.test(m.html) || /discord/i.test(m.text);
reset(); settingsRow.discord_url = "https://discord.gg/lynxrtest"; await post({ action: "join", email: "a@example.invalid" });
let dm = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
check("18a a set Discord link is in the welcome mail, html and text, with the line",
  dm && dm.html.includes("https://discord.gg/lynxrtest") && dm.text.includes("https://discord.gg/lynxrtest")
  && dm.html.includes("come say hi on the lynxr discord") && dm.text.includes("come say hi on the lynxr discord:\nhttps://discord.gg/lynxrtest"));
reset(); settingsRow.discord_url = "https://discord.com/invite/lynxr-test"; await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" });
dm = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
check("18a' ...and in the gift mail (a discord.com/invite link is accepted too)", dm && dm.html.includes("https://discord.com/invite/lynxr-test") && dm.text.includes("https://discord.com/invite/lynxr-test"));
reset(); settingsRow.discord_url = "https://discord.gg/lynxrtest"; rpcReply.waitlist_release = { batch: 7, rows: rows(2) };
await post({ action: "release", n: 2 }, { auth: "staff-token" });
dm = resendBatches()[0] && JSON.parse(resendBatches()[0].body)[0];
check("18a'' ...and in a staff release batch", dm && dm.html.includes("https://discord.gg/lynxrtest"));
reset(); settingsRow.discord_url = "https://discord.gg/lynxrtest"; rpcReply.waitlist_unmailed = { rows: rows(2, "u") };
await post({ action: "retry_release" }, { auth: "staff-token" });
dm = resendBatches()[0] && JSON.parse(resendBatches()[0].body)[0];
check("18a''' ...and in a retry_release batch", dm && dm.html.includes("https://discord.gg/lynxrtest"));
reset(); settingsRow.discord_url = "https://discord.gg/lynxrtest"; await post({ action: "let_in", email: "let@example.invalid" }, { auth: "staff-token" });
dm = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
check("18a'''' ...and in a let_in mail", dm && dm.html.includes("https://discord.gg/lynxrtest"));
reset(); settingsRow.discord_url = "https://discord.gg/lynxrtest"; await post({ action: "resend", token: VIEW });
dm = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
check("18a5 ...and in a send-it-again mail", dm && dm.html.includes("https://discord.gg/lynxrtest"));

reset(); settingsRow.discord_url = "https://evil.example/x"; await post({ action: "join", email: "a@example.invalid" });
dm = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
const evil = FN.buildMail("spot", { email: "a@example.invalid", view_token: VIEW, ref_code: "ABCDEFGH", position: 3 }, "https://lynxr.io", 100, { discord: "https://discord.gg/x\"><script>" });
check("18b a non-Discord URL in the settings is in no mail (and a hostile one never reaches buildMail's html)",
  dm && !hasDiscord(dm) && !dm.html.includes("evil.example") && !hasDiscord(evil) && !evil.html.includes("<script>"));
const noDisc = [];
reset(); settingsRow.discord_url = null;
await post({ action: "join", email: "a@example.invalid" });                                        // welcome
rpcReply.waitlist_join = { ...NEW, status: "exists", kind: "spot" }; await post({ action: "join", email: "a@example.invalid" });   // spot
await post({ action: "let_in", email: "let@example.invalid" }, { auth: "staff-token" });           // release
await post({ action: "gift", code: "ABCDEFGH", email: "g@example.invalid" });                       // gift
for (const c of resendSingles()) noDisc.push(JSON.parse(c.body));
check("18c no Discord setting -> no discord in the welcome, spot, release or gift mail (four mails sent)",
  noDisc.length === 4 && noDisc.every((m) => !hasDiscord(m)));
check("18c' the settings request asks for the Discord and title columns", calls.some((c) => c.u.includes("lynxr_waitlist_settings") && c.u.includes("discord_url") && c.u.includes("title_crew")));
reset(); settingsRow.discord_url = "https://discord.gg/lynxrtest";
const fourDisc = ["welcome", "spot", "release", "gift"].map((k) => FN.buildMail(k, { email: "a@example.invalid", view_token: VIEW, confirm_token: CONF, ref_code: "ABCDEFGH", position: 5, code: "QRSTUVWX" }, "https://lynxr.io", 100, { discord: settingsRow.discord_url }));
check("18d buildMail: all four kinds carry the Discord line when given a valid link, and no pure black or white", fourDisc.every((m) => m.html.includes("come say hi on the lynxr discord") && !/#(000|fff)(?![0-9a-f])/i.test(m.html)));
reset(); settingsRow = {};   // the settings row answers without the numbers: defaults, no Discord
await post({ action: "join", email: "a@example.invalid" });
dm = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
check("18e an unusable settings row falls back to the defaults and a join still sends the welcome mail, without Discord", dm && !hasDiscord(dm) && dm.subject === "hey, lynxr here! you're on the waitlist");

// ---------------------------------------------------------------- the spot answer is a whitelist
reset(); rpcReply.waitlist_spot = { state: "waiting", position: 7, ref_code: "ABCDEFGH", referrals: 2, just_confirmed: true, batch_size: 100, places: 10,
  crew: 2, title: "founding", title_crew: 3, discord: "https://discord.gg/lynxrtest", name: "Maya",
  email: "leak@example.invalid", view_token: VIEW, confirm_token: CONF, code: "QRSTUVWX", id: 5 };
r = await post({ action: "spot", token: VIEW }); b = await r.json();
check("19a spot strips email, tokens, code, the retired just_confirmed and unknown keys; keeps crew, title, title_crew, discord, name",
  keys(b) === "batch_size,crew,discord,name,places,position,ref_code,referrals,state,title,title_crew" && b.name === "Maya"
  && b.crew === 2 && b.title === "founding" && b.title_crew === 3 && b.discord === "https://discord.gg/lynxrtest"
  && !JSON.stringify(b).includes("@") && !JSON.stringify(b).includes(VIEW) && !JSON.stringify(b).includes(CONF) && !JSON.stringify(b).includes("QRSTUVWX"));
reset(); rpcReply.waitlist_spot = { state: "waiting", position: 7, crew: 0, title_crew: 3, discord: "https://evil.example" };
r = await post({ action: "spot", token: VIEW }); b = await r.json();
check("19b a spot discord that is not a Discord link is dropped; the rest stays", !("discord" in b) && b.crew === 0 && b.position === 7 && b.title_crew === 3);
reset(); rpcReply.waitlist_spot = { state: "waiting", position: 7, discord: 42 }; r = await post({ action: "spot", token: VIEW }); b = await r.json();
check("19c a non-string discord is dropped", !("discord" in b) && b.state === "waiting");
reset(); rpcReply.waitlist_spot = { position: 7, email: "leak@example.invalid" }; r = await post({ action: "spot", token: VIEW }); b = await r.json();
check("19d an answer with no state -> {state:'error'}, nothing else", JSON.stringify(b) === '{"state":"error"}');
reset(); rpcReply.waitlist_spot = { state: "waiting", position: 7, title: null, discord: null }; r = await post({ action: "spot", token: VIEW }); b = await r.json();
check("19e null title/discord are absent, not null", !("title" in b) && !("discord" in b));

check("19f no Discord invite URL is hard-coded in the function (the only literals are the shape regexes)",
  !/https:\/\/discord\.(gg|com\/invite)\/[A-Za-z0-9-]+/.test(src.replace(/DISCORD_RE = [^\n]*\n/, "").replace(/\/\/.*$/gm, "")));

// ---------------------------------------------------------------- no confirmation (plan waitlist-no-confirm)
// 20: the function file is pasted through a clipboard, so it stays ASCII; and the word "confirm" is nowhere a person reads.
check("20a the function source is pure ASCII (it is pasted by hand)", !/[^\x00-\x7f]/.test(src));
const visible = (m) => [m.html.replace(/href="[^"]*"/g, ""), m.text.replace(/https?:\S+/g, "")].join("\n");
const mailsOld = ["welcome", "spot", "release", "gift"].map((k) => FN.buildMail(k, { email: "a@example.invalid", view_token: VIEW, confirm_token: CONF, ref_code: "ABCDEFGH", position: 1234, code: "QRSTUVWX" }, "https://lynxr.io", 100));
check("20b no mail kind shows the word confirm once hrefs and URLs are removed (even when an old database sends a confirm token)",
  mailsOld.every((m) => !/confirm/i.test(visible(m))) && allMail.every((m) => !/confirm/i.test(visible(m))));
reset(); rpcReply.waitlist_join = { ...OLD_NEW }; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
const mo = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
check("20c an old database (kind confirm + confirm token): the welcome link still carries the confirm token, invisibly, and says nothing about it",
  mo && mo.subject === "hey, lynxr here! you're on the waitlist" && mo.html.includes(`?spot=${VIEW}&amp;confirm=${CONF}`) && mo.text.includes(`?spot=${VIEW}&confirm=${CONF}`)
  && !/confirm/i.test(visible(mo)) && b.status === "new" && b.token === VIEW && !JSON.stringify(b).includes(CONF) && rpcOf("waitlist_mark_mailed")[0].args.p_kind === "spot");
reset(); rpcReply.waitlist_join = { ...NEW, status: "exists" }; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("20d an exists answer never carries a token (typing someone's address must not hand over their page)", !("token" in b) && keys(b) === "mailed,status" && !JSON.stringify(b).includes(VIEW));
reset(); rpcReply.waitlist_join = { ...NEW, view_token: "not-a-token" }; r = await post({ action: "join", email: "a@example.invalid" }); b = await r.json();
check("20e a view token that is not 32 hex is never handed on", b.status === "new" && !("token" in b));
reset(); rpcReply.waitlist_mail_info = { ok: true, email: "wl-test@example.invalid", kind: "confirm", view_token: VIEW, confirm_token: CONF, ref_code: "ABCDEFGH", position: 9, code: null };
r = await post({ action: "resend", token: VIEW }); b = await r.json();
const mr = resendSingles()[0] && JSON.parse(resendSingles()[0].body);
check("20f send-it-again against an old database (kind confirm) sends 'your place', never a confirm email, and records spot",
  mr && mr.subject === "your place in line for lynxr" && !/confirm/i.test(visible(mr)) && mr.html.includes(`&amp;confirm=${CONF}`) && rpcOf("waitlist_mark_mailed")[0].args.p_kind === "spot");
const wm = allMail[0], sm = allMail[1];
check("20g welcome reads lynxr, hello, lead, number; spot keeps the number first and says it is the same link again",
  wm.html.indexOf("hey, lynxr here!") < wm.html.indexOf("glad you") && wm.html.indexOf("glad you") < wm.html.indexOf("#1,234")
  && sm.html.indexOf("#1,234") < sm.html.indexOf("same page every time") && !sm.html.includes("hey, lynxr here!")
  && wm.text.indexOf("hey, lynxr here!") < wm.text.indexOf("#1,234") && wm.html.includes("want in sooner? every friend who joins with your link moves you up 10 places:")
  && wm.html.includes("https://lynxr.io/join/?c=ABCDEFGH") && !wm.html.includes("?join="));

// 21: a friend's join counts at once, so a second meter limits joins through one friend's link per visitor per day.
reset(); r = await post({ action: "join", email: "a@example.invalid", ref: "abcdefgh" }); b = await r.json();
let tks = rpcOf("waitlist_take");
check("21a a join with a link makes two meter calls; the second is kind credit, 3 an hour and a day, a different hash that holds no IP",
  tks.length === 2 && tks[0].args.p_kind === "join" && tks[1].args.p_kind === "credit" && tks[1].args.p_hour === 3 && tks[1].args.p_day === 3
  && tks[1].args.p_all === 1000000 && /^[0-9a-f]{32}$/.test(tks[1].args.p_ip) && tks[1].args.p_ip !== tks[0].args.p_ip
  && !JSON.stringify(calls).includes("203.0.113.7") && rpcOf("waitlist_join")[0].args.p_ref === "ABCDEFGH" && b.status === "new");
reset(); rpcReply.waitlist_take = (a) => (a.p_kind === "credit" ? "ip_day" : "ok");
r = await post({ action: "join", email: "a@example.invalid", ref: "ABCDEFGH" }); b = await r.json();
check("21b past the per-link limit the join still works, carrying no referral", rpcOf("waitlist_join")[0].args.p_ref === "" && b.status === "new" && resendSingles().length === 1);
reset(); ENV.WL_CREDIT_IP_DAY = "0"; r = await post({ action: "join", email: "a@example.invalid", ref: "ABCDEFGH" }); b = await r.json();
check("21c WL_CREDIT_IP_DAY=0 -> one meter call only, and no join carries a referral", rpcOf("waitlist_take").length === 1 && rpcOf("waitlist_join")[0].args.p_ref === "" && b.status === "new");
reset(); await post({ action: "join", email: "a@example.invalid" });
check("21d no link -> one meter call only", rpcOf("waitlist_take").length === 1 && rpcOf("waitlist_join")[0].args.p_ref === "");
reset(); ENV.WL_CREDIT_IP_DAY = "7"; await post({ action: "join", email: "a@example.invalid", ref: "ABCDEFGH" });
check("21e the per-link limit comes from WL_CREDIT_IP_DAY", rpcOf("waitlist_take")[1].args.p_hour === 7 && rpcOf("waitlist_take")[1].args.p_day === 7);
reset(); await post({ action: "join", email: "a@example.invalid", ref: "ABCDEFGH" }, { ip: "198.51.100.9" });
const tkOther = rpcOf("waitlist_take")[1].args.p_ip;
reset(); await post({ action: "join", email: "a@example.invalid", ref: "ABCDEFGH" });
const tkSame = rpcOf("waitlist_take")[1].args.p_ip;
reset(); await post({ action: "join", email: "a@example.invalid", ref: "QRSTUVWX" });
check("21f the per-link meter is keyed on the visitor AND the code", tkOther !== tkSame && rpcOf("waitlist_take")[1].args.p_ip !== tkSame);
reset(); rpcReply.waitlist_take = (a) => (a.p_kind === "join" ? "ip_hour" : "ok"); await post({ action: "join", email: "a@example.invalid", ref: "ABCDEFGH" });
check("21g a join the first meter refuses never spends the per-link meter", rpcOf("waitlist_take").length === 1 && rpcOf("waitlist_join").length === 0);

// 22: the invite name
reset(); r = await post({ action: "name", token: "short", name: "Maya" }); b = await r.json();
check("22a name with a malformed token -> {ok:false}, nothing fetched", JSON.stringify(b) === '{"ok":false}' && calls.length === 0);
reset(); r = await post({ action: "name", token: VIEW, name: "1000" }); b = await r.json();
check("22b a name that is not letters -> {ok:false, reason:bad_name}, nothing fetched", JSON.stringify(b) === '{"ok":false,"reason":"bad_name"}' && calls.length === 0);
reset(); r = await post({ action: "name", token: VIEW, name: "a".repeat(21) }); b = await r.json();
check("22b' a 21-letter name is refused before any call", b.reason === "bad_name" && calls.length === 0);
reset(); r = await post({ action: "name", token: VIEW, name: " Maya Lee " }); b = await r.json();
check("22c ' Maya Lee ' -> the RPC gets the first word, the answer is {ok:true,name}, metered as a spot call",
  rpcOf("waitlist_set_name").length === 1 && rpcOf("waitlist_set_name")[0].args.p_name === "Maya" && rpcOf("waitlist_set_name")[0].args.p_token === VIEW
  && JSON.stringify(b) === '{"ok":true,"name":"Maya"}' && rpcOf("waitlist_take")[0].args.p_kind === "spot" && rpcOf("waitlist_take")[0].args.p_hour === 120 && resendAny().length === 0);
reset(); rpcReply.waitlist_set_name = { ok: true, name: "evil.com", email: "leak@example.invalid" }; r = await post({ action: "name", token: VIEW, name: "Maya" }); b = await r.json();
check("22d a name the database returns that fails the shape check is dropped from the answer", JSON.stringify(b) === '{"ok":true}');
reset(); r = await post({ action: "name", token: VIEW, name: "" }); b = await r.json();
check("22e an empty name is sent as such (it clears the name)", rpcOf("waitlist_set_name")[0].args.p_name === "" && b.ok === true);
reset(); rpcReply.waitlist_set_name = { ok: false, reason: "none" }; r = await post({ action: "name", token: VIEW, name: "Maya" }); b = await r.json();
check("22f an unknown token -> {ok:false} (the reason is not passed on)", JSON.stringify(b) === '{"ok":false}');
reset(); rpcReply.waitlist_take = "ip_hour"; r = await post({ action: "name", token: VIEW, name: "Maya" }); b = await r.json();
check("22g over the spot meter -> {ok:false}, no name RPC", JSON.stringify(b) === '{"ok":false}' && rpcOf("waitlist_set_name").length === 0);
reset(); r = await post({ action: "name", token: VIEW, name: "María-José" }); b = await r.json();
check("22h letters of other scripts and a hyphen are fine", rpcOf("waitlist_set_name").length === 1 && b.ok === true);
reset(); r = await post({ action: "name", token: VIEW, name: "O’Brien" }); b = await r.json();
check("22i a curly apostrophe is fine (the regex is written with an escape in the source)", rpcOf("waitlist_set_name").length === 1);

// 23: what a friend's banner may learn about a share code
reset(); r = await post({ action: "ref_peek", code: "bad" }); b = await r.json();
check("23a ref_peek with a malformed code -> {}, nothing fetched", JSON.stringify(b) === "{}" && calls.length === 0);
reset(); rpcReply.waitlist_ref_name = { name: "Maya", email: "leak@example.invalid", id: 3 }; r = await post({ action: "ref_peek", code: "abcdefgh" }); b = await r.json();
check("23b a good code -> exactly {name}, the code upper-cased, extra keys dropped, metered as a spot call",
  JSON.stringify(b) === '{"name":"Maya"}' && rpcOf("waitlist_ref_name")[0].args.p_code === "ABCDEFGH" && rpcOf("waitlist_take")[0].args.p_kind === "spot" && resendAny().length === 0);
reset(); rpcReply.waitlist_ref_name = { name: "evil.com" }; r = await post({ action: "ref_peek", code: "ABCDEFGH" }); b = await r.json();
check("23c an invalid name -> {}", JSON.stringify(b) === "{}");
reset(); rpcReply.waitlist_take = "ip_hour"; r = await post({ action: "ref_peek", code: "ABCDEFGH" }); b = await r.json();
check("23d over the meter -> {}, no lookup", JSON.stringify(b) === "{}" && rpcOf("waitlist_ref_name").length === 0);
reset(); ENV.WAITLIST_MODE = "off"; r = await post({ action: "ref_peek", code: "ABCDEFGH" }); b = await r.json();
const offPeek = JSON.stringify(b), offPeekCalls = calls.length;
reset(); ENV.WAITLIST_MODE = "off"; r = await post({ action: "name", token: VIEW, name: "Maya" }); b = await r.json();
check("23e WAITLIST_MODE=off -> ref_peek {}, name {ok:false}, nothing fetched", offPeek === "{}" && offPeekCalls === 0 && JSON.stringify(b) === '{"ok":false}' && calls.length === 0);
reset(); rpcReply.waitlist_ref_name = new Response("{}", { status: 404 }); r = await post({ action: "ref_peek", code: "ABCDEFGH" }); b = await r.json();
const peek404 = JSON.stringify(b), peekStatus = r.status;
reset(); rpcReply.waitlist_set_name = new Response("{}", { status: 404 }); r = await post({ action: "name", token: VIEW, name: "Maya" }); b = await r.json();
check("23f SQL not re-run (RPC 404) -> ref_peek {}, name {ok:false}, both 200", peek404 === "{}" && peekStatus === 200 && JSON.stringify(b) === '{"ok":false}' && r.status === 200);
reset(); r = await post({ action: "ref_peek", code: "ABCDEFGH" }, { origin: "https://evil.example" });
check("23g a foreign Origin cannot peek", r.status === 403 && calls.length === 0);

// 24: the spot answer's name is shape-checked too
reset(); rpcReply.waitlist_spot = { state: "waiting", position: 7, name: "x.com" }; r = await post({ action: "spot", token: VIEW }); b = await r.json();
check("24a spot drops an invalid name", !("name" in b) && b.state === "waiting");
reset(); rpcReply.waitlist_spot = { state: "waiting", position: 7, name: "Maya" }; r = await post({ action: "spot", token: VIEW }); b = await r.json();
check("24b spot keeps a valid name", b.name === "Maya");
reset(); rpcReply.waitlist_spot = { state: "unconfirmed", position: 7, ref_code: "ABCDEFGH" }; r = await post({ action: "spot", token: VIEW }); b = await r.json();
check("24c a database not yet re-run still answers unconfirmed: passed through for the page to treat as waiting", b.state === "unconfirmed" && b.position === 7);

clearInterval(keepAlive);
console.log(results.join("\n"));
const failed = results.filter((x) => x.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
