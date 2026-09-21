# Booking workflow

1. Customer enters ZIP for a rough estimate, then full address for live routing.
2. Site checks requested date/time, selected busy Google Calendars, round-trip travel buffer, and appointment duration.
3. Customer identifies document type and requested notarial act, number of signers, and number of acts (or selects Not Sure).
4. Customer selects printing / mailing / accommodation options.
5. Customer uploads up to 10 PDF/JPG/PNG files, or selects “I don’t have the document yet.” A request without the document cannot be approved.
6. Quote displays an estimated total with expandable line-item detail.
7. Submission creates a **Pending** request and temporarily blocks the requested time.
8. Business Gmail receives a detailed message with secure Review/Approve and Review/Decline links. The links open the admin page and require authorized Google login + MFA.
9. If review increases the quote, the customer gets two hours to accept. If they do not accept, the request auto-declines and releases the slot. A reduced quote does not need fresh acceptance.
10. Once approved, payment is requested through Square. Within 24 hours = immediate payment; more than 24 hours = 4-hour payment window.
11. Successful payment moves the appointment to Confirmed, replaces the pending calendar hold with the confirmed event, and schedules 24-hour and 2-hour reminders.
12. The 2-hour reminder includes Confirm / Cancel / Reschedule Request actions.
13. Cancellation and reschedule requests go back to admin for approval.
14. After completion, uploaded documents are scheduled for deletion seven days later. Appointment and receipt metadata can remain.
