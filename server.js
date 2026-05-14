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

// Upstash Redis REST — durable backup for db.json across Render ephemeral deploys.
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Render env vars.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UPSTASH_KEY = 'wmmc_db';

// General notifications webhook (roster swaps, sync errors, etc.)
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
// Scoreboard-specific webhook — can point to a different channel than notifications.
// Falls back to SLACK_WEBHOOK_URL if not set.
const SLACK_SCOREBOARD_WEBHOOK_URL = process.env.SLACK_SCOREBOARD_WEBHOOK_URL || SLACK_WEBHOOK_URL;
// Signing secret from your Slack app — used to verify slash command requests.
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';

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

// Parse JSON bodies up to 50MB (season data can be large)
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
  const expected = manager.password || LOGIN_PASSWORD;
  if (password !== expected) return null;
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
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    const resp = await fetch(`${UPSTASH_URL}/set/${UPSTASH_KEY}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(JSON.stringify(data)),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error('[Upstash] Save error:', resp.status, text.slice(0, 200));
    }
  } catch (e) {
    console.error('[Upstash] Save failed:', e.message);
  }
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

function writeManagersSeed(managers) {
  try {
    // Strip passwords — they belong in db.json only, not in the git-committed seed file.
    const seedRecords = managers.map(({ password: _password, ...rest }) => rest);
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

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  // Async backup to Upstash so data survives Render's ephemeral filesystem
  saveToUpstash(data).catch((e) => console.error('[Upstash] Background save failed:', e.message));
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
  // Propagate roster add dates into player_dates for mid-week adds, then zero out
  // any pre-add scores for newly rostered players.  We do NOT call recomputeAllWeeklyScores
  // here because it would zero out dropped players' correctly banked scores when their
  // stats live in a daily record dated after weekDates.end (see recomputeMidWeekAddScores).
  if ((sd.daily_batting && sd.daily_batting.length) || (sd.daily_pitching && sd.daily_pitching.length)) {
    syncPlayerDatesFromRosterDates(sd);
    recomputeMidWeekAddScores(sd);
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
  // Strip passwords from response, but indicate if a custom password is set
  const managers = (db.managers || []).map((m) => {
    const { password, ...safe } = m;
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
  // Preserve existing passwords — the client never receives them (stripped in GET),
  // so we must carry them forward from the current db record.
  const existingPasswords = {};
  (db.managers || []).forEach((m) => {
    if (m.email && m.password) existingPasswords[m.email.toLowerCase()] = m.password;
  });
  db.managers = req.body.map((m) => {
    const emailKey = (m.email || '').toLowerCase();
    if (!m.password && existingPasswords[emailKey]) {
      return { ...m, password: existingPasswords[emailKey] };
    }
    return m;
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

// Find the SEASON_SCHEDULE index for a given round+week
function getScheduleWeekIndex(round, week) {
  return SEASON_SCHEDULE.findIndex((s) => s.round === round && s.week === week);
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

  const effectiveStart = 'start' in override ? override.start : (weekDates && weekDates.start) || null;
  // Shift end by +1 day: the daily sync runs in the morning and creates a record dated
  // today containing yesterday's games. The last day of the scoring week therefore
  // appears in a record dated end+1, so we must include it.
  const rawEnd = 'end' in override ? override.end : (weekDates && weekDates.end) || null;
  const effectiveEnd = rawEnd ? addOneDay(rawEnd) : null;

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

  const effectiveStart = 'start' in override ? override.start : (weekDates && weekDates.start) || null;
  const rawEnd = 'end' in override ? override.end : (weekDates && weekDates.end) || null;
  const effectiveEnd = rawEnd ? addOneDay(rawEnd) : null;

  const eligible = records.filter((r) => {
    if (effectiveStart && r.date < effectiveStart) return false;
    if (effectiveEnd && r.date > effectiveEnd) return false;
    return true;
  });

  return Math.round(eligible.reduce((sum, r) => sum + calculatePitchingScore(r.delta || {}), 0) * 100) / 100;
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

// Sum batting + pitching weekly_scores for the given rounds
function computeRoundScores(batting, pitching, rounds) {
  const roundSet = new Set(rounds);
  const map = {};
  batting
    .filter((b) => roundSet.has(b.round))
    .forEach((b) => {
      if (!b.manager) return;
      if (!map[b.manager]) map[b.manager] = { batting: 0, pitching: 0 };
      map[b.manager].batting += b.weekly_score || 0;
    });
  pitching
    .filter((p) => roundSet.has(p.round))
    .forEach((p) => {
      if (!p.manager) return;
      if (!map[p.manager]) map[p.manager] = { batting: 0, pitching: 0 };
      map[p.manager].pitching += p.weekly_score || 0;
    });
  return Object.entries(map).map(([manager, s]) => ({
    manager,
    batting: Math.round(s.batting * 100) / 100,
    pitching: Math.round(s.pitching * 100) / 100,
    total: Math.round((s.batting + s.pitching) * 100) / 100,
  }));
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

  const batting = seasonData.weekly_batting || [];
  const pitching = seasonData.weekly_pitching || [];

  // ---- PP1 / PP2 pool winners (mirrors app hlClass logic) ----
  const poolGroups = {};
  Object.entries(managerPoolMap).forEach(([mgr, poolNum]) => {
    if (!poolGroups[poolNum]) poolGroups[poolNum] = [];
    poolGroups[poolNum].push(mgr);
  });

  const pp1Scores = computeRoundScores(batting, pitching, ['PP1']);
  const pp2Scores = computeRoundScores(batting, pitching, ['PP2']);

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
  const ppOverall = computeRoundScores(batting, pitching, ['PP1', 'PP2']).sort((a, b) => b.total - a.total);
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
  const overallMap = {};
  batting.forEach((b) => {
    if (!b.manager) return;
    if (!overallMap[b.manager]) overallMap[b.manager] = { manager: b.manager, batting: 0, pitching: 0 };
    overallMap[b.manager].batting += b.weekly_score || 0;
  });
  pitching.forEach((p) => {
    if (!p.manager) return;
    if (!overallMap[p.manager]) overallMap[p.manager] = { manager: p.manager, batting: 0, pitching: 0 };
    overallMap[p.manager].pitching += p.weekly_score || 0;
  });
  const overall = Object.values(overallMap)
    .map((m) => ({
      ...m,
      batting: Math.round(m.batting * 100) / 100,
      pitching: Math.round(m.pitching * 100) / 100,
      total: Math.round((m.batting + m.pitching) * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total);

  const overallLastMgr = overall.length > 0 ? overall[overall.length - 1].manager : null;

  // ---- Current-round pool standings ----
  const poolRoundMap = {};
  if (currentRound) {
    batting
      .filter((b) => b.round === currentRound)
      .forEach((b) => {
        if (!b.manager) return;
        if (!poolRoundMap[b.manager])
          {poolRoundMap[b.manager] = { manager: b.manager, batting: 0, pitching: 0, pool: managerPoolMap[b.manager] };}
        poolRoundMap[b.manager].batting += b.weekly_score || 0;
      });
    pitching
      .filter((p) => p.round === currentRound)
      .forEach((p) => {
        if (!p.manager) return;
        if (!poolRoundMap[p.manager])
          {poolRoundMap[p.manager] = { manager: p.manager, batting: 0, pitching: 0, pool: managerPoolMap[p.manager] };}
        poolRoundMap[p.manager].pitching += p.weekly_score || 0;
      });
  }
  const poolStandings = Object.values(poolRoundMap)
    .map((m) => ({
      ...m,
      batting: Math.round(m.batting * 100) / 100,
      pitching: Math.round(m.pitching * 100) / 100,
      total: Math.round((m.batting + m.pitching) * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total);

  // Group by pool — already sorted desc so last entry = pool's last place
  const pools = {};
  poolStandings.forEach((m) => {
    const key = m.pool ? `Pool ${m.pool}` : 'Unassigned';
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
          return `${rank(i)} ${dotStr}${nameStr}${trash} — ${fmt(m.total)}${heart(m.total)} pts _(B: ${fmtInt(m.batting)} | P: ${fmt(m.pitching)})_`;
        })
        .join('\n')
    : '_No scores recorded yet._';

  // ---- Build pool fields (side-by-side via Slack fields, 2-column grid) ----
  const sortedPoolEntries = Object.entries(pools).sort((a, b) => a[0].localeCompare(b[0]));
  const poolFields = sortedPoolEntries.map(([poolName, members]) => {
    const poolLastMgr = members.length > 0 ? members[members.length - 1].manager : null;
    const lines = members
      .map((m, i) => {
        const d = dot(m.manager, currentRound);
        const dotStr = d ? `${d} ` : '';
        const nameStr = i === 0 ? `*${m.manager}*` : m.manager;
        const trash = m.manager === poolLastMgr ? ` ${dumpster}` : '';
        return `${rankPool(i)} ${dotStr}${nameStr}${trash} — ${fmt(m.total)}${heart(m.total)} pts`;
      })
      .join('\n');
    return { type: 'mrkdwn', text: `*${poolName}*\n${lines}` };
  });

  // ---- Assemble blocks ----
  const blocks = [];

  blocks.push({ type: 'header', text: { type: 'plain_text', text: `⚾ WMMC Scoreboard — ${year}`, emoji: true } });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\u{1F4C5} Current Period: *${currentRoundLabel}*` } });

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

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*\u{1F3C6} Overall Standings*\n${overallText}` } });

  if (currentRound && poolFields.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*\u{1F4CA} ${currentRoundLabel} Pool Standings*` } });
    blocks.push({ type: 'section', fields: poolFields });
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
      if (resp.status === 429)
        {throw new Error('Google Sheets API rate limit exceeded. Please wait ~60 seconds before syncing again.');}
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
// Add one calendar day to a YYYY-MM-DD string.
function addOneDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

