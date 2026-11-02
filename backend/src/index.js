/**
 * Meridian Gray — website backend (Cloudflare Worker)
 * Handles: contact/project-brief form, System Finder health-check submission
 * (also pushed into Zoho CRM as a Lead), newsletter signup, and
 * strategy-call booking (with optional real Google Calendar sync). Writes
 * to D1, sends notification email via Brevo.
 *
 * Bindings required (set in wrangler.toml / dashboard):
 *   - DB                   : D1 database binding (meridiangray-db)
 *   - BREVO_API_KEY        : secret, Brevo transactional email API key
 *   - NOTIFY_EMAIL         : env var, where new-lead notifications are sent
 *   - ALLOWED_ORIGIN       : env var, e.g. https://www.meridiangray.in (CORS)
 *   - GOOGLE_CLIENT_ID     : secret, OAuth client id (optional — see README)
 *   - GOOGLE_CLIENT_SECRET : secret, OAuth client secret (optional — see README)
 *   - ZOHO_CLIENT_ID       : secret, OAuth client id (optional — see README)
 *   - ZOHO_CLIENT_SECRET   : secret, OAuth client secret (optional — see README)
 *   - ZOHO_DC              : env var, Zoho data center, e.g. "in" / "com" / "eu"
 */

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function isEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ---------------- Spam / abuse protection ----------------
// Simple fixed-window IP rate limiting on the public POST endpoints, backed by
// D1 (no external service needed). This only ever applies to form submissions
// (POST) — it never touches page loads or crawling, so it can't restrict
// Google, GPTBot, ClaudeBot, PerplexityBot or any other AI/search crawler from
// reading the site (see robots.txt, which explicitly allows all of them).
let rateLimitTableReady = false;

