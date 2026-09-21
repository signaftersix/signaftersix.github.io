import { createClient } from "npm:@supabase/supabase-js@2";

const SQUARE_VERSION = "2026-08-19";

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
      Deno.env.get("SUPABASE_URL");

    const serviceRoleKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY",
      );

    const secretKeysRaw =
      Deno.env.get(
        "SUPABASE_SECRET_KEYS",
      ) || "{}";

    const squareEnvironment =
      Deno.env.get(
        "SQUARE_ENVIRONMENT",
      ) || "sandbox";

    const squareAccessToken =
      Deno.env.get(
        "SQUARE_ACCESS_TOKEN",
      );

    if (
      !supabaseUrl ||
      !serviceRoleKey ||
      !squareAccessToken
    ) {
      throw new Error(
        "Required environment configuration is missing.",
      );
    }

    /*
     * INTERNAL AUTHORIZATION
     *
     * Existing internal callers may use the
     * legacy service-role Bearer credential.
     *
     * Database/Cron callers may use a modern
     * Supabase sb_secret_... key in `apikey`.
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
          error: "Unauthorized",
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
            persistSession: false,
          },
        },
      );

    const squareBase =
      squareEnvironment ===
        "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";

    /*
     * Freeze the eligibility cutoff for this
     * run. A request must have been due by
     * this instant to be processed.
     */
    const checkedAt =
      new Date().toISOString();

    const candidateResult =
      await supabaseQueryWithRetry(
        "load due awaiting-payment candidates",
        () =>
          service
            .from(
              "appointment_requests",
            )
            .select(
              [
                "id",
                "status",
                "payment_due_at",
                "payment_status",
                "square_payment_link_id",
                "square_order_id",
                "pending_calendar_event_id",
                "confirmed_calendar_event_id",
              ].join(","),
            )
            .eq(
              "status",
              "awaiting_payment",
            )
            .eq(
              "payment_status",
              "unpaid",
            )
            .not(
              "payment_due_at",
              "is",
              null,
            )
            .lte(
              "payment_due_at",
              checkedAt,
            )
            .order(
              "payment_due_at",
              {
                ascending: true,
              },
            )
            .limit(5),
      );

    const candidates =
      candidateResult.data || [];

    const results:
      any[] = [];

    let expiredCount = 0;
    let squareCompletedCount = 0;
    let cancelledAtSquareCount = 0;
    let skippedCount = 0;
    let failureCount = 0;
    let calendarReleasedCount = 0;
    let calendarReleaseFailureCount =
      0;

    for (
      const candidate
      of candidates || []
    ) {
      try {
        const result =
          await processCandidate({
            service,
            supabaseUrl,
            serviceRoleKey,
            squareBase,
            squareAccessToken,
            checkedAt,
            candidate,
          });

        results.push(result);

        if (
          result.result ===
          "expired"
        ) {
          expiredCount += 1;
        }

        if (
          result.squareState ===
          "COMPLETED"
        ) {
          squareCompletedCount +=
            1;
        }

        if (
          result.squareCancelled ===
          true
        ) {
          cancelledAtSquareCount +=
            1;
        }

        if (
          result.result ===
          "skipped"
        ) {
          skippedCount += 1;
        }

        if (
          result.calendarReleased ===
          true
        ) {
          calendarReleasedCount +=
            1;
        }

        if (
          result.calendarReleaseFailed ===
          true
        ) {
          calendarReleaseFailureCount +=
            1;
        }
      } catch (error) {
        failureCount += 1;

        console.error(
          "awaiting-payment expiration candidate failed:",
          candidate?.id,
          error,
        );

        results.push({
          requestId:
            candidate?.id ||
            null,
          result:
            "error",
          error:
            formatError(error),
        });

        await insertAuditBestEffort(
          service,
          candidate?.id,
          "payment_expiration_error",
          {
            checked_at:
              checkedAt,
            error:
              formatError(error),
          },
        );
      }
    }

    return json({
      ok: true,
      checkedAt,
      candidatesFound:
        candidates?.length || 0,
      expiredCount,
      squareCompletedCount,
      cancelledAtSquareCount,
      skippedCount,
      failureCount,
      calendarReleasedCount,
      calendarReleaseFailureCount,
      results,
    });
  } catch (error) {
    console.error(
      "expire-awaiting-payment error:",
      error,
    );

    return json(
      {
        error:
          formatError(error) ||
          "Awaiting-payment expiration failed.",
      },
      500,
    );
  }
});


