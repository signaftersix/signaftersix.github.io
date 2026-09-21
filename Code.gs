const CONFIG = {
  OWNER_EMAIL: "signaftersix@gmail.com",
  SENDER_NAME: "Sign After Six Mobile Notary",

  SITE_URL: "https://signaftersix.github.io",
  ADMIN_URL: "https://signaftersix.github.io/admin.html",

  TIME_ZONE: "America/New_York",

  PENDING_CALENDAR_NAME:
    "Sign After Six - Pending Requests",

  CONFIRMED_CALENDAR_NAME:
    "Sign After Six - Confirmed Appointments"
};


/* =========================================================
   OPTIONAL SECRET HELPER
   ========================================================= */

/**
 * Generates and stores a new 64-character shared secret.
 *
 * IMPORTANT:
 * You already created MAILER_SHARED_SECRET manually
 * and Supabase is using it.
 *
 * DO NOT RUN THIS AGAIN unless you intentionally want
 * to replace the secret in both Apps Script and Supabase.
 */
function createMailerSecret() {
  const secret =
    Utilities.getUuid().replace(/-/g, "") +
    Utilities.getUuid().replace(/-/g, "");

  PropertiesService
    .getScriptProperties()
    .setProperty(
      "MAILER_SHARED_SECRET",
      secret
    );

  console.log(secret);
}


/* =========================================================
   WEB APP
   ========================================================= */

function doGet() {
  return jsonResponse({
    ok: true,
    service: "Sign After Six Google Automation"
  });
}


function doPost(e) {
  try {
    const body = JSON.parse(
      e &&
      e.postData &&
      e.postData.contents
        ? e.postData.contents
        : "{}"
    );

    const expectedSecret =
      PropertiesService
        .getScriptProperties()
        .getProperty(
          "MAILER_SHARED_SECRET"
        );

    if (
      !expectedSecret ||
      !body.secret ||
      String(body.secret) !==
        expectedSecret
    ) {
      return jsonResponse({
        ok: false,
        error: "Unauthorized"
      });
    }

    const event =
      String(
        body.event || ""
      );

    const payload =
      body.payload || {};


    /* -----------------------------------------
       NEW REQUEST -> OWNER EMAIL
       ----------------------------------------- */

    if (
      event ===
      "new_request"
    ) {
      sendNewRequestEmail(
        payload
      );

      return jsonResponse({
        ok: true,
        event: event
      });
    }


    /* -----------------------------------------
       APPROVED -> CUSTOMER PAYMENT EMAIL
       ----------------------------------------- */

    if (
      event ===
      "payment_requested"
    ) {
      sendPaymentRequestedEmail(
        payload
      );

      return jsonResponse({
        ok: true,
        event: event
      });
    }


    /* -----------------------------------------
       PAID -> CUSTOMER CONFIRMATION EMAIL
       ----------------------------------------- */

    if (
      event ===
      "payment_confirmed"
    ) {
      sendPaymentConfirmedEmail(
        payload
      );

      return jsonResponse({
        ok: true,
        event: event
      });
    }


    /* -----------------------------------------
       CUSTOMER REQUEST / LIFECYCLE EMAILS
       ----------------------------------------- */

    if (
      event === "customer_request_received" ||
      event === "revised_quote" ||
      event === "cancellation_requested" ||
      event === "cancellation_approved" ||
      event === "cancellation_denied" ||
      event === "reschedule_requested" ||
      event === "reschedule_approved" ||
      event === "reschedule_denied"
    ) {
      sendLifecycleEmail(
        event,
        payload
      );

      return jsonResponse({
        ok: true,
        event: event
      });
    }


    /* -----------------------------------------
       APPOINTMENT REMINDER -> CUSTOMER EMAIL
       ----------------------------------------- */

    if (
      event ===
      "appointment_reminder"
    ) {
      sendAppointmentReminderEmail(
        payload
      );

      return jsonResponse({
        ok: true,
        event: event
      });
    }


    /* -----------------------------------------
       CREATE / UPDATE PENDING CALENDAR HOLD
       ----------------------------------------- */

    if (
      event ===
      "calendar_pending"
    ) {
      const result =
        createPendingCalendarEvent(
          payload
        );

      return jsonResponse({
        ok: true,
        event: event,
        result: result
      });
    }


    /* -----------------------------------------
       MOVE TO CONFIRMED CALENDAR
       ----------------------------------------- */

    if (
      event ===
      "calendar_confirmed"
    ) {
      const result =
        createConfirmedCalendarEvent(
          payload
        );

      return jsonResponse({
        ok: true,
        event: event,
        result: result
      });
    }


    /* -----------------------------------------
       RELEASE CALENDAR HOLD
       ----------------------------------------- */

    if (
      event ===
      "calendar_release"
    ) {
      const result =
        releaseCalendarEvents(
          payload
        );

      return jsonResponse({
        ok: true,
        event: event,
        result: result
      });
    }


    /* -----------------------------------------
       CHECK SIGN AFTER SIX CALENDAR AVAILABILITY
       ----------------------------------------- */

    if (
      event ===
      "calendar_availability"
    ) {
      const result =
        checkCalendarAvailability(
          payload
        );

      return jsonResponse({
        ok: true,
        event: event,
        result: result
      });
    }


    return jsonResponse({
      ok: false,
      error: "Unsupported event"
    });

  } catch (error) {
    console.error(error);

    return jsonResponse({
      ok: false,

      error:
        error &&
        error.message
          ? error.message
          : String(error)
    });
  }
}


/* =========================================================
   NEW REQUEST EMAIL TO OWNER
   ========================================================= */