async function ensureRateLimitTable(env) {
  if (rateLimitTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS rate_limits (
      rl_key TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL
    )`
  ).run();
  rateLimitTableReady = true;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
}

// Returns { limited: boolean }. Fails open (never blocks a real submission)
// if D1 is unreachable for some reason — availability beats strictness here.
async function checkRateLimit(env, request, bucket, { limit, windowSec }) {
  try {
    await ensureRateLimitTable(env);
    const ip = clientIp(request);
    const windowStart = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
    const key = `${bucket}:${ip}:${windowStart}`;

    await env.DB.prepare(
      `INSERT INTO rate_limits (rl_key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(rl_key) DO UPDATE SET count = count + 1`
    )
      .bind(key, windowStart)
      .run();

    const row = await env.DB.prepare(`SELECT count FROM rate_limits WHERE rl_key = ?`).bind(key).first();
    return { limited: (row?.count || 0) > limit };
  } catch (e) {
    console.log("Rate limit check failed (failing open):", e && e.message);
    return { limited: false };
  }
}

function rateLimitedResponse(env) {
  return json(
    { error: "rate_limited", message: "Too many requests from this connection — please wait a few minutes and try again." },
    429,
    env
  );
}

// ---------------- Health Check report locking ----------------
// Each Health Check submission gets a report_token, returned to the
// frontend so it can be kept (localStorage, and emailed back as a link)
// and later checked against this endpoint. Booking a call does NOT unlock
// the report by itself — the report only unlocks once the booked call has
// actually happened: a scheduled job (see unlockDueReports(), run daily)
// finds confirmed bookings whose call date was 5+ days ago, unlocks the
// matching report, and emails the visitor the link. Nothing here infers
// "unlocked" just from a booking existing.
let reportColumnsReady = false;

async function ensureReportColumns(env) {
  if (reportColumnsReady) return;
  for (const stmt of [
    `ALTER TABLE health_check_submissions ADD COLUMN report_token TEXT`,
    `ALTER TABLE health_check_submissions ADD COLUMN report_unlocked INTEGER DEFAULT 0`,
  ]) {
    try {
      await env.DB.prepare(stmt).run();
    } catch (e) {
      // "duplicate column name" once the column already exists — expected
      // on every call after the first; anything else just gets logged.
      if (!/duplicate column/i.test(String(e && e.message))) {
        console.log("ensureReportColumns:", e && e.message);
      }
    }
  }
  reportColumnsReady = true;
}

let callBookingReportColumnsReady = false;

async function ensureCallBookingReportColumns(env) {
  if (callBookingReportColumnsReady) return;
  for (const stmt of [
    `ALTER TABLE call_bookings ADD COLUMN report_token TEXT`,
    `ALTER TABLE call_bookings ADD COLUMN unlock_email_sent INTEGER DEFAULT 0`,
  ]) {
    try {
      await env.DB.prepare(stmt).run();
    } catch (e) {
      if (!/duplicate column/i.test(String(e && e.message))) {
        console.log("ensureCallBookingReportColumns:", e && e.message);
      }
    }
  }
  callBookingReportColumnsReady = true;
}

async function handleReportStatus(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  if (!token) return json({ error: "token is required" }, 400, env);

  await ensureReportColumns(env);
  const row = await env.DB.prepare(`SELECT report_unlocked FROM health_check_submissions WHERE report_token = ?`)
    .bind(token)
    .first();
  if (!row) return json({ error: "not_found" }, 404, env);

  return json({ ok: true, unlocked: !!row.report_unlocked }, 200, env);
}

// Run on a schedule (see the Worker's `scheduled` export / cron trigger in
// wrangler.toml), not per-request: finds confirmed bookings whose call date
// was at least 5 days ago and that haven't had their unlock email sent yet,
// unlocks the matching Health Check report (by the report_token carried on
// the booking row, falling back to matching email), and emails the visitor
// the link. Marks each booking done so it's never processed twice.
async function unlockDueReports(env) {
  await ensureReportColumns(env);
  await ensureCallBookingReportColumns(env);

  const due = await env.DB.prepare(
    `SELECT * FROM call_bookings
     WHERE status = 'confirmed'
       AND unlock_email_sent = 0
       AND call_date <= date('now', '-5 days')`
  ).all();

  for (const row of due?.results || []) {
    try {
      let reportToken = row.report_token;
      if (reportToken) {
        await env.DB.prepare(`UPDATE health_check_submissions SET report_unlocked = 1 WHERE report_token = ?`).bind(reportToken).run();
      } else if (row.email) {
        await env.DB.prepare(`UPDATE health_check_submissions SET report_unlocked = 1 WHERE email = ? COLLATE NOCASE`).bind(row.email).run();
        const hc = await env.DB.prepare(`SELECT report_token FROM health_check_submissions WHERE email = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1`)
          .bind(row.email)
          .first();
        reportToken = hc?.report_token || null;
      }

      if (isEmail(row.email)) {
        await sendBrevoEmail(env, {
          to: row.email,
          subject: `Your full report is unlocked — ${row.business_name || row.name}`,
          preheader: `Your Business Health Check report is ready to view in full.`,
          htmlContent: `
            <h2 style="margin:0 0 14px;font-size:19px;">Your full report is unlocked, ${String(row.name || "").split(" ")[0] || "there"}.</h2>
            <p style="margin:0 0 14px;">Thanks for the call — here's the complete report with every finding, the full diagnosis, and the recommended plan.</p>
            ${
              reportToken
                ? `<div style="margin-top:20px;">${emailButton("View your full report", `https://www.meridiangray.in/where-you-stand.html?rtoken=${reportToken}`)}</div>`
                : ""
            }
          `,
        });
      }

      await env.DB.prepare(`UPDATE call_bookings SET unlock_email_sent = 1 WHERE id = ?`).bind(row.id).run();
    } catch (e) {
      console.log("unlockDueReports: failed for booking", row.id, e && e.message);
    }
  }

  return due?.results?.length || 0;
}

// ---------------- Branded email shell ----------------
// Wraps every email body in the site's own visual identity (same accent blue,
// ink/mute palette and Plus Jakarta Sans font stack as meridiangray.in) so
// transactional mail reads as a real, designed piece of the brand rather than
// a bare system notice — and matches what a recipient sees when they visit
// the site, for the same reason that helps with spam perception: consistent
// sender identity, real branding, a real postal address, and a plain-text
// alternative.
const BRAND = {
  ink: "#111111",
  blue: "#244BDB",
  blueLight: "#9FB4FF",
  mute: "#5B606B",
  faint: "#8A8F9C",
  bg: "#F5F6F8",
  card: "#FFFFFF",
  border: "#E3E5EA",
  green: "#1a7f3c",
  red: "#b3261e",
  font: "'Plus Jakarta Sans',Helvetica,Arial,sans-serif",
};

function emailButton(label, href, { variant = "solid" } = {}) {
  const solid = `background:${BRAND.blue};color:#ffffff;border:1px solid ${BRAND.blue};`;
  const outline = `background:transparent;color:${BRAND.ink};border:1px solid ${BRAND.ink};`;
  const danger = `background:#ffffff;color:${BRAND.red};border:1px solid ${BRAND.red};`;
  const style = variant === "outline" ? outline : variant === "danger" ? danger : solid;
  return `<a href="${href}" style="display:inline-block;${style}padding:13px 24px;font-family:${BRAND.font};font-size:14px;font-weight:700;text-decoration:none;letter-spacing:.01em;margin:4px 10px 4px 0;">${label}</a>`;
}

function emailShell(bodyHtml, { preheader = "" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Meridian Gray</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:${BRAND.font};color:${BRAND.ink};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:32px 14px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${BRAND.card};border:1px solid ${BRAND.border};">
<tr><td style="background:${BRAND.ink};padding:26px 32px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-left:3px solid ${BRAND.blue};padding-left:12px;">
    <div style="font-family:${BRAND.font};font-size:19px;font-weight:700;letter-spacing:-.02em;color:#ffffff;line-height:1;">MERIDIAN <span style="color:${BRAND.blueLight};font-style:normal;">GRAY</span></div>
    <div style="font-family:${BRAND.font};font-size:9px;letter-spacing:.32em;text-transform:uppercase;color:${BRAND.faint};margin-top:7px;">Connected Business Systems</div>
  </td></tr></table>
</td></tr>
<tr><td style="padding:36px 32px;font-family:${BRAND.font};font-size:15px;line-height:1.6;color:${BRAND.ink};">
${bodyHtml}
</td></tr>
<tr><td style="background:${BRAND.bg};padding:22px 32px;border-top:1px solid ${BRAND.border};">
  <p style="margin:0;font-family:${BRAND.font};font-size:12px;line-height:1.7;color:${BRAND.faint};">
    Meridian Gray &middot; Office 215, Center Point, 21 Hemanta Basu Sarani, Lal Dighi, B.B.D. Bagh, Kolkata 700001<br>
    <a href="https://www.meridiangray.in" style="color:${BRAND.blue};text-decoration:none;">meridiangray.in</a> &middot; <a href="mailto:info@meridiangray.in" style="color:${BRAND.blue};text-decoration:none;">info@meridiangray.in</a> &middot; +91 79729 21514
  </p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

async function sendBrevoEmail(env, { subject, htmlContent, to, replyTo, preheader }) {
  if (!env.BREVO_API_KEY) return { skipped: true };
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: "Meridian Gray", email: env.SENDER_EMAIL || "no-reply@meridiangray.in" },
      to: [{ email: to || env.NOTIFY_EMAIL }],
      replyTo: replyTo ? { email: replyTo } : undefined,
      subject,
      htmlContent: emailShell(htmlContent, { preheader: preheader || subject }),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.log("Brevo send failed:", resp.status, text);
    return { ok: false, status: resp.status, text };
  }
  return { ok: true };
}

async function handleContact(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON body" }, 400, env);

  const {
    name = "",
    business_name = "",
    industry = "",
    email = "",
    phone = "",
    website = "",
    main_problem = "",
    current_process = "",
    preferred_contact = "",
    planned_investment = "",
  } = body;

  if (!name || !isEmail(email) || !main_problem) {
    return json({ error: "name, a valid email, and main_problem are required" }, 400, env);
  }

  await env.DB.prepare(
    `INSERT INTO contact_submissions
      (name, business_name, industry, email, phone, website, main_problem, current_process, preferred_contact, planned_investment)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(name, business_name, industry, email, phone, website, main_problem, current_process, preferred_contact, planned_investment)
    .run();

  await sendBrevoEmail(env, {
    subject: `New enquiry — ${business_name || name}`,
    replyTo: email,
    htmlContent: `
      <h2>New project brief submitted</h2>
      <p><b>Name:</b> ${name}</p>
      <p><b>Business:</b> ${business_name}</p>
      <p><b>Industry:</b> ${industry}</p>
      <p><b>Email:</b> ${email}</p>
      <p><b>Phone/WhatsApp:</b> ${phone}</p>
      <p><b>Website:</b> ${website}</p>
      <p><b>Main problem:</b> ${main_problem}</p>
      <p><b>How it works today:</b> ${current_process}</p>
      <p><b>Preferred contact:</b> ${preferred_contact}</p>
      <p><b>Planned investment:</b> ${planned_investment}</p>
    `,
  });

  return json({ ok: true }, 200, env);
}

// The frontend System Finder already computes its own weighted scores per
// sector (research/design/develop/automate/market + overall), so the backend
// trusts and stores what it sends rather than recomputing from raw answers —
// the raw answers (every question id -> chosen option index/indices) and the
// visitor's full info form are stored as-is (JSON) so nothing is lost even if
// the question set changes later.
async function handleHealthCheck(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON body" }, 400, env);

  const {
    sector = "",
    business_type = "",
    custom_label = "",
    answers = {},
    answers_text = "",
    scores = {},
    info = {},
  } = body;

  if (!sector || !business_type) {
    return json({ error: "sector and business_type are required" }, 400, env);
  }

  const {
    name = "",
    email = "",
    phone = "",
    cc = "",
    biz: business_name = "",
    role = "",
    web: website = "",
    year: year_established = "",
    city = "",
    region = "",
    branches = "",
    team: team_size = "",
    turnover = "",
  } = info;

  await ensureReportColumns(env);
  const reportToken = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO health_check_submissions
      (sector, business_type, custom_label, business_name, name, role, email, phone, cc,
       website, year_established, city, region, branches, team_size, turnover,
       answers_json, answers_text, info_json,
       score_overall, score_research, score_design, score_develop, score_automate, score_market,
       report_token)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      sector,
      business_type,
      custom_label,
      business_name,
      name,
      role,
      email,
      phone,
      cc,
      website,
      year_established,
      city,
      region,
      branches,
      team_size,
      turnover,
      JSON.stringify(answers),
      answers_text,
      JSON.stringify(info),
      scores.overall ?? null,
      scores.research ?? null,
      scores.design ?? null,
      scores.develop ?? null,
      scores.automate ?? null,
      scores.market ?? null,
      reportToken
    )
    .run();

  // Internal-only notification to the Meridian Gray team — never to the visitor.
  // (replyTo is set to the visitor's email, purely so hitting "reply" in the inbox
  // goes straight to them; the email itself only ever lands in NOTIFY_EMAIL.)
  const escapeHtml = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  await sendBrevoEmail(env, {
    subject: `New Health Check — ${business_name || sector}`,
    replyTo: isEmail(email) ? email : undefined,
    htmlContent: `
      <h2>New Business Health Check submitted</h2>
      <p><b>Name:</b> ${name} ${role ? `(${role})` : ""}</p>
      <p><b>Business:</b> ${business_name}</p>
      <p><b>Sector:</b> ${sector} &middot; <b>Type:</b> ${custom_label || business_type}</p>
      <p><b>Email:</b> ${email} &middot; <b>Phone:</b> ${cc} ${phone}</p>
      <p><b>Website:</b> ${website || "—"} &middot; <b>City:</b> ${city || "—"} &middot; <b>Established:</b> ${year_established || "—"}</p>
      <p><b>Operates:</b> ${region || "—"} &middot; <b>Offices:</b> ${branches || "—"} &middot; <b>Team:</b> ${team_size || "—"} &middot; <b>Turnover:</b> ${turnover || "—"}</p>
      <p><b>Overall score:</b> ${scores.overall ?? "n/a"}/100</p>
      <p><b>Research:</b> ${scores.research ?? "n/a"} &middot; <b>Design:</b> ${scores.design ?? "n/a"} &middot; <b>Develop:</b> ${scores.develop ?? "n/a"} &middot; <b>Automate:</b> ${scores.automate ?? "n/a"} &middot; <b>Market:</b> ${scores.market ?? "n/a"}</p>
      <h3>Full Health Check — every question &amp; answer</h3>
      <pre style="white-space:pre-wrap;font:13px/1.5 monospace;background:#F5F6F8;padding:16px;border-radius:8px">${escapeHtml(answers_text || "(not provided)")}</pre>
    `,
  });

  // Push into Zoho CRM as a Lead — never blocks or fails the submission if
  // Zoho isn't connected yet or the push itself fails (see /zoho/oauth/start).
  await pushHealthCheckToZoho(env, {
    name,
    email,
    phone,
    cc,
    business_name,
    sector,
    business_type,
    custom_label,
    website,
    city,
    region,
    branches,
    team_size,
    turnover,
    year_established,
    scores,
    answers_text,
  });

  return json({ ok: true, report_token: reportToken }, 200, env);
}

async function handleNewsletter(request, env) {
  const body = await request.json().catch(() => null);
  const email = body?.email || "";
  if (!isEmail(email)) return json({ error: "A valid email is required" }, 400, env);

  try {
    await env.DB.prepare(`INSERT INTO newsletter_subscribers (email) VALUES (?)`).bind(email).run();
  } catch (e) {
    // Unique constraint -> already subscribed; treat as success.
  }
  return json({ ok: true }, 200, env);
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function formatCallDate(dateKey) {
  // dateKey is "YYYY-MM-DD" (IST calendar date, as chosen on the site)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey || "");
  if (!m) return dateKey || "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DAY_NAMES[d.getUTCDay()]}, ${+m[3]} ${MONTH_NAMES[d.getUTCMonth()]} ${m[1]}`;
}

async function isSlotTaken(env, date, time) {
  const start = parseSlotToUtc(date, time);
  if (!start) return false;
  const end = new Date(start.getTime() + CALL_DURATION_MIN * 60000);
  const busy = await getBusyTimes(env, start.toISOString(), end.toISOString());
  if (busy === null) return false; // calendar not connected — can't check, allow it through
  return busy.some((b) => new Date(b.start).getTime() < end.getTime() && start.getTime() < new Date(b.end).getTime());
}

async function handleBookCall(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON body" }, 400, env);

  const {
    date = "",
    time = "",
    mode = "video",
    notes = "",
    sector = "",
    business_type = "",
    score_overall = null,
    info = {},
    report_token = "",
  } = body;

  const { name = "", email = "", phone = "", cc = "", biz: business_name = "" } = info;

  if (!date || !time) {
    return json({ error: "date and time are required" }, 400, env);
  }
  if (!name || !isEmail(email)) {
    return json({ error: "name and a valid email are required" }, 400, env);
  }

  // Re-check the real calendar right before writing anything — the frontend's
  // /api/availability already hid taken slots, but this closes the race/direct-
  // call gap where two requests could otherwise land on the same slot.
  if (await isSlotTaken(env, date, time)) {
    return json({ error: "slot_taken", message: "That slot was just taken — please pick another time." }, 409, env);
  }

  const actionToken = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO call_bookings
      (name, email, phone, cc, business_name, sector, business_type, call_date, call_time, mode, notes, score_overall, status, action_token)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(name, email, phone, cc, business_name, sector, business_type, date, time, mode, notes, score_overall, "pending", actionToken)
    .run();

  // Carry the Health Check report_token along on the booking row (best
  // effort) so the scheduled unlock job can find exactly which report to
  // unlock once the call has actually happened — see unlockDueReports().
  if (report_token) {
    await ensureCallBookingReportColumns(env);
    await env.DB.prepare(`UPDATE call_bookings SET report_token = ? WHERE action_token = ?`)
      .bind(report_token, actionToken)
      .run()
      .catch(() => {});
  }

  const modeLabel = mode === "phone" ? "Phone call — we call you" : "Video call — Google Meet or Zoom";
  const niceDate = formatCallDate(date);
  const baseUrl = "https://meridiangray-backend.work-meridiangray.workers.dev";
  const acceptUrl = `${baseUrl}/api/booking-action?token=${actionToken}&action=accept`;
  const declineUrl = `${baseUrl}/api/booking-action?token=${actionToken}&action=decline`;
  const rescheduleUrl = `${baseUrl}/reschedule?token=${actionToken}`;
  const icsUrl = `${baseUrl}/api/ics?token=${actionToken}`;
  const slotStart = parseSlotToUtc(date, time);
  const slotEnd = slotStart ? new Date(slotStart.getTime() + CALL_DURATION_MIN * 60000) : null;
  const gcalUrl =
    slotStart && slotEnd
      ? googleCalendarAddLink({
          title: `Meridian Gray strategy call — ${business_name || name}`,
          description: `${modeLabel}. Organized by Meridian Gray (info@meridiangray.in).`,
          start: slotStart,
          end: slotEnd,
        })
      : null;

  // Internal notification — team reviews and accepts/declines, nothing is
  // confirmed to the client until one of these is clicked.
  await sendBrevoEmail(env, {
    subject: `Call request — ${business_name || name}, ${niceDate} ${time} IST`,
    replyTo: email,
    htmlContent: `
      <h2 style="margin:0 0 18px;font-size:19px;">New strategy call requested</h2>
      <p style="margin:0 0 6px;"><b>Name:</b> ${name}</p>
      <p style="margin:0 0 6px;"><b>Business:</b> ${business_name || "—"}</p>
      <p style="margin:0 0 6px;"><b>Sector:</b> ${sector || "—"} &middot; <b>Type:</b> ${business_type || "—"}</p>
      <p style="margin:0 0 6px;"><b>Email:</b> ${email} &middot; <b>Phone:</b> ${cc} ${phone}</p>
      <p style="margin:0 0 6px;"><b>When:</b> ${niceDate} at ${time} IST</p>
      <p style="margin:0 0 6px;"><b>How:</b> ${modeLabel}</p>
      ${score_overall !== null ? `<p style="margin:0 0 6px;"><b>Health Check score:</b> ${score_overall}/100</p>` : ""}
      ${notes ? `<p style="margin:0 0 6px;"><b>What they want to look at first:</b> ${notes}</p>` : ""}
      <div style="margin-top:22px;">
        ${emailButton("Accept", acceptUrl)}
        ${emailButton("Decline", declineUrl, { variant: "danger" })}
      </div>
      <p style="color:${BRAND.faint};font-size:13px;margin-top:18px;">Declining frees this slot immediately and lets the client know to pick another time. The slot is held (tentatively) on the calendar until you choose.</p>
    `,
  });

  // To the visitor — sets the right expectation: requested, not yet confirmed.
  await sendBrevoEmail(env, {
    to: email,
    subject: `Your call request — ${niceDate} at ${time} IST`,
    preheader: `We're holding ${niceDate} at ${time} IST for you — confirming shortly.`,
    htmlContent: `
      <h2 style="margin:0 0 14px;font-size:19px;">Got your request, ${name.split(" ")[0]}.</h2>
      <p style="margin:0 0 10px;"><b>${niceDate} at ${time} IST</b>, 30 minutes, by ${modeLabel.toLowerCase()}.</p>
      <p style="margin:0 0 10px;">We're holding this slot and will confirm shortly by email. If it doesn't end up working on our end, we'll reach out to find another time.</p>
      ${notes ? `<p style="margin:0 0 10px;">You mentioned you'd like to look at: <i>${notes}</i>. We'll come prepared.</p>` : ""}
      <div style="margin-top:20px;">
        ${gcalUrl ? emailButton("Add to Google Calendar", gcalUrl) : ""}
        ${emailButton("Download .ics (Outlook/Apple)", icsUrl, { variant: "outline" })}
      </div>
      ${
        report_token
          ? `<p style="margin-top:18px;font-size:13px;color:${BRAND.faint};">Your full report unlocks a few days after the call — we'll email you the link then.</p>`
          : ""
      }
      <p style="margin-top:12px;font-size:13px;color:${BRAND.faint};">Need a different time? <a href="${rescheduleUrl}" style="color:${BRAND.blue};">Reschedule here</a>.</p>
    `,
  });

  // Hold the slot on the real calendar as tentative (so it correctly shows as
  // busy / blocks other bookings) without presenting it as confirmed yet.
  let calendarResult = null;
  try {
    calendarResult = await createCalendarEvent(env, {
      summary: `[Pending] Meridian Gray strategy call — ${business_name || name}`,
      description: [
        `Business: ${business_name || "—"}`,
        `Sector: ${sector || "—"} · Type: ${business_type || "—"}`,
        score_overall !== null ? `Health Check score: ${score_overall}/100` : null,
        notes ? `Wants to look at: ${notes}` : null,
        `Contact: ${name} <${email}>, ${cc} ${phone}`.trim(),
        `Accept: ${acceptUrl}`,
        `Decline: ${declineUrl}`,
      ]
        .filter(Boolean)
        .join("\n"),
      date,
      time,
      attendeeEmail: isEmail(email) ? email : null,
      wantMeet: mode !== "phone",
      status: "tentative",
    });
    if (calendarResult) {
      await env.DB.prepare(`UPDATE call_bookings SET calendar_event_id = ?, meet_link = ? WHERE action_token = ?`)
        .bind(calendarResult.eventId, calendarResult.meetLink || "", actionToken)
        .run()
        .catch(() => {});
    }
  } catch (e) {
    console.log("Calendar event creation skipped/failed:", e && e.message);
  }

  return json({ ok: true, calendar: !!calendarResult }, 200, env);
}

async function updateCalendarEventStatus(env, eventId, status, summaryPrefix) {
  const token = await getGoogleAccessToken(env);
  if (!token || !eventId) return;
  const patch = { status };
  if (summaryPrefix !== undefined) {
    // fetch current summary to replace just the prefix
    const getResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (getResp.ok) {
      const ev = await getResp.json();
      patch.summary = (ev.summary || "").replace(/^\[.*?\]\s*/, summaryPrefix ? `[${summaryPrefix}] ` : "");
    }
  }
  const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}?sendUpdates=none`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) console.log("Calendar status update failed:", resp.status, await resp.text());
}

async function handleBookingAction(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const action = url.searchParams.get("action") || "";
  if (!token || !["accept", "decline"].includes(action)) {
    return oauthHtmlPage("Invalid link", `<p>This link is missing information and can't be processed.</p>`);
  }

  const row = await env.DB.prepare(`SELECT * FROM call_bookings WHERE action_token = ?`).bind(token).first();
  if (!row) return oauthHtmlPage("Not found", `<p>This booking couldn't be found — it may have already been removed.</p>`);

  if (row.status !== "pending") {
    return oauthHtmlPage(
      "Already handled",
      `<p>This booking was already marked <b>${row.status}</b> — no change made.</p>`
    );
  }

  const niceDate = formatCallDate(row.call_date);
  const newStatus = action === "accept" ? "confirmed" : "declined";
  const rescheduleUrl = `https://meridiangray-backend.work-meridiangray.workers.dev/reschedule?token=${token}`;
  await env.DB.prepare(`UPDATE call_bookings SET status = ? WHERE action_token = ?`).bind(newStatus, token).run();

  const icsUrl = `https://meridiangray-backend.work-meridiangray.workers.dev/api/ics?token=${token}`;
  const slotStart = parseSlotToUtc(row.call_date, row.call_time);
  const slotEnd = slotStart ? new Date(slotStart.getTime() + CALL_DURATION_MIN * 60000) : null;
  const gcalUrl =
    slotStart && slotEnd
      ? googleCalendarAddLink({
          title: `Meridian Gray strategy call — ${row.business_name || row.name}`,
          description: `${row.mode === "phone" ? "Phone call" : "Video call"}.${row.meet_link ? ` Join: ${row.meet_link}` : ""} Organized by Meridian Gray (info@meridiangray.in).`,
          start: slotStart,
          end: slotEnd,
        })
      : null;

  if (action === "accept") {
    await updateCalendarEventStatus(env, row.calendar_event_id, "confirmed", "");
    await sendBrevoEmail(env, {
      to: row.email,
      subject: `Confirmed — your call on ${niceDate} at ${row.call_time} IST`,
      preheader: `You're confirmed for ${niceDate} at ${row.call_time} IST.`,
      htmlContent: `
        <h2 style="margin:0 0 14px;font-size:19px;">You're confirmed, ${String(row.name).split(" ")[0]}.</h2>
        <p style="margin:0 0 10px;"><b>${niceDate} at ${row.call_time} IST</b>, 30 minutes${row.meet_link ? `, via <a href="${row.meet_link}" style="color:${BRAND.blue};">${row.meet_link}</a>` : ""}.</p>
        <p style="margin:0 0 10px;">See you then — reply to this email any time before the call if anything changes.</p>
        <div style="margin-top:20px;">
          ${gcalUrl ? emailButton("Add to Google Calendar", gcalUrl) : ""}
          ${emailButton("Download .ics (Outlook/Apple)", icsUrl, { variant: "outline" })}
        </div>
        <p style="margin-top:18px;font-size:13px;color:${BRAND.faint};">Need a different time instead? <a href="${rescheduleUrl}" style="color:${BRAND.blue};">Reschedule here</a>.</p>
      `,
    });
    return oauthHtmlPage("Accepted ✓", `<p>Confirmed with ${row.name} for ${niceDate} at ${row.call_time} IST. They've been emailed.</p>`);
  } else {
    await updateCalendarEventStatus(env, row.calendar_event_id, "cancelled");
    await sendBrevoEmail(env, {
      to: row.email,
      subject: `About your call request — ${niceDate} at ${row.call_time} IST`,
      preheader: `That time didn't work on our end — let's find another.`,
      htmlContent: `
        <h2 style="margin:0 0 14px;font-size:19px;">That time doesn't work for us, ${String(row.name).split(" ")[0]}.</h2>
        <p style="margin:0 0 14px;">Sorry about that — could you pick another slot?</p>
        <div style="margin-top:6px;">
          ${emailButton("Choose a new time", "https://www.meridiangray.in/where-you-stand.html")}
          ${emailButton("Reschedule this request", rescheduleUrl, { variant: "outline" })}
        </div>
      `,
    });
    return oauthHtmlPage("Declined", `<p>Declined ${row.name}'s request for ${niceDate} at ${row.call_time} IST. They've been emailed and the slot is free again.</p>`);
  }
}

function rescheduleBaseStyles() {
  return `
    *{box-sizing:border-box}
    body{margin:0;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;background:${BRAND.bg};color:${BRAND.ink};}
    .wrap{max-width:480px;margin:0 auto;min-height:100vh;}
    .bar{background:${BRAND.ink};padding:22px 28px;}
    .bar .mark{border-left:3px solid ${BRAND.blue};padding-left:11px;}
    .bar .word{font-size:18px;font-weight:700;letter-spacing:-.02em;color:#fff;}
    .bar .word i{font-style:normal;color:${BRAND.blueLight}}
    .bar .tag{font-size:9px;letter-spacing:.3em;text-transform:uppercase;color:${BRAND.faint};margin-top:6px;}
    .card{background:${BRAND.card};border:1px solid ${BRAND.border};border-top:none;padding:36px 28px 44px;}
    h1{font-size:21px;margin:0 0 6px;letter-spacing:-.01em;}
    .sub{color:${BRAND.mute};font-size:14px;margin-bottom:26px;line-height:1.5;}
    label{display:block;font-weight:700;margin-top:20px;margin-bottom:8px;font-size:13px;letter-spacing:.02em;text-transform:uppercase;color:${BRAND.faint};}
    input[type=date]{padding:11px 12px;font-size:15px;font-family:inherit;border:1px solid ${BRAND.ink};border-radius:0;width:100%;background:#fff;color:${BRAND.ink};}
    .slots{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
    .slot{padding:10px 16px;border:1px solid ${BRAND.ink};border-radius:0;cursor:pointer;font-size:14px;font-weight:500;background:#fff;color:${BRAND.ink};transition:background .15s,color .15s,border-color .15s;}
    .slot.selected{background:${BRAND.blue};color:#fff;border-color:${BRAND.blue}}
    .slot.taken{opacity:0.35;cursor:not-allowed;text-decoration:line-through;border-color:${BRAND.border}}
    button#submitBtn{margin-top:26px;background:${BRAND.blue};color:#fff;border:1px solid ${BRAND.blue};padding:13px 24px;border-radius:0;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;}
    button#submitBtn:disabled{opacity:0.4;cursor:not-allowed}
    #msg{margin-top:18px;font-size:14px}
    #msg.error{color:${BRAND.red}}
    #msg.ok{color:${BRAND.green}}
    .foot{padding:18px 28px;font-size:12px;color:${BRAND.faint};}
    a{color:${BRAND.blue};}`;
}

async function handleReschedulePage(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  if (!token) return oauthHtmlPage("Invalid link", `<p>This link is missing information and can't be processed.</p>`);

  const row = await env.DB.prepare(`SELECT * FROM call_bookings WHERE action_token = ?`).bind(token).first();
  if (!row) return oauthHtmlPage("Not found", `<p>This booking couldn't be found — it may have already been removed.</p>`);

  if (!["pending", "confirmed", "declined"].includes(row.status)) {
    return oauthHtmlPage(
      "Can't reschedule",
      `<p>This booking is marked <b>${row.status}</b> and can no longer be rescheduled from this link. <a href="https://www.meridiangray.in/where-you-stand.html">Book a new call instead</a>.</p>`
    );
  }

  const niceDate = formatCallDate(row.call_date);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Reschedule your call — Meridian Gray</title>
  <link rel="icon" href="https://www.meridiangray.in/favicon.ico">
  <style>${rescheduleBaseStyles()}</style></head>
  <body>
  <div class="wrap">
    <div class="bar"><div class="mark"><div class="word">MERIDIAN <i>GRAY</i></div><div class="tag">Connected Business Systems</div></div></div>
    <div class="card">
    <h1>Reschedule your call</h1>
    <p class="sub">Currently booked for <b>${niceDate} at ${row.call_time} IST</b>. Pick a new date and time below.</p>
    <label for="dateInput">New date</label>
    <input type="date" id="dateInput" min="${new Date().toISOString().slice(0, 10)}" />
    <label>Available times</label>
    <div class="slots" id="slots"><span class="sub">Pick a date first</span></div>
    <button id="submitBtn" disabled>Confirm new time</button>
    <div id="msg"></div>
    </div>
    <div class="foot">Meridian Gray &middot; <a href="https://www.meridiangray.in">meridiangray.in</a></div>
  </div>
    <script>
      const token = ${JSON.stringify(token)};
      const dateInput = document.getElementById('dateInput');
      const slotsEl = document.getElementById('slots');
      const submitBtn = document.getElementById('submitBtn');
      const msgEl = document.getElementById('msg');
      let selectedSlot = null;

      dateInput.addEventListener('change', async () => {
        selectedSlot = null;
        submitBtn.disabled = true;
        msgEl.textContent = '';
        slotsEl.innerHTML = '<span class="sub">Loading…</span>';
        try {
          const resp = await fetch('/api/availability?date=' + dateInput.value);
          const data = await resp.json();
          const all = ${JSON.stringify(SLOTS)};
          slotsEl.innerHTML = '';
          all.forEach((slot) => {
            const el = document.createElement('div');
            el.className = 'slot' + (data.available.includes(slot) ? '' : ' taken');
            el.textContent = slot;
            if (data.available.includes(slot)) {
              el.addEventListener('click', () => {
                document.querySelectorAll('.slot').forEach((s) => s.classList.remove('selected'));
                el.classList.add('selected');
                selectedSlot = slot;
                submitBtn.disabled = false;
              });
            }
            slotsEl.appendChild(el);
          });
        } catch (e) {
          slotsEl.innerHTML = '<span class="sub">Could not load availability — try again.</span>';
        }
      });

      submitBtn.addEventListener('click', async () => {
        if (!selectedSlot || !dateInput.value) return;
        submitBtn.disabled = true;
        msgEl.className = '';
        msgEl.textContent = 'Saving…';
        try {
          const resp = await fetch('/api/reschedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, date: dateInput.value, time: selectedSlot }),
          });
          const data = await resp.json();
          if (resp.ok && data.ok) {
            msgEl.className = 'ok';
            msgEl.textContent = "Done — we've sent your new request for review and emailed you a confirmation once it's reviewed.";
            dateInput.disabled = true;
            document.querySelectorAll('.slot').forEach((s) => (s.style.pointerEvents = 'none'));
          } else {
            msgEl.className = 'error';
            msgEl.textContent = data.message || 'That slot was just taken — pick another.';
            submitBtn.disabled = false;
          }
        } catch (e) {
          msgEl.className = 'error';
          msgEl.textContent = 'Something went wrong — please try again.';
          submitBtn.disabled = false;
        }
      });
    </script>
  </body></html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

async function handleReschedule(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON body" }, 400, env);
  const { token = "", date = "", time = "" } = body;

  if (!token || !date || !time) {
    return json({ error: "token, date and time are required" }, 400, env);
  }

  const row = await env.DB.prepare(`SELECT * FROM call_bookings WHERE action_token = ?`).bind(token).first();
  if (!row) return json({ error: "not_found", message: "Booking not found." }, 404, env);

  if (!["pending", "confirmed", "declined"].includes(row.status)) {
    return json({ error: "not_reschedulable", message: `This booking is already ${row.status}.` }, 409, env);
  }

  if (date === row.call_date && time === row.call_time) {
    return json({ error: "same_slot", message: "That's already the current time — pick a different one." }, 400, env);
  }

  if (await isSlotTaken(env, date, time)) {
    return json({ error: "slot_taken", message: "That slot was just taken — please pick another time." }, 409, env);
  }

  const niceDate = formatCallDate(date);
  const modeLabel = row.mode === "phone" ? "Phone call — we call you" : "Video call — Google Meet or Zoom";
  const baseUrl = "https://meridiangray-backend.work-meridiangray.workers.dev";
  const acceptUrl = `${baseUrl}/api/booking-action?token=${token}&action=accept`;
  const declineUrl = `${baseUrl}/api/booking-action?token=${token}&action=decline`;

  // Move the existing calendar event's time and put it back to tentative/pending review.
  if (row.calendar_event_id) {
    const accessToken = await getGoogleAccessToken(env);
    if (accessToken) {
      const start = parseSlotToUtc(date, time);
      const end = new Date(start.getTime() + CALL_DURATION_MIN * 60000);
      await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${row.calendar_event_id}?sendUpdates=none`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "tentative",
          summary: `[Pending] Meridian Gray strategy call — ${row.business_name || row.name}`,
          start: { dateTime: start.toISOString(), timeZone: "Asia/Kolkata" },
          end: { dateTime: end.toISOString(), timeZone: "Asia/Kolkata" },
          description: [
            `Business: ${row.business_name || "—"}`,
            `Sector: ${row.sector || "—"} · Type: ${row.business_type || "—"}`,
            row.score_overall !== null && row.score_overall !== undefined ? `Health Check score: ${row.score_overall}/100` : null,
            row.notes ? `Wants to look at: ${row.notes}` : null,
            `Accept: ${acceptUrl}`,
            `Decline: ${declineUrl}`,
          ]
            .filter(Boolean)
            .join("\n"),
        }),
      }).catch((e) => console.log("Calendar reschedule patch failed:", e && e.message));
    }
  }

  await env.DB.prepare(
    `UPDATE call_bookings SET call_date = ?, call_time = ?, status = 'pending' WHERE action_token = ?`
  )
    .bind(date, time, token)
    .run();

  // Re-send the internal notification so the team reviews the new time.
  await sendBrevoEmail(env, {
    subject: `Rescheduled call request — ${row.business_name || row.name}, ${niceDate} ${time} IST`,
    replyTo: row.email,
    htmlContent: `
      <h2 style="margin:0 0 18px;font-size:19px;">Call request rescheduled by client</h2>
      <p style="margin:0 0 6px;"><b>Name:</b> ${row.name}</p>
      <p style="margin:0 0 6px;"><b>Business:</b> ${row.business_name || "—"}</p>
      <p style="margin:0 0 6px;"><b>Sector:</b> ${row.sector || "—"} &middot; <b>Type:</b> ${row.business_type || "—"}</p>
      <p style="margin:0 0 6px;"><b>Email:</b> ${row.email} &middot; <b>Phone:</b> ${row.cc || ""} ${row.phone || ""}</p>
      <p style="margin:0 0 6px;"><b>Previous time:</b> ${formatCallDate(row.call_date)} at ${row.call_time} IST</p>
      <p style="margin:0 0 6px;"><b>New requested time:</b> ${niceDate} at ${time} IST</p>
      <p style="margin:0 0 6px;"><b>How:</b> ${modeLabel}</p>
      ${row.notes ? `<p style="margin:0 0 6px;"><b>What they want to look at first:</b> ${row.notes}</p>` : ""}
      <div style="margin-top:22px;">
        ${emailButton("Accept", acceptUrl)}
        ${emailButton("Decline", declineUrl, { variant: "danger" })}
      </div>
    `,
  });

  // Let the visitor know their new time is pending review, same as a fresh booking.
  const icsUrl = `${baseUrl}/api/ics?token=${token}`;
  const newStart = parseSlotToUtc(date, time);
  const newEnd = newStart ? new Date(newStart.getTime() + CALL_DURATION_MIN * 60000) : null;
  const gcalUrl =
    newStart && newEnd
      ? googleCalendarAddLink({
          title: `Meridian Gray strategy call — ${row.business_name || row.name}`,
          description: `${modeLabel}. Organized by Meridian Gray (info@meridiangray.in).`,
          start: newStart,
          end: newEnd,
        })
      : null;

  await sendBrevoEmail(env, {
    to: row.email,
    subject: `Your new time request — ${niceDate} at ${time} IST`,
    preheader: `We're holding ${niceDate} at ${time} IST for you — confirming shortly.`,
    htmlContent: `
      <h2 style="margin:0 0 14px;font-size:19px;">Got your new time, ${String(row.name).split(" ")[0]}.</h2>
      <p style="margin:0 0 10px;"><b>${niceDate} at ${time} IST</b>, 30 minutes, by ${modeLabel.toLowerCase()}.</p>
      <p style="margin:0 0 10px;">We're holding this slot and will confirm shortly by email.</p>
      <div style="margin-top:20px;">
        ${gcalUrl ? emailButton("Add to Google Calendar", gcalUrl) : ""}
        ${emailButton("Download .ics (Outlook/Apple)", icsUrl, { variant: "outline" })}
      </div>
    `,
  });

  return json({ ok: true }, 200, env);
}

// ---------------- Google Calendar integration ----------------
// One-time setup: visit /oauth/start as the admin, approve calendar access.
// The resulting refresh token is stored in D1 (app_settings) and used for
// every subsequent call — no further logins needed. See backend/README.md.

const SLOTS = ["10:00 AM", "11:30 AM", "1:00 PM", "3:00 PM", "4:30 PM", "6:00 PM"];
const CALL_DURATION_MIN = 30;
const IST_OFFSET_MIN = 5 * 60 + 30;

function parseSlotToUtc(dateStr, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  const tm = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(timeStr || "");
  if (!dm || !tm) return null;
  let hour = parseInt(tm[1], 10) % 12;
  if (/pm/i.test(tm[3])) hour += 12;
  const minute = parseInt(tm[2], 10);
  const utcMillis = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], hour, minute, 0) - IST_OFFSET_MIN * 60000;
  return new Date(utcMillis);
}

async function getAppSetting(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind(key).first();
  return row ? row.value : null;
}
async function setAppSetting(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, value)
    .run();
}

