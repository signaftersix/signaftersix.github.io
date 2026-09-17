# Sign After Six upgrade notes — September 17, 2026

## Included

- Separate public URLs for Home, How It Works, Services, Pricing, Service Area, FAQ, and Request an Appointment.
- Address-first appointment selection with unavailable time slots removed before the customer continues.
- A final availability recheck remains in place during submission to prevent races.
- Clickable Pending, Confirmed, Awaiting Payment, and Today admin cards synchronized with request filtering.
- Three-column desktop admin workspace: requests, selected request, and audit log.
- Calendar/date/time availability-block form with future-block listing and deletion.
- Permanent Delete Request control with typed confirmation, paid-record warning, calendar release attempt, private-upload deletion, cascade cleanup, and non-identifying audit history.
- A service-only management-token record for new requests.
- Manage Appointment buttons and plaintext links in customer lifecycle, payment-request, payment-confirmation, and reminder emails.
- Square remains the sole payment processor. No Zelle or Cash App instructions were added.

## Deployment requirements

Follow `PRODUCTION_DEPLOYMENT.md` in order. The migration and affected backend functions must be deployed before the new public files are published.

## Important behavior

Delete Request never issues a refund. For a paid request, complete any required refund in Square first, then delete the record only if it no longer needs to remain in operational history.

Management links in every later email apply to requests created after this migration is deployed. Previously issued secure links continue working because their stored hashes are not changed.
