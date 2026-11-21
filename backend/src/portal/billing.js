// Billing: GST / export invoices, payment schedules, payments (Razorpay
// payment links, plus bank transfers and TDS recorded by the team).
//
// Invoices are drafted, then issued: issuing assigns the next number in the
// financial-year series (MG/26-27/0001 for INR, MG/EX/26-27/0001 for USD) and
// freezes a copy of both parties' details, so later edits to settings or the
// client never change an issued invoice.

import { now, newId, audit, sha256 } from "./db.js";
import { esc, appPage, pageHead, ARROW } from "./ui.js";
import { html, redirect, readForm, clientIp, flashFrom, nonce, securityHeaders } from "./http.js";
import { parseAmount, fmtMoney, toInput, amountInWords, supplyType, computeInvoice, fyLabel } from "./money.js";
import { getSettings, razorpayReady, nextInvoiceNumber } from "./settings.js";
import { emailCompany, emailTeam, p, muted } from "./notify.js";
import { portalOrigin } from "./auth.js";
import { todayIST, fmtWhen, relTime } from "./time.js";

const MONEY_ROLES = ["owner", "finance"];
const METHODS = { razorpay: "Razorpay", bank: "Bank transfer", upi: "UPI", cheque: "Cheque", cash: "Cash", other: "Other" };

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
export function fmtDate(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
export const balanceOf = (inv) => Math.max(0, inv.total - inv.paid - inv.tds);

export function invState(inv) {
  if (inv.status === "draft") return ["Draft", "grey"];
  if (inv.status === "void") return ["Cancelled", "grey"];
  if (inv.status === "paid") return ["Paid", "green"];
  const overdue = inv.due_date && inv.due_date < todayIST();
  if (inv.paid + inv.tds > 0) return [overdue ? "Part paid · overdue" : "Part paid", overdue ? "red" : "amber"];
  return overdue ? ["Overdue", "red"] : ["Due", "blue"];
}
const stateBadge = (inv) => {
  const [l, c] = invState(inv);
  return `<span class="bdg ${c}">${l}</span>`;
};

async function getInvoice(env, id, companyId = null) {
  const inv = await env.DB.prepare(
    `SELECT i.*, c.name AS company_name FROM portal_invoices i JOIN portal_companies c ON c.id = i.company_id WHERE i.id = ? AND (? IS NULL OR i.company_id = ?)`
  )
    .bind(id, companyId, companyId)
    .first();
  if (!inv) return null;
  inv.lines = (await env.DB.prepare(`SELECT * FROM portal_invoice_lines WHERE invoice_id = ? ORDER BY sort`).bind(id).all()).results || [];
  inv.sellerObj = inv.seller ? JSON.parse(inv.seller) : null;
  inv.buyerObj = inv.buyer ? JSON.parse(inv.buyer) : null;
  return inv;
}

async function paymentsOf(env, invoiceId) {
  return (await env.DB.prepare(`SELECT p.*, u.name AS by_name FROM portal_payments p LEFT JOIN portal_users u ON u.id = p.recorded_by WHERE p.invoice_id = ? ORDER BY p.created_at`).bind(invoiceId).all()).results || [];
}

function buyerFrom(c) {
  return { name: c.legal_name || c.name, display: c.name, gstin: c.gstin, pan: c.pan, address: c.billing_address, city: c.city, state: c.state, country: c.country };
}
function sellerFrom(s) {
  const keys = ["seller_legal_name", "seller_gstin", "seller_pan", "seller_address", "seller_state", "seller_email", "seller_phone", "lut_number", "lut_fy", "bank_account_name", "bank_name", "bank_account_number", "bank_ifsc", "bank_swift", "upi_id", "invoice_footer"];
  const o = {};
  for (const k of keys) o[k] = s[k] || "";
  o.registered = s.registered;
  return o;
}

// Recomputes lines and totals for an invoice from its current lines.
async function recalc(env, inv, company, settings) {
  const type = supplyType({ sellerRegistered: settings.registered, sellerState: settings.seller_state, buyerCountry: company.country, buyerState: company.state });
  const c = computeInvoice(inv.lines, type);
  const stmts = c.lines.map((l) => env.DB.prepare(`UPDATE portal_invoice_lines SET amount = ?, tax_rate = ? WHERE id = ?`).bind(l.amount, l.tax_rate, l.id));
  stmts.push(env.DB.prepare(`UPDATE portal_invoices SET supply_type = ?, subtotal = ?, cgst = ?, sgst = ?, igst = ?, total = ?, updated_at = ? WHERE id = ?`).bind(type, c.subtotal, c.cgst, c.sgst, c.igst, c.total, now(), inv.id));
  await env.DB.batch(stmts);
}

async function saveLinesFromForm(env, invoiceId, f) {
  const count = Math.min(parseInt(f.ln_count || "0", 10) || 0, 40);
  const stmts = [env.DB.prepare(`DELETE FROM portal_invoice_lines WHERE invoice_id = ?`).bind(invoiceId)];
  let sort = 0;
  for (let i = 0; i < count; i++) {
    const desc = String(f[`ln_desc_${i}`] || "").trim().slice(0, 500);
    const rate = parseAmount(f[`ln_rate_${i}`]);
    if (!desc || rate == null) continue;
    const qty = Math.max(0, Math.min(100000, parseFloat(f[`ln_qty_${i}`] || "1") || 1));
    const tax = Math.max(0, Math.min(28, parseFloat(f[`ln_tax_${i}`] || "0") || 0));
    stmts.push(
      env.DB.prepare(`INSERT INTO portal_invoice_lines (id, invoice_id, sort, description, sac, qty, rate, tax_rate) VALUES (?,?,?,?,?,?,?,?)`).bind(
        newId("ln"), invoiceId, ++sort, desc, String(f[`ln_sac_${i}`] || "").trim().slice(0, 10) || null, qty, rate, tax
      )
    );
  }
  await env.DB.batch(stmts);
  return sort;
}

// ---------- invoice document ----------

export function invoiceDoc(inv, liveSettings = null, liveCompany = null) {
  const s = inv.sellerObj || sellerFrom(liveSettings || {});
  const b = inv.buyerObj || (liveCompany ? buyerFrom(liveCompany) : {});
  const cur = inv.currency;
  const type = inv.supply_type;
  const taxed = type === "intra" || type === "inter";
  const title = type === "export" ? (s.registered ? "Export invoice" : "Invoice") : taxed ? "Tax invoice" : "Invoice";
  const rates = [...new Set(inv.lines.map((l) => l.tax_rate))];
  const oneRate = rates.length === 1 ? rates[0] : null;
  const m = (v) => esc(fmtMoney(v, cur, { symbol: false }));
  const addr = (x) => esc([x.address, [x.city, x.state].filter(Boolean).join(", "), x.country && x.country !== "India" ? x.country : ""].filter(Boolean).join("\n"));
  const stamp = inv.status === "paid" ? '<div class="inv-stamp paid">Paid</div>' : inv.status === "void" ? '<div class="inv-stamp void">Cancelled</div>' : inv.status === "draft" ? '<div class="inv-stamp draft">Draft</div>' : "";
  const bank = [
    s.bank_account_name && ["Account name", s.bank_account_name],
    s.bank_name && ["Bank", s.bank_name],
    s.bank_account_number && ["Account number", s.bank_account_number],
    s.bank_ifsc && ["IFSC", s.bank_ifsc],
    cur === "USD" && s.bank_swift && ["SWIFT", s.bank_swift],
    cur === "INR" && s.upi_id && ["UPI", s.upi_id],
  ].filter(Boolean);
  return `<article class="inv">${stamp}
  <header class="inv-top"><div><div class="inv-logo">Meridian <span>Gray</span><i>.</i></div><div class="inv-seller"><b>${esc(s.seller_legal_name)}</b><br>${esc(s.seller_address).replace(/\n/g, "<br>")}${s.seller_state ? `<br>${esc(s.seller_state)}, India` : ""}${s.seller_gstin ? `<br>GSTIN ${esc(s.seller_gstin)}` : ""}${s.seller_pan ? ` · PAN ${esc(s.seller_pan)}` : ""}<br>${esc(s.seller_email)}${s.seller_phone ? " · " + esc(s.seller_phone) : ""}</div></div>
  <div class="inv-meta"><div class="inv-title">${title}</div><table>
    <tr><td>Invoice no.</td><td><b>${esc(inv.number || "Not issued yet")}</b></td></tr>
    <tr><td>Date</td><td>${esc(fmtDate(inv.issue_date))}</td></tr>
    <tr><td>Due</td><td>${esc(fmtDate(inv.due_date))}</td></tr>
    ${type === "export" ? `<tr><td>Place of supply</td><td>Outside India</td></tr>` : b.state ? `<tr><td>Place of supply</td><td>${esc(b.state)}</td></tr>` : ""}
  </table></div></header>
  <section class="inv-to"><div class="k">Bill to</div><b>${esc(b.name)}</b><div class="pre">${addr(b)}</div>${b.gstin ? `<div>GSTIN ${esc(b.gstin)}</div>` : ""}</section>
  <table class="inv-lines"><thead><tr><th>#</th><th>Description</th><th>SAC</th><th class="r">Qty</th><th class="r">Rate</th>${taxed && !oneRate ? '<th class="r">GST</th>' : ""}<th class="r">Amount (${cur})</th></tr></thead><tbody>${inv.lines
    .map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description).replace(/\n/g, "<br>")}</td><td>${esc(l.sac || "")}</td><td class="r">${esc(String(+l.qty))}</td><td class="r">${m(l.rate)}</td>${taxed && !oneRate ? `<td class="r">${esc(String(l.tax_rate))}%</td>` : ""}<td class="r">${m(l.amount)}</td></tr>`)
    .join("")}</tbody></table>
  <div class="inv-sum"><div class="inv-words"><div class="k">Amount in words</div>${esc(amountInWords(inv.total, cur))}
    ${type === "export" && s.registered ? `<p class="inv-lut">Supply meant for export under LUT${s.lut_number ? ` (ARN ${esc(s.lut_number)}${s.lut_fy ? `, FY ${esc(s.lut_fy)}` : ""})` : ""} without payment of IGST.</p>` : ""}
    ${!s.registered && type !== "export" ? `<p class="inv-lut">Supplier not registered under GST; no GST charged.</p>` : ""}</div>
    <table><tr><td>Subtotal</td><td class="r">${m(inv.subtotal)}</td></tr>
    ${type === "intra" ? `<tr><td>CGST${oneRate ? ` @ ${oneRate / 2}%` : ""}</td><td class="r">${m(inv.cgst)}</td></tr><tr><td>SGST${oneRate ? ` @ ${oneRate / 2}%` : ""}</td><td class="r">${m(inv.sgst)}</td></tr>` : ""}
    ${type === "inter" ? `<tr><td>IGST${oneRate ? ` @ ${oneRate}%` : ""}</td><td class="r">${m(inv.igst)}</td></tr>` : ""}
    ${type === "export" && s.registered ? `<tr><td>IGST @ 0% (LUT)</td><td class="r">${m(0)}</td></tr>` : ""}
    <tr class="tot"><td>Total</td><td class="r">${esc(fmtMoney(inv.total, cur))}</td></tr>
    ${inv.paid + inv.tds > 0 ? `<tr><td>Received${inv.tds ? " (incl. TDS)" : ""}</td><td class="r">${m(inv.paid + inv.tds)}</td></tr><tr class="tot"><td>Balance due</td><td class="r">${esc(fmtMoney(balanceOf(inv), cur))}</td></tr>` : ""}
    </table></div>
  ${inv.notes ? `<section class="inv-notes"><div class="k">Notes</div>${esc(inv.notes).replace(/\n/g, "<br>")}</section>` : ""}
  ${bank.length ? `<section class="inv-bank"><div class="k">Pay by bank transfer</div><table>${bank.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table><div class="small">Please quote ${esc(inv.number || "the invoice number")} as the reference.</div></section>` : ""}
  <footer class="inv-foot">${esc(s.invoice_footer || "")} This is a computer-generated invoice and needs no signature.</footer>
  </article>`;
}

const INV_CSS = `
.inv{position:relative;border:1px solid var(--line,#E2E4EA);background:#fff;padding:40px 44px;font-size:13.5px;line-height:1.55;color:#111;max-width:900px}
.inv .k{font-size:10px;letter-spacing:.24em;text-transform:uppercase;font-weight:600;color:#5B606B;margin-bottom:6px}
.inv-top{display:flex;justify-content:space-between;gap:30px;padding-bottom:24px;border-bottom:2px solid #111}
.inv-logo{font-weight:700;font-size:22px;letter-spacing:-.04em;border-left:3px solid #111;padding-left:10px;margin-bottom:14px}.inv-logo span{color:#5B606B}.inv-logo i{font-style:normal;color:#244BDB}
.inv-seller{font-size:12.5px;color:#373a45}
.inv-title{font-size:24px;font-weight:700;letter-spacing:-.03em;text-align:right;margin-bottom:10px}
.inv-meta table{border-collapse:collapse;margin-left:auto;font-size:13px}.inv-meta td{padding:3px 0 3px 18px}.inv-meta td:first-child{color:#5B606B;padding-left:0}.inv-meta td:last-child{white-space:nowrap}
.inv-to{padding:22px 0}.inv-to .pre{white-space:pre-line;color:#373a45}
.inv-lines{width:100%;border-collapse:collapse}.inv-lines th{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#5B606B;text-align:left;padding:9px 8px;border-bottom:1px solid #111;font-weight:600}
.inv-lines td{padding:11px 8px;border-bottom:1px solid #E2E4EA;vertical-align:top}.inv .r{text-align:right;white-space:nowrap}
.inv-sum{display:flex;justify-content:space-between;gap:30px;padding-top:18px}.inv-words{max-width:420px}
.inv-sum table{border-collapse:collapse;min-width:290px}.inv-sum td{padding:5px 0 5px 20px}.inv-sum td:first-child{padding-left:0;color:#5B606B}
.inv-sum tr.tot td{border-top:1px solid #111;font-weight:700;font-size:15px;color:#111;padding-top:9px}
.inv-lut{font-size:12px;color:#5B606B;margin:10px 0 0}
.inv-notes,.inv-bank{margin-top:24px;padding-top:18px;border-top:1px solid #E2E4EA}.inv-bank table{border-collapse:collapse;font-size:13px}.inv-bank td{padding:2px 18px 2px 0}.inv-bank td:first-child{color:#5B606B}
.inv-bank .small{font-size:12px;color:#5B606B;margin-top:6px}
.inv-foot{margin-top:26px;padding-top:14px;border-top:1px solid #E2E4EA;font-size:11.5px;color:#8A8F9C}
.inv-stamp{position:absolute;top:150px;right:44px;border:2px solid;padding:4px 14px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;font-size:13px;transform:rotate(-6deg);opacity:.85}
.inv-stamp.paid{color:#1a7f3c}.inv-stamp.void{color:#C8102E}.inv-stamp.draft{color:#8A8F9C}
@media (max-width:700px){.inv{padding:22px 18px}.inv-top,.inv-sum{flex-direction:column}.inv-title{text-align:left}.inv-meta table{margin-left:0}.inv-lines{font-size:12.5px}.inv-stamp{top:18px;right:18px}}
`;
export const BILLING_CSS = INV_CSS;

function printPage(request, inv) {
  const n = nonce();
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(inv.number || "Draft invoice")} · Meridian Gray</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap"><style nonce="${n}">body{margin:0;background:#F5F6F8;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}.bar{max-width:900px;margin:24px auto 12px;display:flex;gap:10px;justify-content:flex-end}.bar button,.bar a{font:inherit;font-size:14px;font-weight:600;padding:10px 18px;border:1px solid #111;background:#fff;color:#111;text-decoration:none;cursor:pointer}.bar button{background:#244BDB;border-color:#244BDB;color:#fff}.wrap{max-width:900px;margin:0 auto 40px}${INV_CSS}@media print{body{background:#fff}.bar{display:none}.wrap{margin:0;max-width:none}.inv{border:0;padding:0;max-width:none}@page{margin:14mm}}</style></head>
<body><div class="bar"><a href="javascript:history.back()" data-back>Back</a><button type="button" data-print>Save as PDF / Print</button></div><div class="wrap">${invoiceDoc(inv)}</div>
<script nonce="${n}">document.querySelector('[data-print]').addEventListener('click',function(){window.print()});document.querySelector('[data-back]').addEventListener('click',function(e){e.preventDefault();history.back()});</script></body></html>`;
  return html(request, doc, n);
}

// ---------- payments ----------

export async function recordPayment(env, inv, { amount, tds = 0, method, reference = null, rzpPaymentId = null, receivedOn = null, note = null, byUserId = null }) {
  if (rzpPaymentId) {
    const dup = await env.DB.prepare(`SELECT id FROM portal_payments WHERE rzp_payment_id = ?`).bind(rzpPaymentId).first();
    if (dup) return { duplicate: true };
  }
  const id = newId("pay");
  try {
    await env.DB.prepare(
      `INSERT INTO portal_payments (id, company_id, invoice_id, amount, tds, currency, method, reference, rzp_payment_id, received_on, note, recorded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(id, inv.company_id, inv.id, amount, tds, inv.currency, method, reference, rzpPaymentId, receivedOn || todayIST(), note, byUserId, now())
      .run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return { duplicate: true };
    throw e;
  }
  const t = await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS a, COALESCE(SUM(tds),0) AS t FROM portal_payments WHERE invoice_id = ?`).bind(inv.id).first();
  const status = t.a + t.t >= inv.total ? "paid" : "issued";
  await env.DB.prepare(`UPDATE portal_invoices SET paid = ?, tds = ?, status = CASE WHEN status = 'void' THEN status ELSE ? END, updated_at = ? WHERE id = ?`).bind(t.a, t.t, status, now(), inv.id).run();
  return { id, status };
}

async function paymentEmails(env, mail, request, inv, amount, method) {
  const fresh = await getInvoice(env, inv.id);
  const origin = portalOrigin(request);
  await emailCompany(env, mail, inv.company_id, {
    roles: MONEY_ROLES,
    subject: `Payment received: ${inv.number} · ${fmtMoney(amount, inv.currency)}`,
    html:
      p(`Thank you. We've received <b>${esc(fmtMoney(amount, inv.currency))}</b> against invoice <b>${esc(inv.number)}</b> (${esc(METHODS[method] || method)}).`) +
      p(fresh.status === "paid" ? "This invoice is now fully paid." : `Balance still due: <b>${esc(fmtMoney(balanceOf(fresh), inv.currency))}</b>.`) +
      mail.button("View the invoice", `${origin}/billing/invoices/${inv.id}`),
  });
  await emailTeam(env, mail, { subject: `[${inv.company_name}] Payment ${fmtMoney(amount, inv.currency)} on ${inv.number}`, html: p(`${esc(METHODS[method] || method)} payment of <b>${esc(fmtMoney(amount, inv.currency))}</b> on <b>${esc(inv.number)}</b> from ${esc(inv.company_name)}.`) + mail.button("Open invoice", `${origin}/admin/billing/invoices/${inv.id}`) });
}

// ---------- Razorpay (payment links) ----------

function rzpAuth(env) {
  return "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function createPaymentLink(env, request, inv, ctx) {
  const amount = balanceOf(inv);
  const existing = await env.DB.prepare(`SELECT * FROM portal_payment_links WHERE invoice_id = ? AND amount = ? AND status = 'created' AND created_at > ? ORDER BY created_at DESC LIMIT 1`).bind(inv.id, amount, now() - 6 * 3600).first();
  if (existing?.short_url) return existing.short_url;
  const ref = newId("pl");
  const body = {
    amount,
    currency: inv.currency,
    accept_partial: false,
    reference_id: ref,
    description: `Meridian Gray invoice ${inv.number}`.slice(0, 2048),
    customer: { name: (inv.buyerObj?.name || inv.company_name).slice(0, 100), email: ctx.user.email },
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: { portal_invoice: inv.id, invoice_number: inv.number, source: "meridiangray-portal" },
    callback_url: `${portalOrigin(request)}/billing/pay/return`,
    callback_method: "get",
  };
  const r = await fetch("https://api.razorpay.com/v1/payment_links", { method: "POST", headers: { Authorization: rzpAuth(env), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.short_url) {
    console.log("razorpay link failed", r.status, JSON.stringify(d).slice(0, 400));
    return null;
  }
  await env.DB.prepare(`INSERT INTO portal_payment_links (id, invoice_id, rzp_link_id, amount, short_url, created_at) VALUES (?,?,?,?,?,?)`).bind(ref, inv.id, d.id, amount, d.short_url, now()).run();
  return d.short_url;
}

// Browser comes back from Razorpay with signed query params.
export async function handlePayReturn(request, env, mail, ctx) {
  const q = new URL(request.url).searchParams;
  const pid = q.get("razorpay_payment_id"), lid = q.get("razorpay_payment_link_id"), ref = q.get("razorpay_payment_link_reference_id"), st = q.get("razorpay_payment_link_status"), sig = q.get("razorpay_signature");
  const link = ref ? await env.DB.prepare(`SELECT * FROM portal_payment_links WHERE id = ?`).bind(ref).first() : null;
  if (!link || !razorpayReady(env)) return redirect(request, "/billing?m=e_pay");
  const ok = sig && safeEq(await hmacHex(env.RAZORPAY_KEY_SECRET, `${lid}|${ref}|${st}|${pid}`), sig);
  if (!ok || st !== "paid") return redirect(request, `/billing/invoices/${link.invoice_id}?m=e_pay`);
  await settleLink(env, mail, request, link, pid, link.amount);
  return redirect(request, `/billing/invoices/${link.invoice_id}?m=paid`);
}

async function settleLink(env, mail, request, link, paymentId, amount) {
  const inv = await getInvoice(env, link.invoice_id);
  if (!inv) return;
  await env.DB.prepare(`UPDATE portal_payment_links SET status = 'paid' WHERE id = ?`).bind(link.id).run();
  const r = await recordPayment(env, inv, { amount, method: "razorpay", reference: paymentId, rzpPaymentId: paymentId });
  if (!r.duplicate) {
    await audit(env, null, { companyId: inv.company_id, action: "payment.razorpay", summary: `Razorpay payment ${fmtMoney(amount, inv.currency)} on ${inv.number} (${paymentId})` });
    await paymentEmails(env, mail, request, inv, amount, "razorpay");
  }
}

// Razorpay → us, server to server. Public route; trust comes from the signature.
export async function handleRazorpayWebhook(request, env, mail) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return new Response("not configured", { status: 503 });
  const raw = await request.text();
  const sig = request.headers.get("X-Razorpay-Signature") || "";
  if (!safeEq(await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw), sig)) return new Response("bad signature", { status: 400 });
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (evt.event !== "payment_link.paid") return new Response("ignored");
  const pl = evt.payload?.payment_link?.entity;
  const pay = evt.payload?.payment?.entity;
  // One Razorpay account serves several businesses: only act on our own links.
  if (!pl || pl.notes?.source !== "meridiangray-portal" || !pay?.id) return new Response("ignored");
  const link = await env.DB.prepare(`SELECT * FROM portal_payment_links WHERE id = ?`).bind(pl.reference_id).first();
  if (!link) return new Response("unknown link");
  await settleLink(env, mail, request, link, pay.id, pay.amount || link.amount);
  return new Response("ok");
}

// ---------- shared bits ----------

export async function billingSummary(env, companyId) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS open, COALESCE(SUM(total - paid - tds),0) AS due,
            SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END) AS overdue, MIN(due_date) AS next_due, MAX(currency) AS currency
       FROM portal_invoices WHERE company_id = ? AND status = 'issued'`
  )
    .bind(todayIST(), companyId)
    .first();
  return r;
}

export async function openInvoices(env, companyId) {
  return (await env.DB.prepare(`SELECT * FROM portal_invoices WHERE company_id = ? AND status = 'issued' ORDER BY due_date`).bind(companyId).all()).results || [];
}

function invoiceTable(invs, base, { showCompany = false } = {}) {
  if (!invs.length) return "";
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Invoice</th>${showCompany ? "<th>Client</th>" : ""}<th>Date</th><th>Due</th><th class="r">Total</th><th class="r">Balance</th><th>Status</th></tr></thead><tbody>${invs
    .map(
      (i) => `<tr class="click" data-href="${base}/${esc(i.id)}"><td><a class="rowlink" href="${base}/${esc(i.id)}">${esc(i.number || "Draft")}</a></td>${showCompany ? `<td>${esc(i.company_name)}</td>` : ""}<td class="mono">${esc(fmtDate(i.issue_date))}</td><td class="mono">${esc(fmtDate(i.due_date))}</td><td class="r">${esc(fmtMoney(i.total, i.currency))}</td><td class="r">${i.status === "void" || i.status === "draft" ? "—" : esc(fmtMoney(balanceOf(i), i.currency))}</td><td>${stateBadge(i)}</td></tr>`
    )
    .join("")}</tbody></table></div>`;
}

function scheduleBlock(sch, items, invMap, { admin, base }) {
  const total = items.reduce((a, x) => a + x.amount, 0);
  return `<div class="card sec"><div class="card-h"><div><h3>${esc(sch.title)}</h3><span class="small muted">${items.length} instalment${items.length === 1 ? "" : "s"} · ${esc(fmtMoney(total, sch.currency))} before tax${sch.status === "archived" ? " · archived" : ""}</span></div>${admin ? `<a class="btn sm" href="/admin/billing/schedules/${esc(sch.id)}">Open</a>` : ""}</div>
  <div class="rows">${items
    .map((it) => {
      const inv = it.invoice_id ? invMap[it.invoice_id] : null;
      const st = inv && inv.status !== "draft" ? stateBadge(inv) : `<span class="bdg grey">${inv ? "Being prepared" : it.due_date && it.due_date < todayIST() ? "Due to invoice" : "Upcoming"}</span>`;
      const link = inv && inv.status !== "draft" ? ` · <a href="${base}/${esc(inv.id)}">${esc(inv.number)}</a>` : "";
      return `<div class="row"><div class="when-chip"><b>${esc(it.due_date ? fmtDate(it.due_date).replace(/ \d{4}$/, "") : "—")}</b><small>${esc(it.due_date ? it.due_date.slice(0, 4) : "")}</small></div><div class="grow"><b>${esc(it.label)}</b><small>${esc(fmtMoney(it.amount, sch.currency))} + tax${link}</small></div>${st}${
        admin && !it.invoice_id ? `<form method="post" action="/admin/billing/schedules/${esc(sch.id)}/items/${esc(it.id)}/invoice" class="inline"><button class="btn sm">Create invoice</button></form>` : ""
      }</div>`;
    })
    .join("")}</div></div>`;
}

async function schedulesFor(env, companyId, { includeArchived = false } = {}) {
  const sch = (await env.DB.prepare(`SELECT s.*, c.currency FROM portal_schedules s JOIN portal_companies c ON c.id = s.company_id WHERE s.company_id = ? ${includeArchived ? "" : "AND s.status = 'active'"} ORDER BY s.created_at DESC`).bind(companyId).all()).results || [];
  const out = [];
  for (const s of sch) {
    const items = (await env.DB.prepare(`SELECT * FROM portal_schedule_items WHERE schedule_id = ? ORDER BY sort`).bind(s.id).all()).results || [];
    out.push({ s, items });
  }
  const invIds = out.flatMap((x) => x.items.map((i) => i.invoice_id)).filter(Boolean);
  const invMap = {};
  if (invIds.length) {
    const rows = (await env.DB.prepare(`SELECT * FROM portal_invoices WHERE id IN (${invIds.map(() => "?").join(",")})`).bind(...invIds).all()).results || [];
    for (const r of rows) invMap[r.id] = r;
  }
  return { list: out, invMap };
}

// ---------- client routes ----------

export async function clientBillingRoute(request, env, ctx, mail, path) {
  const url = new URL(request.url);
  const n = nonce();
  const company = ctx.company;
  const flash = flashFrom(url);
  const page = (o) => html(request, appPage({ nonce: n, ctx, flash, ...o }), n);

  if (path === "/billing/pay/return") return handlePayReturn(request, env, mail, ctx);

  if (path === "/billing" && request.method === "GET") {
    const invs = (await env.DB.prepare(`SELECT * FROM portal_invoices WHERE company_id = ? AND status != 'draft' ORDER BY COALESCE(issue_date, '') DESC, created_at DESC`).bind(company.id).all()).results || [];
    const open = invs.filter((i) => i.status === "issued");
    const due = open.reduce((a, i) => a + balanceOf(i), 0);
    const overdue = open.filter((i) => i.due_date && i.due_date < todayIST());
    const paidYr = (await env.DB.prepare(`SELECT COALESCE(SUM(amount + tds),0) AS s FROM portal_payments WHERE company_id = ? AND received_on >= ?`).bind(company.id, `${new Date().getUTCFullYear() - (new Date().getUTCMonth() < 3 ? 1 : 0)}-04-01`).first()).s;
    const { list, invMap } = await schedulesFor(env, company.id);
    const pays = (await env.DB.prepare(`SELECT p.*, i.number FROM portal_payments p JOIN portal_invoices i ON i.id = p.invoice_id WHERE p.company_id = ? ORDER BY p.created_at DESC LIMIT 20`).bind(company.id).all()).results || [];
    const cur = company.currency;
    return page({
      title: "Billing",
      active: "billing",
      crumbs: [[company.name], ["Billing"]],
      body: `${pageHead({ eyebrow: `${company.name} · Billing`, title: `Invoices, schedules <em>and payments.</em>`, lead: cur === "USD" ? "Invoices are raised in US dollars as export invoices, with no GST." : "GST invoices for our work, what's coming up next, and everything you've paid." })}
      <div class="grid g3" style="margin-bottom:8px">
        <div class="card stat"><div class="k">Outstanding</div><div class="v">${esc(fmtMoney(due, cur))}</div><div class="s">${open.length} unpaid invoice${open.length === 1 ? "" : "s"}</div></div>
        <div class="card stat"><div class="k">Overdue</div><div class="v"${overdue.length ? ' style="color:var(--red)"' : ""}>${overdue.length}</div><div class="s">${overdue.length ? "past their due date" : "nothing overdue"}</div></div>
        <div class="card stat"><div class="k">Paid this financial year</div><div class="v">${esc(fmtMoney(paidYr, cur))}</div><div class="s">including TDS</div></div>
      </div>
      <div class="sec"><div class="card-h"><h2>Invoices</h2></div>${invs.length ? invoiceTable(invs, "/billing/invoices") : `<div class="empty"><b>No invoices yet.</b>When we raise one, you'll get an email and it'll be listed here, ready to pay online.</div>`}</div>
      ${list.length ? `<div class="sec"><div class="card-h"><h2>Payment schedule</h2><span class="small muted">What's coming up, before tax</span></div>${list.map(({ s, items }) => scheduleBlock({ ...s, currency: cur }, items, invMap, { admin: false, base: "/billing/invoices" })).join("")}</div>` : ""}
      ${pays.length ? `<div class="sec"><div class="card-h"><h2>Payments received</h2></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Invoice</th><th>Method</th><th class="r">Amount</th><th class="r">TDS</th></tr></thead><tbody>${pays.map((x) => `<tr><td class="mono">${esc(fmtDate(x.received_on))}</td><td><a href="/billing/invoices/${esc(x.invoice_id)}">${esc(x.number)}</a></td><td>${esc(METHODS[x.method] || x.method)}</td><td class="r">${esc(fmtMoney(x.amount, x.currency))}</td><td class="r">${x.tds ? esc(fmtMoney(x.tds, x.currency)) : "—"}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`,
    });
  }

  const m = path.match(/^\/billing\/invoices\/(inv_[a-z0-9]+)(\/print|\/pay)?$/);
  if (!m) return null;
  const inv = await getInvoice(env, m[1], company.id);
  if (!inv || inv.status === "draft") return null;
  if (m[2] === "/print") return printPage(request, inv);
  if (m[2] === "/pay" && request.method === "POST") {
    if (ctx.viewAs || inv.status !== "issued" || !razorpayReady(env) || balanceOf(inv) <= 0) return redirect(request, `/billing/invoices/${inv.id}`);
    const urlPay = await createPaymentLink(env, request, inv, ctx);
    if (!urlPay) return redirect(request, `/billing/invoices/${inv.id}?m=e_pay`);
    await audit(env, ctx, { companyId: company.id, action: "payment.start", summary: `${ctx.user.email} opened online payment for ${inv.number}`, ip: clientIp(request) });
    return new Response(null, { status: 303, headers: { Location: urlPay, ...securityHeaders("x", true) } });
  }
  if (request.method !== "GET") return null;
  const pays = await paymentsOf(env, inv.id);
  const bal = balanceOf(inv);
  const payPanel =
    inv.status === "issued" && bal > 0
      ? `<div class="card panel"><div class="k">Balance due</div><div class="stat"><div class="v">${esc(fmtMoney(bal, inv.currency))}</div><div class="s">${inv.due_date < todayIST() ? `<b style="color:var(--red)">Was due ${esc(fmtDate(inv.due_date))}</b>` : `Due ${esc(fmtDate(inv.due_date))}`}</div></div>
        ${razorpayReady(env) && !ctx.viewAs ? `<form method="post" action="/billing/invoices/${esc(inv.id)}/pay" style="margin-top:16px"><button class="btn pri" style="width:100%">Pay ${esc(fmtMoney(bal, inv.currency))} online ${ARROW}</button></form><p class="small muted" style="margin:10px 0 0">${inv.currency === "INR" ? "UPI, cards, net banking and wallets" : "International cards"}, through Razorpay. You'll come straight back here.</p>` : ""}
        <p class="small muted" style="margin:14px 0 0">Paying by bank transfer? Use the details on the invoice and quote <b>${esc(inv.number)}</b>. If you deduct TDS, tell us in Messages and we'll record it.</p></div>`
      : inv.status === "paid"
        ? `<div class="card panel"><div class="k">Status</div><h3 style="margin-top:8px;color:var(--green)">Paid in full</h3><p class="small muted" style="margin:0">Thank you.</p></div>`
        : `<div class="card panel"><div class="k">Status</div><h3 style="margin-top:8px">Cancelled</h3><p class="small muted" style="margin:0">${esc(inv.void_reason || "This invoice was cancelled and nothing is owed on it.")}</p></div>`;
  return page({
    title: inv.number,
    active: "billing",
    crumbs: [[company.name], ["Billing", "/billing"], [inv.number]],
    body: `${pageHead({ eyebrow: `${company.name} · Invoice`, title: `${esc(inv.number)} ${stateBadge(inv)}`, right: `<a class="btn" href="/billing/invoices/${esc(inv.id)}/print">Download PDF</a>` })}
    <div class="split"><div>${invoiceDoc(inv)}</div><div>${payPanel}${
      pays.length ? `<div class="card sec"><h3>Payments</h3><div class="rows">${pays.map((x) => `<div class="row"><div class="grow"><b>${esc(fmtMoney(x.amount, x.currency))}${x.tds ? ` + ${esc(fmtMoney(x.tds, x.currency))} TDS` : ""}</b><small>${esc(METHODS[x.method] || x.method)} · ${esc(fmtDate(x.received_on))}</small></div></div>`).join("")}</div></div>` : ""
    }</div></div><style>${INV_CSS}</style>`,
  });
}

// ---------- admin routes ----------

function lineEditor(lines, settings, type) {
  const taxed = type === "intra" || type === "inter";
  const row = (l, i) => `<div class="ln-row">
    <input type="text" name="ln_desc_${i}" value="${esc(l?.description || "")}" placeholder="What the client is paying for" aria-label="Description">
    <input type="text" name="ln_sac_${i}" value="${esc(l?.sac ?? settings.default_sac)}" aria-label="SAC code">
    <input type="text" name="ln_qty_${i}" value="${esc(l ? String(+l.qty) : "1")}" inputmode="decimal" aria-label="Quantity">
    <input type="text" name="ln_rate_${i}" value="${esc(l ? toInput(l.rate) : "")}" inputmode="decimal" placeholder="0.00" aria-label="Rate">
    <input type="text" name="ln_tax_${i}" value="${esc(l ? String(l.tax_rate || (taxed ? settings.default_tax_rate : 0)) : settings.default_tax_rate)}" inputmode="decimal" aria-label="GST percent"${taxed ? "" : " disabled"}>
  </div>`;
  const rows = [...lines, null, null];
  return `<div class="ln-head"><span>Description</span><span>SAC</span><span>Qty</span><span>Rate</span><span>GST %</span></div>
  <div id="ln-rows">${rows.map(row).join("")}</div><input type="hidden" name="ln_count" id="ln-count" value="${rows.length}">
  <button type="button" class="btn sm" data-add-line style="margin-top:10px">Add another line</button><template id="ln-tpl">${row(null, "__I__")}</template>
  ${taxed ? "" : `<p class="small muted" style="margin:10px 0 0">${type === "export" ? "Export invoice: no GST is charged." : "You're not GST registered (no GSTIN in settings): no GST is charged."}</p>`}`;
}

async function draftForm(env, { inv = null, companies, company = null, settings, action }) {
  const type = company ? supplyType({ sellerRegistered: settings.registered, sellerState: settings.seller_state, buyerCountry: company.country, buyerState: company.state }) : "intra";
  const issue = inv?.issue_date || todayIST();
  const due = inv?.due_date || addDays(issue, parseInt(settings.payment_terms_days || "7", 10) || 7);
  return `<form class="f" method="post" action="${action}" style="max-width:1000px">
    <div class="card"><div class="grid" style="gap:16px">
      ${
        inv
          ? `<div class="fld"><label>Client</label><input type="text" value="${esc(company.name)} · ${esc(company.currency)}" disabled></div>`
          : `<div class="fld"><label for="i_client">Client</label><select id="i_client" name="company_id" required><option value="">Select a client</option>${companies.map((c) => `<option value="${esc(c.id)}"${company && c.id === company.id ? " selected" : ""}>${esc(c.name)} · ${esc(c.currency)}</option>`).join("")}</select><span class="hint">The invoice is raised in the client's billing currency.</span></div>`
      }
      <div class="frow"><div class="fld"><label for="i_issue">Invoice date</label><input id="i_issue" name="issue_date" type="date" value="${esc(issue)}" required></div><div class="fld"><label for="i_due">Due date</label><input id="i_due" name="due_date" type="date" value="${esc(due)}" required></div></div>
    </div></div>
    <div class="card"><div class="card-h"><h3>Lines</h3><span class="small muted">Amounts before tax, in ${esc(company?.currency || "the client's currency")}</span></div>${lineEditor(inv?.lines || [], settings, type)}</div>
    <div class="card"><div class="fld"><label for="i_notes">Notes on the invoice (optional)</label><textarea id="i_notes" name="notes" rows="2" placeholder="Purchase order number, project reference…">${esc(inv?.notes || "")}</textarea></div></div>
    <div class="actions"><button class="btn pri">Save draft ${ARROW}</button><span class="small muted">Nothing is sent until you issue it.</span></div></form>`;
}

export async function adminBillingRoute(request, env, ctx, mail, path) {
  const url = new URL(request.url);
  const n = nonce();
  const flash = flashFrom(url);
  const ip = clientIp(request);
  const page = (o) => html(request, appPage({ nonce: n, ctx, flash, ...o }), n);
  const settings = await getSettings(env);
  const activeCompanies = async () => (await env.DB.prepare(`SELECT * FROM portal_companies WHERE status = 'active' ORDER BY name`).all()).results || [];

  if (path === "/admin/billing" && request.method === "GET") {
    const st = url.searchParams.get("status") || "open";
    const client = url.searchParams.get("client") || null;
    const where = { open: "i.status = 'issued'", draft: "i.status = 'draft'", paid: "i.status = 'paid'", void: "i.status = 'void'", all: "1=1" }[st] || "i.status = 'issued'";
    const invs = (await env.DB.prepare(`SELECT i.*, c.name AS company_name FROM portal_invoices i JOIN portal_companies c ON c.id = i.company_id WHERE ${where} AND (? IS NULL OR i.company_id = ?) ORDER BY i.status = 'draft' DESC, i.due_date, i.created_at DESC LIMIT 300`).bind(client, client).all()).results || [];
    const tot = (await env.DB.prepare(`SELECT currency, COALESCE(SUM(total - paid - tds),0) AS due, SUM(CASE WHEN due_date < ? THEN total - paid - tds ELSE 0 END) AS overdue FROM portal_invoices WHERE status = 'issued' GROUP BY currency`).bind(todayIST()).all()).results || [];
    const g = (c) => tot.find((t) => t.currency === c) || { due: 0, overdue: 0 };
    const drafts = (await env.DB.prepare(`SELECT COUNT(*) AS c FROM portal_invoices WHERE status = 'draft'`).first()).c;
    const dueItems = (await env.DB.prepare(`SELECT si.*, s.title, c.name AS company_name, s.id AS sid FROM portal_schedule_items si JOIN portal_schedules s ON s.id = si.schedule_id JOIN portal_companies c ON c.id = si.company_id WHERE si.invoice_id IS NULL AND s.status = 'active' AND c.status = 'active' AND si.due_date <= ? ORDER BY si.due_date LIMIT 30`).bind(addDays(todayIST(), 7)).all()).results || [];
    const companies = await activeCompanies();
    const tabs = [["open", "Unpaid"], ["draft", "Drafts"], ["paid", "Paid"], ["void", "Cancelled"], ["all", "All"]];
    return page({
      title: "Billing",
      active: "billing",
      crumbs: [["Admin", "/admin"], ["Billing"]],
      body: `${pageHead({ eyebrow: "Admin · Billing", title: `What's owed, <em>and what's next.</em>`, lead: "INR and USD are kept separate, never converted.", right: `<a class="btn" href="/admin/billing/schedules/new">New payment schedule</a><a class="btn pri" href="/admin/billing/invoices/new">New invoice ${ARROW}</a>` })}
      <div class="grid g4" style="margin-bottom:8px">
        <div class="card stat"><div class="k">Outstanding · INR</div><div class="v">${esc(fmtMoney(g("INR").due, "INR"))}</div><div class="s">${g("INR").overdue ? `<span style="color:var(--red)">${esc(fmtMoney(g("INR").overdue, "INR"))} overdue</span>` : "nothing overdue"}</div></div>
        <div class="card stat"><div class="k">Outstanding · USD</div><div class="v">${esc(fmtMoney(g("USD").due, "USD"))}</div><div class="s">${g("USD").overdue ? `<span style="color:var(--red)">${esc(fmtMoney(g("USD").overdue, "USD"))} overdue</span>` : "nothing overdue"}</div></div>
        <div class="card stat"><div class="k">Drafts</div><div class="v">${drafts}</div><div class="s">not sent yet</div></div>
        <div class="card stat panel"><div class="k">Online payments</div><div class="v" style="font-size:17px;margin-top:12px">${razorpayReady(env) ? "Razorpay on" : "Not connected"}</div><div class="s"><a href="/admin/settings">Billing settings</a></div></div>
      </div>
      ${!settings.registered ? `<div class="flash" style="margin-top:20px">No GSTIN in <a href="/admin/settings">billing settings</a>, so invoices are raised without GST. Add it there if you're registered.</div>` : ""}
      ${dueItems.length ? `<div class="sec"><div class="card-h"><h2>Instalments to invoice <span class="cnt">${dueItems.length}</span></h2><span class="small muted">Due within a week, from payment schedules</span></div><div class="rows">${dueItems.map((it) => `<div class="row"><div class="grow"><b>${esc(it.company_name)} · ${esc(it.label)}</b><small>${esc(it.title)} · due ${esc(fmtDate(it.due_date))} · ${esc(fmtMoney(it.amount, companies.find((c) => c.id === it.company_id)?.currency || "INR"))} + tax</small></div><form method="post" action="/admin/billing/schedules/${esc(it.sid)}/items/${esc(it.id)}/invoice" class="inline"><button class="btn sm pri">Create invoice</button></form></div>`).join("")}</div></div>` : ""}
      <div class="sec"><div class="actions" style="margin-bottom:14px">${tabs.map(([k, l]) => `<a class="btn sm${k === st ? " pri" : ""}" href="/admin/billing?status=${k}${client ? `&amp;client=${esc(client)}` : ""}">${l}</a>`).join("")}
        <form method="get" class="inline" style="margin-left:auto"><input type="hidden" name="status" value="${esc(st)}"><select name="client" data-autosubmit style="width:auto;padding:7px 10px;font-size:13px"><option value="">All clients</option>${companies.map((c) => `<option value="${esc(c.id)}"${c.id === client ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></form></div>
        ${invs.length ? invoiceTable(invs, "/admin/billing/invoices", { showCompany: true }) : `<div class="empty">No invoices here.</div>`}</div>`,
    });
  }

  if (path === "/admin/billing/invoices/new") {
    const companies = await activeCompanies();
    if (request.method === "POST") {
      const f = await readForm(request);
      const company = companies.find((c) => c.id === f.company_id);
      if (!company || !/^\d{4}-\d{2}-\d{2}$/.test(f.issue_date || "") || !/^\d{4}-\d{2}-\d{2}$/.test(f.due_date || "")) return redirect(request, "/admin/billing/invoices/new?m=e_invoice");
      const id = newId("inv");
      const ts = now();
      await env.DB.prepare(`INSERT INTO portal_invoices (id, company_id, status, currency, supply_type, issue_date, due_date, notes, created_by, created_at, updated_at) VALUES (?,?, 'draft', ?, 'intra', ?,?,?,?,?,?)`)
        .bind(id, company.id, company.currency, f.issue_date, f.due_date, String(f.notes || "").trim().slice(0, 1000) || null, ctx.user.id, ts, ts)
        .run();
      await saveLinesFromForm(env, id, f);
      await recalc(env, await getInvoice(env, id), company, settings);
      await audit(env, ctx, { companyId: company.id, action: "invoice.draft", summary: "Created a draft invoice", ip });
      return redirect(request, `/admin/billing/invoices/${id}?m=saved`);
    }
    const pre = companies.find((c) => c.id === url.searchParams.get("client")) || null;
    return page({
      title: "New invoice",
      active: "billing",
      crumbs: [["Admin", "/admin"], ["Billing", "/admin/billing"], ["New invoice"]],
      body: `${pageHead({ eyebrow: "Admin · Billing", title: `New <em>invoice.</em>`, lead: "GST is worked out from the client's state: same state as ours means CGST + SGST, another state means IGST, overseas means an export invoice with no GST." })}${await draftForm(env, { companies, company: pre, settings, action: "/admin/billing/invoices/new" })}`,
    });
  }

  // Schedules
  if (path === "/admin/billing/schedules/new") {
    const companies = await activeCompanies();
    if (request.method === "POST") {
      const f = await readForm(request);
      const company = companies.find((c) => c.id === f.company_id);
      const title = String(f.title || "").trim().slice(0, 160);
      if (!company || !title) return redirect(request, "/admin/billing/schedules/new?m=e_schedule");
      const items = [];
      const monthly = parseAmount(f.m_amount);
      if (monthly && /^\d{4}-\d{2}-\d{2}$/.test(f.m_start || "")) {
        const count = Math.min(Math.max(parseInt(f.m_count || "12", 10) || 12, 1), 60);
        const [y, mo, d] = f.m_start.split("-").map(Number);
        for (let i = 0; i < count; i++) {
          const dt = new Date(Date.UTC(y, mo - 1 + i, 1));
          const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
          dt.setUTCDate(Math.min(d, last));
          items.push({ label: dt.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }), due: dt.toISOString().slice(0, 10), amount: monthly });
        }
      }
      const count = Math.min(parseInt(f.it_count || "0", 10) || 0, 60);
      for (let i = 0; i < count; i++) {
        const label = String(f[`it_label_${i}`] || "").trim().slice(0, 160);
        const amount = parseAmount(f[`it_amount_${i}`]);
        if (!label || !amount) continue;
        items.push({ label, due: /^\d{4}-\d{2}-\d{2}$/.test(f[`it_due_${i}`] || "") ? f[`it_due_${i}`] : null, amount });
      }
      if (!items.length) return redirect(request, "/admin/billing/schedules/new?m=e_schedule");
      const id = newId("sch");
      const tax = Math.max(0, Math.min(28, parseFloat(f.tax_rate || settings.default_tax_rate) || 0));
      const stmts = [env.DB.prepare(`INSERT INTO portal_schedules (id, company_id, title, sac, tax_rate, created_by, created_at) VALUES (?,?,?,?,?,?,?)`).bind(id, company.id, title, String(f.sac || settings.default_sac).slice(0, 10), tax, ctx.user.id, now())];
      items.sort((a, b) => (a.due || "9").localeCompare(b.due || "9"));
      items.forEach((it, i) => stmts.push(env.DB.prepare(`INSERT INTO portal_schedule_items (id, schedule_id, company_id, sort, label, due_date, amount) VALUES (?,?,?,?,?,?,?)`).bind(newId("si"), id, company.id, i + 1, it.label, it.due, it.amount)));
      await env.DB.batch(stmts);
      await audit(env, ctx, { companyId: company.id, action: "schedule.create", summary: `Created payment schedule “${title}” (${items.length} instalments)`, ip });
      return redirect(request, `/admin/billing/schedules/${id}?m=saved`);
    }
    const pre = url.searchParams.get("client") || "";
    const row = (i) => `<div class="si-row"><input type="text" name="it_label_${i}" placeholder="Milestone, e.g. On sign-off (40%)" aria-label="Label"><input type="date" name="it_due_${i}" aria-label="Due date"><input type="text" name="it_amount_${i}" inputmode="decimal" placeholder="Amount before tax" aria-label="Amount"></div>`;
    return page({
      title: "New payment schedule",
      active: "billing",
      crumbs: [["Admin", "/admin"], ["Billing", "/admin/billing"], ["New payment schedule"]],
      body: `${pageHead({ eyebrow: "Admin · Billing", title: `New payment <em>schedule.</em>`, lead: "The client sees what's coming and when. Each instalment becomes an invoice when you click Create invoice; due ones are flagged on the Billing page a week ahead." })}
      <form class="f" method="post" action="/admin/billing/schedules/new" style="max-width:900px">
        <div class="card"><div class="grid" style="gap:16px"><div class="fld"><label for="sc_client">Client</label><select id="sc_client" name="company_id" required><option value="">Select a client</option>${companies.map((c) => `<option value="${esc(c.id)}"${c.id === pre ? " selected" : ""}>${esc(c.name)} · ${esc(c.currency)}</option>`).join("")}</select></div>
          <div class="fld"><label for="sc_title">What it's for</label><input id="sc_title" name="title" type="text" required maxlength="160" placeholder="Website and CRM build, or Monthly retainer"></div>
          <div class="frow"><div class="fld"><label for="sc_sac">SAC</label><input id="sc_sac" name="sac" type="text" value="${esc(settings.default_sac)}"></div><div class="fld"><label for="sc_tax">GST % (ignored for export clients)</label><input id="sc_tax" name="tax_rate" type="text" value="${esc(settings.default_tax_rate)}"></div></div></div></div>
        <div class="card"><div class="card-h"><h3>Monthly retainer</h3><span class="small muted">Fill this for a fixed monthly fee</span></div><div class="frow3"><div class="fld"><label for="m_amount">Monthly amount (before tax)</label><input id="m_amount" name="m_amount" type="text" inputmode="decimal" placeholder="50000"></div><div class="fld"><label for="m_start">First due date</label><input id="m_start" name="m_start" type="date"></div><div class="fld"><label for="m_count">Number of months</label><input id="m_count" name="m_count" type="text" value="12" inputmode="numeric"></div></div></div>
        <div class="card"><div class="card-h"><h3>Milestones</h3><span class="small muted">And/or list instalments yourself</span></div><div class="si-head"><span>Label</span><span>Due</span><span>Amount</span></div><div id="si-rows">${[0, 1, 2, 3].map(row).join("")}</div><input type="hidden" name="it_count" id="si-count" value="4"><button type="button" class="btn sm" data-add-si style="margin-top:10px">Add another</button><template id="si-tpl">${row("__I__")}</template></div>
        <div><button class="btn pri">Create schedule ${ARROW}</button></div></form>`,
    });
  }

  const sm = path.match(/^\/admin\/billing\/schedules\/(sch_[a-z0-9]+)(\/.*)?$/);
  if (sm) {
    const sch = await env.DB.prepare(`SELECT s.*, c.name AS company_name, c.currency FROM portal_schedules s JOIN portal_companies c ON c.id = s.company_id WHERE s.id = ?`).bind(sm[1]).first();
    if (!sch) return null;
    const sub = sm[2] || "";
    if (sub === "" && request.method === "GET") {
      const { list, invMap } = await schedulesFor(env, sch.company_id, { includeArchived: true });
      const mine = list.find((x) => x.s.id === sch.id);
      return page({
        title: sch.title,
        active: "billing",
        crumbs: [["Admin", "/admin"], ["Billing", "/admin/billing"], [sch.title]],
        body: `${pageHead({ eyebrow: `${sch.company_name} · Payment schedule`, title: esc(sch.title), lead: `SAC ${esc(sch.sac || "—")} · GST ${sch.tax_rate}% (none for export clients)` })}
        ${scheduleBlock({ ...sch }, mine.items, invMap, { admin: true, base: "/admin/billing/invoices" }).replace(/<a class="btn sm" href="\/admin\/billing\/schedules\/[^"]+">Open<\/a>/, "")}
        <form method="post" action="/admin/billing/schedules/${esc(sch.id)}/archive" class="sec" data-confirm="${sch.status === "archived" ? "Reactivate" : "Archive"} this schedule?"><button class="btn sm${sch.status === "archived" ? "" : " danger"}">${sch.status === "archived" ? "Reactivate schedule" : "Archive schedule"}</button> <span class="small muted">Archived schedules are hidden from the client. Invoices already raised stay.</span></form>`,
      });
    }
    if (sub === "/archive" && request.method === "POST") {
      const to = sch.status === "archived" ? "active" : "archived";
      await env.DB.prepare(`UPDATE portal_schedules SET status = ? WHERE id = ?`).bind(to, sch.id).run();
      await audit(env, ctx, { companyId: sch.company_id, action: `schedule.${to}`, summary: `${to === "archived" ? "Archived" : "Reactivated"} payment schedule “${sch.title}”`, ip });
      return redirect(request, `/admin/billing/schedules/${sch.id}?m=saved`);
    }
    const im = sub.match(/^\/items\/(si_[a-z0-9]+)\/invoice$/);
    if (im && request.method === "POST") {
      const it = await env.DB.prepare(`SELECT * FROM portal_schedule_items WHERE id = ? AND schedule_id = ?`).bind(im[1], sch.id).first();
      if (!it) return redirect(request, `/admin/billing/schedules/${sch.id}`);
      if (it.invoice_id) return redirect(request, `/admin/billing/invoices/${it.invoice_id}`);
      const company = await env.DB.prepare(`SELECT * FROM portal_companies WHERE id = ?`).bind(sch.company_id).first();
      const id = newId("inv");
      const ts = now();
      const issue = todayIST();
      const due = it.due_date && it.due_date > issue ? it.due_date : addDays(issue, parseInt(settings.payment_terms_days || "7", 10) || 7);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO portal_invoices (id, company_id, status, currency, supply_type, issue_date, due_date, schedule_item_id, created_by, created_at, updated_at) VALUES (?,?, 'draft', ?, 'intra', ?,?,?,?,?,?)`).bind(id, company.id, company.currency, issue, due, it.id, ctx.user.id, ts, ts),
        env.DB.prepare(`INSERT INTO portal_invoice_lines (id, invoice_id, sort, description, sac, qty, rate, tax_rate) VALUES (?,?,1,?,?,1,?,?)`).bind(newId("ln"), id, `${sch.title}: ${it.label}`, sch.sac, it.amount, sch.tax_rate),
        env.DB.prepare(`UPDATE portal_schedule_items SET invoice_id = ? WHERE id = ?`).bind(id, it.id),
      ]);
      await recalc(env, await getInvoice(env, id), company, settings);
      await audit(env, ctx, { companyId: company.id, action: "invoice.draft", summary: `Drafted an invoice for “${it.label}” from schedule “${sch.title}”`, ip });
      return redirect(request, `/admin/billing/invoices/${id}?m=drafted`);
    }
    return null;
  }

  // Single invoice
  const m = path.match(/^\/admin\/billing\/invoices\/(inv_[a-z0-9]+)(\/[a-z]+)?$/);
  if (!m) return null;
  const inv = await getInvoice(env, m[1]);
  if (!inv) return null;
  const sub = m[2] || "";
  const base = `/admin/billing/invoices/${inv.id}`;
  const company = await env.DB.prepare(`SELECT * FROM portal_companies WHERE id = ?`).bind(inv.company_id).first();

  if (sub === "/print") return printPage(request, inv);

  if (sub === "" && request.method === "GET") {
    const pays = await paymentsOf(env, inv.id);
    const bal = balanceOf(inv);
    let side = "";
    if (inv.status === "draft") {
      const missing = [];
      if (!settings.seller_legal_name || !settings.seller_address) missing.push("your legal name and address in billing settings");
      if (company.country === "India" && settings.registered && !company.state) missing.push("the client's state (for place of supply)");
      if (!inv.lines.length) missing.push("at least one line");
      side = `<div class="card panel"><h3>Draft</h3><p class="small muted">Only you can see this. Issuing gives it the next number (${esc(company.currency === "USD" ? `MG/EX/${fyLabel(inv.issue_date)}/…` : `MG/${fyLabel(inv.issue_date)}/…`)}) and emails the client's Owners and Finance people.</p>
        ${missing.length ? `<div class="flash err" style="margin:0 0 14px">Before issuing, add ${esc(missing.join(", "))}.</div>` : ""}
        <div class="actions"><form method="post" action="${base}/issue" class="inline" data-confirm="Issue ${esc(fmtMoney(inv.total, inv.currency))} to ${esc(company.name)} and email them?"><button class="btn pri"${missing.length ? " disabled" : ""}>Issue and email ${ARROW}</button></form><a class="btn" href="${base}/edit">Edit</a></div>
        <form method="post" action="${base}/delete" style="margin-top:14px" data-confirm="Delete this draft?"><button class="linkbtn">Delete draft</button></form></div>`;
    } else if (inv.status === "issued") {
      side = `<div class="card panel"><div class="k">Balance due</div><div class="stat"><div class="v">${esc(fmtMoney(bal, inv.currency))}</div><div class="s">Due ${esc(fmtDate(inv.due_date))}</div></div>
        <div class="actions" style="margin-top:14px"><form method="post" action="${base}/remind" class="inline"><button class="btn sm">Send a reminder</button></form></div></div>
        <div class="card sec"><h3>Record a payment</h3><form class="f" method="post" action="${base}/payment">
          <div class="frow"><div class="fld"><label for="p_amt">Amount received</label><input id="p_amt" name="amount" type="text" inputmode="decimal" value="${esc(toInput(bal))}" required></div><div class="fld"><label for="p_tds">TDS deducted</label><input id="p_tds" name="tds" type="text" inputmode="decimal" placeholder="0"></div></div>
          <div class="frow"><div class="fld"><label for="p_m">Method</label><select id="p_m" name="method">${Object.entries(METHODS).filter(([k]) => k !== "razorpay").map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div><div class="fld"><label for="p_on">Received on</label><input id="p_on" name="received_on" type="date" value="${esc(todayIST())}"></div></div>
          <div class="fld"><label for="p_ref">Reference (UTR, cheque no.)</label><input id="p_ref" name="reference" type="text" maxlength="100"></div>
          <label class="check"><input type="checkbox" name="notify" value="1" checked> Email the client a receipt</label>
          <div><button class="btn pri sm">Record payment</button></div></form></div>
        <details class="card panel sec"><summary><b>Cancel this invoice</b></summary><form class="f" method="post" action="${base}/void" style="margin-top:14px" data-confirm="Cancel ${esc(inv.number)}? The number stays used and it shows as Cancelled."><div class="fld"><label for="v_r">Reason (shown to the client)</label><input id="v_r" name="reason" type="text" maxlength="300" required></div><div><button class="btn sm danger"${inv.paid + inv.tds > 0 ? " disabled" : ""}>Cancel invoice</button>${inv.paid + inv.tds > 0 ? '<span class="small muted"> Has payments, so it can\'t be cancelled.</span>' : ""}</div></form></details>`;
    } else {
      side = `<div class="card panel"><div class="k">Status</div><h3 style="margin-top:8px">${inv.status === "paid" ? "Paid in full" : "Cancelled"}</h3>${inv.void_reason ? `<p class="small muted" style="margin:0">${esc(inv.void_reason)}</p>` : ""}</div>`;
    }
    const payList = pays.length ? `<div class="card sec"><h3>Payments</h3><div class="rows">${pays.map((x) => `<div class="row"><div class="grow"><b>${esc(fmtMoney(x.amount, x.currency))}${x.tds ? ` + ${esc(fmtMoney(x.tds, x.currency))} TDS` : ""}</b><small>${esc(METHODS[x.method] || x.method)}${x.reference ? " · " + esc(x.reference) : ""} · ${esc(fmtDate(x.received_on))}${x.by_name ? " · by " + esc(x.by_name) : ""}</small></div></div>`).join("")}</div></div>` : "";
    return page({
      title: inv.number || "Draft invoice",
      active: "billing",
      crumbs: [["Admin", "/admin"], ["Billing", "/admin/billing"], [inv.number || "Draft"]],
      body: `${pageHead({ eyebrow: `${company.name} · Invoice`, title: `${esc(inv.number || "Draft invoice")} ${stateBadge(inv)}`, right: `<a class="btn" href="${base}/print">PDF / Print</a><a class="btn" href="/admin/clients/${esc(company.id)}">Client</a>` })}
      <div class="split"><div>${invoiceDoc(inv, settings, company)}</div><div>${side}${payList}</div></div><style>${INV_CSS}</style>`,
    });
  }

  if (sub === "/edit") {
    if (inv.status !== "draft") return redirect(request, base);
    if (request.method === "POST") {
      const f = await readForm(request);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.issue_date || "") || !/^\d{4}-\d{2}-\d{2}$/.test(f.due_date || "")) return redirect(request, `${base}/edit?m=e_invoice`);
      await env.DB.prepare(`UPDATE portal_invoices SET issue_date = ?, due_date = ?, notes = ?, updated_at = ? WHERE id = ?`).bind(f.issue_date, f.due_date, String(f.notes || "").trim().slice(0, 1000) || null, now(), inv.id).run();
      await saveLinesFromForm(env, inv.id, f);
      await recalc(env, await getInvoice(env, inv.id), company, settings);
      return redirect(request, `${base}?m=saved`);
    }
    return page({ title: "Edit draft", active: "billing", crumbs: [["Admin", "/admin"], ["Billing", "/admin/billing"], ["Draft", base], ["Edit"]], body: `${pageHead({ eyebrow: `${company.name} · Draft invoice`, title: `Edit <em>draft.</em>` })}${await draftForm(env, { inv, company, settings, action: `${base}/edit` })}` });
  }

  if (request.method !== "POST") return null;
  const f = await readForm(request);

  if (sub === "/delete" && inv.status === "draft") {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM portal_invoice_lines WHERE invoice_id = ?`).bind(inv.id),
      env.DB.prepare(`DELETE FROM portal_invoices WHERE id = ? AND status = 'draft'`).bind(inv.id),
      env.DB.prepare(`UPDATE portal_schedule_items SET invoice_id = NULL WHERE invoice_id = ?`).bind(inv.id),
    ]);
    await audit(env, ctx, { companyId: inv.company_id, action: "invoice.delete", summary: "Deleted a draft invoice", ip });
    return redirect(request, "/admin/billing?status=draft&m=deleted");
  }

  if (sub === "/issue" && inv.status === "draft") {
    if (!inv.lines.length) return redirect(request, `${base}?m=e_invoice`);
    if (company.country === "India" && settings.registered && !company.state) return redirect(request, `${base}?m=e_state`);
    await recalc(env, inv, company, settings);
    const fresh = await getInvoice(env, inv.id);
    if (fresh.total <= 0) return redirect(request, `${base}?m=e_invoice`);
    const number = await nextInvoiceNumber(env, fresh.supply_type === "export" ? "EX" : "IN", fyLabel(fresh.issue_date));
    await env.DB.prepare(`UPDATE portal_invoices SET number = ?, status = 'issued', seller = ?, buyer = ?, issued_at = ?, issued_by = ?, updated_at = ? WHERE id = ? AND status = 'draft'`)
      .bind(number, JSON.stringify(sellerFrom(settings)), JSON.stringify(buyerFrom(company)), now(), ctx.user.id, now(), inv.id)
      .run();
    await audit(env, ctx, { companyId: inv.company_id, action: "invoice.issue", summary: `Issued invoice ${number} for ${fmtMoney(fresh.total, fresh.currency)}`, ip });
    await invoiceEmail(env, mail, request, await getInvoice(env, inv.id), false);
    return redirect(request, `${base}?m=issued`);
  }

  if (sub === "/remind" && inv.status === "issued") {
    await invoiceEmail(env, mail, request, inv, true);
    await audit(env, ctx, { companyId: inv.company_id, action: "invoice.remind", summary: `Sent a payment reminder for ${inv.number}`, ip });
    return redirect(request, `${base}?m=reminded`);
  }

  if (sub === "/payment" && inv.status === "issued") {
    const amount = parseAmount(f.amount) ?? 0;
    const tds = parseAmount(f.tds) ?? 0;
    if (amount + tds <= 0) return redirect(request, `${base}?m=e_amount`);
    const method = METHODS[f.method] && f.method !== "razorpay" ? f.method : "other";
    await recordPayment(env, inv, { amount, tds, method, reference: String(f.reference || "").trim().slice(0, 100) || null, receivedOn: /^\d{4}-\d{2}-\d{2}$/.test(f.received_on || "") ? f.received_on : todayIST(), byUserId: ctx.user.id });
    await audit(env, ctx, { companyId: inv.company_id, action: "payment.record", summary: `Recorded ${fmtMoney(amount, inv.currency)}${tds ? ` + ${fmtMoney(tds, inv.currency)} TDS` : ""} (${METHODS[method]}) on ${inv.number}`, ip });
    if (f.notify && amount > 0) {
      const fresh = await getInvoice(env, inv.id);
      await emailCompany(env, mail, inv.company_id, {
        roles: MONEY_ROLES,
        subject: `Payment received: ${inv.number} · ${fmtMoney(amount, inv.currency)}`,
        html: p(`Thank you. We've received <b>${esc(fmtMoney(amount, inv.currency))}</b>${tds ? ` and noted <b>${esc(fmtMoney(tds, inv.currency))}</b> TDS deducted` : ""} against invoice <b>${esc(inv.number)}</b>.`) + p(fresh.status === "paid" ? "This invoice is now fully paid." : `Balance still due: <b>${esc(fmtMoney(balanceOf(fresh), inv.currency))}</b>.`) + mail.button("View the invoice", `${portalOrigin(request)}/billing/invoices/${inv.id}`),
      });
    }
    return redirect(request, `${base}?m=payment`);
  }

  if (sub === "/void" && inv.status === "issued" && inv.paid + inv.tds === 0) {
    const reason = String(f.reason || "").trim().slice(0, 300) || "Cancelled";
    await env.DB.batch([
      env.DB.prepare(`UPDATE portal_invoices SET status = 'void', void_reason = ?, voided_at = ?, updated_at = ? WHERE id = ?`).bind(reason, now(), now(), inv.id),
      env.DB.prepare(`UPDATE portal_schedule_items SET invoice_id = NULL WHERE invoice_id = ?`).bind(inv.id),
    ]);
    await audit(env, ctx, { companyId: inv.company_id, action: "invoice.void", summary: `Cancelled invoice ${inv.number}: ${reason}`, ip });
    await emailCompany(env, mail, inv.company_id, { roles: MONEY_ROLES, subject: `Invoice ${inv.number} cancelled`, html: p(`Invoice <b>${esc(inv.number)}</b> has been cancelled, so nothing is owed on it.`) + p(`Reason: ${esc(reason)}`) + mail.button("Open billing", `${portalOrigin(request)}/billing`) });
    return redirect(request, `${base}?m=voided`);
  }
  return redirect(request, base);
}

async function invoiceEmail(env, mail, request, inv, reminder) {
  const origin = portalOrigin(request);
  const bal = balanceOf(inv);
  const overdue = inv.due_date < todayIST();
  await emailCompany(env, mail, inv.company_id, {
    roles: MONEY_ROLES,
    subject: reminder ? `${overdue ? "Overdue" : "Reminder"}: invoice ${inv.number} · ${fmtMoney(bal, inv.currency)}` : `Invoice ${inv.number} from Meridian Gray · ${fmtMoney(inv.total, inv.currency)}`,
    html:
      p(reminder ? `A reminder that invoice <b>${esc(inv.number)}</b> has <b>${esc(fmtMoney(bal, inv.currency))}</b> ${overdue ? `outstanding. It was due on <b>${esc(fmtDate(inv.due_date))}</b>.` : `due on <b>${esc(fmtDate(inv.due_date))}</b>.`}` : `Here's invoice <b>${esc(inv.number)}</b> for <b>${esc(fmtMoney(inv.total, inv.currency))}</b>, due on <b>${esc(fmtDate(inv.due_date))}</b>.`) +
      mail.button(razorpayReady(env) ? "View and pay online" : "View the invoice", `${origin}/billing/invoices/${inv.id}`) +
      muted(`You can download it as a PDF from the portal. Bank details are on the invoice if you'd rather pay by transfer.${reminder ? " If you've already paid, thank you, and please ignore this." : ""}`),
  });
}