async function getGoogleAccessToken(env) {
  const refreshToken = await getAppSetting(env, "google_refresh_token");
  if (!refreshToken || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    console.log("Google token refresh failed:", resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return data.access_token || null;
}

async function getBusyTimes(env, timeMinISO, timeMaxISO) {
  const token = await getGoogleAccessToken(env);
  if (!token) return null; // not connected — caller treats everything as available
  const resp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: "primary" }] }),
  });
  if (!resp.ok) {
    console.log("freeBusy failed:", resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return (data.calendars && data.calendars.primary && data.calendars.primary.busy) || [];
}

async function createCalendarEvent(env, { summary, description, date, time, attendeeEmail, wantMeet, status }) {
  const token = await getGoogleAccessToken(env);
  if (!token) return null; // calendar not connected yet
  const start = parseSlotToUtc(date, time);
  if (!start) return null;
  const end = new Date(start.getTime() + CALL_DURATION_MIN * 60000);

  const event = {
    summary,
    description,
    start: { dateTime: start.toISOString(), timeZone: "Asia/Kolkata" },
    end: { dateTime: end.toISOString(), timeZone: "Asia/Kolkata" },
    // No `attendees` here on purpose: adding the visitor as a Calendar
    // attendee makes Google send its own "invitation from an unknown sender"
    // email straight from the personal Gmail account behind the OAuth
    // connection — unbranded, flagged as unrecognized, and exactly what
    // looked like spam. We handle every visitor-facing email ourselves
    // (branded, from info@meridiangray.in) and give them a one-click
    // "Add to Calendar" / .ics link instead — see googleCalendarAddLink()
    // and handleIcsDownload() below.
    reminders: { useDefault: true },
    status: status || "confirmed",
  };
  if (wantMeet) {
    event.conferenceData = {
      createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=${wantMeet ? 1 : 0}&sendUpdates=none`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }
  );
  if (!resp.ok) {
    console.log("Calendar event creation failed:", resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  const meetLink =
    (data.conferenceData && data.conferenceData.entryPoints && (data.conferenceData.entryPoints.find((e) => e.entryPointType === "video") || {}).uri) || null;
  return { eventId: data.id, meetLink };
}

// ---------------- Visitor-side "Add to Calendar" (no Google invite needed) ----------------
// No calendar provider lets a third party write an event straight into someone
// else's personal calendar without that person's own login/consent — that's
// true for Google, Outlook and Apple alike, not a Meridian Gray limitation.
// The practical, one-click equivalent (the same one Calendly etc. use) is a
// prefilled "Add to Google Calendar" link plus a universal .ics download that
// Outlook/Apple Calendar/anything else opens directly — both included on every
// visitor-facing booking email.
function icsUtcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function googleCalendarAddLink({ title, description, location, start, end }) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${icsUtcStamp(start)}/${icsUtcStamp(end)}`,
    details: description || "",
    location: location || "",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function icsFoldLine(line) {
  // RFC 5545: lines over 75 octets must be folded with CRLF + a leading space.
  const bytes = line;
  if (bytes.length <= 75) return bytes;
  let out = bytes.slice(0, 75);
  let rest = bytes.slice(75);
  while (rest.length > 0) {
    out += "\r\n " + rest.slice(0, 74);
    rest = rest.slice(74);
  }
  return out;
}

function icsEscape(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function buildIcs({ uid, title, description, location, start, end }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Meridian Gray//Strategy Call//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@meridiangray.in`,
    `DTSTAMP:${icsUtcStamp(new Date())}`,
    `DTSTART:${icsUtcStamp(start)}`,
    `DTEND:${icsUtcStamp(end)}`,
    `SUMMARY:${icsEscape(title)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `LOCATION:${icsEscape(location || "")}`,
    "ORGANIZER;CN=Meridian Gray:mailto:info@meridiangray.in",
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(icsFoldLine).join("\r\n");
}

async function handleIcsDownload(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  if (!token) return json({ error: "token is required" }, 400, env);

  const row = await env.DB.prepare(`SELECT * FROM call_bookings WHERE action_token = ?`).bind(token).first();
  if (!row) return json({ error: "not_found" }, 404, env);

  const start = parseSlotToUtc(row.call_date, row.call_time);
  if (!start) return json({ error: "invalid_booking" }, 400, env);
  const end = new Date(start.getTime() + CALL_DURATION_MIN * 60000);
  const modeLabel = row.mode === "phone" ? "Phone call — we call you" : "Video call";

  const ics = buildIcs({
    uid: row.action_token,
    title: `Meridian Gray strategy call — ${row.business_name || row.name}`,
    description: [`${modeLabel}.`, row.meet_link ? `Join: ${row.meet_link}` : null, "Organized by Meridian Gray (info@meridiangray.in)."]
      .filter(Boolean)
      .join("\n"),
    location: row.meet_link || "",
    start,
    end,
  });

  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="meridian-gray-call.ics"`,
    },
  });
}

async function handleAvailability(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date (YYYY-MM-DD) is required" }, 400, env);

  const dayStartUtc = parseSlotToUtc(date, "12:00 AM");
  if (!dayStartUtc) return json({ error: "invalid date" }, 400, env);
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60000);

  const busy = await getBusyTimes(env, dayStartUtc.toISOString(), dayEndUtc.toISOString());
  if (busy === null) {
    // Calendar not connected yet — fall back to showing every slot as open.
    return json({ ok: true, connected: false, available: SLOTS }, 200, env);
  }

  const available = SLOTS.filter((slot) => {
    const slotStart = parseSlotToUtc(date, slot).getTime();
    const slotEnd = slotStart + CALL_DURATION_MIN * 60000;
    return !busy.some((b) => {
      const bStart = new Date(b.start).getTime();
      const bEnd = new Date(b.end).getTime();
      return slotStart < bEnd && bStart < slotEnd;
    });
  });

  return json({ ok: true, connected: true, available }, 200, env);
}

function oauthHtmlPage(title, body) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Meridian Gray</title>
    <link rel="icon" href="https://www.meridiangray.in/favicon.ico">
    <style>
      *{box-sizing:border-box}
      body{margin:0;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;background:${BRAND.bg};color:${BRAND.ink};}
      .wrap{max-width:520px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column;}
      .bar{background:${BRAND.ink};padding:22px 28px;}
      .bar .mark{border-left:3px solid ${BRAND.blue};padding-left:11px;}
      .bar .word{font-size:18px;font-weight:700;letter-spacing:-.02em;color:#fff;}
      .bar .word i{font-style:normal;color:${BRAND.blueLight}}
      .bar .tag{font-size:9px;letter-spacing:.3em;text-transform:uppercase;color:${BRAND.faint};margin-top:6px;}
      .card{background:${BRAND.card};border:1px solid ${BRAND.border};border-top:none;padding:40px 28px;flex:1;}
      h1{font-size:21px;margin:0 0 14px;letter-spacing:-.01em;}
      p{font-size:15px;line-height:1.6;color:${BRAND.mute};margin:0 0 10px;}
      a{color:${BRAND.blue};text-decoration:none;}
      .foot{padding:18px 28px;font-size:12px;color:${BRAND.faint};}
    </style></head>
    <body><div class="wrap">
      <div class="bar"><div class="mark"><div class="word">MERIDIAN <i>GRAY</i></div><div class="tag">Connected Business Systems</div></div></div>
      <div class="card"><h1>${title}</h1>${body}</div>
      <div class="foot">Meridian Gray &middot; <a href="https://www.meridiangray.in">meridiangray.in</a></div>
    </div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html;charset=utf-8" } }
  );
}

