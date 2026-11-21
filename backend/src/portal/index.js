// Meridian Gray client portal: entry point. Served on portal.meridiangray.in
// by the same Worker (and D1 database) as the website backend.

import { ensureSchema, now } from "./db.js";
import { html, redirect, sameOrigin, nonce, securityHeaders } from "./http.js";
import { authPage } from "./ui.js";
import { handleLoginGet, handleLoginPost, handleVerifyGet, handleVerifyPost, handleLogout, loadContext } from "./auth.js";
import { adminRoute } from "./admin.js";
import { clientRoute, accountRoute } from "./client.js";
import { clientMeetingsRoute, adminMeetingsRoute, settleMinutes } from "./meetings.js";
import { clientMessagesRoute, adminMessagesRoute, unreadCount } from "./messages.js";

export const PORTAL_HOSTS = ["portal.meridiangray.in"];

export function isPortalRequest(request, env) {
  const host = new URL(request.url).hostname;
  return PORTAL_HOSTS.includes(host) || env.PORTAL_DEV === "1";
}

function notFound(request) {
  const n = nonce();
  return html(
    request,
    authPage({ title: "Not found", nonce: n, body: `<p class="eyebrow">Client portal</p><h1>That page <em>isn't here.</em></h1><p class="lead">It may have moved, or you may not have access to it.</p><a class="btn pri" href="/">Go to the portal</a>` }),
    n,
    { status: 404 }
  );
}

// Small numbers shown beside menu items.
async function badges(env, ctx) {
  const b = { messages: await unreadCount(env, ctx) };
  if (ctx.user.is_staff && !ctx.viewAs) {
    const r = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM portal_meetings mt JOIN portal_companies c ON c.id = mt.company_id WHERE c.status = 'active' AND mt.status = 'requested') +
              (SELECT COUNT(*) FROM portal_minutes mi JOIN portal_companies c ON c.id = mi.company_id WHERE c.status = 'active' AND mi.status = 'correction') +
              (SELECT COUNT(*) FROM portal_meetings mt JOIN portal_companies c ON c.id = mt.company_id LEFT JOIN portal_minutes mi ON mi.meeting_id = mt.id
                WHERE c.status = 'active' AND mt.status = 'scheduled' AND mt.starts_at + mt.duration_min * 60 < ? AND (mi.meeting_id IS NULL OR mi.status = 'draft')) AS c`
    )
      .bind(now())
      .first();
    b.meetings = r?.c || 0;
  } else if (ctx.company && !ctx.viewAs) {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM portal_minutes WHERE company_id = ? AND status = 'published'`).bind(ctx.company.id).first();
    b.meetings = r?.c || 0;
  }
  return b;
}

// deps: { sendEmail, emailButton, checkRateLimit, getGoogleToken } from the main backend.
export async function handlePortal(request, env, deps) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (path === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" } });
  }
  if (path === "/favicon.ico") return Response.redirect("https://www.meridiangray.in/favicon.ico", 301);
  if (method !== "GET" && method !== "POST" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (method === "POST" && !sameOrigin(request)) return new Response("Forbidden", { status: 403, headers: securityHeaders("x", true) });

  await ensureSchema(env);

  const mail = { send: deps.sendEmail, button: deps.emailButton };
  const cal = { getToken: () => (deps.getGoogleToken ? deps.getGoogleToken(env) : null) };
  const rateLimit = async (req, bucket, limit, windowSec) => (await deps.checkRateLimit(env, req, bucket, { limit, windowSec })).limited;

  // Public routes
  if (path === "/login") return method === "POST" ? handleLoginPost(request, env, mail, rateLimit) : handleLoginGet(request);
  if (path === "/auth/verify") return method === "POST" ? handleVerifyPost(request, env) : handleVerifyGet(request, env);
  if (path === "/logout" && method === "POST") return handleLogout(request, env);

  const ctx = await loadContext(request, env);
  if (!ctx) return redirect(request, "/login");

  // Generous ceiling on writes per connection, against runaway scripts.
  if (method === "POST" && (await rateLimit(request, "portal-write", 120, 600))) {
    return new Response("Too many requests. Please wait a few minutes.", { status: 429 });
  }

  await settleMinutes(env);
  ctx.badges = await badges(env, ctx);

  const acc = await accountRoute(request, env, ctx, path);
  if (acc) return acc;

  if (path === "/admin" || path.startsWith("/admin/")) {
    if (!ctx.user.is_staff) return notFound(request);
    if (path.startsWith("/admin/meetings")) return (await adminMeetingsRoute(request, env, ctx, mail, path, cal)) || notFound(request);
    if (path.startsWith("/admin/messages")) return (await adminMessagesRoute(request, env, ctx, mail, path)) || notFound(request);
    return (await adminRoute(request, env, ctx, mail, path)) || notFound(request);
  }

  if (ctx.user.is_staff && !ctx.viewAs) {
    return path === "/" ? redirect(request, "/admin") : notFound(request);
  }

  if (path === "/meetings" || path.startsWith("/meetings/")) return (await clientMeetingsRoute(request, env, ctx, mail, path)) || notFound(request);
  if (path === "/messages" || path.startsWith("/messages/")) return (await clientMessagesRoute(request, env, ctx, mail, path)) || notFound(request);
  return (await clientRoute(request, env, ctx, mail, path)) || notFound(request);
}
