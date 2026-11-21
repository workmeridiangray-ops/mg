// Client side: Home, Your team, Account, and placeholders for the modules
// that arrive in later phases.

import { now, audit } from "./db.js";
import { esc, fmtDate, appPage, pageHead, roleBadge, roleRadios, ROLE_LABEL, ROLE_HELP, ARROW, initials } from "./ui.js";
import { html, redirect, readForm, clientIp, flashFrom, nonce } from "./http.js";
import { addPerson, invitePerson, changeRole, removePerson, peopleOf } from "./admin.js";
import { openClientActions, pendingMinutes, nextMeeting } from "./meetings.js";
import { threadsForCompany, threadRows } from "./messages.js";
import { fmtWhen, fmtDay, todayIST, relTime } from "./time.js";

const SOON = {
  projects: ["Projects", "Milestones, deliverables and <em>where things stand.</em>", "Each project's phases, what's been delivered and what's next, with a clear timeline."],
  tickets: ["Tickets", "Ask for something, <em>see it move.</em>", "Raise a request or report an issue, and follow it from open to done."],
  files: ["Files", "Everything we've shared, <em>in one place.</em>", "Deliverables, documents and assets, organised by project."],
  agreements: ["Agreements", "Proposals and contracts, <em>signed online.</em>", "Review and sign agreements, and download the signed copies any time."],
  billing: ["Billing", "Invoices, schedules <em>and payments.</em>", "See what's due and when, pay online, and download invoices and receipts."],
};

