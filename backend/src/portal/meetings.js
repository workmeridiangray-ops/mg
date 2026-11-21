// Meetings, minutes of meeting (MoM) and action items.
//
// Lifecycle: requested (by client) → scheduled → minutes drafted → published
// → confirmed by the client (or auto-confirmed 48 hours after publishing if
// nobody objects) or "correction raised" → revised and republished. Every
// publish is kept as a revision. Action items live on after the meeting and
// show on the client's Home until they're done.

import { now, newId, audit } from "./db.js";
import { esc, appPage, pageHead, ARROW, initials } from "./ui.js";
import { html, redirect, readForm, clientIp, flashFrom, nonce } from "./http.js";
import { parseIST, istParts, fmtWhen, fmtDay, todayIST, relTime } from "./time.js";
import { emailCompany, emailTeam, p, muted, quote } from "./notify.js";
import { portalOrigin, adminOrigin } from "./auth.js";
import { createThread, postMessage, loadMessages, markRead, renderConversation, unreadCount } from "./messages.js";

const CONFIRM_WINDOW = 48 * 3600;
const DURATIONS = [15, 30, 45, 60, 90, 120];

// ---------- data ----------

// Minutes published more than 48 hours ago with no reply are confirmed.
export async function settleMinutes(env) {
  const due = (await env.DB.prepare(`SELECT m.meeting_id, m.company_id, mt.title FROM portal_minutes m JOIN portal_meetings mt ON mt.id = m.meeting_id WHERE m.status = 'published' AND m.confirm_due_at < ?`).bind(now()).all()).results || [];
  for (const r of due) {
    const res = await env.DB.prepare(`UPDATE portal_minutes SET status = 'confirmed', confirmed_at = ?, confirmed_auto = 1 WHERE meeting_id = ? AND status = 'published'`).bind(now(), r.meeting_id).run();
    if (res.meta?.changes) await audit(env, null, { companyId: r.company_id, action: "minutes.autoconfirm", summary: `Minutes of “${r.title}” confirmed automatically (no response in 48 hours)` });
  }
}

async function getMeeting(env, id, companyId = null) {
  return env.DB.prepare(
    `SELECT mt.*, c.name AS company_name, c.status AS company_status FROM portal_meetings mt JOIN portal_companies c ON c.id = mt.company_id
      WHERE mt.id = ? AND (? IS NULL OR mt.company_id = ?)`
  )
    .bind(id, companyId, companyId)
    .first();
}

async function getMinutes(env, meetingId) {
  return env.DB.prepare(`SELECT * FROM portal_minutes WHERE meeting_id = ?`).bind(meetingId).first();
}

async function getActions(env, meetingId, { publishedOnly }) {
  return (
    (await env.DB.prepare(`SELECT a.*, u.name AS done_name FROM portal_action_items a LEFT JOIN portal_users u ON u.id = a.done_by WHERE a.meeting_id = ? ${publishedOnly ? "AND a.published = 1" : ""} ORDER BY a.sort, a.created_at`).bind(meetingId).all()).results || []
  );
}

export async function openClientActions(env, companyId, limit = 8) {
  return (
    (
      await env.DB.prepare(
        `SELECT a.*, mt.title AS meeting_title FROM portal_action_items a JOIN portal_meetings mt ON mt.id = a.meeting_id
          WHERE a.company_id = ? AND a.published = 1 AND a.status = 'open' AND a.owner_side = 'client'
          ORDER BY CASE WHEN a.due_date IS NULL THEN 1 ELSE 0 END, a.due_date, a.created_at LIMIT ?`
      )
        .bind(companyId, limit)
        .all()
    ).results || []
  );
}

export async function pendingMinutes(env, companyId) {
  return (
    (await env.DB.prepare(`SELECT m.*, mt.title, mt.starts_at FROM portal_minutes m JOIN portal_meetings mt ON mt.id = m.meeting_id WHERE m.company_id = ? AND m.status = 'published' ORDER BY m.confirm_due_at`).bind(companyId).all()).results || []
  );
}

export async function nextMeeting(env, companyId) {
  return env.DB.prepare(`SELECT * FROM portal_meetings WHERE company_id = ? AND status = 'scheduled' AND starts_at + duration_min * 60 > ? ORDER BY starts_at LIMIT 1`).bind(companyId, now()).first();
}

function isPast(m) {
  return m.starts_at && m.starts_at + m.duration_min * 60 < now();
}

// ---------- Google Calendar (optional: only when the backend's calendar is connected) ----------

async function gcalCreate(cal, { title, start, duration, description }) {
  const token = cal && (await cal.getToken());
  if (!token) return null;
  const body = {
    summary: title,
    description,
    start: { dateTime: new Date(start * 1000).toISOString(), timeZone: "Asia/Kolkata" },
    end: { dateTime: new Date((start + duration * 60) * 1000).toISOString(), timeZone: "Asia/Kolkata" },
    reminders: { useDefault: true },
    conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
  };
  const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.log("portal gcal create failed", r.status, await r.text());
    return null;
  }
  const d = await r.json();
  const video = d.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video");
  return { eventId: d.id, meetUrl: video?.uri || null };
}

async function gcalPatch(cal, eventId, patch) {
  const token = eventId && cal && (await cal.getToken());
  if (!token) return;
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) console.log("portal gcal patch failed", r.status, await r.text());
}

function gcalAddLink(m) {
  const stamp = (ts) => new Date(ts * 1000).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const q = new URLSearchParams({ action: "TEMPLATE", text: `${m.title} · Meridian Gray`, dates: `${stamp(m.starts_at)}/${stamp(m.starts_at + m.duration_min * 60)}`, details: m.meet_url ? `Join: ${m.meet_url}` : "", location: m.meet_url || "" });
  return `https://calendar.google.com/calendar/render?${q}`;
}

