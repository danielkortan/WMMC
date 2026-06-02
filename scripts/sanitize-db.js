#!/usr/bin/env node
/**
 * Sanitize db.json into a committable test fixture.
 *
 * Strips every password and pseudonymizes every email address while keeping
 * referential integrity (a manager's email still matches the same email on
 * their swaps/audit entries). The rest of the league data — rosters,
 * roster_dates, swaps, weekly/daily stats — is left intact so it can be used
 * for troubleshooting and unit tests.
 *
 * Usage:
 *   node scripts/sanitize-db.js [input] [output]
 *   npm run sanitize:db
 *
 * Defaults:
 *   input  = ./db.json
 *   output = ./tests/fixtures/db.sample.json
 *
 * NEVER commit the raw db.json — it contains passwords (it is gitignored for
 * that reason). Commit only the sanitized output this script produces.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/sanitize-db.js [input=db.json] [output=tests/fixtures/db.sample.json]');
  process.exit(0);
}

const inputPath = process.argv[2] || path.join(ROOT, 'db.json');
const outputPath = process.argv[3] || path.join(ROOT, 'tests', 'fixtures', 'db.sample.json');

if (!fs.existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  console.error('Run this from a machine that has a real db.json (e.g. your Render disk or local server).');
  process.exit(1);
}

let db;
try {
  db = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (e) {
  console.error(`Could not parse ${inputPath}: ${e.message}`);
  process.exit(1);
}

// Matches an email anywhere inside a string (handles standalone fields and
// emails embedded in audit/detail strings).
const EMAIL_RE = /[^\s@<>()[\]"',;]+@[^\s@<>()[\]"',;]+\.[^\s@<>()[\]"',;]+/g;

// Stable real-email -> fake-email map. Manager emails get a readable pseudonym
// derived from the manager name; any other address falls back to userN@example.com.
const emailMap = new Map();
let unknownCount = 0;

const slug = (name) =>
  String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '.') || 'manager';

(db.managers || []).forEach((m) => {
  if (m && typeof m.email === 'string' && m.email.includes('@')) {
    const key = m.email.toLowerCase();
    if (!emailMap.has(key)) emailMap.set(key, `${slug(m.name)}@example.com`);
  }
});

function fakeEmail(real) {
  const key = String(real).toLowerCase();
  if (!emailMap.has(key)) {
    unknownCount += 1;
    emailMap.set(key, `user${unknownCount}@example.com`);
  }
  return emailMap.get(key);
}

let passwordsRemoved = 0;
let emailsRewritten = 0;

// Recursively drop any `password` key and pseudonymize any email-looking text.
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'password') {
        passwordsRemoved += 1;
        continue;
      }
      out[k] = sanitize(v);
    }
    return out;
  }
  if (typeof value === 'string' && value.includes('@')) {
    return value.replace(EMAIL_RE, (m) => {
      emailsRewritten += 1;
      return fakeEmail(m);
    });
  }
  return value;
}

const clean = sanitize(db);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(clean, null, 2) + '\n');

console.log(`Sanitized ${inputPath} -> ${outputPath}`);
console.log(`  passwords removed:    ${passwordsRemoved}`);
console.log(`  emails pseudonymized: ${emailsRewritten} occurrence(s), ${emailMap.size} unique address(es)`);
