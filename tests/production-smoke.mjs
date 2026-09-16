import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");
const requiredFunctions = [
  "accept-revised-quote", "admin-action", "admin-lifecycle", "calendar-sync",
  "check-availability", "cleanup-documents", "create-request",
  "expire-awaiting-payment", "expire-pending", "manage-request", "notify-status",
  "route-service-address", "send-reminders", "square-webhook",
];

for (const name of requiredFunctions) {
  assert(existsSync(join(root, "supabase/functions", name, "index.ts")), `Missing function: ${name}`);
}

const config = read("config.js");
assert(config.includes("ENABLE_SECURE_ROUTING: true"));
assert(!config.includes("MAPBOX_PUBLIC_TOKEN"));

const app = read("assets/app.js");
assert(app.includes("route-service-address"));
assert(app.includes("travel time to be verified before submitting"));

const migration = read("supabase/production-readiness-migration.sql");
for (const expected of ["management_token_hash", "cancel_requested", "reschedule_requested", "has_booking_conflict", "interval '24 hours'", "interval '7 days'"]) {
  assert(migration.includes(expected), `Migration is missing ${expected}`);
}

const createRequest = read("supabase/functions/create-request/index.ts");
assert(createRequest.includes("management_token_hash"));
assert(createRequest.includes("calculateServerQuote"));
assert(createRequest.includes("route-service-address"));

const square = read("supabase/functions/square-webhook/index.ts");
assert(square.includes("SQUARE_WEBHOOK_SIGNATURE_KEY"));
assert(square.includes("crypto.subtle.sign"));
assert(square.includes("timingSafeEqual"));

const mailer = read("apps-script-mailer/Code.gs");
for (const event of ["customer_request_received", "revised_quote", "cancellation_approved", "reschedule_approved"]) {
  assert(mailer.includes(event), `Mailer is missing ${event}`);
}

for (const htmlName of readdirSync(root).filter((name) => name.endsWith(".html"))) {
  const html = read(htmlName);
  for (const match of html.matchAll(/(?:src|href)=["']([^"'#?]+)["']/g)) {
    const asset = match[1];
    if (/^(?:https?:|mailto:|tel:)/.test(asset) || asset.endsWith(".html") || asset.includes("${")) continue;
    assert(existsSync(join(root, asset)), `${htmlName} references missing local asset ${asset}`);
  }
}

console.log(`Production smoke checks passed for ${requiredFunctions.length} Edge Functions.`);
