const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// Parse JSON bodies up to 50MB (season data can be large)
app.use(express.json({ limit: '50mb' }));

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
// Start
// ============================================================

app.listen(PORT, () => {
  console.log(`WMMC server running at http://localhost:${PORT}`);
  if (!fs.existsSync(DB_FILE)) {
    writeDB({ seasons: {}, managers: [] });
    console.log('Created empty db.json');
  }
});
