import { createClient } from "npm:@supabase/supabase-js@2";

const SITE_ORIGIN = "https://signaftersix.github.io";
const SUPPORT_EMAIL = "signaftersix@gmail.com";

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin":
      origin === SITE_ORIGIN ? origin : SITE_ORIGIN,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function send(
  body: unknown,
  status = 200,
  origin: string | null = SITE_ORIGIN,
) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        ...cors(origin),
        "Content-Type": "application/json",
      },
    },
  );
}

async function sha256(value: string) {
  const bytes =
    new TextEncoder().encode(value);

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      bytes,
    );

  return Array.from(
    new Uint8Array(digest),
  )
    .map((b) =>
      b.toString(16).padStart(2, "0")
    )
    .join("");
}


Deno.serve(async (req) => {
  const origin =
    req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(
      "ok",
      {
        headers: cors(origin),
      },
    );
  }

  if (req.method !== "POST") {
    return send(
      {
        error:
          "Method not allowed",
      },
      405,
      origin,
    );
  }

  try {
    const supabaseUrl =
      Deno.env.get(
        "SUPABASE_URL",
      );

    const anonKey =
      Deno.env.get(
        "SUPABASE_ANON_KEY",
      );

    const serviceRoleKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY",
      );

    if (
      !supabaseUrl ||
      !anonKey ||
      !serviceRoleKey
    ) {
      throw new Error(
        "Supabase configuration is incomplete.",
      );
    }


    /*
     * VERIFY SIGNED-IN ADMIN
     */
    const authHeader =
      req.headers.get(
        "authorization",
      );

    if (
      !authHeader ||
      !authHeader.startsWith(
        "Bearer ",
      )
    ) {
      return send(
        {
          error:
            "Not signed in.",
        },
        401,
        origin,
      );
    }


    const adminClient =
      createClient(
        supabaseUrl,
        anonKey,
        {
          global: {
            headers: {
              Authorization:
                authHeader,
            },
          },

          auth: {
            persistSession:
              false,
          },
        },
      );


    const {
      data: {
        user,
      },
      error:
        userError,
    } =
      await adminClient
        .auth
        .getUser();


    if (
      userError ||
      !user
    ) {
      return send(
        {
          error:
            "Invalid login session.",
        },
        401,
        origin,
      );
    }


    /*
     * is_admin() also checks MFA AAL2
     */
    const {
      data:
        isAdmin,
      error:
        adminError,
    } =
      await adminClient
        .rpc(
          "is_admin",
        );


    if (
      adminError ||
      isAdmin !== true
    ) {
      return send(
        {
          error:
            "Admin authorization and MFA are required.",
        },
        403,
        origin,
      );
    }


    /*
     * PRIVATE SERVICE CLIENT
     */
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


    /*
     * REQUEST BODY
     */
    const body =
      await req.json();

    const requestId =
      String(
        body.requestId ||
        "",
      );

    const action =
      String(
        body.action ||
        "",
      );

    const comment =
      String(
        body.comment ||
        "",
      )
        .trim()
        .slice(
          0,
          4000,
        );

    const revisedTotal =
      Number(
        body.revisedTotal,
      );


    if (!requestId) {
      throw new Error(
        "Missing request ID.",
      );
    }


    if (
      action !== "approve" &&
      action !== "decline" &&
      action !== "complete"
    ) {
      throw new Error(
        "Unsupported admin action.",
      );
    }


    /*
     * Only approval needs a reviewed quote.
     * Decline / complete should not fail merely
     * because revisedTotal is omitted.
     */
    if (
      action === "approve" &&
      (
        !Number.isFinite(
          revisedTotal,
        ) ||
        revisedTotal < 0
      )
    ) {
      throw new Error(
        "Invalid reviewed quote.",
      );
    }


    /*
     * LOAD REQUEST
     *
     * Use an array result instead of PostgREST
     * singular-object coercion. This avoids
     * PGRST116 when a lookup returns zero rows.
     */
    const {
      data:
        requestRows,
      error:
        requestError,
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
        .limit(1);


    if (requestError) {
      throw requestError;
    }


    const record =
      requestRows &&
      requestRows.length
        ? requestRows[0]
        : null;


    if (!record) {
      return send(
        {
          error:
            "Appointment request not found.",
        },
        404,
        origin,
      );
    }


    /*
     * MARK CONFIRMED APPOINTMENT COMPLETED
     *
     * Completion is intentionally manual.
     * A scheduled time passing does not prove
     * the appointment actually occurred.
     *
     * Database triggers handle:
     * - completed_at
     * - locking uploaded documents
     * - delete_after = completed_at + 7 days
     *
     * The Confirmed Google Calendar event is
     * intentionally left in place as history.
     */
    if (
      action === "complete"
    ) {
      /*
       * Idempotent retry behavior.
       * Never restart the retention clock.
       */
      if (
        record.status ===
        "completed"
      ) {
        return send(
          {
            ok: true,

            status:
              "completed",

            completedAt:
              record.completed_at ||
              null,

            message:
              "Appointment was already marked completed.",
          },
          200,
          origin,
        );
      }


      if (
        record.status !==
        "confirmed"
      ) {
        return send(
          {
            error:
              "Only a confirmed appointment can be marked completed.",
          },
          409,
          origin,
        );
      }


      const appointmentAt =
        new Date(
          record.appointment_at,
        );


      if (
        Number.isNaN(
          appointmentAt.getTime(),
        )
      ) {
        return send(
          {
            error:
              "The appointment has an invalid scheduled time and cannot be marked completed.",
          },
          409,
          origin,
        );
      }


      /*
       * Prevent an accidental early click from
       * starting the 7-day retention clock.
       */
      if (
        appointmentAt.getTime() >
        Date.now()
      ) {
        return send(
          {
            error:
              "This appointment cannot be marked completed before its scheduled start time.",
          },
          409,
          origin,
        );
      }


      const {
        data:
          completedRows,
        error:
          completionError,
      } =
        await service
          .from(
            "appointment_requests",
          )
          .update({
            status:
              "completed",

            admin_comments:
              comment ||
              record.admin_comments ||
              null,
          })
          .eq(
            "id",
            requestId,
          )
          .eq(
            "status",
            "confirmed",
          )
          .select(
            "id,status,completed_at",
          );


      if (completionError) {
        throw completionError;
      }


      const completedRecord =
        completedRows &&
        completedRows.length
          ? completedRows[0]
          : null;


      /*
       * A concurrent status change wins rather
       * than being overwritten.
       *
       * If the update returned no row, re-read the
       * record without singular-object coercion so
       * retries remain idempotent.
       */
      if (!completedRecord) {
        const {
          data:
            currentRows,
          error:
            currentError,
        } =
          await service
            .from(
              "appointment_requests",
            )
            .select(
              "id,status,completed_at",
            )
            .eq(
              "id",
              requestId,
            )
            .limit(1);


        if (currentError) {
          throw currentError;
        }


        const currentRecord =
          currentRows &&
          currentRows.length
            ? currentRows[0]
            : null;


        if (
          currentRecord &&
          currentRecord.status ===
            "completed"
        ) {
          return send(
            {
              ok: true,

              status:
                "completed",

              completedAt:
                currentRecord
                  .completed_at ||
                null,

              message:
                "Appointment was already marked completed.",
            },
            200,
            origin,
          );
        }


        return send(
          {
            error:
              "The appointment status changed before completion could be saved. Refresh and try again.",
          },
          409,
          origin,
        );
      }


      const {
        error:
          completionAuditError,
      } =
        await service
          .from(
            "audit_log",
          )
          .insert({
            actor_user_id:
              user.id,

            request_id:
              requestId,

            action:
              "request_completed",

            details: {
              appointment_at:
                record.appointment_at,

              completed_at:
                completedRecord
                  .completed_at ||
                null,

              document_retention_days:
                7,

              comment:
                comment ||
                null,
            },
          });


      if (completionAuditError) {
        /*
         * Completion itself is already saved.
         * Do not reverse it because a secondary
         * audit insert failed.
         */
        console.error(
          "Completion audit log error:",
          completionAuditError,
        );
      }


      return send(
        {
          ok: true,

          status:
            "completed",

          completedAt:
            completedRecord
              .completed_at ||
            null,

          documentRetentionDays:
            7,

          message:
            "Appointment marked completed. Uploaded documents are scheduled for deletion 7 days after completion.",
        },
        200,
        origin,
      );
    }


    /*
     * DECLINE
     */
    if (
      action === "decline"
    ) {
      if (
        record.status ===
        "declined"
      ) {
        /*
         * Retry-safe cleanup.
         *
         * An older decline may have succeeded in the
         * database while Calendar cleanup failed.
         * Calling release again is safe because
         * calendar-sync / Apps Script treat an
         * already-removed event as success.
         */
        const calendarRelease =
          await releaseCalendarBestEffort(
            supabaseUrl,
            serviceRoleKey,
            requestId,
          );

        return send(
          {
            ok: true,

            status:
              "declined",

            calendarReleased:
              calendarRelease.released,

            warning:
              calendarRelease.warning,

            message:
              calendarRelease.released
                ? "Request was already declined. Calendar hold is released."
                : "Request was already declined, but the calendar hold could not be verified as released.",
          },
          200,
          origin,
        );
      }


      const {
        error:
          declineError,
      } =
        await service
          .from(
            "appointment_requests",
          )
          .update({
            status:
              "declined",

            admin_comments:
              comment ||
              null,

            expires_at:
              null,
          })
          .eq(
            "id",
            requestId,
          );


      if (declineError) {
        throw declineError;
      }


      await service
        .from(
          "audit_log",
        )
        .insert({
          actor_user_id:
            user.id,

          request_id:
            requestId,

          action:
            "request_declined",

          details: {
            comment:
              comment ||
              null,
          },
        });


      /*
       * Release the Pending / Confirmed Calendar
       * event after the request is safely marked
       * declined in the database.
       *
       * Calendar cleanup is best-effort so a
       * temporary Google failure never resurrects
       * or prevents the decline itself.
       *
       * Repeating Decline later retries this cleanup.
       */
      const calendarRelease =
        await releaseCalendarBestEffort(
          supabaseUrl,
          serviceRoleKey,
          requestId,
        );


      return send(
        {
          ok: true,

          status:
            "declined",

          calendarReleased:
            calendarRelease.released,

          warning:
            calendarRelease.warning,

          message:
            calendarRelease.released
              ? "Request declined and calendar hold released."
              : "Request declined, but the calendar hold could not be released automatically.",
        },
        200,
        origin,
      );
    }


    /*
     * DON'T CREATE A SECOND
     * PAYMENT LINK
     */
    if (
      record.status ===
      "awaiting_payment"
    ) {
      return send(
        {
          ok: true,
          status:
            "awaiting_payment",

          paymentUrl:
            record
              .square_payment_link_url ||
            null,

          message:
            "This request is already awaiting payment.",
        },
        200,
        origin,
      );
    }


    /*
     * DOCUMENT MUST EXIST
     * BEFORE APPROVAL
     */
    const {
      count:
        documentCount,
      error:
        documentError,
    } =
      await service
        .from(
          "request_documents",
        )
        .select(
          "id",
          {
            count:
              "exact",
            head:
              true,
          },
        )
        .eq(
          "request_id",
          requestId,
        );


    if (documentError) {
      throw documentError;
    }


    if (!documentCount) {
      return send(
        {
          error:
            "This appointment cannot be approved until the customer uploads the document.",
        },
        409,
        origin,
      );
    }


    /*
     * QUOTE REVIEW
     */
    const oldTotal =
      Number(
        record.quote_total,
      );

    let quoteVersion =
      Number(
        record.quote_version ||
        1,
      );

    let breakdown =
      Array.isArray(
        record.quote_breakdown,
      )
        ? [
            ...record.quote_breakdown,
          ]
        : [];


    /*
     * HIGHER REVIEWED PRICE:
     * CUSTOMER MUST ACCEPT FIRST
     */
    if (
      revisedTotal >
      oldTotal + 0.001
    ) {
      quoteVersion += 1;


      const increase =
        Number(
          (
            revisedTotal -
            oldTotal
          ).toFixed(2),
        );


      breakdown.push({
        label:
          "Admin reviewed adjustment",

        amount:
          increase,
      });


      const rawToken =
        crypto
          .randomUUID()
          .replaceAll(
            "-",
            "",
          ) +
        crypto
          .randomUUID()
          .replaceAll(
            "-",
            "",
          );


      const tokenHash =
        await sha256(
          rawToken,
        );


      const expiresAt =
        new Date(
          Date.now() +
          2 *
            60 *
            60 *
            1000,
        ).toISOString();


      const {
        error:
          revisionError,
      } =
        await service
          .from(
            "quote_revisions",
          )
          .insert({
            request_id:
              requestId,

            version:
              quoteVersion,

            previous_total:
              oldTotal,

            revised_total:
              revisedTotal,

            breakdown,

            customer_acceptance_required:
              true,

            expires_at:
              expiresAt,
          });


      if (revisionError) {
        throw revisionError;
      }


      const {
        error:
          updateError,
      } =
        await service
          .from(
            "appointment_requests",
          )
          .update({
            status:
              "revised_quote",

            quote_total:
              revisedTotal,

            quote_version:
              quoteVersion,

            quote_breakdown:
              breakdown,

            admin_comments:
              comment ||
              null,

            revised_quote_expires_at:
              expiresAt,

            acceptance_token_hash:
              tokenHash,
          })
          .eq(
            "id",
            requestId,
          );


      if (updateError) {
        throw updateError;
      }


      await service
        .from(
          "audit_log",
        )
        .insert({
          actor_user_id:
            user.id,

          request_id:
            requestId,

          action:
            "quote_revised_upward",

          details: {
            previous_total:
              oldTotal,

            revised_total:
              revisedTotal,

            comment:
              comment ||
              null,
          },
        });


      const acceptanceUrl =
        `${SITE_ORIGIN}/quote-review.html` +
        `?request=${encodeURIComponent(
          requestId,
        )}` +
        `&token=${encodeURIComponent(
          rawToken,
        )}`;

      await fetch(`${supabaseUrl}/functions/v1/notify-status`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, event: "revised_quote", acceptanceUrl }),
      });


      return send(
        {
          ok: true,

          status:
            "revised_quote",

          acceptanceUrl,

          message:
            "The revised quote is higher, so customer acceptance is required before approval. It expires in 2 hours.",
        },
        200,
        origin,
      );
    }


    /*
     * LOWER REVIEWED PRICE:
     * CUSTOMER DOESN'T NEED TO ACCEPT AGAIN
     */
    if (
      revisedTotal <
      oldTotal - 0.001
    ) {
      quoteVersion += 1;


      const reduction =
        Number(
          (
            revisedTotal -
            oldTotal
          ).toFixed(2),
        );


      breakdown.push({
        label:
          "Admin reviewed adjustment",

        amount:
          reduction,
      });


      const {
        error:
          revisionError,
      } =
        await service
          .from(
            "quote_revisions",
          )
          .insert({
            request_id:
              requestId,

            version:
              quoteVersion,

            previous_total:
              oldTotal,

            revised_total:
              revisedTotal,

            breakdown,

            customer_acceptance_required:
              false,

            accepted_at:
              new Date()
                .toISOString(),
          });


      if (revisionError) {
        throw revisionError;
      }


      const {
        error:
          lowerError,
      } =
        await service
          .from(
            "appointment_requests",
          )
          .update({
            quote_total:
              revisedTotal,

            quote_version:
              quoteVersion,

            quote_breakdown:
              breakdown,

            admin_comments:
              comment ||
              null,
          })
          .eq(
            "id",
            requestId,
          );


      if (lowerError) {
        throw lowerError;
      }


      await service
        .from(
          "audit_log",
        )
        .insert({
          actor_user_id:
            user.id,

          request_id:
            requestId,

          action:
            "quote_revised_downward",

          details: {
            previous_total:
              oldTotal,

            revised_total:
              revisedTotal,
          },
        });
    }


    /*
     * SQUARE
     */
    const squareEnvironment =
      Deno.env.get(
        "SQUARE_ENVIRONMENT",
      ) ||
      "sandbox";


    const squareToken =
      Deno.env.get(
        "SQUARE_ACCESS_TOKEN",
      );


    const squareLocation =
      Deno.env.get(
        "SQUARE_LOCATION_ID",
      );


    if (
      !squareToken ||
      !squareLocation
    ) {
      throw new Error(
        "Square configuration is incomplete.",
      );
    }


    const squareBase =
      squareEnvironment ===
      "production"

        ? "https://connect.squareup.com"

        : "https://connect.squareupsandbox.com";


    const cents =
      Math.round(
        revisedTotal *
        100,
      );


    const squarePayload = {
      idempotency_key:
        `sas-${requestId}-${quoteVersion}`,

      quick_pay: {
        name:
          "Sign After Six Mobile Notary",

        price_money: {
          amount:
            cents,

          currency:
            "USD",
        },

        location_id:
          squareLocation,
      },

      description:
        `Sign After Six appointment ${requestId}`,

      payment_note:
        `Notary appointment ${requestId}`,

      checkout_options: {
        ask_for_shipping_address:
          false,

        merchant_support_email:
          SUPPORT_EMAIL,

        redirect_url:
          `${SITE_ORIGIN}/quote-review.html` +
          `?request=${encodeURIComponent(
            requestId,
          )}` +
          `&payment=return`,

        allow_tipping:
          false,
      },

      pre_populated_data: {
        buyer_email:
          record.customer_email,
      },
    };


    const squareResponse =
      await fetch(
        `${squareBase}/v2/online-checkout/payment-links`,
        {
          method:
            "POST",

          headers: {
            Authorization:
              `Bearer ${squareToken}`,

            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(
              squarePayload,
            ),
        },
      );


    const squareResult =
      await squareResponse
        .json();


    if (!squareResponse.ok) {
      console.error(
        "Square error:",
        squareResult,
      );


      const detail =
        squareResult
          ?.errors?.[0]
          ?.detail ||
        "Square could not create the payment link.";


      throw new Error(
        detail,
      );
    }


    const paymentLink =
      squareResult
        .payment_link;


    if (
      !paymentLink?.url ||
      !paymentLink?.id
    ) {
      throw new Error(
        "Square did not return a payment link.",
      );
    }


    /*
     * PAYMENT WINDOW
     */
    const appointmentTime =
      new Date(
        record.appointment_at,
      ).getTime();


    const hoursAway =
      (
        appointmentTime -
        Date.now()
      ) /
      3600000;


    /*
     * >24 hours:
     * 4-hour payment window
     *
     * <=24 hours:
     * 60-minute payment window
     */
    const paymentDueAt =
      hoursAway > 24

        ? new Date(
            Date.now() +
            4 *
              60 *
              60 *
              1000,
          ).toISOString()

        : new Date(
            Date.now() +
            60 *
              60 *
              1000,
          ).toISOString();


    /*
     * SAVE PAYMENT LINK
     */
    const {
      error:
        finalError,
    } =
      await service
        .from(
          "appointment_requests",
        )
        .update({
          status:
            "awaiting_payment",

          quote_total:
            revisedTotal,

          admin_comments:
            comment ||
            null,

          square_payment_link_id:
            paymentLink.id,

          square_payment_link_url:
            paymentLink.url,

          square_order_id:
            paymentLink.order_id ||
            null,

          payment_status:
            "unpaid",

          payment_due_at:
            paymentDueAt,

          expires_at:
            null,
        })
        .eq(
          "id",
          requestId,
        );


    if (finalError) {
      throw finalError;
    }


    await service
      .from(
        "audit_log",
      )
      .insert({
        actor_user_id:
          user.id,

        request_id:
          requestId,

        action:
          "request_approved_payment_requested",

        details: {
          quote_total:
            revisedTotal,

          payment_link_id:
            paymentLink.id,

          payment_due_at:
            paymentDueAt,

          square_environment:
            squareEnvironment,
        },
      });


    /*
     * SEND CUSTOMER APPROVAL /
     * PAYMENT EMAIL
     *
     * This is deliberately best-effort.
     *
     * If Gmail temporarily fails, the
     * Square link and appointment status
     * remain safely stored so the email
     * can be resent later.
     */
    let notificationSent =
      false;

    let notificationWarning:
      string | null =
      null;


    try {
      const notifyResponse =
        await fetch(
          `${supabaseUrl}/functions/v1/notify-status`,
          {
            method:
              "POST",

            headers: {
              Authorization:
                `Bearer ${serviceRoleKey}`,

              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                requestId,

                event:
                  "payment_requested",
              }),
          },
        );


      const notifyResult =
        await notifyResponse
          .json()
          .catch(
            () => ({}),
          );


      if (
        notifyResponse.ok &&
        notifyResult?.ok
      ) {
        notificationSent =
          true;
      } else {
        notificationWarning =
          notifyResult?.error ||
          "Payment email could not be sent.";
      }

    } catch (notifyError) {
      console.error(
        "Payment notification failed:",
        notifyError,
      );

      notificationWarning =
        "Payment link was created, but the customer email could not be sent.";
    }


    /*
     * FINAL RESPONSE
     */
    return send(
      {
        ok: true,

        status:
          "awaiting_payment",

        paymentUrl:
          paymentLink.url,

        notificationSent,

        warning:
          notificationWarning,

        message:
          notificationSent
            ? "Approved. Square payment link created and emailed to the customer."
            : "Approved. Square payment link created, but the customer email needs to be resent.",
      },
      200,
      origin,
    );


  } catch (error) {
    console.error(
      error,
    );

    return send(
      {
        error:
          error instanceof Error
            ? error.message
            : (
                error &&
                typeof error === "object" &&
                "message" in error
                  ? String(
                      (error as any).message,
                    )
                  : "Admin action failed."
              ),
      },
      400,
      origin,
    );
  }
});

async function releaseCalendarBestEffort(
  supabaseUrl: string,
  serviceRoleKey: string,
  requestId: string,
) {
  try {
    const response =
      await fetch(
        `${supabaseUrl}/functions/v1/calendar-sync`,
        {
          method:
            "POST",

          headers: {
            Authorization:
              `Bearer ${serviceRoleKey}`,

            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              requestId,

              event:
                "release",
            }),
        },
      );


    const result =
      await response
        .json()
        .catch(
          () => ({}),
        );


    if (
      response.ok &&
      result?.ok
    ) {
      return {
        released:
          true,

        warning:
          null,
      };
    }


    const warning =
      result?.error ||
      "Calendar hold could not be released.";


    console.error(
      "Calendar release failed:",
      warning,
    );


    return {
      released:
        false,

      warning:
        warning,
    };

  } catch (error) {
    console.error(
      "Calendar release failed:",
      error,
    );


    return {
      released:
        false,

      warning:
        "Calendar hold could not be released.",
    };
  }
}
