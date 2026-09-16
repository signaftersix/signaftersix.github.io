import { createClient } from "npm:@supabase/supabase-js@2";
import { fromZonedTime } from "npm:date-fns-tz@3.2.0";

const SITE_ORIGIN = Deno.env.get("PUBLIC_SITE_ORIGIN") || "https://signaftersix.github.io";
const MANAGEABLE = new Set(["pending", "revised_quote", "awaiting_payment", "confirmed", "cancel_requested", "reschedule_requested"]);

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin === SITE_ORIGIN ? SITE_ORIGIN : SITE_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function json(body: unknown, status = 200, origin: string | null = SITE_ORIGIN) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
}
async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
  if (origin !== SITE_ORIGIN) return json({ error: "Origin not allowed." }, 403, origin);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!supabaseUrl || !serviceKey) throw new Error("Server configuration is incomplete.");
    const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const body = await req.json();
    const requestId = String(body.requestId || "").trim();
    const token = String(body.token || "").trim();
    const action = String(body.action || "preview").trim();
    if (!/^[0-9a-f-]{36}$/i.test(requestId) || token.length < 40) return json({ error: "This management link is invalid." }, 401, origin);

    const tokenHash = await hash(token);
    const { data: rows, error } = await service.from("appointment_requests").select("*").eq("id", requestId).eq("management_token_hash", tokenHash).limit(1);
    if (error) throw error;
    const record = rows?.[0];
    if (!record) return json({ error: "This management link is invalid or has expired." }, 401, origin);

    const publicRecord = {
      requestId: record.id,
      status: record.status,
      appointmentAt: record.appointment_at,
      requestedAppointmentAt: record.requested_appointment_at,
      customerName: record.customer_name,
      serviceCity: String(record.service_address || "").split(",").slice(-2).join(",").trim(),
      quoteTotal: Number(record.quote_total || 0),
      paymentStatus: record.payment_status,
      refundStatus: record.refund_status,
      rescheduleCount: Number(record.reschedule_count || 0),
    };
    if (action === "preview") return json({ ok: true, request: publicRecord }, 200, origin);
    if (!MANAGEABLE.has(record.status)) return json({ error: "This request can no longer be changed online." }, 409, origin);

    if (action === "request_cancel") {
      if (record.status === "cancel_requested") return json({ ok: true, request: publicRecord, message: "Your cancellation request is already pending review." });
      const reason = String(body.reason || "").trim().slice(0, 1000);
      const { error: updateError } = await service.from("appointment_requests").update({
        lifecycle_previous_status: record.status,
        status: "cancel_requested",
        cancellation_requested_at: new Date().toISOString(),
        cancellation_reason: reason || null,
      }).eq("id", record.id).eq("status", record.status);
      if (updateError) throw updateError;
      await audit(service, record.id, "customer_cancellation_requested", { prior_status: record.status, reason });
      await notify(supabaseUrl, serviceKey, record.id, "cancellation_requested");
      return json({ ok: true, message: "Your cancellation request was sent for review. The appointment remains scheduled until you receive confirmation." });
    }

    if (action === "request_reschedule") {
      const date = String(body.date || "");
      const time = String(body.time || "");
      const reason = String(body.reason || "").trim().slice(0, 1000);
      const requestedAt = fromZonedTime(`${date} ${time}:00`, "America/New_York");
      if (Number.isNaN(requestedAt.getTime()) || requestedAt.getTime() <= Date.now()) return json({ error: "Choose a future date and time." }, 400, origin);

      const ignored = [record.pending_calendar_event_id, record.confirmed_calendar_event_id].filter(Boolean);
      const availabilityResponse = await fetch(`${supabaseUrl}/functions/v1/check-availability`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          appointmentAt: requestedAt.toISOString(),
          durationMinutes: Number(record.duration_minutes || 30),
          travelSeconds: Number(record.one_way_travel_seconds || 0),
          ignoreEventIds: ignored,
          ignoreRequestId: record.id,
        }),
      });
      const availability = await availabilityResponse.json();
      if (!availabilityResponse.ok || availability?.ok !== true) return json({ error: "We couldn't verify that time. Please try again." }, 503, origin);
      if (!availability.available) return json({ error: "That requested time is unavailable. Please choose another." }, 409, origin);

      const previousStatus = record.status === "reschedule_requested" ? record.lifecycle_previous_status : record.status;
      const { error: updateError } = await service.from("appointment_requests").update({
        lifecycle_previous_status: previousStatus,
        status: "reschedule_requested",
        reschedule_requested_at: new Date().toISOString(),
        requested_appointment_at: requestedAt.toISOString(),
        requested_backup_time: String(body.backupTime || "").trim().slice(0, 120) || null,
        reschedule_reason: reason || null,
        previous_appointment_at: record.previous_appointment_at || record.appointment_at,
      }).eq("id", record.id);
      if (updateError) throw updateError;
      await audit(service, record.id, "customer_reschedule_requested", { requested_appointment_at: requestedAt.toISOString(), reason });
      await notify(supabaseUrl, serviceKey, record.id, "reschedule_requested");
      return json({ ok: true, message: "Your requested time is available and was sent for review. Your current appointment remains in place until the change is approved." });
    }

    return json({ error: "Unsupported action." }, 400, origin);
  } catch (error) {
    console.error("manage-request error", error);
    return json({ error: error instanceof Error ? error.message : "Request management failed." }, 400, origin);
  }
});

async function audit(service: any, requestId: string, action: string, details: unknown) {
  const { error } = await service.from("audit_log").insert({ request_id: requestId, action, details });
  if (error) console.error("audit failed", error);
}
async function notify(url: string, key: string, requestId: string, event: string) {
  try {
    await fetch(`${url}/functions/v1/notify-status`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId, event }) });
  } catch (error) {
    console.warn("notification failed", error);
  }
}
