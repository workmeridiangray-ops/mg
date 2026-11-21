// Portal UI: one server-rendered layout in the meridiangray.in design language
// (Plus Jakarta Sans, ink on white, #244BDB accent, square corners, hairline
// borders, "— Label" eyebrows, a blue phrase inside each headline). No
// framework and almost no client-side JS: every page is plain HTML + forms.

export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtDate(sec, withTime = false) {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  const opts = { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" };
  if (withTime) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleString("en-IN", opts);
}

export function initials(name, email) {
  const src = (name || email || "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

export const ROLE_LABEL = { owner: "Owner", finance: "Finance", member: "Member" };
export const ROLE_HELP = {
  owner: "Everything, including adding and removing people",
  finance: "Billing and agreements, plus the work",
  member: "The work: projects, meetings, tickets, messages, files",
};

const CSS = `
:root{--ink:#111;--mute:#5B606B;--faint:#8A8F9C;--line:#E2E4EA;--panel:#F5F6F8;--bg:#fff;--aub:#244BDB;--aub-wash:#EEF2FD;--aub-soft:#A9BAF3;--red:#C8102E;--green:#1a7f3c;--amber:#9a6700;
--sans:'Plus Jakarta Sans','Helvetica Neue',Helvetica,Arial,sans-serif;--mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;--ease:cubic-bezier(.22,1,.36,1)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--sans);color:var(--ink);background:var(--bg);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:inherit}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--aub);outline-offset:2px}
.skip{position:absolute;left:-999px}.skip:focus{left:12px;top:12px;background:#fff;padding:8px 12px;z-index:9}
/* shell */
.shell{display:grid;grid-template-columns:248px 1fr;min-height:100vh}
.side{border-right:1px solid var(--line);padding:26px 0 24px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;background:#fff}
.logo{display:flex;flex-direction:column;gap:5px;line-height:1;padding-left:11px;position:relative;margin:0 26px 30px;text-decoration:none}
.logo::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--ink);transform-origin:top;animation:barIn .5s var(--ease) both}
.logo .wm{font-weight:700;font-size:20px;letter-spacing:-.04em}.logo .wm span{color:var(--mute)}.logo .wm i{font-style:normal;color:var(--aub)}
.logo .tag{font-size:7.5px;letter-spacing:.42em;font-weight:500;text-transform:uppercase;color:var(--mute)}
.co{margin:0 18px 18px;padding:12px 14px;border:1px solid var(--line);background:var(--panel)}
.co .lbl{font-size:9.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--mute);font-weight:600}
.co .nm{font-weight:700;font-size:14px;margin-top:4px;letter-spacing:-.01em}
.co select{margin-top:8px;width:100%;font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--line);background:#fff}
.nav{display:flex;flex-direction:column;gap:2px;padding:0 10px}
.nav .grp{font-size:9.5px;letter-spacing:.26em;text-transform:uppercase;color:var(--faint);font-weight:600;padding:16px 16px 6px}
.nav a{display:flex;align-items:center;gap:12px;padding:9px 14px;text-decoration:none;font-size:14px;color:var(--ink);transition:background .2s,color .2s}
.nav a .n{font-family:var(--mono);font-size:10.5px;color:var(--faint);width:18px}
.nav a:hover{background:var(--panel)}
.nav a.on{background:var(--aub);color:#fff}.nav a.on .n{color:var(--aub-soft)}
.nav a.soon{color:var(--faint)}.nav a.soon::after{content:"Soon";margin-left:auto;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);border:1px solid var(--line);padding:2px 6px}
.side-foot{margin-top:auto;padding:16px 24px 0;border-top:1px solid var(--line);font-size:12.5px;color:var(--mute)}
.me{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.av{width:32px;height:32px;display:grid;place-items:center;background:var(--ink);color:#fff;font-size:11.5px;font-weight:700;letter-spacing:.02em;flex:none}
.av.blue{background:var(--aub)}
.me b{display:block;color:var(--ink);font-size:13px;font-weight:600;line-height:1.3}.me small{display:block;font-size:11.5px;word-break:break-all}
.linkbtn{background:none;border:0;padding:0;font:inherit;color:var(--mute);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.linkbtn:hover{color:var(--ink)}
.main{min-width:0}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 44px;border-bottom:1px solid var(--line);min-height:69px}
.crumbs{font-size:12.5px;color:var(--mute)}.crumbs a{text-decoration:none}.crumbs a:hover{color:var(--aub)}.crumbs .sep{margin:0 8px;color:var(--faint)}
.top .menu-btn{display:none}
.wrap{padding:40px 44px 80px;max-width:1180px}
.viewas{background:var(--ink);color:#fff;font-size:13px;padding:10px 44px;display:flex;justify-content:space-between;gap:12px;align-items:center}
.viewas b{color:var(--aub-soft)}.viewas .linkbtn{color:#fff}
/* type */
.eyebrow{display:flex;align-items:center;gap:12px;font-size:12.5px;color:var(--aub);font-weight:500;margin:0 0 14px}
.eyebrow::before{content:"";width:22px;height:1px;background:var(--aub)}
h1{font-size:clamp(30px,3.4vw,44px);line-height:1.06;letter-spacing:-.035em;font-weight:700;margin:0 0 14px}
h1 em,h2 em{font-style:normal;color:var(--aub)}
h2{font-size:21px;letter-spacing:-.025em;margin:0 0 14px;font-weight:700;line-height:1.2}
h3{font-size:15px;margin:0 0 8px;font-weight:700;letter-spacing:-.01em}
.lead{color:var(--mute);font-size:16px;max-width:640px;margin:0 0 30px}
.muted{color:var(--mute)}.small{font-size:13px}.mono{font-family:var(--mono);font-size:12px;letter-spacing:.01em}
.head{animation:fadeUp .6s var(--ease) both}
.head-row{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:28px}
.head-row .lead{margin:0}
/* blocks */
.grid{display:grid;gap:20px}.g2{grid-template-columns:repeat(2,minmax(0,1fr))}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.card{border:1px solid var(--line);background:#fff;padding:24px;animation:fadeUp .6s var(--ease) both}
.card.panel{background:var(--panel)}
.card+.card{margin-top:0}
.sec{margin-top:36px}
.card-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px}
.card-h h2,.card-h h3{margin:0}
.k{font-size:10.5px;letter-spacing:.24em;text-transform:uppercase;font-weight:600;color:var(--mute)}
.stat .v{font-size:30px;font-weight:700;letter-spacing:-.03em;line-height:1.1;margin-top:8px}
.stat .s{font-size:12.5px;color:var(--mute);margin-top:4px}
.empty{border:1px dashed var(--line);padding:26px;text-align:left;color:var(--mute);font-size:14px;background:#fff}
.empty b{color:var(--ink);display:block;margin-bottom:4px;font-size:14.5px}
.rows{border-top:1px solid var(--line)}
.row{display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--line)}
.row .grow{flex:1;min-width:0}.row .grow b{display:block;font-weight:600;font-size:14.5px}.row .grow small{color:var(--mute);font-size:12.5px;word-break:break-all}
/* table */
.tbl{width:100%;border-collapse:collapse;font-size:14px}
.tbl th{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--mute);font-weight:600;text-align:left;padding:10px 12px;border-bottom:1px solid var(--ink)}
.tbl td{padding:14px 12px;border-bottom:1px solid var(--line);vertical-align:top}
.tbl tr.click{cursor:pointer}.tbl tr.click:hover td{background:var(--panel)}
.tbl td a.rowlink{text-decoration:none;font-weight:600}.tbl td a.rowlink:hover{color:var(--aub)}
.tbl-wrap{overflow-x:auto;border:1px solid var(--line);padding:0 8px}
/* badges */
.bdg{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.04em;padding:3px 8px;border:1px solid var(--line);background:#fff;white-space:nowrap}
.bdg::before{content:"";width:6px;height:6px;background:currentColor}
.bdg.blue{color:var(--aub);border-color:var(--aub-soft);background:var(--aub-wash)}
.bdg.green{color:var(--green)}.bdg.red{color:var(--red)}.bdg.grey{color:var(--mute)}.bdg.amber{color:var(--amber)}
.bdg.ink{color:#fff;background:var(--ink);border-color:var(--ink)}.bdg.ink::before{background:var(--aub-soft)}
/* forms */
form.f{display:grid;gap:16px}
.fld{display:grid;gap:6px}
.fld label{font-size:12.5px;font-weight:600}
.fld .hint{font-size:12px;color:var(--mute)}
input[type=text],input[type=email],input[type=tel],input[type=search],select,textarea{font:inherit;font-size:15px;color:var(--ink);background:#fff;border:1px solid #CDD1DA;border-radius:0;padding:11px 13px;width:100%;transition:border-color .2s,box-shadow .2s}
input:focus,select:focus,textarea:focus{border-color:var(--aub);box-shadow:0 0 0 3px var(--aub-wash);outline:none}
textarea{min-height:96px;resize:vertical}
.frow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.frow3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.radios{display:grid;gap:8px}
.radio{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);padding:12px 14px;cursor:pointer;transition:border-color .2s,background .2s}
.radio:hover{border-color:#bfc4cf}.radio input{margin-top:4px;accent-color:var(--aub)}
.radio:has(input:checked){border-color:var(--aub);background:var(--aub-wash)}
.radio b{display:block;font-size:14px}.radio small{color:var(--mute);font-size:12.5px}
.check{display:flex;gap:10px;align-items:center;font-size:14px}.check input{accent-color:var(--aub);width:16px;height:16px}
/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:46px;padding:0 20px;border-radius:0;font:inherit;font-size:14.5px;font-weight:600;border:1px solid var(--ink);background:#fff;color:var(--ink);cursor:pointer;text-decoration:none;transition:background .25s,color .25s,border-color .25s;white-space:nowrap}
.btn:hover{background:var(--ink);color:#fff}
.btn.pri{background:var(--aub);border-color:var(--aub);color:#fff}.btn.pri:hover{background:#1b3cb8;border-color:#1b3cb8}
.btn.sm{min-height:34px;padding:0 13px;font-size:13px}
.btn.danger{color:var(--red);border-color:#e7b3bb}.btn.danger:hover{background:var(--red);color:#fff;border-color:var(--red)}
.btn svg{width:12px;height:12px;transition:transform .3s var(--ease)}.btn:hover svg{transform:translate(2px,-2px)}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
form.inline{display:inline}
/* flash */
.flash{border:1px solid var(--aub-soft);background:var(--aub-wash);color:var(--ink);padding:13px 16px;font-size:14px;margin-bottom:24px;display:flex;gap:10px;animation:fadeUp .5s var(--ease) both}
.flash::before{content:"";width:3px;align-self:stretch;background:var(--aub);flex:none}
.flash.err{border-color:#efc1c8;background:#fdf1f3}.flash.err::before{background:var(--red)}
/* auth pages */
.auth{min-height:100vh;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr)}
.auth-art{background:var(--ink);color:#fff;padding:44px 52px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}
.auth-art .logo::before{background:#fff}.auth-art .logo .wm{color:#fff}.auth-art .logo .wm span{color:#B9BCC6}.auth-art .logo .tag{color:#8A8F9C}
.auth-art h2{font-size:clamp(30px,3.2vw,46px);line-height:1.06;letter-spacing:-.035em;max-width:520px;margin:0}
.auth-art h2 em{color:#9FB4FF;font-style:normal}
.auth-art p{color:#B9BCC6;max-width:440px;margin:18px 0 0}
.auth-art ul{list-style:none;padding:0;margin:28px 0 0;display:grid;gap:10px;color:#D7D9DF;font-size:14px}
.auth-art li{display:flex;gap:12px;align-items:center}.auth-art li::before{content:"";width:6px;height:6px;background:#9FB4FF;flex:none}
.auth-art svg.net{position:absolute;right:-60px;top:40px;width:520px;opacity:.35;pointer-events:none}
.auth-art .foot{font-size:12px;color:#8A8F9C}
.auth-form{display:flex;align-items:center;justify-content:center;padding:44px}
.auth-box{width:100%;max-width:400px;animation:fadeUp .7s var(--ease) .1s both}
.auth-box h1{font-size:34px}
.note{font-size:12.5px;color:var(--mute);margin-top:18px;line-height:1.6}
/* motion */
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes barIn{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes dash{to{stroke-dashoffset:0}}
.net path{stroke-dasharray:6 6;animation:dash 30s linear infinite;stroke-dashoffset:600}
@media (prefers-reduced-motion:reduce){*,*::before{animation:none!important;transition:none!important}}
/* responsive */
@media (max-width:980px){.g3,.g4{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:860px){
 .shell{grid-template-columns:1fr}
 .side{position:fixed;inset:0 auto 0 0;width:280px;z-index:20;transform:translateX(-100%);transition:transform .35s var(--ease);box-shadow:0 0 0 100vmax rgba(17,17,17,0)}
 body.nav-open .side{transform:none;box-shadow:0 0 0 100vmax rgba(17,17,17,.35)}
 .top .menu-btn{display:inline-flex}
 .top,.wrap,.viewas{padding-left:20px;padding-right:20px}
 .wrap{padding-top:28px}
 .g2,.g3,.g4,.frow,.frow3{grid-template-columns:1fr}
 .auth{grid-template-columns:1fr}.auth-art{padding:32px 24px;min-height:auto}.auth-art svg.net{display:none}.auth-art ul,.auth-art .foot{display:none}
 .auth-form{padding:32px 24px}
}
`;

const NET_SVG = `<svg class="net" viewBox="0 0 520 520" aria-hidden="true"><g fill="none" stroke="#9FB4FF" stroke-width="1"><path d="M40 80 C 180 40, 260 200, 420 120"/><path d="M60 260 C 200 220, 300 360, 480 280"/><path d="M30 420 C 180 380, 280 480, 460 420"/><path d="M420 120 L 480 280 L 460 420"/><path d="M40 80 L 60 260 L 30 420"/></g><g fill="#9FB4FF"><rect x="37" y="77" width="6" height="6"/><rect x="417" y="117" width="6" height="6"/><rect x="57" y="257" width="6" height="6"/><rect x="477" y="277" width="6" height="6"/><rect x="27" y="417" width="6" height="6"/><rect x="457" y="417" width="6" height="6"/></g></svg>`;

export const ARROW = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 10 10 2M4 2h6v6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;

function docHead(title, nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#111111"><title>${esc(title)} · Meridian Gray Client Portal</title>
<link rel="icon" href="https://www.meridiangray.in/favicon-32x32.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap"><style nonce="${nonce}">${CSS}</style></head>`;
}

const LOGO = (href = "/") =>
  `<a class="logo" href="${href}" aria-label="Meridian Gray client portal home"><span class="wm">Meridian <span>Gray</span><i>.</i></span><span class="tag">Client portal</span></a>`;

// Public pages (login, check-your-email, verify).
export function authPage({ title, body, nonce }) {
  return `${docHead(title, nonce)}<body><main class="auth">
<section class="auth-art">${NET_SVG}${LOGO("/")}
<div><h2>Everything about our work together, <em>in one place.</em></h2>
<p>Your projects, meetings and minutes, agreements, invoices and requests, kept in one record that both of us can see.</p>
<ul><li>Milestones and deliverables as they move</li><li>Minutes of every meeting, with action items</li><li>Agreements, invoices and payments</li><li>Requests and conversations on the work itself</li></ul></div>
<div class="foot">Meridian Gray · Connected Business Systems · <a href="https://www.meridiangray.in" style="color:#B9BCC6">meridiangray.in</a></div>
</section>
<section class="auth-form"><div class="auth-box">${body}</div></section></main></body></html>`;
}

// Signed-in pages.
export function appPage({ title, nonce, ctx, active, crumbs = [], body, flash }) {
  const { user, company, companies = [], viewAs } = ctx;
  const staffView = user.is_staff && !viewAs;
  const n = (i) => String(i).padStart(2, "0");

  let nav;
  if (staffView) {
    const items = [
      ["admin", "/admin", "Clients"],
      ["log", "/admin/log", "Change log"],
      ["staff", "/admin/staff", "Team"],
    ];
    nav = `<div class="grp">Admin</div>` + items.map(([k, h, l], i) => `<a href="${h}" class="${active === k ? "on" : ""}"><span class="n">${n(i + 1)}</span>${l}</a>`).join("");
  } else {
    const work = [
      ["home", "/", "Home", false],
      ["projects", "/projects", "Projects", true],
      ["meetings", "/meetings", "Meetings", true],
      ["messages", "/messages", "Messages", true],
      ["tickets", "/tickets", "Tickets", true],
      ["files", "/files", "Files", true],
    ];
    const money = [
      ["agreements", "/agreements", "Agreements", true],
      ["billing", "/billing", "Billing", true],
    ];
    const canMoney = viewAs || ["owner", "finance"].includes(ctx.role);
    let i = 0;
    const link = ([k, h, l, soon]) => `<a href="${h}" class="${active === k ? "on" : ""}${soon ? " soon" : ""}"><span class="n">${n(++i)}</span>${l}</a>`;
    nav = `<div class="grp">Work</div>${work.map(link).join("")}`;
    if (canMoney) nav += `<div class="grp">Money</div>${money.map(link).join("")}`;
    nav += `<div class="grp">Account</div>${link(["team", "/team", "Your team", false])}`;
  }

  const coBlock = staffView
    ? `<div class="co"><div class="lbl">Signed in as</div><div class="nm">Meridian Gray team</div></div>`
    : company
      ? `<div class="co"><div class="lbl">Company</div><div class="nm">${esc(company.name)}</div>${
          companies.length > 1 && !viewAs
            ? `<form method="post" action="/switch"><select name="company_id" aria-label="Switch company" data-autosubmit>${companies
                .map((c) => `<option value="${esc(c.id)}"${c.id === company.id ? " selected" : ""}>${esc(c.name)}</option>`)
                .join("")}</select><noscript><button class="btn sm" style="margin-top:6px">Switch</button></noscript></form>`
            : ""
        }</div>`
      : "";

  const crumbHtml = crumbs.length
    ? crumbs.map((c, i) => (c[1] && i < crumbs.length - 1 ? `<a href="${c[1]}">${esc(c[0])}</a>` : `<span>${esc(c[0])}</span>`)).join('<span class="sep">/</span>')
    : "";

  const viewBar = viewAs
    ? `<div class="viewas"><span>You're viewing the portal as <b>${esc(company?.name)}</b> sees it. Nothing you see here is changed by looking.</span><form method="post" action="/admin/view-as/exit" class="inline"><button class="linkbtn">Back to admin</button></form></div>`
    : "";

  const flashHtml = flash ? `<div class="flash${flash.err ? " err" : ""}" role="status">${esc(flash.msg)}</div>` : "";

  return `${docHead(title, nonce)}<body><a class="skip" href="#content">Skip to content</a>
<div class="shell"><aside class="side" id="side">${LOGO(staffView ? "/admin" : "/")}${coBlock}<nav class="nav" aria-label="Portal">${nav}</nav>
<div class="side-foot"><div class="me"><span class="av${user.is_staff ? " blue" : ""}">${esc(initials(user.name, user.email))}</span><span><b>${esc(user.name || "Your account")}</b><small>${esc(user.email)}</small></span></div>
<a href="/account" style="margin-right:14px">Account</a><form method="post" action="/logout" class="inline"><button class="linkbtn">Sign out</button></form></div></aside>
<div class="main">${viewBar}<div class="top"><div class="crumbs">${crumbHtml}</div><button class="btn sm pri menu-btn" type="button" data-menu aria-controls="side" aria-expanded="false">Menu</button></div>
<div class="wrap" id="content">${flashHtml}${body}</div></div></div>
<script nonce="${nonce}">
document.querySelectorAll('[data-autosubmit]').forEach(function(s){s.addEventListener('change',function(){s.form.submit()})});
var mb=document.querySelector('[data-menu]');if(mb){mb.addEventListener('click',function(){var o=document.body.classList.toggle('nav-open');mb.setAttribute('aria-expanded',o)});document.addEventListener('click',function(e){if(document.body.classList.contains('nav-open')&&!e.target.closest('.side')&&!e.target.closest('[data-menu]'))document.body.classList.remove('nav-open')})}
document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!window.confirm(f.getAttribute('data-confirm')))e.preventDefault()})});
document.querySelectorAll('tr[data-href]').forEach(function(r){r.addEventListener('click',function(e){if(!e.target.closest('a,button,form'))location.href=r.getAttribute('data-href')})});
</script></body></html>`;
}

export function pageHead({ eyebrow, title, lead, right = "" }) {
  return `<div class="head head-row"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ""}</div>${right ? `<div class="actions">${right}</div>` : ""}</div>`;
}

export function roleBadge(role) {
  const cls = role === "owner" ? "ink" : role === "finance" ? "blue" : "grey";
  return `<span class="bdg ${cls}">${esc(ROLE_LABEL[role] || role)}</span>`;
}

export function roleRadios(name, current = "member") {
  return `<div class="radios">${["owner", "finance", "member"]
    .map(
      (r) =>
        `<label class="radio"><input type="radio" name="${name}" value="${r}"${current === r ? " checked" : ""}><span><b>${ROLE_LABEL[r]}</b><small>${ROLE_HELP[r]}</small></span></label>`
    )
    .join("")}</div>`;
}
