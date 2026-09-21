// billing-checkout — turns a signed-in creator into a Stripe Checkout URL, or a Stripe customer-portal URL.
//
// WHY THIS EXISTS AT ALL. Two things must never happen in the browser: holding
// the Stripe secret key, and deciding which plan someone bought. This function
// holds the key, and it stamps the Checkout Session with the creator's own
// user id so the webhook can attribute the payment to an account rather than
// trusting a page to say who it is.
//
// DEPLOY: Supabase dashboard → Edge Functions → `billing-checkout` → Code →
//         paste this whole file → deploy. Verify JWT: OFF (as deployed since
//         2026-09-21). The project is on the new JWT signing keys and the
//         gateway's legacy check rejects real user tokens. This code does its
//         own auth — callerFromToken() asks /auth/v1/user — so nothing reaches
//         Stripe without a live session. After EVERY redeploy, confirm the
//         toggle is still off.
// SECRETS: STRIPE_SECRET_KEY. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
//          injected by the platform; never add them by hand.
//
// CALL (creator's access token as Authorization: Bearer …):
//   POST { "plan": "pro" }                      → { "url": "https://checkout.stripe.com/…" }
//   POST { "action": "checkout", "plan": "pro" } → same (no action = checkout)
//   POST { "action": "portal" }                 → { "url": "https://billing.stripe.com/…" }
//        409 { "error": "no_customer" } if the account has never had a Stripe customer
//        502 { "error": "portal_failed" } if Stripe refuses — in live mode that almost
//        always means the portal settings were never SAVED (Stripe → Settings →
//        Billing → Customer portal)
//
// NO PRICE, NO AMOUNT AND NO PLAN NUMBERS COME FROM THE CALLER. The plan code
// is a key into lynxr_billing_plans; the price id lives in that row. A caller
// that asks for a plan with no price id gets a refusal, which is exactly what
// makes "max — coming soon" unbuyable rather than merely unadvertised.

const STRIPE = "https://api.stripe.com/v1";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
// The platform injects the service-role key. `SUPABASE_SERVICE_ROLE_KEY` is the
// legacy name and is marked deprecated in the dashboard in favour of
// `SUPABASE_SECRET_KEYS`, a JSON dictionary of secret keys — so read the old
// name first and fall back to the first value of the new one. Without this, a
// project that has dropped the legacy name fails at the first database call
// with an unauthorised error that looks nothing like its cause.
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
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;

// The only places a checkout may return to. Never echo a caller-supplied URL
// back into success_url: that is an open redirect with a payment attached.
const ORIGINS = ["https://lynxr.io", "http://localhost:8811"];

/** The one site a Stripe page may send the browser back to: the caller's
    Origin if it is on the allow-list, lynxr.io otherwise. */
const siteFor = (origin: string | null) => (ORIGINS.includes(origin ?? "") ? origin! : ORIGINS[0]);

// MANAGED PAYMENTS — Stripe is the merchant of record (owner, 2026-09-20).
// Stripe then owns sales tax, VAT and GST in 80+ countries, fraud, disputes
// and billing support, for an extra 3.5% per transaction. That is what makes
// selling outside the US possible on day one, and it is why Massachusetts
// sales tax on software is not lynxr LLC's problem.
//
// It is per-SESSION, not per-account: leave this out and the same account
// quietly bills as a normal Stripe payment, with the tax liability back on
// lynxr. The env var exists so it can be turned off without a redeploy if
// Stripe ever refuses eligibility for this product.
const managedOn = () => (Deno.env.get("STRIPE_MANAGED_PAYMENTS") ?? "true") !== "false";

// Allow-Headers must cover every header a browser caller sends, or the
// preflight fails and the POST never leaves the page. It once listed only
// authorization + content-type while the app also sent `apikey`, and every live
// Upgrade click died in the browser. apikey and x-client-info are what
// supabase-js and the app send by habit; allowing them costs nothing.
const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": ORIGINS.includes(origin ?? "") ? origin! : ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });

/** PostgREST as the service role. Reads only; this function never writes. */
async function sbSelect(path: string) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) throw new Error(`select ${res.status}`);
  return await res.json();
}

/** Who is calling. Asking the auth server beats decoding the JWT here: it
    honours revocation, and there is no signing key to get wrong. */
async function callerFromToken(token: string) {
  const res = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id ? { id: u.id as string, email: (u.email ?? "") as string } : null;
}

