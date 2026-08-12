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

// Compact display names for a set of managers: first name only, disambiguated with a last
// initial when two of them share a first name ("Ryan S." / "Ryan C."). Slack posts run out
// of line width long before they run out of things to say, and inside a private league of a
// dozen people the first name is the name everyone actually uses.
//
// Returns a { fullName: shortName } map so callers look names up rather than re-deriving
// them per line. A short form that would STILL be ambiguous (two "Ryan S."s) is dropped in
// favor of the full name for both — renaming two people to one label is worse than a long
// line. Must stay identical to shortManagerNames in server.js, which cannot import this
// ESM copy (see CLAUDE.md gotchas).
export function shortManagerNames(names) {
  const list = [...new Set((names || []).filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()))];

  const firstCounts = {};
  for (const full of list) {
    const first = full.split(/\s+/)[0];
    firstCounts[first] = (firstCounts[first] || 0) + 1;
  }

  const draft = {};
  for (const full of list) {
    const parts = full.split(/\s+/);
    const first = parts[0];
    draft[full] = firstCounts[first] > 1 && parts[1] ? `${first} ${parts[1][0]}.` : first;
  }

  const shortCounts = {};
  for (const short of Object.values(draft)) shortCounts[short] = (shortCounts[short] || 0) + 1;

  const out = {};
  for (const [full, short] of Object.entries(draft)) out[full] = shortCounts[short] > 1 ? full : short;
  return out;
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

// Parse a server-stamped timestamp into a Date. The server stamps swap and
// upload-log timestamps in UTC but strips the zone marker ("YYYY-MM-DD HH:MM:SS",
// via toISOString().replace('T',' ').slice(0,19)), which naive new Date() parsing
// would misread as local time. Zone-less strings are therefore interpreted as UTC;
// strings with an explicit zone (Z or ±hh:mm) are honored as-is. Returns null for
// blank, date-only, or unparseable input so callers can fall back to the raw string.
export function parseServerTimestamp(ts) {
  if (!ts) return null;
  let s = String(ts).trim().replace(' ', 'T');
  if (!s.includes('T')) return null; // date-only — no time to convert
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Format a Date object into YYYY-MM-DD using the local timezone.
export function fmtDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