async function processCandidate(
  args: {
    service: any;
    supabaseUrl: string;
    serviceRoleKey: string;
    squareBase: string;
    squareAccessToken: string;
    checkedAt: string;
    candidate: any;
  },
) {
  const {
    service,
    supabaseUrl,
    serviceRoleKey,
    squareBase,
    squareAccessToken,
    checkedAt,
    candidate,
  } = args;

  const requestId =
    String(
      candidate.id || "",
    );

  if (!requestId) {
    throw new Error(
      "Candidate request ID is missing.",
    );
  }

  /*
   * Re-read immediately before Square
   * reconciliation so an admin/webhook
   * change after the initial query wins.
   */
  const currentResult =
    await supabaseQueryWithRetry(
      "reload awaiting-payment request",
      () =>
        service
          .from(
            "appointment_requests",
          )
          .select(
            [
              "id",
              "status",
              "payment_due_at",
              "payment_status",
              "square_payment_link_id",
              "square_order_id",
              "pending_calendar_event_id",
              "confirmed_calendar_event_id",
            ].join(","),
          )
          .eq(
            "id",
            requestId,
          )
          .maybeSingle(),
    );

  const current =
    currentResult.data;

  if (!current) {
    return {
      requestId,
      result: "skipped",
      reason:
        "request_missing",
    };
  }

  if (
    current.status !==
      "awaiting_payment" ||
    current.payment_status !==
      "unpaid" ||
    !current.payment_due_at ||
    new Date(
      current.payment_due_at,
    ).getTime() >
      new Date(
        checkedAt,
      ).getTime()
  ) {
    return {
      requestId,
      result: "skipped",
      reason:
        "no_longer_due",
    };
  }

  const paymentLinkId =
    String(
      current
        .square_payment_link_id ||
      "",
    );

  const orderId =
    String(
      current.square_order_id ||
      "",
    );

  /*
   * Fail closed if the Square identifiers
   * are missing. Never free the slot unless
   * Square can be reconciled first.
   */
  if (
    !paymentLinkId ||
    !orderId
  ) {
    throw new Error(
      "Square payment link/order identifiers are missing; request was not expired.",
    );
  }

  /*
   * First check the Square order.
   *
   * COMPLETED is fully paid and terminal,
   * so a completed order must never be
   * expired by this worker.
   */
  let orderState =
    await retrieveSquareOrderState(
      squareBase,
      squareAccessToken,
      orderId,
    );

  if (
    orderState ===
    "COMPLETED"
  ) {
    /*
     * Give the payment webhook time to
     * finish the normal confirmation path.
     * This also prevents repeated Square
     * checks every five minutes if the
     * webhook is briefly delayed.
     */
    const graceUntil =
      new Date(
        Date.now() +
        15 *
          60 *
          1000,
      ).toISOString();

    await service
      .from(
        "appointment_requests",
      )
      .update({
        payment_due_at:
          graceUntil,
      })
      .eq(
        "id",
        requestId,
      )
      .eq(
        "status",
        "awaiting_payment",
      )
      .eq(
        "payment_status",
        "unpaid",
      );

    await insertAuditBestEffort(
      service,
      requestId,
      "payment_expiration_skipped_square_completed",
      {
        square_order_id:
          orderId,
        checked_at:
          checkedAt,
        grace_until:
          graceUntil,
      },
    );

    return {
      requestId,
      result: "skipped",
      reason:
        "square_order_completed",
      squareState:
        "COMPLETED",
      graceUntil,
    };
  }

  let squareCancelled =
    orderState ===
      "CANCELED";

  /*
   * OPEN (or another non-terminal payable
   * state) must be shut down at Square
   * before we release the appointment.
   *
   * Square's DeletePaymentLink cancels the
   * corresponding checkout order.
   */
  if (!squareCancelled) {
    const deleteResult =
      await deleteSquarePaymentLink(
        squareBase,
        squareAccessToken,
        paymentLinkId,
      );

    if (
      deleteResult.ok
    ) {
      squareCancelled = true;
      orderState =
        "CANCELED";
    } else {
      /*
       * A payment could have completed in
       * the tiny interval between the first
       * Square lookup and the delete call.
       * Re-read the order before deciding.
       */
      orderState =
        await retrieveSquareOrderState(
          squareBase,
          squareAccessToken,
          orderId,
        );

      if (
        orderState ===
        "COMPLETED"
      ) {
        const graceUntil =
          new Date(
            Date.now() +
            15 *
              60 *
              1000,
          ).toISOString();

        await service
          .from(
            "appointment_requests",
          )
          .update({
            payment_due_at:
              graceUntil,
          })
          .eq(
            "id",
            requestId,
          )
          .eq(
            "status",
            "awaiting_payment",
          )
          .eq(
            "payment_status",
            "unpaid",
          );

        await insertAuditBestEffort(
          service,
          requestId,
          "payment_expiration_skipped_square_completed",
          {
            square_order_id:
              orderId,
            checked_at:
              checkedAt,
            grace_until:
              graceUntil,
            note:
              "Square became completed during expiration reconciliation.",
          },
        );

        return {
          requestId,
          result: "skipped",
          reason:
            "square_order_completed_during_reconciliation",
          squareState:
            "COMPLETED",
          graceUntil,
        };
      }

      if (
        orderState ===
        "CANCELED"
      ) {
        squareCancelled =
          true;
      } else {
        throw new Error(
          `Square payment link could not be canceled and order remains ${orderState || "unknown"}; request was not expired.`,
        );
      }
    }
  }

  if (!squareCancelled) {
    throw new Error(
      "Square order cancellation could not be verified; request was not expired.",
    );
  }

  /*
   * Only after Square is known to be
   * canceled do we atomically expire the
   * database row.
   *
   * The status/payment/due predicates make
   * a concurrent successful webhook win.
   */
  const expireResult =
    await supabaseQueryWithRetry(
      "expire reconciled awaiting-payment request",
      () =>
        service
          .from(
            "appointment_requests",
          )
          .update({
            status:
              "expired",
            payment_due_at:
              null,
            square_payment_link_url:
              null,
          })
          .eq(
            "id",
            requestId,
          )
          .eq(
            "status",
            "awaiting_payment",
          )
          .eq(
            "payment_status",
            "unpaid",
          )
          .lte(
            "payment_due_at",
            checkedAt,
          )
          .select(
            [
              "id",
              "status",
              "pending_calendar_event_id",
              "confirmed_calendar_event_id",
            ].join(","),
          )
          .maybeSingle(),
    );

  const expired =
    expireResult.data;

  /*
   * A concurrent webhook/admin action may
   * have changed the row after Square was
   * canceled. In that case, don't force an
   * overwrite here.
   */
  if (!expired) {
    await insertAuditBestEffort(
      service,
      requestId,
      "payment_expiration_database_skip",
      {
        square_order_id:
          orderId,
        square_state:
          orderState,
        checked_at:
          checkedAt,
        reason:
          "row_changed_before_expiration_update",
      },
    );

    return {
      requestId,
      result: "skipped",
      reason:
        "database_row_changed",
      squareState:
        orderState,
      squareCancelled:
        true,
    };
  }

  await insertAuditBestEffort(
    service,
    requestId,
    "payment_window_expired",
    {
      reason:
        "payment_deadline_passed_unpaid",
      square_payment_link_id:
        paymentLinkId,
      square_order_id:
        orderId,
      square_state:
        orderState,
      expired_at:
        new Date()
          .toISOString(),
      previous_payment_due_at:
        current.payment_due_at,
    },
  );

  /*
   * Best-effort immediate Calendar release.
   *
   * If this fails, event IDs remain stored.
   * The existing expiration processor sees
   * status='expired' + event IDs and retries
   * Calendar cleanup on later Cron runs.
   */
  const calendarResult =
    await releaseCalendarBestEffort(
      supabaseUrl,
      serviceRoleKey,
      requestId,
    );

  return {
    requestId,
    result:
      "expired",
    squareState:
      orderState,
    squareCancelled:
      true,
    calendarReleased:
      calendarResult.released,
    calendarReleaseFailed:
      !calendarResult.released,
    calendarWarning:
      calendarResult.warning,
  };
}


