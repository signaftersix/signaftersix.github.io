const SITE_ORIGIN = Deno.env.get("PUBLIC_SITE_ORIGIN") || "https://signaftersix.github.io";

function headers(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin === SITE_ORIGIN ? SITE_ORIGIN : SITE_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function reply(body: unknown, status = 200, origin: string | null = SITE_ORIGIN) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers(origin), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405, origin);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const internal = serviceKey && req.headers.get("authorization") === `Bearer ${serviceKey}`;
  if (origin !== SITE_ORIGIN && !internal) return reply({ error: "Origin not allowed." }, 403, origin);

  try {
    const token = Deno.env.get("MAPBOX_ACCESS_TOKEN");
    const baseLat = Number(Deno.env.get("BUSINESS_BASE_LATITUDE"));
    const baseLng = Number(Deno.env.get("BUSINESS_BASE_LONGITUDE"));
    if (!token || !Number.isFinite(baseLat) || !Number.isFinite(baseLng)) {
      return reply({ error: "Travel routing is not configured yet.", code: "ROUTING_NOT_CONFIGURED" }, 503, origin);
    }

    const { address } = await req.json();
    const value = String(address || "").trim();
    if (value.length < 8 || value.length > 300) {
      return reply({ error: "Enter a complete Florida service address." }, 400, origin);
    }

    const query = encodeURIComponent(value);
    const geocodeUrl = `https://api.mapbox.com/search/geocode/v6/forward?q=${query}&country=US&region=FL&limit=1&proximity=${baseLng},${baseLat}&access_token=${encodeURIComponent(token)}`;
    const geocode = await fetch(geocodeUrl);
    const geocodeBody = await geocode.json();
    const feature = geocodeBody?.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (!geocode.ok || !Array.isArray(coordinates) || coordinates.length < 2) {
      return reply({ error: "That Florida address could not be located. Check it and try again.", code: "ADDRESS_NOT_FOUND" }, 422, origin);
    }

    const destinationLng = Number(coordinates[0]);
    const destinationLat = Number(coordinates[1]);
    const routeUrl = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${baseLng},${baseLat};${destinationLng},${destinationLat}?overview=false&alternatives=false&access_token=${encodeURIComponent(token)}`;
    const routeResponse = await fetch(routeUrl);
    const routeBody = await routeResponse.json();
    const route = routeBody?.routes?.[0];
    if (!routeResponse.ok || !route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) {
      return reply({ error: "Driving time could not be calculated for that address.", code: "ROUTE_NOT_FOUND" }, 422, origin);
    }

    const miles = Math.round((Number(route.distance) / 1609.344) * 10) / 10;
    const seconds = Math.max(60, Math.round(Number(route.duration)));
    if (miles > 75) {
      return reply({ error: "Online appointment requests are limited to 75 one-way miles.", code: "OUTSIDE_SERVICE_AREA", miles }, 422, origin);
    }

    return reply({
      ok: true,
      miles,
      travelSeconds: seconds,
      destination: feature.properties?.full_address || feature.place_name || value,
    }, 200, origin);
  } catch (error) {
    console.error("route-service-address error", error);
    return reply({ error: "Travel routing is temporarily unavailable. Please try again.", code: "ROUTING_FAILED" }, 503, origin);
  }
});
