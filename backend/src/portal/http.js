// Request/response helpers shared by every portal route.

export function nonce() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b));
}

export function securityHeaders(n, isHttps) {
  const h = {
    "Content-Security-Policy": [
      "default-src 'none'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https://www.meridiangray.in",
      `script-src 'nonce-${n}'`,
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cache-Control": "no-store",
  };
  if (isHttps) h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return h;
}

export function html(req, body, n, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(n, req.url.startsWith("https:")), ...headers },
  });
}

export function redirect(req, to, headers = {}) {
  return new Response(null, {
    status: 303,
    headers: { Location: to, ...securityHeaders("x", req.url.startsWith("https:")), ...headers },
  });
}

export async function readForm(request) {
  const ct = request.headers.get("Content-Type") || "";
  if (!/application\/x-www-form-urlencoded|multipart\/form-data/.test(ct)) return {};
  const fd = await request.formData();
  const out = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v !== "string") continue;
    out[k] = v.length > 5000 ? v.slice(0, 5000) : v;
  }
  return out;
}

// Same-origin check for every state-changing request. SameSite=Lax cookies
// already stop most cross-site posts; this closes the rest.
export function sameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin) return origin === url.origin;
  const sfs = request.headers.get("Sec-Fetch-Site");
  return sfs === "same-origin" || sfs === "none";
}

export function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

// Flash messages travel as a short code in ?m= so nothing user-typed is ever
// reflected back into the page.
export const FLASH = {
  created: "Client created.",
  saved: "Changes saved.",
  added: "Person added. They'll get an email with a sign-in link.",
  added_noinvite: "Person added. No email was sent; use Send sign-in link when you're ready.",
  invited: "Sign-in link sent.",
  role: "Role updated.",
  removed: "Person removed. Their access ended immediately.",
  archived: "Client archived. Their people can no longer sign in.",
  restored: "Client reactivated.",
  switched: "Switched company.",
  signedout_all: "Signed out of every other device.",
  sent: "Sent. The other side has been emailed.",
  requested: "Request sent. We'll confirm the time, or suggest another, by email.",
  scheduled: "Meeting scheduled. The client has been emailed.",
  logged: "Past meeting added. Write its minutes when ready; no invite was sent.",
  nomeet: { msg: "Meeting saved, but a Google Meet link couldn't be created (is the calendar connected?). Paste a link under Reschedule or edit.", err: true },
  cancelled: "Meeting cancelled. The client has been told.",
  published: "Minutes published. The client has 48 hours to confirm or raise a correction.",
  confirmed: "Thanks. The minutes are confirmed as the record of the meeting.",
  correction: "Correction sent. We'll revise the minutes and send them back to you.",
  drafted: "Draft invoice created from the schedule. Check it, then issue it.",
  issued: "Invoice issued and emailed to the client's Owners and Finance people.",
  reminded: "Reminder sent.",
  payment: "Payment recorded.",
  voided: "Invoice cancelled. The client has been told.",
  deleted: "Draft deleted.",
  paid: "Payment received. Thank you! A receipt is on its way to your inbox.",
  signed: "Signed. A copy with the signature record has been emailed to you.",
  declined: "Sent. We'll revise it and send it back to you.",
  agr_sent: "Sent for signature. The client's Owners and Finance people have been emailed.",
  withdrawn: "Agreement withdrawn.",
  e_pay: { msg: "The payment didn't go through, or couldn't be confirmed. Nothing was charged twice. Try again, or pay by bank transfer.", err: true },
  e_invoice: { msg: "Check the dates and add at least one line with an amount.", err: true },
  e_state: { msg: "Add the client's state in their details first; it decides CGST+SGST or IGST.", err: true },
  e_amount: { msg: "Enter the amount received or the TDS deducted.", err: true },
  e_schedule: { msg: "Pick a client, give it a name, and add a monthly amount or at least one instalment.", err: true },
  e_agreement: { msg: "Pick a client and fill in the title and text.", err: true },
  e_sign: { msg: "Type your full name and tick the box to sign.", err: true },
  e_changed: { msg: "This document changed since it was sent, so it can't be signed. We've been notified.", err: true },
  e_msg: { msg: "Add a subject and a message.", err: true },
  e_meeting: { msg: "Pick a date and time in the future, and fill in what it's about.", err: true },
  e_minutes: { msg: "Add at least one discussion point or decision before publishing.", err: true },
  e_email: { msg: "That doesn't look like a valid email address.", err: true },
  e_name: { msg: "Company name is required.", err: true },
  e_gstin: { msg: "GSTIN should be 15 characters, like 19ABCDE1234F1Z5.", err: true },
  e_exists: { msg: "That person already has access to this company.", err: true },
  e_lastowner: { msg: "Every company needs at least one Owner. Make someone else Owner first.", err: true },
  e_self: { msg: "You can't remove yourself. Ask another Owner, or contact us.", err: true },
  e_staff: { msg: "That email belongs to the Meridian Gray team and can't be added as a client.", err: true },
  e_mail: { msg: "Saved, but the email couldn't be sent. Try Send sign-in link again in a minute.", err: true },
};

export function flashFrom(url) {
  const m = url.searchParams.get("m");
  const f = m && FLASH[m];
  if (!f) return null;
  return typeof f === "string" ? { msg: f } : f;
}
