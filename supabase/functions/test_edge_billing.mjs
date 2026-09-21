// Tests for the two billing Edge Functions, run WITHOUT Deno, Supabase or
// Stripe: Node strips the TypeScript types, `Deno` and `fetch` are stubbed,
// and nothing touches the network. Payment code deserves a test that runs in
// one second and needs no account.
//
//   node --experimental-strip-types supabase/functions/test_edge_billing.mjs
//
// The signature cases are the ones that matter: this endpoint is public, and
// the HMAC is the only thing between "Stripe says they paid" and "someone
// POSTed some JSON".
import { createHmac } from "node:crypto";

const DIR = new URL(".", import.meta.url).pathname;   // this file lives beside the functions
const ENV = {
  SUPABASE_URL: "https://sb.test",
  // the new name only: proves the fallback works on a project where the
  // deprecated SUPABASE_SERVICE_ROLE_KEY is gone
  SUPABASE_SECRET_KEYS: JSON.stringify({ "sb_secret_x": "service-role-key" }),
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
};
const UID = "11111111-2222-3333-4444-555555555555";

let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };

const calls = [];
let plans = [{ code: "pro", provider_price_id: "price_123", label: "lynxr pro" }];
let billingRows = [];
let stripeOk = true;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ u, body: init.body ? String(init.body) : null });
  if (u.includes("/auth/v1/user")) {
    const tok = (init.headers?.Authorization || "").replace("Bearer ", "");
    return tok === "good-token"
      ? new Response(JSON.stringify({ id: UID, email: "c@example.com" }), { status: 200 })
      : new Response("{}", { status: 401 });
  }
  if (u.includes("lynxr_billing_plans")) {
    const code = u.match(/code=eq\.([a-z]+)/)?.[1];
    return new Response(JSON.stringify(plans.filter((p) => p.code === code)), { status: 200 });
  }
  if (u.includes("lynxr_billing?")) return new Response(JSON.stringify(billingRows), { status: 200 });
  if (u.includes("api.stripe.com")) {
    const url = u.includes("/billing_portal/sessions")
      ? "https://billing.stripe.com/p/session/test_1"
      : "https://checkout.stripe.com/c/pay/cs_test_1";
    return stripeOk
      ? new Response(JSON.stringify({ url }), { status: 200 })
      : new Response(JSON.stringify({ error: { code: "resource_missing" } }), { status: 400 });
  }
  if (u.includes("/rpc/ingest_billing_event")) {
    return new Response(JSON.stringify({ applied: true, echo: JSON.parse(init.body) }), { status: 200 });
  }
  throw new Error("unexpected fetch " + u);
};

