// Messages: conversations between a client and Meridian Gray, either
// standalone or attached to a meeting. Both sides see the same thread.

import { now, newId, audit } from "./db.js";
import { esc, appPage, pageHead, initials, ARROW } from "./ui.js";
import { html, redirect, readForm, clientIp, flashFrom, nonce } from "./http.js";
import { relTime, fmtWhen } from "./time.js";
import { emailCompany, emailTeam, p, muted, quote } from "./notify.js";
import { portalOrigin } from "./auth.js";

const MAX_BODY = 8000;

export function richText(s) {
  return esc(s)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" rel="noopener noreferrer" target="_blank">$1</a>')
    .replace(/\n/g, "<br>");
}

export async function createThread(env, ctx, companyId, { subject, meetingId = null }) {
  const id = newId("th");
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO portal_threads (id, company_id, subject, meeting_id, created_by, created_at, last_message_at) VALUES (?,?,?,?,?,?,?)`
  )
    .bind(id, companyId, subject.slice(0, 160), meetingId, ctx.user.id, ts, ts)
    .run();
  return id;
}

export async function postMessage(env, mail, request, ctx, thread, body, { linkPathClient, linkPathAdmin }) {
  body = String(body || "").trim().slice(0, MAX_BODY);
  if (!body) return false;
  const ts = now();
  const staff = ctx.user.is_staff ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO portal_messages (id, thread_id, company_id, author_id, author_staff, body, created_at) VALUES (?,?,?,?,?,?,?)`).bind(
      newId("msg"), thread.id, thread.company_id, ctx.user.id, staff, body, ts
    ),
    env.DB.prepare(
      `UPDATE portal_threads SET last_message_at = ?, last_author_id = ?, last_author_staff = ?, message_count = message_count + 1 WHERE id = ?`
    ).bind(ts, ctx.user.id, staff, thread.id),
    env.DB.prepare(
      `INSERT INTO portal_reads (user_id, thread_id, last_read_at) VALUES (?,?,?) ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_at = excluded.last_read_at`
    ).bind(ctx.user.id, thread.id, ts),
  ]);
  const company = await env.DB.prepare(`SELECT name FROM portal_companies WHERE id = ?`).bind(thread.company_id).first();
  const origin = portalOrigin(request);
  const who = ctx.user.name || ctx.user.email;
  if (staff) {
    await emailCompany(env, mail, thread.company_id, {
      subject: `New message from Meridian Gray: ${thread.subject}`,
      html: p(`<b>${esc(who)}</b> from Meridian Gray wrote in <b>${esc(thread.subject)}</b>:`) + quote(body) + mail.button("Reply in the portal", origin + linkPathClient) + muted("Reply in the portal so the conversation stays with the work."),
    });
  } else {
    await emailTeam(env, mail, {
      subject: `[${company?.name || "Client"}] ${thread.subject}`,
      replyTo: ctx.user.email,
      html: p(`<b>${esc(who)}</b> (${esc(company?.name || "")}) wrote in <b>${esc(thread.subject)}</b>:`) + quote(body) + mail.button("Open in the portal", origin + linkPathAdmin),
    });
  }
  return true;
}

export async function markRead(env, userId, threadId) {
  await env.DB.prepare(
    `INSERT INTO portal_reads (user_id, thread_id, last_read_at) VALUES (?,?,?) ON CONFLICT(user_id, thread_id) DO UPDATE SET last_read_at = excluded.last_read_at`
  )
    .bind(userId, threadId, now())
    .run();
}

// Unread = last message written by the other side, after this person last looked.
const UNREAD_SQL = `t.message_count > 0 AND t.last_author_id != ? AND (r.last_read_at IS NULL OR r.last_read_at < t.last_message_at)`;

