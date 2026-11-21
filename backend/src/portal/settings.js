// Meridian Gray's own billing details (shown on every invoice) and the
// invoice-number counters. Edited by the team on /admin/settings.

import { now, audit } from "./db.js";
import { esc, appPage, pageHead, ARROW } from "./ui.js";
import { html, redirect, readForm, clientIp, flashFrom, nonce } from "./http.js";
import { IN_STATES } from "./db.js";

export const SETTING_FIELDS = [
  ["seller_legal_name", "Legal name", "Meridian Gray"],
  ["seller_gstin", "GSTIN", ""],
  ["seller_pan", "PAN", ""],
  ["seller_address", "Registered address", "Office 215, Center Point, 21 Hemanta Basu Sarani, Lal Dighi, B.B.D. Bagh, Kolkata 700001"],
  ["seller_state", "State", "West Bengal"],
  ["seller_email", "Billing email", "info@meridiangray.in"],
  ["seller_phone", "Phone", "+91 79729 21514"],
  ["lut_number", "LUT ARN (for export invoices)", ""],
  ["lut_fy", "LUT valid for financial year", ""],
  ["bank_account_name", "Account name", ""],
  ["bank_name", "Bank", ""],
  ["bank_account_number", "Account number", ""],
  ["bank_ifsc", "IFSC", ""],
  ["bank_swift", "SWIFT (for overseas transfers)", ""],
  ["upi_id", "UPI ID", ""],
  ["default_sac", "Default SAC code", "998314"],
  ["default_tax_rate", "Default GST rate (%)", "18"],
  ["payment_terms_days", "Payment due after (days)", "7"],
  ["invoice_footer", "Note printed on every invoice", "Thank you for your business."],
];

export async function getSettings(env) {
  const rows = (await env.DB.prepare(`SELECT key, value FROM portal_settings`).all()).results || [];
  const s = {};
  for (const [k, , d] of SETTING_FIELDS) s[k] = d;
  for (const r of rows) if (r.value != null) s[r.key] = r.value;
  s.registered = !!(s.seller_gstin && s.seller_gstin.trim());
  return s;
}

