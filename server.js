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
    body: JSON.stringify(body)
  });
}

async function postScoreboardSlack(db, year) {
  if (!SLACK_SCOREBOARD_WEBHOOK_URL) return;
  const { blocks, text } = buildScoreboardBlocks(db, year);
  await fetch(SLACK_SCOREBOARD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, blocks })
  });
}

// Unique token generated every time the server starts. Appended to asset URLs
// so that browsers (especially mobile) always fetch fresh JS/CSS after a deploy.
const ASSET_VERSION = Date.now();

// Parse JSON bodies up to 50MB (season data can be large)
app.use(express.json({ limit: '50mb' }));

// ============================================================
// Security middleware
// ============================================================

// Simple rate limiter for POST endpoints
const rateLimits = {};
const RATE_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_MAX_REQUESTS = 60;

function rateLimit(req, res, next) {
  if (req.method !== 'POST') return next();
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!rateLimits[ip] || now - rateLimits[ip].start > RATE_WINDOW_MS) {
    rateLimits[ip] = { start: now, count: 1 };
  } else {
    rateLimits[ip].count++;
  }
  if (rateLimits[ip].count > RATE_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  next();
}

app.use(rateLimit);

// Security headers
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ============================================================
// Static file serving
// ============================================================

// Serve index.html through a dedicated route so we can inject the dynamic
// version stamp and set aggressive no-cache headers that cannot be overridden.
app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    .replace(/\?v=\d+/g, '?v=' + ASSET_VERSION);
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('html').send(html);
});

// Serve remaining static files (js/, css/, data.json, etc.)
app.use(express.static(__dirname, {
  index: false, // index.html is handled by the route above
  setHeaders(res, filePath) {
    if (/\.(js|css|json)$/i.test(filePath)) {
      res.set('Cache-Control', 'public, max-age=300, must-revalidate');
    }
  }
}));

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
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
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
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(data))
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
    const seedRecords = managers.map(({ password, ...rest }) => rest);
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
  saveToUpstash(data).catch(e => console.error('[Upstash] Background save failed:', e.message));
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
    email: email || 'system'
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
  const manager = managers.find(m => m.email && m.email.toLowerCase() === email.toLowerCase());

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

  res.json({ ok: true, manager: { name: manager.name, email: manager.email, commissioner: manager.commissioner || false } });
});

// ============================================================
// Login password endpoint (for client to get global password)
// ============================================================