function sendNewRequestEmail(
  payload
) {
  const request =
    payload.request || {};

  const customer =
    payload.customer || {};

  const quote =
    payload.quote || {};

  const documents =
    Array.isArray(
      payload.documents
    )
      ? payload.documents
      : [];


  const customerName =
    customer.name ||
    "Customer";


  const appointmentTime =
    request.appointmentDisplay ||
    request.appointmentAt ||
    "Time pending";


  const total =
    quote.total !== undefined &&
    quote.total !== null
      ? money(
          quote.total
        )
      : "Review required";


  const subject =
    "New Pending Notary Request — " +
    customerName +
    " — " +
    appointmentTime;


  /* -----------------------------------------
     DOCUMENT LINKS
     ----------------------------------------- */

  let documentHtml = "";

  if (
    documents.length
  ) {
    documentHtml =
      "<h3>Uploaded documents</h3>" +
      "<ul>";


    documents.forEach(
      function(doc) {

        documentHtml +=
          "<li>" +
          escapeHtml(
            doc.name ||
            "Document"
          );


        if (
          doc.url
        ) {
          documentHtml +=
            ' — <a href="' +
            escapeHtml(
              doc.url
            ) +
            '">' +
            "View securely" +
            "</a>";
        }


        documentHtml +=
          "</li>";
      }
    );


    documentHtml +=
      "</ul>";

  } else {
    documentHtml =
      "<p>" +
      "<strong>Documents:</strong> " +
      "Customer indicated the document is not available yet." +
      "</p>";
  }


  const quoteHtml =
    buildQuoteHtml(
      quote
    );


  const approveUrl =
    payload.approveUrl ||
    CONFIG.ADMIN_URL;


  const declineUrl =
    payload.declineUrl ||
    CONFIG.ADMIN_URL;


  const html =
    emailShell(

      "New appointment request",

      "<p>" +
      "<strong>Status:</strong> Pending" +
      "</p>" +


      "<h3>Customer</h3>" +

      "<p>" +

      "<strong>Name:</strong> " +
      escapeHtml(
        customerName
      ) +
      "<br>" +

      "<strong>Email:</strong> " +
      escapeHtml(
        customer.email || ""
      ) +
      "<br>" +

      "<strong>Phone:</strong> " +
      escapeHtml(
        customer.phone || ""
      ) +

      "</p>" +


      "<h3>Appointment</h3>" +

      "<p>" +

      "<strong>Requested time:</strong> " +
      escapeHtml(
        appointmentTime
      ) +
      "<br>" +

      "<strong>Address:</strong> " +
      escapeHtml(
        request.address || ""
      ) +
      "<br>" +

      "<strong>Distance:</strong> " +
      escapeHtml(
        request.distanceDisplay ||
        "Pending calculation"
      ) +

      "</p>" +


      "<h3>Document / Notarial Act</h3>" +

      "<p>" +

      "<strong>Document:</strong> " +
      escapeHtml(
        request.documentType || ""
      ) +
      "<br>" +

      "<strong>Notarial act:</strong> " +
      escapeHtml(
        request.notarialAct || ""
      ) +
      "<br>" +

      "<strong>Signers:</strong> " +
      escapeHtml(
        String(
          request.signerCount ||
          ""
        )
      ) +
      "<br>" +

      "<strong>Number of acts:</strong> " +
      escapeHtml(
        request.actsUnknown
          ? "Not sure"
          : String(
              request.actCount ||
              ""
            )
      ) +

      "</p>" +


      documentHtml +


      "<h3>Customer comments</h3>" +

      "<p>" +
      escapeHtml(
        request.comments ||
        "No comments provided."
      ) +
      "</p>" +


      quoteHtml +


      '<div style="' +
      "font-size:22px;" +
      "font-weight:bold;" +
      "margin:20px 0" +
      '">' +

      "Estimated total: " +
      escapeHtml(
        total
      ) +

      "</div>" +


      '<div style="margin-top:24px">' +

      actionButton(
        approveUrl,
        "Review / Approve",
        "#54205d"
      ) +

      "&nbsp;&nbsp;" +

      actionButton(
        declineUrl,
        "Review / Decline",
        "#444444"
      ) +

      "</div>" +


      '<p style="' +
      "margin-top:24px;" +
      "font-size:12px;" +
      "color:#666" +
      '">' +

      "Appointment requests remain pending until reviewed and approved. " +
      "Customer documents should be reviewed using the secure document link." +

      "</p>"
    );


  const plainText =
    "NEW SIGN AFTER SIX APPOINTMENT REQUEST\n\n" +

    "Status: Pending\n" +

    "Customer: " +
    customerName +
    "\n" +

    "Email: " +
    (
      customer.email ||
      ""
    ) +
    "\n" +

    "Phone: " +
    (
      customer.phone ||
      ""
    ) +
    "\n" +

    "Appointment: " +
    appointmentTime +
    "\n" +

    "Address: " +
    (
      request.address ||
      ""
    ) +
    "\n" +

    "Document: " +
    (
      request.documentType ||
      ""
    ) +
    "\n" +

    "Notarial act: " +
    (
      request.notarialAct ||
      ""
    ) +
    "\n" +

    "Estimated total: " +
    total +
    "\n\n" +

    "Open the Sign After Six admin dashboard to review the request.";


  GmailApp.sendEmail(
    CONFIG.OWNER_EMAIL,

    subject,

    plainText,

    {
      htmlBody: html,

      name:
        CONFIG.SENDER_NAME,

      replyTo:
        customer.email ||
        CONFIG.OWNER_EMAIL
    }
  );
}


/* =========================================================
   CUSTOMER PAYMENT REQUEST EMAIL
   ========================================================= */

