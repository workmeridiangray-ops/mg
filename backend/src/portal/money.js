// Money: stored as integers in the smallest unit (paise / cents).

export function parseAmount(v) {
  const s = String(v ?? "").replace(/[,\s₹$]/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

export function fmtMoney(minor, currency = "INR", { symbol = true } = {}) {
  const v = (minor || 0) / 100;
  const s = v.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!symbol) return s;
  return (currency === "INR" ? "₹" : currency === "USD" ? "US$" : currency + " ") + s;
}

export function toInput(minor) {
  if (minor == null) return "";
  const v = minor / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function under1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? " " + ONES[r % 10] : ""}`);
  return parts.join(" ");
}
function indianWords(n) {
  if (n === 0) return "Zero";
  const out = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) out.push(`${indianWords(crore)} Crore`);
  if (lakh) out.push(`${under1000(lakh)} Lakh`);
  if (thousand) out.push(`${under1000(thousand)} Thousand`);
  if (n) out.push(under1000(n));
  return out.join(" ");
}
function intlWords(n) {
  if (n === 0) return "Zero";
  const scales = [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"]];
  const out = [];
  for (const [v, w] of scales) if (n >= v) { out.push(`${under1000(Math.floor(n / v))} ${w}`); n %= v; }
  if (n) out.push(under1000(n));
  return out.join(" ");
}
export function amountInWords(minor, currency) {
  const major = Math.floor(minor / 100), cents = minor % 100;
  if (currency === "INR") return `Rupees ${indianWords(major)}${cents ? ` and ${under1000(cents)} Paise` : ""} Only`;
  return `US Dollars ${intlWords(major)}${cents ? ` and ${under1000(cents)} Cents` : ""} Only`;
}

// Supply type decides the tax: same state → CGST+SGST, other state → IGST,
// outside India → export (zero-rated under LUT). Unregistered seller → no GST.
export function supplyType({ sellerRegistered, sellerState, buyerCountry, buyerState }) {
  if (buyerCountry && buyerCountry !== "India") return "export";
  if (!sellerRegistered) return "unregistered";
  return buyerState && sellerState && buyerState === sellerState ? "intra" : "inter";
}

export function computeInvoice(lines, type) {
  let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
  const out = lines.map((l) => {
    const amount = Math.round((l.qty || 0) * (l.rate || 0));
    const rate = type === "intra" || type === "inter" ? l.tax_rate || 0 : 0;
    const tax = Math.round((amount * rate) / 100);
    subtotal += amount;
    if (type === "intra") {
      const half = Math.round(tax / 2);
      cgst += half;
      sgst += tax - half;
    } else if (type === "inter") igst += tax;
    return { ...l, amount, tax_rate: rate };
  });
  return { lines: out, subtotal, cgst, sgst, igst, total: subtotal + cgst + sgst + igst };
}

// Indian financial year label for a YYYY-MM-DD date: 2026-11-21 → "26-27".
export function fyLabel(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}
