const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// Parse JSON bodies up to 50MB (season data can be large)
app.use(express.json({ limit: '50mb' }));

// Cache-busting: set no-cache on HTML so browsers always get the latest version.
// JS/CSS/JSON get a short max-age (5 min) so they're re-validated frequently.
app.use((req, res, next) => {
  const url = req.url.split('?')[0]; // strip query params for extension check
  if (url.endsWith('.html') || url === '/') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  } else if (url.endsWith('.js') || url.endsWith('.css') || url.endsWith('.json')) {
    res.set('Cache-Control', 'public, max-age=300, must-revalidate'); // 5 minutes
  }
  next();
});

// Serve static files (index.html, app.js, styles.css, data.json, etc.)
app.use(express.static(__dirname));

// ============================================================
// Database helpers
// ============================================================

function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading db.json:', e.message);
  }
  return { seasons: {}, managers: [] };
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

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
  const db = readDB();
  db.seasons = req.body;
  writeDB(db);
  res.json({ ok: true });
});

// POST /api/seasons/:year — save a single season
app.post('/api/seasons/:year', (req, res) => {
  const db = readDB();
  if (!db.seasons) db.seasons = {};
  db.seasons[req.params.year] = req.body;
  writeDB(db);
  res.json({ ok: true });
});

// GET /api/managers — return managers list
app.get('/api/managers', (req, res) => {
  const db = readDB();
  res.json(db.managers || []);
});

// POST /api/managers — save managers list
app.post('/api/managers', (req, res) => {
  const db = readDB();
  db.managers = req.body;
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
  const resp = await fetch(url);
  if (!resp.ok) {
    if (resp.status === 404 || resp.status === 400) return null; // tab doesn't exist
    const text = await resp.text();
    throw new Error(`Google Sheets API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.values || [];
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
      weekly_score: weeklyScore,
      source: 'gsheets'
    });

    if (isUnassigned) skipped++;
    else imported++;
  });

  return { imported, skipped };
}

// Main sync function — fetches all available weeks from the sheet
async function syncGoogleSheets(year) {
  const db = readDB();
  const config = db.google_sheets_config || {};
  const sd = (db.seasons || {})[year];

  if (!sd) throw new Error(`Season ${year} not found`);
  if (!config.spreadsheet_id) throw new Error('No spreadsheet ID configured');
  if (!config.api_key) throw new Error('No API key configured');

  if (!sd.weekly_batting) sd.weekly_batting = [];
  if (!sd.weekly_pitching) sd.weekly_pitching = [];

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
      if (batValues && batValues.length > 1) {
        const batRows = parseSheetRows(batValues);
        const batResult = processBattingRows(batRows, sd, sched);
        totalBatImported += batResult.imported;
        results.push({ week: weekNum, type: 'batting', imported: batResult.imported, skipped: batResult.skipped });
      }
    } catch (e) {
      results.push({ week: weekNum, type: 'batting', error: e.message });
    }

    // Try pitching tab
    try {
      const pitValues = await fetchSheetTab(config.spreadsheet_id, pitTab, config.api_key);
      if (pitValues && pitValues.length > 1) {
        const pitRows = parseSheetRows(pitValues);
        const pitResult = processPitchingRows(pitRows, sd, sched);
        totalPitImported += pitResult.imported;
        results.push({ week: weekNum, type: 'pitching', imported: pitResult.imported, skipped: pitResult.skipped });
      }
    } catch (e) {
      results.push({ week: weekNum, type: 'pitching', error: e.message });
    }
  }

  // Log the sync
  if (!sd.upload_log) sd.upload_log = [];
  sd.upload_log.push({
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    type: 'gsheets_sync',
    batting_imported: totalBatImported,
    pitching_imported: totalPitImported,
    details: results
  });

  // Save
  if (!db.seasons) db.seasons = {};
  db.seasons[year] = sd;

  // Update sync status
  config.last_sync = new Date().toISOString();
  config.last_sync_result = {
    success: true,
    batting_imported: totalBatImported,
    pitching_imported: totalPitImported,
    weeks_with_data: results.filter(r => !r.error && r.imported > 0).length,
    errors: results.filter(r => r.error).length,
    details: results
  };
  db.google_sheets_config = config;

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
    const result = await syncGoogleSheets(season);
    res.json({ ok: true, result });
  } catch (e) {
    // Log the error
    const db = readDB();
    if (!db.google_sheets_config) db.google_sheets_config = {};
    db.google_sheets_config.last_sync = new Date().toISOString();
    db.google_sheets_config.last_sync_result = { success: false, error: e.message };
    writeDB(db);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/google-sheets/sync-status
app.get('/api/google-sheets/sync-status', (req, res) => {
  const db = readDB();
  const config = db.google_sheets_config || {};
  res.json({
    last_sync: config.last_sync || null,
    last_sync_result: config.last_sync_result || null,
    enabled: config.enabled || false,
    next_sync: getNextSyncTime()
  });
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

    syncGoogleSheets(season)
      .then(result => console.log(`[GSheets] Sync complete: ${result.batting_imported} batting, ${result.pitching_imported} pitching records`))
      .catch(e => console.error(`[GSheets] Sync error: ${e.message}`));

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
// Online Users Tracking
// ============================================================
const onlineUsers = {};

app.post('/api/heartbeat', (req, res) => {
  const { email, name } = req.body;
  if (email && name) {
    onlineUsers[email] = { name, timestamp: Date.now() };
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
// Start
// ============================================================

app.listen(PORT, () => {
  console.log(`WMMC server running at http://localhost:${PORT}`);
  if (!fs.existsSync(DB_FILE)) {
    writeDB({ seasons: {}, managers: [] });
    console.log('Created empty db.json');
  }
  // Start the Google Sheets sync scheduler
  scheduleGSheetsSync();
});