function sendPaymentRequestedEmail(
  payload
) {
  const request =
    payload.request || {};

  const customer =
    payload.customer || {};

  const quote =
    payload.quote || {};

  const payment =
    payload.payment || {};
  const manageUrl = payload.manageUrl || "";


  if (
    !customer.email
  ) {
    throw new Error(
      "Customer email is missing."
    );
  }


  if (
    !payment.url
  ) {
    throw new Error(
      "Square payment URL is missing."
    );
  }


  const customerName =
    customer.name ||
    "Customer";


  const appointmentTime =
    request.appointmentDisplay ||
    request.appointmentAt ||
    "See appointment details";


  const total =
    quote.total !== undefined &&
    quote.total !== null
      ? money(
          quote.total
        )
      : "See payment page";


  const paymentDeadline =
    payment.dueDisplay ||
    payment.dueAt ||
    "";


  let deadlineHtml =
    "";


  if (
    paymentDeadline
  ) {
    deadlineHtml =
      "<p>" +
      "<strong>Payment deadline:</strong><br>" +
      escapeHtml(
        paymentDeadline
      ) +
      "</p>";
  }


  const html =
    emailShell(

      "Your appointment request was approved",

      "<p>" +
      "Hi " +
      escapeHtml(
        customerName
      ) +
      "," +
      "</p>" +


      "<p>" +
      "Your mobile notary appointment has been approved. " +
      "Payment is required to finish confirming your appointment." +
      "</p>" +


      "<p>" +
      "<strong>Appointment:</strong><br>" +
      escapeHtml(
        appointmentTime
      ) +
      "</p>" +


      "<p>" +
      "<strong>Amount due:</strong> " +
      escapeHtml(
        total
      ) +
      "</p>" +


      deadlineHtml +


      '<p style="margin:28px 0">' +

      actionButton(
        payment.url,
        "Pay Securely with Square",
        "#54205d"
      ) +

      "</p>" +


      "<p>" +
      "Your appointment remains " +
      "<strong>awaiting payment</strong> " +
      "until payment is completed." +
      "</p>" +


      "<p>" +
      "If you need to request a change, reply to this email." +
      "</p>" +
      (manageUrl ? '<p style="margin:28px 0">' + actionButton(manageUrl, "Manage Your Appointment", "#54205d") + "</p>" : "")
    );


  const plainText =
    "Hi " +
    customerName +
    ",\n\n" +

    "Your Sign After Six appointment request was approved.\n\n" +

    "Appointment: " +
    appointmentTime +
    "\n" +

    "Amount due: " +
    total +
    "\n" +

    (
      paymentDeadline
        ? "Payment deadline: " +
          paymentDeadline +
          "\n"
        : ""
    ) +

    "\n" +

    "Pay securely here:\n" +
    payment.url +
    "\n\n" +

    "Your appointment remains awaiting payment until payment is completed." +
    (manageUrl ? "\n\nManage your appointment:\n" + manageUrl : "");


  GmailApp.sendEmail(
    customer.email,

    "Your Sign After Six appointment was approved",

    plainText,

    {
      htmlBody: html,

      name:
        CONFIG.SENDER_NAME,

      replyTo:
        CONFIG.OWNER_EMAIL
    }
  );
}


/* =========================================================
   PAYMENT RECEIVED / CONFIRMATION EMAIL
   ========================================================= */

function sendLifecycleEmail(event, payload) {
  const customer = payload.customer || {};
  const request = payload.request || {};
  if (!customer.email) throw new Error("Customer email is missing.");

  const appointment = request.appointmentDisplay || request.appointmentAt || "See appointment details";
  const requested = request.requestedAppointmentDisplay || request.requestedAppointmentAt || "";
  const manageUrl = payload.acceptanceUrl || payload.manageUrl || "";
  const copy = {
    customer_request_received: {
      subject: "We received your Sign After Six request",
      title: "Your request is pending review",
      body: "Your requested appointment has been received. It is not confirmed yet. You will receive a separate payment link after approval.",
      button: "Manage Your Request"
    },
    revised_quote: {
      subject: "Your Sign After Six quote was updated",
      title: "Please review your updated quote",
      body: "The reviewed price is higher than the original estimate. Review and accept it before the link expires. Your appointment remains pending until acceptance and payment are completed.",
      button: "Review Updated Quote"
    },
    cancellation_requested: {
      subject: "Cancellation request received",
      title: "Your cancellation request is under review",
      body: "Your appointment remains scheduled until you receive a final cancellation confirmation.",
      button: "View Request Status"
    },
    cancellation_approved: {
      subject: "Your appointment has been cancelled",
      title: "Cancellation confirmed",
      body: "Your appointment has been cancelled. If a refund is due, it will be handled manually and its status will be recorded with your request.",
      button: "View Request Status"
    },
    cancellation_denied: {
      subject: "Update on your cancellation request",
      title: "Cancellation was not approved",
      body: "Your appointment remains scheduled. Reply to this email if you need to discuss the decision.",
      button: "View Request Status"
    },
    reschedule_requested: {
      subject: "Reschedule request received",
      title: "Your requested change is under review",
      body: "Your current appointment remains scheduled until the new time is approved.",
      button: "View Request Status"
    },
    reschedule_approved: {
      subject: "Your new appointment time is confirmed",
      title: "Reschedule approved",
      body: "Your appointment has been moved to the new time shown below.",
      button: "View Request Status"
    },
    reschedule_denied: {
      subject: "Update on your reschedule request",
      title: "The requested time was not approved",
      body: "Your original appointment remains scheduled. You may use your management link to request another available time.",
      button: "Manage Your Request"
    }
  }[event];
  if (!copy) throw new Error("Unsupported lifecycle email.");

  const schedule = event.indexOf("reschedule_") === 0 && requested
    ? "<p><strong>Requested time:</strong><br>" + escapeHtml(requested) + "</p>"
    : "<p><strong>Appointment:</strong><br>" + escapeHtml(appointment) + "</p>";
  const button = manageUrl
    ? '<p style="margin:28px 0">' + actionButton(manageUrl, copy.button, "#54205d") + "</p>"
    : "";
  const html = emailShell(copy.title,
    "<p>Hi " + escapeHtml(customer.name || "there") + ",</p>" +
    "<p>" + escapeHtml(copy.body) + "</p>" + schedule + button +
    "<p>Reply to this email if you need help.</p>");
  const plain = "Hi " + (customer.name || "there") + ",\n\n" + copy.body + "\n\n" +
    (requested ? "Requested time: " + requested : "Appointment: " + appointment) +
    (manageUrl ? "\n\nManage your request:\n" + manageUrl : "") +
    "\n\nSign After Six Mobile Notary";
  GmailApp.sendEmail(customer.email, copy.subject, plain, {
    htmlBody: html,
    name: CONFIG.SENDER_NAME,
    replyTo: CONFIG.OWNER_EMAIL
  });

  if (event === "cancellation_requested" || event === "reschedule_requested") {
    GmailApp.sendEmail(
      CONFIG.OWNER_EMAIL,
      "Admin action needed: " + copy.subject,
      "Customer: " + (customer.name || "Customer") + "\nRequest: " + (request.id || "") + "\n\n" + copy.body + "\n\nOpen the admin dashboard:\nhttps://signaftersix.github.io/admin.html?request=" + encodeURIComponent(request.id || ""),
      { name: CONFIG.SENDER_NAME, replyTo: customer.email }
    );
  }
}