const results = [];
const check = (name, cond, extra = "") =>
  results.push(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`);

// ---------------------------------------------------------------- checkout
await import(`${DIR}/billing-checkout/index.ts`);
const checkout = handler;
const post = (body, token = "good-token") =>
  checkout(new Request("https://fn.test/", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, origin: "https://lynxr.io", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

let r = await checkout(new Request("https://fn.test/", { method: "OPTIONS", headers: { origin: "https://lynxr.io" } }));
check("preflight 204 + CORS", r.status === 204 && r.headers.get("access-control-allow-origin") === "https://lynxr.io");
// The live Upgrade bug: the app sent `apikey`, the preflight didn't allow it,
// and the browser blocked every checkout before it left the page.
{
  const allowed = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/\s*,\s*/);
  check("preflight allows every header a browser caller sends",
    ["authorization", "apikey", "content-type", "x-client-info"].every((h) => allowed.includes(h)));
}

r = await post({ plan: "pro" }, "bad-token");
check("bad token -> 401", r.status === 401);

r = await post({ plan: "free" });
check("plan 'free' refused", r.status === 400 && (await r.json()).error === "unknown_plan");

r = await post({ plan: "max" });
check("max has no price -> not_for_sale (coming soon is unbuyable)", r.status === 409 && (await r.json()).error === "not_for_sale");

calls.length = 0;
r = await post({ plan: "pro" });
const body = await r.json();
const stripeCall = calls.find((c) => c.u.includes("api.stripe.com"));
const form = new URLSearchParams(stripeCall.body);
check("pro -> checkout url", r.status === 200 && body.url.startsWith("https://checkout.stripe.com/"));
check("price from the ledger, not the caller", form.get("line_items[0][price]") === "price_123");
check("session stamped with account id", form.get("client_reference_id") === UID && form.get("subscription_data[metadata][creator_id]") === UID);
check("subscription mode", form.get("mode") === "subscription");
check("managed payments on — stripe is merchant of record", form.get("managed_payments[enabled]") === "true");
check("returns to lynxr.io only", form.get("success_url") === "https://lynxr.io/?billing=done");

r = await checkout(new Request("https://fn.test/", {
  method: "POST",
  headers: { authorization: "Bearer good-token", origin: "https://evil.example", "content-type": "application/json" },
  body: JSON.stringify({ plan: "pro" }),
}));
const evilForm = new URLSearchParams(calls.filter((c) => c.u.includes("api.stripe.com")).pop().body);
check("hostile Origin cannot redirect the payment", evilForm.get("success_url") === "https://lynxr.io/?billing=done");

billingRows = [{ provider_customer_id: "cus_1", status: "active", plan_code: "pro" }];
r = await post({ plan: "pro" });
check("already on pro -> refused", r.status === 409 && (await r.json()).error === "already_subscribed");

billingRows = [{ provider_customer_id: "cus_1", status: "canceled", plan_code: "pro" }];
calls.length = 0;
await post({ plan: "pro" });
check("returning customer reuses its stripe customer", new URLSearchParams(calls.find((c) => c.u.includes("api.stripe.com")).body).get("customer") === "cus_1");

ENV.STRIPE_MANAGED_PAYMENTS = "false";
calls.length = 0;
billingRows = [];
await post({ plan: "pro" });
check("managed payments can be switched off by env, no redeploy",
  !new URLSearchParams(calls.find((c) => c.u.includes("api.stripe.com")).body).has("managed_payments[enabled]"));
delete ENV.STRIPE_MANAGED_PAYMENTS;

billingRows = [];
stripeOk = false;
r = await post({ plan: "pro" });
check("stripe failure -> 502, no leak", r.status === 502 && (await r.json()).error === "checkout_failed");
stripeOk = true;

// ---------------------------------------------------------------- portal
const stripeCalls = () => calls.filter((c) => c.u.includes("api.stripe.com"));
const postFrom = (originHdr, b) =>
  checkout(new Request("https://fn.test/", {
    method: "POST",
    headers: { authorization: "Bearer good-token", origin: originHdr, "content-type": "application/json" },
    body: JSON.stringify(b),
  }));

calls.length = 0;
r = await post({ action: "portal" }, "bad-token");
check("portal: bad token -> 401, stripe never called", r.status === 401 && stripeCalls().length === 0);

billingRows = [];
calls.length = 0;
r = await post({ action: "portal" });
check("portal: never bought -> 409 no_customer, stripe never called",
  r.status === 409 && (await r.json()).error === "no_customer" && stripeCalls().length === 0);

billingRows = [{ provider_customer_id: null, status: "none", plan_code: null }];
r = await post({ action: "portal" });
check("portal: row with no customer id -> no_customer", r.status === 409 && (await r.json()).error === "no_customer");

billingRows = [{ provider_customer_id: "cus_1", status: "active", plan_code: "pro" }];
calls.length = 0;
r = await post({ action: "portal", customer: "cus_evil", return_url: "https://evil.example/" });
const portalBody = await r.json();
const portalCall = stripeCalls()[0];
const portalForm = new URLSearchParams(portalCall?.body ?? "");
check("portal: active pro subscriber gets a portal url, not already_subscribed",
  r.status === 200 && String(portalBody.url).startsWith("https://billing.stripe.com/"));
check("portal: calls /v1/billing_portal/sessions", !!portalCall && portalCall.u.endsWith("/v1/billing_portal/sessions"));
check("portal: customer from the ledger, never the caller", portalForm.get("customer") === "cus_1");
check("portal: returns to lynxr.io/?billing=portal, never a caller url",
  portalForm.get("return_url") === "https://lynxr.io/?billing=portal");
check("portal: form carries only customer + return_url",
  [...portalForm.keys()].sort().join(",") === "customer,return_url");
check("portal: reads only the caller's own billing row",
  calls.some((c) => c.u.includes("lynxr_billing?") && c.u.includes(`creator_id=eq.${UID}`)));

calls.length = 0;
await postFrom("https://evil.example", { action: "portal" });
check("portal: hostile Origin cannot redirect the return",
  new URLSearchParams(stripeCalls()[0].body).get("return_url") === "https://lynxr.io/?billing=portal");

calls.length = 0;
await postFrom("http://localhost:8811", { action: "portal" });
check("portal: the localhost preview returns to itself",
  new URLSearchParams(stripeCalls()[0].body).get("return_url") === "http://localhost:8811/?billing=portal");

billingRows = [{ provider_customer_id: "cus_1", status: "canceled", plan_code: "pro" }];
r = await post({ action: "portal" });
check("portal: a cancelled customer can still open it (receipts)", r.status === 200);

stripeOk = false;
r = await post({ action: "portal" });
check("portal: stripe failure -> 502 portal_failed, no leak",
  r.status === 502 && (await r.json()).error === "portal_failed");
stripeOk = true;

billingRows = [];
calls.length = 0;
r = await post({ action: "checkout", plan: "pro" });
check("explicit action 'checkout' still opens checkout",
  r.status === 200 && (await r.json()).url.startsWith("https://checkout.stripe.com/") &&
  stripeCalls()[0].u.endsWith("/v1/checkout/sessions"));

calls.length = 0;
r = await post({ action: "refund", plan: "pro" });
check("unknown action refused, stripe never called",
  r.status === 400 && (await r.json()).error === "unknown_action" && stripeCalls().length === 0);

// ---------------------------------------------------------------- webhook
handler = null;
await import(`${DIR}/billing-webhook/index.ts`);
const hook = handler;
const sign = (raw, t, secret = ENV.STRIPE_WEBHOOK_SECRET) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
const send = (evt, opts = {}) => {
  const raw = JSON.stringify(evt);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const sig = opts.sig ?? sign(raw, t, opts.secret);
  return hook(new Request("https://fn.test/", { method: "POST", headers: { "stripe-signature": sig }, body: raw }));
};
const subEvent = (over = {}) => ({
  id: "evt_" + Math.random().toString(16).slice(2),
  type: "customer.subscription.updated",
  created: Math.floor(Date.now() / 1000),
  data: { object: {
    id: "sub_1", customer: "cus_1", status: "active",
    metadata: { creator_id: UID },
    items: { data: [{ price: { id: "price_123" } }] },
    current_period_end: 1790000000, cancel_at: null, cancel_at_period_end: false,
    ...over } },
});

r = await send(subEvent());
let sent = (await r.json()).echo;
check("valid signature accepted", r.status === 200);
check("status + price + account passed to the ledger",
  sent.p_status === "active" && sent.p_price_id === "price_123" && sent.p_creator === UID);
check("period end converted to a timestamp", sent.p_period_end === new Date(1790000000 * 1000).toISOString());

r = await send(subEvent(), { sig: "t=1,v1=deadbeef" });
check("forged signature rejected (400)", r.status === 400);

r = await send(subEvent(), { secret: "whsec_wrong" });
check("wrong secret rejected", r.status === 400);

r = await send(subEvent(), { t: Math.floor(Date.now() / 1000) - 3600 });
check("hour-old replay rejected", r.status === 400);

r = await send(subEvent({ current_period_end: undefined,
  items: { data: [{ price: { id: "price_123" }, current_period_end: 1790000000 }] } }));
check("renewal date read from the item (Stripe API 2025+ shape)",
  (await r.json()).echo.p_period_end === new Date(1790000000 * 1000).toISOString());

r = await send({ ...subEvent(), type: "customer.subscription.deleted" });
check("deleted -> canceled", (await r.json()).echo.p_status === "canceled");

r = await send(subEvent({ status: "incomplete_expired" }));
check("never-paid checkout reads as canceled", (await r.json()).echo.p_status === "canceled");

r = await send(subEvent({ cancel_at_period_end: true }));
sent = (await r.json()).echo;
check("cancel at period end keeps access until then",
  sent.p_status === "active" && sent.p_cancel_at === new Date(1790000000 * 1000).toISOString());

r = await send({
  id: "evt_sess", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000),
  data: { object: { client_reference_id: UID, customer: "cus_9", subscription: "sub_9" } },
});
sent = (await r.json()).echo;
check("checkout.session binds account to customer, applies no status",
  sent.p_status === null && sent.p_customer === "cus_9" && sent.p_creator === UID);

r = await send({
  id: "evt_ref", type: "charge.refunded", created: Math.floor(Date.now() / 1000),
  data: { object: { customer: "cus_1", metadata: {} } },
});
check("refund recorded, entitlement untouched", (await r.json()).echo.p_status === null);

const all = JSON.stringify(calls.filter((c) => c.u.includes("ingest_billing_event")).map((c) => c.body));
check("no customer email/name/address forwarded to the database", !/email|@example|address|name/i.test(all));

console.log(results.join("\n"));
console.log(`\n${results.filter((x) => x.startsWith("ok")).length}/${results.length} passed`);
process.exit(results.some((x) => x.startsWith("FAIL")) ? 1 : 0);
