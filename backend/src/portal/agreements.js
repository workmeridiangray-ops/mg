// Agreements: proposals, statements of work, service agreements, NDAs and
// change requests, written by the team and signed online by the client.
//
// When an agreement is sent, its text is fingerprinted (SHA-256). Sent text
// can't be edited; a change means a revised version that replaces it. A
// signature records the typed name, title, email, time, IP address, browser
// and the fingerprint of exactly the text that was signed.

import { now, newId, audit, sha256 } from "./db.js";
import { esc, appPage, pageHead, ARROW } from "./ui.js";
import { html, redirect, readForm, clientIp, flashFrom, nonce } from "./http.js";
import { fmtWhen } from "./time.js";
import { emailCompany, emailTeam, p, muted, quote } from "./notify.js";
import { portalOrigin, adminOrigin } from "./auth.js";

export const KINDS = { proposal: "Proposal", sow: "Statement of work", contract: "Service agreement", nda: "Non-disclosure agreement", change_request: "Change request", other: "Agreement" };
const MONEY_ROLES = ["owner", "finance"];

const SKELETON = {
  proposal: "# Background\n\n# What we'll do\n\n- \n\n# Deliverables\n\n- \n\n# Timeline\n\n# Investment\n\n# Next steps\n",
  sow: "# Parties\n\n# Scope of work\n\n- \n\n# Out of scope\n\n- \n\n# Deliverables and acceptance\n\n# Timeline and milestones\n\n# Fees and payment schedule\n\n# Assumptions\n",
  contract: "# Parties\n\n# Services\n\n# Term\n\n# Fees and payment\n\n# Intellectual property\n\n# Confidentiality\n\n# Termination\n\n# Governing law\n",
  nda: "# Parties\n\n# Confidential information\n\n# Obligations\n\n# Exclusions\n\n# Term\n\n# Governing law\n",
  change_request: "# What's changing\n\n# Why\n\n# Impact on timeline\n\n# Impact on fees\n\n# Approval\n\nSigning this change request approves the change described above, which then forms part of the agreement it amends.\n",
  other: "",
};