function sendPaymentConfirmedEmail(
  payload
) {
  const request =
    payload.request || {};

  const customer =
    payload.customer || {};

  const quote =
    payload.quote || {};

  const payment =
    payload.payment || {};
  const manageUrl = payload.manageUrl || "";


  if (
    !customer.email
  ) {
    throw new Error(
      "Customer email is missing."
    );
  }


  const customerName =
    customer.name ||
    "Customer";


  const appointmentTime =
    request.appointmentDisplay ||
    request.appointmentAt ||
    "See appointment details";


  const address =
    request.address ||
    "";


  const total =
    quote.total !== undefined &&
    quote.total !== null
      ? money(
          quote.total
        )
      : money(
          payment.amount ||
          0
        );


  const quoteHtml =
    buildQuoteHtml(
      quote
    );


  const html =
    emailShell(

      "Payment received — appointment confirmed",

      "<p>" +
      "Hi " +
      escapeHtml(
        customerName
      ) +
      "," +
      "</p>" +


      "<p>" +
      "You're all set. Your payment has been received and your " +
      "<strong>Sign After Six Mobile Notary</strong> appointment is confirmed." +
      "</p>" +


      '<div style="' +
      "background:#f7f1f7;" +
      "padding:18px;" +
      "border-radius:10px;" +
      "margin:22px 0" +
      '">' +


      '<p style="margin-top:0">' +
      "<strong>Appointment:</strong><br>" +
      escapeHtml(
        appointmentTime
      ) +
      "</p>" +


      "<p>" +
      "<strong>Location:</strong><br>" +
      escapeHtml(
        address
      ) +
      "</p>" +


      "<p>" +
      "<strong>Document:</strong><br>" +
      escapeHtml(
        request.documentType ||
        ""
      ) +
      "</p>" +


      '<p style="margin-bottom:0">' +
      "<strong>Amount paid:</strong> " +
      escapeHtml(
        total
      ) +
      "</p>" +


      "</div>" +


      quoteHtml +


      "<h3>What to have ready</h3>" +

      "<ul>" +

      "<li>" +
      "An acceptable form of identification." +
      "</li>" +

      "<li>" +
      "The complete document to be notarized. " +
      "Do not leave required information blank." +
      "</li>" +

      "<li>" +
      "All required signers must be present." +
      "</li>" +

      "<li>" +
      "If your document requires witnesses, you are responsible for providing them." +
      "</li>" +

      "</ul>" +


      "<p>" +
      "You'll receive reminders approximately 24 hours and 2 hours before your appointment." +
      "</p>" +


      "<p>" +
      "If you need to cancel or request a reschedule, reply to this email." +
      "</p>" +
      (manageUrl ? '<p style="margin:28px 0">' + actionButton(manageUrl, "Manage Your Appointment", "#54205d") + "</p>" : "") +


      '<p style="' +
      "font-size:12px;" +
      "color:#666;" +
      "margin-top:28px" +
      '">' +

      "In-person mobile notarization only. " +
      "Sign After Six does not provide legal advice and is not a Remote Online Notary service." +

      "</p>"
    );


  const plainText =
    "Hi " +
    customerName +
    ",\n\n" +

    "Payment received. Your Sign After Six Mobile Notary appointment is confirmed.\n\n" +

    "Appointment: " +
    appointmentTime +
    "\n" +

    "Location: " +
    address +
    "\n" +

    "Document: " +
    (
      request.documentType ||
      ""
    ) +
    "\n" +

    "Amount paid: " +
    total +
    "\n\n" +

    "WHAT TO HAVE READY\n" +

    "- Acceptable identification\n" +
    "- Complete document\n" +
    "- All required signers\n" +
    "- Any required witnesses\n\n" +

    "You'll receive reminders approximately 24 hours and 2 hours before the appointment.\n\n" +
    (manageUrl ? "Manage your appointment:\n" + manageUrl + "\n\n" : "") +

    "Sign After Six Mobile Notary\n" +
    "When 9-to-5 doesn’t work, I do.";


  GmailApp.sendEmail(
    customer.email,

    "Payment received — your notary appointment is confirmed",

    plainText,

    {
      htmlBody: html,

      name:
        CONFIG.SENDER_NAME,

      replyTo:
        CONFIG.OWNER_EMAIL
    }
  );
}


/* =========================================================
   APPOINTMENT REMINDER EMAIL
   ========================================================= */