function handleOAuthStart(env) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "GOOGLE_CLIENT_ID not configured" }, 500, env);
  const redirectUri = "https://meridiangray-backend.work-meridiangray.workers.dev/oauth/callback";
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar",
    access_type: "offline",
    prompt: "consent",
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
}

async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) return oauthHtmlPage("Calendar connection failed", `<p>Google returned an error: ${error}</p>`);
  if (!code) return oauthHtmlPage("Calendar connection failed", `<p>No authorization code was returned.</p>`);

  const redirectUri = "https://meridiangray-backend.work-meridiangray.workers.dev/oauth/callback";
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.refresh_token) {
    return oauthHtmlPage(
      "Calendar connection failed",
      `<p>Google didn't return a refresh token (${resp.status}). This usually means the account already granted access before — go to <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a>, remove "Meridian Gray", and try <a href="/oauth/start">/oauth/start</a> again.</p><pre>${JSON.stringify(data)}</pre>`
    );
  }
  await setAppSetting(env, "google_refresh_token", data.refresh_token);
  return oauthHtmlPage("Calendar connected ✓", `<p>Your Google Calendar is now connected. Real-time availability and automatic event creation are live. You can close this tab.</p>`);
}

// ---------------- Zoho CRM integration ----------------
// One-time setup: visit /zoho/oauth/start as the Zoho CRM admin, approve
// access. The resulting refresh token is stored in D1 (app_settings) and
// reused for every subsequent push — no further logins needed. See README.
// ZOHO_DC picks the data center (the part after "zoho." in your CRM login
// URL — "in" for crm.zoho.in, "com" for crm.zoho.com, "eu" for crm.zoho.eu).
function zohoDc(env) {
  return (env.ZOHO_DC || "in").replace(/^\./, "");
}

