import { createClient } from "npm:@supabase/supabase-js@2";

const TIME_ZONE =
  "America/New_York";

/*
 * Reminder windows.
 *
 * Cron runs every 5 minutes, so a 60-minute
 * window gives plenty of room for transient retries
 * while keeping "about 24 hours" / "about 2 hours"
 * accurate.
 */
const REMINDER_WINDOWS = {
  "24h": {
    minMinutes: 23.5 * 60,
    maxMinutes: 24.5 * 60,
    auditAction:
      "appointment_reminder_24h_sent",
  },

  "2h": {
    minMinutes: 1.5 * 60,
    maxMinutes: 2.5 * 60,
    auditAction:
      "appointment_reminder_2h_sent",
  },
};


Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json(
      {
        error:
          "Method not allowed",
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

    const secretKeysRaw =
      Deno.env.get(
        "SUPABASE_SECRET_KEYS",
      ) || "{}";

    const mailerUrl =
      Deno.env.get(
        "MAILER_WEB_APP_URL",
      );

    const mailerSecret =
      Deno.env.get(
        "MAILER_SHARED_SECRET",
      );

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
     * INTERNAL AUTHORIZATION
     *
     * Existing internal callers may use:
     * Authorization: Bearer <service-role>
     *
     * Cron may use:
     * apikey: <sb_secret_...>
     */
    const authorization =
      req.headers.get(
        "authorization",
      ) || "";

    const apiKey =
      req.headers.get(
        "apikey",
      ) || "";

    let configuredSecretKeys:
      string[] = [];

    try {
      const parsed =
        JSON.parse(
          secretKeysRaw,
        );

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        configuredSecretKeys =
          Object.values(parsed)
            .filter(
              (
                value,
              ): value is string =>
                typeof value ===
                  "string" &&
                value.length > 0,
            );
      }
    } catch (error) {
      console.error(
        "Could not parse SUPABASE_SECRET_KEYS:",
        error,
      );
    }

    const legacyAuthorized =
      authorization ===
      `Bearer ${serviceRoleKey}`;

    const modernAuthorized =
      Boolean(
        apiKey &&
        configuredSecretKeys
          .includes(apiKey),
      );

    if (
      !legacyAuthorized &&
      !modernAuthorized
    ) {
      return json(
        {
          error:
            "Unauthorized",
        },
        401,
      );
    }

    const service =
      createClient(
        supabaseUrl,
        serviceRoleKey,
        {
          auth: {
            persistSession:
              false,
          },
        },
      );

    const body =
      await req
        .json()
        .catch(
          () => ({}),
        );

    /*
     * OPTIONAL INTERNAL MANUAL TEST
     *
     * Example:
     * {
     *   "requestId": "...",
     *   "reminderType": "2h",
     *   "test": true
     * }
     *
     * This sends the reminder but deliberately
     * does NOT create the production "sent"
     * audit record.
     */
    if (
      body?.test === true &&
      body?.requestId &&
      (
        body?.reminderType ===
          "24h" ||
        body?.reminderType ===
          "2h"
      )
    ) {
      const result =
        await sendManualTest({
          service,
          mailerUrl,
          mailerSecret,
          requestId:
            String(
              body.requestId,
            ),
          reminderType:
            body.reminderType,
        });

      return json({
        ok: true,
        mode:
          "test",
        result,
      });
    }

    const checkedAt =
      new Date();

    const checkedAtIso =
      checkedAt.toISOString();

    const maxAppointmentTime =
      new Date(
        checkedAt.getTime() +
        24.5 *
          60 *
          60 *
          1000,
      ).toISOString();

    /*
     * Only confirmed appointments can receive
     * customer appointment reminders.
     */
    const {
      data: appointments,
      error: appointmentError,
    } =
      await service
        .from(
          "appointment_requests",
        )
        .select(
          [
            "id",
            "status",
            "appointment_at",
            "customer_name",
            "customer_email",
            "customer_phone",
            "service_address",
            "service_unit",
            "service_zip",
            "document_type",
            "notarial_act",
            "signer_count",
            "act_count",
            "acts_unknown",
          ].join(","),
        )
        .eq(
          "status",
          "confirmed",
        )
        .gt(
          "appointment_at",
          checkedAtIso,
        )
        .lte(
          "appointment_at",
          maxAppointmentTime,
        )
        .order(
          "appointment_at",
          {
            ascending: true,
          },
        )
        .limit(100);

    if (appointmentError) {
      throw appointmentError;
    }

    const results:
      any[] = [];

    let sent24hCount =
      0;

    let sent2hCount =
      0;

    let alreadySentCount =
      0;

    let outsideWindowCount =
      0;

    let failureCount =
      0;

    for (
      const appointment
      of appointments || []
    ) {
      const appointmentAt =
        new Date(
          appointment.appointment_at,
        );

      const minutesUntil =
        (
          appointmentAt.getTime() -
          checkedAt.getTime()
        ) /
        60000;

      const reminderType =
        determineReminderType(
          minutesUntil,
        );

      if (!reminderType) {
        outsideWindowCount +=
          1;

        continue;
      }

      try {
        const window =
          REMINDER_WINDOWS[
            reminderType
          ];

        const alreadySent =
          await reminderAlreadySent({
            service,
            requestId:
              appointment.id,
            auditAction:
              window.auditAction,
            appointmentAt:
              appointment
                .appointment_at,
          });

        if (alreadySent) {
          alreadySentCount +=
            1;

          results.push({
            requestId:
              appointment.id,
            reminderType,
            result:
              "already_sent",
          });

          continue;
        }

        await sendReminderToMailer({
          mailerUrl,
          mailerSecret,
          appointment,
          reminderType,
        });

        const {
          error: auditError,
        } =
          await service
            .from(
              "audit_log",
            )
            .insert({
              request_id:
                appointment.id,

              action:
                window.auditAction,

              details: {
                reminder_type:
                  reminderType,

                appointment_at:
                  appointment
                    .appointment_at,

                sent_at:
                  new Date()
                    .toISOString(),

                minutes_until_appointment:
                  Math.round(
                    minutesUntil,
                  ),
              },
            });

        if (auditError) {
          /*
           * The email already sent, so log loudly.
           * We do not pretend the run was fully
           * successful because a missing audit row
           * could otherwise permit a duplicate later.
           */
          throw new Error(
            `Reminder email sent but audit logging failed: ${formatError(
              auditError,
            )}`,
          );
        }

        if (
          reminderType ===
          "24h"
        ) {
          sent24hCount +=
            1;
        } else {
          sent2hCount +=
            1;
        }

        results.push({
          requestId:
            appointment.id,

          reminderType,

          result:
            "sent",

          minutesUntilAppointment:
            Math.round(
              minutesUntil,
            ),
        });
      } catch (error) {
        failureCount +=
          1;

        console.error(
          "appointment reminder failed:",
          appointment?.id,
          error,
        );

        results.push({
          requestId:
            appointment?.id ||
            null,

          reminderType,

          result:
            "error",

          error:
            formatError(
              error,
            ),
        });
      }
    }

    return json({
      ok: true,

      checkedAt:
        checkedAtIso,

      appointmentsChecked:
        appointments?.length ||
        0,

      sent24hCount,

      sent2hCount,

      alreadySentCount,

      outsideWindowCount,

      failureCount,

      results,
    });

  } catch (error) {
    console.error(
      "send-reminders error:",
      error,
    );

    return json(
      {
        error:
          formatError(
            error,
          ) ||
          "Reminder processing failed.",
      },
      500,
    );
  }
});