async function retrieveSquareOrderState(
  squareBase: string,
  squareAccessToken: string,
  orderId: string,
) {
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
          `${squareBase}/v2/orders/${encodeURIComponent(
            orderId,
          )}`,
          {
            method: "GET",
            headers: {
              Authorization:
                `Bearer ${squareAccessToken}`,
              "Content-Type":
                "application/json",
              "Square-Version":
                SQUARE_VERSION,
            },
            signal:
              AbortSignal.timeout(
                8000,
              ),
          },
        );

      const body =
        await response
          .json()
          .catch(
            () => ({}),
          );

      if (response.ok) {
        const state =
          String(
            body?.order?.state ||
            "",
          );

        if (!state) {
          throw new Error(
            "Square order lookup returned no order state.",
          );
        }

        return state;
      }

      const detail =
        body?.errors?.[0]
          ?.detail ||
        `Square order lookup failed (${response.status}).`;

      const retryable =
        response.status === 429 ||
        response.status >= 500;

      if (
        !retryable ||
        attempt === 3
      ) {
        throw new Error(
          detail,
        );
      }

      lastError =
        new Error(detail);

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
      attempt * 750,
    );
  }

  throw (
    lastError ||
    new Error(
      "Square order lookup failed.",
    )
  );
}

async function deleteSquarePaymentLink(
  squareBase: string,
  squareAccessToken: string,
  paymentLinkId: string,
) {
  let lastStatus:
    number | null = null;

  let lastBody:
    any = {};

  for (
    let attempt = 1;
    attempt <= 3;
    attempt += 1
  ) {
    try {
      const response =
        await fetch(
          `${squareBase}/v2/online-checkout/payment-links/${encodeURIComponent(
            paymentLinkId,
          )}`,
          {
            method:
              "DELETE",
            headers: {
              Authorization:
                `Bearer ${squareAccessToken}`,
              "Content-Type":
                "application/json",
              "Square-Version":
                SQUARE_VERSION,
            },
            signal:
              AbortSignal.timeout(
                8000,
              ),
          },
        );

      const body =
        await response
          .json()
          .catch(
            () => ({}),
          );

      if (response.ok) {
        return {
          ok: true,
          body,
        };
      }

      lastStatus =
        response.status;

      lastBody =
        body;

      const retryable =
        response.status === 429 ||
        response.status >= 500;

      if (
        !retryable ||
        attempt === 3
      ) {
        break;
      }

    } catch (error) {
      if (
        attempt === 3 ||
        !isTransientError(
          error,
        )
      ) {
        console.error(
          "Square DeletePaymentLink failed:",
          error,
        );

        return {
          ok: false,
          status:
            lastStatus,
          body:
            lastBody,
        };
      }
    }

    await sleep(
      attempt * 750,
    );
  }

  console.error(
    "Square DeletePaymentLink failed:",
    lastStatus,
    lastBody,
  );

  return {
    ok: false,
    status:
      lastStatus,
    body:
      lastBody,
  };
}

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


