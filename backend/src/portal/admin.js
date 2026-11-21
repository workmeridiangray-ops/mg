// Admin side: clients, their people, the change log, and "view as client".

import { now, newId, normEmail, isEmail, audit, IN_STATES } from "./db.js";
import { esc, fmtDate, appPage, pageHead, roleBadge, roleRadios, ROLE_LABEL, ARROW, initials } from "./ui.js";
import { html, redirect, readForm, clientIp, flashFrom, nonce } from "./http.js";
import { isStaffEmail, createLoginToken, sendSignInEmail, INVITE_TTL } from "./auth.js";
import { threadsForCompany, threadRows } from "./messages.js";
import { fmtWhen, fmtDay, todayIST } from "./time.js";
import { fmtMoney } from "./money.js";

// GSTIN state codes → state, so a GSTIN fills in the state if it's left blank.
const GST_STATE = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
  "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
  "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep",
  "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana",
  "37": "Andhra Pradesh", "38": "Ladakh",
};
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const COUNTRIES = ["India", "United States", "United Arab Emirates", "Germany", "United Kingdom", "Singapore", "Australia", "Canada", "Saudi Arabia", "Qatar", "Other"];

function companyFields(f) {
  const country = COUNTRIES.includes(f.country) ? f.country : "India";
  const gstin = String(f.gstin || "").trim().toUpperCase().replace(/\s+/g, "");
  let state = String(f.state || "").trim();
  if (country !== "India") state = String(f.region || "").trim();
  else if (!state && GSTIN_RE.test(gstin)) state = GST_STATE[gstin.slice(0, 2)] || "";
  else if (state && !IN_STATES.includes(state)) state = "";
  return {
    name: String(f.name || "").trim().slice(0, 160),
    legal_name: String(f.legal_name || "").trim().slice(0, 200) || null,
    gstin: country === "India" ? gstin || null : null,
    pan: country === "India" ? String(f.pan || "").trim().toUpperCase().slice(0, 10) || null : null,
    billing_address: String(f.billing_address || "").trim().slice(0, 600) || null,
    city: String(f.city || "").trim().slice(0, 80) || null,
    state: state || null,
    country,
    currency: f.currency === "USD" ? "USD" : f.currency === "INR" ? "INR" : country === "India" ? "INR" : "USD",
    notes: String(f.notes || "").trim().slice(0, 2000) || null,
  };
}