function icsFor(m) {
  const stamp = (ts) => new Date(ts * 1000).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const e = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const fold = (l) => (l.length <= 75 ? l : l.match(/.{1,74}/g).join("\r\n "));
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Meridian Gray//Client Portal//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${m.id}@portal.meridiangray.in`, `DTSTAMP:${stamp(now())}`, `DTSTART:${stamp(m.starts_at)}`, `DTEND:${stamp(m.starts_at + m.duration_min * 60)}`,
    `SUMMARY:${e(m.title + " · Meridian Gray")}`, `DESCRIPTION:${e(m.meet_url ? "Join: " + m.meet_url : "")}`, `LOCATION:${e(m.meet_url || "")}`,
    "ORGANIZER;CN=Meridian Gray:mailto:info@meridiangray.in", `STATUS:${m.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT", "END:VCALENDAR",
  ].map(fold).join("\r\n");
}

function whenBlock(m) {
  return `<span data-ts="${m.starts_at}">${esc(fmtWhen(m.starts_at))}</span>`;
}

function statusBadge(m, minutes) {
  if (m.status === "cancelled") return '<span class="bdg grey">Cancelled</span>';
  if (m.status === "requested") return '<span class="bdg amber">Requested</span>';
  if (minutes && minutes.status === "published") return '<span class="bdg blue">Minutes to confirm</span>';
  if (minutes && minutes.status === "correction") return '<span class="bdg red">Correction raised</span>';
  if (minutes && minutes.status === "confirmed") return '<span class="bdg green">Minutes confirmed</span>';
  if (isPast(m)) return '<span class="bdg grey">Held</span>';
  return '<span class="bdg ink">Scheduled</span>';
}

function lines(s) {
  return String(s || "")
    .split(/\r?\n/)
    .map((x) => x.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean);
}

// ---------- shared rendering ----------

function meetingRow(m, base, { showCompany = false } = {}) {
  return `<a class="row thread" href="${base}/${esc(m.id)}"><div class="when-chip"><b>${esc(fmtDay(istParts(m.starts_at || now()).date))}</b><small>${m.starts_at ? esc(istParts(m.starts_at).time) : "—"}</small></div><div class="grow"><b>${esc(m.title)}</b><small>${showCompany ? esc(m.company_name) + " · " : ""}${m.starts_at ? `<span data-ts="${m.starts_at}">${esc(fmtWhen(m.starts_at))}</span>` : "Time to be confirmed"} · ${m.duration_min} min</small></div>${statusBadge(m, m.minutes_status ? { status: m.minutes_status } : null)}</a>`;
}

async function listMeetings(env, companyId) {
  return (
    (
      await env.DB.prepare(
        `SELECT mt.*, c.name AS company_name, mi.status AS minutes_status FROM portal_meetings mt JOIN portal_companies c ON c.id = mt.company_id
           LEFT JOIN portal_minutes mi ON mi.meeting_id = mt.id AND mi.status != 'draft'
          WHERE (? IS NULL OR mt.company_id = ?) ORDER BY mt.starts_at DESC LIMIT 300`
      )
        .bind(companyId, companyId)
        .all()
    ).results || []
  );
}

function minutesView(m, minutes, actions, ctx, base, { admin }) {
  if (!minutes || minutes.status === "draft") {
    if (admin) {
      return `<div class="empty"><b>${minutes ? "Minutes drafted, not published yet." : "No minutes yet."}</b>${isPast(m) ? "Write them while the meeting is fresh; the client gets 48 hours to confirm." : "You can draft minutes any time; publish after the meeting."}<div style="margin-top:14px"><a class="btn pri sm" href="${base}/minutes">${minutes ? "Continue the draft" : "Write the minutes"} ${ARROW}</a></div></div>`;
    }
    return `<div class="empty"><b>Minutes will appear here after the meeting.</b>You'll get an email when they're ready, and 48 hours to confirm them or ask for a correction.</div>`;
  }
  const canAct = !ctx.viewAs;
  const st = minutes.status;
  const banner =
    st === "published"
      ? `<div class="flash" style="margin:0 0 20px">${admin ? `Waiting for the client to confirm. Confirms automatically on <b>${esc(fmtWhen(minutes.confirm_due_at))}</b> if nobody objects.` : `Please read these and confirm they're right, or raise a correction. If we don't hear back, they're confirmed automatically on <b>${esc(fmtWhen(minutes.confirm_due_at))}</b>.`}</div>`
      : st === "correction"
        ? `<div class="flash err" style="margin:0 0 20px"><span><b>Correction raised</b> ${esc(relTime(minutes.correction_at))}: “${esc(minutes.correction_note)}”${admin ? ` <a href="${base}/minutes">Revise and republish</a>` : " We'll revise the minutes and send them again."}</span></div>`
        : `<div class="flash" style="margin:0 0 20px">Confirmed ${minutes.confirmed_auto ? "automatically after 48 hours" : ""} on ${esc(fmtWhen(minutes.confirmed_at))}. This is the agreed record of the meeting.</div>`;

  const sect = (title, items, ordered = false) =>
    items.length ? `<div class="mom-sec"><div class="k">${title}</div><${ordered ? "ol" : "ul"} class="mom-list">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</${ordered ? "ol" : "ul"}></div>` : "";

  const actHtml = actions.length
    ? `<div class="mom-sec"><div class="k">Action items</div><div class="rows">${actions
        .map((a) => {
          const mineSide = admin || a.owner_side === "client";
          const overdue = a.status === "open" && a.due_date && a.due_date < todayIST();
          const toggle =
            canAct && mineSide
              ? `<form method="post" action="${base}/actions/${esc(a.id)}" class="inline"><button class="tick${a.status === "done" ? " on" : ""}" aria-label="${a.status === "done" ? "Mark as not done" : "Mark as done"}" title="${a.status === "done" ? "Mark as not done" : "Mark as done"}"></button></form>`
              : `<span class="tick ro${a.status === "done" ? " on" : ""}" aria-hidden="true"></span>`;
          return `<div class="row act${a.status === "done" ? " done" : ""}">${toggle}<div class="grow"><b>${esc(a.text)}</b><small>${a.owner_side === "mg" ? "Meridian Gray" : esc(m.company_name)}${a.owner_name ? ` · ${esc(a.owner_name)}` : ""}${a.status === "done" ? ` · done ${esc(relTime(a.done_at))}${a.done_name ? " by " + esc(a.done_name) : ""}` : ""}</small></div>${
            a.due_date ? `<span class="bdg ${a.status === "done" ? "grey" : overdue ? "red" : "grey"}">${overdue ? "Overdue · " : "Due "}${esc(fmtDay(a.due_date))}</span>` : ""
          }</div>`;
        })
        .join("")}</div></div>`
    : "";

  const clientButtons =
    !admin && canAct && st === "published"
      ? `<div class="card panel sec"><h3>Are these minutes right?</h3><div class="actions" style="margin-bottom:16px"><form method="post" action="${base}/confirm" class="inline"><button class="btn pri">Confirm the minutes</button></form></div>
         <form class="f" method="post" action="${base}/correction"><div class="fld"><label for="corr">Or raise a correction</label><textarea id="corr" name="note" rows="3" required maxlength="2000" placeholder="What should be changed, and to what?"></textarea></div><div><button class="btn sm">Send correction</button></div></form></div>`
      : "";

  return `${banner}<div class="mom">
    <div class="mom-head"><span class="k">Minutes of meeting · Revision ${minutes.revision}</span><span class="mono muted">Published ${esc(fmtWhen(minutes.published_at))}</span></div>
    ${sect("Attendees", lines(minutes.attendees))}
    ${sect("Discussed", lines(minutes.summary))}
    ${sect("Decisions", lines(minutes.decisions), true)}
    ${actHtml}
    ${admin && st !== "correction" ? `<div style="margin-top:18px"><a class="btn sm" href="${base}/minutes">Amend the minutes</a> <span class="small muted">An amendment goes back to the client to confirm.</span></div>` : ""}
  </div>${clientButtons}`;
}

async function meetingPage(env, ctx, m, { admin, flash, n, request }) {
  const base = admin ? `/admin/meetings/${m.id}` : `/meetings/${m.id}`;
  const minutes = await getMinutes(env, m.id);
  const visibleMinutes = admin || (minutes && minutes.status !== "draft") ? minutes : null;
  const actions = await getActions(env, m.id, { publishedOnly: !admin });
  const agenda = (await env.DB.prepare(`SELECT a.*, u.name, u.email, u.is_staff FROM portal_agenda_items a LEFT JOIN portal_users u ON u.id = a.author_id WHERE a.meeting_id = ? ORDER BY a.created_at`).bind(m.id).all()).results || [];
  const thread = await env.DB.prepare(`SELECT * FROM portal_threads WHERE meeting_id = ?`).bind(m.id).first();
  const msgs = thread ? await loadMessages(env, thread.id) : [];
  if (thread && !ctx.viewAs) {
    await markRead(env, ctx.user.id, thread.id);
    if (ctx.badges) ctx.badges.messages = await unreadCount(env, ctx);
  }
  const past = isPast(m);
  const canEdit = !ctx.viewAs && m.status !== "cancelled";
  const agendaOpen = canEdit && !past;

  const agendaHtml = `${
    agenda.length
      ? `<ol class="agenda">${agenda
          .map(
            (a) => `<li><span>${esc(a.text)}</span><small class="muted">${esc(a.is_staff ? "Meridian Gray" : a.name || a.email || "")}${
              agendaOpen && (a.author_id === ctx.user.id || admin)
                ? ` · <form method="post" action="${base}/agenda/${esc(a.id)}/delete" class="inline"><button class="linkbtn">remove</button></form>`
                : ""
            }</small></li>`
          )
          .join("")}</ol>`
      : `<p class="muted small" style="margin:0 0 12px">No agenda points yet.</p>`
  }${agendaOpen ? `<form class="actions" method="post" action="${base}/agenda" style="margin-top:12px"><input type="text" name="text" required maxlength="300" placeholder="Add a point you want to cover" style="flex:1;min-width:220px"><button class="btn sm">Add</button></form>` : ""}`;

  const join =
    m.status === "scheduled" && !past && m.meet_url
      ? `<a class="btn pri" href="${esc(m.meet_url)}" target="_blank" rel="noopener">Join the call ${ARROW}</a>`
      : "";
  const cal = m.status === "scheduled" && !past && m.starts_at ? `<a class="btn" href="${base}/invite.ics">Add to calendar (.ics)</a><a class="btn" href="${esc(gcalAddLink(m))}" target="_blank" rel="noopener">Google Calendar</a>` : "";

  let adminControls = "";
  if (admin && canEdit) {
    const parts = m.starts_at ? istParts(m.starts_at) : { date: "", time: "" };
    adminControls = `<details class="card panel sec"${m.status === "requested" ? " open" : ""}><summary><b>${m.status === "requested" ? "Confirm this request" : "Reschedule or edit"}</b></summary>
      <form class="f" method="post" action="${base}/schedule" style="margin-top:16px">
        <div class="fld"><label for="s_title">Title</label><input id="s_title" name="title" type="text" value="${esc(m.title)}" required maxlength="160"></div>
        <div class="frow3"><div class="fld"><label for="s_date">Date</label><input id="s_date" name="date" type="date" value="${esc(parts.date)}" required></div>
        <div class="fld"><label for="s_time">Time (IST)</label><input id="s_time" name="time" type="time" value="${esc(parts.time)}" required step="300"></div>
        <div class="fld"><label for="s_dur">Duration</label><select id="s_dur" name="duration">${DURATIONS.map((d) => `<option value="${d}"${d === m.duration_min ? " selected" : ""}>${d} min</option>`).join("")}</select></div></div>
        <div class="fld"><label for="s_url">Meeting link</label><input id="s_url" name="meet_url" type="text" value="${esc(m.meet_url)}" placeholder="https://meet.google.com/…"><span class="hint">Leave empty and tick below to create a Google Meet automatically.</span></div>
        ${m.meet_url ? "" : `<label class="check"><input type="checkbox" name="auto_meet" value="1" checked> Create a Google Meet link and put it on our calendar</label>`}
        <label class="check"><input type="checkbox" name="notify" value="1" checked> Email the client${m.status === "requested" ? " that it's confirmed" : " if the time changes"}</label>
        <div><button class="btn pri">${m.status === "requested" ? "Confirm meeting" : "Save"}</button></div></form></details>
      <details class="card panel sec"><summary><b>Cancel this meeting</b></summary><form class="f" method="post" action="${base}/cancel" style="margin-top:16px" data-confirm="Cancel this meeting and tell the client?"><div class="fld"><label for="c_reason">Reason (shown to the client)</label><input id="c_reason" name="reason" type="text" maxlength="300"></div><div><button class="btn sm danger">Cancel meeting</button></div></form></details>`;
  }

  const body = `${pageHead({
    eyebrow: `${admin ? m.company_name + " · " : ""}Meeting`,
    title: esc(m.title),
    lead: `${m.starts_at ? whenBlock(m) : "Time to be confirmed"} · ${m.duration_min} min ${statusBadge(m, visibleMinutes)}${m.status === "cancelled" && m.cancel_reason ? `<br><span class="small">Cancelled: ${esc(m.cancel_reason)}</span>` : ""}${m.status === "requested" && m.request_note ? `<br><span class="small">Requested topic: ${esc(m.request_note)}</span>` : ""}`,
    right: join + cal,
  })}
  <div class="split">
    <div>
      <div class="card-h"><h2>Minutes</h2></div>
      ${minutesView(m, visibleMinutes, actions, ctx, base, { admin })}
      <div class="sec" id="discussion"><div class="card-h"><h2>Discussion</h2><span class="small muted">About this meeting only</span></div>
        ${renderConversation(msgs, ctx, { action: `${base}/discuss`, canPost: !ctx.viewAs, emptyText: "No messages about this meeting yet.", placeholder: "Ask a question or add context about this meeting…" })}</div>
    </div>
    <div>
      <div class="card"><div class="card-h"><h3>Agenda</h3>${agendaOpen ? '<span class="small muted">Both sides can add</span>' : ""}</div>${agendaHtml}</div>
      ${adminControls}
    </div>
  </div>`;

  return html(
    request,
    appPage({
      nonce: n,
      ctx,
      flash,
      title: m.title,
      active: "meetings",
      crumbs: admin ? [["Admin", "/admin"], ["Meetings", "/admin/meetings"], [m.title]] : [[m.company_name], ["Meetings", "/meetings"], [m.title]],
      body,
    }),
    n
  );
}

// Actions shared by both sides on a meeting page. Returns a Response or null.
async function meetingActions(request, env, ctx, mail, m, sub, { admin }) {
  const base = admin ? `/admin/meetings/${m.id}` : `/meetings/${m.id}`;
  const ip = clientIp(request);
  const method = request.method;

  if (sub === "/invite.ics" && method === "GET") {
    if (!m.starts_at) return redirect(request, base);
    return new Response(icsFor(m), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="meridian-gray-meeting.ics"`, "Cache-Control": "no-store" } });
  }
  if (method !== "POST") return null;
  if (ctx.viewAs) return redirect(request, base);
  const f = await readForm(request);

  if (sub === "/agenda") {
    const text = String(f.text || "").trim().slice(0, 300);
    if (text && m.status !== "cancelled" && !isPast(m)) {
      await env.DB.prepare(`INSERT INTO portal_agenda_items (id, meeting_id, company_id, text, author_id, created_at) VALUES (?,?,?,?,?,?)`).bind(newId("ag"), m.id, m.company_id, text, ctx.user.id, now()).run();
      await audit(env, ctx, { companyId: m.company_id, action: "meeting.agenda", summary: `${ctx.user.email} added an agenda point to “${m.title}”`, ip });
    }
    return redirect(request, base);
  }
  const ad = sub.match(/^\/agenda\/(ag_[a-z0-9]+)\/delete$/);
  if (ad) {
    await env.DB.prepare(`DELETE FROM portal_agenda_items WHERE id = ? AND meeting_id = ? ${admin ? "" : "AND author_id = ?"}`).bind(...(admin ? [ad[1], m.id] : [ad[1], m.id, ctx.user.id])).run();
    return redirect(request, base);
  }
  const ac = sub.match(/^\/actions\/(ai_[a-z0-9]+)$/);
  if (ac) {
    const a = await env.DB.prepare(`SELECT * FROM portal_action_items WHERE id = ? AND meeting_id = ? AND published = 1`).bind(ac[1], m.id).first();
    if (a && (admin || a.owner_side === "client")) {
      const done = a.status !== "done";
      await env.DB.prepare(`UPDATE portal_action_items SET status = ?, done_at = ?, done_by = ? WHERE id = ?`).bind(done ? "done" : "open", done ? now() : null, done ? ctx.user.id : null, a.id).run();
      await audit(env, ctx, { companyId: m.company_id, action: "action.toggle", summary: `${ctx.user.email} marked “${a.text.slice(0, 80)}” as ${done ? "done" : "not done"}`, ip });
    }
    const back = new URL(request.url).searchParams.get("back");
    return redirect(request, back === "home" ? "/" : base);
  }
  if (sub === "/discuss") {
    let thread = await env.DB.prepare(`SELECT * FROM portal_threads WHERE meeting_id = ?`).bind(m.id).first();
    if (!String(f.body || "").trim()) return redirect(request, `${base}#discussion`);
    if (!thread) {
      const id = await createThread(env, ctx, m.company_id, { subject: `Meeting: ${m.title}`, meetingId: m.id });
      thread = await env.DB.prepare(`SELECT * FROM portal_threads WHERE id = ?`).bind(id).first();
    }
    await postMessage(env, mail, request, ctx, thread, f.body, { linkPathClient: `/meetings/${m.id}#discussion`, linkPathAdmin: `/admin/meetings/${m.id}#discussion` });
    return redirect(request, `${base}?m=sent#discussion`);
  }

  // Client-only
  if (!admin && (sub === "/confirm" || sub === "/correction")) {
    const minutes = await getMinutes(env, m.id);
    if (!minutes || minutes.status !== "published") return redirect(request, base);
    const origin = portalOrigin(request);
    if (sub === "/confirm") {
      await env.DB.prepare(`UPDATE portal_minutes SET status = 'confirmed', confirmed_at = ?, confirmed_by = ?, confirmed_auto = 0 WHERE meeting_id = ? AND status = 'published'`).bind(now(), ctx.user.id, m.id).run();
      await audit(env, ctx, { companyId: m.company_id, action: "minutes.confirm", summary: `${ctx.user.email} confirmed the minutes of “${m.title}” (revision ${minutes.revision})`, ip });
      await emailTeam(env, mail, { subject: `[${m.company_name}] Minutes confirmed: ${m.title}`, html: p(`<b>${esc(ctx.user.name || ctx.user.email)}</b> confirmed the minutes of <b>${esc(m.title)}</b>.`) + mail.button("Open the meeting", `${adminOrigin(request)}/admin/meetings/${m.id}`) });
      return redirect(request, `${base}?m=confirmed`);
    }
    const note = String(f.note || "").trim().slice(0, 2000);
    if (!note) return redirect(request, base);
    await env.DB.prepare(`UPDATE portal_minutes SET status = 'correction', correction_note = ?, correction_by = ?, correction_at = ? WHERE meeting_id = ?`).bind(note, ctx.user.id, now(), m.id).run();
    await audit(env, ctx, { companyId: m.company_id, action: "minutes.correction", summary: `${ctx.user.email} raised a correction on the minutes of “${m.title}”`, detail: { note }, ip });
    await emailTeam(env, mail, { subject: `[${m.company_name}] Correction raised on minutes: ${m.title}`, replyTo: ctx.user.email, html: p(`<b>${esc(ctx.user.name || ctx.user.email)}</b> asked for a correction to the minutes of <b>${esc(m.title)}</b>:`) + quote(note) + mail.button("Revise the minutes", `${adminOrigin(request)}/admin/meetings/${m.id}/minutes`) });
    return redirect(request, `${base}?m=correction`);
  }
  return null;
}