// Populate player_dates from roster_dates for genuine mid-week ADDS only.
//
// Key design decisions:
//   - Only adds a START cutoff, never an END cutoff.  Dropped players' accumulated
//     scores are locked by drop_locked on the weekly record; we must not re-filter
//     their already-banked stats by date.
//   - Only applies when add_date is strictly AFTER the week's start date (initial
//     roster players should score the full week).
//   - Shifts start by +1 day because the daily sync captures cumulative stats
//     through (sync_date - 1): a record dated "May 10" contains May 9's games.
//     To count only games on/after add_date, we need records dated > add_date,
//     i.e. effective_start = add_date + 1.
//   - Entries created here are marked { auto: true } so they can be refreshed on
//     subsequent saves without clobbering manual commissioner overrides.
function syncPlayerDatesFromRosterDates(sd) {
  if (!sd || !sd.roster_dates) return;
  if (!sd.player_dates) sd.player_dates = {};

  // Wipe previously auto-generated entries so stale data (e.g. incorrect end dates
  // from an earlier version) is cleaned up on every run.
  for (const weekKey of Object.keys(sd.player_dates)) {
    for (const type of ['batter', 'pitcher']) {
      const typeMap = (sd.player_dates[weekKey] || {})[type];
      if (!typeMap) continue;
      for (const [player, entry] of Object.entries(typeMap)) {
        if (entry && entry.auto) delete typeMap[player];
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
        if (!dates.add_date) continue;
        // Skip players rostered from the very start of the week — no cutoff needed.
        if (weekStart && dates.add_date <= weekStart) continue;

        // Shift by +1: the sync on add_date records cumulative through (add_date-1).
        // To capture add_date's own games, include records with date > add_date.
        const effectiveStart = addOneDay(dates.add_date);

        for (const type of ['batter', 'pitcher']) {
          if (!sd.player_dates[weekKey]) sd.player_dates[weekKey] = {};
          if (!sd.player_dates[weekKey][type]) sd.player_dates[weekKey][type] = {};
          const existing = sd.player_dates[weekKey][type][player];
          if (existing && !existing.auto) continue; // preserve manual commissioner override
          sd.player_dates[weekKey][type][player] = { start: effectiveStart, auto: true };
        }
      }
    }
  }
}