export function razorpayReady(env) {
  return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

export async function nextInvoiceNumber(env, series, fy) {
  const key = `inv:${series}:${fy}`;
  const r = await env.DB.prepare(`INSERT INTO portal_counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 RETURNING value`).bind(key).first();
  const n = String(r.value).padStart(4, "0");
  return series === "EX" ? `MG/EX/${fy}/${n}` : `MG/${fy}/${n}`;
}

export async function settingsRoute(request, env, ctx, path) {
  if (path !== "/admin/settings") return null;
  const url = new URL(request.url);
  if (request.method === "POST") {
    const f = await readForm(request);
    const ts = now();
    const changed = [];
    const cur = await getSettings(env);
    for (const [k] of SETTING_FIELDS) {
      if (!(k in f)) continue;
      let v = String(f[k] || "").trim().slice(0, 600);
      if (["seller_gstin", "seller_pan", "bank_ifsc", "bank_swift"].includes(k)) v = v.toUpperCase().replace(/\s+/g, "");
      if (k === "seller_state" && v && !IN_STATES.includes(v)) continue;
      if (v !== (cur[k] ?? "")) changed.push(k);
      await env.DB.prepare(`INSERT INTO portal_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(k, v, ts).run();
    }
    if (changed.length) await audit(env, ctx, { action: "settings.update", summary: `Updated billing settings: ${changed.join(", ").replace(/_/g, " ")}`, ip: clientIp(request) });
    return redirect(request, "/admin/settings?m=saved");
  }
  const s = await getSettings(env);
  const n = nonce();
  const fld = (k, opts = {}) => {
    const [, label] = SETTING_FIELDS.find((x) => x[0] === k);
    if (k === "seller_state") return `<div class="fld"><label for="${k}">${label}</label><select id="${k}" name="${k}">${IN_STATES.map((x) => `<option${x === s[k] ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></div>`;
    if (opts.area) return `<div class="fld"><label for="${k}">${label}</label><textarea id="${k}" name="${k}" rows="3">${esc(s[k])}</textarea>${opts.hint ? `<span class="hint">${opts.hint}</span>` : ""}</div>`;
    return `<div class="fld"><label for="${k}">${label}</label><input id="${k}" name="${k}" type="text" value="${esc(s[k])}">${opts.hint ? `<span class="hint">${opts.hint}</span>` : ""}</div>`;
  };
  const rzp = razorpayReady(env);
  const hook = `${url.origin}/razorpay/webhook`;
  return html(
    request,
    appPage({
      nonce: n,
      ctx,
      flash: flashFrom(url),
      title: "Billing settings",
      active: "settings",
      crumbs: [["Admin", "/admin"], ["Billing settings"]],
      body: `${pageHead({ eyebrow: "Admin · Settings", title: `What every invoice <em>says about us.</em>`, lead: "Changes apply to invoices issued from now on. Issued invoices keep the details they were issued with." })}
      <form class="f" method="post" action="/admin/settings" style="max-width:900px">
        <div class="card"><div class="card-h"><h2>Business</h2></div><div class="grid" style="gap:16px">
          <div class="frow">${fld("seller_legal_name")}${fld("seller_gstin", { hint: s.registered ? "GST registered: invoices charge GST." : "Empty means not GST registered: invoices carry no GST." })}</div>
          ${fld("seller_address", { area: true })}
          <div class="frow3">${fld("seller_state")}${fld("seller_pan")}${fld("seller_phone")}</div>
          <div class="frow">${fld("seller_email")}${fld("payment_terms_days")}</div></div></div>
        <div class="card"><div class="card-h"><h2>Export invoices</h2><span class="small muted">USD clients</span></div><div class="frow">${fld("lut_number", { hint: "Printed on export invoices: supply under LUT without payment of IGST." })}${fld("lut_fy", { hint: "For example 2026-27. Renew every April." })}</div></div>
        <div class="card"><div class="card-h"><h2>Bank transfer details</h2><span class="small muted">Shown on invoices for clients paying by transfer</span></div><div class="grid" style="gap:16px">
          <div class="frow">${fld("bank_account_name")}${fld("bank_name")}</div><div class="frow3">${fld("bank_account_number")}${fld("bank_ifsc")}${fld("bank_swift")}</div>${fld("upi_id")}</div></div>
        <div class="card"><div class="card-h"><h2>Defaults</h2></div><div class="frow3">${fld("default_sac", { hint: "998314 is IT design and development." })}${fld("default_tax_rate")}${fld("invoice_footer")}</div></div>
        <div><button class="btn pri">Save settings</button></div>
      </form>
      <div class="card panel sec" style="max-width:900px"><div class="card-h"><h2>Online payments (Razorpay)</h2>${rzp ? '<span class="bdg green">Connected</span>' : '<span class="bdg amber">Not connected</span>'}</div>
        ${
          rzp
            ? `<p class="small" style="margin:0 0 10px">Clients see a <b>Pay now</b> button on unpaid invoices. To make payments land even if someone closes the tab before returning, add this webhook in Razorpay (Settings → Webhooks), event <b>payment_link.paid</b>:</p><p class="mono" style="margin:0 0 10px;word-break:break-all">${esc(hook)}</p><p class="small muted" style="margin:0">${env.RAZORPAY_WEBHOOK_SECRET ? "Webhook secret is set." : "Webhook secret not set yet: add RAZORPAY_WEBHOOK_SECRET alongside the keys."}</p>`
            : `<p class="small" style="margin:0">Until it's connected, invoices show your bank details and you record payments by hand. To connect, add <span class="mono">RAZORPAY_KEY_ID</span>, <span class="mono">RAZORPAY_KEY_SECRET</span> and <span class="mono">RAZORPAY_WEBHOOK_SECRET</span> as GitHub repository secrets, then redeploy.</p>`
        }</div>`,
    }),
    n
  );
}