function determineReminderType(
  minutesUntil: number,
):
  | "24h"
  | "2h"
  | null {
  const twoHour =
    REMINDER_WINDOWS["2h"];

  if (
    minutesUntil >=
      twoHour.minMinutes &&
    minutesUntil <=
      twoHour.maxMinutes
  ) {
    return "2h";
  }

  const twentyFourHour =
    REMINDER_WINDOWS["24h"];

  if (
    minutesUntil >=
      twentyFourHour.minMinutes &&
    minutesUntil <=
      twentyFourHour.maxMinutes
  ) {
    return "24h";
  }

  return null;
}


async function reminderAlreadySent(
  args: {
    service: any;
    requestId: string;
    auditAction: string;
    appointmentAt: string;
  },
) {
  const {
    service,
    requestId,
    auditAction,
    appointmentAt,
  } = args;

  const {
    data,
    error,
  } =
    await service
      .from(
        "audit_log",
      )
      .select(
        "id, details",
      )
      .eq(
        "request_id",
        requestId,
      )
      .eq(
        "action",
        auditAction,
      )
      .order(
        "created_at",
        {
          ascending: false,
        },
      )
      .limit(20);

  if (error) {
    throw error;
  }

  return (
    data || []
  ).some(
    (row: any) =>
      String(
        row?.details
          ?.appointment_at ||
        "",
      ) ===
      String(
        appointmentAt,
      ),
  );
}


