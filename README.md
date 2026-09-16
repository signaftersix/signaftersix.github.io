# Sign After Six Mobile Notary

Mobile-first GitHub Pages website and booking-system scaffold for **Sign After Six Mobile Notary**.

> **Tagline:** When 9-to-5 doesn't work, I do.
>
> Florida Notary Public: **Prince Duke E. Hubbard IV**
>
> Business email: **signaftersix@gmail.com**

## What is already built

- Friendly plum / cream / soft-gold responsive UI.
- Mobile navigation and sticky booking CTA.
- Service descriptions and Florida-specific limitations.
- Six-step quote + appointment-request wizard.
- Price calculator implementing the locked travel, urgency, weekend, holiday, printing, postage, and mailing rules.
- PDF/JPG/PNG upload UI (maximum 10 files).
- “I don’t have the document yet” path.
- Service-area map with 50-mile primary and 75-mile premium radii.
- Private admin-dashboard scaffold.
- Supabase schema with RLS, private document bucket, quote revisions, availability blocks, and audit log.
- Edge-function scaffolds for request creation, Gmail notifications, Google Calendar holds, Square payment links, Square payment webhook, Telnyx SMS, and seven-day document cleanup.
- GitHub Pages deployment workflow.
- Final privacy and booking-terms pages.

## Important architecture choice

**GitHub Pages is only the public frontend. Never place customer documents, private API keys, Google refresh tokens, Square secrets, or service-role credentials in GitHub.** The secure work belongs in Supabase Edge Functions and private Supabase Storage.

## Launch stack

- **Frontend:** GitHub Pages
- **Database/auth/private storage:** Supabase
- **Routing:** Mapbox Directions + Geocoding
- **Public business calls/manual texts:** Google Voice (outside this repo)
- **Automated transactional SMS:** Telnyx adapter
- **Business email:** Gmail API using `signaftersix@gmail.com`
- **Calendar:** Google Calendar API (separate Pending and Confirmed calendars + selected busy calendars)
- **Payments:** Square Checkout / Payment Links
- **Public map:** Leaflet + OpenStreetMap

## 1. Preview locally

From this folder:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

The public form intentionally runs in **demo mode** until backend credentials are configured. The price calculator, UI, map, and form wizard still work.

## 2. Create the GitHub repository

Repository name: **`signaftersix`**

Upload the contents of this folder to the repository's `main` branch. The included `.github/workflows/pages.yml` deploys the repository to GitHub Pages.

In GitHub: **Settings → Pages → Source → GitHub Actions**.

## 3. Create Supabase

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the SQL editor.
3. Enable Google as an Auth provider.
4. Use TOTP MFA for the admin account.
5. After your first Google login, add that authenticated user UUID to `public.admin_users`.
6. Deploy the functions under `supabase/functions/`.
7. Schedule `cleanup-documents` daily. When an appointment is marked completed, set each document's `delete_after = completed_at + interval '7 days'`.

### Supabase public browser config

Copy `config.example.js` to `config.js` (already included in demo form) and add only browser-safe values:

```js
window.SAS_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_PUBLIC_ANON_KEY",
  API_BASE_URL: "https://YOUR_PROJECT.supabase.co/functions/v1",
  BUSINESS_PHONE_DISPLAY: "",
  ENABLE_LIVE_SUBMISSION: true,
  ENABLE_SECURE_ROUTING: true
};
```

The Supabase publishable key is meant for client use. Mapbox routing now runs only in an Edge Function; never place its token or the private business starting point in browser code. **Do not put a Supabase service-role key or private provider token here.**

## 4. Supabase secrets

Set private secrets with the Supabase CLI / dashboard:

```text
SUPABASE_SERVICE_ROLE_KEY
PUBLIC_SITE_ORIGIN
BUSINESS_EMAIL=signaftersix@gmail.com
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
GOOGLE_PENDING_CALENDAR_ID
GOOGLE_CONFIRMED_CALENDAR_ID
SQUARE_ACCESS_TOKEN
SQUARE_LOCATION_ID
SQUARE_WEBHOOK_SIGNATURE_KEY
TELNYX_API_KEY
TELNYX_FROM_NUMBER
MAPBOX_ACCESS_TOKEN
BUSINESS_BASE_LATITUDE
BUSINESS_BASE_LONGITUDE
```

The Google refresh token must have the Gmail send scope and the Google Calendar scopes actually needed by the functions. Do not request broader Google scopes than necessary.

## 5. Gmail sender name

In the connected Gmail account, set the sender display name to:

**Sign After Six Mobile Notary**

New-request emails include secure dashboard links. They **do not approve or decline directly from email**: the admin link opens the protected dashboard, which requires Google login + MFA before an action is finalized.