function handleZohoOAuthStart(env) {
  if (!env.ZOHO_CLIENT_ID) return json({ error: "ZOHO_CLIENT_ID not configured" }, 500, env);
  const dc = zohoDc(env);
  const redirectUri = "https://meridiangray-backend.work-meridiangray.workers.dev/zoho/oauth/callback";
  const params = new URLSearchParams({
    client_id: env.ZOHO_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "ZohoCRM.modules.leads.CREATE,ZohoCRM.modules.leads.READ,ZohoCRM.settings.fields.READ",
    access_type: "offline",
    prompt: "consent",
  });
  return Response.redirect(`https://accounts.zoho.${dc}/oauth/v2/auth?${params.toString()}`, 302);
}

async function handleZohoOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const dc = zohoDc(env);
  if (error) return oauthHtmlPage("Zoho connection failed", `<p>Zoho returned an error: ${error}</p>`);
  if (!code) return oauthHtmlPage("Zoho connection failed", `<p>No authorization code was returned.</p>`);

  const redirectUri = "https://meridiangray-backend.work-meridiangray.workers.dev/zoho/oauth/callback";
  const resp = await fetch(`https://accounts.zoho.${dc}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.refresh_token) {
    return oauthHtmlPage(
      "Zoho connection failed",
      `<p>Zoho didn't return a refresh token (${resp.status}). The authorization code from Zoho expires in about a minute and can only be used once — go back to <a href="/zoho/oauth/start">/zoho/oauth/start</a> and approve again, without delay this time.</p><pre>${JSON.stringify(data)}</pre>`
    );
  }
  await setAppSetting(env, "zoho_refresh_token", data.refresh_token);
  return oauthHtmlPage("Zoho CRM connected ✓", `<p>Zoho CRM is now connected. New Health Check leads will be pushed in automatically. You can close this tab.</p>`);
}

