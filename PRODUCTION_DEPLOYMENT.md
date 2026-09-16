# Sign After Six — Production Deployment

This package already contains the database migration, all Edge Functions, the
customer cancellation/rescheduling page, the admin lifecycle controls, the
private Mapbox routing proxy, notification templates, and final policy pages.

## What you still need to supply

1. A Mapbox account and a **secret** access token with Geocoding and Directions access.
2. The latitude and longitude of the business starting point. These remain Supabase secrets and are never sent to browsers.
3. Your Square production credentials when you are ready to leave sandbox.
4. The final Apps Script Web App URL and shared secret if the current values are not already working.
5. One real end-to-end test appointment and a real low-dollar/refunded Square test before taking customer traffic.

Do not send any secret values in chat or commit them to GitHub.

## Deploy in this order

Open PowerShell in this project folder. Docker is **not required** for this deployment path.

### 1. Link the Supabase project

```powershell
npx supabase login
npx supabase link --project-ref sawmgfzkrhiepzyymwwr
```

### 2. Apply the production migration

Use Supabase Dashboard → SQL Editor → New query. Paste all of
`supabase/production-readiness-migration.sql`, select **Run**, and confirm it
finishes without an error.

This avoids `supabase db dump`, which requires Docker Desktop. A schema dump is
useful as a backup but is not required to apply this migration.

### 3. Add the new secrets

Create a Mapbox account at `https://account.mapbox.com/`, create a secret token,
then run the following with your real values:

```powershell
npx supabase secrets set PUBLIC_SITE_ORIGIN=https://signaftersix.github.io
npx supabase secrets set MAPBOX_ACCESS_TOKEN=YOUR_SECRET_MAPBOX_TOKEN
npx supabase secrets set BUSINESS_BASE_LATITUDE=YOUR_LATITUDE
npx supabase secrets set BUSINESS_BASE_LONGITUDE=YOUR_LONGITUDE
```

Confirm these existing custom secrets are still present in Supabase:

- `MAILER_WEB_APP_URL`
- `MAILER_SHARED_SECRET`
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_LOCATION_ID`
- `SQUARE_WEBHOOK_SIGNATURE_KEY`
- `SQUARE_ENVIRONMENT` (`sandbox` until final production cutover)

Supabase automatically supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY`. `SUPABASE_SECRET_KEYS` is already shown as a default
secret in your project.

### 4. Deploy every function

The included `supabase/config.toml` supplies the correct JWT setting. Run:

```powershell
npx supabase functions deploy create-request
npx supabase functions deploy check-availability
npx supabase functions deploy route-service-address
npx supabase functions deploy manage-request
npx supabase functions deploy accept-revised-quote
npx supabase functions deploy admin-action
npx supabase functions deploy admin-lifecycle
npx supabase functions deploy calendar-sync
npx supabase functions deploy notify-status
npx supabase functions deploy square-webhook
npx supabase functions deploy expire-pending
npx supabase functions deploy expire-awaiting-payment
npx supabase functions deploy send-reminders
npx supabase functions deploy cleanup-documents
```

`accept-revised-quote`, `manage-request`, `route-service-address`, and
`admin-lifecycle` are new; it is normal that they did not appear in the earlier
Edge Functions screenshot.

### 5. Update the Apps Script mailer

In the existing Apps Script project:

1. Replace `Code.gs` with `apps-script-mailer/Code.gs` from this package.
2. Confirm Script Properties contains the same shared secret used by Supabase.
3. Deploy → Manage deployments → Edit → New version → Deploy.
4. If the Web App URL changes, update `MAILER_WEB_APP_URL` in Supabase.

### 6. Publish the website

Copy the package contents to the existing `signaftersix.github.io` repository,
commit, and push `main`. GitHub Pages will publish the changes. Do this only
after Steps 2–5, because live booking now requires the secure routing function.

### 7. Verify Square

In Square Developer → Webhooks, confirm the notification URL is:

`https://sawmgfzkrhiepzyymwwr.supabase.co/functions/v1/square-webhook`

Subscribe to the payment events used by the current integration. Send a test
event and confirm a `200` response. The older `500` entries shown in your
screenshot must not recur before production cutover.

## Required acceptance test

Run these in order with a test customer email:

1. Enter an address inside 75 driving miles and confirm mileage/quote appears.
2. Enter an address outside 75 miles and confirm submission is blocked.
3. Submit a request and confirm the owner and customer emails arrive.
4. Open the customer management link; request a reschedule and deny it in admin.
5. Request cancellation and deny it; confirm the original calendar hold remains.
6. Approve a request with a higher quote; accept it from the revised-quote link.
7. Pay in Square sandbox; confirm the request becomes `confirmed` and moves calendars.
8. Mark the appointment complete only after its start time.
9. Confirm audit-log entries exist for each lifecycle action.
10. Confirm cancelled uploads receive a 24-hour deletion time and completed uploads receive a 7-day deletion time.

## Cron jobs

Keep the three working jobs already shown in Supabase:

- `expire-pending`: every 5 minutes
- `send-reminders`: every 5 minutes
- `cleanup-documents`: hourly at minute 10

Also ensure `expire-awaiting-payment` is scheduled every 5 minutes. If it is not
listed, add it in Integrations → Cron with a service-authorized invocation of the
`expire-awaiting-payment` function.

## Go-live blockers

Do not accept real customer bookings until all of these are true:

- Mapbox secrets are set and secure routing succeeds.
- The migration ran successfully.
- All 14 functions are deployed.
- Apps Script mail tests succeed.
- Square test webhooks return 200 rather than 500.
- The full sandbox payment and cancellation/reschedule tests pass.
- `SQUARE_ENVIRONMENT` and credentials are deliberately switched to production.