// ---------- client routes ----------

export async function clientMeetingsRoute(request, env, ctx, mail, path) {
  const url = new URL(request.url);
  const n = nonce();
  const company = ctx.company;
  const flash = flashFrom(url);

  if (path === "/meetings") {
    if (request.method === "POST") {
      if (ctx.viewAs) return redirect(request, "/meetings");
      const f = await readForm(request);
      const start = parseIST(f.date, f.time);
      const topic = String(f.topic || "").trim().slice(0, 1000);
      if (!start || start < now() || !topic) return redirect(request, "/meetings?m=e_meeting");
      const id = newId("mt");
      const ts = now();
      const title = topic.split(/\n/)[0].slice(0, 90);
      await env.DB.prepare(`INSERT INTO portal_meetings (id, company_id, title, starts_at, duration_min, status, request_note, requested_by, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, company.id, title, start, DURATIONS.includes(+f.duration) ? +f.duration : 30, "requested", topic, ctx.user.id, ctx.user.id, ts, ts)
        .run();
      await audit(env, ctx, { companyId: company.id, action: "meeting.request", summary: `${ctx.user.email} requested a meeting: ${title}`, ip: clientIp(request) });
      await emailTeam(env, mail, {
        subject: `[${company.name}] Meeting requested: ${title}`,
        replyTo: ctx.user.email,
        html: p(`<b>${esc(ctx.user.name || ctx.user.email)}</b> (${esc(company.name)}) asked for a meeting on <b>${esc(fmtWhen(start))}</b>.`) + quote(topic) + mail.button("Confirm or suggest another time", `${adminOrigin(request)}/admin/meetings/${id}`),
      });
      return redirect(request, `/meetings/${id}?m=requested`);
    }
    const all = await listMeetings(env, company.id);
    const t = now();
    const confirm = all.filter((m) => m.minutes_status === "published");
    const upcoming = all.filter((m) => m.status === "scheduled" && !isPast(m)).reverse();
    const requested = all.filter((m) => m.status === "requested");
    const past = all.filter((m) => (m.status === "scheduled" && isPast(m)) || m.status === "done" || m.status === "cancelled");
    const block = (title, list, empty) => `<div class="sec"><div class="card-h"><h2>${title}</h2></div>${list.length ? `<div class="rows">${list.map((m) => meetingRow(m, "/meetings")).join("")}</div>` : `<div class="empty">${empty}</div>`}</div>`;
    const minDate = todayIST();
    const times = [];
    for (let h = 9; h <= 19; h++) for (const mm of ["00", "30"]) times.push(`${String(h).padStart(2, "0")}:${mm}`);
    return html(
      request,
      appPage({
        nonce: n,
        ctx,
        flash,
        title: "Meetings",
        active: "meetings",
        crumbs: [[company.name], ["Meetings"]],
        body: `${pageHead({ eyebrow: `${company.name} · Meetings`, title: `Every meeting, <em>and what we agreed.</em>`, lead: "Agendas before, minutes after, and the action items both sides took away. Times are in IST, with your local time alongside." })}
        ${confirm.length ? block("Minutes to confirm", confirm, "") : ""}
        ${block("Upcoming", upcoming, "<b>Nothing scheduled.</b>Ask for a meeting below and we'll confirm a time.")}
        ${requested.length ? block("Waiting for us to confirm", requested, "") : ""}
        ${block("Past meetings", past, "Meetings we've held will be listed here with their minutes.")}
        ${
          ctx.viewAs
            ? ""
            : `<div class="card panel sec" id="request" style="max-width:760px"><h2>Ask for a meeting</h2><p class="small muted" style="margin:-6px 0 16px">Suggest a time and tell us what it's about. We'll confirm it, or suggest another time, and send a calendar invite with the link.</p>
          <form class="f" method="post" action="/meetings"><div class="frow3"><div class="fld"><label for="r_date">Preferred date</label><input id="r_date" type="date" name="date" min="${minDate}" required></div>
          <div class="fld"><label for="r_time">Time (IST)</label><select id="r_time" name="time">${times.map((x) => `<option${x === "11:00" ? " selected" : ""}>${x}</option>`).join("")}</select></div>
          <div class="fld"><label for="r_dur">Length</label><select id="r_dur" name="duration"><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option></select></div></div>
          <div class="fld"><label for="r_topic">What would you like to discuss?</label><textarea id="r_topic" name="topic" rows="3" required maxlength="1000" placeholder="Review of the first dashboard draft"></textarea></div>
          <div><button class="btn pri">Send request</button></div></form></div>`
        }`,
      }),
      n
    );
  }

  const mm = path.match(/^\/meetings\/(mt_[a-z0-9]+)(\/.*)?$/);
  if (mm) {
    const m = await getMeeting(env, mm[1], company.id);
    if (!m) return null;
    if (mm[2]) return meetingActions(request, env, ctx, mail, m, mm[2], { admin: false });
    if (request.method !== "GET") return null;
    return meetingPage(env, ctx, m, { admin: false, flash, n, request });
  }
  return null;
}

// ---------- admin routes ----------

function minutesEditor(m, minutes, actions, people, staffName) {
  const attendeesDefault = minutes?.attendees ?? [staffName ? `${staffName} (Meridian Gray)` : "Meridian Gray team", ...people.map((x) => x.name || x.email)].join("\n");
  const row = (a, i) => `<div class="ai-row">
    <input type="hidden" name="ai_id_${i}" value="${esc(a?.id || "")}">
    <input type="text" name="ai_text_${i}" value="${esc(a?.text || "")}" placeholder="What needs to happen" aria-label="Action item ${i + 1}">
    <select name="ai_side_${i}" aria-label="Whose action"><option value="client"${a?.owner_side !== "mg" ? " selected" : ""}>${esc(m.company_name)}</option><option value="mg"${a?.owner_side === "mg" ? " selected" : ""}>Meridian Gray</option></select>
    <input type="text" name="ai_owner_${i}" value="${esc(a?.owner_name || "")}" placeholder="Person" aria-label="Person responsible">
    <input type="date" name="ai_due_${i}" value="${esc(a?.due_date || "")}" aria-label="Due date">
  </div>`;
  const rows = [...actions, null, null, null];
  return `<form class="f" method="post" action="/admin/meetings/${esc(m.id)}/minutes" style="max-width:980px">
    <div class="card"><div class="fld"><label for="mi_att">Attendees</label><textarea id="mi_att" name="attendees" rows="4">${esc(attendeesDefault)}</textarea><span class="hint">One per line.</span></div></div>
    <div class="card"><div class="fld"><label for="mi_sum">Key points discussed</label><textarea id="mi_sum" name="summary" rows="7" placeholder="One point per line">${esc(minutes?.summary || "")}</textarea></div></div>
    <div class="card"><div class="fld"><label for="mi_dec">Decisions made</label><textarea id="mi_dec" name="decisions" rows="5" placeholder="One decision per line">${esc(minutes?.decisions || "")}</textarea><span class="hint">These are what the client confirms, so word them plainly.</span></div></div>
    <div class="card"><div class="card-h"><h3>Action items</h3><span class="small muted">Leave text empty to remove a row</span></div>
      <div class="ai-head"><span>Action</span><span>Whose</span><span>Person</span><span>Due</span></div>
      <div id="ai-rows">${rows.map(row).join("")}</div>
      <input type="hidden" name="ai_count" value="${rows.length}" id="ai-count">
      <button type="button" class="btn sm" data-add-row style="margin-top:10px">Add another row</button>
      <template id="ai-tpl">${row(null, "__I__")}</template></div>
    <div class="actions"><button class="btn" name="do" value="draft">Save draft</button><button class="btn pri" name="do" value="publish">${minutes && minutes.revision > 0 ? `Publish revision ${minutes.revision + 1}` : "Publish to client"} ${ARROW}</button>
    <span class="small muted">Publishing emails everyone at ${esc(m.company_name)}. They have 48 hours to confirm or raise a correction.</span></div>
  </form>`;
}

export async function adminMeetingsRoute(request, env, ctx, mail, path, cal) {
  const url = new URL(request.url);
  const n = nonce();
  const flash = flashFrom(url);
  const ip = clientIp(request);
  const page = (o) => html(request, appPage({ nonce: n, ctx, flash, ...o }), n);

  if (path === "/admin/meetings" && request.method === "GET") {
    const all = await listMeetings(env, null);
    const t = now();
    const requests = all.filter((m) => m.status === "requested");
    const upcoming = all.filter((m) => m.status === "scheduled" && !isPast(m)).reverse();
    const needMinutes = all.filter((m) => m.status === "scheduled" && isPast(m) && !m.minutes_status);
    const corrections = all.filter((m) => m.minutes_status === "correction");
    const waiting = all.filter((m) => m.minutes_status === "published");
    const recent = all.filter((m) => m.minutes_status === "confirmed" || m.status === "cancelled").slice(0, 15);
    const block = (title, list, empty, hint = "") =>
      `<div class="sec"><div class="card-h"><h2>${title}${list.length ? ` <span class="cnt">${list.length}</span>` : ""}</h2>${hint ? `<span class="small muted">${hint}</span>` : ""}</div>${list.length ? `<div class="rows">${list.map((m) => meetingRow(m, "/admin/meetings", { showCompany: true })).join("")}</div>` : `<div class="empty">${empty}</div>`}</div>`;
    return page({
      title: "Meetings",
      active: "meetings",
      crumbs: [["Admin", "/admin"], ["Meetings"]],
      body: `${pageHead({ eyebrow: "Admin · Meetings", title: `Meetings and minutes, <em>nothing dropped.</em>`, lead: "Requests to confirm, minutes to write, and corrections to answer come first.", right: `<a class="btn pri" href="/admin/meetings/new">Schedule a meeting ${ARROW}</a>` })}
      ${requests.length ? block("Requested by clients", requests, "") : ""}
      ${corrections.length ? block("Corrections raised", corrections, "", "Revise and republish") : ""}
      ${block("Minutes to write", needMinutes, "All caught up.", "Meetings that happened without published minutes")}
      ${block("Upcoming", upcoming, "Nothing scheduled.")}
      ${waiting.length ? block("Waiting for client confirmation", waiting, "", "Auto-confirm after 48 hours") : ""}
      ${block("Recently closed", recent, "Nothing yet.")}`,
    });
  }

  if (path === "/admin/meetings/new") {
    const companies = (await env.DB.prepare(`SELECT id, name FROM portal_companies WHERE status = 'active' ORDER BY name`).all()).results || [];
    if (request.method === "POST") {
      const f = await readForm(request);
      const company = companies.find((c) => c.id === f.company_id);
      const start = parseIST(f.date, f.time);
      const title = String(f.title || "").trim().slice(0, 160);
      if (!company || !start || !title) return redirect(request, `/admin/meetings/new?m=e_meeting`);
      const duration = DURATIONS.includes(+f.duration) ? +f.duration : 45;
      let meetUrl = cleanUrl(f.meet_url);
      let eventId = null;
      if (!meetUrl && f.auto_meet && start > now()) {
        const ev = await gcalCreate(cal, { title: `${title} · ${company.name}`, start, duration, description: `Meridian Gray admin: ${adminOrigin(request)}/admin/meetings` });
        if (ev) ({ meetUrl, eventId } = ev);
      }
      const id = newId("mt");
      const ts = now();
      await env.DB.prepare(`INSERT INTO portal_meetings (id, company_id, title, starts_at, duration_min, meet_url, gcal_event_id, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, company.id, title, start, duration, meetUrl, eventId, "scheduled", ctx.user.id, ts, ts)
        .run();
      for (const line of lines(f.agenda).slice(0, 30)) {
        await env.DB.prepare(`INSERT INTO portal_agenda_items (id, meeting_id, company_id, text, author_id, created_at) VALUES (?,?,?,?,?,?)`).bind(newId("ag"), id, company.id, line.slice(0, 300), ctx.user.id, ts).run();
      }
      await audit(env, ctx, { companyId: company.id, action: "meeting.schedule", summary: `Scheduled “${title}” for ${fmtWhen(start)}`, ip });
      const m = await getMeeting(env, id);
      // A meeting logged after the fact (to write its minutes) doesn't need an invite.
      const future = start > now();
      if (f.notify && future) await notifyScheduled(env, mail, request, m, "scheduled");
      return redirect(request, `/admin/meetings/${id}?m=${!meetUrl && f.auto_meet && future ? "nomeet" : future ? "scheduled" : "logged"}`);
    }
    const pre = url.searchParams.get("client") || "";
    const times = [];
    for (let h = 8; h <= 21; h++) for (const mm of ["00", "15", "30", "45"]) times.push(`${String(h).padStart(2, "0")}:${mm}`);
    return page({
      title: "Schedule a meeting",
      active: "meetings",
      crumbs: [["Admin", "/admin"], ["Meetings", "/admin/meetings"], ["Schedule"]],
      body: `${pageHead({ eyebrow: "Admin · Meetings", title: `Schedule a <em>meeting.</em>`, lead: "The client gets an email with the time, the link and a calendar file, and can add agenda points before the call." })}
      <form class="f card" method="post" action="/admin/meetings/new" style="max-width:820px">
        <div class="fld"><label for="n_client">Client</label><select id="n_client" name="company_id" required><option value="">Select a client</option>${companies.map((c) => `<option value="${esc(c.id)}"${c.id === pre ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
        <div class="fld"><label for="n_title">Title</label><input id="n_title" name="title" type="text" required maxlength="160" placeholder="Weekly check-in"></div>
        <div class="frow3"><div class="fld"><label for="n_date">Date</label><input id="n_date" name="date" type="date" min="${todayIST()}" required></div>
        <div class="fld"><label for="n_time">Time (IST)</label><select id="n_time" name="time">${times.map((x) => `<option${x === "11:00" ? " selected" : ""}>${x}</option>`).join("")}</select></div>
        <div class="fld"><label for="n_dur">Duration</label><select id="n_dur" name="duration">${DURATIONS.map((d) => `<option value="${d}"${d === 45 ? " selected" : ""}>${d} min</option>`).join("")}</select></div></div>
        <div class="fld"><label for="n_url">Meeting link (optional)</label><input id="n_url" name="meet_url" type="text" placeholder="https://meet.google.com/… or Zoom link"></div>
        <label class="check"><input type="checkbox" name="auto_meet" value="1" checked> No link above? Create a Google Meet and put it on our calendar</label>
        <div class="fld"><label for="n_agenda">Agenda (optional)</label><textarea id="n_agenda" name="agenda" rows="4" placeholder="One point per line"></textarea></div>
        <label class="check"><input type="checkbox" name="notify" value="1" checked> Email everyone at the client</label>
        <div><button class="btn pri">Schedule ${ARROW}</button></div></form>`,
    });
  }

  const mm = path.match(/^\/admin\/meetings\/(mt_[a-z0-9]+)(\/.*)?$/);
  if (!mm) return null;
  const m = await getMeeting(env, mm[1]);
  if (!m) return null;
  const base = `/admin/meetings/${m.id}`;
  const sub = mm[2] || "";

  if (sub === "" && request.method === "GET") return meetingPage(env, ctx, m, { admin: true, flash, n, request });

  if (sub === "/schedule" && request.method === "POST") {
    const f = await readForm(request);
    const start = parseIST(f.date, f.time);
    const title = String(f.title || "").trim().slice(0, 160);
    if (!start || !title || m.status === "cancelled") return redirect(request, `${base}?m=e_meeting`);
    const duration = DURATIONS.includes(+f.duration) ? +f.duration : m.duration_min;
    let meetUrl = cleanUrl(f.meet_url);
    let eventId = m.gcal_event_id;
    const wasRequest = m.status === "requested";
    const moved = start !== m.starts_at || duration !== m.duration_min;
    if (!meetUrl && f.auto_meet) {
      const ev = await gcalCreate(cal, { title: `${title} · ${m.company_name}`, start, duration, description: `Meridian Gray admin: ${adminOrigin(request)}${base}` });
      if (ev) ({ meetUrl, eventId } = ev);
    } else if (eventId && moved) {
      await gcalPatch(cal, eventId, { start: { dateTime: new Date(start * 1000).toISOString() }, end: { dateTime: new Date((start + duration * 60) * 1000).toISOString() }, summary: `${title} · ${m.company_name}` });
    }
    await env.DB.prepare(`UPDATE portal_meetings SET title = ?, starts_at = ?, duration_min = ?, meet_url = ?, gcal_event_id = ?, status = 'scheduled', updated_at = ? WHERE id = ?`)
      .bind(title, start, duration, meetUrl, eventId, now(), m.id)
      .run();
    await audit(env, ctx, { companyId: m.company_id, action: wasRequest ? "meeting.confirm" : "meeting.update", summary: wasRequest ? `Confirmed “${title}” for ${fmtWhen(start)}` : moved ? `Moved “${title}” to ${fmtWhen(start)}` : `Updated “${title}”`, ip });
    if (f.notify && (wasRequest || moved)) await notifyScheduled(env, mail, request, await getMeeting(env, m.id), wasRequest ? "confirmed" : "moved");
    return redirect(request, `${base}?m=${wasRequest ? "scheduled" : "saved"}`);
  }

  if (sub === "/cancel" && request.method === "POST") {
    const f = await readForm(request);
    const reason = String(f.reason || "").trim().slice(0, 300) || null;
    await env.DB.prepare(`UPDATE portal_meetings SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?`).bind(reason, now(), m.id).run();
    if (m.gcal_event_id) await gcalPatch(cal, m.gcal_event_id, { status: "cancelled" });
    await audit(env, ctx, { companyId: m.company_id, action: "meeting.cancel", summary: `Cancelled “${m.title}”${reason ? `: ${reason}` : ""}`, ip });
    await emailCompany(env, mail, m.company_id, {
      subject: `Cancelled: ${m.title}`,
      html: p(`The meeting <b>${esc(m.title)}</b>${m.starts_at ? ` on <b>${esc(fmtWhen(m.starts_at))}</b>` : ""} has been cancelled.`) + (reason ? quote(reason) : "") + mail.button("Open your portal", `${portalOrigin(request)}/meetings`),
    });
    return redirect(request, `${base}?m=cancelled`);
  }

  if (sub === "/minutes") {
    const minutes = await getMinutes(env, m.id);
    const actions = await getActions(env, m.id, { publishedOnly: false });
    if (request.method === "POST") {
      const f = await readForm(request);
      const ts = now();
      const attendees = String(f.attendees || "").slice(0, 3000);
      const summary = String(f.summary || "").slice(0, 8000);
      const decisions = String(f.decisions || "").slice(0, 5000);
      const publish = f.do === "publish";
      if (!minutes) {
        await env.DB.prepare(`INSERT INTO portal_minutes (meeting_id, company_id, attendees, summary, decisions, status, updated_at) VALUES (?,?,?,?,?, 'draft', ?)`).bind(m.id, m.company_id, attendees, summary, decisions, ts).run();
      } else {
        await env.DB.prepare(`UPDATE portal_minutes SET attendees = ?, summary = ?, decisions = ?, updated_at = ? WHERE meeting_id = ?`).bind(attendees, summary, decisions, ts, m.id).run();
      }
      // Action items: update kept rows, add new ones, drop rows emptied out.
      const count = Math.min(parseInt(f.ai_count || "0", 10) || 0, 60);
      const keep = new Set();
      let sort = 0;
      for (let i = 0; i < count; i++) {
        const text = String(f[`ai_text_${i}`] || "").trim().slice(0, 400);
        const id = String(f[`ai_id_${i}`] || "");
        const existing = actions.find((a) => a.id === id);
        if (!text) continue;
        const side = f[`ai_side_${i}`] === "mg" ? "mg" : "client";
        const owner = String(f[`ai_owner_${i}`] || "").trim().slice(0, 80) || null;
        const due = /^\d{4}-\d{2}-\d{2}$/.test(f[`ai_due_${i}`] || "") ? f[`ai_due_${i}`] : null;
        sort++;
        if (existing) {
          keep.add(existing.id);
          await env.DB.prepare(`UPDATE portal_action_items SET text = ?, owner_side = ?, owner_name = ?, due_date = ?, sort = ? WHERE id = ?`).bind(text, side, owner, due, sort, existing.id).run();
        } else {
          const nid = newId("ai");
          keep.add(nid);
          await env.DB.prepare(`INSERT INTO portal_action_items (id, company_id, meeting_id, text, owner_side, owner_name, due_date, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(nid, m.company_id, m.id, text, side, owner, due, sort, ts).run();
        }
      }
      for (const a of actions) if (!keep.has(a.id)) await env.DB.prepare(`DELETE FROM portal_action_items WHERE id = ?`).bind(a.id).run();

      if (!publish) {
        await audit(env, ctx, { companyId: m.company_id, action: "minutes.draft", summary: `Saved draft minutes for “${m.title}”`, ip });
        return redirect(request, `${base}/minutes?m=saved`);
      }
      if (!lines(summary).length && !lines(decisions).length) return redirect(request, `${base}/minutes?m=e_minutes`);
      const rev = (minutes?.revision || 0) + 1;
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE portal_minutes SET status = 'published', revision = ?, published_at = ?, published_by = ?, confirm_due_at = ?, confirmed_at = NULL, confirmed_by = NULL, confirmed_auto = 0, correction_note = NULL, correction_by = NULL, correction_at = NULL WHERE meeting_id = ?`
        ).bind(rev, ts, ctx.user.id, ts + CONFIRM_WINDOW, m.id),
        env.DB.prepare(`UPDATE portal_action_items SET published = 1 WHERE meeting_id = ?`).bind(m.id),
        env.DB.prepare(`UPDATE portal_meetings SET status = CASE WHEN status = 'requested' THEN 'scheduled' ELSE status END, updated_at = ? WHERE id = ?`).bind(ts, m.id),
      ]);
      const finalActions = await getActions(env, m.id, { publishedOnly: true });
      await env.DB.prepare(`INSERT INTO portal_minutes_revisions (meeting_id, revision, snapshot, published_at, published_by) VALUES (?,?,?,?,?)`)
        .bind(m.id, rev, JSON.stringify({ attendees, summary, decisions, actions: finalActions.map((a) => ({ text: a.text, side: a.owner_side, owner: a.owner_name, due: a.due_date })) }), ts, ctx.user.id)
        .run();
      await audit(env, ctx, { companyId: m.company_id, action: "minutes.publish", summary: `Published minutes of “${m.title}” (revision ${rev})`, ip });
      const clientActs = finalActions.filter((a) => a.owner_side === "client");
      await emailCompany(env, mail, m.company_id, {
        subject: rev > 1 ? `Revised minutes to confirm: ${m.title}` : `Minutes to confirm: ${m.title}`,
        html:
          p(`${rev > 1 ? "We've revised the" : "Here are the"} minutes of <b>${esc(m.title)}</b>${m.starts_at ? ` (${esc(fmtWhen(m.starts_at))})` : ""}.`) +
          (lines(decisions).length ? `<p style="margin:0 0 8px;font-weight:700;">Decisions</p><ol style="margin:0 0 16px;padding-left:20px;">${lines(decisions).map((d) => `<li style="margin-bottom:4px;">${esc(d)}</li>`).join("")}</ol>` : "") +
          (clientActs.length ? `<p style="margin:0 0 8px;font-weight:700;">Actions on your side</p><ul style="margin:0 0 16px;padding-left:20px;">${clientActs.map((a) => `<li style="margin-bottom:4px;">${esc(a.text)}${a.due_date ? ` (by ${esc(fmtDay(a.due_date))})` : ""}</li>`).join("")}</ul>` : "") +
          mail.button("Read and confirm", `${portalOrigin(request)}/meetings/${m.id}`) +
          muted(`If nothing needs changing, confirm in the portal. If we don't hear back within 48 hours, the minutes are treated as confirmed.`),
      });
      return redirect(request, `${base}?m=published`);
    }
    const people = (await env.DB.prepare(`SELECT u.name, u.email FROM portal_memberships mb JOIN portal_users u ON u.id = mb.user_id WHERE mb.company_id = ?`).bind(m.company_id).all()).results || [];
    const revs = (await env.DB.prepare(`SELECT revision, published_at FROM portal_minutes_revisions WHERE meeting_id = ? ORDER BY revision DESC`).bind(m.id).all()).results || [];
    return page({
      title: `Minutes · ${m.title}`,
      active: "meetings",
      crumbs: [["Admin", "/admin"], ["Meetings", "/admin/meetings"], [m.title, base], ["Minutes"]],
      body: `${pageHead({ eyebrow: `${m.company_name} · Minutes of meeting`, title: `${esc(m.title)} <em>minutes.</em>`, lead: `${m.starts_at ? whenBlock(m) : ""}${minutes?.status === "correction" ? `<br><b style="color:var(--red)">Correction asked for:</b> ${esc(minutes.correction_note)}` : ""}` })}
      ${minutesEditor(m, minutes, actions, people, ctx.user.name || "")}
      ${revs.length ? `<div class="sec"><div class="k" style="margin-bottom:8px">Published revisions</div>${revs.map((r) => `<div class="small">Revision ${r.revision} · ${esc(fmtWhen(r.published_at))}</div>`).join("")}</div>` : ""}`,
    });
  }

  return meetingActions(request, env, ctx, mail, m, sub, { admin: true });
}

