import { withSupabase } from "npm:@supabase/server";


export default {
  fetch: withSupabase(
    {
      auth:
        "secret",
    },

    async (
      req,
      ctx,
    ) => {
      if (
        req.method !==
        "POST"
      ) {
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


        if (
          !supabaseUrl ||
          !serviceRoleKey
        ) {
          throw new Error(
            "Server configuration is incomplete.",
          );
        }


        /*
         * `auth: "secret"` above is the supported
         * Supabase service-to-service authentication
         * path for sb_secret_... keys sent in `apikey`.
         *
         * ctx.supabaseAdmin is already privileged and
         * bypasses RLS for the database work below.
         */
        const service =
          ctx.supabaseAdmin;


        const now =
          new Date()
            .toISOString();


        /*
         * STEP 1
         *
         * Find Pending requests whose hold window
         * has expired.
         *
         * The batch cap keeps a single scheduled run
         * bounded. Later runs will pick up any remainder.
         */
        const {
          data:
            candidates,
          error:
            candidateError,
        } =
          await service
            .from(
              "appointment_requests",
            )
            .select(
              "id, status, expires_at, pending_calendar_event_id, confirmed_calendar_event_id",
            )
            .eq(
              "status",
              "pending",
            )
            .not(
              "expires_at",
              "is",
              null,
            )
            .lte(
              "expires_at",
              now,
            )
            .order(
              "expires_at",
              {
                ascending:
                  true,
              },
            )
            .limit(
              100,
            );


        if (candidateError) {
          throw candidateError;
        }


        const expiredIds:
          string[] = [];


        for (
          const candidate
          of candidates || []
        ) {
          /*
           * Atomic claim.
           *
           * Repeat status + expiration conditions on
           * UPDATE so an admin action occurring after
           * SELECT cannot be overwritten.
           */
          const {
            data:
              expiredRecord,
            error:
              expireError,
          } =
            await service
              .from(
                "appointment_requests",
              )
              .update({
                status:
                  "expired",

                expires_at:
                  null,
              })
              .eq(
                "id",
                candidate.id,
              )
              .eq(
                "status",
                "pending",
              )
              .not(
                "expires_at",
                "is",
                null,
              )
              .lte(
                "expires_at",
                now,
              )
              .select(
                "id",
              )
              .maybeSingle();


          if (expireError) {
            console.error(
              "Pending expiration update failed:",
              candidate.id,
              expireError,
            );

            continue;
          }


          /*
           * No returned row means something else
           * changed the request between SELECT
           * and UPDATE.
           */
          if (
            !expiredRecord
          ) {
            continue;
          }


          expiredIds.push(
            candidate.id,
          );


          const {
            error:
              auditError,
          } =
            await service
              .from(
                "audit_log",
              )
              .insert({
                request_id:
                  candidate.id,

                action:
                  "request_expired",

                details: {
                  reason:
                    "pending_hold_expired",

                  previous_expires_at:
                    candidate.expires_at,

                  expired_at:
                    now,
                },
              });


          if (auditError) {
            console.error(
              "Expiration audit log failed:",
              candidate.id,
              auditError,
            );
          }
        }


        /*
         * STEP 2
         *
         * Include previously-expired requests whose
         * Calendar event ID is still present.
         *
         * This makes cleanup retry-safe if Apps Script
         * or Google Calendar was temporarily unavailable.
         */
        const {
          data:
            retryRows,
          error:
            retryError,
        } =
          await service
            .from(
              "appointment_requests",
            )
            .select(
              "id, pending_calendar_event_id, confirmed_calendar_event_id",
            )
            .eq(
              "status",
              "expired",
            )
            .or(
              "pending_calendar_event_id.not.is.null,confirmed_calendar_event_id.not.is.null",
            )
            .limit(
              100,
            );


        if (retryError) {
          throw retryError;
        }


        const releaseIds =
          Array.from(
            new Set([
              ...expiredIds,

              ...(
                retryRows || []
              ).map(
                (row) =>
                  String(
                    row.id,
                  ),
              ),
            ]),
          );


        let releasedCount =
          0;

        const releaseFailures:
          Array<{
            requestId: string;
            error: string;
          }> = [];


        for (
          const requestId
          of releaseIds
        ) {
          try {
            /*
             * calendar-sync currently authenticates
             * trusted internal callers with the existing
             * legacy service-role Bearer credential.
             *
             * We preserve that working contract here.
             */
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
              releasedCount +=
                1;

            } else {
              const message =
                String(
                  result?.error ||
                  `Calendar release failed (${response.status}).`,
                );


              console.error(
                "Expired Calendar release failed:",
                requestId,
                message,
              );


              releaseFailures.push({
                requestId,
                error:
                  message,
              });
            }

          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Calendar release failed.";


            console.error(
              "Expired Calendar release failed:",
              requestId,
              error,
            );


            releaseFailures.push({
              requestId,
              error:
                message,
            });
          }
        }


        return json({
          ok:
            true,

          checkedAt:
            now,

          candidatesFound:
            (
              candidates || []
            ).length,

          expiredCount:
            expiredIds.length,

          calendarReleaseAttempts:
            releaseIds.length,

          calendarReleasedCount:
            releasedCount,

          calendarReleaseFailureCount:
            releaseFailures.length,

          expiredRequestIds:
            expiredIds,

          releaseFailures:
            releaseFailures,
        });


      } catch (error) {
        console.error(
          "expire-pending error:",
          error,
        );


        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Pending-expiration job failed.",
          },
          500,
        );
      }
    },
  ),
};


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

        "Cache-Control":
          "no-store",
      },
    },
  );
}
