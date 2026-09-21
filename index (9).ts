import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET =
  "notary-documents";

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

    if (
      !supabaseUrl ||
      !serviceRoleKey
    ) {
      throw new Error(
        "Required environment configuration is missing.",
      );
    }

    /*
     * INTERNAL AUTHORIZATION
     *
     * Existing internal callers:
     * Authorization: Bearer <service-role>
     *
     * Cron:
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
     * Optional internal test controls.
     *
     * dryRun=true:
     *   reports what is due without deleting.
     *
     * requestId:
     *   limits the run to one appointment.
     *
     * These are useful for safe manual QA.
     */
    const dryRun =
      body?.dryRun === true;

    const requestIdFilter =
      body?.requestId
        ? String(
            body.requestId,
          )
        : null;

    const checkedAt =
      new Date()
        .toISOString();

    let query =
      service
        .from(
          "request_documents",
        )
        .select(
          [
            "id",
            "request_id",
            "storage_path",
            "original_name",
            "mime_type",
            "byte_size",
            "locked",
            "delete_after",
            "created_at",
          ].join(","),
        )
        .not(
          "delete_after",
          "is",
          null,
        )
        .lte(
          "delete_after",
          checkedAt,
        )
        .order(
          "delete_after",
          {
            ascending: true,
          },
        )
        .limit(25);

    if (requestIdFilter) {
      query =
        query.eq(
          "request_id",
          requestIdFilter,
        );
    }

    const documentResult =
      await supabaseOperationWithRetry(
        "load due document cleanup candidates",
        async () => {
          const result =
            await query;

          if (result?.error) {
            throw result.error;
          }

          return result;
        },
      );

    const documents =
      documentResult.data || [];

    const results:
      any[] = [];

    let eligibleCount =
      0;

    let deletedCount =
      0;

    let skippedCount =
      0;

    let failureCount =
      0;

    let bytesDeleted =
      0;

    for (
      const document
      of documents || []
    ) {
      try {
        /*
         * Safety check:
         * delete_after alone is not enough.
         * The parent request must STILL be completed.
         */
        const appointmentResult =
          await supabaseOperationWithRetry(
            "load parent appointment for document cleanup",
            async () => {
              const result =
                await service
                  .from(
                    "appointment_requests",
                  )
                  .select(
                    "id,status,completed_at",
                  )
                  .eq(
                    "id",
                    document.request_id,
                  )
                  .maybeSingle();

              if (result?.error) {
                throw result.error;
              }

              return result;
            },
          );

        const appointment =
          appointmentResult.data;

        if (!appointment) {
          skippedCount +=
            1;

          results.push({
            documentId:
              document.id,

            requestId:
              document.request_id,

            result:
              "skipped",

            reason:
              "parent_request_missing",
          });

          continue;
        }

        if (
          appointment.status !==
          "completed"
        ) {
          skippedCount +=
            1;

          results.push({
            documentId:
              document.id,

            requestId:
              document.request_id,

            result:
              "skipped",

            reason:
              "request_not_completed",

            currentStatus:
              appointment.status,
          });

          continue;
        }

        if (
          !appointment.completed_at
        ) {
          skippedCount +=
            1;

          results.push({
            documentId:
              document.id,

            requestId:
              document.request_id,

            result:
              "skipped",

            reason:
              "completed_at_missing",
          });

          continue;
        }

        eligibleCount +=
          1;

        if (dryRun) {
          results.push({
            documentId:
              document.id,

            requestId:
              document.request_id,

            result:
              "would_delete",

            storagePath:
              document.storage_path,

            deleteAfter:
              document.delete_after,

            byteSize:
              Number(
                document.byte_size ||
                0,
              ),
          });

          continue;
        }

        /*
         * STORAGE FIRST.
         *
         * Metadata is never removed before
         * the actual private object deletion
         * succeeds.
         */
        await supabaseOperationWithRetry(
          "delete private storage object",
          async () => {
            const result =
              await service
                .storage
                .from(
                  BUCKET,
                )
                .remove([
                  document
                    .storage_path,
                ]);

            if (result?.error) {
              throw new Error(
                `Storage deletion failed: ${formatError(
                  result.error,
                )}`,
              );
            }

            return result;
          },
        );

        /*
         * Only after Storage succeeds do we
         * remove the database metadata row.
         */
        await supabaseOperationWithRetry(
          "delete document metadata row",
          async () => {
            const result =
              await service
                .from(
                  "request_documents",
                )
                .delete()
                .eq(
                  "id",
                  document.id,
                )
                .eq(
                  "request_id",
                  document
                    .request_id,
                );

            if (result?.error) {
              throw new Error(
                `Document metadata deletion failed: ${formatError(
                  result.error,
                )}`,
              );
            }

            return result;
          },
        );

        deletedCount +=
          1;

        bytesDeleted +=
          Number(
            document.byte_size ||
            0,
          );

        /*
         * Best-effort audit trail.
         * Do not restore a deleted document
         * merely because audit logging failed.
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
                document
                  .request_id,

              action:
                "document_retention_deleted",

              details: {
                document_id:
                  document.id,

                original_name:
                  document
                    .original_name,

                mime_type:
                  document
                    .mime_type,

                byte_size:
                  Number(
                    document
                      .byte_size ||
                    0,
                  ),

                delete_after:
                  document
                    .delete_after,

                deleted_at:
                  new Date()
                    .toISOString(),

                bucket:
                  BUCKET,
              },
            });

        if (auditError) {
          console.error(
            "Document cleanup audit insert failed:",
            document.id,
            auditError,
          );
        }

        results.push({
          documentId:
            document.id,

          requestId:
            document.request_id,

          result:
            "deleted",

          byteSize:
            Number(
              document.byte_size ||
              0,
            ),
        });

      } catch (error) {
        failureCount +=
          1;

        console.error(
          "document cleanup failed:",
          document?.id,
          error,
        );

        results.push({
          documentId:
            document?.id ||
            null,

          requestId:
            document?.request_id ||
            null,

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

      mode:
        dryRun
          ? "dry_run"
          : "delete",

      checkedAt,

      candidatesFound:
        documents?.length ||
        0,

      eligibleCount,

      deletedCount,

      skippedCount,

      failureCount,

      bytesDeleted,

      results,
    });

  } catch (error) {
    console.error(
      "cleanup-documents error:",
      error,
    );

    return json(
      {
        error:
          formatError(
            error,
          ) ||
          "Document cleanup failed.",
      },
      500,
    );
  }
});


async function supabaseOperationWithRetry(
  label: string,
  operation: () => Promise<any>,
) {
  let lastError:
    unknown = null;

  for (
    let attempt = 1;
    attempt <= 3;
    attempt += 1
  ) {
    try {
      return await operation();
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

      console.warn(
        `${label} transient failure; retrying`,
        {
          attempt,
          error:
            formatError(
              error,
            ),
        },
      );

      await sleep(
        attempt * 750,
      );
    }
  }

  throw (
    lastError ||
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