// Minimal, safe formatting: # / ## headings, - bullets, 1. numbered, **bold**.
export function renderBody(src) {
  const out = [];
  let list = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  for (const raw of String(src || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { close(); continue; }
    if ((m = /^##\s+(.*)$/.exec(line))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); continue; }
    if ((m = /^#\s+(.*)$/.exec(line))) { close(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    close();
    out.push(`<p>${inline(line)}</p>`);
  }
  close();
  return out.join("");
}

const fingerprint = (a) => sha256(`${a.kind}\n${a.title}\n${a.body}`);

const STATUS = { draft: ["Draft", "grey"], sent: ["Awaiting signature", "blue"], signed: ["Signed", "green"], declined: ["Declined", "red"], void: ["Withdrawn", "grey"], superseded: ["Replaced", "grey"] };
const badge = (a) => `<span class="bdg ${STATUS[a.status]?.[1] || "grey"}">${STATUS[a.status]?.[0] || a.status}</span>`;

async function getAgreement(env, id, companyId = null) {
  return env.DB.prepare(`SELECT a.*, c.name AS company_name FROM portal_agreements a JOIN portal_companies c ON c.id = a.company_id WHERE a.id = ? AND (? IS NULL OR a.company_id = ?)`).bind(id, companyId, companyId).first();
}
async function signaturesOf(env, id) {
  return (await env.DB.prepare(`SELECT * FROM portal_signatures WHERE agreement_id = ? ORDER BY signed_at`).bind(id).all()).results || [];
}

export async function pendingAgreements(env, companyId) {
  return (await env.DB.prepare(`SELECT * FROM portal_agreements WHERE company_id = ? AND status = 'sent' ORDER BY sent_at`).bind(companyId).all()).results || [];
}

const DOC_CSS = `.agr{border:1px solid var(--line);background:#fff;padding:40px 44px;max-width:860px;font-size:14.5px;line-height:1.7}
.agr-k{font-size:10.5px;letter-spacing:.24em;text-transform:uppercase;font-weight:600;color:var(--mute)}
.agr h2.agr-t{font-size:28px;letter-spacing:-.03em;margin:8px 0 6px}.agr .agr-sub{color:var(--mute);font-size:13px;padding-bottom:20px;border-bottom:2px solid var(--ink);margin-bottom:10px}
.agr h3{font-size:17px;margin:26px 0 8px;letter-spacing:-.01em}.agr h4{font-size:15px;margin:18px 0 6px}.agr p{margin:0 0 10px}.agr ul,.agr ol{margin:0 0 12px;padding-left:22px}
.cert{margin-top:30px;border-top:1px solid var(--line);padding-top:18px;font-size:13px}.cert table{border-collapse:collapse;width:100%}.cert td{padding:6px 10px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}.cert td:first-child{color:var(--mute);width:150px}
.cert .fp{font-family:var(--mono);font-size:11px;word-break:break-all}
@media (max-width:700px){.agr{padding:22px 18px}}
@media print{.agr{border:0;padding:0}}`;

function agreementDoc(a, sigs) {
  const sig = sigs[sigs.length - 1];
  return `<article class="agr"><div class="agr-k">${esc(KINDS[a.kind] || "Agreement")} · Meridian Gray and ${esc(a.company_name)}</div><h2 class="agr-t">${esc(a.title)}</h2>
  <div class="agr-sub">${a.sent_at ? `Issued ${esc(fmtWhen(a.sent_at))} by ${esc(a.sender_name || "Meridian Gray")}` : "Draft, not sent"}${a.replaces ? " · replaces an earlier version" : ""}</div>
  ${renderBody(a.body)}
  ${
    a.status === "signed" && sig
      ? `<div class="cert"><div class="agr-k" style="margin-bottom:8px">Electronic signature record</div><table>
      <tr><td>Issued by</td><td>${a.sender_name && a.sender_name !== "Meridian Gray" ? `${esc(a.sender_name)}, for ` : ""}Meridian Gray · ${esc(fmtWhen(a.sent_at))}</td></tr>
      <tr><td>Signed by</td><td><b>${esc(sig.typed_name)}</b>${sig.title ? `, ${esc(sig.title)}` : ""}, for ${esc(a.company_name)} (${esc(sig.email)})</td></tr>
      <tr><td>Signed at</td><td>${esc(fmtWhen(sig.signed_at))} · IP ${esc(sig.ip || "unknown")}</td></tr>
      <tr><td>Document fingerprint</td><td class="fp">SHA-256 ${esc(sig.doc_hash)}</td></tr></table>
      <p class="small muted" style="margin:10px 0 0">Signed electronically in the Meridian Gray client portal after signing in with a one-time link sent to the signer's email address. The fingerprint identifies exactly the text above.</p></div>`
      : a.status === "declined"
        ? `<div class="cert"><div class="agr-k">Declined</div><p>${esc(fmtWhen(a.declined_at))}${a.decline_reason ? `: “${esc(a.decline_reason)}”` : ""}</p></div>`
        : ""
  }</article>`;
}

function printPage(request, a, sigs) {
  const n = nonce();
  return html(
    request,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(a.title)} · Meridian Gray</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap">
<style nonce="${n}">:root{--ink:#111;--mute:#5B606B;--line:#E2E4EA;--mono:ui-monospace,Menlo,monospace}body{margin:0;background:#F5F6F8;font-family:'Plus Jakarta Sans',Helvetica,Arial,sans-serif;color:#111}.bar{max-width:860px;margin:24px auto 12px;display:flex;justify-content:flex-end}.bar button{font:inherit;font-size:14px;font-weight:600;padding:10px 18px;border:1px solid #244BDB;background:#244BDB;color:#fff;cursor:pointer}.wrap{max-width:860px;margin:0 auto 40px}.small{font-size:12px}.muted{color:#5B606B}${DOC_CSS}@media print{body{background:#fff}.bar{display:none}.wrap{margin:0;max-width:none}@page{margin:16mm}}</style></head>
<body><div class="bar"><button type="button" data-print>Save as PDF / Print</button></div><div class="wrap">${agreementDoc(a, sigs)}</div><script nonce="${n}">document.querySelector('[data-print]').addEventListener('click',function(){window.print()})</script></body></html>`,
    n
  );
}

function listRows(list, base, { showCompany = false } = {}) {
  return `<div class="rows">${list
    .map((a) => `<a class="row thread" href="${base}/${esc(a.id)}"><div class="grow"><b>${esc(a.title)}</b><small>${showCompany ? esc(a.company_name) + " · " : ""}${esc(KINDS[a.kind] || "")}${a.sent_at ? ` · sent ${esc(fmtWhen(a.sent_at, { short: true }))}` : ""}${a.signed_at ? ` · signed ${esc(fmtWhen(a.signed_at, { short: true }))}` : ""}</small></div>${badge(a)}</a>`)
    .join("")}</div>`;
}

// ---------- client ----------

export async function clientAgreementsRoute(request, env, ctx, mail, path) {
  const url = new URL(request.url);
  const n = nonce();
  const company = ctx.company;
  const page = (o) => html(request, appPage({ nonce: n, ctx, flash: flashFrom(url), ...o }), n);

  if (path === "/agreements" && request.method === "GET") {
    const list = (await env.DB.prepare(`SELECT a.*, c.name AS company_name FROM portal_agreements a JOIN portal_companies c ON c.id = a.company_id WHERE a.company_id = ? AND a.status NOT IN ('draft') ORDER BY a.status = 'sent' DESC, COALESCE(a.signed_at, a.sent_at) DESC`).bind(company.id).all()).results || [];
    const pending = list.filter((a) => a.status === "sent");
    const rest = list.filter((a) => a.status !== "sent");
    return page({
      title: "Agreements",
      active: "agreements",
      crumbs: [[company.name], ["Agreements"]],
      body: `${pageHead({ eyebrow: `${company.name} · Agreements`, title: `Proposals and contracts, <em>signed online.</em>`, lead: "Read, sign and download every agreement between us. Owners and Finance people can sign for the company." })}
      ${pending.length ? `<div class="sec" style="margin-top:0"><div class="card-h"><h2>Waiting for your signature <span class="cnt">${pending.length}</span></h2></div>${listRows(pending, "/agreements")}</div>` : ""}
      <div class="sec"${pending.length ? "" : ' style="margin-top:0"'}><div class="card-h"><h2>${pending.length ? "Everything else" : "Agreements"}</h2></div>${rest.length ? listRows(rest, "/agreements") : `<div class="empty"><b>${pending.length ? "Nothing else yet." : "No agreements yet."}</b>When we send a proposal, contract or change request, you'll get an email and it'll be here to sign.</div>`}</div>`,
    });
  }

  const m = path.match(/^\/agreements\/(agr_[a-z0-9]+)(\/sign|\/decline|\/print)?$/);
  if (!m) return null;
  const a = await getAgreement(env, m[1], company.id);
  if (!a || a.status === "draft") return null;
  const sigs = await signaturesOf(env, a.id);
  if (m[2] === "/print") return printPage(request, a, sigs);

  if (request.method === "POST") {
    if (ctx.viewAs || a.status !== "sent") return redirect(request, `/agreements/${a.id}`);
    const f = await readForm(request);
    const ip = clientIp(request);
    const origin = portalOrigin(request);
    if (m[2] === "/sign") {
      const name = String(f.typed_name || "").trim().slice(0, 120);
      if (!name || !f.consent) return redirect(request, `/agreements/${a.id}?m=e_sign`);
      const hash = await fingerprint(a);
      if (hash !== a.doc_hash) return redirect(request, `/agreements/${a.id}?m=e_changed`);
      const ts = now();
      const res = await env.DB.prepare(`UPDATE portal_agreements SET status = 'signed', signed_at = ?, updated_at = ? WHERE id = ? AND status = 'sent'`).bind(ts, ts, a.id).run();
      if (!res.meta?.changes) return redirect(request, `/agreements/${a.id}`);
      await env.DB.prepare(`INSERT INTO portal_signatures (id, agreement_id, user_id, email, typed_name, title, doc_hash, ip, ua, signed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(newId("sig"), a.id, ctx.user.id, ctx.user.email, name, String(f.title || "").trim().slice(0, 80) || null, hash, ip, (request.headers.get("User-Agent") || "").slice(0, 200), ts)
        .run();
      await audit(env, ctx, { companyId: company.id, action: "agreement.sign", summary: `${name} (${ctx.user.email}) signed “${a.title}”`, detail: { hash }, ip });
      await emailTeam(env, mail, { subject: `[${company.name}] Signed: ${a.title}`, html: p(`<b>${esc(name)}</b> (${esc(ctx.user.email)}) signed <b>${esc(a.title)}</b> for ${esc(company.name)}.`) + mail.button("Open the agreement", `${adminOrigin(request)}/admin/agreements/${a.id}`) });
      await emailCompany(env, mail, company.id, { roles: MONEY_ROLES, subject: `Signed copy: ${a.title}`, html: p(`<b>${esc(a.title)}</b> was signed by ${esc(name)} on ${esc(fmtWhen(ts))}. The signed copy, with its signature record, is in your portal.`) + mail.button("Download the signed copy", `${origin}/agreements/${a.id}/print`) });
      return redirect(request, `/agreements/${a.id}?m=signed`);
    }
    if (m[2] === "/decline") {
      const reason = String(f.reason || "").trim().slice(0, 1000);
      if (!reason) return redirect(request, `/agreements/${a.id}`);
      await env.DB.prepare(`UPDATE portal_agreements SET status = 'declined', declined_at = ?, decline_reason = ?, updated_at = ? WHERE id = ? AND status = 'sent'`).bind(now(), reason, now(), a.id).run();
      await audit(env, ctx, { companyId: company.id, action: "agreement.decline", summary: `${ctx.user.email} declined “${a.title}”`, ip });
      await emailTeam(env, mail, { subject: `[${company.name}] Declined: ${a.title}`, replyTo: ctx.user.email, html: p(`<b>${esc(ctx.user.name || ctx.user.email)}</b> declined <b>${esc(a.title)}</b>:`) + quote(reason) + mail.button("Open the agreement", `${adminOrigin(request)}/admin/agreements/${a.id}`) });
      return redirect(request, `/agreements/${a.id}?m=declined`);
    }
    return null;
  }

  const canSign = !ctx.viewAs && a.status === "sent" && ["owner", "finance"].includes(ctx.role);
  const side =
    a.status === "sent"
      ? canSign
        ? `<div class="card panel"><h3>Sign this ${esc((KINDS[a.kind] || "agreement").toLowerCase())}</h3><form class="f" method="post" action="/agreements/${esc(a.id)}/sign">
          <div class="fld"><label for="g_name">Your full name</label><input id="g_name" name="typed_name" type="text" required maxlength="120" value="${esc(ctx.user.name || "")}" autocomplete="name"></div>
          <div class="fld"><label for="g_title">Your title</label><input id="g_title" name="title" type="text" maxlength="80" value="${esc(ctx.user.title || "")}" placeholder="Director"></div>
          <label class="check" style="align-items:flex-start"><input type="checkbox" name="consent" value="1" required style="margin-top:3px"> <span class="small">I've read this document, I'm authorised to sign it for ${esc(company.name)}, and I agree that typing my name here is my electronic signature.</span></label>
          <button class="btn pri">Sign ${ARROW}</button></form></div>
          <details class="card sec"><summary><b>Decline or ask for changes</b></summary><form class="f" method="post" action="/agreements/${esc(a.id)}/decline" style="margin-top:14px"><div class="fld"><label for="g_r">What needs to change?</label><textarea id="g_r" name="reason" rows="3" required maxlength="1000"></textarea></div><div><button class="btn sm">Send to Meridian Gray</button></div></form></details>`
        : `<div class="card panel"><h3>Awaiting signature</h3><p class="small muted" style="margin:0">${ctx.viewAs ? "Preview: clients sign here." : "Only Owners and Finance people can sign for the company."}</p></div>`
      : `<div class="card panel"><div class="k">Status</div><div style="margin-top:8px">${badge(a)}</div>${a.status === "signed" ? `<p class="small muted" style="margin:12px 0 0">Signed ${esc(fmtWhen(a.signed_at))}. Download the signed copy any time.</p>` : ""}</div>`;
  return page({
    title: a.title,
    active: "agreements",
    crumbs: [[company.name], ["Agreements", "/agreements"], [a.title]],
    body: `${pageHead({ eyebrow: `${company.name} · ${KINDS[a.kind] || "Agreement"}`, title: esc(a.title), right: `<a class="btn" href="/agreements/${esc(a.id)}/print">${a.status === "signed" ? "Download signed copy" : "Download PDF"}</a>` })}
    <div class="split"><div>${agreementDoc(a, sigs)}</div><div>${side}</div></div><style>${DOC_CSS}</style>`,
  });
}

// ---------- admin ----------

function editor(a, companies, action, pre) {
  return `<form class="f" method="post" action="${action}" style="max-width:900px"><div class="card"><div class="grid" style="gap:16px">
    ${a ? `<div class="fld"><label>Client</label><input type="text" value="${esc(a.company_name)}" disabled></div>` : `<div class="fld"><label for="a_client">Client</label><select id="a_client" name="company_id" required><option value="">Select a client</option>${companies.map((c) => `<option value="${esc(c.id)}"${c.id === pre ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>`}
    <div class="frow"><div class="fld"><label for="a_kind">Type</label><select id="a_kind" name="kind" data-skeleton>${Object.entries(KINDS).map(([k, l]) => `<option value="${k}"${(a?.kind || "sow") === k ? " selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="fld"><label for="a_title">Title</label><input id="a_title" name="title" type="text" required maxlength="160" value="${esc(a?.title || "")}" placeholder="Statement of work: CRM and dashboards"></div></div>
    <div class="fld"><label for="a_body">Text</label><textarea id="a_body" name="body" rows="22" required style="font-family:var(--mono);font-size:13.5px;line-height:1.6">${esc(a?.body ?? SKELETON.sow)}</textarea><span class="hint"># Heading · ## Subheading · - bullet · 1. numbered · **bold**. Blank line between paragraphs. Paste from your template and keep editing until it's right; nothing is sent until you press Send.</span></div>
  </div></div><div class="actions"><button class="btn pri">Save draft ${ARROW}</button></div></form>
  <script type="application/json" id="skeletons">${JSON.stringify(SKELETON).replace(/</g, "\\u003c")}</script>`;
}

export async function adminAgreementsRoute(request, env, ctx, mail, path) {
  const url = new URL(request.url);
  const n = nonce();
  const ip = clientIp(request);
  const page = (o) => html(request, appPage({ nonce: n, ctx, flash: flashFrom(url), ...o }), n);
  const companies = async () => (await env.DB.prepare(`SELECT id, name FROM portal_companies WHERE status = 'active' ORDER BY name`).all()).results || [];

  if (path === "/admin/agreements" && request.method === "GET") {
    const list = (await env.DB.prepare(`SELECT a.*, c.name AS company_name FROM portal_agreements a JOIN portal_companies c ON c.id = a.company_id ORDER BY a.updated_at DESC LIMIT 300`).all()).results || [];
    const groups = [["Declined: needs a revision", list.filter((a) => a.status === "declined")], ["Awaiting signature", list.filter((a) => a.status === "sent")], ["Drafts", list.filter((a) => a.status === "draft")], ["Signed", list.filter((a) => a.status === "signed")], ["Withdrawn and replaced", list.filter((a) => a.status === "void" || a.status === "superseded")]];
    return page({
      title: "Agreements",
      active: "agreements",
      crumbs: [["Admin", "/admin"], ["Agreements"]],
      body: `${pageHead({ eyebrow: "Admin · Agreements", title: `Written once, <em>signed on record.</em>`, lead: "Proposals, statements of work, contracts, NDAs and change requests.", right: `<a class="btn pri" href="/admin/agreements/new">New agreement ${ARROW}</a>` })}
      ${list.length ? groups.filter(([, g]) => g.length).map(([t, g]) => `<div class="sec"><div class="card-h"><h2>${t} <span class="cnt">${g.length}</span></h2></div>${listRows(g, "/admin/agreements", { showCompany: true })}</div>`).join("") : `<div class="empty"><b>No agreements yet.</b>Write one, send it, and the client signs it online.</div>`}`,
    });
  }

  if (path === "/admin/agreements/new") {
    const cs = await companies();
    if (request.method === "POST") {
      const f = await readForm(request);
      const c = cs.find((x) => x.id === f.company_id);
      const title = String(f.title || "").trim().slice(0, 160);
      const body = String(f.body || "").slice(0, 60000);
      if (!c || !title || !body.trim()) return redirect(request, "/admin/agreements/new?m=e_agreement");
      const id = newId("agr");
      await env.DB.prepare(`INSERT INTO portal_agreements (id, company_id, kind, title, body, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?, 'draft', ?,?,?)`).bind(id, c.id, KINDS[f.kind] ? f.kind : "other", title, body, ctx.user.id, now(), now()).run();
      await audit(env, ctx, { companyId: c.id, action: "agreement.draft", summary: `Drafted “${title}”`, ip });
      return redirect(request, `/admin/agreements/${id}?m=saved`);
    }
    return page({ title: "New agreement", active: "agreements", crumbs: [["Admin", "/admin"], ["Agreements", "/admin/agreements"], ["New"]], body: `${pageHead({ eyebrow: "Admin · Agreements", title: `New <em>agreement.</em>`, lead: "Pick a type to start from its outline, then write or paste the text." })}${editor(null, cs, "/admin/agreements/new", url.searchParams.get("client") || "")}` });
  }

  const m = path.match(/^\/admin\/agreements\/(agr_[a-z0-9]+)(\/[a-z]+)?$/);
  if (!m) return null;
  const a = await getAgreement(env, m[1]);
  if (!a) return null;
  const sub = m[2] || "";
  const base = `/admin/agreements/${a.id}`;
  const sigs = await signaturesOf(env, a.id);
  if (sub === "/print") return printPage(request, a, sigs);

  if (sub === "" && request.method === "GET") {
    let side = "";
    if (a.status === "draft") side = `<div class="card panel"><h3>Draft</h3><p class="small muted">Only the team can see it. Sending fingerprints the text and emails the client's Owners and Finance people to sign.</p><div class="actions"><form method="post" action="${base}/send" class="inline" data-confirm="Send “${esc(a.title)}” to ${esc(a.company_name)} for signature? The text can't be changed after sending."><button class="btn pri">Send for signature ${ARROW}</button></form><a class="btn" href="${base}/edit">Edit</a></div><form method="post" action="${base}/delete" style="margin-top:14px" data-confirm="Delete this draft?"><button class="linkbtn">Delete draft</button></form></div>`;
    else if (a.status === "sent") side = `<div class="card panel"><h3>Awaiting signature</h3><p class="small muted">Sent ${esc(fmtWhen(a.sent_at))}.</p><div class="actions"><form method="post" action="${base}/remind" class="inline"><button class="btn sm">Send a reminder</button></form><form method="post" action="${base}/revise" class="inline"><button class="btn sm">Revise</button></form><form method="post" action="${base}/void" class="inline" data-confirm="Withdraw this agreement? The client can no longer sign it."><button class="btn sm danger">Withdraw</button></form></div></div>`;
    else if (a.status === "declined") side = `<div class="card panel"><h3 style="color:var(--red)">Declined</h3><p class="small">“${esc(a.decline_reason || "")}”</p><form method="post" action="${base}/revise"><button class="btn pri sm">Revise and resend ${ARROW}</button></form></div>`;
    else side = `<div class="card panel"><div class="k">Status</div><div style="margin-top:8px">${badge(a)}</div>${a.replaced_by ? `<p class="small" style="margin:12px 0 0">Replaced by <a href="/admin/agreements/${esc(a.replaced_by)}">the revised version</a>.</p>` : ""}${a.status === "signed" ? `<form method="post" action="${base}/revise" style="margin-top:14px"><button class="btn sm">Start a change request from this</button></form>` : ""}</div>`;
    return page({
      title: a.title,
      active: "agreements",
      crumbs: [["Admin", "/admin"], ["Agreements", "/admin/agreements"], [a.title]],
      body: `${pageHead({ eyebrow: `${a.company_name} · ${KINDS[a.kind]}`, title: `${esc(a.title)} ${badge(a)}`, right: `<a class="btn" href="${base}/print">PDF / Print</a>` })}<div class="split"><div>${agreementDoc(a, sigs)}</div><div>${side}${a.doc_hash ? `<p class="small muted mono" style="word-break:break-all;margin-top:16px">SHA-256 ${esc(a.doc_hash)}</p>` : ""}</div></div><style>${DOC_CSS}</style>`,
    });
  }

  if (sub === "/edit") {
    if (a.status !== "draft") return redirect(request, base);
    if (request.method === "POST") {
      const f = await readForm(request);
      const title = String(f.title || "").trim().slice(0, 160);
      const body = String(f.body || "").slice(0, 60000);
      if (!title || !body.trim()) return redirect(request, `${base}/edit?m=e_agreement`);
      await env.DB.prepare(`UPDATE portal_agreements SET kind = ?, title = ?, body = ?, updated_at = ? WHERE id = ? AND status = 'draft'`).bind(KINDS[f.kind] ? f.kind : a.kind, title, body, now(), a.id).run();
      return redirect(request, `${base}?m=saved`);
    }
    return page({ title: "Edit draft", active: "agreements", crumbs: [["Admin", "/admin"], ["Agreements", "/admin/agreements"], [a.title, base], ["Edit"]], body: `${pageHead({ eyebrow: `${a.company_name} · Draft`, title: `Edit <em>draft.</em>` })}${editor(a, [], `${base}/edit`)}` });
  }

  if (request.method !== "POST") return null;
  const origin = portalOrigin(request);

  if (sub === "/delete" && a.status === "draft") {
    await env.DB.prepare(`DELETE FROM portal_agreements WHERE id = ? AND status = 'draft'`).bind(a.id).run();
    await audit(env, ctx, { companyId: a.company_id, action: "agreement.delete", summary: `Deleted draft “${a.title}”`, ip });
    return redirect(request, "/admin/agreements?m=deleted");
  }
  if ((sub === "/send" && a.status === "draft") || (sub === "/remind" && a.status === "sent")) {
    if (sub === "/send") {
      const hash = await fingerprint(a);
      await env.DB.prepare(`UPDATE portal_agreements SET status = 'sent', doc_hash = ?, sent_at = ?, sent_by = ?, sender_name = ?, updated_at = ? WHERE id = ? AND status = 'draft'`).bind(hash, now(), ctx.user.id, ctx.user.name || "Meridian Gray", now(), a.id).run();
      if (a.replaces) await env.DB.prepare(`UPDATE portal_agreements SET status = 'superseded', replaced_by = ?, updated_at = ? WHERE id = ? AND status IN ('sent','declined','signed')`).bind(a.id, now(), a.replaces).run();
      await audit(env, ctx, { companyId: a.company_id, action: "agreement.send", summary: `Sent “${a.title}” for signature`, detail: { hash }, ip });
    } else await audit(env, ctx, { companyId: a.company_id, action: "agreement.remind", summary: `Sent a signature reminder for “${a.title}”`, ip });
    await emailCompany(env, mail, a.company_id, {
      roles: MONEY_ROLES,
      subject: `${sub === "/remind" ? "Reminder: " : ""}Please review and sign: ${a.title}`,
      html: p(`${sub === "/remind" ? "A reminder that" : "Meridian Gray has sent"} <b>${esc(a.title)}</b> (${esc(KINDS[a.kind])}) ${sub === "/remind" ? "is waiting for your signature" : "for your review and signature"}.`) + mail.button("Read and sign", `${origin}/agreements/${a.id}`) + muted("Signing takes a minute: read it in the portal, type your name and confirm. If something needs to change, use Decline or ask for changes and tell us what."),
    });
    return redirect(request, `${base}?m=${sub === "/send" ? "agr_sent" : "reminded"}`);
  }
  if (sub === "/void" && a.status === "sent") {
    await env.DB.prepare(`UPDATE portal_agreements SET status = 'void', updated_at = ? WHERE id = ?`).bind(now(), a.id).run();
    await audit(env, ctx, { companyId: a.company_id, action: "agreement.void", summary: `Withdrew “${a.title}”`, ip });
    return redirect(request, `${base}?m=withdrawn`);
  }
  if (sub === "/revise" && ["sent", "declined", "signed"].includes(a.status)) {
    const id = newId("agr");
    const isChange = a.status === "signed";
    await env.DB.prepare(`INSERT INTO portal_agreements (id, company_id, kind, title, body, status, replaces, created_by, created_at, updated_at) VALUES (?,?,?,?,?, 'draft', ?,?,?,?)`)
      .bind(id, a.company_id, isChange ? "change_request" : a.kind, isChange ? `Change request: ${a.title}`.slice(0, 160) : a.title, isChange ? SKELETON.change_request.replace("# What's changing\n", `# What's changing\n\nThis change request amends “${a.title}”, signed ${fmtWhen(a.signed_at)}.\n`) : a.body, isChange ? null : a.id, ctx.user.id, now(), now())
      .run();
    await audit(env, ctx, { companyId: a.company_id, action: "agreement.revise", summary: isChange ? `Started a change request for “${a.title}”` : `Started a revision of “${a.title}”`, ip });
    return redirect(request, `/admin/agreements/${id}/edit`);
  }
  return redirect(request, base);
}