function companyForm(c = {}, { withContact = false } = {}) {
  const country = c.country || "India";
  const cur = c.currency || (country === "India" ? "INR" : "USD");
  return `
  <div class="card"><div class="card-h"><h2>Company</h2></div>
    <div class="grid" style="gap:16px">
      <div class="frow"><div class="fld"><label for="name">Name shown in the portal *</label><input id="name" name="name" type="text" value="${esc(c.name)}" required maxlength="160" placeholder="Acme Foods"></div>
      <div class="fld"><label for="legal_name">Legal name, for invoices</label><input id="legal_name" name="legal_name" type="text" value="${esc(c.legal_name)}" placeholder="Acme Foods Private Limited"></div></div>
      <div class="frow3"><div class="fld"><label for="country">Country</label><select id="country" name="country">${COUNTRIES.map((x) => `<option${x === country ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></div>
      <div class="fld"><label for="state">State (India)</label><select id="state" name="state"><option value="">Select</option>${IN_STATES.map((x) => `<option${x === c.state ? " selected" : ""}>${esc(x)}</option>`).join("")}</select><span class="hint">Decides CGST+SGST or IGST. Left blank, it's read from the GSTIN.</span></div>
      <div class="fld"><label for="region">State / region (outside India)</label><input id="region" name="region" type="text" value="${esc(country !== "India" ? c.state : "")}"></div></div>
      <div class="frow3"><div class="fld"><label for="city">City</label><input id="city" name="city" type="text" value="${esc(c.city)}"></div>
      <div class="fld"><label for="gstin">GSTIN</label><input id="gstin" name="gstin" type="text" value="${esc(c.gstin)}" maxlength="15" placeholder="19ABCDE1234F1Z5" style="text-transform:uppercase"></div>
      <div class="fld"><label for="pan">PAN</label><input id="pan" name="pan" type="text" value="${esc(c.pan)}" maxlength="10" style="text-transform:uppercase"></div></div>
      <div class="fld"><label for="billing_address">Billing address</label><textarea id="billing_address" name="billing_address" rows="3">${esc(c.billing_address)}</textarea></div>
      <div class="fld"><label>Billing currency</label><div class="frow">
        <label class="radio"><input type="radio" name="currency" value="INR"${cur === "INR" ? " checked" : ""}><span><b>INR · GST invoice</b><small>Indian clients. CGST+SGST or IGST by state.</small></span></label>
        <label class="radio"><input type="radio" name="currency" value="USD"${cur === "USD" ? " checked" : ""}><span><b>USD · Export invoice</b><small>Overseas clients. Zero GST under LUT.</small></span></label></div></div>
      <div class="fld"><label for="notes">Internal notes</label><textarea id="notes" name="notes" rows="2" placeholder="Only the Meridian Gray team sees this.">${esc(c.notes)}</textarea></div>
    </div></div>
  ${
    withContact
      ? `<div class="card"><div class="card-h"><h2>First contact</h2><span class="muted small">Optional. You can add people later.</span></div>
      <div class="grid" style="gap:16px">
      <div class="frow"><div class="fld"><label for="p_name">Name</label><input id="p_name" name="p_name" type="text"></div>
      <div class="fld"><label for="p_email">Email</label><input id="p_email" name="p_email" type="email"></div></div>
      <input type="hidden" name="p_role" value="owner"><p class="small muted" style="margin:0">They'll be the company's <b>Owner</b>, so they can add their own colleagues.</p>
      <label class="check"><input type="checkbox" name="p_invite" value="1" checked> Email them a sign-in link now</label></div></div>`
      : ""
  }`;
}

async function getCompany(env, id) {
  return env.DB.prepare(`SELECT * FROM portal_companies WHERE id = ?`).bind(id).first();
}

// Adds (or re-adds) a person to a company. Returns {user, error}.
export async function addPerson(env, ctx, companyId, { name, email, role }) {
  email = normEmail(email);
  if (!isEmail(email)) return { error: "e_email" };
  if (await isStaffEmail(env, email)) return { error: "e_staff" };
  role = ["owner", "finance", "member"].includes(role) ? role : "member";
  let user = await env.DB.prepare(`SELECT * FROM portal_users WHERE email = ?`).bind(email).first();
  if (!user) {
    user = { id: newId("usr"), email, name: String(name || "").trim().slice(0, 120) || null };
    await env.DB.prepare(`INSERT INTO portal_users (id, email, name, created_at) VALUES (?,?,?,?)`).bind(user.id, email, user.name, now()).run();
  } else {
    if (user.status !== "active") await env.DB.prepare(`UPDATE portal_users SET status = 'active' WHERE id = ?`).bind(user.id).run();
    if (!user.name && name) await env.DB.prepare(`UPDATE portal_users SET name = ? WHERE id = ?`).bind(String(name).trim().slice(0, 120), user.id).run();
  }
  const exists = await env.DB.prepare(`SELECT 1 FROM portal_memberships WHERE user_id = ? AND company_id = ?`).bind(user.id, companyId).first();
  if (exists) return { error: "e_exists" };
  await env.DB.prepare(`INSERT INTO portal_memberships (user_id, company_id, role, created_at, invited_by) VALUES (?,?,?,?,?)`)
    .bind(user.id, companyId, role, now(), ctx.user.id)
    .run();
  return { user };
}

export async function invitePerson(env, mail, request, ctx, company, email) {
  const token = await createLoginToken(env, email, INVITE_TTL, clientIp(request));
  const r = await sendSignInEmail(env, mail, request, email, token, {
    invite: true,
    companyName: company.name,
    inviterName: ctx.user.is_staff ? "Meridian Gray" : ctx.user.name || "",
  });
  return r.ok;
}

async function ownerCount(env, companyId) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM portal_memberships WHERE company_id = ? AND role = 'owner'`).bind(companyId).first();
  return r?.c || 0;
}

// Shared by admin and client Owners: change a role / remove someone, with the
// "always keep one Owner" rule.
export async function changeRole(env, companyId, userId, role) {
  role = ["owner", "finance", "member"].includes(role) ? role : null;
  if (!role) return { error: "e_email" };
  const cur = await env.DB.prepare(`SELECT role FROM portal_memberships WHERE user_id = ? AND company_id = ?`).bind(userId, companyId).first();
  if (!cur) return { error: "e_email" };
  if (cur.role === "owner" && role !== "owner" && (await ownerCount(env, companyId)) <= 1) return { error: "e_lastowner" };
  await env.DB.prepare(`UPDATE portal_memberships SET role = ? WHERE user_id = ? AND company_id = ?`).bind(role, userId, companyId).run();
  return { from: cur.role, to: role };
}

export async function removePerson(env, companyId, userId) {
  const cur = await env.DB.prepare(`SELECT role FROM portal_memberships WHERE user_id = ? AND company_id = ?`).bind(userId, companyId).first();
  if (!cur) return { error: "e_email" };
  if (cur.role === "owner" && (await ownerCount(env, companyId)) <= 1) return { error: "e_lastowner" };
  await env.DB.prepare(`DELETE FROM portal_memberships WHERE user_id = ? AND company_id = ?`).bind(userId, companyId).run();
  return { ok: true };
}