## 6. Google Calendar

Create two calendars:

- `Sign After Six — Pending Requests`
- `Sign After Six — Confirmed Appointments`

The backend should also query free/busy information from only the personal/work calendars you explicitly select. A customer appointment should block:

`one-way drive time before + appointment duration + one-way drive time after`

Customer price is based on one-way mileage; calendar blocking is round trip.

## 7. Square

The repository uses Square-hosted payment links. Payment happens only after approval.

Before production:
- Create a Square developer app and location.
- Configure the Square webhook endpoint.
- **Implement and test Square webhook signature verification** in `square-webhook/index.ts` before accepting real payments.
- For appointments within 24 hours, request payment immediately after approval.
- For future appointments, use a four-hour payment deadline.

## 8. Automated SMS

Google Voice remains the customer-facing business number for calls/manual texts. Automated booking alerts use a separate provider number.

Telnyx is scaffolded for low-volume transactional SMS. Register the sender properly for U.S. messaging before production and include any legally/contractually required opt-out language where applicable.

## 9. Mapbox

Mapbox is used only when `ENABLE_SECURE_ROUTING` is true. The browser calls the private `route-service-address` Edge Function, and the calculator uses the route's **one-way driving mileage** for pricing and the route duration for calendar blocking.

The public service-area map itself uses Leaflet + OpenStreetMap and shows only the ZIP-area base, never a private street address.

## 10. USPS values

The starter calculator uses these current values as configuration constants in `assets/app.js`:

- 1 oz stamped First-Class letter: **$0.82**
- Certified Mail service: **$5.55**

These should be reviewed whenever USPS changes prices. The customer's standard envelope+stamp charge is the current 1-oz stamped-letter rate plus the selected **$0.25** markup. Certified Mail/tracking is actual USPS cost plus **$1** handling.

## 11. Legal / notary notes to preserve

- Standard in-person Florida notarial act fee: no more than **$10 per act**.
- Simple marriage solemnization is priced at **$25** in this site; Florida law ties the maximum to the clerk's fee for the same service.
- Do not advertise Remote Online Notarization because it is not offered.
- Do not advertise full loan-signing-agent services.
- Do not imply that the notary chooses a notarial act or provides legal advice.
- Attested-copy language must exclude records Florida law does not permit a notary to attest in this manner, including vital records and public records for which an official certified copy can be obtained.
- If a future Spanish-language version is launched, review Florida's advertising requirements before publishing it.

## 12. Final production checklist

Before switching `ENABLE_LIVE_SUBMISSION` to true:

- [ ] Business Google Voice number added to the site.
- [ ] Supabase project and RLS reviewed.
- [ ] Admin Google account added to `admin_users`.
- [ ] Admin TOTP MFA enrolled and enforced.
- [ ] Private storage tested; no upload URL is publicly enumerable.
- [ ] Seven-day document deletion job tested.
- [ ] Mapbox routing token restricted to the site domain.
- [ ] Gmail OAuth scopes minimized and send flow tested.
- [ ] Pending + Confirmed Google Calendars created.
- [ ] Selected busy calendars connected.
- [ ] Square webhook signature verification completed and tested.
- [ ] Telnyx sender registration completed.
- [ ] Cancellation/refund flows tested.
- [ ] Privacy/terms pages reviewed for the actual launched integrations.
- [ ] Business phone number and commission details added where desired.
- [ ] Test booking from an Android phone and iPhone-sized viewport.
- [ ] Test keyboard-only navigation and screen-reader labels.

## Current legal / operational references

- Florida Statute §117.05 (notarial fee, ID, advertising, attested copies): https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0100-0199/0117/Sections/0117.05.html
- Florida Statute §117.045 (marriage solemnization): https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0100-0199/0117/Sections/0117.045.html
- Florida Statute §28.24 (clerk solemnization fee): https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0000-0099/0028/Sections/0028.24.html
- USPS Notice 123: https://pe.usps.com/text/dmm300/Notice123.htm

## Files

```text
index.html                  Public website + quote wizard
admin.html                  Protected-dashboard frontend scaffold
privacy.html                Draft privacy notice
terms.html                  Draft booking terms
config.example.js           Public config template
config.js                   Demo config
assets/styles.css           Public site styles
assets/app.js               Wizard, calculator, calendar-hours logic, map
assets/admin.css            Admin styles
assets/admin.js             Supabase admin auth/data hooks
supabase/schema.sql         Database, RLS, private storage, audit log
supabase/functions/         Backend function scaffolds
.github/workflows/pages.yml GitHub Pages deployment
docs/PRICING.md             Locked pricing logic
docs/WORKFLOW.md            Booking workflow
```
