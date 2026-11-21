// Sign-in by emailed link (no passwords), sessions, and who-can-see-what.
//
// - Staff: anyone whose email's SHA-256 is listed in STAFF_EMAIL_HASHES. The
//   list holds hashes, not addresses, so it's safe in the repo.
// - Clients: a portal_users row with at least one membership in an active
//   company. Access is recomputed on every request, so removing someone or
//   archiving a company cuts access immediately.

import { now, newId, randomToken, sha256, normEmail, isEmail, audit } from "./db.js";
import { esc, authPage } from "./ui.js";
import { html, redirect, readForm, sameOrigin, getCookie, clientIp, nonce } from "./http.js";

export const COOKIE = "__Host-mgp";
const SESSION_DAYS = 30;
const LOGIN_TTL = 20 * 60; // 20 minutes for a link someone asked for
export const INVITE_TTL = 72 * 3600; // 3 days for an invitation

export async function isStaffEmail(env, email) {
  const list = String(env.STAFF_EMAIL_HASHES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;
  return list.includes(await sha256(normEmail(email)));
}

// Who may receive a sign-in link at all.
async function canSignIn(env, email) {
  if (await isStaffEmail(env, email)) return true;
  const row = await env.DB.prepare(
    `SELECT 1 FROM portal_users u
       JOIN portal_memberships m ON m.user_id = u.id
       JOIN portal_companies c ON c.id = m.company_id
      WHERE u.email = ? AND u.status = 'active' AND c.status = 'active' LIMIT 1`
  )
    .bind(email)
    .first();
  return !!row;
}

export async function createLoginToken(env, email, ttl, ip = null) {
  const token = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO portal_login_tokens (token_hash, email, created_at, expires_at, ip) VALUES (?,?,?,?,?)`
  )
    .bind(await sha256(token), normEmail(email), now(), now() + ttl, ip)
    .run();
  return token;
}

// Two addresses, one system: clients use portal.meridiangray.in, the team
// uses admin.meridiangray.in. Locally (dev) both are the dev server.
export const CLIENT_HOST = "portal.meridiangray.in";
export const ADMIN_HOST = "admin.meridiangray.in";
const isLive = (request) => new URL(request.url).hostname.endsWith("meridiangray.in");
export function portalOrigin(request) {
  return isLive(request) ? `https://${CLIENT_HOST}` : new URL(request.url).origin;
}
export function adminOrigin(request) {
  return isLive(request) ? `https://${ADMIN_HOST}` : new URL(request.url).origin;
}

export async function sendSignInEmail(env, mail, request, email, token, { invite = false, companyName = "", inviterName = "" } = {}) {
  const origin = (await isStaffEmail(env, email)) ? adminOrigin(request) : portalOrigin(request);
  const link = `${origin}/auth/verify?t=${encodeURIComponent(token)}`;
  if (env.PORTAL_DEV === "1") console.log(`[portal dev] sign-in link for ${email}: ${link}`);
  const subject = invite ? `You've been given access to the Meridian Gray client portal` : `Your sign-in link for the Meridian Gray client portal`;
  const body = invite
    ? `<p style="margin:0 0 16px;">Hello,</p>
       <p style="margin:0 0 16px;">${inviterName ? esc(inviterName) + " has" : "We've"} given you access to the Meridian Gray client portal${companyName ? ` for <b>${esc(companyName)}</b>` : ""}. It's where you'll find our projects together, meeting minutes, agreements, invoices and requests.</p>
       <p style="margin:0 0 24px;">${mail.button("Open the portal", link)}</p>
       <p style="margin:0;font-size:13px;color:#5B606B;">This link signs you in directly and works for 3 days. After that, go to ${esc(origin)} and enter this email address to get a fresh link. No password needed, ever.</p>`
    : `<p style="margin:0 0 16px;">Here's your sign-in link for the Meridian Gray client portal.</p>
       <p style="margin:0 0 24px;">${mail.button("Sign in to the portal", link)}</p>
       <p style="margin:0;font-size:13px;color:#5B606B;">The link works once and expires in 20 minutes. If you didn't ask for it, you can ignore this email; nobody can sign in without it.</p>`;
  const r = await mail.send(env, { subject, htmlContent: body, to: email, preheader: invite ? "Your access to the Meridian Gray client portal" : "Sign in with one click" });
  return { ok: !!(r && (r.ok || r.skipped)), skipped: !!(r && r.skipped), link };
}

// ---------- pages ----------

const GOOGLE_BTN = `<a class="btn gbtn" href="/auth/google"><svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>Continue with Google</a><div class="or"><span>or get a link by email</span></div>`;

function loginBody({ email = "", sent = false, devLink = "", err = "", team = false, google = false }) {
  if (sent) {
    return `<p class="eyebrow">Client portal</p><h1>Check <em>your email.</em></h1>
      <p class="lead" style="margin-bottom:18px">If <b>${esc(email)}</b> has access to the portal, a sign-in link is on its way. It works once and expires in 20 minutes.</p>
      <p class="note">Nothing arrived after a couple of minutes? Check spam or promotions, then <a href="/login">try again</a>. Still nothing? Write to <a href="mailto:info@meridiangray.in">info@meridiangray.in</a> and we'll sort out your access.</p>
      ${devLink ? `<p class="note"><b>Dev mode:</b> <a href="${esc(devLink)}">open the sign-in link</a></p>` : ""}`;
  }
  if (team) {
    return `<p class="eyebrow">Meridian Gray · Team</p><h1>Team <em>sign-in.</em></h1>
    <p class="lead" style="margin-bottom:26px">For the Meridian Gray team only. Continue with Google, or get a one-click sign-in link by email.</p>
    ${err ? `<div class="flash err">${esc(err)}</div>` : ""}${google ? GOOGLE_BTN : ""}
    <form class="f" method="post" action="/login">
      <div class="fld"><label for="email">Work email</label><input id="email" type="email" name="email" value="${esc(email)}" autocomplete="email" required${google ? "" : " autofocus"}></div>
      <button class="btn pri" type="submit">Email me a sign-in link</button>
    </form>
    <p class="note">Clients sign in at <a href="https://${CLIENT_HOST}">${CLIENT_HOST}</a>.</p>`;
  }
  return `<p class="eyebrow">Client portal</p><h1>Sign in to <em>your portal.</em></h1>
    <p class="lead" style="margin-bottom:26px">Continue with Google, or enter the email we have for you and we'll send a one-click sign-in link. There's no password to remember.</p>
    ${err ? `<div class="flash err">${esc(err)}</div>` : ""}${google ? GOOGLE_BTN : ""}
    <form class="f" method="post" action="/login">
      <div class="fld"><label for="email">Work email</label><input id="email" type="email" name="email" value="${esc(email)}" autocomplete="email" required${google ? "" : " autofocus"}></div>
      <button class="btn pri" type="submit">Email me a sign-in link</button>
    </form>
    <p class="note">Not a client yet? See what we do at <a href="https://www.meridiangray.in">meridiangray.in</a>.</p>`;
}

export async function handleLoginGet(request, env, scope = null) {
  const n = nonce();
  const url = new URL(request.url);
  const email = url.searchParams.get("email") || "";
  const e = url.searchParams.get("e");
  const errs = {
    expired: "That link has expired or was already used. Enter your email for a fresh one.",
    google: "Google sign-in didn't complete. Try again, or use an email link below.",
    google_cancel: "Google sign-in was cancelled.",
    noaccess: `${email || "That Google account"} doesn't have access here. Sign in with the email address we invited, or write to info@meridiangray.in.`,
    useteam: "Team accounts sign in here, at the team address.",
  };
  return html(request, authPage({ title: scope === "admin" ? "Team sign-in" : "Sign in", nonce: n, body: loginBody({ email: e === "noaccess" ? "" : email, err: errs[e] || "", team: scope === "admin", google: googleReady(env) }) }), n);
}

// scope: "admin" on admin.meridiangray.in, "client" on portal.meridiangray.in, null in dev.
export async function handleLoginPost(request, env, mail, rateLimit, scope = null) {
  const team = scope === "admin";
  const n = nonce();
  if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const f = await readForm(request);
  const email = normEmail(f.email);
  if (!isEmail(email)) {
    return html(request, authPage({ title: "Sign in", nonce: n, body: loginBody({ email: f.email, team, err: "That doesn't look like a valid email address." }) }), n, { status: 400 });
  }
  if (await rateLimit(request, "portal-login", 10, 600)) {
    return html(request, authPage({ title: "Sign in", nonce: n, body: loginBody({ email, team, err: "Too many attempts from this connection. Please wait a few minutes and try again." }) }), n, { status: 429 });
  }

  let devLink = "";
  // The team address only ever sends links to the team.
  if ((await canSignIn(env, email)) && (!team || (await isStaffEmail(env, email)))) {
    // At most 3 links per address per 15 minutes, so nobody can flood an inbox.
    const recent = await env.DB.prepare(`SELECT COUNT(*) AS c FROM portal_login_tokens WHERE email = ? AND created_at > ?`)
      .bind(email, now() - 900)
      .first();
    if ((recent?.c || 0) < 3) {
      const token = await createLoginToken(env, email, LOGIN_TTL, clientIp(request));
      const r = await sendSignInEmail(env, mail, request, email, token);
      if (env.PORTAL_DEV === "1") devLink = r.link;
    }
  }
  // Same answer whether or not the address has access, so the form can't be
  // used to discover who our clients are.
  return html(request, authPage({ title: "Check your email", nonce: n, body: loginBody({ email, sent: true, devLink }) }), n);
}

// GET shows a confirm button instead of signing in straight away: email
// security scanners open links automatically, and would otherwise burn the
// one-time token before the person clicks it.
export async function handleVerifyGet(request, env) {
  const n = nonce();
  const t = new URL(request.url).searchParams.get("t") || "";
  const row = t
    ? await env.DB.prepare(`SELECT email FROM portal_login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
        .bind(await sha256(t), now())
        .first()
    : null;
  if (!row) return redirect(request, "/login?e=expired");
  const body = `<p class="eyebrow">Client portal</p><h1>One click <em>and you're in.</em></h1>
    <p class="lead" style="margin-bottom:26px">Signing in as <b>${esc(row.email)}</b>.</p>
    <form class="f" method="post" action="/auth/verify"><input type="hidden" name="t" value="${esc(t)}"><button class="btn pri" type="submit">Continue to the portal</button></form>
    <p class="note">Not you? Just close this page.</p>`;
  return html(request, authPage({ title: "Sign in", nonce: n, body }), n);
}

export async function handleVerifyPost(request, env, scope = null) {
  if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const f = await readForm(request);
  const t = f.t || "";
  if (!t) return redirect(request, "/login?e=expired");
  const h = await sha256(t);
  const ts = now();
  const res = await env.DB.prepare(`UPDATE portal_login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(ts, h, ts)
    .run();
  if (!res.meta || res.meta.changes !== 1) return redirect(request, "/login?e=expired");
  const { email } = await env.DB.prepare(`SELECT email FROM portal_login_tokens WHERE token_hash = ?`).bind(h).first();

  const staff = await isStaffEmail(env, email);
  if (!staff && !(await canSignIn(env, email))) return redirect(request, "/login?e=expired");
  // Each address only signs in its own people; a link opened on the wrong one goes to the right one.
  if (scope === "admin" && !staff) return redirect(request, `${portalOrigin(request)}/login`);
  if (scope === "client" && staff) return redirect(request, `${adminOrigin(request)}/login`);

  return startSession(env, request, email, staff, { method: "email link" });
}

// Creates the session once someone has proved they own the email address.
async function startSession(env, request, email, staff, { method, googleName = null }) {
  const ts = now();
  let user = await env.DB.prepare(`SELECT * FROM portal_users WHERE email = ?`).bind(email).first();
  if (!user) {
    // Only staff can arrive without a row; clients always have one.
    const id = newId("usr");
    await env.DB.prepare(`INSERT INTO portal_users (id, email, is_staff, created_at) VALUES (?,?,1,?)`).bind(id, email, ts).run();
    user = { id, email, is_staff: 1 };
  } else if (staff && !user.is_staff) {
    await env.DB.prepare(`UPDATE portal_users SET is_staff = 1 WHERE id = ?`).bind(user.id).run();
    user.is_staff = 1;
  }
  await env.DB.prepare(`UPDATE portal_users SET last_login_at = ?, name = COALESCE(name, ?) WHERE id = ?`).bind(ts, googleName || null, user.id).run();

  const sid = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO portal_sessions (id_hash, user_id, created_at, expires_at, last_seen_at, ip, ua) VALUES (?,?,?,?,?,?,?)`
  )
    .bind(await sha256(sid), user.id, ts, ts + SESSION_DAYS * 86400, ts, clientIp(request), (request.headers.get("User-Agent") || "").slice(0, 200))
    .run();
  await audit(env, user, { action: "auth.signin", summary: `${email} signed in (${method})`, ip: clientIp(request) });
  // Housekeeping: drop old tokens and expired sessions now and then.
  if (Math.random() < 0.1) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM portal_login_tokens WHERE expires_at < ?`).bind(ts - 86400),
      env.DB.prepare(`DELETE FROM portal_sessions WHERE expires_at < ?`).bind(ts),
    ]);
  }
  return redirect(request, user.is_staff ? "/admin" : "/", {
    "Set-Cookie": `${COOKIE}=${sid}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  });
}


// ---------- Sign in with Google ----------
// Standard OAuth 2.0 / OpenID Connect code flow. The ID token comes straight
// from Google's token endpoint over TLS in exchange for our client secret, so
// its contents are trusted after checking audience, issuer, expiry and that
// Google has verified the email address. Google proves who someone is; the
// portal still decides whether that email has access, exactly as for links.
const GSTATE = "__Host-mgg";

export function googleReady(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export async function handleGoogleStart(request, env) {
  if (!googleReady(env)) return redirect(request, "/login");
  const state = randomToken(24);
  const origin = new URL(request.url).origin;
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
    access_type: "online",
  });
  return redirect(request, `https://accounts.google.com/o/oauth2/v2/auth?${q}`, {
    "Set-Cookie": `${GSTATE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
  });
}

function decodeJwtPayload(jwt) {
  const part = String(jwt || "").split(".")[1] || "";
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
}

export async function handleGoogleCallback(request, env, scope = null) {
  const url = new URL(request.url);
  const clear = { "Set-Cookie": `${GSTATE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` };
  const fail = (code) => redirect(request, `/login?e=${code}`, clear);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return fail("google_cancel");
  if (!googleReady(env) || !state || !code || state !== getCookie(request, GSTATE)) return fail("google");
  let claims;
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${url.origin}/auth/google/callback`, grant_type: "authorization_code" }),
    });
    const d = await r.json();
    if (!r.ok || !d.id_token) {
      console.log("google token exchange failed", r.status, JSON.stringify(d).slice(0, 300));
      return fail("google");
    }
    claims = decodeJwtPayload(d.id_token);
  } catch (e) {
    console.log("google sign-in error", e && e.message);
    return fail("google");
  }
  const okIss = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!okIss || claims.aud !== env.GOOGLE_CLIENT_ID || !(claims.exp > now()) || !(claims.email_verified === true || claims.email_verified === "true")) return fail("google");
  const email = normEmail(claims.email);
  const staff = await isStaffEmail(env, email);
  if (!staff && !(await canSignIn(env, email))) return redirect(request, `/login?e=noaccess&email=${encodeURIComponent(email)}`, clear);
  if (scope === "admin" && !staff) return redirect(request, `/login?e=noaccess&email=${encodeURIComponent(email)}`, clear);
  if (scope === "client" && staff) return redirect(request, `${adminOrigin(request)}/login?e=useteam`, clear);
  const res = await startSession(env, request, email, staff, { method: "Google", googleName: String(claims.name || "").slice(0, 120) || null });
  res.headers.append("Set-Cookie", clear["Set-Cookie"]);
  return res;
}