export async function unreadCount(env, ctx) {
  if (ctx.user.is_staff && !ctx.viewAs) {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM portal_threads t JOIN portal_companies c ON c.id = t.company_id LEFT JOIN portal_reads r ON r.thread_id = t.id AND r.user_id = ?
        WHERE c.status = 'active' AND t.last_author_staff = 0 AND ${UNREAD_SQL}`
    )
      .bind(ctx.user.id, ctx.user.id)
      .first();
    return r?.c || 0;
  }
  if (ctx.viewAs) return 0;
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM portal_threads t LEFT JOIN portal_reads r ON r.thread_id = t.id AND r.user_id = ?
      WHERE t.company_id = ? AND t.last_author_staff = 1 AND ${UNREAD_SQL}`
  )
    .bind(ctx.user.id, ctx.company.id, ctx.user.id)
    .first();
  return r?.c || 0;
}

export async function loadMessages(env, threadId) {
  const r = await env.DB.prepare(
    `SELECT m.*, u.name, u.email FROM portal_messages m JOIN portal_users u ON u.id = m.author_id WHERE m.thread_id = ? ORDER BY m.created_at, m.rowid`
  )
    .bind(threadId)
    .all();
  return r.results || [];
}

export function renderConversation(messages, ctx, { action, placeholder = "Write a message…", canPost = true, emptyText = "No messages yet." }) {
  const list = messages.length
    ? `<div class="msgs">${messages
        .map((m) => {
          const mine = m.author_id === ctx.user.id;
          return `<div class="msg${m.author_staff ? " mg" : ""}${mine ? " mine" : ""}"><span class="av${m.author_staff ? " blue" : ""}">${esc(initials(m.name, m.email))}</span>
          <div class="msg-b"><div class="msg-h"><b>${esc(m.name || m.email)}</b>${m.author_staff ? ' <span class="bdg blue">Meridian Gray</span>' : ""}<span class="mono muted" title="${esc(fmtWhen(m.created_at))}">${esc(relTime(m.created_at))}</span></div><div class="msg-t">${richText(m.body)}</div></div></div>`;
        })
        .join("")}</div>`
    : `<div class="empty">${esc(emptyText)}</div>`;
  const form = canPost
    ? `<form class="f reply" method="post" action="${action}"><div class="fld"><label for="body" class="sr">Message</label><textarea id="body" name="body" rows="4" required maxlength="${MAX_BODY}" placeholder="${esc(placeholder)}"></textarea></div><div class="actions"><button class="btn pri">Send</button><span class="small muted">The other side gets an email.</span></div></form>`
    : "";
  return list + form;
}

function threadRows(threads, ctx, base, { showCompany = false } = {}) {
  if (!threads.length) return "";
  return `<div class="rows">${threads
    .map((t) => {
      const unread = t.unread ? " unread" : "";
      return `<a class="row thread${unread}" href="${base}/${esc(t.id)}"><span class="dot" aria-hidden="true"></span><div class="grow"><b>${esc(t.subject)}</b><small>${showCompany ? `${esc(t.company_name)} · ` : ""}${t.meeting_id ? "Meeting discussion · " : ""}${t.message_count} message${t.message_count === 1 ? "" : "s"}${t.last_name ? ` · last from ${esc(t.last_name)}` : ""}</small></div>${t.unread ? '<span class="bdg blue">New</span>' : ""}<span class="mono muted">${esc(relTime(t.last_message_at))}</span></a>`;
    })
    .join("")}</div>`;
}

async function listThreads(env, ctx, { companyId = null, limit = 100 }) {
  const r = await env.DB.prepare(
    `SELECT t.*, c.name AS company_name, lu.name AS last_name, r.last_read_at,
            CASE WHEN ${UNREAD_SQL} THEN 1 ELSE 0 END AS unread
       FROM portal_threads t JOIN portal_companies c ON c.id = t.company_id
       LEFT JOIN portal_reads r ON r.thread_id = t.id AND r.user_id = ?
       LEFT JOIN portal_users lu ON lu.id = t.last_author_id
      WHERE (? IS NULL OR t.company_id = ?) AND c.status = 'active' AND t.message_count > 0
      ORDER BY unread DESC, t.last_message_at DESC LIMIT ?`
  )
    .bind(ctx.user.id, ctx.user.id, companyId, companyId, limit)
    .all();
  return r.results || [];
}

export async function threadsForCompany(env, ctx, companyId, limit = 5) {
  return listThreads(env, ctx, { companyId, limit });
}
export { threadRows };

