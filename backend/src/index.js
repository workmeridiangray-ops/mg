/**
 * Meridian Gray — website backend (Cloudflare Worker)
 * Handles: contact/project-brief form, System Finder health-check submission,
 * newsletter signup. Writes to D1, sends notification email via Brevo.
 *
 * Bindings required (set in wrangler.toml / dashboard):
 *   - DB            : D1 database binding (meridiangray-db)
 *   - BREVO_API_KEY : secret, Brevo transactional email API key
 *   - NOTIFY_EMAIL  : env var, where new-lead notifications are sent (e.g. info@meridiangray.in)
 *   - ALLOWED_ORIGIN: env var, e.g. https://www.meridiangray.in (CORS)
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

    return json({ error: "Not found" }, 404, env);
  },
};
