/**
 * Pre-launch gate for meridiangray.in.
 *
 * While GATE_ENABLED is "true", every visitor sees a "Coming Soon" page
 * instead of the real site, except for whoever signs in with Google using
 * one of the emails in ALLOWED_EMAILS -- they get a signed session cookie
 * and see the real site exactly as it will look at launch.
 *
 * To actually launch: set GATE_ENABLED to "false" in wrangler.jsonc (or as
 * a Cloudflare dashboard variable override) and redeploy. No code changes
 * needed, and nothing here has to be removed -- it just stops intercepting
 * requests.
 *
 * Secrets this Worker needs (Cloudflare dashboard -> Workers & Pages -> mg
 * -> Settings -> Variables and Secrets -- NOT in this repo):
 *   GOOGLE_CLIENT_SECRET  - from the Google Cloud OAuth client
 *   SESSION_SECRET         - any long random string, used to sign the cookie
 */

const COOKIE_NAME = "mg_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Paths that bypass the gate entirely -- always served from static assets,
// signed-in or not. Keeps the coming-soon page's own icon working and lets
// the auth flow itself run before a session cookie exists.
const BYPASS_PATHS = new Set([
	"/favicon.ico",
	"/favicon-16x16.png",
	"/favicon-32x32.png",
	"/favicon-192x192.png",
	"/favicon-512x512.png",
	"/apple-touch-icon.png",
	"/og-image.png",
	"/site.webmanifest",
]);

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/robots.txt" && isGateOn(env)) {
			return new Response("User-agent: *\nDisallow: /\n", {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		if (url.pathname.startsWith("/auth/")) {
			return handleAuth(request, env, url);
		}

		if (!isGateOn(env) || BYPASS_PATHS.has(url.pathname)) {
			return env.ASSETS.fetch(request);
		}

		const session = await readSession(request, env);
		if (session) {
			return env.ASSETS.fetch(request);
		}

		return comingSoonPage(env);
	},
};

function isGateOn(env) {
	return String(env.GATE_ENABLED || "true").toLowerCase() === "true";
}

function allowedEmails(env) {
	return String(env.ALLOWED_EMAILS || "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
}

async function handleAuth(request, env, url) {
	if (!env.SESSION_SECRET || !env.GOOGLE_CLIENT_ID) {
		return htmlPage(
			"Sign-in not configured yet",
			`<p>Google sign-in isn't fully set up on this Worker yet (missing ${!env.GOOGLE_CLIENT_ID ? "GOOGLE_CLIENT_ID" : "SESSION_SECRET"}).</p>`
		);
	}

	if (url.pathname === "/auth/login") {
		const redirectUri = `${url.origin}/auth/callback`;
		const params = new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID || "",
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "openid email",
			access_type: "online",
			prompt: "select_account",
		});
		return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
	}

	if (url.pathname === "/auth/callback") {
		const code = url.searchParams.get("code");
		const oauthError = url.searchParams.get("error");
		if (oauthError) return htmlPage("Sign-in cancelled", `<p>Google sign-in was cancelled or denied.</p><p><a href="/auth/login">Try again</a></p>`);
		if (!code) return htmlPage("Sign-in failed", `<p>No authorization code was returned.</p><p><a href="/auth/login">Try again</a></p>`);

		const redirectUri = `${url.origin}/auth/callback`;
		const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code,
				client_id: env.GOOGLE_CLIENT_ID || "",
				client_secret: env.GOOGLE_CLIENT_SECRET || "",
				redirect_uri: redirectUri,
				grant_type: "authorization_code",
			}),
		});
		const tokenData = await tokenResp.json();
		if (!tokenResp.ok || !tokenData.id_token) {
			return htmlPage("Sign-in failed", `<p>Google didn't return a valid token.</p><pre>${escapeHtml(JSON.stringify(tokenData))}</pre><p><a href="/auth/login">Try again</a></p>`);
		}

		const payload = decodeJwtPayload(tokenData.id_token);
		const email = (payload && payload.email || "").toLowerCase();
		const emailVerified = payload && (payload.email_verified === true || payload.email_verified === "true");

		if (!email || !emailVerified) {
			return htmlPage("Sign-in failed", `<p>Could not verify your Google account's email.</p><p><a href="/auth/login">Try again</a></p>`);
		}

		if (!allowedEmails(env).includes(email)) {
			return htmlPage(
				"Not approved yet",
				`<p>Signed in as <b>${escapeHtml(email)}</b>, but this account isn't on the approved list for the preview.</p><p>Ask the team to add it, or <a href="/auth/login">sign in with a different account</a>.</p>`
			);
		}

		const token = await signSession({ email, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE }, env);
		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			`${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
		);
		headers.set("Location", "/");
		return new Response(null, { status: 302, headers });
	}

	if (url.pathname === "/auth/logout") {
		const headers = new Headers();
		headers.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
		headers.set("Location", "/");
		return new Response(null, { status: 302, headers });
	}

	return new Response("Not found", { status: 404 });
}

async function readSession(request, env) {
	if (!env.SESSION_SECRET) return null;
	const cookieHeader = request.headers.get("Cookie") || "";
	const match = cookieHeader.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]+)`));
	if (!match) return null;
	let verified;
	try {
		verified = await verifySession(match[1], env);
	} catch {
		return null;
	}
	if (!verified) return null;
	if (verified.exp && verified.exp < Math.floor(Date.now() / 1000)) return null;
	if (!allowedEmails(env).includes((verified.email || "").toLowerCase())) return null;
	return verified;
}