// Recompute weekly scores ONLY for mid-week additions (player_dates entries with auto:true).
// Dropped players' banked scores are intentionally left alone — calling recomputeAllWeeklyScores
// on a save would zero them out when their stats live in a sync record dated after weekDates.end
// (the morning sync captures the previous day's games, so a player who pitches on the last day
// of a scoring week has their stats in a record dated end+1, which the end-date filter excludes).
function recomputeMidWeekAddScores(sd) {
  const playerDates = sd.player_dates || {};
  for (const [weekKey, weekTypes] of Object.entries(playerDates)) {
    const parts = weekKey.split('|');
    const round = parts[0];
    const week = parts.slice(1).join('|');
    for (const [batter, entry] of Object.entries(weekTypes.batter || {})) {
      if (!entry || !entry.auto) continue;
      (sd.weekly_batting || []).forEach((b) => {
        if (b.batter !== batter || b.round !== round || b.week !== week) return;
        if (b.drop_locked || (b.manual_fields && b.manual_fields.length > 0)) return;
        const score = computeEffectiveBattingScore(sd, batter, round, week);
        b.weekly_score = score !== null ? score : 0;
        b.total_score = b.weekly_score;
      });
    }
    for (const [pitcher, entry] of Object.entries(weekTypes.pitcher || {})) {
      if (!entry || !entry.auto) continue;
      (sd.weekly_pitching || []).forEach((p) => {
        if (p.pitcher !== pitcher || p.round !== round || p.week !== week) return;
        if (p.drop_locked || (p.manual_fields && p.manual_fields.length > 0)) return;
        const score = computeEffectivePitchingScore(sd, pitcher, round, week);
        p.weekly_score = score !== null ? score : 0;
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

  const commAdded = new Set(
    (sd.swaps || [])
      .filter((s) => s.status === 'approved' && s.player_in && s.week_key === weekKey)
      .map((s) => s.player_in)
  );

  for (const [manager, sub] of Object.entries(sd.initial_submissions)) {
    const hasPlayers = (sub.batters || []).length > 0 || (sub.pitchers || []).length > 0;
    if (!hasPlayers) continue;
    const mgrRoster = sd.rosters[manager];
    if (!mgrRoster || !mgrRoster[weekKey]) continue;

    const submittedBatters = new Set(sub.batters || []);
    const submittedPitchers = new Set(sub.pitchers || []);

    const weekRosterDates = (sd.roster_dates && sd.roster_dates[manager] && sd.roster_dates[manager][weekKey]) || {};
    const allBattersPool = new Set(sd.batters_pool || []);
    const allPitchersPool = new Set(sd.pitchers_pool || []);

    const candidateBatters = new Set([
      ...(mgrRoster[weekKey].batters || []),
      ...Object.keys(weekRosterDates).filter((p) => allBattersPool.size === 0 || allBattersPool.has(p)),
    ]);
    const candidatePitchers = new Set([
      ...(mgrRoster[weekKey].pitchers || []),
      ...Object.keys(weekRosterDates).filter((p) => allPitchersPool.size > 0 && allPitchersPool.has(p)),
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
    sd.weekly_batting = sd.weekly_batting.filter(
      (b) =>
        !(
          b.round === scheduleWeek.round &&
          b.week === scheduleWeek.week &&
          b.batter === batter &&
          b.source === 'gsheets'
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

    // Delta = today's cumulative minus the most-recent previous snapshot
    const prevSnapshot = sd.daily_pitching
      .filter(
        (r) =>
          r.pitcher === pitcher && r.round === scheduleWeek.round && r.week === scheduleWeek.week && r.date < syncDate
      )
      .sort((a, b) => b.date.localeCompare(a.date))[0];

    const delta = prevSnapshot ? pitchingDelta(cumulative, prevSnapshot.cumulative) : { ...cumulative };

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
          p.source === 'gsheets'
        )
    );

    sd.weekly_pitching.push({
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      manager: manager || null,
      pitcher,
      status: findCol(row, ['status', 'Status']) || null,
      ...cumulative,
      qs_highlight: cumulative.gs >= 2,
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

  // Capture today's date once so all rows in this sync share the same snapshot date
  const syncDate = new Date().toISOString().split('T')[0];

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
function parseBoxscore(box) {
  const batting = {};
  const pitching = {};
  const teamMap = {};

  for (const side of ['away', 'home']) {
    const teamData = box.teams?.[side];
    if (!teamData) continue;
    const abbrev = teamData.team?.abbreviation || '';
    const teamTotalOuts = teamData.teamStats?.pitching?.outs ?? null;

    for (const player of Object.values(teamData.players || {})) {
      const name = player.person?.fullName;
      if (!name) continue;

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
        const isCG = started > 0 && teamTotalOuts !== null && pitcherOuts !== null && pitcherOuts === teamTotalOuts ? 1 : 0;
        pitching[name] = {
          gs: started,
          w: ps.wins || 0,
          // QS: started, >= 6 IP, <= 3 ER
          qs: started > 0 && ipDec >= 6 && er <= 3 ? 1 : 0,
          // CG/CGSO/NH derived from outs and hit/ER counts
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
// Returns [{ gameId, date, batting, pitching, teamMap }]
async function fetchMLBPerGameStats(startDate, endDate) {
  const games = await fetchMLBGames(startDate, endDate);
  const results = [];
  for (const { gameId, date } of games) {
    let box;
    try {
      box = await mlbApiFetch(`/api/v1/game/${gameId}/boxscore`);
    } catch {
      continue;
    }
    const { batting, pitching, teamMap } = parseBoxscore(box);
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
      if (!pitching[name]) pitching[name] = { gs: 0, w: 0, qs: 0, cg: 0, cgso: 0, nh: 0, ip: 0, h: 0, er: 0, bb: 0, k: 0 };
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
    return { name, manager: manager || null, team: teamMap[name] || null, ...stats, weekly_score: calculateBattingScore(stats) };
  });
}

// Attach manager + weekly score to aggregated pitching stats.
function enrichPitching(pitchingMap, teamMap, sd, schedWeek) {
  return Object.entries(pitchingMap).map(([name, stats]) => {
    const manager =
      findManagerForPlayerWeek(sd, name, 'pitching', schedWeek.round, schedWeek.week) ||
      findManagerForPlayer(sd, name, 'pitching');
    return { name, manager: manager || null, team: teamMap[name] || null, ...stats, weekly_score: calculatePitchingScore(stats) };
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
    const gameRecords = await fetchMLBPerGameStats(dates.start, dates.end);
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
    const gameRecords = await fetchMLBPerGameStats(dates.start, dates.end);

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
        return { name, ...data, games: data.games.sort((a, b) => a.date.localeCompare(b.date)), weekly_score: Math.round(weekly_score * 100) / 100 };
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
    const gameRecords = await fetchMLBPerGameStats(dates.start, dates.end);
    const { batting, pitching, teamMap } = aggregatePerGame(gameRecords);

    const mlbBat = enrichBatting(batting, teamMap, sd, schedWeek);
    const mlbPit = enrichPitching(pitching, teamMap, sd, schedWeek);
    const storedBat = (sd.weekly_batting || []).filter((b) => b.round === round && b.week === week);
    const storedPit = (sd.weekly_pitching || []).filter((p) => p.round === round && p.week === week);

    const allBatters = new Set([...mlbBat.map((b) => b.name), ...storedBat.map((b) => b.batter)]);
    const allPitchers = new Set([...mlbPit.map((p) => p.name), ...storedPit.map((p) => p.pitcher)]);

    const compareRows = (names, mlbList, storedList, nameKey) =>
      [...names].map((name) => {
        const mlb = mlbList.find((x) => x.name === name) || null;
        const stored = storedList.find((x) => x[nameKey] === name) || null;
        const mlbScore = mlb?.weekly_score ?? null;
        const storedScore = stored?.weekly_score ?? null;
        const diff = mlbScore !== null && storedScore !== null ? Math.round((mlbScore - storedScore) * 100) / 100 : null;
        return { name, manager: mlb?.manager || stored?.manager || null, mlb, stored, score_diff: diff };
      }).sort((a, b) => Math.abs(b.score_diff ?? 0) - Math.abs(a.score_diff ?? 0));

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
      manager_summary: Object.entries(managerTotals).map(([manager, t]) => ({
        manager,
        mlb_total: Math.round(t.mlb * 100) / 100,
        stored_total: Math.round(t.stored * 100) / 100,
        diff: Math.round((t.mlb - t.stored) * 100) / 100,
      })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)),
      batting: battingComparison,
      pitching: pitchingComparison,
    });
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

  if (!sd.weekly_batting) sd.weekly_batting = [];
  if (!sd.weekly_pitching) sd.weekly_pitching = [];
  if (!sd.daily_batting) sd.daily_batting = [];
  if (!sd.daily_pitching) sd.daily_pitching = [];
  if (!sd.batters_team) sd.batters_team = {};
  if (!sd.pitchers_team) sd.pitchers_team = {};

  repairGhostInitialRosterPlayers(sd);
  syncPlayerDatesFromRosterDates(sd);

  try {
    const gameRecords = await fetchMLBPerGameStats(dates.start, dates.end);

    // Update team maps from all games
    for (const { teamMap } of gameRecords) {
      for (const [name, abbrev] of Object.entries(teamMap)) {
        sd.batters_team[name] = abbrev;
        sd.pitchers_team[name] = abbrev;
      }
    }

    let batImported = 0, batSkipped = 0, pitImported = 0, pitSkipped = 0;

    // Store one daily record per player per game, then recompute weekly totals.
    for (const { gameId, date, batting, pitching, teamMap } of gameRecords) {
      for (const [name, gameStats] of Object.entries(batting)) {
        const manager =
          findManagerForPlayerWeek(sd, name, 'batting', schedWeek.round, schedWeek.week) ||
          findManagerForPlayer(sd, name, 'batting');

        // Skip if a manual/locked record already exists for this game
        const lockedDaily = sd.daily_batting.find(
          (r) => r.game_id === gameId && r.round === round && r.week === week && r.batter === name &&
            ((r.manual_fields && r.manual_fields.length > 0) || r.drop_locked)
        );
        if (lockedDaily) { manager ? batImported++ : batSkipped++; continue; }

        // Replace any previous mlbapi record for this game (handles stat corrections)
        sd.daily_batting = sd.daily_batting.filter(
          (r) => !(r.game_id === gameId && r.round === round && r.week === week && r.batter === name && r.source === 'mlbapi')
        );
        // delta = game stats; cumulative = game stats (per-game: each record is its own increment)
        sd.daily_batting.push({ date, round, week, batter: name, game_id: gameId, cumulative: gameStats, delta: gameStats, source: 'mlbapi' });

        manager ? batImported++ : batSkipped++;
      }

      for (const [name, gameStats] of Object.entries(pitching)) {
        const manager =
          findManagerForPlayerWeek(sd, name, 'pitching', schedWeek.round, schedWeek.week) ||
          findManagerForPlayer(sd, name, 'pitching');

        const lockedDaily = sd.daily_pitching.find(
          (r) => r.game_id === gameId && r.round === round && r.week === week && r.pitcher === name &&
            ((r.manual_fields && r.manual_fields.length > 0) || r.drop_locked)
        );
        if (lockedDaily) { manager ? pitImported++ : pitSkipped++; continue; }

        sd.daily_pitching = sd.daily_pitching.filter(
          (r) => !(r.game_id === gameId && r.round === round && r.week === week && r.pitcher === name && r.source === 'mlbapi')
        );
        sd.daily_pitching.push({ date, round, week, pitcher: name, game_id: gameId, cumulative: gameStats, delta: gameStats, source: 'mlbapi' });

        manager ? pitImported++ : pitSkipped++;
      }
    }

    // Aggregate totals across all stored game records and write weekly summary rows.
    const { batting: weeklyBat, pitching: weeklyPit, teamMap: allTeams } = aggregatePerGame(gameRecords);

    for (const [name, cumulative] of Object.entries(weeklyBat)) {
      const manager =
        findManagerForPlayerWeek(sd, name, 'batting', schedWeek.round, schedWeek.week) ||
        findManagerForPlayer(sd, name, 'batting');

      const existingManual = sd.weekly_batting.find(
        (b) => b.round === round && b.week === week && b.batter === name &&
          ((b.manual_fields && b.manual_fields.length > 0) || b.drop_locked)
      );
      if (existingManual) continue;

      const effectiveScore = computeEffectiveBattingScore(sd, name, round, week);
      const weeklyScore = effectiveScore !== null ? effectiveScore : calculateBattingScore(cumulative);

      sd.weekly_batting = sd.weekly_batting.filter(
        (b) => !(b.round === round && b.week === week && b.batter === name && b.source === 'mlbapi')
      );
      sd.weekly_batting.push({
        round, week, manager: manager || null, batter: name, team: allTeams[name] || null,
        ...cumulative, weekly_score: weeklyScore, total_score: weeklyScore, source: 'mlbapi',
      });
    }

    for (const [name, cumulative] of Object.entries(weeklyPit)) {
      const manager =
        findManagerForPlayerWeek(sd, name, 'pitching', schedWeek.round, schedWeek.week) ||
        findManagerForPlayer(sd, name, 'pitching');

      const existingManual = sd.weekly_pitching.find(
        (p) => p.round === round && p.week === week && p.pitcher === name &&
          ((p.manual_fields && p.manual_fields.length > 0) || p.drop_locked)
      );
      if (existingManual) continue;

      const effectiveScore = computeEffectivePitchingScore(sd, name, round, week);
      const weeklyScore = effectiveScore !== null ? effectiveScore : calculatePitchingScore(cumulative);

      sd.weekly_pitching = sd.weekly_pitching.filter(
        (p) => !(p.round === round && p.week === week && p.pitcher === name && p.source === 'mlbapi')
      );
      sd.weekly_pitching.push({
        round, week, manager: manager || null, pitcher: name, team: allTeams[name] || null,
        ...cumulative, qs_highlight: cumulative.gs >= 2, weekly_score: weeklyScore, source: 'mlbapi',
      });
    }

    if (!sd.upload_log) sd.upload_log = [];
    sd.upload_log.push({
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      type: 'mlbapi_sync',
      round, week, games: gameRecords.length,
      batting_imported: batImported, pitching_imported: pitImported,
    });
    pruneSyncHistory(sd);

    db.seasons[year] = sd;
    addAuditEntry(db, 'mlbapi_sync', { year, round, week, batting_imported: batImported, pitching_imported: pitImported });
    writeDB(db);

    res.json({
      ok: true,
      games_fetched: gameRecords.length,
      batting_imported: batImported, batting_skipped: batSkipped,
      pitching_imported: pitImported, pitching_skipped: pitSkipped,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// MLB Name Normalization
// ============================================================

// Standard Levenshtein distance.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => new Array(n + 1).fill(0));
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
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
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
  const add = (v) => { if (v && typeof v === 'string') names.add(v); };

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
    arr.forEach((v, i) => { if (v === oldName) { arr[i] = newName; count++; } });
  };
  const renameKey = (obj) => {
    if (!obj || !(oldName in obj)) return;
    obj[newName] = obj[oldName];
    delete obj[oldName];
    count++;
  };
  const renameField = (obj, field) => {
    if (obj && obj[field] === oldName) { obj[field] = newName; count++; }
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

  return count;
}

// Fetch all MLB player full names for a given season.
async function fetchMLBPlayerNames(season) {
  const data = await mlbApiFetch(`/api/v1/sports/1/players?season=${season}`);
  return (data.people || []).map((p) => p.fullName).filter(Boolean);
}

// For each WMMC name find the best MLB API match. Returns array of match objects.
function buildNameMatchReport(wmmcNames, mlbNames) {
  const mlbSet = new Set(mlbNames);
  return wmmcNames.map((wmmcName) => {
    if (mlbSet.has(wmmcName)) {
      return { wmmc_name: wmmcName, mlb_name: wmmcName, score: 1.0, exact: true, action: 'none' };
    }
    let bestName = null, bestScore = 0;
    for (const mlbName of mlbNames) {
      const s = nameSimilarity(wmmcName, mlbName);
      if (s > bestScore) { bestScore = s; bestName = mlbName; }
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

// Returns the top N closest MLB names to a WMMC name, with scores.
function topCandidates(wmmcName, mlbNames, n = 5) {
  return mlbNames
    .map((mlbName) => ({ mlb_name: mlbName, score: Math.round(nameSimilarity(wmmcName, mlbName) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

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

// GET /api/mlb/roster-audit?year=2025
//
// Tiers every player name in the database into four buckets:
//
//   rostered_exact    — on a roster, name already matches MLB API exactly
//   rostered_review   — on a roster, fuzzy score < 0.9; shows top-5 candidates for manual pick
//   unrostered_auto   — not on any roster, score >= 0.75; will be auto-replaced on fix
//   unrostered_replace— not on any roster, score < 0.75; best MLB candidate will replace old name
//
// Nothing is changed by this endpoint.
app.get('/api/mlb/roster-audit', requireCommissioner, async (req, res) => {
  const { year } = req.query;
  if (!year) return res.status(400).json({ error: 'year is required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  try {
    const mlbNames = await fetchMLBPlayerNames(year);
    const mlbSet = new Set(mlbNames);
    const allWmmcNames = extractSeasonPlayerNames(sd);
    const rostered = getRosteredNames(sd);

    const rosteredExact = [];
    const rosteredReview = [];
    const unrosteredAuto = [];
    const unrosteredReplace = [];

    for (const wmmcName of allWmmcNames) {
      const isRostered = rostered.has(wmmcName);
      const exact = mlbSet.has(wmmcName);

      if (exact) {
        if (isRostered) rosteredExact.push({ name: wmmcName });
        // Exact-match unrostered names need no action — skip them
        continue;
      }

      const candidates = topCandidates(wmmcName, mlbNames, 5);
      const best = candidates[0];

      if (isRostered) {
        // Always show for review regardless of score — commissioner must confirm
        rosteredReview.push({
          wmmc_name: wmmcName,
          best_match: best.mlb_name,
          best_score: best.score,
          candidates,
        });
      } else if (best.score >= 0.75) {
        unrosteredAuto.push({ wmmc_name: wmmcName, mlb_name: best.mlb_name, score: best.score });
      } else {
        unrosteredReplace.push({ wmmc_name: wmmcName, mlb_name: best.mlb_name, score: best.score, candidates });
      }
    }

    // Sort review list: worst score first so the most uncertain are at the top
    rosteredReview.sort((a, b) => a.best_score - b.best_score);

    res.json({
      season: year,
      summary: {
        rostered_exact: rosteredExact.length,
        rostered_review: rosteredReview.length,
        unrostered_auto: unrosteredAuto.length,
        unrostered_replace: unrosteredReplace.length,
      },
      // These need your input before the fix endpoint will touch them
      rostered_review: rosteredReview,
      // These will be auto-handled by roster-fix with no input needed
      unrostered_auto: unrosteredAuto,
      unrostered_replace: unrosteredReplace,
      // Already correct — listed for completeness
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
    if (obj && name in obj) { delete obj[name]; count++; }
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

  return count;
}

// POST /api/mlb/roster-fix
// Body: { year, manual_mappings: [{ from, to }] }
//
// One-pass cleanup:
//   1. Renames rostered players automatically when score >= 0.9.
//      Rostered players with score < 0.9 require an explicit { from, to } in manual_mappings;
//      they appear in the response's `needs_manual` list if omitted.
//   2. manual_mappings entries always apply regardless of score (use for low-confidence overrides).
//   3. Unrostered players with any name mismatch are PURGED entirely from the database —
//      their old misspelled records are removed and the MLB API sync will repopulate them
//      under the correct name on next run.
app.post('/api/mlb/roster-fix', requireCommissioner, async (req, res) => {
  const { year, manual_mappings } = req.body || {};
  if (!year) return res.status(400).json({ error: 'year is required' });

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: `Season ${year} not found` });

  try {
    const mlbNames = await fetchMLBPlayerNames(year);
    const mlbSet = new Set(mlbNames);
    const allWmmcNames = extractSeasonPlayerNames(sd);
    const rostered = getRosteredNames(sd);
    const manualMap = new Map((manual_mappings || []).map((m) => [m.from, m.to]));

    const applied = [];
    const needsManual = [];
    const purged = [];

    for (const wmmcName of allWmmcNames) {
      if (mlbSet.has(wmmcName)) continue; // already correct

      if (rostered.has(wmmcName)) {
        // Rostered player: use manual override if provided, else auto-rename if score >= 0.9
        if (manualMap.has(wmmcName)) {
          const to = manualMap.get(wmmcName);
          const occurrences = renamePlayerInSeason(sd, wmmcName, to);
          applied.push({ from: wmmcName, to, score: null, auto: false, occurrences_updated: occurrences });
        } else {
          const best = topCandidates(wmmcName, mlbNames, 1)[0];
          if (best && best.score >= 0.9) {
            const occurrences = renamePlayerInSeason(sd, wmmcName, best.mlb_name);
            applied.push({ from: wmmcName, to: best.mlb_name, score: best.score, auto: true, occurrences_updated: occurrences });
          } else {
            needsManual.push({ wmmc_name: wmmcName, best_match: best?.mlb_name ?? null, score: best?.score ?? 0, candidates: topCandidates(wmmcName, mlbNames, 5) });
          }
        }
      } else {
        // Unrostered player: purge entirely — MLB sync will re-add under the correct name
        const removed = purgePlayerFromSeason(sd, wmmcName);
        purged.push({ name: wmmcName, records_removed: removed });
      }
    }

    if (applied.length > 0 || purged.length > 0) {
      db.seasons[year] = sd;
      addAuditEntry(db, 'roster_name_fix', { year, renames: applied.length, purged: purged.length, detail: { applied, purged } });
      writeDB(db);
    }

    res.json({
      ok: true,
      renames_applied: applied.length,
      players_purged: purged.length,
      needs_manual_review: needsManual.length,
      applied,
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
    const gameRecords = await fetchMLBPerGameStats(startDate, endDate);

    const batterLog = {};
    const pitcherLog = {};

    for (const { gameId, date, batting, pitching, teamMap } of gameRecords) {
      for (const [name, stats] of Object.entries(batting)) {
        if (!rostered.has(name)) continue;
        const manager = findManagerForPlayer(sd, name, 'batting');
        if (!batterLog[name]) batterLog[name] = { manager: manager || null, team: teamMap[name] || null, games: [] };
        batterLog[name].games.push({ date, game_id: gameId, ...stats, game_score: Math.round(calculateBattingScore(stats) * 100) / 100 });
      }
      for (const [name, stats] of Object.entries(pitching)) {
        if (!rostered.has(name)) continue;
        const manager = findManagerForPlayer(sd, name, 'pitching');
        if (!pitcherLog[name]) pitcherLog[name] = { manager: manager || null, team: teamMap[name] || null, games: [] };
        pitcherLog[name].games.push({ date, game_id: gameId, ...stats, game_score: Math.round(calculatePitchingScore(stats) * 100) / 100 });
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

// POST /api/slack/scoreboard — post the current scoreboard to Slack
app.post('/api/slack/scoreboard', requireCommissioner, async (req, res) => {
  if (!SLACK_WEBHOOK_URL) {
    return res.status(503).json({ error: 'Slack webhook not configured' });
  }

  const db = readDB();

  // Require commissioner
  const userEmail = req.get('X-User-Email') || '';
  const manager = (db.managers || []).find((m) => m.email && m.email.toLowerCase() === userEmail.toLowerCase());
  if (!manager || !manager.commissioner) {
    return res.status(403).json({ error: 'Commissioner access required' });
  }

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
// Slack sends application/x-www-form-urlencoded; we need the raw body to verify the signature.
function captureRawBody(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    data += chunk;
  });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
}

app.post('/api/slack/command', captureRawBody, (req, res) => {
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
      .update(`v0:${timestamp}:${req.rawBody}`)
      .digest('hex');
    if (`v0=${hmac}` !== signature) return res.status(403).send('Invalid signature');
  }

  // Parse the URL-encoded body Slack sends
  const params = new URLSearchParams(req.rawBody || '');
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
  if (!round || !week || !player || !type)
    {return res.status(400).json({ error: 'round, week, player, and type are required' });}
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
  if (!round || !week || !player || !type)
    {return res.status(400).json({ error: 'round, week, player, and type are required' });}

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

  // Returns the next occurrence of 7am America/New_York as a UTC Date, accounting for DST.
  function getNext7amEastern() {
    const TZ = 'America/New_York';

    function calc7amEasternFor(ref) {
      const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ref);
      const [yr, mo, dy] = dateStr.split('-').map(Number);
      // Use noon UTC to sample the Eastern offset safely (DST transitions happen at 2am)
      const noonUTC = new Date(Date.UTC(yr, mo - 1, dy, 12, 0, 0));
      const noonEasternHour = +new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        hour: '2-digit',
        hour12: false,
      }).format(noonUTC);
      const offsetHours = noonEasternHour - 12; // -4 (EDT) or -5 (EST)
      return new Date(Date.UTC(yr, mo - 1, dy, 7 - offsetHours, 0, 0));
    }

    const now = new Date();
    let next = calc7amEasternFor(now);
    if (next <= now) {
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      next = calc7amEasternFor(tomorrow);
    }
    return next;
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

    // Schedule next run at 7am Eastern tomorrow
    const next = getNext7amEastern();
    scoreboardTimer = setTimeout(runAndReschedule, next - Date.now());
    console.log(`[Scoreboard] Next post scheduled for ${next.toISOString()} (7am Eastern)`);
  }

  const next = getNext7amEastern();
  const delay = next - Date.now();

  console.log(
    `[Scoreboard] Auto-post enabled. Next post at ${next.toISOString()} (7am Eastern, in ${Math.round(delay / 60000)} minutes)`
  );
  scoreboardTimer = setTimeout(runAndReschedule, delay);
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
      console.log('[Upstash] Restoring db...');
      const saved = await loadFromUpstash();
      if (saved) {
        fs.writeFileSync(DB_FILE, JSON.stringify(saved, null, 2), 'utf8');
        console.log('[Upstash] db restored successfully');
      } else {
        console.log('[Upstash] No saved db found — starting fresh or using local db.json');
      }
    } catch (e) {
      console.error('[Upstash] Restore error (continuing with local db.json):', e.message);
    }
  }

  app.listen(PORT, () => {
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

    // Start the Google Sheets sync scheduler
    scheduleGSheetsSync();
    // Start the daily scoreboard post scheduler (7am)
    scheduleScoreboardPost();
  });
}

main().catch(console.error);
