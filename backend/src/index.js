/**
 * Meridian Gray — website backend (Cloudflare Worker)
 * Handles: contact/project-brief form, System Finder health-check submission,
 * newsletter signup, and strategy-call booking (with optional real Google
 * Calendar sync). Writes to D1, sends notification email via Brevo.
 *
 * Bindings required (set in wrangler.toml / dashboard):
 *   - DB                   : D1 database binding (meridiangray-db)
 *   - BREVO_API_KEY        : secret, Brevo transactional email API key
 *   - NOTIFY_EMAIL         : env var, where new-lead notifications are sent
 *   - ALLOWED_ORIGIN       : env var, e.g. https://www.meridiangray.in (CORS)
 *   - GOOGLE_CLIENT_ID     : secret, OAuth client id (optional — see README)
 *   - GOOGLE_CLIENT_SECRET : secret, OAuth client secret (optional — see README)
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

async function sendBrevoEmail(env, { subject, htmlContent, to, replyTo }) {
  if (!env.BREVO_API_KEY) return { skipped: true };
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: "Meridian Gray Website", email: env.SENDER_EMAIL || "no-reply@meridiangray.in" },
      to: [{ email: to || env.NOTIFY_EMAIL }],
      replyTo: replyTo ? { email: replyTo } : undefined,
      subject,
      htmlContent,
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

  await env.DB.prepare(
    `INSERT INTO health_check_submissions
      (sector, business_type, custom_label, business_name, name, role, email, phone, cc,
       website, year_established, city, region, branches, team_size, turnover,
       answers_json, answers_text, info_json,
       score_overall, score_research, score_design, score_develop, score_automate, score_market)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      scores.market ?? null
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

  return json({ ok: true }, 200, env);
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

  const modeLabel = mode === "phone" ? "Phone call — we call you" : "Video call — Google Meet or Zoom";
  const niceDate = formatCallDate(date);
  const baseUrl = "https://meridiangray-backend.work-meridiangray.workers.dev";
  const acceptUrl = `${baseUrl}/api/booking-action?token=${actionToken}&action=accept`;
  const declineUrl = `${baseUrl}/api/booking-action?token=${actionToken}&action=decline`;

  // Internal notification — team reviews and accepts/declines, nothing is
  // confirmed to the client until one of these is clicked.
  await sendBrevoEmail(env, {
    subject: `Call request — ${business_name || name}, ${niceDate} ${time} IST`,
    replyTo: email,
    htmlContent: `
      <h2>New strategy call requested</h2>
      <p><b>Name:</b> ${name}</p>
      <p><b>Business:</b> ${business_name || "—"}</p>
      <p><b>Sector:</b> ${sector || "—"} &middot; <b>Type:</b> ${business_type || "—"}</p>
      <p><b>Email:</b> ${email} &middot; <b>Phone:</b> ${cc} ${phone}</p>
      <p><b>When:</b> ${niceDate} at ${time} IST</p>
      <p><b>How:</b> ${modeLabel}</p>
      ${score_overall !== null ? `<p><b>Health Check score:</b> ${score_overall}/100</p>` : ""}
      ${notes ? `<p><b>What they want to look at first:</b> ${notes}</p>` : ""}
      <p style="margin-top:20px">
        <a href="${acceptUrl}" style="background:#1a7f3c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold;margin-right:10px">Accept</a>
        <a href="${declineUrl}" style="background:#b3261e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Decline</a>
      </p>
      <p style="color:#666;font-size:13px">Declining frees this slot immediately and lets the client know to pick another time. The slot is held (tentatively) on the calendar until you choose.</p>
    `,
  });

  // To the visitor — sets the right expectation: requested, not yet confirmed.
  await sendBrevoEmail(env, {
    to: email,
    subject: `Your call request — ${niceDate} at ${time} IST`,
    htmlContent: `
      <h2>Got your request, ${name.split(" ")[0]}.</h2>
      <p><b>${niceDate} at ${time} IST</b>, 30 minutes, by ${modeLabel.toLowerCase()}.</p>
      <p>We're holding this slot and will confirm shortly by email. If it doesn't end up working on our end, we'll reach out to find another time.</p>
      ${notes ? `<p>You mentioned you'd like to look at: <i>${notes}</i>. We'll come prepared.</p>` : ""}
      <p>— Meridian Gray</p>
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
  const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}?sendUpdates=all`, {
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
  await env.DB.prepare(`UPDATE call_bookings SET status = ? WHERE action_token = ?`).bind(newStatus, token).run();

  if (action === "accept") {
    await updateCalendarEventStatus(env, row.calendar_event_id, "confirmed", "");
    await sendBrevoEmail(env, {
      to: row.email,
      subject: `Confirmed — your call on ${niceDate} at ${row.call_time} IST`,
      htmlContent: `
        <h2>You're confirmed, ${String(row.name).split(" ")[0]}.</h2>
        <p><b>${niceDate} at ${row.call_time} IST</b>, 30 minutes${row.meet_link ? `, via <a href="${row.meet_link}">${row.meet_link}</a>` : ""}.</p>
        <p>See you then — reply to this email any time before the call if anything changes.</p>
        <p>— Meridian Gray</p>
      `,
    });
    return oauthHtmlPage("Accepted ✓", `<p>Confirmed with ${row.name} for ${niceDate} at ${row.call_time} IST. They've been emailed.</p>`);
  } else {
    await updateCalendarEventStatus(env, row.calendar_event_id, "cancelled");
    await sendBrevoEmail(env, {
      to: row.email,
      subject: `About your call request — ${niceDate} at ${row.call_time} IST`,
      htmlContent: `
        <h2>That time doesn't work for us, ${String(row.name).split(" ")[0]}.</h2>
        <p>Sorry about that — could you pick another slot? <a href="https://www.meridiangray.in/where-you-stand.html">Choose a new time</a>.</p>
        <p>— Meridian Gray</p>
      `,
    });
    return oauthHtmlPage("Declined", `<p>Declined ${row.name}'s request for ${niceDate} at ${row.call_time} IST. They've been emailed and the slot is free again.</p>`);
  }
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
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
    reminders: { useDefault: true },
    status: status || "confirmed",
  };
  if (wantMeet) {
    event.conferenceData = {
      createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=${wantMeet ? 1 : 0}&sendUpdates=all`,
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
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#111}
    h1{font-size:22px}a{color:#244BDB}</style></head><body><h1>${title}</h1>${body}</body></html>`,
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
      return handleContact(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/health-check") {
      return handleHealthCheck(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/newsletter") {
      return handleNewsletter(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/book-call") {
      return handleBookCall(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/availability") {
      return handleAvailability(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/booking-action") {
      return handleBookingAction(request, env);
    }

    if (request.method === "GET" && url.pathname === "/oauth/start") {
      return handleOAuthStart(env);
    }

    if (request.method === "GET" && url.pathname === "/oauth/callback") {
      return handleOAuthCallback(request, env);
    }

    return json({ error: "Not found" }, 404, env);
  },
};
