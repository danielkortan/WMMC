const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
// DB_PATH env var lets Render point db.json to a persistent disk mount (/var/data/db.json)
// while local dev keeps it in the project directory.
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'db.json');
// Committed seed file — persists manager identity (name/email/role) across fresh deploys.
// Passwords are never stored here; they live only in db.json so git pulls can't reset them.
const MANAGERS_SEED_FILE = path.join(__dirname, 'managers_seed.json');
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'Welcome2Hell';

// Upstash Redis REST — optional durable backup for db.json across Render ephemeral deploys.
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Render env vars to enable.
//
// IMPORTANT: this backs up the ENTIRE db.json as a single Upstash value. Upstash's REST /set
// rejects payloads over its request-size limit (~1 MB on the free tier), and a full season of
// per-game daily records pushes db.json well past that (multiple MB). So for this league the
// PRIMARY durable store is the Render persistent disk (render.yaml `disk:` + DB_PATH=/var/data),
// NOT Upstash — leaving Upstash unset is intentional. Do not enable it expecting a working
// backup unless the payload is first slimmed (e.g. back up weekly rollups only). saveToUpstash
// surfaces failures (size/status) rather than swallowing them, and the 4am sync awaits + alerts.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UPSTASH_KEY = 'wmmc_db';
// Dated, auto-expiring backup keys (wmmc_db_bak_YYYY-MM-DD) give a rolling history of restore
// points — the primary UPSTASH_KEY is overwritten on every save and keeps none. ~14 days.
const DB_BACKUP_TTL_SECONDS = 14 * 24 * 60 * 60;

// General notifications webhook (roster swaps, sync errors, etc.)
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
// Scoreboard-specific webhook — can point to a different channel than notifications.
// Falls back to SLACK_WEBHOOK_URL if not set.
const SLACK_SCOREBOARD_WEBHOOK_URL = process.env.SLACK_SCOREBOARD_WEBHOOK_URL || SLACK_WEBHOOK_URL;
// Signing secret from your Slack app — used to verify slash command requests.
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';

// Google Sign-In — set GOOGLE_CLIENT_ID to the OAuth 2.0 *Web application* client
// ID from your Google Cloud project to enable "Sign in with Google" on the login
// page. The client ID is not a secret (it ships to the browser). Leaving it unset
// keeps Google login hidden; email/password login always works regardless.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// Anthropic API — set ANTHROPIC_API_KEY to enable AI-generated elimination roasts.
// If unset, roasts fall back to a static message.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

async function postSlack(text, blocks) {
  if (!SLACK_WEBHOOK_URL) return;
  const body = blocks ? { text, blocks } : { text };
  await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postScoreboardSlack(db, year) {
  if (!SLACK_SCOREBOARD_WEBHOOK_URL) return;
  const { blocks, text } = buildScoreboardBlocks(db, year);
  await fetch(SLACK_SCOREBOARD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, blocks }),
  });
}

// Unique token generated every time the server starts. Appended to asset URLs
// so that browsers (especially mobile) always fetch fresh JS/CSS after a deploy.
const ASSET_VERSION = Date.now();

// 10mb body limit — generous enough for banner-config base64 images and full
// season payloads, but bounded so a malicious client can't OOM the process.
app.use(express.json({ limit: '10mb' }));

// ============================================================
// Security middleware
// ============================================================

// Simple rate limiter — covers all mutating verbs (POST/PUT/PATCH/DELETE).
// Read-only GETs are not rate limited so dashboard refreshes don't trip it.
const rateLimits = new Map();
const RATE_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_MAX_REQUESTS = 60;
const RATE_LIMITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function rateLimit(req, res, next) {
  if (!RATE_LIMITED_METHODS.has(req.method)) return next();
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    rateLimits.set(ip, { start: now, count: 1 });
  } else {
    entry.count++;
    if (entry.count > RATE_MAX_REQUESTS) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
  }
  next();
}

// Periodically evict stale entries so the Map can't grow unbounded.
setInterval(
  () => {
    const cutoff = Date.now() - RATE_WINDOW_MS * 2;
    for (const [ip, entry] of rateLimits) {
      if (entry.start < cutoff) rateLimits.delete(ip);
    }
  },
  5 * 60 * 1000
).unref();

app.use(rateLimit);

// Security headers
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ============================================================
// Auth middleware
// ============================================================
// Authenticated routes look for X-User-Email + X-User-Password headers, set by
// the client's apiFetch() helper after a successful /api/login. Both are
// re-verified against db.json on every request — there is no server-side
// session store, so a stolen token has no value beyond the password it carries.

function loadManagerFromHeaders(req) {
  const email = (req.get('X-User-Email') || '').toLowerCase();
  const password = req.get('X-User-Password') || '';
  if (!email || !password) return null;
  const db = readDB();
  const manager = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === email);
  if (!manager) return null;
  // The X-User-Password header carries either the login password OR a per-manager
  // auth token issued after Google sign-in (see /api/auth/google). Either proves
  // identity — there is no session store, so both are re-verified on every request.
  const expected = manager.password || LOGIN_PASSWORD;
  const tokenMatch = !!manager.authToken && password === manager.authToken;
  if (password !== expected && !tokenMatch) return null;
  return manager;
}

function requireAuth(req, res, next) {
  const manager = loadManagerFromHeaders(req);
  if (!manager) return res.status(401).json({ error: 'Authentication required' });
  if (manager.active === false) {
    return res.status(403).json({ error: 'Account is inactive' });
  }
  req.manager = manager;
  next();
}

function requireCommissioner(req, res, next) {
  const manager = loadManagerFromHeaders(req);
  if (!manager) return res.status(401).json({ error: 'Authentication required' });
  if (!manager.commissioner) {
    return res.status(403).json({ error: 'Commissioner access required' });
  }
  req.manager = manager;
  next();
}

// ============================================================
// Static file serving
// ============================================================

// Serve index.html through a dedicated route so we can inject the dynamic
// version stamp and set aggressive no-cache headers that cannot be overridden.
app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/\?v=\d+/g, '?v=' + ASSET_VERSION);
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('html').send(html);
});

// Serve remaining static files (js/, css/, data.json, etc.)
app.use(
  express.static(__dirname, {
    index: false, // index.html is handled by the route above
    setHeaders(res, filePath) {
      if (/\.(js|css|json)$/i.test(filePath)) {
        res.set('Cache-Control', 'public, max-age=300, must-revalidate');
      }
    },
  })
);

// ============================================================
// Database helpers
// ============================================================

// ============================================================
// Upstash Redis helpers — durable db.json persistence
// ============================================================

async function loadFromUpstash() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const resp = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!resp.ok) return null;
    const { result } = await resp.json();
    return result ? JSON.parse(result) : null;
  } catch (e) {
    console.error('[Upstash] Load failed:', e.message);
    return null;
  }
}

async function saveToUpstash(data) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return { ok: false, skipped: true };
  const body = JSON.stringify(JSON.stringify(data));
  try {
    const resp = await fetch(`${UPSTASH_URL}/set/${UPSTASH_KEY}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error('[Upstash] Save error:', resp.status, `(${body.length} bytes)`, text.slice(0, 200));
      return { ok: false, status: resp.status, bytes: body.length, error: text.slice(0, 200) };
    }
    return { ok: true, status: resp.status, bytes: body.length };
  } catch (e) {
    console.error('[Upstash] Save failed:', `(${body.length} bytes)`, e.message);
    return { ok: false, bytes: body.length, error: e.message };
  }
}

// Write a dated, auto-expiring snapshot of the DB under wmmc_db_bak_<YYYY-MM-DD>. Unlike the
// live UPSTASH_KEY (overwritten on every save, no history), these rotate themselves via EX and
// give ~2 weeks of daily restore points — so a bad write or boot migration is recoverable
// instead of lost. Called on boot, capturing the as-restored (pre-migration) state.
async function saveTimestampedBackup(data) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return { ok: false, skipped: true };
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD; later deploys refresh same-day key
  const key = `${UPSTASH_KEY}_bak_${dateKey}`;
  const body = JSON.stringify(JSON.stringify(data));
  try {
    const resp = await fetch(`${UPSTASH_URL}/set/${key}?EX=${DB_BACKUP_TTL_SECONDS}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!resp.ok) {
      console.error('[Upstash] Backup save error:', resp.status, `(${body.length} bytes)`);
      return { ok: false, status: resp.status };
    }
    return { ok: true, key };
  } catch (e) {
    console.error('[Upstash] Backup save failed:', `(${body.length} bytes)`, e.message);
    return { ok: false, error: e.message };
  }
}

// Roster/manager integrity audit (SAVE_HARDENING_PLAN.md, Layer 4). Enforces the core invariant:
// managers come only from db.managers (the commissioner source of truth) and players enter rosters
// only via a submission or an approved swap, stamped with a date + period. Read-only classifier;
// it distinguishes GENUINE problems from a known-benign case so it never cries wolf:
//   - unknownManagers: a name referenced in rosters/roster_dates/stat rows/swaps/submissions that
//     is NOT in db.managers.
//   - ghosts: a rostered player (in roster_dates) with no submission origin AND no swap in/out —
//     truly no provenance.
//   - swapInNoAdd: a swap player_in (not in any submission) with zero add_dates across roster_dates
//     — would score from the week start instead of the add date (a real mis-score).
//   - cosmetic (NOT a problem): an original-draft player dropped early who isn't recorded in
//     initial_submissions (adds:0, has a drop, is a swap player_out). Scores correctly from the
//     period start to the drop; only the origin record is incomplete.
function auditRosterIntegrity(db, sd) {
  const canon = new Set(((db && db.managers) || []).map((m) => m.name));
  const approved = ((sd && sd.swaps) || []).filter((s) => s.status === 'approved');

  const referenced = new Set();
  Object.keys(sd.rosters || {}).forEach((m) => referenced.add(m));
  Object.keys(sd.roster_dates || {}).forEach((m) => referenced.add(m));
  (sd.weekly_batting || []).forEach((r) => r.manager && referenced.add(r.manager));
  (sd.weekly_pitching || []).forEach((r) => r.manager && referenced.add(r.manager));
  approved.forEach((s) => s.manager && referenced.add(s.manager));
  Object.keys(sd.initial_submissions || {}).forEach((m) => referenced.add(m));
  Object.values(sd.period_submissions || {}).forEach((b) => Object.keys(b || {}).forEach((m) => referenced.add(m)));
  const unknownManagers = [...referenced].filter((m) => !canon.has(m));

  const submittedPlayers = (mgr) => {
    const set = new Set();
    const init = (sd.initial_submissions || {})[mgr];
    if (init) {
      (init.batters || []).forEach((p) => set.add(p));
      (init.pitchers || []).forEach((p) => set.add(p));
    }
    Object.values(sd.period_submissions || {}).forEach((b) => {
      const s = (b || {})[mgr];
      if (s) {
        (s.batters || []).forEach((p) => set.add(p));
        (s.pitchers || []).forEach((p) => set.add(p));
      }
    });
    return set;
  };

  const ghosts = [];
  const swapInNoAdd = [];
  const cosmetic = [];
  for (const [mgr, weeks] of Object.entries(sd.roster_dates || {})) {
    const sub = submittedPlayers(mgr);
    const agg = {};
    for (const players of Object.values(weeks || {})) {
      for (const [p, d] of Object.entries(players || {})) {
        if (!agg[p]) agg[p] = { adds: 0, drops: 0 };
        if (d && d.add_date) agg[p].adds++;
        if (d && d.drop_date) agg[p].drops++;
      }
    }
    for (const [p, a] of Object.entries(agg)) {
      const inSub = sub.has(p);
      const sIn = approved.some((s) => s.manager === mgr && s.player_in === p);
      const sOut = approved.some((s) => s.manager === mgr && s.player_out === p);
      if (!inSub && !sIn && !sOut) ghosts.push({ manager: mgr, player: p });
      else if (sIn && !inSub && a.adds === 0) swapInNoAdd.push({ manager: mgr, player: p });
      else if (!inSub && sOut && !sIn) cosmetic.push({ manager: mgr, player: p });
    }
  }
  return { unknownManagers, ghosts, swapInNoAdd, cosmetic };
}

// Boot-time data-integrity audit. The schedule_dates wipe was invisible for hours because
// nothing watched for it; this surfaces that class of silent corruption by logging and posting
// a Slack alert when an active season is missing data its scoring depends on. Detection only —
// it never mutates state.
async function auditSeasonIntegrity(db) {
  const problems = [];
  for (const [year, sd] of Object.entries((db && db.seasons) || {})) {
    if (!sd || sd.status !== 'active') continue;
    const schedLen = Array.isArray(sd.schedule_dates) ? sd.schedule_dates.length : 0;
    if (schedLen < 16) {
      problems.push(`${year}: schedule_dates has ${schedLen}/16 weeks — every add/drop scoring window is disabled.`);
    }
    if (!Array.isArray(sd.score_snapshots) || sd.score_snapshots.length === 0) {
      problems.push(`${year}: no score-guard snapshots stored — swing detection is blind.`);
    }
    // An empty rosters object while stats exist means manager attribution has been wiped (e.g. a
    // stale full-season save). Standings limp along on roster_dates carry-forward, but the next
    // rebuildWeeklyFromDaily re-credits every row through the empty arrays and zeroes the board.
    const rosterMgrs = sd.rosters && typeof sd.rosters === 'object' ? Object.keys(sd.rosters).length : 0;
    const hasWeeklyStats =
      (Array.isArray(sd.weekly_batting) && sd.weekly_batting.length > 0) ||
      (Array.isArray(sd.weekly_pitching) && sd.weekly_pitching.length > 0);
    if (rosterMgrs === 0 && hasWeeklyStats) {
      problems.push(
        `${year}: rosters object is empty while weekly stats exist — manager attribution is wiped; ` +
          `the next stat compile will zero the scoreboard. Recover with POST /api/seasons/${year}/reconstruct-rosters.`
      );
    }
    // Roster/manager provenance (Layer 4). Alarm only on GENUINE problems — never the benign
    // cosmetic case (dropped original-draft players missing from initial_submissions).
    const ri = auditRosterIntegrity(db, sd);
    if (ri.unknownManagers.length) {
      problems.push(
        `${year}: ${ri.unknownManagers.length} manager(s) referenced but not in db.managers: ${ri.unknownManagers.join(', ')}.`
      );
    }
    if (ri.ghosts.length) {
      problems.push(
        `${year}: ${ri.ghosts.length} rostered player(s) with no submission/swap origin (ghosts): ` +
          `${ri.ghosts.map((g) => `${g.player} (${g.manager})`).join(', ')}.`
      );
    }
    if (ri.swapInNoAdd.length) {
      problems.push(
        `${year}: ${ri.swapInNoAdd.length} swapped-in player(s) missing an add_date (will mis-score from the week start): ` +
          `${ri.swapInNoAdd.map((g) => `${g.player} (${g.manager})`).join(', ')}.`
      );
    }
  }
  if (problems.length === 0) return;
  console.error('[Integrity]', problems.join(' | '));
  try {
    await postSlack(':rotating_light: *WMMC integrity check found issues at startup:*\n• ' + problems.join('\n• '));
  } catch (e) {
    console.error('[Integrity] Slack alert failed:', e.message);
  }
}

// Pre-commit integrity guard for the full-season save (SAVE_HARDENING_PLAN.md, Layer 3). Compares
// the candidate season against the stored one and flags DESTRUCTIVE changes a stale full-season
// overwrite would otherwise apply silently: a roster/attribution wipe, a vanished manager, lost
// roster_dates/swaps, or a manager's total cratering. Detection only — the caller blocks. This is
// the backstop that catches the next not-yet-guarded field the way the rosters wipe slipped past
// the per-field guards. `captureScoreSnapshot` is hoisted (declared below).
function assessSeasonWriteIntegrity(existingSd, candidateSd) {
  const reasons = [];
  if (!existingSd) return { destructive: false, reasons };
  const objCount = (o) => (o && typeof o === 'object' ? Object.keys(o).length : 0);
  const mgrCount = (sd) => objCount(sd && sd.rosters);
  const rdCount = (sd) => objCount(sd && sd.roster_dates);
  const swapCount = (sd) => ((sd && sd.swaps) || []).filter((s) => s.status === 'approved').length;

  const exMgrs = mgrCount(existingSd);
  const caMgrs = mgrCount(candidateSd);
  if (exMgrs > 0 && caMgrs === 0) reasons.push(`rosters wiped (managers ${exMgrs} → 0)`);
  else if (caMgrs < exMgrs) reasons.push(`rosters lost ${exMgrs - caMgrs} manager(s) (${exMgrs} → ${caMgrs})`);

  const exRd = rdCount(existingSd);
  const caRd = rdCount(candidateSd);
  if (exRd > 0 && caRd < exRd) reasons.push(`roster_dates lost ${exRd - caRd} manager(s) (${exRd} → ${caRd})`);

  const exSw = swapCount(existingSd);
  const caSw = swapCount(candidateSd);
  if (exSw > 0 && caSw < exSw) reasons.push(`approved swaps dropped ${exSw - caSw} (${exSw} → ${caSw})`);

  // Structural: catch a stale clobber that strips players without the matching swap, even when the
  // score swing is under 40. A legit swap is net-zero on a week's roster and a single add/drop is
  // ±1, so a week's batter or pitcher list shrinking by more than MAX_WEEK_ROSTER_SHRINK — or a
  // populated week disappearing entirely — signals a stale/partial overwrite. (Comparison runs
  // after the save's roster_dates heal, so unchanged rosters compare equal.)
  const MAX_WEEK_ROSTER_SHRINK = 1;
  const exRosters = existingSd.rosters && typeof existingSd.rosters === 'object' ? existingSd.rosters : {};
  const caRosters = candidateSd.rosters && typeof candidateSd.rosters === 'object' ? candidateSd.rosters : {};
  for (const [mgr, weeks] of Object.entries(exRosters)) {
    if (!weeks || typeof weeks !== 'object') continue;
    const caWeeks = caRosters[mgr] && typeof caRosters[mgr] === 'object' ? caRosters[mgr] : {};
    for (const [wk, wr] of Object.entries(weeks)) {
      if (!wr || typeof wr !== 'object') continue;
      const exB = Array.isArray(wr.batters) ? wr.batters.length : 0;
      const exP = Array.isArray(wr.pitchers) ? wr.pitchers.length : 0;
      const cw = caWeeks[wk] || {};
      const caB = Array.isArray(cw.batters) ? cw.batters.length : 0;
      const caP = Array.isArray(cw.pitchers) ? cw.pitchers.length : 0;
      if (exB - caB > MAX_WEEK_ROSTER_SHRINK || exP - caP > MAX_WEEK_ROSTER_SHRINK) {
        reasons.push(`${mgr} ${wk} roster shrank (B ${exB}→${caB}, P ${exP}→${caP})`);
      }
    }
  }

  // Per-manager total swing — reuse the score-guard 40-pt threshold for a destructive DROP. A
  // normal roster edit (a swap, an add/drop) never craters a cumulative total by 40+.
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const before = captureScoreSnapshot(existingSd, todayET).totals;
    const after = captureScoreSnapshot(candidateSd, todayET).totals;
    for (const m of Object.keys(before)) {
      const b = (before[m] || {}).total || 0;
      const a = (after[m] || {}).total || 0;
      if (b - a >= 40) reasons.push(`${m} total drops ${Math.round((b - a) * 10) / 10} (${b} → ${a})`);
    }
  } catch (e) {
    // A snapshot failure must not block a legitimate save — log and skip the score check.
    console.error('[Save guard] integrity snapshot error (continuing):', e.message);
  }

  return { destructive: reasons.length > 0, reasons };
}

function readManagersSeed() {
  try {
    if (fs.existsSync(MANAGERS_SEED_FILE)) {
      return JSON.parse(fs.readFileSync(MANAGERS_SEED_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading managers_seed.json:', e.message);
  }
  return [];
}

// Format a pool value as a label without doubling "Pool" (manager records use a
// bare pool like "1"/"A", but some data has the full "Pool 1"). Mirrors the
// client-side formatPool() in app.js.
function formatPool(pool) {
  if (pool === null || pool === undefined || pool === '') return '';
  const s = String(pool).trim();
  return /^pool\b/i.test(s) ? s : `Pool ${s}`;
}

function writeManagersSeed(managers) {
  try {
    // Strip credentials (password + Google auth token) — they belong in db.json
    // only, never in the git-committed seed file.
    const seedRecords = managers.map(({ password: _password, authToken: _authToken, ...rest }) => rest);
    fs.writeFileSync(MANAGERS_SEED_FILE, JSON.stringify(seedRecords, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing managers_seed.json:', e.message);
  }
}

function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // If db.json has no managers, seed from the committed managers_seed.json
      if (!db.managers || db.managers.length === 0) {
        db.managers = readManagersSeed();
      }
      return db;
    }
  } catch (e) {
    console.error('Error reading db.json:', e.message);
  }
  // No db.json — build fresh state seeded from managers_seed.json
  return { seasons: {}, managers: readManagersSeed(), audit_log: [] };
}

function writeDB(data, opts = {}) {
  // Stamp every write so startup can tell whether the local disk copy or the
  // Upstash backup is newer (prevents a stale backup from clobbering good data).
  data.last_saved_at = new Date().toISOString();
  // Atomic write: serialize to a temp file, fsync it to disk, then rename over the live file.
  // rename(2) is atomic on the same filesystem, so a crash/restart mid-write can never leave a
  // truncated or corrupt db.json — the previous good file stays intact until the new one is
  // fully durable. (Plain writeFileSync onto db.json leaves a corruption window.)
  const json = JSON.stringify(data, null, 2);
  const tmp = `${DB_FILE}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DB_FILE);
  // Back up to Upstash so data survives Render's ephemeral filesystem. By default this is
  // fire-and-forget, but unattended/critical writes (the 4am sync, manual backfills) pass
  // { awaitBackup: true } and await the returned promise so the write can't be lost if the
  // instance is reclaimed (spin-down) before the backup completes.
  const backup = saveToUpstash(data);
  if (opts.awaitBackup) return backup;
  backup.catch((e) => console.error('[Upstash] Background save failed:', e.message));
}

// ============================================================
// Audit log helpers
// ============================================================

const MAX_AUDIT_ENTRIES = 500;

function addAuditEntry(db, action, details, email) {
  if (!db.audit_log) db.audit_log = [];
  db.audit_log.unshift({
    timestamp: new Date().toISOString(),
    action,
    details,
    email: email || 'system',
  });
  // Prune to max entries
  if (db.audit_log.length > MAX_AUDIT_ENTRIES) {
    db.audit_log = db.audit_log.slice(0, MAX_AUDIT_ENTRIES);
  }
}

// ============================================================
// Input validation helpers
// ============================================================

function isValidYear(year) {
  const n = parseInt(year, 10);
  return !isNaN(n) && n >= 2000 && n <= 2100;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, 500);
}

// ============================================================
// Authentication endpoint
// ============================================================

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const db = readDB();
  const managers = db.managers || [];
  const manager = managers.find((m) => m.email && m.email.toLowerCase() === email.toLowerCase());

  if (!manager) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Check manager-specific password first, then global password
  const expectedPassword = manager.password || LOGIN_PASSWORD;
  if (password !== expectedPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  addAuditEntry(db, 'login', { email: manager.email }, manager.email);
  writeDB(db);

  res.json({
    ok: true,
    manager: { name: manager.name, email: manager.email, commissioner: manager.commissioner || false },
  });
});

// ============================================================
// Google Sign-In
// ============================================================
// Verifies a Google ID token (JWT) using only Node's built-in crypto — no
// external dependency. Fetches Google's published RSA public keys (JWKS),
// caches them per Google's Cache-Control, verifies the RS256 signature, then
// checks the standard claims (issuer, audience, expiry, email_verified).

let googleCertsCache = { keys: null, expiresAt: 0 };

async function getGoogleCerts() {
  const now = Date.now();
  if (googleCertsCache.keys && now < googleCertsCache.expiresAt) {
    return googleCertsCache.keys;
  }
  const resp = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!resp.ok) throw new Error(`Failed to fetch Google certs: ${resp.status}`);
  const data = await resp.json();
  // Honor max-age so we refresh when Google rotates its signing keys.
  let maxAge = 3600;
  const m = (resp.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  if (m) maxAge = parseInt(m[1], 10);
  googleCertsCache = { keys: data.keys || [], expiresAt: now + maxAge * 1000 };
  return googleCertsCache.keys;
}

function base64urlToBuffer(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not configured');
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new Error('Malformed token');
  }
  const [headerB64, payloadB64, sigB64] = idToken.split('.');
  const header = JSON.parse(base64urlToBuffer(headerB64).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');

  const certs = await getGoogleCerts();
  const jwk = certs.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('No matching Google signing key');

  const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  if (!verifier.verify(pubKey, base64urlToBuffer(sigB64))) {
    throw new Error('Invalid token signature');
  }

  const payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
  const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
  if (!validIssuers.includes(payload.iss)) throw new Error('Invalid token issuer');
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('Token audience mismatch');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('Token expired');
  if (!payload.email || payload.email_verified !== true) {
    throw new Error('Google account email is not verified');
  }
  return payload;
}

// GET /api/auth/config — public. Tells the client whether Google sign-in is on,
// and the (non-secret) client ID needed to render the Google button.
app.get('/api/auth/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// POST /api/auth/google — verify a Google ID token and log the user in.
// The Google account's verified email is matched directly to a league manager.
app.post('/api/auth/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(404).json({ error: 'Google sign-in is not enabled' });
  }
  const { credential } = req.body || {};
  if (!credential) {
    return res.status(400).json({ error: 'Missing Google credential' });
  }

  let payload;
  try {
    payload = await verifyGoogleIdToken(credential);
  } catch (e) {
    console.error('Google token verification failed:', e.message);
    return res.status(401).json({ error: 'Google sign-in could not be verified' });
  }

  const email = payload.email.toLowerCase();
  const db = readDB();
  // Match the Google account to a manager by their configured Google email,
  // falling back to the league email when none is set. Commissioners can point
  // this at a different address per manager via the admin panel.
  const manager = (db.managers || []).find((m) => {
    const mapped = (m.googleEmail || m.email || '').toLowerCase();
    return mapped && mapped === email;
  });
  if (!manager) {
    return res.status(403).json({ error: 'This Google account is not registered. Contact the commissioner.' });
  }
  if (manager.active === false) {
    return res.status(403).json({ error: 'Account is inactive' });
  }

  // Issue (or reuse) a per-manager auth token. The client sends it in the
  // X-User-Password header on later requests, exactly where the password would
  // go — keeping the stateless re-validation model intact for Google users.
  if (!manager.authToken) {
    manager.authToken = crypto.randomBytes(32).toString('hex');
  }
  addAuditEntry(db, 'google_login', { email: manager.email }, manager.email);
  writeDB(db);

  res.json({
    ok: true,
    manager: { name: manager.name, email: manager.email, commissioner: manager.commissioner || false },
    token: manager.authToken,
  });
});

// ============================================================
// API Endpoints
// ============================================================

// GET /api/seasons — return all seasons
app.get('/api/seasons', (req, res) => {
  const db = readDB();
  res.json(db.seasons || {});
});

// POST /api/seasons — save all seasons (full replace)
app.post('/api/seasons', requireCommissioner, (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body must be an object' });
  }
  const db = readDB();
  addAuditEntry(db, 'seasons_save_all', { seasonCount: Object.keys(req.body).length }, req.get('X-User-Email'));
  db.seasons = req.body;
  writeDB(db);
  res.json({ ok: true });
});

// POST /api/seasons/:year — save a single season
// Build identifier — ASSET_VERSION is set once per process start, so it changes on every
// deploy/restart. The client polls this and prompts a reload when it differs from the value it
// loaded with, so an open tab can't keep running stale code after a deploy.
app.get('/api/build', (req, res) => {
  res.json({ build: ASSET_VERSION });
});

app.post('/api/seasons/:year', requireAuth, (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body must be an object' });
  }
  const db = readDB();
  if (!db.seasons) db.seasons = {};

  // Detect newly added pending swaps so we can notify via Slack
  const existingSwaps = (db.seasons[req.params.year] && db.seasons[req.params.year].swaps) || [];
  const existingIds = new Set(existingSwaps.map((s) => s.id));
  const incomingSwaps = req.body.swaps || [];
  const newPending = incomingSwaps.filter((s) => s.status === 'pending' && !existingIds.has(s.id));

  addAuditEntry(db, 'season_save', { year: req.params.year }, req.get('X-User-Email'));
  const sd = req.body;
  const existingSd = (db.seasons || {})[req.params.year];

  // Stat records (daily_*/weekly_*) and team maps are server-authoritative — populated by the
  // MLB sync / backfill, never edited through this full-season save. A client that loaded
  // before a sync holds a stale, smaller copy; without this guard its saveSeason() silently
  // wipes the weeks the server fetched after the client loaded (the recurring "stats reset"
  // bug). Re-append any server stat record missing from the incoming payload (keyed per
  // game/week/player), mirroring the swap protection below; a client record with a matching
  // key still wins, so legitimate edits propagate.
  if (existingSd) {
    const mergeStats = (incoming, existing, keyFn) => {
      const arr = Array.isArray(incoming) ? incoming : [];
      if (!Array.isArray(existing) || existing.length === 0) return arr;
      const have = new Set(arr.map(keyFn));
      for (const r of existing) if (!have.has(keyFn(r))) arr.push(r);
      return arr;
    };
    sd.daily_batting = mergeStats(
      sd.daily_batting,
      existingSd.daily_batting,
      (r) => `${r.round}|${r.week}|${r.game_id}|${r.batter}`
    );
    sd.daily_pitching = mergeStats(
      sd.daily_pitching,
      existingSd.daily_pitching,
      (r) => `${r.round}|${r.week}|${r.game_id}|${r.pitcher}`
    );
    sd.weekly_batting = mergeStats(
      sd.weekly_batting,
      existingSd.weekly_batting,
      (r) => `${r.round}|${r.week}|${r.batter}`
    );
    sd.weekly_pitching = mergeStats(
      sd.weekly_pitching,
      existingSd.weekly_pitching,
      (r) => `${r.round}|${r.week}|${r.pitcher}`
    );
    sd.batters_team = { ...(existingSd.batters_team || {}), ...(sd.batters_team || {}) };
    sd.pitchers_team = { ...(existingSd.pitchers_team || {}), ...(sd.pitchers_team || {}) };

    // Player pools are built by server-side MLB API bootstrap and by commissioner CSV
    // uploads (both of which go through saveSeason). A stale client save (loaded before
    // the pool existed) would overwrite the server's populated arrays with empty ones —
    // same class of bug as the stat-reset. Union-merge: keep everything the server has
    // that the client doesn't, so bootstrap additions and CSV uploads are never lost to
    // a stale save. Client entries always win (CSV adds propagate normally).
    const mergePool = (incoming, existing) => {
      const arr = Array.isArray(incoming) ? [...incoming] : [];
      if (!Array.isArray(existing) || existing.length === 0) return arr;
      const have = new Set(arr);
      for (const name of existing) if (!have.has(name)) arr.push(name);
      return arr;
    };
    sd.batters_pool = mergePool(sd.batters_pool, existingSd.batters_pool);
    sd.pitchers_pool = mergePool(sd.pitchers_pool, existingSd.pitchers_pool);

    // roster_dates (add/drop windows) are written by server-side repairs (e.g. the gated
    // roster-chain repair, swap-date backfill) as well as the client. Re-append any
    // manager/week/player entry the incoming payload is missing so a stale client can't
    // silently revert server-added dates — mirroring the swap/stat protection. A matching
    // entry in the payload still wins, so legitimate commissioner edits propagate.
    if (existingSd.roster_dates && typeof existingSd.roster_dates === 'object') {
      if (!sd.roster_dates || typeof sd.roster_dates !== 'object') sd.roster_dates = {};
      for (const [mgr, weeks] of Object.entries(existingSd.roster_dates)) {
        if (!weeks || typeof weeks !== 'object') continue;
        for (const [weekKey, players] of Object.entries(weeks)) {
          if (!players || typeof players !== 'object') continue;
          for (const [player, dates] of Object.entries(players)) {
            if (sd.roster_dates[mgr] && sd.roster_dates[mgr][weekKey] && player in sd.roster_dates[mgr][weekKey]) {
              continue; // client has an entry for this slot — its version wins
            }
            if (!sd.roster_dates[mgr]) sd.roster_dates[mgr] = {};
            if (!sd.roster_dates[mgr][weekKey]) sd.roster_dates[mgr][weekKey] = {};
            sd.roster_dates[mgr][weekKey][player] = dates;
          }
        }
      }
    }

    // rosters (per-week roster arrays) are the attribution cache that findManagerForPlayerWeek
    // reads — they decide which manager every stat row, daily high/low, Live-tab line, and the
    // next rebuildWeeklyFromDaily credits. They are a server-healable projection of roster_dates,
    // but a stale full-season save that carries an empty/partial rosters object would blank a
    // manager's arrays, and the rebuildRosterArraysFromDates heal below is purely additive — it
    // augments existing week entries, it cannot recreate ones the save dropped. The result is
    // silent: standings survive (managerWeekSubtotal falls back to roster_dates carry-forward),
    // but the next stat compile re-attributes every row through the empty arrays and zeroes the
    // scoreboard. Same stale-save defense as roster_dates/schedule_dates above: when the server
    // holds populated arrays for a manager and the incoming payload drops or empties them,
    // preserve the server's copy. A client that sends non-empty arrays for the manager still
    // wins (legitimate add/drop edits propagate); only a wipe is rejected.
    if (existingSd.rosters && typeof existingSd.rosters === 'object') {
      if (!sd.rosters || typeof sd.rosters !== 'object') sd.rosters = {};
      const hasRosterData = (weeks) =>
        !!weeks &&
        typeof weeks === 'object' &&
        Object.values(weeks).some(
          (w) =>
            w &&
            ((Array.isArray(w.batters) && w.batters.length > 0) || (Array.isArray(w.pitchers) && w.pitchers.length > 0))
        );
      for (const [mgr, weeks] of Object.entries(existingSd.rosters)) {
        if (hasRosterData(weeks) && !hasRosterData(sd.rosters[mgr])) {
          sd.rosters[mgr] = weeks;
          console.error(
            `[Save guard] Save for ${req.params.year} dropped roster arrays for ${mgr} — ` +
              `preserving the stored rosters to protect manager attribution.`
          );
        }
      }
    }

    // schedule_dates (per-week start/end) defines every add/drop scoring window and is written
    // only by Season Setup's schedule computation — it is otherwise stable for the whole season.
    // A stale client save that lacks it (a browser whose cached season predates setup) must never
    // blank it: an empty schedule silently turns every `add_date <= weekEnd` eligibility check into
    // "always eligible", leaking dropped and future-period players across all weeks and corrupting
    // scoring league-wide. Preserve the server's copy unless the payload carries a complete schedule
    // (>= the stored length) — a real Season Setup save always sends all 16 weeks.
    if (Array.isArray(existingSd.schedule_dates) && existingSd.schedule_dates.length > 0) {
      const incomingDates = Array.isArray(sd.schedule_dates) ? sd.schedule_dates : [];
      if (incomingDates.length < existingSd.schedule_dates.length) {
        console.error(
          `[Save guard] Save for ${req.params.year} carried ${incomingDates.length} schedule_dates vs ` +
            `${existingSd.schedule_dates.length} stored — preserving the stored schedule to protect add/drop windows.`
        );
        sd.schedule_dates = existingSd.schedule_dates;
      }
    }

    // Roster submissions are server-authoritative: they are written only via the atomic
    // /api/seasons/:year/submissions endpoints (POST upsert, DELETE remove/clear). Preserve
    // the server's copy here so a stale full-season save from one browser can't clobber a
    // submission another user just made — the exact bug this replaces. (A brand-new season
    // has no existingSd, so its first save still establishes the empty buckets normally.)
    sd.initial_submissions = existingSd.initial_submissions || {};
    sd.period_submissions = existingSd.period_submissions || {};
  }

  // Heal per-week roster arrays from roster_dates whenever a save lands (swap/submission
  // approval, commissioner add/drop). The per-player scoreboard & My-Roster breakdowns attribute
  // points via the arrays, so a mid-period swap-in that was never carried into later weeks' arrays
  // would otherwise under-count in those views even though the canonical totals (carry-forward via
  // managerWeekSubtotal) already include it. This pass is additive + idempotent + score-neutral —
  // it only adds players already active per roster_dates, so totals never move.
  if (sd && sd.status === 'active') {
    try {
      rebuildRosterArraysFromDates(sd);
    } catch (e) {
      console.error('[Roster array heal] Error (continuing):', e.message);
    }
  }

  // Propagate roster add dates into player_dates for mid-week adds, then zero out
  // any pre-add scores for newly rostered players.  We do NOT call recomputeAllWeeklyScores
  // here because it would zero out dropped players' correctly banked scores when their
  // stats live in a daily record dated after weekDates.end (see recomputeMidWeekAddScores).
  if ((sd.daily_batting && sd.daily_batting.length) || (sd.daily_pitching && sd.daily_pitching.length)) {
    const wipedAuto = syncPlayerDatesFromRosterDates(sd);
    recomputeMidWeekAddScores(sd, wipedAuto);
  }
  // Protect server-side auto-advance markers from being overwritten by a stale client save.
  if (existingSd && Array.isArray(existingSd.auto_advanced_weeks)) {
    if (!Array.isArray(sd.auto_advanced_weeks)) sd.auto_advanced_weeks = [];
    if (!Array.isArray(sd.advanced_weeks)) sd.advanced_weeks = [];
    for (const w of existingSd.auto_advanced_weeks) {
      if (!sd.auto_advanced_weeks.includes(w)) sd.auto_advanced_weeks.push(w);
      if (!sd.advanced_weeks.includes(w)) sd.advanced_weeks.push(w);
    }
  }
  // Protect swap records added server-side (e.g. by startup repairs) that the client
  // may not know about because it loaded before the server restarted.  Any swap whose
  // id exists on the server but is absent from the incoming payload is re-appended so
  // a stale client cannot silently wipe server-added records.
  if (existingSd && Array.isArray(existingSd.swaps)) {
    if (!Array.isArray(sd.swaps)) sd.swaps = [];
    const incomingIds = new Set(sd.swaps.map((s) => s.id));
    for (const serverSwap of existingSd.swaps) {
      if (!incomingIds.has(serverSwap.id)) sd.swaps.push(serverSwap);
    }
  }

  // Integrity guard (SAVE_HARDENING_PLAN.md, Layer 3): refuse a full-season save that would destroy
  // rosters/attribution, drop a manager, lose roster_dates/swaps, or crater a manager's total — the
  // stale-tab clobber class. The per-field guards above protect known fields; this is the backstop
  // for the next field nobody remembered to guard (exactly how the 06-08 rosters wipe slipped
  // through). Commissioner can override a true positive by re-sending with `force: true`.
  if (existingSd && req.body.force !== true) {
    const integrity = assessSeasonWriteIntegrity(existingSd, sd);
    if (integrity.destructive) {
      console.error(`[Save guard] BLOCKED destructive save for ${req.params.year}: ${integrity.reasons.join('; ')}`);
      addAuditEntry(
        db,
        'season_save_blocked',
        { year: req.params.year, reasons: integrity.reasons },
        req.get('X-User-Email')
      );
      writeDB(db); // persist the audit record only; db.seasons[year] is still the stored (good) copy
      postSlack(
        `:no_entry: *Blocked a destructive season save (${req.params.year})* — likely a stale browser tab.\n• ` +
          `${integrity.reasons.join('\n• ')}\nThe saved state was preserved; no change was applied.`
      ).catch(() => {});
      return res.status(409).json({ error: 'destructive_save_blocked', reasons: integrity.reasons });
    }
  }

  db.seasons[req.params.year] = sd;
  writeDB(db);
  res.json({ ok: true });

  // Fire-and-forget Slack notifications for each new pending swap
  for (const swap of newPending) {
    postSlack(
      `*New Swap Request*\n*Manager:* ${swap.manager || '?'}\n*Out:* ${swap.player_out || '?'}\n*In:* ${swap.player_in || '?'}\n*Reason:* ${swap.reason || '—'}`
    ).catch(() => {});
  }
});

// POST /api/seasons/:year/swaps — atomically append a single pending swap.
// Uses a tiny payload (just the swap object) instead of the full season JSON, so it
// cannot fail due to payload size and gives the client a clear success/error signal.
// The full-season save (POST /api/seasons/:year) still acts as a safety net, but
// swap submission no longer depends on it succeeding.
app.post('/api/seasons/:year/swaps', requireAuth, (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  const swap = req.body;
  if (!swap || typeof swap !== 'object' || Array.isArray(swap)) {
    return res.status(400).json({ error: 'Request body must be a swap object' });
  }
  if (!swap.player_out || !swap.player_in || !swap.manager) {
    return res.status(400).json({ error: 'Swap must include manager, player_out, and player_in' });
  }
  const db = readDB();
  if (!db.seasons) db.seasons = {};
  const sd = (db.seasons || {})[req.params.year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });
  if (sd.status !== 'active') return res.status(400).json({ error: 'Season is not active' });

  // Server stamps id, timestamp, and status so the client cannot forge them.
  swap.id = Date.now().toString();
  swap.timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  swap.status = 'pending';

  if (!Array.isArray(sd.swaps)) sd.swaps = [];
  sd.swaps.push(swap);

  addAuditEntry(
    db,
    'swap_submitted',
    { year: req.params.year, manager: swap.manager, player_out: swap.player_out, player_in: swap.player_in },
    req.get('X-User-Email')
  );
  writeDB(db);
  res.json({ ok: true, swap });

  postSlack(
    `*New Swap Request*\n*Manager:* ${swap.manager || '?'}\n*Out:* ${swap.player_out || '?'}\n*In:* ${swap.player_in || '?'}\n*Reason:* ${swap.reason || '—'}`
  ).catch(() => {});
});

// ---- Atomic roster-submission endpoints (PP1 + PP2/playoff periods) ----
//
// Roster submissions used to ride the full-season save (POST /api/seasons/:year), whose
// background, error-swallowing call meant a submission could land in localStorage only
// (invisible to the server) or be silently clobbered by a stale full-season save from a
// different browser. These small atomic endpoints own the submission buckets instead — and
// the full-season save now treats those buckets as server-authoritative (see below) — so a
// submission persists reliably and can't be wiped by an unrelated save. Mirrors the
// /api/seasons/:year/swaps fix.
const SUBMISSION_PERIODS = ['pp1', 'pp2', 'qf', 'sf', 'finals'];

function submissionBucket(sd, period) {
  if (period === 'pp1') {
    if (!sd.initial_submissions) sd.initial_submissions = {};
    return sd.initial_submissions;
  }
  if (!sd.period_submissions) sd.period_submissions = {};
  if (!sd.period_submissions[period]) sd.period_submissions[period] = {};
  return sd.period_submissions[period];
}

// POST /api/seasons/:year/submissions — upsert one manager's submission for a period.
// Body: { period, manager, batters[], pitchers[], status }. The server stamps
// submitted_at / approved_at so timestamps reflect the real moment, not a client clock.
app.post('/api/seasons/:year/submissions', requireAuth, (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  const { period, manager, batters, pitchers, status } = req.body || {};
  if (
    !manager ||
    !SUBMISSION_PERIODS.includes(period) ||
    !Array.isArray(batters) ||
    !Array.isArray(pitchers) ||
    !['draft', 'pending', 'approved'].includes(status)
  ) {
    return res.status(400).json({ error: 'period, manager, batters[], pitchers[] and a valid status are required' });
  }
  const db = readDB();
  const sd = (db.seasons || {})[req.params.year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  const bucket = submissionBucket(sd, period);
  const existing = bucket[manager] || {};
  const now = new Date().toISOString();
  const submission = { ...existing, batters, pitchers, status };
  if (status === 'draft') {
    delete submission.submitted_at;
    delete submission.approved_at;
  } else {
    submission.submitted_at = existing.submitted_at || now;
    if (status === 'approved') submission.approved_at = now;
    else delete submission.approved_at;
  }
  bucket[manager] = submission;

  db.seasons[req.params.year] = sd;
  addAuditEntry(
    db,
    'submission_saved',
    { year: req.params.year, period, manager, status, batters: batters.length, pitchers: pitchers.length },
    req.get('X-User-Email')
  );
  writeDB(db);
  res.json({ ok: true, submission });
});

// DELETE /api/seasons/:year/submissions/:period/:manager — remove one submission record
// entirely (commissioner Delete). Distinct from Deny, which leaves an empty draft.
app.delete('/api/seasons/:year/submissions/:period/:manager', requireAuth, (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  const { period } = req.params;
  const manager = decodeURIComponent(req.params.manager);
  if (!SUBMISSION_PERIODS.includes(period)) {
    return res.status(400).json({ error: 'Invalid period' });
  }
  const db = readDB();
  const sd = (db.seasons || {})[req.params.year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  const bucket = submissionBucket(sd, period);
  const removed = Object.prototype.hasOwnProperty.call(bucket, manager);
  delete bucket[manager];

  db.seasons[req.params.year] = sd;
  addAuditEntry(db, 'submission_deleted', { year: req.params.year, period, manager }, req.get('X-User-Email'));
  writeDB(db);
  res.json({ ok: true, removed });
});

// DELETE /api/seasons/:year/submissions — clear ALL submissions for a season (used by the
// commissioner "Reset Season Data" action, which can no longer clear them via the full save).
app.delete('/api/seasons/:year/submissions', requireCommissioner, (req, res) => {
  if (!isValidYear(req.params.year)) {
    return res.status(400).json({ error: 'Invalid year parameter' });
  }
  const db = readDB();
  const sd = (db.seasons || {})[req.params.year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });
  sd.initial_submissions = {};
  sd.period_submissions = { pp2: {}, qf: {}, sf: {}, finals: {} };
  db.seasons[req.params.year] = sd;
  addAuditEntry(db, 'submissions_cleared', { year: req.params.year }, req.get('X-User-Email'));
  writeDB(db);
  res.json({ ok: true });
});

// GET /api/pending-count — number of pending swaps for a given season year
app.get('/api/pending-count', (req, res) => {
  const { year } = req.query;
  if (!year || !isValidYear(year)) return res.json({ count: 0 });
  const db = readDB();
  const sd = (db.seasons || {})[year];
  const swaps = (sd && sd.swaps) || [];
  res.json({ count: swaps.filter((s) => s.status === 'pending').length });
});

// GET /api/managers — return managers list
app.get('/api/managers', (req, res) => {
  const db = readDB();
  // Strip credentials from response, but indicate if a custom password is set.
  // authToken is a login credential and must never reach the client.
  const managers = (db.managers || []).map((m) => {
    const { password, authToken: _authToken, ...safe } = m;
    safe.hasCustomPassword = !!password;
    return safe;
  });
  res.json(managers);
});

// POST /api/managers — save managers list
app.post('/api/managers', requireCommissioner, (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Request body must be an array' });
  }
  const db = readDB();
  // Preserve existing credentials (password + Google auth token) — the client
  // never receives them (stripped in GET), so we must carry them forward from
  // the current db record or a managers save would wipe them.
  const existingCreds = {};
  (db.managers || []).forEach((m) => {
    if (m.email && (m.password || m.authToken)) {
      existingCreds[m.email.toLowerCase()] = { password: m.password, authToken: m.authToken };
    }
  });
  db.managers = req.body.map((m) => {
    const emailKey = (m.email || '').toLowerCase();
    const prior = existingCreds[emailKey];
    if (!prior) return m;
    const merged = { ...m };
    if (!merged.password && prior.password) merged.password = prior.password;
    if (!merged.authToken && prior.authToken) merged.authToken = prior.authToken;
    return merged;
  });
  addAuditEntry(db, 'managers_save', { count: req.body.length }, req.get('X-User-Email'));
  writeDB(db);
  // Keep the committed seed file in sync so managers survive the next redeploy
  writeManagersSeed(db.managers);
  res.json({ ok: true });
});

// POST /api/managers/:email/password — set a manager's password
app.post('/api/managers/:email/password', requireCommissioner, (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const { password } = req.body || {};
  if (!password || typeof password !== 'string' || password.trim().length < 3) {
    return res.status(400).json({ error: 'Password must be at least 3 characters' });
  }
  const db = readDB();
  const manager = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === email);
  if (!manager) {
    return res.status(404).json({ error: 'Manager not found' });
  }
  manager.password = password.trim();
  addAuditEntry(db, 'manager_password_set', { email }, req.get('X-User-Email'));
  writeDB(db);
  writeManagersSeed(db.managers);
  res.json({ ok: true });
});

// DELETE /api/managers/:email/password — reset a manager's password to the global default
app.delete('/api/managers/:email/password', requireCommissioner, (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const db = readDB();
  const manager = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === email);
  if (!manager) {
    return res.status(404).json({ error: 'Manager not found' });
  }
  delete manager.password;
  addAuditEntry(db, 'manager_password_reset', { email }, req.get('X-User-Email'));
  writeDB(db);
  writeManagersSeed(db.managers);
  res.json({ ok: true });
});

// POST /api/managers/:email/change-password — self-service password change (logged-in manager)
app.post('/api/managers/:email/change-password', (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || typeof newPassword !== 'string' || newPassword.trim().length < 3) {
    return res.status(400).json({ error: 'New password must be at least 3 characters' });
  }
  const db = readDB();
  const manager = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === email);
  if (!manager) {
    return res.status(404).json({ error: 'Manager not found' });
  }
  const expectedPassword = manager.password || LOGIN_PASSWORD;
  if (currentPassword !== expectedPassword) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  manager.password = newPassword.trim();
  addAuditEntry(db, 'manager_password_changed', { email }, email);
  writeDB(db);
  writeManagersSeed(db.managers);
  res.json({ ok: true });
});

// POST /api/managers/:email/theme — self-service UI theme preference (logged-in manager)
app.post('/api/managers/:email/theme', requireAuth, (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  // A user may only change their own theme.
  if (req.manager.email.toLowerCase() !== email) {
    return res.status(403).json({ error: "Cannot change another user's theme" });
  }
  const { theme } = req.body || {};
  if (theme !== 'light' && theme !== 'dark') {
    return res.status(400).json({ error: 'Theme must be "light" or "dark"' });
  }
  const db = readDB();
  const manager = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === email);
  if (!manager) {
    return res.status(404).json({ error: 'Manager not found' });
  }
  manager.theme = theme;
  writeDB(db);
  // Theme is a non-credential identity preference — keep it in the committed seed
  // so it survives a redeploy (same as a manager's name/active flag).
  writeManagersSeed(db.managers);
  res.json({ ok: true });
});

// GET /api/audit-log — return recent audit log entries
app.get('/api/audit-log', requireCommissioner, (req, res) => {
  const db = readDB();
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, MAX_AUDIT_ENTRIES);
  const log = (db.audit_log || []).slice(0, limit);
  res.json(log);
});

// ============================================================
// Banner Background Config
// ============================================================

// GET /api/banner-config — return banner background configuration
app.get('/api/banner-config', (req, res) => {
  const db = readDB();
  res.json(db.banner_config || null);
});

// POST /api/banner-config — save banner background configuration
// Body: { imageData, posX, posY, scale } or null to clear
app.post('/api/banner-config', requireCommissioner, (req, res) => {
  const db = readDB();
  const body = req.body;

  if (body === null || (typeof body === 'object' && body.clear)) {
    db.banner_config = null;
    addAuditEntry(db, 'banner_config_clear', {}, req.get('X-User-Email'));
    writeDB(db);
    return res.json({ ok: true });
  }

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { imageData, posX, posY, scale } = body;

  // Validate imageData is a data URL for an image
  if (imageData && (typeof imageData !== 'string' || !imageData.startsWith('data:image/'))) {
    return res.status(400).json({ error: 'imageData must be an image data URL' });
  }

  // Validate numeric fields
  const config = {};
  if (imageData) config.imageData = imageData;
  config.posX = typeof posX === 'number' ? Math.max(0, Math.min(100, posX)) : 50;
  config.posY = typeof posY === 'number' ? Math.max(0, Math.min(100, posY)) : 50;
  config.scale = typeof scale === 'number' ? Math.max(0.5, Math.min(5, scale)) : 1;

  db.banner_config = config;
  addAuditEntry(db, 'banner_config_save', { hasImage: !!imageData }, req.get('X-User-Email'));
  writeDB(db);
  res.json({ ok: true });
});

// ============================================================
// Scoring (mirrored from client for server-side processing)
// ============================================================

const SCORING = {
  batting: { '1B': 3, '2B': 5, '3B': 8, HR: 10, R: 2, RBI: 2, SB: 5, BB: 2 },
  pitching: { W: 4, QS: 4, CG: 2.5, CGSO: 2.5, NH: 5, IP: 2.25, H: -0.6, ER: -2, BB: -0.6, K: 2 },
};

const SEASON_SCHEDULE = [
  { round: 'PP1', week: 'Week 1' },
  { round: 'PP1', week: 'Week 2' },
  { round: 'PP1', week: 'Week 3' },
  { round: 'PP1', week: 'Week 4' },
  { round: 'PP1', week: 'Week 5' },
  { round: 'PP2', week: 'Week 1' },
  { round: 'PP2', week: 'Week 2' },
  { round: 'PP2', week: 'Week 3' },
  { round: 'PP2', week: 'Week 4' },
  { round: 'PP2', week: 'Week 5' },
  { round: 'QF', week: 'Week 1' },
  { round: 'QF', week: 'Week 2' },
  { round: 'SF', week: 'Week 1' },
  { round: 'SF', week: 'Week 2' },
  { round: 'Finals', week: 'Week 1' },
  { round: 'Finals', week: 'Week 2' },
];

function calculateBattingScore(stats) {
  let score = 0;
  score += (stats['1b'] || 0) * SCORING.batting['1B'];
  score += (stats['2b'] || 0) * SCORING.batting['2B'];
  score += (stats['3b'] || 0) * SCORING.batting['3B'];
  score += (stats.hr || 0) * SCORING.batting['HR'];
  score += (stats.r || 0) * SCORING.batting['R'];
  score += (stats.rbi || 0) * SCORING.batting['RBI'];
  score += (stats.sb || 0) * SCORING.batting['SB'];
  score += (stats.bb || 0) * SCORING.batting['BB'];
  return Math.round(score * 100) / 100;
}

function calculatePitchingScore(stats) {
  let score = 0;
  score += (stats.w || 0) * SCORING.pitching['W'];
  score += (stats.qs || 0) * SCORING.pitching['QS'];
  score += (stats.cg || 0) * SCORING.pitching['CG'];
  score += (stats.cgso || 0) * SCORING.pitching['CGSO'];
  score += (stats.nh || 0) * SCORING.pitching['NH'];
  score += (stats.ip || 0) * SCORING.pitching['IP'];
  score += (stats.h || 0) * SCORING.pitching['H'];
  score += (stats.er || 0) * SCORING.pitching['ER'];
  score += (stats.bb || 0) * SCORING.pitching['BB'];
  score += (stats.k || 0) * SCORING.pitching['K'];
  return Math.round(score * 100) / 100;
}

function parseNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// ============================================================
// Daily Stats Engine
// ============================================================

// Convert IP from baseball notation to true decimal for arithmetic
// "6.1" = 6 + 1/3 ≈ 6.333, "7.2" = 7 + 2/3 ≈ 7.667
function convertIPDecimal(rawIP) {
  const str = String(rawIP);
  const dot = str.indexOf('.');
  if (dot === -1) return parseFloat(rawIP) || 0;
  const whole = parseInt(str.slice(0, dot)) || 0;
  const frac = str.slice(dot + 1);
  if (frac === '1') return Math.round((whole + 1 / 3) * 1000) / 1000;
  if (frac === '2') return Math.round((whole + 2 / 3) * 1000) / 1000;
  return parseFloat(rawIP) || 0;
}

// Daily delta between two batting cumulative snapshots (floor at 0 to guard resets)
function battingDelta(curr, prev) {
  const fields = ['1b', '2b', '3b', 'hr', 'r', 'rbi', 'sb', 'bb', 'abs'];
  const delta = {};
  for (const f of fields) delta[f] = Math.max(0, (curr[f] || 0) - (prev[f] || 0));
  return delta;
}

// Daily delta between two pitching cumulative snapshots (IP stored in decimal)
function pitchingDelta(curr, prev) {
  const intFields = ['gs', 'w', 'qs', 'cg', 'cgso', 'nh', 'h', 'er', 'bb', 'k'];
  const delta = {};
  for (const f of intFields) delta[f] = Math.max(0, (curr[f] || 0) - (prev[f] || 0));
  delta.ip = Math.max(0, Math.round(((curr.ip || 0) - (prev.ip || 0)) * 1000) / 1000);
  return delta;
}

// WMMC custom quality-start rule (tighter than MLB's 6 IP / 3 ER): a started
// outing of >= 5 IP with <= 2 ER. Shared by parseBoxscore, the gsheets sync
// pipeline, and the startup backfill so every ingest path stays in sync.
function isWmmcQS(gs, ip, er) {
  return (gs || 0) > 0 && (ip || 0) >= 5 && (er || 0) <= 2 ? 1 : 0;
}

// Find the SEASON_SCHEDULE index for a given round+week
function getScheduleWeekIndex(round, week) {
  return SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === week);
}

// Start date of the PERIOD (round) a week belongs to — the schedule start of that round's first
// week. Used to scope add/drop carry-forward to within a period: each new submission period (PP2,
// QF, SF, Finals) starts from its own submission, so a prior period's players must not carry over.
// Returns null for the initial period (PP1) — there's no prior period to exclude, so its scoring
// and roster derivation are left exactly as-is.
function periodStartForRound(sd, round) {
  if (!round || !Array.isArray(SEASON_SCHEDULE) || round === SEASON_SCHEDULE[0].round) return null;
  const scheduleDates = sd.schedule_dates || [];
  for (let i = 0; i < SEASON_SCHEDULE.length && i < scheduleDates.length; i++) {
    if (SEASON_SCHEDULE[i].round === round) return scheduleDates[i] ? scheduleDates[i].start : null;
  }
  return null;
}

// Compute effective weekly batting score from daily deltas filtered by player_dates.
// Returns null when no daily records exist (caller falls back to stored weekly_score).
function computeEffectiveBattingScore(sd, batter, round, week) {
  const records = (sd.daily_batting || []).filter((r) => r.batter === batter && r.round === round && r.week === week);
  if (records.length === 0) return null;

  const weekIdx = getScheduleWeekIndex(round, week);
  const weekDates = weekIdx >= 0 ? (sd.schedule_dates || [])[weekIdx] : null;
  const weekKey = `${round}|${week}`;
  const override = (((sd.player_dates || {})[weekKey] || {}).batter || {})[batter] || {};

  // Inclusive date window: record.date is the actual MLB game date, so
  // effectiveStart and effectiveEnd both match the commissioner-facing
  // add_date / drop_date semantics directly. (Legacy +1 end shift was for
  // the gsheets snapshot model where record.date carried stats from the
  // previous day — no longer applies post-takeover.)
  const effectiveStart = 'start' in override ? override.start : (weekDates && weekDates.start) || null;
  const effectiveEnd = 'end' in override ? override.end : (weekDates && weekDates.end) || null;

  const eligible = records.filter((r) => {
    if (effectiveStart && r.date < effectiveStart) return false;
    if (effectiveEnd && r.date > effectiveEnd) return false;
    return true;
  });

  return Math.round(eligible.reduce((sum, r) => sum + calculateBattingScore(r.delta || {}), 0) * 100) / 100;
}

// Compute effective weekly pitching score from daily deltas filtered by player_dates.
function computeEffectivePitchingScore(sd, pitcher, round, week) {
  const records = (sd.daily_pitching || []).filter(
    (r) => r.pitcher === pitcher && r.round === round && r.week === week
  );
  if (records.length === 0) return null;

  const weekIdx = getScheduleWeekIndex(round, week);
  const weekDates = weekIdx >= 0 ? (sd.schedule_dates || [])[weekIdx] : null;
  const weekKey = `${round}|${week}`;
  const override = (((sd.player_dates || {})[weekKey] || {}).pitcher || {})[pitcher] || {};

  // Inclusive date window — see computeEffectiveBattingScore for rationale.
  const effectiveStart = 'start' in override ? override.start : (weekDates && weekDates.start) || null;
  const effectiveEnd = 'end' in override ? override.end : (weekDates && weekDates.end) || null;

  const eligible = records.filter((r) => {
    if (effectiveStart && r.date < effectiveStart) return false;
    if (effectiveEnd && r.date > effectiveEnd) return false;
    return true;
  });

  return Math.round(eligible.reduce((sum, r) => sum + calculatePitchingScore(r.delta || {}), 0) * 100) / 100;
}

// Returns true if gameDate falls within a player's effective scoring window for the week.
// Reads player_dates overrides first; falls back to the week's calendar start/end.
// Used by the live tab and /api/mlb/daily to skip stats for dropped/future-add players
// that are still physically present in the roster object from auto-advance carry-forward.
function isDateEligibleForPlayer(sd, playerName, playerType, round, week, gameDate) {
  const weekKey = `${round}|${week}`;
  const pdType = playerType === 'batting' ? 'batter' : 'pitcher';
  const override = (((sd.player_dates || {})[weekKey] || {})[pdType] || {})[playerName] || {};
  const weekIdx = getScheduleWeekIndex(round, week);
  const weekDates = weekIdx >= 0 ? (sd.schedule_dates || [])[weekIdx] : null;
  const effectiveStart = 'start' in override ? override.start : (weekDates && weekDates.start) || null;
  const effectiveEnd = 'end' in override ? override.end : (weekDates && weekDates.end) || null;
  if (effectiveStart && gameDate < effectiveStart) return false;
  if (effectiveEnd && gameDate > effectiveEnd) return false;
  return true;
}

// Returns true if `playerName` was dropped from `managerName`'s roster in an EARLIER week
// (a drop_date before this week's start) and not re-added this week. Such a player is still
// physically present in this week's roster object via auto-advance carry-forward, so an
// add/drop in week N leaves a ghost entry in weeks N+1, N+2, ... that must not be credited
// or displayed. Mirrors the inline wasDroppedBefore guard in managerWeekSubtotal so every
// score-accumulation view — Scoreboard, Live tab, the /api/mlb/daily breakdown, and the
// daily high/low — agrees on who counts for the week.
function wasDroppedBeforeWeek(sd, managerName, playerName, weekKey, weekStart) {
  if (!sd || !managerName || !weekStart) return false;
  const mgrDates = (sd.roster_dates && sd.roster_dates[managerName]) || {};
  const approvedSwaps = (sd.swaps || []).filter((s) => s.status === 'approved');
  const addedThisWeek = new Set([
    ...approvedSwaps.filter((s) => s.player_in && s.week_key === weekKey).map((s) => s.player_in),
    ...Object.entries(mgrDates[weekKey] || {})
      .filter(([, d]) => d.add_date)
      .map(([p]) => p),
  ]);
  if (addedThisWeek.has(playerName)) return false;
  for (const [wk, players] of Object.entries(mgrDates)) {
    if (wk === weekKey) continue;
    const pd = players[playerName];
    if (pd && pd.drop_date && pd.drop_date < weekStart) {
      // Only treat as dropped if there is no re-add in a later week before weekStart.
      const reAddedLater = Object.values(mgrDates).some(
        (wkp) => wkp[playerName] && wkp[playerName].add_date > pd.drop_date && wkp[playerName].add_date < weekStart
      );
      if (!reAddedLater) return true;
    }
  }
  return false;
}

// True when `name`'s only roster association for this week is a carry-forward of a player the
// manager already dropped in an earlier week. The sync write paths use this to avoid storing
// (and to purge) stat records that no scoreboard would ever count — so a one-day add/drop
// player accumulates stats only for the day they were actually rostered. Resolves the
// week-specific manager and the week's start internally, then defers to wasDroppedBeforeWeek.
function isCarriedForwardDrop(sd, name, type, round, week) {
  const mgr = findManagerForPlayerWeek(sd, name, type, round, week);
  if (!mgr) return false;
  const weekIdx = getScheduleWeekIndex(round, week);
  const weekStart = weekIdx >= 0 ? ((sd.schedule_dates || [])[weekIdx] || {}).start : null;
  return wasDroppedBeforeWeek(sd, mgr, name, `${round}|${week}`, weekStart);
}

// One-shot maintenance backfill: remove daily + weekly stat records that were written for
// players carried forward into a week after being dropped in an earlier week. These never
// counted toward any total (the read paths filter them via wasDroppedBeforeWeek), but they
// lingered in db.json. The sync now skips writing them going forward; this purges the history
// for weeks the daily sync would never re-touch. Manual edits and drop_locked records are
// preserved. Idempotent and gated by a db flag, mirroring backfillWmmcQS / applyMLBApiTakeover.
function purgeCarriedForwardDropRecords(db) {
  if (!db || db.carried_forward_drop_purge_done) return false;

  let dailyRemoved = 0;
  let weeklyRemoved = 0;
  const isOverride = (r) => (r.manual_fields && r.manual_fields.length > 0) || r.drop_locked;

  for (const sd of Object.values(db.seasons || {})) {
    if (!sd) continue;
    // Ensure player_dates reflect the latest roster_dates before judging eligibility.
    syncPlayerDatesFromRosterDates(sd);

    const purge = (list, playerKey, type, counter) => {
      if (!Array.isArray(list)) return list;
      return list.filter((r) => {
        if (isOverride(r)) return true; // never touch commissioner overrides
        if (isCarriedForwardDrop(sd, r[playerKey], type, r.round, r.week)) {
          counter();
          return false;
        }
        return true;
      });
    };

    sd.daily_batting = purge(sd.daily_batting, 'batter', 'batting', () => dailyRemoved++);
    sd.daily_pitching = purge(sd.daily_pitching, 'pitcher', 'pitching', () => dailyRemoved++);
    sd.weekly_batting = purge(sd.weekly_batting, 'batter', 'batting', () => weeklyRemoved++);
    sd.weekly_pitching = purge(sd.weekly_pitching, 'pitcher', 'pitching', () => weeklyRemoved++);
  }

  db.carried_forward_drop_purge_done = true;
  console.log(
    `[Carry-forward purge] Removed ${dailyRemoved} daily and ${weeklyRemoved} weekly record(s) for dropped carry-over players.`
  );
  return true;
}

// One-shot maintenance: undo period-boundary auto-advances. The Sunday auto-advance
// now skips period (round) boundaries — PP1→PP2, PP2→QF, QF→SF, SF→Finals — because
// those are populated via the roster-submission workflow. A run before that fix carried
// a boundary week (e.g. PP2 Week 1) forward and marked it advanced. This removes those
// carry-forward roster copies, their zero-stat weekly rows, and the advanced /
// auto_advanced markers so the boundary week is empty again and submissions own it.
// Safe by construction: active season only, and a week is skipped untouched if any of
// its weekly rows carry real points (so an already-played boundary is never disturbed).
// Score-neutral. Gated by a db flag → runs once.
function purgeBoundaryAutoAdvance(db) {
  if (!db || db.boundary_auto_advance_purge_done) return false;

  let rostersRemoved = 0;
  let weeklyRemoved = 0;
  const weeksCleared = [];

  for (const sd of Object.values(db.seasons || {})) {
    if (!sd || sd.status !== 'active') continue;
    const autoAdvanced = Array.isArray(sd.auto_advanced_weeks) ? sd.auto_advanced_weeks : [];
    const candidates = autoAdvanced.filter((i) => isPeriodBoundaryWeek(i));
    if (candidates.length === 0) continue;

    const cleared = [];
    for (const i of candidates) {
      const { round, week } = SEASON_SCHEDULE[i];
      const rowMatches = (r) => r.round === round && r.week === week;

      // Never disturb a boundary week that has actually been played.
      const hasRealStats =
        (sd.weekly_batting || []).some((r) => rowMatches(r) && (r.weekly_score || 0) !== 0) ||
        (sd.weekly_pitching || []).some((r) => rowMatches(r) && (r.weekly_score || 0) !== 0);
      if (hasRealStats) continue;

      const weekKey = `${round}|${week}`;
      for (const mgrRoster of Object.values(sd.rosters || {})) {
        if (mgrRoster[weekKey]) {
          delete mgrRoster[weekKey];
          rostersRemoved++;
        }
      }

      const before = (sd.weekly_batting || []).length + (sd.weekly_pitching || []).length;
      sd.weekly_batting = (sd.weekly_batting || []).filter((r) => !rowMatches(r));
      sd.weekly_pitching = (sd.weekly_pitching || []).filter((r) => !rowMatches(r));
      weeklyRemoved += before - ((sd.weekly_batting || []).length + (sd.weekly_pitching || []).length);

      cleared.push(i);
      weeksCleared.push(weekKey);
    }

    // Drop the markers for the weeks we cleared so the every-boot roster repair
    // treats the boundary week as un-advanced and submissions can own it.
    if (cleared.length > 0) {
      sd.advanced_weeks = (sd.advanced_weeks || []).filter((i) => !cleared.includes(i));
      sd.auto_advanced_weeks = autoAdvanced.filter((i) => !cleared.includes(i));
    }
  }

  db.boundary_auto_advance_purge_done = true;
  if (rostersRemoved > 0 || weeklyRemoved > 0) {
    console.log(
      `[Boundary purge] Cleared ${weeksCleared.join(', ')}: ${rostersRemoved} roster(s), ${weeklyRemoved} weekly row(s).`
    );
  }
  return true;
}

// One-shot maintenance: purge an orphaned "ghost" player from a manager's records.
// Iván Herrera scored for Joey Auclair across PP1 Weeks 1–5 (~207 pts) via stat records
// plus a roster_dates add-date, but was never in his initial submission, any weekly
// roster, or any approved swap. The roster-validated scoreboard correctly excluded him
// (~1,342) while raw-stat paths — the diag dump and the score-guard snapshot — still
// counted him (~1,549). That 207-pt phantom made the nightly compile look like a 40+ pt
// drop, so the score guard blocked the save every morning (and never recorded a snapshot,
// leaving the trail empty). repairGhostInitialRosterPlayers only cleans Week 1, so it
// could never fully remove a multi-week ghost. Commissioner confirmed he was never
// rostered → remove his stat records and date/roster entries for Joey across all weeks.
// Score-neutral for every correct (roster-validated) view. Gated by a db flag → runs once.
function purgeGhostHerreraFromJoey(db) {
  if (!db || db.ghost_herrera_purge_done) return false;

  const MANAGER = 'Joey Auclair';
  const isGhost = (name) => normalizeName(name) === 'ivan herrera';
  let removed = 0;

  for (const sd of Object.values(db.seasons || {})) {
    if (!sd || sd.status !== 'active') continue;

    const filterStats = (list, key) => {
      if (!Array.isArray(list)) return list;
      const kept = list.filter((r) => !(r.manager === MANAGER && isGhost(r[key])));
      removed += list.length - kept.length;
      return kept;
    };
    sd.weekly_batting = filterStats(sd.weekly_batting, 'batter');
    sd.daily_batting = filterStats(sd.daily_batting, 'batter');
    sd.weekly_pitching = filterStats(sd.weekly_pitching, 'pitcher');
    sd.daily_pitching = filterStats(sd.daily_pitching, 'pitcher');

    // Drop his date entries (roster_dates: week → {player}; player_dates: week →
    // {batter|pitcher → {player}}) and any stray roster membership, all weeks.
    for (const week of Object.values((sd.roster_dates || {})[MANAGER] || {})) {
      for (const name of Object.keys(week || {})) if (isGhost(name)) delete week[name];
    }
    for (const week of Object.values((sd.player_dates || {})[MANAGER] || {})) {
      for (const sub of ['batter', 'pitcher']) {
        if (week && week[sub]) for (const name of Object.keys(week[sub])) if (isGhost(name)) delete week[sub][name];
      }
    }
    for (const wr of Object.values((sd.rosters || {})[MANAGER] || {})) {
      if (wr.batters) wr.batters = wr.batters.filter((p) => !isGhost(p));
      if (wr.pitchers) wr.pitchers = wr.pitchers.filter((p) => !isGhost(p));
    }
  }

  db.ghost_herrera_purge_done = true;
  if (removed > 0) console.log(`[Ghost purge] Removed ${removed} Iván Herrera stat record(s) from ${MANAGER}.`);
  return true;
}

// Version stamp — mirrors app.js ROSTER_REPAIR_VERSION.  Bump both together.
// v6: carry-forward now folds swaps effective in a trusted seed week into the
// baseline, so an in-season move made during the first week propagates forward.
const ROSTER_REPAIR_VERSION = 6;

// Fill / recompute per-week roster entries by carrying forward the most recent trusted
// roster and applying approved swaps whose swap_date falls in each week.
// Using swap_date (vs the stored week_key) is more reliable when schedule boundaries shift.
// On the first run after a version bump a full recompute corrects weeks already populated
// by a previous broken repair pass.
function repairCarryForwardRosters(db) {
  let filled = 0;
  let purged = 0;
  let versionUpdated = false;
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  for (const sd of Object.values(db.seasons || {})) {
    if (!sd || sd.status !== 'active' || !sd.rosters) continue;

    const approvedSwaps = (sd.swaps || []).filter((s) => s.status === 'approved');
    const scheduleDates = sd.schedule_dates || [];
    const legitimatelyAdvanced = new Set(sd.advanced_weeks || []);
    const needsFullRecompute = (sd.roster_repair_version || 0) < ROSTER_REPAIR_VERSION;

    const swapEffectiveWeekKey = (swap) => {
      if (swap.swap_date) {
        for (let j = 0; j < SEASON_SCHEDULE.length; j++) {
          const d = scheduleDates[j];
          if (d && swap.swap_date >= d.start && swap.swap_date <= d.end) {
            return `${SEASON_SCHEDULE[j].round}|${SEASON_SCHEDULE[j].week}`;
          }
        }
      }
      return swap.week_key;
    };

    // Apply every approved swap whose effective week is `weekKey` to a roster
    // baseline. Mutates copies passed as newBatters/newPitchers and classifies
    // swap-ins against prevBatters/prevPitchers (the pre-swap state). Shared by
    // the non-trusted rebuild and the trusted-seed baseline advance so a swap
    // made during the first (or an auto-advanced) week still carries forward.
    // Mirrors app.js' repairCarryForwardRosters applySwaps — keep the two in sync.
    function applySwaps(mgrName, weekKey, prevBatters, prevPitchers, newBatters, newPitchers) {
      approvedSwaps
        .filter((s) => s.manager === mgrName && swapEffectiveWeekKey(s) === weekKey)
        .forEach((s) => {
          if (s.player_out) {
            newBatters = newBatters.filter((p) => p !== s.player_out);
            newPitchers = newPitchers.filter((p) => p !== s.player_out);
          }
          if (s.player_in) {
            const wasBatter = s.player_out ? prevBatters.includes(s.player_out) : false;
            const wasPitcher = s.player_out ? prevPitchers.includes(s.player_out) : false;
            const inBatPool = (sd.batters_pool || []).includes(s.player_in);
            const inPitPool = (sd.pitchers_pool || []).includes(s.player_in);
            if (wasBatter && !newBatters.includes(s.player_in)) newBatters.push(s.player_in);
            else if (wasPitcher && !newPitchers.includes(s.player_in)) newPitchers.push(s.player_in);
            else if (inBatPool && !newBatters.includes(s.player_in)) newBatters.push(s.player_in);
            else if (inPitPool && !newPitchers.includes(s.player_in)) newPitchers.push(s.player_in);
          }
        });
      return { newBatters, newPitchers };
    }

    for (const [mgrName, mgrRoster] of Object.entries(sd.rosters)) {
      let prevBatters = null;
      let prevPitchers = null;

      for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
        const { round, week } = SEASON_SCHEDULE[i];
        const weekKey = `${round}|${week}`;
        const weekStart = scheduleDates[i] ? scheduleDates[i].start : null;
        const isFuture = weekStart && weekStart > todayET;

        if (isFuture) {
          if (!legitimatelyAdvanced.has(i)) {
            const wr = mgrRoster[weekKey];
            if (wr && ((wr.batters || []).length > 0 || (wr.pitchers || []).length > 0)) {
              delete mgrRoster[weekKey];
              purged++;
            }
          }
          continue;
        }

        const wr = mgrRoster[weekKey];
        const hasBatters = wr && (wr.batters || []).length > 0;
        const hasPitchers = wr && (wr.pitchers || []).length > 0;
        const hasData = hasBatters || hasPitchers;
        // Trust week 0 (initial submission) and the first week with data (no prior
        // context). Auto-advanced weeks are trusted only for INCREMENTAL repairs —
        // during a full recompute they are rebuilt from carry-forward + swaps too,
        // otherwise an auto-advanced current week never picks up swaps made during it
        // (and inherits any staleness from the week it was advanced from).
        const isTrusted = i === 0 || prevBatters === null || (legitimatelyAdvanced.has(i) && !needsFullRecompute);

        if (isTrusted) {
          if (hasData) {
            // A swap whose effective week is THIS trusted seed week (an in-season
            // move made during the first, or an auto-advanced, week) must still
            // advance the carry-forward baseline, or the swap-in never propagates
            // to later weeks. We leave mgrRoster[weekKey] untouched — the seed week
            // still scores the outgoing player for the days it rostered them via
            // roster_dates — and only advance prevBatters/prevPitchers.
            const seedBatters = [...(wr.batters || [])];
            const seedPitchers = [...(wr.pitchers || [])];
            ({ newBatters: prevBatters, newPitchers: prevPitchers } = applySwaps(
              mgrName,
              weekKey,
              seedBatters,
              seedPitchers,
              [...seedBatters],
              [...seedPitchers]
            ));
          }
        } else if (!hasData || needsFullRecompute) {
          const rebuilt = applySwaps(mgrName, weekKey, prevBatters, prevPitchers, [...prevBatters], [...prevPitchers]);
          mgrRoster[weekKey] = { batters: rebuilt.newBatters, pitchers: rebuilt.newPitchers };
          filled++;
          prevBatters = rebuilt.newBatters;
          prevPitchers = rebuilt.newPitchers;
        } else {
          prevBatters = [...(wr.batters || [])];
          prevPitchers = [...(wr.pitchers || [])];
        }
      }
    }

    if (needsFullRecompute) {
      sd.roster_repair_version = ROSTER_REPAIR_VERSION;
      versionUpdated = true;
    }
  }

  if (filled > 0) console.log(`[Roster Repair] Filled/recomputed ${filled} week roster entries.`);
  if (purged > 0) console.log(`[Roster Repair] Purged ${purged} future week entries not written by auto-advance.`);
  return filled > 0 || purged > 0 || versionUpdated;
}

// Recompute all weekly_batting/pitching scores from daily data.
// Called after player_dates changes or manual daily stat edits.
// Skips records with manual_fields or drop_locked (commissioner overrides stay intact).
function recomputeAllWeeklyScores(sd) {
  (sd.weekly_batting || []).forEach((b) => {
    if ((b.manual_fields && b.manual_fields.length > 0) || b.drop_locked) return;
    const score = computeEffectiveBattingScore(sd, b.batter, b.round, b.week);
    if (score !== null) {
      b.weekly_score = score;
      b.total_score = score;
    }
  });
  (sd.weekly_pitching || []).forEach((p) => {
    if ((p.manual_fields && p.manual_fields.length > 0) || p.drop_locked) return;
    const score = computeEffectivePitchingScore(sd, p.pitcher, p.round, p.week);
    if (score !== null) {
      p.weekly_score = score;
    }
  });
}

// Rebuild weekly_batting/pitching summary rows for one week by aggregating
// ALL stored daily_batting/pitching records for that week. This ensures the
// weekly row always reflects the full week's accumulated games — not just the
// ones fetched in the most recent API call — so a daily one-day fetch
// correctly adds to the running total rather than overwriting it.
// Skips any row with manual_fields or drop_locked (commissioner overrides stay intact).
function rebuildWeeklyFromDaily(sd, round, week) {
  if (!sd.weekly_batting) sd.weekly_batting = [];
  if (!sd.weekly_pitching) sd.weekly_pitching = [];

  const dailyBat = (sd.daily_batting || []).filter((r) => r.round === round && r.week === week);
  const dailyPit = (sd.daily_pitching || []).filter((r) => r.round === round && r.week === week);

  // Sum batting stats per player across all stored game records.
  const batMap = {};
  for (const r of dailyBat) {
    const d = r.delta || r.cumulative || {};
    if (!batMap[r.batter]) batMap[r.batter] = { '1b': 0, '2b': 0, '3b': 0, hr: 0, r: 0, rbi: 0, sb: 0, bb: 0, abs: 0 };
    for (const k of Object.keys(batMap[r.batter])) batMap[r.batter][k] += d[k] || 0;
  }

  // Sum pitching stats per player (IP requires decimal arithmetic).
  const pitMap = {};
  for (const r of dailyPit) {
    const d = r.delta || r.cumulative || {};
    if (!pitMap[r.pitcher]) {
      pitMap[r.pitcher] = { gs: 0, w: 0, qs: 0, cg: 0, cgso: 0, nh: 0, ip: 0, h: 0, er: 0, bb: 0, k: 0 };
    }
    const m = pitMap[r.pitcher];
    for (const k of Object.keys(m)) {
      if (k === 'ip') m.ip = Math.round((m.ip + (d.ip || 0)) * 1000) / 1000;
      else m[k] += d[k] || 0;
    }
  }

  for (const [name, cumulative] of Object.entries(batMap)) {
    if (
      sd.weekly_batting.find(
        (b) =>
          b.round === round &&
          b.week === week &&
          b.batter === name &&
          ((b.manual_fields && b.manual_fields.length > 0) || b.drop_locked)
      )
    ) {
      continue;
    }
    // Attribute strictly to the manager who rosters the player THIS week (carry-forward
    // already respects add/drop windows). The old any-week `findManagerForPlayer` fallback
    // mis-credited pre-add / post-drop weeks to a manager who only owned the player in other
    // weeks — e.g. a player swapped in on 5/22 showing points for the prior weeks. A player
    // not rostered this week stays manager:null (free-agent stats) and is excluded from that
    // manager's views and totals.
    const manager = findManagerForPlayerWeek(sd, name, 'batting', round, week);
    const effectiveScore = computeEffectiveBattingScore(sd, name, round, week);
    const weeklyScore = effectiveScore !== null ? effectiveScore : calculateBattingScore(cumulative);
    sd.weekly_batting = sd.weekly_batting.filter(
      (b) =>
        !(
          b.round === round &&
          b.week === week &&
          b.batter === name &&
          !((b.manual_fields && b.manual_fields.length > 0) || b.drop_locked)
        )
    );
    sd.weekly_batting.push({
      round,
      week,
      manager: manager || null,
      batter: name,
      team: (sd.batters_team || {})[name] || null,
      ...cumulative,
      weekly_score: weeklyScore,
      total_score: weeklyScore,
      source: 'mlbapi',
    });
  }

  for (const [name, cumulative] of Object.entries(pitMap)) {
    if (
      sd.weekly_pitching.find(
        (p) =>
          p.round === round &&
          p.week === week &&
          p.pitcher === name &&
          ((p.manual_fields && p.manual_fields.length > 0) || p.drop_locked)
      )
    ) {
      continue;
    }
    // Strictly per-week attribution — see the batting note above.
    const manager = findManagerForPlayerWeek(sd, name, 'pitching', round, week);
    const effectiveScore = computeEffectivePitchingScore(sd, name, round, week);
    const weeklyScore = effectiveScore !== null ? effectiveScore : calculatePitchingScore(cumulative);
    sd.weekly_pitching = sd.weekly_pitching.filter(
      (p) =>
        !(
          p.round === round &&
          p.week === week &&
          p.pitcher === name &&
          !((p.manual_fields && p.manual_fields.length > 0) || p.drop_locked)
        )
    );
    sd.weekly_pitching.push({
      round,
      week,
      manager: manager || null,
      pitcher: name,
      team: (sd.pitchers_team || {})[name] || null,
      ...cumulative,
      qs_highlight: false,
      weekly_score: weeklyScore,
      source: 'mlbapi',
    });
  }
}

// One-shot migration: make the MLB Stats API the single source of truth for
// stats and disable the daily Google Sheets sync. Runs once (gated by the
// `mlb_api_takeover_v1` flag on the db root) so the commissioner can later
// re-enable gsheets from the UI without this flipping it back. Strips every
// row with source='gsheets' from the weekly + daily stat arrays, then walks
// the schedule and re-syncs each week whose start date has passed (and the
// current in-progress week) from the MLB Stats API. The flag is only set
// once every past week sync succeeds, so a partial run can resume on the
// next startup.
async function applyMLBApiTakeover(db) {
  if (db.mlb_api_takeover_v1) return false;

  let stripped = 0;
  for (const sd of Object.values(db.seasons || {})) {
    if (!sd) continue;
    for (const arr of ['weekly_batting', 'weekly_pitching', 'daily_batting', 'daily_pitching']) {
      if (!Array.isArray(sd[arr])) continue;
      const before = sd[arr].length;
      sd[arr] = sd[arr].filter((r) => r.source !== 'gsheets');
      stripped += before - sd[arr].length;
    }
  }

  if (db.google_sheets_config && db.google_sheets_config.enabled) {
    db.google_sheets_config.enabled = false;
  }

  // Backfill every past (or in-progress) week of the active season from MLB.
  // performMLBSync replaces mlbapi rows for each game_id, so re-running a
  // successful week is a no-op — safe to retry after a partial failure.
  const today = new Date().toISOString().split('T')[0];
  const config = db.google_sheets_config || {};
  const season = config.season || new Date().getFullYear().toString();
  const sd = (db.seasons || {})[season];
  let weeksSynced = 0;
  if (sd) {
    const dates = sd.schedule_dates || [];
    for (let i = 0; i < SEASON_SCHEDULE.length && i < dates.length; i++) {
      const { start } = dates[i] || {};
      if (!start || start > today) continue; // skip future weeks
      const schedWeek = SEASON_SCHEDULE[i];
      try {
        const result = await performMLBSync(sd, schedWeek, dates[i], {
          trigger: 'auto',
          note: 'startup-backfill',
        });
        weeksSynced++;
        console.log(
          `[MLB-API takeover] Synced ${season} ${schedWeek.round} ${schedWeek.week} — ` +
            `${result.games_fetched} games, ${result.batting_imported}B / ${result.pitching_imported}P`
        );
      } catch (e) {
        console.error(
          `[MLB-API takeover] Sync failed for ${season} ${schedWeek.round} ${schedWeek.week}: ${e.message}`
        );
        // Leave the flag unset so the next startup retries; partial progress
        // is preserved by the caller's writeDB.
        return true;
      }
    }
  }

  db.mlb_api_takeover_v1 = true;
  console.log(
    `[MLB-API takeover] Stripped ${stripped} gsheets-source row(s); backfilled ${weeksSynced} past week(s) from MLB; gsheets auto-sync disabled (re-enable from commissioner UI to use as a fallback).`
  );
  return true;
}

// Collapse weekly_batting / weekly_pitching duplicates that arise when both
// the Google Sheets sync and the MLB-API sync have written rows for the same
// (round, week, player) — each sync's filter only purges its own source, so
// the rows pile up and the on-page Batting Total / Pitching Total subtotals
// double-count. We keep at most one row per (round, week, player), preferring
// rows the commissioner has touched (manual_fields / drop_locked) and
// otherwise the most recently pushed entry.
function dedupeWeeklyRows(sd) {
  let removed = 0;
  for (const arrName of ['weekly_batting', 'weekly_pitching']) {
    const arr = sd[arrName];
    if (!Array.isArray(arr)) continue;
    const playerKey = arrName === 'weekly_batting' ? 'batter' : 'pitcher';
    const isManual = (r) => (r.manual_fields && r.manual_fields.length > 0) || r.drop_locked;
    const winnerByKey = new Map();
    arr.forEach((r, idx) => {
      const key = `${r.round}|${r.week}|${r[playerKey]}`;
      const existing = winnerByKey.get(key);
      if (!existing) {
        winnerByKey.set(key, { row: r, idx });
        return;
      }
      // Keep the commissioner-touched row; otherwise the later push wins.
      if (isManual(existing.row) && !isManual(r)) return;
      if (isManual(r) && !isManual(existing.row)) {
        winnerByKey.set(key, { row: r, idx });
        return;
      }
      winnerByKey.set(key, { row: r, idx });
    });
    const survivors = [...winnerByKey.values()].sort((a, b) => a.idx - b.idx).map((v) => v.row);
    if (survivors.length !== arr.length) {
      removed += arr.length - survivors.length;
      sd[arrName] = survivors;
    }
  }
  return removed;
}

// Re-derive QS on existing pitching records using the WMMC rule. Idempotent
// — repeated runs converge on the same values — so it's safe to invoke on
// every server startup. Manual commissioner overrides (manual_fields=qs or
// drop_locked) are left intact. After fixing the daily deltas we refresh the
// cumulative QS on each weekly_pitching row and recompute weekly_score so
// every downstream view (My Roster, scoreboard, Live tab) agrees.
function backfillWmmcQS(db) {
  let dailyTouched = 0;
  let weeklyTouched = 0;
  let dupesRemoved = 0;
  for (const sd of Object.values(db.seasons || {})) {
    if (!sd) continue;
    dupesRemoved += dedupeWeeklyRows(sd);
    for (const r of sd.daily_pitching || []) {
      if ((r.manual_fields || []).includes('qs') || r.drop_locked) continue;
      const d = r.delta || {};
      const gs = d.gs || 0;
      const prev = d.qs || 0;
      let next = prev;
      if (gs === 1) next = isWmmcQS(1, d.ip, d.er);
      else if (gs === 0) next = 0;
      if (next !== prev) {
        d.qs = next;
        dailyTouched++;
      }
    }
    for (const wp of sd.weekly_pitching || []) {
      if ((wp.manual_fields || []).includes('qs') || wp.drop_locked) continue;
      const dailies = (sd.daily_pitching || []).filter(
        (d) => d.pitcher === wp.pitcher && d.round === wp.round && d.week === wp.week
      );
      const prevQs = wp.qs || 0;
      const prevHighlight = wp.qs_highlight === true;
      if (dailies.length > 0) {
        wp.qs = dailies.reduce((s, d) => s + ((d.delta && d.delta.qs) || 0), 0);
        // Per-game data is authoritative now, so the multi-start manual-review
        // flag (which made My Roster render "—" for the QS column) no longer
        // applies — clear it so the computed value is visible.
        wp.qs_highlight = false;
      } else {
        // No per-day records: apply the rule directly when single-start, zero
        // out no-start weeks, and leave multi-start cumulatives alone.
        const gs = wp.gs || 0;
        if (gs === 1) {
          wp.qs = isWmmcQS(1, wp.ip, wp.er);
          wp.qs_highlight = false;
        } else if (gs === 0) {
          wp.qs = 0;
          wp.qs_highlight = false;
        }
        if ((wp.qs || 0) !== prevQs) wp.weekly_score = calculatePitchingScore(wp);
      }
      if ((wp.qs || 0) !== prevQs || prevHighlight !== (wp.qs_highlight === true)) weeklyTouched++;
    }
    // Rebuild player_dates from roster_dates so add_date cutoffs land on the
    // game day (the new policy) rather than the day after (the old gsheets
    // shift). Then recompute weekly_scores so existing rows pick up the fix
    // without waiting for the next 4am sync.
    syncPlayerDatesFromRosterDates(sd);
    recomputeAllWeeklyScores(sd);
  }
  if (dailyTouched > 0 || weeklyTouched > 0 || dupesRemoved > 0) {
    console.log(
      `[WMMC-QS] Backfill: corrected ${dailyTouched} daily delta(s), ${weeklyTouched} weekly row(s), removed ${dupesRemoved} duplicate weekly row(s)`
    );
  }
}

// ============================================================
// Slack Scoreboard Builder
// ============================================================

const ROUND_LABELS = {
  PP1: 'Pool Play 1',
  PP2: 'Pool Play 2',
  QF: 'Quarterfinals',
  SF: 'Semifinals',
  Finals: 'Finals',
};
const ROUND_ORDER = ['PP1', 'PP2', 'QF', 'SF', 'Finals'];

function detectCurrentRound(scheduleDates) {
  const today = new Date().toISOString().split('T')[0];

  // Find a week whose date range contains today
  for (let i = 0; i < SEASON_SCHEDULE.length && i < scheduleDates.length; i++) {
    const { start, end } = scheduleDates[i] || {};
    if (start && end && today >= start && today <= end) return SEASON_SCHEDULE[i].round;
  }

  // Fall back to the most recently completed round
  for (let i = SEASON_SCHEDULE.length - 1; i >= 0; i--) {
    const { end } = scheduleDates[i] || {};
    if (end && today > end) return SEASON_SCHEDULE[i].round;
  }

  return null;
}

// Per-week subtotal for one manager. Mirrors app.js' managerWeekSubtotal
// exactly so the Slack scoreboard and Live tab totals reconcile to the
// in-app My Roster page (wasDroppedBefore filter -> eligibility set ->
// manager/null dedup -> sum of weekly_score).
// `detailOut` (optional): when provided, each eligible player row that
// contributes to the subtotal is pushed as { player, score } — used by the
// daily score-snapshot trail to record per-player breakdowns without changing
// the numeric return value the other callers rely on.
function managerWeekSubtotal(sd, managerName, schedWeek, weekIdx, rowsArr, playerKey, listKey, detailOut) {
  if (!sd || !managerName) return 0;
  const round = schedWeek.round;
  const week = schedWeek.week;
  const weekKey = `${round}|${week}`;

  // Legacy 'PP1P' / 'PP2P' import variants share weeks with their parents.
  const matchesRoundWeek = (r) => {
    if (r.week !== week) return false;
    if (r.round === round) return true;
    if (r.round && r.round.endsWith('P') && r.round.slice(0, -1) === round) return true;
    return false;
  };

  const scheduleDates = sd.schedule_dates || [];
  const seasonStartDate = scheduleDates[0] ? scheduleDates[0].start : null;
  // Scope to THIS manager — eligibility must never pull in another manager's swap-in.
  // The unscoped version leaked one manager's same-week add onto every other manager
  // who also had a swap that week (e.g. Austin's Shane Baz showing on Anton's roster).
  const approvedSwaps = (sd.swaps || []).filter((s) => s.status === 'approved' && s.manager === managerName);
  const allMgrDates = (sd.roster_dates && sd.roster_dates[managerName]) || null;

  let weekRoster = (sd.rosters && sd.rosters[managerName] && sd.rosters[managerName][weekKey]) || {
    batters: [],
    pitchers: [],
  };
  const weekRosterDates =
    (sd.roster_dates && sd.roster_dates[managerName] && sd.roster_dates[managerName][weekKey]) || {};

  const weekStart = scheduleDates[weekIdx] ? scheduleDates[weekIdx].start : null;
  if (weekStart && allMgrDates) {
    const addedThisWeek = new Set([
      ...approvedSwaps.filter((s) => s.player_in && s.week_key === weekKey).map((s) => s.player_in),
      ...Object.entries(weekRosterDates)
        .filter(([, d]) => d.add_date)
        .map(([p]) => p),
    ]);
    const wasDroppedBefore = (player) => {
      if (addedThisWeek.has(player)) return false;
      for (const [wk, players] of Object.entries(allMgrDates)) {
        if (wk === weekKey) continue;
        const pd = players[player];
        if (pd && pd.drop_date && pd.drop_date < weekStart) {
          const reAddedLater = Object.values(allMgrDates).some(
            (wkp) => wkp[player] && wkp[player].add_date > pd.drop_date && wkp[player].add_date < weekStart
          );
          if (!reAddedLater) return true;
        }
      }
      return false;
    };
    weekRoster = {
      batters: weekRoster.batters.filter((p) => !wasDroppedBefore(p)),
      pitchers: weekRoster.pitchers.filter((p) => !wasDroppedBefore(p)),
    };
  }

  // Carry-forward eligibility: a player added in an earlier (or this) week via
  // roster_dates and not dropped as of this week is still rostered now, even if a
  // stale roster array (or a first-season repair) never carried them into this
  // week's array. Without this, a mid-season swap-in silently stops scoring the
  // week after it was added (e.g. Devers added 5/9 vanished from Weeks 2+). Mirrors
  // the frontend's isStillActiveForMgr but evaluated as of this week's end.
  const weekEnd = scheduleDates[weekIdx] ? scheduleDates[weekIdx].end : null;
  // Carry-forward is scoped to the player's PERIOD: a new submission period (PP2/QF/SF/Finals)
  // starts fresh from its own submission, so an add/drop in a PRIOR period must not keep a player
  // "active" here. Without this, a PP1 holdover with no drop reads as active in PP2 and gets
  // credited once PP2 scores. null (initial period) = no lower bound, leaving PP1 untouched.
  const periodStart = periodStartForRound(sd, round);
  const activeByDates = [];
  if (allMgrDates) {
    const latestAdd = {};
    const latestDrop = {};
    for (const players of Object.values(allMgrDates)) {
      for (const [p, d] of Object.entries(players)) {
        if (
          d.add_date &&
          (!periodStart || d.add_date >= periodStart) &&
          (!weekEnd || d.add_date <= weekEnd) &&
          (!latestAdd[p] || d.add_date > latestAdd[p])
        ) {
          latestAdd[p] = d.add_date;
        }
        if (
          d.drop_date &&
          (!periodStart || d.drop_date >= periodStart) &&
          (!weekEnd || d.drop_date <= weekEnd) &&
          (!latestDrop[p] || d.drop_date > latestDrop[p])
        ) {
          latestDrop[p] = d.drop_date;
        }
      }
    }
    for (const p of Object.keys(latestAdd)) {
      if (!latestDrop[p] || latestAdd[p] > latestDrop[p]) activeByDates.push(p);
    }
  }

  const eligible = new Set([
    ...weekRoster[listKey],
    ...activeByDates,
    ...Object.keys(weekRosterDates).filter(
      (p) => !seasonStartDate || !weekRosterDates[p].drop_date || weekRosterDates[p].drop_date >= seasonStartDate
    ),
    ...approvedSwaps
      .filter(
        (s) =>
          s.player_in &&
          s.week_key === weekKey &&
          (!seasonStartDate || !s.swap_date || s.swap_date >= seasonStartDate) &&
          (weekRosterDates[s.player_in] || rowsArr.some((r) => r[playerKey] === s.player_in && matchesRoundWeek(r)))
      )
      .map((s) => s.player_in),
  ]);

  const weekManagerRows = rowsArr.filter((r) => r.manager === managerName && matchesRoundWeek(r));
  const allWeekRows = weekManagerRows.slice();
  rowsArr.forEach((r) => {
    if (
      matchesRoundWeek(r) &&
      !r.manager &&
      eligible.has(r[playerKey]) &&
      !allWeekRows.some((x) => x[playerKey] === r[playerKey])
    ) {
      allWeekRows.push(r);
    }
  });

  const finalRows = allWeekRows.filter((r) => eligible.has(r[playerKey]));
  if (detailOut) {
    for (const r of finalRows) detailOut.push({ player: r[playerKey], score: r.weekly_score || 0 });
  }
  return finalRows.reduce((s, r) => s + (r.weekly_score || 0), 0);
}

// Sum batting + pitching weekly_scores for the given rounds, scoped per
// manager. `rounds` may be null/undefined to sum across every round.
function computeRoundScores(batting, pitching, rounds, sd) {
  if (!sd) {
    // Backwards-compat: no season data available — fall back to a naive
    // sum by row.manager (matches the pre-refactor behavior).
    const roundSet = rounds ? new Set(rounds) : null;
    const map = {};
    const credit = (rows, type) => {
      for (const r of rows) {
        if (roundSet && !roundSet.has(r.round)) continue;
        const mgr = r.manager;
        if (!mgr) continue;
        if (!map[mgr]) map[mgr] = { batting: 0, pitching: 0 };
        map[mgr][type] += r.weekly_score || 0;
      }
    };
    credit(batting, 'batting');
    credit(pitching, 'pitching');
    return Object.entries(map).map(([manager, s]) => ({
      manager,
      batting: Math.round(s.batting * 100) / 100,
      pitching: Math.round(s.pitching * 100) / 100,
      total: Math.round((s.batting + s.pitching) * 100) / 100,
    }));
  }

  // Derive the manager list from rosters + attributed stat rows.
  const managers = new Set(Object.keys(sd.rosters || {}));
  for (const r of batting) if (r.manager) managers.add(r.manager);
  for (const r of pitching) if (r.manager) managers.add(r.manager);

  const targetRounds = rounds ? new Set(rounds.map((r) => (r && r.endsWith('P') ? r.slice(0, -1) : r))) : null;

  const map = {};
  SEASON_SCHEDULE.forEach((schedWeek, idx) => {
    if (targetRounds && !targetRounds.has(schedWeek.round)) return;
    for (const mgr of managers) {
      const bat = managerWeekSubtotal(sd, mgr, schedWeek, idx, batting, 'batter', 'batters');
      const pit = managerWeekSubtotal(sd, mgr, schedWeek, idx, pitching, 'pitcher', 'pitchers');
      if (bat || pit) {
        if (!map[mgr]) map[mgr] = { batting: 0, pitching: 0 };
        map[mgr].batting += bat;
        map[mgr].pitching += pit;
      }
    }
  });

  return Object.entries(map).map(([manager, s]) => ({
    manager,
    batting: Math.round(s.batting * 100) / 100,
    pitching: Math.round(s.pitching * 100) / 100,
    total: Math.round((s.batting + s.pitching) * 100) / 100,
  }));
}

// ============================================================
// Score-swing guard + daily snapshot trail
// ============================================================
// The Overall standings are recomputed live from rosters + add/drop dates +
// swaps on every compile, so a single bad date or swap can retroactively move a
// manager's cumulative total by hundreds of points. These helpers snapshot the
// per-manager (and per-player/week) totals before and after each compile, flag
// suspicious DOWNWARD swings, and keep a rolling trail so any swing can be
// traced to the exact player/week that moved.

// Number of full-detail daily snapshots retained per season (rolling window).
const MAX_SCORE_SNAPSHOTS = 21;

// Build a full snapshot of the current standings: per-manager totals plus a
// per-manager / per-week / per-player breakdown. Mirrors computeRoundScores'
// attribution (managerWeekSubtotal) so the snapshot always matches what the
// scoreboard shows.
function captureScoreSnapshot(sd, dateISO) {
  const batting = sd.weekly_batting || [];
  const pitching = sd.weekly_pitching || [];
  const managers = new Set(Object.keys(sd.rosters || {}));
  for (const r of batting) if (r.manager) managers.add(r.manager);
  for (const r of pitching) if (r.manager) managers.add(r.manager);

  const totals = {};
  const detail = {};
  SEASON_SCHEDULE.forEach((schedWeek, idx) => {
    const wk = `${schedWeek.round}|${schedWeek.week}`;
    for (const mgr of managers) {
      const batRows = [];
      const pitRows = [];
      const bat = managerWeekSubtotal(sd, mgr, schedWeek, idx, batting, 'batter', 'batters', batRows);
      const pit = managerWeekSubtotal(sd, mgr, schedWeek, idx, pitching, 'pitcher', 'pitchers', pitRows);
      if (!bat && !pit && batRows.length === 0 && pitRows.length === 0) continue;
      if (!totals[mgr]) totals[mgr] = { total: 0, batting: 0, pitching: 0 };
      totals[mgr].batting += bat;
      totals[mgr].pitching += pit;
      totals[mgr].total += bat + pit;
      if (!detail[mgr]) detail[mgr] = {};
      detail[mgr][wk] = {
        batting: Math.round(bat * 100) / 100,
        pitching: Math.round(pit * 100) / 100,
        batters: Object.fromEntries(batRows.map((r) => [r.player, Math.round(r.score * 100) / 100])),
        pitchers: Object.fromEntries(pitRows.map((r) => [r.player, Math.round(r.score * 100) / 100])),
      };
    }
  });
  for (const m of Object.keys(totals)) {
    totals[m].total = Math.round(totals[m].total * 100) / 100;
    totals[m].batting = Math.round(totals[m].batting * 100) / 100;
    totals[m].pitching = Math.round(totals[m].pitching * 100) / 100;
  }
  return { date: dateISO, captured_at: new Date().toISOString(), totals, detail };
}

// Append a snapshot to the rolling trail (one per date — a same-day re-run
// replaces the prior entry), pruned to MAX_SCORE_SNAPSHOTS.
function recordScoreSnapshot(sd, snapshot) {
  if (!sd.score_snapshots) sd.score_snapshots = [];
  sd.score_snapshots = sd.score_snapshots.filter((s) => s.date !== snapshot.date);
  sd.score_snapshots.push(snapshot);
  sd.score_snapshots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sd.score_snapshots.length > MAX_SCORE_SNAPSHOTS) {
    sd.score_snapshots = sd.score_snapshots.slice(-MAX_SCORE_SNAPSHOTS);
  }
}

// Synced copy of js/scoring.js detectScoreSwings — the canonical, unit-tested
// version lives there. Keep both in sync. (See CLAUDE.md "two places that must
// stay in sync".)
function detectScoreSwings(before = {}, after = {}, opts = {}) {
  const blockDropPts = opts.blockDropPts != null ? opts.blockDropPts : 40;
  const warnGainPts = opts.warnGainPts != null ? opts.warnGainPts : 200;

  const tot = (v) => (typeof v === 'number' ? v : v && typeof v.total === 'number' ? v.total : 0);
  const managers = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);

  const swings = [];
  for (const m of managers) {
    const b = tot(before[m]);
    const a = tot(after[m]);
    const delta = Math.round((a - b) * 100) / 100;
    const pct = b > 0 ? delta / b : 0;
    swings.push({ manager: m, before: b, after: a, delta, pct });
  }
  swings.sort((x, y) => x.delta - y.delta);

  const warnings = [];
  const blockers = [];
  for (const s of swings) {
    if (-s.delta >= blockDropPts) {
      blockers.push(s);
    } // dropped 40+ pts — block
    else if (s.delta > warnGainPts) warnings.push(s); // jumped >200 pts — warn
  }

  const maxDrop = swings.length ? Math.max(0, -swings[0].delta) : 0;
  const maxGain = swings.length ? Math.max(0, swings[swings.length - 1].delta) : 0;
  return {
    swings,
    warnings,
    blockers,
    block: blockers.length > 0,
    maxDrop,
    maxGain,
    thresholds: { blockDropPts, warnGainPts },
  };
}

// Format a list of swing rows for a Slack alert.
function formatSwingLines(rows) {
  return rows
    .map(
      (s) =>
        `• ${s.manager}: ${s.before} → ${s.after} (${s.delta >= 0 ? '+' : ''}${s.delta}, ` +
        `${(s.pct * 100).toFixed(1)}%)`
    )
    .join('\n');
}

// Evaluate a completed (in-memory) compile against the pre-compile totals.
// Returns { snapshot, report, blocked }. Does NOT write the db — the caller
// decides whether to commit (recordScoreSnapshot + writeDB) based on `blocked`.
// `force` overrides a block (commissioner "I know what I'm doing").
function evaluateScoreGuard(beforeTotals, sd, opts = {}) {
  const { dateISO, force = false, trigger = 'auto', year } = opts;
  const snapshot = captureScoreSnapshot(sd, dateISO);
  const report = detectScoreSwings(beforeTotals, snapshot.totals);
  const blocked = report.block && !force;

  if (report.block) {
    // Blockers are downward swings of 40+ pts — the case we refuse to save.
    const header = blocked
      ? ':warning: *Score guard BLOCKED a compile* — scores NOT saved (drop of 40+ pts).'
      : ':warning: *Score guard tripped* (force-overridden — scores saved).';
    postSlack(
      `${header}\n` +
        `Season ${year || ''} • ${dateISO} • trigger: ${trigger}\n` +
        `Largest drops:\n${formatSwingLines(report.blockers)}\n` +
        (blocked ? '_Review rosters / swaps / add-drop dates, then re-run Sync Now (Force to override)._' : '')
    ).catch(() => {});
  } else if (report.warnings.length > 0) {
    // Warnings are unusually large UPWARD jumps (>200 pts) — saved, just flagged.
    postSlack(
      `:eyes: *Score guard: large upward jump (>200 pts)* (${dateISO}, ${trigger}) — scores saved, worth a look.\n` +
        formatSwingLines(report.warnings)
    ).catch(() => {});
  }

  return { snapshot, report, blocked };
}

// Diff two stored snapshots (a = earlier, b = later) down to the player level,
// surfacing only managers / weeks / players whose score actually moved. Used by
// the score-guard read endpoint to answer "what changed?" after a swing.
function diffScoreSnapshots(a, b) {
  const managers = new Set([...Object.keys(a.totals || {}), ...Object.keys(b.totals || {})]);
  const out = [];
  for (const m of managers) {
    const at = (a.totals[m] || {}).total || 0;
    const bt = (b.totals[m] || {}).total || 0;
    const delta = Math.round((bt - at) * 100) / 100;
    if (Math.abs(delta) < 0.01) continue;

    const aWk = (a.detail || {})[m] || {};
    const bWk = (b.detail || {})[m] || {};
    const weeks = [];
    for (const wk of new Set([...Object.keys(aWk), ...Object.keys(bWk)])) {
      const aw = aWk[wk] || { batting: 0, pitching: 0, batters: {}, pitchers: {} };
      const bw = bWk[wk] || { batting: 0, pitching: 0, batters: {}, pitchers: {} };
      const wkDelta = Math.round((bw.batting + bw.pitching - (aw.batting + aw.pitching)) * 100) / 100;
      if (Math.abs(wkDelta) < 0.01) continue;

      const players = [];
      for (const type of ['batters', 'pitchers']) {
        const names = new Set([...Object.keys(aw[type] || {}), ...Object.keys(bw[type] || {})]);
        for (const name of names) {
          const before = (aw[type] || {})[name] || 0;
          const after = (bw[type] || {})[name] || 0;
          const pd = Math.round((after - before) * 100) / 100;
          if (Math.abs(pd) >= 0.01) players.push({ player: name, type, before, after, delta: pd });
        }
      }
      players.sort((x, y) => x.delta - y.delta);
      weeks.push({ week: wk, delta: wkDelta, players });
    }
    weeks.sort((x, y) => x.delta - y.delta);
    out.push({ manager: m, before: at, after: bt, delta, weeks });
  }
  out.sort((x, y) => x.delta - y.delta);
  return out;
}

// Reconcile every manager's per-week roster ARRAYS with the authoritative
// roster_dates add/drop history. Purely additive: for each existing week it adds
// any player who is active that week per their add/drop dates but missing from
// the array (the stale-array bug that hid carried-forward swap-ins like Devers
// from the roster view and per-player breakdown). Never removes a player, so it
// can't drop a legitimate slot. Batter/pitcher type comes from the manager's own
// arrays + weekly rows first; pools are used only for single-type players so a
// two-way player (Ohtani) is never forced onto a manager who didn't roster him
// both ways. Returns a list of the additions made.
function rebuildRosterArraysFromDates(sd) {
  const scheduleDates = sd.schedule_dates || [];
  const weekIdxByKey = {};
  SEASON_SCHEDULE.forEach((s, i) => (weekIdxByKey[`${s.round}|${s.week}`] = i));
  const batPool = new Set(sd.batters_pool || []);
  const pitPool = new Set(sd.pitchers_pool || []);

  const changes = [];
  for (const [mgr, weeks] of Object.entries(sd.rosters || {})) {
    const mgrDates = (sd.roster_dates || {})[mgr];
    if (!mgrDates || !weeks) continue;

    // Classify names this manager touches as batter and/or pitcher.
    const batterNames = new Set();
    const pitcherNames = new Set();
    for (const wr of Object.values(weeks)) {
      for (const p of wr.batters || []) batterNames.add(p);
      for (const p of wr.pitchers || []) pitcherNames.add(p);
    }
    for (const r of sd.weekly_batting || []) if (r.manager === mgr && r.batter) batterNames.add(r.batter);
    for (const r of sd.weekly_pitching || []) if (r.manager === mgr && r.pitcher) pitcherNames.add(r.pitcher);
    const allDated = new Set();
    for (const players of Object.values(mgrDates)) for (const p of Object.keys(players)) allDated.add(p);
    for (const p of allDated) {
      const inBat = batPool.has(p);
      const inPit = pitPool.has(p);
      if (inBat && !inPit) batterNames.add(p);
      else if (inPit && !inBat) pitcherNames.add(p); // both/neither: rely on arrays + rows
    }

    for (const weekKey of Object.keys(weeks)) {
      const idx = weekIdxByKey[weekKey];
      const weekEnd = idx != null && scheduleDates[idx] ? scheduleDates[idx].end : null;
      // Scope carry-forward to this week's PERIOD so a prior period's players don't leak into a new
      // submission period (PP2/QF/SF/Finals start from their own submission). Mirrors the same
      // guard in managerWeekSubtotal; null for the initial period leaves PP1 unchanged.
      const periodStart = periodStartForRound(sd, weekKey.split('|')[0]);

      // Players whose most-recent roster_dates event as of this week's end is an add.
      const latestAdd = {};
      const latestDrop = {};
      for (const players of Object.values(mgrDates)) {
        for (const [p, d] of Object.entries(players)) {
          if (
            d.add_date &&
            (!periodStart || d.add_date >= periodStart) &&
            (!weekEnd || d.add_date <= weekEnd) &&
            (!latestAdd[p] || d.add_date > latestAdd[p])
          ) {
            latestAdd[p] = d.add_date;
          }
          if (
            d.drop_date &&
            (!periodStart || d.drop_date >= periodStart) &&
            (!weekEnd || d.drop_date <= weekEnd) &&
            (!latestDrop[p] || d.drop_date > latestDrop[p])
          ) {
            latestDrop[p] = d.drop_date;
          }
        }
      }
      const active = Object.keys(latestAdd).filter((p) => !latestDrop[p] || latestAdd[p] > latestDrop[p]);

      const wr = weeks[weekKey];
      if (!Array.isArray(wr.batters)) wr.batters = [];
      if (!Array.isArray(wr.pitchers)) wr.pitchers = [];
      const addedBat = [];
      const addedPit = [];
      for (const p of active) {
        if (batterNames.has(p) && !wr.batters.includes(p)) {
          wr.batters.push(p);
          addedBat.push(p);
        }
        if (pitcherNames.has(p) && !wr.pitchers.includes(p)) {
          wr.pitchers.push(p);
          addedPit.push(p);
        }
      }
      if (addedBat.length || addedPit.length) {
        changes.push({ manager: mgr, week: weekKey, added_batters: addedBat, added_pitchers: addedPit });
      }
    }
  }
  return changes;
}

// Rebuild a WIPED rosters object from scratch. rebuildRosterArraysFromDates (above) is purely
// additive — it only augments week entries that already exist — so it cannot recover from a
// stale-save wipe that left sd.rosters === {}.
//
// The arrays must hold each week's DATE-WINDOWED roster: a player belongs to a week only while
// they were actually rostered (on/after their add, on/before their drop). That is exactly the
// eligibility the scoreboard already derives from roster_dates + swaps (managerWeekSubtotal's
// `activeByDates`), which is why standings stayed correct this morning even with rosters === {}.
//
// Do NOT seed the arrays from the `manager` field on weekly stat rows: that field is sticky — a
// dropped/swapped player keeps `manager: X` on their later-week rows — so trusting it re-adds
// players to weeks they had already left (a PP2-only player showing in PP1, a Week-3 add scoring
// in Weeks 1–2) and re-inflates totals. roster_dates is the only swap-honored source.
//
// So: reset, seed an entry for every manager × already-started week, then let
// rebuildRosterArraysFromDates populate them with the date-windowed active set. The result equals
// `activeByDates`, so it restores findManagerForPlayerWeek (Best/Worst, Live tab) WITHOUT moving
// any total. Idempotent — a full reset each run yields the identical result.
function reconstructRostersFromSurvivingData(sd) {
  sd.rosters = {};
  const ensure = (mgr, key) => {
    if (!sd.rosters[mgr]) sd.rosters[mgr] = {};
    if (!sd.rosters[mgr][key]) sd.rosters[mgr][key] = { batters: [], pitchers: [] };
    return sd.rosters[mgr][key];
  };

  // Seed an entry for every manager × already-started week so the (additive) heal has a slot.
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const scheduleDates = sd.schedule_dates || [];
  const managers = new Set(Object.keys(sd.roster_dates || {}));
  for (const r of sd.weekly_batting || []) if (r.manager) managers.add(r.manager);
  for (const r of sd.weekly_pitching || []) if (r.manager) managers.add(r.manager);
  for (const mgr of managers) {
    for (let i = 0; i < SEASON_SCHEDULE.length && i < scheduleDates.length; i++) {
      const d = scheduleDates[i];
      if (!d || !d.start || d.start > todayET) continue; // only weeks that have started
      ensure(mgr, `${SEASON_SCHEDULE[i].round}|${SEASON_SCHEDULE[i].week}`);
    }
  }

  // Populate each seeded week from roster_dates + swaps, honoring every add/drop window.
  rebuildRosterArraysFromDates(sd);

  // Belt-and-suspenders: guarantee each already-started NON-initial period's first week contains
  // its approved submission roster. The date heal above already includes these players (their
  // submission writes a period add_date), but sourcing them straight from period_submissions means
  // a player kept from a prior period can never be lost even if that add is missing — directly
  // honoring "don't drop a PP1 player's status when the period rolls over". A player the manager
  // has since dropped within the period (latest period action is a drop) is skipped so a real
  // in-period drop isn't undone.
  const periodKeyByRound = { PP2: 'pp2', QF: 'qf', SF: 'sf', Finals: 'finals' };
  for (let i = 0; i < SEASON_SCHEDULE.length && i < scheduleDates.length; i++) {
    if (!isPeriodBoundaryWeek(i)) continue; // first week of a new submission period only
    const d = scheduleDates[i];
    if (!d || !d.start || d.start > todayET) continue; // period hasn't started
    const { round, week } = SEASON_SCHEDULE[i];
    const pStart = periodStartForRound(sd, round);
    const bucket = (sd.period_submissions || {})[periodKeyByRound[round]] || {};
    const key = `${round}|${week}`;
    for (const [mgr, sub] of Object.entries(bucket)) {
      if (!sub || sub.status !== 'approved') continue;
      const mgrDates = (sd.roster_dates || {})[mgr] || {};
      const droppedInPeriod = (player) => {
        let la = null;
        let ld = null;
        for (const wkDates of Object.values(mgrDates)) {
          const e = wkDates[player];
          if (!e) continue;
          if (e.add_date && (!pStart || e.add_date >= pStart) && (!la || e.add_date > la)) la = e.add_date;
          if (e.drop_date && (!pStart || e.drop_date >= pStart) && (!ld || e.drop_date > ld)) ld = e.drop_date;
        }
        return !!ld && (!la || ld >= la);
      };
      const wr = ensure(mgr, key);
      for (const b of sub.batters || []) if (!droppedInPeriod(b) && !wr.batters.includes(b)) wr.batters.push(b);
      for (const p of sub.pitchers || []) if (!droppedInPeriod(p) && !wr.pitchers.includes(p)) wr.pitchers.push(p);
    }
  }

  // Drop weeks that stayed empty (manager not rostered that week) so the arrays stay tidy and
  // findManagerForPlayerWeek never matches an empty slot.
  for (const mgr of Object.keys(sd.rosters)) {
    for (const key of Object.keys(sd.rosters[mgr])) {
      const w = sd.rosters[mgr][key];
      if (!(w.batters || []).length && !(w.pitchers || []).length) delete sd.rosters[mgr][key];
    }
    if (Object.keys(sd.rosters[mgr]).length === 0) delete sd.rosters[mgr];
  }

  return {
    managers: Object.keys(sd.rosters).length,
    week_entries: Object.values(sd.rosters).reduce((n, w) => n + Object.keys(w || {}).length, 0),
  };
}

// Compute high/low scores for a specific date (YYYY-MM-DD).
// Returns { bestManager, worstManager, bestPlayer, worstPlayer } or null if no data.
function computeDailyHighLow(sd, date) {
  const hadGame = (delta) => delta && Object.values(delta).some((v) => (parseFloat(v) || 0) !== 0);
  const dailyBat = (sd.daily_batting || []).filter((r) => r.date === date && hadGame(r.delta));
  const dailyPit = (sd.daily_pitching || []).filter((r) => r.date === date && hadGame(r.delta));
  if (dailyBat.length === 0 && dailyPit.length === 0) return null;

  // Aggregate player scores across games on the same day (e.g. doubleheaders)
  const batterScores = {};
  const batRoundWeek = {};
  for (const r of dailyBat) {
    batterScores[r.batter] = (batterScores[r.batter] || 0) + calculateBattingScore(r.delta || {});
    if (!batRoundWeek[r.batter]) batRoundWeek[r.batter] = { round: r.round, week: r.week };
  }
  const pitcherScores = {};
  const pitRoundWeek = {};
  for (const r of dailyPit) {
    pitcherScores[r.pitcher] = (pitcherScores[r.pitcher] || 0) + calculatePitchingScore(r.delta || {});
    if (!pitRoundWeek[r.pitcher]) pitRoundWeek[r.pitcher] = { round: r.round, week: r.week };
  }

  // Manager daily totals — respect player_dates date windows.
  // Track attributed players so the player high/low only covers rostered players.
  const managerTotals = {};
  const attributedBatters = new Set();
  const attributedPitchers = new Set();
  const addToManager = (playerName, pdType, score, round, week) => {
    const playerType = pdType === 'batter' ? 'batting' : 'pitching';
    const mgr = findManagerForPlayerWeek(sd, playerName, playerType, round, week);
    if (!mgr) return;

    const weekKey = `${round}|${week}`;
    const weekIdx = getScheduleWeekIndex(round, week);
    const weekDates = weekIdx >= 0 ? (sd.schedule_dates || [])[weekIdx] : null;
    const weekStart = weekDates ? weekDates.start : null;

    // Exclude players dropped before this week started (roster carry-overs from prior weeks).
    if (wasDroppedBeforeWeek(sd, mgr, playerName, weekKey, weekStart)) return;

    const override = (((sd.player_dates || {})[weekKey] || {})[pdType] || {})[playerName] || {};
    const effectiveStart = 'start' in override ? override.start : (weekDates && weekDates.start) || null;
    const effectiveEnd = 'end' in override ? override.end : (weekDates && weekDates.end) || null;
    if (effectiveStart && date < effectiveStart) return;
    if (effectiveEnd && date > effectiveEnd) return;

    if (!managerTotals[mgr]) managerTotals[mgr] = { batting: 0, pitching: 0 };
    managerTotals[mgr][playerType] += score;
    if (pdType === 'batter') attributedBatters.add(playerName);
    else attributedPitchers.add(playerName);
  };

  for (const [name, score] of Object.entries(batterScores)) {
    const { round, week } = batRoundWeek[name];
    addToManager(name, 'batter', score, round, week);
  }
  for (const [name, score] of Object.entries(pitcherScores)) {
    const { round, week } = pitRoundWeek[name];
    addToManager(name, 'pitcher', score, round, week);
  }

  // Combined rostered-player list for individual high/low
  const allPlayers = [
    ...Object.entries(batterScores)
      .filter(([name]) => attributedBatters.has(name))
      .map(([name, score]) => ({ name, score: Math.round(score * 100) / 100, type: 'Batter' })),
    ...Object.entries(pitcherScores)
      .filter(([name]) => attributedPitchers.has(name))
      .map(([name, score]) => ({ name, score: Math.round(score * 100) / 100, type: 'Pitcher' })),
  ];
  if (allPlayers.length === 0) return null;
  allPlayers.sort((a, b) => b.score - a.score);
  const managers = Object.entries(managerTotals)
    .map(([manager, s]) => ({
      manager,
      batting: Math.round(s.batting * 100) / 100,
      pitching: Math.round(s.pitching * 100) / 100,
      total: Math.round((s.batting + s.pitching) * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total);

  if (managers.length === 0) return null;

  return {
    topManagers: managers.slice(0, 3),
    bottomManagers: managers.slice(-3).reverse(),
    topPlayers: allPlayers.slice(0, 3),
    bottomPlayers: allPlayers.slice(-3).reverse(),
  };
}

function buildScoreboardBlocks(db, year) {
  const seasonData = (db.seasons || {})[year] || {};
  const managers = db.managers || [];

  const managerPoolMap = {};
  managers.forEach((m) => {
    if (m.pool) managerPoolMap[m.name] = m.pool;
  });

  // Determine current round
  const scheduleDates = seasonData.schedule_dates || [];
  let currentRound = detectCurrentRound(scheduleDates);

  // If still no round from dates, use the latest round present in data
  if (!currentRound) {
    const roundsWithData = new Set((seasonData.weekly_batting || []).map((b) => b.round));
    for (let i = ROUND_ORDER.length - 1; i >= 0; i--) {
      if (roundsWithData.has(ROUND_ORDER[i])) {
        currentRound = ROUND_ORDER[i];
        break;
      }
    }
  }

  const currentRoundLabel = ROUND_LABELS[currentRound] || currentRound || 'Season';

  // Find the specific week within the current round that contains today
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let currentWeek = null;
  for (let i = 0; i < SEASON_SCHEDULE.length && i < scheduleDates.length; i++) {
    const { start, end } = scheduleDates[i] || {};
    if (start && end && todayISO >= start && todayISO <= end) {
      currentWeek = SEASON_SCHEDULE[i].week;
      break;
    }
  }
  if (!currentWeek) {
    for (let i = SEASON_SCHEDULE.length - 1; i >= 0; i--) {
      const { end } = scheduleDates[i] || {};
      if (end && todayISO > end) {
        currentWeek = SEASON_SCHEDULE[i].week;
        break;
      }
    }
  }

  // Find the end date of the last week belonging to the current round
  let roundEndDate = null;
  if (currentRound) {
    for (let i = SEASON_SCHEDULE.length - 1; i >= 0; i--) {
      if (SEASON_SCHEDULE[i].round === currentRound && (scheduleDates[i] || {}).end) {
        roundEndDate = scheduleDates[i].end;
        break;
      }
    }
  }

  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  // ---- PP1 / PP2 pool winners (mirrors app hlClass logic) ----
  const poolGroups = {};
  Object.entries(managerPoolMap).forEach(([mgr, poolNum]) => {
    if (!poolGroups[poolNum]) poolGroups[poolNum] = [];
    poolGroups[poolNum].push(mgr);
  });

  const pp1Scores = computeRoundScores(batting, pitching, ['PP1'], seasonData);
  const pp2Scores = computeRoundScores(batting, pitching, ['PP2'], seasonData);

  const pp1WinnerSet = new Set();
  const pp2WinnerSet = new Set();
  Object.values(poolGroups).forEach((members) => {
    const best1 = pp1Scores.filter((s) => members.includes(s.manager)).sort((a, b) => b.total - a.total)[0];
    if (best1 && best1.total > 0) pp1WinnerSet.add(best1.manager);
    const best2 = pp2Scores.filter((s) => members.includes(s.manager)).sort((a, b) => b.total - a.total)[0];
    if (best2 && best2.total > 0) pp2WinnerSet.add(best2.manager);
  });

  const allPPWinners = new Set([...pp1WinnerSet, ...pp2WinnerSet]);
  const numWildcards = Math.max(0, 8 - allPPWinners.size);
  const wildcardSet = new Set();
  const ppOverall = computeRoundScores(batting, pitching, ['PP1', 'PP2'], seasonData).sort((a, b) => b.total - a.total);
  let wcCount = 0;
  for (const m of ppOverall) {
    if (wcCount >= numWildcards) break;
    if (!allPPWinners.has(m.manager) && m.total > 0) {
      wildcardSet.add(m.manager);
      wcCount++;
    }
  }

  // Color dot per manager: 🟢 PP1 leader, 🔵 PP2 leader, 🔷 both, 🟡 wildcard
  function dot(name, section) {
    const wonPP1 = pp1WinnerSet.has(name);
    const wonPP2 = pp2WinnerSet.has(name);
    if (section === 'overall') {
      if (wonPP1 && wonPP2) return '🔷';
      if (wonPP1) return '🟢';
      if (wonPP2) return '🔵';
      if (wildcardSet.has(name)) return '🟡';
      return null;
    }
    if (section === 'PP1') return wonPP1 ? '🟢' : null;
    if (section === 'PP2') return wonPP2 ? '🔵' : null;
    return null;
  }

  // ---- Overall standings (all rounds) ----
  // Route through computeRoundScores so we get the same roster-validated
  // attribution as the in-app Pool Play Scoreboard.
  const overall = computeRoundScores(batting, pitching, null, seasonData).sort((a, b) => b.total - a.total);

  const overallLastMgr = overall.length > 0 ? overall[overall.length - 1].manager : null;

  // ---- Current-round pool standings ----
  const poolStandings = currentRound
    ? computeRoundScores(batting, pitching, [currentRound], seasonData)
        .map((m) => ({ ...m, pool: managerPoolMap[m.manager] }))
        .sort((a, b) => b.total - a.total)
    : [];

  // Group by pool — already sorted desc so last entry = pool's last place
  const pools = {};
  poolStandings.forEach((m) => {
    const key = m.pool ? formatPool(m.pool) : 'Unassigned';
    if (!pools[key]) pools[key] = [];
    pools[key].push(m);
  });

  // ---- Formatters ----
  const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const rankEmoji = ['\u{1F947}', '\u{1F948}', '\u{1F949}']; // 🥇🥈🥉
  const rank = (i) => (i < 3 ? rankEmoji[i] : `${i + 1}.`);
  const rankPool = (i) => (i === 0 ? '\u{1F947}' : `${i + 1}.`); // 🥇 for pool leader only
  const heart = (n) => (Math.floor(n) === 69 ? ' ❤️' : ''); // ❤️ easter egg at 69
  const dumpster = '\u{1F5D1}️\u{1F4A6}'; // 🗑️💦 last place

  // ---- Build overall standings text ----
  const overallText = overall.length
    ? overall
        .map((m, i) => {
          const d = dot(m.manager, 'overall');
          const nameStr = d !== null ? `*${m.manager}*` : m.manager;
          const dotStr = d ? `${d} ` : '';
          const trash = m.manager === overallLastMgr ? ` ${dumpster}` : '';
          return `${rank(i)} ${dotStr}${nameStr}${trash} — ${fmt(m.total)}${heart(m.total)} pts`;
        })
        .join('\n')
    : '_No scores recorded yet._';

  // ---- Build pool text (combined into one string for the right column) ----
  const sortedPoolEntries = Object.entries(pools).sort((a, b) => a[0].localeCompare(b[0]));
  const poolText = sortedPoolEntries
    .map(([poolName, members]) => {
      const poolLastMgr = members.length > 0 ? members[members.length - 1].manager : null;
      const lines = members
        .map((m, i) => {
          const d = dot(m.manager, currentRound);
          const dotStr = d ? `${d} ` : '';
          const nameStr = i === 0 ? `*${m.manager}*` : m.manager;
          const trash = m.manager === poolLastMgr ? ' \u{1F4A9}' : '';
          return `${rankPool(i)} ${dotStr}${nameStr}${trash} — ${fmt(m.total)}${heart(m.total)} pts`;
        })
        .join('\n');
      return `*${poolName}*\n${lines}`;
    })
    .join('\n\n');

  // ---- Assemble blocks ----
  const blocks = [];

  blocks.push({ type: 'header', text: { type: 'plain_text', text: `⚾ WMMC Scoreboard — ${year}`, emoji: true } });

  // Warn managers when the most recent automated compile failed/was blocked, so they
  // know these numbers may be stale. Cleared automatically by the next successful sync.
  const syncStatus = seasonData.last_sync_status;
  if (syncStatus && syncStatus.ok === false) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '\u{26A0}\u{FE0F} *Heads up — this morning’s score update did not complete.* ' +
          'Yesterday’s stats may be missing or incomplete. The commissioner has been notified and is reviewing; ' +
          'standings below reflect the last verified totals.',
      },
    });
  }

  const periodLabel = currentWeek ? `${currentRoundLabel} - ${currentWeek}` : currentRoundLabel;
  const roundEndLabel = roundEndDate
    ? new Date(roundEndDate + 'T12:00:00Z').toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : null;
  const periodText = roundEndLabel
    ? `\u{1F4C5} Current Period: *${periodLabel}*\nCurrent Round ends: ${roundEndLabel}`
    : `\u{1F4C5} Current Period: *${periodLabel}*`;
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: periodText } });

  // Color legend shown during pool play rounds when leaders are determined
  if (['PP1', 'PP2'].includes(currentRound) && (pp1WinnerSet.size > 0 || pp2WinnerSet.size > 0)) {
    const parts = [];
    if (pp1WinnerSet.size > 0) parts.push('\u{1F7E2} PP1 Pool Leader');
    if (pp2WinnerSet.size > 0) parts.push('\u{1F535} PP2 Pool Leader');
    if (pp1WinnerSet.size > 0 && pp2WinnerSet.size > 0) parts.push('\u{1F537} Both');
    if (wildcardSet.size > 0) parts.push('\u{1F7E1} Wild Card');
    parts.push(`${dumpster} Last Place`);
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: parts.join('  ·  ') }] });
  }

  // ---- Standings: overall (left) + pool (right) in a 2-column layout ----
  blocks.push({ type: 'divider' });
  if (currentRound && poolText) {
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*\u{1F3C6} Overall Standings*\n${overallText}` },
        { type: 'mrkdwn', text: `*\u{1F4CA} ${currentRoundLabel} Pool Standings*\n${poolText}` },
      ],
    });
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*\u{1F3C6} Overall Standings*\n${overallText}` } });
  }

  // ---- Daily high/low section ----
  const yesterdayET = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  const dailyHL = computeDailyHighLow(seasonData, yesterdayET);
  if (dailyHL) {
    const dateLabel = new Date(yesterdayET + 'T12:00:00Z').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    const { topManagers, bottomManagers, topPlayers, bottomPlayers } = dailyHL;

    const fmtMgr = (m, i, isBottom) => {
      const label = isBottom ? `${i + 1}.` : rankEmoji[i] || `${i + 1}.`;
      return `${label} *${m.manager}* — ${fmt(m.total)} pts\n_(B: ${fmtInt(m.batting)} | P: ${fmt(m.pitching)})_`;
    };
    const fmtPlayer = (p, i, isBottom) => {
      const label = isBottom ? `${i + 1}.` : rankEmoji[i] || `${i + 1}.`;
      return `${label} *${p.name}* (${p.type}) — ${fmt(p.score)} pts`;
    };

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*\u{1F4C5} Yesterday's Best & Worst (${dateLabel})*` },
    });
    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `\u{1F3C6} *Best Manager Days*\n${topManagers.map((m, i) => fmtMgr(m, i, false)).join('\n')}`,
        },
        {
          type: 'mrkdwn',
          text: `\u{1F5D1}️ *Worst Manager Days*\n${bottomManagers.map((m, i) => fmtMgr(m, i, true)).join('\n')}`,
        },
      ],
    });
    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `\u{2B50} *Best Player Days*\n${topPlayers.map((p, i) => fmtPlayer(p, i, false)).join('\n')}`,
        },
        {
          type: 'mrkdwn',
          text: `\u{1F4C9} *Worst Player Days*\n${bottomPlayers.map((p, i) => fmtPlayer(p, i, true)).join('\n')}`,
        },
      ],
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '\u{1F517} View full scoreboard: <http://wmmc.live|wmmc.live>' }],
  });

  return {
    blocks,
    text: `⚾ WMMC Scoreboard (${year}) — ${currentRoundLabel} | wmmc.live`,
  };
}

// ============================================================
// Google Sheets Sync
// ============================================================

// Extract spreadsheet ID from URL or raw ID
function extractSpreadsheetId(input) {
  if (!input) return null;
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Might be a raw ID already
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input.trim())) return input.trim();
  return null;
}

// Fetch a single sheet tab via Google Sheets API v4
async function fetchSheetTab(spreadsheetId, tabName, apiKey) {
  const encodedTab = encodeURIComponent(tabName);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedTab}?key=${apiKey}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url);
    if (!resp.ok) {
      if (resp.status === 404 || resp.status === 400) return null;
      if (resp.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 65000));
        continue;
      }
      const text = await resp.text();
      if (resp.status === 429) {
        throw new Error('Google Sheets API rate limit exceeded. Please wait ~60 seconds before syncing again.');
      }
      throw new Error(`Google Sheets API error ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.values || [];
  }
}

// Parse sheet rows (first row = headers) into objects
function parseSheetRows(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0].map((h) => (h || '').trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = {};
    headers.forEach((h, j) => {
      row[h] = (values[i][j] || '').trim();
    });
    rows.push(row);
  }
  return rows;
}

// Flexible column lookup (case-insensitive)
function findCol(row, names) {
  for (const name of names) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === name.toLowerCase()) return row[key];
    }
  }
  return null;
}

// Propagate add/drop dates from roster_dates into player_dates so that
// computeEffectiveBattingScore / computeEffectivePitchingScore filter daily deltas
// to only the days a player was actually rostered. Only fills gaps — does not overwrite
// existing player_dates entries (commissioner manual overrides take precedence).
// Populate player_dates from roster_dates so per-day game records are
// filtered to the inclusive window the player was actually rostered.
//
// Date-range contract (matches the commissioner's mental model):
//   - A player with add_date = X scores from games dated X onward.
//   - A player with drop_date = Y scores up to and including games dated Y.
//   - A player rostered for the whole week (no add_date, no drop_date) scores
//     for every day in scheduleDates[weekIdx].
//
// Implementation notes:
//   - Records carry their actual game date (MLB-API per-game model), so
//     effectiveStart = add_date and effectiveEnd = drop_date — both
//     inclusive, no shift. The legacy +1 shift only made sense for the
//     gsheets snapshot model where a record dated X carried stats from X-1
//     (gsheets is stripped + disabled after the takeover).
//   - Entries created here are marked { auto: true } so they can be refreshed
//     on subsequent saves without clobbering manual commissioner overrides.
function syncPlayerDatesFromRosterDates(sd) {
  if (!sd || !sd.roster_dates) return new Set();
  if (!sd.player_dates) sd.player_dates = {};

  // Track auto entries that get wiped so callers can recompute the affected
  // weekly_score values. Without this, a player whose add_date is corrected
  // from a post-week-end value back to the week start would keep the zeroed
  // score that the now-removed cutoff produced.
  const wiped = new Set();

  // Wipe previously auto-generated entries so stale data (e.g. incorrect end dates
  // from an earlier version) is cleaned up on every run.
  for (const weekKey of Object.keys(sd.player_dates)) {
    for (const type of ['batter', 'pitcher']) {
      const typeMap = (sd.player_dates[weekKey] || {})[type];
      if (!typeMap) continue;
      for (const [player, entry] of Object.entries(typeMap)) {
        if (entry && entry.auto) {
          wiped.add(`${weekKey}|${type}|${player}`);
          delete typeMap[player];
        }
      }
    }
  }

  for (const mgrDates of Object.values(sd.roster_dates)) {
    for (const [weekKey, players] of Object.entries(mgrDates)) {
      // Look up the week start date to distinguish mid-week adds from initial roster.
      const parts = weekKey.split('|');
      const round = parts[0];
      const week = parts.slice(1).join('|');
      const weekIdx = SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === week);
      const weekStart =
        weekIdx >= 0 && sd.schedule_dates && sd.schedule_dates[weekIdx] ? sd.schedule_dates[weekIdx].start : null;

      for (const [player, dates] of Object.entries(players)) {
        if (!dates.add_date && !dates.drop_date) continue;

        // Inclusive game-date range, mirroring the commissioner's intent:
        //   - add_date sets a start cutoff only when strictly after weekStart
        //     (rostered from day 1 needs no override).
        //   - drop_date sets an end cutoff at the player's last rostered day.
        // Setting a key to null preserves the override semantics
        // (`'start' in override`) so computeEffective* knows there's no
        // cutoff on that side without falling back to weekDates.
        const needsStart = !!(dates.add_date && weekStart && dates.add_date > weekStart);
        const needsEnd = !!dates.drop_date;
        if (!needsStart && !needsEnd) continue;

        const entry = {
          start: needsStart ? dates.add_date : null,
          end: needsEnd ? dates.drop_date : null,
          auto: true,
        };

        for (const type of ['batter', 'pitcher']) {
          if (!sd.player_dates[weekKey]) sd.player_dates[weekKey] = {};
          if (!sd.player_dates[weekKey][type]) sd.player_dates[weekKey][type] = {};
          const existing = sd.player_dates[weekKey][type][player];
          if (existing && !existing.auto) continue; // preserve manual commissioner override
          sd.player_dates[weekKey][type][player] = entry;
        }
      }
    }
  }

  return wiped;
}

// Recompute weekly scores for any player whose roster_dates entry could have triggered
// a date-based cutoff at any point — i.e. anyone with an add_date set, plus any auto
// entry that was just wiped by syncPlayerDatesFromRosterDates. This covers three cases:
//   1. Current mid-week add (auto entry active): apply the cutoff from daily data.
//   2. add_date just corrected from post-week to the week start (auto entry wiped,
//      no new auto entry): restore full-week score that the old cutoff zeroed out.
//   3. Already-stale data from a prior save where the cutoff was wiped before this
//      logic existed: recompute on the next save to self-heal.
// Dropped players' banked scores are intentionally left alone (drop_locked check)
// because they may include stats dated after the week end (the morning sync captures
// the previous day's games, so a final-day pitcher's stats live in a record dated
// end+1, which is included by the +1-day shift in computeEffective*).
function recomputeMidWeekAddScores(sd, wipedAutoEntries = new Set()) {
  // Collect (weekKey, type, player) tuples to recompute.
  const toRecompute = new Set();

  // Current auto entries in player_dates (active mid-week cutoffs).
  for (const [weekKey, weekTypes] of Object.entries(sd.player_dates || {})) {
    for (const type of ['batter', 'pitcher']) {
      for (const [player, entry] of Object.entries(weekTypes[type] || {})) {
        if (entry && entry.auto) toRecompute.add(`${weekKey}|${type}|${player}`);
      }
    }
  }

  // Auto entries wiped this run that were not re-created.
  for (const key of wipedAutoEntries) toRecompute.add(key);

  // All roster_dates entries with an add_date or drop_date — covers the
  // no-longer-mid-week case, mid-week drops, and self-heals any stale
  // weekly_score values left from earlier saves.
  for (const mgrDates of Object.values(sd.roster_dates || {})) {
    for (const [weekKey, players] of Object.entries(mgrDates)) {
      for (const [player, dates] of Object.entries(players)) {
        if (!dates || (!dates.add_date && !dates.drop_date)) continue;
        toRecompute.add(`${weekKey}|batter|${player}`);
        toRecompute.add(`${weekKey}|pitcher|${player}`);
      }
    }
  }

  for (const key of toRecompute) {
    // Keys are formatted as `${weekKey}|${type}|${player}` where weekKey is
    // itself `${round}|${week}` (e.g. "PP1|Week 1"). Split from the right so
    // the embedded '|' in weekKey is not mistaken for a delimiter.
    const lastPipe = key.lastIndexOf('|');
    const secondLastPipe = key.lastIndexOf('|', lastPipe - 1);
    const player = key.slice(lastPipe + 1);
    const type = key.slice(secondLastPipe + 1, lastPipe);
    const weekKey = key.slice(0, secondLastPipe);
    const wkParts = weekKey.split('|');
    const round = wkParts[0];
    const week = wkParts.slice(1).join('|');

    if (type === 'batter') {
      (sd.weekly_batting || []).forEach((b) => {
        if (b.batter !== player || b.round !== round || b.week !== week) return;
        if (b.drop_locked || (b.manual_fields && b.manual_fields.length > 0)) return;
        const score = computeEffectiveBattingScore(sd, player, round, week);
        // If there is no daily data, preserve the stored score (e.g. gsheets-only weeks)
        // unless an auto cutoff is currently active, in which case 0 is the right answer.
        const hasAutoEntry = !!(((sd.player_dates || {})[weekKey] || {}).batter || {})[player];
        if (score !== null) {
          b.weekly_score = score;
          b.total_score = score;
        } else if (hasAutoEntry) {
          b.weekly_score = 0;
          b.total_score = 0;
        }
      });
    } else {
      (sd.weekly_pitching || []).forEach((p) => {
        if (p.pitcher !== player || p.round !== round || p.week !== week) return;
        if (p.drop_locked || (p.manual_fields && p.manual_fields.length > 0)) return;
        const score = computeEffectivePitchingScore(sd, player, round, week);
        const hasAutoEntry = !!(((sd.player_dates || {})[weekKey] || {}).pitcher || {})[player];
        if (score !== null) {
          p.weekly_score = score;
        } else if (hasAutoEntry) {
          p.weekly_score = 0;
        }
      });
    }
  }
}
// Mirrors the client-side repairGhostInitialRosterPlayers in app.js.
// Checks both roster.batters AND roster_dates entries (a manual removeFromRoster call removes
// from the roster array but leaves a roster_dates entry).  Purges all stats including
// drop_locked records — the lock was set against a player who was never legitimately rostered.
function repairGhostInitialRosterPlayers(sd) {
  if (!sd || !sd.initial_submissions || !sd.rosters) return false;
  const firstSched = SEASON_SCHEDULE[0];
  if (!firstSched) return false;
  const weekKey = `${firstSched.round}|${firstSched.week}`;
  let repaired = false;

  // Players involved in ANY approved swap (in or out, any week) are legitimate, not
  // ghosts: player_in was commissioner-added and player_out was genuinely rostered
  // before being swapped out, so the days they scored must survive even when the
  // recorded initial_submission is incomplete. (Previously this only protected
  // Week-1 swaps, which let a later swap's player be wrongly purged from Week 1.)
  const commAdded = new Set(
    (sd.swaps || []).filter((s) => s.status === 'approved').flatMap((s) => [s.player_in, s.player_out].filter(Boolean))
  );

  for (const [manager, sub] of Object.entries(sd.initial_submissions)) {
    const hasPlayers = (sub.batters || []).length > 0 || (sub.pitchers || []).length > 0;
    if (!hasPlayers) continue;
    const mgrRoster = sd.rosters[manager];
    if (!mgrRoster || !mgrRoster[weekKey]) continue;

    const submittedBatters = new Set(sub.batters || []);
    const submittedPitchers = new Set(sub.pitchers || []);

    const weekRosterDates = (sd.roster_dates && sd.roster_dates[manager] && sd.roster_dates[manager][weekKey]) || {};
    // Match pool membership accent/format-insensitively: an accented roster_dates name
    // (e.g. "Iván Herrera") must still match its pool entry, or it slips the candidate
    // filter and a ghost survives the purge.
    const battersPoolNorm = new Set((sd.batters_pool || []).map(normalizeName));
    const pitchersPoolNorm = new Set((sd.pitchers_pool || []).map(normalizeName));

    const candidateBatters = new Set([
      ...(mgrRoster[weekKey].batters || []),
      ...Object.keys(weekRosterDates).filter(
        (p) => battersPoolNorm.size === 0 || battersPoolNorm.has(normalizeName(p))
      ),
    ]);
    const candidatePitchers = new Set([
      ...(mgrRoster[weekKey].pitchers || []),
      ...Object.keys(weekRosterDates).filter(
        (p) => pitchersPoolNorm.size > 0 && pitchersPoolNorm.has(normalizeName(p))
      ),
    ]);

    const ghostBatters = [...candidateBatters].filter((b) => !submittedBatters.has(b) && !commAdded.has(b));
    const ghostPitchers = [...candidatePitchers].filter((p) => !submittedPitchers.has(p) && !commAdded.has(p));
    if (ghostBatters.length === 0 && ghostPitchers.length === 0) continue;

    [...ghostBatters, ...ghostPitchers].forEach((player) => {
      if (sd.roster_dates && sd.roster_dates[manager] && sd.roster_dates[manager][weekKey]) {
        delete sd.roster_dates[manager][weekKey][player];
      }
      // Purge ALL stats — including drop_locked — because this player was never legitimately rostered
      if (sd.weekly_batting) {
        sd.weekly_batting = sd.weekly_batting.filter(
          (b) => !(b.batter === player && b.round === firstSched.round && b.week === firstSched.week)
        );
      }
      if (sd.weekly_pitching) {
        sd.weekly_pitching = sd.weekly_pitching.filter(
          (p) => !(p.pitcher === player && p.round === firstSched.round && p.week === firstSched.week)
        );
      }
      if (sd.daily_batting) {
        sd.daily_batting = sd.daily_batting.filter(
          (b) => !(b.batter === player && b.round === firstSched.round && b.week === firstSched.week)
        );
      }
      if (sd.daily_pitching) {
        sd.daily_pitching = sd.daily_pitching.filter(
          (p) => !(p.pitcher === player && p.round === firstSched.round && p.week === firstSched.week)
        );
      }
    });
    mgrRoster[weekKey].batters = (mgrRoster[weekKey].batters || []).filter(
      (b) => submittedBatters.has(b) || commAdded.has(b)
    );
    mgrRoster[weekKey].pitchers = (mgrRoster[weekKey].pitchers || []).filter(
      (p) => submittedPitchers.has(p) || commAdded.has(p)
    );
    repaired = true;
  }
  return repaired;
}

// Find manager for a player from rosters
function findManagerForPlayer(sd, playerName, type) {
  if (!sd.rosters || !playerName) return null;
  const lcName = playerName.toLowerCase();
  for (const [manager, weekRosters] of Object.entries(sd.rosters)) {
    for (const roster of Object.values(weekRosters)) {
      const pool = type === 'batting' ? roster.batters || [] : roster.pitchers || [];
      if (pool.some((p) => p.toLowerCase() === lcName)) return manager;
    }
  }
  return null;
}

// Find manager for a player in a specific week
function findManagerForPlayerWeek(sd, playerName, type, round, week) {
  if (!sd.rosters || !playerName) return null;
  const lcName = playerName.toLowerCase();
  const weekKey = `${round}|${week}`;
  for (const [manager, weekRosters] of Object.entries(sd.rosters)) {
    const roster = weekRosters[weekKey];
    if (!roster) continue;
    const pool = type === 'batting' ? roster.batters || [] : roster.pitchers || [];
    if (pool.some((p) => p.toLowerCase() === lcName)) return manager;
  }
  return null;
}

// Process batting rows from a sheet tab.
// syncDate ('YYYY-MM-DD') is today's date; used to store a daily snapshot and compute the delta
// from the previous sync so that mid-week add/drops only count rostered days.
function processBattingRows(rows, sd, scheduleWeek, syncDate) {
  let imported = 0,
    skipped = 0;

  if (!sd.daily_batting) sd.daily_batting = [];

  rows.forEach((row) => {
    const batter = findCol(row, ['batter', 'player', 'name']);
    if (!batter) return;

    // Update player→team map from sheet's Team column (handles new players + mid-season trades)
    const team = findCol(row, ['team', 'Team']);
    if (team) {
      if (!sd.batters_team) sd.batters_team = {};
      sd.batters_team[batter] = team;
    }

    let manager = findManagerForPlayerWeek(sd, batter, 'batting', scheduleWeek.round, scheduleWeek.week);
    if (!manager) manager = findManagerForPlayer(sd, batter, 'batting');
    if (!manager) manager = findCol(row, ['manager', 'owner']);
    const isUnassigned = !manager;

    // Cumulative week-to-date stats from the sheet
    const cumulative = {
      '1b': parseNum(findCol(row, ['1b', '1B', 'singles']) || 0),
      '2b': parseNum(findCol(row, ['2b', '2B', 'doubles']) || 0),
      '3b': parseNum(findCol(row, ['3b', '3B', 'triples']) || 0),
      hr: parseNum(findCol(row, ['hr', 'HR', 'home_runs', 'homeRuns']) || 0),
      r: parseNum(findCol(row, ['r', 'R', 'runs']) || 0),
      rbi: parseNum(findCol(row, ['rbi', 'RBI']) || 0),
      sb: parseNum(findCol(row, ['sb', 'SB', 'stolen_bases', 'stolenBases']) || 0),
      bb: parseNum(findCol(row, ['bb', 'BB', 'walks']) || 0),
      abs: parseNum(findCol(row, ['ab', 'AB', 'abs', 'atBats']) || 0),
    };

    // Don't overwrite a manually-locked daily record for today
    const lockedDaily = sd.daily_batting.find(
      (r) =>
        r.date === syncDate &&
        r.round === scheduleWeek.round &&
        r.week === scheduleWeek.week &&
        r.batter === batter &&
        ((r.manual_fields && r.manual_fields.length > 0) || r.drop_locked)
    );
    if (lockedDaily) return;

    // Carry-forward of a player dropped in an earlier week — purge any stale snapshot and
    // skip, so stats only accrue for the days they were actually rostered.
    if (isCarriedForwardDrop(sd, batter, 'batting', scheduleWeek.round, scheduleWeek.week)) {
      sd.daily_batting = sd.daily_batting.filter(
        (r) =>
          !(
            r.date === syncDate &&
            r.round === scheduleWeek.round &&
            r.week === scheduleWeek.week &&
            r.batter === batter &&
            r.source === 'gsheets'
          )
      );
      skipped++;
      return;
    }

    // Delta = today's cumulative minus the most-recent previous snapshot for this player/week
    const prevSnapshot = sd.daily_batting
      .filter(
        (r) =>
          r.batter === batter && r.round === scheduleWeek.round && r.week === scheduleWeek.week && r.date < syncDate
      )
      .sort((a, b) => b.date.localeCompare(a.date))[0];

    const delta = prevSnapshot ? battingDelta(cumulative, prevSnapshot.cumulative) : { ...cumulative };

    // Replace any existing gsheets snapshot for today
    sd.daily_batting = sd.daily_batting.filter(
      (r) =>
        !(
          r.date === syncDate &&
          r.round === scheduleWeek.round &&
          r.week === scheduleWeek.week &&
          r.batter === batter &&
          r.source === 'gsheets'
        )
    );
    sd.daily_batting.push({
      date: syncDate,
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      batter,
      cumulative,
      delta,
      source: 'gsheets',
    });

    // Don't overwrite manually-edited or drop-locked weekly records
    const existingManual = sd.weekly_batting.find(
      (b) =>
        b.round === scheduleWeek.round &&
        b.week === scheduleWeek.week &&
        b.batter === batter &&
        ((b.manual_fields && b.manual_fields.length > 0) || b.drop_locked)
    );
    if (existingManual) {
      if (isUnassigned) skipped++;
      else imported++;
      return;
    }

    // Effective weekly score = sum of daily deltas for rostered days only
    const effectiveScore = computeEffectiveBattingScore(sd, batter, scheduleWeek.round, scheduleWeek.week);
    const weeklyScore = effectiveScore !== null ? effectiveScore : calculateBattingScore(cumulative);

    // Remove any previous non-manual sync record for this player/week
    // (regardless of source) so dual-source syncs don't double up rows.
    sd.weekly_batting = sd.weekly_batting.filter(
      (b) =>
        !(
          b.round === scheduleWeek.round &&
          b.week === scheduleWeek.week &&
          b.batter === batter &&
          !((b.manual_fields && b.manual_fields.length > 0) || b.drop_locked)
        )
    );

    sd.weekly_batting.push({
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      manager: manager || null,
      batter,
      status: findCol(row, ['status', 'Status']) || null,
      ...cumulative,
      weekly_score: weeklyScore,
      total_score: weeklyScore,
      source: 'gsheets',
    });

    if (isUnassigned) skipped++;
    else imported++;
  });

  return { imported, skipped };
}

// Process pitching rows from a sheet tab.
// syncDate ('YYYY-MM-DD') is today's date for daily snapshot storage.
// IP is converted to true decimal before storing so delta math stays accurate.
function processPitchingRows(rows, sd, scheduleWeek, syncDate) {
  let imported = 0,
    skipped = 0;

  if (!sd.daily_pitching) sd.daily_pitching = [];

  rows.forEach((row) => {
    const pitcher = findCol(row, ['pitcher', 'player', 'name']);
    if (!pitcher) return;

    // Update player→team map from sheet's Team column (handles new players + mid-season trades)
    const team = findCol(row, ['team', 'Team']);
    if (team) {
      if (!sd.pitchers_team) sd.pitchers_team = {};
      sd.pitchers_team[pitcher] = team;
    }

    let manager = findManagerForPlayerWeek(sd, pitcher, 'pitching', scheduleWeek.round, scheduleWeek.week);
    if (!manager) manager = findManagerForPlayer(sd, pitcher, 'pitching');
    if (!manager) manager = findCol(row, ['manager', 'owner']);
    const isUnassigned = !manager;

    // Cumulative week-to-date stats; IP converted to decimal for accurate delta subtraction
    const cumulative = {
      gs: parseNum(findCol(row, ['gs', 'GS']) || 0),
      w: parseNum(findCol(row, ['w', 'W', 'wins']) || 0),
      qs: parseNum(findCol(row, ['qs', 'QS']) || 0),
      cg: parseNum(findCol(row, ['cg', 'CG']) || 0),
      cgso: parseNum(findCol(row, ['cgso', 'CGSO']) || 0),
      nh: parseNum(findCol(row, ['nh', 'NH']) || 0),
      ip: convertIPDecimal(findCol(row, ['ip', 'IP']) || 0),
      h: parseNum(findCol(row, ['h', 'H', 'hits']) || 0),
      er: parseNum(findCol(row, ['er', 'ER']) || 0),
      bb: parseNum(findCol(row, ['bb', 'BB', 'walks']) || 0),
      k: parseNum(findCol(row, ['k', 'K', 'so', 'SO', 'strikeouts']) || 0),
    };

    // Don't overwrite a manually-locked daily record for today
    const lockedDaily = sd.daily_pitching.find(
      (r) =>
        r.date === syncDate &&
        r.round === scheduleWeek.round &&
        r.week === scheduleWeek.week &&
        r.pitcher === pitcher &&
        ((r.manual_fields && r.manual_fields.length > 0) || r.drop_locked)
    );
    if (lockedDaily) return;

    // Carry-forward of a player dropped in an earlier week — purge any stale snapshot and skip.
    if (isCarriedForwardDrop(sd, pitcher, 'pitching', scheduleWeek.round, scheduleWeek.week)) {
      sd.daily_pitching = sd.daily_pitching.filter(
        (r) =>
          !(
            r.date === syncDate &&
            r.round === scheduleWeek.round &&
            r.week === scheduleWeek.week &&
            r.pitcher === pitcher &&
            r.source === 'gsheets'
          )
      );
      skipped++;
      return;
    }

    // Delta = today's cumulative minus the most-recent previous snapshot
    const prevSnapshot = sd.daily_pitching
      .filter(
        (r) =>
          r.pitcher === pitcher && r.round === scheduleWeek.round && r.week === scheduleWeek.week && r.date < syncDate
      )
      .sort((a, b) => b.date.localeCompare(a.date))[0];

    const delta = prevSnapshot ? pitchingDelta(cumulative, prevSnapshot.cumulative) : { ...cumulative };

    // Override the sheet's QS for any single-start day using the WMMC rule;
    // for no-start days force QS to 0. Multi-start days (rare, gs>=2) keep
    // the sheet value because cumulative IP/ER can't recover per-game splits.
    if ((delta.gs || 0) === 1) {
      delta.qs = isWmmcQS(1, delta.ip, delta.er);
    } else if ((delta.gs || 0) === 0) {
      delta.qs = 0;
    }

    // Replace any existing gsheets snapshot for today
    sd.daily_pitching = sd.daily_pitching.filter(
      (r) =>
        !(
          r.date === syncDate &&
          r.round === scheduleWeek.round &&
          r.week === scheduleWeek.week &&
          r.pitcher === pitcher &&
          r.source === 'gsheets'
        )
    );
    sd.daily_pitching.push({
      date: syncDate,
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      pitcher,
      cumulative,
      delta,
      source: 'gsheets',
    });

    // Keep cumulative.qs aligned with the corrected daily deltas so the
    // weekly_pitching row's QS column matches what feeds weekly_score.
    cumulative.qs = sd.daily_pitching
      .filter((r) => r.pitcher === pitcher && r.round === scheduleWeek.round && r.week === scheduleWeek.week)
      .reduce((sum, r) => sum + ((r.delta && r.delta.qs) || 0), 0);

    // Don't overwrite manually-edited or drop-locked weekly records
    const existingManual = sd.weekly_pitching.find(
      (p) =>
        p.round === scheduleWeek.round &&
        p.week === scheduleWeek.week &&
        p.pitcher === pitcher &&
        ((p.manual_fields && p.manual_fields.length > 0) || p.drop_locked)
    );
    if (existingManual) {
      if (isUnassigned) skipped++;
      else imported++;
      return;
    }

    // Effective weekly score = sum of daily deltas for rostered days only
    const effectiveScore = computeEffectivePitchingScore(sd, pitcher, scheduleWeek.round, scheduleWeek.week);
    const weeklyScore = effectiveScore !== null ? effectiveScore : calculatePitchingScore(cumulative);

    // Remove previous gsheets sync for this player/week
    sd.weekly_pitching = sd.weekly_pitching.filter(
      (p) =>
        !(
          p.round === scheduleWeek.round &&
          p.week === scheduleWeek.week &&
          p.pitcher === pitcher &&
          !((p.manual_fields && p.manual_fields.length > 0) || p.drop_locked)
        )
    );

    sd.weekly_pitching.push({
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      manager: manager || null,
      pitcher,
      status: findCol(row, ['status', 'Status']) || null,
      ...cumulative,
      // Per-day deltas were rewritten with the WMMC rule above, so cumulative.qs
      // is now the trustworthy per-game sum — no need to flag multi-start weeks
      // for manual review.
      qs_highlight: false,
      weekly_score: weeklyScore,
      source: 'gsheets',
    });

    if (isUnassigned) skipped++;
    else imported++;
  });

  return { imported, skipped };
}

// ============================================================
// Sync history pruning
// ============================================================

const MAX_SYNC_HISTORY = 50;

function pruneSyncHistory(sd) {
  if (sd.upload_log && sd.upload_log.length > MAX_SYNC_HISTORY) {
    sd.upload_log = sd.upload_log.slice(-MAX_SYNC_HISTORY);
  }
}

// Main sync function — fetches all available weeks from the sheet
async function syncGoogleSheets(year, syncType = 'daily') {
  const db = readDB();
  const config = db.google_sheets_config || {};
  const sd = (db.seasons || {})[year];

  if (!sd) throw new Error(`Season ${year} not found`);
  if (!config.spreadsheet_id) throw new Error('No spreadsheet ID configured');
  if (!config.api_key) throw new Error('No API key configured');

  if (!sd.weekly_batting) sd.weekly_batting = [];
  if (!sd.weekly_pitching) sd.weekly_pitching = [];
  if (!sd.daily_batting) sd.daily_batting = [];
  if (!sd.daily_pitching) sd.daily_pitching = [];
  if (!sd.player_dates) sd.player_dates = {};
  if (!sd.batters_team) sd.batters_team = {};
  if (!sd.pitchers_team) sd.pitchers_team = {};

  // Remove any ghost players left in the Week 1 roster by a stale initial-submission approval
  // before attributing this sync's stats so they are never credited to the wrong manager.
  repairGhostInitialRosterPlayers(sd);

  // Populate player_dates from roster_dates so mid-week adds/drops filter daily deltas correctly.
  syncPlayerDatesFromRosterDates(sd);

  // Capture today's date once so all rows in this sync share the same snapshot date.
  // Use Eastern time to match the MLB game-date convention used everywhere else.
  const syncDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const results = [];
  let totalBatImported = 0,
    totalPitImported = 0;

  for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
    const sched = SEASON_SCHEDULE[i];
    const weekNum = i + 1;
    const batTab = `Week ${weekNum} Batting`;
    const pitTab = `Week ${weekNum} Pitching`;

    // Try batting tab
    try {
      const batValues = await fetchSheetTab(config.spreadsheet_id, batTab, config.api_key);
      if (batValues !== null) {
        // Tab exists — full overwrite: remove all non-manual gsheets weekly records for this week
        sd.weekly_batting = sd.weekly_batting.filter(
          (b) =>
            !(
              b.round === sched.round &&
              b.week === sched.week &&
              b.source === 'gsheets' &&
              (!b.manual_fields || b.manual_fields.length === 0)
            )
        );
        if (batValues.length > 1) {
          const batRows = parseSheetRows(batValues);
          const batResult = processBattingRows(batRows, sd, sched, syncDate);
          totalBatImported += batResult.imported;
          results.push({ week: weekNum, type: 'batting', imported: batResult.imported, skipped: batResult.skipped });
        }
      }
    } catch (e) {
      results.push({ week: weekNum, type: 'batting', error: e.message });
    }

    // Try pitching tab
    try {
      const pitValues = await fetchSheetTab(config.spreadsheet_id, pitTab, config.api_key);
      if (pitValues !== null) {
        // Tab exists — full overwrite: remove all non-manual gsheets weekly records for this week
        sd.weekly_pitching = sd.weekly_pitching.filter(
          (p) =>
            !(
              p.round === sched.round &&
              p.week === sched.week &&
              p.source === 'gsheets' &&
              (!p.manual_fields || p.manual_fields.length === 0)
            )
        );
        if (pitValues.length > 1) {
          const pitRows = parseSheetRows(pitValues);
          const pitResult = processPitchingRows(pitRows, sd, sched, syncDate);
          totalPitImported += pitResult.imported;
          results.push({ week: weekNum, type: 'pitching', imported: pitResult.imported, skipped: pitResult.skipped });
        }
      }
    } catch (e) {
      results.push({ week: weekNum, type: 'pitching', error: e.message });
    }
  }

  // Log the sync
  const errorCount = results.filter((r) => r.error).length;
  if (!sd.upload_log) sd.upload_log = [];
  sd.upload_log.push({
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    type: 'gsheets_sync',
    sync_type: syncType,
    success: errorCount === 0,
    batting_imported: totalBatImported,
    pitching_imported: totalPitImported,
    details: results,
  });

  // Prune sync history to prevent indefinite growth
  pruneSyncHistory(sd);

  // Save
  if (!db.seasons) db.seasons = {};
  db.seasons[year] = sd;

  // Update sync status
  config.last_sync = new Date().toISOString();
  config.last_sync_result = {
    success: errorCount === 0,
    batting_imported: totalBatImported,
    pitching_imported: totalPitImported,
    weeks_with_data: results.filter((r) => !r.error && r.imported > 0).length,
    errors: errorCount,
    details: results,
  };
  db.google_sheets_config = config;

  addAuditEntry(db, 'gsheets_sync', {
    year,
    batting_imported: totalBatImported,
    pitching_imported: totalPitImported,
  });

  writeDB(db);

  return config.last_sync_result;
}

// ============================================================
// Google Sheets API Endpoints
// ============================================================

// GET /api/google-sheets/config
app.get('/api/google-sheets/config', (req, res) => {
  const db = readDB();
  const config = db.google_sheets_config || {};
  // Don't expose the full API key to the client — mask it
  const safeConfig = { ...config };
  if (safeConfig.api_key) {
    safeConfig.api_key_masked = safeConfig.api_key.slice(0, 8) + '...' + safeConfig.api_key.slice(-4);
    delete safeConfig.api_key;
  }
  res.json(safeConfig);
});

// POST /api/google-sheets/config
app.post('/api/google-sheets/config', requireCommissioner, (req, res) => {
  const db = readDB();
  const { spreadsheet_url, api_key, enabled, season, sync_time } = req.body;

  const spreadsheetId = extractSpreadsheetId(spreadsheet_url);
  if (spreadsheet_url && !spreadsheetId) {
    return res.status(400).json({ error: 'Could not extract spreadsheet ID from the provided URL' });
  }

  if (!db.google_sheets_config) db.google_sheets_config = {};
  if (spreadsheetId) db.google_sheets_config.spreadsheet_id = spreadsheetId;
  if (api_key) db.google_sheets_config.api_key = api_key;
  if (typeof enabled === 'boolean') db.google_sheets_config.enabled = enabled;
  if (season) db.google_sheets_config.season = season;
  if (sync_time) db.google_sheets_config.sync_time = sync_time;

  addAuditEntry(db, 'gsheets_config_update', { enabled, season }, req.get('X-User-Email'));
  writeDB(db);
  scheduleGSheetsSync(); // reconfigure scheduler

  res.json({ ok: true, spreadsheet_id: db.google_sheets_config.spreadsheet_id });
});

// POST /api/google-sheets/sync — manual trigger
app.post('/api/google-sheets/sync', requireCommissioner, async (req, res) => {
  try {
    const db = readDB();
    const config = db.google_sheets_config || {};
    const season = req.body.season || config.season || new Date().getFullYear().toString();
    const result = await syncGoogleSheets(season, 'manual');
    if (result.errors > 0) {
      postSlack(
        `*Google Sheets Manual Sync — ${result.errors} error(s)*\n${result.errors} week(s) failed to import for season ${season}.`
      ).catch(() => {});
    }
    res.json({ ok: true, result });
  } catch (e) {
    // Log the error
    const db = readDB();
    if (!db.google_sheets_config) db.google_sheets_config = {};
    db.google_sheets_config.last_sync = new Date().toISOString();
    db.google_sheets_config.last_sync_result = { success: false, error: e.message };
    writeDB(db);
    postSlack(`*Google Sheets Manual Sync Failed*\n${e.message}`).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// GET /api/google-sheets/sync-status
app.get('/api/google-sheets/sync-status', (req, res) => {
  const db = readDB();
  const config = db.google_sheets_config || {};
  const season = config.season || new Date().getFullYear().toString();
  const sd = (db.seasons || {})[season] || {};
  const recentLogs = (sd.upload_log || [])
    .filter((l) => l.type === 'gsheets_sync')
    .slice(-10)
    .reverse();
  res.json({
    last_sync: config.last_sync || null,
    last_sync_result: config.last_sync_result || null,
    enabled: config.enabled || false,
    next_sync: getNextSyncTime(),
    recent_logs: recentLogs,
  });
});

// GET /api/mlb/sync-status
app.get('/api/mlb/sync-status', requireCommissioner, (req, res) => {
  const db = readDB();
  const config = db.google_sheets_config || {};
  const season = config.season || new Date().getFullYear().toString();
  const sd = (db.seasons || {})[season] || {};

  // Sync runs are recorded in two places: the per-season upload_log (rich — includes
  // game counts, but capped at MAX_SYNC_HISTORY) and the global audit_log (one entry per
  // automatic AND manual run, capped at MAX_AUDIT_ENTRIES). The UI historically read only
  // upload_log, so automatic runs that had aged out of (or never reached) it were invisible.
  // Merge both, de-duplicating the same run by minute + week + note and preferring the
  // richer upload_log copy, so every auto/manual run shows up.
  const fmtTs = (ts) => {
    const d = new Date(String(ts).replace(' ', 'T'));
    return isNaN(d.getTime()) ? String(ts) : d.toISOString().replace('T', ' ').slice(0, 19);
  };
  const minuteKey = (ts) => {
    const d = new Date(String(ts).replace(' ', 'T'));
    return isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(0, 16);
  };

  const uploadEntries = (sd.upload_log || [])
    .filter((l) => l.type === 'mlbapi_sync' || l.type === 'mlbapi_auto_sync')
    .map((l) => ({
      timestamp: fmtTs(l.timestamp),
      trigger: l.trigger || (l.type === 'mlbapi_auto_sync' ? 'auto' : 'manual'),
      round: l.round || '',
      week: l.week || '',
      games: l.games,
      batting_imported: l.batting_imported,
      pitching_imported: l.pitching_imported,
      note: l.note || '',
    }));

  const auditEntries = (db.audit_log || [])
    .filter((l) => l.action === 'mlbapi_sync' || l.action === 'mlbapi_auto_sync')
    .slice(0, 60)
    .map((l) => {
      const d = l.details || {};
      return {
        timestamp: fmtTs(l.timestamp),
        trigger: l.action === 'mlbapi_auto_sync' ? 'auto' : 'manual',
        round: d.round || '',
        week: d.week || '',
        games: undefined,
        batting_imported: d.batting_imported,
        pitching_imported: d.pitching_imported,
        note: d.note || '',
      };
    });

  const seen = new Set();
  const merged = [];
  // upload_log entries first so their game counts win on duplicate runs.
  for (const e of [...uploadEntries, ...auditEntries]) {
    const key = `${minuteKey(e.timestamp)}|${e.round}|${e.week}|${e.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  merged.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

  const next = getNextEasternHour(4);
  res.json({
    next_sync: next.toISOString(),
    recent_logs: merged.slice(0, 60),
  });
});

// GET /api/mlb/player-debug?year=2026&name=Casey%20Mize
// Read-only diagnostic for a "rostered but showing 0 points" player. Dumps, per schedule
// week, everything that determines the displayed score: stored daily/weekly records and
// their manager attribution, which managers roster the player that week, the effective
// scoring window (roster_dates/player_dates), the computed effective score, and whether the
// carried-forward-drop logic would suppress the player. Changes nothing.
app.get('/api/mlb/player-debug', requireCommissioner, (req, res) => {
  const { year, name } = req.query;
  if (!year || !name) return res.status(400).json({ error: 'year and name are required' });
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  // Refresh eligibility windows from roster_dates (in-memory only — not persisted).
  syncPlayerDatesFromRosterDates(sd);

  const lc = String(name).toLowerCase();
  const eqi = (a) => String(a || '').toLowerCase() === lc;
  const uniq = (arr) => [...new Set(arr)];

  // Which managers roster this player, and in which weeks.
  const rosterMembership = {};
  for (const [mgr, weekRosters] of Object.entries(sd.rosters || {})) {
    for (const [weekKey, roster] of Object.entries(weekRosters || {})) {
      const inBat = (roster.batters || []).some(eqi);
      const inPit = (roster.pitchers || []).some(eqi);
      if (inBat || inPit) {
        (rosterMembership[weekKey] = rosterMembership[weekKey] || []).push(
          `${mgr}${inBat ? ' [B]' : ''}${inPit ? ' [P]' : ''}`
        );
      }
    }
  }

  // roster_dates add/drop windows mentioning this player.
  const rosterDates = {};
  for (const [mgr, weeks] of Object.entries(sd.roster_dates || {})) {
    for (const [weekKey, players] of Object.entries(weeks || {})) {
      const hit = Object.entries(players || {}).find(([p]) => eqi(p));
      if (hit) rosterDates[`${mgr} | ${weekKey}`] = hit[1];
    }
  }

  const perWeek = [];
  for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
    const { round, week } = SEASON_SCHEDULE[i];
    const weekKey = `${round}|${week}`;
    const dBat = (sd.daily_batting || []).filter((r) => eqi(r.batter) && r.round === round && r.week === week);
    const dPit = (sd.daily_pitching || []).filter((r) => eqi(r.pitcher) && r.round === round && r.week === week);
    const wBat = (sd.weekly_batting || []).filter((r) => eqi(r.batter) && r.round === round && r.week === week);
    const wPit = (sd.weekly_pitching || []).filter((r) => eqi(r.pitcher) && r.round === round && r.week === week);
    if (!dBat.length && !dPit.length && !wBat.length && !wPit.length && !rosterMembership[weekKey]) continue;

    const weekDates = (sd.schedule_dates || [])[i] || {};
    const entry = { week: weekKey, rostered_by: rosterMembership[weekKey] || [] };

    if (dPit.length || wPit.length) {
      const storedName = (dPit[0] || wPit[0]).pitcher;
      const pd = (((sd.player_dates || {})[weekKey] || {}).pitcher || {})[storedName] || {};
      entry.pitching = {
        stored_name: storedName,
        daily_games: dPit.length,
        daily_dates: dPit.map((r) => r.date),
        daily_managers: uniq(dPit.map((r) => r.manager)),
        weekly_rows: wPit.map((r) => ({
          manager: r.manager,
          weekly_score: r.weekly_score,
          source: r.source,
          override: !!((r.manual_fields && r.manual_fields.length) || r.drop_locked),
        })),
        effective_window: {
          start: 'start' in pd ? pd.start : weekDates.start || null,
          end: 'end' in pd ? pd.end : weekDates.end || null,
        },
        effective_score: dPit.length ? computeEffectivePitchingScore(sd, storedName, round, week) : null,
        carried_forward_drop: isCarriedForwardDrop(sd, storedName, 'pitching', round, week),
      };
    }
    if (dBat.length || wBat.length) {
      const storedName = (dBat[0] || wBat[0]).batter;
      const pd = (((sd.player_dates || {})[weekKey] || {}).batter || {})[storedName] || {};
      entry.batting = {
        stored_name: storedName,
        daily_games: dBat.length,
        daily_dates: dBat.map((r) => r.date),
        daily_managers: uniq(dBat.map((r) => r.manager)),
        weekly_rows: wBat.map((r) => ({
          manager: r.manager,
          weekly_score: r.weekly_score,
          source: r.source,
          override: !!((r.manual_fields && r.manual_fields.length) || r.drop_locked),
        })),
        effective_window: {
          start: 'start' in pd ? pd.start : weekDates.start || null,
          end: 'end' in pd ? pd.end : weekDates.end || null,
        },
        effective_score: dBat.length ? computeEffectiveBattingScore(sd, storedName, round, week) : null,
        carried_forward_drop: isCarriedForwardDrop(sd, storedName, 'batting', round, week),
      };
    }
    perWeek.push(entry);
  }

  // Distinguish "name mismatch" from "genuinely no games": surface stored stat names that
  // resemble the query. An unmapped player (no mlb_id) only associates by exact name, so a
  // close-but-different stored spelling means the roster slot and the synced feed disagree.
  const totalExact = {
    daily_pitching: (sd.daily_pitching || []).filter((r) => eqi(r.pitcher)).length,
    daily_batting: (sd.daily_batting || []).filter((r) => eqi(r.batter)).length,
  };
  let similarStoredNames = null;
  if (totalExact.daily_pitching === 0 && totalExact.daily_batting === 0) {
    const rank = (names) =>
      uniq(names.filter(Boolean))
        .map((n) => ({ name: n, score: Math.round(nameSimilarity(name, n) * 1000) / 1000 }))
        .filter((x) => x.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    similarStoredNames = {
      pitching: rank((sd.daily_pitching || []).map((r) => r.pitcher)),
      batting: rank((sd.daily_batting || []).map((r) => r.batter)),
    };
  }

  res.json({
    query: { year, name },
    mlb_id: (sd.mlb_ids || {})[name] ?? null,
    total_exact_daily_records: totalExact,
    similar_stored_names: similarStoredNames,
    roster_membership: rosterMembership,
    roster_dates: rosterDates,
    per_week: perWeek,
  });
});

// GET /api/mlb/data-debug?year=2026
// Read-only season-wide ground truth: per schedule week, how many daily and weekly stat
// records are stored, how many weekly rows are attributed to a manager vs. left null, how
// many score nonzero, and how many managers have a populated roster. Pinpoints whether a
// "No stats" week is missing daily data, missing the weekly rollup, or just unattributed.
app.get('/api/mlb/data-debug', requireCommissioner, (req, res) => {
  const { year } = req.query;
  if (!year) return res.status(400).json({ error: 'year is required' });
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const dailyCount = (list) => {
    const m = {};
    for (const r of list || []) m[`${r.round}|${r.week}`] = (m[`${r.round}|${r.week}`] || 0) + 1;
    return m;
  };
  const weeklyAgg = (list) => {
    const m = {};
    for (const r of list || []) {
      const k = `${r.round}|${r.week}`;
      const a = (m[k] = m[k] || { total: 0, with_manager: 0, null_manager: 0, nonzero: 0 });
      a.total++;
      if (r.manager) a.with_manager++;
      else a.null_manager++;
      if ((r.weekly_score || 0) !== 0) a.nonzero++;
    }
    return m;
  };
  const dBat = dailyCount(sd.daily_batting);
  const dPit = dailyCount(sd.daily_pitching);
  const wBat = weeklyAgg(sd.weekly_batting);
  const wPit = weeklyAgg(sd.weekly_pitching);

  const rosterPopulated = {};
  for (const weekRosters of Object.values(sd.rosters || {})) {
    for (const [wk, roster] of Object.entries(weekRosters || {})) {
      if ((roster.batters || []).length + (roster.pitchers || []).length > 0) {
        rosterPopulated[wk] = (rosterPopulated[wk] || 0) + 1;
      }
    }
  }

  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const perWeek = SEASON_SCHEDULE.map((s, i) => {
    const k = `${s.round}|${s.week}`;
    const dates = (sd.schedule_dates || [])[i] || {};
    return {
      week: k,
      dates: { start: dates.start || null, end: dates.end || null },
      elapsed: dates.start ? dates.start <= todayET : null,
      managers_with_roster: rosterPopulated[k] || 0,
      daily_batting: dBat[k] || 0,
      daily_pitching: dPit[k] || 0,
      weekly_batting: wBat[k] || { total: 0, with_manager: 0, null_manager: 0, nonzero: 0 },
      weekly_pitching: wPit[k] || { total: 0, with_manager: 0, null_manager: 0, nonzero: 0 },
    };
  }).filter((w) => w.dates.start);

  res.json({ year, today: todayET, per_week: perWeek });
});

// POST /api/mlb/rebuild-weeklies  { year }
// Non-destructive repair: for every elapsed week, recompute the weekly_batting/weekly_pitching
// rollups from the ALREADY-STORED daily records and re-attribute each row's manager from the
// CURRENT rosters. No MLB re-fetch. Fixes weeks whose weekly rows are missing or carry stale /
// null attribution after roster corrections (the daily delta only ever rebuilds the current
// week). Manual overrides and drop-locked rows are preserved by rebuildWeeklyFromDaily.
app.post('/api/mlb/rebuild-weeklies', requireCommissioner, (req, res) => {
  const year = (req.body.year || new Date().getFullYear()).toString();
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  try {
    syncPlayerDatesFromRosterDates(sd);
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const scheduleDates = sd.schedule_dates || [];
    const results = [];
    for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
      const { round, week } = SEASON_SCHEDULE[i];
      const dates = scheduleDates[i];
      if (!dates || !dates.start || dates.start > todayET) continue; // skip future / undated weeks
      rebuildWeeklyFromDaily(sd, round, week);
      const wb = (sd.weekly_batting || []).filter((r) => r.round === round && r.week === week);
      const wp = (sd.weekly_pitching || []).filter((r) => r.round === round && r.week === week);
      results.push({
        week: `${round}|${week}`,
        weekly_batting: wb.length,
        weekly_pitching: wp.length,
        attributed: wb.filter((r) => r.manager).length + wp.filter((r) => r.manager).length,
      });
    }
    db.seasons[year] = sd;
    addAuditEntry(db, 'mlbapi_rebuild_weeklies', { year, weeks: results.length });
    writeDB(db);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mlb/backfill  { year }
// Re-fetch every elapsed week from the MLB Stats API and store it (performMLBSync is
// idempotent — replaces mlbapi game records, preserves manual overrides/drop-locks). Use this
// to restore weeks whose stored stats are missing entirely (not just unattributed). Awaits the
// Upstash backup and reports its size/status so a silent persistence failure (e.g. payload too
// large) is visible rather than lost.
app.post('/api/mlb/backfill', requireCommissioner, async (req, res) => {
  const year = (req.body.year || new Date().getFullYear()).toString();
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const scheduleDates = sd.schedule_dates || [];
    const results = [];
    for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
      const schedWeek = SEASON_SCHEDULE[i];
      const dates = scheduleDates[i];
      if (!dates || !dates.start || dates.start > todayET) continue; // elapsed/in-progress weeks only
      const r = await performMLBSync(sd, schedWeek, dates, { trigger: 'manual', note: 'backfill' });
      results.push({
        week: `${schedWeek.round}|${schedWeek.week}`,
        games: r.games_fetched,
        batting_imported: r.batting_imported,
        pitching_imported: r.pitching_imported,
      });
    }
    db.seasons[year] = sd;
    addAuditEntry(db, 'mlbapi_sync', { year, note: 'backfill-all', weeks: results.length });
    const backup = await writeDB(db, { awaitBackup: true });
    res.json({ ok: true, results, backup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mlb/storage-status
// Read-only: report exactly where the server persists db.json and whether durable storage is
// actually active. The #1 cause of "data resets on restart" is the app falling back to an
// ephemeral path because DB_PATH isn't set (so the mounted Render disk is never used) AND
// Upstash being unconfigured — leaving no durable store at all.
app.get('/api/mlb/storage-status', requireCommissioner, (req, res) => {
  let exists = false;
  let sizeBytes = null;
  try {
    if (fs.existsSync(DB_FILE)) {
      exists = true;
      sizeBytes = fs.statSync(DB_FILE).size;
    }
  } catch {
    /* ignore stat errors */
  }
  let lastSaved = null;
  try {
    lastSaved = readDB().last_saved_at || null;
  } catch {
    /* ignore */
  }
  const onDeclaredDisk = typeof DB_FILE === 'string' && DB_FILE.startsWith('/var/data');
  const upstashConfigured = !!(UPSTASH_URL && UPSTASH_TOKEN);
  res.json({
    db_file: DB_FILE,
    env_DB_PATH: process.env.DB_PATH || null,
    on_persistent_disk_path: onDeclaredDisk,
    db_exists: exists,
    db_size_bytes: sizeBytes,
    last_saved_at: lastSaved,
    upstash_configured: upstashConfigured,
    durable: onDeclaredDisk || upstashConfigured,
    warning:
      onDeclaredDisk || upstashConfigured
        ? null
        : 'No durable storage active — db.json is on an ephemeral path and Upstash is not configured. Data will reset on restart/spin-down.',
  });
});

// ============================================================
// MLB Stats API Integration
// ============================================================

const MLB_API_BASE = 'https://statsapi.mlb.com';

async function mlbApiFetch(path) {
  const resp = await fetch(`${MLB_API_BASE}${path}`);
  if (!resp.ok) throw new Error(`MLB API ${resp.status}: ${path}`);
  return resp.json();
}

// Returns [{ gameId, date }] for all final games in a date range.
async function fetchMLBGames(startDate, endDate) {
  const data = await mlbApiFetch(
    `/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&gameType=R,F,D,L,W`
  );
  const games = [];
  for (const dateEntry of data.dates || []) {
    for (const game of dateEntry.games || []) {
      if (game.status?.abstractGameState === 'Final') {
        games.push({ gameId: game.gamePk, date: dateEntry.date });
      }
    }
  }
  return games;
}

// Parse one boxscore into per-player batting and pitching stat objects for that game.
// Returns { batting: { name: stats }, pitching: { name: stats }, teamMap: { name: abbrev } }
//
// idToWmmcName (optional): Map<mlbPlayerId, wmmcDisplayName>. When the MLB player's ID
// is present in the map, stats are keyed under the WMMC display name — this is what lets
// two MLB players who share a fullName (e.g. both "Max Muncy") be tracked separately as
// "Max Muncy (LAD)" and "Max Muncy (OAK)". Unmapped players fall back to their fullName
// (back-compat with pre-ID-migration data).
// gameIsFinal gates the CG/CGSO/NH derivation: those can only be credited once the
// game is over. Mid-game, the starter is typically the only pitcher who has appeared,
// so his outs equal the team's total outs and the naive check would falsely flag a
// complete game / shutout / no-hitter. Callers that only ever pass Final games (the
// scoring sync) pass true; live endpoints pass the per-game state. Defaults to false
// so a forgotten flag fails safe (no phantom CG) rather than crediting in-progress games.
function parseBoxscore(box, idToWmmcName = new Map(), gameIsFinal = false) {
  const batting = {};
  const pitching = {};
  const teamMap = {};

  for (const side of ['away', 'home']) {
    const teamData = box.teams?.[side];
    if (!teamData) continue;
    const abbrev = teamData.team?.abbreviation || '';
    const teamTotalOuts = teamData.teamStats?.pitching?.outs ?? null;

    for (const player of Object.values(teamData.players || {})) {
      const fullName = player.person?.fullName;
      const mlbId = player.person?.id;
      if (!fullName) continue;
      // Prefer the WMMC display name when this MLB player has been claimed by a WMMC entry,
      // so stats land on the correct roster slot even when two MLB players share a name.
      const name = (mlbId && idToWmmcName.get(mlbId)) || fullName;

      const bs = player.stats?.batting;
      if (bs && bs.atBats !== undefined) {
        teamMap[name] = abbrev;
        const hits = bs.hits || 0;
        const doubles = bs.doubles || 0;
        const triples = bs.triples || 0;
        const hr = bs.homeRuns || 0;
        batting[name] = {
          '1b': Math.max(0, hits - doubles - triples - hr),
          '2b': doubles,
          '3b': triples,
          hr,
          r: bs.runs || 0,
          rbi: bs.rbi || 0,
          sb: bs.stolenBases || 0,
          bb: bs.baseOnBalls || 0,
          abs: bs.atBats || 0,
        };
      }

      const ps = player.stats?.pitching;
      if (ps && ps.inningsPitched !== undefined) {
        teamMap[name] = abbrev;
        const ipDec = convertIPDecimal(ps.inningsPitched || 0);
        const er = ps.earnedRuns || 0;
        const hits = ps.hits || 0;
        const started = ps.gamesStarted || 0;
        const pitcherOuts = ps.outs ?? null;
        // Only a completed game can yield a CG: mid-game the starter holds all of his
        // team's outs so far, which is not a complete game until the game is over.
        const isCG =
          gameIsFinal && started > 0 && teamTotalOuts !== null && pitcherOuts !== null && pitcherOuts === teamTotalOuts
            ? 1
            : 0;
        pitching[name] = {
          gs: started,
          w: ps.wins || 0,
          qs: isWmmcQS(started, ipDec, er),
          // CG/CGSO/NH derived from outs and hit/ER counts (only when the game is final)
          cg: isCG,
          cgso: isCG && er === 0 ? 1 : 0,
          nh: isCG && hits === 0 ? 1 : 0,
          ip: ipDec,
          h: hits,
          er,
          bb: ps.baseOnBalls || 0,
          k: ps.strikeOuts || 0,
        };
      }
    }
  }

  return { batting, pitching, teamMap };
}

// Fetch per-game per-player stats for a date range.
// idToWmmcName: passed through to parseBoxscore so duplicate-fullName MLB players
// can be routed to the correct WMMC display name.
// Returns [{ gameId, date, batting, pitching, teamMap }]
async function fetchMLBPerGameStats(startDate, endDate, idToWmmcName = new Map()) {
  const games = await fetchMLBGames(startDate, endDate);
  const results = [];
  for (const { gameId, date } of games) {
    let box;
    try {
      box = await mlbApiFetch(`/api/v1/game/${gameId}/boxscore`);
    } catch {
      continue;
    }
    // fetchMLBGames only returns Final games, so CG/CGSO/NH are safe to credit here.
    const { batting, pitching, teamMap } = parseBoxscore(box, idToWmmcName, true);
    results.push({ gameId, date, batting, pitching, teamMap });
  }
  return results;
}

// Sum per-game records into weekly totals per player.
// Returns { batting: { name: totals }, pitching: { name: totals }, teamMap: { name: abbrev } }
function aggregatePerGame(gameRecords) {
  const batting = {};
  const pitching = {};
  const teamMap = {};

  for (const { batting: gb, pitching: gp, teamMap: gt } of gameRecords) {
    Object.assign(teamMap, gt);

    for (const [name, stats] of Object.entries(gb)) {
      if (!batting[name]) batting[name] = { '1b': 0, '2b': 0, '3b': 0, hr: 0, r: 0, rbi: 0, sb: 0, bb: 0, abs: 0 };
      for (const k of Object.keys(batting[name])) batting[name][k] += stats[k] || 0;
    }

    for (const [name, stats] of Object.entries(gp)) {
      if (!pitching[name]) {
        pitching[name] = { gs: 0, w: 0, qs: 0, cg: 0, cgso: 0, nh: 0, ip: 0, h: 0, er: 0, bb: 0, k: 0 };
      }
      for (const k of Object.keys(pitching[name])) {
        if (k === 'ip') pitching[name].ip = Math.round((pitching[name].ip + (stats.ip || 0)) * 1000) / 1000;
        else pitching[name][k] += stats[k] || 0;
      }
    }
  }

  return { batting, pitching, teamMap };
}

// Attach manager + weekly score to aggregated batting stats.
function enrichBatting(battingMap, teamMap, sd, schedWeek) {
  return Object.entries(battingMap).map(([name, stats]) => {
    const manager =
      findManagerForPlayerWeek(sd, name, 'batting', schedWeek.round, schedWeek.week) ||
      findManagerForPlayer(sd, name, 'batting');
    return {
      name,
      manager: manager || null,
      team: teamMap[name] || null,
      ...stats,
      weekly_score: calculateBattingScore(stats),
    };
  });
}

// Attach manager + weekly score to aggregated pitching stats.
function enrichPitching(pitchingMap, teamMap, sd, schedWeek) {
  return Object.entries(pitchingMap).map(([name, stats]) => {
    const manager =
      findManagerForPlayerWeek(sd, name, 'pitching', schedWeek.round, schedWeek.week) ||
      findManagerForPlayer(sd, name, 'pitching');
    return {
      name,
      manager: manager || null,
      team: teamMap[name] || null,
      ...stats,
      weekly_score: calculatePitchingScore(stats),
    };
  });
}

// Shared param validation + season/week lookup for all MLB endpoints.
function resolveMLBWeek(req, isBody = false) {
  const src = isBody ? req.body || {} : req.query;
  const { year, round, week } = src;
  if (!year || !round || !week) return { error: 'year, round, and week are required' };
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return { error: `Season ${year} not found` };
  const weekIdx = SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === week);
  if (weekIdx === -1) return { error: `Unknown schedule slot: ${round} / ${week}` };
  const dates = (sd.schedule_dates || [])[weekIdx];
  if (!dates?.start || !dates?.end) {
    return { error: `No schedule dates for ${round} ${week}. Set them in the Commissioner panel first.` };
  }
  return { db, sd, year, round, week, weekIdx, dates, schedWeek: SEASON_SCHEDULE[weekIdx] };
}

// GET /api/mlb/preview?year=2025&round=PP1&week=Week+1
// Dry-run: returns per-player weekly totals derived from per-game data. Nothing is saved.
app.get('/api/mlb/preview', requireCommissioner, async (req, res) => {
  const ctx = resolveMLBWeek(req);
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  const { sd, round, week, dates, schedWeek } = ctx;

  try {
    const gameRecords = await fetchMLBPerGameStats(dates.start, dates.end, buildIdToWmmcName(ctx.sd));
    const { batting, pitching, teamMap } = aggregatePerGame(gameRecords);

    res.json({
      source: 'mlbapi',
      week: { round, week, start: dates.start, end: dates.end },
      games_fetched: gameRecords.length,
      batting: enrichBatting(batting, teamMap, sd, schedWeek).sort((a, b) => b.weekly_score - a.weekly_score),
      pitching: enrichPitching(pitching, teamMap, sd, schedWeek).sort((a, b) => b.weekly_score - a.weekly_score),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mlb/games?year=2025&round=PP1&week=Week+1
// Per-player per-game log: each player's stats broken out by individual game date.
app.get('/api/mlb/games', requireCommissioner, async (req, res) => {
  const ctx = resolveMLBWeek(req);
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  const { sd, round, week, dates, schedWeek } = ctx;

  try {
    const gameRecords = await fetchMLBPerGameStats(dates.start, dates.end, buildIdToWmmcName(sd));

    // Build per-player game log: { name -> [{ date, gameId, batting/pitching, score }] }
    const batterLog = {};
    const pitcherLog = {};

    for (const { gameId, date, batting, pitching, teamMap } of gameRecords) {
      for (const [name, stats] of Object.entries(batting)) {
        const manager =
          findManagerForPlayerWeek(sd, name, 'batting', schedWeek.round, schedWeek.week) ||
          findManagerForPlayer(sd, name, 'batting');
        if (!batterLog[name]) batterLog[name] = { manager: manager || null, team: teamMap[name] || null, games: [] };
        batterLog[name].games.push({ date, game_id: gameId, ...stats, game_score: calculateBattingScore(stats) });
      }
      for (const [name, stats] of Object.entries(pitching)) {
        const manager =
          findManagerForPlayerWeek(sd, name, 'pitching', schedWeek.round, schedWeek.week) ||
          findManagerForPlayer(sd, name, 'pitching');
        if (!pitcherLog[name]) pitcherLog[name] = { manager: manager || null, team: teamMap[name] || null, games: [] };
        pitcherLog[name].games.push({ date, game_id: gameId, ...stats, game_score: calculatePitchingScore(stats) });
      }
    }

    // Add weekly totals to each player
    const withTotals = (log) =>
      Object.entries(log).map(([name, data]) => {
        const weekly_score = data.games.reduce((s, g) => s + g.game_score, 0);
        return {
          name,
          ...data,
          games: data.games.sort((a, b) => a.date.localeCompare(b.date)),
          weekly_score: Math.round(weekly_score * 100) / 100,
        };
      });

    res.json({
      week: { round, week, start: dates.start, end: dates.end },
      games_fetched: gameRecords.length,
      batting: withTotals(batterLog).sort((a, b) => b.weekly_score - a.weekly_score),
      pitching: withTotals(pitcherLog).sort((a, b) => b.weekly_score - a.weekly_score),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mlb/compare?year=2025&round=PP1&week=Week+1
// Side-by-side: MLB API weekly totals vs. currently stored stats. Sorted by largest score diff.
app.get('/api/mlb/compare', requireCommissioner, async (req, res) => {
  const ctx = resolveMLBWeek(req);
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  const { sd, round, week, dates, schedWeek } = ctx;

  try {
    const gameRecords = await fetchMLBPerGameStats(dates.start, dates.end, buildIdToWmmcName(sd));
    const { batting, pitching, teamMap } = aggregatePerGame(gameRecords);

    const mlbBat = enrichBatting(batting, teamMap, sd, schedWeek);
    const mlbPit = enrichPitching(pitching, teamMap, sd, schedWeek);
    const storedBat = (sd.weekly_batting || []).filter((b) => b.round === round && b.week === week);
    const storedPit = (sd.weekly_pitching || []).filter((p) => p.round === round && p.week === week);

    const allBatters = new Set([...mlbBat.map((b) => b.name), ...storedBat.map((b) => b.batter)]);
    const allPitchers = new Set([...mlbPit.map((p) => p.name), ...storedPit.map((p) => p.pitcher)]);

    const compareRows = (names, mlbList, storedList, nameKey) =>
      [...names]
        .map((name) => {
          const mlb = mlbList.find((x) => x.name === name) || null;
          const stored = storedList.find((x) => x[nameKey] === name) || null;
          const mlbScore = mlb?.weekly_score ?? null;
          const storedScore = stored?.weekly_score ?? null;
          const diff =
            mlbScore !== null && storedScore !== null ? Math.round((mlbScore - storedScore) * 100) / 100 : null;
          return { name, manager: mlb?.manager || stored?.manager || null, mlb, stored, score_diff: diff };
        })
        .sort((a, b) => Math.abs(b.score_diff ?? 0) - Math.abs(a.score_diff ?? 0));

    const battingComparison = compareRows(allBatters, mlbBat, storedBat, 'batter');
    const pitchingComparison = compareRows(allPitchers, mlbPit, storedPit, 'pitcher');

    const managerTotals = {};
    for (const row of [...battingComparison, ...pitchingComparison]) {
      const mgr = row.manager;
      if (!mgr) continue;
      if (!managerTotals[mgr]) managerTotals[mgr] = { mlb: 0, stored: 0 };
      managerTotals[mgr].mlb += row.mlb?.weekly_score ?? 0;
      managerTotals[mgr].stored += row.stored?.weekly_score ?? 0;
    }

    res.json({
      week: { round, week, start: dates.start, end: dates.end },
      games_fetched: gameRecords.length,
      manager_summary: Object.entries(managerTotals)
        .map(([manager, t]) => ({
          manager,
          mlb_total: Math.round(t.mlb * 100) / 100,
          stored_total: Math.round(t.stored * 100) / 100,
          diff: Math.round((t.mlb - t.stored) * 100) / 100,
        }))
        .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)),
      batting: battingComparison,
      pitching: pitchingComparison,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Core MLB-API sync logic, shared by the manual /api/mlb/sync endpoint and
// the daily 4am Eastern auto-sync scheduler. Mutates `sd` in place but does
// not write the db — the caller decides how to persist and audit.
async function performMLBSync(sd, schedWeek, dates, opts = {}) {
  const { round, week } = schedWeek;

  if (!sd.weekly_batting) sd.weekly_batting = [];
  if (!sd.weekly_pitching) sd.weekly_pitching = [];
  if (!sd.daily_batting) sd.daily_batting = [];
  if (!sd.daily_pitching) sd.daily_pitching = [];
  if (!sd.batters_team) sd.batters_team = {};
  if (!sd.pitchers_team) sd.pitchers_team = {};

  repairGhostInitialRosterPlayers(sd);
  syncPlayerDatesFromRosterDates(sd);

  const gameRecords = await fetchMLBPerGameStats(dates.start, dates.end, buildIdToWmmcName(sd));

  // Update team maps from all games
  for (const { teamMap } of gameRecords) {
    for (const [name, abbrev] of Object.entries(teamMap)) {
      sd.batters_team[name] = abbrev;
      sd.pitchers_team[name] = abbrev;
    }
  }

  let batImported = 0,
    batSkipped = 0,
    pitImported = 0,
    pitSkipped = 0;

  // Store one daily record per player per game, then recompute weekly totals.
  for (const { gameId, date, batting, pitching } of gameRecords) {
    for (const [name, gameStats] of Object.entries(batting)) {
      const manager =
        findManagerForPlayerWeek(sd, name, 'batting', schedWeek.round, schedWeek.week) ||
        findManagerForPlayer(sd, name, 'batting');

      // Skip if a manual/locked record already exists for this game
      const lockedDaily = sd.daily_batting.find(
        (r) =>
          r.game_id === gameId &&
          r.round === round &&
          r.week === week &&
          r.batter === name &&
          ((r.manual_fields && r.manual_fields.length > 0) || r.drop_locked)
      );
      if (lockedDaily) {
        manager ? batImported++ : batSkipped++;
        continue;
      }

      // Carry-forward of a player dropped in an earlier week — purge any stale auto record
      // and don't write a new one, so stats only accrue for the days they were rostered.
      if (isCarriedForwardDrop(sd, name, 'batting', round, week)) {
        sd.daily_batting = sd.daily_batting.filter(
          (r) =>
            !(
              r.game_id === gameId &&
              r.round === round &&
              r.week === week &&
              r.batter === name &&
              r.source === 'mlbapi'
            )
        );
        batSkipped++;
        continue;
      }

      // Replace any previous mlbapi record for this game (handles stat corrections)
      sd.daily_batting = sd.daily_batting.filter(
        (r) =>
          !(r.game_id === gameId && r.round === round && r.week === week && r.batter === name && r.source === 'mlbapi')
      );
      // delta = game stats; cumulative = game stats (per-game: each record is its own increment)
      sd.daily_batting.push({
        date,
        round,
        week,
        batter: name,
        game_id: gameId,
        cumulative: gameStats,
        delta: gameStats,
        source: 'mlbapi',
      });

      manager ? batImported++ : batSkipped++;
    }

    for (const [name, gameStats] of Object.entries(pitching)) {
      const manager =
        findManagerForPlayerWeek(sd, name, 'pitching', schedWeek.round, schedWeek.week) ||
        findManagerForPlayer(sd, name, 'pitching');

      const lockedDaily = sd.daily_pitching.find(
        (r) =>
          r.game_id === gameId &&
          r.round === round &&
          r.week === week &&
          r.pitcher === name &&
          ((r.manual_fields && r.manual_fields.length > 0) || r.drop_locked)
      );
      if (lockedDaily) {
        manager ? pitImported++ : pitSkipped++;
        continue;
      }

      if (isCarriedForwardDrop(sd, name, 'pitching', round, week)) {
        sd.daily_pitching = sd.daily_pitching.filter(
          (r) =>
            !(
              r.game_id === gameId &&
              r.round === round &&
              r.week === week &&
              r.pitcher === name &&
              r.source === 'mlbapi'
            )
        );
        pitSkipped++;
        continue;
      }

      sd.daily_pitching = sd.daily_pitching.filter(
        (r) =>
          !(r.game_id === gameId && r.round === round && r.week === week && r.pitcher === name && r.source === 'mlbapi')
      );
      sd.daily_pitching.push({
        date,
        round,
        week,
        pitcher: name,
        game_id: gameId,
        cumulative: gameStats,
        delta: gameStats,
        source: 'mlbapi',
      });

      manager ? pitImported++ : pitSkipped++;
    }
  }

  // Rebuild weekly summary rows from ALL stored daily records (not just the
  // games fetched this call). This means a partial-date fetch correctly
  // accumulates on top of prior data rather than overwriting it.
  rebuildWeeklyFromDaily(sd, round, week);

  if (!sd.upload_log) sd.upload_log = [];
  sd.upload_log.push({
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    type: 'mlbapi_sync',
    trigger: opts.trigger || 'manual',
    round,
    week,
    games: gameRecords.length,
    batting_imported: batImported,
    pitching_imported: pitImported,
    ...(opts.note ? { note: opts.note } : {}),
  });
  pruneSyncHistory(sd);

  return {
    games_fetched: gameRecords.length,
    batting_imported: batImported,
    batting_skipped: batSkipped,
    pitching_imported: pitImported,
    pitching_skipped: pitSkipped,
  };
}

// Fetch one calendar day's games and add them to the daily records, then
// rebuild the containing week's summary from all stored daily data.
// Used for the daily 4am incremental update — doesn't overwrite other days.
async function performMLBDailySync(sd, dateISO, opts = {}) {
  const wk = detectScheduleWeekForDate(sd, dateISO);
  if (!wk) return null;
  const { round, week } = wk.schedWeek;

  if (!sd.weekly_batting) sd.weekly_batting = [];
  if (!sd.weekly_pitching) sd.weekly_pitching = [];
  if (!sd.daily_batting) sd.daily_batting = [];
  if (!sd.daily_pitching) sd.daily_pitching = [];
  if (!sd.batters_team) sd.batters_team = {};
  if (!sd.pitchers_team) sd.pitchers_team = {};

  repairGhostInitialRosterPlayers(sd);
  syncPlayerDatesFromRosterDates(sd);

  const gameRecords = await fetchMLBPerGameStats(dateISO, dateISO, buildIdToWmmcName(sd));

  for (const { teamMap } of gameRecords) {
    for (const [name, abbrev] of Object.entries(teamMap)) {
      sd.batters_team[name] = abbrev;
      sd.pitchers_team[name] = abbrev;
    }
  }

  let batImported = 0,
    pitImported = 0;

  for (const { gameId, date, batting, pitching } of gameRecords) {
    for (const [name, gameStats] of Object.entries(batting)) {
      const locked = sd.daily_batting.find(
        (r) =>
          r.game_id === gameId &&
          r.round === round &&
          r.week === week &&
          r.batter === name &&
          ((r.manual_fields && r.manual_fields.length > 0) || r.drop_locked)
      );
      if (locked) {
        batImported++;
        continue;
      }
      // Don't write stats for a player carried forward into this week after being dropped
      // in an earlier week; purge any stale auto record so the week stays clean.
      if (isCarriedForwardDrop(sd, name, 'batting', round, week)) {
        sd.daily_batting = sd.daily_batting.filter(
          (r) =>
            !(
              r.game_id === gameId &&
              r.round === round &&
              r.week === week &&
              r.batter === name &&
              r.source === 'mlbapi'
            )
        );
        continue;
      }
      sd.daily_batting = sd.daily_batting.filter(
        (r) =>
          !(r.game_id === gameId && r.round === round && r.week === week && r.batter === name && r.source === 'mlbapi')
      );
      sd.daily_batting.push({
        date,
        round,
        week,
        batter: name,
        game_id: gameId,
        cumulative: gameStats,
        delta: gameStats,
        source: 'mlbapi',
      });
      batImported++;
    }
    for (const [name, gameStats] of Object.entries(pitching)) {
      const locked = sd.daily_pitching.find(
        (r) =>
          r.game_id === gameId &&
          r.round === round &&
          r.week === week &&
          r.pitcher === name &&
          ((r.manual_fields && r.manual_fields.length > 0) || r.drop_locked)
      );
      if (locked) {
        pitImported++;
        continue;
      }
      if (isCarriedForwardDrop(sd, name, 'pitching', round, week)) {
        sd.daily_pitching = sd.daily_pitching.filter(
          (r) =>
            !(
              r.game_id === gameId &&
              r.round === round &&
              r.week === week &&
              r.pitcher === name &&
              r.source === 'mlbapi'
            )
        );
        continue;
      }
      sd.daily_pitching = sd.daily_pitching.filter(
        (r) =>
          !(r.game_id === gameId && r.round === round && r.week === week && r.pitcher === name && r.source === 'mlbapi')
      );
      sd.daily_pitching.push({
        date,
        round,
        week,
        pitcher: name,
        game_id: gameId,
        cumulative: gameStats,
        delta: gameStats,
        source: 'mlbapi',
      });
      pitImported++;
    }
  }

  rebuildWeeklyFromDaily(sd, round, week);

  if (!sd.upload_log) sd.upload_log = [];
  sd.upload_log.push({
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    type: 'mlbapi_sync',
    trigger: opts.trigger || 'auto',
    round,
    week,
    games: gameRecords.length,
    batting_imported: batImported,
    pitching_imported: pitImported,
    note: `daily-delta:${dateISO}`,
  });
  pruneSyncHistory(sd);

  return {
    games_fetched: gameRecords.length,
    batting_imported: batImported,
    pitching_imported: pitImported,
    round,
    week,
  };
}

// Determine which weeks to full-sync during a Wednesday correction run or a
// Commissioner Sync Now. Returns 1-2 entries: the current week plus the prior
// week, but only when both are in the same scoring phase (pool play or playoff).
// Pool play weeks are never re-synced once the season enters playoffs, and
// a new playoff round never re-syncs the previous playoff round.
function resolveWeeksForCatchUp(sd, todayISO) {
  const scheduleDates = sd.schedule_dates || [];
  const todayWk = detectScheduleWeekForDate(sd, todayISO) || detectCurrentScheduleWeek(sd);
  if (!todayWk) return [];
  const curIdx = SEASON_SCHEDULE.findIndex(
    (s) => s.round === todayWk.schedWeek.round && s.week === todayWk.schedWeek.week
  );
  const result = [{ schedWeek: todayWk.schedWeek, dates: todayWk.dates, label: 'current' }];
  if (curIdx > 0) {
    const prevSched = SEASON_SCHEDULE[curIdx - 1];
    const prevDates = scheduleDates[curIdx - 1];
    if (prevDates && prevDates.start && prevDates.end && shouldCatchUpPrior(todayWk.schedWeek.round, prevSched.round)) {
      result.unshift({ schedWeek: prevSched, dates: prevDates, label: 'prior' });
    }
  }
  return result;
}

// Pool play weeks sync together across the PP1→PP2 boundary.
// Playoff rounds only sync within the same round (QF Week 2 catches up QF Week 1,
// but SF Week 1 does NOT go back and re-sync QF Week 2).
function shouldCatchUpPrior(currentRound, priorRound) {
  const pp = new Set(['PP1', 'PP2']);
  if (pp.has(currentRound) && pp.has(priorRound)) return true;
  if (!pp.has(currentRound) && !pp.has(priorRound)) return currentRound === priorRound;
  return false;
}

// POST /api/mlb/sync-current  { year }
// Commissioner "Sync Now": full-week correction for current week + prior week
// (when same round/phase), same as what runs automatically on Wednesdays.
app.post('/api/mlb/sync-current', requireCommissioner, async (req, res) => {
  const year = (req.body.year || new Date().getFullYear()).toString();
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const weekPairs = resolveWeeksForCatchUp(sd, todayET);
    if (weekPairs.length === 0) return res.status(400).json({ error: 'No schedule week found for today' });

    const guardBefore = captureScoreSnapshot(sd, todayET).totals;

    const results = [];
    for (const { schedWeek, dates, label } of weekPairs) {
      const r = await performMLBSync(sd, schedWeek, dates);
      addAuditEntry(db, 'mlbapi_sync', {
        year,
        round: schedWeek.round,
        week: schedWeek.week,
        batting_imported: r.batting_imported,
        pitching_imported: r.pitching_imported,
        note: `catchup-${label}`,
      });
      results.push({ week: `${schedWeek.round} ${schedWeek.week}`, label, ...r });
    }

    // Score guard: a manual full-week re-sync can legitimately apply MLB stat
    // corrections, but on a drop of 40+ pts we refuse to save unless the
    // commissioner re-submits with { force: true }.
    const guard = evaluateScoreGuard(guardBefore, sd, {
      dateISO: todayET,
      trigger: 'sync-now',
      force: !!req.body.force,
      year,
    });
    if (guard.blocked) {
      return res.status(409).json({
        error: 'Score guard blocked this sync — large downward swing detected. Re-run with force to override.',
        guard_blocked: true,
        report: guard.report,
        results,
      });
    }
    recordScoreSnapshot(sd, guard.snapshot);
    sd.last_sync_status = { ok: true, date: todayET, at: new Date().toISOString() };

    db.seasons[year] = sd;
    writeDB(db);
    res.json({ ok: true, results, guard: guard.report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mlb/sync  { year, round, week }
// Stores one daily_batting / daily_pitching record per player per game (keyed by game_id).
// Re-syncing a completed week replaces existing game records so MLB stat corrections propagate.
// Respects manual overrides and drop-locked records exactly like the Google Sheets sync.
app.post('/api/mlb/sync', requireCommissioner, async (req, res) => {
  const ctx = resolveMLBWeek(req, true);
  if (ctx.error) return res.status(400).json({ error: ctx.error });
  const { db, sd, year, round, week, dates, schedWeek } = ctx;

  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const guardBefore = captureScoreSnapshot(sd, todayET).totals;
    const result = await performMLBSync(sd, schedWeek, dates);

    const guard = evaluateScoreGuard(guardBefore, sd, {
      dateISO: todayET,
      trigger: 'manual-week-sync',
      force: !!req.body.force,
      year,
    });
    if (guard.blocked) {
      return res.status(409).json({
        error: 'Score guard blocked this sync — large downward swing detected. Re-run with force to override.',
        guard_blocked: true,
        report: guard.report,
      });
    }
    recordScoreSnapshot(sd, guard.snapshot);
    sd.last_sync_status = { ok: true, date: todayET, at: new Date().toISOString() };

    db.seasons[year] = sd;
    addAuditEntry(db, 'mlbapi_sync', {
      year,
      round,
      week,
      batting_imported: result.batting_imported,
      pitching_imported: result.pitching_imported,
    });
    writeDB(db);
    res.json({ ok: true, ...result, guard: guard.report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mlb/score-guard?year=YYYY
//   Default: lightweight list of stored daily snapshots (date + per-manager totals).
// GET /api/mlb/score-guard?year=YYYY&from=DATE&to=DATE
//   Player-level diff between two snapshot dates — "what changed?" after a swing.
app.get('/api/mlb/score-guard', requireCommissioner, (req, res) => {
  const year = (req.query.year || new Date().getFullYear()).toString();
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const snaps = sd.score_snapshots || [];
  if (req.query.from && req.query.to) {
    const a = snaps.find((s) => s.date === req.query.from);
    const b = snaps.find((s) => s.date === req.query.to);
    if (!a || !b) {
      return res
        .status(404)
        .json({ error: 'Snapshot not found for one of the dates', available: snaps.map((s) => s.date) });
    }
    return res.json({ year, from: a.date, to: b.date, diff: diffScoreSnapshots(a, b) });
  }

  res.json({
    year,
    retained: MAX_SCORE_SNAPSHOTS,
    snapshots: snaps.map((s) => ({ date: s.date, captured_at: s.captured_at, totals: s.totals })),
  });
});

// POST /api/mlb/snapshot?year=YYYY
// Capture the current Overall totals as a dated score-guard snapshot WITHOUT running a
// sync. Use it to seed/refresh the baseline the next compile diffs against — e.g. after a
// manual correction, or to recover when the trail is empty because recent compiles were
// blocked. Same-day re-run replaces that day's entry (recordScoreSnapshot dedupes by date).
app.post('/api/mlb/snapshot', requireCommissioner, (req, res) => {
  const year = ((req.query && req.query.year) || (req.body && req.body.year) || new Date().getFullYear()).toString();
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const dateISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const snapshot = captureScoreSnapshot(sd, dateISO);
  recordScoreSnapshot(sd, snapshot);
  db.seasons[year] = sd;
  addAuditEntry(db, 'score_snapshot_manual', { year, date: dateISO }, req.get('X-User-Email') || '');
  writeDB(db);

  res.json({ ok: true, year, date: dateISO, totals: snapshot.totals });
});

// Read-only audit: surface "ghost" players — anyone credited to a manager (via a weekly
// roster, a roster_dates entry, or attributed stat rows) who is NOT in that manager's
// legitimate origin set: their initial submission plus the player_in/player_out of any
// approved swap (commissioner adds go through swaps). Mirrors the Iván Herrera case, where
// a player with stat records + a roster_dates add-date but no submission/swap origin was
// credited via managerWeekSubtotal's roster_dates carry-forward. Name matching is
// accent/format-insensitive. This only reports — it never mutates — so a player whose
// submission slot was legitimately lost (see DATA_REPAIRS) will surface here for review
// rather than being purged automatically.
function auditGhostPlayers(sd) {
  const out = [];
  if (!sd) return out;

  const approvedSwaps = (sd.swaps || []).filter((s) => s.status === 'approved');
  const initial = sd.initial_submissions || {};
  const rosters = sd.rosters || {};
  const rosterDates = sd.roster_dates || {};
  const weeklyBat = sd.weekly_batting || [];
  const weeklyPit = sd.weekly_pitching || [];

  const managers = new Set([...Object.keys(initial), ...Object.keys(rosters), ...Object.keys(rosterDates)]);

  for (const mgr of managers) {
    const origin = new Set();
    const sub = initial[mgr] || {};
    [...(sub.batters || []), ...(sub.pitchers || [])].forEach((p) => origin.add(normalizeName(p)));
    approvedSwaps
      .filter((s) => s.manager === mgr)
      .forEach((s) => {
        if (s.player_in) origin.add(normalizeName(s.player_in));
        if (s.player_out) origin.add(normalizeName(s.player_out));
      });

    // Every player credited to this manager, keyed by normalized name → display name.
    const candidates = new Map();
    for (const wr of Object.values(rosters[mgr] || {})) {
      [...(wr.batters || []), ...(wr.pitchers || [])].forEach((p) => candidates.set(normalizeName(p), p));
    }
    for (const week of Object.values(rosterDates[mgr] || {})) {
      Object.keys(week || {}).forEach((p) => candidates.set(normalizeName(p), p));
    }
    weeklyBat.forEach((r) => r.manager === mgr && r.batter && candidates.set(normalizeName(r.batter), r.batter));
    weeklyPit.forEach((r) => r.manager === mgr && r.pitcher && candidates.set(normalizeName(r.pitcher), r.pitcher));

    for (const [norm, display] of candidates) {
      if (origin.has(norm)) continue;
      let points = 0;
      const weeks = new Set();
      weeklyBat.forEach((r) => {
        if (r.manager === mgr && normalizeName(r.batter) === norm) {
          points += r.weekly_score || 0;
          weeks.add(`${r.round}|${r.week}`);
        }
      });
      weeklyPit.forEach((r) => {
        if (r.manager === mgr && normalizeName(r.pitcher) === norm) {
          points += r.weekly_score || 0;
          weeks.add(`${r.round}|${r.week}`);
        }
      });
      const inRosterDates = Object.values(rosterDates[mgr] || {}).some((w) =>
        Object.keys(w || {}).some((p) => normalizeName(p) === norm)
      );
      out.push({
        manager: mgr,
        player: display,
        points: Math.round(points * 100) / 100,
        weeks: [...weeks],
        in_roster_dates: inRosterDates,
      });
    }
  }

  return out.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
}

// GET /api/mlb/ghost-audit?year=YYYY  — read-only list of ghost players to review.
app.get('/api/mlb/ghost-audit', requireCommissioner, (req, res) => {
  const year = (req.query.year || new Date().getFullYear()).toString();
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });
  const ghosts = auditGhostPlayers(sd);
  res.json({ year, count: ghosts.length, ghosts });
});

// GET /api/diag/manager?year=YYYY&name=Manager Name
// Read-only dump of one manager's source records — the inputs the live Overall
// standings are recomputed from. Used to diagnose attribution swings: compare
// what the manager actually rostered (initial_submissions + per-week rosters +
// swaps) against what currently scores (the per-week / per-player breakdown) to
// spot players wrongly excluded by a stray add/drop date. Mutates nothing.
app.get('/api/diag/manager', requireCommissioner, (req, res) => {
  const year = (req.query.year || new Date().getFullYear()).toString();
  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name query param is required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const managers = Object.keys(sd.rosters || {});
  if (!managers.includes(name) && !(sd.initial_submissions || {})[name]) {
    return res.status(404).json({ error: `Manager "${name}" not found`, available: managers });
  }

  // Every player this manager has ever been associated with — to scope player_dates.
  const playerNames = new Set();
  const mgrRosters = (sd.rosters || {})[name] || {};
  for (const wk of Object.values(mgrRosters)) {
    for (const p of wk.batters || []) playerNames.add(p);
    for (const p of wk.pitchers || []) playerNames.add(p);
  }
  const mgrRosterDates = (sd.roster_dates || {})[name] || {};
  for (const wk of Object.values(mgrRosterDates)) for (const p of Object.keys(wk)) playerNames.add(p);
  const mgrSwaps = (sd.swaps || []).filter((s) => s.manager === name);
  for (const s of mgrSwaps) {
    if (s.player_in) playerNames.add(s.player_in);
    if (s.player_out) playerNames.add(s.player_out);
  }

  // player_dates entries (the derived add/drop cutoffs) touching this manager's players.
  const playerDates = {};
  for (const [weekKey, types] of Object.entries(sd.player_dates || {})) {
    for (const type of ['batter', 'pitcher']) {
      for (const [player, entry] of Object.entries((types || {})[type] || {})) {
        if (!playerNames.has(player)) continue;
        playerDates[weekKey] = playerDates[weekKey] || {};
        playerDates[weekKey][type] = playerDates[weekKey][type] || {};
        playerDates[weekKey][type][player] = entry;
      }
    }
  }

  // What currently scores: per-week / per-player breakdown for this manager,
  // pulled from a fresh snapshot (mirrors the live scoreboard attribution).
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const snapshot = captureScoreSnapshot(sd, todayET);

  res.json({
    year,
    manager: name,
    schedule_dates: sd.schedule_dates || [],
    initial_submission: (sd.initial_submissions || {})[name] || null,
    rosters: mgrRosters,
    roster_dates: mgrRosterDates,
    player_dates: playerDates,
    swaps: mgrSwaps,
    scoring: {
      total: (snapshot.totals || {})[name] || null,
      by_week: (snapshot.detail || {})[name] || {},
    },
  });
});

// POST /api/seasons/:year/rebuild-roster-arrays
// Reconcile every manager's weekly roster arrays with their roster_dates add/drop
// history (purely additive — adds active-but-missing players, removes nothing).
// Fixes the per-player roster view showing carried-forward swap-ins as greyed /
// missing. Returns the additions made + a before/after total check (totals should
// not move, since scoring already derives eligibility from the same dates).
app.post('/api/seasons/:year/rebuild-roster-arrays', requireCommissioner, (req, res) => {
  const year = req.params.year;
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const before = captureScoreSnapshot(sd, todayET).totals;
  const changes = rebuildRosterArraysFromDates(sd);
  const after = captureScoreSnapshot(sd, todayET).totals;

  // Totals shouldn't move; surface any that did so the commissioner can eyeball it.
  const movedTotals = [];
  for (const m of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = (before[m] || {}).total || 0;
    const a = (after[m] || {}).total || 0;
    if (Math.abs(a - b) >= 0.01) {
      movedTotals.push({ manager: m, before: b, after: a, delta: Math.round((a - b) * 100) / 100 });
    }
  }

  db.seasons[year] = sd;
  addAuditEntry(db, 'rebuild_roster_arrays', { year, changes: changes.length }, req.get('X-User-Email'));
  writeDB(db);
  res.json({
    ok: true,
    managers_touched: new Set(changes.map((c) => c.manager)).size,
    changes,
    moved_totals: movedTotals,
  });
});

// POST /api/seasons/:year/reconstruct-rosters
// Recovery for a WIPED rosters object (sd.rosters === {}) — the failure mode where a stale
// full-season save blanks the per-week roster arrays, killing findManagerForPlayerWeek
// attribution (daily high/low, Live tab, per-player views) and arming the next stat compile to
// zero the scoreboard. Unlike rebuild-roster-arrays (additive, no-op on a full wipe), this
// recreates the arrays from surviving data: the manager fields on weekly stat rows plus
// roster_dates carry-forward. Score-neutral — it only rebuilds the attribution cache — so the
// before/after totals should match; any movement is surfaced for the commissioner to eyeball.
// Follow with Rebuild Totals to re-roll weekly scores from daily data once attribution is back.
app.post('/api/seasons/:year/reconstruct-rosters', requireCommissioner, (req, res) => {
  const year = req.params.year;
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const before = captureScoreSnapshot(sd, todayET).totals;
  const summary = reconstructRostersFromSurvivingData(sd);
  const after = captureScoreSnapshot(sd, todayET).totals;

  const movedTotals = [];
  for (const m of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = (before[m] || {}).total || 0;
    const a = (after[m] || {}).total || 0;
    if (Math.abs(a - b) >= 0.01) {
      movedTotals.push({ manager: m, before: b, after: a, delta: Math.round((a - b) * 100) / 100 });
    }
  }

  db.seasons[year] = sd;
  addAuditEntry(db, 'reconstruct_rosters', { year, ...summary }, req.get('X-User-Email'));
  writeDB(db);
  res.json({ ok: true, ...summary, moved_totals: movedTotals });
});

// GET /api/seasons/:year/roster-audit
// Read-only roster/manager provenance report (SAVE_HARDENING_PLAN.md, Layer 4). Verifies the core
// invariant: managers come only from db.managers, and every rostered player traces to a submission
// or approved swap with a date + period. Returns genuine problems (unknown managers, origin-less
// ghosts, swap-ins missing an add_date) separately from the known-benign cosmetic case (an
// original-draft player dropped early and not recorded in initial_submissions — scores correctly).
app.get('/api/seasons/:year/roster-audit', requireCommissioner, (req, res) => {
  const { year } = req.params;
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });
  const r = auditRosterIntegrity(db, sd);
  const ok = r.unknownManagers.length === 0 && r.ghosts.length === 0 && r.swapInNoAdd.length === 0;
  res.json({
    ok,
    genuine: {
      unknown_managers: r.unknownManagers,
      ghosts: r.ghosts,
      swap_in_missing_add_date: r.swapInNoAdd,
    },
    cosmetic: r.cosmetic,
  });
});

// POST /api/seasons/:year/dedupe-repair-swaps
// Removes 'repair-...' swaps that duplicate a real (non-repair) swap for the same move
// (manager + player_out + player_in + week_key). The old auto-repair band-aids (since deleted)
// recreated some swaps that the real record also covers, leaving doubles. Idempotent and safe:
// keeps any repair- swap that is the SOLE record of a move (deleting it would erase the move).
// Reports the removed entries + a before/after total check (totals should not move).
app.post('/api/seasons/:year/dedupe-repair-swaps', requireCommissioner, (req, res) => {
  const year = req.params.year;
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const swaps = Array.isArray(sd.swaps) ? sd.swaps : [];
  const moveKey = (s) => `${s.manager}|${s.player_out || ''}|${s.player_in || ''}|${s.week_key || ''}`;
  const realMoves = new Set(swaps.filter((s) => !String(s.id).startsWith('repair-')).map(moveKey));

  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const before = captureScoreSnapshot(sd, todayET).totals;

  const removed = [];
  sd.swaps = swaps.filter((s) => {
    if (String(s.id).startsWith('repair-') && realMoves.has(moveKey(s))) {
      removed.push({
        id: s.id,
        manager: s.manager,
        player_out: s.player_out,
        player_in: s.player_in,
        week_key: s.week_key,
      });
      return false;
    }
    return true;
  });

  const after = captureScoreSnapshot(sd, todayET).totals;
  const movedTotals = [];
  for (const m of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = (before[m] || {}).total || 0;
    const a = (after[m] || {}).total || 0;
    if (Math.abs(a - b) >= 0.01) {
      movedTotals.push({ manager: m, before: b, after: a, delta: Math.round((a - b) * 100) / 100 });
    }
  }

  db.seasons[year] = sd;
  addAuditEntry(db, 'dedupe_repair_swaps', { year, removed: removed.length }, req.get('X-User-Email'));
  writeDB(db);
  res.json({ ok: true, removed, removed_count: removed.length, moved_totals: movedTotals });
});

// POST /api/seasons/:year/initial-submission  { manager, batters, pitchers }
// Commissioner set/override of a manager's initial (Pool Play 1) submission, at any
// time. This is the generic, reusable replacement for the hardcoded "missing initial
// submission" repairs — correct the source record here instead of baking a player-
// specific fix into the server. Preserves the original submitted_at if present.
app.post('/api/seasons/:year/initial-submission', requireCommissioner, (req, res) => {
  const year = req.params.year;
  const { manager, batters, pitchers } = req.body || {};
  if (!manager || !Array.isArray(batters) || !Array.isArray(pitchers)) {
    return res.status(400).json({ error: 'manager, batters[] and pitchers[] are required' });
  }
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  if (!sd.initial_submissions) sd.initial_submissions = {};
  const existing = sd.initial_submissions[manager] || {};
  const now = new Date().toISOString();
  sd.initial_submissions[manager] = {
    ...existing,
    batters,
    pitchers,
    status: 'approved',
    submitted_at: existing.submitted_at || now,
    approved_at: now,
  };

  db.seasons[year] = sd;
  addAuditEntry(
    db,
    'set_initial_submission',
    { year, manager, batters: batters.length, pitchers: pitchers.length },
    req.get('X-User-Email')
  );
  writeDB(db);
  res.json({ ok: true, manager, initial_submission: sd.initial_submissions[manager] });
});

// POST /api/slack/test-guard-alert  — posts a clearly-labeled TEST score-guard alert to the
// notifications Slack channel so the commissioner can preview the format. Changes no data.
app.post('/api/slack/test-guard-alert', requireCommissioner, async (req, res) => {
  const blockers = [
    { manager: 'Example Manager A', before: 1419.6, after: 1053.8, delta: -365.8, pct: -0.258 },
    { manager: 'Example Manager B', before: 1108.2, after: 980.1, delta: -128.1, pct: -0.116 },
  ];
  const dateISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const msg =
    ':test_tube: *TEST — Score guard BLOCKED a compile* — scores NOT saved (drop of 40+ pts).\n' +
    `Season 2026 • ${dateISO} • trigger: test\n` +
    `Largest drops:\n${formatSwingLines(blockers)}\n` +
    '_This is a test — no scores changed. To triage a real one: paste `SCOREFIX` to Claude, or see RUNBOOK.md._';
  try {
    await postSlack(msg);
    res.json({ ok: true, posted: !!SLACK_WEBHOOK_URL, preview: msg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// MLB Name Normalization
// ============================================================

// Standard Levenshtein distance.
function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Strip accents, suffixes (Jr/Sr/III), and punctuation for comparison.
function normalizeName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Similarity score 0–1. Tries both forward and token-sorted order.
function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1.0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  const fwd = 1 - levenshtein(na, nb) / maxLen;
  // token-sorted: handles "Last, First" vs "First Last"
  const sorted = (s) => s.split(' ').sort().join(' ');
  const srt = 1 - levenshtein(sorted(na), sorted(nb)) / maxLen;
  return Math.max(fwd, srt);
}

// Collect every unique player name referenced anywhere in a season's data.
function extractSeasonPlayerNames(sd) {
  const names = new Set();
  const add = (v) => {
    if (v && typeof v === 'string') names.add(v);
  };

  (sd.batters_pool || []).forEach(add);
  (sd.pitchers_pool || []).forEach(add);

  for (const weekRosters of Object.values(sd.rosters || {})) {
    for (const roster of Object.values(weekRosters)) {
      (roster.batters || []).forEach(add);
      (roster.pitchers || []).forEach(add);
    }
  }

  for (const sub of Object.values(sd.initial_submissions || {})) {
    (sub.batters || []).forEach(add);
    (sub.pitchers || []).forEach(add);
  }

  for (const s of sd.swaps || []) {
    add(s.player_in);
    add(s.player_out);
  }

  for (const mgrDates of Object.values(sd.roster_dates || {})) {
    for (const weekDates of Object.values(mgrDates)) {
      Object.keys(weekDates).forEach(add);
    }
  }

  (sd.weekly_batting || []).forEach((b) => add(b.batter));
  (sd.weekly_pitching || []).forEach((p) => add(p.pitcher));
  (sd.daily_batting || []).forEach((b) => add(b.batter));
  (sd.daily_pitching || []).forEach((p) => add(p.pitcher));

  for (const weekTypes of Object.values(sd.player_dates || {})) {
    Object.keys(weekTypes.batter || {}).forEach(add);
    Object.keys(weekTypes.pitcher || {}).forEach(add);
  }

  Object.keys(sd.batters_team || {}).forEach(add);
  Object.keys(sd.pitchers_team || {}).forEach(add);

  return [...names].filter(Boolean).sort();
}

// Rename one player everywhere in a season (mutates sd). Returns count of fields changed.
function renamePlayerInSeason(sd, oldName, newName) {
  let count = 0;

  const renameArr = (arr) => {
    if (!arr) return;
    arr.forEach((v, i) => {
      if (v === oldName) {
        arr[i] = newName;
        count++;
      }
    });
  };
  const renameKey = (obj) => {
    if (!obj || !(oldName in obj)) return;
    obj[newName] = obj[oldName];
    delete obj[oldName];
    count++;
  };
  const renameField = (obj, field) => {
    if (obj && obj[field] === oldName) {
      obj[field] = newName;
      count++;
    }
  };

  renameArr(sd.batters_pool);
  renameArr(sd.pitchers_pool);

  for (const weekRosters of Object.values(sd.rosters || {})) {
    for (const roster of Object.values(weekRosters)) {
      renameArr(roster.batters);
      renameArr(roster.pitchers);
    }
  }

  for (const sub of Object.values(sd.initial_submissions || {})) {
    renameArr(sub.batters);
    renameArr(sub.pitchers);
  }

  for (const s of sd.swaps || []) {
    renameField(s, 'player_in');
    renameField(s, 'player_out');
  }

  for (const mgrDates of Object.values(sd.roster_dates || {})) {
    for (const weekDates of Object.values(mgrDates)) renameKey(weekDates);
  }

  (sd.weekly_batting || []).forEach((b) => renameField(b, 'batter'));
  (sd.weekly_pitching || []).forEach((p) => renameField(p, 'pitcher'));
  (sd.daily_batting || []).forEach((b) => renameField(b, 'batter'));
  (sd.daily_pitching || []).forEach((p) => renameField(p, 'pitcher'));

  for (const weekTypes of Object.values(sd.player_dates || {})) {
    renameKey(weekTypes.batter);
    renameKey(weekTypes.pitcher);
  }

  renameKey(sd.batters_team);
  renameKey(sd.pitchers_team);
  renameKey(sd.mlb_ids);

  return count;
}

// Fetch the MLB player catalog for a season: id + name + current team.
// Cached per-season for the lifetime of the process — the catalog is large (~2k players)
// and stable enough within a session that re-fetching on every audit call is wasteful.
//
// hydrate=currentTeam is required because the bare endpoint inconsistently returns team
// info on the player record (some players have only currentTeam.id without name/abbrev).
// teamId -> short abbreviation (ATL / LAD / NYM / ...). Sourced from
// /api/v1/teams so the abbreviation is consistent for every player, even
// when the players-endpoint hydrate response only fills currentTeam.name.
let _teamAbbrevsCache = null;
async function fetchMLBTeamAbbrevs({ refresh = false } = {}) {
  if (!refresh && _teamAbbrevsCache) return _teamAbbrevsCache;
  const data = await mlbApiFetch('/api/v1/teams?sportId=1');
  const map = {};
  for (const t of data.teams || []) {
    const abbrev = t.abbreviation || t.teamCode;
    if (t.id && abbrev) map[t.id] = abbrev;
  }
  _teamAbbrevsCache = map;
  return map;
}

const _mlbCatalogCache = new Map();
async function fetchMLBPlayerCatalog(season, { refresh = false } = {}) {
  const key = String(season);
  if (!refresh && _mlbCatalogCache.has(key)) return _mlbCatalogCache.get(key);
  const teamAbbrevs = await fetchMLBTeamAbbrevs({ refresh });
  const data = await mlbApiFetch(`/api/v1/sports/1/players?season=${season}&hydrate=currentTeam`);
  const catalog = (data.people || [])
    .filter((p) => p && p.id && p.fullName)
    .map((p) => {
      const teamId = p.currentTeam?.id || null;
      return {
        id: p.id,
        fullName: p.fullName,
        // Prefer the canonical abbreviation from /api/v1/teams; only fall back
        // to whatever currentTeam exposed inline when the teamId is unknown.
        team: (teamId && teamAbbrevs[teamId]) || p.currentTeam?.abbreviation || p.currentTeam?.teamCode || null,
        teamId,
        position: p.primaryPosition?.abbreviation || null,
      };
    });
  _mlbCatalogCache.set(key, catalog);
  return catalog;
}

// Back-compat: callers that only need names still work.
async function fetchMLBPlayerNames(season) {
  const catalog = await fetchMLBPlayerCatalog(season);
  return catalog.map((p) => p.fullName);
}

// Index a catalog by normalized fullName so duplicates (e.g. two "Max Muncy"s) surface as arrays.
function indexCatalogByName(catalog) {
  const byNorm = new Map();
  const byId = new Map();
  for (const entry of catalog) {
    byId.set(entry.id, entry);
    const norm = normalizeName(entry.fullName);
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm).push(entry);
  }
  return { byNorm, byId };
}

// Seed sd.batters_pool / sd.pitchers_pool from MLB's active-player catalog so
// every name that could earn fantasy points is searchable in the My Roster
// autocomplete, including players who haven't appeared in a boxscore yet
// (injured, just promoted, on bench). Two-way players (Ohtani-style) land in
// both pools. Team maps are refreshed every call so mid-season trades stay
// current. Names already in a pool are preserved — never removed — so any
// commissioner-curated additions survive a refresh.
async function bootstrapPlayerPools(sd, season, { refresh = false } = {}) {
  const catalog = await fetchMLBPlayerCatalog(season, { refresh });

  if (!sd.batters_pool) sd.batters_pool = [];
  if (!sd.pitchers_pool) sd.pitchers_pool = [];
  if (!sd.batters_team) sd.batters_team = {};
  if (!sd.pitchers_team) sd.pitchers_team = {};

  const battersSet = new Set(sd.batters_pool);
  const pitchersSet = new Set(sd.pitchers_pool);
  let battersAdded = 0;
  let pitchersAdded = 0;

  for (const p of catalog) {
    const name = p.fullName;
    if (!name) continue;
    const pos = p.position || '';
    const isPitcher = pos === 'P' || pos === 'SP' || pos === 'RP' || pos === 'TWP';
    const isBatter = pos !== 'P' && pos !== 'SP' && pos !== 'RP'; // TWP also bats

    if (isBatter) {
      if (!battersSet.has(name)) {
        sd.batters_pool.push(name);
        battersSet.add(name);
        battersAdded++;
      }
      if (p.team) sd.batters_team[name] = p.team;
    }
    if (isPitcher) {
      if (!pitchersSet.has(name)) {
        sd.pitchers_pool.push(name);
        pitchersSet.add(name);
        pitchersAdded++;
      }
      if (p.team) sd.pitchers_team[name] = p.team;
    }
  }

  return { battersAdded, pitchersAdded, catalogSize: catalog.length };
}

// Build the reverse lookup MLB ID -> WMMC display name from sd.mlb_ids.
// Used during stats merge to route boxscore stats to the right WMMC roster slot.
function buildIdToWmmcName(sd) {
  const map = new Map();
  for (const [name, id] of Object.entries(sd.mlb_ids || {})) {
    if (typeof id === 'number') map.set(id, name);
  }
  return map;
}

// For each WMMC name find the best MLB API match. Returns array of match objects.
function buildNameMatchReport(wmmcNames, mlbNames) {
  const mlbSet = new Set(mlbNames);
  return wmmcNames.map((wmmcName) => {
    if (mlbSet.has(wmmcName)) {
      return { wmmc_name: wmmcName, mlb_name: wmmcName, score: 1.0, exact: true, action: 'none' };
    }
    let bestName = null,
      bestScore = 0;
    for (const mlbName of mlbNames) {
      const s = nameSimilarity(wmmcName, mlbName);
      if (s > bestScore) {
        bestScore = s;
        bestName = mlbName;
      }
    }
    const score = Math.round(bestScore * 1000) / 1000;
    return {
      wmmc_name: wmmcName,
      mlb_name: bestName,
      score,
      exact: false,
      // >= 0.9: high confidence auto-fix; 0.75–0.89: review first; < 0.75: likely wrong sport/pool entry
      action: score >= 0.9 ? 'auto' : score >= 0.75 ? 'review' : 'no_match',
    };
  });
}

// GET /api/mlb/name-check?year=2025
// Compares every player name in the WMMC database against the MLB Stats API canonical list.
// Returns match report with confidence scores. Nothing is changed.
app.get('/api/mlb/name-check', requireCommissioner, async (req, res) => {
  const { year } = req.query;
  if (!year) return res.status(400).json({ error: 'year is required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  try {
    const [mlbNames, wmmcNames] = await Promise.all([
      fetchMLBPlayerNames(year),
      Promise.resolve(extractSeasonPlayerNames(sd)),
    ]);

    const report = buildNameMatchReport(wmmcNames, mlbNames);

    res.json({
      season: year,
      wmmc_player_count: wmmcNames.length,
      mlb_roster_size: mlbNames.length,
      exact_matches: report.filter((r) => r.exact).length,
      auto_fixable: report.filter((r) => r.action === 'auto').length,
      needs_review: report.filter((r) => r.action === 'review').length,
      no_match: report.filter((r) => r.action === 'no_match').length,
      // Worst matches first so problems are immediately visible
      players: report.sort((a, b) => a.score - b.score),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mlb/name-fix
// Applies name corrections across the entire season database.
//
// Two modes:
//   { year, mappings: [{ from, to }, ...] }        — apply specific corrections you've reviewed
//   { year, auto_threshold: 0.9 }                  — auto-apply all matches at or above the threshold
//
// Always returns what was changed so you can verify before running again.
app.post('/api/mlb/name-fix', requireCommissioner, async (req, res) => {
  const { year, mappings, auto_threshold } = req.body || {};
  if (!year) return res.status(400).json({ error: 'year is required' });
  if (!mappings && auto_threshold === undefined) {
    return res.status(400).json({ error: 'Provide either mappings or auto_threshold' });
  }

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  let toApply = mappings || [];

  if (auto_threshold !== undefined && !mappings) {
    try {
      const [mlbNames, wmmcNames] = await Promise.all([
        fetchMLBPlayerNames(year),
        Promise.resolve(extractSeasonPlayerNames(sd)),
      ]);
      const report = buildNameMatchReport(wmmcNames, mlbNames);
      toApply = report
        .filter((r) => !r.exact && r.score >= auto_threshold && r.mlb_name)
        .map((r) => ({ from: r.wmmc_name, to: r.mlb_name }));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const applied = [];
  for (const { from, to } of toApply) {
    if (!from || !to || from === to) continue;
    const occurrences = renamePlayerInSeason(sd, from, to);
    applied.push({ from, to, occurrences_updated: occurrences });
  }

  if (applied.length > 0) {
    db.seasons[year] = sd;
    addAuditEntry(db, 'mlb_name_fix', { year, renames: applied.length, detail: applied });
    writeDB(db);
  }

  res.json({ ok: true, renames_applied: applied.length, applied });
});

// Collect all player names that appear in any manager's roster for the given season.
// "currently rostered" = present in sd.rosters for any week this season.
function getRosteredNames(sd) {
  const rostered = new Set();
  for (const weekRosters of Object.values(sd.rosters || {})) {
    for (const roster of Object.values(weekRosters)) {
      (roster.batters || []).forEach((n) => rostered.add(n));
      (roster.pitchers || []).forEach((n) => rostered.add(n));
    }
  }
  return rostered;
}

// Return top N fuzzy candidates as catalog entries (id + fullName + team + score),
// so the commissioner can disambiguate duplicate-name MLB players.
function topCatalogCandidates(wmmcName, catalog, n = 5) {
  return catalog
    .map((entry) => ({
      mlb_id: entry.id,
      mlb_name: entry.fullName,
      team: entry.team,
      score: Math.round(nameSimilarity(wmmcName, entry.fullName) * 1000) / 1000,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

// GET /api/mlb/roster-audit?year=2025
//
// Tiers every player name in the database. The buckets are designed around the
// new ID-based identity model: a WMMC name is "fully identified" only when it
// has a stable MLB player ID in sd.mlb_ids.
//
//   rostered_exact     — on a roster AND has a confirmed mlb_id in sd.mlb_ids
//   needs_id_assignment— rostered, no mlb_id yet, single catalog match → safe auto-assign
//   duplicate_review   — rostered, multiple catalog entries share this name (e.g. two "Max Muncy")
//                        OR fuzzy candidates resolve to multiple ids; requires explicit mlb_id pick
//   rostered_review    — rostered, no exact catalog match; fuzzy candidates listed for manual pick
//   unrostered_auto    — not rostered, fuzzy score >= 0.75; will be auto-replaced on fix
//   unrostered_replace — not rostered, fuzzy score < 0.75; best MLB candidate will replace old name
//
// Nothing is changed by this endpoint.
app.get('/api/mlb/roster-audit', requireCommissioner, async (req, res) => {
  const { year } = req.query;
  if (!year) return res.status(400).json({ error: 'year is required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  try {
    const catalog = await fetchMLBPlayerCatalog(year);
    const { byNorm, byId } = indexCatalogByName(catalog);
    const allWmmcNames = extractSeasonPlayerNames(sd);
    const rostered = getRosteredNames(sd);
    const mlbIds = sd.mlb_ids || {};

    const rosteredExact = [];
    const needsIdAssignment = [];
    const duplicateReview = [];
    const rosteredReview = [];
    const unrosteredAuto = [];
    const unrosteredReplace = [];

    for (const wmmcName of allWmmcNames) {
      const isRostered = rostered.has(wmmcName);
      const assignedId = mlbIds[wmmcName];

      // Already confirmed via mlb_id — validate the id still exists in the catalog.
      if (typeof assignedId === 'number') {
        const entry = byId.get(assignedId);
        if (entry) {
          if (isRostered) {
            rosteredExact.push({ name: wmmcName, mlb_id: assignedId, mlb_name: entry.fullName, team: entry.team });
          }
          continue;
        }
        // Stale id — fall through to re-resolve.
      }

      const normMatches = byNorm.get(normalizeName(wmmcName)) || [];

      if (isRostered) {
        if (normMatches.length === 1) {
          // Single normalized-name match in catalog — safe to auto-assign on fix.
          const entry = normMatches[0];
          needsIdAssignment.push({
            wmmc_name: wmmcName,
            mlb_id: entry.id,
            mlb_name: entry.fullName,
            team: entry.team,
            rename_needed: entry.fullName !== wmmcName,
          });
        } else if (normMatches.length > 1) {
          // Duplicate fullName in MLB — must pick by id.
          duplicateReview.push({
            wmmc_name: wmmcName,
            reason: 'multiple_catalog_entries_share_name',
            candidates: normMatches.map((e) => ({
              mlb_id: e.id,
              mlb_name: e.fullName,
              team: e.team,
              position: e.position,
              score: 1.0,
            })),
          });
        } else {
          // No normalized match — fall back to fuzzy.
          const candidates = topCatalogCandidates(wmmcName, catalog, 5);
          const best = candidates[0];
          // If the top fuzzy hit's MLB name has multiple catalog entries (e.g. "Max Muncy (LAD)"
          // -> two "Max Muncy"s tied at the top score), this is really a duplicate-name pick:
          // route to duplicate_review so the commissioner sees all the colliding ids together.
          const topMlbDupes = best ? byNorm.get(normalizeName(best.mlb_name)) || [] : [];
          if (topMlbDupes.length > 1) {
            duplicateReview.push({
              wmmc_name: wmmcName,
              reason: 'fuzzy_top_match_has_multiple_catalog_entries',
              fuzzy_score: best.score,
              candidates: topMlbDupes.map((e) => ({
                mlb_id: e.id,
                mlb_name: e.fullName,
                team: e.team,
                position: e.position,
                score: best.score,
              })),
            });
          } else {
            rosteredReview.push({
              wmmc_name: wmmcName,
              best_match: best?.mlb_name ?? null,
              best_score: best?.score ?? 0,
              candidates,
            });
          }
        }
        continue;
      }

      // Unrostered: keep the historical name-only behavior — these get purged anyway on fix.
      const candidates = topCatalogCandidates(wmmcName, catalog, 5);
      const best = candidates[0];
      if (best && best.score >= 0.75) {
        unrosteredAuto.push({ wmmc_name: wmmcName, mlb_name: best.mlb_name, mlb_id: best.mlb_id, score: best.score });
      } else {
        unrosteredReplace.push({
          wmmc_name: wmmcName,
          mlb_name: best?.mlb_name ?? null,
          mlb_id: best?.mlb_id ?? null,
          score: best?.score ?? 0,
          candidates,
        });
      }
    }

    rosteredReview.sort((a, b) => a.best_score - b.best_score);

    res.json({
      season: year,
      summary: {
        rostered_exact: rosteredExact.length,
        needs_id_assignment: needsIdAssignment.length,
        duplicate_review: duplicateReview.length,
        rostered_review: rosteredReview.length,
        unrostered_auto: unrosteredAuto.length,
        unrostered_replace: unrosteredReplace.length,
      },
      // Auto-assignable on next roster-fix run, no input needed.
      needs_id_assignment: needsIdAssignment,
      // Requires explicit { from, mlb_id } in manual_mappings.
      duplicate_review: duplicateReview,
      // Fuzzy match — confirm before applying.
      rostered_review: rosteredReview,
      unrostered_auto: unrosteredAuto,
      unrostered_replace: unrosteredReplace,
      rostered_exact: rosteredExact,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove every trace of a player from a season (mutates sd). Returns count of fields removed.
function purgePlayerFromSeason(sd, name) {
  let count = 0;

  const removeFromArr = (arr) => {
    if (!arr) return;
    const before = arr.length;
    arr.splice(0, arr.length, ...arr.filter((v) => v !== name));
    count += before - arr.length;
  };
  const removeKey = (obj) => {
    if (obj && name in obj) {
      delete obj[name];
      count++;
    }
  };

  removeFromArr(sd.batters_pool);
  removeFromArr(sd.pitchers_pool);

  for (const weekRosters of Object.values(sd.rosters || {})) {
    for (const roster of Object.values(weekRosters)) {
      removeFromArr(roster.batters);
      removeFromArr(roster.pitchers);
    }
  }

  for (const sub of Object.values(sd.initial_submissions || {})) {
    removeFromArr(sub.batters);
    removeFromArr(sub.pitchers);
  }

  if (sd.swaps) {
    const before = sd.swaps.length;
    sd.swaps = sd.swaps.filter((s) => s.player_in !== name && s.player_out !== name);
    count += before - sd.swaps.length;
  }

  for (const mgrDates of Object.values(sd.roster_dates || {})) {
    for (const weekDates of Object.values(mgrDates)) removeKey(weekDates);
  }

  const filterField = (arr, field) => {
    if (!arr) return;
    const before = arr.length;
    const next = arr.filter((r) => r[field] !== name);
    arr.splice(0, arr.length, ...next);
    count += before - arr.length;
  };

  filterField(sd.weekly_batting, 'batter');
  filterField(sd.weekly_pitching, 'pitcher');
  filterField(sd.daily_batting, 'batter');
  filterField(sd.daily_pitching, 'pitcher');

  for (const weekTypes of Object.values(sd.player_dates || {})) {
    removeKey(weekTypes.batter);
    removeKey(weekTypes.pitcher);
  }

  removeKey(sd.batters_team);
  removeKey(sd.pitchers_team);
  removeKey(sd.mlb_ids);

  return count;
}

// POST /api/mlb/roster-fix
// Body: { year, manual_mappings: [{ from, to?, mlb_id? }] }
//
// One-pass cleanup. Every rostered WMMC name ends up either with a confirmed mlb_id in
// sd.mlb_ids or in `needs_manual` waiting on user input:
//
//   1. manual_mappings entries always win. Shape:
//        { from: <wmmc name>, to?: <new wmmc name>, mlb_id?: <int> }
//      - If `to` is omitted, only the id is assigned (no rename).
//      - `mlb_id` is REQUIRED when the target name has multiple MLB catalog entries
//        (e.g. two "Max Muncy"s) — otherwise the id can be inferred.
//   2. For unmapped rostered players, the endpoint auto-assigns the id when there is
//      exactly one normalized-name catalog match (covers accent-only diffs like
//      "Ranger Suárez" -> id of "Ranger Suarez"). It also auto-renames when the WMMC
//      name differs from the canonical fullName.
//   3. Fuzzy fallback for rostered players with no normalized match: auto-apply when
//      score >= 0.9 AND the target name is unique in the catalog.
//   4. Unrostered players with any name mismatch are PURGED entirely from the database —
//      their old misspelled records are removed and the MLB API sync will repopulate
//      them under the correct name on next run.
//
// sd.mlb_ids is the source of truth for player identity going forward: stats merge
// keys boxscore rows by MLB id and routes them to the WMMC display name via this map.
app.post('/api/mlb/roster-fix', requireCommissioner, async (req, res) => {
  const { year, manual_mappings } = req.body || {};
  if (!year) return res.status(400).json({ error: 'year is required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  try {
    const catalog = await fetchMLBPlayerCatalog(year);
    const { byNorm, byId } = indexCatalogByName(catalog);
    const allWmmcNames = extractSeasonPlayerNames(sd);
    const rostered = getRosteredNames(sd);
    const manualMap = new Map((manual_mappings || []).map((m) => [m.from, m]));

    if (!sd.mlb_ids) sd.mlb_ids = {};
    const idsInUse = new Map(Object.entries(sd.mlb_ids).map(([n, id]) => [id, n]));

    const applied = [];
    const idsAssigned = [];
    const needsManual = [];
    const purged = [];

    // Single source of truth for writing an id assignment: rejects collisions
    // (two WMMC names mapped to the same mlb id) since that would re-introduce the
    // exact ambiguity this system is meant to eliminate.
    const assignId = (wmmcName, mlbId) => {
      const existingHolder = idsInUse.get(mlbId);
      if (existingHolder && existingHolder !== wmmcName) {
        return { ok: false, error: `mlb_id ${mlbId} already assigned to "${existingHolder}"` };
      }
      sd.mlb_ids[wmmcName] = mlbId;
      idsInUse.set(mlbId, wmmcName);
      return { ok: true };
    };

    for (const wmmcName of allWmmcNames) {
      const isRostered = rostered.has(wmmcName);
      const manual = manualMap.get(wmmcName);

      // Manual mapping path — always applied (overrides every other rule).
      if (manual) {
        const to = manual.to || wmmcName;
        let mlbId = manual.mlb_id;
        // Allow id inference when target name is unambiguous in the catalog.
        if (mlbId == null) {
          const matches = byNorm.get(normalizeName(to)) || [];
          if (matches.length === 1) mlbId = matches[0].id;
          else if (matches.length > 1) {
            needsManual.push({
              wmmc_name: wmmcName,
              reason: 'mlb_id_required_for_ambiguous_target',
              candidates: matches.map((e) => ({ mlb_id: e.id, mlb_name: e.fullName, team: e.team })),
            });
            continue;
          }
        }
        if (mlbId != null && !byId.has(mlbId)) {
          needsManual.push({ wmmc_name: wmmcName, reason: `mlb_id ${mlbId} not found in ${year} catalog` });
          continue;
        }

        let occurrences = 0;
        if (to !== wmmcName) occurrences = renamePlayerInSeason(sd, wmmcName, to);
        if (mlbId != null) {
          const r = assignId(to, mlbId);
          if (!r.ok) {
            needsManual.push({ wmmc_name: wmmcName, reason: r.error });
            continue;
          }
          idsAssigned.push({ wmmc_name: to, mlb_id: mlbId, source: 'manual' });
        }
        if (to !== wmmcName || mlbId != null) {
          applied.push({
            from: wmmcName,
            to,
            mlb_id: mlbId ?? null,
            source: 'manual',
            occurrences_updated: occurrences,
          });
        }
        continue;
      }

      if (isRostered) {
        // Already has a confirmed id — verify catalog still has it.
        const existingId = sd.mlb_ids[wmmcName];
        if (typeof existingId === 'number' && byId.has(existingId)) continue;

        const normMatches = byNorm.get(normalizeName(wmmcName)) || [];

        if (normMatches.length === 1) {
          // Unambiguous: auto-assign id (and rename if WMMC name differs from canonical).
          const entry = normMatches[0];
          let occurrences = 0;
          let finalName = wmmcName;
          if (entry.fullName !== wmmcName) {
            occurrences = renamePlayerInSeason(sd, wmmcName, entry.fullName);
            finalName = entry.fullName;
          }
          const r = assignId(finalName, entry.id);
          if (!r.ok) {
            needsManual.push({ wmmc_name: wmmcName, reason: r.error });
            continue;
          }
          idsAssigned.push({ wmmc_name: finalName, mlb_id: entry.id, source: 'normalized_match' });
          if (occurrences > 0) {
            applied.push({
              from: wmmcName,
              to: finalName,
              mlb_id: entry.id,
              source: 'normalized_match',
              occurrences_updated: occurrences,
            });
          }
          continue;
        }

        if (normMatches.length > 1) {
          // Duplicate fullName in MLB — require explicit mlb_id.
          needsManual.push({
            wmmc_name: wmmcName,
            reason: 'multiple_catalog_entries_share_name',
            candidates: normMatches.map((e) => ({
              mlb_id: e.id,
              mlb_name: e.fullName,
              team: e.team,
              position: e.position,
            })),
          });
          continue;
        }

        // No normalized match — fall back to fuzzy.
        const fuzzy = topCatalogCandidates(wmmcName, catalog, 5);
        const best = fuzzy[0];
        if (best && best.score >= 0.9) {
          const targetMatches = byNorm.get(normalizeName(best.mlb_name)) || [];
          if (targetMatches.length === 1) {
            const entry = targetMatches[0];
            const occurrences = renamePlayerInSeason(sd, wmmcName, entry.fullName);
            const r = assignId(entry.fullName, entry.id);
            if (!r.ok) {
              needsManual.push({ wmmc_name: wmmcName, reason: r.error });
              continue;
            }
            idsAssigned.push({ wmmc_name: entry.fullName, mlb_id: entry.id, source: 'fuzzy_auto' });
            applied.push({
              from: wmmcName,
              to: entry.fullName,
              mlb_id: entry.id,
              source: 'fuzzy_auto',
              score: best.score,
              occurrences_updated: occurrences,
            });
            continue;
          }
        }
        needsManual.push({
          wmmc_name: wmmcName,
          best_match: best?.mlb_name ?? null,
          score: best?.score ?? 0,
          candidates: fuzzy,
        });
        continue;
      }

      // Unrostered: purge entirely. MLB sync will re-add under canonical fullName next run.
      const removed = purgePlayerFromSeason(sd, wmmcName);
      purged.push({ name: wmmcName, records_removed: removed });
    }

    if (applied.length > 0 || idsAssigned.length > 0 || purged.length > 0) {
      db.seasons[year] = sd;
      addAuditEntry(db, 'roster_name_fix', {
        year,
        renames: applied.length,
        ids_assigned: idsAssigned.length,
        purged: purged.length,
        detail: { applied, ids_assigned: idsAssigned, purged },
      });
      writeDB(db);
    }

    res.json({
      ok: true,
      summary: {
        renames_applied: applied.length,
        ids_assigned: idsAssigned.length,
        players_purged: purged.length,
        needs_manual_review: needsManual.length,
      },
      applied,
      ids_assigned: idsAssigned,
      purged,
      // If non-empty: re-POST with manual_mappings entries for these players
      needs_manual: needsManual,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mlb/recent-stats?year=2025&days=2
// Returns per-game stats from the last N days for every currently rostered player.
// Use this to verify MLB API data looks correct before committing name fixes to production.
app.get('/api/mlb/recent-stats', requireCommissioner, async (req, res) => {
  const { year, days = '2' } = req.query;
  if (!year) return res.status(400).json({ error: 'year is required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const rostered = getRosteredNames(sd);
  if (rostered.size === 0) return res.json({ period: {}, games_checked: 0, batting: [], pitching: [] });

  const numDays = Math.min(Math.max(parseInt(days) || 2, 1), 7);
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - (numDays - 1) * 86400000).toISOString().split('T')[0];

  try {
    const gameRecords = await fetchMLBPerGameStats(startDate, endDate, buildIdToWmmcName(sd));

    const batterLog = {};
    const pitcherLog = {};

    for (const { gameId, date, batting, pitching, teamMap } of gameRecords) {
      for (const [name, stats] of Object.entries(batting)) {
        if (!rostered.has(name)) continue;
        const manager = findManagerForPlayer(sd, name, 'batting');
        if (!batterLog[name]) batterLog[name] = { manager: manager || null, team: teamMap[name] || null, games: [] };
        batterLog[name].games.push({
          date,
          game_id: gameId,
          ...stats,
          game_score: Math.round(calculateBattingScore(stats) * 100) / 100,
        });
      }
      for (const [name, stats] of Object.entries(pitching)) {
        if (!rostered.has(name)) continue;
        const manager = findManagerForPlayer(sd, name, 'pitching');
        if (!pitcherLog[name]) pitcherLog[name] = { manager: manager || null, team: teamMap[name] || null, games: [] };
        pitcherLog[name].games.push({
          date,
          game_id: gameId,
          ...stats,
          game_score: Math.round(calculatePitchingScore(stats) * 100) / 100,
        });
      }
    }

    const summarise = (log) =>
      Object.entries(log)
        .map(([name, data]) => ({
          name,
          manager: data.manager,
          team: data.team,
          games: data.games.sort((a, b) => a.date.localeCompare(b.date)),
          period_score: Math.round(data.games.reduce((s, g) => s + g.game_score, 0) * 100) / 100,
        }))
        .sort((a, b) => b.period_score - a.period_score);

    res.json({
      period: { start: startDate, end: endDate, days: numDays },
      games_checked: gameRecords.length,
      rostered_player_count: rostered.size,
      batting: summarise(batterLog),
      pitching: summarise(pitcherLog),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mlb/teams-started?teams=NYY,LAD
// Lightweight check used at swap-submission time: given a comma-separated list of
// team abbreviations, returns which of those teams have a game today that has
// already started (Live/Final, or first-pitch time already passed). The frontend
// uses this to decide a swap's effective date — you can't swap a player in or out
// once their team's game has begun.
//
// Read-only and unauthenticated like /api/mlb/live; safe for any logged-in manager.
app.get('/api/mlb/teams-started', async (req, res) => {
  const teamsParam = (req.query.teams || '').trim();
  const requested = teamsParam
    ? teamsParam
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean)
    : [];

  // MLB games are dated in Eastern time; use ET so a late-evening UTC rollover
  // doesn't shift "today" to tomorrow.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  try {
    const scheduleData = await mlbApiFetch(
      `/api/v1/schedule?sportId=1&startDate=${today}&endDate=${today}&gameType=R,F,D,L,W&hydrate=team`
    );

    const now = Date.now();
    const startedSet = new Set();
    for (const dateEntry of scheduleData.dates || []) {
      for (const g of dateEntry.games || []) {
        const state = g.status?.abstractGameState || 'Preview';
        const firstPitch = g.gameDate ? new Date(g.gameDate).getTime() : null;
        const hasStarted = state === 'Live' || state === 'Final' || (firstPitch && firstPitch <= now);
        if (!hasStarted) continue;
        const away = g.teams?.away?.team?.abbreviation;
        const home = g.teams?.home?.team?.abbreviation;
        if (away) startedSet.add(away.toUpperCase());
        if (home) startedSet.add(home.toUpperCase());
      }
    }

    // When teams are requested, only report on those; otherwise return all started teams.
    const started = requested.length ? requested.filter((t) => startedSet.has(t)) : Array.from(startedSet);

    res.json({ today, started, any_started: started.length > 0 });
  } catch (e) {
    // On MLB API failure, report nothing as started — the frontend then treats the
    // swap as effective today, the same as the no-games-started path. Keeps swaps usable.
    res.json({ today, started: [], any_started: false, error: e.message });
  }
});

// GET /api/mlb/live?year=2026
// Live scoring snapshot for the schedule week that contains today's date.
// Combines the in-progress + final games' boxscore stats with the upcoming Preview games
// so the UI can render running totals plus a "games left" indicator per manager.
//
// Unlike /preview or /sync this endpoint includes Live games and is safe to poll on a
// short interval (~60s). It's read-only — nothing is written to the database.
app.get('/api/mlb/live', async (req, res) => {
  const { year } = req.query;
  if (!year) return res.status(400).json({ error: 'year is required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  // Use Eastern time — MLB games are dated in ET, and late-evening games would produce
  // a UTC date that's already tomorrow, breaking game-date comparisons entirely.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Find the schedule week whose [start, end] contains today.
  const scheduleDates = sd.schedule_dates || [];
  let activeIdx = -1;
  for (let i = 0; i < scheduleDates.length; i++) {
    const d = scheduleDates[i];
    if (d && d.start && d.end && today >= d.start && today <= d.end) {
      activeIdx = i;
      break;
    }
  }

  if (activeIdx < 0) {
    return res.json({
      season: year,
      active_week: null,
      reason: 'no_active_week_for_today',
      today,
      fetched_at: new Date().toISOString(),
      games: [],
      managers: [],
      players: [],
    });
  }

  const schedWeek = SEASON_SCHEDULE[activeIdx];
  const { start, end } = scheduleDates[activeIdx];
  const weekRound = schedWeek.round;
  const weekName = schedWeek.week;

  try {
    const idToWmmcName = buildIdToWmmcName(sd);

    // Pull the week's full schedule including in-progress + scheduled games.
    // hydrate=team is required because the bare schedule endpoint returns team.id/name
    // but not abbreviation, leaving the UI to render "?" for matchups.
    const scheduleData = await mlbApiFetch(
      `/api/v1/schedule?sportId=1&startDate=${start}&endDate=${end}&gameType=R,F,D,L,W&hydrate=team`
    );

    const games = [];
    for (const dateEntry of scheduleData.dates || []) {
      for (const g of dateEntry.games || []) {
        const state = g.status?.abstractGameState || 'Preview';
        games.push({
          game_id: g.gamePk,
          date: dateEntry.date,
          scheduled_time: g.gameDate || null,
          state,
          status_detail: g.status?.detailedState || null,
          inning: g.linescore?.currentInning || null,
          inning_half: g.linescore?.inningHalf || null,
          away: {
            team: g.teams?.away?.team?.abbreviation || null,
            team_name: g.teams?.away?.team?.name || null,
            score: g.teams?.away?.score ?? null,
          },
          home: {
            team: g.teams?.home?.team?.abbreviation || null,
            team_name: g.teams?.home?.team?.name || null,
            score: g.teams?.home?.score ?? null,
          },
        });
      }
    }

    // Fetch boxscores for Live + Final games. Preview games have no stats yet.
    // Done sequentially to avoid hammering the MLB API; ~15 games/day is fine on a 60s poll.
    // Keyed by `${wmmcName}::${type}` so two-way players (e.g. Ohtani) get separate
    // batting and pitching entries instead of colliding into one row.
    const playerAgg = {};
    for (const game of games) {
      if (game.state !== 'Live' && game.state !== 'Final') continue;
      let box;
      try {
        box = await mlbApiFetch(`/api/v1/game/${game.game_id}/boxscore`);
      } catch {
        continue;
      }
      const { batting, pitching } = parseBoxscore(box, idToWmmcName, game.state === 'Final');

      const collect = (statsMap, type, scorer) => {
        for (const [name, stats] of Object.entries(statsMap)) {
          const key = `${name}::${type}`;
          if (!playerAgg[key]) {
            playerAgg[key] = { name, type, stats: {}, games: [] };
          }
          // Sum stats across games this week so the weekly running total stays correct.
          for (const k of Object.keys(stats)) {
            playerAgg[key].stats[k] = (playerAgg[key].stats[k] || 0) + (stats[k] || 0);
          }
          playerAgg[key].games.push({
            game_id: game.game_id,
            date: game.date,
            state: game.state,
            stats: { ...stats },
            game_score: Math.round(scorer(stats) * 100) / 100,
          });
        }
      };
      collect(batting, 'batting', calculateBattingScore);
      collect(pitching, 'pitching', calculatePitchingScore);
    }

    // Build per-manager rosters for the active week. This league tracks rosters via roster_dates +
    // submissions (carry-forward), so the sd.rosters arrays are usually empty — relying on them
    // (as findManagerForPlayer* do) leaves both the standings and the per-player scoring blank.
    // Derive each manager's active-week roster from roster_dates (most-recent add not superseded by
    // a drop as of the week's end), classified by pool, unioned with any explicit stored arrays.
    // Mirrors rebuildRosterArraysFromDates and managerWeekSubtotal's eligibility, so Live's roster
    // view matches the Scoreboard's.
    const weekKey = `${weekRound}|${weekName}`;
    const batPool = new Set(sd.batters_pool || []);
    const pitPool = new Set(sd.pitchers_pool || []);
    const managerBatters = {}; // manager -> string[]
    const managerPitchers = {}; // manager -> string[]
    const allManagerNames = new Set([...Object.keys(sd.rosters || {}), ...Object.keys(sd.roster_dates || {})]);
    for (const manager of allManagerNames) {
      const stored = (sd.rosters && sd.rosters[manager] && sd.rosters[manager][weekKey]) || {};
      const bats = [...(stored.batters || [])];
      const pits = [...(stored.pitchers || [])];

      const mgrDates = (sd.roster_dates || {})[manager];
      if (mgrDates && typeof mgrDates === 'object') {
        // Latest add / drop for each player as of this week's end.
        const latestAdd = {};
        const latestDrop = {};
        for (const players of Object.values(mgrDates)) {
          if (!players || typeof players !== 'object') continue;
          for (const [p, d] of Object.entries(players)) {
            if (d.add_date && (!end || d.add_date <= end) && (!latestAdd[p] || d.add_date > latestAdd[p])) {
              latestAdd[p] = d.add_date;
            }
            if (d.drop_date && (!end || d.drop_date <= end) && (!latestDrop[p] || d.drop_date > latestDrop[p])) {
              latestDrop[p] = d.drop_date;
            }
          }
        }
        for (const p of Object.keys(latestAdd)) {
          if (latestDrop[p] && latestAdd[p] <= latestDrop[p]) continue; // dropped and not re-added
          const inBat = batPool.has(p);
          const inPit = pitPool.has(p);
          if (inBat && !inPit) {
            if (!bats.includes(p)) bats.push(p);
          } else if (inPit && !inBat) {
            if (!pits.includes(p)) pits.push(p);
          }
          // both/neither pool: can't classify confidently — rely on the stored arrays.
        }
      }

      if (bats.length || pits.length) {
        managerBatters[manager] = bats;
        managerPitchers[manager] = pits;
      }
    }

    // Reverse index for player→manager attribution this week, built from the carry-forward rosters
    // above. findManagerForPlayer* read the empty sd.rosters arrays and would attribute nothing, so
    // without this the per-player scoring (Daily/Weekly + the expand panels) stays at zero. Keyed by
    // lowercased name + type so a two-way player resolves per role.
    const weekManagerByPlayer = {};
    for (const [m, names] of Object.entries(managerBatters)) {
      for (const n of names) weekManagerByPlayer[`${n.toLowerCase()}::batting`] = m;
    }
    for (const [m, names] of Object.entries(managerPitchers)) {
      for (const n of names) weekManagerByPlayer[`${n.toLowerCase()}::pitching`] = m;
    }

    // Resolve manager + team for each player and compute running scores.
    // Only include rostered players in the live view — unrostered names are noise here.
    const playerRows = [];
    for (const [, agg] of Object.entries(playerAgg)) {
      const { name } = agg;
      const manager =
        weekManagerByPlayer[`${name.toLowerCase()}::${agg.type}`] ||
        findManagerForPlayerWeek(sd, name, agg.type, weekRound, weekName) ||
        findManagerForPlayer(sd, name, agg.type);
      if (!manager) continue;
      // Skip players dropped in an earlier week but carried forward into this week's roster
      // object — they are excluded from the certified total, so they must not appear here either.
      if (wasDroppedBeforeWeek(sd, manager, name, `${weekRound}|${weekName}`, start)) continue;
      const teamMap = agg.type === 'batting' ? sd.batters_team : sd.pitchers_team;
      const score = agg.type === 'batting' ? calculateBattingScore(agg.stats) : calculatePitchingScore(agg.stats);
      const hasLive = agg.games.some((g) => g.state === 'Live');
      const hasFinal = agg.games.some((g) => g.state === 'Final');
      // today_score = sum of just today's game contributions, so the standings can show
      // both this week's total and what a manager added in the current day.
      // Respect player_dates: a player dropped before today or not yet effective today
      // is still in the roster object (auto-advance carry-forward) but must not be credited.
      const eligibleToday = isDateEligibleForPlayer(sd, name, agg.type, weekRound, weekName, today);
      const todayScore = eligibleToday
        ? agg.games.filter((g) => g.date === today).reduce((s, g) => s + (g.game_score || 0), 0)
        : 0;
      playerRows.push({
        name,
        manager,
        team: teamMap?.[name] || null,
        type: agg.type,
        running_score: Math.round(score * 100) / 100,
        today_score: Math.round(todayScore * 100) / 100,
        stats: agg.stats,
        games_played: agg.games.length,
        any_live: hasLive,
        any_final: hasFinal,
        games: agg.games.sort((a, b) => a.date.localeCompare(b.date)),
      });
    }
    playerRows.sort((a, b) => b.running_score - a.running_score);

    // For each team, classify their day relative to today's games:
    //   ACTIVE     — at least one game today is Live
    //   REMAINING  — at least one Preview game today, no Live
    //   DONE       — only Final game(s) today
    //   none       — no game today
    // This drives both the per-player Live/Done/Remaining counts and the per-manager
    // green highlight when they still have skin in the game today.
    const teamTodayStates = {}; // teamAbbr -> { live, preview, final }
    for (const game of games) {
      if (game.date !== today) continue;
      for (const side of [game.away, game.home]) {
        const t = side?.team;
        if (!t) continue;
        if (!teamTodayStates[t]) teamTodayStates[t] = { live: 0, preview: 0, final: 0 };
        if (game.state === 'Live') teamTodayStates[t].live++;
        else if (game.state === 'Preview') teamTodayStates[t].preview++;
        else if (game.state === 'Final') teamTodayStates[t].final++;
      }
    }
    const classifyTeamToday = (t) => {
      const s = teamTodayStates[t];
      if (!s) return null;
      if (s.live > 0) return 'ACTIVE';
      if (s.preview > 0) return 'REMAINING';
      if (s.final > 0) return 'DONE';
      return null;
    };

    // Per-manager rollup. Seed all rostered managers so the standings show every entry
    // even when a manager has no recorded play yet today.
    const managerMap = {};
    const ensureMgr = (m) => {
      if (!managerMap[m]) {
        managerMap[m] = {
          name: m,
          running_score: 0, // sum of player running scores this week
          today_score: 0, // sum of player scores from today's games only
          round_total: 0, // see below — fills in after we have running_score
          players_active: 0, // rostered players whose team has a Live game today
          players_finished: 0, // rostered players whose team's games today are Final-only
          players_remaining: 0, // rostered players whose team has a Preview game today
        };
      }
      return managerMap[m];
    };
    for (const m of Object.keys(managerBatters)) ensureMgr(m);

    for (const row of playerRows) {
      const m = ensureMgr(row.manager);
      m.running_score = Math.round((m.running_score + row.running_score) * 100) / 100;
      m.today_score = Math.round((m.today_score + (row.today_score || 0)) * 100) / 100;
    }

    // Per-player today-state counts, derived from the rostered player's team's today-state.
    // A player without a known team or whose team has no game today is not counted.
    const incrementPlayerStateCounts = (manager, names, teamMap) => {
      const seenPlayers = new Set();
      for (const name of names || []) {
        if (seenPlayers.has(name)) continue;
        seenPlayers.add(name);
        const team = teamMap?.[name];
        if (!team) continue;
        const state = classifyTeamToday(team);
        if (!state) continue;
        const mgr = ensureMgr(manager);
        if (state === 'ACTIVE') mgr.players_active++;
        else if (state === 'REMAINING') mgr.players_remaining++;
        else if (state === 'DONE') mgr.players_finished++;
      }
    };
    for (const m of Object.keys(managerMap)) {
      incrementPlayerStateCounts(m, managerBatters[m], sd.batters_team);
      incrementPlayerStateCounts(m, managerPitchers[m], sd.pitchers_team);
    }

    // ---- Certified scoreboard total (matches the Scoreboard view exactly) ----
    // The naive `if (b.manager) sum(weekly_score)` approach over-counts rows for
    // players who were on the manager's roster when stats were uploaded but are
    // no longer on the roster for that week (mid-week swaps, dropped carry-overs).
    // The displayed Scoreboard re-validates roster membership per week before
    // crediting points; the Live tab must do the same so Live Total exactly equals
    // (Scoreboard Total + today's daily points).
    //
    // The active phase decides which rounds to roll up: pool play (PP1/PP2) maps
    // to the Pool Play Overall view (PP1 + PP2 + their *P import variants); a
    // playoff round maps to just that round's scoreboard.
    const isPoolPlayPhase = weekRound === 'PP1' || weekRound === 'PP2';
    const certifiedRounds = isPoolPlayPhase ? new Set(['PP1', 'PP2']) : new Set([weekRound]);

    // Roll up certified weekly totals through the shared per-week subtotal
    // helper, so the Live Total = Scoreboard Total + today's daily points,
    // reconciled to the My Roster page's Pool Play Total stat card.
    const certifiedTotals = {};
    const battingRows = sd.weekly_batting || [];
    const pitchingRows = sd.weekly_pitching || [];
    SEASON_SCHEDULE.forEach((schedWeek, idx) => {
      if (!certifiedRounds.has(schedWeek.round)) return;
      for (const mgr of Object.keys(managerMap)) {
        const bat = managerWeekSubtotal(sd, mgr, schedWeek, idx, battingRows, 'batter', 'batters');
        const pit = managerWeekSubtotal(sd, mgr, schedWeek, idx, pitchingRows, 'pitcher', 'pitchers');
        certifiedTotals[mgr] = (certifiedTotals[mgr] || 0) + bat + pit;
      }
    });
    // Seed managers who have no certified points yet so they still get a rank.
    for (const m of Object.keys(managerMap)) if (!(m in certifiedTotals)) certifiedTotals[m] = 0;

    const rankByTotals = (totalsMap) =>
      Object.entries(totalsMap)
        .sort((a, b) => b[1] - a[1])
        .reduce((acc, [name], i) => {
          acc[name] = i + 1;
          return acc;
        }, {});

    const baselineRanks = rankByTotals(certifiedTotals);
    const liveTotalsMap = {};
    for (const m of Object.keys(certifiedTotals)) {
      const today = (managerMap[m] && managerMap[m].today_score) || 0;
      liveTotalsMap[m] = certifiedTotals[m] + today;
    }
    const liveRanks = rankByTotals(liveTotalsMap);

    for (const [m, agg] of Object.entries(managerMap)) {
      const baseRank = baselineRanks[m] ?? null;
      const liveRank = liveRanks[m] ?? null;
      agg.baseline_rank = baseRank;
      agg.live_rank = liveRank;
      agg.rank_delta = baseRank != null && liveRank != null ? baseRank - liveRank : 0;
      agg.round_total = Math.round(((certifiedTotals[m] || 0) + agg.today_score) * 100) / 100;
      agg.is_active_today = agg.players_active > 0 || agg.players_remaining > 0;
    }

    const managers = Object.values(managerMap).sort((a, b) => b.round_total - a.round_total);

    res.json({
      season: year,
      active_week: { round: weekRound, week: weekName, start, end, week_index: activeIdx },
      today,
      fetched_at: new Date().toISOString(),
      summary: {
        games_total: games.length,
        games_live: games.filter((g) => g.state === 'Live').length,
        games_final: games.filter((g) => g.state === 'Final').length,
        games_preview: games.filter((g) => g.state === 'Preview').length,
      },
      games,
      managers,
      players: playerRows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mlb/live/game/:gamePk?year=YYYY
// GET /api/mlb/daily?year=YYYY&date=YYYY-MM-DD
// Historical daily scoring snapshot built from synced daily_batting/daily_pitching records.
// Returns per-manager daily scores, rank deltas, and player details for a past date.
// Safe to call for any date that falls within the season schedule.
app.get('/api/mlb/daily', (req, res) => {
  const { year, date } = req.query;
  if (!year || !date) return res.status(400).json({ error: 'year and date are required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  const scheduleDates = sd.schedule_dates || [];
  let weekIdx = -1;
  for (let i = 0; i < scheduleDates.length; i++) {
    const wd = scheduleDates[i];
    if (wd && wd.start && wd.end && date >= wd.start && date <= wd.end) {
      weekIdx = i;
      break;
    }
  }

  if (weekIdx < 0) return res.json({ season: year, date, active_week: null });

  const schedWeek = SEASON_SCHEDULE[weekIdx];
  const { start, end } = scheduleDates[weekIdx];
  const weekRound = schedWeek.round;
  const weekName = schedWeek.week;

  const isPoolPlayPhase = weekRound === 'PP1' || weekRound === 'PP2';
  const certifiedRounds = isPoolPlayPhase ? new Set(['PP1', 'PP2']) : new Set([weekRound]);

  // Also include legacy '*P' import-variant rounds (e.g. PP1P, PP2P)
  const inCertifiedRounds = (r) =>
    certifiedRounds.has(r) || (r && r.endsWith('P') && certifiedRounds.has(r.slice(0, -1)));

  const allManagers = new Set(Object.keys(sd.rosters || {}));
  const battingRows = sd.weekly_batting || [];
  const pitchingRows = sd.weekly_pitching || [];

  // Step 1: certified weekly totals for all certified-round weeks that fully ended before D's week.
  // Uses managerWeekSubtotal (roster-validated, reads weekly_batting) — same logic as live scoreboard.
  const certifiedCompletedWeeks = {};
  for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
    const sw = SEASON_SCHEDULE[i];
    const wd = scheduleDates[i];
    if (!wd || !wd.end) continue;
    if (!inCertifiedRounds(sw.round)) continue;
    if (wd.end >= start) continue; // skip D's current week and any overlapping/later weeks
    for (const mgr of allManagers) {
      const bat = managerWeekSubtotal(sd, mgr, sw, i, battingRows, 'batter', 'batters');
      const pit = managerWeekSubtotal(sd, mgr, sw, i, pitchingRows, 'pitcher', 'pitchers');
      if (bat + pit !== 0) certifiedCompletedWeeks[mgr] = (certifiedCompletedWeeks[mgr] || 0) + bat + pit;
    }
  }

  // Step 2: sum daily records for ONLY the active week through a cutoff date.
  // Scoped strictly to current round+week to avoid cross-week contamination.
  // No findManagerForPlayer fallback — unrostered players are excluded.
  const weeklyThrough = (cutoff) => {
    const totals = {};
    const process = (records, playerKey, scoreFunc, playerType) => {
      for (const r of records) {
        if (r.date > cutoff || r.round !== weekRound || r.week !== weekName) continue;
        const name = r[playerKey];
        const mgr = findManagerForPlayerWeek(sd, name, playerType, r.round, r.week);
        if (!mgr) continue;
        if (wasDroppedBeforeWeek(sd, mgr, name, `${weekRound}|${weekName}`, start)) continue;
        if (!isDateEligibleForPlayer(sd, name, playerType, r.round, r.week, r.date)) continue;
        totals[mgr] = (totals[mgr] || 0) + scoreFunc(r.delta || {});
      }
    };
    process(sd.daily_batting || [], 'batter', calculateBattingScore, 'batting');
    process(sd.daily_pitching || [], 'pitcher', calculatePitchingScore, 'pitching');
    return totals;
  };

  const prevDate = (() => {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const weekBefore = weeklyThrough(prevDate);
  const weekAfter = weeklyThrough(date);

  const rankByTotals = (map) =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .reduce((acc, [name], i) => {
        acc[name] = i + 1;
        return acc;
      }, {});

  const totalsBefore = {};
  const totalsAfter = {};
  for (const mgr of allManagers) {
    totalsBefore[mgr] = (certifiedCompletedWeeks[mgr] || 0) + (weekBefore[mgr] || 0);
    totalsAfter[mgr] = (certifiedCompletedWeeks[mgr] || 0) + (weekAfter[mgr] || 0);
  }
  const ranksBefore = rankByTotals(totalsBefore);
  const ranksAfter = rankByTotals(totalsAfter);

  const managers = [...allManagers]
    .map((mgr) => ({
      name: mgr,
      today_score: Math.round(((weekAfter[mgr] || 0) - (weekBefore[mgr] || 0)) * 100) / 100,
      round_total: Math.round((totalsAfter[mgr] || 0) * 100) / 100,
      running_score: Math.round((weekAfter[mgr] || 0) * 100) / 100,
      baseline_rank: ranksBefore[mgr] ?? null,
      live_rank: ranksAfter[mgr] ?? null,
      rank_delta: (ranksBefore[mgr] ?? 0) - (ranksAfter[mgr] ?? 0),
    }))
    .sort((a, b) => b.round_total - a.round_total || a.name.localeCompare(b.name));

  // Player-level details for just this date
  const players = [];
  const pushPlayers = (records, playerKey, scoreFunc, playerType, teamMap) => {
    for (const r of records) {
      if (r.date !== date || r.round !== weekRound || r.week !== weekName) continue;
      const name = r[playerKey];
      const mgr = findManagerForPlayerWeek(sd, name, playerType, r.round, r.week);
      if (!mgr) continue;
      if (wasDroppedBeforeWeek(sd, mgr, name, `${weekRound}|${weekName}`, start)) continue;
      if (!isDateEligibleForPlayer(sd, name, playerType, r.round, r.week, r.date)) continue;
      players.push({
        name,
        manager: mgr,
        team: teamMap?.[name] || null,
        type: playerType,
        score: Math.round(scoreFunc(r.delta || {}) * 100) / 100,
        stats: r.delta || {},
      });
    }
  };
  pushPlayers(sd.daily_batting || [], 'batter', calculateBattingScore, 'batting', sd.batters_team);
  pushPlayers(sd.daily_pitching || [], 'pitcher', calculatePitchingScore, 'pitching', sd.pitchers_team);
  players.sort((a, b) => b.score - a.score);

  res.json({
    season: year,
    date,
    active_week: { round: weekRound, week: weekName, start, end, week_index: weekIdx },
    season_start: scheduleDates[0]?.start ?? null,
    season_end: scheduleDates[scheduleDates.length - 1]?.end ?? null,
    managers,
    players,
  });
});

// Full single-game boxscore for the Live tab's per-game expand UI. Returns
// every batter and pitcher from both teams (not just rostered), with each
// player flagged `rostered` against the active schedule week and tagged with
// their WMMC manager when one exists. Lazily called only when the user
// opens a game card, so it never inflates the routine 2-minute /live poll.
app.get('/api/mlb/live/game/:gamePk', async (req, res) => {
  const { gamePk } = req.params;
  const { year } = req.query;
  if (!gamePk) return res.status(400).json({ error: 'gamePk is required' });
  if (!year) return res.status(400).json({ error: 'year is required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  // Resolve the active week so we can flag each MLB player as rostered (or not)
  // for the currently-running WMMC week. If today doesn't fall inside a week,
  // we just leave week-specific lookups off and fall back to historical roster.
  // Use Eastern time — MLB game dates are ET-based; a UTC "today" drifts to tomorrow
  // after ~8 PM ET and breaks the rostered-player flagging logic.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const scheduleDates = sd.schedule_dates || [];
  let activeIdx = -1;
  for (let i = 0; i < scheduleDates.length; i++) {
    const d = scheduleDates[i];
    if (d && d.start && d.end && today >= d.start && today <= d.end) {
      activeIdx = i;
      break;
    }
  }
  const schedWeek = activeIdx >= 0 ? SEASON_SCHEDULE[activeIdx] : null;
  const weekRound = schedWeek?.round || null;
  const weekName = schedWeek?.week || null;

  try {
    const idToWmmcName = buildIdToWmmcName(sd);
    const box = await mlbApiFetch(`/api/v1/game/${gamePk}/boxscore`);
    // Determine whether this game is final so CG/CGSO/NH aren't credited mid-game
    // (the boxscore alone carries no game state). Look it up from the active week's
    // schedule; on any miss or failure, default to not-final — the safe direction.
    let gameIsFinal = false;
    try {
      const range = scheduleDates[activeIdx];
      if (range?.start && range?.end) {
        const sched = await mlbApiFetch(
          `/api/v1/schedule?sportId=1&startDate=${range.start}&endDate=${range.end}&gameType=R,F,D,L,W`
        );
        for (const dateEntry of sched.dates || []) {
          for (const g of dateEntry.games || []) {
            if (String(g.gamePk) === String(gamePk)) {
              gameIsFinal = g.status?.abstractGameState === 'Final';
            }
          }
        }
      }
    } catch {
      // Leave gameIsFinal = false — better to omit CG than to credit an in-progress game.
    }
    const { batting, pitching } = parseBoxscore(box, idToWmmcName, gameIsFinal);

    const teams = {};
    for (const side of ['away', 'home']) {
      const t = box.teams?.[side];
      if (!t) continue;
      teams[side] = {
        team: t.team?.abbreviation || null,
        team_name: t.team?.name || null,
        runs: t.teamStats?.batting?.runs ?? null,
        hits: t.teamStats?.batting?.hits ?? null,
        errors: t.teamStats?.fielding?.errors ?? null,
      };
    }

    const sidedBatting = { away: [], home: [] };
    const sidedPitching = { away: [], home: [] };

    for (const side of ['away', 'home']) {
      const teamData = box.teams?.[side];
      if (!teamData) continue;
      const abbrev = teamData.team?.abbreviation || '';
      for (const player of Object.values(teamData.players || {})) {
        const fullName = player.person?.fullName;
        const mlbId = player.person?.id;
        if (!fullName) continue;
        const name = (mlbId && idToWmmcName.get(mlbId)) || fullName;

        const bStats = batting[name];
        if (bStats) {
          let manager =
            (weekRound && findManagerForPlayerWeek(sd, name, 'batting', weekRound, weekName)) ||
            findManagerForPlayer(sd, name, 'batting') ||
            null;
          // A player dropped in an earlier week but carried forward into this week's roster
          // object isn't really this manager's — don't flag them as rostered.
          if (
            manager &&
            wasDroppedBeforeWeek(sd, manager, name, `${weekRound}|${weekName}`, scheduleDates[activeIdx]?.start)
          ) {
            manager = null;
          }
          sidedBatting[side].push({
            name,
            team: abbrev,
            position: player.position?.abbreviation || null,
            batting_order: player.battingOrder ? parseInt(player.battingOrder, 10) : null,
            stats: bStats,
            pts: Math.round(calculateBattingScore(bStats) * 100) / 100,
            manager,
            rostered: !!manager,
          });
        }

        const pStats = pitching[name];
        if (pStats) {
          let manager =
            (weekRound && findManagerForPlayerWeek(sd, name, 'pitching', weekRound, weekName)) ||
            findManagerForPlayer(sd, name, 'pitching') ||
            null;
          if (
            manager &&
            wasDroppedBeforeWeek(sd, manager, name, `${weekRound}|${weekName}`, scheduleDates[activeIdx]?.start)
          ) {
            manager = null;
          }
          sidedPitching[side].push({
            name,
            team: abbrev,
            stats: pStats,
            pts: Math.round(calculatePitchingScore(pStats) * 100) / 100,
            manager,
            rostered: !!manager,
          });
        }
      }
      sidedBatting[side].sort((a, b) => (a.batting_order ?? 9999) - (b.batting_order ?? 9999));
      sidedPitching[side].sort((a, b) => (b.stats.ip || 0) - (a.stats.ip || 0));
    }

    res.json({
      game_pk: Number(gamePk),
      fetched_at: new Date().toISOString(),
      active_week: schedWeek ? { round: weekRound, week: weekName } : null,
      teams,
      batting: sidedBatting,
      pitching: sidedPitching,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/slack/scoreboard — post the current scoreboard to Slack
app.post('/api/slack/scoreboard', requireCommissioner, async (req, res) => {
  if (!SLACK_WEBHOOK_URL) {
    return res.status(503).json({ error: 'Slack webhook not configured' });
  }

  const db = readDB();
  const userEmail = req.get('X-User-Email') || '';
  const config = db.google_sheets_config || {};
  const year = (req.body && req.body.year) || config.season || String(new Date().getFullYear());

  try {
    await postScoreboardSlack(db, year);
    addAuditEntry(db, 'slack_scoreboard_post', { year }, userEmail);
    writeDB(db);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Slack] Scoreboard post failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/slack/command — Slack slash command handler
// Slack sends application/x-www-form-urlencoded. Body reading is inlined so
// that express.json() (which runs globally) cannot leave the stream in a state
// where the 'end' event never fires, which would cause a 3-second Slack timeout.
app.post('/api/slack/command', (req, res) => {
  let rawBody = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    rawBody += chunk;
  });
  req.on('error', () => res.status(400).send('Bad request'));
  req.on('end', () => {
    try {
      // Verify the request came from Slack
      if (SLACK_SIGNING_SECRET) {
        const timestamp = req.headers['x-slack-request-timestamp'];
        const signature = req.headers['x-slack-signature'];
        const age = Math.abs(Date.now() / 1000 - parseInt(timestamp || '0', 10));
        if (!timestamp || !signature || age > 300) {
          return res.status(403).send('Invalid request');
        }
        const hmac = crypto
          .createHmac('sha256', SLACK_SIGNING_SECRET)
          .update(`v0:${timestamp}:${rawBody}`)
          .digest('hex');
        if (`v0=${hmac}` !== signature) return res.status(403).send('Invalid signature');
      }

      // Parse the URL-encoded body Slack sends
      const params = new URLSearchParams(rawBody || '');
      const body = Object.fromEntries(params.entries());
      const text = (body.text || '').trim().toLowerCase();

      const db = readDB();
      const config = db.google_sheets_config || {};
      const year = config.season || String(new Date().getFullYear());

      // Support optional year argument: /wmmc 2024
      const requestedYear = /^\d{4}$/.test(text) ? text : year;

      const { blocks, text: fallback } = buildScoreboardBlocks(db, requestedYear);

      // response_type: in_channel makes the reply visible to everyone in the channel
      res.json({ response_type: 'in_channel', text: fallback, blocks });
    } catch (err) {
      console.error('[Slack] /wmmc command error:', err);
      res.json({ response_type: 'ephemeral', text: 'An error occurred generating the scoreboard.' });
    }
  });
});

// DELETE /api/seasons/:year/week-data — clear all stats for a given week
app.delete('/api/seasons/:year/week-data', requireCommissioner, (req, res) => {
  const { year } = req.params;
  const { round, week, type } = req.body;

  if (!round || !week) {
    return res.status(400).json({ error: 'round and week are required' });
  }

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  let batRemoved = 0,
    pitRemoved = 0;

  if (!type || type === 'batting' || type === 'all') {
    const before = (sd.weekly_batting || []).length;
    sd.weekly_batting = (sd.weekly_batting || []).filter((b) => !(b.round === round && b.week === week));
    batRemoved = before - (sd.weekly_batting || []).length;
    // Clear daily batting snapshots for the same week
    sd.daily_batting = (sd.daily_batting || []).filter((b) => !(b.round === round && b.week === week));
  }

  if (!type || type === 'pitching' || type === 'all') {
    const before = (sd.weekly_pitching || []).length;
    sd.weekly_pitching = (sd.weekly_pitching || []).filter((p) => !(p.round === round && p.week === week));
    pitRemoved = before - (sd.weekly_pitching || []).length;
    // Clear daily pitching snapshots for the same week
    sd.daily_pitching = (sd.daily_pitching || []).filter((p) => !(p.round === round && p.week === week));
  }

  addAuditEntry(
    db,
    'clear_week_data',
    { year, round, week, type: type || 'all', batRemoved, pitRemoved },
    req.get('X-User-Email')
  );
  db.seasons[year] = sd;
  writeDB(db);

  res.json({ ok: true, batting_removed: batRemoved, pitching_removed: pitRemoved });
});

// ============================================================
// Player Dates — per-player active date overrides for mid-week add/drops
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/seasons/:year/player-dates
app.get('/api/seasons/:year/player-dates', (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });
  res.json(sd.player_dates || {});
});

// POST /api/seasons/:year/player-dates — set a player's active date range for a specific week
// Body: { round, week, player, type ('batter'|'pitcher'), start ('YYYY-MM-DD'|null), end ('YYYY-MM-DD'|null) }
app.post('/api/seasons/:year/player-dates', requireCommissioner, (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });

  const userEmail = req.get('X-User-Email') || '';
  const db = readDB();
  const manager = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === userEmail.toLowerCase());
  if (!manager || !manager.commissioner) return res.status(403).json({ error: 'Commissioner access required' });

  const { round, week, player, type, start, end } = req.body;
  if (!round || !week || !player || !type) {
    return res.status(400).json({ error: 'round, week, player, and type are required' });
  }
  if (type !== 'batter' && type !== 'pitcher') return res.status(400).json({ error: 'type must be batter or pitcher' });
  if (start && !DATE_RE.test(start)) return res.status(400).json({ error: 'start must be YYYY-MM-DD' });
  if (end && !DATE_RE.test(end)) return res.status(400).json({ error: 'end must be YYYY-MM-DD' });

  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  if (!sd.player_dates) sd.player_dates = {};
  if (!sd.daily_batting) sd.daily_batting = [];
  if (!sd.daily_pitching) sd.daily_pitching = [];

  const weekKey = `${round}|${week}`;
  if (!sd.player_dates[weekKey]) sd.player_dates[weekKey] = {};
  if (!sd.player_dates[weekKey][type]) sd.player_dates[weekKey][type] = {};
  sd.player_dates[weekKey][type][player] = { start: start || null, end: end || null };

  // Recompute weekly score for this player using the new date constraint
  if (type === 'batter') {
    const score = computeEffectiveBattingScore(sd, player, round, week);
    if (score !== null) {
      const entry = (sd.weekly_batting || []).find(
        (b) =>
          b.batter === player &&
          b.round === round &&
          b.week === week &&
          !((b.manual_fields && b.manual_fields.length > 0) || b.drop_locked)
      );
      if (entry) {
        entry.weekly_score = score;
        entry.total_score = score;
      }
    }
  } else {
    const score = computeEffectivePitchingScore(sd, player, round, week);
    if (score !== null) {
      const entry = (sd.weekly_pitching || []).find(
        (p) =>
          p.pitcher === player &&
          p.round === round &&
          p.week === week &&
          !((p.manual_fields && p.manual_fields.length > 0) || p.drop_locked)
      );
      if (entry) {
        entry.weekly_score = score;
      }
    }
  }

  addAuditEntry(
    db,
    'player_date_set',
    { year, round, week, player, type, start: start || null, end: end || null },
    userEmail
  );
  db.seasons[year] = sd;
  writeDB(db);
  res.json({ ok: true, player_dates: sd.player_dates[weekKey] });
});

// DELETE /api/seasons/:year/player-dates — remove a player's date override (resets to full week)
// Body: { round, week, player, type }
app.delete('/api/seasons/:year/player-dates', requireCommissioner, (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });

  const userEmail = req.get('X-User-Email') || '';
  const db = readDB();
  const manager = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === userEmail.toLowerCase());
  if (!manager || !manager.commissioner) return res.status(403).json({ error: 'Commissioner access required' });

  const { round, week, player, type } = req.body;
  if (!round || !week || !player || !type) {
    return res.status(400).json({ error: 'round, week, player, and type are required' });
  }

  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  if (!sd.daily_batting) sd.daily_batting = [];
  if (!sd.daily_pitching) sd.daily_pitching = [];

  const weekKey = `${round}|${week}`;
  if (sd.player_dates && sd.player_dates[weekKey] && sd.player_dates[weekKey][type]) {
    delete sd.player_dates[weekKey][type][player];
  }

  // Recompute score without the override (reverts to full week)
  if (type === 'batter') {
    const score = computeEffectiveBattingScore(sd, player, round, week);
    if (score !== null) {
      const entry = (sd.weekly_batting || []).find(
        (b) =>
          b.batter === player &&
          b.round === round &&
          b.week === week &&
          !((b.manual_fields && b.manual_fields.length > 0) || b.drop_locked)
      );
      if (entry) {
        entry.weekly_score = score;
        entry.total_score = score;
      }
    }
  } else {
    const score = computeEffectivePitchingScore(sd, player, round, week);
    if (score !== null) {
      const entry = (sd.weekly_pitching || []).find(
        (p) =>
          p.pitcher === player &&
          p.round === round &&
          p.week === week &&
          !((p.manual_fields && p.manual_fields.length > 0) || p.drop_locked)
      );
      if (entry) {
        entry.weekly_score = score;
      }
    }
  }

  addAuditEntry(db, 'player_date_delete', { year, round, week, player, type }, userEmail);
  db.seasons[year] = sd;
  writeDB(db);
  res.json({ ok: true });
});

// ============================================================
// Daily Stats — view and manually override individual day records
// ============================================================

// GET /api/seasons/:year/daily-stats
// Query: player (optional), type ('batter'|'pitcher', optional), round (optional), week (optional)
app.get('/api/seasons/:year/daily-stats', (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });
  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  const { player, type, round, week } = req.query;

  const filterBat = (r) =>
    (!player || r.batter === player) && (!round || r.round === round) && (!week || r.week === week);
  const filterPit = (r) =>
    (!player || r.pitcher === player) && (!round || r.round === round) && (!week || r.week === week);

  if (type === 'batter') return res.json((sd.daily_batting || []).filter(filterBat));
  if (type === 'pitcher') return res.json((sd.daily_pitching || []).filter(filterPit));
  res.json({
    batting: (sd.daily_batting || []).filter(filterBat),
    pitching: (sd.daily_pitching || []).filter(filterPit),
  });
});

// POST /api/seasons/:year/daily-stats — commissioner manual daily stat entry
// Body: { date ('YYYY-MM-DD'), round, week, type ('batter'|'pitcher'), player, delta: { ...stats } }
app.post('/api/seasons/:year/daily-stats', requireCommissioner, (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });

  const userEmail = req.get('X-User-Email') || '';
  const db = readDB();
  const mgr = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === userEmail.toLowerCase());
  if (!mgr || !mgr.commissioner) return res.status(403).json({ error: 'Commissioner access required' });

  const { date, round, week, type, player, delta } = req.body;
  if (!date || !round || !week || !type || !player || !delta) {
    return res.status(400).json({ error: 'date, round, week, type, player, and delta are required' });
  }
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (type !== 'batter' && type !== 'pitcher') return res.status(400).json({ error: 'type must be batter or pitcher' });

  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  if (!sd.daily_batting) sd.daily_batting = [];
  if (!sd.daily_pitching) sd.daily_pitching = [];
  if (!sd.weekly_batting) sd.weekly_batting = [];
  if (!sd.weekly_pitching) sd.weekly_pitching = [];

  if (type === 'batter') {
    const cleanDelta = {
      '1b': parseNum(delta['1b'] || 0),
      '2b': parseNum(delta['2b'] || 0),
      '3b': parseNum(delta['3b'] || 0),
      hr: parseNum(delta.hr || 0),
      r: parseNum(delta.r || 0),
      rbi: parseNum(delta.rbi || 0),
      sb: parseNum(delta.sb || 0),
      bb: parseNum(delta.bb || 0),
      abs: parseNum(delta.abs || 0),
    };
    sd.daily_batting = sd.daily_batting.filter(
      (r) => !(r.date === date && r.round === round && r.week === week && r.batter === player)
    );
    sd.daily_batting.push({
      date,
      round,
      week,
      batter: player,
      cumulative: null,
      delta: cleanDelta,
      source: 'manual',
      manual_fields: Object.keys(delta),
      drop_locked: true,
    });
    // Recompute and update weekly record
    const score = computeEffectiveBattingScore(sd, player, round, week);
    if (score !== null) {
      let entry = sd.weekly_batting.find((b) => b.batter === player && b.round === round && b.week === week);
      if (!entry) {
        let manager = findManagerForPlayerWeek(sd, player, 'batting', round, week);
        if (!manager) manager = findManagerForPlayer(sd, player, 'batting');
        entry = {
          round,
          week,
          manager: manager || null,
          batter: player,
          source: 'manual',
          weekly_score: 0,
          total_score: 0,
        };
        sd.weekly_batting.push(entry);
      }
      if (!((entry.manual_fields && entry.manual_fields.length > 0) || entry.drop_locked)) {
        entry.weekly_score = score;
        entry.total_score = score;
      }
    }
  } else {
    const cleanDelta = {
      gs: parseNum(delta.gs || 0),
      w: parseNum(delta.w || 0),
      qs: parseNum(delta.qs || 0),
      cg: parseNum(delta.cg || 0),
      cgso: parseNum(delta.cgso || 0),
      nh: parseNum(delta.nh || 0),
      ip: parseNum(delta.ip || 0),
      h: parseNum(delta.h || 0),
      er: parseNum(delta.er || 0),
      bb: parseNum(delta.bb || 0),
      k: parseNum(delta.k || 0),
    };
    sd.daily_pitching = sd.daily_pitching.filter(
      (r) => !(r.date === date && r.round === round && r.week === week && r.pitcher === player)
    );
    sd.daily_pitching.push({
      date,
      round,
      week,
      pitcher: player,
      cumulative: null,
      delta: cleanDelta,
      source: 'manual',
      manual_fields: Object.keys(delta),
      drop_locked: true,
    });
    const score = computeEffectivePitchingScore(sd, player, round, week);
    if (score !== null) {
      let entry = sd.weekly_pitching.find((p) => p.pitcher === player && p.round === round && p.week === week);
      if (!entry) {
        let manager = findManagerForPlayerWeek(sd, player, 'pitching', round, week);
        if (!manager) manager = findManagerForPlayer(sd, player, 'pitching');
        entry = { round, week, manager: manager || null, pitcher: player, source: 'manual', weekly_score: 0 };
        sd.weekly_pitching.push(entry);
      }
      if (!((entry.manual_fields && entry.manual_fields.length > 0) || entry.drop_locked)) {
        entry.weekly_score = score;
      }
    }
  }

  addAuditEntry(db, 'daily_stat_manual', { year, date, round, week, type, player }, userEmail);
  db.seasons[year] = sd;
  writeDB(db);
  res.json({ ok: true });
});

// DELETE /api/seasons/:year/daily-stats — delete a specific daily stat record (commissioner)
// Body: { date, round, week, type, player }
app.delete('/api/seasons/:year/daily-stats', requireCommissioner, (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });

  const userEmail = req.get('X-User-Email') || '';
  const db = readDB();
  const mgr = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === userEmail.toLowerCase());
  if (!mgr || !mgr.commissioner) return res.status(403).json({ error: 'Commissioner access required' });

  const { date, round, week, type, player } = req.body;
  if (!date || !round || !week || !type || !player) {
    return res.status(400).json({ error: 'date, round, week, type, and player are required' });
  }

  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  if (!sd.daily_batting) sd.daily_batting = [];
  if (!sd.daily_pitching) sd.daily_pitching = [];

  if (type === 'batter') {
    sd.daily_batting = sd.daily_batting.filter(
      (r) => !(r.date === date && r.round === round && r.week === week && r.batter === player)
    );
    const score = computeEffectiveBattingScore(sd, player, round, week);
    if (score !== null) {
      const entry = (sd.weekly_batting || []).find(
        (b) =>
          b.batter === player &&
          b.round === round &&
          b.week === week &&
          !((b.manual_fields && b.manual_fields.length > 0) || b.drop_locked)
      );
      if (entry) {
        entry.weekly_score = score;
        entry.total_score = score;
      }
    }
  } else {
    sd.daily_pitching = sd.daily_pitching.filter(
      (r) => !(r.date === date && r.round === round && r.week === week && r.pitcher === player)
    );
    const score = computeEffectivePitchingScore(sd, player, round, week);
    if (score !== null) {
      const entry = (sd.weekly_pitching || []).find(
        (p) =>
          p.pitcher === player &&
          p.round === round &&
          p.week === week &&
          !((p.manual_fields && p.manual_fields.length > 0) || p.drop_locked)
      );
      if (entry) {
        entry.weekly_score = score;
      }
    }
  }

  addAuditEntry(db, 'daily_stat_delete', { year, date, round, week, type, player }, userEmail);
  db.seasons[year] = sd;
  writeDB(db);
  res.json({ ok: true });
});

// POST /api/seasons/:year/recompute-scores — recompute all weekly scores from daily data (commissioner)
app.post('/api/seasons/:year/recompute-scores', requireCommissioner, (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });

  const userEmail = req.get('X-User-Email') || '';
  const db = readDB();
  const mgr = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === userEmail.toLowerCase());
  if (!mgr || !mgr.commissioner) return res.status(403).json({ error: 'Commissioner access required' });

  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  syncPlayerDatesFromRosterDates(sd);
  recomputeAllWeeklyScores(sd);

  addAuditEntry(db, 'recompute_scores', { year }, userEmail);
  db.seasons[year] = sd;
  writeDB(db);
  res.json({ ok: true });
});

// ============================================================
// Elimination Roasts
// ============================================================

// Build a plain-text performance summary for the given manager in the given round.
function buildManagerPerformanceForRoast(sd, manager, round) {
  const roundMap = { PP: ['PP1', 'PP2'], QF: ['QF'], SF: ['SF'], Finals: ['Finals'] };
  const rounds = roundMap[round] || [round];

  const batters = {};
  const pitchers = {};

  (sd.weekly_batting || []).forEach((b) => {
    if (!rounds.includes(b.round)) return;
    if (!b.batter) return;
    // Simple ownership check: was this player on this manager's roster?
    const rosters = sd.rosters && sd.rosters[manager];
    if (!rosters) return;
    const weekKey = `${b.round}|${b.week}`;
    const weekRoster = rosters[weekKey] || {};
    if (!(weekRoster.batters || []).includes(b.batter)) return;
    batters[b.batter] = (batters[b.batter] || 0) + (b.weekly_score || 0);
  });

  (sd.weekly_pitching || []).forEach((p) => {
    if (!rounds.includes(p.round)) return;
    if (!p.pitcher) return;
    const rosters = sd.rosters && sd.rosters[manager];
    if (!rosters) return;
    const weekKey = `${p.round}|${p.week}`;
    const weekRoster = rosters[weekKey] || {};
    if (!(weekRoster.pitchers || []).includes(p.pitcher)) return;
    pitchers[p.pitcher] = (pitchers[p.pitcher] || 0) + (p.weekly_score || 0);
  });

  const totalBat = Object.values(batters).reduce((s, v) => s + v, 0);
  const totalPit = Object.values(pitchers).reduce((s, v) => s + v, 0);
  const total = Math.round((totalBat + totalPit) * 100) / 100;

  const sortedBatters = Object.entries(batters)
    .sort((a, b) => a[1] - b[1])
    .map(([name, score]) => `${name}: ${Math.round(score * 100) / 100} pts`);
  const sortedPitchers = Object.entries(pitchers)
    .sort((a, b) => a[1] - b[1])
    .map(([name, score]) => `${name}: ${Math.round(score * 100) / 100} pts`);

  return {
    manager,
    round,
    total,
    batting_total: Math.round(totalBat * 100) / 100,
    pitching_total: Math.round(totalPit * 100) / 100,
    batters_ranked_worst_first: sortedBatters,
    pitchers_ranked_worst_first: sortedPitchers,
  };
}

// Call the Anthropic Messages API to generate a vulgar, personalized roast.
async function generateRoastWithClaude(manager, round, perf) {
  if (!ANTHROPIC_API_KEY) {
    const worst = perf.batters_ranked_worst_first[0] || perf.pitchers_ranked_worst_first[0] || 'their entire roster';
    return `${manager} put up a heroic ${perf.total} points in ${round} and somehow managed to make ${worst} look like an all-star by comparison. Absolutely cooked. The league thanks you for your sacrifice.`;
  }

  const roundLabel =
    round === 'PP' ? 'Pool Play' : round === 'QF' ? 'Quarterfinals' : round === 'SF' ? 'Semifinals' : round;

  const prompt = `You are the trash-talking announcer for the Whit Merrifield Memorial Cup fantasy baseball league. A manager just got eliminated and deserves a brutal, hilariously vulgar roast. Be savage, specific, and profane. Reference their worst-performing players by name. Keep it to 2-3 sentences max.

Manager eliminated: ${manager}
Eliminated in: ${roundLabel}
Total score: ${perf.total} pts (Batting: ${perf.batting_total}, Pitching: ${perf.pitching_total})
Worst batters (lowest scores first): ${perf.batters_ranked_worst_first.slice(0, 3).join(', ') || 'none'}
Worst pitchers (lowest scores first): ${perf.pitchers_ranked_worst_first.slice(0, 3).join(', ') || 'none'}

Write the roast now. No preamble, no labels — just the roast.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    console.error('Anthropic API error:', resp.status, await resp.text());
    return `${manager} scored ${perf.total} pts in ${roundLabel} and got absolutely cooked. No further commentary is needed.`;
  }

  const data = await resp.json();
  return (
    (data.content && data.content[0] && data.content[0].text) ||
    `${manager} had a historically embarrassing run in ${roundLabel}.`
  );
}

// POST /api/seasons/:year/generate-roast — generate and store an elimination roast (commissioner only)
app.post('/api/seasons/:year/generate-roast', requireCommissioner, async (req, res) => {
  const { year } = req.params;
  if (!isValidYear(year)) return res.status(400).json({ error: 'Invalid year' });

  const { manager, round } = req.body || {};
  if (!manager || !round) return res.status(400).json({ error: 'manager and round are required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  try {
    const perf = buildManagerPerformanceForRoast(sd, manager, round);
    const roastText = await generateRoastWithClaude(manager, round, perf);

    if (!sd.roasts) sd.roasts = {};
    sd.roasts[manager] = { round, text: roastText, generated_at: new Date().toISOString() };

    addAuditEntry(db, 'roast_generated', { year, manager, round }, req.get('X-User-Email'));
    db.seasons[year] = sd;
    writeDB(db);

    res.json({ roast: roastText });
  } catch (err) {
    console.error('Roast generation error:', err);
    res.status(500).json({ error: 'Failed to generate roast' });
  }
});

// ============================================================
// Daily Scheduler
// ============================================================

let syncTimer = null;

function parseSyncTime(t) {
  const parts = (t || '05:00').split(':').map(Number);
  const h = Number.isFinite(parts[0]) && parts[0] >= 0 && parts[0] <= 23 ? parts[0] : 5;
  const m = Number.isFinite(parts[1]) && parts[1] >= 0 && parts[1] <= 59 ? parts[1] : 0;
  return [h, m];
}

function getNextSyncTime() {
  const db = readDB();
  const config = db.google_sheets_config || {};
  const [syncHour, syncMinute] = parseSyncTime(config.sync_time);
  const now = new Date();
  const next = new Date();
  next.setHours(syncHour, syncMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

// Returns the next occurrence of the given hour (0-23) in America/New_York
// as a UTC Date, accounting for DST. Shared by the scoreboard post and the
// MLB-API daily sync schedulers.
function getNextEasternHour(hour) {
  const TZ = 'America/New_York';
  function calcForRef(ref) {
    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ref);
    const [yr, mo, dy] = dateStr.split('-').map(Number);
    // Sample the offset at noon UTC; DST transitions happen at 2am Eastern.
    const noonUTC = new Date(Date.UTC(yr, mo - 1, dy, 12, 0, 0));
    const noonEasternHour = +new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hour: '2-digit',
      hour12: false,
    }).format(noonUTC);
    const offsetHours = noonEasternHour - 12; // -4 (EDT) or -5 (EST)
    return new Date(Date.UTC(yr, mo - 1, dy, hour - offsetHours, 0, 0));
  }
  const now = new Date();
  let next = calcForRef(now);
  if (next <= now) {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    next = calcForRef(tomorrow);
  }
  return next;
}

// Check if today falls within the season's sync window:
// day after PP1 starts (index 0) through day after Finals Week 2 ends (index 15)
function isWithinSyncWindow(sd) {
  if (!sd || !sd.schedule_dates || sd.schedule_dates.length < 16) return true; // no dates configured — always allow
  const dates = sd.schedule_dates;
  const pp1Start = dates[0] && dates[0].start;
  const finalsEnd = dates[15] && dates[15].end;
  if (!pp1Start || !finalsEnd) return true;

  const todayISO = new Date().toISOString().split('T')[0];

  // Sync window: day after PP1 starts → day after Finals ends
  const syncStart = new Date(pp1Start + 'T12:00:00');
  syncStart.setDate(syncStart.getDate() + 1);
  const syncStartISO = syncStart.toISOString().split('T')[0];

  const syncEnd = new Date(finalsEnd + 'T12:00:00');
  syncEnd.setDate(syncEnd.getDate() + 1);
  const syncEndISO = syncEnd.toISOString().split('T')[0];

  return todayISO >= syncStartISO && todayISO <= syncEndISO;
}

// ============================================================
// Sunday Auto-Advance Scheduler
// ============================================================

// Returns next occurrence of the given hour on a Sunday in America/New_York as UTC Date.
function getNextEasternSunday(hour) {
  const TZ = 'America/New_York';
  const now = new Date();
  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const candidate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const dayOfWeek = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(candidate);
    if (dayOfWeek !== 'Sunday') continue;
    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(candidate);
    const [yr, mo, dy] = dateStr.split('-').map(Number);
    const noonUTC = new Date(Date.UTC(yr, mo - 1, dy, 12, 0, 0));
    const noonEasternHour = +new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hour: '2-digit',
      hour12: false,
    }).format(noonUTC);
    const offsetHours = noonEasternHour - 12;
    const target = new Date(Date.UTC(yr, mo - 1, dy, hour - offsetHours, 0, 0));
    if (target > now) return target;
  }
  return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
}

// A period (round) boundary is a week whose round differs from the prior week's
// — e.g. PP1 Week 5 → PP2 Week 1, PP2 Week 5 → QF Week 1, QF → SF, SF → Finals.
// Auto-advance never crosses these: managers populate the new period via the
// roster-submission workflow, not carry-forward. Mid-period week changes
// (Week 1 → 2, 2 → 3, and the mid-round week change inside a playoff round)
// DO auto-advance.
function isPeriodBoundaryWeek(i) {
  return i > 0 && SEASON_SCHEDULE[i].round !== SEASON_SCHEDULE[i - 1].round;
}

// Determine which week index should be auto-advanced on Sunday at 6am.
// Prefers the week whose start date is tomorrow (the Monday that begins it).
// Falls back to the first un-advanced week that has prior-week roster data.
// Period-boundary weeks are skipped — those are handled by submissions.
function findAutoAdvanceWeekIndex(sd) {
  const TZ = 'America/New_York';
  const dates = sd.schedule_dates || [];
  const advanced = sd.advanced_weeks || [];

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomorrowET = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(tomorrow);

  for (let i = 1; i < SEASON_SCHEDULE.length && i < dates.length; i++) {
    if (isPeriodBoundaryWeek(i)) continue;
    const { start } = dates[i] || {};
    if (start === tomorrowET && !advanced.includes(i)) return i;
  }

  // Fallback: first un-advanced week where prior week has roster data
  const rosters = sd.rosters || {};
  for (let i = 1; i < SEASON_SCHEDULE.length; i++) {
    if (advanced.includes(i)) continue;
    if (isPeriodBoundaryWeek(i)) continue;
    const priorSched = SEASON_SCHEDULE[i - 1];
    const priorKey = `${priorSched.round}|${priorSched.week}`;
    const hasPriorData = Object.values(rosters).some((r) => r[priorKey] && (r[priorKey].batters || []).length > 0);
    if (hasPriorData) return i;
  }
  return -1;
}

// Server-side equivalent of the client's advancePlayers() function.
// Copies prior-week rosters to weekIndex for all active managers, creating
// zero-stat batting/pitching records. Marks both advanced_weeks and
// auto_advanced_weeks so the client can display the correct label.
// Returns the number of manager rosters advanced.
function serverAutoAdvancePlayers(sd, managers, weekIndex) {
  if (!sd || weekIndex < 1) return 0;
  if (!sd.advanced_weeks) sd.advanced_weeks = [];
  if (!sd.auto_advanced_weeks) sd.auto_advanced_weeks = [];
  if (sd.advanced_weeks.includes(weekIndex)) return 0;

  const priorSched = SEASON_SCHEDULE[weekIndex - 1];
  const currentSched = SEASON_SCHEDULE[weekIndex];
  const priorKey = `${priorSched.round}|${priorSched.week}`;
  const currentKey = `${currentSched.round}|${currentSched.week}`;

  if (!sd.rosters) sd.rosters = {};
  if (!sd.weekly_batting) sd.weekly_batting = [];
  if (!sd.weekly_pitching) sd.weekly_pitching = [];

  const swaps = sd.swaps || [];

  const existingBatTotals = {};
  (sd.weekly_batting || []).forEach((b) => {
    if (b.batter) existingBatTotals[b.batter] = (existingBatTotals[b.batter] || 0) + (b.weekly_score || 0);
  });

  const activeManagers = managers.filter((m) => m.active !== false);
  let advanced = 0;

  activeManagers.forEach((m) => {
    if (!sd.rosters[m.name]) sd.rosters[m.name] = {};
    const priorRoster = sd.rosters[m.name][priorKey];
    if (!priorRoster || sd.rosters[m.name][currentKey]) return;

    const droppedBatters = new Set();
    const droppedPitchers = new Set();
    swaps
      .filter((s) => s.manager === m.name && s.status === 'approved' && s.player_out)
      .forEach((s) => {
        if (s.week_key === priorKey || s.week_key === currentKey) {
          droppedBatters.add(s.player_out);
          droppedPitchers.add(s.player_out);
        }
      });

    const batters = (priorRoster.batters || []).filter((p) => !droppedBatters.has(p));
    const pitchers = (priorRoster.pitchers || []).filter((p) => !droppedPitchers.has(p));

    sd.rosters[m.name][currentKey] = { batters, pitchers };

    batters.forEach((batter) => {
      const exists = sd.weekly_batting.some(
        (b) =>
          b.round === currentSched.round && b.week === currentSched.week && b.batter === batter && b.manager === m.name
      );
      if (!exists) {
        sd.weekly_batting.push({
          round: currentSched.round,
          week: currentSched.week,
          manager: m.name,
          batter,
          abs: 0,
          '1b': 0,
          '2b': 0,
          '3b': 0,
          hr: 0,
          r: 0,
          rbi: 0,
          sb: 0,
          bb: 0,
          weekly_score: 0,
          total_score: existingBatTotals[batter] || 0,
        });
      }
    });

    pitchers.forEach((pitcher) => {
      const exists = sd.weekly_pitching.some(
        (p) =>
          p.round === currentSched.round &&
          p.week === currentSched.week &&
          p.pitcher === pitcher &&
          p.manager === m.name
      );
      if (!exists) {
        sd.weekly_pitching.push({
          round: currentSched.round,
          week: currentSched.week,
          manager: m.name,
          pitcher,
          gs: 0,
          w: 0,
          qs: 0,
          cg: 0,
          cgso: 0,
          nh: 0,
          ip: 0,
          h: 0,
          er: 0,
          bb: 0,
          k: 0,
          weekly_score: 0,
        });
      }
    });

    advanced++;
  });

  if (advanced > 0) {
    sd.advanced_weeks.push(weekIndex);
    sd.auto_advanced_weeks.push(weekIndex);
  }

  return advanced;
}

let weeklyAutoAdvanceTimer = null;

function scheduleWeeklyAutoAdvance() {
  if (weeklyAutoAdvanceTimer) clearTimeout(weeklyAutoAdvanceTimer);

  async function runAndReschedule() {
    try {
      const db = readDB();
      const config = db.google_sheets_config || {};
      const season = config.season || new Date().getFullYear().toString();
      const sd = (db.seasons || {})[season];

      if (!sd) {
        console.log(`[Auto-Advance] Skipping — no season data for ${season}`);
      } else {
        const managers = db.managers || [];
        const weekIndex = findAutoAdvanceWeekIndex(sd);

        if (weekIndex < 0) {
          console.log(`[Auto-Advance] No eligible week to advance for ${season}`);
        } else {
          const count = serverAutoAdvancePlayers(sd, managers, weekIndex);
          if (count > 0) {
            db.seasons[season] = sd;
            writeDB(db);
            const sched = SEASON_SCHEDULE[weekIndex];
            console.log(`[Auto-Advance] Advanced ${count} manager(s) to ${sched.round} ${sched.week} for ${season}`);
            postSlack(
              `*Auto-Advance* — ${count} manager roster(s) advanced to ${sched.round} ${sched.week} for ${season} season`
            ).catch(() => {});
          } else {
            console.log(`[Auto-Advance] Nothing to advance for ${season} (week index ${weekIndex})`);
          }
        }
      }
    } catch (e) {
      console.error('[Auto-Advance] Error:', e.message);
    }

    const next = getNextEasternSunday(6);
    weeklyAutoAdvanceTimer = setTimeout(runAndReschedule, next - Date.now());
    console.log(`[Auto-Advance] Next auto-advance scheduled for ${next.toISOString()} (Sunday 6am Eastern)`);
  }

  const next = getNextEasternSunday(6);
  const delay = next - Date.now();
  console.log(
    `[Auto-Advance] Scheduler started. Next run at ${next.toISOString()} (Sunday 6am Eastern, in ${Math.round(delay / 60000)} minutes)`
  );
  weeklyAutoAdvanceTimer = setTimeout(runAndReschedule, delay);
}

function scheduleGSheetsSync() {
  if (syncTimer) clearTimeout(syncTimer);

  const db = readDB();
  const config = db.google_sheets_config || {};

  if (!config.enabled || !config.spreadsheet_id || !config.api_key) {
    console.log('[GSheets] Auto-sync not configured or disabled');
    return;
  }

  const [syncHour, syncMinute] = parseSyncTime(config.sync_time);

  function runAndReschedule() {
    const now = new Date();
    console.log(`[GSheets] Running scheduled sync at ${now.toISOString()}`);

    const db2 = readDB();
    const cfg = db2.google_sheets_config || {};
    const season = cfg.season || now.getFullYear().toString();

    syncGoogleSheets(season)
      .then((result) => {
        console.log(
          `[GSheets] Sync complete: ${result.batting_imported} batting, ${result.pitching_imported} pitching records`
        );
        if (result.errors > 0) {
          postSlack(
            `*Google Sheets Sync — ${result.errors} error(s)*\n${result.errors} week(s) failed to import during the daily sync for season ${season}.`
          ).catch(() => {});
        }
      })
      .catch((e) => {
        console.error(`[GSheets] Sync error: ${e.message}`);
        postSlack(`*Google Sheets Sync Failed*\n${e.message}`).catch(() => {});
      });

    // Re-read sync_time in case it was changed since the timer was set
    const db3 = readDB();
    const [sh, sm] = parseSyncTime((db3.google_sheets_config || {}).sync_time);
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(sh, sm, 0, 0);
    const delay = next - Date.now();
    syncTimer = setTimeout(runAndReschedule, delay);
    console.log(`[GSheets] Next sync scheduled for ${next.toISOString()}`);
  }

  const now = new Date();
  const next = new Date();
  next.setHours(syncHour, syncMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;

  console.log(
    `[GSheets] Auto-sync enabled. Next sync at ${next.toISOString()} (in ${Math.round(delay / 60000)} minutes)`
  );
  syncTimer = setTimeout(runAndReschedule, delay);
}

// ============================================================
// Daily Scoreboard Post (7:00 AM)
// ============================================================

let scoreboardTimer = null;

function scheduleScoreboardPost() {
  if (scoreboardTimer) clearTimeout(scoreboardTimer);

  if (!SLACK_SCOREBOARD_WEBHOOK_URL) {
    console.log('[Scoreboard] No Slack scoreboard webhook configured — auto-post disabled');
    return;
  }

  function runAndReschedule() {
    const now = new Date();
    console.log(`[Scoreboard] Posting daily scoreboard at ${now.toISOString()}`);

    const db = readDB();
    const config = db.google_sheets_config || {};
    const season = config.season || now.getFullYear().toString();
    const sd = (db.seasons || {})[season];

    if (isWithinSyncWindow(sd)) {
      postScoreboardSlack(db, season)
        .then(() => console.log('[Scoreboard] Daily scoreboard posted successfully'))
        .catch((e) => console.error('[Scoreboard] Post failed:', e.message));
    } else {
      console.log(`[Scoreboard] Skipping — outside season date window for ${season}`);
    }

    const next = getNextEasternHour(7);
    scoreboardTimer = setTimeout(runAndReschedule, next - Date.now());
    console.log(`[Scoreboard] Next post scheduled for ${next.toISOString()} (7am Eastern)`);
  }

  const next = getNextEasternHour(7);
  const delay = next - Date.now();

  console.log(
    `[Scoreboard] Auto-post enabled. Next post at ${next.toISOString()} (7am Eastern, in ${Math.round(delay / 60000)} minutes)`
  );
  scoreboardTimer = setTimeout(runAndReschedule, delay);
}

// ============================================================
// MLB API Daily Sync (4:00 AM Eastern)
// ============================================================

let mlbApiSyncTimer = null;

// Pick the SEASON_SCHEDULE entry whose date range contains today; fall back to
// the most recently completed week so a late-night sync after the final day
// still rolls up that week's stats.
function detectCurrentScheduleWeek(sd) {
  if (!sd) return null;
  const dates = sd.schedule_dates || [];
  // Use Eastern time — MLB games are dated in ET; UTC date at 4am ET is the same
  // calendar day but we make this explicit to match fetchMLBPerGameStats behaviour.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (let i = 0; i < SEASON_SCHEDULE.length && i < dates.length; i++) {
    const { start, end } = dates[i] || {};
    if (start && end && today >= start && today <= end) {
      return { schedWeek: SEASON_SCHEDULE[i], dates: dates[i] };
    }
  }
  for (let i = SEASON_SCHEDULE.length - 1; i >= 0; i--) {
    const { start, end } = dates[i] || {};
    if (start && end && today > end) {
      return { schedWeek: SEASON_SCHEDULE[i], dates: dates[i] };
    }
  }
  return null;
}

// Find the schedule week that contains a specific date string (YYYY-MM-DD).
function detectScheduleWeekForDate(sd, dateISO) {
  if (!sd) return null;
  const dates = sd.schedule_dates || [];
  for (let i = 0; i < SEASON_SCHEDULE.length && i < dates.length; i++) {
    const { start, end } = dates[i] || {};
    if (start && end && dateISO >= start && dateISO <= end) {
      return { schedWeek: SEASON_SCHEDULE[i], dates: dates[i] };
    }
  }
  return null;
}

// Sync schedule:
//
//  Every day at 4am ET — daily delta:
//    Fetch only yesterday's games and add them to daily records, then rebuild
//    the containing week's summary from all stored daily data. Keeps the
//    Scoreboard and My Roster current without re-fetching the whole week.
//
//  Every Wednesday at 4am ET — full-week correction (in addition to the delta):
//    Fetch the complete current week + prior week from MLB and rebuild weekly
//    summaries. Catches MLB stat corrections that arrive days after games finish.
//    Pool-play weeks are only re-synced while still in pool play; a new playoff
//    round never goes back and re-syncs the previous round.
//
//  Commissioner Sync Now — same as Wednesday correction (current + prior week).

// Persist a small last-sync status marker on the active season so the Slack scoreboard
// can warn managers when the most recent automated compile failed/was blocked. Reads a
// FRESH db copy so a blocked run (whose in-memory sd holds rejected scores) records only
// the status, never the bad numbers. Self-derives the season from config.
function recordSyncStatus(status) {
  try {
    const sdb = readDB();
    const season = (sdb.google_sheets_config || {}).season || new Date().getFullYear().toString();
    if (!sdb.seasons || !sdb.seasons[season]) return;
    sdb.seasons[season].last_sync_status = status;
    writeDB(sdb);
  } catch (e) {
    console.error('[MLB-API] Failed to record sync status:', e.message);
  }
}

function scheduleMLBApiSync() {
  if (mlbApiSyncTimer) clearTimeout(mlbApiSyncTimer);

  async function runAndReschedule() {
    const now = new Date();
    try {
      const db = readDB();
      const config = db.google_sheets_config || {};
      const season = config.season || now.getFullYear().toString();
      const sd = (db.seasons || {})[season];

      if (!sd) {
        console.log(`[MLB-API] Skipping — no season data for ${season}`);
      } else {
        let dirty = false;
        let statsCompiled = false;
        let guardBefore = null;

        // Refresh player pool every day so call-ups / trades appear in autocomplete.
        try {
          const r = await bootstrapPlayerPools(sd, season, { refresh: true });
          if (r.battersAdded > 0 || r.pitchersAdded > 0) {
            console.log(`[MLB-API] Pool refresh: +${r.battersAdded} batters, +${r.pitchersAdded} pitchers`);
            dirty = true;
          }
        } catch (e) {
          console.error('[MLB-API] Pool refresh error (continuing):', e.message);
        }

        if (!isWithinSyncWindow(sd)) {
          console.log(`[MLB-API] Stats sync skipped — outside season window for ${season}`);
        } else {
          const todayET = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          const yesterdayET = new Date(now - 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
            timeZone: 'America/New_York',
          });
          const dayOfWeek = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });

          // Snapshot Overall totals BEFORE the compile so the score guard can
          // detect a downward swing introduced by this sync (Wednesday's
          // full-week correction included — a real MLB stat fix that drops a
          // manager 40+ pts will block and can be re-run with Force).
          guardBefore = captureScoreSnapshot(sd, todayET).totals;

          // Wednesday: full-week correction for current + prior week (same phase).
          if (dayOfWeek === 'Wednesday') {
            const weekPairs = resolveWeeksForCatchUp(sd, todayET);
            for (const { schedWeek, dates, label } of weekPairs) {
              const r = await performMLBSync(sd, schedWeek, dates, {
                trigger: 'auto',
                note: `wed-correction:${label}`,
              });
              addAuditEntry(db, 'mlbapi_auto_sync', {
                year: season,
                round: schedWeek.round,
                week: schedWeek.week,
                batting_imported: r.batting_imported,
                pitching_imported: r.pitching_imported,
                note: `wed-correction:${label}`,
              });
              console.log(
                `[MLB-API] Wed correction (${label}): ${season} ${schedWeek.round} ${schedWeek.week} — ` +
                  `${r.batting_imported} bat / ${r.pitching_imported} pit (${r.games_fetched} games)`
              );
            }
            dirty = true;
            statsCompiled = true;
          }

          // Daily delta: fetch yesterday's games and add to existing weekly data.
          const dailyResult = await performMLBDailySync(sd, yesterdayET);
          if (dailyResult) {
            addAuditEntry(db, 'mlbapi_auto_sync', {
              year: season,
              round: dailyResult.round,
              week: dailyResult.week,
              batting_imported: dailyResult.batting_imported,
              pitching_imported: dailyResult.pitching_imported,
              note: `daily-delta:${yesterdayET}`,
            });
            console.log(
              `[MLB-API] Daily delta (${yesterdayET}): ${season} ${dailyResult.round} ${dailyResult.week} — ` +
                `${dailyResult.batting_imported} bat / ${dailyResult.pitching_imported} pit (${dailyResult.games_fetched} games)`
            );
            dirty = true;
            statsCompiled = true;
          } else {
            console.log(`[MLB-API] Daily delta skipped — ${yesterdayET} outside season schedule`);
          }
        }

        // Score guard: if this compile produced a wild downward swing, do NOT
        // persist it — keep the prior (correct) db.json and alert the
        // commissioner to investigate. The unattended 4am run can't ask a human,
        // so a block here is the safe default; the 7am scoreboard then posts the
        // last-good numbers and the commissioner re-runs Sync Now after fixing.
        if (statsCompiled && guardBefore) {
          const guard = evaluateScoreGuard(guardBefore, sd, {
            dateISO: now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
            trigger: 'auto-4am',
            year: season,
          });
          const nowISO = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          if (guard.blocked) {
            const lines = guard.report.blockers.map((s) => `${s.manager} ${s.delta}`).join(', ');
            console.error(`[MLB-API] Score guard BLOCKED write — not persisting. Drops: ${lines}`);
            // Don't writeDB the rejected scores — but record a status marker (fresh db
            // copy) so the 7am scoreboard can warn managers. The Slack alert (sent by
            // evaluateScoreGuard) remains the commissioner-facing record.
            recordSyncStatus({
              ok: false,
              reason: 'guard_blocked',
              date: nowISO,
              at: new Date().toISOString(),
              detail: lines,
            });
            dirty = false; // skip the write below — keep last-good scores
          } else {
            recordScoreSnapshot(sd, guard.snapshot);
            sd.last_sync_status = { ok: true, date: nowISO, at: new Date().toISOString() };
          }
        }

        if (dirty) {
          db.seasons[season] = sd;
          // Await the Upstash backup: the 4am sync runs unattended and the instance may be
          // reclaimed right after, so a fire-and-forget backup could be lost before it lands.
          const backup = await writeDB(db, { awaitBackup: true });
          if (backup && backup.ok === false && !backup.skipped) {
            console.error(`[MLB-API] Upstash backup did NOT persist (${backup.bytes} bytes, status ${backup.status})`);
            postSlack(`*MLB sync: Upstash backup failed* (${backup.bytes} bytes, status ${backup.status})`).catch(
              () => {}
            );
          }
        }
      }
    } catch (e) {
      console.error('[MLB-API] Daily sync error:', e.message);
      postSlack(`*MLB API daily sync failed*\n${e.message}`).catch(() => {});
      recordSyncStatus({
        ok: false,
        reason: 'error',
        date: now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
        at: new Date().toISOString(),
        detail: e.message,
      });
    }

    const next = getNextEasternHour(4);
    mlbApiSyncTimer = setTimeout(runAndReschedule, next - Date.now());
    console.log(`[MLB-API] Next sync scheduled for ${next.toISOString()} (4am Eastern)`);
  }

  const next = getNextEasternHour(4);
  const delay = next - Date.now();
  console.log(
    `[MLB-API] Auto-sync enabled. Next sync at ${next.toISOString()} (4am Eastern, in ${Math.round(delay / 60000)} minutes)`
  );
  mlbApiSyncTimer = setTimeout(runAndReschedule, delay);
}

// ============================================================
// Online Users Tracking
// ============================================================
const onlineUsers = {};

app.post('/api/heartbeat', (req, res) => {
  const { email, name } = req.body;
  if (email && name) {
    onlineUsers[sanitizeString(email)] = { name: sanitizeString(name), timestamp: Date.now() };
  }
  res.json({ ok: true });
});

app.get('/api/online-users', (req, res) => {
  // Clean up stale entries (older than 5 minutes)
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  for (const [email, data] of Object.entries(onlineUsers)) {
    if (now - data.timestamp > FIVE_MIN) delete onlineUsers[email];
  }
  res.json(onlineUsers);
});

// ============================================================
// Global error handler
// ============================================================

app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// Start
// ============================================================

async function main() {
  // Ensure the directory that holds db.json exists (needed when DB_PATH points to a
  // Render persistent disk mount like /var/data that may not have been created yet).
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

  // Restore db.json from Upstash before the server accepts any requests.
  // Active when UPSTASH_* env vars are set; no-op otherwise.
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      console.log('[Upstash] Checking backup...');
      const saved = await loadFromUpstash();

      // Read whatever is already on the (persistent) disk so we can compare
      // freshness instead of blindly overwriting it.
      let local = null;
      try {
        if (fs.existsSync(DB_FILE)) local = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      } catch (e) {
        console.error('[Upstash] Could not read local db.json:', e.message);
      }
      const hasSeasons = (d) => d && d.seasons && Object.keys(d.seasons).length > 0;
      const savedAt = (d) => (d && typeof d.last_saved_at === 'string' ? d.last_saved_at : '');

      if (saved && (!hasSeasons(local) || savedAt(saved) > savedAt(local))) {
        // Upstash is the better copy: the local disk is missing/empty, or the
        // backup is strictly newer. Safe to restore.
        fs.writeFileSync(DB_FILE, JSON.stringify(saved, null, 2), 'utf8');
        console.log('[Upstash] db restored from backup (local missing or older)');
      } else if (hasSeasons(local)) {
        // The local disk copy is current (Render's persistent disk survived the
        // restart). Keep it and refresh the backup, so a stale Upstash snapshot
        // can never clobber good data on a later deploy.
        console.log('[Upstash] Local db is current; keeping it and refreshing the backup');
        await saveToUpstash(local);
      } else {
        console.log('[Upstash] No usable backup or local db — starting fresh');
      }
    } catch (e) {
      console.error('[Upstash] Restore error (continuing with local db.json):', e.message);
    }
  }

  // Snapshot the as-restored DB to a dated, auto-expiring backup key before this boot's
  // migrations run, so we always keep a pre-deploy restore point (the live key keeps none).
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const r = await saveTimestampedBackup(readDB());
      if (r.ok) console.log(`[Upstash] Dated backup written: ${r.key}`);
    } catch (e) {
      console.error('[Upstash] Dated backup error (continuing):', e.message);
    }
  }

  app.listen(PORT, async () => {
    console.log(`WMMC server running at http://localhost:${PORT}`);
    if (!fs.existsSync(DB_FILE)) {
      writeDB({ seasons: {}, managers: [], audit_log: [] });
      console.log('Created empty db.json');
    }

    // Auto-seed managers from data.json if db.json has none
    const db = readDB();
    if (!db.managers || db.managers.length === 0) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
        const emailMap = data.email_map || {};
        if (Object.keys(emailMap).length > 0) {
          db.managers = Object.entries(emailMap).map(([email, name]) => ({
            name,
            email,
            commissioner: email === 'daniel.kortan@gmail.com',
            active: true,
          }));
          writeDB(db);
          console.log(`Seeded ${db.managers.length} managers from data.json`);
        }
      } catch (e) {
        console.error('Could not seed managers from data.json:', e.message);
      }
    }

    // One-shot backfill: default each manager's googleEmail to their league
    // email so Google sign-in works out of the box. Commissioners can change
    // any of these in the admin panel. Idempotent — only writes when it fills
    // in a missing value.
    try {
      const dbGE = readDB();
      let changed = false;
      (dbGE.managers || []).forEach((m) => {
        if (m.email && m.googleEmail === undefined) {
          m.googleEmail = m.email.toLowerCase();
          changed = true;
        }
      });
      if (changed) {
        writeDB(dbGE);
        writeManagersSeed(dbGE.managers);
        console.log('Backfilled googleEmail for managers missing it');
      }
    } catch (e) {
      console.error('Could not backfill manager googleEmail:', e.message);
    }

    // One-shot: cut over to the MLB Stats API as the sole stats source.
    // Strips gsheets-sourced rows, flips gsheets auto-sync off, and
    // backfills every past schedule week via MLB. Gated by a db flag so it
    // only runs once unless a previous attempt failed partway through.
    try {
      const dbForTakeover = readDB();
      const ran = await applyMLBApiTakeover(dbForTakeover);
      if (ran) writeDB(dbForTakeover);
    } catch (e) {
      console.error('[MLB-API takeover] Error (continuing):', e.message);
    }

    // Seed the player pool from MLB's active-player catalog on every boot.
    // bootstrapPlayerPools only adds names, so re-running is safe and keeps
    // call-ups visible in the My Roster autocomplete without waiting for the
    // next daily refresh.
    try {
      const dbForPool = readDB();
      const cfg = dbForPool.google_sheets_config || {};
      const season = cfg.season || new Date().getFullYear().toString();
      const sd = (dbForPool.seasons || {})[season];
      if (sd) {
        const r = await bootstrapPlayerPools(sd, season);
        console.log(
          `[Player Pool] Seeded from ${r.catalogSize} active MLB players ` +
            `(+${r.battersAdded} batters, +${r.pitchersAdded} pitchers).`
        );
        dbForPool.seasons[season] = sd;
        writeDB(dbForPool);
      }
    } catch (e) {
      console.error('[Player Pool] Bootstrap error (continuing):', e.message);
    }

    // Re-derive QS on existing pitching records using the WMMC rule.
    try {
      const dbForBackfill = readDB();
      backfillWmmcQS(dbForBackfill);
      writeDB(dbForBackfill);
    } catch (e) {
      console.error('[WMMC-QS] Backfill error (continuing):', e.message);
    }

    // One-shot: purge stale stat records for players carried forward into a week after being
    // dropped in an earlier week (e.g. a one-day add/drop). Gated by a db flag so it runs once.
    try {
      const dbForPurge = readDB();
      const ran = purgeCarriedForwardDropRecords(dbForPurge);
      if (ran) writeDB(dbForPurge);
    } catch (e) {
      console.error('[Carry-forward purge] Error (continuing):', e.message);
    }

    // One-shot: undo any period-boundary auto-advance (e.g. PP2 Week 1 carried
    // forward before boundaries were excluded). Gated by a db flag so it runs once.
    try {
      const dbForBoundaryPurge = readDB();
      const ran = purgeBoundaryAutoAdvance(dbForBoundaryPurge);
      if (ran) writeDB(dbForBoundaryPurge);
    } catch (e) {
      console.error('[Boundary purge] Error (continuing):', e.message);
    }

    // One-shot: purge the Iván Herrera ghost records from Joey Auclair (never rostered;
    // caused the recurring score-guard block). Gated by a db flag so it runs once.
    try {
      const dbForGhostPurge = readDB();
      const ran = purgeGhostHerreraFromJoey(dbForGhostPurge);
      if (ran) writeDB(dbForGhostPurge);
    } catch (e) {
      console.error('[Ghost purge] Error (continuing):', e.message);
    }

    // Fill / recompute per-week roster entries carrying forward approved swaps.
    try {
      const dbForRosterRepair = readDB();
      const ran = repairCarryForwardRosters(dbForRosterRepair);
      if (ran) writeDB(dbForRosterRepair);
    } catch (e) {
      console.error('[Roster Repair] Error (continuing):', e.message);
    }

    // Heal per-week roster arrays from roster_dates so the per-player breakdowns reconcile with
    // the carry-forward totals (a mid-period swap-in not carried into later weeks' arrays would
    // otherwise under-count in those views). Additive + idempotent + score-neutral — runs after
    // the carry-forward repair so it operates on the settled week keys.
    try {
      const dbForArrayHeal = readDB();
      let healed = false;
      for (const sd of Object.values(dbForArrayHeal.seasons || {})) {
        if (!sd || sd.status !== 'active') continue;
        const changes = rebuildRosterArraysFromDates(sd);
        if (changes && changes.length) healed = true;
      }
      if (healed) writeDB(dbForArrayHeal);
    } catch (e) {
      console.error('[Roster array heal] Error (continuing):', e.message);
    }

    // One-time: seed a score-guard baseline snapshot for any active season whose trail is empty,
    // so the guard has a reference to diff against and the audit below doesn't flag an empty trail.
    // Runs after this boot's recompute/heals, so the baseline reflects corrected totals. Idempotent
    // — skips once a trail exists.
    try {
      const dbForSeed = readDB();
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      let seeded = false;
      for (const sd of Object.values(dbForSeed.seasons || {})) {
        if (!sd || sd.status !== 'active') continue;
        if (Array.isArray(sd.score_snapshots) && sd.score_snapshots.length > 0) continue;
        recordScoreSnapshot(sd, captureScoreSnapshot(sd, todayET));
        seeded = true;
      }
      if (seeded) {
        writeDB(dbForSeed);
        console.log('[Score guard] Seeded baseline snapshot for active season(s) with an empty trail.');
      }
    } catch (e) {
      console.error('[Score guard] Snapshot seed error (continuing):', e.message);
    }

    // Surface silent data corruption (e.g. a wiped schedule_dates) loudly at startup.
    try {
      await auditSeasonIntegrity(readDB());
    } catch (e) {
      console.error('[Integrity] audit error (continuing):', e.message);
    }

    // Start the Google Sheets sync scheduler (no-op while config.enabled=false,
    // but stays available so the commissioner can re-enable as a fallback).
    scheduleGSheetsSync();
    // Start the MLB Stats API daily sync (4am Eastern) — the new source of truth.
    scheduleMLBApiSync();
    // Start the daily scoreboard post scheduler (7am)
    scheduleScoreboardPost();
    // Auto-advance active rosters to the next week every Sunday at 6am Eastern,
    // for mid-period week changes only. Period (round) boundaries — PP1→PP2,
    // PP2→QF, QF→SF, SF→Finals — are skipped; those use roster submissions.
    scheduleWeeklyAutoAdvance();
  });
}

main().catch(console.error);
