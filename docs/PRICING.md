# Pricing rules

These are the locked business rules implemented by the quote estimator.

## Notarial / marriage fees
- Standard in-person Florida notarial act: **$10 per act**.
- Simple marriage solemnization: **$25**.
- Notarial fees are itemized separately from mobile, urgency, printing, mailing, parking, and other service charges.

## Mobile / travel
Customer pricing uses **one-way driving mileage** from the service base near ZIP 33547. Calendar blocking uses the full round-trip travel time.

- Base mobile fee: **$25**.
- First 5 miles: included.
- Miles 6–50: **$0.25/mile**.
- Miles 51–75: **$2.00/mile** for each mile beyond 50.
- Minimum mobile/travel fee: **$25 within 10 miles**; **$30 beyond 10 miles**.
- Online booking maximum: **75 driving miles**.
- Drive time affects calendar blocking, not the price.
- Tolls are not charged to the customer.
- Required paid parking is passed through at actual cost with no markup.

Formula:
`max(minimum, 25 + .25 * max(0, min(miles,50)-5) + 2 * max(0,miles-50))`

## Urgency
- 12–24 hours: **+$5**
- 6–12 hours: **+$10**
- Under 6 hours: **+$25**
- Same-day appointment after 8 PM: **+$40**, replacing the normal urgency fee rather than stacking with it.
- Emergency-opening requests use the normal same-day pricing; no additional squeeze-in fee.

## Weekends
- Base Saturday/Sunday premium: **+$5**
- Before 8 AM: **+$15** additional
- After 8 PM: **+$20** additional
- Weekend availability: **6 AM–midnight**

## Holidays
- Other U.S. federal holidays: **+$20**
- Major holidays: **+$40**
- Major holidays: Thanksgiving Day, Christmas Eve after 6 PM, Christmas Day, New Year's Eve after 6 PM, New Year's Day, Easter Sunday, July 4.
- Major holidays use weekend-style availability (6 AM–midnight where applicable).

## Printing / mailing
- Printing: **$5 up to 10 pages**, then **$0.25/additional page**.
- Standard envelope + stamp: current 1-ounce stamped-letter postage + **$0.25**. Standard envelope only; document must be okay to fold.
- Mailbox drop: **+$5**.
- Staffed post-office counter: **+$10**.
- Mailing assistance: sent within **24 hours of signing**.
- Certified Mail/tracking: actual USPS cost + **$1** handling.
- No signature-confirmation option.

## Large / special jobs
- 1–2 signers / up to 3 acts: 30-minute appointment block.
- 3–4 signers or 4–6 acts: 45 minutes.
- 5+ signers or 7+ acts: 60 minutes and manual review.
- No routine time surcharge for normal 45/60-minute appointments.
- Unusually large jobs may receive a custom service-time charge after manual review.
- Secure facilities always receive manual review and may receive a custom access surcharge.
