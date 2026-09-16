import { createClient } from "npm:@supabase/supabase-js@2";


Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json(
      {
        error: "Method not allowed",
      },
      405,
    );
  }


  try {
    const supabaseUrl =
      Deno.env.get(
        "SUPABASE_URL",
      );

    const serviceRoleKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY",
      );

    const mailerUrl =
      Deno.env.get(
        "MAILER_WEB_APP_URL",
      );

    const mailerSecret =
      Deno.env.get(
        "MAILER_SHARED_SECRET",
      );

    const secretKeysRaw =
      Deno.env.get(
        "SUPABASE_SECRET_KEYS",
      ) || "{}";


    if (
      !supabaseUrl ||
      !serviceRoleKey ||
      !mailerUrl ||
      !mailerSecret
    ) {
      throw new Error(
        "Required environment configuration is missing.",
      );
    }


    /*
     * calendar-sync is an INTERNAL function.
     *
     * Existing callers may continue using the
     * legacy service-role Bearer credential.
     *
     * Scheduled/database callers may instead use
     * a modern Supabase sb_secret_... key in the
     * apikey header. This lets pg_net call this
     * function without putting a service-role JWT
     * into SQL or browser-facing code.
     */
    const authorization =
      req.headers.get(
        "authorization",
      ) || "";

    const apiKey =
      req.headers.get(
        "apikey",
      ) || "";

    let configuredSecretKeys: string[] = [];

    try {
      const parsedSecretKeys =
        JSON.parse(
          secretKeysRaw,
        );

      if (
        parsedSecretKeys &&
        typeof parsedSecretKeys === "object" &&
        !Array.isArray(parsedSecretKeys)
      ) {
        configuredSecretKeys =
          Object.values(
            parsedSecretKeys,
          ).filter(
            (value): value is string =>
              typeof value === "string" &&
              value.length > 0,
          );
      }
    } catch (error) {
      console.error(
        "Could not parse SUPABASE_SECRET_KEYS:",
        error,
      );
    }

    const legacyServiceRoleAuthorized =
      authorization ===
      `Bearer ${serviceRoleKey}`;

    const modernSecretAuthorized =
      Boolean(
        apiKey &&
        configuredSecretKeys.includes(
          apiKey,
        ),
      );


    if (
      !legacyServiceRoleAuthorized &&
      !modernSecretAuthorized
    ) {
      return json(
        {
          error: "Unauthorized",
        },
        401,
      );
    }


    const body =
      await req.json();


    const requestId =
      String(
        body.requestId || "",
      );


    const event =
      String(
        body.event || "",
      );


    if (!requestId) {
      return json(
        {
          error:
            "requestId is required.",
        },
        400,
      );
    }


    if (
      ![
        "pending_hold",
        "confirmed",
        "release",
      ].includes(event)
    ) {
      return json(
        {
          error:
            "Unsupported calendar event.",
        },
        400,
      );
    }


    const service =
      createClient(
        supabaseUrl,
        serviceRoleKey,
        {
          auth: {
            persistSession: false,
          },
        },
      );


    /*
     * Load the entire request.
     *
     * This lets us use the existing
     * request data without duplicating
     * it in callers.
     */
    const {
      data: appointment,
      error: appointmentError,
    } =
      await service
        .from(
          "appointment_requests",
        )
        .select("*")
        .eq(
          "id",
          requestId,
        )
        .maybeSingle();


    if (appointmentError) {
      throw appointmentError;
    }


    if (!appointment) {
      return json(
        {
          error:
            "Appointment request not found.",
        },
        404,
      );
    }


    const address =
      buildAddress(
        appointment,
      );


    const appointmentDisplay =
      formatAppointmentDisplay(
        appointment.appointment_at,
      );


    const distanceDisplay =
      appointment.one_way_miles !==
        null &&
      appointment.one_way_miles !==
        undefined
        ? `${Number(
            appointment.one_way_miles,
          ).toFixed(1)} miles one way`
        : "";


    const payload = {
      request: {
        id:
          appointment.id,

        appointmentAt:
          appointment.appointment_at,

        appointmentDisplay:
          appointmentDisplay,

        address:
          address,

        locationNotes:
          appointment.location_notes ||
          "",

        distanceDisplay:
          distanceDisplay,

        travelSeconds:
          Number(
            appointment.one_way_travel_seconds ||
            0,
          ),

        durationMinutes:
          Number(
            appointment.duration_minutes ||
            30,
          ),

        documentType:
          appointment.document_type ||
          "",

        notarialAct:
          appointment.notarial_act ||
          "",

        signerCount:
          appointment.signer_count ||
          "",

        actCount:
          appointment.act_count ||
          "",

        actsUnknown:
          Boolean(
            appointment.acts_unknown,
          ),

        comments:
          appointment.customer_comments ||
          appointment.comments ||
          "",
      },


      customer: {
        name:
          appointment.customer_name ||
          "",

        email:
          appointment.customer_email ||
          "",

        phone:
          appointment.customer_phone ||
          "",
      },


      quote: {
        total:
          Number(
            appointment.quote_total ||
            0,
          ),

        lines:
          Array.isArray(
            appointment.quote_breakdown,
          )
            ? appointment.quote_breakdown
            : [],
      },


      calendar: {
        pendingEventId:
          appointment.pending_calendar_event_id ||
          null,

        confirmedEventId:
          appointment.confirmed_calendar_event_id ||
          null,
      },
    };


    /*
     * Translate internal event name
     * to the Apps Script event.
     */
    let appsScriptEvent = "";


    if (
      event ===
      "pending_hold"
    ) {
      appsScriptEvent =
        "calendar_pending";
    }


    if (
      event ===
      "confirmed"
    ) {
      appsScriptEvent =
        "calendar_confirmed";
    }


    if (
      event ===
      "release"
    ) {
      appsScriptEvent =
        "calendar_release";
    }


    /*
     * Send the secure request to
     * the Sign After Six Apps Script.
     */
    const response =
      await fetch(
        mailerUrl,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              secret:
                mailerSecret,

              event:
                appsScriptEvent,

              payload:
                payload,
            }),
        },
      );


    const responseText =
      await response.text();


    let appsScriptResult:
      any = null;


    try {
      appsScriptResult =
        JSON.parse(
          responseText,
        );
    } catch {
      throw new Error(
        "Google Apps Script returned an invalid response.",
      );
    }


    if (
      !response.ok ||
      !appsScriptResult?.ok
    ) {
      throw new Error(
        appsScriptResult?.error ||
        `Google Apps Script calendar request failed (${response.status}).`,
      );
    }


    const result =
      appsScriptResult.result ||
      {};


    /*
     * Save the Google Calendar event IDs.
     *
     * These IDs let us update or delete
     * the exact same events later.
     */
    if (
      event ===
      "pending_hold"
    ) {
      if (!result.eventId) {
        throw new Error(
          "Pending calendar event ID was not returned.",
        );
      }


      const {
        error: updateError,
      } =
        await service
          .from(
            "appointment_requests",
          )
          .update({
            pending_calendar_event_id:
              result.eventId,
          })
          .eq(
            "id",
            requestId,
          );


      if (updateError) {
        throw updateError;
      }
    }


    if (
      event ===
      "confirmed"
    ) {
      if (!result.eventId) {
        throw new Error(
          "Confirmed calendar event ID was not returned.",
        );
      }


      const {
        error: updateError,
      } =
        await service
          .from(
            "appointment_requests",
          )
          .update({
            pending_calendar_event_id:
              null,

            confirmed_calendar_event_id:
              result.eventId,
          })
          .eq(
            "id",
            requestId,
          );


      if (updateError) {
        throw updateError;
      }
    }


    if (
      event ===
      "release"
    ) {
      const {
        error: updateError,
      } =
        await service
          .from(
            "appointment_requests",
          )
          .update({
            pending_calendar_event_id:
              null,

            confirmed_calendar_event_id:
              null,
          })
          .eq(
            "id",
            requestId,
          );


      if (updateError) {
        throw updateError;
      }
    }


    /*
     * Audit trail.
     */
    const auditAction =
      event ===
      "pending_hold"
        ? "calendar_pending_hold_created"
        : event ===
          "confirmed"
          ? "calendar_confirmed"
          : "calendar_released";


    const {
      error: auditError,
    } =
      await service
        .from(
          "audit_log",
        )
        .insert({
          request_id:
            requestId,

          action:
            auditAction,

          details: {
            calendar_event:
              event,

            pending_event_id:
              event ===
              "pending_hold"
                ? result.eventId ||
                  null
                : appointment
                    .pending_calendar_event_id ||
                  null,

            confirmed_event_id:
              event ===
              "confirmed"
                ? result.eventId ||
                  null
                : appointment
                    .confirmed_calendar_event_id ||
                  null,

            calendar_id:
              result.calendarId ||
              null,

            block_start:
              result.start ||
              null,

            block_end:
              result.end ||
              null,
          },
        });


    if (auditError) {
      console.error(
        "Calendar audit log error:",
        auditError,
      );
    }


    return json({
      ok: true,

      requestId:
        requestId,

      event:
        event,

      calendarResult:
        result,
    });


  } catch (error) {
    console.error(
      "calendar-sync error:",
      error,
    );


    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Calendar sync failed.",
      },
      500,
    );
  }
});