async function getZohoAccessToken(env) {
  const refreshToken = await getAppSetting(env, "zoho_refresh_token");
  if (!refreshToken || !env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) return null;
  const dc = zohoDc(env);
  const resp = await fetch(`https://accounts.zoho.${dc}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    console.log("Zoho token refresh failed:", resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return data.access_token || null;
}

// Pushes a Health Check submission into Zoho CRM as a Lead. Uses only
// standard Leads-module fields that exist on every Zoho CRM account by
// default (Last_Name is the one Zoho requires), so this works without
// knowing anything about custom fields the account may or may not have —
// the full business detail and every answer goes into Description, same
// content as the internal notification email. Never throws: a CRM push
// failure should never block the visitor's submission or the team email.
async function pushHealthCheckToZoho(env, hc) {
  try {
    const token = await getZohoAccessToken(env);
    if (!token) return { skipped: true }; // not connected yet — see /zoho/oauth/start

    const nameParts = String(hc.name || "").trim().split(/\s+/);
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : nameParts[0] || "Unknown";
    const firstName = nameParts.length > 1 ? nameParts[0] : undefined;

    const description = [
      `Sector: ${hc.sector || "—"} · Type: ${hc.custom_label || hc.business_type || "—"}`,
      `Website: ${hc.website || "—"} · City: ${hc.city || "—"} · Established: ${hc.year_established || "—"}`,
      `Operates: ${hc.region || "—"} · Offices: ${hc.branches || "—"} · Team: ${hc.team_size || "—"} · Turnover: ${hc.turnover || "—"}`,
      `Overall score: ${hc.scores?.overall ?? "n/a"}/100 (Research ${hc.scores?.research ?? "n/a"} · Design ${hc.scores?.design ?? "n/a"} · Develop ${hc.scores?.develop ?? "n/a"} · Automate ${hc.scores?.automate ?? "n/a"} · Market ${hc.scores?.market ?? "n/a"})`,
      "",
      "Full Health Check answers:",
      hc.answers_text || "(not provided)",
    ].join("\n");

    const dc = zohoDc(env);
    const resp = await fetch(`https://www.zohoapis.${dc}/crm/v2/Leads`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [
          {
            Last_Name: lastName,
            First_Name: firstName,
            Email: isEmail(hc.email) ? hc.email : undefined,
            Phone: hc.phone ? `${hc.cc || ""} ${hc.phone}`.trim() : undefined,
            Company: hc.business_name || hc.name || "Unknown",
            Lead_Source: "Website Health Check",
            Description: description,
          },
        ],
        trigger: [], // never fire the account's own workflow/email automations on this
      }),
    });

    const result = await resp.json().catch(() => ({}));
    const entry = result?.data?.[0];
    if (!resp.ok || entry?.status !== "success") {
      console.log("Zoho lead push failed:", resp.status, JSON.stringify(result));
      return { ok: false, status: resp.status, result };
    }
    return { ok: true, id: entry.details?.id };
  } catch (e) {
    console.log("Zoho lead push error:", e && e.message);
    return { ok: false, error: e && e.message };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, service: "meridiangray-backend" }, 200, env);
    }

    if (request.method === "POST" && url.pathname === "/api/contact") {
      if ((await checkRateLimit(env, request, "contact", { limit: 5, windowSec: 600 })).limited) return rateLimitedResponse(env);
      return handleContact(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/health-check") {
      if ((await checkRateLimit(env, request, "health-check", { limit: 6, windowSec: 600 })).limited) return rateLimitedResponse(env);
      return handleHealthCheck(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/newsletter") {
      if ((await checkRateLimit(env, request, "newsletter", { limit: 5, windowSec: 600 })).limited) return rateLimitedResponse(env);
      return handleNewsletter(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/book-call") {
      if ((await checkRateLimit(env, request, "book-call", { limit: 5, windowSec: 600 })).limited) return rateLimitedResponse(env);
      return handleBookCall(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/availability") {
      return handleAvailability(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/booking-action") {
      return handleBookingAction(request, env);
    }

    if (request.method === "GET" && url.pathname === "/reschedule") {
      return handleReschedulePage(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/reschedule") {
      if ((await checkRateLimit(env, request, "reschedule", { limit: 8, windowSec: 600 })).limited) return rateLimitedResponse(env);
      return handleReschedule(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/ics") {
      return handleIcsDownload(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/report-status") {
      return handleReportStatus(request, env);
    }

    if (request.method === "GET" && url.pathname === "/oauth/start") {
      return handleOAuthStart(env);
    }

    if (request.method === "GET" && url.pathname === "/oauth/callback") {
      return handleOAuthCallback(request, env);
    }

    if (request.method === "GET" && url.pathname === "/zoho/oauth/start") {
      return handleZohoOAuthStart(env);
    }

    if (request.method === "GET" && url.pathname === "/zoho/oauth/callback") {
      return handleZohoOAuthCallback(request, env);
    }

    return json({ error: "Not found" }, 404, env);
  },

  // Fired daily by the cron trigger in wrangler.toml — unlocks any Health
  // Check reports whose call happened 5+ days ago and emails the visitor.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      unlockDueReports(env)
        .then((n) => console.log(`unlockDueReports: processed ${n} booking(s)`))
        .catch((e) => console.log("unlockDueReports failed:", e && e.message))
    );
  },
};
