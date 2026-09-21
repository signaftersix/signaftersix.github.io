import { createClient } from "npm:@supabase/supabase-js@2";

const SITE_URL = "https://signaftersix.github.io";


Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return response(
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


    if (
      !supabaseUrl ||
      !serviceRoleKey ||
      !mailerUrl ||
      !mailerSecret
    ) {
      throw new Error(
        "Mailer configuration is incomplete.",
      );
    }


    /*
     * Only other trusted backend functions
     * may call notify-status.
     */
    const authHeader =
      req.headers.get(
        "authorization",
      ) || "";


    if (
      authHeader !==
      `Bearer ${serviceRoleKey}`
    ) {
      return response(
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
        body.requestId ||
        "",
      );


    const event =
      String(
        body.event ||
        "new_request",
      );


    if (!requestId) {
      throw new Error(
        "Missing requestId.",
      );
    }


    /*
     * Supported email events.
     *
     * payment_confirmed is NEW.
     */
    const supportedEvents =
      new Set([
        "new_request",
        "customer_request_received",
        "revised_quote",
        "payment_requested",
        "payment_confirmed",
        "cancellation_requested",
        "cancellation_approved",
        "cancellation_denied",
        "reschedule_requested",
        "reschedule_approved",
        "reschedule_denied",
      ]);


    if (
      !supportedEvents.has(
        event,
      )
    ) {
      throw new Error(
        `Unsupported notification event: ${event}`,
      );
    }


    const supabase =
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
     * GET APPOINTMENT REQUEST
     */
    const {
      data: requestRow,
      error: requestError,
    } =
      await supabase
        .from(
          "appointment_requests",
        )
        .select("*")
        .eq(
          "id",
          requestId,
        )
        .single();


    if (
      requestError ||
      !requestRow
    ) {
      throw (
        requestError ||
        new Error(
          "Request not found.",
        )
      );
    }


    /*
     * FORMAT APPOINTMENT DATE/TIME
     */
    const appointmentDate =
      new Date(
        requestRow.appointment_at,
      );


    const appointmentDisplay =
      new Intl.DateTimeFormat(
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
        },
      ).format(
        appointmentDate,
      );


    /*
     * ADDRESS
     */
    const addressParts = [
      requestRow.service_address,
      requestRow.service_unit,
      requestRow.service_zip,
    ].filter(Boolean);


    const address =
      addressParts.join(
        ", ",
      );


    /*
     * DISTANCE
     */
    const distanceDisplay =
      requestRow.one_way_miles != null

        ? `${Number(
            requestRow.one_way_miles,
          ).toFixed(1)} miles one way`

        : "Pending calculation";


    /*
     * BASE PAYLOAD USED BY ALL
     * EMAIL TYPES
     */
    const mailPayload: any = {
      secret:
        mailerSecret,

      event,

      payload: {
        request: {
          id:
            requestId,

          appointmentAt:
            requestRow
              .appointment_at,

          appointmentDisplay,

          address,

          distanceDisplay,

          documentType:
            requestRow
              .document_type,

          notarialAct:
            requestRow
              .notarial_act,

          signerCount:
            requestRow
              .signer_count,

          actCount:
            requestRow
              .act_count,

          actsUnknown:
            requestRow
              .acts_unknown,

          comments:
            requestRow
              .customer_comments,

          emergencyOpening:
            requestRow
              .emergency_opening,
        },


        customer: {
          name:
            requestRow
              .customer_name,

          email:
            requestRow
              .customer_email,

          phone:
            requestRow
              .customer_phone,
        },


        quote: {
          total:
            Number(
              requestRow
                .quote_total,
            ),

          lines:
            requestRow
              .quote_breakdown ||
            [],
        },
      },
    };

    let managementToken = body.managementToken ? String(body.managementToken) : "";
    if (!managementToken) {
      const { data: managementLink } = await supabase
        .from("request_management_links")
        .select("management_token")
        .eq("request_id", requestId)
        .maybeSingle();
      managementToken = String(managementLink?.management_token || "");
    }
    if (managementToken) {
      mailPayload.payload.manageUrl = `${SITE_URL}/manage-request.html?request=${encodeURIComponent(requestId)}&token=${encodeURIComponent(managementToken)}`;
    }
    if (body.acceptanceUrl) mailPayload.payload.acceptanceUrl = String(body.acceptanceUrl);

    if (requestRow.requested_appointment_at) {
      mailPayload.payload.request.requestedAppointmentAt = requestRow.requested_appointment_at;
      mailPayload.payload.request.requestedAppointmentDisplay = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
      }).format(new Date(requestRow.requested_appointment_at));
    }


    /*
     * NEW REQUEST EMAIL
     *
     * Generate temporary signed URLs
     * for uploaded documents.
     */
    if (
      event ===
      "new_request"
    ) {
      const {
        data: documentRows,
        error: documentError,
      } =
        await supabase
          .from(
            "request_documents",
          )
          .select("*")
          .eq(
            "request_id",
            requestId,
          );


      if (documentError) {
        throw documentError;
      }


      const documents = [];


      for (
        const doc of
        documentRows || []
      ) {
        const {
          data: signed,
          error: signedError,
        } =
          await supabase
            .storage
            .from(
              "notary-documents",
            )
            .createSignedUrl(
              doc.storage_path,

              /*
               * Secure document link
               * expires after one hour.
               */
              60 * 60,
            );


        documents.push({
          name:
            doc.original_name,

          url:
            signedError
              ? null
              : (
                  signed
                    ?.signedUrl ||
                  null
                ),
        });
      }


      mailPayload
        .payload
        .documents =
          documents;


      mailPayload
        .payload
        .approveUrl =
          `${SITE_URL}/admin.html` +
          `?request=${encodeURIComponent(
            requestId,
          )}` +
          `&action=approve`;


      mailPayload
        .payload
        .declineUrl =
          `${SITE_URL}/admin.html` +
          `?request=${encodeURIComponent(
            requestId,
          )}` +
          `&action=decline`;
    }

    if (event === "customer_request_received" && !mailPayload.payload.manageUrl) {
      throw new Error("Customer management URL is missing.");
    }


    /*
     * PAYMENT REQUESTED EMAIL
     *
     * Includes the Square payment link
     * and payment deadline.
     */
    if (
      event ===
      "payment_requested"
    ) {
      if (
        !requestRow
          .square_payment_link_url
      ) {
        throw new Error(
          "Square payment link is missing.",
        );
      }


      let dueDisplay =
        "";


      if (
        requestRow
          .payment_due_at
      ) {
        dueDisplay =
          new Intl.DateTimeFormat(
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

              hour:
                "numeric",

              minute:
                "2-digit",
            },
          ).format(
            new Date(
              requestRow
                .payment_due_at,
            ),
          );
      }


      mailPayload
        .payload
        .payment = {
          url:
            requestRow
              .square_payment_link_url,

          dueAt:
            requestRow
              .payment_due_at,

          dueDisplay,

          status:
            requestRow
              .payment_status ||
            "unpaid",
        };
    }


    /*
     * PAYMENT CONFIRMED EMAIL
     *
     * NEW:
     * This is sent after Square reports
     * the payment as COMPLETED.
     */
    if (
      event ===
      "payment_confirmed"
    ) {
      mailPayload
        .payload
        .payment = {
          status:
            requestRow
              .payment_status ||
            "paid",

          amount:
            Number(
              requestRow
                .quote_total ||
              0,
            ),
        };
    }


    /*
     * SEND TO GOOGLE APPS SCRIPT
     */
    const mailResponse =
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
            JSON.stringify(
              mailPayload,
            ),
        },
      );


    const mailText =
      await mailResponse
        .text();


    let mailResult:
      any;


    try {
      mailResult =
        JSON.parse(
          mailText,
        );

    } catch {
      mailResult = {
        ok: false,
        raw: mailText,
      };
    }


    if (
      !mailResponse.ok ||
      !mailResult.ok
    ) {
      console.error(
        "Mailer failed:",
        mailResult,
      );


      throw new Error(
        mailResult.error ||
        "Google Apps Script mailer failed.",
      );
    }


    /*
     * AUDIT LOG
     *
     * Both payment_requested and
     * payment_confirmed go to the customer.
     *
     * new_request goes to the business.
     */
    const recipient =
      event ===
        "payment_requested" ||
      event === "payment_confirmed" ||
      event === "customer_request_received" ||
      event.startsWith("cancellation_") ||
      event.startsWith("reschedule_")

        ? requestRow
            .customer_email

        : "signaftersix@gmail.com";


    const {
      error: auditError,
    } =
      await supabase
        .from(
          "audit_log",
        )
        .insert({
          request_id:
            requestId,

          action:
            "notification_sent",

          details: {
            event,

            channel:
              "email",

            recipient,
          },
        });


    if (auditError) {
      console.error(
        "Notification audit log failed:",
        auditError,
      );
    }


    return response({
      ok: true,
      event,
      requestId,
    });


  } catch (error) {
    console.error(
      error,
    );


    return response(
      {
        error:
          error instanceof Error

            ? error.message

            : "Notification failed.",
      },

      400,
    );
  }
});


function response(
  body: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify(
      body,
    ),

    {
      status,

      headers: {
        "Content-Type":
          "application/json",
      },
    },
  );
}