export async function handleLogout(request, env) {
  if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const sid = getCookie(request, COOKIE);
  if (sid) await env.DB.prepare(`DELETE FROM portal_sessions WHERE id_hash = ?`).bind(await sha256(sid)).run();
  return redirect(request, "/login", { "Set-Cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
}

// Loads the signed-in context, or null. ctx = { user, sessionHash, company,
// companies, role, viewAs }.
export async function loadContext(request, env) {
  const sid = getCookie(request, COOKIE);
  if (!sid || sid.length < 20) return null;
  const sh = await sha256(sid);
  const ts = now();
  const s = await env.DB.prepare(
    `SELECT s.*, u.email, u.name, u.phone, u.title, u.is_staff, u.status AS user_status
       FROM portal_sessions s JOIN portal_users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ?`
  )
    .bind(sh, ts)
    .first();
  if (!s || s.user_status !== "active") return null;

  const user = { id: s.user_id, email: s.email, name: s.name, phone: s.phone, title: s.title, is_staff: !!s.is_staff };
  if (user.is_staff && !(await isStaffEmail(env, user.email))) return null; // removed from the team list

  if (ts - s.last_seen_at > 300) {
    await env.DB.prepare(`UPDATE portal_sessions SET last_seen_at = ? WHERE id_hash = ?`).bind(ts, sh).run();
  }

  const ctx = { user, sessionHash: sh, company: null, companies: [], role: null, viewAs: false };

  if (user.is_staff) {
    if (s.view_as_company_id) {
      const c = await env.DB.prepare(`SELECT * FROM portal_companies WHERE id = ?`).bind(s.view_as_company_id).first();
      if (c) {
        ctx.company = c;
        ctx.companies = [c];
        ctx.viewAs = true;
        ctx.role = "owner"; // sees what an Owner sees, read-only intent
      }
    }
    return ctx;
  }

  const rows = await env.DB.prepare(
    `SELECT c.*, m.role FROM portal_memberships m JOIN portal_companies c ON c.id = m.company_id
      WHERE m.user_id = ? AND c.status = 'active' ORDER BY c.name`
  )
    .bind(user.id)
    .all();
  ctx.companies = rows.results || [];
  if (!ctx.companies.length) return null; // no live access left
  const pick = ctx.companies.find((c) => c.id === s.company_id) || ctx.companies[0];
  ctx.company = pick;
  ctx.role = pick.role;
  return ctx;
}