function sendAppointmentReminderEmail(
  payload
) {
  const request =
    payload.request || {};

  const customer =
    payload.customer || {};

  const reminderType =
    String(
      payload.reminderType || ""
    );
  const manageUrl = payload.manageUrl || "";


  if (
    !customer.email
  ) {
    throw new Error(
      "Customer email is missing."
    );
  }


  if (
    reminderType !== "24h" &&
    reminderType !== "2h"
  ) {
    throw new Error(
      "Invalid reminder type."
    );
  }


  const customerName =
    customer.name ||
    "Customer";


  const appointmentTime =
    request.appointmentDisplay ||
    request.appointmentAt ||
    "See appointment details";


  const address =
    request.address ||
    "";


  const documentType =
    request.documentType ||
    "";


  const isTwoHour =
    reminderType === "2h";


  const subject =
    isTwoHour
      ? "Reminder — your notary appointment is in about 2 hours"
      : "Reminder — your notary appointment is about 24 hours away";


  const heading =
    isTwoHour
      ? "Your appointment is coming up soon"
      : "Your appointment is tomorrow";


  const intro =
    isTwoHour
      ? "Just a quick reminder that your Sign After Six Mobile Notary appointment is coming up in about two hours."
      : "Just a reminder that your Sign After Six Mobile Notary appointment is coming up in about 24 hours.";


  const html =
    emailShell(

      heading,

      "<p>" +
      "Hi " +
      escapeHtml(
        customerName
      ) +
      "," +
      "</p>" +


      "<p>" +
      escapeHtml(
        intro
      ) +
      "</p>" +


      '<div style="' +
      "background:#f7f1f7;" +
      "padding:18px;" +
      "border-radius:10px;" +
      "margin:22px 0" +
      '">' +


      '<p style="margin-top:0">' +
      "<strong>Appointment:</strong><br>" +
      escapeHtml(
        appointmentTime
      ) +
      "</p>" +


      "<p>" +
      "<strong>Location:</strong><br>" +
      escapeHtml(
        address
      ) +
      "</p>" +


      '<p style="margin-bottom:0">' +
      "<strong>Document:</strong><br>" +
      escapeHtml(
        documentType
      ) +
      "</p>" +


      "</div>" +


      "<h3>What to have ready</h3>" +

      "<ul>" +

      "<li>" +
      "An acceptable form of identification." +
      "</li>" +

      "<li>" +
      "The complete document to be notarized." +
      "</li>" +

      "<li>" +
      "All required signers must be present." +
      "</li>" +

      "<li>" +
      "If witnesses are required, you are responsible for providing them." +
      "</li>" +

      "</ul>" +


      "<p>" +
      "If you need to cancel or request a change, reply to this email as soon as possible." +
      "</p>" +
      (manageUrl ? '<p style="margin:28px 0">' + actionButton(manageUrl, "Manage Your Appointment", "#54205d") + "</p>" : "") +


      '<p style="' +
      "font-size:12px;" +
      "color:#666;" +
      "margin-top:28px" +
      '">' +

      "In-person mobile notarization only. " +
      "Sign After Six does not provide legal advice and is not a Remote Online Notary service." +

      "</p>"
    );


  const plainText =
    "Hi " +
    customerName +
    ",\n\n" +

    intro +
    "\n\n" +

    "Appointment: " +
    appointmentTime +
    "\n" +

    "Location: " +
    address +
    "\n" +

    "Document: " +
    documentType +
    "\n\n" +

    "WHAT TO HAVE READY\n" +

    "- Acceptable identification\n" +
    "- Complete document\n" +
    "- All required signers\n" +
    "- Any required witnesses\n\n" +

    "If you need to cancel or request a change, reply to this email as soon as possible.\n\n" +
    (manageUrl ? "Manage your appointment:\n" + manageUrl + "\n\n" : "") +

    "Sign After Six Mobile Notary\n" +
    "When 9-to-5 doesn’t work, I do.";


  GmailApp.sendEmail(
    customer.email,

    subject,

    plainText,

    {
      htmlBody: html,

      name:
        CONFIG.SENDER_NAME,

      replyTo:
        CONFIG.OWNER_EMAIL
    }
  );
}


/**
 * Manual reminder-email test.
 *
 * Sends to OWNER_EMAIL only.
 * This does NOT touch Supabase or Calendar.
 */
function testAppointmentReminderEmail() {
  sendAppointmentReminderEmail({
    reminderType:
      "2h",

    customer: {
      name:
        "Test Customer",

      email:
        CONFIG.OWNER_EMAIL
    },

    request: {
      appointmentDisplay:
        "Tuesday, September 15, 2026 at 7:00 PM EDT",

      appointmentAt:
        "2026-09-15T23:00:00.000Z",

      address:
        "Test appointment location",

      documentType:
        "General notarization"
    }
  });
}


/* =========================================================
   GOOGLE CALENDAR - PENDING
   ========================================================= */

/**
 * Creates or updates the Pending Requests calendar hold.
 *
 * Calendar time includes:
 *
 * 33547 -> customer travel
 * appointment duration
 * customer -> 33547 travel
 */
function createPendingCalendarEvent(
  payload
) {
  const request =
    payload.request || {};

  const customer =
    payload.customer || {};

  const calendarInfo =
    payload.calendar || {};


  const calendar =
    getOrCreateCalendar(
      "PENDING_CALENDAR_ID",
      CONFIG.PENDING_CALENDAR_NAME
    );


  const times =
    calculateCalendarTimes(
      request
    );


  let event =
    null;


  if (
    calendarInfo.pendingEventId
  ) {
    event =
      calendar.getEventById(
        calendarInfo.pendingEventId
      );
  }


  if (
    !event
  ) {
    event =
      calendar.createEvent(

        "PENDING — " +
        (
          customer.name ||
          "Notary Request"
        ),

        times.start,

        times.end,

        {
          location:
            request.address ||
            "",

          description:
            buildCalendarDescription(
              "PENDING",
              payload
            )
        }
      );

  } else {

    event
      .setTitle(
        "PENDING — " +
        (
          customer.name ||
          "Notary Request"
        )
      )

      .setTime(
        times.start,
        times.end
      )

      .setLocation(
        request.address ||
        ""
      )

      .setDescription(
        buildCalendarDescription(
          "PENDING",
          payload
        )
      );
  }


  return {
    calendarId:
      calendar.getId(),

    eventId:
      event.getId(),

    start:
      times.start.toISOString(),

    end:
      times.end.toISOString()
  };
}


/* =========================================================
   GOOGLE CALENDAR - CONFIRMED
   ========================================================= */

/**
 * Deletes the Pending hold and creates
 * the Confirmed appointment block.
 */