async function sendManualTest(
  args: {
    service: any;
    mailerUrl: string;
    mailerSecret: string;
    requestId: string;
    reminderType:
      | "24h"
      | "2h";
  },
) {
  const {
    service,
    mailerUrl,
    mailerSecret,
    requestId,
    reminderType,
  } = args;

  const {
    data: appointment,
    error,
  } =
    await service
      .from(
        "appointment_requests",
      )
      .select(
        [
          "id",
          "status",
          "appointment_at",
          "customer_name",
          "customer_email",
          "customer_phone",
          "service_address",
          "service_unit",
          "service_zip",
          "document_type",
          "notarial_act",
          "signer_count",
          "act_count",
          "acts_unknown",
        ].join(","),
      )
      .eq(
        "id",
        requestId,
      )
      .maybeSingle();

  if (error) {
    throw error;
  }

  if (!appointment) {
    throw new Error(
      "Appointment request not found.",
    );
  }

  await sendReminderToMailer({
    mailerUrl,
    mailerSecret,
    appointment,
    reminderType,
  });

  return {
    requestId,
    reminderType,
    sentTo:
      appointment
        .customer_email ||
      null,
  };
}


async function sendReminderToMailer(
  args: {
    mailerUrl: string;
    mailerSecret: string;
    appointment: any;
    reminderType:
      | "24h"
      | "2h";
  },
) {
  const {
    mailerUrl,
    mailerSecret,
    appointment,
    reminderType,
  } = args;

  if (
    !appointment
      ?.customer_email
  ) {
    throw new Error(
      "Customer email is missing.",
    );
  }

  const payload = {
    reminderType,

    request: {
      id:
        appointment.id,

      appointmentAt:
        appointment.appointment_at,

      appointmentDisplay:
        formatAppointmentDisplay(
          appointment
            .appointment_at,
        ),

      address:
        buildAddress(
          appointment,
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
          appointment
            .acts_unknown,
        ),
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
  };

  let lastError:
    unknown = null;

  for (
    let attempt = 1;
    attempt <= 3;
    attempt += 1
  ) {
    try {
      const response =
        await fetch(
          mailerUrl,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                secret:
                  mailerSecret,

                event:
                  "appointment_reminder",

                payload,
              }),

            signal:
              AbortSignal.timeout(
                12000,
              ),
          },
        );

      const text =
        await response
          .text();

      let result:
        any = null;

      try {
        result =
          JSON.parse(
            text,
          );
      } catch {
        throw new Error(
          "Google Apps Script returned an invalid response.",
        );
      }

      if (
        response.ok &&
        result?.ok
      ) {
        return;
      }

      const message =
        result?.error ||
        `Google Apps Script reminder failed (${response.status}).`;

      const retryable =
        response.status >=
          500 ||
        response.status ===
          429;

      if (
        !retryable ||
        attempt === 3
      ) {
        throw new Error(
          message,
        );
      }

      lastError =
        new Error(
          message,
        );

    } catch (error) {
      lastError =
        error;

      if (
        attempt === 3 ||
        !isTransientError(
          error,
        )
      ) {
        throw error;
      }
    }

    await sleep(
      attempt *
        750,
    );
  }

  throw (
    lastError ||
    new Error(
      "Reminder email failed.",
    )
  );
}


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
        appointment
          .service_address,
      ),
    );
  }

  if (
    appointment.service_unit
  ) {
    parts.push(
      String(
        appointment
          .service_unit,
      ),
    );
  }

  if (
    appointment.service_zip
  ) {
    const zip =
      String(
        appointment
          .service_zip,
      );

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
        TIME_ZONE,

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


function isTransientError(
  error: unknown,
) {
  const message =
    formatError(
      error,
    ).toLowerCase();

  return (
    message.includes(
      "gateway timeout",
    ) ||
    message.includes(
      "timeout",
    ) ||
    message.includes(
      "timed out",
    ) ||
    message.includes(
      "temporarily unavailable",
    ) ||
    message.includes(
      "service unavailable",
    ) ||
    message.includes(
      "bad gateway",
    ) ||
    message.includes(
      "too many requests",
    ) ||
    message.includes(
      "connection reset",
    ) ||
    message.includes(
      "fetch failed",
    )
  );
}


function formatError(
  error: unknown,
) {
  if (
    error instanceof Error
  ) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object"
  ) {
    const maybeMessage =
      (error as any)
        .message;

    const maybeDetails =
      (error as any)
        .details;

    const maybeCode =
      (error as any)
        .code;

    const parts =
      [
        maybeCode
          ? `code=${maybeCode}`
          : "",

        maybeMessage
          ? String(
              maybeMessage,
            )
          : "",

        maybeDetails
          ? String(
              maybeDetails,
            )
          : "",
      ].filter(Boolean);

    if (parts.length) {
      return parts.join(
        " | ",
      );
    }

    try {
      return JSON.stringify(
        error,
      );
    } catch {
      return String(
        error,
      );
    }
  }

  return String(
    error || "",
  );
}


function sleep(
  milliseconds: number,
) {
  return new Promise(
    (
      resolve,
    ) =>
      setTimeout(
        resolve,
        milliseconds,
      ),
  );
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