function cleanUrl(u) {
  u = String(u || "").trim();
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === "https:" ? x.toString() : null;
  } catch {
    return null;
  }
}

async function notifyScheduled(env, mail, request, m, kind) {
  const origin = portalOrigin(request);
  const head = { scheduled: "We've scheduled a meeting", confirmed: "Your meeting is confirmed", moved: "Your meeting has moved" }[kind];
  await emailCompany(env, mail, m.company_id, {
    subject: `${kind === "moved" ? "Moved" : kind === "confirmed" ? "Confirmed" : "Meeting"}: ${m.title} · ${fmtWhen(m.starts_at, { short: true })}`,
    html:
      p(`${head}: <b>${esc(m.title)}</b>`) +
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;font-size:14px;"><tr><td style="padding:4px 16px 4px 0;color:#5B606B;">When</td><td style="padding:4px 0;"><b>${esc(fmtWhen(m.starts_at))}</b> · ${m.duration_min} min</td></tr>${
        m.meet_url ? `<tr><td style="padding:4px 16px 4px 0;color:#5B606B;">Link</td><td style="padding:4px 0;"><a href="${esc(m.meet_url)}" style="color:#244BDB;">${esc(m.meet_url)}</a></td></tr>` : ""
      }</table>` +
      mail.button("Open in the portal", `${origin}/meetings/${m.id}`) +
      mail.button("Add to Google Calendar", gcalAddLink(m), { variant: "outline" }) +
      muted("You can add points to the agenda in the portal before the call. Minutes and action items will be shared there afterwards."),
  });
}
