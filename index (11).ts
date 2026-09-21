import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const publicSiteOrigin =
    Deno.env.get(
      "PUBLIC_SITE_ORIGIN",
    ) ||
    "https://signaftersix.github.io";

  const origin =
    req.headers.get(
      "origin",
    ) || "";

  const corsHeaders =
    buildCorsHeaders(
      origin,
      publicSiteOrigin,
    );


  /*
   * Browser preflight.
   */
  if (
    req.method ===
    "OPTIONS"
  ) {
    if (
      origin &&
      origin !==
        publicSiteOrigin
    ) {
      return json(
        {
          error:
            "Origin not allowed.",
        },
        403,
        corsHeaders,
      );
    }

    return new Response(
      null,
      {
        status: 204,
        headers:
          corsHeaders,
      },
    );
  }


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
      corsHeaders,
    );
  }


  try {
    const mailerUrl =
      Deno.env.get(
        "MAILER_WEB_APP_URL",
      );

    const mailerSecret =
      Deno.env.get(
        "MAILER_SHARED_SECRET",
      );

    const serviceRoleKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY",
      );


    if (
      !mailerUrl ||
      !mailerSecret
    ) {
      throw new Error(
        "Required environment configuration is missing.",
      );
    }


    /*
     * This endpoint supports two trusted call paths:
     *
     * 1. the public Sign After Six website
     *    from the exact allowed Origin;
     *
     * 2. internal Supabase functions using
     *    the service-role Authorization header.
     *
     * The response contains availability only.
     * It never returns Calendar titles, customers,
     * addresses, descriptions, or event IDs.
     */
    const authorization =
      req.headers.get(
        "authorization",
      ) || "";

    const isInternal =
      Boolean(
        serviceRoleKey &&
        authorization ===
          `Bearer ${serviceRoleKey}`,
      );

    const isPublicSite =
      Boolean(
        origin &&
        origin ===
          publicSiteOrigin,
      );


    if (
      !isInternal &&
      !isPublicSite
    ) {
      return json(
        {
          error:
            "Unauthorized",
        },
        401,
        corsHeaders,
      );
    }


    const body =
      await req.json();


    const appointmentAt =
      String(
        body.appointmentAt ||
        "",
      ).trim();

    const durationMinutes =
      Number(
        body.durationMinutes ??
        30,
      );

    const travelSeconds =
      Number(
        body.travelSeconds ??
        0,
      );


    if (
      !appointmentAt
    ) {
      return json(
        {
          error:
            "appointmentAt is required.",
        },
        400,
        corsHeaders,
      );
    }


    const appointmentDate =
      new Date(
        appointmentAt,
      );


    if (
      Number.isNaN(
        appointmentDate.getTime(),
      )
    ) {
      return json(
        {
          error:
            "appointmentAt must be a valid date/time.",
        },
        400,
        corsHeaders,
      );
    }


    /*
     * Normal Sign After Six appointments are
     * 30, 45, or 60 minutes. The wider limit
     * leaves room for future manual exceptions
     * without allowing unbounded Calendar scans.
     */
    if (
      !Number.isFinite(
        durationMinutes,
      ) ||
      durationMinutes < 30 ||
      durationMinutes > 180
    ) {
      return json(
        {
          error:
            "durationMinutes must be between 30 and 180.",
        },
        400,
        corsHeaders,
      );
    }


    /*
     * Travel is one-way seconds.
     * Six hours is deliberately generous and
     * prevents abusive requests for huge ranges.
     */
    if (
      !Number.isFinite(
        travelSeconds,
      ) ||
      travelSeconds < 0 ||
      travelSeconds >
        21600
    ) {
      return json(
        {
          error:
            "travelSeconds must be between 0 and 21600.",
        },
        400,
        corsHeaders,
      );
    }


    /*
     * Public callers cannot tell the checker
     * to ignore Calendar events.
     *
     * Internal functions may provide IDs later
     * for a legitimate reschedule/update check.
     */
    const ignoreEventIds =
      isInternal &&
      Array.isArray(
        body.ignoreEventIds,
      )
        ? body.ignoreEventIds
            .slice(
              0,
              10,
            )
            .map(
              (value: unknown) =>
                String(
                  value || "",
                ).trim(),
            )
            .filter(
              Boolean,
            )
        : [];


    const payload = {
      request: {
        appointmentAt:
          appointmentDate
            .toISOString(),

        travelSeconds:
          Math.round(
            travelSeconds,
          ),

        durationMinutes:
          Math.round(
            durationMinutes,
          ),
      },

      calendar: {},

      ignoreEventIds:
        ignoreEventIds,
    };

    /* Database blocks complement Google Calendar and make the admin
       Block Availability control enforceable even before Calendar sync. */
    if (serviceRoleKey) {
      const service = createClient(Deno.env.get("SUPABASE_URL")!, serviceRoleKey, { auth: { persistSession: false } });
      const blockStart = new Date(appointmentDate.getTime() - Math.round(travelSeconds) * 1000);
      const blockEnd = new Date(appointmentDate.getTime() + Math.round(durationMinutes) * 60000 + Math.round(travelSeconds) * 1000);
      const { data: manualBlocks, error: blockError } = await service.from("availability_blocks").select("id").lt("starts_at", blockEnd.toISOString()).gt("ends_at", blockStart.toISOString()).limit(1);
      if (blockError) throw blockError;
      if (manualBlocks?.length) return json({ ok: true, available: false, blockStart: blockStart.toISOString(), blockEnd: blockEnd.toISOString() }, 200, corsHeaders);

      const ignoreRequestId = isInternal ? String(body.ignoreRequestId || "") : "";
      const { data: conflict, error: activeError } = await service.rpc("has_booking_conflict", { proposed_start: blockStart.toISOString(), proposed_end: blockEnd.toISOString(), ignore_request_id: ignoreRequestId || null });
      if (activeError) throw activeError;
      if (conflict) return json({ ok: true, available: false, blockStart: blockStart.toISOString(), blockEnd: blockEnd.toISOString() }, 200, corsHeaders);
    }


    /*
     * Ask the existing Apps Script to check
     * both Sign After Six calendars.
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
                "calendar_availability",

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
        `Google Apps Script availability request failed (${response.status}).`,
      );
    }


    const result =
      appsScriptResult.result ||
      {};


    if (
      typeof result.available !==
      "boolean"
    ) {
      throw new Error(
        "Google Apps Script did not return a valid availability result.",
      );
    }


    /*
     * Deliberately sanitize the response.
     * Customers only need to know whether
     * this proposed block is available.
     */
    return json(
      {
        ok: true,

        available:
          result.available,

        blockStart:
          result.blockStart ||
          null,

        appointmentStart:
          result.appointmentStart ||
          null,

        appointmentEnd:
          result.appointmentEnd ||
          null,

        blockEnd:
          result.blockEnd ||
          null,
      },
      200,
      corsHeaders,
    );


  } catch (error) {
    console.error(
      "check-availability error:",
      error,
    );


    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Availability check failed.",
      },
      500,
      corsHeaders,
    );
  }
});


function buildCorsHeaders(
  origin: string,
  publicSiteOrigin: string,
) {
  const allowOrigin =
    origin ===
    publicSiteOrigin
      ? origin
      : publicSiteOrigin;


  return {
    "Access-Control-Allow-Origin":
      allowOrigin,

    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",

    "Access-Control-Allow-Methods":
      "POST, OPTIONS",

    "Cache-Control":
      "no-store",

    "Vary":
      "Origin",
  };
}


function json(
  body: unknown,
  status = 200,
  extraHeaders:
    Record<string, string> = {},
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

        ...extraHeaders,
      },
    },
  );
}
