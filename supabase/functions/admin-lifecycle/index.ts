import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = Deno.env.get("PUBLIC_SITE_ORIGIN") || "https://signaftersix.github.io";
const cors = { "Access-Control-Allow-Origin": SITE, "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth = req.headers.get("authorization") || "";
    const client = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data: { user } } = await client.auth.getUser();
    if (!user) return json({ error: "Unauthorized." }, 401);
    const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== "aal2") return json({ error: "Second-factor verification required." }, 403);
    const { data: isAdmin } = await client.rpc("is_admin");
    if (!isAdmin) return json({ error: "Admin access required." }, 403);
    const service = createClient(url, serviceKey, { auth: { persistSession: false } });
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "block_availability") {
      const startsAt = new Date(body.startsAt);
      const endsAt = new Date(body.endsAt);
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return json({ error: "Enter a valid start and end time." }, 400);
      const { data, error } = await service.from("availability_blocks").insert({ starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), reason: String(body.reason || "Unavailable").slice(0, 500), source: "manual" }).select("id").limit(1);
      if (error) throw error;
      await audit(service, user.id, null, "availability_block_created", { block_id: data?.[0]?.id, starts_at: startsAt, ends_at: endsAt });
      return json({ ok: true, message: "Availability block created." });
    }

    const requestId = String(body.requestId || "");
    const { data: rows, error } = await service.from("appointment_requests").select("*").eq("id", requestId).limit(1);
    if (error) throw error;
    const record = rows?.[0];
    if (!record) return json({ error: "Request not found." }, 404);

    if (action === "approve_cancellation") {
      if (record.status !== "cancel_requested") return json({ error: "This request is not awaiting cancellation review." }, 409);
      const paid = record.payment_status === "paid" || Boolean(record.square_payment_id);
      const refundStatus = paid ? "manual_required" : "not_applicable";
      const { error: updateError } = await service.from("appointment_requests").update({ status: "cancelled", cancelled_at: new Date().toISOString(), refund_status: refundStatus, refund_amount: paid ? Number(record.quote_total || 0) : null, refund_note: paid ? "Review cancellation policy and complete manually in Square." : null }).eq("id", requestId).eq("status", "cancel_requested");
      if (updateError) throw updateError;
      await call(url, serviceKey, "calendar-sync", { requestId, event: "release" }, true);
      await audit(service, user.id, requestId, "cancellation_approved", { refund_status: refundStatus });
      await call(url, serviceKey, "notify-status", { requestId, event: "cancellation_approved" });
      return json({ ok: true, message: paid ? "Cancelled. Manual Square refund review is required." : "Cancellation approved and calendar time released." });
    }

    if (action === "deny_cancellation") {
      if (record.status !== "cancel_requested") return json({ error: "This request is not awaiting cancellation review." }, 409);
      const restored = String(record.lifecycle_previous_status || "confirmed");
      const { error: updateError } = await service.from("appointment_requests").update({ status: restored, cancellation_requested_at: null, cancellation_reason: null, lifecycle_previous_status: null }).eq("id", requestId).eq("status", "cancel_requested");
      if (updateError) throw updateError;
      await audit(service, user.id, requestId, "cancellation_denied", { restored_status: restored, comment: String(body.comment || "") });
      await call(url, serviceKey, "notify-status", { requestId, event: "cancellation_denied" });
      return json({ ok: true, message: "Cancellation request denied; the prior appointment state was restored." });
    }

    if (action === "approve_reschedule") {
      if (record.status !== "reschedule_requested" || !record.requested_appointment_at) return json({ error: "This request is not awaiting reschedule review." }, 409);
      const check = await call(url, serviceKey, "check-availability", { appointmentAt: record.requested_appointment_at, durationMinutes: Number(record.duration_minutes || 30), travelSeconds: Number(record.one_way_travel_seconds || 0), ignoreEventIds: [record.pending_calendar_event_id, record.confirmed_calendar_event_id].filter(Boolean), ignoreRequestId: record.id }, true);
      if (!check?.available) return json({ error: "The requested time is no longer available." }, 409);
      const restored = String(record.lifecycle_previous_status || "confirmed");
      const { error: updateError } = await service.from("appointment_requests").update({ appointment_at: record.requested_appointment_at, backup_time: record.requested_backup_time, status: restored, requested_appointment_at: null, requested_backup_time: null, reschedule_requested_at: null, reschedule_reason: null, lifecycle_previous_status: null, reschedule_count: Number(record.reschedule_count || 0) + 1 }).eq("id", requestId).eq("status", "reschedule_requested");
      if (updateError?.code === "23P01") return json({ error: "The requested time was just taken. Choose another." }, 409);
      if (updateError) throw updateError;
      await call(url, serviceKey, "calendar-sync", { requestId, event: restored === "confirmed" ? "confirmed" : "pending_hold" }, true);
      await audit(service, user.id, requestId, "reschedule_approved", { previous_appointment_at: record.appointment_at, appointment_at: record.requested_appointment_at });
      await call(url, serviceKey, "notify-status", { requestId, event: "reschedule_approved" });
      return json({ ok: true, message: "Reschedule approved and Calendar updated." });
    }

    if (action === "deny_reschedule") {
      if (record.status !== "reschedule_requested") return json({ error: "This request is not awaiting reschedule review." }, 409);
      const restored = String(record.lifecycle_previous_status || "confirmed");
      const { error: updateError } = await service.from("appointment_requests").update({ status: restored, requested_appointment_at: null, requested_backup_time: null, reschedule_requested_at: null, reschedule_reason: null, lifecycle_previous_status: null }).eq("id", requestId).eq("status", "reschedule_requested");
      if (updateError) throw updateError;
      await audit(service, user.id, requestId, "reschedule_denied", { restored_status: restored, comment: String(body.comment || "") });
      await call(url, serviceKey, "notify-status", { requestId, event: "reschedule_denied" });
      return json({ ok: true, message: "Reschedule request denied; the original appointment remains scheduled." });
    }

    return json({ error: "Unsupported action." }, 400);
  } catch (error) {
    console.error("admin-lifecycle error", error);
    return json({ error: error instanceof Error ? error.message : "Admin operation failed." }, 400);
  }
});

async function call(url: string, key: string, name: string, body: unknown, required = false) {
  try {
    const response = await fetch(`${url}/functions/v1/${name}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok && required) throw new Error(result?.error || `${name} failed.`);
    return result;
  } catch (error) {
    if (required) throw error;
    console.warn(`${name} failed`, error);
    return null;
  }
}
async function audit(service: any, actor: string, requestId: string | null, action: string, details: unknown) {
  const { error } = await service.from("audit_log").insert({ actor_user_id: actor, request_id: requestId, action, details });
  if (error) console.error("audit failed", error);
}
