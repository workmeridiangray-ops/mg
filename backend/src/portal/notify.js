// Email notifications for portal events. Client-facing emails go to every
// person at the company; client actions notify the Meridian Gray inbox.

import { esc } from "./ui.js";

export async function companyRecipients(env, companyId, exceptUserId = null, roles = null) {
  const r = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, m.role FROM portal_memberships m JOIN portal_users u ON u.id = m.user_id
      WHERE m.company_id = ? AND u.status = 'active'`
  )
    .bind(companyId)
    .all();
  return (r.results || []).filter((u) => u.id !== exceptUserId && (!roles || roles.includes(u.role)));
}

// roles: limit to e.g. ["owner", "finance"] for money matters.
export async function emailCompany(env, mail, companyId, { subject, html, exceptUserId = null, roles = null }) {
  const people = await companyRecipients(env, companyId, exceptUserId, roles);
  let sent = 0;
  for (const p of people) {
    try {
      const r = await mail.send(env, { subject, htmlContent: html, to: p.email, preheader: subject });
      if (r && (r.ok || r.skipped)) sent++;
    } catch (e) {
      console.log("emailCompany failed:", e && e.message);
    }
  }
  return sent;
}

export async function emailTeam(env, mail, { subject, html, replyTo }) {
  try {
    await mail.send(env, { subject, htmlContent: html, to: env.NOTIFY_EMAIL, replyTo, preheader: subject });
  } catch (e) {
    console.log("emailTeam failed:", e && e.message);
  }
}

export const p = (s) => `<p style="margin:0 0 16px;">${s}</p>`;
export const muted = (s) => `<p style="margin:16px 0 0;font-size:13px;color:#5B606B;">${s}</p>`;
export const quote = (s) =>
  `<div style="border-left:3px solid #244BDB;background:#F5F6F8;padding:12px 16px;margin:0 0 20px;font-size:14px;white-space:pre-line;">${esc(String(s).slice(0, 600))}${String(s).length > 600 ? "…" : ""}</div>`;