function buildAddress(
  appointment: any,
) {
  const parts:
    string[] = [];


  if (
    appointment.service_address
  ) {
    parts.push(
      String(
        appointment.service_address,
      ),
    );
  }


  if (
    appointment.service_unit
  ) {
    parts.push(
      String(
        appointment.service_unit,
      ),
    );
  }


  if (
    appointment.service_zip
  ) {
    const zip =
      String(
        appointment.service_zip,
      );


    /*
     * Avoid repeating ZIP if the full
     * address already contains it.
     */
    if (
      !parts
        .join(" ")
        .includes(zip)
    ) {
      parts.push(zip);
    }
  }


  return parts.join(", ");
}


function formatAppointmentDisplay(
  value: string | null,
) {
  if (!value) {
    return "";
  }


  const date =
    new Date(value);


  if (
    Number.isNaN(
      date.getTime(),
    )
  ) {
    return value;
  }


  return new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone:
        "America/New_York",

      weekday:
        "long",

      month:
        "long",

      day:
        "numeric",

      year:
        "numeric",

      hour:
        "numeric",

      minute:
        "2-digit",

      timeZoneName:
        "short",
    },
  ).format(date);
}


function json(
  body: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify(body),
    {
      status,

      headers: {
        "Content-Type":
          "application/json",
      },
    },
  );
}