async function insertAuditBestEffort(
  service: any,
  requestId: string | null | undefined,
  action: string,
  details: Record<
    string,
    unknown
  >,
) {
  if (!requestId) {
    return;
  }

  const {
    error,
  } =
    await service
      .from(
        "audit_log",
      )
      .insert({
        request_id:
          requestId,
        action,
        details,
      });

  if (error) {
    console.error(
      "Audit insert failed:",
      action,
      requestId,
      error,
    );
  }
}


async function supabaseQueryWithRetry(
  label: string,
  operation: () => PromiseLike<any>,
) {
  let lastResult:
    any = null;

  for (
    let attempt = 1;
    attempt <= 3;
    attempt += 1
  ) {
    const result =
      await operation();

    lastResult =
      result;

    if (!result?.error) {
      return result;
    }

    if (
      attempt === 3 ||
      !isTransientError(
        result.error,
      )
    ) {
      throw result.error;
    }

    console.warn(
      `${label} transient failure; retrying`,
      {
        attempt,
        error:
          formatError(
            result.error,
          ),
      },
    );

    await sleep(
      attempt * 750,
    );
  }

  throw (
    lastResult?.error ||
    new Error(
      `${label} failed.`,
    )
  );
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
      "timed out",
    ) ||
    message.includes(
      "timeout",
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
