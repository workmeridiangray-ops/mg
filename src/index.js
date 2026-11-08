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

// Launch moment: the gate switches itself off at this time, server-side, so
// nobody can open the site early by tampering with their browser clock.
// Override with the LAUNCH_AT variable (any ISO-8601 time with offset).
const DEFAULT_LAUNCH_AT = "2026-11-08T17:22:00+05:30";

function launchMs(env) {
	const t = Date.parse(String(env.LAUNCH_AT || DEFAULT_LAUNCH_AT));
	return Number.isNaN(t) ? Date.parse(DEFAULT_LAUNCH_AT) : t;
}

function isGateOn(env) {
	if (String(env.GATE_ENABLED || "true").toLowerCase() !== "true") return false;
	return Date.now() < launchMs(env);
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

	// Private share link: /auth/preview?key=<PREVIEW_KEY> gives a 7-day viewing
	// session without Google sign-in. Change PREVIEW_KEY to revoke the link.
	if (url.pathname === "/auth/preview") {
		const key = url.searchParams.get("key") || "";
		if (!env.PREVIEW_KEY || key !== env.PREVIEW_KEY) {
			return htmlPage("Link not valid", `<p>This preview link is not valid or has been turned off.</p>`);
		}
		const days = 7;
		const token = await signSession({ email: "preview-link", exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * days }, env);
		const h = new Headers();
		h.append("Set-Cookie", `${COOKIE_NAME}=${token}; Path=/; Max-Age=${60 * 60 * 24 * days}; HttpOnly; Secure; SameSite=Lax`);
		h.set("Location", "/");
		return new Response(null, { status: 302, headers: h });
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
	const html = COMING_SOON_HTML
		.replace("__SERVER_NOW__", String(Date.now()))
		.replace("__LAUNCH_MS__", String(launchMs(env)));
	return new Response(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

const COMING_SOON_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meridian Gray &middot; Opening Soon</title>
<meta name="robots" content="noindex,nofollow">
<meta name="mg-gate" content="1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<link rel="icon" href="/favicon.ico" sizes="any">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#0B0E1A;color:#fff;font-family:'Plus Jakarta Sans',-apple-system,sans-serif}
#site{position:fixed;inset:0;width:100%;height:100%;border:0;background:#0B0E1A;z-index:1;display:none}
#shutter{position:fixed;inset:0;z-index:10;perspective:1200px;perspective-origin:50% 0%;overflow:hidden}
.slat{position:absolute;left:0;width:100%;transform-origin:50% 0%;backface-visibility:hidden;
 background:linear-gradient(180deg,#d9dde2 0%,#9aa1a9 45%,#6f767e 55%,#b9bec4 100%);
 border-bottom:1px solid rgba(0,0,0,.45);box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 1px 3px rgba(0,0,0,.35)}
.slat::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(0,0,0,.03) 0 2px,transparent 2px 6px)}
.drum{position:absolute;left:0;top:0;width:100%;height:0;background:linear-gradient(180deg,#2b2e32,#8b9299 40%,#4a4f55 70%,#222);box-shadow:0 6px 18px rgba(0,0,0,.55)}
.bar{position:absolute;left:0;width:100%;height:46px;background:linear-gradient(180deg,#4a4d52,#1d1f22 60%,#2c2f33);box-shadow:0 8px 20px rgba(0,0,0,.5)}
.bar::before{content:"";position:absolute;left:50%;top:14px;width:110px;height:18px;transform:translateX(-50%);border-radius:9px;background:linear-gradient(180deg,#f0cf7d,#9b7424);box-shadow:0 2px 4px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.5)}
#panel{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:24px;transition:opacity .5s}
#panel.gone{opacity:0;pointer-events:none}
.card{max-width:520px;width:100%;text-align:center;background:rgba(11,14,26,.9);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:34px 26px;box-shadow:0 30px 60px -20px rgba(0,0,0,.7)}
.brand{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#9AA0B4;margin-bottom:18px;font-weight:600}
.brand b{color:#fff}
h1{font-size:clamp(28px,6vw,44px);line-height:1.1;letter-spacing:-.03em;font-weight:700;margin-bottom:10px}
h1 em{font-style:normal;color:#7C94FF}
p.lead{color:#9AA0B4;font-size:15px;line-height:1.5;margin-bottom:22px}
#count{display:flex;justify-content:center;gap:10px;margin-bottom:26px}
.u{min-width:68px;padding:12px 6px;border-radius:12px;background:#151a2e;border:1px solid rgba(255,255,255,.08)}
.u b{display:block;font-size:clamp(26px,7vw,38px);font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.u span{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9AA0B4}
.btn{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#111;font-weight:600;font-size:14px;padding:12px 20px;border-radius:999px;text-decoration:none}
.btn svg{width:18px;height:18px}
.team{font-size:12px;color:#7a8095;margin-bottom:10px}
#sound{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:30;background:rgba(0,0,0,.75);color:#fff;border:0;padding:9px 18px;border-radius:30px;font:600 13px 'Plus Jakarta Sans',sans-serif;cursor:pointer;transition:opacity .4s}
#sound.hide{opacity:0;pointer-events:none}
</style>
</head>
<body>
<iframe id="site" title="Meridian Gray" aria-hidden="true"></iframe>
<div id="shutter" aria-hidden="true"></div>
<div id="panel">
  <div class="card">
    <div class="brand"><b>Meridian Gray</b> &middot; Connecting Systems</div>
    <h1>The shop opens <em>soon.</em></h1>
    <p class="lead">The shutter rolls up at 5:22 PM IST today, 8 November.</p>
    <div id="count" aria-live="off">
      <div class="u"><b id="cH">--</b><span>Hours</span></div>
      <div class="u"><b id="cM">--</b><span>Minutes</span></div>
      <div class="u"><b id="cS">--</b><span>Seconds</span></div>
    </div>
    <div class="team">On the team? Preview the site early:</div>
    <a class="btn" href="/auth/login">
      <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.9 6.1 29.8 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.9 6.1 29.8 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.7 0 10.7-1.9 14.5-5.2l-6.7-5.7C29.7 34.6 27 35.5 24 35.5c-5.2 0-9.6-3.3-11.2-7.9l-6.6 5.1C9.6 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.7 5.7C41.5 36.1 44 30.6 44 24c0-1.3-.1-2.7-.4-3.5z"/></svg>
      Sign in with Google
    </a>
  </div>
</div>
<button id="sound" type="button">&#128266; Tap once to turn the shutter sound on</button>

<script>
(function () {
  var SERVER_NOW = __SERVER_NOW__, LAUNCH = __LAUNCH_MS__;
  var offset = SERVER_NOW - Date.now();           // use server time, not the visitor's clock
  function now() { return Date.now() + offset; }

  var N = 72, BAR = 46, OPEN_MS = 5200;
  var shutter = document.getElementById('shutter');
  var panel = document.getElementById('panel');
  var soundBtn = document.getElementById('sound');
  var site = document.getElementById('site');
  var slats = [];
  for (var i = 0; i < N; i++) { var s = document.createElement('div'); s.className = 'slat'; shutter.appendChild(s); slats.push(s); }
  var drum = document.createElement('div'); drum.className = 'drum'; shutter.appendChild(drum);
  var bar = document.createElement('div'); bar.className = 'bar'; shutter.appendChild(bar);

  /* ---- sound (synthesised) ---- */
  var ac, master, rumble;
  function noiseBuf(sec) {
    var b = ac.createBuffer(1, ac.sampleRate * sec, ac.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function initAudio() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain(); master.gain.value = 2.2;
    var comp = ac.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 8;
    master.connect(comp); comp.connect(ac.destination);
    var rb = ac.createBufferSource(); rb.buffer = noiseBuf(2); rb.loop = true;
    var lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    rumble = ac.createGain(); rumble.gain.value = 0;
    rb.connect(lp); lp.connect(rumble); rumble.connect(master); rb.start();
    soundBtn.classList.add('hide');
  }
  function tick() {
    if (!ac) return;
    var t = ac.currentTime;
    var src = ac.createBufferSource(); src.buffer = noiseBuf(0.05);
    var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2800 + Math.random() * 1500; bp.Q.value = 4;
    var g = ac.createGain(); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(bp); bp.connect(g); g.connect(master); src.start(t); src.stop(t + 0.05);
    var o = ac.createOscillator(); o.type = 'square'; o.frequency.value = 700 + Math.random() * 500;
    var og = ac.createGain(); og.gain.setValueAtTime(0.12, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(og); og.connect(master); o.start(t); o.stop(t + 0.035);
  }
  function rattle(k) {
    if (!ac) return;
    var t = ac.currentTime;
    var src = ac.createBufferSource(); src.buffer = noiseBuf(0.12);
    var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200 + Math.random() * 1800; bp.Q.value = 2.5;
    var g = ac.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 * k, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    src.connect(bp); bp.connect(g); g.connect(master); src.start(t); src.stop(t + 0.12);
  }
  function clunk(freq, vol, len) {
    if (!ac) return;
    var t = ac.currentTime;
    var o = ac.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(freq * 2, t); o.frequency.exponentialRampToValueAtTime(freq * 0.5, t + len);
    var g = ac.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + len);
    var n = ac.createBufferSource(); n.buffer = noiseBuf(0.15);
    var hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    var ng = ac.createGain(); ng.gain.setValueAtTime(vol * 0.5, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    n.connect(hp); hp.connect(ng); ng.connect(master); n.start(t); n.stop(t + 0.15);
  }
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) {
    addEventListener(ev, initAudio, { passive: true });
  });
  soundBtn.addEventListener('click', initAudio);

  /* ---- shutter render ---- */
  function render(p) {
    var h = innerHeight, Hs = h - BAR, slatH = Hs / N, lift = p * Hs;
    for (var i = 0; i < N; i++) {
      var s = slats[i], y = i * slatH, d = y - lift;
      s.style.height = (Math.ceil(slatH) + 1) + 'px';
      s.style.top = y + 'px';
      if (d >= 0) { s.style.transform = 'translateY(' + (-lift) + 'px)'; s.style.opacity = 1; }
      else {
        var k = Math.min(1, -d / (h * 0.22));
        s.style.transform = 'translateY(' + (-lift + (-d) * 0.9) + 'px) translateZ(' + (-k * 120) + 'px) rotateX(' + (-k * 95) + 'deg)';
        s.style.opacity = 1 - k;
      }
    }
    bar.style.top = (Hs - lift) + 'px';
    drum.style.height = (30 * Math.min(1, p * 1.5)) + 'px';
    drum.style.opacity = p > 0.01 ? 1 : 0;
  }
  render(0);
  addEventListener('resize', function () { render(window.__p || 0); });

  /* ---- countdown ---- */
  var cH = document.getElementById('cH'), cM = document.getElementById('cM'), cS = document.getElementById('cS');
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  var launched = false;
  function update() {
    var left = LAUNCH - now();
    if (left <= 0) { if (!launched) launch(); return; }
    var t = Math.floor(left / 1000);
    cH.textContent = pad(Math.floor(t / 3600));      // hours can exceed 24 if the launch time is moved out
    cM.textContent = pad(Math.floor((t % 3600) / 60));
    cS.textContent = pad(t % 60);
  }
  update();
  var timer = setInterval(update, 250);

  /* ---- launch: countdown + sign-in go, shutter rolls up with sound ---- */
  function launch() {
    launched = true; clearInterval(timer);
    panel.classList.add('gone');
    soundBtn.classList.add('hide');
    loadSiteBehind();
    initAudio();
    clunk(140, 1, 0.25);                              // latch release
    var start = performance.now(), last = 0, lastRattle = 0;
    function ease(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
    function frame(ts) {
      var x = Math.min(1, (ts - start) / OPEN_MS), p = ease(x);
      var prev = window.__p || 0; window.__p = p;
      var passed = Math.floor(p * N), before = Math.floor(prev * N);
      if (passed > before) { var c = Math.min(passed - before, 4); for (var i = 0; i < c; i++) setTimeout(tick, i * 12); }
      var speed = p - prev;
      if (rumble) rumble.gain.setTargetAtTime(Math.min(1.2, speed * 90), ac.currentTime, 0.05);
      if (speed > 0.0006 && ts - lastRattle > 90) { rattle(Math.min(1.5, speed * 120)); lastRattle = ts; }
      render(p);
      if (x < 1) requestAnimationFrame(frame); else done();
    }
    requestAnimationFrame(frame);
  }
  function done() {
    clunk(70, 1, 0.5);                                // shutter hits the top stop
    shutter.style.display = 'none';
    var go = function () { location.replace('/'); };
    setTimeout(go, 700);
  }

  /* load the real site behind the shutter once the server has opened the gate */
  function loadSiteBehind() {
    var tries = 0;
    (function attempt() {
      fetch('/?launch=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r.text(); })
        .then(function (txt) {
          if (txt.indexOf('name="mg-gate"') !== -1 && tries++ < 20) { setTimeout(attempt, 500); return; }
          if (txt.indexOf('name="mg-gate"') === -1) { site.style.display = 'block'; site.src = '/'; }
        })
        .catch(function () { if (tries++ < 20) setTimeout(attempt, 500); });
    })();
  }
})();
</script>
</body>
</html>`;