app.get('/api/login-password', (req, res) => {
  res.json({ password: LOGIN_PASSWORD });
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
app.post('/api/seasons', (req, res) => {
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
app.post('/api/seasons/:year', (req, res) => {
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
  const existingIds = new Set(existingSwaps.map(s => s.id));
  const incomingSwaps = req.body.swaps || [];
  const newPending = incomingSwaps.filter(s => s.status === 'pending' && !existingIds.has(s.id));

  addAuditEntry(db, 'season_save', { year: req.params.year }, req.get('X-User-Email'));
  db.seasons[req.params.year] = req.body;
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
  res.json({ count: swaps.filter(s => s.status === 'pending').length });
});

// GET /api/managers — return managers list
app.get('/api/managers', (req, res) => {
  const db = readDB();
  // Strip passwords from response, but indicate if a custom password is set
  const managers = (db.managers || []).map(m => {
    const { password, ...safe } = m;
    safe.hasCustomPassword = !!password;
    return safe;
  });
  res.json(managers);
});

// POST /api/managers — save managers list
app.post('/api/managers', (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Request body must be an array' });
  }
  const db = readDB();
  // Preserve existing passwords — the client never receives them (stripped in GET),
  // so we must carry them forward from the current db record.
  const existingPasswords = {};
  (db.managers || []).forEach(m => {
    if (m.email && m.password) existingPasswords[m.email.toLowerCase()] = m.password;
  });
  db.managers = req.body.map(m => {
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
app.post('/api/managers/:email/password', (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const { password } = req.body || {};
  if (!password || typeof password !== 'string' || password.trim().length < 3) {
    return res.status(400).json({ error: 'Password must be at least 3 characters' });
  }
  const db = readDB();
  const manager = (db.managers || []).find(m => m.email && m.email.toLowerCase() === email);
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
app.delete('/api/managers/:email/password', (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const db = readDB();
  const manager = (db.managers || []).find(m => m.email && m.email.toLowerCase() === email);
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
  const manager = (db.managers || []).find(m => m.email && m.email.toLowerCase() === email);
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
app.get('/api/audit-log', (req, res) => {
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
app.post('/api/banner-config', (req, res) => {
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
  batting: { '1B': 3, '2B': 5, '3B': 8, 'HR': 10, 'R': 2, 'RBI': 2, 'SB': 5, 'BB': 2 },
  pitching: { 'W': 4, 'QS': 4, 'CG': 2.5, 'CGSO': 2.5, 'NH': 5, 'IP': 2.25, 'H': -0.6, 'ER': -2, 'BB': -0.6, 'K': 2 }
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
// Slack Scoreboard Builder
// ============================================================

const ROUND_LABELS = { PP1: 'Pool Play 1', PP2: 'Pool Play 2', QF: 'Quarterfinals', SF: 'Semifinals', Finals: 'Finals' };
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
  batting.filter(b => roundSet.has(b.round)).forEach(b => {
    if (!b.manager) return;
    if (!map[b.manager]) map[b.manager] = { batting: 0, pitching: 0 };
    map[b.manager].batting += (b.weekly_score || 0);
  });
  pitching.filter(p => roundSet.has(p.round)).forEach(p => {
    if (!p.manager) return;
    if (!map[p.manager]) map[p.manager] = { batting: 0, pitching: 0 };
    map[p.manager].pitching += (p.weekly_score || 0);
  });
  return Object.entries(map).map(([manager, s]) => ({
    manager,
    batting: Math.round(s.batting * 100) / 100,
    pitching: Math.round(s.pitching * 100) / 100,
    total: Math.round((s.batting + s.pitching) * 100) / 100
  }));
}

function buildScoreboardBlocks(db, year) {
  const seasonData = (db.seasons || {})[year] || {};
  const managers = db.managers || [];

  const managerPoolMap = {};
  managers.forEach(m => { if (m.pool) managerPoolMap[m.name] = m.pool; });

  // Determine current round
  const scheduleDates = seasonData.schedule_dates || [];
  let currentRound = detectCurrentRound(scheduleDates);

  // If still no round from dates, use the latest round present in data
  if (!currentRound) {
    const roundsWithData = new Set((seasonData.weekly_batting || []).map(b => b.round));
    for (let i = ROUND_ORDER.length - 1; i >= 0; i--) {
      if (roundsWithData.has(ROUND_ORDER[i])) { currentRound = ROUND_ORDER[i]; break; }
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
  Object.values(poolGroups).forEach(members => {
    const best1 = pp1Scores.filter(s => members.includes(s.manager)).sort((a, b) => b.total - a.total)[0];
    if (best1 && best1.total > 0) pp1WinnerSet.add(best1.manager);
    const best2 = pp2Scores.filter(s => members.includes(s.manager)).sort((a, b) => b.total - a.total)[0];
    if (best2 && best2.total > 0) pp2WinnerSet.add(best2.manager);
  });

  const allPPWinners = new Set([...pp1WinnerSet, ...pp2WinnerSet]);
  const numWildcards = Math.max(0, 8 - allPPWinners.size);
  const wildcardSet = new Set();
  const ppOverall = computeRoundScores(batting, pitching, ['PP1', 'PP2']).sort((a, b) => b.total - a.total);
  let wcCount = 0;
  for (const m of ppOverall) {
    if (wcCount >= numWildcards) break;
    if (!allPPWinners.has(m.manager) && m.total > 0) { wildcardSet.add(m.manager); wcCount++; }
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
  batting.forEach(b => {
    if (!b.manager) return;
    if (!overallMap[b.manager]) overallMap[b.manager] = { manager: b.manager, batting: 0, pitching: 0 };
    overallMap[b.manager].batting += (b.weekly_score || 0);
  });
  pitching.forEach(p => {
    if (!p.manager) return;
    if (!overallMap[p.manager]) overallMap[p.manager] = { manager: p.manager, batting: 0, pitching: 0 };
    overallMap[p.manager].pitching += (p.weekly_score || 0);
  });
  const overall = Object.values(overallMap).map(m => ({
    ...m,
    batting: Math.round(m.batting * 100) / 100,
    pitching: Math.round(m.pitching * 100) / 100,
    total: Math.round((m.batting + m.pitching) * 100) / 100
  })).sort((a, b) => b.total - a.total);

  const overallLastMgr = overall.length > 0 ? overall[overall.length - 1].manager : null;

  // ---- Current-round pool standings ----
  const poolRoundMap = {};
  if (currentRound) {
    batting.filter(b => b.round === currentRound).forEach(b => {
      if (!b.manager) return;
      if (!poolRoundMap[b.manager]) poolRoundMap[b.manager] = { manager: b.manager, batting: 0, pitching: 0, pool: managerPoolMap[b.manager] };
      poolRoundMap[b.manager].batting += (b.weekly_score || 0);
    });
    pitching.filter(p => p.round === currentRound).forEach(p => {
      if (!p.manager) return;
      if (!poolRoundMap[p.manager]) poolRoundMap[p.manager] = { manager: p.manager, batting: 0, pitching: 0, pool: managerPoolMap[p.manager] };
      poolRoundMap[p.manager].pitching += (p.weekly_score || 0);
    });
  }
  const poolStandings = Object.values(poolRoundMap).map(m => ({
    ...m,
    batting: Math.round(m.batting * 100) / 100,
    pitching: Math.round(m.pitching * 100) / 100,
    total: Math.round((m.batting + m.pitching) * 100) / 100
  })).sort((a, b) => b.total - a.total);

  // Group by pool — already sorted desc so last entry = pool's last place
  const pools = {};
  poolStandings.forEach(m => {
    const key = m.pool ? `Pool ${m.pool}` : 'Unassigned';
    if (!pools[key]) pools[key] = [];
    pools[key].push(m);
  });

  // ---- Formatters ----
  const fmt = n => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtInt = n => Math.round(n).toLocaleString('en-US');
  const rankEmoji = ['\u{1F947}', '\u{1F948}', '\u{1F949}']; // 🥇🥈🥉
  const rank = i => i < 3 ? rankEmoji[i] : `${i + 1}.`;
  const rankPool = i => i === 0 ? '\u{1F947}' : `${i + 1}.`; // 🥇 for pool leader only
  const heart = n => Math.floor(n) === 69 ? ' ❤️' : ''; // ❤️ easter egg at 69
  const dumpster = '\u{1F5D1}️\u{1F4A6}'; // 🗑️💦 last place

  // ---- Build overall standings text ----
  const overallText = overall.length
    ? overall.map((m, i) => {
        const d = dot(m.manager, 'overall');
        const nameStr = d !== null ? `*${m.manager}*` : m.manager;
        const dotStr = d ? `${d} ` : '';
        const trash = m.manager === overallLastMgr ? ` ${dumpster}` : '';
        return `${rank(i)} ${dotStr}${nameStr}${trash} — ${fmt(m.total)}${heart(m.total)} pts _(B: ${fmtInt(m.batting)} | P: ${fmt(m.pitching)})_`;
      }).join('\n')
    : '_No scores recorded yet._';

  // ---- Build pool fields (side-by-side via Slack fields, 2-column grid) ----
  const sortedPoolEntries = Object.entries(pools).sort((a, b) => a[0].localeCompare(b[0]));
  const poolFields = sortedPoolEntries.map(([poolName, members]) => {
    const poolLastMgr = members.length > 0 ? members[members.length - 1].manager : null;
    const lines = members.map((m, i) => {
      const d = dot(m.manager, currentRound);
      const dotStr = d ? `${d} ` : '';
      const nameStr = i === 0 ? `*${m.manager}*` : m.manager;
      const trash = m.manager === poolLastMgr ? ` ${dumpster}` : '';
      return `${rankPool(i)} ${dotStr}${nameStr}${trash} — ${fmt(m.total)}${heart(m.total)} pts`;
    }).join('\n');
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
    elements: [{ type: 'mrkdwn', text: '\u{1F517} View full scoreboard: <http://wmmc.live|wmmc.live>' }]
  });

  return {
    blocks,
    text: `⚾ WMMC Scoreboard (${year}) — ${currentRoundLabel} | wmmc.live`
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
        await new Promise(r => setTimeout(r, 65000));
        continue;
      }
      const text = await resp.text();
      if (resp.status === 429) throw new Error('Google Sheets API rate limit exceeded. Please wait ~60 seconds before syncing again.');
      throw new Error(`Google Sheets API error ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    return data.values || [];
  }
}

// Parse sheet rows (first row = headers) into objects
function parseSheetRows(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0].map(h => (h || '').trim());
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

// Find manager for a player from rosters
function findManagerForPlayer(sd, playerName, type) {
  if (!sd.rosters || !playerName) return null;
  const lcName = playerName.toLowerCase();
  for (const [manager, weekRosters] of Object.entries(sd.rosters)) {
    for (const roster of Object.values(weekRosters)) {
      const pool = type === 'batting' ? (roster.batters || []) : (roster.pitchers || []);
      if (pool.some(p => p.toLowerCase() === lcName)) return manager;
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
    const pool = type === 'batting' ? (roster.batters || []) : (roster.pitchers || []);
    if (pool.some(p => p.toLowerCase() === lcName)) return manager;
  }
  return null;
}

// Process batting rows from a sheet tab
function processBattingRows(rows, sd, scheduleWeek) {
  let imported = 0, skipped = 0;

  rows.forEach(row => {
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

    const stats = {
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

    const weeklyScore = calculateBattingScore(stats);

    // Check if a manually-edited record exists for this player/week — don't overwrite it
    const existingManual = sd.weekly_batting.find(b =>
      b.round === scheduleWeek.round && b.week === scheduleWeek.week &&
      b.batter === batter && b.manual_fields && b.manual_fields.length > 0
    );
    if (existingManual) return;

    // Remove any previous non-manual sync record for this player/week
    sd.weekly_batting = sd.weekly_batting.filter(b =>
      !(b.round === scheduleWeek.round && b.week === scheduleWeek.week &&
        b.batter === batter && b.source === 'gsheets')
    );

    sd.weekly_batting.push({
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      manager: manager || null,
      batter,
      status: findCol(row, ['status', 'Status']) || null,
      ...stats,
      weekly_score: weeklyScore,
      total_score: weeklyScore,
      source: 'gsheets'
    });

    if (isUnassigned) skipped++;
    else imported++;
  });

  return { imported, skipped };
}

// Process pitching rows from a sheet tab
function processPitchingRows(rows, sd, scheduleWeek) {
  let imported = 0, skipped = 0;

  rows.forEach(row => {
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

    const stats = {
      gs: parseNum(findCol(row, ['gs', 'GS']) || 0),
      w: parseNum(findCol(row, ['w', 'W', 'wins']) || 0),
      qs: parseNum(findCol(row, ['qs', 'QS']) || 0),
      cg: parseNum(findCol(row, ['cg', 'CG']) || 0),
      cgso: parseNum(findCol(row, ['cgso', 'CGSO']) || 0),
      nh: parseNum(findCol(row, ['nh', 'NH']) || 0),
      ip: parseNum(findCol(row, ['ip', 'IP']) || 0),
      h: parseNum(findCol(row, ['h', 'H', 'hits']) || 0),
      er: parseNum(findCol(row, ['er', 'ER']) || 0),
      bb: parseNum(findCol(row, ['bb', 'BB', 'walks']) || 0),
      k: parseNum(findCol(row, ['k', 'K', 'so', 'SO', 'strikeouts']) || 0),
    };

    const weeklyScore = calculatePitchingScore(stats);

    // Don't overwrite manually-edited records
    const existingManual = sd.weekly_pitching.find(p =>
      p.round === scheduleWeek.round && p.week === scheduleWeek.week &&
      p.pitcher === pitcher && p.manual_fields && p.manual_fields.length > 0
    );
    if (existingManual) return;

    // Remove previous gsheets sync for this player/week
    sd.weekly_pitching = sd.weekly_pitching.filter(p =>
      !(p.round === scheduleWeek.round && p.week === scheduleWeek.week &&
        p.pitcher === pitcher && p.source === 'gsheets')
    );

    sd.weekly_pitching.push({
      round: scheduleWeek.round,
      week: scheduleWeek.week,
      manager: manager || null,
      pitcher,
      status: findCol(row, ['status', 'Status']) || null,
      ...stats,
      qs_highlight: stats.gs >= 2,
      weekly_score: weeklyScore,
      source: 'gsheets'
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
  if (!sd.batters_team) sd.batters_team = {};
  if (!sd.pitchers_team) sd.pitchers_team = {};

  const results = [];
  let totalBatImported = 0, totalPitImported = 0;

  for (let i = 0; i < SEASON_SCHEDULE.length; i++) {
    const sched = SEASON_SCHEDULE[i];
    const weekNum = i + 1;
    const batTab = `Week ${weekNum} Batting`;
    const pitTab = `Week ${weekNum} Pitching`;

    // Try batting tab
    try {
      const batValues = await fetchSheetTab(config.spreadsheet_id, batTab, config.api_key);
      if (batValues !== null) {
        // Tab exists — full overwrite: remove all non-manual gsheets records for this week
        sd.weekly_batting = sd.weekly_batting.filter(b =>
          !(b.round === sched.round && b.week === sched.week &&
            b.source === 'gsheets' && (!b.manual_fields || b.manual_fields.length === 0))
        );
        if (batValues.length > 1) {
          const batRows = parseSheetRows(batValues);
          const batResult = processBattingRows(batRows, sd, sched);
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
        // Tab exists — full overwrite: remove all non-manual gsheets records for this week
        sd.weekly_pitching = sd.weekly_pitching.filter(p =>
          !(p.round === sched.round && p.week === sched.week &&
            p.source === 'gsheets' && (!p.manual_fields || p.manual_fields.length === 0))
        );
        if (pitValues.length > 1) {
          const pitRows = parseSheetRows(pitValues);
          const pitResult = processPitchingRows(pitRows, sd, sched);
          totalPitImported += pitResult.imported;
          results.push({ week: weekNum, type: 'pitching', imported: pitResult.imported, skipped: pitResult.skipped });
        }
      }
    } catch (e) {
      results.push({ week: weekNum, type: 'pitching', error: e.message });
    }
  }

  // Log the sync
  const errorCount = results.filter(r => r.error).length;
  if (!sd.upload_log) sd.upload_log = [];
  sd.upload_log.push({
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    type: 'gsheets_sync',
    sync_type: syncType,
    success: errorCount === 0,
    batting_imported: totalBatImported,
    pitching_imported: totalPitImported,
    details: results
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
    weeks_with_data: results.filter(r => !r.error && r.imported > 0).length,
    errors: errorCount,
    details: results
  };
  db.google_sheets_config = config;

  addAuditEntry(db, 'gsheets_sync', {
    year,
    batting_imported: totalBatImported,
    pitching_imported: totalPitImported
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
app.post('/api/google-sheets/config', (req, res) => {
  const db = readDB();
  const { spreadsheet_url, api_key, enabled, season } = req.body;

  const spreadsheetId = extractSpreadsheetId(spreadsheet_url);
  if (spreadsheet_url && !spreadsheetId) {
    return res.status(400).json({ error: 'Could not extract spreadsheet ID from the provided URL' });
  }

  if (!db.google_sheets_config) db.google_sheets_config = {};
  if (spreadsheetId) db.google_sheets_config.spreadsheet_id = spreadsheetId;
  if (api_key) db.google_sheets_config.api_key = api_key;
  if (typeof enabled === 'boolean') db.google_sheets_config.enabled = enabled;
  if (season) db.google_sheets_config.season = season;

  addAuditEntry(db, 'gsheets_config_update', { enabled, season }, req.get('X-User-Email'));
  writeDB(db);
  scheduleGSheetsSync(); // reconfigure scheduler

  res.json({ ok: true, spreadsheet_id: db.google_sheets_config.spreadsheet_id });
});

// POST /api/google-sheets/sync — manual trigger
app.post('/api/google-sheets/sync', async (req, res) => {
  try {
    const db = readDB();
    const config = db.google_sheets_config || {};
    const season = req.body.season || config.season || new Date().getFullYear().toString();
    const result = await syncGoogleSheets(season, 'manual');
    if (result.errors > 0) {
      postSlack(`*Google Sheets Manual Sync — ${result.errors} error(s)*\n${result.errors} week(s) failed to import for season ${season}.`).catch(() => {});
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
    .filter(l => l.type === 'gsheets_sync')
    .slice(-10)
    .reverse();
  res.json({
    last_sync: config.last_sync || null,
    last_sync_result: config.last_sync_result || null,
    enabled: config.enabled || false,
    next_sync: getNextSyncTime(),
    recent_logs: recentLogs
  });
});

// POST /api/slack/scoreboard — post the current scoreboard to Slack
app.post('/api/slack/scoreboard', async (req, res) => {
  if (!SLACK_WEBHOOK_URL) {
    return res.status(503).json({ error: 'Slack webhook not configured' });
  }

  const db = readDB();

  // Require commissioner
  const userEmail = req.get('X-User-Email') || '';
  const manager = (db.managers || []).find(m => m.email && m.email.toLowerCase() === userEmail.toLowerCase());
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
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => { req.rawBody = data; next(); });
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
    const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
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
app.delete('/api/seasons/:year/week-data', (req, res) => {
  const { year } = req.params;
  const { round, week, type } = req.body;

  if (!round || !week) {
    return res.status(400).json({ error: 'round and week are required' });
  }

  const db = readDB();
  const sd = (db.seasons || {})[year];
  if (!sd) return res.status(404).json({ error: 'Season not found' });

  let batRemoved = 0, pitRemoved = 0;

  if (!type || type === 'batting' || type === 'all') {
    const before = (sd.weekly_batting || []).length;
    sd.weekly_batting = (sd.weekly_batting || []).filter(b =>
      !(b.round === round && b.week === week)
    );
    batRemoved = before - (sd.weekly_batting || []).length;
  }

  if (!type || type === 'pitching' || type === 'all') {
    const before = (sd.weekly_pitching || []).length;
    sd.weekly_pitching = (sd.weekly_pitching || []).filter(p =>
      !(p.round === round && p.week === week)
    );
    pitRemoved = before - (sd.weekly_pitching || []).length;
  }

  addAuditEntry(db, 'clear_week_data', { year, round, week, type: type || 'all', batRemoved, pitRemoved }, req.get('X-User-Email'));
  db.seasons[year] = sd;
  writeDB(db);

  res.json({ ok: true, batting_removed: batRemoved, pitching_removed: pitRemoved });
});

// ============================================================
// Daily Scheduler (5:00 AM)
// ============================================================

let syncTimer = null;

function getNextSyncTime() {
  const now = new Date();
  const next = new Date();
  next.setHours(5, 0, 0, 0);
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

  function runAndReschedule() {
    const now = new Date();
    console.log(`[GSheets] Running scheduled sync at ${now.toISOString()}`);

    const db2 = readDB();
    const cfg = db2.google_sheets_config || {};
    const season = cfg.season || now.getFullYear().toString();
    const sd = (db2.seasons || {})[season];

    syncGoogleSheets(season)
      .then(result => {
        console.log(`[GSheets] Sync complete: ${result.batting_imported} batting, ${result.pitching_imported} pitching records`);
        if (result.errors > 0) {
          postSlack(`*Google Sheets Sync — ${result.errors} error(s)*\n${result.errors} week(s) failed to import during the daily sync for season ${season}.`).catch(() => {});
        }
      })
      .catch(e => {
        console.error(`[GSheets] Sync error: ${e.message}`);
        postSlack(`*Google Sheets Sync Failed*\n${e.message}`).catch(() => {});
      });

    // Schedule next run at 5am tomorrow
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(5, 0, 0, 0);
    const delay = next - Date.now();
    syncTimer = setTimeout(runAndReschedule, delay);
    console.log(`[GSheets] Next sync scheduled for ${next.toISOString()}`);
  }

  // Calculate delay until next 5am
  const now = new Date();
  const next = new Date();
  next.setHours(5, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;

  console.log(`[GSheets] Auto-sync enabled. Next sync at ${next.toISOString()} (in ${Math.round(delay / 60000)} minutes)`);
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
        .catch(e => console.error('[Scoreboard] Post failed:', e.message));
    } else {
      console.log(`[Scoreboard] Skipping — outside season date window for ${season}`);
    }

    // Schedule next run at 7am tomorrow
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(7, 0, 0, 0);
    scoreboardTimer = setTimeout(runAndReschedule, next - Date.now());
    console.log(`[Scoreboard] Next post scheduled for ${next.toISOString()}`);
  }

  const now = new Date();
  const next = new Date();
  next.setHours(7, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;

  console.log(`[Scoreboard] Auto-post enabled. Next post at ${next.toISOString()} (in ${Math.round(delay / 60000)} minutes)`);
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
