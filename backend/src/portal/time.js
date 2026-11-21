// Meeting times are entered and shown in IST. Pages also add the viewer's own
// local time beside it (small script in ui.js) for overseas clients.

const IST_OFFSET = 330 * 60; // seconds

export function parseIST(dateStr, timeStr) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ""));
  if (!d || !t) return null;
  const ms = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000) - IST_OFFSET;
}

export function istParts(ts) {
  const d = new Date((ts + IST_OFFSET) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
}

export function fmtWhen(ts, { short = false } = {}) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const day = d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: short ? undefined : "numeric", timeZone: "Asia/Kolkata" });
  const tm = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  return `${day} · ${tm} IST`;
}

export function fmtDay(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function todayIST() {
  return istParts(Math.floor(Date.now() / 1000)).date;
}

export function relTime(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}