/** THE STRIPE CUSTOMER PORTAL for the CALLER's own customer — cancel, change
    card, download receipts. The customer id comes from lynxr_billing, which
    only billing-webhook writes from Stripe's own events. Never from the
    request: a portal URL for someone else's customer hands over their billing. */
async function openPortal(creatorId: string, origin: string | null) {
  const rows = await sbSelect(
    `lynxr_billing?creator_id=eq.${creatorId}&select=provider_customer_id`,
  );
  const customer = rows?.[0]?.provider_customer_id;
  // Never bought anything: there is no Stripe customer to manage. The app only
  // shows the button when my_plan() says has_customer, so this is the guard,
  // not the path.
  if (!customer) return json({ error: "no_customer" }, 409, origin);

  const form = new URLSearchParams({
    customer,
    // Same allow-list as checkout: never a caller-supplied URL.
    return_url: `${siteFor(origin)}/?billing=portal`,
  });
  const res = await fetch(`${STRIPE}/billing_portal/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const session = await res.json();
  if (!res.ok || !session?.url) {
    // Live mode with the portal never saved is the usual cause. Code/type only:
    // Stripe's message can name the account.
    console.error("stripe portal failed", res.status, session?.error?.code ?? session?.error?.type ?? "");
    return json({ error: "portal_failed" }, 502, origin);
  }
  console.log("portal opened", creatorId.slice(0, 8));
  return json({ url: session.url }, 200, origin);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method" }, 405, origin);

  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "unauthenticated" }, 401, origin);
    const caller = await callerFromToken(token);
    if (!caller) return json({ error: "unauthenticated" }, 401, origin);

    const body = await req.json().catch(() => ({}));
    // `action` picks the job. Absent means checkout, so a caller written before
    // the portal existed keeps working unchanged; anything unknown is refused
    // before it can reach Stripe.
    const action = String(body.action ?? "checkout");
    if (action === "portal") return await openPortal(caller.id, origin);
    if (action !== "checkout") return json({ error: "unknown_action" }, 400, origin);

    const plan = String(body.plan ?? "");
    // Allow-list, not a pass-through: 'free' has no price and must never reach
    // Stripe, and an unknown string must not become a query against the table.
    if (plan !== "pro" && plan !== "max") return json({ error: "unknown_plan" }, 400, origin);

    const rows = await sbSelect(
      `lynxr_billing_plans?code=eq.${plan}&select=code,provider_price_id,label`,
    );
    const price = rows?.[0]?.provider_price_id;
    if (!price) return json({ error: "not_for_sale", plan }, 409, origin);

    // An existing subscriber keeps their Stripe customer, so a second purchase
    // does not create a second customer record with the same card.
    const billing = await sbSelect(
      `lynxr_billing?creator_id=eq.${caller.id}&select=provider_customer_id,status,plan_code`,
    );
    const existing = billing?.[0] ?? null;
    if (existing && ["active", "trialing", "past_due"].includes(existing.status) &&
        existing.plan_code === plan) {
      // Already on this plan: send them to manage it, not to buy it twice.
      return json({ error: "already_subscribed", plan }, 409, origin);
    }

    const site = siteFor(origin);
    const form = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: `${site}/?billing=done`,
      cancel_url: `${site}/?billing=cancelled`,
      // Both of these carry the account id: the session for
      // checkout.session.completed, the subscription for every later event.
      client_reference_id: caller.id,
      "metadata[creator_id]": caller.id,
      "subscription_data[metadata][creator_id]": caller.id,
      billing_address_collection: "required",
      allow_promotion_codes: "true",
    });
    if (managedOn()) form.set("managed_payments[enabled]", "true");
    if (existing?.provider_customer_id) form.set("customer", existing.provider_customer_id);
    else if (caller.email) form.set("customer_email", caller.email);

    const res = await fetch(`${STRIPE}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    const session = await res.json();
    if (!res.ok || !session?.url) {
      // Stripe's message can name the account or the price; log the code only.
      console.error("stripe checkout failed", res.status, session?.error?.code ?? "");
      return json({ error: "checkout_failed" }, 502, origin);
    }
    console.log("checkout created", plan, caller.id.slice(0, 8));
    return json({ url: session.url }, 200, origin);
  } catch (e) {
    console.error("checkout error", String(e).slice(0, 120));
    return json({ error: "server" }, 500, origin);
  }
});