function createConfirmedCalendarEvent(
  payload
) {
  const request =
    payload.request || {};

  const customer =
    payload.customer || {};

  const calendarInfo =
    payload.calendar || {};


  const pendingCalendar =
    getOrCreateCalendar(
      "PENDING_CALENDAR_ID",
      CONFIG.PENDING_CALENDAR_NAME
    );


  const confirmedCalendar =
    getOrCreateCalendar(
      "CONFIRMED_CALENDAR_ID",
      CONFIG.CONFIRMED_CALENDAR_NAME
    );


  /*
   * Remove the old Pending event.
   *
   * Calendar callbacks may be retried.
   * If the Pending event was already deleted,
   * that is already the desired result.
   */
  if (
    calendarInfo.pendingEventId
  ) {
    try {
      const oldPending =
        pendingCalendar.getEventById(
          calendarInfo.pendingEventId
        );

      if (
        oldPending
      ) {
        oldPending.deleteEvent();
      }

    } catch (error) {
      console.log(
        "Pending event was already removed or unavailable:",
        String(error)
      );
    }
  }


  const times =
    calculateCalendarTimes(
      request
    );


  let event =
    null;


  /*
   * First try the Confirmed event ID
   * already stored in Supabase.
   */
  if (
    calendarInfo.confirmedEventId
  ) {
    try {
      event =
        confirmedCalendar.getEventById(
          calendarInfo.confirmedEventId
        );

    } catch (error) {
      console.log(
        "Stored confirmed event could not be loaded:",
        String(error)
      );

      event =
        null;
    }
  }


  /*
   * RETRY PROTECTION
   *
   * If Google created the Confirmed event
   * but Supabase did not get a chance to save
   * its event ID, search for the existing event
   * using the unique Request ID in its description.
   */
  if (
    !event &&
    request.id
  ) {
    try {
      const searchStart =
        new Date(
          times.start.getTime() -
          24 * 60 * 60 * 1000
        );

      const searchEnd =
        new Date(
          times.end.getTime() +
          24 * 60 * 60 * 1000
        );


      const possibleEvents =
        confirmedCalendar.getEvents(
          searchStart,
          searchEnd,
          {
            search:
              String(
                request.id
              )
          }
        );


      if (
        possibleEvents &&
        possibleEvents.length
      ) {
        event =
          possibleEvents[0];
      }

    } catch (error) {
      console.log(
        "Confirmed event retry search failed:",
        String(error)
      );
    }
  }


  /*
   * Create only if the Confirmed event
   * truly does not already exist.
   */
  if (
    !event
  ) {
    event =
      confirmedCalendar.createEvent(

        "CONFIRMED — " +
        (
          customer.name ||
          "Mobile Notary"
        ),

        times.start,

        times.end,

        {
          location:
            request.address ||
            "",

          description:
            buildCalendarDescription(
              "CONFIRMED",
              payload
            )
        }
      );

  } else {
    event
      .setTitle(
        "CONFIRMED — " +
        (
          customer.name ||
          "Mobile Notary"
        )
      )

      .setTime(
        times.start,
        times.end
      )

      .setLocation(
        request.address ||
        ""
      )

      .setDescription(
        buildCalendarDescription(
          "CONFIRMED",
          payload
        )
      );
  }


  return {
    calendarId:
      confirmedCalendar.getId(),

    eventId:
      event.getId(),

    start:
      times.start.toISOString(),

    end:
      times.end.toISOString()
  };
}


/* =========================================================
   GOOGLE CALENDAR - RELEASE
   ========================================================= */

/**
 * Removes pending or confirmed events.
 *
 * Used later for:
 * decline
 * cancellation
 * expiration
 * reschedule replacement
 */
function releaseCalendarEvents(
  payload
) {
  const calendarInfo =
    payload.calendar || {};


  const pendingCalendar =
    getOrCreateCalendar(
      "PENDING_CALENDAR_ID",
      CONFIG.PENDING_CALENDAR_NAME
    );


  const confirmedCalendar =
    getOrCreateCalendar(
      "CONFIRMED_CALENDAR_ID",
      CONFIG.CONFIRMED_CALENDAR_NAME
    );


  let pendingDeleted =
    false;

  let confirmedDeleted =
    false;


  /*
   * Pending event
   */
  if (
    calendarInfo.pendingEventId
  ) {
    try {
      const pendingEvent =
        pendingCalendar.getEventById(
          calendarInfo.pendingEventId
        );


      if (
        pendingEvent
      ) {
        pendingEvent.deleteEvent();

        pendingDeleted =
          true;
      }

    } catch (error) {
      /*
       * Already gone is fine.
       * The desired end state is achieved.
       */
      console.log(
        "Pending event already removed:",
        String(error)
      );

      pendingDeleted =
        true;
    }
  }


  /*
   * Confirmed event
   */
  if (
    calendarInfo.confirmedEventId
  ) {
    try {
      const confirmedEvent =
        confirmedCalendar.getEventById(
          calendarInfo.confirmedEventId
        );


      if (
        confirmedEvent
      ) {
        confirmedEvent.deleteEvent();

        confirmedDeleted =
          true;
      }

    } catch (error) {
      console.log(
        "Confirmed event already removed:",
        String(error)
      );

      confirmedDeleted =
        true;
    }
  }


  return {
    pendingDeleted:
      pendingDeleted,

    confirmedDeleted:
      confirmedDeleted
  };
}


/* =========================================================
   GOOGLE CALENDAR - AVAILABILITY CHECK
   ========================================================= */

/**
 * Checks whether a proposed appointment block overlaps
 * anything already held on either Sign After Six calendar.
 *
 * The checked block is:
 *
 * one-way travel time before
 * + appointment duration
 * + one-way travel time after
 *
 * This returns availability only. It does not create,
 * move, edit, or delete a calendar event.
 *
 * No customer/event titles are returned, so a future
 * public availability endpoint can safely expose only
 * the boolean/count fields it chooses.
 */
function checkCalendarAvailability(
  payload
) {
  const request =
    payload.request || {};

  const calendarInfo =
    payload.calendar || {};

  const ignoreEventIds =
    Array.isArray(
      payload.ignoreEventIds
    )
      ? payload.ignoreEventIds
      : [];


  const times =
    calculateCalendarTimes(
      request
    );


  const pendingCalendar =
    getOrCreateCalendar(
      "PENDING_CALENDAR_ID",
      CONFIG.PENDING_CALENDAR_NAME
    );


  const confirmedCalendar =
    getOrCreateCalendar(
      "CONFIRMED_CALENDAR_ID",
      CONFIG.CONFIRMED_CALENDAR_NAME
    );


  /*
   * Allow update/reschedule checks to ignore
   * the appointment's own existing event.
   */
  const ignored =
    {};


  [
    calendarInfo.pendingEventId,
    calendarInfo.confirmedEventId
  ]
    .concat(
      ignoreEventIds
    )
    .forEach(
      function(eventId) {
        if (
          eventId
        ) {
          ignored[
            String(
              eventId
            )
          ] = true;
        }
      }
    );


  const pendingConflicts =
    countCalendarConflicts(
      pendingCalendar,
      times.start,
      times.end,
      ignored
    );


  const confirmedConflicts =
    countCalendarConflicts(
      confirmedCalendar,
      times.start,
      times.end,
      ignored
    );


  const conflictCount =
    pendingConflicts +
    confirmedConflicts;


  return {
    available:
      conflictCount === 0,

    conflictCount:
      conflictCount,

    pendingConflictCount:
      pendingConflicts,

    confirmedConflictCount:
      confirmedConflicts,

    blockStart:
      times.start.toISOString(),

    appointmentStart:
      times.appointmentStart.toISOString(),

    appointmentEnd:
      times.appointmentEnd.toISOString(),

    blockEnd:
      times.end.toISOString()
  };
}


