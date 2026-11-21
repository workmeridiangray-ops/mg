// Portal schema (D1, same meridiangray-db as the website backend). Every
// table is prefixed portal_ so it never collides with the website's tables,
// and every client-owned row carries company_id so queries can always be
// scoped to the signed-in client's company.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS portal_companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    legal_name TEXT,
    gstin TEXT,
    pan TEXT,
    billing_address TEXT,
    city TEXT,
    state TEXT,
    country TEXT NOT NULL DEFAULT 'India',
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS portal_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    phone TEXT,
    title TEXT,
    is_staff INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS portal_memberships (
    user_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at INTEGER NOT NULL,
    invited_by TEXT,
    PRIMARY KEY (user_id, company_id)
  )`,
  `CREATE INDEX IF NOT EXISTS portal_memberships_company ON portal_memberships(company_id)`,
  `CREATE TABLE IF NOT EXISTS portal_login_tokens (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    ip TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS portal_login_tokens_email ON portal_login_tokens(email, created_at)`,
  `CREATE TABLE IF NOT EXISTS portal_sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    company_id TEXT,
    view_as_company_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip TEXT,
    ua TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS portal_sessions_user ON portal_sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS portal_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor_user_id TEXT,
    actor_email TEXT,
    actor_is_staff INTEGER NOT NULL DEFAULT 0,
    company_id TEXT,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT,
    ip TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS portal_audit_company ON portal_audit_log(company_id, at)`,

  // ---- Phase 2: meetings, minutes (MoM), action items, messages ----
  `CREATE TABLE IF NOT EXISTS portal_meetings (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    title TEXT NOT NULL,
    starts_at INTEGER,
    duration_min INTEGER NOT NULL DEFAULT 45,
    meet_url TEXT,
    gcal_event_id TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',
    request_note TEXT,
    requested_by TEXT,
    cancel_reason TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS portal_meetings_company ON portal_meetings(company_id, starts_at)`,
  `CREATE TABLE IF NOT EXISTS portal_agenda_items (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    text TEXT NOT NULL,
    author_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS portal_agenda_meeting ON portal_agenda_items(meeting_id)`,
  `CREATE TABLE IF NOT EXISTS portal_minutes (
    meeting_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    attendees TEXT,
    summary TEXT,
    decisions TEXT,
    next_steps TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    revision INTEGER NOT NULL DEFAULT 0,
    published_at INTEGER,
    published_by TEXT,
    confirm_due_at INTEGER,
    confirmed_at INTEGER,
    confirmed_by TEXT,
    confirmed_auto INTEGER NOT NULL DEFAULT 0,
    correction_note TEXT,
    correction_by TEXT,
    correction_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS portal_minutes_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    published_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS portal_action_items (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    meeting_id TEXT,
    text TEXT NOT NULL,
    owner_side TEXT NOT NULL DEFAULT 'client',
    owner_name TEXT,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    published INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    done_at INTEGER,
    done_by TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS portal_actions_company ON portal_action_items(company_id, status)`,
  `CREATE TABLE IF NOT EXISTS portal_threads (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    meeting_id TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL,
    last_author_id TEXT,
    last_author_staff INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS portal_threads_company ON portal_threads(company_id, last_message_at)`,
  `CREATE TABLE IF NOT EXISTS portal_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_staff INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS portal_messages_thread ON portal_messages(thread_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS portal_reads (
    user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    last_read_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, thread_id)
  )`,
];

let ready = false;
export async function ensureSchema(env) {
  if (ready) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  ready = true;
}

export const now = () => Math.floor(Date.now() / 1000);

const ALPHA = "abcdefghijkmnpqrstuvwxyz23456789";
export function newId(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(14));
  let s = "";
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return `${prefix}_${s}`;
}

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}

export function isEmail(s) {
  return typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export async function audit(env, ctxOrActor, { companyId = null, action, summary, detail = null, ip = null }) {
  const u = ctxOrActor?.user || ctxOrActor || {};
  try {
    await env.DB.prepare(
      `INSERT INTO portal_audit_log (at, actor_user_id, actor_email, actor_is_staff, company_id, action, summary, detail, ip)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
      .bind(now(), u.id || null, u.email || null, u.is_staff ? 1 : 0, companyId, action, summary, detail ? JSON.stringify(detail) : null, ip)
      .run();
  } catch (e) {
    console.log("audit failed:", e && e.message);
  }
}

// Indian states and UTs, for place of supply (CGST+SGST vs IGST) later.
export const IN_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir",
  "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
  "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal",
];
