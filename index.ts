import { createClient } from "npm:@supabase/supabase-js@2";
const SITE = Deno.env.get("PUBLIC_SITE_ORIGIN") || "https://signaftersix.github.io";
const cors = { "Access-Control-Allow-Origin": SITE, "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
async function sha256(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join(""); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    if (req.headers.get("origin") !== SITE) return json({ error: "Origin not allowed." }, 403);
    const url = Deno.env.get("SUPABASE_URL")!, key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const squareToken = Deno.env.get("SQUARE_ACCESS_TOKEN")!, locationId = Deno.env.get("SQUARE_LOCATION_ID")!;
    const environment = Deno.env.get("SQUARE_ENVIRONMENT") || "sandbox";
    if (!url || !key || !squareToken || !locationId) throw new Error("Server payment configuration is incomplete.");
    const body = await req.json(), requestId = String(body.requestId || ""), token = String(body.acceptanceToken || ""), action = String(body.action || "preview");
    const service = createClient(url, key, { auth: { persistSession: false } });
    const tokenHash = await sha256(token);
    const { data: rows, error } = await service.from("appointment_requests").select("*").eq("id", requestId).eq("acceptance_token_hash", tokenHash).limit(1);
    if (error) throw error;
    const record = rows?.[0];
    if (!record || record.status !== "revised_quote") return json({ error: "This revised-quote link is invalid or no longer active." }, 401);
    if (!record.revised_quote_expires_at || new Date(record.revised_quote_expires_at) <= new Date()) return json({ error: "This revised quote has expired." }, 410);
    const { data: revisions, error: revisionError } = await service.from("quote_revisions").select("*").eq("request_id", requestId).eq("version", record.quote_version).limit(1);
    if (revisionError) throw revisionError;
    const revision = revisions?.[0];
    if (!revision) throw new Error("Revised quote record is missing.");
    if (action === "preview") return json({ previousTotal: Number(revision.previous_total), revisedTotal: Number(revision.revised_total), expiresAt: revision.expires_at });
    if (action === "decline") {
      const { error: declineError } = await service.from("appointment_requests").update({ status: "declined", acceptance_token_hash: null }).eq("id", requestId).eq("status", "revised_quote");
      if (declineError) throw declineError;
      await service.from("audit_log").insert({ request_id: requestId, action: "revised_quote_declined_by_customer" });
      await invoke(url, key, "calendar-sync", { requestId, event: "release" });
      return json({ ok: true });
    }
    if (action !== "accept") return json({ error: "Unsupported action." }, 400);
    const squareBase = environment === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
    const squareResponse = await fetch(`${squareBase}/v2/online-checkout/payment-links`, { method: "POST", headers: { Authorization: `Bearer ${squareToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: `sas-revised-${requestId}-${record.quote_version}`, quick_pay: { name: "Sign After Six Mobile Notary", price_money: { amount: Math.round(Number(record.quote_total) * 100), currency: "USD" }, location_id: locationId }, description: `Sign After Six appointment ${requestId}`, checkout_options: { ask_for_shipping_address: false, merchant_support_email: "signaftersix@gmail.com", redirect_url: `${SITE}/quote-review.html?request=${encodeURIComponent(requestId)}&payment=return`, allow_tipping: false }, pre_populated_data: { buyer_email: record.customer_email } }) });
    const square = await squareResponse.json();
    if (!squareResponse.ok || !square?.payment_link?.url) throw new Error(square?.errors?.[0]?.detail || "Square could not create the payment link.");
    const hoursAway = (new Date(record.appointment_at).getTime() - Date.now()) / 3600000;
    const due = new Date(Date.now() + (hoursAway > 24 ? 4 * 3600000 : 3600000)).toISOString();
    const { error: updateError } = await service.from("appointment_requests").update({ status: "awaiting_payment", acceptance_token_hash: null, square_payment_link_id: square.payment_link.id, square_payment_link_url: square.payment_link.url, square_order_id: square.payment_link.order_id || null, payment_status: "unpaid", payment_due_at: due }).eq("id", requestId).eq("status", "revised_quote");
    if (updateError) throw updateError;
    await service.from("quote_revisions").update({ accepted_at: new Date().toISOString() }).eq("id", revision.id);
    await service.from("audit_log").insert({ request_id: requestId, action: "revised_quote_accepted_by_customer", details: { quote_total: Number(record.quote_total), payment_due_at: due } });
    await invoke(url, key, "notify-status", { requestId, event: "payment_requested" });
    return json({ ok: true, paymentUrl: square.payment_link.url, paymentDueAt: due });
  } catch (error) {
    console.error("accept-revised-quote error", error);
    return json({ error: error instanceof Error ? error.message : "Unable to process the revised quote." }, 400);
  }
});
async function invoke(url: string, key: string, name: string, body: unknown) { try { await fetch(`${url}/functions/v1/${name}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); } catch (error) { console.warn(`${name} failed`, error); } }