function newThreadForm(action, { companies = null, selected = "" } = {}) {
  return `<div class="card panel" id="new"><h2>Start a conversation</h2><form class="f" method="post" action="${action}">
    ${
      companies
        ? `<div class="fld"><label for="client">Client</label><select id="client" name="company_id" required><option value="">Select a client</option>${companies
            .map((c) => `<option value="${esc(c.id)}"${c.id === selected ? " selected" : ""}>${esc(c.name)}</option>`)
            .join("")}</select></div>`
        : ""
    }
    <div class="fld"><label for="subject">Subject</label><input id="subject" name="subject" type="text" required maxlength="160" placeholder="${companies ? "Next steps on the CRM rollout" : "Question about the dashboard"}"></div>
    <div class="fld"><label for="nbody">Message</label><textarea id="nbody" name="body" rows="5" required maxlength="${MAX_BODY}"></textarea></div>
    <div><button class="btn pri">Send ${ARROW}</button></div></form></div>`;
}

// ---------- routes ----------

export async function clientMessagesRoute(request, env, ctx, mail, path) {
  const url = new URL(request.url);
  const n = nonce();
  const company = ctx.company;
  const page = (o) => html(request, appPage({ nonce: n, ctx, flash: flashFrom(url), ...o }), n);
  const canPost = !ctx.viewAs;

  if (path === "/messages") {
    if (request.method === "POST") {
      if (!canPost) return redirect(request, "/messages");
      const f = await readForm(request);
      const subject = String(f.subject || "").trim();
      if (!subject || !String(f.body || "").trim()) return redirect(request, "/messages?m=e_msg");
      const id = await createThread(env, ctx, company.id, { subject });
      const thread = await env.DB.prepare(`SELECT * FROM portal_threads WHERE id = ?`).bind(id).first();
      await postMessage(env, mail, request, ctx, thread, f.body, { linkPathClient: `/messages/${id}`, linkPathAdmin: `/admin/messages/${id}` });
      await audit(env, ctx, { companyId: company.id, action: "message.thread", summary: `${ctx.user.email} started a conversation: ${subject}`, ip: clientIp(request) });
      return redirect(request, `/messages/${id}?m=sent`);
    }
    const threads = await listThreads(env, ctx, { companyId: company.id });
    return page({
      title: "Messages",
      active: "messages",
      crumbs: [[company.name], ["Messages"]],
      body: `${pageHead({ eyebrow: `${company.name} · Messages`, title: `Talk to us, <em>on the record.</em>`, lead: "Every conversation with the Meridian Gray team, in one place both sides can see. Discussions about a specific meeting live on that meeting." })}
      ${threads.length ? threadRows(threads, ctx, "/messages") : `<div class="empty"><b>No conversations yet.</b>Start one below. We reply here, and you'll get an email when we do.</div>`}
      ${canPost ? `<div class="sec">${newThreadForm("/messages")}</div>` : ""}`,
    });
  }

  const m = path.match(/^\/messages\/(th_[a-z0-9]+)$/);
  if (m) {
    const thread = await env.DB.prepare(`SELECT * FROM portal_threads WHERE id = ? AND company_id = ?`).bind(m[1], company.id).first();
    if (!thread) return null;
    if (thread.meeting_id) return redirect(request, `/meetings/${thread.meeting_id}#discussion`);
    if (request.method === "POST") {
      if (!canPost) return redirect(request, path);
      const f = await readForm(request);
      await postMessage(env, mail, request, ctx, thread, f.body, { linkPathClient: path, linkPathAdmin: `/admin/messages/${thread.id}` });
      return redirect(request, `${path}?m=sent#end`);
    }
    if (!ctx.viewAs) {
      await markRead(env, ctx.user.id, thread.id);
      if (ctx.badges) ctx.badges.messages = await unreadCount(env, ctx);
    }
    const msgs = await loadMessages(env, thread.id);
    return page({
      title: thread.subject,
      active: "messages",
      crumbs: [[company.name], ["Messages", "/messages"], [thread.subject]],
      body: `${pageHead({ eyebrow: `${company.name} · Conversation`, title: esc(thread.subject), lead: `Started ${esc(fmtWhen(thread.created_at))}` })}
      <div style="max-width:820px">${renderConversation(msgs, ctx, { action: path, canPost })}<span id="end"></span></div>`,
    });
  }
  return null;
}

export async function adminMessagesRoute(request, env, ctx, mail, path) {
  const url = new URL(request.url);
  const n = nonce();
  const page = (o) => html(request, appPage({ nonce: n, ctx, flash: flashFrom(url), ...o }), n);

  if (path === "/admin/messages") {
    if (request.method === "POST") {
      const f = await readForm(request);
      const company = await env.DB.prepare(`SELECT * FROM portal_companies WHERE id = ? AND status = 'active'`).bind(f.company_id || "").first();
      const subject = String(f.subject || "").trim();
      if (!company || !subject || !String(f.body || "").trim()) return redirect(request, "/admin/messages?m=e_msg");
      const id = await createThread(env, ctx, company.id, { subject });
      const thread = await env.DB.prepare(`SELECT * FROM portal_threads WHERE id = ?`).bind(id).first();
      await postMessage(env, mail, request, ctx, thread, f.body, { linkPathClient: `/messages/${id}`, linkPathAdmin: `/admin/messages/${id}` });
      await audit(env, ctx, { companyId: company.id, action: "message.thread", summary: `Started a conversation: ${subject}`, ip: clientIp(request) });
      return redirect(request, `/admin/messages/${id}?m=sent`);
    }
    const client = url.searchParams.get("client") || null;
    const threads = await listThreads(env, ctx, { companyId: client, limit: 200 });
    const companies = (await env.DB.prepare(`SELECT id, name FROM portal_companies WHERE status = 'active' ORDER BY name`).all()).results || [];
    return page({
      title: "Messages",
      active: "messages",
      crumbs: [["Admin", "/admin"], ["Messages"]],
      body: `${pageHead({ eyebrow: "Admin · Messages", title: `Every conversation, <em>unread first.</em>`, lead: "Replies here reach the client by email and in their portal." })}
      <form method="get" class="actions" style="margin-bottom:16px"><select name="client" style="max-width:320px" data-autosubmit><option value="">All clients</option>${companies
        .map((c) => `<option value="${esc(c.id)}"${c.id === client ? " selected" : ""}>${esc(c.name)}</option>`)
        .join("")}</select></form>
      ${threads.length ? threadRows(threads, ctx, "/admin/messages", { showCompany: true }) : `<div class="empty"><b>No conversations yet.</b></div>`}
      <div class="sec">${newThreadForm("/admin/messages", { companies, selected: client || url.searchParams.get("new") || "" })}</div>`,
    });
  }

  const m = path.match(/^\/admin\/messages\/(th_[a-z0-9]+)$/);
  if (m) {
    const thread = await env.DB.prepare(`SELECT t.*, c.name AS company_name FROM portal_threads t JOIN portal_companies c ON c.id = t.company_id WHERE t.id = ?`).bind(m[1]).first();
    if (!thread) return null;
    if (thread.meeting_id) return redirect(request, `/admin/meetings/${thread.meeting_id}#discussion`);
    if (request.method === "POST") {
      const f = await readForm(request);
      await postMessage(env, mail, request, ctx, thread, f.body, { linkPathClient: `/messages/${thread.id}`, linkPathAdmin: path });
      return redirect(request, `${path}?m=sent#end`);
    }
    await markRead(env, ctx.user.id, thread.id);
    if (ctx.badges) ctx.badges.messages = await unreadCount(env, ctx);
    const msgs = await loadMessages(env, thread.id);
    return page({
      title: thread.subject,
      active: "messages",
      crumbs: [["Admin", "/admin"], ["Messages", "/admin/messages"], [thread.subject]],
      body: `${pageHead({ eyebrow: `${thread.company_name} · Conversation`, title: esc(thread.subject), lead: `Started ${esc(fmtWhen(thread.created_at))} · <a href="/admin/clients/${esc(thread.company_id)}">${esc(thread.company_name)}</a>` })}
      <div style="max-width:820px">${renderConversation(msgs, ctx, { action: path })}<span id="end"></span></div>`,
    });
  }
  return null;
}
