// ============================================================
// WMMC — Pure display, parsing, and escape utilities
// ============================================================

const _ESC_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape a string for safe inclusion in HTML text content or attribute values.
// Use anywhere a user-controlled string (manager/player name, swap reason) is
// interpolated into a template literal that becomes innerHTML.
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => _ESC_HTML[c]);
}

// Escape a string for safe injection inside a single-quoted JS string literal
// (e.g. an inline onclick="fn('${jsStr(name)}')" attribute).
export function jsStr(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

// Coerce a value to a finite number, falling back to 0. Used pervasively by
// the stat-merging pipeline.
export function parseNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// Format a numeric score for the scoreboard. Returns '-' for blank/None,
// integers with locale grouping, decimals with up to 2 fractional digits,
// and a baseball easter-egg for the number 69.
export function fmt(val) {
  if (val == null || val === '' || val === 'None') return '-';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  const str =
    num % 1 === 0
      ? num.toLocaleString()
      : num.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  return Math.floor(num) === 69 ? str + ' ❤️' : str;
}

// Format a value as a decimal stat (allowed to be 0 rather than '-').
export function fmtDec(val) {
  if (val == null || val === '') return '0';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// Up to 2 initials from a manager's name for online-user chips. Returns '?'
// rather than '' when the name is blank so the chip never collapses.
export function getInitials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

// Accent/punctuation/suffix-insensitive form of a player name, for matching
// names across data sources that spell them differently ("Ronald Acuna Jr."
// vs MLB's "Ronald Acuña Jr."). Must stay identical to normalizeName in
// server.js — the server can't import this ESM copy (see CLAUDE.md gotchas).
export function normalizeName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Format a Date object into YYYY-MM-DD using the local timezone.
export function fmtDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
