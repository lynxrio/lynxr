// billing-webhook — the only thing that grants or removes a paid entitlement.
//
// WHY THE SIGNATURE CHECK IS THE WHOLE POINT. This endpoint is public: Stripe
// has to be able to reach it, so anyone can. The only thing separating "Stripe
// says this person paid" from "someone POSTed some JSON" is the HMAC below.
// Treat it as the lock on the paid features, because it is.
//
// DEPLOY: Supabase dashboard → Edge Functions → new function `billing-webhook`
//         → paste → deploy → **turn Verify JWT OFF** for this one. Stripe does
//         not send a Supabase token, so with JWT verification on, every
//         delivery is rejected before this code runs and subscriptions never
//         activate. This is the single most common way this setup fails.
// SECRETS: STRIPE_WEBHOOK_SECRET (Stripe → Developers → Webhooks → your
//          endpoint → signing secret, `whsec_…`). SUPABASE_URL and
//          SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
// EVENTS to select on the Stripe endpoint:
//   checkout.session.completed
//   customer.subscription.created | .updated | .deleted
//   invoice.payment_failed
//   charge.refunded
// 48-HOUR REFUND (owner, 2026-10-08): a cancel within 48 hours of a paid
// invoice refunds it and ends the subscription — see refund48() below.
// Needs STRIPE_SECRET_KEY (shared with billing-checkout) with Invoices read,
// Refunds write, Subscriptions write, and REFUND48_ENABLED=true. Off by default.
//
// WHAT IT DOES NOT DO. It does not decide entitlement, compute an allowance,
// or write lynxr_billing directly. It verifies, translates Stripe's vocabulary
// into ours, and hands the result to ingest_billing_event(), which records and
// applies in ONE transaction so a retry after a half-failure reprocesses
// instead of being swallowed as a duplicate.

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
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

// Stripe retries for days, so a replayed old delivery is normal; a replay of a
// very old one is not. Five minutes is Stripe's own recommended tolerance.
const TOLERANCE_S = 300;

// ---------------------------------------------------------------- 48-hour refund
// Owner decisions D1–D3 (plan lynxr-48h-refunds-no-unlimited.md). The terms'
// #refunds section says the same thing in words: change both together.
const FIRST_PAYMENT_ONLY = false;   // D1: true = only an invoice that started a subscription
const MAX_SCRIPTS_SINCE = 10;       // D2: refund only if FEWER than this many scripts since the payment; 0 = no condition
const END_ACCESS = true;            // D3: a refund ends the subscription at once
const REFUND_WINDOW_S = 48 * 3600;
const STRIPE = "https://api.stripe.com/v1";
// Read at call time, so the owner can switch it without a redeploy (and the
// tests can flip it). Off unless set: deploying this code changes nothing.
const refundOn = () => (Deno.env.get("REFUND48_ENABLED") ?? "false") === "true";
// Payments before this instant keep the old 14-day guarantee, handled by hand.
// Midnight Boston time on 22 Oct 2026. REFUND48_FROM overrides it for a live test.
const refundFrom = () => Date.parse(Deno.env.get("REFUND48_FROM") ?? "2026-10-22T04:00:00Z") / 1000;

/** Constant-time compare: a fast `===` on a signature leaks, by timing, how
    much of a forged prefix was right. */
function sameSig(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Verify Stripe-Signature over the RAW body. Parsing the JSON first and
    re-serialising it would change bytes and fail every time. */
async function verify(raw: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.trim().split("=", 2) as [string, string]),
  );
  const t = Number(parts.t);
  if (!t || Math.abs(Math.floor(Date.now() / 1000) - t) > TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)));
  // The header may carry several v1 signatures during a secret rotation.
  return header.split(",").some((p) => {
    const [k, v] = p.trim().split("=", 2);
    return k === "v1" && sameSig(mac, v ?? "");
  });
}

const iso = (unix: unknown) =>
  typeof unix === "number" && unix > 0 ? new Date(unix * 1000).toISOString() : null;

/** Stripe's subscription statuses → the ledger's vocabulary.
    `incomplete_expired` means a checkout that was never paid for: it must read
    as gone, not as a live subscription. */
function mapStatus(s: string | undefined): string | null {
  switch (s) {
    case "active":
    case "trialing":
    case "past_due":
    case "paused":
    case "canceled":
    case "incomplete":
    case "unpaid":
      return s;
    case "incomplete_expired":
      return "canceled";
    default:
      return null;
  }
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE,
      Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn} ${res.status} ${text.slice(0, 120)}`);
  return text ? JSON.parse(text) : null;
}

/** Stripe, with the restricted key billing-checkout also uses. Never throws on
    an HTTP error: the caller reads ok/status/body. */
async function stripe(method: string, path: string, form?: URLSearchParams, idem?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY") ?? ""}` };
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(`${STRIPE}${path}`, { method, headers, body: form });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** PostgREST read as the service role. */
async function sbGet(path: string) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) throw new Error(`select ${res.status}`);
  return await res.json();
}