/**
 * Counts strict time overlaps on one calendar.
 *
 * Back-to-back blocks are allowed:
 *
 * existing end == proposed start
 * or
 * existing start == proposed end
 *
 * are NOT treated as conflicts.
 */
function countCalendarConflicts(
  calendar,
  proposedStart,
  proposedEnd,
  ignoredEventIds
) {
  const events =
    calendar.getEvents(
      proposedStart,
      proposedEnd
    );


  let count =
    0;


  events.forEach(
    function(event) {

      let eventId =
        "";

      try {
        eventId =
          String(
            event.getId() ||
            ""
          );

      } catch (error) {
        eventId =
          "";
      }


      if (
        eventId &&
        ignoredEventIds &&
        ignoredEventIds[eventId]
      ) {
        return;
      }


      const eventStart =
        event.getStartTime();

      const eventEnd =
        event.getEndTime();


      const overlaps =
        eventStart.getTime() <
          proposedEnd.getTime() &&
        eventEnd.getTime() >
          proposedStart.getTime();


      if (
        overlaps
      ) {
        count +=
          1;
      }
    }
  );


  return count;
}


/* =========================================================
   CALENDAR TIME CALCULATIONS
   ========================================================= */

function calculateCalendarTimes(
  request
) {
  if (
    !request.appointmentAt
  ) {
    throw new Error(
      "Appointment time is missing."
    );
  }


  const appointmentStart =
    new Date(
      request.appointmentAt
    );


  if (
    isNaN(
      appointmentStart.getTime()
    )
  ) {
    throw new Error(
      "Invalid appointment time."
    );
  }


  /*
   * Travel time is one-way.
   * We use it once before and once after.
   */
  const travelSeconds =
    Math.max(
      0,

      Number(
        request.travelSeconds ||
        0
      )
    );


  const durationMinutes =
    Math.max(
      30,

      Number(
        request.durationMinutes ||
        30
      )
    );


  /*
   * Travel TO customer.
   */
  const blockStart =
    new Date(
      appointmentStart.getTime() -
      (
        travelSeconds *
        1000
      )
    );


  /*
   * Appointment itself.
   */
  const appointmentEnd =
    new Date(
      appointmentStart.getTime() +
      (
        durationMinutes *
        60 *
        1000
      )
    );


  /*
   * Travel BACK to base.
   */
  const blockEnd =
    new Date(
      appointmentEnd.getTime() +
      (
        travelSeconds *
        1000
      )
    );


  return {
    start:
      blockStart,

    appointmentStart:
      appointmentStart,

    appointmentEnd:
      appointmentEnd,

    end:
      blockEnd
  };
}


/* =========================================================
   CALENDAR DESCRIPTION
   ========================================================= */

function buildCalendarDescription(
  status,
  payload
) {
  const request =
    payload.request || {};

  const customer =
    payload.customer || {};

  const quote =
    payload.quote || {};


  const lines = [
    "Sign After Six Mobile Notary",

    "",

    "Status: " +
    status,

    "",

    "CUSTOMER",

    "Name: " +
    (
      customer.name ||
      ""
    ),

    "Phone: " +
    (
      customer.phone ||
      ""
    ),

    "Email: " +
    (
      customer.email ||
      ""
    ),

    "",

    "APPOINTMENT",

    "Appointment time: " +
    (
      request.appointmentDisplay ||
      request.appointmentAt ||
      ""
    ),

    "Address: " +
    (
      request.address ||
      ""
    ),

    "One-way travel time: " +
    formatTravelTime(
      request.travelSeconds
    ),

    "Appointment duration: " +
    (
      request.durationMinutes ||
      30
    ) +
    " minutes",

    "",

    "SERVICE",

    "Document: " +
    (
      request.documentType ||
      ""
    ),

    "Notarial act: " +
    (
      request.notarialAct ||
      ""
    ),

    "Signers: " +
    (
      request.signerCount ||
      ""
    ),

    "Acts: " +
    (
      request.actsUnknown
        ? "Not sure"
        : (
            request.actCount ||
            ""
          )
    ),

    "",

    "QUOTE",

    "Total: " +
    money(
      quote.total ||
      0
    ),

    "",

    "Request ID: " +
    (
      request.id ||
      ""
    )
  ];


  if (
    request.comments
  ) {
    lines.push(
      "",
      "CUSTOMER COMMENTS",
      request.comments
    );
  }


  if (
    request.locationNotes
  ) {
    lines.push(
      "",
      "LOCATION NOTES",
      request.locationNotes
    );
  }


  return lines.join(
    "\n"
  );
}


/* =========================================================
   CALENDAR CREATION / LOOKUP
   ========================================================= */

function getOrCreateCalendar(
  propertyName,
  calendarName
) {
  const properties =
    PropertiesService
      .getScriptProperties();


  const savedId =
    properties.getProperty(
      propertyName
    );


  if (
    savedId
  ) {
    const existing =
      CalendarApp
        .getCalendarById(
          savedId
        );


    if (
      existing
    ) {
      return existing;
    }
  }


  /*
   * Calendar might already exist
   * even if the Script Property is gone.
   */
  const matches =
    CalendarApp
      .getCalendarsByName(
        calendarName
      );


  if (
    matches &&
    matches.length
  ) {
    properties.setProperty(
      propertyName,
      matches[0].getId()
    );

    return matches[0];
  }


  /*
   * Create new business calendar.
   */
  const newCalendar =
    CalendarApp
      .createCalendar(
        calendarName,

        {
          description:
            "Created automatically by Sign After Six Mobile Notary.",

          timeZone:
            CONFIG.TIME_ZONE
        }
      );


  properties.setProperty(
    propertyName,
    newCalendar.getId()
  );


  return newCalendar;
}


/* =========================================================
   CALENDAR SETUP TEST
   ========================================================= */

/**
 * RUN THIS ONCE after replacing Code.gs.
 *
 * It:
 * 1. requests Google Calendar permission
 * 2. creates the two calendars if needed
 * 3. saves their IDs as Script Properties
 */
