import { createClient } from "npm:@supabase/supabase-js@2";

const WEBHOOK_URL =
  "https://sawmgfzkrhiepzyymwwr.supabase.co/functions/v1/square-webhook";


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

    const signatureKey =
      Deno.env.get(
        "SQUARE_WEBHOOK_SIGNATURE_KEY",
      );


    if (
      !supabaseUrl ||
      !serviceRoleKey
    ) {
      throw new Error(
        "Supabase configuration is incomplete.",
      );
    }


    if (!signatureKey) {
      throw new Error(
        "Square webhook signature key is not configured.",
      );
    }


    /*
     * IMPORTANT:
     *
     * Square's signature must be checked
     * against the RAW request body.
     *
     * Do not call req.json() before
     * signature verification.
     */
    const rawBody =
      await req.text();


    const squareSignature =
      req.headers.get(
        "x-square-hmacsha256-signature",
      );


    if (!squareSignature) {
      return json(
        {
          error:
            "Missing Square webhook signature.",
        },
        401,
      );
    }


    const validSignature =
      await verifySquareSignature(
        rawBody,
        squareSignature,
        signatureKey,
      );


    if (!validSignature) {
      console.error(
        "Invalid Square webhook signature.",
      );


      return json(
        {
          error:
            "Invalid webhook signature.",
        },
        401,
      );
    }


    /*
     * Signature is valid.
     * Now it is safe to parse the body.
     */
    const event =
      JSON.parse(
        rawBody,
      );


    const eventType =
      String(
        event.type ||
        "",
      );


    /*
     * We only care about Square
     * payment.updated events.
     *
     * Return 200 for other legitimate
     * Square events so Square does not
     * keep retrying them.
     */
    if (
      eventType !==
      "payment.updated"
    ) {
      return json({
        ok: true,
        ignored: true,
        eventType,
      });
    }


    const payment =
      event
        ?.data
        ?.object
        ?.payment;


    if (!payment) {
      throw new Error(
        "Square payment object is missing.",
      );
    }


    const paymentStatus =
      String(
        payment.status ||
        "",
      );


    /*
     * Only a COMPLETED Square payment
     * can confirm the appointment.
     */
    if (
      paymentStatus !==
      "COMPLETED"
    ) {
      return json({
        ok: true,
        ignored: true,
        paymentStatus,
      });
    }


    const paymentId =
      String(
        payment.id ||
        "",
      );


    const orderId =
      String(
        payment.order_id ||
        "",
      );


    if (!orderId) {
      throw new Error(
        "Square payment does not contain an order ID.",
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
     * Find the Sign After Six request
     * tied to Square's order.
     */
    const {
      data: appointment,
      error: lookupError,
    } =
      await service
        .from(
          "appointment_requests",
        )
        .select(
          [
            "id",
            "status",
            "payment_status",
            "square_order_id",
            "customer_email",
            "customer_name",
            "appointment_at",
            "quote_total",
          ].join(","),
        )
        .eq(
          "square_order_id",
          orderId,
        )
        .maybeSingle();


    if (lookupError) {
      throw lookupError;
    }


    /*
     * Square can send a legitimate event
     * belonging to another Sandbox payment.
     *
     * Return 200 instead of making Square
     * repeatedly retry an unrelated event.
     */
    if (!appointment) {
      console.warn(
        "No appointment matched Square order:",
        orderId,
      );


      return json({
        ok: true,
        ignored: true,

        reason:
          "No matching appointment.",
      });
    }


    /*
     * Determine whether this payment was
     * already processed successfully.
     *
     * IMPORTANT:
     *
     * We do NOT immediately return here.
     *
     * A previous attempt could have updated
     * the payment but then failed while
     * moving the Calendar event or sending
     * the confirmation email.
     *
     * A Square retry should be able to finish
     * those remaining jobs.
     */
    const alreadyPaid =
      appointment.status ===
        "confirmed" &&
      appointment.payment_status ===
        "paid";


    /*
     * SAFETY GATE
     *
     * For a first-time payment confirmation,
     * the appointment should be awaiting
     * payment.
     *
     * This prevents a later payment.updated
     * event from accidentally resurrecting a
     * canceled, declined, expired, completed,
     * or otherwise closed appointment.
     */
    if (
      !alreadyPaid &&
      appointment.status !==
        "awaiting_payment"
    ) {
      console.warn(
        "Completed Square payment received for appointment in unexpected status:",
        appointment.id,
        appointment.status,
      );


      return json({
        ok: true,
        ignored: true,

        requestId:
          appointment.id,

        reason:
          "Appointment is not awaiting payment.",

        currentStatus:
          appointment.status,

        paymentStatus:
          appointment.payment_status,
      });
    }


    /*
     * =====================================================
     * PAYMENT COMPLETE
     *
     * Awaiting Payment -> Confirmed / Paid
     * =====================================================
     */

    if (!alreadyPaid) {
      const {
        error: updateError,
      } =
        await service
          .from(
            "appointment_requests",
          )
          .update({
            status:
              "confirmed",

            payment_status:
              "paid",

            payment_due_at:
              null,

            expires_at:
              null,
          })
          .eq(
            "id",
            appointment.id,
          );


      if (updateError) {
        throw updateError;
      }


      /*
       * Audit the successful Square payment.
       */
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
              "square_payment_completed",

            details: {
              square_event_id:
                event.event_id ||
                event.id ||
                null,

              square_payment_id:
                paymentId ||
                null,

              square_order_id:
                orderId,

              amount_money:
                payment.amount_money ||
                null,

              payment_status:
                paymentStatus,
            },
          });


      if (auditError) {
        console.error(
          "Square payment audit error:",
          auditError,
        );
      }
    }


    /*
     * =====================================================
     * GOOGLE CALENDAR
     *
     * Pending Requests
     *        ->
     * Confirmed Appointments
     *
     * calendar-sync reads the appointment
     * directly from Supabase and knows the
     * Pending and Confirmed Google event IDs.
     *
     * It is safe to call again if Square
     * retries this webhook.
     * =====================================================
     */

    const calendarResult =
      await callInternalFunction(
        `${supabaseUrl}/functions/v1/calendar-sync`,

        serviceRoleKey,

        {
          requestId:
            appointment.id,

          event:
            "confirmed",
        },
      );


    /*
     * =====================================================
     * CUSTOMER CONFIRMATION EMAIL
     *
     * Check for our dedicated success marker
     * before sending so normal Square webhook
     * retries do not send duplicate emails.
     * =====================================================
     */

    const confirmationAlreadySent =
      await hasAuditAction(
        service,
        appointment.id,
        "payment_confirmation_email_sent",
      );


    let notificationResult:
      any = {
        skipped:
          confirmationAlreadySent,

        reason:
          confirmationAlreadySent
            ? "Confirmation email already sent."
            : null,
      };


    if (
      !confirmationAlreadySent
    ) {
      notificationResult =
        await callInternalFunction(
          `${supabaseUrl}/functions/v1/notify-status`,

          serviceRoleKey,

          {
            requestId:
              appointment.id,

            event:
              "payment_confirmed",
          },
        );


      /*
       * Add our dedicated duplicate-send
       * marker only after notify-status
       * returns successfully.
       */
      const {
        error: emailAuditError,
      } =
        await service
          .from(
            "audit_log",
          )
          .insert({
            request_id:
              appointment.id,

            action:
              "payment_confirmation_email_sent",

            details: {
              square_payment_id:
                paymentId ||
                null,

              square_order_id:
                orderId,

              square_event_id:
                event.event_id ||
                event.id ||
                null,

              recipient:
                appointment
                  .customer_email ||
                null,
            },
          });


      if (emailAuditError) {
        console.error(
          "Confirmation-email audit marker error:",
          emailAuditError,
        );
      }
    }


    /*
     * Everything required for the confirmed
     * appointment has now completed.
     */
    return json({
      ok: true,

      requestId:
        appointment.id,

      status:
        "confirmed",

      paymentStatus:
        "paid",

      calendar:
        calendarResult,

      confirmationEmail:
        notificationResult,
    });


  } catch (error) {
    console.error(
      "square-webhook error:",
      error,
    );


    /*
     * Returning a failure allows Square
     * to retry temporary downstream failures.
     *
     * The database update, Calendar move,
     * and confirmation email protections are
     * designed so a retry can safely finish
     * incomplete work.
     */
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Square webhook failed.",
      },
      500,
    );
  }
});