/** THE 48-HOUR REFUND. A subscription cancelled within 48 hours of its latest
    paid invoice gets that invoice refunded in full (and, with END_ACCESS, ends
    now). Runs AFTER the ledger has applied the event. Never throws: a refund
    problem is recorded as refund48.failed for a person to finish, and must
    not make Stripe re-deliver an event the ledger already applied. Every step
    is safe to repeat: the refund carries an idempotency key, and an
    already-refunded charge counts as done. */
async function refund48(type: string, o: any, creator: string | null, customer: string | null): Promise<string> {
  if (!refundOn()) return "off";
  if (!type.startsWith("customer.subscription.")) return "n/a";
  const cancelling = type.endsWith(".deleted") || o.cancel_at_period_end === true || o.cancel_at != null;
  const canceledAt = typeof o.canceled_at === "number" ? o.canceled_at : null;
  const invoiceId = typeof o.latest_invoice === "string" ? o.latest_invoice : null;
  const subId = typeof o.id === "string" ? o.id : null;
  if (!cancelling || !canceledAt || !invoiceId) return "n/a";
  if (!Deno.env.get("STRIPE_SECRET_KEY")) return "no_key";
  try {
    const inv = await stripe("GET", `/invoices/${invoiceId}?expand%5B%5D=payments`);
    if (!inv.ok) throw new Error(`invoice ${inv.status} ${inv.body?.error?.code ?? ""}`);
    const i = inv.body;
    const paidAt = i?.status_transitions?.paid_at;
    if (i?.status !== "paid" || !(i?.amount_paid > 0) || typeof paidAt !== "number") return "not_paid";
    if (paidAt < refundFrom()) return "before_policy";
    if (canceledAt < paidAt || canceledAt - paidAt > REFUND_WINDOW_S) return "outside_window";
    if (FIRST_PAYMENT_ONLY && i.billing_reason !== "subscription_create") return "renewal";
    const pay = (i.payments?.data ?? []).find((p: any) => p?.status === "paid" && p?.payment?.type === "payment_intent");
    const pi = typeof pay?.payment?.payment_intent === "string" ? pay.payment.payment_intent : pay?.payment?.payment_intent?.id;
    if (!pi) return "no_payment_intent";
    let who = creator;
    if (!who && customer) {
      const rows = await sbGet(`lynxr_billing?provider_customer_id=eq.${encodeURIComponent(customer)}&select=creator_id`);
      who = rows?.[0]?.creator_id ?? null;
    }
    if (MAX_SCRIPTS_SINCE > 0) {
      if (!who) return "no_creator";
      const since = encodeURIComponent(new Date(paidAt * 1000).toISOString());
      const rows = await sbGet(`lynxr_script_charges?creator_id=eq.${who}&charged_at=gte.${since}&select=adaptation_id&limit=${MAX_SCRIPTS_SINCE}`);
      if ((rows?.length ?? 0) >= MAX_SCRIPTS_SINCE) return "over_cap";
    }
    const form = new URLSearchParams({
      payment_intent: pi,
      reason: "requested_by_customer",
      "metadata[policy]": "refund48",
      "metadata[invoice]": invoiceId,
    });
    if (who) form.set("metadata[creator_id]", who);
    const ref = await stripe("POST", "/refunds", form, `refund48-${invoiceId}`);
    const already = ref.body?.error?.code === "charge_already_refunded";
    if (!ref.ok && !already) throw new Error(`refund ${ref.status} ${ref.body?.error?.code ?? ""}`);
    if (END_ACCESS && subId && !type.endsWith(".deleted")) {
      const del = await stripe("DELETE", `/subscriptions/${subId}`);
      if (!del.ok) console.warn("refund48: subscription not ended", del.status, del.body?.error?.code ?? "");
    }
    await rpc("ingest_billing_event", {
      p_event_id: `refund48:${invoiceId}`, p_event_type: "refund48.issued",
      p_occurred_at: new Date().toISOString(), p_creator: who, p_customer: customer,
      p_subscription: subId, p_status: null, p_price_id: null, p_period_end: null,
      p_cancel_at: null, p_summary: { invoice: invoiceId, payment_intent: pi, already },
    });
    return already ? "already_refunded" : "refunded";
  } catch (e) {
    console.error("refund48 failed", String(e).slice(0, 160));
    try {
      await rpc("ingest_billing_event", {
        p_event_id: `refund48-failed:${invoiceId}:${Date.now()}`, p_event_type: "refund48.failed",
        p_occurred_at: new Date().toISOString(), p_creator: creator, p_customer: customer,
        p_subscription: subId, p_status: null, p_price_id: null, p_period_end: null,
        p_cancel_at: null, p_summary: { invoice: invoiceId, error: String(e).slice(0, 120) },
      });
    } catch { /* the log line above is the record */ }
    return "failed";
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const raw = await req.text();
  if (!(await verify(raw, req.headers.get("stripe-signature")))) {
    // 400, not 401: Stripe treats 4xx as "do not retry, this is broken", which
    // is the truth for a bad signature.
    console.warn("signature rejected");
    return new Response(JSON.stringify({ error: "signature rejected" }), { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }

  const type = String(event?.type ?? "");
  const o = event?.data?.object ?? {};

  // Everything below is derived from the event only — never from a request
  // parameter — and only ids and states are kept. The raw payload carries the
  // customer's name, email and address; none of that belongs in our database.
  let creator: string | null = null;
  let customer: string | null = null;
  let subscription: string | null = null;
  let status: string | null = null;
  let priceId: string | null = null;
  let periodEnd: string | null = null;
  let cancelAt: string | null = null;

  if (type === "checkout.session.completed") {
    // Carries the account id and the new customer; the authoritative status
    // arrives on the subscription events, so none is applied here. This event
    // exists to bind account → Stripe customer.
    creator = o.client_reference_id ?? o.metadata?.creator_id ?? null;
    customer = typeof o.customer === "string" ? o.customer : null;
    subscription = typeof o.subscription === "string" ? o.subscription : null;
  } else if (type.startsWith("customer.subscription.")) {
    creator = o.metadata?.creator_id ?? null;
    customer = typeof o.customer === "string" ? o.customer : null;
    subscription = typeof o.id === "string" ? o.id : null;
    status = type.endsWith(".deleted") ? "canceled" : mapStatus(o.status);
    priceId = o.items?.data?.[0]?.price?.id ?? null;
    // Stripe API 2025-03-31.basil moved current_period_end from the subscription
    // onto its items; the account default here is 2025-04-30.basil, so the old
    // field arrives empty. Read both: first live subscription on 2026-09-21
    // recorded no renewal date because of exactly this.
    const itemEnd = o.items?.data?.[0]?.current_period_end;
    periodEnd = iso(o.current_period_end ?? itemEnd);
    // cancel_at_period_end is the common case: still entitled until the end of
    // the period they already paid for.
    cancelAt = iso(o.cancel_at) ?? (o.cancel_at_period_end ? iso(o.current_period_end ?? itemEnd) : null);
  } else if (type === "invoice.payment_failed" || type === "charge.refunded") {
    // Recorded, not applied. Stripe moves the subscription to past_due or
    // cancels it on its own schedule, and those events carry the truth. A
    // refund on its own does not end a subscription — cancelling does; the
    // 48-hour refund ends it explicitly in refund48().
    creator = o.metadata?.creator_id ?? null;
    customer = typeof o.customer === "string" ? o.customer : null;
    subscription = typeof o.subscription === "string" ? o.subscription : null;
  }

  try {
    const out = await rpc("ingest_billing_event", {
      p_event_id: String(event.id),
      p_event_type: type,
      p_occurred_at: iso(event.created),
      p_creator: creator,
      p_customer: customer,
      p_subscription: subscription,
      p_status: status,
      p_price_id: priceId,
      p_period_end: periodEnd,
      p_cancel_at: cancelAt,
      p_summary: { type, status, price_id: priceId, subscription, customer },
    });
    // After the ledger: a cancel inside the 48-hour window refunds. Never throws.
    const r48 = await refund48(type, o, creator, customer);
    // Ids only, 8 characters of the account id: these logs are readable by
    // anyone with dashboard access.
    console.log("event", type, String(event.id).slice(0, 18),
                creator ? creator.slice(0, 8) : "-",
                JSON.stringify(out).slice(0, 80), "r48=" + r48);
    return new Response(JSON.stringify(out ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    // 500 on purpose: the signature was good and we failed to record it, so we
    // WANT Stripe's retry. Returning 200 here loses the event for good.
    console.error("ingest failed", type, String(e).slice(0, 160));
    return new Response(JSON.stringify({ error: "ingest failed" }), { status: 500 });
  }
});