function testCalendarSetup() {
  const pending =
    getOrCreateCalendar(
      "PENDING_CALENDAR_ID",
      CONFIG.PENDING_CALENDAR_NAME
    );


  const confirmed =
    getOrCreateCalendar(
      "CONFIRMED_CALENDAR_ID",
      CONFIG.CONFIRMED_CALENDAR_NAME
    );


  console.log(
    "Pending calendar: " +
    pending.getName()
  );


  console.log(
    "Pending calendar ID: " +
    pending.getId()
  );


  console.log(
    "Confirmed calendar: " +
    confirmed.getName()
  );


  console.log(
    "Confirmed calendar ID: " +
    confirmed.getId()
  );
}


/* =========================================================
   EMAIL HELPERS
   ========================================================= */

function buildQuoteHtml(
  quote
) {
  const lines =
    Array.isArray(
      quote.lines
    )
      ? quote.lines
      : [];


  if (
    !lines.length
  ) {
    return "";
  }


  let html =
    "<h3>Price breakdown</h3>" +

    '<table style="' +
    "border-collapse:collapse;" +
    "width:100%" +
    '">';


  lines.forEach(
    function(line) {

      let label =
        "Charge";

      let amount =
        0;


      /*
       * Current Sign After Six quote format:
       *
       * [
       *   "Mobile/travel",
       *   25
       * ]
       */
      if (
        Array.isArray(
          line
        )
      ) {
        label =
          line[0] != null
            ? String(
                line[0]
              )
            : "Charge";

        amount =
          line[1] != null
            ? line[1]
            : 0;
      }


      /*
       * Also support object-style quote
       * lines so future backend changes
       * don't break receipts.
       */
      else if (
        line &&
        typeof line ===
          "object"
      ) {
        label =
          line.label ||
          line.name ||
          line.description ||
          "Charge";


        if (
          line.amount !==
            undefined &&
          line.amount !==
            null
        ) {
          amount =
            line.amount;
        }

        else if (
          line.value !==
            undefined &&
          line.value !==
            null
        ) {
          amount =
            line.value;
        }

        else if (
          line.total !==
            undefined &&
          line.total !==
            null
        ) {
          amount =
            line.total;
        }

        else if (
          line.price !==
            undefined &&
          line.price !==
            null
        ) {
          amount =
            line.price;
        }

        else {
          amount =
            0;
        }
      }


      html +=
        "<tr>" +

        '<td style="' +
        "padding:6px;" +
        "border-bottom:1px solid #ddd" +
        '">' +

        escapeHtml(
          label
        ) +

        "</td>" +

        '<td style="' +
        "padding:6px;" +
        "border-bottom:1px solid #ddd;" +
        "text-align:right" +
        '">' +

        money(
          amount
        ) +

        "</td>" +

        "</tr>";
    }
  );


  html +=
    "</table>";


  return html;
}


function emailShell(
  heading,
  contents
) {
  return (
    '<div style="' +
    "font-family:Arial,sans-serif;" +
    "max-width:680px;" +
    "margin:auto;" +
    "color:#222" +
    '">' +

    '<div style="' +
    "background:#54205d;" +
    "color:white;" +
    "padding:22px;" +
    "border-radius:14px 14px 0 0" +
    '">' +

    '<h2 style="margin:0">' +
    "Sign After Six Mobile Notary" +
    "</h2>" +

    '<p style="margin:5px 0 0">' +
    escapeHtml(
      heading
    ) +
    "</p>" +

    "</div>" +

    '<div style="' +
    "padding:22px;" +
    "border:1px solid #ddd;" +
    "border-top:0;" +
    "border-radius:0 0 14px 14px" +
    '">' +

    contents +

    '<p style="' +
    "font-size:13px;" +
    "color:#666;" +
    "margin-top:30px" +
    '">' +

    "Sign After Six Mobile Notary" +
    "<br>" +

    "When 9-to-5 doesn’t work, I do." +

    "</p>" +

    "</div>" +

    "</div>"
  );
}


function actionButton(
  url,
  label,
  color
) {
  return (
    '<a href="' +
    escapeHtml(
      url
    ) +
    '" style="' +

    "display:inline-block;" +

    "background:" +
    color +
    ";" +

    "color:white;" +

    "text-decoration:none;" +

    "padding:13px 21px;" +

    "border-radius:8px;" +

    "font-weight:bold" +

    '">' +

    escapeHtml(
      label
    ) +

    "</a>"
  );
}


/* =========================================================
   GENERAL HELPERS
   ========================================================= */

function money(
  value
) {
  const number =
    Number(
      value
    );


  if (
    !Number.isFinite(
      number
    )
  ) {
    return "$0.00";
  }


  return number.toLocaleString(
    "en-US",

    {
      style:
        "currency",

      currency:
        "USD"
    }
  );
}


function escapeHtml(
  value
) {
  return String(
    value == null
      ? ""
      : value
  )

    .replace(
      /&/g,
      "&amp;"
    )

    .replace(
      /</g,
      "&lt;"
    )

    .replace(
      />/g,
      "&gt;"
    )

    .replace(
      /"/g,
      "&quot;"
    )

    .replace(
      /'/g,
      "&#039;"
    );
}


function jsonResponse(
  data
) {
  return ContentService

    .createTextOutput(
      JSON.stringify(
        data
      )
    )

    .setMimeType(
      ContentService
        .MimeType
        .JSON
    );
}


function formatTravelTime(
  seconds
) {
  const totalSeconds =
    Math.max(
      0,
      Number(
        seconds ||
        0
      )
    );


  if (
    !totalSeconds
  ) {
    return "Not calculated";
  }


  const minutes =
    Math.round(
      totalSeconds /
      60
    );


  if (
    minutes < 60
  ) {
    return (
      minutes +
      " minutes"
    );
  }


  const hours =
    Math.floor(
      minutes /
      60
    );


  const remaining =
    minutes %
    60;


  if (
    remaining === 0
  ) {
    return (
      hours +
      (
        hours === 1
          ? " hour"
          : " hours"
      )
    );
  }


  return (
    hours +
    (
      hours === 1
        ? " hour "
        : " hours "
    ) +
    remaining +
    " minutes"
  );
}


/* =========================================================
   MANUAL TEST FUNCTIONS
   ========================================================= */

function testMailer() {
  GmailApp.sendEmail(
    CONFIG.OWNER_EMAIL,

    "Sign After Six Mailer Test",

    "Your Sign After Six Gmail mailer is working.",

    {
      name:
        CONFIG.SENDER_NAME
    }
  );
}