async function signSession(data, env) {
	const body = base64url(JSON.stringify(data));
	const sig = await hmac(body, env);
	return `${body}.${sig}`;
}

async function verifySession(token, env) {
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const [body, sig] = parts;
	const expected = await hmac(body, env);
	if (!timingSafeEqual(sig, expected)) return null;
	try {
		return JSON.parse(base64urlDecode(body));
	} catch {
		return null;
	}
}

async function hmac(message, env) {
	const secret = env.SESSION_SECRET || "";
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return base64url(String.fromCharCode(...new Uint8Array(sig)));
}

function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return result === 0;
}

function base64url(str) {
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
	str = str.replace(/-/g, "+").replace(/_/g, "/");
	while (str.length % 4) str += "=";
	return atob(str);
}

function decodeJwtPayload(jwt) {
	try {
		const payload = jwt.split(".")[1];
		return JSON.parse(base64urlDecode(payload));
	} catch {
		return null;
	}
}

function escapeHtml(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function htmlPage(title, bodyHtml) {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Meridian Gray</title><style>
body{margin:0;min-height:100svh;display:grid;place-items:center;background:#0B0E1A;color:#fff;font:16px/1.6 -apple-system,'Plus Jakarta Sans',sans-serif;padding:24px}
.card{max-width:440px;text-align:center}
h1{font-size:26px;margin:0 0 16px;letter-spacing:-.02em}
a{color:#7C94FF}
p{color:#B9BDCB}
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1>${bodyHtml}</div></body></html>`,
		{ headers: { "content-type": "text/html; charset=utf-8" }, status: 200 }
	);
}

function comingSoonPage(env) {
	return new Response(COMING_SOON_HTML, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

const COMING_SOON_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meridian Gray &middot; Coming Soon</title>
<meta name="robots" content="noindex,nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<link rel="icon" href="/favicon.ico" sizes="any">
<style>
:root{--aub:#244BDB;--ink:#fff;--mute:#9AA0B4}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;background:#0B0E1A;color:var(--ink);font-family:'Plus Jakarta Sans',-apple-system,sans-serif;display:flex;flex-direction:column}
.wrap{flex:1;display:grid;place-items:center;padding:24px}
.card{max-width:480px;width:100%;text-align:center}
.brand{font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);margin-bottom:28px;font-weight:600}
.brand b{color:#fff}
h1{font-size:clamp(34px,6vw,52px);line-height:1.08;letter-spacing:-.03em;font-weight:700;margin:0 0 18px}
h1 em{font-style:normal;color:#7C94FF}
p.lead{color:var(--mute);font-size:16px;line-height:1.6;margin:0 0 36px}
.btn{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#111;font-weight:600;font-size:15px;padding:13px 22px;border-radius:999px;text-decoration:none;transition:transform .2s,box-shadow .2s}
.btn:hover{transform:translateY(-2px);box-shadow:0 10px 24px -8px rgba(255,255,255,.3)}
.btn svg{width:18px;height:18px}
footer{text-align:center;padding:20px;color:#5A5F72;font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="brand"><b>Meridian Gray</b> &middot; Connecting Systems</div>
    <h1>Something's being <em>built.</em></h1>
    <p class="lead">We're not quite ready to open the doors. If you're on the team, sign in below to preview the site.</p>
    <a class="btn" href="/auth/login">
      <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.9 6.1 29.8 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.9 6.1 29.8 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.7 0 10.7-1.9 14.5-5.2l-6.7-5.7C29.7 34.6 27 35.5 24 35.5c-5.2 0-9.6-3.3-11.2-7.9l-6.6 5.1C9.6 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.7 5.7C41.5 36.1 44 30.6 44 24c0-1.3-.1-2.7-.4-3.5z"/></svg>
      Sign in with Google
    </a>
  </div>
</div>
<footer>&copy; Meridian Gray</footer>
</body>
</html>`;