export async function peopleOf(env, companyId) {
  const r = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.title, u.last_login_at, m.role, m.created_at FROM portal_memberships m
       JOIN portal_users u ON u.id = m.user_id WHERE m.company_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'finance' THEN 1 ELSE 2 END, u.name, u.email`
  )
    .bind(companyId)
    .all();
  return r.results || [];
}

function auditRows(rows, { showCompany = false } = {}) {
  if (!rows.length) return `<div class="empty"><b>Nothing recorded yet.</b>Every change made in the portal will be listed here, with who made it and when.</div>`;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Who</th>${showCompany ? "<th>Client</th>" : ""}<th>What</th></tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr><td class="mono" style="white-space:nowrap">${esc(fmtDate(r.at, true))}</td><td>${esc(r.actor_email || "System")}${r.actor_is_staff ? ' <span class="bdg blue">MG</span>' : ""}</td>${
          showCompany ? `<td>${r.company_id ? `<a href="/admin/clients/${esc(r.company_id)}">${esc(r.company_name || r.company_id)}</a>` : '<span class="muted">—</span>'}</td>` : ""
        }<td>${esc(r.summary)}</td></tr>`
    )
    .join("")}</tbody></table></div>`;
}

// ---------- routes ----------

export async function adminRoute(request, env, ctx, mail, path) {
  const url = new URL(request.url);
  const method = request.method;
  const n = nonce();
  const flash = flashFrom(url);
  const ip = clientIp(request);
  const page = (o) => html(request, appPage({ nonce: n, ctx, flash, ...o }), n);

  // Clients list
  if (path === "/admin" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const showArchived = url.searchParams.get("archived") === "1";
    const like = `%${q.toLowerCase()}%`;
    const rows = (
      await env.DB.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM portal_memberships m WHERE m.company_id = c.id) AS people,
                (SELECT MAX(u.last_login_at) FROM portal_memberships m JOIN portal_users u ON u.id = m.user_id WHERE m.company_id = c.id) AS last_seen
           FROM portal_companies c
          WHERE c.status = ? AND (? = '' OR lower(c.name) LIKE ? OR lower(IFNULL(c.legal_name,'')) LIKE ? OR lower(IFNULL(c.gstin,'')) LIKE ?)
          ORDER BY c.name`
      )
        .bind(showArchived ? "archived" : "active", q, like, like, like)
        .all()
    ).results || [];
    const stats = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM portal_companies WHERE status='active') AS clients,
              (SELECT COUNT(*) FROM portal_companies WHERE status='active' AND currency='USD') AS usd,
              (SELECT COUNT(DISTINCT m.user_id) FROM portal_memberships m JOIN portal_companies c ON c.id=m.company_id WHERE c.status='active') AS people,
              (SELECT COUNT(DISTINCT u.id) FROM portal_users u WHERE u.is_staff=0 AND u.last_login_at > ?) AS active7`
    )
      .bind(now() - 7 * 86400)
      .first();

    const table = rows.length
      ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Client</th><th>Location</th><th>Billing</th><th>People</th><th>Last sign-in</th></tr></thead><tbody>${rows
          .map(
            (c) => `<tr class="click" data-href="/admin/clients/${esc(c.id)}"><td><a class="rowlink" href="/admin/clients/${esc(c.id)}">${esc(c.name)}</a>${
              c.legal_name ? `<div class="small muted">${esc(c.legal_name)}</div>` : ""
            }</td><td>${esc([c.city, c.state, c.country !== "India" ? c.country : ""].filter(Boolean).join(", ") || "—")}</td><td><span class="bdg ${c.currency === "USD" ? "blue" : "grey"}">${esc(c.currency)}</span></td><td>${c.people}</td><td class="mono">${esc(fmtDate(c.last_seen))}</td></tr>`
          )
          .join("")}</tbody></table></div>`
      : q
        ? `<div class="empty"><b>No clients match “${esc(q)}”.</b>Try part of the name, legal name or GSTIN.</div>`
        : showArchived
          ? `<div class="empty"><b>No archived clients.</b></div>`
          : `<div class="empty"><b>No clients yet.</b>Add your first client to give them a portal login. <div style="margin-top:14px"><a class="btn pri sm" href="/admin/clients/new">Add a client</a></div></div>`;

    return page({
      title: "Clients",
      active: "admin",
      crumbs: [["Admin", "/admin"], ["Clients"]],
      body: `${pageHead({
        eyebrow: "Admin · Clients",
        title: `Every client, <em>one view.</em>`,
        lead: "Add a client, give their people access, and see the portal exactly as they see it.",
        right: `<a class="btn pri" href="/admin/clients/new">Add a client ${ARROW}</a>`,
      })}
      <div class="grid g4" style="margin-bottom:28px">
        <div class="card stat"><div class="k">Active clients</div><div class="v">${stats.clients}</div><div class="s">${stats.usd} billed in USD</div></div>
        <div class="card stat"><div class="k">Client people</div><div class="v">${stats.people}</div><div class="s">with portal access</div></div>
        <div class="card stat"><div class="k">Signed in, 7 days</div><div class="v">${stats.active7}</div><div class="s">client people</div></div>
        <a class="card stat panel" href="/admin/meetings" style="text-decoration:none"><div class="k">Needs attention</div><div class="v">${(ctx.badges?.meetings || 0) + (ctx.badges?.messages || 0)}</div><div class="s">${ctx.badges?.meetings || 0} meeting tasks · ${ctx.badges?.messages || 0} unread</div></a>
      </div>
      <form method="get" action="/admin" class="actions" style="margin-bottom:16px"><input type="search" name="q" value="${esc(q)}" placeholder="Search by name, legal name or GSTIN" style="max-width:380px">${
        showArchived ? '<input type="hidden" name="archived" value="1">' : ""
      }<button class="btn sm">Search</button><a class="small muted" href="${showArchived ? "/admin" : "/admin?archived=1"}" style="margin-left:auto">${showArchived ? "Show active clients" : "Show archived clients"}</a></form>
      ${table}`,
    });
  }

  // New client
  if (path === "/admin/clients/new") {
    if (method === "POST") {
      const f = await readForm(request);
      const c = companyFields(f);
      const back = (m) => page({ title: "Add a client", active: "admin", flash: flashFrom(new URL(`http://x/?m=${m}`)), crumbs: [["Admin", "/admin"], ["Clients", "/admin"], ["Add a client"]], body: newClientBody(c, f) });
      if (!c.name) return back("e_name");
      if (c.gstin && !GSTIN_RE.test(c.gstin)) return back("e_gstin");
      if (f.p_email && !isEmail(normEmail(f.p_email))) return back("e_email");
      if (f.p_email && (await isStaffEmail(env, f.p_email))) return back("e_staff");
      const id = newId("co");
      const ts = now();
      await env.DB.prepare(
        `INSERT INTO portal_companies (id, name, legal_name, gstin, pan, billing_address, city, state, country, currency, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(id, c.name, c.legal_name, c.gstin, c.pan, c.billing_address, c.city, c.state, c.country, c.currency, c.notes, ts, ts)
        .run();
      await audit(env, ctx, { companyId: id, action: "company.create", summary: `Created client ${c.name} (${c.currency})`, ip });
      let m = "created";
      if (f.p_email) {
        const r = await addPerson(env, ctx, id, { name: f.p_name, email: f.p_email, role: "owner" });
        if (r.user) {
          await audit(env, ctx, { companyId: id, action: "member.add", summary: `Added ${r.user.email} as Owner`, ip });
          if (f.p_invite) {
            const ok = await invitePerson(env, mail, request, ctx, { id, name: c.name }, r.user.email);
            await audit(env, ctx, { companyId: id, action: "member.invite", summary: `Sent sign-in link to ${r.user.email}`, ip });
            m = ok ? "added" : "e_mail";
          } else m = "added_noinvite";
        }
      }
      return redirect(request, `/admin/clients/${id}?m=${m}`);
    }
    return page({ title: "Add a client", active: "admin", crumbs: [["Admin", "/admin"], ["Clients", "/admin"], ["Add a client"]], body: newClientBody({}, {}) });
  }

  // View-as exit
  if (path === "/admin/view-as/exit" && method === "POST") {
    await env.DB.prepare(`UPDATE portal_sessions SET view_as_company_id = NULL WHERE id_hash = ?`).bind(ctx.sessionHash).run();
    return redirect(request, "/admin");
  }

  // Change log
  if (path === "/admin/log" && method === "GET") {
    const cid = url.searchParams.get("client") || "";
    const before = parseInt(url.searchParams.get("before") || "0", 10) || 0;
    const rows = (
      await env.DB.prepare(
        `SELECT a.*, c.name AS company_name FROM portal_audit_log a LEFT JOIN portal_companies c ON c.id = a.company_id
          WHERE (? = '' OR a.company_id = ?) AND (? = 0 OR a.id < ?) ORDER BY a.id DESC LIMIT 51`
      )
        .bind(cid, cid, before, before)
        .all()
    ).results || [];
    const more = rows.length > 50;
    const list = rows.slice(0, 50);
    const companies = (await env.DB.prepare(`SELECT id, name FROM portal_companies ORDER BY name`).all()).results || [];
    return page({
      title: "Change log",
      active: "log",
      crumbs: [["Admin", "/admin"], ["Change log"]],
      body: `${pageHead({ eyebrow: "Admin · Change log", title: `Who did what, <em>and when.</em>`, lead: "Every sign-in and every change in the portal, newest first. Entries can't be edited or deleted." })}
      <form method="get" class="actions" style="margin-bottom:16px"><select name="client" style="max-width:320px" data-autosubmit><option value="">All clients and sign-ins</option>${companies
        .map((c) => `<option value="${esc(c.id)}"${c.id === cid ? " selected" : ""}>${esc(c.name)}</option>`)
        .join("")}</select><noscript><button class="btn sm">Filter</button></noscript></form>
      ${auditRows(list, { showCompany: true })}
      ${more ? `<p style="margin-top:16px"><a class="btn sm" href="/admin/log?${cid ? `client=${esc(cid)}&amp;` : ""}before=${list[list.length - 1].id}">Older entries</a></p>` : ""}`,
    });
  }

  // Staff list
  if (path === "/admin/staff" && method === "GET") {
    const staff = (await env.DB.prepare(`SELECT * FROM portal_users WHERE is_staff = 1 ORDER BY last_login_at DESC`).all()).results || [];
    const visible = [];
    for (const s of staff) if (await isStaffEmail(env, s.email)) visible.push(s);
    return page({
      title: "Team",
      active: "staff",
      crumbs: [["Admin", "/admin"], ["Team"]],
      body: `${pageHead({ eyebrow: "Admin · Team", title: `The Meridian Gray <em>side.</em>`, lead: "Team members see every client. Who counts as team is set in the backend's settings, not here, so nobody can grant themselves access from inside the portal." })}
      <div class="rows">${visible
        .map(
          (s) => `<div class="row"><span class="av blue">${esc(initials(s.name, s.email))}</span><div class="grow"><b>${esc(s.name || s.email)}</b><small>${esc(s.email)}</small></div><span class="mono muted">Last sign-in ${esc(fmtDate(s.last_login_at, true))}</span></div>`
        )
        .join("")}</div>`,
    });
  }

  // Client detail + actions
  const m = path.match(/^\/admin\/clients\/(co_[a-z0-9]+)(\/.*)?$/);
  if (m) {
    const company = await getCompany(env, m[1]);
    if (!company) return null;
    const sub = m[2] || "";
    const base = `/admin/clients/${company.id}`;

    if (sub === "" && method === "GET") {
      const people = await peopleOf(env, company.id);
      const log = (await env.DB.prepare(`SELECT * FROM portal_audit_log WHERE company_id = ? ORDER BY id DESC LIMIT 12`).bind(company.id).all()).results || [];
      const meetings = (await env.DB.prepare(`SELECT mt.*, mi.status AS minutes_status FROM portal_meetings mt LEFT JOIN portal_minutes mi ON mi.meeting_id = mt.id WHERE mt.company_id = ? ORDER BY mt.starts_at DESC LIMIT 6`).bind(company.id).all()).results || [];
      const acts = (await env.DB.prepare(`SELECT a.*, mt.title AS meeting_title FROM portal_action_items a JOIN portal_meetings mt ON mt.id = a.meeting_id WHERE a.company_id = ? AND a.published = 1 AND a.status = 'open' ORDER BY a.due_date IS NULL, a.due_date LIMIT 12`).bind(company.id).all()).results || [];
      const threads = await threadsForCompany(env, ctx, company.id, 5);
      const cInvs = (await env.DB.prepare(`SELECT * FROM portal_invoices WHERE company_id = ? ORDER BY created_at DESC LIMIT 6`).bind(company.id).all()).results || [];
      const cDue = (await env.DB.prepare(`SELECT COALESCE(SUM(total - paid - tds),0) AS d FROM portal_invoices WHERE company_id = ? AND status = 'issued'`).bind(company.id).first()).d;
      const cAgr = (await env.DB.prepare(`SELECT * FROM portal_agreements WHERE company_id = ? ORDER BY updated_at DESC LIMIT 6`).bind(company.id).all()).results || [];
      const today = todayIST();
      const mStatus = (m) => m.status === "cancelled" ? "Cancelled" : m.status === "requested" ? "Requested" : m.minutes_status === "published" ? "Minutes to confirm" : m.minutes_status === "correction" ? "Correction raised" : m.minutes_status === "confirmed" ? "Confirmed" : m.minutes_status === "draft" ? "Minutes drafted" : m.starts_at + m.duration_min * 60 < Date.now() / 1000 ? "Needs minutes" : "Scheduled";
      const archived = company.status === "archived";
      const peopleHtml = people.length
        ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>${people
            .map(
              (p) => `<tr><td><b>${esc(p.name || "—")}</b><div class="small muted">${esc(p.email)}</div></td>
              <td><form method="post" action="${base}/people/${esc(p.id)}/role" class="actions"><select name="role" data-autosubmit style="width:auto;padding:6px 10px;font-size:13px">${["owner", "finance", "member"]
                .map((r) => `<option value="${r}"${r === p.role ? " selected" : ""}>${ROLE_LABEL[r]}</option>`)
                .join("")}</select><noscript><button class="btn sm">Save</button></noscript></form></td>
              <td class="mono">${p.last_login_at ? esc(fmtDate(p.last_login_at, true)) : '<span class="bdg amber">Never</span>'}</td>
              <td style="text-align:right;white-space:nowrap"><form method="post" action="${base}/people/${esc(p.id)}/invite" class="inline"><button class="btn sm"${archived ? " disabled" : ""}>Send sign-in link</button></form>
              <form method="post" action="${base}/people/${esc(p.id)}/remove" class="inline" data-confirm="Remove ${esc(p.email)} from ${esc(company.name)}? Their access ends immediately."><button class="btn sm danger">Remove</button></form></td></tr>`
            )
            .join("")}</tbody></table></div>`
        : `<div class="empty"><b>No people yet.</b>Add someone below to give them a portal login.</div>`;

      const details = [
        ["Legal name", company.legal_name],
        ["GSTIN", company.gstin],
        ["PAN", company.pan],
        ["Location", [company.city, company.state, company.country].filter(Boolean).join(", ")],
        ["Billing address", company.billing_address],
        ["Billing", company.currency === "USD" ? "USD · Export invoice (zero GST under LUT)" : "INR · GST invoice"],
        ["Client since", fmtDate(company.created_at)],
      ];

      return page({
        title: company.name,
        active: "admin",
        crumbs: [["Admin", "/admin"], ["Clients", "/admin"], [company.name]],
        body: `${pageHead({
          eyebrow: `Client · ${company.currency}${archived ? " · Archived" : ""}`,
          title: `${esc(company.name)}`,
          lead: company.legal_name ? esc(company.legal_name) : "",
          right: `${archived ? "" : `<form method="post" action="${base}/view-as" class="inline"><button class="btn pri">View as client ${ARROW}</button></form>`}<a class="btn" href="${base}/edit">Edit details</a>`,
        })}
        <div class="split">
          <div>
            <div class="card-h"><h2>People</h2><span class="muted small">${people.length} with access</span></div>
            ${peopleHtml}
            <div class="sec"><div class="card-h"><h2>Billing</h2><span class="actions"><span class="small muted">${esc(fmtMoney(cDue, company.currency))} outstanding</span><a class="btn sm" href="/admin/billing/schedules/new?client=${esc(company.id)}">Schedule</a><a class="btn sm" href="/admin/billing/invoices/new?client=${esc(company.id)}">Invoice</a></span></div>${
              cInvs.length
                ? `<div class="rows">${cInvs.map((i) => `<a class="row thread" href="/admin/billing/invoices/${esc(i.id)}"><div class="grow"><b>${esc(i.number || "Draft invoice")}</b><small>${esc(fmtMoney(i.total, i.currency))}${i.due_date ? ` · due ${esc(i.due_date)}` : ""}</small></div><span class="bdg ${{ draft: "grey", issued: "blue", paid: "green", void: "grey" }[i.status]}">${{ draft: "Draft", issued: "Unpaid", paid: "Paid", void: "Cancelled" }[i.status]}</span></a>`).join("")}</div>`
                : `<div class="empty">No invoices yet.</div>`
            }</div>
            <div class="sec"><div class="card-h"><h2>Agreements</h2><a class="btn sm" href="/admin/agreements/new?client=${esc(company.id)}">New</a></div>${
              cAgr.length
                ? `<div class="rows">${cAgr.map((g) => `<a class="row thread" href="/admin/agreements/${esc(g.id)}"><div class="grow"><b>${esc(g.title)}</b><small>${esc(g.kind.replace("_", " "))}</small></div><span class="bdg ${{ signed: "green", sent: "blue", declined: "red" }[g.status] || "grey"}">${esc({ draft: "Draft", sent: "Awaiting signature", signed: "Signed", declined: "Declined", void: "Withdrawn", superseded: "Replaced" }[g.status])}</span></a>`).join("")}</div>`
                : `<div class="empty">No agreements yet.</div>`
            }</div>
            <div class="sec"><div class="card-h"><h2>Meetings</h2><a class="btn sm" href="/admin/meetings/new?client=${esc(company.id)}">Schedule</a></div>${
              meetings.length
                ? `<div class="rows">${meetings.map((m) => `<a class="row thread" href="/admin/meetings/${esc(m.id)}"><div class="grow"><b>${esc(m.title)}</b><small>${m.starts_at ? esc(fmtWhen(m.starts_at)) : "Time to be confirmed"}</small></div><span class="bdg ${/Needs|Correction|Requested/.test(mStatus(m)) ? "amber" : "grey"}">${mStatus(m)}</span></a>`).join("")}</div>`
                : `<div class="empty">No meetings yet.</div>`
            }</div>
            <div class="sec"><div class="card-h"><h2>Open action items</h2><span class="small muted">${acts.length} open</span></div>${
              acts.length
                ? `<div class="rows">${acts.map((a) => `<div class="row"><div class="grow"><b>${esc(a.text)}</b><small>${a.owner_side === "mg" ? "Meridian Gray" : esc(company.name)}${a.owner_name ? " · " + esc(a.owner_name) : ""} · <a href="/admin/meetings/${esc(a.meeting_id)}">${esc(a.meeting_title)}</a></small></div>${a.due_date ? `<span class="bdg ${a.due_date < today ? "red" : "grey"}">${a.due_date < today ? "Overdue · " : "Due "}${esc(fmtDay(a.due_date))}</span>` : ""}</div>`).join("")}</div>`
                : `<div class="empty">Nothing open.</div>`
            }</div>
            <div class="sec"><div class="card-h"><h2>Conversations</h2><a class="btn sm" href="/admin/messages?new=${esc(company.id)}#new">New message</a></div>${
              threads.length ? threadRows(threads, ctx, "/admin/messages") : `<div class="empty">No conversations yet.</div>`
            }</div>
            <div class="card panel sec"><h3>Add a person</h3><p class="small muted" style="margin:0 0 14px">They sign in with this email. Owners can also add their own colleagues from inside the portal.</p>
              <form class="f" method="post" action="${base}/people">
                <div class="frow"><div class="fld"><label for="ap_name">Name</label><input id="ap_name" name="name" type="text"></div><div class="fld"><label for="ap_email">Email *</label><input id="ap_email" name="email" type="email" required></div></div>
                <div class="fld"><label>Role</label>${roleRadios("role", people.length ? "member" : "owner")}</div>
                <label class="check"><input type="checkbox" name="invite" value="1" checked> Email them a sign-in link now</label>
                <div><button class="btn pri"${archived ? " disabled" : ""}>Add person</button></div>
              </form></div>
            <div class="sec"><div class="card-h"><h2>Recent changes</h2><a class="small" href="/admin/log?client=${esc(company.id)}">Full log</a></div>${auditRows(log)}</div>
          </div>
          <div>
            <div class="card"><div class="card-h"><h3>Details</h3><a class="small" href="${base}/edit">Edit</a></div>
              <div class="rows">${details
                .map(([k, v]) => `<div class="row" style="align-items:flex-start"><span class="k" style="width:110px;flex:none;padding-top:3px">${esc(k)}</span><span class="grow" style="white-space:pre-line">${esc(v || "—")}</span></div>`)
                .join("")}</div>
              ${company.notes ? `<div class="sec" style="margin-top:20px"><div class="k" style="margin-bottom:6px">Internal notes</div><p class="small" style="white-space:pre-line;margin:0">${esc(company.notes)}</p></div>` : ""}
            </div>
            <div class="card panel sec"><h3>${archived ? "Reactivate" : "Archive"} this client</h3><p class="small muted">${
              archived ? "Their people will be able to sign in again." : "Their people lose access straight away. Nothing is deleted, and you can reactivate any time."
            }</p>
              <form method="post" action="${base}/status" ${archived ? "" : `data-confirm="Archive ${esc(company.name)}? Their people lose access immediately."`}><input type="hidden" name="status" value="${archived ? "active" : "archived"}"><button class="btn sm ${archived ? "" : "danger"}">${archived ? "Reactivate" : "Archive client"}</button></form></div>
          </div>
        </div>`,
      });
    }

    if (sub === "/edit") {
      if (method === "POST") {
        const f = await readForm(request);
        const c = companyFields(f);
        if (!c.name || (c.gstin && !GSTIN_RE.test(c.gstin))) {
          return page({ title: "Edit details", active: "admin", flash: flashFrom(new URL(`http://x/?m=${!c.name ? "e_name" : "e_gstin"}`)), crumbs: [["Admin", "/admin"], [company.name, base], ["Edit"]], body: editBody(company, c) });
        }
        await env.DB.prepare(
          `UPDATE portal_companies SET name=?, legal_name=?, gstin=?, pan=?, billing_address=?, city=?, state=?, country=?, currency=?, notes=?, updated_at=? WHERE id=?`
        )
          .bind(c.name, c.legal_name, c.gstin, c.pan, c.billing_address, c.city, c.state, c.country, c.currency, c.notes, now(), company.id)
          .run();
        const changed = Object.keys(c).filter((k) => (company[k] ?? null) !== (c[k] ?? null));
        await audit(env, ctx, { companyId: company.id, action: "company.update", summary: changed.length ? `Updated ${changed.map((k) => k.replace("_", " ")).join(", ")}` : "Saved details (no changes)", detail: { changed }, ip });
        return redirect(request, `${base}?m=saved`);
      }
      return page({ title: "Edit details", active: "admin", crumbs: [["Admin", "/admin"], ["Clients", "/admin"], [company.name, base], ["Edit"]], body: editBody(company, company) });
    }

    if (method !== "POST") return null;

    if (sub === "/view-as") {
      await env.DB.prepare(`UPDATE portal_sessions SET view_as_company_id = ? WHERE id_hash = ?`).bind(company.id, ctx.sessionHash).run();
      await audit(env, ctx, { companyId: company.id, action: "admin.view_as", summary: `Viewed the portal as ${company.name}`, ip });
      return redirect(request, "/");
    }

    if (sub === "/status") {
      const f = await readForm(request);
      const status = f.status === "archived" ? "archived" : "active";
      await env.DB.prepare(`UPDATE portal_companies SET status = ?, updated_at = ? WHERE id = ?`).bind(status, now(), company.id).run();
      await audit(env, ctx, { companyId: company.id, action: `company.${status === "archived" ? "archive" : "restore"}`, summary: status === "archived" ? "Archived client" : "Reactivated client", ip });
      return redirect(request, `${base}?m=${status === "archived" ? "archived" : "restored"}`);
    }

    if (sub === "/people") {
      const f = await readForm(request);
      const r = await addPerson(env, ctx, company.id, f);
      if (r.error) return redirect(request, `${base}?m=${r.error}`);
      await audit(env, ctx, { companyId: company.id, action: "member.add", summary: `Added ${r.user.email} as ${ROLE_LABEL[f.role] || "Member"}`, ip });
      if (!f.invite) return redirect(request, `${base}?m=added_noinvite`);
      const ok = company.status === "active" && (await invitePerson(env, mail, request, ctx, company, r.user.email));
      await audit(env, ctx, { companyId: company.id, action: "member.invite", summary: `Sent sign-in link to ${r.user.email}`, ip });
      return redirect(request, `${base}?m=${ok ? "added" : "e_mail"}`);
    }

    const pm = sub.match(/^\/people\/(usr_[a-z0-9]+)\/(role|remove|invite)$/);
    if (pm) {
      const person = await env.DB.prepare(
        `SELECT u.* FROM portal_users u JOIN portal_memberships m ON m.user_id = u.id WHERE u.id = ? AND m.company_id = ?`
      )
        .bind(pm[1], company.id)
        .first();
      if (!person) return redirect(request, base);
      if (pm[2] === "role") {
        const f = await readForm(request);
        const r = await changeRole(env, company.id, person.id, f.role);
        if (r.error) return redirect(request, `${base}?m=${r.error}`);
        if (r.from !== r.to) await audit(env, ctx, { companyId: company.id, action: "member.role", summary: `Changed ${person.email} from ${ROLE_LABEL[r.from]} to ${ROLE_LABEL[r.to]}`, ip });
        return redirect(request, `${base}?m=role`);
      }
      if (pm[2] === "remove") {
        const r = await removePerson(env, company.id, person.id);
        if (r.error) return redirect(request, `${base}?m=${r.error}`);
        await audit(env, ctx, { companyId: company.id, action: "member.remove", summary: `Removed ${person.email}`, ip });
        return redirect(request, `${base}?m=removed`);
      }
      if (pm[2] === "invite") {
        if (company.status !== "active") return redirect(request, base);
        const ok = await invitePerson(env, mail, request, ctx, company, person.email);
        await audit(env, ctx, { companyId: company.id, action: "member.invite", summary: `Sent sign-in link to ${person.email}`, ip });
        return redirect(request, `${base}?m=${ok ? "invited" : "e_mail"}`);
      }
    }
  }

  return null;
}

function newClientBody(c, f) {
  return `${pageHead({ eyebrow: "Admin · New client", title: `Add a <em>client.</em>`, lead: "Billing details can be filled in later, but the currency decides which kind of invoice they get, so set it now if you know it." })}
  <form method="post" action="/admin/clients/new" class="grid" style="gap:20px;max-width:860px">${companyForm(c, { withContact: true })}
  <div class="actions"><button class="btn pri">Create client ${ARROW}</button><a class="btn" href="/admin">Cancel</a></div></form>`;
}

function editBody(company, c) {
  return `${pageHead({ eyebrow: `Client · ${esc(company.name)}`, title: `Edit <em>details.</em>` })}
  <form method="post" action="/admin/clients/${esc(company.id)}/edit" class="grid" style="gap:20px;max-width:860px">${companyForm(c)}
  <div class="actions"><button class="btn pri">Save changes</button><a class="btn" href="/admin/clients/${esc(company.id)}">Cancel</a></div></form>`;
}