function greeting() {
  const h = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export async function clientRoute(request, env, ctx, mail, path) {
  const url = new URL(request.url);
  const method = request.method;
  const n = nonce();
  const flash = flashFrom(url);
  const ip = clientIp(request);
  const company = ctx.company;
  const page = (o) => html(request, appPage({ nonce: n, ctx, flash, ...o }), n);
  const isOwner = ctx.role === "owner" && !ctx.viewAs;
  const canMoney = ctx.viewAs || ["owner", "finance"].includes(ctx.role);

  if (path === "/" && method === "GET") {
    const people = await peopleOf(env, company.id);
    const first = (ctx.user.name || "").split(/\s+/)[0];
    const [pend, acts, next, threads] = await Promise.all([
      pendingMinutes(env, company.id),
      openClientActions(env, company.id, 8),
      nextMeeting(env, company.id),
      threadsForCompany(env, ctx, company.id, 4),
    ]);
    const unread = threads.filter((t) => t.unread);
    const today = todayIST();
    const needs = [];
    for (const mi of pend) {
      needs.push(`<div class="row"><span class="bdg blue">Confirm</span><div class="grow"><b><a href="/meetings/${esc(mi.meeting_id)}">Minutes of “${esc(mi.title)}”</a></b><small>Confirm or raise a correction. Confirms automatically on ${esc(fmtWhen(mi.confirm_due_at))}.</small></div><a class="btn sm" href="/meetings/${esc(mi.meeting_id)}">Review</a></div>`);
    }
    for (const t of unread) {
      needs.push(`<div class="row"><span class="bdg blue">Reply</span><div class="grow"><b><a href="${t.meeting_id ? `/meetings/${esc(t.meeting_id)}#discussion` : `/messages/${esc(t.id)}`}">${esc(t.subject)}</a></b><small>New message from Meridian Gray · ${esc(relTime(t.last_message_at))}</small></div></div>`);
    }
    for (const a of acts) {
      const overdue = a.due_date && a.due_date < today;
      needs.push(`<div class="row act">${ctx.viewAs ? '<span class="tick ro" aria-hidden="true"></span>' : `<form method="post" action="/meetings/${esc(a.meeting_id)}/actions/${esc(a.id)}?back=home" class="inline"><button class="tick" title="Mark as done" aria-label="Mark as done"></button></form>`}<div class="grow"><b>${esc(a.text)}</b><small>${a.owner_name ? esc(a.owner_name) + " · " : ""}from <a href="/meetings/${esc(a.meeting_id)}">${esc(a.meeting_title)}</a></small></div>${a.due_date ? `<span class="bdg ${overdue ? "red" : "grey"}">${overdue ? "Overdue · " : "Due "}${esc(fmtDay(a.due_date))}</span>` : ""}</div>`);
    }
    const lastSignIns = people.filter((p) => p.last_login_at).length;
    return page({
      title: "Home",
      active: "home",
      crumbs: [[company.name], ["Home"]],
      body: `${pageHead({
        eyebrow: `${company.name} · Home`,
        title: `${greeting()}${first && !ctx.viewAs ? `, ${esc(first)}` : ""}. <em>Here's where things stand.</em>`,
        lead: "Anything waiting on you shows up first. Everything else about our work together is one click away on the left.",
      })}
      <div class="sec needs" style="margin-top:0"><div class="card-h"><h2>Needs your action${needs.length ? ` <span class="cnt">${needs.length}</span>` : ""}</h2></div>
        ${needs.length ? `<div class="rows">${needs.join("")}</div>` : `<div class="empty"><b>Nothing needs you right now.</b>When there's minutes to confirm, a message for you, an action on your side, or later an agreement to sign or an invoice to pay, it'll appear here first.</div>`}</div>
      <div class="grid g3 sec">
        <div class="card"><div class="k">Next meeting</div>${
          next
            ? `<h3 style="margin-top:10px"><a href="/meetings/${esc(next.id)}" style="text-decoration:none">${esc(next.title)}</a></h3><p class="small muted" style="margin:0 0 14px"><span data-ts="${next.starts_at}">${esc(fmtWhen(next.starts_at))}</span></p><div class="actions">${next.meet_url ? `<a class="btn sm pri" href="${esc(next.meet_url)}" target="_blank" rel="noopener">Join ${ARROW}</a>` : ""}<a class="btn sm" href="/meetings/${esc(next.id)}">Agenda</a></div>`
            : `<h3 style="margin-top:10px">None scheduled</h3><p class="small muted" style="margin:0 0 14px">Ask for a time and we'll confirm it.</p><a class="btn sm" href="/meetings#request">Ask for a meeting</a>`
        }</div>
        <div class="card"><div class="k">Projects</div><h3 style="margin-top:10px">Being set up</h3><p class="small muted" style="margin:0">Your milestones and deliverables will appear here as soon as we add them.</p></div>
        ${
          canMoney
            ? `<div class="card"><div class="k">Billing · ${esc(company.currency)}</div><h3 style="margin-top:10px">Nothing due</h3><p class="small muted" style="margin:0">Invoices and the payment schedule will show here, with online payment.</p></div>`
            : `<div class="card"><div class="k">Your team</div><h3 style="margin-top:10px">${people.length} ${people.length === 1 ? "person" : "people"}</h3><p class="small muted" style="margin:0 0 14px">${lastSignIns} signed in so far.</p><a class="btn sm" href="/team">See your team</a></div>`
        }
      </div>
      <div class="grid g2 sec">
        <div><div class="card-h"><h2>Recent conversations</h2><a class="small" href="/messages">All messages</a></div>${
          threads.length ? threadRows(threads, ctx, "/messages") : `<div class="empty"><b>No conversations yet.</b><a href="/messages#new">Start one</a> any time; we reply here and by email.</div>`
        }</div>
        <div class="card panel"><div class="k">Your Meridian Gray contacts</div>
          <div class="rows" style="margin-top:12px;border-top:0">
            <div class="row"><span class="av blue">MG</span><div class="grow"><b>Meridian Gray team</b><small><a href="mailto:info@meridiangray.in">info@meridiangray.in</a> · <a href="tel:+917972921514">+91 79729 21514</a></small></div></div>
          </div><p class="small muted" style="margin:10px 0 0">You're signed in as ${esc(ROLE_LABEL[ctx.role] || "Member")}${ctx.viewAs ? " (preview)" : ""}: ${esc((ROLE_HELP[ctx.role] || "").toLowerCase())}.</p></div>
      </div>`,
    });
  }

  if (path === "/team") {
    const base = "/team";
    if (method === "POST") return redirect(request, base);
    const people = await peopleOf(env, company.id);
    const list = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th>Last sign-in</th>${isOwner ? "<th></th>" : ""}</tr></thead><tbody>${people
      .map((p) => {
        const me = p.id === ctx.user.id;
        return `<tr><td><b>${esc(p.name || "—")}</b>${me ? ' <span class="bdg blue">You</span>' : ""}<div class="small muted">${esc(p.email)}</div></td>
        <td>${
          isOwner
            ? `<form method="post" action="${base}/${esc(p.id)}/role"><select name="role" data-autosubmit style="width:auto;padding:6px 10px;font-size:13px">${["owner", "finance", "member"]
                .map((r) => `<option value="${r}"${r === p.role ? " selected" : ""}>${ROLE_LABEL[r]}</option>`)
                .join("")}</select><noscript><button class="btn sm">Save</button></noscript></form>`
            : roleBadge(p.role)
        }</td>
        <td class="mono">${p.last_login_at ? esc(fmtDate(p.last_login_at, true)) : '<span class="bdg amber">Not yet</span>'}</td>
        ${
          isOwner
            ? `<td style="text-align:right;white-space:nowrap">${me ? "" : `<form method="post" action="${base}/${esc(p.id)}/invite" class="inline"><button class="btn sm">Resend link</button></form> <form method="post" action="${base}/${esc(p.id)}/remove" class="inline" data-confirm="Remove ${esc(p.email)}? Their access ends immediately."><button class="btn sm danger">Remove</button></form>`}</td>`
            : ""
        }</tr>`;
      })
      .join("")}</tbody></table></div>`;
    return page({
      title: "Your team",
      active: "team",
      crumbs: [[company.name], ["Your team"]],
      body: `${pageHead({
        eyebrow: `${company.name} · Your team`,
        title: `Who can see <em>your portal.</em>`,
        lead: isOwner ? "Add colleagues who should follow the work. Pick a role for each; you can change it any time." : "Only Owners can add or remove people. Ask one of them, or write to us.",
      })}
      ${list}
      <div class="grid g3 sec">${["owner", "finance", "member"].map((r) => `<div class="card panel"><div>${roleBadge(r)}</div><p class="small" style="margin:10px 0 0">${ROLE_HELP[r]}.</p></div>`).join("")}</div>
      ${
        isOwner
          ? `<div class="card sec" style="max-width:760px"><h2>Add a colleague</h2><form class="f" method="post" action="${base}/add">
          <div class="frow"><div class="fld"><label for="t_name">Name</label><input id="t_name" name="name" type="text"></div><div class="fld"><label for="t_email">Email *</label><input id="t_email" name="email" type="email" required></div></div>
          <div class="fld"><label>Role</label>${roleRadios("role", "member")}</div>
          <div><button class="btn pri">Add and send sign-in link</button></div></form></div>`
          : ""
      }`,
    });
  }

  const tm = path.match(/^\/team\/(add|(usr_[a-z0-9]+)\/(role|remove|invite))$/);
  if (tm && method === "POST") {
    if (!isOwner) return redirect(request, "/team");
    const f = await readForm(request);
    if (tm[1] === "add") {
      const r = await addPerson(env, ctx, company.id, f);
      if (r.error) return redirect(request, `/team?m=${r.error}`);
      await audit(env, ctx, { companyId: company.id, action: "member.add", summary: `${ctx.user.email} added ${r.user.email} as ${ROLE_LABEL[f.role] || "Member"}`, ip });
      const ok = await invitePerson(env, mail, request, ctx, company, r.user.email);
      return redirect(request, `/team?m=${ok ? "added" : "e_mail"}`);
    }
    const uid = tm[2];
    const person = await env.DB.prepare(`SELECT u.* FROM portal_users u JOIN portal_memberships m ON m.user_id = u.id WHERE u.id = ? AND m.company_id = ?`)
      .bind(uid, company.id)
      .first();
    if (!person) return redirect(request, "/team");
    if (tm[3] === "role") {
      const r = await changeRole(env, company.id, uid, f.role);
      if (r.error) return redirect(request, `/team?m=${r.error}`);
      if (r.from !== r.to) await audit(env, ctx, { companyId: company.id, action: "member.role", summary: `${ctx.user.email} changed ${person.email} from ${ROLE_LABEL[r.from]} to ${ROLE_LABEL[r.to]}`, ip });
      return redirect(request, "/team?m=role");
    }
    if (tm[3] === "remove") {
      if (uid === ctx.user.id) return redirect(request, "/team?m=e_self");
      const r = await removePerson(env, company.id, uid);
      if (r.error) return redirect(request, `/team?m=${r.error}`);
      await audit(env, ctx, { companyId: company.id, action: "member.remove", summary: `${ctx.user.email} removed ${person.email}`, ip });
      return redirect(request, "/team?m=removed");
    }
    if (tm[3] === "invite") {
      const ok = await invitePerson(env, mail, request, ctx, company, person.email);
      await audit(env, ctx, { companyId: company.id, action: "member.invite", summary: `${ctx.user.email} sent a sign-in link to ${person.email}`, ip });
      return redirect(request, `/team?m=${ok ? "invited" : "e_mail"}`);
    }
  }

  if (path === "/switch" && method === "POST") {
    const f = await readForm(request);
    if (!ctx.viewAs && ctx.companies.some((c) => c.id === f.company_id)) {
      await env.DB.prepare(`UPDATE portal_sessions SET company_id = ? WHERE id_hash = ?`).bind(f.company_id, ctx.sessionHash).run();
    }
    return redirect(request, "/?m=switched");
  }

  const key = path.slice(1);
  if (SOON[key] && method === "GET") {
    if ((key === "billing" || key === "agreements") && !canMoney) return redirect(request, "/");
    const [label, title, lead] = SOON[key];
    return page({
      title: label,
      active: key,
      crumbs: [[company.name], [label]],
      body: `${pageHead({ eyebrow: `${company.name} · ${label}`, title, lead })}<div class="empty"><b>This section opens soon.</b>We're setting it up now. Until then, anything you need is a message away at <a href="mailto:info@meridiangray.in">info@meridiangray.in</a>.</div>`,
    });
  }

  return null;
}

// Account page works for both staff and clients.
export async function accountRoute(request, env, ctx, path) {
  const url = new URL(request.url);
  const n = nonce();
  if (path === "/account" && request.method === "POST") {
    const f = await readForm(request);
    const name = String(f.name || "").trim().slice(0, 120) || null;
    const phone = String(f.phone || "").trim().slice(0, 30) || null;
    const title = String(f.title || "").trim().slice(0, 80) || null;
    await env.DB.prepare(`UPDATE portal_users SET name = ?, phone = ?, title = ? WHERE id = ?`).bind(name, phone, title, ctx.user.id).run();
    await audit(env, ctx, { companyId: ctx.viewAs ? null : ctx.company?.id || null, action: "account.update", summary: `${ctx.user.email} updated their profile`, ip: clientIp(request) });
    return redirect(request, "/account?m=saved");
  }
  if (path === "/account/signout-others" && request.method === "POST") {
    await env.DB.prepare(`DELETE FROM portal_sessions WHERE user_id = ? AND id_hash != ?`).bind(ctx.user.id, ctx.sessionHash).run();
    await audit(env, ctx, { action: "account.signout_others", summary: `${ctx.user.email} signed out of other devices`, ip: clientIp(request) });
    return redirect(request, "/account?m=signedout_all");
  }
  if (path !== "/account" || request.method !== "GET") return null;
  const sessions = (await env.DB.prepare(`SELECT * FROM portal_sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`).bind(ctx.user.id, now()).all()).results || [];
  const u = ctx.user;
  const staffCtx = { ...ctx, viewAs: false };
  return html(
    request,
    appPage({
      nonce: n,
      ctx: u.is_staff ? staffCtx : ctx,
      flash: flashFrom(url),
      title: "Account",
      active: "account",
      crumbs: [["Account"]],
      body: `${pageHead({ eyebrow: "Account", title: `Your <em>details.</em>`, lead: "Your sign-in email can only be changed by us, since it's how the portal knows it's you." })}
      <div class="split">
      <div class="card"><form class="f" method="post" action="/account">
        <div class="fld"><label>Sign-in email</label><input type="email" value="${esc(u.email)}" disabled></div>
        <div class="frow"><div class="fld"><label for="a_name">Name</label><input id="a_name" name="name" type="text" value="${esc(u.name)}" autocomplete="name"></div>
        <div class="fld"><label for="a_title">Job title</label><input id="a_title" name="title" type="text" value="${esc(u.title)}"></div></div>
        <div class="fld"><label for="a_phone">Phone</label><input id="a_phone" name="phone" type="tel" value="${esc(u.phone)}" autocomplete="tel"></div>
        <div><button class="btn pri">Save</button></div></form></div>
      <div class="card panel"><h3>Where you're signed in</h3><div class="rows" style="margin-top:10px">${sessions
        .map(
          (s) => `<div class="row"><div class="grow"><b style="font-size:13.5px">${esc(uaLabel(s.ua))}${s.id_hash === ctx.sessionHash ? ' <span class="bdg blue">This device</span>' : ""}</b><small>Last active ${esc(fmtDate(s.last_seen_at, true))}</small></div></div>`
        )
        .join("")}</div>
        ${sessions.length > 1 ? `<form method="post" action="/account/signout-others" style="margin-top:14px"><button class="btn sm">Sign out everywhere else</button></form>` : ""}</div>
      </div>`,
    }),
    n
  );
}

function uaLabel(ua = "") {
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return `${br} on ${os}`;
}