/* =========================================================
   INTERNAL SUPABASE FUNCTION CALL
   ========================================================= */

async function callInternalFunction(
  url: string,
  serviceRoleKey: string,
  body: unknown,
) {
  const result =
    await fetch(
      url,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${serviceRoleKey}`,
        },

        body:
          JSON.stringify(
            body,
          ),
      },
    );


  const text =
    await result.text();


  let parsed:
    any;


  try {
    parsed =
      JSON.parse(
        text,
      );

  } catch {
    throw new Error(
      `Internal function returned an invalid response: ${text}`,
    );
  }


  if (
    !result.ok ||
    !parsed?.ok
  ) {
    throw new Error(
      parsed?.error ||
      `Internal function failed with HTTP ${result.status}.`,
    );
  }


  return parsed;
}


/* =========================================================
   AUDIT CHECK
   ========================================================= */

async function hasAuditAction(
  service: any,
  requestId: string,
  action: string,
) {
  /*
   * Select "action" instead of assuming
   * audit_log's primary-key column name.
   *
   * We know "action" exists because all
   * current audit inserts use it.
   */
  const {
    data,
    error,
  } =
    await service
      .from(
        "audit_log",
      )
      .select(
        "action",
      )
      .eq(
        "request_id",
        requestId,
      )
      .eq(
        "action",
        action,
      )
      .limit(1);


  if (error) {
    console.error(
      "Audit lookup failed:",
      error,
    );


    /*
     * Do not silently assume the email
     * was sent if the audit lookup fails.
     */
    return false;
  }


  return Boolean(
    data &&
    data.length > 0
  );
}


/* =========================================================
   SQUARE SIGNATURE VALIDATION
   ========================================================= */

/*
 * Square signs:
 *
 * exact notification URL
 * +
 * exact raw request body
 *
 * using HMAC-SHA256,
 * then Base64.
 */
async function verifySquareSignature(
  rawBody: string,
  receivedSignature: string,
  signatureKey: string,
) {
  const encoder =
    new TextEncoder();


  const cryptoKey =
    await crypto.subtle.importKey(
      "raw",

      encoder.encode(
        signatureKey,
      ),

      {
        name:
          "HMAC",

        hash:
          "SHA-256",
      },

      false,

      [
        "sign",
      ],
    );


  const signedData =
    WEBHOOK_URL +
    rawBody;


  const signatureBytes =
    await crypto.subtle.sign(
      "HMAC",

      cryptoKey,

      encoder.encode(
        signedData,
      ),
    );


  const expectedSignature =
    bytesToBase64(
      new Uint8Array(
        signatureBytes,
      ),
    );


  return timingSafeEqual(
    expectedSignature,
    receivedSignature,
  );
}


/* =========================================================
   BASE64
   ========================================================= */

function bytesToBase64(
  bytes: Uint8Array,
) {
  let binary =
    "";


  for (
    let i = 0;
    i < bytes.length;
    i++
  ) {
    binary +=
      String.fromCharCode(
        bytes[i],
      );
  }


  return btoa(
    binary,
  );
}


/* =========================================================
   CONSTANT-TIME SIGNATURE COMPARISON
   ========================================================= */

function timingSafeEqual(
  a: string,
  b: string,
) {
  if (
    a.length !==
    b.length
  ) {
    return false;
  }


  let result =
    0;


  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }


  return result ===
    0;
}


/* =========================================================
   JSON RESPONSE
   ========================================================= */

function json(
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