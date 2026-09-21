import { createClient } from "npm:@supabase/supabase-js@2";
import { fromZonedTime } from "npm:date-fns-tz@3.2.0";

const SITE_ORIGIN = "https://signaftersix.github.io";

const allowedTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const MAX_FILES = 10;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_SIZE = 50 * 1024 * 1024;

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin":
      origin === SITE_ORIGIN ? SITE_ORIGIN : SITE_ORIGIN,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(
  body: unknown,
  status = 200,
  origin: string | null = SITE_ORIGIN,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
    },
  });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders(origin),
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, origin);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Server configuration is incomplete.");
    }

    const supabase = createClient(
      supabaseUrl,
      serviceRoleKey,
    );

    const form = await req.formData();

    const rawPayload = form.get("payload");

    if (!rawPayload) {
      throw new Error("Missing appointment information.");
    }

    const payload = JSON.parse(String(rawPayload));

    validatePayload(payload);

    const files = form
      .getAll("documents")
      .filter((item): item is File => item instanceof File);

    if (files.length > MAX_FILES) {
      throw new Error("A maximum of 10 files may be uploaded.");
    }

    if (
      files.length === 0 &&
      !payload?.document?.noDocumentYet
    ) {
      throw new Error(
        "Please upload the document or indicate that you do not have it yet.",
      );
    }

    let totalBytes = 0;

    for (const file of files) {
      if (!allowedTypes.has(file.type)) {
        throw new Error(
          `Unsupported file type: ${file.name}`,
        );
      }

      if (file.size > MAX_FILE_SIZE) {
        throw new Error(
          `${file.name} is larger than the 10 MB file limit.`,
        );
      }

      totalBytes += file.size;
    }

    if (totalBytes > MAX_TOTAL_SIZE) {
      throw new Error(
        "The combined upload may not exceed 50 MB.",
      );
    }

    const appointment = payload.appointment;
    const document = payload.document;
    const customer = payload.customer;
    const quote = payload.quote;
    const extras = payload.extras || {};

    const appointmentAt = fromZonedTime(
      `${appointment.date} ${appointment.time}:00`,
      "America/New_York",
    );

    if (
      Number.isNaN(appointmentAt.getTime()) ||
      appointmentAt.getTime() <= Date.now()
    ) {
      throw new Error(
        "The appointment must be scheduled for a future time.",
      );
    }

    const hoursUntilAppointment =
      (appointmentAt.getTime() - Date.now()) / 3600000;

    let expirationMs;

    if (hoursUntilAppointment <= 24) {
      const halfWindowHours = Math.max(
        1,
        hoursUntilAppointment / 2,
      );

      expirationMs = Math.min(
        appointmentAt.getTime() - 30 * 60 * 1000,
        Date.now() + halfWindowHours * 3600000,
      );
    } else {
      expirationMs = Date.now() + 24 * 3600000;
    }

    if (expirationMs < Date.now()) {
      expirationMs = Date.now() + 15 * 60 * 1000;
    }

    /* Recalculate routing on the server so a customer cannot alter browser mileage. */
    const routeResponse = await fetch(
      `${supabaseUrl}/functions/v1/route-service-address`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ address: appointment.address }),
      },
    );
    const routeResult = await routeResponse.json();
    if (!routeResponse.ok || routeResult?.ok !== true) {
      return json(
        {
          error: routeResult?.error || "Travel routing could not be verified.",
          code: routeResult?.code || "ROUTING_FAILED",
        },
        routeResponse.status || 503,
        origin,
      );
    }

    const oneWayMiles = Number(routeResult.miles);

    if (oneWayMiles < 0 || oneWayMiles > 75) {
      throw new Error(
        "Online appointment requests are limited to 75 miles.",
      );
    }

    const serverQuote = calculateServerQuote(oneWayMiles, appointmentAt, document, extras);
    const quoteTotal = serverQuote.total;

    if (
      !Number.isFinite(quoteTotal) ||
      quoteTotal < 0
    ) {
      throw new Error("Invalid quote total.");
    }

    /*
     * Use the same travel and duration values for:
     *
     * 1. the availability check;
     * 2. the database record;
     * 3. the Pending Calendar hold.
     *
     * This prevents the availability checker from
     * evaluating a different block than Calendar later uses.
     */
    const oneWayTravelSeconds = Number(routeResult.travelSeconds);

    if (
      !Number.isFinite(oneWayTravelSeconds) ||
      oneWayTravelSeconds < 0 ||
      oneWayTravelSeconds > 21600
    ) {
      throw new Error(
        "Invalid travel-time calculation.",
      );
    }

    const durationMinutes = serverQuote.duration;

    if (
      !Number.isFinite(durationMinutes) ||
      durationMinutes < 30 ||
      durationMinutes > 180
    ) {
      throw new Error(
        "Invalid appointment duration.",
      );
    }

    /*
     * REQUIRED SERVER-SIDE AVAILABILITY CHECK
     *
     * This happens before the request is inserted,
     * before documents are uploaded, and before any
     * email/calendar side effects occur.
     *
     * We fail closed: if Calendar availability cannot
     * be verified, the customer is asked to try again
     * rather than risking a double booking.
     */
    let availability:
      {
        available: boolean;
      };

    try {
      availability =
        await checkAvailability(
          supabaseUrl,
          serviceRoleKey,
          {
            appointmentAt:
              appointmentAt.toISOString(),

            durationMinutes:
              Math.round(
                durationMinutes,
              ),

            travelSeconds:
              Math.round(
                oneWayTravelSeconds,
              ),
          },
        );

    } catch (availabilityError) {
      console.error(
        "Availability verification failed:",
        availabilityError,
      );

      return json(
        {
          error:
            "We couldn't verify that appointment time right now. Please try again in a moment.",

          code:
            "AVAILABILITY_CHECK_FAILED",
        },
        503,
        origin,
      );
    }

    if (
      !availability.available
    ) {
      return json(
        {
          error:
            "That appointment time is no longer available. Please choose another time.",

          code:
            "TIME_UNAVAILABLE",
        },
        409,
        origin,
      );
    }

    const managementToken = crypto.randomUUID() + crypto.randomUUID();
    const managementTokenHash = await sha256(managementToken);

    const { data: record, error: insertError } =
      await supabase
        .from("appointment_requests")
        .insert({
          customer_name: customer.name,
          customer_email: customer.email,
          customer_phone: customer.phone,
          preferred_contact:
            customer.preferredContact || null,
          referral: customer.referral || null,

          appointment_at: appointmentAt.toISOString(),
          backup_time: appointment.backupTime || null,

          service_address: appointment.address,
          service_unit: appointment.unit || null,
          service_zip: appointment.zip || null,
          location_notes:
            appointment.locationNotes || null,

          emergency_opening:
            !!appointment.emergencyOpening,

          one_way_miles:
            oneWayMiles || null,

          one_way_travel_seconds:
            oneWayTravelSeconds || null,

          duration_minutes:
            Math.round(
              durationMinutes,
            ),

          document_type: document.type,
          notarial_act: document.notarialAct,

          signer_count:
            Number(document.signers) || 1,

          act_count:
            document.acts === "unknown"
              ? null
              : Number(document.acts),

          acts_unknown:
            document.acts === "unknown",

          needs_witnesses:
            !!document.needsWitnesses,

          document_notes:
            document.notes || null,

          customer_comments:
            payload.customerComments || null,

          accommodations:
            extras.accommodations || [],

          extras,

          quote_breakdown: serverQuote.lines,

          quote_total: quoteTotal,

          expires_at:
            new Date(expirationMs).toISOString(),

          management_token_hash: managementTokenHash,
        })
        .select("id")
        .single();

    if (insertError) {
      /*
       * PostgreSQL exclusion-constraint violation.
       *
       * This is the database-level race-condition backstop:
       * if another active request claimed an overlapping block
       * after our Calendar availability check but before this
       * insert completed, return the same friendly conflict
       * response instead of exposing a database error.
       */
      if (
        insertError.code === "23P01" ||
        String(insertError.message || "").includes(
          "appointment_requests_no_active_overlap",
        )
      ) {
        return json(
          {
            error:
              "That appointment time is no longer available. Please choose another time.",

            code:
              "TIME_UNAVAILABLE",
          },
          409,
          origin,
        );
      }

      throw insertError;
    }

    const { error: managementLinkError } = await supabase
      .from("request_management_links")
      .insert({ request_id: record.id, management_token: managementToken });
    if (managementLinkError) {
      await supabase.from("appointment_requests").delete().eq("id", record.id);
      throw new Error("The secure appointment-management link could not be created.");
    }

    for (const file of files) {
      const safeName = file.name.replace(
        /[^a-zA-Z0-9._-]/g,
        "_",
      );

      const storagePath =
        `${record.id}/${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } =
        await supabase.storage
          .from("notary-documents")
          .upload(storagePath, file, {
            contentType: file.type,
            upsert: false,
          });

      if (uploadError) {
        throw uploadError;
      }

      const { error: metadataError } =
        await supabase
          .from("request_documents")
          .insert({
            request_id: record.id,
            storage_path: storagePath,
            original_name: file.name,
            mime_type: file.type,
            byte_size: file.size,
          });

      if (metadataError) {
        throw metadataError;
      }
    }

    await supabase
      .from("audit_log")
      .insert({
        request_id: record.id,
        action: "request_created",
        details: {
          source: "public_site",
          file_count: files.length,
        },
      });

    await invokeBestEffort(
      supabaseUrl,
      serviceRoleKey,
      "notify-status",
      {
        requestId: record.id,
        event: "new_request",
        managementToken,
      },
    );

    await invokeBestEffort(
      supabaseUrl,
      serviceRoleKey,
      "notify-status",
      {
        requestId: record.id,
        event: "customer_request_received",
        managementToken,
      },
    );

    await invokeBestEffort(
      supabaseUrl,
      serviceRoleKey,
      "calendar-sync",
      {
        requestId: record.id,
        event: "pending_hold",
      },
    );

    return json(
      {
        requestId: record.id,
        status: "pending",
      },
      201,
      origin,
    );
  } catch (error) {
    console.error(error);

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to create appointment request.",
      },
      400,
      origin,
    );
  }
});

function validatePayload(payload: any) {
  if (
    !payload?.customer?.name ||
    !payload?.customer?.email ||
    !payload?.customer?.phone
  ) {
    throw new Error(
      "Missing required customer information.",
    );
  }

  if (
    !payload?.appointment?.date ||
    !payload?.appointment?.time ||
    !payload?.appointment?.address
  ) {
    throw new Error(
      "Missing required appointment information.",
    );
  }

  if (
    !payload?.document?.type ||
    !payload?.document?.notarialAct
  ) {
    throw new Error(
      "Missing required document information.",
    );
  }

  if (!payload?.quote) {
    throw new Error("Missing quote information.");
  }
}

function calculateServerQuote(miles: number, appointmentAt: Date, document: any, extras: any) {
  const lines: [string, number][] = [];
  const acts = document.acts === "unknown" ? 1 : Math.max(1, Number(document.acts || 1));
  const signers = Math.max(1, Number(document.signers || 1));
  const marriage = document.type === "Simple Marriage Solemnization" || document.notarialAct === "Simple Marriage Solemnization";
  lines.push([marriage ? "Simple marriage solemnization" : `${acts} notarial act${acts === 1 ? "" : "s"} x $10`, marriage ? 25 : acts * 10]);
  let travel = 25;
  if (miles > 5) travel += Math.max(0, Math.min(miles, 50) - 5) * 0.25;
  if (miles > 50) travel += (miles - 50) * 2;
  travel = Math.max(travel, miles <= 10 ? 25 : 30);
  lines.push([`Mobile/travel (${miles.toFixed(1)} one-way mi)`, roundMoney(travel)]);

  const hours = (appointmentAt.getTime() - Date.now()) / 3600000;
  const hourText = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(appointmentAt);
  const easternHour = Number(hourText === "24" ? "0" : hourText);
  const easternDate = easternDateKey(appointmentAt);
  const todayEastern = easternDateKey(new Date());
  let urgency = 0;
  if (easternDate === todayEastern && easternHour >= 20) urgency = 40;
  else if (hours <= 6) urgency = 25;
  else if (hours <= 12) urgency = 10;
  else if (hours <= 24) urgency = 5;
  if (urgency) lines.push([easternDate === todayEastern && easternHour >= 20 ? "Same-day after-8 PM premium" : "Short-notice premium", urgency]);

  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(appointmentAt);
  if (weekday === "Sat" || weekday === "Sun") {
    let weekend = 5;
    if (easternHour < 8) weekend += 15;
    if (easternHour >= 20) weekend += 20;
    lines.push(["Weekend / early-late premium", weekend]);
  }
  const [year, month, day] = easternDate.split("-").map(Number);
  const holiday = holidayPremium(year, month, day, easternHour);
  if (holiday) lines.push([holiday === 40 ? "Major holiday premium" : "Holiday premium", holiday]);
  if (extras.printing) {
    const pages = Math.max(1, Number(extras.pages || 1));
    lines.push([`Printing (${pages} page${pages === 1 ? "" : "s"})`, 5 + Math.max(0, pages - 10) * 0.25]);
  }
  if (extras.envelope) lines.push(["Standard envelope + stamp", 1.07]);
  if (extras.mailing === "mailbox") lines.push(["Mailbox drop-off", 5]);
  if (extras.mailing === "counter") lines.push(["Staffed post-office drop-off", 10]);
  if (extras.certified) lines.push(["Certified Mail + handling", 6.55]);
  const duration = signers >= 5 || acts >= 7 ? 60 : signers >= 3 || acts >= 4 ? 45 : 30;
  return { total: roundMoney(lines.reduce((sum, line) => sum + line[1], 0)), lines: lines.map(([label, amount]) => [label, roundMoney(amount)]), duration };
}

function easternDateKey(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function holidayPremium(year: number, month: number, day: number, hour: number) {
  const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const easter = easterDate(year);
  if (key === easter || (month === 11 && nthWeekday(year, month, day, 4, 4)) || (month === 12 && day === 25) || (month === 1 && day === 1) || (month === 7 && day === 4) || (month === 12 && (day === 24 || day === 31) && hour >= 18)) return 40;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if ((month === 6 && day === 19) || (month === 11 && day === 11) || (month === 1 && weekday === 1 && Math.ceil(day / 7) === 3) || (month === 2 && weekday === 1 && Math.ceil(day / 7) === 3) || (month === 5 && weekday === 1 && day + 7 > new Date(Date.UTC(year, month, 0)).getUTCDate()) || (month === 9 && weekday === 1 && day <= 7) || (month === 10 && weekday === 1 && day >= 8 && day <= 14)) return 20;
  return 0;
}
function nthWeekday(year: number, month: number, day: number, nth: number, weekday: number) { return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === weekday && Math.ceil(day / 7) === nth; }
function easterDate(year: number) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=(h+l-7*m+114)%31+1;
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

async function checkAvailability(
  supabaseUrl: string,
  serviceRoleKey: string,
  body: {
    appointmentAt: string;
    durationMinutes: number;
    travelSeconds: number;
  },
) {
  const response =
    await fetch(
      `${supabaseUrl}/functions/v1/check-availability`,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${serviceRoleKey}`,

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify(
            body,
          ),
      },
    );

  const responseText =
    await response.text();

  let result:
    any = null;

  try {
    result =
      JSON.parse(
        responseText,
      );
  } catch {
    throw new Error(
      "Availability service returned an invalid response.",
    );
  }

  if (
    !response.ok ||
    result?.ok !== true ||
    typeof result?.available !==
      "boolean"
  ) {
    throw new Error(
      result?.error ||
      `Availability service failed (${response.status}).`,
    );
  }

  return {
    available:
      result.available,
  };
}

async function invokeBestEffort(
  supabaseUrl: string,
  serviceRoleKey: string,
  name: string,
  body: unknown,
) {
  try {
    await fetch(
      `${supabaseUrl}/functions/v1/${name}`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  } catch (error) {
    console.warn(
      `Optional ${name} call failed:`,
      error,
    );
  }
}
